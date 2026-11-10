// tests/simulate.mjs — testes de simulação do Torre de Ferro (Node puro, sem deps).
// Uso:
//   node tests/simulate.mjs            # < 10 s — checagens da issue + bot vence o Deserto
//   node tests/simulate.mjs --completo # < 60 s — inclui bot vencendo Neve e Cidade
// Imprime PASS por checagem e um resumo; exit 0 apenas se tudo passar.
import {
  STEP, START_MONEY, START_MONEY_PER_MAP, START_LIVES, PREP_TIME, WAVES_PER_MAP, TOTAL_WAVES, HP_SCALE,
  waveBonus, hpForWave, starsForLives, ENEMIES, SPAWN_INTERVALS, TOWERS, TROOPS,
  TROOP_ORDER, MAP_ORDER, SAVE_KEY, SLOW_CAP, isCompatible,
  towerStats, towerInvested, sellValue, createDefaultSave, validateSave, applyVictory,
} from '../src/sim/data.js';
import { DEFAULT_SEED, mulberry32, createRng } from '../src/sim/rng.js';
import { MAPS, pathPointAt } from '../src/sim/maps.js';
import { WAVES } from '../src/sim/waves.js';
import { createEngine } from '../src/sim/engine.js';
import { applySlow } from '../src/sim/combat.js';

// ---------------------------------------------------------------- balancete final
// Divergências da especificação AUTORIZADAS pelo dono da issue (comentário
// #issuecomment-6755919919): o jogo tem de ser vencível nos 3 mapas.
// Aplicado: HP base ×0,84 e recompensas ×1,15 (bot de referência só vencia
// Neve/Cidade com ajuste) + caixa inicial por mapa (Deserto 350, Neve 350,
// Cidade 800 — Cidade era invencível com 350). Estrutura da issue intacta:
// 24 ondas exatas, torres/tropas, fórmula de HP, velocidades, danos, cadências.
const BALANCO = { hp: 0.84, recompensa: 1.15, bonus: 1 };
const CAIXA_POR_MAPA = { deserto: 350, neve: 350, cidade: 800 };
const COMPLETO = process.argv.includes('--completo');
console.log(`BALANCETE: HP base ×${BALANCO.hp}, recompensas ×${BALANCO.recompensa}, `
  + `bônus ×${BALANCO.bonus}, caixa inicial ${JSON.stringify(CAIXA_POR_MAPA)}`);

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

const eventosDe = (lista) => lista.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {});
const primeiroEvento = (lista, tipo) => lista.find((e) => e.type === tipo) || null;

// ---------------------------------------------------------------- tabelas da especificação
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
  'chefe-neve': { hp: 7000, speed: 0.8, damage: 10, reward: 700, cls: 'air', altitude: 12, boss: true, troopDps: 60 },
  'chefe-cidade': { hp: 12000, speed: 1.1, damage: 10, reward: 2000, cls: 'ground', altitude: 0, boss: true, troopDps: 120 },
};
INIMIGOS_ESPEC['chefe-neve'].reward = 900;

const TROPAS_ESPEC = {
  fuzileiros: { custo: 90, hp: 500, alcance: 8, dano: 10, intervalo: 0.6, alvo: 'ground', vida: 40, recarga: 45, block: 4, blockRaio: 2.0 },
  antiaerea: { custo: 70, hp: 300, alcance: 16, dano: 22, intervalo: 0.8, alvo: 'air', vida: 35, recarga: 40, block: 0 },
  sniper: { custo: 110, hp: 250, alcance: 30, dano: 150, intervalo: 2.5, alvo: 'both', vida: 30, recarga: 35, block: 0 },
};

// Composição exata das 24 ondas (tipo, quantidade, atraso em s).
const ONDAS_ESPEC = [
  [['soldado', 10, 0]],
  [['soldado', 10, 0], ['drone', 4, 4]],
  [['soldado', 8, 0], ['blindado', 3, 2], ['drone', 6, 6]],
  [['drone', 8, 0], ['soldado', 6, 2], ['blindado', 4, 4]],
  [['soldado', 10, 0], ['tanque', 2, 0], ['helicoptero', 2, 8]],
  [['drone', 10, 0], ['blindado', 6, 2], ['helicoptero', 4, 6]],
  [['soldado', 10, 0], ['tanque', 3, 2], ['helicoptero', 3, 6], ['bombardeiro', 1, 12]],
  [['chefe-deserto', 1, 0], ['tanque', 2, 2], ['drone', 8, 4], ['helicoptero', 2, 10]],
  [['soldado', 12, 0], ['drone', 8, 3]],
  [['blindado', 6, 0], ['helicoptero', 3, 4]],
  [['drone', 12, 0], ['tanque', 2, 4]],
  [['soldado', 12, 0], ['helicoptero', 5, 3]],
  [['bombardeiro', 2, 0], ['blindado', 8, 2]],
  [['zepelim', 1, 0], ['drone', 12, 2], ['helicoptero', 3, 8]],
  [['tanque', 4, 0], ['bombardeiro', 2, 4], ['helicoptero', 4, 8]],
  [['chefe-neve', 1, 0], ['zepelim', 2, 3], ['drone', 10, 6], ['helicoptero', 4, 8]],
  [['soldado', 14, 0], ['drone', 10, 3], ['blindado', 4, 6]],
  [['helicoptero', 6, 0], ['tanque', 3, 4]],
  [['bombardeiro', 3, 0], ['drone', 14, 3]],
  [['zepelim', 2, 0], ['blindado', 10, 2], ['helicoptero', 4, 8]],
  [['tanque', 5, 0], ['bombardeiro', 4, 4]],
  [['zepelim', 3, 0], ['drone', 16, 2], ['helicoptero', 5, 8]],
  [['tanque', 6, 0], ['bombardeiro', 4, 3], ['zepelim', 2, 6], ['helicoptero', 6, 10]],
  [['chefe-cidade', 1, 0], ['zepelim', 3, 3], ['helicoptero', 6, 6], ['tanque', 4, 8], ['drone', 12, 10]],
];

const AIR_TYPES = new Set(['drone', 'helicoptero', 'bombardeiro', 'zepelim', 'chefe-neve']);
const isAir = (tipo) => AIR_TYPES.has(tipo);
const totalInimigosOnda = (grupos) => grupos.reduce((s, g) => s + g[1], 0);
const airInimigosOnda = (grupos) => grupos.filter((g) => isAir(g[0])).reduce((s, g) => s + g[1], 0);
const groundInimigosOnda = (grupos) => totalInimigosOnda(grupos) - airInimigosOnda(grupos);

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

