/* rotas.js — cálculo de rotas por menor tempo (Dijkstra) sobre paradas, viagens e caminhadas.
   Uso: const motor = Rotas.criar(dados); const { opcoes, erro } = motor.buscar([lat,lon], [lat,lon], new Date());
   Tempos internos em segundos. Nós do grafo:
     parada na rua   : 4*pi + 2*f + w (f=1 já andou de veículo: paga multa ao embarcar de novo;
                       w=1 chegou andando: não pode encadear outra caminhada)
     viagem na parada: base[vi] + k
     origem / destino virtuais. */
(function (raiz) {
  const CFG = {
    velPe: 1.25,          // m/s (4,5 km/h)
    fatorPe: 1.3,         // linha reta -> caminho real aproximado
    pesoPe: 2,            // 1 min andando "pesa" como 2 min de ônibus (andar cansa)
    caminhadaLivre: 300,  // s: até 5 min contínuos andando, sem penalidade extra
    penCaminhaA: 120,     // s: força da penalidade que cresce de forma exponencial depois disso
    penCaminhaT: 400,     // s: quanto maior, mais suave a subida da curva
    penBaldeacao: 600,    // s de "multa" a cada novo embarque (10 min)
    maxTransfPe: 300,     // m: caminhada máxima entre duas paradas
    maxDiretoPe: 2500,    // m: caminhada direta origem -> destino
    passo: 50, maxBusca: 2000, extra: 300, maxCand: 20, // busca de paradas perto da origem/destino
    grade: 0.004
  };
  const rad = Math.PI / 180;
  function hav(la1, lo1, la2, lo2) {
    const p1 = la1 * rad, p2 = la2 * rad;
    const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((lo2 - lo1) * rad / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(a));
  }
  // Custo (s) de um trecho andando contínuo de `seg` segundos: linear + penalidade exponencial após 5 min
  function custoPe(seg, peso) {
    let c = seg * peso;
    if (seg > CFG.caminhadaLivre) c += CFG.penCaminhaA * (Math.exp((seg - CFG.caminhadaLivre) / CFG.penCaminhaT) - 1);
    return c;
  }
  function headway(v, min) { // intervalo (s) da faixa que cobre o minuto; 0 = sem serviço
    const f = v.f;
    for (let i = 0; i < f.length; i += 3) if (min >= f[i] && min <= f[i + 1]) return f[i + 2];
    return 0;
  }

  function criar(dados) {
    const { paradas, viagens, servicos } = dados;
    const Np = paradas.length, G = CFG.grade;

    const grade = new Map();
    paradas.forEach((p, i) => {
      const k = Math.floor(p[1] / G) + ',' + Math.floor(p[2] / G);
      if (!grade.has(k)) grade.set(k, []);
      grade.get(k).push(i);
    });
    const emVi = paradas.map(() => []), emK = paradas.map(() => []);
    const base = new Int32Array(viagens.length);
    let total = 4 * Np;
    viagens.forEach((v, vi) => { base[vi] = total; total += v.p.length; v.p.forEach((pi, k) => { emVi[pi].push(vi); emK[pi].push(k); }); });
    const nVi = new Int32Array(total), nK = new Int32Array(total);
    viagens.forEach((v, vi) => v.p.forEach((_, k) => { nVi[base[vi] + k] = vi; nK[base[vi] + k] = k; }));
    const ORIG = total, DEST = total + 1, NN = total + 2;
    const D_ = new Float64Array(NN), prev = new Int32Array(NN);

    function perto(lat, lon, raio) {
      const dLa = raio / 110540, dLo = raio / (111320 * Math.cos(lat * rad)), res = [];
      for (let i = Math.floor((lat - dLa) / G); i <= Math.floor((lat + dLa) / G); i++)
        for (let j = Math.floor((lon - dLo) / G); j <= Math.floor((lon + dLo) / G); j++)
          for (const pi of grade.get(i + ',' + j) || []) {
            const d = hav(lat, lon, paradas[pi][1], paradas[pi][2]);
            if (d <= raio) res.push({ pi, d });
          }
      return res.sort((a, b) => a.d - b.d);
    }
    function proximas(lat, lon) { // cresce de 50 em 50 m até achar a primeira e segue mais `extra` m
      for (let r = CFG.passo; r <= CFG.maxBusca; r += CFG.passo) {
        const a = perto(lat, lon, r);
        if (a.length) return perto(lat, lon, a[0].d + CFG.extra).slice(0, CFG.maxCand);
      }
      return [];
    }
    const viz = new Map();
    function vizinhas(pi) {
      let r = viz.get(pi);
      if (!r) { r = perto(paradas[pi][1], paradas[pi][2], CFG.maxTransfPe).filter(x => x.pi !== pi).slice(0, 25); viz.set(pi, r); }
      return r;
    }

    function buscar(O, D, quando) {
      quando = quando || new Date();
      const dow = (quando.getDay() + 6) % 7;
      const agora = quando.getHours() * 3600 + quando.getMinutes() * 60 + quando.getSeconds();
      const ativa = new Uint8Array(viagens.length);
      viagens.forEach((v, i) => { ativa[i] = v.f.length && servicos[v.s] && servicos[v.s][dow] ? 1 : 0; });
      const candO = proximas(O[0], O[1]), candD = proximas(D[0], D[1]);
      if (!candO.length || !candD.length) return { opcoes: [], erro: !candO.length ? 'origem' : 'destino' };
      const destMap = new Map(candD.map(c => [c.pi, c.d]));
      const dd = hav(O[0], O[1], D[0], D[1]);
      const coord = n => n === ORIG ? O : n === DEST ? D : [paradas[n >> 2][1], paradas[n >> 2][2]];

      function caminho(P) {
        D_.fill(Infinity); prev.fill(-1);
        const hk = [], hv = [];
        const push = (k, v) => {
          let i = hk.length; hk.push(k); hv.push(v);
          while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; }
          hk[i] = k; hv[i] = v;
        };
        let ok = 0, ov = 0;
        const pop = () => {
          ok = hk[0]; ov = hv[0];
          const k = hk.pop(), v = hv.pop(), n = hk.length;
          if (n > 0) {
            let i = 0;
            for (;;) {
              let c = 2 * i + 1;
              if (c >= n) break;
              if (c + 1 < n && hk[c + 1] < hk[c]) c++;
              if (hk[c] >= k) break;
              hk[i] = hk[c]; hv[i] = hv[c]; i = c;
            }
            hk[i] = k; hv[i] = v;
          }
        };
        const walk = d => custoPe(d * CFG.fatorPe / CFG.velPe, P.pesoPe);
        const relax = (v, nd, u) => { if (nd < D_[v]) { D_[v] = nd; prev[v] = u; push(nd, v); } };
        D_[ORIG] = 0; push(0, ORIG);
        while (hk.length) {
          pop();
          const g = ok, u = ov;
          if (g > D_[u]) continue;
          if (u === DEST) break;
          if (u === ORIG) {
            candO.forEach(c => relax(4 * c.pi + 1, walk(c.d), u));
            if (dd * CFG.fatorPe <= CFG.maxDiretoPe) relax(DEST, walk(dd), u);
          } else if (u < 4 * Np) {
            const pi = u >> 2, f = (u >> 1) & 1, w = u & 1, vs = emVi[pi], ks = emK[pi];
            const min = Math.floor(((agora + g) / 60) % 1440);
            for (let i = 0; i < vs.length; i++) {
              const vi = vs[i], v = viagens[vi];
              if (!ativa[vi] || P.banir.has(v.r) || ks[i] === v.p.length - 1) continue;
              const h = headway(v, min);
              if (h) relax(base[vi] + ks[i], g + h / 2 + (f ? P.pen : 0), u);
            }
            if (!w) { // só anda de novo logo após descer: evita encadear caminhadas e fugir da penalidade
              for (const x of vizinhas(pi)) relax(4 * x.pi + 3, g + walk(x.d), u);
              const cd = destMap.get(pi);
              if (cd !== undefined) relax(DEST, g + walk(cd), u);
            }
          } else if (u < ORIG) {
            const vi = nVi[u], k = nK[u], v = viagens[vi];
            if (k + 1 < v.p.length) relax(u + 1, g + Math.max(10, v.t[k + 1] - v.t[k]), u);
            if (k >= 1) relax(4 * v.p[k] + 2, g, u);
          }
        }
        if (D_[DEST] === Infinity) return null;
        const path = [];
        for (let n = DEST; n !== -1; n = prev[n]) path.push(n);
        path.reverse();
        return montar(path);
      }

      function montar(path) {
        const etapas = [];
        let leg = null;
        for (let i = 0; i < path.length - 1; i++) {
          const u = path[i], w = path[i + 1];
          const uT = u >= 4 * Np && u < ORIG, wT = w >= 4 * Np && w < ORIG;
          if (!uT && !wT) {
            const a = coord(u), b = coord(w), m = hav(a[0], a[1], b[0], b[1]) * CFG.fatorPe;
            const ult = etapas[etapas.length - 1];
            if (ult && ult.tipo === 'pe') { ult.ate = b; ult.m += m; ult.ateParada = w < 2 * Np ? w >> 1 : -1; }
            else etapas.push({ tipo: 'pe', de: a, ate: b, m, ateParada: w < 4 * Np ? w >> 2 : -1 });
          } else if (!uT && wT) {
            const vi = nVi[w], v = viagens[vi];
            const h = headway(v, Math.floor(((agora + D_[u]) / 60) % 1440));
            leg = { tipo: 'veiculo', vi, r: v.r, destino: v.h, kDe: nK[w], kAte: nK[w], espera: h };
            etapas.push(leg);
          } else if (uT && wT) leg.kAte = nK[w];
          else leg.kAte = nK[u];
        }
        let pe = 0, cpe = 0, ride = 0, esp = 0, maxEsp = 0, nVeic = 0;
        etapas.forEach(e => {
          if (e.tipo === 'pe') { e.min = e.m / CFG.velPe / 60; pe += e.min; cpe += custoPe(e.min * 60, CFG.pesoPe) / 60; return; }
          const v = viagens[e.vi];
          e.min = (v.t[e.kAte] - v.t[e.kDe]) / 60; e.nParadas = e.kAte - e.kDe;
          e.deParada = v.p[e.kDe]; e.ateParada = v.p[e.kAte];
          ride += e.min; esp += e.espera / 120; maxEsp += e.espera / 60; nVeic++;
        });
        const baldeacoes = Math.max(0, nVeic - 1), esperado = pe + ride + esp;
        // pontuação para ordenar as opções: tempo esperado + custo extra de andar e de baldear
        const pontos = esperado - pe + cpe + baldeacoes * CFG.penBaldeacao / 60;
        return { etapas, baldeacoes, peMin: pe, esperado, pontos, min: pe + ride, max: pe + ride + maxEsp };
      }

      const opcoes = [], vistos = new Set();
      const rodar = P => {
        const r = caminho(P);
        if (!r) return r;
        const sig = r.etapas.filter(e => e.tipo === 'veiculo').map(e => e.vi + ':' + e.kDe + '-' + e.kAte).join('|') || 'pe';
        if (!vistos.has(sig)) { vistos.add(sig); opcoes.push(r); }
        return r;
      };
      const padrao = { pen: CFG.penBaldeacao, pesoPe: CFG.pesoPe };
      const r1 = rodar({ ...padrao, banir: new Set() });
      if (r1) {
        const usadas = [...new Set(r1.etapas.filter(e => e.tipo === 'veiculo').map(e => e.r))].slice(0, 3);
        usadas.forEach(r => rodar({ ...padrao, banir: new Set([r]) }));   // alternativa sem cada linha da 1ª opção
      }
      rodar({ pen: CFG.penBaldeacao * 2, pesoPe: CFG.pesoPe, banir: new Set() });  // ainda menos baldeações
      rodar({ pen: CFG.penBaldeacao, pesoPe: CFG.pesoPe * 2, banir: new Set() });  // ainda menos caminhada
      opcoes.sort((a, b) => a.pontos - b.pontos);
      return { opcoes: opcoes.slice(0, 4) };
    }
    return { buscar };
  }

  raiz.Rotas = { criar, CFG, custoPe };
  if (typeof module !== 'undefined') module.exports = raiz.Rotas;
})(typeof window !== 'undefined' ? window : globalThis);