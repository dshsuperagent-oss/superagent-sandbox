// Motor de simulação — Torre de Ferro.
// Puro: sem DOM/Three/áudio/localStorage/Math.random. Passo fixo de 1/60 s.
// Emite uma fila de eventos por passo (render/HUD/áudio apenas consomem) e
// expõe um snapshot serializável em getState().
import {
  STEP, START_MONEY, START_MONEY_PER_MAP, START_LIVES, PREP_TIME, WAVES_PER_MAP, TOTAL_WAVES,
  waveBonus, hpForWave, starsForLives, ENEMIES, SPAWN_INTERVALS, TOWERS,
  TROOPS, TROOP_ORDER, MAP_ORDER, SLOW_CAP, towerStats, sellValue,
} from './data.js';
import { getMap, pathPointAt } from './maps.js';
import { WAVES } from './waves.js';
import { createRng, DEFAULT_SEED } from './rng.js';
import {
  distance, selectTowerTarget, enemiesInRadius, applySlow, chainNext,
} from './combat.js';
import { selectTroopTarget, assignBlocks } from './troops.js';

const round3 = (n) => Math.round(n * 1000) / 1000;
/** Tempo total de simulação (apenas p/ documentação; TOTAL_WAVES é exportado por data). */
export const TOTAL_WAVES_SIM = TOTAL_WAVES;

/**
 * Cria um motor de partida.
 * @param {{mapId?:string, seed?:number, money?:number, lives?:number}} opcoes
 */
