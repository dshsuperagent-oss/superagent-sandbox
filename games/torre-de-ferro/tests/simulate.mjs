// tests/simulate.mjs — testes de simulação do Torre de Ferro (Node puro, sem deps).
// Expansão issue #20: campanha de **20 fases × 2 ondas (40 ondas)**, progressão de
// recursos (caixa/recompensa/bônus), desbloqueios por fase, vidas/estrelas e
// save v2 com migração de v1. O bot de referência joga a campanha inteira, fase a
// fase, sem aleatoriedade e sem vender.
//
// Uso:
//   node tests/simulate.mjs            # < 20 s — checagens + bot joga as 20 fases
//   node tests/simulate.mjs --completo # exige vidas >= 8 em cada uma das 20 fases
// Imprime PASS por checagem e um resumo; exit 0 apenas se tudo passar.
import {
  STEP, START_LIVES, PREP_TIME, HP_SCALE, SELL_RATE, SLOW_CAP,
  MAP_ORDER, MAP_NAMES, ENEMIES, SPAWN_INTERVALS, TOWERS, TROOPS, TROOP_ORDER,
  TOTAL_PHASES, WAVES_PER_PHASE, TOTAL_WAVES, PHASES_PER_SCENARIO, BOSS_PHASES,
  TOWER_UNLOCK_PHASE, TROOP_UNLOCK_PHASE, UPGRADE_UNLOCK_PHASE,
  SAVE_KEY, LEGACY_SAVE_KEY, SAVE_VERSION,
  scenarioForPhase, phasesForScenario, globalWaveFor, bonusPermanentFor,
  startingMoneyFor, rewardMultiplier, rewardFor, hpForWave, bossForPhase,
  towerUnlocked, troopUnlocked, upgradeUnlocked,
  createDefaultSave, validateSave, applyPhaseVictory, isPhaseUnlocked,
  completedPhaseCount, waveBonus, starsForLives, isCompatible,
  towerStats, towerInvested, sellValue,
} from '../src/sim/data.js';
import { DEFAULT_SEED, mulberry32, createRng } from '../src/sim/rng.js';
import { MAPS, pathPointAt } from '../src/sim/maps.js';
import {
  WAVES, waveFor, wavesForPhase, totalEnemies, airEnemiesIn, groundEnemiesIn,
} from '../src/sim/waves.js';
import { createEngine } from '../src/sim/engine.js';
import { applySlow } from '../src/sim/combat.js';

// ---------------------------------------------------------------- balancete herdado
// Os stats base de inimigos/torres/tropas continuam os da issue #18, com o
// balancete documentado no README (HP base ×0,84 e recompensas ×1,15). A escala
// de HP por onda da expansão fica em HP_SCALE, usada por hpForWave(); o teste
// confere a fórmula (não o valor) para permitir o ajuste de balanceamento.
const BALANCO = { hp: 0.84, recompensa: 1.15 };
const COMPLETO = process.argv.includes('--completo');
console.log(`CAMPANHA: ${TOTAL_PHASES} fases × ${WAVES_PER_PHASE} ondas = ${TOTAL_WAVES} ondas, `
  + `cenários 1–7/8–14/15–20, chefes 5/10/15/20`);
console.log(`BALANCETE HERDADO: HP base ×${BALANCO.hp}, recompensas ×${BALANCO.recompensa}`);

// ---------------------------------------------------------------- harness
let total = 0;
let falhas = 0;
const inicioGeral = Date.now();

function check(nome, fn) {
  total += 1;
  try {
    fn();
    console.log(`PASS ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL ${nome}: ${err && err.message ? err.message : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'condição falsa');
}

function eq(obtido, esperado, msg) {
  if (obtido !== esperado) {
    throw new Error(`${msg || 'valor'} — esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);
  }
}

function near(obtido, esperado, eps, msg) {
  if (!(Math.abs(obtido - esperado) <= eps)) {
    throw new Error(`${msg || 'valor'} — esperado ~${esperado} (±${eps}), obtido ${obtido}`);
  }
}

function ok(res, msg) {
  assert(res && res.ok === true, `${msg || 'ação'} falhou: ${JSON.stringify(res)}`);
}

function erro(res, codigo) {
  assert(res && res.ok === false, `esperava falha, obtido ${JSON.stringify(res)}`);
  eq(res.error, codigo, 'código de erro');
}

function bloqueado(res, unlockPhase, extra = {}, msg = 'ação') {
  assert(res && res.ok === false, `${msg} deveria estar bloqueada, obtido ${JSON.stringify(res)}`);
  eq(res.error, 'bloqueado', `${msg}: código de erro`);
  eq(res.unlockPhase, unlockPhase, `${msg}: unlockPhase`);
  for (const [chave, valor] of Object.entries(extra)) {
    eq(res[chave], valor, `${msg}: ${chave}`);
  }
}

const eventosDe = (lista) => lista.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {});
const primeiroEvento = (lista, tipo) => lista.find((e) => e.type === tipo) || null;

// Comparação profunda independente da ordem das chaves (schema exato do save).
function ordenarChaves(valor) {
  if (Array.isArray(valor)) return valor.map(ordenarChaves);
  if (valor && typeof valor === 'object') {
    const out = {};
    for (const chave of Object.keys(valor).sort()) out[chave] = ordenarChaves(valor[chave]);
    return out;
  }
  return valor;
}

function deepEq(obtido, esperado, msg) {
  const a = JSON.stringify(ordenarChaves(obtido));
  const b = JSON.stringify(ordenarChaves(esperado));
  if (a !== b) throw new Error(`${msg || 'objeto'} — esperado ${b}, obtido ${a}`);
}

const AIR_TYPES = new Set(['drone', 'helicoptero', 'bombardeiro', 'zepelim', 'chefe-neve']);
const isAir = (tipo) => AIR_TYPES.has(tipo);

/** airEnemiesIn devolve os grupos aéreos (semântica herdada); conta de forma tolerante. */
function contagem(listaOuNumero) {
  if (Array.isArray(listaOuNumero)) return listaOuNumero.reduce((s, g) => s + g.count, 0);
  return Number(listaOuNumero);
}

function airCount(onda) { return contagem(airEnemiesIn(onda)); }
function groundCount(onda) { return Number(groundEnemiesIn(onda)); }
function totalCount(onda) { return Number(totalEnemies(onda)); }

// ---------------------------------------------------------------- tabelas da issue #18
const TORRES_ESPEC = {
  metralhadora: {
    alvo: 'ground', efeito: 'instant',
    custos: [100, 80, 140], dano: [12, 22, 36], cadencia: [0.6, 0.5, 0.4], alcance: [14, 15, 16],
  },
  antiaereo: {
    alvo: 'air', efeito: 'instant',
    custos: [140, 110, 180], dano: [30, 55, 90], cadencia: [1.0, 0.9, 0.75], alcance: [18, 19, 20],
  },
  morteiro: {
    alvo: 'ground', efeito: 'splash',
    custos: [130, 100, 160], dano: [45, 80, 140], cadencia: [1.8, 1.6, 1.4], alcance: [16, 17, 18],
    splash: [4.0, 4.5, 5.0],
  },
  tesla: {
    alvo: 'both', efeito: 'chain',
    custos: [160, 130, 190], dano: [28, 46, 74], cadencia: [1.2, 1.1, 0.95], alcance: [12, 12, 13],
    cadeia: [2, 3, 4], salto: 6, falloff: 0.7,
  },
  criogenica: {
    alvo: 'both', efeito: 'slow',
    custos: [110, 90, 130], dano: [6, 10, 16], cadencia: [0.8, 0.8, 0.8], alcance: [13, 14, 16],
    lento: [0.25, 0.35, 0.45], tempo: [1.5, 2.0, 2.5],
  },
  missil: {
    alvo: 'both', efeito: 'missile',
    custos: [180, 150, 220], dano: [70, 120, 210], cadencia: [2.6, 2.4, 2.2], alcance: [22, 23, 24],
    velocidade: 14, splash: 3,
  },
};

const INIMIGOS_ESPEC = {
  soldado: { hp: 60, speed: 3.2, damage: 1, reward: 8, cls: 'ground', altitude: 0, boss: false, troopDps: 10 },
  blindado: { hp: 200, speed: 2.2, damage: 1, reward: 18, cls: 'ground', altitude: 0, boss: false, troopDps: 14 },
  tanque: { hp: 650, speed: 1.6, damage: 2, reward: 45, cls: 'ground', altitude: 0, boss: false, troopDps: 25 },
  drone: { hp: 45, speed: 4.0, damage: 1, reward: 10, cls: 'air', altitude: 6, boss: false, troopDps: 0 },
  helicoptero: { hp: 250, speed: 3.0, damage: 1, reward: 30, cls: 'air', altitude: 8, boss: false, troopDps: 0 },
  bombardeiro: { hp: 800, speed: 1.8, damage: 2, reward: 70, cls: 'air', altitude: 10, boss: false, troopDps: 0 },
  zepelim: { hp: 1800, speed: 0.9, damage: 5, reward: 150, cls: 'air', altitude: 12, boss: false, troopDps: 0 },
  'chefe-deserto': { hp: 4000, speed: 1.4, damage: 10, reward: 400, cls: 'ground', altitude: 0, boss: true, troopDps: 60 },
  'chefe-neve': { hp: 7000, speed: 0.8, damage: 10, reward: 900, cls: 'air', altitude: 12, boss: true, troopDps: 60 },
  'chefe-cidade': { hp: 12000, speed: 1.1, damage: 10, reward: 2000, cls: 'ground', altitude: 0, boss: true, troopDps: 120 },
};

const TROPAS_ESPEC = {
  fuzileiros: { custo: 90, hp: 500, alcance: 8, dano: 10, intervalo: 0.6, alvo: 'ground', vida: 40, recarga: 45, block: 4, blockRaio: 2.0 },
  antiaerea: { custo: 70, hp: 300, alcance: 16, dano: 22, intervalo: 0.8, alvo: 'air', vida: 35, recarga: 40, block: 0 },
  sniper: { custo: 110, hp: 250, alcance: 30, dano: 150, intervalo: 2.5, alvo: 'both', vida: 30, recarga: 35, block: 0 },
};

// Composições de referência das 24 ondas originais da issue #18 (tipo + atraso em s,
// sem as contagens): a expansão reaproveita os tipos de cada cenário, reorganiza em
// 2 ondas por fase e escala as contagens (tabela canônica abaixo, documentada no
// README). Guardamos aqui só os TIPOS por cenário para conferir a herança.
const COMPOSICOES_REF = [
  // Deserto (1–8)
  [['soldado', 0]],
  [['soldado', 0], ['drone', 4]],
  [['soldado', 0], ['blindado', 2], ['drone', 6]],
  [['drone', 0], ['soldado', 2], ['blindado', 4]],
  [['soldado', 0], ['tanque', 0], ['helicoptero', 8]],
  [['drone', 0], ['blindado', 2], ['helicoptero', 6]],
  [['soldado', 0], ['tanque', 2], ['helicoptero', 6], ['bombardeiro', 12]],
  [['chefe-deserto', 0], ['tanque', 2], ['drone', 4], ['helicoptero', 10]],
  // Neve (9–16)
  [['soldado', 0], ['drone', 3]],
  [['blindado', 0], ['helicoptero', 4]],
  [['drone', 0], ['tanque', 4]],
  [['soldado', 0], ['helicoptero', 3]],
  [['bombardeiro', 0], ['blindado', 2]],
  [['zepelim', 0], ['drone', 2], ['helicoptero', 8]],
  [['tanque', 0], ['bombardeiro', 4], ['helicoptero', 8]],
  [['chefe-neve', 0], ['zepelim', 3], ['drone', 6], ['helicoptero', 8]],
  // Cidade (17–24)
  [['soldado', 0], ['drone', 3], ['blindado', 6]],
  [['helicoptero', 0], ['tanque', 4]],
  [['bombardeiro', 0], ['drone', 3]],
  [['zepelim', 0], ['blindado', 2], ['helicoptero', 8]],
  [['tanque', 0], ['bombardeiro', 4]],
  [['zepelim', 0], ['drone', 2], ['helicoptero', 8]],
  [['tanque', 0], ['bombardeiro', 3], ['zepelim', 6], ['helicoptero', 10]],
  [['chefe-cidade', 0], ['zepelim', 3], ['helicoptero', 6], ['tanque', 8], ['drone', 10]],
];

const REF_TIPOS_CENARIO = (() => {
  const mapa = { deserto: new Set(), neve: new Set(), cidade: new Set() };
  COMPOSICOES_REF.forEach((ref, i) => {
    const cenario = i < 8 ? 'deserto' : (i < 16 ? 'neve' : 'cidade');
    for (const [tipo] of ref) if (!ENEMIES[tipo].boss) mapa[cenario].add(tipo);
  });
  return mapa;
})();