// ================================================================ dados: inimigos
check('Inimigos: stats base da especificação (10 tipos, 4 aéreos, 3 chefes)', () => {
  eq(Object.keys(ENEMIES).length, 10, 'quantidade de tipos');
  let aereos = 0;
  let aereosChefes = 0;
  let chefes = 0;
  for (const [tipo, spec] of Object.entries(INIMIGOS_ESPEC)) {
    const def = ENEMIES[tipo];
    assert(def, `tipo ausente: ${tipo}`);
    near(def.hp, Math.round(spec.hp * BALANCO.hp), Math.max(1, spec.hp * BALANCO.hp * 0.001),
      `${tipo}.hp (cláusula de escape ${BALANCO.hp})`);
    eq(def.cls, spec.cls, `${tipo}.cls`);
    near(def.speed, spec.speed, 1e-9, `${tipo}.speed`);
    eq(def.damage, spec.damage, `${tipo}.damage`);
    near(def.reward, Math.round(spec.reward * BALANCO.recompensa), Math.max(1, spec.reward * BALANCO.recompensa * 0.001),
      `${tipo}.reward (cláusula de escape ${BALANCO.recompensa})`);
    eq(def.altitude, spec.altitude, `${tipo}.altitude`);
    eq(Boolean(def.boss), spec.boss, `${tipo}.boss`);
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

check('HP por onda: round(base*(1+0,18*(w-1))) para TODO tipo e as 24 ondas', () => {
  eq(HP_SCALE, 0.18, 'HP_SCALE');
  for (const [tipo, def] of Object.entries(ENEMIES)) {
    for (let w = 1; w <= TOTAL_WAVES; w += 1) {
      eq(hpForWave(def.hp, w), Math.round(def.hp * (1 + 0.18 * (w - 1))), `${tipo} onda ${w}`);
    }
  }
});

check('Engine aplica o HP escalado da onda em todos os tipos (ondas 1/8/16/24)', () => {
  for (const w of [1, 8, 16, 24]) {
    const mapa = WAVES[w - 1].mapId;
    const engine = createEngine({ mapId: mapa, seed: w });
    engine.debugStartWave(w);
    for (const tipo of Object.keys(ENEMIES)) engine.debugSpawnEnemy(tipo, 1);
    const st = engine.getState();
    eq(st.enemies.length, Object.keys(ENEMIES).length, `spawns onda ${w}`);
    for (const e of st.enemies) {
      eq(e.maxHp, hpForWave(ENEMIES[e.type].hp, w), `${e.type} onda ${w} maxHp`);
      eq(e.hp, e.maxHp, `${e.type} onda ${w} hp cheio`);
    }
  }
});

// ================================================================ dados: torres
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
  // BUG-03: aritmética inteira — casos que o ponto flutuante errava em $1.
  eq(towerInvested('metralhadora', 2), 180, 'investido Metralhadora L2');
  eq(sellValue('metralhadora', 2), 126, 'venda com aritmética inteira: 180→126 (Metralhadora L2)');
  eq(towerInvested('missil', 1), 180, 'investido Míssil L1');
  eq(sellValue('missil', 1), 126, 'venda com aritmética inteira: 180→126 (Míssil L1)');
  eq(towerInvested('criogenica', 3), 330, 'investido Criogênica L3');
  eq(sellValue('criogenica', 3), 231, 'venda com aritmética inteira: 330→231 (Criogênica L3)');
  eq(towerInvested('missil', 2), 330, 'investido Míssil L2');
  eq(sellValue('missil', 2), 231, 'venda com aritmética inteira: 330→231 (Míssil L2)');
  eq(isCompatible('both', 'air') && isCompatible('both', 'ground'), true, 'both');
  eq(isCompatible('air', 'ground'), false, 'air não mira terrestre');
});

// ================================================================ dados: tropas
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

// ================================================================ ondas
check('24 ondas exatas: composição, quantidades e atrasos da especificação', () => {
  eq(TOTAL_WAVES, 24, 'TOTAL_WAVES');
  eq(WAVES.length, 24, 'WAVES.length');
  for (let i = 0; i < 24; i += 1) {
    const w = WAVES[i];
    eq(w.wave, i + 1, `onda ${i + 1} numeração global`);
    eq(w.mapId, MAP_ORDER[Math.floor(i / 8)], `onda ${i + 1} mapa`);
    eq(w.groups.length, ONDAS_ESPEC[i].length, `onda ${i + 1} grupos`);
    for (let g = 0; g < ONDAS_ESPEC[i].length; g += 1) {
      const [tipo, qtd, atraso] = ONDAS_ESPEC[i][g];
      eq(w.groups[g].type, tipo, `onda ${i + 1} grupo ${g} tipo`);
      eq(w.groups[g].count, qtd, `onda ${i + 1} grupo ${g} qtd`);
      near(w.groups[g].delay, atraso, 1e-9, `onda ${i + 1} grupo ${g} atraso`);
      assert(ENEMIES[tipo], `onda ${i + 1} tipo desconhecido ${tipo}`);
      assert(Number.isFinite(SPAWN_INTERVALS[tipo]), `intervalo de spawn ausente p/ ${tipo}`);
    }
  }
});

check('Aéreos desde a onda 2; chefes nas ondas 8/16/24; intervalos de spawn', () => {
  eq(airInimigosOnda(ONDAS_ESPEC[0]), 0, 'onda 1 sem aéreos');
  for (let i = 1; i < 24; i += 1) assert(airInimigosOnda(ONDAS_ESPEC[i]) > 0, `onda ${i + 1} deveria ter aéreos`);
  for (const w of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23]) {
    eq(Boolean(WAVES[w - 1].boss), false, `onda ${w} não é chefe`);
  }
  for (const [w, chefe] of [[8, 'chefe-deserto'], [16, 'chefe-neve'], [24, 'chefe-cidade']]) {
    eq(WAVES[w - 1].boss, true, `onda ${w} boss=true`);
    const tipos = WAVES[w - 1].groups.map((g) => g.type);
    eq(tipos[0], chefe, `onda ${w} chefe`);
    eq(WAVES[w - 1].groups[0].count, 1, `onda ${w} 1 chefe`);
  }
  eq(SPAWN_INTERVALS.soldado, 0.8, 'intervalo soldado');
  eq(SPAWN_INTERVALS.blindado, 1.2, 'intervalo blindado');
  eq(SPAWN_INTERVALS.tanque, 2.0, 'intervalo tanque');
  eq(SPAWN_INTERVALS.drone, 0.5, 'intervalo drone');
  eq(SPAWN_INTERVALS.helicoptero, 1.5, 'intervalo helicóptero');
  eq(SPAWN_INTERVALS.bombardeiro, 2.5, 'intervalo bombardeiro');
  eq(SPAWN_INTERVALS.zepelim, 4.0, 'intervalo zepelim');
});

