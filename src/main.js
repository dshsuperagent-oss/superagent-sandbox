// Torre de Ferro — Defesa do Último Posto
// Ponto de integração: motor de simulação puro + cena Three.js + HUD + áudio + efeitos.
// O motor avança em passo fixo de 1/60 s; render/HUD/áudio apenas consomem
// eventos e o snapshot serializável do estado.

import {
  STEP, START_MONEY, START_MONEY_PER_MAP, START_LIVES, SAVE_KEY, MAP_ORDER, MAP_NAMES,
  starsForLives, applyVictory, validateSave, createDefaultSave, TOWERS, ENEMIES, TROOP_ORDER,
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

function lerSave() {
  try {
    const bruto = window.localStorage.getItem(SAVE_KEY);
    if (!bruto) return createDefaultSave();
    return validateSave(bruto);
  } catch (err) {
    return createDefaultSave();
  }
}

function gravarSave(save) {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(save));
    return true;
  } catch (err) {
    return false;
  }
}

function el(id) {
  return document.getElementById(id);
}

// ------------------------------------------------------------------ estado do app

const app = {
  save: lerSave(),
  engine: null,
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

function selecionarMapa(mapId) {
  const mapa = getMap(mapId);
  if (!mapa) return;
  const dados = app.save.maps[mapId];
  if (!dados || !dados.unlocked) {
    app.hud.toast('Bloqueado (complete o mapa anterior)');
    chamarAudio('handle', [{ type: 'error' }], null);
    return;
  }
  iniciarPartida(mapId);
}

function primeiroMapaDisponivel() {
  for (const id of MAP_ORDER) {
    const dados = app.save.maps[id];
    if (dados && dados.unlocked && dados.stars === 0) return id;
  }
  for (const id of MAP_ORDER) {
    if (app.save.maps[id] && app.save.maps[id].unlocked) return id;
  }
  return 'deserto';
}

function iniciarCampanha() {
  iniciarPartida(primeiroMapaDisponivel());
}

function proximaMissao() {
  if (!app.mapId) { abrirMissoes(); return; }
  const idx = MAP_ORDER.indexOf(app.mapId);
  const proximo = MAP_ORDER[idx + 1];
  if (proximo && app.save.maps[proximo] && app.save.maps[proximo].unlocked) {
    iniciarPartida(proximo);
  } else if (proximo) {
    abrirMissoes();
  } else {
    app.hud.updateMaps(app.save);
    mostrarTela('maps');
    app.hud.toast('Você defendeu todos os setores!');
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

function iniciarPartida(mapId, opcoes = {}) {
  const mapa = getMap(mapId) || getMap('deserto');
  if (!mapa) return;

  app.mapId = mapa.id;
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

  app.engine = createEngine({
    mapId: mapa.id,
    seed: Number.isFinite(opcoes.seed) ? opcoes.seed : DEFAULT_SEED,
    money: Number.isFinite(opcoes.money)
      ? opcoes.money
      : (START_MONEY_PER_MAP[mapa.id] ?? START_MONEY),
    lives: Number.isFinite(opcoes.lives) ? opcoes.lives : START_LIVES,
  });

  app.scene.setMap(app.engine.getMapDef());
  app.scene.highlightSlot(null);
  app.scene.highlightPoint(null);
  app.hud.setBossBar(null);

  // Tutorial: apenas no Deserto e enquanto não foi concluído.
  if (mapa.id === 'deserto' && !app.save.tutorialDone) {
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
  if (app.mapId) iniciarPartida(app.mapId);
  else irParaMenu();
}

function finalizarPartida(estado) {
  if (app.ended) return;
  app.ended = true;
  app.paused = false;
  app.hud.setTutorial(null);

  const vitoria = estado.phase === 'victory';
  let save = app.save;
  if (vitoria) {
    save = applyVictory(save, app.mapId, estado.lives);
  }
  save.totals.kills += Math.max(0, estado.stats ? estado.stats.kills : 0);
  save.totals.timePlayed += Math.max(0, Math.round(app.matchTime));
  // Mantém a preferência de velocidade da partida no save.
  save.settings.speed = app.speed;
  app.save = save;
  gravarSave(app.save);

  chamarAudio('stopMusic');
  app.hud.setBossBar(null);

  if (vitoria) {
    const estrelas = starsForLives(estado.lives);
    app.hud.showScreen('victory', {
      lives: estado.lives,
      stars: estrelas,
      mapId: app.mapId,
      mapName: MAP_NAMES[app.mapId] || app.mapId,
      hasNext: MAP_ORDER.indexOf(app.mapId) < MAP_ORDER.length - 1,
    });
    ui.screen = 'victory';
  } else {
    app.hud.showScreen('defeat', {
      mapId: app.mapId,
      mapName: MAP_NAMES[app.mapId] || app.mapId,
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
      app.hud.toast(`Onda ${((ev.wave - 1) % 8) + 1} iniciada.`);
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
    selecionarMapa,
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
    // Contrato de QA exigido pela issue #18 / DESIGN §15.2 (campos + métodos).
    version: '1.0.0',
    ready: false,
    maps: MAP_ORDER.slice(),
    enemyTypes: Object.keys(ENEMIES),
    towerTypes: Object.keys(TOWERS),
    troopTypes: TROOP_ORDER.slice(),
    start(opcoes) {
      iniciarPartida((opcoes && opcoes.mapId) || 'deserto', opcoes || {});
      return true;
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
