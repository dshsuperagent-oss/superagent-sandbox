// HUD e telas do Torre de Ferro — tudo em pt-BR, só DOM + handlers.
// Não conhece engine, Three.js nem localStorage: quem manda é o main.js.
// API fixa: createHud({ handlers }) -> { update, showScreen, toast, setTutorial,
// updateMaps, setBossBar, dispose }.

import { TOWERS, TROOPS, TROOP_ORDER, MAP_ORDER, MAP_NAMES } from '../sim/data.js';

const SCREENS = [
  ['menu', 'screen-menu'],
  ['maps', 'screen-maps'],
  ['game', 'screen-game'],
  ['victory', 'screen-victory'],
  ['defeat', 'screen-defeat'],
  ['pause', 'screen-pause'],
  ['help', 'screen-help'],
  ['controls', 'screen-controls'],
];

// Em telas de toque, os textos falam "toque" em vez de "clique".
const TOQUE = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;

function falar(texto) {
  if (!TOQUE) return texto;
  return texto
    .replace(/\bClique\b/g, 'Toque')
    .replace(/\bclique\b/g, 'toque')
    .replace(/\s·\sEsc fecha o painel/g, ' · use Fechar para sair')
    .replace(/\s·\sV vende a torre\s·\sEsc fecha/g, ' · V vende a torre');
}

// Textos do tutorial de 6 passos (Deserto, onda 1).
export const TUTORIAL_STEPS = [
  'Bem-vindo ao último posto, comandante! Construa torres nos círculos claros ao lado do caminho.',
  'Clique em um slot vazio do campo e escolha uma torre no painel Construir.',
  'Inicie a onda quando estiver pronto — ou aguarde a preparação de 25 segundos.',
  'Clique em uma torre para abrir o painel e melhorá-la: mais dano, alcance e cadência.',
  'Posicione tropas especiais nos pontos marcados. Fuzileiros bloqueiam inimigos terrestres.',
  'Sobreviva às 8 ondas do setor. Chefes são resistentes: concentre o fogo e proteja a base!',
].map(falar);

const ALVO_NOME = {
  both: 'terrestre e aéreo',
  ground: 'terrestre',
  air: 'aéreo',
};

function starsText(stars) {
  const n = Math.max(0, Math.min(3, Math.round(Number(stars) || 0)));
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return String(v);
}

function fmtDec(n, casas) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(casas).replace('.', ',');
}

function pctText(hp, maxHp) {
  if (!maxHp) return '—';
  return `${Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)))}%`;
}

function nullHud() {
  return {
    update() {},
    showScreen() {},
    toast() {},
    setTutorial() {},
    updateMaps() {},
    setBossBar() {},
    dispose() {},
  };
}