// ---------------------------------------------------------------- tabela canônica
// As 40 ondas finais da campanha (fonte de verdade da expansão; mesma tabela
// documentada no README). Cada entrada: [fase, ondaLocal, [[tipo, qtd, atraso], ...],
// chefe]. O teste pinа esta tabela (regressão) e valida as invariantes de forma
// independente — chefes 5/10/15/20, aéreos, somas por tipo, cenários e herança.
const ONDAS_ESPEC = [
  [1, 1, [['soldado', 8, 0]], false],
  [1, 2, [['soldado', 10, 0], ['drone', 4, 4]], false],
  [2, 1, [['soldado', 10, 0], ['blindado', 2, 3]], false],
  [2, 2, [['soldado', 10, 0], ['drone', 6, 3], ['blindado', 3, 6]], false],
  [3, 1, [['drone', 6, 0], ['soldado', 6, 2]], false],
  [3, 2, [['drone', 8, 0], ['soldado', 8, 2], ['blindado', 4, 5]], false],
  [4, 1, [['soldado', 10, 0], ['tanque', 1, 4]], false],
  [4, 2, [['soldado', 10, 0], ['tanque', 2, 2], ['helicoptero', 2, 8]], false],
  [5, 1, [['drone', 10, 0], ['blindado', 5, 2]], false],
  [5, 2, [['chefe-deserto', 1, 0], ['tanque', 2, 2], ['drone', 8, 4], ['helicoptero', 2, 10]], 'chefe-deserto'],
  [6, 1, [['soldado', 12, 0], ['tanque', 2, 3], ['helicoptero', 1, 8]], false],
  [6, 2, [['soldado', 12, 0], ['tanque', 3, 2], ['helicoptero', 3, 6], ['bombardeiro', 1, 12]], false],
  [7, 1, [['drone', 12, 0], ['blindado', 6, 2], ['helicoptero', 2, 6]], false],
  [7, 2, [['drone', 12, 0], ['blindado', 8, 2], ['helicoptero', 4, 6], ['bombardeiro', 2, 12]], false],
  [8, 1, [['soldado', 12, 0]], false],
  [8, 2, [['soldado', 12, 0], ['drone', 8, 3]], false],
  [9, 1, [['blindado', 6, 0]], false],
  [9, 2, [['blindado', 6, 0], ['helicoptero', 3, 4]], false],
  [10, 1, [['drone', 12, 0], ['tanque', 1, 4]], false],
  [10, 2, [['chefe-neve', 1, 0], ['zepelim', 1, 3], ['drone', 10, 5], ['helicoptero', 3, 8]], 'chefe-neve'],
  [11, 1, [['soldado', 12, 0], ['drone', 4, 3]], false],
  [11, 2, [['soldado', 12, 0], ['helicoptero', 5, 3]], false],
  [12, 1, [['bombardeiro', 1, 0], ['blindado', 6, 2]], false],
  [12, 2, [['bombardeiro', 2, 0], ['blindado', 8, 2]], false],
  [13, 1, [['tanque', 3, 0], ['helicoptero', 2, 4]], false],
  [13, 2, [['zepelim', 1, 0], ['drone', 12, 2], ['helicoptero', 3, 8]], false],
  [14, 1, [['tanque', 4, 0], ['bombardeiro', 1, 4]], false],
  [14, 2, [['tanque', 4, 0], ['bombardeiro', 2, 4], ['helicoptero', 4, 8], ['zepelim', 1, 14]], false],
  [15, 1, [['soldado', 14, 0], ['drone', 6, 3]], false],
  [15, 2, [['chefe-deserto', 1, 0], ['tanque', 2, 2], ['soldado', 10, 4], ['drone', 8, 6], ['helicoptero', 2, 10]], 'chefe-deserto'],
  [16, 1, [['helicoptero', 4, 0], ['tanque', 2, 4]], false],
  [16, 2, [['helicoptero', 6, 0], ['tanque', 3, 4], ['drone', 6, 8]], false],
  [17, 1, [['bombardeiro', 2, 0], ['drone', 10, 3]], false],
  [17, 2, [['bombardeiro', 3, 0], ['drone', 14, 3]], false],
  [18, 1, [['zepelim', 1, 0], ['blindado', 8, 2]], false],
  [18, 2, [['zepelim', 2, 0], ['blindado', 10, 2], ['helicoptero', 4, 8]], false],
  [19, 1, [['tanque', 5, 0], ['bombardeiro', 3, 4]], false],
  [19, 2, [['tanque', 6, 0], ['bombardeiro', 4, 3], ['zepelim', 2, 6], ['helicoptero', 6, 10]], false],
  [20, 1, [['tanque', 6, 0], ['bombardeiro', 4, 4], ['drone', 10, 8]], false],
  [20, 2, [['chefe-cidade', 1, 0], ['zepelim', 3, 3], ['helicoptero', 6, 6], ['tanque', 4, 8], ['drone', 12, 10]], 'chefe-cidade'],
];

const gruposEspec = (entrada) => entrada[2].map(([type, count, delay]) => ({ type, count, delay }));
const totalEspec = (entrada) => entrada[2].reduce((soma, grupo) => soma + grupo[1], 0);
const airEspec = (entrada) => entrada[2].filter(([tipo]) => isAir(tipo)).reduce((soma, grupo) => soma + grupo[1], 0);

// ================================================================ RNG
check('RNG: mulberry32 determinístico e em [0,1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 100; i += 1) {
    const va = a();
    const vb = b();
    eq(va, vb, 'mesma seed');
    assert(va >= 0 && va < 1, 'fora de [0,1)');
  }
  assert(mulberry32(1)() !== mulberry32(2)(), 'seeds diferentes deveriam divergir');
});

check('RNG: createRng usa DEFAULT_SEED e oferece range/pick', () => {
  const a = createRng();
  const b = createRng(DEFAULT_SEED);
  for (let i = 0; i < 20; i += 1) eq(a.next(), b.next(), 'DEFAULT_SEED');
  const r = createRng(7);
  for (let i = 0; i < 50; i += 1) {
    const v = r.range(2, 5);
    assert(v >= 2 && v < 5, 'range fora');
  }
  const p = createRng(7);
  for (let i = 0; i < 20; i += 1) assert(['a', 'b', 'c'].includes(p.pick(['a', 'b', 'c'])), 'pick inválido');
});

// ================================================================ estrutura da campanha
check('Constantes da campanha: 20 fases × 2 ondas = 40, 3 cenários e save v2', () => {
  eq(TOTAL_PHASES, 20, 'TOTAL_PHASES');
  eq(WAVES_PER_PHASE, 2, 'WAVES_PER_PHASE');
  eq(TOTAL_WAVES, 40, 'TOTAL_WAVES');
  eq(TOTAL_PHASES * WAVES_PER_PHASE, TOTAL_WAVES, '20 × 2 = 40');
  deepEq(PHASES_PER_SCENARIO, { deserto: 7, neve: 7, cidade: 6 }, 'PHASES_PER_SCENARIO');
  eq(PHASES_PER_SCENARIO.deserto + PHASES_PER_SCENARIO.neve + PHASES_PER_SCENARIO.cidade, TOTAL_PHASES, 'soma dos cenários');
  eq(START_LIVES, 20, 'START_LIVES');
  eq(PREP_TIME, 25, 'PREP_TIME');
  eq(STEP, 1 / 60, 'STEP');
  eq(SELL_RATE, 0.7, 'SELL_RATE');
  eq(SLOW_CAP, 0.6, 'SLOW_CAP');
  eq(SAVE_KEY, 'td3d:save:v2', 'SAVE_KEY');
  eq(LEGACY_SAVE_KEY, 'td3d:save:v1', 'LEGACY_SAVE_KEY');
  eq(SAVE_VERSION, 2, 'SAVE_VERSION');
  eq(JSON.stringify(MAP_ORDER), JSON.stringify(['deserto', 'neve', 'cidade']), 'MAP_ORDER');
  eq(MAP_NAMES.deserto, 'Deserto', 'MAP_NAMES.deserto');
  eq(MAP_NAMES.neve, 'Neve', 'MAP_NAMES.neve');
  eq(MAP_NAMES.cidade, 'Cidade', 'MAP_NAMES.cidade');
});

check('scenarioForPhase/phasesForScenario: 1–7 Deserto, 8–14 Neve, 15–20 Cidade', () => {
  for (let fase = 1; fase <= 20; fase += 1) {
    const esperado = fase <= 7 ? 'deserto' : (fase <= 14 ? 'neve' : 'cidade');
    eq(scenarioForPhase(fase), esperado, `cenário da fase ${fase}`);
  }
  const vistos = [];
  for (const [cenario, quantidade] of Object.entries(PHASES_PER_SCENARIO)) {
    const fases = phasesForScenario(cenario);
    eq(Array.isArray(fases), true, `${cenario}: array`);
    eq(fases.length, quantidade, `${cenario}: quantidade de fases`);
    for (const fase of fases) {
      eq(typeof fase, 'number', `${cenario}: número da fase`);
      eq(scenarioForPhase(fase), cenario, `fase ${fase} pertence a ${cenario}`);
      vistos.push(fase);
    }
  }
  vistos.sort((a, b) => a - b);
  eq(JSON.stringify(vistos), JSON.stringify(Array.from({ length: 20 }, (_, i) => i + 1)), 'as 20 fases em ordem');
});

check('globalWaveFor/bossForPhase/BOSS_PHASES: ondas 1..40 e chefes 5/10/15/20', () => {
  deepEq(BOSS_PHASES, {
    5: 'chefe-deserto', 10: 'chefe-neve', 15: 'chefe-deserto', 20: 'chefe-cidade',
  }, 'BOSS_PHASES');
  const globais = [];
  for (let fase = 1; fase <= TOTAL_PHASES; fase += 1) {
    for (let onda = 1; onda <= WAVES_PER_PHASE; onda += 1) {
      const esperado = (fase - 1) * WAVES_PER_PHASE + onda;
      eq(globalWaveFor(fase, onda), esperado, `globalWaveFor(${fase}, ${onda})`);
      globais.push(esperado);
    }
  }
  eq(JSON.stringify(globais), JSON.stringify(Array.from({ length: 40 }, (_, i) => i + 1)), 'ondas globais 1..40');
  for (const [fase, chefe] of Object.entries(BOSS_PHASES)) {
    eq(bossForPhase(Number(fase)), chefe, `bossForPhase(${fase})`);
  }
  for (let fase = 1; fase <= 20; fase += 1) {
    if (!BOSS_PHASES[fase]) assert(bossForPhase(fase) == null, `fase ${fase} sem chefe`);
  }
});

check('bonusPermanentFor (25×concluídas, cap 250) e startingMoneyFor (300+25×(fase−1)+bônus)', () => {
  for (let concluidas = 0; concluidas <= 20; concluidas += 1) {
    eq(bonusPermanentFor(concluidas), Math.min(250, 25 * concluidas), `bônus com ${concluidas} concluídas`);
  }
  eq(bonusPermanentFor(0), 0, 'bônus inicial');
  eq(bonusPermanentFor(10), 250, 'bônus no cap com 10');
  eq(bonusPermanentFor(20), 250, 'bônus no cap com 20');
  eq(bonusPermanentFor(9), 225, 'bônus com 9');
  for (let fase = 1; fase <= 20; fase += 1) {
    for (const bonus of [0, 25, 125, 250]) {
      eq(startingMoneyFor(fase, bonus), 300 + 25 * (fase - 1) + bonus, `caixa fase ${fase} bônus ${bonus}`);
    }
    eq(startingMoneyFor(fase), 300 + 25 * (fase - 1), `caixa padrão fase ${fase} (sem bônus)`);
  }
  eq(startingMoneyFor(1), 300, 'caixa da fase 1');
  eq(startingMoneyFor(20), 775, 'caixa da fase 20 sem bônus');
  eq(startingMoneyFor(20, 250), 1025, 'caixa da fase 20 com bônus máximo');
});

check('rewardMultiplier/rewardFor: +5% por fase, arredondamento inteiro (fases 1/5/10/20)', () => {
  for (let fase = 1; fase <= 20; fase += 1) {
    near(rewardMultiplier(fase), 1 + 0.05 * (fase - 1), 1e-12, `multiplicador fase ${fase}`);
  }
  eq(rewardMultiplier(1), 1, 'fase 1 = base');
  const bases = Object.values(ENEMIES).map((def) => def.reward);
  for (const base of bases) {
    for (const fase of [1, 2, 3, 5, 10, 20]) {
      eq(rewardFor(base, fase), Math.round(base * (1 + 0.05 * (fase - 1))), `reward(${base}, fase ${fase})`);
      assert(Number.isInteger(rewardFor(base, fase)), `reward(${base}, fase ${fase}) inteiro`);
    }
  }
  // arredondamentos que o ponto flutuante não pode errar:
  eq(rewardFor(9, 2), 9, '9 × 1,05 = 9,45 → 9');
  eq(rewardFor(9, 3), 10, '9 × 1,10 = 9,9 → 10');
  eq(rewardFor(21, 3), 23, '21 × 1,10 = 23,1 → 23');
  eq(rewardFor(21, 5), 25, '21 × 1,20 = 25,2 → 25');
  eq(rewardFor(173, 20), 337, '173 × 1,95 = 337,35 → 337');
  eq(rewardFor(2300, 20), 4485, '2300 × 1,95 = 4485');
  eq(rewardFor(8, 1), 8, 'fase 1');

  // Desbloqueios declarados pela especificação (funções e tabelas).
  deepEq(TOWER_UNLOCK_PHASE, {
    metralhadora: 1, morteiro: 1, antiaereo: 2, tesla: 4, criogenica: 6, missil: 8,
  }, 'TOWER_UNLOCK_PHASE');
  deepEq(TROOP_UNLOCK_PHASE, { fuzileiros: 1, antiaerea: 3, sniper: 5 }, 'TROOP_UNLOCK_PHASE');
  deepEq(UPGRADE_UNLOCK_PHASE, { 2: 2, 3: 5 }, 'UPGRADE_UNLOCK_PHASE');
  for (let fase = 1; fase <= 20; fase += 1) {
    for (const [tipo, minimo] of Object.entries(TOWER_UNLOCK_PHASE)) {
      eq(towerUnlocked(tipo, fase), fase >= minimo, `torre ${tipo} na fase ${fase}`);
      assert(TOWERS[tipo], `torre declarada sem stats: ${tipo}`);
    }
    for (const [tipo, minimo] of Object.entries(TROOP_UNLOCK_PHASE)) {
      eq(troopUnlocked(tipo, fase), fase >= minimo, `tropa ${tipo} na fase ${fase}`);
      assert(TROOPS[tipo], `tropa declarada sem stats: ${tipo}`);
    }
    eq(upgradeUnlocked(1, fase), true, `nível 1 sempre liberado (fase ${fase})`);
    eq(upgradeUnlocked(2, fase), fase >= 2, `nível 2 na fase ${fase}`);
    eq(upgradeUnlocked(3, fase), fase >= 5, `nível 3 na fase ${fase}`);
  }
  eq(upgradeUnlocked(2, 1), false, 'nível 2 bloqueado na fase 1');
  eq(upgradeUnlocked(3, 4), false, 'nível 3 bloqueado na fase 4');
});

check('hpForWave: HP escala com a onda global (fórmula única p/ os 10 tipos, 1..40)', () => {
  assert(Number.isFinite(HP_SCALE) && HP_SCALE > 0, `HP_SCALE inválido: ${HP_SCALE}`);
  for (const [tipo, def] of Object.entries(ENEMIES)) {
    for (let global = 1; global <= TOTAL_WAVES; global += 1) {
      eq(hpForWave(def.hp, global), Math.round(def.hp * (1 + HP_SCALE * (global - 1))), `${tipo} onda global ${global}`);
    }
    eq(hpForWave(def.hp, 1), def.hp, `${tipo}: onda 1 = HP base`);
  }
});

// ================================================================ dados: inimigos/torres/tropas
check('Inimigos: stats base herdados (10 tipos, 4 aéreos, 3 chefes)', () => {
  eq(Object.keys(ENEMIES).length, 10, 'quantidade de tipos');
  let aereos = 0;
  let aereosChefes = 0;
  let chefes = 0;
  for (const [tipo, spec] of Object.entries(INIMIGOS_ESPEC)) {
    const def = ENEMIES[tipo];
    assert(def, `tipo ausente: ${tipo}`);
    near(def.hp, Math.round(spec.hp * BALANCO.hp), Math.max(1, spec.hp * BALANCO.hp * 0.001),
      `${tipo}.hp (balancete ${BALANCO.hp})`);
    eq(def.cls, spec.cls, `${tipo}.cls`);
    near(def.speed, spec.speed, 1e-9, `${tipo}.speed`);
    eq(def.damage, spec.damage, `${tipo}.damage`);
    near(def.reward, Math.round(spec.reward * BALANCO.recompensa), Math.max(1, spec.reward * BALANCO.recompensa * 0.001),
      `${tipo}.reward (balancete ${BALANCO.recompensa})`);
    eq(def.altitude, spec.altitude, `${tipo}.altitude`);
    eq(Boolean(def.boss), spec.boss, `${tipo}.boss`);
    eq(def.troopDps, spec.troopDps, `${tipo}.troopDps`);
    if (spec.cls === 'air' && !spec.boss) aereos += 1;
    if (spec.cls === 'air' && spec.boss) aereosChefes += 1;
    if (spec.boss) chefes += 1;
  }
  eq(aereos, 4, 'inimigos aéreos (não-chefes)');
  eq(aereosChefes, 1, 'chefe aéreo (Fortaleza Voadora)');
  eq(chefes, 3, 'chefes');
  for (const chefe of ['chefe-deserto', 'chefe-neve', 'chefe-cidade']) {
    near(ENEMIES[chefe].slowResist, 0.5, 1e-9, `${chefe}.slowResist`);
  }
});

