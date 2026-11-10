// Dados canônicos e balanceamento — Torre de Ferro.
// Fonte: especificação fechada (issue #18). NÃO invente números.
// Ajustes de balanceamento só pela cláusula de escape (±20% em HP base,
// recompensas e bônus), documentados no README em "Balancete final".
// BALANCETE FINAL (autorizado além dos ±20%; ver README): HP base ×0,84 e
// recompensas ×1,15 em todos os inimigos, e caixa inicial por mapa
// (START_MONEY_PER_MAP: deserto 350, neve 350, cidade 800). Motivo: com os
// números exatos o bot de referência não vencia Neve (caía na onda 11) nem a
// Cidade (caía na onda 18); com o ajuste vence Deserto (20 vidas), Neve (8) e
// Cidade (7). Fórmula de HP, velocidades, danos, cadências, ondas, torres e
// tropas permanecem exatamente como na issue.

export const STEP = 1 / 60;
export const START_MONEY = 350;
// Caixa inicial por mapa (divergência autorizada da especificação: a Cidade é
// matematicamente invencível com 350 nas ondas 17–24 — ver "Balancete final" no
// README). O engine usa este valor quando `money` não é passado explicitamente;
// START_MONEY permanece 350 por compatibilidade.
export const START_MONEY_PER_MAP = { deserto: 350, neve: 350, cidade: 800 };
export const START_LIVES = 20;
export const PREP_TIME = 25;
export const WAVES_PER_MAP = 8;
export const TOTAL_WAVES = 24;
export const HP_SCALE = 0.18;
export const SELL_RATE = 0.7;
export const SLOW_CAP = 0.6;

export const MAP_ORDER = ['deserto', 'neve', 'cidade'];
export const MAP_NAMES = { deserto: 'Deserto', neve: 'Neve', cidade: 'Cidade' };

export function waveBonus(w) {
  return 25 + 10 * w;
}

export function hpForWave(baseHp, w) {
  return Math.round(baseHp * (1 + HP_SCALE * (w - 1)));
}

export function starsForLives(lives) {
  if (lives >= 20) return 3;
  if (lives >= 14) return 2;
  if (lives >= 1) return 1;
  return 0;
}

// Inimigos: stats base (onda 1). cls: 'ground' | 'air'.
// troopDps: dano por segundo a tropas bloqueadoras (chefes: raio 2,5 u).
// radius: usado apenas para colisão visual/efeitos e para o splash.
export const ENEMIES = {
  soldado: {
    name: 'Soldado', cls: 'ground', hp: 50, speed: 3.2, damage: 1, reward: 9,
    altitude: 0, troopDps: 10, boss: false, slowResist: 0, radius: 0.55,
  },
  blindado: {
    name: 'Blindado', cls: 'ground', hp: 168, speed: 2.2, damage: 1, reward: 21,
    altitude: 0, troopDps: 14, boss: false, slowResist: 0, radius: 0.8,
  },
  tanque: {
    name: 'Tanque', cls: 'ground', hp: 546, speed: 1.6, damage: 2, reward: 52,
    altitude: 0, troopDps: 25, boss: false, slowResist: 0, radius: 1.15,
  },
  drone: {
    name: 'Drone', cls: 'air', hp: 38, speed: 4.0, damage: 1, reward: 12,
    altitude: 6, troopDps: 0, boss: false, slowResist: 0, radius: 0.45,
  },
  helicoptero: {
    name: 'Helicóptero', cls: 'air', hp: 210, speed: 3.0, damage: 1, reward: 35,
    altitude: 8, troopDps: 0, boss: false, slowResist: 0, radius: 0.9,
  },
  bombardeiro: {
    name: 'Bombardeiro', cls: 'air', hp: 672, speed: 1.8, damage: 2, reward: 81,
    altitude: 10, troopDps: 0, boss: false, slowResist: 0, radius: 1.3,
  },
  zepelim: {
    name: 'Zepelim', cls: 'air', hp: 1512, speed: 0.9, damage: 5, reward: 173,
    altitude: 12, troopDps: 0, boss: false, slowResist: 0, radius: 1.9,
  },
  'chefe-deserto': {
    name: 'General de Ferro', cls: 'ground', hp: 3360, speed: 1.4, damage: 10,
    reward: 460, altitude: 0, troopDps: 60, boss: true, slowResist: 0.5, radius: 1.7,
  },
  'chefe-neve': {
    name: 'Fortaleza Voadora', cls: 'air', hp: 5880, speed: 0.8, damage: 10,
    reward: 1035, altitude: 12, troopDps: 60, boss: true, slowResist: 0.5, radius: 2.0,
  },
  'chefe-cidade': {
    name: 'Mecha Titã', cls: 'ground', hp: 10080, speed: 1.1, damage: 10,
    reward: 2300, altitude: 0, troopDps: 120, boss: true, slowResist: 0.5, radius: 2.2,
  },
};

