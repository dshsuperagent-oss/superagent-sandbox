// Torre de Ferro — Defesa do Último Posto
// Ponto de integração: motor de simulação puro + cena Three.js + HUD + áudio + efeitos.
// O motor avança em passo fixo de 1/60 s; render/HUD/áudio apenas consomem
// eventos e o snapshot serializável do estado.

import {
  STEP, SAVE_KEY, LEGACY_SAVE_KEY, MAP_ORDER, MAP_NAMES,
  TOTAL_PHASES, WAVES_PER_PHASE, PHASES_PER_SCENARIO,
  starsForLives, applyPhaseVictory, validateSave, createDefaultSave,
  isPhaseUnlocked, completedPhaseCount, scenarioForPhase,
  TOWERS, ENEMIES, TROOP_ORDER,
} from './sim/data.js';
import { DEFAULT_SEED } from './sim/rng.js';
import { getMap } from './sim/maps.js';
import { createEngine } from './sim/engine.js';
import { createScene } from './render/scene.js';
import { createHud } from './render/hud.js';
import { createAudio } from './render/audio.js';
import { createFx } from './render/fx.js';

const $ = (sel) => document.querySelector(sel);

const MENSAGENS_ERRO = {
  'sem-dinheiro': 'Caixa insuficiente.',
  'slot-ocupado': 'Este slot já tem uma torre.',
  'slot-invalido': 'Slot inválido.',
  'nivel-maximo': 'Esta torre já está no nível máximo.',
  'torre-invalida': 'Torre inválida.',
  'tipo-invalido': 'Torre desconhecida.',
  'ponto-ocupado': 'Este ponto de tropa já está ocupado.',
  'ponto-invalido': 'Ponto de tropa inválido.',
  'tropa-viva': 'Já existe uma tropa desse tipo viva.',
  'recarga': 'Tropa recarregando.',
  'onda-em-andamento': 'A onda já está em andamento.',
  'fase-invalida': 'Ação indisponível agora.',
};

function mensagemErro(res) {
  if (!res) return 'Ação indisponível.';
  if (res.error === 'bloqueado' && res.unlockPhase) {
    return `Desbloqueia na fase ${res.unlockPhase}.`;
  }
  return MENSAGENS_ERRO[res.error] || 'Ação indisponível.';
}

function chamarAudio(metodo, ...args) {
  try {
    if (app.audio && typeof app.audio[metodo] === 'function') return app.audio[metodo](...args);
  } catch (err) {
    // áudio nunca pode quebrar a partida
  }
  return null;
}

function chamarFx(metodo, ...args) {
  try {
    if (app.fx && typeof app.fx[metodo] === 'function') return app.fx[metodo](...args);
  } catch (err) {
    // efeitos nunca podem quebrar a partida
  }
  return null;
}

function normalizarFase(valor) {
  const n = Math.round(Number(valor));
  if (!Number.isFinite(n)) return 1;
  return Math.min(TOTAL_PHASES, Math.max(1, n));
}

function gravarSave(save) {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(save));
    return true;
  } catch (err) {
    return false;
  }
}

// Save v2: lê a chave nova; se só existir a v1, migra com validateSave e grava
// a v2 imediatamente (a v1 fica intacta como backup).
function lerSave() {
  try {
    const brutoV2 = window.localStorage.getItem(SAVE_KEY);
    if (brutoV2) return validateSave(brutoV2);
    const brutoV1 = window.localStorage.getItem(LEGACY_SAVE_KEY);
    if (brutoV1) {
      const migrado = validateSave(brutoV1);
      gravarSave(migrado);
      return migrado;
    }
    return createDefaultSave();
  } catch (err) {
    return createDefaultSave();
  }
}

function el(id) {
  return document.getElementById(id);
}

// ------------------------------------------------------------------ estado do app

const app = {
  save: lerSave(),
  engine: null,
  phaseNumber: 1,
  mapId: null,
  scene: null,
  hud: null,
  audio: null,
  fx: null,
  paused: false,
  ended: false,
  matchActive: false,
  speed: 1,
  matchTime: 0,
  acc: 0,
  last: 0,
  fps: 60,
  simEventLog: [],
  ayudaRetorno: 'menu',
};