check('Torres: 6 tipos × 3 níveis com dano/cadência/alcance/custo da especificação', () => {
  eq(Object.keys(TOWERS).length, 6, 'quantidade de torres');
  for (const [tipo, spec] of Object.entries(TORRES_ESPEC)) {
    const def = TOWERS[tipo];
    assert(def, `torre ausente: ${tipo}`);
    eq(def.target, spec.alvo, `${tipo}.target`);
    eq(def.effect, spec.efeito, `${tipo}.effect`);
    eq(JSON.stringify(def.costs), JSON.stringify(spec.custos), `${tipo}.costs`);
    for (let nivel = 1; nivel <= 3; nivel += 1) {
      const st = towerStats(tipo, nivel);
      eq(st.damage, spec.dano[nivel - 1], `${tipo} L${nivel} dano`);
      near(st.rate, spec.cadencia[nivel - 1], 1e-9, `${tipo} L${nivel} cadência`);
      eq(st.range, spec.alcance[nivel - 1], `${tipo} L${nivel} alcance`);
    }
  }
  eq(TOWERS.morteiro.splash.join(','), '4,4.5,5', 'splash morteiro');
  eq(TOWERS.tesla.chain.join(','), '2,3,4', 'cadeia tesla');
  eq(TOWERS.tesla.chainJump, 6, 'salto tesla');
  eq(TOWERS.tesla.chainFalloff, 0.7, 'falloff tesla');
  eq(TOWERS.criogenica.slow.join(','), '0.25,0.35,0.45', 'lentidão criogênica');
  eq(TOWERS.criogenica.slowTime.join(','), '1.5,2,2.5', 'duração lentidão');
  eq(TOWERS.criogenica.slowCap, SLOW_CAP, 'teto de lentidão');
  eq(TOWERS.missil.missileSpeed, 14, 'velocidade míssil');
  eq(TOWERS.missil.missileSplash, 3, 'raio splash míssil');
});

check('Custos investidos e venda 70% (floor) por tipo/nível', () => {
  for (const [tipo, spec] of Object.entries(TORRES_ESPEC)) {
    let acumulado = 0;
    for (let nivel = 1; nivel <= 3; nivel += 1) {
      acumulado += spec.custos[nivel - 1];
      eq(towerInvested(tipo, nivel), acumulado, `${tipo} investido L${nivel}`);
      eq(sellValue(tipo, nivel), Math.floor((acumulado * 7) / 10), `${tipo} venda L${nivel}`);
    }
  }
  eq(towerInvested('metralhadora', 2), 180, 'investido Metralhadora L2');
  eq(sellValue('metralhadora', 2), 126, 'venda 180→126 (arte inteira)');
  eq(sellValue('missil', 1), 126, 'venda 180→126 (Míssil L1)');
  eq(sellValue('criogenica', 3), 231, 'venda 330→231 (Criogênica L3)');
  eq(isCompatible('both', 'air') && isCompatible('both', 'ground'), true, 'both');
  eq(isCompatible('air', 'ground'), false, 'air não mira terrestre');
});

check('Tropas: 3 tipos com custo/HP/alcance/dano/intervalo/vida/recarga da especificação', () => {
  eq(JSON.stringify(TROOP_ORDER), JSON.stringify(['fuzileiros', 'antiaerea', 'sniper']), 'TROOP_ORDER');
  for (const [tipo, spec] of Object.entries(TROPAS_ESPEC)) {
    const def = TROOPS[tipo];
    assert(def, `tropa ausente: ${tipo}`);
    eq(def.cost, spec.custo, `${tipo}.cost`);
    eq(def.hp, spec.hp, `${tipo}.hp`);
    eq(def.range, spec.alcance, `${tipo}.range`);
    eq(def.damage, spec.dano, `${tipo}.damage`);
    near(def.interval, spec.intervalo, 1e-9, `${tipo}.interval`);
    eq(def.target, spec.alvo, `${tipo}.target`);
    eq(def.lifetime, spec.vida, `${tipo}.lifetime`);
    eq(def.recharge, spec.recarga, `${tipo}.recharge`);
    eq(def.block || 0, spec.block, `${tipo}.block`);
    if (spec.block) eq(def.blockRadius, spec.blockRaio, `${tipo}.blockRadius`);
  }
});

check('Estrelas: 3=20, 2=14–19, 1=1–13, 0=derrota; vidas resetam em 20 por fase', () => {
  eq(starsForLives(20), 3, '20 vidas');
  eq(starsForLives(25), 3, 'acima de 20');
  eq(starsForLives(19), 2, '19 vidas');
  eq(starsForLives(14), 2, '14 vidas');
  eq(starsForLives(13), 1, '13 vidas');
  eq(starsForLives(1), 1, '1 vida');
  eq(starsForLives(0), 0, '0 vidas');
  for (let fase = 1; fase <= 20; fase += 1) {
    eq(createEngine({ phase: fase }).getState().lives, 20, `vidas da fase ${fase}`);
  }
});

// ================================================================ ondas (40)
check('40 ondas exatas: tabela canônica pinada (fase/onda local/cenário/grupos/chefe)', () => {
  eq(WAVES.length, TOTAL_WAVES, 'WAVES.length');
  eq(ONDAS_ESPEC.length, TOTAL_WAVES, 'tabela canônica com 40 ondas');
  for (let i = 0; i < TOTAL_WAVES; i += 1) {
    const [fase, local, , chefe] = ONDAS_ESPEC[i];
    const onda = WAVES[i];
    eq(onda.phase, fase, `onda ${i + 1}: fase`);
    eq(onda.waveInPhase, local, `onda ${i + 1}: onda local`);
    eq(onda.scenario, scenarioForPhase(fase), `onda ${i + 1}: cenário`);
    deepEq(onda.groups, gruposEspec(ONDAS_ESPEC[i]), `onda ${i + 1}: composição (tipo/contagem/atraso)`);
    eq(onda.boss, chefe, `onda ${i + 1}: campo boss`);
    const de = waveFor(fase, local);
    assert(de, `waveFor(${fase}, ${local})`);
    eq(de, onda, `waveFor(${fase}, ${local}) devolve a mesma onda`);
  }
  eq(WAVES.length, TOTAL_PHASES * WAVES_PER_PHASE, '20 × 2');
  for (let fase = 1; fase <= TOTAL_PHASES; fase += 1) {
    const ondas = wavesForPhase(fase);
    eq(ondas.length, WAVES_PER_PHASE, `fase ${fase}: 2 ondas`);
    eq(ondas[0].waveInPhase, 1, `fase ${fase}: 1ª onda`);
    eq(ondas[1].waveInPhase, 2, `fase ${fase}: 2ª onda`);
    eq(ondas[0].scenario, scenarioForPhase(fase), `fase ${fase}: cenário das ondas`);
    deepEq(ondas.map((o) => o.groups), [gruposEspec(ONDAS_ESPEC[(fase - 1) * 2]), gruposEspec(ONDAS_ESPEC[(fase - 1) * 2 + 1])],
      `fase ${fase}: ondas locais na ordem`);
  }
  assert(waveFor(21, 1) == null, 'fase 21 não existe');
  assert(waveFor(1, 3) == null, 'onda local 3 não existe');
});

check('Herança das 24 ondas originais: só tipos do cenário e cobertura dos tipos', () => {
  for (const entrada of ONDAS_ESPEC) {
    const [fase, local, grupos] = entrada;
    const cenario = scenarioForPhase(fase);
    for (const [tipo] of grupos) {
      assert(ENEMIES[tipo], `fase ${fase}/${local}: tipo inválido ${tipo}`);
      if (!ENEMIES[tipo].boss) {
        assert(REF_TIPOS_CENARIO[cenario].has(tipo),
          `fase ${fase}/${local}: ${tipo} não existia nas ondas originais do cenário ${cenario}`);
      }
    }
  }
  // Cobertura: todos os tipos não-chefe do cenário original aparecem na expansão.
  for (const cenario of MAP_ORDER) {
    const vistos = new Set();
    for (const [fase, , grupos] of ONDAS_ESPEC) {
      if (scenarioForPhase(fase) !== cenario) continue;
      for (const [tipo] of grupos) if (!ENEMIES[tipo].boss) vistos.add(tipo);
    }
    for (const tipo of REF_TIPOS_CENARIO[cenario]) {
      assert(vistos.has(tipo), `cenário ${cenario}: tipo original ${tipo} sumiu da expansão`);
    }
    eq(vistos.size, REF_TIPOS_CENARIO[cenario].size, `cenário ${cenario}: tipos cobertos`);
  }
});

check('Grupos válidos: tipos existentes, contagens inteiras > 0 e atrasos determinísticos', () => {
  for (const [i, entrada] of ONDAS_ESPEC.entries()) {
    const [fase, local, grupos] = entrada;
    assert(Array.isArray(grupos) && grupos.length > 0, `onda ${i + 1}: groups válidos`);
    assert(grupos.length <= 6, `onda ${i + 1}: grupos demais (${grupos.length})`);
    const tipos = new Set();
    for (const [grupo, [tipo, count, delay]] of grupos.entries()) {
      assert(ENEMIES[tipo], `onda ${i + 1} grupo ${grupo}: tipo desconhecido ${tipo}`);
      assert(!tipos.has(tipo), `onda ${i + 1}: tipo ${tipo} repetido em dois grupos`);
      tipos.add(tipo);
      assert(Number.isInteger(count) && count > 0,
        `onda ${i + 1} grupo ${grupo} (${tipo}): count inválido ${count}`);
      assert(count <= 80, `onda ${i + 1} grupo ${grupo} (${tipo}): count absurdo ${count}`);
      assert(Number.isFinite(delay) && delay >= 0 && delay <= 90,
        `onda ${i + 1} grupo ${grupo} (${tipo}): delay inválido ${delay}`);
      assert(Number.isFinite(SPAWN_INTERVALS[tipo]),
        `onda ${i + 1} grupo ${grupo}: SPAWN_INTERVALS ausente para ${tipo}`);
      if (ENEMIES[tipo].boss) eq(count, 1, `onda ${i + 1}: chefe sempre 1 por grupo`);
    }
    assert(totalEspec(entrada) > 0, `onda ${i + 1} (fase ${fase}/${local}): sem inimigos`);
  }
});

check('Aéreos desde a fase 1 onda 2 em todos os cenários (2ª onda sempre com aéreos)', () => {
  eq(airEspec(ONDAS_ESPEC[0]), 0, 'onda global 1 sem aéreos (preparação normal)');
  for (let i = 1; i < TOTAL_WAVES; i += 1) {
    if (ONDAS_ESPEC[i][1] !== 2) continue;
    assert(airEspec(ONDAS_ESPEC[i]) > 0,
      `onda global ${i + 1} (fase ${ONDAS_ESPEC[i][0]} onda 2) sem aéreos`);
  }
  // A 2ª onda da primeira fase de CADA cenário (1, 8, 15) tem aéreos.
  for (const fase of [1, 8, 15]) {
    const indice = (fase - 1) * WAVES_PER_PHASE + 1;
    eq(ONDAS_ESPEC[indice][1], 2, `fase ${fase}: 2ª onda`);
    assert(airEspec(ONDAS_ESPEC[indice]) > 0, `fase ${fase} onda 2 deve ter aéreos`);
  }
  // Todos os 4 aéreos não-chefe aparecem em algum momento da campanha.
  const aereosUsados = new Set();
  for (const [, , grupos] of ONDAS_ESPEC) {
    for (const [tipo] of grupos) if (isAir(tipo) && !ENEMIES[tipo].boss) aereosUsados.add(tipo);
  }
  eq(aereosUsados.size, 4, 'os 4 inimigos aéreos aparecem na campanha');
});

check('Chefes só na 2ª onda das fases 5/10/15/20 (terrestre/aéreo/terrestre/mecha)', () => {
  const classes = { 5: 'ground', 10: 'air', 15: 'ground', 20: 'ground' };
  for (const [i, entrada] of ONDAS_ESPEC.entries()) {
    const [fase, local, grupos, chefe] = entrada;
    const esperado = local === 2 ? (bossForPhase(fase) || false) : false;
    eq(chefe, esperado, `onda global ${i + 1}: chefe da tabela`);
    const gruposChefe = grupos.filter(([tipo]) => ENEMIES[tipo].boss);
    if (esperado) {
      eq(gruposChefe.length, 1, `onda global ${i + 1}: um grupo de chefe`);
      eq(gruposChefe[0][0], esperado, `onda global ${i + 1}: tipo do chefe`);
      eq(gruposChefe[0][1], 1, `onda global ${i + 1}: 1 chefe`);
    } else {
      eq(gruposChefe.length, 0, `onda global ${i + 1}: nenhum chefe`);
    }
  }
  for (const [fase, tipo] of [[5, 'chefe-deserto'], [10, 'chefe-neve'], [15, 'chefe-deserto'], [20, 'chefe-cidade']]) {
    const onda = waveFor(fase, 2);
    eq(onda.boss, tipo, `fase ${fase} onda 2: boss`);
    eq(ENEMIES[tipo].boss, true, `${tipo} é chefe`);
    eq(ENEMIES[tipo].cls, classes[fase], `fase ${fase}: classe do chefe`);
  }
  eq(ENEMIES['chefe-cidade'].name, 'Mecha Titã', 'fase 20: chefe mecha');
});

check('Contagens: soma por tipo, totalEnemies/air/ground coerentes e dificuldade cresce', () => {
  const somaEspec = {};
  for (const [, , grupos] of ONDAS_ESPEC) {
    for (const [tipo, count] of grupos) somaEspec[tipo] = (somaEspec[tipo] || 0) + count;
  }
  const somaOndas = {};
  for (const onda of WAVES) {
    for (const grupo of onda.groups) somaOndas[grupo.type] = (somaOndas[grupo.type] || 0) + grupo.count;
  }
  deepEq(somaOndas, somaEspec, 'soma por tipo (implementação × tabela canônica)');

  for (let i = 0; i < TOTAL_WAVES; i += 1) {
    const onda = WAVES[i];
    const ehAereo = (tipo) => isAir(tipo);
    const somaGrupos = onda.groups.reduce((s, g) => s + g.count, 0);
    eq(totalCount(onda), totalEspec(ONDAS_ESPEC[i]), `onda global ${i + 1}: totalEnemies × tabela`);
    eq(somaGrupos, totalEspec(ONDAS_ESPEC[i]), `onda global ${i + 1}: soma dos grupos`);
    const aereos = airCount(onda);
    eq(groundCount(onda), somaGrupos - aereos, `onda global ${i + 1}: groundEnemiesIn = total − aéreos`);
    eq(aereos, onda.groups.filter((g) => ehAereo(g.type)).reduce((s, g) => s + g.count, 0),
      `onda global ${i + 1}: airEnemiesIn`);
  }
  const inicioCampanha = totalCount(WAVES[0]) + totalCount(WAVES[1]);
  const fimCampanha = totalCount(WAVES[38]) + totalCount(WAVES[39]);
  assert(fimCampanha > inicioCampanha,
    `contagens deveriam escalar com a fase: fase 1 = ${inicioCampanha}, fase 20 = ${fimCampanha}`);
});