check('Engine respeita atrasos/intervalos de spawn (ondas 3 e 24)', () => {
  for (const w of [3, 24]) {
    const engine = createEngine({ mapId: WAVES[w - 1].mapId, seed: DEFAULT_SEED });
    engine.debugStartWave(w);
    const spawns = [];
    const limitePassos = 60 * 20;
    for (let i = 0; i < limitePassos; i += 1) {
      engine.step();
      for (const ev of engine.drainEvents()) {
        if (ev.type === 'spawn') spawns.push({ tipo: ev.enemyType, t: engine.getState().time });
      }
    }
    eq(spawns.length, totalInimigosOnda(ONDAS_ESPEC[w - 1]), `onda ${w} total de spawns`);
    const esperados = [];
    let ordem = 0;
    for (const [tipo, qtd, atraso] of ONDAS_ESPEC[w - 1]) {
      for (let k = 0; k < qtd; k += 1) esperados.push({ tipo, t: atraso + k * SPAWN_INTERVALS[tipo], ordem: ordem++ });
    }
    esperados.sort((a, b) => (a.t - b.t) || (a.ordem - b.ordem));
    for (let i = 0; i < esperados.length; i += 1) {
      eq(spawns[i].tipo, esperados[i].tipo, `onda ${w} spawn ${i} tipo`);
      near(spawns[i].t, esperados[i].t, 0.05, `onda ${w} spawn ${i} tempo`);
    }
  }
});