const ui = {
  screen: 'menu',
  panel: null,
  selectedSlot: null,
  selectedTowerId: null,
  deployTipo: null,
  tutorialStep: null,
  boss: null,
};

// Ajustes carregados do save (speed 1x/2x e som).
app.speed = app.save.settings.speed === 2 ? 2 : 1;

// ------------------------------------------------------------------ navegação de telas

function mostrarTela(nome, dados) {
  ui.screen = nome;
  app.hud.showScreen(nome, dados);
}

function irParaMenu() {
  app.matchActive = false;
  app.ended = false;
  app.engine = null;
  app.paused = false;
  ui.panel = null;
  ui.selectedSlot = null;
  ui.selectedTowerId = null;
  ui.deployTipo = null;
  ui.tutorialStep = null;
  app.hud.setTutorial(null);
  chamarAudio('stopMusic');
  app.hud.setBossBar(null);
  if (app.scene) app.scene.setMap(getMap('deserto'));
  mostrarTela('menu');
}

function abrirMissoes() {
  app.hud.updateMaps(app.save);
  mostrarTela('maps');
}

// Fase inicial da campanha: primeira fase liberada ainda não concluída.
function primeiraFaseDisponivel() {
  for (let fase = 1; fase <= TOTAL_PHASES; fase += 1) {
    const info = app.save.phases && app.save.phases[fase - 1];
    if (isPhaseUnlocked(app.save, fase) && !(info && info.completed)) return fase;
  }
  for (let fase = 1; fase <= TOTAL_PHASES; fase += 1) {
    if (isPhaseUnlocked(app.save, fase)) return fase;
  }
  return 1;
}

// Compatibilidade: __TD__.start({mapId}) de versões antigas aponta para a 1ª fase do cenário.
const PRIMEIRA_FASE_DO_CENARIO = { deserto: 1, neve: 1 + PHASES_PER_SCENARIO.deserto, cidade: 1 + PHASES_PER_SCENARIO.deserto + PHASES_PER_SCENARIO.neve };

function faseDeOpcoes(opcoes) {
  const o = opcoes && typeof opcoes === 'object' ? opcoes : {};
  if (Number.isFinite(Number(o.phase))) return normalizarFase(o.phase);
  if (o.mapId && Number.isFinite(PRIMEIRA_FASE_DO_CENARIO[o.mapId])) return normalizarFase(PRIMEIRA_FASE_DO_CENARIO[o.mapId]);
  if (Number.isFinite(Number(app.phaseNumber))) return normalizarFase(app.phaseNumber);
  return 1;
}

function selecionarFase(fase) {
  const alvo = normalizarFase(fase);
  if (!isPhaseUnlocked(app.save, alvo)) {
    app.hud.toast('Fase bloqueada: complete a fase anterior.');
    chamarAudio('handle', [{ type: 'error' }], null);
    return;
  }
  iniciarPartida(alvo);
}

function iniciarCampanha() {
  iniciarPartida(primeiraFaseDisponivel());
}

function proximaMissao() {
  if (!app.phaseNumber) { abrirMissoes(); return; }
  if (app.phaseNumber >= TOTAL_PHASES) {
    abrirMissoes();
    return;
  }
  const proxima = app.phaseNumber + 1;
  if (isPhaseUnlocked(app.save, proxima)) {
    iniciarPartida(proxima);
  } else {
    abrirMissoes();
    app.hud.toast('Complete a fase atual para liberar a próxima.');
  }
}

function missoesVitoria() {
  app.matchActive = false;
  app.ended = false;
  app.engine = null;
  chamarAudio('stopMusic');
  abrirMissoes();
}

// ------------------------------------------------------------------ partida