check('Bônus de onda: waveBonus(ondaGlobal) = 25 + 10×onda para as 40 ondas', () => {
  for (let global = 1; global <= TOTAL_WAVES; global += 1) {
    eq(waveBonus(global), 25 + 10 * global, `bônus da onda global ${global}`);
  }
  eq(waveBonus(1), 35, '1ª onda global');
  eq(waveBonus(40), 425, 'última onda global');
});

function coletarFimDaOnda(engine, maxSegundos, aoDrenar) {
  let segundos = 0;
  while (segundos < maxSegundos) {
    const st = engine.getState();
    if (st.phase !== 'wave') break;
    let passos = 0;
    while (passos < 60 && engine.getState().phase === 'wave') {
      engine.step();
      passos += 1;
    }
    segundos += 1;
    aoDrenar(engine.drainEvents());
  }
  aoDrenar(engine.drainEvents());
}

check('Spawn determinístico: atrasos/intervalos batem com SPAWN_INTERVALS (fases 1 e 5)', () => {
  for (const [fase, local] of [[1, 1], [1, 2], [5, 2]]) {
    const onda = waveFor(fase, local);
    const global = globalWaveFor(fase, local);
    const engine = createEngine({ phase: fase, seed: DEFAULT_SEED });
    engine.debugSetLives(1000);
    engine.drainEvents();
    eq(engine.debugStartWave(local), true, `fase ${fase}/${local}: inicia onda`);
    const spawns = [];
    for (let i = 0; i < 60 * 300 && engine.getState().phase === 'wave'; i += 1) {
      engine.step();
      const momento = engine.getState().time;
      for (const ev of engine.drainEvents()) {
        if (ev.type === 'spawn') spawns.push({ tipo: ev.enemyType, t: momento, hp: ev.hp });
      }
    }
    for (const ev of engine.drainEvents()) {
      if (ev.type === 'spawn') spawns.push({ tipo: ev.enemyType, t: engine.getState().time, hp: ev.hp });
    }
    eq(spawns.length, totalCount(onda), `fase ${fase}/${local}: total de spawns`);
    const esperados = [];
    let ordem = 0;
    for (const grupo of onda.groups) {
      for (let k = 0; k < grupo.count; k += 1) {
        esperados.push({ tipo: grupo.type, t: grupo.delay + k * SPAWN_INTERVALS[grupo.type], ordem: ordem++ });
      }
    }
    esperados.sort((a, b) => (a.t - b.t) || (a.ordem - b.ordem));
    for (let i = 0; i < esperados.length; i += 1) {
      eq(spawns[i].tipo, esperados[i].tipo, `fase ${fase}/${local}: spawn ${i} tipo`);
      near(spawns[i].t, esperados[i].t, 0.05, `fase ${fase}/${local}: spawn ${i} tempo`);
      eq(spawns[i].hp, hpForWave(ENEMIES[esperados[i].tipo].hp, global),
        `fase ${fase}/${local}: spawn ${i} HP (onda global ${global})`);
    }
  }
});

check('Engine spawna exatamente a composição de cada onda (fidelidade de grupos)', () => {
  for (const [fase, local] of [[1, 1], [1, 2], [5, 2], [10, 2], [20, 2]]) {
    const onda = waveFor(fase, local);
    const esperado = {};
    for (const grupo of onda.groups) esperado[grupo.type] = (esperado[grupo.type] || 0) + grupo.count;
    const engine = createEngine({ phase: fase, seed: DEFAULT_SEED });
    engine.debugSetLives(1000);
    engine.drainEvents();
    eq(engine.debugStartWave(local), true, `fase ${fase}/${local}: inicia onda`);
    const obtido = {};
    let total = 0;
    coletarFimDaOnda(engine, 400, (eventos) => {
      for (const ev of eventos) {
        if (ev.type === 'spawn') {
          obtido[ev.enemyType] = (obtido[ev.enemyType] || 0) + 1;
          total += 1;
        }
      }
    });
    deepEq(obtido, esperado, `fase ${fase}/${local}: composição spawnada`);
    eq(total, totalCount(onda), `fase ${fase}/${local}: total spawnado`);
    const st = engine.getState();
    if (local === 2) {
      eq(st.phase, 'victory', `fase ${fase}/${local}: 2ª onda conclui a fase`);
    } else {
      eq(st.phase, 'prep', `fase ${fase}/${local}: 1ª onda volta para a preparação`);
    }
  }
});

// ================================================================ mapas
check('Mapas: waypoints/comprimentos da especificação e regra de slots/pontos', () => {
  const esperado = {
    deserto: { length: 146, waypoints: [[-42, -18], [-24, -18], [-24, 6], [-2, 6], [-2, -10], [18, -10], [18, 14], [40, 14]] },
    neve: { length: 172, waypoints: [[-36, -18], [-36, 14], [-10, 14], [-10, -14], [10, -14], [10, 14], [34, 14], [34, 0]] },
    cidade: { length: 176, waypoints: [[-40, 0], [-20, 0], [-20, -16], [0, -16], [0, 16], [20, 16], [20, -16], [40, -16], [40, 0]] },
  };
  for (const [id, spec] of Object.entries(esperado)) {
    const mapa = MAPS[id];
    assert(mapa, `mapa ausente ${id}`);
    near(mapa.length, spec.length, 0.01, `${id}.length`);
    eq(JSON.stringify(mapa.waypoints), JSON.stringify(spec.waypoints), `${id}.waypoints`);
    const p0 = pathPointAt(mapa, 0);
    near(p0.x, spec.waypoints[0][0], 0.01, `${id} spawn.x`);
    near(p0.z, spec.waypoints[0][1], 0.01, `${id} spawn.z`);
    const pf = pathPointAt(mapa, mapa.length);
    near(pf.x, spec.waypoints[spec.waypoints.length - 1][0], 0.01, `${id} base.x`);
    near(pf.z, spec.waypoints[spec.waypoints.length - 1][1], 0.01, `${id} base.z`);
    const limite = mapa.length - 6;
    let slotsEsperados = 0;
    for (let i = 0; i < 16; i += 1) {
      const d = 10 + 9 * i;
      if (d > limite) break;
      slotsEsperados += 1;
      const pp = pathPointAt(mapa, d);
      const lado = i % 2 === 0 ? 1 : -1;
      const sx = Math.round((pp.x + pp.nx * 6 * lado) * 100) / 100;
      const sz = Math.round((pp.z + pp.nz * 6 * lado) * 100) / 100;
      near(mapa.slots[i].x, sx, 0.011, `${id} slot ${i}.x`);
      near(mapa.slots[i].z, sz, 0.011, `${id} slot ${i}.z`);
    }
    eq(mapa.slots.length, slotsEsperados, `${id} quantidade de slots`);
    eq(mapa.troopPoints.length, 6, `${id} pontos de tropa`);
    for (let j = 0; j < 6; j += 1) {
      const d = Math.min(20 + 25 * j, limite);
      const pp = pathPointAt(mapa, d);
      const lado = j % 2 === 0 ? 1 : -1;
      const px = Math.round((pp.x + pp.nx * 2.5 * lado) * 100) / 100;
      const pz = Math.round((pp.z + pp.nz * 2.5 * lado) * 100) / 100;
      near(mapa.troopPoints[j].x, px, 0.011, `${id} ponto ${j}.x`);
      near(mapa.troopPoints[j].z, pz, 0.011, `${id} ponto ${j}.z`);
    }
  }
});

// ================================================================ engine: estado e progressão
function criarEngineFase(fase, opcoes = {}) {
  const engine = createEngine({ phase: fase, seed: DEFAULT_SEED, ...opcoes });
  engine.drainEvents();
  return engine;
}

check('createEngine: estado inicial da fase 1 da campanha', () => {
  const engine = criarEngineFase(1);
  const st = engine.getState();
  eq(st.phase, 'prep', 'fase da partida');
  eq(st.phaseNumber, 1, 'phaseNumber');
  eq(st.totalPhases, 20, 'totalPhases');
  eq(st.scenario, 'deserto', 'scenario');
  eq(st.scenarioName, 'Deserto', 'scenarioName');
  eq(st.mapId, 'deserto', 'mapId');
  eq(st.mapName, 'Deserto', 'mapName');
  eq(st.wave, 1, 'onda local inicial');
  eq(st.wavesPerPhase, 2, 'wavesPerPhase');
  eq(st.globalWave, 1, 'globalWave inicial');
  near(st.prepLeft, 25, 0.05, 'prepLeft');
  eq(st.money, startingMoneyFor(1, 0), 'caixa inicial');
  eq(st.startingMoney, startingMoneyFor(1, 0), 'startingMoney');
  eq(st.lives, 20, 'vidas');
  eq(st.bonusPermanent, 0, 'bonusPermanent');
  eq(st.slots.length, MAPS.deserto.slots.length, 'slots do cenário');
  eq(st.troopPoints.length, 6, 'pontos de tropa');
  eq(st.boss, null, 'boss nulo no início');
  eq(st.phase, 'prep', 'preparação');
  eq(st.wave, 1, 'onda local 1');
  eq(JSON.parse(JSON.stringify(engine.getState())).phaseNumber, 1, 'snapshot serializável');
});

check('createEngine por fase: cenário, caixa, vidas, onda global e unlocks', () => {
  for (let fase = 1; fase <= TOTAL_PHASES; fase += 1) {
    const engine = criarEngineFase(fase);
    const st = engine.getState();
    eq(st.phaseNumber, fase, `fase ${fase}: phaseNumber`);
    eq(st.totalPhases, 20, `fase ${fase}: totalPhases`);
    eq(st.scenario, scenarioForPhase(fase), `fase ${fase}: scenario`);
    eq(st.scenarioName, MAP_NAMES[scenarioForPhase(fase)], `fase ${fase}: scenarioName`);
    eq(st.mapId, scenarioForPhase(fase), `fase ${fase}: mapId`);
    eq(st.mapName, MAP_NAMES[scenarioForPhase(fase)], `fase ${fase}: mapName`);
    eq(st.wave, 1, `fase ${fase}: onda local`);
    eq(st.globalWave, globalWaveFor(fase, 1), `fase ${fase}: globalWave`);
    eq(st.lives, 20, `fase ${fase}: vidas`);
    eq(st.money, startingMoneyFor(fase, 0), `fase ${fase}: caixa`);
    eq(st.startingMoney, startingMoneyFor(fase, 0), `fase ${fase}: startingMoney`);
    eq(st.slots.length, MAPS[scenarioForPhase(fase)].slots.length, `fase ${fase}: slots`);
    // desbloqueios refletidos no estado
    assert(st.unlocks && st.unlocks.towers && st.unlocks.troops && st.unlocks.upgrades,
      `fase ${fase}: estado.unlocks ausente`);
    for (const tipo of Object.keys(TOWERS)) {
      eq(st.unlocks.towers[tipo], towerUnlocked(tipo, fase), `fase ${fase}: unlocks.towers.${tipo}`);
    }
    for (const tipo of Object.keys(TROOPS)) {
      eq(st.unlocks.troops[tipo], troopUnlocked(tipo, fase), `fase ${fase}: unlocks.troops.${tipo}`);
    }
    eq(st.unlocks.upgrades[2], upgradeUnlocked(2, fase), `fase ${fase}: unlocks.upgrades.2`);
    eq(st.unlocks.upgrades[3], upgradeUnlocked(3, fase), `fase ${fase}: unlocks.upgrades.3`);
  }
});

check('Caixa inicial = startingMoneyFor(fase, bônusPermanente) e override explícito', () => {
  for (let fase = 1; fase <= TOTAL_PHASES; fase += 1) {
    const bonus = bonusPermanentFor(fase - 1);
    const engine = criarEngineFase(fase, { bonusPermanent: bonus });
    const st = engine.getState();
    eq(st.bonusPermanent, bonus, `fase ${fase}: bonusPermanent no estado`);
    eq(st.money, startingMoneyFor(fase, bonus), `fase ${fase}: caixa com bônus`);
    eq(st.startingMoney, startingMoneyFor(fase, bonus), `fase ${fase}: startingMoney com bônus`);
    eq(st.money, 300 + 25 * (fase - 1) + bonus, `fase ${fase}: fórmula da caixa`);
  }
  eq(criarEngineFase(5, { money: 123 }).getState().money, 123, 'override de caixa');
  eq(criarEngineFase(5, { lives: 7 }).getState().lives, 7, 'override de vidas');
  eq(criarEngineFase(20, { bonusPermanent: 125 }).getState().bonusPermanent, 125,
    'engine repassa o bônus recebido');
  eq(criarEngineFase(20, { bonusPermanent: 999 }).getState().bonusPermanent, 250,
    'engine limita o bônus ao cap 250 (como o save)');
});

check('Preparação auto-inicia a onda após 25 s', () => {
  const engine = criarEngineFase(1);
  engine.advance(24.5);
  eq(engine.getState().phase, 'prep', 'ainda em prep');
  engine.advance(1);
  eq(engine.getState().phase, 'wave', 'auto-start');
  assert(primeiroEvento(engine.drainEvents(), 'waveStart'), 'evento waveStart');
});

check('Debug/QA: debugAddMoney, debugSetLives, debugStartWave(1..2), debugSpawnEnemy', () => {
  const engine = criarEngineFase(1);
  eq(engine.debugAddMoney(100), startingMoneyFor(1, 0) + 100, 'soma dinheiro');
  eq(engine.debugAddMoney(-100000), 0, 'nunca fica negativo');
  eq(engine.debugSetLives(7), 7, 'define vidas');
  engine.debugSetLives(0);
  eq(engine.getState().phase, 'defeat', 'vidas 0 derrota');
  eq(primeiroEvento(engine.drainEvents(), 'defeat').lives, 0, 'evento defeat');

  const outra = criarEngineFase(1);
  eq(outra.debugStartWave(0), false, 'onda local inválida (0)');
  eq(outra.debugStartWave(-1), false, 'onda local inválida (-1)');
  eq(outra.debugStartWave(2), true, 'pula para a 2ª onda local');
  eq(outra.getState().wave, 2, 'onda local 2');
  eq(outra.getState().globalWave, 2, 'onda global 2');
  eq(outra.debugSpawnEnemy('soldado', 3), 3, 'spawna 3');
  eq(outra.getState().enemies.length, 3, '3 inimigos');
  eq(outra.debugSpawnEnemy('inexistente', 1), 0, 'tipo inválido');
});

