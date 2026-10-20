(() => {
  const CENTRO_PADRAO = [-23.5505, -46.6333]; // São Paulo (fallback)
  const mapa = L.map('mapa').setView(CENTRO_PADRAO, 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; contribuidores do <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(mapa);

  const icone = cls => L.divIcon({ className: '', html: `<div class="marcador ${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
  const estado = {
    origem: { coord: null, marcador: null },
    destino: { coord: null, marcador: null }
  };
  const aviso = document.getElementById('aviso');
  const msg = t => { aviso.textContent = t || ''; };

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

  // ---------- Autocomplete (Nominatim + debounce) ----------
  function ligarAutocomplete(tipo) {
    const input = document.getElementById(tipo);
    const lista = document.getElementById('sug-' + tipo);
    let timer, controle, itens = [], idx = -1;

    const fechar = () => { lista.hidden = true; lista.innerHTML = ''; itens = []; idx = -1; };

    function escolher(it) {
      input.value = it.display_name;
      definirPonto(tipo, parseFloat(it.lat), parseFloat(it.lon));
      fechar();
    }

    function mostrar(resultados) {
      itens = resultados;
      lista.innerHTML = '';
      if (!itens.length) {
        lista.innerHTML = '<li>Nenhum endereço encontrado</li>';
        lista.hidden = false;
        itens = [];
        return;
      }
      itens.forEach(it => {
        const li = document.createElement('li');
        li.textContent = it.display_name;
        li.addEventListener('mousedown', ev => { ev.preventDefault(); escolher(it); });
        lista.appendChild(li);
      });
      lista.hidden = false;
    }

    async function buscar(q) {
      if (controle) controle.abort();
      controle = new AbortController();
      const c = mapa.getCenter();
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=br&accept-language=pt-BR'
        + `&viewbox=${c.lng - 0.8},${c.lat + 0.8},${c.lng + 0.8},${c.lat - 0.8}`
        + '&q=' + encodeURIComponent(q);
      try {
        const r = await fetch(url, { signal: controle.signal });
        if (!r.ok) throw new Error(r.status);
        mostrar(await r.json());
      } catch (err) {
        if (err.name !== 'AbortError') { msg('Não foi possível buscar endereços agora. Tente novamente.'); }
      }
    }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      estado[tipo].coord = null; // texto mudou: ponto antigo deixa de valer
      const q = input.value.trim();
      if (q.length < 3) { fechar(); return; }
      timer = setTimeout(() => buscar(q), 400); // debounce
    });

    input.addEventListener('keydown', ev => {
      const lis = [...lista.querySelectorAll('li')];
      if (lista.hidden || !itens.length) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        idx = (idx + (ev.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length;
        lis.forEach((l, i) => l.classList.toggle('ativo', i === idx));
      } else if (ev.key === 'Enter' && idx >= 0) {
        ev.preventDefault(); escolher(itens[idx]);
      } else if (ev.key === 'Escape') fechar();
    });

    input.addEventListener('blur', () => setTimeout(fechar, 150));
  }

  ligarAutocomplete('origem');
  ligarAutocomplete('destino');

  // ---------- GPS ----------
  document.getElementById('btn-gps').addEventListener('click', () => {
    msg('');
    if (!navigator.geolocation) { msg('Seu navegador não suporta localização. Digite o endereço de origem.'); return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude, longitude } = pos.coords;
        document.getElementById('origem').value = 'Minha localização atual';
        definirPonto('origem', latitude, longitude);
      },
      () => {
        msg('Não foi possível obter sua localização. Permita o acesso ou digite o endereço de origem.');
        mapa.setView(CENTRO_PADRAO, 12);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // ---------- Calcular ----------
  document.getElementById('btn-calcular').addEventListener('click', () => {
    if (!estado.origem.coord || !estado.destino.coord) {
      msg('Escolha a origem e o destino nas sugestões (ou use o botão 🎯 na origem).');
      return;
    }
    msg('');
    enquadrar();
  });
})();