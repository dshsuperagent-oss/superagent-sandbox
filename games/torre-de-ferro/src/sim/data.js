// Dados canônicos e balanceamento — Torre de Ferro.
// Fonte: especificação fechada original (issue #18) + expansão da campanha
// (issue #20): 20 fases × 2 ondas = 40 ondas, progressão de recursos e
// desbloqueios por fase. NÃO invente números além do que está especificado.
//
// BALANCETE DA EXPANSÃO (documentado no README, seção "Balancete da expansão"):
// a composição das 40 ondas deriva das 24 ondas originais, reorganizada em
// 2 ondas por fase e escalada; HP base ×0,84 e recompensas base ×1,15 da
// issue #18 seguem valendo (números finais da tabela ENEMIES). A curva de HP
// usa o número da onda global (1..40) e foi ajustada para o bot de referência
// vencer as 20 fases com vidas ≥ 8 por fase.

export const STEP = 1 / 60;
// Caixa inicial da fase 1 (a fórmula da issue #20 é
// 300 + 25×(fase−1) + bônusPermanente; ver startingMoneyFor).
export const START_MONEY = 300;
export const START_LIVES = 20;
export const PREP_TIME = 25;
export const HP_SCALE = 0.03;
export const SELL_RATE = 0.7;
export const SLOW_CAP = 0.6;

// ---------------------------------------------------------------- campanha
export const TOTAL_PHASES = 20;
export const WAVES_PER_PHASE = 2;
export const TOTAL_WAVES = TOTAL_PHASES * WAVES_PER_PHASE;

export const MAP_ORDER = ['deserto', 'neve', 'cidade'];
export const MAP_NAMES = { deserto: 'Deserto', neve: 'Neve', cidade: 'Cidade' };

// Fases 1–7 Deserto, 8–14 Neve, 15–20 Cidade (issue #20, fechado).
export const PHASES_PER_SCENARIO = { deserto: 7, neve: 7, cidade: 6 };
export const SCENARIO_PHASE_RANGES = {
  deserto: { first: 1, last: 7 },
  neve: { first: 8, last: 14 },
  cidade: { first: 15, last: 20 },
};

// Chefes na 2ª onda das fases 5, 10, 15 e 20.
// Classes pedidas: 5 = terrestre, 10 = aéreo, 15 = terrestre, 20 = mecha.
// Tipos reaproveitados (sem inventar nomes): General de Ferro (terrestre),
// Fortaleza Voadora (aérea) e Mecha Titã (mecha).
export const BOSS_PHASES = {
  5: 'chefe-deserto',
  10: 'chefe-neve',
  15: 'chefe-deserto',
  20: 'chefe-cidade',
};

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Fase normalizada no intervalo 1..20 (fallback 1). */
export function clampPhase(phase) {
  return clampInt(phase, 1, TOTAL_PHASES, 1);
}

/** Cenário de uma fase (1..7 deserto, 8..14 neve, 15..20 cidade). */
export function scenarioForPhase(phase) {
  const p = clampPhase(phase);
  if (p <= SCENARIO_PHASE_RANGES.deserto.last) return 'deserto';
  if (p <= SCENARIO_PHASE_RANGES.neve.last) return 'neve';
  return 'cidade';
}

/** Nome do cenário de uma fase. */
export function scenarioNameForPhase(phase) {
  return MAP_NAMES[scenarioForPhase(phase)];
}

/** Fases (números 1..20) de um cenário, na ordem. */
export function phasesForScenario(scenarioId) {
  const faixa = SCENARIO_PHASE_RANGES[scenarioId];
  if (!faixa) return [];
  const fases = [];
  for (let p = faixa.first; p <= faixa.last; p += 1) fases.push(p);
  return fases;
}

/** Lista das 20 fases com metadados: [{phase, scenario, scenarioName}]. */
export const PHASES = Array.from({ length: TOTAL_PHASES }, (_, i) => {
  const phase = i + 1;
  const scenario = scenarioForPhase(phase);
  return { phase, scenario, scenarioName: MAP_NAMES[scenario] };
});

/** Metadados de uma fase. */
export function phaseInfo(phase) {
  const p = clampPhase(phase);
  const scenario = scenarioForPhase(p);
  return { phase: p, scenario, scenarioName: MAP_NAMES[scenario] };
}