// ================================================================ desbloqueios via engine
check('Engine bloqueia torres fora da fase com {bloqueado,unlockPhase,type} e libera na fase', () => {
  for (const [tipo, minimo] of Object.entries(TOWER_UNLOCK_PHASE)) {
    if (minimo > 1) {
      const engine = criarEngineFase(minimo - 1, { money: 5000 });
      const caixaAntes = engine.getState().money;
      const res = engine.buildTower(0, tipo);
      bloqueado(res, minimo, { type: tipo }, `torre ${tipo} na fase ${minimo - 1}`);
      eq(engine.getState().money, caixaAntes, `torre ${tipo}: bloqueio não cobra`);
      eq(engine.getState().towers.length, 0, `torre ${tipo}: nada construído`);
    }
    const engine = criarEngineFase(minimo, { money: 5000 });
    ok(engine.buildTower(0, tipo), `torre ${tipo} liberada na fase ${minimo}`);
  }
  const fase1 = criarEngineFase(1, { money: 5000 });
  erro(fase1.buildTower(1, 'torre-inexistente'), 'tipo-invalido');
  eq(fase1.getState().money, 5000, 'tipo inválido não cobra');
});

check('Engine bloqueia tropas fora da fase com {bloqueado,unlockPhase,type} e libera na fase', () => {
  for (const [tipo, minimo] of Object.entries(TROOP_UNLOCK_PHASE)) {
    if (minimo > 1) {
      const engine = criarEngineFase(minimo - 1, { money: 5000 });
      const caixaAntes = engine.getState().money;
      const res = engine.deployTroop(tipo, 0);
      bloqueado(res, minimo, { type: tipo }, `tropa ${tipo} na fase ${minimo - 1}`);
      eq(engine.getState().money, caixaAntes, `tropa ${tipo}: bloqueio não cobra`);
      eq(engine.getState().troops.length, 0, `tropa ${tipo}: nada posicionado`);
    }
    const engine = criarEngineFase(minimo, { money: 5000 });
    ok(engine.deployTroop(tipo, 0), `tropa ${tipo} liberada na fase ${minimo}`);
  }
  const fase1 = criarEngineFase(1, { money: 5000 });
  erro(fase1.deployTroop('tropa-inexistente', 0), 'tipo-invalido');
});

check('Engine bloqueia upgrade L2 antes da fase 2 e L3 antes da fase 5', () => {
  const fase1 = criarEngineFase(1, { money: 5000 });
  ok(fase1.buildTower(0, 'metralhadora'), 'build na fase 1');
  const caixaAntes = fase1.getState().money;
  bloqueado(fase1.upgradeTower(fase1.getState().towers[0].id), 2, { level: 2 }, 'upgrade L2 na fase 1');
  eq(fase1.getState().money, caixaAntes, 'upgrade bloqueado não cobra');
  eq(fase1.getState().towers[0].level, 1, 'torre continua L1');

  const fase2 = criarEngineFase(2, { money: 5000 });
  ok(fase2.buildTower(0, 'metralhadora'), 'build na fase 2');
  const id2 = fase2.getState().towers[0].id;
  ok(fase2.upgradeTower(id2), 'upgrade L2 liberado na fase 2');
  eq(fase2.getState().towers[0].level, 2, 'torre L2');
  bloqueado(fase2.upgradeTower(id2), 5, { level: 3 }, 'upgrade L3 na fase 2');
  eq(fase2.getState().towers[0].level, 2, 'torre continua L2');

  const fase5 = criarEngineFase(5, { money: 5000 });
  ok(fase5.buildTower(0, 'metralhadora'), 'build na fase 5');
  const id5 = fase5.getState().towers[0].id;
  ok(fase5.upgradeTower(id5), 'upgrade L2 na fase 5');
  ok(fase5.upgradeTower(id5), 'upgrade L3 liberado na fase 5');
  eq(fase5.getState().towers[0].level, 3, 'torre L3');
});

// ================================================================ combate (mecânicas herdadas)
function engineComTorre(fase, tipo, slot = 0, opcoes = {}) {
  const engine = criarEngineFase(fase, opcoes);
  ok(engine.buildTower(slot, tipo), `build ${tipo} na fase ${fase}`);
  engine.drainEvents();
  return engine;
}

check('Torres: construir, melhorar até L3, códigos de erro e venda 70%', () => {
  const engine = criarEngineFase(5);
  ok(engine.buildTower(0, 'metralhadora'), 'build metralhadora');
  eq(engine.getState().money, startingMoneyFor(5) - 100, 'dinheiro após build');
  let torre = engine.getState().towers[0];
  eq(torre.level, 1, 'nível 1');
  eq(torre.damage, 12, 'dano L1');
  near(torre.rate, 0.6, 1e-9, 'cadência L1');
  eq(torre.range, 14, 'alcance L1');
  eq(torre.invested, 100, 'investido');
  eq(torre.sellValue, 70, 'venda L1');
  eq(engine.getState().slots[0].towerId, torre.id, 'slot ocupado');

  erro(engine.buildTower(0, 'metralhadora'), 'slot-ocupado');
  erro(engine.buildTower(999, 'metralhadora'), 'slot-invalido');
  erro(engine.buildTower(1, 'torre-x'), 'tipo-invalido');

  ok(engine.upgradeTower(torre.id), 'upgrade L2');
  torre = engine.getState().towers[0];
  eq(torre.level, 2, 'nível 2');
  eq(torre.damage, 22, 'dano L2');
  eq(engine.getState().money, startingMoneyFor(5) - 180, 'dinheiro após L2');
  eq(torre.sellValue, 126, 'venda L2 (180 investido)');
  ok(engine.upgradeTower(torre.id), 'upgrade L3');
  torre = engine.getState().towers[0];
  eq(torre.level, 3, 'nível 3');
  eq(torre.damage, 36, 'dano L3');
  eq(torre.range, 16, 'alcance L3');
  eq(torre.invested, 320, 'investido L3');
  eq(torre.sellValue, 224, 'venda L3');
  eq(engine.getState().money, startingMoneyFor(5) - 320, 'dinheiro após L3');
  erro(engine.upgradeTower(torre.id), 'nivel-maximo');
  erro(engine.buildTower(1, 'missil'), 'bloqueado'); // fase 5: míssil só na fase 8
  erro(engine.upgradeTower(999), 'torre-invalida');
  eq(engine.getState().money, startingMoneyFor(5) - 320, 'falhas não mexem no caixa');

  const venda = engine.sellTower(torre.id);
  ok(venda, 'vender');
  eq(venda.refund, 224, 'reembolso 70%');
  eq(engine.getState().money, startingMoneyFor(5) - 320 + 224, 'dinheiro após venda');
  eq(engine.getState().towers.length, 0, 'torre removida');
  eq(engine.getState().slots[0].towerId, null, 'slot liberado');
  erro(engine.sellTower(torre.id), 'torre-invalida');
  const ev = eventosDe(engine.drainEvents());
  eq(ev.build, 1, 'evento build');
  eq(ev.upgrade, 2, 'eventos upgrade');
  eq(ev.sell, 1, 'evento sell');

  const semDinheiro = criarEngineFase(8);
  ok(semDinheiro.buildTower(0, 'missil'), '1º míssil');
  ok(semDinheiro.buildTower(1, 'missil'), '2º míssil');
  eq(semDinheiro.buildTower(2, 'missil').error, 'sem-dinheiro', '3º míssil sem caixa');
  eq(semDinheiro.getState().money, startingMoneyFor(8) - 360, 'caixa intacto após falha');

  const outra = criarEngineFase(1, { money: 1000 });
  outra.startWave();
  ok(outra.buildTower(0, 'metralhadora'), 'build durante a onda');
  const vitoria = criarEngineFase(1, { money: 1000 });
  vitoria.forceWin();
  erro(vitoria.buildTower(0, 'metralhadora'), 'fase-invalida');
});

check('Alvos: torre mira maior progresso e respeita compatibilidade', () => {
  const engine = engineComTorre(1, 'metralhadora', 0, { money: 600 });
  engine.debugSpawnEnemy('soldado', 2);
  engine.drainEvents();
  engine.step();
  let shot = primeiroEvento(engine.drainEvents(), 'shot');
  eq(shot.targetId, 1, 'empate: menor id');
  engine.advance(0.1);
  engine.drainEvents();
  engine.debugSpawnEnemy('soldado', 1); // id 3, progresso 0
  let alvo = null;
  for (let i = 0; i < 60 && !alvo; i += 1) {
    engine.step();
    alvo = primeiroEvento(engine.drainEvents(), 'shot');
  }
  assert(alvo, 'deveria atirar');
  eq(alvo.targetId, 1, 'maior progresso (id 1 chegou antes)');

  const anti = engineComTorre(2, 'antiaereo', 0, { money: 600 });
  anti.debugSpawnEnemy('soldado', 2);
  anti.advance(1);
  eq(eventosDe(anti.drainEvents()).shot || 0, 0, 'antiaéreo não atira em terrestre');
  anti.debugSpawnEnemy('drone', 1);
  let disparou = false;
  for (let i = 0; i < 60 && !disparou; i += 1) {
    anti.step();
    disparou = Boolean(primeiroEvento(anti.drainEvents(), 'shot'));
  }
  assert(disparou, 'deveria atirar no aéreo');
});

check('Dano instantâneo, kill e recompensa = rewardFor(base, fase) (fases 1/5/10/20)', () => {
  for (const fase of [1, 5, 10, 20]) {
    const engine = engineComTorre(fase, 'metralhadora', 0, { money: 5000 });
    // sobe a metralhadora até onde a fase permite (L1 na fase 1, L3 da fase 5 em diante)
    const id = engine.getState().towers[0].id;
    while (engine.upgradeTower(id).ok) { /* melhora tudo que a fase libera */ }
    const caixaAntes = engine.getState().money;
    engine.debugSpawnEnemy('soldado', 1);
    engine.drainEvents();
    let kill = null;
    for (let i = 0; i < 60 * 20 && !kill; i += 1) {
      engine.step();
      kill = primeiroEvento(engine.drainEvents(), 'kill');
    }
    assert(kill, `fase ${fase}: deveria matar o soldado`);
    eq(kill.enemyType, 'soldado', `fase ${fase}: tipo do kill`);
    eq(kill.boss, false, `fase ${fase}: kill não é chefe`);
    eq(kill.reward, rewardFor(ENEMIES.soldado.reward, fase), `fase ${fase}: recompensa por abate`);
    eq(engine.getState().money, caixaAntes + rewardFor(ENEMIES.soldado.reward, fase),
      `fase ${fase}: caixa com a recompensa`);
  }
});

check('Morteiro: splash em área + evento explosion', () => {
  const engine = engineComTorre(1, 'morteiro', 0, { money: 600 });
  engine.debugSpawnEnemy('soldado', 5);
  engine.drainEvents();
  engine.step();
  const evs = engine.drainEvents();
  assert(primeiroEvento(evs, 'shot'), 'evento shot');
  const explosao = primeiroEvento(evs, 'explosion');
  assert(explosao, 'evento explosion');
  eq(explosao.kind, 'morteiro', 'explosion kind');
  eq(explosao.radius, 4, 'raio splash L1');
  const st = engine.getState();
  const hpSoldado = hpForWave(ENEMIES.soldado.hp, globalWaveFor(1, 1));
  const atingidos = st.enemies.filter((e) => Math.abs(e.hp - (e.maxHp - 45)) <= 1e-6);
  assert(atingidos.length >= 5, `splash deveria atingir >=5, atingiu ${atingidos.length}`);
  eq(hpSoldado, st.enemies[0].maxHp, 'HP do soldado na 1ª onda global');
});

check('Tesla: cadeia 2 saltos no L1 com ×0,7 por salto e ≤6 u', () => {
  const engine = engineComTorre(4, 'tesla', 0, { money: 600 });
  engine.debugSpawnEnemy('soldado', 3);
  engine.drainEvents();
  engine.step();
  const evs = engine.drainEvents();
  const shot = primeiroEvento(evs, 'shot');
  assert(shot, 'shot tesla');
  eq(shot.kind, 'chain', 'kind chain');
  eq(shot.chain.length, 2, '2 saltos no L1');
  const st = engine.getState();
  const feridos = st.enemies.map((e) => Math.round((e.maxHp - e.hp) * 100) / 100);
  eq(feridos[0], 28, 'dano primário');
  near(feridos[1], 19.6, 1e-6, 'dano salto 1');
  near(feridos[2], 13.72, 1e-6, 'dano salto 2');
});

check('Criogênica: lentidão 25%/1,5 s no L1, teto 60% e chefes com 50% de resistência', () => {
  eq(applySlow({ slow: 0, slowLeft: 0 }, 0.8, 1, SLOW_CAP), 0.6, 'teto 60%');
  const engine = engineComTorre(6, 'criogenica', 0, { money: 600 });
  engine.debugSpawnEnemy('tanque', 1);
  engine.drainEvents();
  engine.step();
  const evs = engine.drainEvents();
  const lento = primeiroEvento(evs, 'slow');
  assert(lento, 'evento slow');
  near(lento.amount, 0.25, 1e-9, 'fração de lentidão');
  near(lento.duration, 1.5, 1e-9, 'duração');
  eq(engine.getState().enemies[0].slow, 0.25, 'estado slow');

  const bossEngine = engineComTorre(10, 'criogenica', 0, { money: 600 });
  bossEngine.debugSpawnEnemy('chefe-neve', 1);
  bossEngine.step();
  const bossSlow = primeiroEvento(bossEngine.drainEvents(), 'slow');
  assert(bossSlow, 'chefe também sofre lentidão');
  near(bossSlow.amount, 0.125, 1e-9, 'chefe 50% resistência');
});

check('Míssil: teleguiado 14 u/s, explode no alvo e em alvo morto na última posição', () => {
  const engine = criarEngineFase(8, { money: 900 });
  ok(engine.buildTower(0, 'missil'), 'build míssil 1');
  ok(engine.buildTower(1, 'missil'), 'build míssil 2');
  engine.debugSpawnEnemy('soldado', 1);
  engine.drainEvents();
  engine.step();
  let evs = engine.drainEvents();
  const tiros = evs.filter((e) => e.type === 'shot' && e.kind === 'missile');
  assert(tiros.length >= 1, 'disparou míssil');
  assert(Number.isFinite(tiros[0].missileId), 'shot com missileId');
  assert(engine.getState().projectiles.length >= 1, 'projétil no estado');
  eq(engine.getState().projectiles[0].type, 'missil', 'tipo do projétil');
  const hits = [];
  for (let i = 0; i < 300; i += 1) {
    engine.step();
    for (const e of engine.drainEvents()) if (e.type === 'missileHit') hits.push(e);
  }
  assert(hits.length >= 1, 'evento missileHit');
  eq(hits[0].radius, 3, 'raio 3 u');
  assert(engine.getState().stats.kills >= 1, 'alvo morreu');
  assert(hits.every((h) => Number.isFinite(h.x) && Number.isFinite(h.z)), 'posição da explosão');
});