function iniciarPartida(fase, opcoes = {}) {
  const numeroFase = Number.isFinite(Number(fase)) ? normalizarFase(fase) : faseDeOpcoes(opcoes);
  const opcoesMotor = {
    phase: numeroFase,
    seed: Number.isFinite(opcoes.seed) ? opcoes.seed : DEFAULT_SEED,
    bonusPermanent: Number.isFinite(opcoes.bonusPermanent)
      ? Number(opcoes.bonusPermanent)
      : (Number(app.save.bonusPermanent) || 0),
    completedPhases: Number.isFinite(opcoes.completedPhases)
      ? Number(opcoes.completedPhases)
      : completedPhaseCount(app.save),
  };
  if (Number.isFinite(opcoes.money)) opcoesMotor.money = Number(opcoes.money);
  if (Number.isFinite(opcoes.lives)) opcoesMotor.lives = Number(opcoes.lives);

  app.phaseNumber = numeroFase;
  app.matchActive = true;
  app.ended = false;
  app.paused = false;
  app.matchTime = 0;
  app.acc = 0;
  app.simEventLog = [];
  ui.panel = null;
  ui.selectedSlot = null;
  ui.selectedTowerId = null;
  ui.deployTipo = null;

  app.engine = createEngine(opcoesMotor);
  const estadoInicial = app.engine.getState();
  app.mapId = estadoInicial.scenario || scenarioForPhase(numeroFase);

  app.scene.setMap(app.engine.getMapDef());
  app.scene.highlightSlot(null);
  app.scene.highlightPoint(null);
  app.hud.setBossBar(null);

  // Tutorial: apenas na fase 1 e enquanto não foi concluído.
  if (numeroFase === 1 && !app.save.tutorialDone) {
    ui.tutorialStep = 1;
  } else {
    ui.tutorialStep = null;
  }
  app.hud.setTutorial(ui.tutorialStep);

  mostrarTela('game');
  chamarAudio('startMusic');
  chamarAudio('setMuted', Boolean(app.save.settings.muted));
  app.last = performance.now();
}

function pausar() {
  if (!app.matchActive || app.ended || ui.screen !== 'game') return;
  app.paused = true;
  mostrarTela('pause');
}

function retomar() {
  if (ui.screen !== 'pause') return;
  app.paused = false;
  mostrarTela('game');
  app.last = performance.now();
}

function alternarPausa() {
  if (ui.screen === 'game') pausar();
  else if (ui.screen === 'pause') retomar();
}

function sairPartida() {
  irParaMenu();
}

function tentarDeNovo() {
  if (app.phaseNumber) iniciarPartida(app.phaseNumber);
  else irParaMenu();
}

function cenarioDaFase(fase) {
  const cenario = scenarioForPhase(fase) || app.mapId || 'deserto';
  return MAP_NAMES[cenario] || cenario;
}

function finalizarPartida(estado) {
  if (app.ended) return;
  app.ended = true;
  app.paused = false;
  app.hud.setTutorial(null);

  const vitoria = estado.phase === 'victory';
  const fase = normalizarFase(estado.phaseNumber || app.phaseNumber || 1);
  let save = app.save;
  if (vitoria) {
    save = applyPhaseVictory(save, fase, estado.lives);
  }
  if (!save.totals || typeof save.totals !== 'object') save.totals = { kills: 0, waves: 0, timePlayed: 0 };
  save.totals.kills = Math.max(0, Math.round(Number(save.totals.kills) || 0)) + Math.max(0, estado.stats ? estado.stats.kills : 0);
  save.totals.timePlayed = Math.max(0, Math.round(Number(save.totals.timePlayed) || 0)) + Math.max(0, Math.round(app.matchTime));
  // Mantém a preferência de velocidade da partida no save.
  save.settings.speed = app.speed;
  app.save = save;
  gravarSave(app.save);

  chamarAudio('stopMusic');
  app.hud.setBossBar(null);

  const cenario = estado.scenarioName || cenarioDaFase(fase);
  const faseLabel = `Fase ${fase}/${TOTAL_PHASES} · ${cenario}`;

  if (vitoria) {
    const estrelas = starsForLives(estado.lives);
    const campanhaConcluida = fase >= TOTAL_PHASES;
    if (campanhaConcluida) {
      // Fase 20 vencida: tela de campanha concluída (SCREENS do hud.js).
      app.hud.showScreen('campanha', { save: app.save });
      ui.screen = 'campanha';
    } else {
      app.hud.showScreen('victory', {
        lives: estado.lives,
        stars: estrelas,
        phaseNumber: fase,
        totalPhases: TOTAL_PHASES,
        scenarioName: cenario,
        faseLabel,
        hasNext: fase < TOTAL_PHASES,
      });
      ui.screen = 'victory';
    }
  } else {
    app.hud.showScreen('defeat', {
      phaseNumber: fase,
      totalPhases: TOTAL_PHASES,
      scenarioName: cenario,
      faseLabel,
      wave: estado.wave,
      lives: estado.lives,
    });
    ui.screen = 'defeat';
  }
}