/** Número da onda global (1..40) de uma onda local de uma fase. */
export function globalWaveFor(phase, waveInPhase) {
  const p = clampPhase(phase);
  const w = clampInt(waveInPhase, 1, WAVES_PER_PHASE, 1);
  return (p - 1) * WAVES_PER_PHASE + w;
}

/** Chefe da 2ª onda de uma fase (tipo) ou null. */
export function bossForPhase(phase) {
  return BOSS_PHASES[clampPhase(phase)] || null;
}

/** Bônus ao concluir uma onda: 25 + 10 × onda global (1..40). */
export function waveBonus(globalWave) {
  const w = clampInt(globalWave, 0, TOTAL_WAVES, 0);
  return 25 + 10 * w;
}

/** HP de um inimigo na onda global informada (1..40). */
export function hpForWave(baseHp, globalWave) {
  const w = clampInt(globalWave, 1, TOTAL_WAVES, 1);
  return Math.round(baseHp * (1 + HP_SCALE * (w - 1)));
}

/** Estrelas ao vencer: 3 = 20 vidas, 2 = 14–19, 1 = 1–13, 0 = derrota. */
export function starsForLives(lives) {
  const v = clampInt(lives, 0, START_LIVES, 0);
  if (v >= 20) return 3;
  if (v >= 14) return 2;
  if (v >= 1) return 1;
  return 0;
}

/** Faixa de "melhores vidas" coerente com as estrelas. */
function bestLivesBandForStars(stars) {
  const s = clampInt(stars, 1, 3, 1);
  if (s === 3) return [20, 20];
  if (s === 2) return [14, 19];
  return [1, 13];
}

/** Normaliza "melhores vidas" para a faixa das estrelas (consistência do save). */
export function bestLivesForStars(stars, bestLives) {
  const [min, max] = bestLivesBandForStars(stars);
  return Math.round(clampNum(bestLives, min, max, min));
}

// ---------------------------------------------------------------- progressão
/** Bônus permanente: min(250, 25 × fases concluídas) — nunca regride. */
export function bonusPermanentFor(completedPhases) {
  const n = clampInt(completedPhases, 0, TOTAL_PHASES, 0);
  return Math.min(250, 25 * n);
}

/** Caixa inicial: 300 + 25×(fase−1) + bônusPermanente. */
export function startingMoneyFor(phase, bonusPermanent = 0) {
  const p = clampPhase(phase);
  const bonus = clampInt(bonusPermanent, 0, 250, 0);
  return 300 + 25 * (p - 1) + bonus;
}

/** Multiplicador de recompensa por abate da fase: 1 + 0,05×(fase−1). */
export function rewardMultiplier(phase) {
  return 1 + 0.05 * (clampPhase(phase) - 1);
}

/** Recompensa por abate: round(valor base × (1 + 0,05×(fase−1))). */
export function rewardFor(baseReward, phase) {
  const base = Number(baseReward);
  if (!Number.isFinite(base)) return 0;
  return Math.round(base * rewardMultiplier(phase));
}

// ---------------------------------------------------------------- desbloqueios
// Torres: metralhadora e morteiro na fase 1; antiaéreo na 2; tesla na 4;
// criogênica na 6; míssil na 8.
export const TOWER_UNLOCK_PHASE = {
  metralhadora: 1,
  morteiro: 1,
  antiaereo: 2,
  tesla: 4,
  criogenica: 6,
  missil: 8,
};

// Tropas: fuzileiros na fase 1; antiaérea na 3; sniper na 5.
export const TROOP_UNLOCK_PHASE = {
  fuzileiros: 1,
  antiaerea: 3,
  sniper: 5,
};

// Upgrades: nível 2 a partir da fase 2; nível 3 a partir da fase 5.
export const UPGRADE_UNLOCK_PHASE = { 2: 2, 3: 5 };

export function towerUnlocked(type, phase) {
  const min = TOWER_UNLOCK_PHASE[type];
  if (!min) return false;
  return clampPhase(phase) >= min;
}

export function troopUnlocked(type, phase) {
  const min = TROOP_UNLOCK_PHASE[type];
  if (!min) return false;
  return clampPhase(phase) >= min;
}