export function createHud({ handlers = {} } = {}) {
  if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') {
    return nullHud();
  }

  const listeners = [];
  const cache = Object.create(null);
  let lastState = null;
  let lastUi = {};
  let lastSave = null;
  let tutorialStepShown = null;
  let currentBossId = null;
  let toastTimer = 0;
  let alertTimer = 0;
  let lastToastText = '';

  function el(id) {
    if (!id) return null;
    if (id in cache) return cache[id];
    let node = null;
    try {
      node = document.getElementById(id);
    } catch (err) {
      node = null;
    }
    cache[id] = node;
    return node;
  }

  function q(root, selector) {
    if (!root || typeof root.querySelector !== 'function') return null;
    try {
      return root.querySelector(selector);
    } catch (err) {
      return null;
    }
  }

  function qa(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    try {
      return Array.prototype.slice.call(root.querySelectorAll(selector));
    } catch (err) {
      return [];
    }
  }

  function on(node, type, fn) {
    if (!node || typeof node.addEventListener !== 'function') return;
    node.addEventListener(type, fn);
    listeners.push([node, type, fn]);
  }

  function setText(nodeOrId, value) {
    const node = typeof nodeOrId === 'string' ? el(nodeOrId) : nodeOrId;
    if (!node) return;
    const text = value == null ? '' : String(value);
    if (node.textContent !== text) node.textContent = text;
  }

  function setTextIn(root, selector, value) {
    const node = q(root, selector);
    if (node) setText(node, value);
  }

  function setHidden(nodeOrId, hidden) {
    const node = typeof nodeOrId === 'string' ? el(nodeOrId) : nodeOrId;
    if (!node) return;
    if ('hidden' in node) node.hidden = !!hidden;
    if (node.classList) node.classList.toggle('oculto', !!hidden);
  }

  function call(name, ...args) {
    const fn = handlers ? handlers[name] : null;
    if (typeof fn !== 'function') return undefined;
    return fn(...args);
  }

  function toggleClass(nodeOrId, cls, enabled) {
    const node = typeof nodeOrId === 'string' ? el(nodeOrId) : nodeOrId;
    if (!node || !node.classList) return;
    node.classList.toggle(cls, !!enabled);
  }

  // --------------------------------------------------------------- ligações
  function bindClick(id, handlerName) {
    const node = el(id);
    if (!node) return;
    on(node, 'click', () => call(handlerName));
  }

  bindClick('btn-iniciar', 'iniciarCampanha');
  bindClick('btn-missoes', 'abrirMissoes');
  bindClick('btn-controles', 'abrirControles');
  bindClick('btn-voltar-menu', 'voltarMenu');
  bindClick('btn-onda', 'iniciarOnda');
  bindClick('btn-tropas', 'abrirTropas');
  bindClick('btn-velocidade', 'alternarVelocidade');
  bindClick('btn-pausa', 'pausar');
  bindClick('btn-mudo', 'alternarMudo');
  bindClick('btn-ajuda', 'abrirAjuda');
  bindClick('btn-fechar-ajuda', 'fecharAjuda');
  bindClick('btn-fechar-controles', 'fecharControles');
  bindClick('btn-fechar-construir', 'fecharPainel');
  bindClick('btn-fechar-torre', 'fecharPainel');
  bindClick('btn-fechar-tropas', 'fecharPainel');
  bindClick('btn-melhorar', 'melhorar');
  bindClick('btn-vender', 'vender');
  bindClick('btn-tutorial-ok', 'tutorialOk');
  bindClick('btn-proxima-missao', 'proximaMissao');
  bindClick('btn-vitoria-missoes', 'missoesVitoria');
  bindClick('btn-tentar-de-novo', 'tentarDeNovo');
  bindClick('btn-continuar', 'retomar');
  bindClick('btn-sair', 'sairPartida');
  bindClick('btn-voltar-missoes', 'abrirMissoes');

  // Cartões de torre e de tropa são estáticos no index.html.
  for (const card of qa(el('painel-construir'), '.torre-card[data-torre]')) {
    const tipo = card.getAttribute('data-torre');
    on(card, 'click', () => call('construir', tipo));
  }
  const tropasPanel = el('painel-tropas');
  for (const card of qa(tropasPanel, '.tropa-card[data-tropa]')) {
    const tipo = card.getAttribute('data-tropa');
    on(card, 'click', () => call('posicionarTropa', tipo));
  }

  // Cartões de missão são gerados aqui (#map-list começa vazio).
  const mapList = el('map-list');
  on(mapList, 'click', (ev) => {
    const alvo = ev && ev.target;
    if (!alvo || typeof alvo.closest !== 'function') return;
    const card = alvo.closest('.map-card');
    if (!card || card.disabled) return;
    const mapId = card.getAttribute('data-map');
    if (mapId) call('selecionarMapa', mapId);
  });

  // --------------------------------------------------------------- mapas
  function ensureMapCards() {
    const list = el('map-list');
    if (!list || typeof document.createElement !== 'function') return [];
    let cards = qa(list, '.map-card[data-map]');
    if (cards.length === 0) {
      for (const mapId of MAP_ORDER) {
        const card = document.createElement('button');
        card.className = 'map-card';
        card.type = 'button';
        card.setAttribute('data-map', mapId);
        const nome = document.createElement('span');
        nome.className = 'map-nome';
        nome.textContent = MAP_NAMES[mapId] || mapId;
        const estrelas = document.createElement('span');
        estrelas.className = 'map-estrelas';
        estrelas.textContent = '☆☆☆';
        const estado = document.createElement('span');
        estado.className = 'map-estado';
        estado.textContent = 'Disponível';
        card.appendChild(nome);
        card.appendChild(estrelas);
        card.appendChild(estado);
        list.appendChild(card);
        cards.push(card);
      }
    }
    return cards;
  }

  function updateMaps(save) {
    if (save && typeof save === 'object') lastSave = save;
    const cards = ensureMapCards();
    const fonte = save && typeof save === 'object' ? save : lastSave;
    const mapsSave = fonte && fonte.maps && typeof fonte.maps === 'object' ? fonte.maps : {};
    for (const card of cards) {
      const mapId = card.getAttribute('data-map');
      const info = mapsSave[mapId] && typeof mapsSave[mapId] === 'object' ? mapsSave[mapId] : {};
      const unlocked = info.unlocked === true || mapId === 'deserto';
      const stars = unlocked ? Math.max(0, Math.min(3, Math.round(Number(info.stars) || 0))) : 0;
      const wavesWon = Math.max(0, Math.round(Number(info.wavesWon) || 0));
      const concluido = wavesWon >= 8 || stars > 0;

      setTextIn(card, '.map-nome', MAP_NAMES[mapId] || mapId);
      setTextIn(card, '.map-estrelas', starsText(stars));

      let estado;
      if (!unlocked) {
        estado = 'Bloqueado (complete o mapa anterior)';
      } else if (concluido) {
        const melhor = info.bestLives > 0 ? ` · melhor: ${fmtInt(info.bestLives)} vidas` : '';
        estado = `Setor defendido${melhor}`;
      } else {
        estado = 'Disponível';
      }
      setTextIn(card, '.map-estado', estado);
      card.disabled = !unlocked;
      if (card.classList) {
        card.classList.toggle('map-card--bloqueado', !unlocked);
        card.classList.toggle('map-card--concluido', unlocked && concluido);
      }
    }
  }

  // --------------------------------------------------------------- telas
  function showScreen(nome, dados) {
    const alvo = SCREENS.find((par) => par[0] === nome);
    if (!alvo) return;
    // Toast é da partida: ao sair do jogo, esconde e cancela o timer pendente
    // para não vazar o texto para menu/missões/pausa/ajuda/fim de partida.
    if (nome !== 'game') {
      const toastNode = el('toast');
      if (toastNode) setHidden(toastNode, true);
      setText('toast', '');
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = 0;
      }
      lastToastText = '';
    }
    for (const [chave, id] of SCREENS) {
      const node = el(id);
      if (!node) continue;
      const ativo = chave === nome;
      setHidden(node, !ativo);
      toggleClass(node, 'active', ativo);
    }
    if (nome === 'maps') {
      const save = dados && dados.save ? dados.save : lastSave;
      updateMaps(save);
    }
    if (nome === 'victory') {
      const info = dados || {};
      setText('vitoria-vidas', fmtInt(info.lives));
      setText('vitoria-estrelas', starsText(info.stars));
      const btn = el('btn-proxima-missao');
      if (btn) {
        const hasNext = info.hasNext !== false;
        btn.disabled = !hasNext;
        setText(btn, hasNext ? 'Próxima missão' : 'Campanha concluída');
      }
      if (info.mapName) setText('vitoria-mapa', info.mapName);
    }
    if (nome === 'defeat' && dados && dados.mapName) {
      setText('derrota-mapa', dados.mapName);
    }
    // Entrar em jogo/esconder overlays fecha tutorial? Não: o tutorial é do jogo.
  }

  // --------------------------------------------------------------- HUD topo
  function localWave(state) {
    const global = Math.max(1, Math.round(Number(state.wave) || 1));
    const base = Math.max(0, MAP_ORDER.indexOf(state.mapId)) * 8;
    return Math.max(1, Math.min(8, global - base));
  }

  function updateWaveButton(state) {
    const btn = el('btn-onda');
    if (!btn) return;
    const phase = state.phase || 'prep';
    if (phase === 'prep') {
      btn.disabled = false;
      const seg = Math.max(0, Math.ceil(Number(state.prepLeft) || 0));
      setText(btn, `Iniciar Onda (${seg}s)`);
    } else if (phase === 'wave') {
      btn.disabled = true;
      setText(btn, 'Onda em andamento');
    } else {
      btn.disabled = true;
      setText(btn, phase === 'victory' ? 'Setor defendido' : 'Fim de partida');
    }
  }

  function updateDica(state, ui) {
    const dica = el('dica-campo');
    const dicaToque = el('dica-toque');
    if (!dica && !dicaToque) return;
    let texto = 'Clique em um slot vazio para construir · clique em uma torre para melhorar';
    if (ui.panel === 'construir') {
      texto = 'Escolha uma torre · Esc fecha o painel';
    } else if (ui.panel === 'torre') {
      texto = 'Melhorar aumenta dano, alcance e cadência · V vende a torre · Esc fecha';
    } else if (ui.panel === 'tropas') {
      texto = 'Clique em um ponto de tropa no campo · Esc fecha o painel';
    }
    if (ui.deployTipo && TROOPS[ui.deployTipo]) {
      texto = `Clique em um ponto de tropa livre para posicionar: ${TROOPS[ui.deployTipo].name}`;
    }
    if (dica) setText(dica, texto);
    if (dicaToque) setText(dicaToque, falar(texto));
  }

  // --------------------------------------------------------------- painéis
  function updateBuildPanel(state) {
    const painel = el('painel-construir');
    if (!painel) return;
    for (const card of qa(painel, '.torre-card[data-torre]')) {
      const tipo = card.getAttribute('data-torre');
      const def = TOWERS[tipo];
      if (!def) continue;
      const custo = Array.isArray(def.costs) ? def.costs[0] : 0;
      setTextIn(card, '.torre-nome', def.name || tipo);
      setTextIn(card, '.torre-alvo', `Alvo: ${ALVO_NOME[def.target] || 'qualquer'}${def.effect === 'splash' ? ' · área' : ''}${def.effect === 'chain' ? ' · cadeia' : ''}${def.effect === 'slow' ? ' · lentidão' : ''}${def.effect === 'missile' ? ' · teleguiado' : ''}`);
      setTextIn(card, '.torre-custo', `$${fmtInt(custo)}`);
      card.disabled = Number(state.money) < Number(custo);
      toggleClass(card, 'torre-card--indisponivel', card.disabled);
    }
  }

  function nextUpgradeCost(tower) {
    const def = TOWERS[tower.type];
    const nivel = Math.max(1, Math.min(3, Math.round(Number(tower.level) || 1)));
    if (!def || !Array.isArray(def.costs) || nivel >= 3) return null;
    return Number(def.costs[nivel]) || 0; // costs[1] = L2, costs[2] = L3
  }

  function updateTowerPanel(state, tower) {
    const painel = el('painel-torre');
    if (!painel || !tower) return;
    const def = TOWERS[tower.type] || null;
    const nivel = Math.max(1, Math.min(3, Math.round(Number(tower.level) || 1)));
    setTextIn(painel, '.torre-nome', tower.name || (def ? def.name : tower.type));
    setTextIn(painel, '.torre-nivel', fmtInt(nivel));
    setTextIn(painel, '.torre-dano', Number.isFinite(Number(tower.damage)) ? fmtInt(tower.damage) : '—');
    setTextIn(painel, '.torre-alcance', Number.isFinite(Number(tower.range)) ? `${fmtInt(tower.range)} m` : '—');
    setTextIn(painel, '.torre-cadencia', Number.isFinite(Number(tower.rate)) ? `${fmtDec(tower.rate, 2)} s` : '—');

    const btnMelhorar = el('btn-melhorar');
    if (btnMelhorar) {
      const custo = nextUpgradeCost(tower);
      if (custo == null) {
        btnMelhorar.disabled = true;
        setText(btnMelhorar, 'Nível máximo');
      } else {
        btnMelhorar.disabled = Number(state.money) < custo;
        setText(btnMelhorar, `Melhorar $${fmtInt(custo)}`);
      }
    }

    const btnVender = el('btn-vender');
    if (btnVender) {
      let refund = Number(tower.sellValue);
      if (!Number.isFinite(refund)) {
        const investido = Number(tower.invested);
        refund = Number.isFinite(investido) ? Math.floor(investido * 0.7) : 0;
      }
      setText(btnVender, `Vender +$${fmtInt(refund)}`);
      btnVender.disabled = false;
    }
  }

  function updateTroopsPanel(state, ui) {
    const painel = el('painel-tropas');
    if (!painel) return;
    const tropas = Array.isArray(state.troops) ? state.troops : [];
    const cooldowns = Array.isArray(state.troopCooldowns) ? state.troopCooldowns : [];
    const pontos = Array.isArray(state.troopPoints) ? state.troopPoints : [];
    const livres = pontos.filter((p) => !p || p.troopId == null).length;
    for (const card of qa(painel, '.tropa-card[data-tropa]')) {
      const tipo = card.getAttribute('data-tropa');
      const def = TROOPS[tipo];
      if (!def) continue;
      const estado = el(`tropa-estado-${tipo}`) || q(card, '.tropa-estado');
      const viva = tropas.find((t) => t && t.type === tipo);
      const cd = cooldowns.find((c) => c && c.type === tipo) || null;
      let texto = 'Posicionar';
      let recarga = false;
      let disponivel = true;

      if (viva) {
        const ponto = Number.isFinite(Number(viva.point)) ? Math.round(Number(viva.point)) + 1 : null;
        texto = ponto ? `Viva no ponto ${ponto}` : 'Viva em campo';
        disponivel = false;
      } else if (cd && cd.ready === false) {
        const falta = Math.max(0, Math.ceil(Number(cd.rechargeLeft) || 0));
        texto = `Recarregando ${falta}s`;
        recarga = true;
        disponivel = false;
      } else if (livres <= 0) {
        texto = 'Sem ponto livre';
        disponivel = false;
      }

      const custo = Number(def.cost) || 0;
      setText(estado, texto);
      toggleClass(estado, 'tropa-estado--recarga', recarga);
      setTextIn(card, '.tropa-custo', `$${fmtInt(custo)}`);
      setTextIn(card, '.tropa-nome', def.name || tipo);
      card.disabled = !disponivel || Number(state.money) < custo;
      toggleClass(card, 'tropa-card--posicionando', ui.deployTipo === tipo);
    }
  }

  function updatePanels(state, ui) {
    const painel = ui.panel || null;
    const torres = Array.isArray(state.towers) ? state.towers : [];
    const selecionada =
      painel === 'torre' && ui.selectedTowerId != null
        ? torres.find((t) => t && t.id === ui.selectedTowerId) || null
        : null;

    setHidden('painel-construir', painel !== 'construir');
    setHidden('painel-tropas', painel !== 'tropas');
    setHidden('painel-torre', !(painel === 'torre' && selecionada));

    if (painel === 'construir') updateBuildPanel(state);
    if (painel === 'torre' && selecionada) updateTowerPanel(state, selecionada);
    if (painel === 'tropas') updateTroopsPanel(state, ui);

    toggleClass('btn-tropas', 'botao--ativo', painel === 'tropas');
  }

  // --------------------------------------------------------------- tutorial
  function setTutorial(step) {
    const node = el('tutorial');
    if (step == null || step === false || Number.isNaN(Number(step))) {
      if (node) setHidden(node, true);
      tutorialStepShown = null;
      return;
    }
    const n = Math.max(1, Math.min(TUTORIAL_STEPS.length, Math.round(Number(step))));
    if (node) setHidden(node, false);
    setText('tutorial-passo', `Passo ${n} de ${TUTORIAL_STEPS.length}`);
    setText('tutorial-texto', TUTORIAL_STEPS[n - 1]);
    tutorialStepShown = n;
  }

  function syncTutorial(ui) {
    if (!Object.prototype.hasOwnProperty.call(ui, 'tutorialStep')) return;
    const step = ui.tutorialStep == null ? null : Number(ui.tutorialStep);
    if (step === tutorialStepShown) return;
    setTutorial(step);
  }

  // --------------------------------------------------------------- chefe
  function hideBossAlert() {
    if (alertTimer) {
      clearTimeout(alertTimer);
      alertTimer = 0;
    }
    setHidden('alerta-chefe', true);
  }

  function showBossAlert(boss) {
    setHidden('alerta-chefe', false);
    setText('alerta-chefe-nome', `${boss.name || 'Chefe'} entrou no setor!`);
    if (alertTimer) clearTimeout(alertTimer);
    alertTimer = setTimeout(() => {
      alertTimer = 0;
      setHidden('alerta-chefe', true);
    }, 3000);
  }

  function setBossBar(boss) {
    const barra = el('chefe-barra');
    if (!boss) {
      currentBossId = null;
      if (barra) setHidden(barra, true);
      hideBossAlert();
      return;
    }
    if (barra) setHidden(barra, false);
    setText('chefe-nome', boss.name || 'Chefe');
    const vida = el('chefe-vida');
    const maxHp = Number(boss.maxHp) || 0;
    const hp = Math.max(0, Number(boss.hp) || 0);
    const pct = maxHp > 0 ? Math.max(0, Math.min(100, (hp / maxHp) * 100)) : 0;
    if (vida && vida.style) vida.style.width = `${pct.toFixed(1)}%`;
    setText('chefe-vida-texto', `${fmtInt(hp)} / ${fmtInt(maxHp)} · ${pctText(hp, maxHp)}`);
    if (boss.id !== currentBossId) {
      currentBossId = boss.id;
      showBossAlert(boss);
    }
  }

  // --------------------------------------------------------------- toast
  function toast(texto) {
    const node = el('toast');
    if (!node) return;
    if (texto == null || texto === '') {
      setHidden(node, true);
      lastToastText = '';
      return;
    }
    const textoStr = String(texto);
    lastToastText = textoStr;
    setText(node, textoStr);
    setHidden(node, false);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = 0;
      setHidden(node, true);
    }, 2800);
  }

  // --------------------------------------------------------------- update
  function update(state, ui) {
    if (!state) return;
    lastState = state;
    lastUi = ui && typeof ui === 'object' ? ui : {};
    const u = lastUi;

    setText('hud-dinheiro', fmtInt(state.money));
    setText('hud-vidas', fmtInt(state.lives));
    setText('hud-onda', `Onda ${localWave(state)}/8`);
    setText('hud-mapa', state.mapName || MAP_NAMES[state.mapId] || 'Setor');
    updateWaveButton(state);

    const speed = u.speed === 2 || state.speed === 2 ? 2 : 1;
    setText('btn-velocidade', `${speed}x`);
    const muted = typeof u.muted === 'boolean' ? u.muted : !!state.muted;
    setText('btn-mudo', muted ? 'Mudo' : 'Som');
    const btnMudo = el('btn-mudo');
    if (btnMudo) btnMudo.setAttribute && btnMudo.setAttribute('aria-pressed', muted ? 'true' : 'false');
    setText('btn-pausa', 'Pausar');

    updatePanels(state, u);
    updateDica(state, u);
    syncTutorial(u);

    const boss = Object.prototype.hasOwnProperty.call(u, 'boss') ? u.boss : state.boss || null;
    setBossBar(boss || null);

    if (typeof u.toast === 'string' && u.toast && u.toast !== lastToastText) toast(u.toast);
  }

  function dispose() {
    for (const [node, type, fn] of listeners) {
      try {
        node.removeEventListener(type, fn);
      } catch (err) {
        /* ignora */
      }
    }
    listeners.length = 0;
    if (toastTimer) clearTimeout(toastTimer);
    if (alertTimer) clearTimeout(alertTimer);
    toastTimer = 0;
    alertTimer = 0;
    for (const [, id] of SCREENS) {
      const node = el(id);
      if (!node) continue;
      setHidden(node, true);
      toggleClass(node, 'active', false);
    }
    for (const id of ['painel-construir', 'painel-torre', 'painel-tropas', 'tutorial', 'toast', 'alerta-chefe', 'chefe-barra']) {
      setHidden(id, true);
    }
    lastState = null;
    lastUi = {};
  }

  return {
    update,
    showScreen,
    toast,
    setTutorial,
    updateMaps,
    setBossBar,
    dispose,
  };
}

export default createHud;