// ------------------------------------------------------------------ ações de jogo

function atualizarSelecao() {
  if (!app.scene) return;
  app.scene.highlightSlot(ui.panel ? ui.selectedSlot : null);
  app.scene.highlightPoint(null);
}

function fecharPainel() {
  ui.panel = null;
  ui.selectedSlot = null;
  ui.selectedTowerId = null;
  ui.deployTipo = null;
  atualizarSelecao();
}

function abrirPainelTropas() {
  if (!app.matchActive || app.ended) return;
  ui.panel = 'tropas';
  ui.selectedSlot = null;
  ui.selectedTowerId = null;
  atualizarSelecao();
}

function construir(tipo) {
  if (!app.engine) return;
  if (ui.selectedSlot === null || ui.selectedSlot === undefined) {
    app.hud.toast('Clique em um slot vazio primeiro.');
    chamarAudio('handle', [{ type: 'error' }], null);
    return;
  }
  const res = app.engine.buildTower(ui.selectedSlot, tipo);
  if (!res || !res.ok) {
    app.hud.toast(mensagemErro(res));
    chamarAudio('handle', [{ type: 'error' }], null);
    return;
  }
  ui.panel = null;
  ui.selectedSlot = null;
  atualizarSelecao();
}

function melhorar() {
  if (!app.engine) return;
  if (ui.selectedTowerId === null || ui.selectedTowerId === undefined) {
    app.hud.toast('Selecione uma torre.');
    return;
  }
  const res = app.engine.upgradeTower(ui.selectedTowerId);
  if (!res || !res.ok) {
    app.hud.toast(mensagemErro(res));
    chamarAudio('handle', [{ type: 'error' }], null);
  }
}

function vender() {
  if (!app.engine) return;
  if (ui.selectedTowerId === null || ui.selectedTowerId === undefined) {
    app.hud.toast('Selecione uma torre.');
    return;
  }
  const res = app.engine.sellTower(ui.selectedTowerId);
  if (!res || !res.ok) {
    app.hud.toast(mensagemErro(res));
    chamarAudio('handle', [{ type: 'error' }], null);
    return;
  }
  fecharPainel();
}

function posicionarTropa(tipo) {
  if (!app.engine || app.ended) return;
  // Teclas 7/8/9 e botão "Posicionar": se houver ponto livre, posiciona no
  // primeiro livre; senão informa o motivo.
  const estado = app.engine.getState();
  const livre = estado.troopPoints.find((p) => !p.troopId);
  if (!livre) {
    app.hud.toast('Nenhum ponto de tropa livre.');
    chamarAudio('handle', [{ type: 'error' }], null);
    return;
  }
  const res = app.engine.deployTroop(tipo, livre.j);
  if (!res || !res.ok) {
    app.hud.toast(mensagemErro(res));
    chamarAudio('handle', [{ type: 'error' }], null);
    return;
  }
  ui.deployTipo = null;
  if (ui.panel === 'tropas') atualizarSelecao();
}

function iniciarOnda() {
  if (!app.engine || app.ended) return;
  const res = app.engine.startWave();
  if (res === false) {
    app.hud.toast('A onda já está em andamento.');
  }
}

function alternarVelocidade() {
  app.speed = app.speed === 1 ? 2 : 1;
  app.save.settings.speed = app.speed;
  gravarSave(app.save);
}

function alternarMudo() {
  app.save.settings.muted = !app.save.settings.muted;
  chamarAudio('setMuted', Boolean(app.save.settings.muted));
  gravarSave(app.save);
}

function abrirAjuda() {
  app.ayudaRetorno = ui.screen === 'game' ? 'game' : (ui.screen === 'pause' ? 'pause' : 'menu');
  if (ui.screen === 'game') app.paused = true;
  mostrarTela('help');
}