check('Tropas: deploy/custo/limite por tipo/ponto/recarga/vida útil', () => {
  const engine = criarEngineFase(1);
  const r = engine.deployTroop('fuzileiros', 0);
  ok(r, 'deploy fuzileiros');
  eq(engine.getState().money, startingMoneyFor(1) - 90, 'custo debitado');
  const tropa = engine.getState().troops[0];
  eq(tropa.type, 'fuzileiros', 'tipo');
  eq(tropa.hp, 500, 'hp');
  eq(tropa.maxHp, 500, 'maxHp');
  near(tropa.lifeLeft, 40, 1e-9, 'vida útil');
  eq(engine.getState().troopPoints[0].troopId, tropa.id, 'ponto ocupado');
  erro(engine.deployTroop('fuzileiros', 1), 'tropa-viva');
  // na fase 1 a antiaérea ainda está bloqueada (desbloqueia na fase 3)
  bloqueado(engine.deployTroop('antiaerea', 1), 3, { type: 'antiaerea' }, 'antiaérea na fase 1');

  // fase 3: antiaérea liberada; erros de validação e vida útil/recarga.
  const anti = criarEngineFase(3, { money: 600 });
  eq(anti.deployTroop('antiaerea', 99).error, 'ponto-invalido', 'ponto inválido');
  eq(anti.deployTroop('tropa-x', 1).error, 'tipo-invalido', 'tipo inválido');
  ok(anti.deployTroop('antiaerea', 0), 'deploy antiaérea na fase 3');
  eq(anti.deployTroop('antiaerea', 0).error, 'ponto-ocupado', 'ponto ocupado');
  eq(anti.deployTroop('antiaerea', 1).error, 'tropa-viva', 'já existe antiaérea viva');
  eq(anti.getState().troopCooldowns.find((c) => c.type === 'antiaerea').ready, false, 'recarga iniciada');
  let morte = null;
  for (let i = 0; i < 36 * 60 && !morte; i += 1) {
    anti.step();
    for (const e of anti.drainEvents()) {
      if (e.type === 'troopDeath' && e.troopType === 'antiaerea') morte = e;
    }
  }
  assert(morte, 'antiaérea deveria expirar');
  eq(morte.reason, 'expired', 'motivo expired');
  eq(anti.getState().troopPoints[0].troopId, null, 'ponto liberado');
  eq(anti.getState().troopCooldowns.find((c) => c.type === 'antiaerea').ready, false, 'ainda recarregando');
  erro(anti.deployTroop('antiaerea', 0), 'recarga');
  anti.advance(6);
  eq(anti.getState().troopCooldowns.find((c) => c.type === 'antiaerea').ready, true, 'recarga concluída');
  ok(anti.deployTroop('antiaerea', 0), 'pode posicionar de novo');
});

check('Fuzileiros bloqueiam até 4 terrestres (inimigo para e ataca)', () => {
  const engine = criarEngineFase(1, { money: 600 });
  ok(engine.deployTroop('fuzileiros', 0), 'deploy fuzileiros');
  engine.debugSpawnEnemy('tanque', 1);
  engine.drainEvents();
  const tropaId = engine.getState().troops[0].id;
  let tanqueId = null;
  let progressoBloqueado = null;
  for (let passo = 0; passo < 60 * 40; passo += 1) {
    engine.step();
    engine.drainEvents();
    const st = engine.getState();
    const tanque = st.enemies.find((e) => e.type === 'tanque');
    if (tanque && tanque.blocked) {
      tanqueId = tanque.id;
      progressoBloqueado = tanque.progress;
      eq(tanque.targetTroopId, tropaId, 'alvo do bloqueio é o fuzileiro');
      break;
    }
  }
  assert(tanqueId !== null, 'tanque deveria ser bloqueado');
  engine.advance(1);
  const st2 = engine.getState();
  const tanque2 = st2.enemies.find((e) => e.id === tanqueId);
  assert(tanque2, 'tanque continua vivo');
  assert(tanque2.blocked, 'continua bloqueado');
  near(tanque2.progress, progressoBloqueado, 1e-6, 'inimigo bloqueado não avança');
  const tropa = st2.troops.find((t) => t.id === tropaId);
  assert(tropa && tropa.hp < 500 - 1e-6, 'tropa leva dano do inimigo bloqueado');

  const cap = criarEngineFase(1, { money: 600 });
  ok(cap.deployTroop('fuzileiros', 0), 'deploy fuzileiros (capacidade)');
  cap.debugStartWave(1);
  let bloqueados = 0;
  for (let passo = 0; passo < 60 * 45 && bloqueados === 0; passo += 1) {
    cap.step();
    cap.drainEvents();
    bloqueados = cap.getState().enemies.filter((e) => e.blocked).length;
  }
  assert(bloqueados > 0, 'deveria bloquear na 1ª onda');
  assert(bloqueados <= 4, `bloqueia no máximo 4 (obtido ${bloqueados})`);
});

check('Chefes não são bloqueados e atacam tropas no raio 2,5 u', () => {
  const engine = criarEngineFase(5, { money: 600 });
  ok(engine.deployTroop('fuzileiros', 0), 'deploy fuzileiros');
  engine.debugSpawnEnemy('chefe-deserto', 1);
  engine.drainEvents();
  const tropaId = engine.getState().troops[0].id;
  let hpMin = 500;
  let passou = false;
  for (let i = 0; i < 60 * 25; i += 1) {
    engine.step();
    engine.drainEvents();
    const st = engine.getState();
    const boss = st.enemies.find((e) => e.boss);
    if (!boss) break;
    assert(!boss.blocked, 'chefe nunca bloqueado');
    eq(boss.targetTroopId, null, 'chefe não tem alvo de bloqueio');
    const tropa = st.troops.find((t) => t.id === tropaId);
    if (tropa) hpMin = Math.min(hpMin, tropa.hp);
    if (boss.progress > 24) { passou = true; break; }
  }
  assert(passou, 'chefe deveria passar pela tropa');
  assert(hpMin < 500 - 1e-6, `chefe ataca tropa no raio 2,5 (hp mínimo ${hpMin})`);
});

check('Sniper prioriza maior HP; antiaérea prioriza maior progresso', () => {
  const engine = criarEngineFase(5, { money: 600 });
  ok(engine.deployTroop('sniper', 0), 'deploy sniper');
  engine.debugSpawnEnemy('tanque', 1); // id 1
  engine.debugSpawnEnemy('soldado', 1); // id 2
  engine.drainEvents();
  engine.step();
  const shot = primeiroEvento(engine.drainEvents(), 'troopShot');
  assert(shot, 'sniper atirou');
  eq(shot.targetId, 1, 'sniper mira o tanque (maior HP)');
  eq(shot.damage, 150, 'dano do sniper');

  const anti = criarEngineFase(3, { money: 600 });
  ok(anti.deployTroop('antiaerea', 0), 'deploy antiaérea');
  anti.debugSpawnEnemy('helicoptero', 1); // id 1
  anti.advance(1);
  anti.drainEvents();
  anti.debugSpawnEnemy('helicoptero', 1); // id 2
  let alvo = null;
  for (let i = 0; i < 120 && !alvo; i += 1) {
    anti.step();
    alvo = primeiroEvento(anti.drainEvents(), 'troopShot');
  }
  assert(alvo, 'antiaérea atirou');
  eq(alvo.targetId, 1, 'prioriza maior progresso');
});

// ================================================================ economia, vidas e vitória
check('Fim de onda: bônus 25+10×ondaGlobal e volta para a preparação (fases 1/5/10/15/20)', () => {
  for (const fase of [1, 5, 10, 15, 20]) {
    const engine = criarEngineFase(fase);
    engine.debugSetLives(1000);
    const caixaAntes = engine.getState().money;
    engine.drainEvents();
    eq(engine.debugStartWave(1), true, `fase ${fase}: inicia 1ª onda`);
    let fim = null;
    coletarFimDaOnda(engine, 400, (eventos) => {
      for (const ev of eventos) if (ev.type === 'waveEnd' && !fim) fim = ev;
    });
    assert(fim, `fase ${fase}: onda 1 deveria terminar`);
    eq(fim.bonus, waveBonus(globalWaveFor(fase, 1)),
      `fase ${fase}: bônus = 25+10×ondaGlobal(${globalWaveFor(fase, 1)})`);
    const st = engine.getState();
    eq(st.money, caixaAntes + waveBonus(globalWaveFor(fase, 1)), `fase ${fase}: bônus creditado`);
    eq(st.stats.wavesWon, 1, `fase ${fase}: wavesWon`);
    eq(st.phase, 'prep', `fase ${fase}: fim da 1ª onda volta para prep (não vence)`);
    eq(st.wave, 2, `fase ${fase}: próxima onda local 2`);
    eq(st.globalWave, globalWaveFor(fase, 2), `fase ${fase}: próxima onda global`);
  }
});

check('Vitória real: só após a 2ª onda, com evento victory {phaseNumber, lives, stars}', () => {
  for (const fase of [1, 5, 10, 15, 20]) {
    const engine = criarEngineFase(fase);
    engine.debugSetLives(1000);
    const caixaAntes = engine.getState().money;
    const eventos = [];
    engine.drainEvents();
    eq(engine.debugStartWave(1), true, `fase ${fase}: 1ª onda`);
    coletarFimDaOnda(engine, 400, (evs) => eventos.push(...evs));
    eq(engine.getState().phase, 'prep', `fase ${fase}: sem vitória após a 1ª onda`);
    eq(eventos.filter((e) => e.type === 'victory').length, 0, `fase ${fase}: nenhum victory na 1ª onda`);

    eq(engine.debugStartWave(2), true, `fase ${fase}: 2ª onda`);
    coletarFimDaOnda(engine, 400, (evs) => eventos.push(...evs));
    const st = engine.getState();
    eq(st.phase, 'victory', `fase ${fase}: vitória só na 2ª onda`);
    const fim2 = eventos.filter((e) => e.type === 'waveEnd').pop();
    assert(fim2, `fase ${fase}: waveEnd da 2ª onda`);
    eq(fim2.bonus, waveBonus(globalWaveFor(fase, 2)), `fase ${fase}: bônus da 2ª onda`);
    const vitoria = primeiroEvento(eventos, 'victory');
    assert(vitoria, `fase ${fase}: evento victory`);
    eq(vitoria.phaseNumber, fase, `fase ${fase}: victory.phaseNumber`);
    eq(vitoria.totalPhases, TOTAL_PHASES, `fase ${fase}: victory.totalPhases`);
    eq(vitoria.lives, st.lives, `fase ${fase}: victory.lives`);
    eq(vitoria.stars, starsForLives(st.lives), `fase ${fase}: victory.stars`);
    assert(st.lives > 0, `fase ${fase}: vidas > 0 na vitória`);
    eq(st.money, caixaAntes + waveBonus(globalWaveFor(fase, 1)) + waveBonus(globalWaveFor(fase, 2)),
      `fase ${fase}: bônus das 2 ondas creditados`);
    engine.advance(1);
    eq(engine.drainEvents().length, 0, `fase ${fase}: sem eventos após a vitória`);
  }
});

check('Chefe real: bossSpawn e state.boss com HP da onda global nas fases 5/10/15/20', () => {
  for (const [fase, tipo] of [[5, 'chefe-deserto'], [10, 'chefe-neve'], [15, 'chefe-deserto'], [20, 'chefe-cidade']]) {
    const global = globalWaveFor(fase, 2);
    const engine = criarEngineFase(fase);
    engine.debugSetLives(1000);
    engine.drainEvents();
    eq(engine.debugStartWave(2), true, `fase ${fase}: 2ª onda`);
    const evs = [];
    for (let i = 0; i < 60 * 10 && !engine.getState().boss; i += 1) {
      engine.step();
      evs.push(...engine.drainEvents());
    }
    evs.push(...engine.drainEvents());
    const spawn = primeiroEvento(evs, 'bossSpawn');
    assert(spawn, `fase ${fase}: bossSpawn`);
    eq(spawn.enemyType, tipo, `fase ${fase}: tipo do bossSpawn`);
    eq(spawn.maxHp, hpForWave(ENEMIES[tipo].hp, global), `fase ${fase}: HP do chefe na onda global ${global}`);
    const st = engine.getState();
    assert(st.boss, `fase ${fase}: state.boss`);
    eq(st.boss.type, tipo, `fase ${fase}: state.boss.type`);
    eq(st.boss.name, ENEMIES[tipo].name, `fase ${fase}: state.boss.name`);
    eq(st.boss.maxHp, hpForWave(ENEMIES[tipo].hp, global), `fase ${fase}: state.boss.maxHp`);
    eq(evs.filter((e) => e.type === 'spawn' && e.boss).length, 1, `fase ${fase}: um único chefe`);
  }
  // Sem chefe nas outras ondas (2ª onda de fase sem chefe e 1ª onda das fases de chefe).
  for (const [fase, local] of [[1, 2], [2, 2], [19, 2], [5, 1], [10, 1], [20, 1]]) {
    const engine = criarEngineFase(fase);
    engine.debugSetLives(1000);
    engine.drainEvents();
    eq(engine.debugStartWave(local), true, `fase ${fase}/${local}: inicia onda`);
    engine.advance(2);
    const evs = engine.drainEvents();
    eq(evs.filter((e) => e.type === 'bossSpawn').length, 0, `fase ${fase}/${local}: sem bossSpawn`);
    eq(engine.getState().boss, null, `fase ${fase}/${local}: state.boss nulo`);
  }
});

check('Derrota: 0 vidas encerra a partida com evento defeat', () => {
  const engine = criarEngineFase(1);
  engine.debugSpawnEnemy('soldado', 25);
  engine.drainEvents();
  const evs = [];
  for (let i = 0; i < 60 * 120; i += 1) {
    engine.step();
    evs.push(...engine.drainEvents());
    if (engine.getState().phase === 'defeat') break;
  }
  const st = engine.getState();
  eq(st.phase, 'defeat', 'derrota');
  eq(st.lives, 0, 'vidas 0');
  const leaks = evs.filter((e) => e.type === 'leak');
  eq(leaks.length, 20, '20 vazamentos até zerar as vidas');
  eq(leaks[0].damage, 1, 'dano do soldado');
  eq(leaks[0].lives, 19, 'vidas após o primeiro vazamento');
  const derrota = primeiroEvento(evs, 'defeat');
  assert(derrota, 'evento defeat');
  eq(derrota.lives, 0, 'evento defeat lives');
  eq(st.stats.damageTaken, 20, 'dano total na base');
  engine.advance(2);
  eq(engine.drainEvents().length, 0, 'sem eventos após derrota');
});

check('forceWin/forceLose encerram a fase com eventos (phaseNumber, stars) e máximo de vidas', () => {
  const v = criarEngineFase(3);
  eq(v.forceWin(), true, 'forceWin');
  eq(v.getState().phase, 'victory', 'fase vitória');
  const vit = primeiroEvento(v.drainEvents(), 'victory');
  eq(vit.phaseNumber, 3, 'victory.phaseNumber');
  eq(vit.stars, 3, '20 vidas = 3 estrelas');
  eq(vit.lives, 20, 'vidas na vitória');

  const v2 = criarEngineFase(7);
  v2.debugSetLives(15);
  eq(v2.forceWin(), true, 'forceWin com 15 vidas');
  eq(primeiroEvento(v2.drainEvents(), 'victory').stars, 2, '15 vidas = 2 estrelas');

  const d = criarEngineFase(12);
  eq(d.forceLose(), true, 'forceLose');
  eq(d.getState().phase, 'defeat', 'fase derrota');
  eq(d.getState().lives, 0, 'vidas 0');
  const der = primeiroEvento(d.drainEvents(), 'defeat');
  assert(der, 'evento derrota');
  eq(der.lives, 0, 'defeat.lives');
});

