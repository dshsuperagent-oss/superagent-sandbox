// As 40 ondas da campanha — composição da expansão (issue #20).
//
// Estrutura fechada pela issue: 20 fases × 2 ondas; fases 1–7 Deserto,
// 8–14 Neve, 15–20 Cidade; a 1ª onda de cada fase é a preparação e a 2ª é a
// onda principal; chefes na 2ª onda das fases 5, 10, 15 e 20 (terrestre,
// aéreo, terrestre, mecha); inimigos aéreos desde a fase 1, onda 2, em todos
// os cenários.
//
// A composição deriva das 24 ondas da especificação anterior (issue #18),
// reorganizadas em duas ondas por fase e escaladas ao longo da campanha.
// Grupo = { type, count, delay }: o 1º inimigo do grupo nasce em `delay`
// segundos depois do início da onda e os demais a cada SPAWN_INTERVALS[type].
// A tabela final está documentada no README (seção "Campanha").

const W = (phase, waveInPhase, groups, boss = false) => {
  const scenario = phase <= 7 ? 'deserto' : (phase <= 14 ? 'neve' : 'cidade');
  return { phase, waveInPhase, scenario, groups, boss };
};

export const WAVES = [
  // ---------------------------------------------------------------- Deserto (1–7)
  W(1, 1, [
    { type: 'soldado', count: 8, delay: 0 },
  ]),
  W(1, 2, [
    { type: 'soldado', count: 10, delay: 0 },
    { type: 'drone', count: 4, delay: 4 },
  ]),
  W(2, 1, [
    { type: 'soldado', count: 10, delay: 0 },
    { type: 'blindado', count: 2, delay: 3 },
  ]),
  W(2, 2, [
    { type: 'soldado', count: 10, delay: 0 },
    { type: 'drone', count: 6, delay: 3 },
    { type: 'blindado', count: 3, delay: 6 },
  ]),
  W(3, 1, [
    { type: 'drone', count: 6, delay: 0 },
    { type: 'soldado', count: 6, delay: 2 },
  ]),
  W(3, 2, [
    { type: 'drone', count: 8, delay: 0 },
    { type: 'soldado', count: 8, delay: 2 },
    { type: 'blindado', count: 4, delay: 5 },
  ]),
  W(4, 1, [
    { type: 'soldado', count: 10, delay: 0 },
    { type: 'tanque', count: 1, delay: 4 },
  ]),
  W(4, 2, [
    { type: 'soldado', count: 10, delay: 0 },
    { type: 'tanque', count: 2, delay: 2 },
    { type: 'helicoptero', count: 2, delay: 8 },
  ]),
  W(5, 1, [
    { type: 'drone', count: 10, delay: 0 },
    { type: 'blindado', count: 5, delay: 2 },
  ]),
  W(5, 2, [
    { type: 'chefe-deserto', count: 1, delay: 0 },
    { type: 'tanque', count: 2, delay: 2 },
    { type: 'drone', count: 8, delay: 4 },
    { type: 'helicoptero', count: 2, delay: 10 },
  ], 'chefe-deserto'),
  W(6, 1, [
    { type: 'soldado', count: 12, delay: 0 },
    { type: 'tanque', count: 2, delay: 3 },
    { type: 'helicoptero', count: 1, delay: 8 },
  ]),
  W(6, 2, [
    { type: 'soldado', count: 12, delay: 0 },
    { type: 'tanque', count: 3, delay: 2 },
    { type: 'helicoptero', count: 3, delay: 6 },
    { type: 'bombardeiro', count: 1, delay: 12 },
  ]),
  W(7, 1, [
    { type: 'drone', count: 12, delay: 0 },
    { type: 'blindado', count: 6, delay: 2 },
    { type: 'helicoptero', count: 2, delay: 6 },
  ]),
  W(7, 2, [
    { type: 'drone', count: 12, delay: 0 },
    { type: 'blindado', count: 8, delay: 2 },
    { type: 'helicoptero', count: 4, delay: 6 },
    { type: 'bombardeiro', count: 2, delay: 12 },
  ]),

  // ---------------------------------------------------------------- Neve (8–14)
  W(8, 1, [
    { type: 'soldado', count: 12, delay: 0 },
  ]),
  W(8, 2, [
    { type: 'soldado', count: 12, delay: 0 },
    { type: 'drone', count: 8, delay: 3 },
  ]),
  W(9, 1, [
    { type: 'blindado', count: 6, delay: 0 },
  ]),
  W(9, 2, [
    { type: 'blindado', count: 6, delay: 0 },
    { type: 'helicoptero', count: 3, delay: 4 },
  ]),
  W(10, 1, [
    { type: 'drone', count: 12, delay: 0 },
    { type: 'tanque', count: 1, delay: 4 },
  ]),
  W(10, 2, [
    { type: 'chefe-neve', count: 1, delay: 0 },
    { type: 'zepelim', count: 1, delay: 3 },
    { type: 'drone', count: 10, delay: 5 },
    { type: 'helicoptero', count: 3, delay: 8 },
  ], 'chefe-neve'),
  W(11, 1, [
    { type: 'soldado', count: 12, delay: 0 },
    { type: 'drone', count: 4, delay: 3 },
  ]),
  W(11, 2, [
    { type: 'soldado', count: 12, delay: 0 },
    { type: 'helicoptero', count: 5, delay: 3 },
  ]),
  W(12, 1, [
    { type: 'bombardeiro', count: 1, delay: 0 },
    { type: 'blindado', count: 6, delay: 2 },
  ]),
  W(12, 2, [
    { type: 'bombardeiro', count: 2, delay: 0 },
    { type: 'blindado', count: 8, delay: 2 },
  ]),
  W(13, 1, [
    { type: 'tanque', count: 3, delay: 0 },
    { type: 'helicoptero', count: 2, delay: 4 },
  ]),
  W(13, 2, [
    { type: 'zepelim', count: 1, delay: 0 },
    { type: 'drone', count: 12, delay: 2 },
    { type: 'helicoptero', count: 3, delay: 8 },
  ]),
  W(14, 1, [
    { type: 'tanque', count: 4, delay: 0 },
    { type: 'bombardeiro', count: 1, delay: 4 },
  ]),
  W(14, 2, [
    { type: 'tanque', count: 4, delay: 0 },
    { type: 'bombardeiro', count: 2, delay: 4 },
    { type: 'helicoptero', count: 4, delay: 8 },
    { type: 'zepelim', count: 1, delay: 14 },
  ]),

  // ---------------------------------------------------------------- Cidade (15–20)
  W(15, 1, [
    { type: 'soldado', count: 14, delay: 0 },
    { type: 'drone', count: 6, delay: 3 },
  ]),
  W(15, 2, [
    { type: 'chefe-deserto', count: 1, delay: 0 },
    { type: 'tanque', count: 2, delay: 2 },
    { type: 'soldado', count: 10, delay: 4 },
    { type: 'drone', count: 8, delay: 6 },
    { type: 'helicoptero', count: 2, delay: 10 },
  ], 'chefe-deserto'),
  W(16, 1, [
    { type: 'helicoptero', count: 4, delay: 0 },
    { type: 'tanque', count: 2, delay: 4 },
  ]),
  W(16, 2, [
    { type: 'helicoptero', count: 6, delay: 0 },
    { type: 'tanque', count: 3, delay: 4 },
    { type: 'drone', count: 6, delay: 8 },
  ]),
  W(17, 1, [
    { type: 'bombardeiro', count: 2, delay: 0 },
    { type: 'drone', count: 10, delay: 3 },
  ]),
  W(17, 2, [
    { type: 'bombardeiro', count: 3, delay: 0 },
    { type: 'drone', count: 14, delay: 3 },
  ]),
  W(18, 1, [
    { type: 'zepelim', count: 1, delay: 0 },
    { type: 'blindado', count: 8, delay: 2 },
  ]),
  W(18, 2, [
    { type: 'zepelim', count: 2, delay: 0 },
    { type: 'blindado', count: 10, delay: 2 },
    { type: 'helicoptero', count: 4, delay: 8 },
  ]),
  W(19, 1, [
    { type: 'tanque', count: 5, delay: 0 },
    { type: 'bombardeiro', count: 3, delay: 4 },
  ]),
  W(19, 2, [
    { type: 'tanque', count: 6, delay: 0 },
    { type: 'bombardeiro', count: 4, delay: 3 },
    { type: 'zepelim', count: 2, delay: 6 },
    { type: 'helicoptero', count: 6, delay: 10 },
  ]),
  W(20, 1, [
    { type: 'tanque', count: 6, delay: 0 },
    { type: 'bombardeiro', count: 4, delay: 4 },
    { type: 'drone', count: 10, delay: 8 },
  ]),
  W(20, 2, [
    { type: 'chefe-cidade', count: 1, delay: 0 },
    { type: 'zepelim', count: 3, delay: 3 },
    { type: 'helicoptero', count: 6, delay: 6 },
    { type: 'tanque', count: 4, delay: 8 },
    { type: 'drone', count: 12, delay: 10 },
  ], 'chefe-cidade'),
];