function fecharAjuda() {
  if (app.ayudaRetorno === 'game') {
    app.paused = false;
    mostrarTela('game');
    app.last = performance.now();
  } else if (app.ayudaRetorno === 'pause') {
    mostrarTela('pause');
  } else {
    mostrarTela('menu');
  }
}

function abrirControles() {
  mostrarTela('controls');
}

function fecharControles() {
  mostrarTela('menu');
}

function tutorialOk() {
  if (ui.tutorialStep === null) return;
  if (ui.tutorialStep >= 6) {
    ui.tutorialStep = null;
    app.save.tutorialDone = true;
    gravarSave(app.save);
  } else {
    ui.tutorialStep += 1;
  }
  app.hud.setTutorial(ui.tutorialStep);
}

// ------------------------------------------------------------------ clique no 3D

function aoEscolher({ slot, point }) {
  if (!app.engine || app.ended || ui.screen !== 'game') return;

  if (ui.deployTipo && point !== null && point !== undefined) {
    const res = app.engine.deployTroop(ui.deployTipo, point);
    if (!res || !res.ok) {
      app.hud.toast(mensagemErro(res));
      chamarAudio('handle', [{ type: 'error' }], null);
    } else {
      ui.deployTipo = null;
      ui.panel = null;
      atualizarSelecao();
    }
    return;
  }

  if (point !== null && point !== undefined) {
    ui.panel = 'tropas';
    ui.selectedSlot = null;
    ui.selectedTowerId = null;
    atualizarSelecao();
    return;
  }

  if (slot !== null && slot !== undefined) {
    const estado = app.engine.getState();
    const torre = estado.towers.find((t) => t.slot === slot);
    if (torre) {
      ui.panel = 'torre';
      ui.selectedTowerId = torre.id;
      ui.selectedSlot = slot;
      ui.deployTipo = null;
    } else {
      ui.panel = 'construir';
      ui.selectedSlot = slot;
      ui.selectedTowerId = null;
      ui.deployTipo = null;
    }
    atualizarSelecao();
    return;
  }

  fecharPainel();
}

// ------------------------------------------------------------------ eventos da simulação

function processarEventos(eventos) {
  for (const ev of eventos) {
    if (!ev || !ev.type) continue;
    if (ev.type === 'waveStart') {
      const ondaLocal = ((Math.max(1, Math.round(Number(ev.wave) || 1)) - 1) % WAVES_PER_PHASE) + 1;
      app.hud.toast(`Fase ${app.phaseNumber}/${TOTAL_PHASES} · Onda ${ondaLocal}/${WAVES_PER_PHASE} iniciada.`);
    } else if (ev.type === 'waveEnd') {
      app.hud.toast(`Onda concluída! Bônus de $${ev.bonus}.`);
    } else if (ev.type === 'bossSpawn') {
      app.hud.toast(`Chefe: ${ev.name}`);
    } else if (ev.type === 'leak') {
      app.audio.handle([ev], null);
    } else if (ev.type === 'kill' && ev.boss) {
      app.hud.toast('Chefe eliminado!');
    }
  }
}

function atualizarChefe(estado) {
  if (!estado) return;
  ui.boss = estado.boss || null;
}

// ------------------------------------------------------------------ loop principal

function instantaneoUI() {
  return {
    panel: ui.panel,
    selectedSlot: ui.selectedSlot,
    selectedTowerId: ui.selectedTowerId,
    deployTipo: ui.deployTipo,
    speed: app.speed,
    muted: Boolean(app.save.settings.muted),
    volume: app.save.settings.volume,
    tutorialStep: ui.tutorialStep,
    boss: ui.boss,
  };
}