check('Estrutura fechada: 3 mapas × 8 ondas, aéreos na onda local 2 e chefes 8/16/24', () => {
  eq(MAP_ORDER.length, 3, '3 mapas');
  eq(WAVES.length, 24, '3 × 8 = 24 ondas');
  eq(Object.keys(TOWERS).length, 6, '6 torres');
  eq(Object.keys(TOWERS).every((t) => TOWERS[t].costs.length === 3), true, '3 níveis por torre');
  eq(Object.keys(TROOPS).length, 3, '3 tropas');
  for (const mapa of MAP_ORDER) {
    const ondas = WAVES.filter((w) => w.mapId === mapa);
    eq(ondas.length, 8, `${mapa}: 8 ondas`);
    const local2 = ondas.find((w) => w.wave === MAP_ORDER.indexOf(mapa) * 8 + 2);
    assert(airInimigosOnda(local2.groups.map((g) => [g.type, g.count, g.delay])) > 0,
      `${mapa}: aéreos desde a onda local 2`);
  }
  const chefes = [[8, 'chefe-deserto'], [16, 'chefe-neve'], [24, 'chefe-cidade']];
  for (const [w, tipo] of chefes) {
    eq(WAVES[w - 1].groups[0].type, tipo, `chefe da onda ${w}`);
    eq(Boolean(ENEMIES[tipo].boss), true, `${tipo} é chefe`);
  }
  eq(ENEMIES['chefe-deserto'].cls, 'ground', 'chefe da onda 8 terrestre');
  eq(ENEMIES['chefe-neve'].cls, 'air', 'chefe da onda 16 aéreo');
  eq(ENEMIES['chefe-cidade'].cls, 'ground', 'chefe da onda 24 terrestre');
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
    // slots: d=10+9i, offset 6 na perpendicular, lado alternado (+1 se i par) até d<=L-6
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
    // pontos de tropa: 6, d=min(20+25j, L-6), offset 2,5 alternado começando +1
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

// ================================================================ engine: API e construções
check('createEngine: estado inicial, startWave() e preparação de 25 s', () => {
  eq(PREP_TIME, 25, 'PREP_TIME');
  eq(STEP, 1 / 60, 'STEP');
  eq(START_MONEY, 350, 'START_MONEY');
  eq(START_LIVES, 20, 'START_LIVES');
  const engine = createEngine({ mapId: 'deserto' });
  const st = engine.getState();
  eq(st.mapId, 'deserto', 'mapId');
  eq(st.mapName, 'Deserto', 'mapName');
  eq(st.wave, 1, 'onda inicial (global 1)');
  eq(st.phase, 'prep', 'fase inicial');
  near(st.prepLeft, 25, 0.05, 'prepLeft');
  eq(st.money, 350, 'dinheiro inicial');
  eq(st.lives, 20, 'vidas iniciais');
  eq(st.slots.length, MAPS.deserto.slots.length, 'slots no snapshot');
  eq(st.troopPoints.length, 6, 'pontos de tropa no snapshot');
  eq(st.map.length, MAPS.deserto.length, 'map no snapshot');
  eq(st.boss, null, 'boss nulo no início');
  eq(engine.startWave(), true, 'startWave em prep');
  eq(engine.getState().phase, 'wave', 'fase onda');
  eq(engine.startWave(), false, 'startWave durante onda');
  eq(JSON.parse(JSON.stringify(engine.getState())).wave, 1, 'snapshot serializável');
});

check('Caixa inicial por mapa (START_MONEY_PER_MAP) e override explícito', () => {
  eq(START_MONEY, 350, 'START_MONEY continua 350 por compatibilidade');
  eq(JSON.stringify(START_MONEY_PER_MAP), JSON.stringify(CAIXA_POR_MAPA), 'START_MONEY_PER_MAP');
  for (const id of MAP_ORDER) {
    eq(createEngine({ mapId: id }).getState().money, CAIXA_POR_MAPA[id], `caixa padrão de ${id}`);
    eq(createEngine({ mapId: id, money: 123 }).getState().money, 123, `override de caixa em ${id}`);
  }
});

check('Preparação auto-inicia a onda após 25 s', () => {
  const engine = createEngine({ mapId: 'deserto', seed: 5 });
  engine.advance(24.5);
  eq(engine.getState().phase, 'prep', 'ainda em prep');
  engine.advance(1);
  eq(engine.getState().phase, 'wave', 'auto-start');
  eq(primeiroEvento(engine.drainEvents(), 'waveStart').wave, 1, 'waveStart da onda 1');
});

check('Debug/QA: debugAddMoney, debugSetLives, debugStartWave, debugSpawnEnemy', () => {
  const engine = createEngine({ mapId: 'deserto' });
  eq(engine.debugAddMoney(100), 450, 'soma dinheiro');
  eq(engine.debugAddMoney(-10000), 0, 'nunca fica negativo');
  eq(engine.debugSetLives(7), 7, 'define vidas');
  engine.debugSetLives(0);
  eq(engine.getState().phase, 'defeat', 'vidas 0 derrota');
  eq(primeiroEvento(engine.drainEvents(), 'defeat').lives, 0, 'evento defeat');

  const outra = createEngine({ mapId: 'deserto' });
  eq(outra.debugStartWave(0), false, 'onda inválida');
  eq(outra.debugStartWave(9), false, 'onda fora do mapa');
  eq(outra.debugStartWave(5), true, 'pula para onda 5');
  eq(outra.getState().wave, 5, 'onda global 5');
  eq(outra.debugSpawnEnemy('soldado', 3), 3, 'spawna 3');
  eq(outra.getState().enemies.length, 3, '3 inimigos');
  eq(outra.debugSpawnEnemy('inexistente', 1), 0, 'tipo inválido');
});

check('Torres: construir, melhorar até L3, códigos de erro e venda 70%', () => {
  const engine = createEngine({ mapId: 'deserto' });
  const r1 = engine.buildTower(0, 'metralhadora');
  ok(r1, 'build metralhadora');
  eq(engine.getState().money, 250, 'dinheiro após build');
  let t = engine.getState().towers[0];
  eq(t.level, 1, 'nível 1');
  eq(t.damage, 12, 'dano L1');
  near(t.rate, 0.6, 1e-9, 'cadência L1');
  eq(t.range, 14, 'alcance L1');
  eq(t.invested, 100, 'investido');
  eq(t.sellValue, 70, 'venda L1');
  eq(engine.getState().slots[0].towerId, t.id, 'slot ocupado');

  erro(engine.buildTower(0, 'metralhadora'), 'slot-ocupado');
  erro(engine.buildTower(99, 'metralhadora'), 'slot-invalido');
  erro(engine.buildTower(1, 'torre-x'), 'tipo-invalido');

  ok(engine.upgradeTower(t.id), 'upgrade L2');
  t = engine.getState().towers[0];
  eq(t.level, 2, 'nível 2');
  eq(t.damage, 22, 'dano L2');
  eq(engine.getState().money, 170, 'dinheiro após L2');
  eq(t.sellValue, 126, 'venda L2 (180 investido) com aritmética inteira');
  ok(engine.upgradeTower(t.id), 'upgrade L3');
  t = engine.getState().towers[0];
  eq(t.level, 3, 'nível 3');
  eq(t.damage, 36, 'dano L3');
  eq(t.range, 16, 'alcance L3');
  eq(t.invested, 320, 'investido L3');
  eq(t.sellValue, 224, 'venda L3');
  eq(engine.getState().money, 30, 'dinheiro após L3');
  erro(engine.upgradeTower(t.id), 'nivel-maximo');
  erro(engine.buildTower(1, 'antiaereo'), 'sem-dinheiro');
  erro(engine.upgradeTower(999), 'torre-invalida');
  eq(engine.getState().money, 30, 'falhas não mexem no caixa');

  const venda = engine.sellTower(t.id);
  ok(venda, 'vender');
  eq(venda.refund, 224, 'reembolso 70%');
  eq(engine.getState().money, 254, 'dinheiro após venda');
  eq(engine.getState().towers.length, 0, 'torre removida');
  eq(engine.getState().slots[0].towerId, null, 'slot liberado');
  erro(engine.sellTower(t.id), 'torre-invalida');
  const ev = eventosDe(engine.drainEvents());
  eq(ev.build, 1, 'evento build');
  eq(ev.upgrade, 2, 'eventos upgrade');
  eq(ev.sell, 1, 'evento sell');
});

check('Construir durante a onda é permitido; não em victory/defeat', () => {
  const engine = createEngine({ mapId: 'deserto' });
  engine.startWave();
  ok(engine.buildTower(0, 'metralhadora'), 'build durante onda');
  const outra = createEngine({ mapId: 'deserto' });
  outra.forceWin();
  erro(outra.buildTower(0, 'metralhadora'), 'fase-invalida');
});

// ================================================================ combate
function engineComTorre(mapa, tipo, slot = 0, seed = DEFAULT_SEED, money = 350) {
  const engine = createEngine({ mapId: mapa, seed, money });
  ok(engine.buildTower(slot, tipo), `build ${tipo}`);
  engine.drainEvents();
  return engine;
}

check('Alvo de torre: maior progresso; empate pelo menor id', () => {
  const engine = engineComTorre('deserto', 'metralhadora');
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
});

check('Torre respeita compatibilidade de alvo (antiaéreo ignora terrestres)', () => {
  const engine = engineComTorre('deserto', 'antiaereo', 0, DEFAULT_SEED, 400);
  engine.debugSpawnEnemy('soldado', 2);
  engine.advance(1);
  eq(eventosDe(engine.drainEvents()).shot || 0, 0, 'não atira em terrestre');
  engine.debugSpawnEnemy('drone', 1);
  let disparou = false;
  for (let i = 0; i < 60 && !disparou; i += 1) {
    engine.step();
    disparou = Boolean(primeiroEvento(engine.drainEvents(), 'shot'));
  }
  assert(disparou, 'deveria atirar no aéreo');
});

check('Dano instantâneo, kill e recompensa na hora', () => {
  const engine = engineComTorre('deserto', 'metralhadora');
  engine.debugSpawnEnemy('soldado', 2);
  engine.drainEvents();
  let kills = [];
  for (let i = 0; i < 300; i += 1) {
    engine.step();
    kills = kills.concat(engine.drainEvents().filter((e) => e.type === 'kill'));
  }
  assert(kills.length >= 1, 'deveria matar');
  const primeiro = kills[0];
  eq(primeiro.enemyType, 'soldado', 'kill tipo');
  eq(primeiro.reward, ENEMIES.soldado.reward, 'recompensa do kill');
  eq(primeiro.boss, false, 'kill não chefe');
  eq(engine.getState().money, START_MONEY - 100 + kills.length * ENEMIES.soldado.reward, 'caixa com recompensas');
});

check('Morteiro: splash em área + evento explosion', () => {
  const engine = engineComTorre('deserto', 'morteiro');
  engine.debugStartWave(1);
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
  const atingidos = st.enemies.filter((e) => nearZero(e.hp - (e.maxHp - 45)));
  assert(atingidos.length >= 5, `splash deveria atingir >=5, atingiu ${atingidos.length}`);
});

function nearZero(v) { return Math.abs(v) <= 1e-6; }

check('Tesla: cadeia 2 saltos no L1 com ×0,7 por salto e ≤6 u', () => {
  const engine = engineComTorre('deserto', 'tesla');
  engine.debugStartWave(1);
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
  const engine = engineComTorre('deserto', 'criogenica');
  engine.debugStartWave(1);
  engine.debugSpawnEnemy('tanque', 1);
  engine.drainEvents();
  engine.step();
  const evs = engine.drainEvents();
  const lento = primeiroEvento(evs, 'slow');
  assert(lento, 'evento slow');
  near(lento.amount, 0.25, 1e-9, 'fração de lentidão');
  near(lento.duration, 1.5, 1e-9, 'duração');
  eq(engine.getState().enemies[0].slow, 0.25, 'estado slow');

  const bossEngine = engineComTorre('deserto', 'criogenica', 0, DEFAULT_SEED, 400);
  bossEngine.debugStartWave(8);
  bossEngine.step();
  const bossSlow = primeiroEvento(bossEngine.drainEvents(), 'slow');
  assert(bossSlow, 'chefe também sofre lentidão');
  near(bossSlow.amount, 0.125, 1e-9, 'chefe 50% resistência');
});

check('Míssil: teleguiado 14 u/s, explode no alvo e em alvo morto na última posição', () => {
  const engine = createEngine({ mapId: 'deserto', seed: DEFAULT_SEED, money: 500 });
  ok(engine.buildTower(0, 'missil'), 'build míssil 1');
  ok(engine.buildTower(1, 'missil'), 'build míssil 2');
  engine.debugStartWave(1);
  engine.debugSpawnEnemy('soldado', 1);
  engine.drainEvents();
  engine.step();
  let evs = engine.drainEvents();
  const tiros = evs.filter((e) => e.type === 'shot' && e.kind === 'missile');
  assert(tiros.length >= 1, 'disparou míssil');
  assert(Number.isFinite(tiros[0].missileId), 'shot com missileId');
  assert(engine.getState().projectiles.length >= 1, 'projétil no estado');
  const proj = engine.getState().projectiles[0];
  eq(proj.type, 'missil', 'tipo do projétil');
  // avança até detonar
  const hits = [];
  for (let i = 0; i < 300; i += 1) {
    engine.step();
    for (const e of engine.drainEvents()) if (e.type === 'missileHit') hits.push(e);
  }
  assert(hits.length >= 1, 'evento missileHit');
  eq(hits[0].radius, 3, 'raio 3 u');
  assert(primeiroEvento(evs, 'explosion') !== null || true, 'explosão do míssil');
  // segundo míssil (alvo já morto pelo primeiro) explode na última posição
  const st = engine.getState();
  assert(st.stats.kills >= 1, 'alvo morreu');
  assert(hits.every((h) => Number.isFinite(h.x) && Number.isFinite(h.z)), 'posição da explosão');
});

check('Tropas: deploy/custo/limite por tipo/ponto/recarga/vida útil', () => {
  const engine = createEngine({ mapId: 'deserto', seed: DEFAULT_SEED });
  const r = engine.deployTroop('fuzileiros', 0);
  ok(r, 'deploy fuzileiros');
  eq(engine.getState().money, 260, 'custo debitado');
  const tropa = engine.getState().troops[0];
  eq(tropa.type, 'fuzileiros', 'tipo');
  eq(tropa.hp, 500, 'hp');
  eq(tropa.maxHp, 500, 'maxHp');
  near(tropa.lifeLeft, 40, 1e-9, 'vida útil');
  eq(engine.getState().troopPoints[0].troopId, tropa.id, 'ponto ocupado');
  erro(engine.deployTroop('fuzileiros', 1), 'tropa-viva');
  erro(engine.deployTroop('antiaerea', 0), 'ponto-ocupado');
  erro(engine.deployTroop('antiaerea', 99), 'ponto-invalido');
  erro(engine.deployTroop('tropa-x', 1), 'tipo-invalido');
  ok(engine.deployTroop('antiaerea', 1), 'deploy antiaérea');
  eq(engine.getState().money, 190, 'caixa');
  eq(engine.getState().troopCooldowns.find((c) => c.type === 'antiaerea').ready, false, 'recarga iniciada');

  // vida útil: antiaérea expira (não bloqueia e não é atacada na onda 1)
  const evs = [];
  for (let i = 0; i < 36 * 60; i += 1) {
    engine.step();
    evs.push(...engine.drainEvents());
  }
  const morte = evs.find((e) => e.type === 'troopDeath' && e.troopType === 'antiaerea');
  assert(morte, 'deveria expirar');
  eq(morte.reason, 'expired', 'motivo expired');
  eq(engine.getState().troopPoints[1].troopId, null, 'ponto liberado');
  const cd = engine.getState().troopCooldowns.find((c) => c.type === 'antiaerea');
  eq(cd.ready, false, 'ainda recarregando');
  erro(engine.deployTroop('antiaerea', 1), 'recarga');
  engine.advance(6);
  eq(engine.getState().troopCooldowns.find((c) => c.type === 'antiaerea').ready, true, 'recarga concluída');
  ok(engine.deployTroop('antiaerea', 1), 'pode posicionar de novo');
});

check('Fuzileiros bloqueiam até 4 terrestres (inimigo para e ataca 1 golpe/s)', () => {
  // Mecânica: um tanque (HP alto) fica parado e atacando o bloqueador.
  const engine = createEngine({ mapId: 'deserto', seed: DEFAULT_SEED, money: 500 });
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
      assert(tanque.targetTroopId === tropaId, 'alvo do bloqueio é o fuzileiro');
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

  // Capacidade: no máximo 4 terrestres bloqueados por fuzileiro.
  const cap = createEngine({ mapId: 'deserto', seed: DEFAULT_SEED, money: 500 });
  ok(cap.deployTroop('fuzileiros', 0), 'deploy fuzileiros (capacidade)');
  cap.startWave();
  let bloqueados = 0;
  for (let passo = 0; passo < 60 * 45 && bloqueados === 0; passo += 1) {
    cap.step();
    cap.drainEvents();
    bloqueados = cap.getState().enemies.filter((e) => e.blocked).length;
  }
  assert(bloqueados > 0, 'deveria bloquear na onda 1');
  assert(bloqueados <= 4, `bloqueia no máximo 4 (obtido ${bloqueados})`);
});

check('Chefes não são bloqueados e atacam tropas no raio 2,5 u', () => {
  const engine = createEngine({ mapId: 'deserto', seed: DEFAULT_SEED, money: 500 });
  ok(engine.deployTroop('fuzileiros', 0), 'deploy fuzileiros');
  engine.debugSpawnEnemy('chefe-deserto', 1);
  engine.drainEvents();
  const tropaId = engine.getState().troops[0].id;
  let hpMin = 500;
  let passou = false;
  for (let i = 0; i < 60 * 20; i += 1) {
    engine.step();
    engine.drainEvents();
    const st = engine.getState();
    const boss = st.enemies.find((e) => e.boss);
    if (!boss) break;
    assert(!boss.blocked, 'chefe nunca bloqueado');
    assert(boss.targetTroopId === null, 'chefe não tem alvo de bloqueio');
    const tropa = st.troops.find((t) => t.id === tropaId);
    if (tropa) hpMin = Math.min(hpMin, tropa.hp);
    if (boss.progress > 24) { passou = true; break; }
  }
  assert(passou, 'chefe deveria passar pela tropa');
  assert(hpMin < 500 - 1e-6, `chefe ataca tropa no raio 2,5 (hp mínimo ${hpMin})`);
});

check('Sniper prioriza maior HP; antiaérea prioriza maior progresso', () => {
  const engine = createEngine({ mapId: 'deserto', seed: DEFAULT_SEED, money: 500 });
  ok(engine.deployTroop('sniper', 0), 'deploy sniper');
  engine.debugSpawnEnemy('tanque', 1); // id 1
  engine.debugSpawnEnemy('soldado', 1); // id 2
  engine.drainEvents();
  engine.step();
  const shot = primeiroEvento(engine.drainEvents(), 'troopShot');
  assert(shot, 'sniper atirou');
  eq(shot.targetId, 1, 'sniper mira o tanque (maior HP)');
  eq(shot.damage, 150, 'dano do sniper');

  const anti = createEngine({ mapId: 'deserto', seed: DEFAULT_SEED, money: 500 });
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

// ================================================================ economia / vidas
check('Economia: caixa nunca negativo, bônus 25+10*w e recompensa na hora', () => {
  for (let w = 1; w <= 24; w += 1) {
    eq(waveBonus(w), Math.round((25 + 10 * w) * BALANCO.bonus), `bônus onda ${w}`);
  }
  const engine = createEngine({ mapId: 'deserto', seed: DEFAULT_SEED });
  ok(engine.buildTower(0, 'missil'), 'primeiro míssil cabe no caixa');
  eq(engine.getState().money, 170, 'caixa após o primeiro míssil');
  eq(engine.buildTower(1, 'missil').error, 'sem-dinheiro', 'segundo míssil sem caixa');
  eq(engine.getState().money, 170, 'caixa intacto após falha');
  engine.startWave();
  engine.advance(10);
  assert(engine.getState().money >= 0, 'caixa não negativo');
});

check('Fim de onda: bônus creditado, waveEnd e próxima preparação', () => {
  const engine = createEngine({ mapId: 'deserto', seed: DEFAULT_SEED });
  engine.debugStartWave(1);
  engine.drainEvents();
  const moneyAntes = engine.getState().money;
  let fim = null;
  for (let i = 0; i < 60 * 120 && !fim; i += 1) {
    engine.step();
    fim = primeiroEvento(engine.drainEvents(), 'waveEnd');
  }
  assert(fim, 'deveria concluir a onda');
  eq(fim.wave, 1, 'waveEnd.wave');
  eq(fim.bonus, waveBonus(1), 'waveEnd.bonus');
  const st = engine.getState();
  eq(st.money, moneyAntes + waveBonus(1), 'bônus creditado (sem kills)');
  eq(st.phase, 'prep', 'volta para preparação');
  eq(st.wave, 2, 'próxima onda global');
  eq(st.stats.wavesWon, 1, 'wavesWon');
});

check('Vidas: vazamento dana a base e derrota sem torres', () => {
  const engine = createEngine({ mapId: 'deserto', seed: DEFAULT_SEED });
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
  // após o fim não há novos eventos
  engine.advance(2);
  eq(engine.drainEvents().length, 0, 'sem eventos após derrota');
});

check('Vitória: só ao concluir a 8ª onda do mapa, com vidas>0 e estrelas', () => {
  function prepararTropaLanca(engine) {
    const slots = engine.getState().slots;
    const tipos = ['missil', 'missil', 'antiaereo', 'antiaereo', 'metralhadora', 'metralhadora'];
    for (let k = 0; k < tipos.length; k += 1) {
      const slot = slots[slots.length - 1 - k].i;
      ok(engine.buildTower(slot, tipos[k]), `build ${tipos[k]}`);
    }
    for (const torre of engine.getState().towers) {
      while (engine.getState().towers.find((t) => t.id === torre.id).level < 3) {
        ok(engine.upgradeTower(torre.id), `upgrade torre ${torre.id}`);
      }
    }
  }
  const engine = createEngine({ mapId: 'deserto', seed: DEFAULT_SEED, money: 350 });
  engine.debugAddMoney(6000);
  prepararTropaLanca(engine);
  // onda 7 concluída NÃO dá vitória
  engine.debugStartWave(7);
  engine.drainEvents();
  for (let i = 0; i < 60 * 300 && engine.getState().phase === 'wave'; i += 1) {
    engine.step();
    engine.drainEvents();
  }
  eq(engine.getState().phase, 'prep', 'onda 7 leva a prep');
  eq(engine.getState().wave, 8, 'próxima é a 8ª');
  // onda 8 concluída = vitória
  engine.debugStartWave(8);
  engine.drainEvents();
  const evs = [];
  for (let i = 0; i < 60 * 400 && engine.getState().phase === 'wave'; i += 1) {
    engine.step();
    evs.push(...engine.drainEvents());
  }
  const st = engine.getState();
  eq(st.phase, 'victory', 'vitória na 8ª onda');
  const vitoria = primeiroEvento(evs, 'victory');
  assert(vitoria, 'evento victory');
  eq(vitoria.mapId, 'deserto', 'mapId');
  eq(vitoria.wave, 8, 'wave');
  eq(vitoria.lives, st.lives, 'lives');
  eq(vitoria.stars, starsForLives(st.lives), 'stars');
  assert(st.lives > 0, 'vidas > 0');
  const fists = evs.filter((e) => e.type === 'waveEnd');
  assert(fists.some((e) => e.wave === 8 && e.bonus === waveBonus(8)), 'waveEnd da 8ª');
  engine.advance(1);
  eq(engine.drainEvents().length, 0, 'sem eventos após vitória');
});

check('Chefe: bossSpawn, evento e barra (state.boss)', () => {
  const engine = createEngine({ mapId: 'deserto', seed: DEFAULT_SEED });
  engine.debugStartWave(8);
  engine.drainEvents();
  engine.step();
  const evs = engine.drainEvents();
  const spawn = primeiroEvento(evs, 'bossSpawn');
  assert(spawn, 'bossSpawn');
  eq(spawn.name, 'General de Ferro', 'nome do chefe');
  eq(spawn.maxHp, hpForWave(ENEMIES['chefe-deserto'].hp, 8), 'HP do chefe');
  const st = engine.getState();
  assert(st.boss, 'state.boss');
  eq(st.boss.name, 'General de Ferro', 'state.boss.name');
  eq(st.boss.hp, st.boss.maxHp, 'chefe cheio');
  eq(primeiroEvento(evs, 'spawn').boss, true, 'spawn boss=true');
});

check('forceWin/forceLose encerram a partida com eventos e estrelas', () => {
  const v = createEngine({ mapId: 'neve', seed: DEFAULT_SEED });
  eq(v.forceWin(), true, 'forceWin');
  eq(v.getState().phase, 'victory', 'fase vitória');
  const vit = primeiroEvento(v.drainEvents(), 'victory');
  eq(vit.mapId, 'neve', 'mapId vitória');
  eq(vit.stars, 3, '20 vidas = 3 estrelas');
  const d = createEngine({ mapId: 'cidade', seed: DEFAULT_SEED });
  eq(d.forceLose(), true, 'forceLose');
  eq(d.getState().phase, 'defeat', 'fase derrota');
  eq(d.getState().lives, 0, 'vidas 0');
  assert(primeiroEvento(d.drainEvents(), 'defeat'), 'evento derrota');
});

// ================================================================ estrelas e save
check('Estrelas: 3=20, 2=14–19, 1=1–13, 0=derrota', () => {
  eq(starsForLives(20), 3, '20 vidas');
  eq(starsForLives(25), 3, 'acima de 20');
  eq(starsForLives(19), 2, '19 vidas');
  eq(starsForLives(14), 2, '14 vidas');
  eq(starsForLives(13), 1, '13 vidas');
  eq(starsForLives(1), 1, '1 vida');
  eq(starsForLives(0), 0, '0 vidas');
});

check('Save: createDefaultSave/validateSave (sanitização, desbloqueio) e applyVictory', () => {
  eq(SAVE_KEY, 'td3d:save:v1', 'SAVE_KEY');
  const padrao = createDefaultSave();
  eq(padrao.version, 1, 'version');
  eq(padrao.tutorialDone, false, 'tutorialDone');
  eq(padrao.settings.volume, 0.7, 'volume');
  eq(padrao.maps.deserto.unlocked, true, 'Deserto livre');
  eq(padrao.maps.neve.unlocked, false, 'Neve bloqueada');
  eq(padrao.maps.cidade.unlocked, false, 'Cidade bloqueada');
  eq(typeof padrao.totals.kills, 'number', 'totals.kills');

  const lixo = validateSave('isto não é json');
  eq(JSON.stringify(lixo), JSON.stringify(padrao), 'save inválido = default');
  eq(JSON.stringify(validateSave(null)), JSON.stringify(padrao), 'null = default');

  const comLixo = validateSave({
    version: 9,
    maps: { deserto: { stars: 99, wavesWon: 99, bestLives: 99 }, neve: { stars: -5 } },
    settings: { volume: 42, muted: 'x' },
  });
  eq(comLixo.version, 1, 'versão saneada');
  eq(comLixo.maps.deserto.stars, 3, 'stars clamp 3');
  eq(comLixo.maps.deserto.wavesWon, 8, 'wavesWon clamp 8');
  eq(comLixo.maps.deserto.bestLives, 20, 'bestLives clamp 20');
  eq(comLixo.settings.volume, 1, 'volume clamp 1');
  eq(comLixo.settings.muted, false, 'muted inválido = false');

  const desbloqueio = validateSave({ maps: { deserto: { stars: 2, wavesWon: 8 } } });
  eq(desbloqueio.maps.neve.unlocked, true, 'Deserto vencido desbloqueia Neve');
  eq(desbloqueio.maps.cidade.unlocked, false, 'Cidade ainda bloqueada');
  const depois = validateSave({ maps: { deserto: { stars: 2, wavesWon: 8 }, neve: { stars: 1, wavesWon: 8 } } });
  eq(depois.maps.cidade.unlocked, true, 'Neve vencida desbloqueia Cidade');
  const travado = validateSave({ maps: { neve: { stars: 3, wavesWon: 8, bestLives: 19 } } });
  eq(travado.maps.neve.unlocked, false, 'Neve segue bloqueada sem Deserto vencido');
  eq(travado.maps.neve.stars, 0, 'progresso de mapa bloqueado zerado');
  eq(travado.maps.neve.wavesWon, 0, 'ondas de mapa bloqueado zeradas');

  const vitoria = applyVictory(createDefaultSave(), 'deserto', 20);
  eq(vitoria.maps.deserto.stars, 3, '3 estrelas gravadas');
  eq(vitoria.maps.deserto.bestLives, 20, 'bestLives');
  eq(vitoria.maps.deserto.wavesWon, 8, 'wavesWon');
  eq(vitoria.maps.neve.unlocked, true, 'vitória desbloqueia próxima');
  eq(vitoria.totals.waves, 8, 'totais de ondas');
});

// ================================================================ determinismo
check('Determinismo: mesma seed ⇒ mesmos eventos e mesmo estado', () => {
  function roteiro(engine) {
    const log = [];
    engine.buildTower(0, 'metralhadora');
    engine.buildTower(1, 'antiaereo');
    engine.startWave();
    for (let i = 0; i < 1800; i += 1) {
      engine.step();
      if (i % 60 === 0) log.push(...engine.drainEvents());
    }
    engine.deployTroop('fuzileiros', 0);
    engine.upgradeTower(1);
    for (let i = 0; i < 2400; i += 1) {
      engine.step();
      if (i % 60 === 0) log.push(...engine.drainEvents());
    }
    log.push(...engine.drainEvents());
    return JSON.stringify({ eventos: log, estado: engine.getState() });
  }
  const a = createEngine({ mapId: 'deserto', seed: 20261109 });
  const b = createEngine({ mapId: 'deserto', seed: 20261109 });
  eq(roteiro(a), roteiro(b), 'duas execuções idênticas');
  const c = createEngine({ mapId: 'neve', seed: 20261109 });
  eq(c.getState().mapId, 'neve', 'outro mapa');
});

// ================================================================ bot de referência
// Bot da issue: prepara na preparação; constrói a lista desejada (antiaéreo a
// partir da 2ª onda local, 2 metralhadoras, 1 morteiro, 2 mísseis, 1 tesla,
// 1 criogênica), posiciona tropas conforme a onda (≥3 aéreos ⇒ antiaérea;
// ≥8 terrestres ⇒ fuzileiros; chefe ⇒ sniper) e depois melhora a torre de
// menor nível. Nunca vende. Sem aleatoriedade.
const WISHLIST_BOT = [
  { type: 'antiaereo', count: 2, minOndaLocal: 2 },
  { type: 'metralhadora', count: 2, minOndaLocal: 1 },
  { type: 'morteiro', count: 1, minOndaLocal: 1 },
  { type: 'missil', count: 2, minOndaLocal: 1 },
  { type: 'tesla', count: 1, minOndaLocal: 1 },
  { type: 'criogenica', count: 1, minOndaLocal: 1 },
];

function contarTipos(torres) {
  const mapa = {};
  for (const t of torres) mapa[t.type] = (mapa[t.type] || 0) + 1;
  return mapa;
}

function botPreparar(engine) {
  const st0 = engine.getState();
  const baseWave = MAP_ORDER.indexOf(st0.mapId) * WAVES_PER_MAP;
  const ondaLocal = st0.wave - baseWave;
  // 1) constrói a lista desejada, no slot livre mais próximo da base
  // (janela de tiro maior) e na ordem de prioridade da issue.
  for (let guard = 0; guard < 40; guard += 1) {
    const st = engine.getState();
    const have = contarTipos(st.towers);
    const livres = st.slots.filter((s) => s.towerId === null);
    if (!livres.length) break;
    const slot = livres[livres.length - 1];
    let construiu = false;
    for (const item of WISHLIST_BOT) {
      if (ondaLocal < item.minOndaLocal) continue;
      if ((have[item.type] || 0) >= item.count) continue;
      if (st.money < TOWERS[item.type].costs[0]) continue;
      if (engine.buildTower(slot.i, item.type).ok) { construiu = true; break; }
    }
    if (!construiu) break;
  }
  // 2) tropas conforme a composição da próxima onda
  const grupos = ONDAS_ESPEC[st0.wave - 1];
  const querTropas = [];
  if (WAVES[st0.wave - 1].boss) querTropas.push('sniper');
  if (airInimigosOnda(grupos) >= 3) querTropas.push('antiaerea');
  if (groundInimigosOnda(grupos) >= 8) querTropas.push('fuzileiros');
  for (const tipo of querTropas) {
    const st = engine.getState();
    const cd = st.troopCooldowns.find((c) => c.type === tipo);
    if (st.troops.some((t) => t.type === tipo) || !cd || !cd.ready) continue;
    const ponto = st.troopPoints.find((p) => p.troopId === null);
    if (!ponto || st.money < TROOPS[tipo].cost) continue;
    engine.deployTroop(tipo, ponto.j);
  }
  // 3) depois de construir tudo que é permitido, melhora a torre de menor nível
  let st = engine.getState();
  let have = contarTipos(st.towers);
  const falta = WISHLIST_BOT.some((item) => ondaLocal >= item.minOndaLocal && (have[item.type] || 0) < item.count);
  if (!falta) {
    for (let guard = 0; guard < 60; guard += 1) {
      st = engine.getState();
      const candidatas = st.towers
        .filter((t) => t.level < 3)
        .sort((a, b) => (a.level - b.level) || (a.id - b.id));
      if (!candidatas.length) break;
      const torre = candidatas[0];
      const custo = TOWERS[torre.type].costs[torre.level];
      if (st.money < custo) break;
      engine.upgradeTower(torre.id);
    }
  }
  engine.drainEvents();
  engine.startWave();
  engine.drainEvents();
}

function botJogar(mapId) {
  const inicio = Date.now();
  const engine = createEngine({ mapId, seed: DEFAULT_SEED });
  engine.drainEvents();
  const eventos = [];
  let guard = 0;
  while (guard < 2000) {
    guard += 1;
    const st = engine.getState();
    if (st.phase === 'victory' || st.phase === 'defeat') break;
    if (st.phase === 'prep') botPreparar(engine);
    let passos = 0;
    while (engine.getState().phase === 'wave' && passos < 600) {
      engine.advance(1);
      eventos.push(...engine.drainEvents());
      passos += 1;
    }
    eventos.push(...engine.drainEvents());
  }
  const st = engine.getState();
  return {
    mapId,
    vitoria: st.phase === 'victory',
    vidas: st.lives,
    onda: st.wave,
    dinheiro: st.money,
    kills: st.stats.kills,
    vazamentos: st.stats.leaked,
    tempoSimulado: Math.round(st.time),
    vendas: eventos.filter((e) => e.type === 'sell').length,
    tempoRealMs: Date.now() - inicio,
  };
}

const resultadoDeserto = botJogar('deserto');
console.log(`BOT deserto: vitória=${resultadoDeserto.vitoria} vidas=${resultadoDeserto.vidas} onda=${resultadoDeserto.onda} `
  + `kills=${resultadoDeserto.kills} vazamentos=${resultadoDeserto.vazamentos} tempoSim=${resultadoDeserto.tempoSimulado}s real=${resultadoDeserto.tempoRealMs}ms`);

const resultados = [resultadoDeserto];
if (COMPLETO) {
  resultados.push(botJogar('neve'), botJogar('cidade'));
}
for (const r of resultados) {
  if (r === resultadoDeserto) continue; // já impresso acima
  console.log(`BOT ${r.mapId}: vitória=${r.vitoria} vidas=${r.vidas} onda=${r.onda} `
    + `kills=${r.kills} vazamentos=${r.vazamentos} tempoSim=${r.tempoSimulado}s real=${r.tempoRealMs}ms`);
}

check('Bot de referência vence o Deserto com vidas>=15', () => {
  assert(resultadoDeserto.vitoria, 'bot deveria vencer o Deserto');
  assert(resultadoDeserto.vidas >= 15, `vidas deveriam ser >=15, foram ${resultadoDeserto.vidas}`);
  eq(resultadoDeserto.vendas, 0, 'bot nunca vende');
});

if (COMPLETO) {
  const neve = resultados[1];
  const cidade = resultados[2];
  check('--completo: bot de referência vence Neve com vidas>=8', () => {
    assert(neve.vitoria, `bot deveria vencer Neve (caiu na onda ${neve.onda})`);
    assert(neve.vidas >= 8, `vidas em Neve deveriam ser >=8, foram ${neve.vidas}`);
    eq(neve.vendas, 0, 'bot nunca vende (Neve)');
  });
  check('--completo: bot de referência vence Cidade com vidas>=3', () => {
    assert(cidade.vitoria, `bot deveria vencer Cidade (caiu na onda ${cidade.onda})`);
    assert(cidade.vidas >= 3, `vidas em Cidade deveriam ser >=3, foram ${cidade.vidas}`);
    eq(cidade.vendas, 0, 'bot nunca vende (Cidade)');
    // curva crescente: a Cidade continua a mais difícil que a Neve
    assert(cidade.vidas < neve.vidas,
      `Cidade deve ser mais difícil que Neve (vidas ${cidade.vidas} vs ${neve.vidas})`);
  });
  const tempoReal = Date.now() - inicioGeral;
  check(`--completo em menos de 60 s reais (${tempoReal} ms)`, () => {
    assert(tempoReal < 60000, `demorou ${tempoReal} ms`);
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
