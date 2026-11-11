// Combate puro (sem DOM/Three/áudio): alvos, alcance, splash, cadeia tesla,
// lentidão criogênica e consultas de área. Usado pelo engine.
import { isCompatible } from './data.js';

/** Distância horizontal (plano x/z). Altura não conta para alcance. */
export function distance(ax, az, bx, bz) {
  return Math.hypot(bx - ax, bz - az);
}

/** Velocidade efetiva de um inimigo considerando a lentidão atual (0..cap). */
export function effectiveSpeed(enemy) {
  return enemy.speed * (1 - enemy.slow);
}

/**
 * Alvo de torre: inimigo compatível (ar/terra) dentro do alcance com maior
 * progresso no caminho; empate pelo menor id.
 */
export function selectTowerTarget(tower, enemies) {
  let best = null;
  for (const e of enemies) {
    if (e.hp <= 0) continue;
    if (!isCompatible(tower.target, e.cls)) continue;
    if (distance(tower.x, tower.z, e.x, e.z) > tower.range + 1e-9) continue;
    const better = !best
      || e.progress > best.progress + 1e-9
      || (Math.abs(e.progress - best.progress) <= 1e-9 && e.id < best.id);
    if (better) best = e;
  }
  return best;
}

/** Inimigos vivos dentro de um raio horizontal (exclui opcionalmente um id). */
export function enemiesInRadius(enemies, x, z, radius, excludeId = -1) {
  const out = [];
  for (const e of enemies) {
    if (e.hp <= 0 || e.id === excludeId) continue;
    if (distance(x, z, e.x, e.z) <= radius + 1e-9) out.push(e);
  }
  return out;
}

/**
 * Aplica (ou renova) lentidão sem empilhar: vale a maior fração e a maior
 * duração. `amount` já deve vir com a resistência do chefe aplicada.
 * Retorna a fração efetivamente aplicada.
 */
export function applySlow(enemy, amount, duration, cap) {
  const capped = Math.min(cap, Math.max(0, amount));
  if (capped <= 0 || duration <= 0) return 0;
  enemy.slow = Math.max(enemy.slow, capped);
  enemy.slowLeft = Math.max(enemy.slowLeft, duration);
  return capped;
}

/**
 * Próximo elo da cadeia tesla: inimigo vivo mais próximo do elo atual dentro
 * de `jumpRadius`, ainda não atingido nesta descarga.
 */
export function chainNext(enemies, fromX, fromZ, jumpRadius, visited) {
  let best = null;
  let bestD = Infinity;
  for (const e of enemies) {
    if (e.hp <= 0 || visited.has(e.id)) continue;
    const d = distance(fromX, fromZ, e.x, e.z);
    if (d > jumpRadius + 1e-9) continue;
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && (!best || e.id < best.id))) {
      best = e;
      bestD = d;
    }
  }
  return best;
}