function loop(agora) {
  window.requestAnimationFrame(loop);
  const bruto = (agora - app.last) / 1000;
  app.last = agora;
  const dt = Math.min(0.1, Math.max(0, Number.isFinite(bruto) ? bruto : 0));

  // FPS suavizado (perf() do __TD__).
  if (dt > 0) app.fps = app.fps * 0.9 + (1 / dt) * 0.1;

  if (app.engine && app.matchActive && !app.ended && !app.paused) {
    app.acc += dt * app.speed;
    let passos = 0;
    const maxPassos = 60 * 5; // no máximo 5 s de simulação por frame
    while (app.acc >= STEP && passos < maxPassos) {
      app.engine.step();
      app.acc -= STEP;
      app.matchTime += STEP;
      passos += 1;
    }
    if (passos >= maxPassos) app.acc = 0;
  }

  let eventos = [];
  let estado = null;
  if (app.engine) {
    eventos = app.engine.drainEvents() || [];
    if (eventos.length) {
      app.simEventLog.push(...eventos);
      if (app.simEventLog.length > 6000) {
        app.simEventLog.splice(0, app.simEventLog.length - 6000);
      }
      estado = app.engine.getState();
      chamarFx('handle', eventos, estado);
      chamarAudio('handle', eventos, estado);
      processarEventos(eventos);
    }
    estado = app.engine.getState();
    atualizarChefe(estado);
    app.scene.update(estado, dt, eventos);
    app.hud.update(estado, instantaneoUI());

    if (!app.ended && (estado.phase === 'victory' || estado.phase === 'defeat')) {
      finalizarPartida(estado);
    }
  } else {
    app.scene.update(null, dt, []);
  }

  chamarFx('update', dt);
  chamarAudio('update', dt);
  app.scene.render();

  // Boot completo: primeiro frame renderizado com cena, HUD e loop prontos.
  const td = window.__TD__;
  if (td && td.ready !== true) td.ready = true;
}

// ------------------------------------------------------------------ teclado

function aoTeclar(ev) {
  if (ev.defaultPrevented) return;
  const tag = ev.target && ev.target.tagName ? ev.target.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  const codigo = ev.code || '';
  const tecla = ev.key || '';

  // Atalhos globais de tela.
  if (tecla === 'Escape') {
    if (ui.screen === 'help') { fecharAjuda(); ev.preventDefault(); return; }
    if (ui.screen === 'controls') { fecharControles(); ev.preventDefault(); return; }
    if (ui.screen === 'pause') { retomar(); ev.preventDefault(); return; }
    if (ui.screen === 'campanha') { irParaMenu(); ev.preventDefault(); return; }
    if (ui.screen === 'game') {
      if (ui.panel) fecharPainel();
      else pausar();
      ev.preventDefault();
    }
    return;
  }

  if (ui.screen !== 'game') return;

  if (tecla === ' ' || codigo === 'Space') { alternarPausa(); ev.preventDefault(); return; }
  if (tecla === 'f' || tecla === 'F') { alternarVelocidade(); ev.preventDefault(); return; }
  if (tecla === 'm' || tecla === 'M') { alternarMudo(); ev.preventDefault(); return; }
  if (tecla === 'n' || tecla === 'N') { iniciarOnda(); ev.preventDefault(); return; }
  if (tecla === 'h' || tecla === 'H') { abrirAjuda(); ev.preventDefault(); return; }
  if (tecla === 'u' || tecla === 'U') { melhorar(); ev.preventDefault(); return; }
  if (tecla === 'v' || tecla === 'V') { vender(); ev.preventDefault(); return; }

  const torres = Object.keys(TOWERS);
  const indice = ['1', '2', '3', '4', '5', '6'].indexOf(tecla);
  if (indice >= 0 && indice < torres.length) {
    construir(torres[indice]);
    ev.preventDefault();
    return;
  }
  const tropas = ['fuzileiros', 'antiaerea', 'sniper'];
  const indiceTropa = ['7', '8', '9'].indexOf(tecla);
  if (indiceTropa >= 0) {
    posicionarTropa(tropas[indiceTropa]);
    ev.preventDefault();
  }
}

// ------------------------------------------------------------------ handlers da HUD

function criarHandlers() {
  return {
    iniciarCampanha,
    abrirMissoes,
    selecionarFase,
    voltarMenu: irParaMenu,
    iniciarOnda,
    pausar,
    retomar,
    sairPartida,
    alternarVelocidade,
    alternarMudo,
    abrirAjuda,
    fecharAjuda,
    abrirControles,
    fecharControles,
    abrirTropas: abrirPainelTropas,
    construir,
    melhorar,
    vender,
    posicionarTropa,
    fecharPainel,
    tutorialOk,
    tentarDeNovo,
    proximaMissao,
    missoesVitoria,
  };
}