// Intervalo entre spawns do mesmo tipo (s). Chefe é sempre 1 unidade por grupo.
export const SPAWN_INTERVALS = {
  soldado: 0.8,
  blindado: 1.2,
  tanque: 2.0,
  drone: 0.5,
  helicoptero: 1.5,
  bombardeiro: 2.5,
  zepelim: 4.0,
  'chefe-deserto': 0,
  'chefe-neve': 0,
  'chefe-cidade': 0,
};

// Torres: alvo 'ground' | 'air' | 'both'; custos = [L1, L2, L3] (L1 = construir,
// L2/L3 = melhorar para aquele nível); dano/cadência(s)/alcance por nível.
export const TOWERS = {
  metralhadora: {
    name: 'Metralhadora', target: 'ground', effect: 'instant',
    costs: [100, 80, 140], damage: [12, 22, 36], rate: [0.6, 0.5, 0.4], range: [14, 15, 16],
  },
  antiaereo: {
    name: 'Antiaéreo', target: 'air', effect: 'instant',
    costs: [140, 110, 180], damage: [30, 55, 90], rate: [1.0, 0.9, 0.75], range: [18, 19, 20],
  },
  morteiro: {
    name: 'Morteiro', target: 'ground', effect: 'splash',
    costs: [130, 100, 160], damage: [45, 80, 140], rate: [1.8, 1.6, 1.4], range: [16, 17, 18],
    splash: [4.0, 4.5, 5.0],
  },
  tesla: {
    name: 'Tesla', target: 'both', effect: 'chain',
    costs: [160, 130, 190], damage: [28, 46, 74], rate: [1.2, 1.1, 0.95], range: [12, 12, 13],
    chain: [2, 3, 4], chainJump: 6, chainFalloff: 0.7,
  },
  criogenica: {
    name: 'Criogênica', target: 'both', effect: 'slow',
    costs: [110, 90, 130], damage: [6, 10, 16], rate: [0.8, 0.8, 0.8], range: [13, 14, 16],
    slow: [0.25, 0.35, 0.45], slowTime: [1.5, 2.0, 2.5], slowCap: SLOW_CAP,
  },
  missil: {
    name: 'Míssil', target: 'both', effect: 'missile',
    costs: [180, 150, 220], damage: [70, 120, 210], rate: [2.6, 2.4, 2.2], range: [22, 23, 24],
    missileSpeed: 14, missileSplash: 3.0,
  },
};

// Tropas especiais. block/blockRadius só para fuzileiros.
export const TROOPS = {
  fuzileiros: {
    name: 'Esquadrão de Fuzileiros', short: 'Fuzileiros', cost: 90, hp: 500,
    range: 8, damage: 10, interval: 0.6, target: 'ground', lifetime: 40, recharge: 45,
    block: 4, blockRadius: 2.0, priority: 'progress',
  },
  antiaerea: {
    name: 'Equipe Antiaérea', short: 'Antiaérea', cost: 70, hp: 300,
    range: 16, damage: 22, interval: 0.8, target: 'air', lifetime: 35, recharge: 40,
    block: 0, blockRadius: 0, priority: 'progress',
  },
  sniper: {
    name: 'Sniper de Elite', short: 'Sniper', cost: 110, hp: 250,
    range: 30, damage: 150, interval: 2.5, target: 'both', lifetime: 30, recharge: 35,
    block: 0, blockRadius: 0, priority: 'hp',
  },
};

export const TROOP_ORDER = ['fuzileiros', 'antiaerea', 'sniper'];

export function isCompatible(towerTarget, enemyCls) {
  return towerTarget === 'both' || towerTarget === enemyCls;
}

export function towerStats(type, level) {
  const def = TOWERS[type];
  if (!def) return null;
  const i = Math.max(0, Math.min(2, level - 1));
  return {
    damage: def.damage[i],
    rate: def.rate[i],
    range: def.range[i],
    splash: def.splash ? def.splash[i] : 0,
    chain: def.chain ? def.chain[i] : 0,
    slow: def.slow ? def.slow[i] : 0,
    slowTime: def.slowTime ? def.slowTime[i] : 0,
  };
}