export function upgradeUnlocked(level, phase) {
  const n = clampInt(level, 1, 3, 1);
  if (n <= 1) return true;
  const min = UPGRADE_UNLOCK_PHASE[n];
  return Number.isFinite(min) ? clampPhase(phase) >= min : false;
}

// ---------------------------------------------------------------- inimigos
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

// Venda = floor(0,7 × total investido), em aritmética INTEIRA (a spec manda
// floor(0,7×investido); com ponto flutuante 0,7×180 dava 125 e 0,7×330 dava
// 230 — $1 a menos nas combinações de investido 180 e 330).
export function sellValue(type, level) {
  return Math.floor((towerInvested(type, level) * 7) / 10);
}

// ---------------------------------------------------------------- save v2
// Schema v2 (issue #20): fases concluídas, estrelas por fase, bônusPermanente,
// configurações. Sem save no meio da partida. Migra o schema v1 (mapas).
export const SAVE_KEY = 'td3d:save:v2';
export const LEGACY_SAVE_KEY = 'td3d:save:v1';
export const SAVE_VERSION = 2;

const PHASE_DEFAULT = { completed: false, stars: 0, bestLives: 0 };

export function createDefaultSave() {
  return {
    version: SAVE_VERSION,
    tutorialDone: false,
    settings: { volume: 0.7, muted: false, speed: 1 },
    bonusPermanent: 0,
    phases: Array.from({ length: TOTAL_PHASES }, () => ({ ...PHASE_DEFAULT })),
    totals: { kills: 0, waves: 0, timePlayed: 0 },
  };
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseSaveRaw(raw) {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }
  if (raw && typeof raw === 'object') return raw;
  return null;
}

function copySettingsAndTotals(save, src) {
  const settings = src.settings && typeof src.settings === 'object' ? src.settings : {};
  save.settings.volume = clampNum(settings.volume, 0, 1, save.settings.volume);
  save.settings.muted = typeof settings.muted === 'boolean' ? settings.muted : false;
  save.settings.speed = settings.speed === 2 ? 2 : 1;
  const totals = src.totals && typeof src.totals === 'object' ? src.totals : {};
  save.totals.kills = Math.round(clampNum(totals.kills, 0, Number.MAX_SAFE_INTEGER, 0));
  save.totals.waves = Math.round(clampNum(totals.waves, 0, Number.MAX_SAFE_INTEGER, 0));
  save.totals.timePlayed = Math.round(clampNum(totals.timePlayed, 0, Number.MAX_SAFE_INTEGER, 0));
}

function sanitizePhase(raw, fallback = PHASE_DEFAULT) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const stars = clampInt(src.stars, 0, 3, fallback.stars);
  const concluida = src.completed === true || stars >= 1;
  if (!concluida) return { ...PHASE_DEFAULT };
  // Uma fase concluída sempre rendeu ao menos 1 estrela (vitória).
  const estrelas = Math.max(1, stars);
  return {
    completed: true,
    stars: estrelas,
    bestLives: bestLivesForStars(estrelas, clampNum(src.bestLives, 0, START_LIVES, 0)),
  };
}