// ------------------------------------------------------------------ API de QA (__TD__)

function instalarTD() {
  const TD = {
    // Contrato de QA da expansão (issue #20 / CONTRATO-EXPANSAO.md).
    version: '2.0.0',
    ready: false,
    phases: TOTAL_PHASES,
    scenarios: MAP_ORDER.slice(),
    maps: MAP_ORDER.slice(),
    enemyTypes: Object.keys(ENEMIES),
    towerTypes: Object.keys(TOWERS),
    troopTypes: TROOP_ORDER.slice(),
    start(opcoes) {
      const o = opcoes && typeof opcoes === 'object' ? opcoes : {};
      iniciarPartida(faseDeOpcoes(o), o);
      return true;
    },
    startPhase(fase) {
      iniciarPartida(normalizarFase(fase));
      return true;
    },
    save() {
      try {
        return JSON.parse(JSON.stringify(app.save));
      } catch (err) {
        return null;
      }
    },
    state() {
      return app.engine ? app.engine.getState() : null;
    },
    eventLog(n) {
      const qtd = Number.isFinite(n) ? n : 20;
      return app.simEventLog.slice(-qtd);
    },
    spawnWave(n) {
      if (!app.engine || typeof app.engine.debugStartWave !== 'function') return false;
      app.engine.debugStartWave(Number(n));
      return true;
    },
    spawnEnemy(tipo, quantidade) {
      if (!app.engine || typeof app.engine.debugSpawnEnemy !== 'function') return false;
      app.engine.debugSpawnEnemy(tipo, Number.isFinite(quantidade) ? quantidade : 1);
      return true;
    },
    giveMoney(valor) {
      if (!app.engine || typeof app.engine.debugAddMoney !== 'function') return null;
      app.engine.debugAddMoney(Number(valor) || 0);
      return app.engine.getState().money;
    },
    setLives(valor) {
      if (!app.engine || typeof app.engine.debugSetLives !== 'function') return null;
      app.engine.debugSetLives(Number(valor) || 0);
      return app.engine.getState().lives;
    },
    setSpeed(velocidade) {
      app.speed = Number(velocidade) === 2 ? 2 : 1;
      return app.speed;
    },
    pause() {
      if (ui.screen === 'game') pausar();
      return app.paused;
    },
    resume() {
      retomar();
      return !app.paused;
    },
    fastForward(segundos) {
      if (!app.engine) return false;
      const passos = Math.max(0, Math.round((Number(segundos) || 0) * 60));
      for (let i = 0; i < passos; i += 1) {
        app.engine.step();
        const evs = app.engine.drainEvents() || [];
        if (evs.length) {
          app.simEventLog.push(...evs);
          processarEventos(evs);
        }
      }
      if (app.simEventLog.length > 6000) {
        app.simEventLog.splice(0, app.simEventLog.length - 6000);
      }
      const estado = app.engine.getState();
      if (!app.ended && (estado.phase === 'victory' || estado.phase === 'defeat')) {
        finalizarPartida(estado);
      }
      return true;
    },
    buildTower(slot, tipo) {
      return app.engine ? app.engine.buildTower(Number(slot), tipo) : null;
    },
    upgradeTower(id) {
      return app.engine ? app.engine.upgradeTower(id) : null;
    },
    sellTower(id) {
      return app.engine ? app.engine.sellTower(id) : null;
    },
    deployTroop(tipo, ponto) {
      return app.engine ? app.engine.deployTroop(tipo, Number(ponto)) : null;
    },
    audioLog(n) {
      const qtd = Number.isFinite(n) ? n : 20;
      return app.audio.log().slice(-qtd);
    },
    fxLog(n) {
      const qtd = Number.isFinite(n) ? n : 20;
      return app.fx.log().slice(-qtd);
    },
    perf() {
      const base = app.scene.perf ? app.scene.perf() : {};
      const estado = app.engine ? app.engine.getState() : null;
      return {
        ...base,
        fps: Math.round(app.fps),
        speed: app.speed,
        paused: app.paused,
        screen: ui.screen,
        enemies: estado ? estado.enemies.length : 0,
        particles: app.fx.count ? app.fx.count() : 0,
        money: estado ? estado.money : null,
        lives: estado ? estado.lives : null,
        wave: estado ? estado.wave : null,
        phase: estado ? estado.phase : null,
        phaseNumber: estado ? estado.phaseNumber : null,
        globalWave: estado ? estado.globalWave : null,
      };
    },
    zoomBy(fator) {
      if (!app.scene || typeof app.scene.zoomBy !== 'function') return null;
      return app.scene.zoomBy(Number(fator));
    },
    view() {
      if (!app.scene || typeof app.scene.viewInfo !== 'function') return null;
      return app.scene.viewInfo();
    },
    projectSlot(indice) {
      // Coordenada de tela de um slot (usada pelos testes de toque).
      const estado = app.engine ? app.engine.getState() : null;
      if (!estado || !app.scene || typeof app.scene.project !== 'function') return null;
      const alvo = Number(indice);
      const slot = estado.slots.find((s) => Number(s.i) === alvo);
      if (!slot) return null;
      const p = app.scene.project(slot.x, 0, slot.z);
      return { x: p.x, y: p.y, visible: p.visible, slot: alvo };
    },
    win() {
      if (app.engine && typeof app.engine.forceWin === 'function') app.engine.forceWin();
      return true;
    },
    lose() {
      if (app.engine && typeof app.engine.forceLose === 'function') app.engine.forceLose();
      return true;
    },
  };
  window.__TD__ = TD;
}