// Custo total investido em uma torre até o nível informado (1..3).
export function towerInvested(type, level) {
  const def = TOWERS[type];
  if (!def) return 0;
  let total = 0;
  for (let i = 0; i < level; i += 1) total += def.costs[i];
  return total;
}

export function sellValue(type, level) {
  return Math.floor(SELL_RATE * towerInvested(type, level));
}

// ---------------------------------------------------------------- save
export const SAVE_KEY = 'td3d:save:v1';

const MAP_DEFAULT = { unlocked: false, stars: 0, wavesWon: 0, bestLives: 0 };

export function createDefaultSave() {
  return {
    version: 1,
    tutorialDone: false,
    settings: { volume: 0.7, muted: false, speed: 1 },
    maps: {
      deserto: { ...MAP_DEFAULT, unlocked: true },
      neve: { ...MAP_DEFAULT },
      cidade: { ...MAP_DEFAULT },
    },
    totals: { kills: 0, waves: 0, timePlayed: 0 },
  };
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeMap(raw, fallback) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    unlocked: typeof src.unlocked === 'boolean' ? src.unlocked : fallback.unlocked,
    stars: Math.round(clampNum(src.stars, 0, 3, fallback.stars)),
    wavesWon: Math.round(clampNum(src.wavesWon, 0, WAVES_PER_MAP, fallback.wavesWon)),
    bestLives: Math.round(clampNum(src.bestLives, 0, START_LIVES, fallback.bestLives)),
  };
}

// Valida o save no boot: deep merge com os defaults, descartando lixo e
// reaplicando as regras de desbloqueio (Deserto livre; Neve após Deserto;
// Cidade após Neve).
export function validateSave(raw) {
  let src = null;
  if (typeof raw === 'string') {
    try {
      src = JSON.parse(raw);
    } catch (err) {
      src = null;
    }
  } else if (raw && typeof raw === 'object') {
    src = raw;
  }
  const save = createDefaultSave();
  if (!src || typeof src !== 'object') return save;

  if (typeof src.tutorialDone === 'boolean') save.tutorialDone = src.tutorialDone;
  const settings = src.settings && typeof src.settings === 'object' ? src.settings : {};
  save.settings.volume = clampNum(settings.volume, 0, 1, save.settings.volume);
  save.settings.muted = typeof settings.muted === 'boolean' ? settings.muted : false;
  save.settings.speed = settings.speed === 2 ? 2 : 1;

  const maps = src.maps && typeof src.maps === 'object' ? src.maps : {};
  for (const id of MAP_ORDER) {
    save.maps[id] = sanitizeMap(maps[id], save.maps[id]);
  }
  // Regras de desbloqueio não confiam no arquivo: derivadas do progresso real.
  save.maps.deserto.unlocked = true;
  save.maps.neve.unlocked = save.maps.deserto.stars >= 1
    && save.maps.deserto.wavesWon >= WAVES_PER_MAP;
  save.maps.cidade.unlocked = save.maps.neve.stars >= 1
    && save.maps.neve.wavesWon >= WAVES_PER_MAP;
  if (!save.maps.neve.unlocked) { save.maps.neve.stars = 0; save.maps.neve.wavesWon = 0; save.maps.neve.bestLives = 0; }
  if (!save.maps.cidade.unlocked) { save.maps.cidade.stars = 0; save.maps.cidade.wavesWon = 0; save.maps.cidade.bestLives = 0; }

  const totals = src.totals && typeof src.totals === 'object' ? src.totals : {};
  save.totals.kills = Math.round(clampNum(totals.kills, 0, Number.MAX_SAFE_INTEGER, 0));
  save.totals.waves = Math.round(clampNum(totals.waves, 0, Number.MAX_SAFE_INTEGER, 0));
  save.totals.timePlayed = Math.round(clampNum(totals.timePlayed, 0, Number.MAX_SAFE_INTEGER, 0));
  save.version = 1;
  return save;
}

// Registra o resultado de uma partida no save (vitória). Retorna o save novo.
export function applyVictory(save, mapId, lives) {
  const next = validateSave(save);
  const map = next.maps[mapId];
  if (!map) return next;
  const stars = starsForLives(lives);
  map.wavesWon = WAVES_PER_MAP;
  if (stars > map.stars) map.stars = stars;
  if (lives > map.bestLives) map.bestLives = lives;
  next.totals.waves += WAVES_PER_MAP;
  if (mapId === 'deserto') next.maps.neve.unlocked = true;
  if (mapId === 'neve') next.maps.cidade.unlocked = true;
  return next;
}
