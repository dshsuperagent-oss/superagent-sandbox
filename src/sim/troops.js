// Tropas especiais — seleção de alvo e bloqueio de terrestres (puro).
import { isCompatible } from './data.js';
import { distance } from './combat.js';

/**
 * Alvo de tropa: compatível e dentro do alcance. Sniper prioriza maior HP
 * atual; as demais priorizam maior progresso. Empates pelo menor id.
 */
export function selectTroopTarget(troop, enemies) {
  let best = null;
  for (const e of enemies) {
    if (e.hp <= 0) continue;
    if (!isCompatible(troop.target, e.cls)) continue;
    if (distance(troop.x, troop.z, e.x, e.z) > troop.range + 1e-9) continue;
    let better = !best;
    if (best) {
      if (troop.priority === 'hp') {
        better = e.hp > best.hp + 1e-9
          || (Math.abs(e.hp - best.hp) <= 1e-9 && e.id < best.id);
      } else {
        better = e.progress > best.progress + 1e-9
          || (Math.abs(e.progress - best.progress) <= 1e-9 && e.id < best.id);
      }
    }
    if (better) best = e;
  }
  return best;
}

/**
 * Distribui bloqueios entre as tropas bloqueadoras (fuzileiros).
 * Só terrestres e não-chefes podem ser bloqueados; cada tropa bloqueia até
 * `block` inimigos. A colisão usa o raio da tropa (blockRadius) somado ao
 * raio do inimigo — os pontos de tropa ficam a 2,5 u do caminho, então usar
 * apenas 2,0 u de centro a centro nunca dispararia o bloqueio.
 * Determinístico: inimigos em ordem de id; empate por menor id de tropa.
 * Retorna [{enemyId, troopId}, ...].
 */
export function assignBlocks(enemies, troops) {
  const blockers = troops
    .filter((t) => t.hp > 0 && t.block > 0 && t.blockRadius > 0)
    .sort((a, b) => a.id - b.id);
  if (!blockers.length) return [];

  const counts = new Map();
  const out = [];
  const candidates = enemies
    .filter((e) => e.hp > 0 && e.cls === 'ground' && !e.boss)
    .sort((a, b) => a.id - b.id);

  for (const e of candidates) {
    let chosen = null;
    let chosenD = Infinity;
    for (const t of blockers) {
      if ((counts.get(t.id) || 0) >= t.block) continue;
      const d = distance(t.x, t.z, e.x, e.z);
      const reach = t.blockRadius + (e.radius || 0);
      if (d > reach + 1e-9) continue;
      if (d < chosenD - 1e-9 || (Math.abs(d - chosenD) <= 1e-9 && chosen && t.id < chosen.id)) {
        chosen = t;
        chosenD = d;
      }
    }
    if (chosen) {
      out.push({ enemyId: e.id, troopId: chosen.id });
      counts.set(chosen.id, (counts.get(chosen.id) || 0) + 1);
    }
  }
  return out;
}