// ------------------------------------------------------------------ boot

function desbloquearAudio() {
  try {
    app.audio.unlock();
  } catch (err) {
    // áudio indisponível não pode quebrar o jogo
  }
}

// PWA: permite instalar na tela inicial (Android/iPad) e jogar offline após a 1ª visita.
function registrarServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (typeof location !== 'undefined' && location.protocol === 'file:') return;
  try {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline é opcional: sem SW o jogo continua funcionando online */
    });
  } catch (err) {
    /* idem */
  }
}

function iniciar() {
  const canvas = el('cena');
  if (!canvas) throw new Error('Canvas #cena ausente.');

  app.scene = createScene({ canvas, onPick: aoEscolher, onHover: null });
  app.hud = createHud({ handlers: criarHandlers() });
  app.audio = createAudio({ getSettings: () => app.save.settings });
  app.fx = createFx({ sceneApi: app.scene });

  app.hud.updateMaps(app.save);
  app.scene.setMap(getMap('deserto'));
  mostrarTela('menu');

  window.addEventListener('resize', () => {
    if (app.scene && app.scene.resize) app.scene.resize();
  });
  window.addEventListener('keydown', aoTeclar);
  const desbloquear = () => {
    desbloquearAudio();
    window.removeEventListener('pointerdown', desbloquear);
    window.removeEventListener('keydown', desbloquear);
  };
  window.addEventListener('pointerdown', desbloquear);
  window.addEventListener('keydown', desbloquear);

  instalarTD();

  // Zoom por botões (útil no toque; a pinça no canvas também funciona).
  // Aproximar = reduzir a distância da câmera.
  const btnZoomMais = el('btn-zoom-mais');
  const btnZoomMenos = el('btn-zoom-menos');
  if (btnZoomMais) btnZoomMais.addEventListener('click', () => app.scene.zoomBy(0.8));
  if (btnZoomMenos) btnZoomMenos.addEventListener('click', () => app.scene.zoomBy(1.25));

  registrarServiceWorker();

  app.last = performance.now();
  window.requestAnimationFrame(loop);
}

try {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
} catch (err) {
  // Mostra um aviso legível em vez de uma tela preta.
  const aviso = document.createElement('div');
  aviso.className = 'sem-js';
  aviso.textContent = 'Não foi possível iniciar o jogo 3D: ' + (err && err.message ? err.message : 'erro desconhecido') + '. Verifique se o WebGL está habilitado.';
  document.body.appendChild(aviso);
}
