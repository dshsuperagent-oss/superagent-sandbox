// As 24 ondas — composição exata da especificação (issue #18).
// Grupo = { type, count, delay } onde o 1º inimigo nasce em `delay` s depois do
// início da onda e os demais a cada SPAWN_INTERVALS[type].

const W = (wave, mapId, groups, boss = false) => ({ wave, mapId, groups, boss });

export const WAVES = [
  // Deserto (1–8)
  W(1, 'deserto', [
    { type: 'soldado', count: 10, delay: 0 },
  ]),
  W(2, 'deserto', [
    { type: 'soldado', count: 10, delay: 0 },
    { type: 'drone', count: 4, delay: 4 },
  ]),
  W(3, 'deserto', [
    { type: 'soldado', count: 8, delay: 0 },
    { type: 'blindado', count: 3, delay: 2 },
    { type: 'drone', count: 6, delay: 6 },
  ]),
  W(4, 'deserto', [
    { type: 'drone', count: 8, delay: 0 },
    { type: 'soldado', count: 6, delay: 2 },
    { type: 'blindado', count: 4, delay: 4 },
  ]),
  W(5, 'deserto', [
    { type: 'soldado', count: 10, delay: 0 },
    { type: 'tanque', count: 2, delay: 0 },
    { type: 'helicoptero', count: 2, delay: 8 },
  ]),
  W(6, 'deserto', [
    { type: 'drone', count: 10, delay: 0 },
    { type: 'blindado', count: 6, delay: 2 },
    { type: 'helicoptero', count: 4, delay: 6 },
  ]),
  W(7, 'deserto', [
    { type: 'soldado', count: 10, delay: 0 },
    { type: 'tanque', count: 3, delay: 2 },
    { type: 'helicoptero', count: 3, delay: 6 },
    { type: 'bombardeiro', count: 1, delay: 12 },
  ]),
  W(8, 'deserto', [
    { type: 'chefe-deserto', count: 1, delay: 0 },
    { type: 'tanque', count: 2, delay: 2 },
    { type: 'drone', count: 8, delay: 4 },
    { type: 'helicoptero', count: 2, delay: 10 },
  ], true),

  // Neve (9–16)
  W(9, 'neve', [
    { type: 'soldado', count: 12, delay: 0 },
    { type: 'drone', count: 8, delay: 3 },
  ]),
  W(10, 'neve', [
    { type: 'blindado', count: 6, delay: 0 },
    { type: 'helicoptero', count: 3, delay: 4 },
  ]),
  W(11, 'neve', [
    { type: 'drone', count: 12, delay: 0 },
    { type: 'tanque', count: 2, delay: 4 },
  ]),
  W(12, 'neve', [
    { type: 'soldado', count: 12, delay: 0 },
    { type: 'helicoptero', count: 5, delay: 3 },
  ]),
  W(13, 'neve', [
    { type: 'bombardeiro', count: 2, delay: 0 },
    { type: 'blindado', count: 8, delay: 2 },
  ]),
  W(14, 'neve', [
    { type: 'zepelim', count: 1, delay: 0 },
    { type: 'drone', count: 12, delay: 2 },
    { type: 'helicoptero', count: 3, delay: 8 },
  ]),
  W(15, 'neve', [
    { type: 'tanque', count: 4, delay: 0 },
    { type: 'bombardeiro', count: 2, delay: 4 },
    { type: 'helicoptero', count: 4, delay: 8 },
  ]),
  W(16, 'neve', [
    { type: 'chefe-neve', count: 1, delay: 0 },
    { type: 'zepelim', count: 2, delay: 3 },
    { type: 'drone', count: 10, delay: 6 },
    { type: 'helicoptero', count: 4, delay: 8 },
  ], true),

  // Cidade (17–24)
  W(17, 'cidade', [
    { type: 'soldado', count: 14, delay: 0 },
    { type: 'drone', count: 10, delay: 3 },
    { type: 'blindado', count: 4, delay: 6 },
  ]),
  W(18, 'cidade', [
    { type: 'helicoptero', count: 6, delay: 0 },
    { type: 'tanque', count: 3, delay: 4 },
  ]),
  W(19, 'cidade', [
    { type: 'bombardeiro', count: 3, delay: 0 },
    { type: 'drone', count: 14, delay: 3 },
  ]),
  W(20, 'cidade', [
    { type: 'zepelim', count: 2, delay: 0 },
    { type: 'blindado', count: 10, delay: 2 },
    { type: 'helicoptero', count: 4, delay: 8 },
  ]),
  W(21, 'cidade', [
    { type: 'tanque', count: 5, delay: 0 },
    { type: 'bombardeiro', count: 4, delay: 4 },
  ]),
  W(22, 'cidade', [
    { type: 'zepelim', count: 3, delay: 0 },
    { type: 'drone', count: 16, delay: 2 },
    { type: 'helicoptero', count: 5, delay: 8 },
  ]),
  W(23, 'cidade', [
    { type: 'tanque', count: 6, delay: 0 },
    { type: 'bombardeiro', count: 4, delay: 3 },
    { type: 'zepelim', count: 2, delay: 6 },
    { type: 'helicoptero', count: 6, delay: 10 },
  ]),
  W(24, 'cidade', [
    { type: 'chefe-cidade', count: 1, delay: 0 },
    { type: 'zepelim', count: 3, delay: 3 },
    { type: 'helicoptero', count: 6, delay: 6 },
    { type: 'tanque', count: 4, delay: 8 },
    { type: 'drone', count: 12, delay: 10 },
  ], true),
];

export function waveFor(mapId, localWave) {
  const idx = ['deserto', 'neve', 'cidade'].indexOf(mapId);
  if (idx < 0 || localWave < 1 || localWave > 8) return null;
  return WAVES[idx * 8 + localWave - 1];
}

export function wavesForMap(mapId) {
  return WAVES.filter((w) => w.mapId === mapId);
}

export function totalEnemies(wave) {
  return wave.groups.reduce((sum, g) => sum + g.count, 0);
}

export function airEnemiesIn(wave) {
  return wave.groups.filter((g) => g.type === 'drone' || g.type === 'helicoptero'
    || g.type === 'bombardeiro' || g.type === 'zepelim' || g.type === 'chefe-neve');
}

export function groundEnemiesIn(wave) {
  return totalEnemies(wave) - airEnemiesIn(wave).reduce((sum, g) => sum + g.count, 0);
}