// ================================================================ save v2 + migração v1
const SAVE_PADRAO = {
  version: 2,
  tutorialDone: false,
  settings: { volume: 0.7, muted: false, speed: 1 },
  bonusPermanent: 0,
  phases: Array.from({ length: 20 }, () => ({ completed: false, stars: 0, bestLives: 0 })),
  totals: { kills: 0, waves: 0, timePlayed: 0 },
};

function saveV1(overrides = {}) {
  const mapa = (unlocked, stars, wavesWon, bestLives) => ({ unlocked, stars, wavesWon, bestLives });
  return {
    version: 1,
    tutorialDone: false,
    settings: { volume: 0.7, muted: false, speed: 1 },
    maps: { deserto: mapa(true, 0, 0, 0), neve: mapa(false, 0, 0, 0), cidade: mapa(false, 0, 0, 0) },
    totals: { kills: 0, waves: 0, timePlayed: 0 },
    ...overrides,
  };
}

check('Save v2: createDefaultSave com schema exato e chaves da especificação', () => {
  const save = createDefaultSave();
  deepEq(save, SAVE_PADRAO, 'schema do save padrão');
  eq(save.version, 2, 'version');
  eq(save.phases.length, 20, '20 fases no save');
  for (let i = 0; i < 20; i += 1) {
    eq(save.phases[i].completed, false, `fase ${i + 1}: não concluída`);
    eq(save.phases[i].stars, 0, `fase ${i + 1}: 0 estrelas`);
    eq(save.phases[i].bestLives, 0, `fase ${i + 1}: bestLives`);
  }
  // cada save devolvido é independente (sem estado compartilhado)
  save.phases[0].completed = true;
  eq(createDefaultSave().phases[0].completed, false, 'createDefaultSave devolve objeto novo');
});

check('Save v2: validateSave aceita objeto/string e sanitiza lixo, clamps e limites', () => {
  deepEq(validateSave('isto não é json'), SAVE_PADRAO, 'json inválido = default');
  deepEq(validateSave(null), SAVE_PADRAO, 'null = default');
  deepEq(validateSave(undefined), SAVE_PADRAO, 'undefined = default');
  deepEq(validateSave(42), SAVE_PADRAO, 'número = default');

  const comLixo = validateSave({
    version: 9,
    tutorialDone: true,
    settings: { volume: 42, muted: 'x', speed: 7 },
    bonusPermanent: 999,
    phases: [
      { completed: true, stars: 99, bestLives: 99 },
      { completed: 'sim', stars: -5, bestLives: -1 },
    ],
    totals: { kills: -5, waves: -1, timePlayed: -2 },
  });
  eq(comLixo.version, 2, 'versão saneada para 2');
  eq(comLixo.tutorialDone, true, 'tutorialDone preservado');
  eq(comLixo.settings.volume, 1, 'volume clamp 1');
  eq(comLixo.settings.muted, false, 'muted inválido = false');
  eq(comLixo.settings.speed, 1, 'speed inválido = 1');
  eq(comLixo.totals.kills, 0, 'kills negativo = 0');
  eq(comLixo.totals.waves, 0, 'waves negativo = 0');
  eq(comLixo.totals.timePlayed, 0, 'timePlayed negativo = 0');
  eq(comLixo.phases.length, 20, 'sempre 20 fases');
  eq(comLixo.phases[0].completed, true, 'fase 1 concluída');
  eq(comLixo.phases[0].stars, 3, 'stars clamp 3');
  eq(comLixo.phases[0].bestLives, 20, 'bestLives normalizado para a faixa de 3★');
  eq(comLixo.phases[1].completed, false, 'progresso inválido descartado');
  eq(completedPhaseCount(comLixo), 1, 'só a fase 1 é válida');
  eq(comLixo.bonusPermanent, 250, 'bônus 999 → cap 250 (nunca regride)');

  // não muta a entrada
  const raw = { version: 2, phases: [], totals: { kills: 1, waves: 2, timePlayed: 3 } };
  const antes = JSON.stringify(raw);
  validateSave(raw);
  eq(JSON.stringify(raw), antes, 'validateSave não muta a entrada');

  // aceita string JSON de save v2 válido
  const valido = createDefaultSave();
  valido.tutorialDone = true;
  valido.totals.kills = 42;
  deepEq(validateSave(JSON.stringify(valido)), valido, 'string v2 válida é preservada');
});

check('Save v2: progressão sequencial obrigatória e bônus recalculado (nunca regride, cap 250)', () => {
  // fase concluída fora de ordem é descartada (mantém o prefixo válido)
  const foraDeOrdem = createDefaultSave();
  foraDeOrdem.phases[0] = { completed: true, stars: 3, bestLives: 20 };
  foraDeOrdem.phases[1] = { completed: true, stars: 2, bestLives: 16 };
  foraDeOrdem.phases[4] = { completed: true, stars: 3, bestLives: 20 };
  const saneado = validateSave(foraDeOrdem);
  eq(saneado.phases[0].completed, true, 'fase 1 concluída');
  eq(saneado.phases[1].completed, true, 'fase 2 concluída');
  eq(saneado.phases[4].completed, false, 'fase 5 descartada (buraco na sequência)');
  eq(completedPhaseCount(saneado), 2, '2 fases concluídas');
  eq(saneado.bonusPermanent, 50, 'bônus derivado de 2 concluídas');

  // bônus armazenado maior que o derivado nunca regride (cap 250)
  const salvoComBonus = createDefaultSave();
  salvoComBonus.phases[0] = { completed: true, stars: 3, bestLives: 20 };
  salvoComBonus.bonusPermanent = 100;
  eq(validateSave(salvoComBonus).bonusPermanent, 100, 'bônus 100 preservado (nunca menor que o derivado)');
  eq(completedPhaseCount(validateSave(salvoComBonus)), 1, 'bônus não inventa fases');

  const bonusCap = createDefaultSave();
  bonusCap.bonusPermanent = 12345;
  eq(validateSave(bonusCap).bonusPermanent, 250, 'bônus 12345 → cap 250');

  const tudo = createDefaultSave();
  for (let i = 0; i < 20; i += 1) tudo.phases[i] = { completed: true, stars: 3, bestLives: 20 };
  tudo.bonusPermanent = 0;
  eq(validateSave(tudo).bonusPermanent, 250, 'bônus recalculado com 20 concluídas');
});

check('Save v2: isPhaseUnlocked e completedPhaseCount sequenciais', () => {
  let save = createDefaultSave();
  eq(isPhaseUnlocked(save, 1), true, 'fase 1 sempre liberada');
  eq(isPhaseUnlocked(save, 2), false, 'fase 2 bloqueada');
  eq(completedPhaseCount(save), 0, 'nenhuma concluída');
  eq(validateSave({ phases: [{ completed: true, stars: 1, bestLives: 1 }] }).phases[0].completed, true,
    'fase 1 concluída aceita');
  save = applyPhaseVictory(save, 1, 20);
  eq(isPhaseUnlocked(save, 2), true, 'fase 2 liberada após a 1');
  eq(isPhaseUnlocked(save, 3), false, 'fase 3 ainda bloqueada');
  eq(completedPhaseCount(save), 1, '1 concluída');
  save = applyPhaseVictory(save, 2, 15);
  eq(isPhaseUnlocked(save, 3), true, 'fase 3 liberada após a 2');
  eq(completedPhaseCount(save), 2, '2 concluídas');
});

check('Save v2: applyPhaseVictory marca fase/estrelas/bestLives/totais (puro, sem mutar)', () => {
  const base = createDefaultSave();
  const antes = JSON.stringify(base);
  const depois1 = applyPhaseVictory(base, 1, 20);
  eq(JSON.stringify(base), antes, 'applyPhaseVictory não muta o save de entrada');
  eq(depois1.phases[0].completed, true, 'fase 1 concluída');
  eq(depois1.phases[0].stars, 3, 'fase 1: 3 estrelas');
  eq(depois1.phases[0].bestLives, 20, 'fase 1: bestLives 20');
  eq(completedPhaseCount(depois1), 1, '1 concluída');
  eq(depois1.bonusPermanent, 25, 'bônus 25 após a fase 1');
  eq(depois1.totals.waves, 2, 'totais: +2 ondas (2 ondas por fase)');
  eq(depois1.totals.kills, 0, 'totais: kills intocados');
  eq(depois1.totals.timePlayed, 0, 'totais: tempo intocado');

  const depois2 = applyPhaseVictory(depois1, 2, 15);
  eq(depois2.phases[1].completed, true, 'fase 2 concluída');
  eq(depois2.phases[1].stars, 2, 'fase 2: 2 estrelas (15 vidas)');
  eq(depois2.phases[1].bestLives, 15, 'fase 2: bestLives 15');
  eq(depois2.bonusPermanent, 50, 'bônus 50 após 2 fases');
  eq(depois2.totals.waves, 4, 'totais: 4 ondas');

  // replay: estrelas/bestLives nunca regridem e o bônus não infla
  const replay = applyPhaseVictory(depois2, 1, 10);
  eq(replay.phases[0].stars, 3, 'replay não reduz estrelas');
  eq(replay.phases[0].bestLives, 20, 'replay não reduz bestLives');
  eq(completedPhaseCount(replay), 2, 'replay não cria fases');
  eq(replay.bonusPermanent, 50, 'replay não infla o bônus');

  // fase 2 com vidas maiores melhora estrelas/bestLives
  const melhor = applyPhaseVictory(depois2, 2, 19);
  eq(melhor.phases[1].stars, 2, '2 estrelas com 19 vidas (máximo já era 2)');
  eq(melhor.phases[1].bestLives, 19, 'bestLives melhora para 19');
});

check('Migração v1 → v2: cenários completos com as estrelas antigas e settings/totals preservados', () => {
  const v1 = saveV1({
    tutorialDone: true,
    settings: { volume: 0.5, muted: true, speed: 2 },
    maps: {
      deserto: { unlocked: true, stars: 3, wavesWon: 8, bestLives: 20 },
      neve: { unlocked: true, stars: 2, wavesWon: 8, bestLives: 15 },
      cidade: { unlocked: true, stars: 1, wavesWon: 8, bestLives: 3 },
    },
    totals: { kills: 123, waves: 456, timePlayed: 789 },
  });
  for (const entrada of [v1, JSON.stringify(v1)]) {
    const save = validateSave(entrada);
    eq(save.version, 2, 'versão migrada para 2');
    eq(save.tutorialDone, true, 'tutorialDone preservado');
    deepEq(save.settings, { volume: 0.5, muted: true, speed: 2 }, 'settings preservados');
    deepEq(save.totals, { kills: 123, waves: 456, timePlayed: 789 }, 'totals preservados');
    eq(completedPhaseCount(save), 20, '20 fases concluídas');
    eq(save.bonusPermanent, 250, 'bônus derivado 250');
    for (let fase = 1; fase <= 7; fase += 1) {
      eq(save.phases[fase - 1].completed, true, `Deserto fase ${fase} concluída`);
      eq(save.phases[fase - 1].stars, 3, `Deserto fase ${fase}: estrelas antigas (3)`);
      eq(save.phases[fase - 1].bestLives, 20, `Deserto fase ${fase}: bestLives 3★ = 20`);
    }
    for (let fase = 8; fase <= 14; fase += 1) {
      eq(save.phases[fase - 1].completed, true, `Neve fase ${fase} concluída`);
      eq(save.phases[fase - 1].stars, 2, `Neve fase ${fase}: estrelas antigas (2)`);
      eq(save.phases[fase - 1].bestLives, 15, `Neve fase ${fase}: bestLives antigo na faixa 2★`);
    }
    for (let fase = 15; fase <= 20; fase += 1) {
      eq(save.phases[fase - 1].completed, true, `Cidade fase ${fase} concluída`);
      eq(save.phases[fase - 1].stars, 1, `Cidade fase ${fase}: estrelas antigas (1)`);
      eq(save.phases[fase - 1].bestLives, 3, `Cidade fase ${fase}: bestLives antigo na faixa 1★`);
    }
  }
});

check('Migração v1 → v2: progresso parcial vira fases com 1 estrela e bônus derivado', () => {
  const parcial = validateSave(saveV1({
    maps: {
      deserto: { unlocked: true, stars: 0, wavesWon: 4, bestLives: 0 },
      neve: { unlocked: false, stars: 0, wavesWon: 0, bestLives: 0 },
      cidade: { unlocked: false, stars: 0, wavesWon: 0, bestLives: 0 },
    },
  }));
  // floor(4/8 × 7) = 3 fases do Deserto concluídas, com 1 estrela (sem inventar estrelas altas)
  eq(completedPhaseCount(parcial), 3, '3 fases derivadas');
  for (let fase = 1; fase <= 3; fase += 1) {
    eq(parcial.phases[fase - 1].completed, true, `fase ${fase} concluída`);
    eq(parcial.phases[fase - 1].stars, 1, `fase ${fase}: 1 estrela (progresso parcial)`);
    eq(parcial.phases[fase - 1].bestLives, 1, `fase ${fase}: bestLives 1 (faixa de 1★)`);
  }
  eq(parcial.phases[3].completed, false, 'fase 4 não concluída');
  eq(parcial.bonusPermanent, 75, 'bônus derivado de 3 concluídas');
  eq(isPhaseUnlocked(parcial, 4), true, 'fase 4 liberada');
  eq(isPhaseUnlocked(parcial, 5), false, 'fase 5 bloqueada');

  // cenário seguinte parcial: Deserto completo + Neve pela metade
  const meio = validateSave(saveV1({
    maps: {
      deserto: { unlocked: true, stars: 3, wavesWon: 8, bestLives: 20 },
      neve: { unlocked: true, stars: 0, wavesWon: 4, bestLives: 0 },
      cidade: { unlocked: false, stars: 0, wavesWon: 0, bestLives: 0 },
    },
  }));
  eq(completedPhaseCount(meio), 10, '7 do Deserto + 3 da Neve');
  for (let fase = 8; fase <= 10; fase += 1) {
    eq(meio.phases[fase - 1].completed, true, `Neve fase ${fase} derivada`);
    eq(meio.phases[fase - 1].stars, 1, `Neve fase ${fase}: 1 estrela parcial`);
  }
  eq(meio.phases[10].completed, false, 'Neve fase 11 não concluída');
  eq(meio.bonusPermanent, 250, 'bônus no cap com 10 concluídas');
});

