(() => {
  const CENTRO_SP = [-23.5505, -46.6333];
  // Caixa de São Paulo (capital + entorno): esquerda, topo, direita, base
  const VIEWBOX = '-46.83,-23.35,-46.36,-23.80';
  const MAX_RECENTES = 3;   // recentes mostrados/guardados
  const MAX_FAVORITOS = 5;  // favoritos por campo
  const $ = id => document.getElementById(id);
  const aviso = $('aviso');
  const msg = t => { aviso.textContent = t || ''; };

  // ---------- localStorage ----------
  const ler = (k) => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  // Favoritos individuais: um conjunto para Origem e outro para Destino
  let favoritos = { origem: ler('rotas:favoritos:origem'), destino: ler('rotas:favoritos:destino') };
  const legado = ler('rotas:favoritos'); // migra a lista única da versão anterior
  if (legado.length && !favoritos.origem.length && !favoritos.destino.length) {
    favoritos.origem = legado.slice(0, MAX_FAVORITOS);
    favoritos.destino = legado.slice(0, MAX_FAVORITOS);
    gravar('rotas:favoritos:origem', favoritos.origem);
    gravar('rotas:favoritos:destino', favoritos.destino);
  }
  try { localStorage.removeItem('rotas:favoritos'); } catch {}
  let recentes = ler('rotas:recentes').slice(0, MAX_RECENTES);
  const ehFavorito = (tipo, nome) => favoritos[tipo].some(f => f.nome === nome);

  // ---------- Mapa e tema ----------
  const mapa = L.map('mapa').setView(CENTRO_SP, 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; contribuidores do <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(mapa); // o mapa é sempre claro, independente do tema

  function aplicarTema(tema) {
    document.documentElement.setAttribute('data-theme', tema);
    $('btn-tema').firstElementChild.textContent = tema === 'dark' ? 'light_mode' : 'dark_mode';
    try { localStorage.setItem('rotas:tema', tema); } catch {}
  }
  let temaSalvo = null;
  try { temaSalvo = localStorage.getItem('rotas:tema'); } catch {}
  if (temaSalvo === 'escuro') temaSalvo = 'dark';
  if (temaSalvo === 'claro') temaSalvo = 'light';
  aplicarTema(temaSalvo || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $('btn-tema').addEventListener('click', () => {
    aplicarTema(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  // ---------- Pontos no mapa ----------
  const icone = cls => L.divIcon({ className: '', html: `<div class="marcador ${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
  const estado = { origem: { coord: null, marcador: null }, destino: { coord: null, marcador: null } };

  function definirPonto(tipo, lat, lon) {
    const e = estado[tipo];
    e.coord = [lat, lon]; // Leaflet: [lat, lon]
    if (e.marcador) mapa.removeLayer(e.marcador);
    e.marcador = L.marker(e.coord, { icon: icone(tipo === 'origem' ? 'o' : 'd') })
      .addTo(mapa).bindPopup(tipo === 'origem' ? 'Origem' : 'Destino');
    enquadrar();
  }
  function enquadrar() {
    const pts = [estado.origem.coord, estado.destino.coord].filter(Boolean);
    if (pts.length === 2) mapa.fitBounds(L.latLngBounds(pts), { padding: [50, 50] });
    else if (pts.length === 1) mapa.setView(pts[0], 15);
  }

  // ---------- Busca de endereços (Photon + fallback Nominatim) ----------
  const BBOX = '-46.83,-23.80,-46.36,-23.35'; // minLon,minLat,maxLon,maxLat

  function normalizar(q) { // expande abreviações no início da busca
    return q.trim()
      .replace(/^av\.?(\s+|$)/i, 'Avenida ')
      .replace(/^r\.?\s+/i, 'Rua ')
      .replace(/^al\.?(\s+|$)/i, 'Alameda ')
      .replace(/^(pç|pca|pc)\.?\s+/i, 'Praça ')
      .replace(/^est\.?\s+/i, 'Estrada ')
      .trim();
  }

  function nomePhoton(p) {
    const partes = [];
    if (p.name) partes.push(p.name);
    if (p.street && p.street !== p.name) partes.push(p.street + (p.housenumber ? ', ' + p.housenumber : ''));
    else if (p.housenumber && !p.street) partes.push(p.housenumber);
    [p.district || p.locality, p.city || p.county, p.state].forEach(x => { if (x && !partes.includes(x)) partes.push(x); });
    return partes.join(', ');
  }

  async function viaPhoton(q, limit, signal) {
    const url = 'https://photon.komoot.io/api/?' + new URLSearchParams({
      q, limit: String(limit + 4), lat: '-23.5505', lon: '-46.6333', bbox: BBOX
    });
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error('Photon ' + r.status);
    const dados = await r.json();
    const vistos = new Set(), saida = [];
    for (const f of dados.features || []) {
      const [lon, lat] = f.geometry.coordinates; // GeoJSON é [lon, lat] -> normaliza
      const nome = nomePhoton(f.properties);
      if (!nome || vistos.has(nome)) continue;
      vistos.add(nome); saida.push({ nome, lat, lon });
      if (saida.length === limit) break;
    }
    return saida;
  }

  async function viaNominatim(q, limit, signal) {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=pt-BR&countrycodes=br'
      + `&limit=${limit}&viewbox=${VIEWBOX}&bounded=1&q=` + encodeURIComponent(q);
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error('Nominatim ' + r.status);
    return (await r.json()).map(i => ({ nome: i.display_name, lat: parseFloat(i.lat), lon: parseFloat(i.lon) }));
  }

  async function buscarEnderecos(texto, { limit = 5, signal } = {}) {
    const q = normalizar(texto);
    try {
      const r = await viaPhoton(q, limit, signal);
      if (r.length) return r;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
    return viaNominatim(q, limit, signal); // fallback
  }

  // ---------- Campos (dropdown + autocomplete + favoritos) ----------
  const campos = {};
  function criarCampo(tipo) {
    const input = $(tipo), dd = $('dd-' + tipo), box = $('campo-' + tipo);
    const btnSalvar = box.querySelector('.btn-salvar');
    const c = campos[tipo] = { input, dd, btnSalvar, itens: [], idx: -1, sugestoes: null, timer: null, ctrl: null };

    c.fechar = () => { dd.hidden = true; c.idx = -1; };

    c.atualizarBookmark = () => {
      const salvo = ehFavorito(tipo, input.value.trim());
      btnSalvar.classList.toggle('salvo', salvo);
      btnSalvar.title = salvo ? 'Remover dos favoritos' : 'Salvar nos favoritos';
      btnSalvar.setAttribute('aria-label', btnSalvar.title);
    };

    c.escolher = (item) => {
      input.value = item.nome;
      definirPonto(tipo, item.lat, item.lon);
      adicionarRecente(item);
      c.sugestoes = null;
      c.fechar();
      c.atualizarBookmark();
      msg('');
    };

    function linha(item, icone, comRemover) {
      const el = document.createElement('div');
      el.className = 'item' + (comRemover ? ' recente' : '');
      el.setAttribute('role', 'option');
      el.innerHTML = `<span class="material-symbols-outlined ic ${icone === 'bookmark' ? 'preenchido' : ''}">${icone}</span><span class="txt"></span>`;
      el.querySelector('.txt').textContent = item.nome;
      if (comRemover) {
        const x = document.createElement('button');
        x.type = 'button'; x.className = 'icone-btn remover'; x.title = 'Remover dos recentes'; x.setAttribute('aria-label', 'Remover dos recentes');
        x.innerHTML = '<span class="material-symbols-outlined">close</span>';
        x.addEventListener('click', ev => { ev.stopPropagation(); removerRecente(item.nome); });
        el.appendChild(x);
      }
      el.addEventListener('click', () => c.escolher(item));
      c.itens.push({ el, item, recente: comRemover });
      return el;
    }
    const titulo = t => { const h = document.createElement('p'); h.className = 'dd-titulo'; h.textContent = t; return h; };
    const vazio = t => { const p = document.createElement('p'); p.className = 'dd-vazio'; p.textContent = t; return p; };

    c.render = () => {
      dd.innerHTML = ''; c.itens = []; c.idx = -1;
      if (c.sugestoes) {
        dd.appendChild(titulo('Sugestões'));
        if (!c.sugestoes.length) dd.appendChild(vazio('Nenhum endereço encontrado. Inclua o nome da rua (ex.: Avenida Paulista).'));
        c.sugestoes.forEach(s => dd.appendChild(linha(s, 'location_on', false)));
      } else {
        const favs = favoritos[tipo];
        if (favs.length) {
          dd.appendChild(titulo('Locais salvos'));
          favs.forEach(f => dd.appendChild(linha(f, 'bookmark', false)));
        }
        if (recentes.length) {
          dd.appendChild(titulo('Buscas recentes'));
          recentes.slice(0, MAX_RECENTES).forEach(r => dd.appendChild(linha(r, 'schedule', true)));
        }
        if (!favs.length && !recentes.length) dd.appendChild(vazio('Nenhum local salvo ou recente ainda.'));
      }
      dd.hidden = false;
    };

    c.abrir = () => {
      Object.values(campos).forEach(o => { if (o !== c) o.fechar(); });
      if (input.value.trim().length < 3) c.sugestoes = null;
      c.render();
    };

    input.addEventListener('focus', c.abrir);
    input.addEventListener('click', () => { if (dd.hidden) c.abrir(); });

    input.addEventListener('input', () => {
      clearTimeout(c.timer);
      if (c.ctrl) c.ctrl.abort();
      estado[tipo].coord = null;
      c.atualizarBookmark();
      const q = input.value.trim();
      if (q.length < 3) { c.sugestoes = null; c.render(); return; } // volta para favoritos/recentes
      c.timer = setTimeout(async () => { // debounce
        c.ctrl = new AbortController();
        try {
          c.sugestoes = await buscarEnderecos(q, { signal: c.ctrl.signal });
          c.render();
        } catch (err) {
          if (err.name !== 'AbortError') msg('Não foi possível buscar endereços agora. Tente novamente.');
        }
      }, 400);
    });

    input.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { c.fechar(); return; }
      if (dd.hidden || !c.itens.length) return;
      if (ev.key === 'Delete' && c.idx >= 0 && c.itens[c.idx].recente) {
        ev.preventDefault(); removerRecente(c.itens[c.idx].item.nome); return;
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const n = c.itens.length;
        c.idx = (c.idx + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
        c.itens.forEach((o, i) => o.el.classList.toggle('ativo', i === c.idx));
        c.itens[c.idx].el.scrollIntoView({ block: 'nearest' });
      } else if (ev.key === 'Enter' && c.idx >= 0) {
        ev.preventDefault(); c.escolher(c.itens[c.idx].item);
      }
    });

    // Bookmark: salva (após validar na API) ou remove
    btnSalvar.addEventListener('click', async () => {
      const texto = input.value.trim();
      if (!texto) { msg('Digite um endereço antes de salvar.'); return; }
      if (ehFavorito(tipo, texto)) {
        favoritos[tipo] = favoritos[tipo].filter(f => f.nome !== texto);
        gravar('rotas:favoritos:' + tipo, favoritos[tipo]);
        atualizarTudo();
        return;
      }
      msg('Validando endereço…');
      try {
        const [achado] = await buscarEnderecos(texto, { limit: 1 });
        if (!achado) { msg('Endereço não encontrado em São Paulo. Confira e tente de novo.'); return; }
        if (!ehFavorito(tipo, achado.nome)) {
          if (favoritos[tipo].length >= MAX_FAVORITOS) {
            msg(`Limite de ${MAX_FAVORITOS} favoritos neste campo. Remova um para salvar outro.`);
            return;
          }
          favoritos[tipo].unshift(achado);
          gravar('rotas:favoritos:' + tipo, favoritos[tipo]);
        }
        input.value = achado.nome;
        definirPonto(tipo, achado.lat, achado.lon);
        msg('');
        atualizarTudo();
      } catch {
        msg('Não foi possível validar o endereço agora. Tente novamente.');
      }
    });
    c.atualizarBookmark();
  }

  function atualizarTudo() {
    Object.values(campos).forEach(c => {
      c.atualizarBookmark();
      if (!c.dd.hidden) c.render();
    });
  }
  function adicionarRecente(item) {
    recentes = [item, ...recentes.filter(r => r.nome !== item.nome)].slice(0, MAX_RECENTES);
    gravar('rotas:recentes', recentes);
  }
  function removerRecente(nome) {
    recentes = recentes.filter(r => r.nome !== nome);
    gravar('rotas:recentes', recentes);
    atualizarTudo();
  }

  criarCampo('origem');
  criarCampo('destino');

  // Fecha o dropdown ao clicar fora
  document.addEventListener('pointerdown', ev => {
    Object.entries(campos).forEach(([tipo, c]) => {
      if (!$('campo-' + tipo).contains(ev.target)) c.fechar();
    });
  });

  // ---------- GPS ----------
  $('btn-gps').addEventListener('click', () => {
    msg('');
    if (!navigator.geolocation) { msg('Seu navegador não suporta localização. Digite o endereço de origem.'); return; }
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const { latitude, longitude } = pos.coords;
        let nome = 'Minha localização atual';
        try { // tenta transformar em endereço real
          const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=pt-BR&lat=${latitude}&lon=${longitude}`);
          if (r.ok) nome = (await r.json()).display_name || nome;
        } catch {}
        campos.origem.input.value = nome;
        definirPonto('origem', latitude, longitude);
        campos.origem.sugestoes = null;
        campos.origem.fechar();
        campos.origem.atualizarBookmark();
      },
      () => {
        msg('Não foi possível obter sua localização. Permita o acesso ou digite o endereço de origem.');
        mapa.setView(CENTRO_SP, 12);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // ---------- Calcular ----------
  $('btn-calcular').addEventListener('click', () => {
    if (!estado.origem.coord || !estado.destino.coord) {
      msg('Escolha a origem e o destino na lista de sugestões, nos favoritos ou nos recentes.');
      return;
    }
    msg('');
    enquadrar();
    calcularRotas();
  });

  // ---------- Dados de transporte e rotas ----------
  let dados = null, motor = null, promTraj = null, camadaRota = null, opcoes = [], quandoBusca = new Date(), tokenDesenho = 0;
  const statusEl = $('status-dados');
  const msgStatus = (t, erro) => { statusEl.textContent = t; statusEl.classList.toggle('erro', !!erro); };
  const fmt = n => n.toLocaleString('pt-BR');

  // @@helpers
  const rad = Math.PI / 180;
  function distM(la1, lo1, la2, lo2) {
    const p1 = la1 * rad, p2 = la2 * rad;
    const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((lo2 - lo1) * rad / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(a));
  }
  function decodificar(s) { // polyline precisão 5 -> [[lat, lon], ...]
    let i = 0, la = 0, lo = 0;
    const out = [];
    while (i < s.length) {
      const v = [0, 0];
      for (let k = 0; k < 2; k++) {
        let r = 0, sh = 0, b;
        do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
        v[k] = (r & 1) ? ~(r >> 1) : (r >> 1);
      }
      la += v[0]; lo += v[1];
      out.push([la / 1e5, lo / 1e5]);
    }
    return out;
  }
  function acumulado(pts) {
    const c = [0];
    for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + distM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    return c;
  }
  function pontoAo(pts, cum, m) { // ponto do trajeto a m metros do início
    let i = 1;
    while (i < cum.length - 1 && cum[i] < m) i++;
    const a = pts[i - 1], b = pts[i], seg = cum[i] - cum[i - 1];
    const t = seg > 0 ? Math.min(1, Math.max(0, (m - cum[i - 1]) / seg)) : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  function trechoEntre(pts, cum, m1, m2) { // pedaço do trajeto entre dois pontos (em metros)
    const out = [pontoAo(pts, cum, m1)];
    for (let i = 0; i < pts.length; i++) if (cum[i] > m1 && cum[i] < m2) out.push(pts[i]);
    out.push(pontoAo(pts, cum, m2));
    return out;
  }
  // @@fim

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const icMat = nome => el('span', 'material-symbols-outlined', nome);
  const iconeModo = t => t === 1 ? 'subway' : t === 2 ? 'train' : 'directions_bus';
  const nomeModo = t => t === 1 ? 'Metrô' : t === 2 ? 'Trem' : 'Ônibus';
  const nomeParada = pi => dados.paradas[pi][0];
  const hora = d => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const corTexto = hex => {
    const n = parseInt(hex, 16), l = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return l > 150 ? '#1b2a26' : '#fff';
  };
  const faixa = (a, b) => { const x = Math.max(1, Math.round(a)), y = Math.max(x, Math.round(b)); return x === y ? `${x} min` : `${x}–${y} min`; };

  let selIdx = 0, expandido = false;
  const painel = $('painel'), vLista = $('painel-lista'), vDet = $('painel-detalhe');

  function calcularRotas() {
    if (!motor) { msgStatus('Os dados de transporte ainda estão carregando…'); return; }
    msgStatus('Calculando rotas…');
    setTimeout(() => {
      const t0 = performance.now();
      quandoBusca = new Date();
      const res = motor.buscar(estado.origem.coord, estado.destino.coord, quandoBusca);
      opcoes = res.opcoes; selIdx = 0; expandido = false;
      msgStatus(opcoes.length ? `${opcoes.length} opç${opcoes.length > 1 ? 'ões' : 'ão'} em ${Math.round(performance.now() - t0)} ms` : '');
      painel.hidden = false;
      mostrarLista(res.erro);
      if (opcoes.length) desenhar(0); else limparRota();
    }, 20);
  }

  function limparRota() { if (camadaRota) { mapa.removeLayer(camadaRota); camadaRota = null; } }

  function cartaoResumo(o, i) {
    const c = el('article', 'cartao' + (i === selIdx ? ' sel' : ''));
    c.addEventListener('click', () => abrirDetalhe(i));
    const topo = el('div', 'c-topo');
    topo.appendChild(el('span', 'c-tempo', faixa(o.min, o.max)));
    const fim = new Date(quandoBusca.getTime() + o.esperado * 60000);
    topo.appendChild(el('span', 'c-sub', `chega ~${hora(fim)}`));
    c.appendChild(topo);
    const ic = el('div', 'c-icones');
    o.etapas.forEach((e, k) => {
      if (k) ic.appendChild(el('span', 'c-seta', '›'));
      if (e.tipo === 'pe') {
        const s = el('span', 'c-pe'); s.appendChild(icMat('directions_walk'));
        s.appendChild(document.createTextNode(` ${Math.max(1, Math.round(e.min))} min`));
        ic.appendChild(s);
      } else {
        const rota = dados.rotas[dados.viagens[e.vi].r], chip = el('span', 'chip');
        chip.style.background = '#' + rota[3]; chip.style.color = corTexto(rota[3]);
        chip.appendChild(icMat(iconeModo(rota[2]))); chip.appendChild(document.createTextNode(' ' + rota[0]));
        ic.appendChild(chip);
      }
    });
    c.appendChild(ic);
    c.appendChild(el('div', 'c-sub', `esperado ~${Math.round(o.esperado)} min · anda ${Math.round(o.peMin)} min · `
      + (o.baldeacoes ? `${o.baldeacoes} baldeaç${o.baldeacoes > 1 ? 'ões' : 'ão'}` : 'sem baldeação')));
    return c;
  }

  function mostrarLista(erro) {
    vDet.hidden = true; vLista.hidden = false; vLista.innerHTML = '';
    if (!opcoes.length) {
      vLista.appendChild(el('p', 'painel-vazio', erro
        ? `Não há nenhuma parada a até 2 km da ${erro}.`
        : 'Não encontrei uma rota para este horário. Pode ser que nenhuma linha esteja rodando agora.'));
      return;
    }
    (expandido ? opcoes : opcoes.slice(0, 1)).forEach((o, i) => vLista.appendChild(cartaoResumo(o, i)));
    if (opcoes.length > 1) {
      const n = opcoes.length - 1, b = el('button', 'btn-mais');
      b.type = 'button';
      b.appendChild(document.createTextNode(expandido ? 'Mostrar menos' : `Mostrar mais ${n} opç${n > 1 ? 'ões' : 'ão'}`));
      b.appendChild(icMat(expandido ? 'expand_less' : 'expand_more'));
      b.addEventListener('click', () => { expandido = !expandido; mostrarLista(); });
      vLista.appendChild(b);
    }
  }

  function abrirDetalhe(i) {
    selIdx = i;
    desenhar(i);
    const o = opcoes[i];
    vLista.hidden = true; vDet.hidden = false; vDet.innerHTML = '';
    const topo = el('div', 'det-topo');
    const voltar = el('button', 'icone-btn');
    voltar.type = 'button'; voltar.title = 'Voltar às opções'; voltar.setAttribute('aria-label', 'Voltar às opções');
    voltar.appendChild(icMat('arrow_back'));
    voltar.addEventListener('click', () => mostrarLista());
    topo.appendChild(voltar);
    topo.appendChild(el('span', 'c-tempo', faixa(o.min, o.max)));
    topo.appendChild(el('span', 'c-sub', `chega ~${hora(new Date(quandoBusca.getTime() + o.esperado * 60000))}`));
    vDet.appendChild(topo);

    const tl = el('div', 'linha-tempo');
    const no = txt => { const d = el('div', 'no'); d.appendChild(el('span', 'ponto')); d.appendChild(el('span', null, txt)); return d; };
    const trecho = (cor, pont, conteudo) => {
      const d = el('div', 'trecho'), r = el('span', 'trilho' + (pont ? ' pont' : ''));
      r.style.setProperty('--cor', cor); d.appendChild(r); d.appendChild(conteudo); return d;
    };
    tl.appendChild(no('Sua origem'));
    o.etapas.forEach(e => {
      const t = el('div');
      if (e.tipo === 'pe') {
        t.appendChild(icMat('directions_walk'));
        t.appendChild(document.createTextNode(` Caminhe ${Math.max(1, Math.round(e.min))} min · ${fmt(Math.round(e.m / 10) * 10)} m`));
        if (e.m > 800) t.appendChild(el('small', null, 'Caminhada longa'));
        tl.appendChild(trecho('#8a8f8d', true, t));
        tl.appendChild(no(e.ateParada >= 0 ? nomeParada(e.ateParada) : 'Seu destino'));
      } else {
        const rota = dados.rotas[dados.viagens[e.vi].r], chip = el('span', 'chip');
        chip.style.background = '#' + rota[3]; chip.style.color = corTexto(rota[3]);
        chip.appendChild(icMat(iconeModo(rota[2]))); chip.appendChild(document.createTextNode(' ' + rota[0]));
        t.appendChild(chip); t.appendChild(document.createTextNode(` sentido ${e.destino || '?'}`));
        t.appendChild(el('small', null, `Espera de 0 a ${Math.round(e.espera / 60)} min`));
        t.appendChild(el('small', null, `${e.nParadas} paradas · ${Math.max(1, Math.round(e.min))} min`));
        tl.appendChild(trecho('#' + rota[3], false, t));
        tl.appendChild(no(nomeParada(e.ateParada)));
      }
    });
    vDet.appendChild(tl);
  }

  async function desenhar(i) {
    const token = ++tokenDesenho, o = opcoes[i];
    let traj = null;
    if (o.etapas.some(e => e.tipo === 'veiculo')) {
      try {
        promTraj = promTraj || fetch('dados/trajetos.json').then(r => r.json()).then(j => j.t);
        traj = await promTraj;
      } catch (e) { promTraj = null; msgStatus('Não foi possível carregar os trajetos; mostrando as paradas.', true); }
    }
    if (token !== tokenDesenho) return;   // outra opção foi escolhida enquanto carregava
    limparRota();                          // evita acumular traçados
    const g = L.layerGroup(), todos = [];
    o.etapas.forEach(e => {
      if (e.tipo === 'pe') {
        L.polyline([e.de, e.ate], { color: '#555', weight: 4, dashArray: '1 9', lineCap: 'round' }).addTo(g);
        todos.push(e.de, e.ate);
        return;
      }
      const v = dados.viagens[e.vi], rota = dados.rotas[v.r], cor = '#' + rota[3];
      const full = traj ? decodificar(traj[e.vi]) : null, cum = full ? acumulado(full) : null;
      const pos = k => full ? pontoAo(full, cum, v.m[k]) : [dados.paradas[v.p[k]][1], dados.paradas[v.p[k]][2]];
      const linha = full ? trechoEntre(full, cum, v.m[e.kDe], v.m[e.kAte]) : [];
      if (!full) for (let k = e.kDe; k <= e.kAte; k++) linha.push(pos(k));
      L.polyline(linha, { color: cor, weight: 6, opacity: 0.9 }).addTo(g);
      todos.push(...linha);
      for (let k = e.kDe; k <= e.kAte; k++) {
        const ponta = k === e.kDe || k === e.kAte;
        L.circleMarker(pos(k), { radius: ponta ? 6 : 3.5, color: ponta ? cor : '#fff', weight: ponta ? 3 : 1, fillColor: ponta ? '#fff' : cor, fillOpacity: 1 })
          .bindTooltip(nomeParada(v.p[k])).addTo(g);
      }
    });
    g.addTo(mapa);
    camadaRota = g;
    if (todos.length) { // deixa livre o espaço do painel
      const larg = window.innerWidth > 760 ? painel.offsetWidth + 40 : 40;
      mapa.fitBounds(L.latLngBounds(todos), { paddingTopLeft: [40, 40], paddingBottomRight: [larg, 40] });
    }
  }

  (async () => {
    msgStatus('Carregando dados de transporte…');
    try {
      const [rp, rl] = await Promise.all([fetch('dados/paradas.json'), fetch('dados/linhas.json')]);
      if (!rp.ok || !rl.ok) throw new Error('HTTP');
      const linhas = await rl.json();
      dados = { paradas: (await rp.json()).p, rotas: linhas.rotas, viagens: linhas.viagens, servicos: linhas.servicos };
      motor = Rotas.criar(dados);
      msgStatus(`${fmt(dados.paradas.length)} paradas e ${fmt(dados.viagens.length)} viagens prontas.`);
    } catch (e) {
      msgStatus('Não foi possível carregar a pasta dados/. Abra o site por um servidor local '
        + '(python -m http.server) e confira se dados/ está ao lado do index.html.', true);
    }
  })();
})();