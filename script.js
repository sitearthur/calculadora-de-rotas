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
  });
})();