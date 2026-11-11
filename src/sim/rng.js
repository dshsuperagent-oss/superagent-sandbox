// RNG determinístico da simulação — mulberry32.
// Proibido Math.random() em src/sim/. A seed padrão é 20261109 (ver issue #18).

export const DEFAULT_SEED = 20261109;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed = DEFAULT_SEED) {
  const next = mulberry32(seed >>> 0);
  return {
    seed: seed >>> 0,
    next,
    range(min, max) {
      return min + (max - min) * next();
    },
    pick(list) {
      return list[Math.floor(next() * list.length) % list.length];
    },
  };
}