export function createEngine(opcoes = {}) {
  const mapId = opcoes.mapId || 'deserto';
  const mapDef = getMap(mapId);
  if (!mapDef) throw new Error(`Mapa desconhecido: ${mapId}`);

  const seed = Number.isFinite(opcoes.seed) ? (opcoes.seed >>> 0) : DEFAULT_SEED;
  const rng = createRng(seed);
  const baseWave = MAP_ORDER.indexOf(mapId) * WAVES_PER_MAP;

  const caixaInicial = Number.isFinite(START_MONEY_PER_MAP[mapId])
    ? START_MONEY_PER_MAP[mapId]
    : START_MONEY;
  let money = Number.isFinite(opcoes.money) ? Math.max(0, Math.round(opcoes.money)) : caixaInicial;
  let lives = Number.isFinite(opcoes.lives) ? Math.max(0, Math.round(opcoes.lives)) : START_LIVES;
  let wave = baseWave + 1; // onda atual (durante onda) ou próxima (na preparação)
  let phase = 'prep';
  let prepLeft = PREP_TIME;
  let waveTime = 0;
  let time = 0;

  const enemies = [];
  const towers = [];
  const troops = [];
  const projectiles = [];
  const events = [];
  const spawnQueue = [];
  const slots = mapDef.slots.map((s) => ({ i: s.i, d: s.d, x: s.x, z: s.z, towerId: null }));
  const troopPoints = mapDef.troopPoints.map((p) => ({ j: p.j, d: p.d, x: p.x, z: p.z, troopId: null }));
  const troopCooldowns = TROOP_ORDER.map((type) => ({ type, ready: true, rechargeLeft: 0 }));
  const stats = { kills: 0, wavesWon: 0, leaked: 0, damageTaken: 0, shots: 0 };
  let bossEnemy = null;
  let enemySeq = 1;
  let towerSeq = 1;
  let troopSeq = 1;
  let projectileSeq = 1;

  // ------------------------------------------------------------------ util
  function emit(type, campos) {
    events.push({ type, ...campos });
  }

  function enemyById(id) {
    for (const e of enemies) if (e.id === id && !e.removed) return e;
    return null;
  }

  function troopById(id) {
    for (const t of troops) if (t.id === id && !t.removed) return t;
    return null;
  }

  function towerTerminal() {
    return phase === 'victory' || phase === 'defeat';
  }

  function clearCombat() {
    for (const e of enemies) e.removed = true;
    enemies.length = 0;
    for (const p of projectiles) p.removed = true;
    projectiles.length = 0;
    bossEnemy = null;
    spawnQueue.length = 0;
  }

  // ------------------------------------------------------------------ fim de partida
  function triggerDefeat() {
    if (towerTerminal()) return;
    lives = Math.max(0, lives);
    phase = 'defeat';
    clearCombat();
    emit('defeat', { mapId, wave, lives });
  }

  function triggerVictory() {
    if (towerTerminal()) return;
    lives = Math.max(1, lives);
    phase = 'victory';
    clearCombat();
    emit('victory', { mapId, wave, lives, stars: starsForLives(lives) });
  }

  // ------------------------------------------------------------------ inimigos
  function spawnEnemy(type) {
    const def = ENEMIES[type];
    if (!def) return null;
    const w = Math.max(1, wave);
    const hp = hpForWave(def.hp, w);
    const p = pathPointAt(mapDef, 0);
    const enemy = {
      id: enemySeq++,
      type,
      name: def.name,
      cls: def.cls,
      boss: Boolean(def.boss),
      x: p.x,
      z: p.z,
      y: def.altitude,
      hp,
      maxHp: hp,
      progress: 0,
      speed: def.speed,
      slow: 0,
      slowLeft: 0,
      blocked: false,
      targetTroopId: null,
      troopDps: def.troopDps || 0,
      radius: def.radius || 0,
      removed: false,
    };
    enemies.push(enemy);
    const variant = Math.floor(rng.next() * 3); // visual determinístico
    emit('spawn', {
      enemyId: enemy.id, enemyType: type, cls: def.cls,
      x: round3(enemy.x), z: round3(enemy.z), y: def.altitude,
      hp, maxHp: hp, wave: w, boss: Boolean(def.boss), variant,
    });
    if (def.boss) {
      bossEnemy = enemy;
      emit('bossSpawn', {
        enemyId: enemy.id, enemyType: type, name: def.name, hp, maxHp: hp,
      });
    }
    return enemy;
  }

  function removeEnemy(enemy) {
    if (enemy.removed) return;
    const idx = enemies.indexOf(enemy);
    if (idx >= 0) enemies.splice(idx, 1);
    enemy.removed = true;
    const def = ENEMIES[enemy.type];
    if (bossEnemy === enemy) bossEnemy = null;
    money += def.reward;
    stats.kills += 1;
    emit('kill', {
      enemyId: enemy.id, enemyType: enemy.type, x: round3(enemy.x),
      z: round3(enemy.z), reward: def.reward, boss: Boolean(def.boss),
    });
  }

  function leakEnemy(enemy) {
    if (enemy.removed) return;
    const idx = enemies.indexOf(enemy);
    if (idx >= 0) enemies.splice(idx, 1);
    enemy.removed = true;
    const def = ENEMIES[enemy.type];
    const dano = def.damage;
    if (bossEnemy === enemy) bossEnemy = null;
    lives = Math.max(0, lives - dano);
    stats.leaked += 1;
    stats.damageTaken += dano;
    emit('leak', {
      enemyId: enemy.id, enemyType: enemy.type, x: round3(enemy.x),
      z: round3(enemy.z), damage: dano, lives, boss: Boolean(def.boss),
    });
    if (lives <= 0) triggerDefeat();
  }

  /** Aplica dano; retorna true se o inimigo morreu (e já foi removido/recompensado). */
  function damageEnemy(enemy, amount) {
    if (!enemy || enemy.removed || enemy.hp <= 0) return false;
    enemy.hp -= amount;
    if (enemy.hp <= 0) {
      removeEnemy(enemy);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ tropas
  function killTroop(troop, reason) {
    if (!troop || troop.removed) return;
    const idx = troops.indexOf(troop);
    if (idx >= 0) troops.splice(idx, 1);
    troop.removed = true;
    const ponto = troopPoints[troop.point];
    if (ponto && ponto.troopId === troop.id) ponto.troopId = null;
    emit('troopDeath', {
      troopId: troop.id, troopType: troop.type, reason,
      x: round3(troop.x), z: round3(troop.z),
    });
  }

  function updateTroops(dt) {
    for (const troop of troops.slice()) {
      if (troop.removed) continue;
      troop.lifeLeft -= dt;
      if (troop.lifeLeft <= 0) {
        killTroop(troop, 'expired');
        continue;
      }
      troop.cooldown -= dt;
      if (troop.cooldown <= 0) {
        const alvo = selectTroopTarget(troop, enemies);
        if (alvo) {
          emit('troopShot', {
            troopId: troop.id, troopType: troop.type, targetId: alvo.id,
            fromX: round3(troop.x), fromZ: round3(troop.z),
            toX: round3(alvo.x), toZ: round3(alvo.z),
            damage: troop.damage,
          });
          stats.shots += 1;
          damageEnemy(alvo, troop.damage);
          troop.cooldown = troop.interval;
        } else {
          troop.cooldown = 0;
        }
      }
    }
    for (const cd of troopCooldowns) {
      if (cd.ready) continue;
      cd.rechargeLeft -= dt;
      if (cd.rechargeLeft <= 0) {
        cd.ready = true;
        cd.rechargeLeft = 0;
      }
    }
  }

  // ------------------------------------------------------------------ torres
  function updateTowers(dt) {
    for (const tower of towers) {
      if (tower.removed) continue;
      tower.cooldown -= dt;
      if (tower.cooldown > 0) continue;
      const alvo = selectTowerTarget(tower, enemies);
      if (!alvo) {
        tower.cooldown = 0;
        tower.targetId = null;
        continue;
      }
      tower.targetId = alvo.id;
      tower.cooldown = tower.rate;
      fireTower(tower, alvo);
    }
  }

  function fireTower(tower, alvo) {
    const def = TOWERS[tower.type];
    const nivel = tower.level;
    const indice = nivel - 1;
    stats.shots += 1;
    const evento = {
      towerId: tower.id, towerType: tower.type, level: nivel,
      targetId: alvo.id, fromX: round3(tower.x), fromZ: round3(tower.z),
      toX: round3(alvo.x), toZ: round3(alvo.z),
    };

    if (tower.effect === 'instant') {
      emit('shot', { ...evento, kind: 'instant' });
      damageEnemy(alvo, tower.damage);
      return;
    }

    if (tower.effect === 'splash') {
      const ix = alvo.x;
      const iz = alvo.z;
      const raio = tower.splash;
      emit('shot', { ...evento, kind: 'splash' });
      emit('explosion', {
        x: round3(ix), z: round3(iz), radius: raio, size: 'small', kind: 'morteiro',
      });
      for (const e of enemiesInRadius(enemies, ix, iz, raio)) damageEnemy(e, tower.damage);
      return;
    }

    if (tower.effect === 'chain') {
      const visited = new Set([alvo.id]);
      const cadeia = [];
      let origem = alvo;
      let dano = tower.damage;
      damageEnemy(alvo, dano);
      for (let i = 0; i < tower.chain; i += 1) {
        const proximo = chainNext(enemies, origem.x, origem.z, def.chainJump, visited);
        if (!proximo) break;
        dano *= def.chainFalloff;
        visited.add(proximo.id);
        cadeia.push({ enemyId: proximo.id, x: round3(proximo.x), z: round3(proximo.z) });
        damageEnemy(proximo, dano);
        origem = proximo;
      }
      emit('shot', { ...evento, kind: 'chain', chain: cadeia });
      return;
    }

    if (tower.effect === 'slow') {
      emit('shot', { ...evento, kind: 'slow' });
      const inimigoDef = ENEMIES[alvo.type];
      const resist = inimigoDef ? (inimigoDef.slowResist || 0) : 0;
      const quantidade = def.slow[indice] * (1 - resist);
      const duracao = def.slowTime[indice];
      damageEnemy(alvo, tower.damage);
      if (!alvo.removed) {
        const aplicado = applySlow(alvo, quantidade, duracao, SLOW_CAP);
        if (aplicado > 0) {
          emit('slow', { enemyId: alvo.id, amount: round3(aplicado), duration: duracao });
        }
      }
      return;
    }

    if (tower.effect === 'missile') {
      const p = {
        id: projectileSeq++,
        type: 'missil',
        x: tower.x,
        z: tower.z,
        targetId: alvo.id,
        lastX: alvo.x,
        lastZ: alvo.z,
        damage: tower.damage,
        splash: def.missileSplash,
        speed: def.missileSpeed,
        removed: false,
      };
      projectiles.push(p);
      emit('shot', { ...evento, kind: 'missile', missileId: p.id });
    }
  }

  // ------------------------------------------------------------------ inimigos: bloqueio, movimento, ataques
  function updateEnemies(dt) {
    const atribuicoes = assignBlocks(enemies, troops);
    const bloqueadoPor = new Map();
    for (const a of atribuicoes) bloqueadoPor.set(a.enemyId, a.troopId);
    for (const e of enemies) {
      e.blocked = bloqueadoPor.has(e.id);
      e.targetTroopId = e.blocked ? bloqueadoPor.get(e.id) : null;
    }

    for (const e of enemies.slice()) {
      if (e.removed) continue;

      if (e.blocked) {
        // Inimigo parado atacando o bloqueador: 1 golpe/s ⇒ dano contínuo
        // equivalente a troopDps por segundo.
        const tropa = troopById(e.targetTroopId);
        if (!tropa || tropa.removed) {
          e.blocked = false;
          e.targetTroopId = null;
        } else {
          tropa.hp -= e.troopDps * dt;
          if (tropa.hp <= 0) {
            killTroop(tropa, 'killed');
            e.blocked = false;
            e.targetTroopId = null;
          }
        }
      }

      if (!e.blocked) {
        // Chefes não param: atacam tropas no raio 2,5 u enquanto avançam.
        if (e.boss) {
          for (const t of troops.slice()) {
            if (t.removed) continue;
            if (distance(e.x, e.z, t.x, t.z) <= 2.5 + 1e-9) {
              t.hp -= e.troopDps * dt;
              if (t.hp <= 0) killTroop(t, 'killed');
            }
          }
        }
        e.progress += e.speed * (1 - e.slow) * dt;
        if (e.progress >= mapDef.length) {
          leakEnemy(e);
          if (phase === 'defeat') return;
          continue;
        }
        const p = pathPointAt(mapDef, e.progress);
        e.x = p.x;
        e.z = p.z;
      }

      if (e.slowLeft > 0) {
        e.slowLeft = Math.max(0, e.slowLeft - dt);
        if (e.slowLeft <= 0) e.slow = 0;
      }
    }
  }

  // ------------------------------------------------------------------ projéteis (míssil teleguiado)
  function removeProjectile(p) {
    const idx = projectiles.indexOf(p);
    if (idx >= 0) projectiles.splice(idx, 1);
    p.removed = true;
  }

  function detonateMissile(p, x, z) {
    if (p.removed) return;
    removeProjectile(p);
    emit('missileHit', { missileId: p.id, x: round3(x), z: round3(z), radius: p.splash });
    emit('explosion', {
      x: round3(x), z: round3(z), radius: p.splash, size: 'small', kind: 'missil',
    });
    for (const e of enemiesInRadius(enemies, x, z, p.splash)) damageEnemy(e, p.damage);
  }

  function updateProjectiles(dt) {
    for (const p of projectiles.slice()) {
      if (p.removed) continue;
      const alvo = enemyById(p.targetId);
      let aimX = p.lastX;
      let aimZ = p.lastZ;
      if (alvo) {
        // Segue o alvo vivo; guarda a última posição conhecida caso ele morra.
        aimX = alvo.x;
        aimZ = alvo.z;
        p.lastX = alvo.x;
        p.lastZ = alvo.z;
      }
      const dx = aimX - p.x;
      const dz = aimZ - p.z;
      const d = Math.hypot(dx, dz);
      const passo = p.speed * dt;
      if (d <= passo + 1e-9) {
        detonateMissile(p, aimX, aimZ);
        continue;
      }
      p.x += (dx / d) * passo;
      p.z += (dz / d) * passo;
    }
  }

  // ------------------------------------------------------------------ ondas
  function beginWave(n) {
    wave = n;
    phase = 'wave';
    waveTime = 0;
    prepLeft = 0;
    spawnQueue.length = 0;
    const def = WAVES[n - 1];
    if (!def) {
      phase = 'prep';
      prepLeft = PREP_TIME;
      return false;
    }
    let ordem = 0;
    for (const grupo of def.groups) {
      const intervalo = Number(SPAWN_INTERVALS[grupo.type]) || 0;
      for (let k = 0; k < grupo.count; k += 1) {
        spawnQueue.push({ type: grupo.type, at: grupo.delay + k * intervalo, order: ordem++ });
      }
    }
    spawnQueue.sort((a, b) => (a.at - b.at) || (a.order - b.order));
    emit('waveStart', { wave: n, mapId, total: spawnQueue.length });
    return true;
  }

  function completeWave() {
    const bonus = waveBonus(wave);
    money += bonus;
    stats.wavesWon += 1;
    emit('waveEnd', { wave, bonus });
    const local = wave - baseWave;
    if (local >= WAVES_PER_MAP) {
      if (lives > 0) triggerVictory();
      else triggerDefeat();
      return;
    }
    wave += 1;
    phase = 'prep';
    prepLeft = PREP_TIME;
  }

  // ------------------------------------------------------------------ passo
  function step() {
    if (towerTerminal()) {
      time += STEP;
      return;
    }
    time += STEP;

    if (phase === 'prep') {
      prepLeft -= STEP;
      if (prepLeft <= 1e-9) {
        prepLeft = 0;
        startWave();
      }
    }

    if (phase === 'wave') {
      waveTime += STEP;
      while (spawnQueue.length > 0 && spawnQueue[0].at <= waveTime + 1e-9) {
        const item = spawnQueue.shift();
        spawnEnemy(item.type);
      }
    }

    updateTroops(STEP);
    updateTowers(STEP);
    updateEnemies(STEP);
    if (phase === 'defeat') return;
    updateProjectiles(STEP);
    checkWaveEnd();
  }

  function checkWaveEnd() {
    if (phase !== 'wave') return;
    if (spawnQueue.length > 0 || enemies.length > 0) return;
    completeWave();
  }

  // ------------------------------------------------------------------ API
  function advance(segundos) {
    const passos = Math.max(0, Math.round((Number(segundos) || 0) / STEP));
    for (let i = 0; i < passos; i += 1) step();
    return passos;
  }

  function drainEvents() {
    const fila = events.slice();
    events.length = 0;
    return fila;
  }

  function startWave() {
    if (phase !== 'prep') return false;
    if (wave - baseWave < 1 || wave - baseWave > WAVES_PER_MAP) return false;
    return beginWave(wave);
  }

  function buildTower(slotIndex, type) {
    if (towerTerminal()) return { ok: false, error: 'fase-invalida' };
    const def = TOWERS[type];
    if (!def) return { ok: false, error: 'tipo-invalido' };
    const indice = Number(slotIndex);
    if (!Number.isInteger(indice) || indice < 0 || indice >= slots.length) {
      return { ok: false, error: 'slot-invalido' };
    }
    const slot = slots[indice];
    if (slot.towerId !== null) return { ok: false, error: 'slot-ocupado' };
    const custo = def.costs[0];
    if (money < custo) return { ok: false, error: 'sem-dinheiro' };
    money -= custo;
    const st = towerStats(type, 1);
    const tower = {
      id: towerSeq++,
      type,
      name: def.name,
      slot: indice,
      x: slot.x,
      z: slot.z,
      level: 1,
      damage: st.damage,
      rate: st.rate,
      range: st.range,
      effect: def.effect,
      target: def.target,
      splash: st.splash,
      chain: st.chain,
      slow: st.slow,
      slowTime: st.slowTime,
      cooldown: 0,
      targetId: null,
      invested: custo,
      sellValue: sellValue(type, 1),
      removed: false,
    };
    towers.push(tower);
    slot.towerId = tower.id;
    emit('build', { towerId: tower.id, slot: indice, towerType: type, cost: custo, level: 1 });
    return { ok: true, id: tower.id };
  }

  function upgradeTower(towerId) {
    if (towerTerminal()) return { ok: false, error: 'fase-invalida' };
    const id = Number(towerId);
    const tower = towers.find((t) => t.id === id && !t.removed);
    if (!tower) return { ok: false, error: 'torre-invalida' };
    if (tower.level >= 3) return { ok: false, error: 'nivel-maximo' };
    const def = TOWERS[tower.type];
    const custo = def.costs[tower.level];
    if (money < custo) return { ok: false, error: 'sem-dinheiro' };
    money -= custo;
    tower.level += 1;
    const st = towerStats(tower.type, tower.level);
    tower.damage = st.damage;
    tower.rate = st.rate;
    tower.range = st.range;
    tower.splash = st.splash;
    tower.chain = st.chain;
    tower.slow = st.slow;
    tower.slowTime = st.slowTime;
    tower.invested += custo;
    tower.sellValue = sellValue(tower.type, tower.level);
    emit('upgrade', { towerId: tower.id, towerType: tower.type, level: tower.level, cost: custo });
    return { ok: true };
  }

  function sellTower(towerId) {
    if (towerTerminal()) return { ok: false, error: 'fase-invalida' };
    const id = Number(towerId);
    const idx = towers.findIndex((t) => t.id === id && !t.removed);
    if (idx < 0) return { ok: false, error: 'torre-invalida' };
    const tower = towers[idx];
    const reembolso = tower.sellValue;
    money += reembolso;
    slots[tower.slot].towerId = null;
    towers.splice(idx, 1);
    tower.removed = true;
    emit('sell', {
      towerId: tower.id, towerType: tower.type, slot: tower.slot, refund: reembolso,
    });
    return { ok: true, refund: reembolso };
  }

  function deployTroop(type, pointIndex) {
    if (towerTerminal()) return { ok: false, error: 'fase-invalida' };
    const def = TROOPS[type];
    if (!def) return { ok: false, error: 'tipo-invalido' };
    const j = Number(pointIndex);
    if (!Number.isInteger(j) || j < 0 || j >= troopPoints.length) {
      return { ok: false, error: 'ponto-invalido' };
    }
    const ponto = troopPoints[j];
    if (ponto.troopId !== null) return { ok: false, error: 'ponto-ocupado' };
    if (troops.some((t) => t.type === type && !t.removed)) {
      return { ok: false, error: 'tropa-viva' };
    }
    const cd = troopCooldowns.find((c) => c.type === type);
    if (!cd || !cd.ready) return { ok: false, error: 'recarga' };
    if (money < def.cost) return { ok: false, error: 'sem-dinheiro' };
    money -= def.cost;
    const troop = {
      id: troopSeq++,
      type,
      name: def.name,
      point: j,
      x: ponto.x,
      z: ponto.z,
      hp: def.hp,
      maxHp: def.hp,
      lifeLeft: def.lifetime,
      range: def.range,
      damage: def.damage,
      interval: def.interval,
      target: def.target,
      priority: def.priority,
      block: def.block,
      blockRadius: def.blockRadius,
      cooldown: 0,
      removed: false,
    };
    troops.push(troop);
    ponto.troopId = troop.id;
    cd.ready = false;
    cd.rechargeLeft = def.recharge;
    emit('troopDeploy', {
      troopId: troop.id, troopType: type, point: j, cost: def.cost,
    });
    return { ok: true, id: troop.id };
  }

  // ---------------------------------------------------------------- debug (QA)
  function debugStartWave(n) {
    const num = Math.round(Number(n));
    if (!Number.isFinite(num)) return false;
    const local = num - baseWave;
    if (local < 1 || local > WAVES_PER_MAP) return false;
    for (const e of enemies) e.removed = true;
    enemies.length = 0;
    for (const p of projectiles) p.removed = true;
    projectiles.length = 0;
    bossEnemy = null;
    return beginWave(num);
  }

  function debugSpawnEnemy(type, count = 1) {
    if (!ENEMIES[type]) return 0;
    const n = Math.max(1, Math.min(80, Math.round(Number(count) || 1)));
    let criados = 0;
    for (let i = 0; i < n; i += 1) {
      if (spawnEnemy(type)) criados += 1;
    }
    return criados;
  }

  function debugAddMoney(valor) {
    const delta = Math.round(Number(valor) || 0);
    money = Math.max(0, money + delta);
    return money;
  }

  function debugSetLives(valor) {
    const n = Math.round(Number(valor));
    if (!Number.isFinite(n)) return lives;
    lives = Math.max(0, n);
    if (lives <= 0 && !towerTerminal()) triggerDefeat();
    return lives;
  }

  function forceWin() {
    if (towerTerminal()) return false;
    triggerVictory();
    return true;
  }

  function forceLose() {
    if (towerTerminal()) return false;
    lives = 0;
    triggerDefeat();
    return true;
  }

  function getMapDef() {
    return {
      id: mapDef.id,
      name: mapDef.name,
      fog: mapDef.fog,
      length: mapDef.length,
      waypoints: mapDef.waypoints.map((p) => [p[0], p[1]]),
      slots: mapDef.slots.map((s) => ({ i: s.i, x: s.x, z: s.z })),
      troopPoints: mapDef.troopPoints.map((p) => ({ j: p.j, x: p.x, z: p.z })),
    };
  }

  function getState() {
    const towersSnap = towers
      .filter((t) => !t.removed)
      .map((t) => ({
        id: t.id, type: t.type, name: t.name, slot: t.slot,
        x: round3(t.x), z: round3(t.z), level: t.level,
        damage: t.damage, rate: t.rate, range: t.range,
        effect: t.effect, target: t.target,
        cooldown: round3(Math.max(0, t.cooldown)), targetId: t.targetId,
        invested: t.invested, sellValue: t.sellValue,
      }));

    const enemiesSnap = enemies
      .filter((e) => !e.removed)
      .map((e) => ({
        id: e.id, type: e.type, name: e.name, cls: e.cls, boss: e.boss,
        x: round3(e.x), z: round3(e.z), y: e.y,
        hp: e.hp, maxHp: e.maxHp, progress: round3(e.progress),
        speed: e.speed, slow: round3(e.slow), blocked: e.blocked,
        targetTroopId: e.targetTroopId,
      }));

    const troopsSnap = troops
      .filter((t) => !t.removed)
      .map((t) => ({
        id: t.id, type: t.type, name: t.name, point: t.point,
        x: round3(t.x), z: round3(t.z), hp: round3(t.hp),
        maxHp: t.maxHp, lifeLeft: round3(t.lifeLeft),
      }));

    return {
      mapId,
      mapName: mapDef.name,
      map: {
        id: mapDef.id,
        name: mapDef.name,
        length: mapDef.length,
        waypoints: mapDef.waypoints.map((p) => [p[0], p[1]]),
      },
      wave,
      waveLocal: Math.max(1, Math.min(WAVES_PER_MAP, wave - baseWave)),
      wavesPerMap: WAVES_PER_MAP,
      phase,
      prepLeft: round3(Math.max(0, prepLeft)),
      waveTime: round3(waveTime),
      time: round3(time),
      speed: 1,
      paused: false,
      money,
      lives,
      enemies: enemiesSnap,
      towers: towersSnap,
      troops: troopsSnap,
      projectiles: projectiles
        .filter((p) => !p.removed)
        .map((p) => ({ id: p.id, type: 'missil', x: round3(p.x), z: round3(p.z), targetId: p.targetId })),
      troopCooldowns: troopCooldowns.map((c) => ({
        type: c.type, ready: c.ready, rechargeLeft: round3(Math.max(0, c.rechargeLeft)),
      })),
      slots: slots.map((s) => ({ i: s.i, x: s.x, z: s.z, towerId: s.towerId })),
      troopPoints: troopPoints.map((p) => ({ j: p.j, x: p.x, z: p.z, troopId: p.troopId })),
      stats: { ...stats },
      boss: bossEnemy && !bossEnemy.removed
        ? {
          id: bossEnemy.id, type: bossEnemy.type, name: bossEnemy.name,
          hp: bossEnemy.hp, maxHp: bossEnemy.maxHp,
        }
        : null,
    };
  }

  return {
    step,
    advance,
    drainEvents,
    getState,
    startWave,
    buildTower,
    upgradeTower,
    sellTower,
    deployTroop,
    debugStartWave,
    debugSpawnEnemy,
    debugAddMoney,
    debugSetLives,
    forceWin,
    forceLose,
    getMapDef,
    get wave() { return wave; },
    get phase() { return phase; },
    get mapId() { return mapId; },
    get money() { return money; },
    get lives() { return lives; },
  };
}
