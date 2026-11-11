// HUD e telas do Torre de Ferro — tudo em pt-BR, só DOM + handlers.
// Não conhece engine, Three.js nem localStorage: quem manda é o main.js.
// API fixa: createHud({ handlers }) -> { update, showScreen, toast, setTutorial,
// updateMaps, setBossBar, dispose }.

import {
  TOWERS, TROOPS, TROOP_ORDER, MAP_ORDER, MAP_NAMES,
  TOTAL_PHASES, WAVES_PER_PHASE, PHASES_PER_SCENARIO,
  TOWER_UNLOCK_PHASE, TROOP_UNLOCK_PHASE, UPGRADE_UNLOCK_PHASE,
  phasesForScenario, isPhaseUnlocked, completedPhaseCount,
  towerUnlocked, troopUnlocked, upgradeUnlocked,
} from '../sim/data.js';

const TODAS_AS_FASES = TOTAL_PHASES || 20;
const ONDAS_POR_FASE = WAVES_PER_PHASE || 2;

const SCREENS = [
  ['menu', 'screen-menu'],
  ['maps', 'screen-maps'],
  ['game', 'screen-game'],
  ['victory', 'screen-victory'],
  ['campanha', 'screen-campanha'],
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

// Textos do tutorial de 6 passos (fase 1).
export const TUTORIAL_STEPS = [
  'Bem-vindo ao último posto, comandante! São 20 fases e 2 ondas por fase. Construa torres nos círculos claros ao lado do caminho.',
  'Clique em um slot vazio do campo e escolha uma torre no painel Construir. Torres bloqueadas mostram a fase de desbloqueio.',
  'Inicie a onda quando estiver pronto — ou aguarde a preparação. Cada fase tem 2 ondas: a segunda costuma ser mais pesada.',
  'Clique em uma torre para abrir o painel e melhorá-la: mais dano, alcance e cadência. Nível 2 libera na fase 2 e nível 3 na fase 5.',
  'Posicione tropas especiais nos pontos marcados. Fuzileiros bloqueiam terrestres; antiaérea libera na fase 3 e sniper na fase 5.',
  'São 20 fases em 3 cenários. Chefes nas fases 5, 10, 15 e 20 (terrestre, aéreo, terrestre e mecha): concentre o fogo e proteja a base!',
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

// ------------------------------------------------------- helpers de progressão
// Recebem o snapshot do estado/save; não tocam em engine nem localStorage.
function faseAtual(state) {
  const n = Math.round(Number(state && state.phaseNumber));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function totalFases(state) {
  const n = Math.round(Number(state && state.totalPhases));
  return Number.isFinite(n) && n >= 1 ? n : TODAS_AS_FASES;
}

function ondasDaFase(state) {
  const n = Math.round(Number(state && state.wavesPerPhase));
  return Number.isFinite(n) && n >= 1 ? n : ONDAS_POR_FASE;
}

function torreLiberada(state, tipo) {
  const u = state && state.unlocks && state.unlocks.towers;
  if (u && typeof u[tipo] === 'boolean') return u[tipo];
  return towerUnlocked(tipo, faseAtual(state));
}

function tropaLiberada(state, tipo) {
  const u = state && state.unlocks && state.unlocks.troops;
  if (u && typeof u[tipo] === 'boolean') return u[tipo];
  return troopUnlocked(tipo, faseAtual(state));
}

// Nível de melhoria bloqueado: devolve a fase mínima, ou null se liberado.
function desbloqueioNivel(state, nivel) {
  const u = state && state.unlocks && state.unlocks.upgrades;
  if (u && typeof u[nivel] === 'boolean') return u[nivel] ? null : (UPGRADE_UNLOCK_PHASE[nivel] || null);
  return upgradeUnlocked(nivel, faseAtual(state)) ? null : (UPGRADE_UNLOCK_PHASE[nivel] || null);
}

function fasesConcluidas(save) {
  if (!save || typeof save !== 'object') return 0;
  try {
    return completedPhaseCount(save);
  } catch (err) {
    return 0;
  }
}

function estrelasTotais(save) {
  const fases = save && Array.isArray(save.phases) ? save.phases : [];
  let total = 0;
  for (const info of fases) {
    total += Math.max(0, Math.min(3, Math.round(Number(info && info.stars) || 0)));
  }
  return total;
}

function faseLiberadaNoSave(save, fase) {
  try {
    return isPhaseUnlocked(save, fase);
  } catch (err) {
    return fase === 1;
  }
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
  bindClick('btn-campanha-missoes', 'missoesVitoria');
  bindClick('btn-campanha-menu', 'voltarMenu');
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

  // Cartões de missão são gerados aqui (#map-list começa vazio): 20 fases agrupadas por cenário.
  const mapList = el('map-list');
  on(mapList, 'click', (ev) => {
    const alvo = ev && ev.target;
    if (!alvo || typeof alvo.closest !== 'function') return;
    const card = alvo.closest('.fase-card');
    if (!card || card.disabled) return;
    const fase = Number(card.getAttribute('data-fase'));
    if (Number.isFinite(fase) && fase >= 1) call('selecionarFase', fase);
  });

  // --------------------------------------------------------------- missões (20 fases)
  function fasesDoCenario(cenario) {
    try {
      const lista = phasesForScenario(cenario);
      if (Array.isArray(lista) && lista.length) {
        return lista
          .map((item) => (typeof item === 'object' ? Number(item.phase) : Number(item)))
          .filter((fase) => Number.isFinite(fase) && fase >= 1 && fase <= TODAS_AS_FASES)
          .map((fase, i, arr) => (arr.indexOf(fase) === i ? fase : null))
          .filter((fase) => fase != null);
      }
    } catch (err) {
      /* usa o fallback abaixo */
    }
    // Fallback: deriva o intervalo do cenário a partir de PHASES_PER_SCENARIO.
    const contagem = PHASES_PER_SCENARIO || { deserto: 7, neve: 7, cidade: 6 };
    let inicio = 1;
    for (const id of MAP_ORDER) {
      const qtd = Math.max(0, Math.round(Number(contagem[id]) || 0));
      if (id === cenario) return Array.from({ length: qtd }, (_, i) => inicio + i);
      inicio += qtd;
    }
    return [];
  }

  function intervaloDoGrupo(fases) {
    if (!fases.length) return '';
    const primeiro = fases[0];
    const ultimo = fases[fases.length - 1];
    return primeiro === ultimo ? `Fase ${primeiro}` : `Fases ${primeiro}–${ultimo}`;
  }

  function criarCardFase(fase, cenario) {
    const card = document.createElement('button');
    card.className = 'fase-card';
    card.type = 'button';
    card.setAttribute('data-fase', String(fase));

    const numero = document.createElement('span');
    numero.className = 'fase-numero';
    numero.textContent = `Fase ${fase}`;

    const nomeCenario = document.createElement('span');
    nomeCenario.className = 'fase-cenario';
    nomeCenario.textContent = MAP_NAMES[cenario] || cenario;

    const estrelas = document.createElement('span');
    estrelas.className = 'fase-estrelas';
    estrelas.textContent = '☆☆☆';

    const estado = document.createElement('span');
    estado.className = 'fase-estado';
    estado.textContent = 'Disponível';

    const cadeado = document.createElement('span');
    cadeado.className = 'fase-cadeado';
    cadeado.setAttribute('aria-hidden', 'true');
    cadeado.textContent = '🔒';

    card.appendChild(numero);
    card.appendChild(nomeCenario);
    card.appendChild(estrelas);
    card.appendChild(estado);
    card.appendChild(cadeado);
    return card;
  }

  function ensureFaseCards() {
    const list = el('map-list');
    if (!list || typeof document.createElement !== 'function') return [];
    let cards = qa(list, '.fase-card[data-fase]');
    if (cards.length >= TODAS_AS_FASES) return cards;

    list.textContent = '';
    cards = [];
    for (const cenario of MAP_ORDER) {
      const fases = fasesDoCenario(cenario);
      if (!fases.length) continue;
      const grupo = document.createElement('section');
      grupo.className = 'fase-grupo';
      grupo.setAttribute('data-cenario', cenario);

      const titulo = document.createElement('h3');
      titulo.className = 'fase-grupo-titulo';
      titulo.textContent = `${MAP_NAMES[cenario] || cenario} · ${intervaloDoGrupo(fases)}`;

      const grid = document.createElement('div');
      grid.className = 'fase-grid';
      for (const fase of fases) {
        const card = criarCardFase(fase, cenario);
        grid.appendChild(card);
        cards.push(card);
      }
      grupo.appendChild(titulo);
      grupo.appendChild(grid);
      list.appendChild(grupo);
    }
    return cards;
  }

  function updateMaps(save) {
    if (save && typeof save === 'object') lastSave = save;
    const cards = ensureFaseCards();
    const fonte = save && typeof save === 'object' ? save : lastSave;
    const fases = fonte && Array.isArray(fonte.phases) ? fonte.phases : [];
    const total = TODAS_AS_FASES;

    let concluidas = 0;
    for (const card of cards) {
      const fase = Number(card.getAttribute('data-fase'));
      const info = fases[fase - 1] && typeof fases[fase - 1] === 'object' ? fases[fase - 1] : {};
      const liberada = faseLiberadaNoSave(fonte, fase);
      const stars = liberada ? Math.max(0, Math.min(3, Math.round(Number(info.stars) || 0))) : 0;
      const concluida = liberada && info.completed === true;
      const bestLives = Math.max(0, Math.round(Number(info.bestLives) || 0));
      if (concluida) concluidas += 1;

      setTextIn(card, '.fase-numero', `Fase ${fase}`);
      setTextIn(card, '.fase-estrelas', starsText(stars));

      let estado;
      if (!liberada) {
        estado = 'Bloqueada';
      } else if (concluida) {
        estado = `Concluída${bestLives > 0 ? ` · melhor: ${fmtInt(bestLives)} vidas` : ''}`;
      } else {
        estado = 'Disponível';
      }
      setTextIn(card, '.fase-estado', estado);

      card.disabled = !liberada;
      if (card.classList) {
        card.classList.toggle('fase-card--bloqueada', !liberada);
        card.classList.toggle('fase-card--concluida', concluida);
        card.classList.toggle('fase-card--disponivel', liberada && !concluida);
      }
      const cadeado = q(card, '.fase-cadeado');
      if (cadeado) setHidden(cadeado, liberada);
      if (card.setAttribute) {
        card.setAttribute('aria-label', liberada ? `Fase ${fase}, ${estado}` : `Fase ${fase}, bloqueada`);
      }
    }

    const progresso = el('map-progresso');
    if (progresso) {
      const totalStars = estrelasTotais(fonte);
      setText(
        progresso,
        `${fmtInt(concluidas)}/${fmtInt(total)} fases concluídas · ${fmtInt(totalStars)}/${fmtInt(total * 3)} estrelas`,
      );
    }
    return { concluidas, total, estrelas: estrelasTotais(fonte) };
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
      if (info.faseLabel) {
        setText('vitoria-mapa', info.faseLabel);
      } else if (info.phaseNumber) {
        setText('vitoria-mapa', `Fase ${fmtInt(info.phaseNumber)}/${fmtInt(info.totalPhases || TODAS_AS_FASES)}`);
      } else if (info.mapName) {
        setText('vitoria-mapa', info.mapName);
      }
    }
    if (nome === 'campanha') {
      const save = dados && dados.save ? dados.save : lastSave;
      const total = TODAS_AS_FASES;
      const fasesOk = fasesConcluidas(save);
      const estrelas = estrelasTotais(save);
      setText('campanha-fases', `${fmtInt(fasesOk)}/${fmtInt(total)} fases concluídas`);
      setText('campanha-estrelas', `${fmtInt(estrelas)}/${fmtInt(total * 3)}`);
      const detalhe = el('campanha-detalhe');
      if (detalhe) {
        const vidas = save && save.totals ? Math.round(Number(save.totals.kills) || 0) : 0;
        setText(detalhe, `Abates na campanha: ${fmtInt(vidas)} · bônus permanente: +$${fmtInt(save && save.bonusPermanent)}`);
      }
    }
    if (nome === 'defeat') {
      const info = dados || {};
      if (info.faseLabel) {
        setText('derrota-mapa', info.faseLabel);
      } else if (info.phaseNumber) {
        setText('derrota-mapa', `Fase ${fmtInt(info.phaseNumber)}/${fmtInt(info.totalPhases || TODAS_AS_FASES)} · ${info.scenarioName || info.mapName || ''}`.trim());
      } else if (info.mapName) {
        setText('derrota-mapa', info.mapName);
      }
    }
    // Entrar em jogo/esconder overlays fecha tutorial? Não: o tutorial é do jogo.
  }

  // --------------------------------------------------------------- HUD topo
  function ondaLocal(state) {
    // `state.wave` é a onda local (1..2) no contrato; o módulo cobre também um
    // eventual valor global (1..40), que daria o mesmo resultado local.
    const bruta = Math.max(1, Math.round(Number(state.wave) || 1));
    const porFase = ondasDaFase(state);
    return ((bruta - 1) % porFase) + 1;
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
      setText(btn, phase === 'victory' ? 'Fase defendida' : 'Fim de partida');
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
  // Cria (uma vez) o selo de desbloqueio dentro do card e atualiza o estado.
  function garantirBloqueio(card, classe) {
    let span = q(card, `.${classe}`);
    if (!span && typeof document.createElement === 'function') {
      span = document.createElement('span');
      span.className = classe;
      card.appendChild(span);
    }
    return span;
  }

  function marcarBloqueio(card, bloqueado, faseMin, classeSelo, classeCard) {
    const selo = garantirBloqueio(card, classeSelo);
    if (selo) {
      setText(selo, bloqueado ? `Desbloqueia na fase ${fmtInt(faseMin)}` : '');
      setHidden(selo, !bloqueado);
    }
    toggleClass(card, classeCard, !!bloqueado);
  }

  function updateBuildPanel(state) {
    const painel = el('painel-construir');
    if (!painel) return;
    for (const card of qa(painel, '.torre-card[data-torre]')) {
      const tipo = card.getAttribute('data-torre');
      const def = TOWERS[tipo];
      if (!def) continue;
      const custo = Array.isArray(def.costs) ? def.costs[0] : 0;
      const liberada = torreLiberada(state, tipo);
      const faseMin = TOWER_UNLOCK_PHASE ? TOWER_UNLOCK_PHASE[tipo] : null;

      setTextIn(card, '.torre-nome', def.name || tipo);
      setTextIn(card, '.torre-alvo', `Alvo: ${ALVO_NOME[def.target] || 'qualquer'}${def.effect === 'splash' ? ' · área' : ''}${def.effect === 'chain' ? ' · cadeia' : ''}${def.effect === 'slow' ? ' · lentidão' : ''}${def.effect === 'missile' ? ' · teleguiado' : ''}`);
      setTextIn(card, '.torre-custo', `$${fmtInt(custo)}`);
      marcarBloqueio(card, !liberada, faseMin, 'torre-bloqueio', 'torre-card--bloqueada');
      card.disabled = !liberada || Number(state.money) < Number(custo);
      toggleClass(card, 'torre-card--indisponivel', liberada && card.disabled);
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
      const faseBloqueio = custo == null ? null : desbloqueioNivel(state, nivel + 1);
      if (custo == null) {
        btnMelhorar.disabled = true;
        setText(btnMelhorar, 'Nível máximo');
        toggleClass(btnMelhorar, 'botao--bloqueado', false);
      } else if (faseBloqueio != null) {
        btnMelhorar.disabled = true;
        setText(btnMelhorar, `Desbloqueia na fase ${fmtInt(faseBloqueio)}`);
        toggleClass(btnMelhorar, 'botao--bloqueado', true);
      } else {
        btnMelhorar.disabled = Number(state.money) < custo;
        setText(btnMelhorar, `Melhorar $${fmtInt(custo)}`);
        toggleClass(btnMelhorar, 'botao--bloqueado', false);
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
      const liberada = tropaLiberada(state, tipo);
      const faseMin = TROOP_UNLOCK_PHASE ? TROOP_UNLOCK_PHASE[tipo] : null;
      const viva = tropas.find((t) => t && t.type === tipo);
      const cd = cooldowns.find((c) => c && c.type === tipo) || null;
      let texto = 'Posicionar';
      let recarga = false;
      let disponivel = true;

      if (!liberada) {
        texto = `Desbloqueia na fase ${fmtInt(faseMin)}`;
        disponivel = false;
      } else if (viva) {
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
      marcarBloqueio(card, !liberada, faseMin, 'tropa-bloqueio', 'tropa-card--bloqueada');
      card.disabled = !disponivel || !liberada || Number(state.money) < custo;
      toggleClass(card, 'tropa-card--posicionando', liberada && ui.deployTipo === tipo);
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

  // BUG-MOB-04: em toque, ancora a barra do chefe logo abaixo da HUD real
  // (as linhas da HUD variam com largura/fonte). O CSS já dá o fallback em rem;
  // aqui refinamos em px para nunca cobrir/intersectar os botões.
  let ultimoTopoBarra = null;

  function ehToque() {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(pointer: coarse)').matches;
    } catch (err) {
      return false;
    }
  }

  function posicionarBarraChefe() {
    const barra = el('chefe-barra');
    const hud = el('hud-top');
    if (!barra || !hud || !barra.style) return;
    if (!ehToque()) {
      if (barra.style.top) barra.style.top = '';
      ultimoTopoBarra = null;
      return;
    }
    const hudBottom = hud.getBoundingClientRect ? hud.getBoundingClientRect().bottom : 0;
    if (!Number.isFinite(hudBottom) || hudBottom <= 0) return;
    const topo = Math.round(hudBottom + 10);
    if (topo === ultimoTopoBarra) return;
    ultimoTopoBarra = topo;
    barra.style.top = `${topo}px`;
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
    posicionarBarraChefe();
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
    setText('hud-onda', `Fase ${fmtInt(faseAtual(state))}/${fmtInt(totalFases(state))} · Onda ${fmtInt(ondaLocal(state))}/${fmtInt(ondasDaFase(state))}`);
    setText('hud-mapa', state.scenarioName || state.mapName || MAP_NAMES[state.scenario] || MAP_NAMES[state.mapId] || 'Cenário');
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