/** Onda de uma fase (1..20) e onda local (1..2); null se inválida. */
export function waveFor(phase, waveInPhase) {
  const p = Math.round(Number(phase));
  const w = Math.round(Number(waveInPhase));
  if (!Number.isFinite(p) || !Number.isFinite(w)) return null;
  return WAVES.find((onda) => onda.phase === p && onda.waveInPhase === w) || null;
}

/** As 2 ondas de uma fase, na ordem. */
export function wavesForPhase(phase) {
  return WAVES.filter((onda) => onda.phase === Math.round(Number(phase)));
}

/** Número da onda global (1..40) de uma onda local de uma fase. */
export function globalWaveOf(onda) {
  if (!onda) return 0;
  return (onda.phase - 1) * 2 + onda.waveInPhase;
}

/** Total de inimigos de uma onda. */
export function totalEnemies(onda) {
  if (!onda || !Array.isArray(onda.groups)) return 0;
  return onda.groups.reduce((soma, grupo) => soma + grupo.count, 0);
}

/** Grupos aéreos de uma onda (mesma semântica da versão anterior). */
export function airEnemiesIn(onda) {
  if (!onda || !Array.isArray(onda.groups)) return [];
  return onda.groups.filter((grupo) => grupo.type === 'drone'
    || grupo.type === 'helicoptero'
    || grupo.type === 'bombardeiro'
    || grupo.type === 'zepelim'
    || grupo.type === 'chefe-neve');
}

/** Total de inimigos terrestres de uma onda. */
export function groundEnemiesIn(onda) {
  const aereos = airEnemiesIn(onda).reduce((soma, grupo) => soma + grupo.count, 0);
  return totalEnemies(onda) - aereos;
}