check('Migração v1 → v2: progresso incoerente/fora de ordem é descartado', () => {
  // v1 não poderia ter Neve vencida sem o Deserto completo: descarta o impossível.
  const impossivel = validateSave(saveV1({
    maps: {
      deserto: { unlocked: true, stars: 0, wavesWon: 2, bestLives: 0 },
      neve: { unlocked: true, stars: 3, wavesWon: 8, bestLives: 20 },
      cidade: { unlocked: true, stars: 3, wavesWon: 8, bestLives: 20 },
    },
  }));
  eq(completedPhaseCount(impossivel), 1, 'floor(2/8 × 7) = 1 fase do Deserto');
  eq(impossivel.phases[0].completed, true, 'fase 1 concluída');
  for (let fase = 8; fase <= 20; fase += 1) {
    eq(impossivel.phases[fase - 1].completed, false, `fase ${fase} descartada (fora de ordem)`);
  }
  eq(impossivel.bonusPermanent, 25, 'bônus coerente com 1 fase');

  // Cidade "vencida" sem a Neve completa também cai.
  const semNeve = validateSave(saveV1({
    maps: {
      deserto: { unlocked: true, stars: 3, wavesWon: 8, bestLives: 20 },
      neve: { unlocked: true, stars: 0, wavesWon: 0, bestLives: 0 },
      cidade: { unlocked: true, stars: 3, wavesWon: 8, bestLives: 20 },
    },
  }));
  eq(completedPhaseCount(semNeve), 7, 'só o Deserto é válido');
  for (let fase = 15; fase <= 20; fase += 1) {
    eq(semNeve.phases[fase - 1].completed, false, `Cidade fase ${fase} descartada`);
  }
});

check('Migração v1 → v2: bestLives antigo é normalizado para a faixa das estrelas', () => {
  const v1 = saveV1({
    maps: {
      deserto: { unlocked: true, stars: 2, wavesWon: 8, bestLives: 5 },
      neve: { unlocked: true, stars: 1, wavesWon: 8, bestLives: 20 },
      cidade: { unlocked: true, stars: 3, wavesWon: 8, bestLives: 10 },
    },
  });
  const save = validateSave(v1);
  eq(completedPhaseCount(save), 20, '20 fases concluídas');
  eq(save.bonusPermanent, 250, 'bônus 250');
  for (let fase = 1; fase <= 7; fase += 1) {
    eq(save.phases[fase - 1].stars, 2, `Deserto fase ${fase}: 2 estrelas`);
    eq(save.phases[fase - 1].bestLives, 14, `Deserto fase ${fase}: bestLives 5 → 14 (mínimo da faixa 2★)`);
  }
  for (let fase = 8; fase <= 14; fase += 1) {
    eq(save.phases[fase - 1].stars, 1, `Neve fase ${fase}: 1 estrela`);
    eq(save.phases[fase - 1].bestLives, 13, `Neve fase ${fase}: bestLives 20 → 13 (máximo da faixa 1★)`);
  }
  for (let fase = 15; fase <= 20; fase += 1) {
    eq(save.phases[fase - 1].stars, 3, `Cidade fase ${fase}: 3 estrelas`);
    eq(save.phases[fase - 1].bestLives, 20, `Cidade fase ${fase}: bestLives 10 → 20 (3★)`);
  }
});

check('Sem save no meio da partida: engine não grava e o save só muda na vitória (applyPhaseVictory)', () => {
  // O engine é puro: não conhece localStorage e não emite eventos de save.
  const engine = criarEngineFase(1);
  engine.debugSetLives(1000);
  engine.debugStartWave(1);
  const eventos = [];
  coletarFimDaOnda(engine, 400, (evs) => eventos.push(...evs));
  eq(eventos.filter((e) => /save|storage|localStorage/i.test(e.type)).length, 0,
    'engine não emite eventos de save durante a onda');
  // A partida em andamento não altera o save: só applyPhaseVictory, ao final.
  const save = createDefaultSave();
  const antes = JSON.stringify(save);
  const durante = applyPhaseVictory(save, 1, 20);
  eq(JSON.stringify(save), antes, 'save só muda quando applyPhaseVictory devolve o novo save');
  eq(durante.phases[0].completed, true, 'save novo marcado ao final da fase');
});

// ================================================================ determinismo
check('Determinismo: mesma fase+seed ⇒ mesmos eventos e mesmo estado', () => {
  function roteiro(engine) {
    const log = [];
    ok(engine.buildTower(0, 'metralhadora'), 'build 1');
    ok(engine.buildTower(1, 'antiaereo'), 'build 2');
    engine.startWave();
    for (let i = 0; i < 1800; i += 1) {
      engine.step();
      if (i % 60 === 0) log.push(...engine.drainEvents());
    }
    engine.deployTroop('fuzileiros', 0);
    const id = engine.getState().towers[0].id;
    engine.upgradeTower(id);
    for (let i = 0; i < 2400; i += 1) {
      engine.step();
      if (i % 60 === 0) log.push(...engine.drainEvents());
    }
    log.push(...engine.drainEvents());
    return JSON.stringify({ eventos: log, estado: engine.getState() });
  }
  const a = criarEngineFase(2, { money: 900 });
  const b = criarEngineFase(2, { money: 900 });
  eq(roteiro(a), roteiro(b), 'duas execuções idênticas');
  const c = criarEngineFase(20);
  eq(c.getState().scenario, 'cidade', 'outra fase/cenário');
});

// ================================================================ bot de referência
// Bot determinístico de balanceamento (testado pelo Lead; portado literalmente):
// constrói a wishlist em ordem nos slots livres mais próximos da base, reinveste a
// renda dos abates a cada 5 s simulados (durante a onda), posiciona tropas conforme a
// composição da onda (chefe ⇒ sniper; ≥3 aéreos ⇒ antiaérea; ≥8 terrestres ⇒
// fuzileiros) e melhora priorizando alto dano. Nunca vende e não usa aleatoriedade.
function wishlist(phase) {
  const lista = [];
  // Ordem de construção: solo barato no começo; a partir da fase 4/8 as torres
  // de alto dano (AA, míssil, tesla) vêm primeiro.
  if (phase < 8) lista.push({ type: 'metralhadora', count: 2, minPhase: 1 });
  else lista.push({ type: 'missil', count: 1 + Math.floor((phase - 8) / 5), minPhase: 8 });
  lista.push({ type: 'antiaereo', count: 2 + Math.floor((phase - 2) / 6), minPhase: 2 });
  if (phase >= 3) lista.push({ type: 'morteiro', count: 1 + (phase >= 10 ? 1 : 0), minPhase: 3 });
  if (phase >= 4) lista.push({ type: 'tesla', count: 1 + Math.floor((phase - 4) / 8), minPhase: 4 });
  if (phase >= 6) lista.push({ type: 'criogenica', count: 1, minPhase: 6 });
  if (phase >= 8) lista.push({ type: 'missil', count: 1 + Math.floor((phase - 8) / 5), minPhase: 8 });
  if (phase >= 8) lista.push({ type: 'metralhadora', count: 1, minPhase: 1 });
  return lista.filter((i) => phase >= i.minPhase);
}

const PRIORIDADE_UP = ['missil', 'tesla', 'antiaereo', 'morteiro', 'metralhadora', 'criogenica'];

function contarTipos(torres) {
  const mapa = {};
  for (const t of torres) mapa[t.type] = (mapa[t.type] || 0) + 1;
  return mapa;
}

function gastarCaixa(engine) {
  // 1) constrói a wishlist em ordem; 2) melhora.
  for (let guard = 0; guard < 120; guard += 1) {
    const st = engine.getState();
    const have = contarTipos(st.towers);
    const livres = st.slots.filter((s) => s.towerId === null);
    const lista = wishlist(st.phaseNumber);
    const slot = livres.length ? livres[livres.length - 1] : null;
    let fez = false;
    if (slot) {
      for (const item of lista) {
        if ((have[item.type] || 0) >= item.count) continue;
        if (st.money < TOWERS[item.type].costs[0]) continue;
        if (engine.buildTower(slot.i, item.type).ok) { fez = true; break; }
      }
    }
    if (!fez) break;
  }
  // 2) melhoras, priorizando alto dano.
  for (let guard = 0; guard < 300; guard += 1) {
    const st = engine.getState();
    const candidatas = st.towers
      .filter((t) => t.level < 3 && st.unlocks.upgrades[t.level + 1]
        && st.money >= TOWERS[t.type].costs[t.level])
      .sort((a, b) => (a.level - b.level)
        || (PRIORIDADE_UP.indexOf(a.type) - PRIORIDADE_UP.indexOf(b.type))
        || (a.id - b.id));
    if (!candidatas.length) break;
    if (!engine.upgradeTower(candidatas[0].id).ok) break;
  }
}

function botPreparar(engine) {
  const st0 = engine.getState();
  gastarCaixa(engine);
  const onda = waveFor(st0.phaseNumber, st0.wave);
  const aereos = onda ? airEnemiesIn(onda).reduce((soma, grupo) => soma + grupo.count, 0) : 0;
  const terrestres = onda ? groundEnemiesIn(onda) : 0;
  const querTropas = [];
  if (onda && onda.boss) querTropas.push('sniper');
  if (aereos >= 3) querTropas.push('antiaerea');
  if (terrestres >= 8) querTropas.push('fuzileiros');
  for (const tipo of querTropas) {
    const st = engine.getState();
    if (!st.unlocks.troops[tipo]) continue;
    const cd = st.troopCooldowns.find((c) => c.type === tipo);
    if (st.troops.some((t) => t.type === tipo) || !cd || !cd.ready) continue;
    const ponto = st.troopPoints.find((p) => p.troopId === null);
    if (!ponto || st.money < TROOPS[tipo].cost) continue;
    engine.deployTroop(tipo, ponto.j);
  }
  engine.drainEvents();
  engine.startWave();
  engine.drainEvents();
}

function botJogarFase(fase, save) {
  const inicio = Date.now();
  const engine = createEngine({
    phase: fase,
    seed: DEFAULT_SEED,
    bonusPermanent: save.bonusPermanent,
    completedPhases: completedPhaseCount(save),
  });
  engine.drainEvents();
  const eventos = [];
  let guard = 0;
  while (guard < 4000) {
    guard += 1;
    const st = engine.getState();
    if (st.phase === 'victory' || st.phase === 'defeat') break;
    if (st.phase === 'prep') botPreparar(engine);
    let passos = 0;
    while (engine.getState().phase === 'wave' && passos < 800) {
      // O jogador pode construir durante a onda: o bot reinveste a renda dos
      // abates a cada 5 s de simulação (determinístico).
      if (passos % 5 === 0) gastarCaixa(engine);
      engine.advance(1);
      eventos.push(...engine.drainEvents());
      passos += 1;
    }
    eventos.push(...engine.drainEvents());
  }
  const st = engine.getState();
  return {
    fase,
    scenario: scenarioForPhase(fase),
    vitoria: st.phase === 'victory',
    vidas: st.lives,
    onda: st.wave,
    globalWave: st.globalWave,
    dinheiro: st.money,
    kills: st.stats.kills,
    vazamentos: st.stats.leaked,
    tempoSimulado: Math.round(st.time),
    vendas: eventos.filter((e) => e.type === 'sell').length,
    tempoRealMs: Date.now() - inicio,
  };
}

function botJogarCampanha() {
  let save = createDefaultSave();
  const resultados = [];
  for (let fase = 1; fase <= TOTAL_PHASES; fase += 1) {
    assert(isPhaseUnlocked(save, fase), `fase ${fase} deveria estar liberada antes de jogar`);
    const esperadoBonus = bonusPermanentFor(completedPhaseCount(save));
    eq(save.bonusPermanent, esperadoBonus, `fase ${fase}: bônus antes da partida`);
    const r = botJogarFase(fase, save);
    resultados.push(r);
    console.log(`FASE ${fase}: vitória=${r.vitoria} vidas=${r.vidas} kills=${r.kills} `
      + `vazamentos=${r.vazamentos} (${r.scenario}, ${r.tempoSimulado}s sim, ${r.tempoRealMs}ms real)`);
    if (r.vitoria) {
      save = applyPhaseVictory(save, fase, r.vidas);
      eq(completedPhaseCount(save), fase, `fase ${fase}: save marca as fases concluídas`);
      eq(save.bonusPermanent, bonusPermanentFor(fase), `fase ${fase}: bônus acumulado no save`);
      if (fase < TOTAL_PHASES) {
        eq(isPhaseUnlocked(save, fase + 1), true, `fase ${fase}: libera a fase ${fase + 1}`);
      }
    } else {
      break; // derrota interrompe a campanha (relatada na checagem abaixo)
    }
  }
  return { save, resultados };
}

const campanha = botJogarCampanha();
const resultados = campanha.resultados;
const totalVitorias = resultados.filter((r) => r.vitoria).length;

check('Bot de referência vence a campanha inteira (20/20 fases) sem vender', () => {
  eq(totalVitorias, TOTAL_PHASES,
    `bot venceu ${totalVitorias}/${TOTAL_PHASES} fases (parou na fase ${resultados.length}: `
    + `vidas=${resultados[resultados.length - 1].vidas})`);
  eq(resultados.length, TOTAL_PHASES, 'jogou as 20 fases');
  eq(resultados.filter((r) => r.vendas > 0).length, 0, 'bot nunca vende');
  eq(completedPhaseCount(campanha.save), TOTAL_PHASES, 'save final com 20 fases');
  eq(campanha.save.bonusPermanent, 250, 'bônus final 250');
  eq(isPhaseUnlocked(campanha.save, 20), true, 'fase 20 liberada no fim');
  for (const r of resultados) {
    assert(r.vidas >= 1, `fase ${r.fase}: vidas deveriam ser >= 1, foram ${r.vidas}`);
    eq(r.vitoria, true, `fase ${r.fase}: vitória`);
  }
});

if (COMPLETO) {
  check('--completo: bot vence as 20 fases com vidas >= 8 em cada fase', () => {
    for (const r of resultados) {
      eq(r.vitoria, true, `fase ${r.fase}: vitória`);
      assert(r.vidas >= 8, `fase ${r.fase}: vidas deveriam ser >= 8, foram ${r.vidas}`);
    }
  });
  const tempoReal = Date.now() - inicioGeral;
  check(`--completo em menos de 180 s reais (${tempoReal} ms)`, () => {
    assert(tempoReal < 180000, `demorou ${tempoReal} ms`);
  });
} else {
  const tempoBot = resultados.reduce((s, r) => s + r.tempoRealMs, 0);
  check(`bot da campanha completa em menos de 20 s reais (${tempoBot} ms)`, () => {
    assert(tempoBot < 20000, `bot demorou ${tempoBot} ms`);
  });
}

// ================================================================ resumo
const duracao = ((Date.now() - inicioGeral) / 1000).toFixed(2);
console.log('------------------------------------------------------------------');
console.log(`${duracao}s — ${total} checagens, ${total - falhas} PASS, ${falhas} FAIL${COMPLETO ? ' (--completo)' : ''}`);
if (falhas > 0) {
  console.error(`FALHARAM: ${falhas} checagem(ns).`);
  process.exit(1);
}
console.log('TODAS AS CHECAGENS PASSARAM');
process.exit(0);