// Migra o save v1 (progresso por mapa, 8 ondas cada) para fases 1..20.
// Regra documentada no README: por cenário, floor(wavesWon/8 × fasesDoCenário)
// fases concluídas; mapa 100% concluído mantém as estrelas antigas; progresso
// parcial vira 1 estrela por fase derivada (sem inventar notas altas).
export function migrateSaveV1(src) {
  const save = createDefaultSave();
  const v1 = src && typeof src === 'object' ? src : {};
  if (typeof v1.tutorialDone === 'boolean') save.tutorialDone = v1.tutorialDone;
  copySettingsAndTotals(save, v1);
  const maps = v1.maps && typeof v1.maps === 'object' ? v1.maps : {};
  // O save v1 só tinha progresso alcançável: Neve exigia Deserto vencido e
  // Cidade exigia Neve vencida. Progresso "solto" de um cenário bloqueado é
  // lixo e não pode inflar o bônus permanente (nem criar fases fora de ordem).
  let faseBase = 0;
  let anteriorConcluido = true;
  for (const mapId of MAP_ORDER) {
    const qtdFases = PHASES_PER_SCENARIO[mapId];
    const mapa = maps[mapId] && typeof maps[mapId] === 'object' ? maps[mapId] : {};
    const alcancavel = mapId === MAP_ORDER[0] || anteriorConcluido;
    const wavesWon = alcancavel ? Math.round(clampNum(mapa.wavesWon, 0, 8, 0)) : 0;
    const mapaConcluido = wavesWon >= 8;
    const concluidas = mapaConcluido
      ? qtdFases
      : Math.min(qtdFases, Math.floor((wavesWon / 8) * qtdFases + 1e-9));
    const estrelas = mapaConcluido ? Math.max(1, clampInt(mapa.stars, 0, 3, 1)) : 1;
    const melhores = mapaConcluido
      ? bestLivesForStars(estrelas, clampNum(mapa.bestLives, 0, START_LIVES, 0))
      : 1;
    for (let i = 0; i < concluidas; i += 1) {
      save.phases[faseBase + i] = { completed: true, stars: estrelas, bestLives: melhores };
    }
    faseBase += qtdFases;
    anteriorConcluido = alcancavel && mapaConcluido;
  }
  // Bônus derivado do prefixo contínuo de fases realmente alcançáveis.
  save.bonusPermanent = bonusPermanentFor(completedPhaseCount(save));
  return save;
}

export function completedPhaseCount(save) {
  if (!save || !Array.isArray(save.phases)) return 0;
  let n = 0;
  for (const fase of save.phases) if (fase && fase.completed === true) n += 1;
  return n;
}

export function isPhaseUnlocked(save, phase) {
  const p = clampPhase(phase);
  if (p <= 1) return true;
  if (!save || !Array.isArray(save.phases)) return false;
  const anterior = save.phases[p - 2];
  return Boolean(anterior && anterior.completed === true);
}

// Valida o save no boot: deep merge com os defaults, descarta lixo e migra v1.
// Progressão é sequencial: se uma fase não foi concluída, todas as seguintes
// são redefinidas (não confia no arquivo do localStorage).
export function validateSave(raw) {
  let src = parseSaveRaw(raw);
  if (!src) return createDefaultSave();
  if (src.version === 1 || (!Array.isArray(src.phases) && src.maps)) {
    src = migrateSaveV1(src);
  }
  const save = createDefaultSave();
  if (typeof src.tutorialDone === 'boolean') save.tutorialDone = src.tutorialDone;
  copySettingsAndTotals(save, src);

  const fases = Array.isArray(src.phases) ? src.phases : [];
  for (let i = 0; i < TOTAL_PHASES; i += 1) {
    save.phases[i] = sanitizePhase(fases[i], PHASE_DEFAULT);
  }
  // Progressão sequencial: mantém o prefixo contínuo de fases concluídas.
  let anteriorConcluida = true;
  for (let i = 0; i < TOTAL_PHASES; i += 1) {
    if (!anteriorConcluida) save.phases[i] = { ...PHASE_DEFAULT };
    anteriorConcluida = save.phases[i].completed === true;
  }

  const concluidas = completedPhaseCount(save);
  const bonusSalvo = clampInt(src.bonusPermanent, 0, 250, 0);
  // Bônus permanente nunca regride: vale o maior entre o salvo e o derivado.
  save.bonusPermanent = Math.max(bonusSalvo, bonusPermanentFor(concluidas));
  save.version = SAVE_VERSION;
  return save;
}

// Registra a vitória de uma fase. Retorna o save novo (não muta o original).
export function applyPhaseVictory(save, phase, lives) {
  const next = validateSave(save);
  const p = clampPhase(phase);
  if (!isPhaseUnlocked(next, p)) return next;
  const fase = next.phases[p - 1];
  const stars = starsForLives(lives);
  if (stars > 0) {
    fase.completed = true;
    if (stars > fase.stars) fase.stars = stars;
    if (lives > fase.bestLives) fase.bestLives = lives;
    next.bonusPermanent = bonusPermanentFor(completedPhaseCount(next));
    next.totals.waves += WAVES_PER_PHASE;
  }
  return next;
}
