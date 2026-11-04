'use strict';

/**
 * Crítico visual (esqueleto) do Blender Director v2.
 *
 * Recebe métricas já calculadas (SSIM, ΔE00, PSNR, luminância, ruído) e um
 * checklist subjetivo, e devolve uma lista de correções priorizadas. Não
 * calcula imagem e não chama modelo: é deliberadamente pequeno para ser
 * testado com fixtures e trocado por um crítico real na fase 2.
 *
 * Limites honestos: SSIM/PSNR comparam estrutura e ruído, ΔE00 compara cor;
 * nenhum deles "entende" o pedido. Uma imagem plausível pode ter métrica boa e
 * continuar errada. O crítico declara isso em `disclaimer` e prioriza apenas o
 * que as métricas e o checklist conseguem justificar.
 *
 * Contrato:
 *   critique(metrics, opts?) -> Critique
 */

const CRITIC_VERSION = 1;
const MAX_CORRECTIONS = 10;

const THRESHOLDS = Object.freeze({
  ssim: { fail: 0.6, warn: 0.75 },
  deltaE: { warn: 5, fail: 10 },
  psnr: { fail: 20, warn: 24 },
  clipHigh: { warn: 0.01, fail: 0.03 },
  clipLow: { warn: 0.02, fail: 0.06 },
  luminanceMin: 0.16,
  luminanceMax: 0.84,
  score: { ok: 80, needsWork: 40 },
});

const SEVERITY_WEIGHT = { critical: 30, high: 18, medium: 10, low: 4 };
const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 };

const CHECK_AREAS = {
  framing: {
    area: 'enquadramento',
    problem: 'o checklist reprovou o enquadramento',
    action: 'reposicionar câmera/objeto para o objeto principal ficar legível, com margem e sem cortes',
  },
  exposure: {
    area: 'exposição',
    problem: 'o checklist reprovou a exposição',
    action: 'ajustar energia das luzes e exposição do color management; re-renderizar o preview',
  },
  materials: {
    area: 'materiais',
    problem: 'o checklist reprovou materiais',
    action: 'revisar baseColor/roughness/metalness do material citado e comparar com a referência',
  },
  composition: {
    area: 'composição',
    problem: 'o checklist reprovou a composição',
    action: 'revisar proporção entre objeto, piso e fundo; usar a grade de terços como checagem',
  },
  geometry: {
    area: 'geometria',
    problem: 'o checklist reprovou a geometria',
    action: 'conferir escala, normais e interseções; corrigir o spec e gerar novo preview',
  },
  noise: {
    area: 'ruído',
    problem: 'o checklist reprovou o ruído',
    action: 'subir samples do preview, revisar denoise e evitar fontes pequenas demais',
  },
  color: {
    area: 'cor',
    problem: 'o checklist reprovou a cor',
    action: 'corrigir o material e o color management; medir ΔE00 contra a referência',
  },
};

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function severityFor(metric, value) {
  if (metric === 'ssim') {
    if (value < THRESHOLDS.ssim.fail) return 'critical';
    if (value < THRESHOLDS.ssim.warn) return 'high';
    return null;
  }
  if (metric === 'deltaE') {
    if (value > THRESHOLDS.deltaE.fail) return 'critical';
    if (value > THRESHOLDS.deltaE.warn) return 'high';
    return null;
  }
  if (metric === 'psnr') {
    if (value < THRESHOLDS.psnr.fail) return 'critical';
    if (value < THRESHOLDS.psnr.warn) return 'high';
    return null;
  }
  return null;
}

function metricCorrection(metric, value, area, problem, action, target) {
  const severity = severityFor(metric, value);
  if (!severity) return null;
  return {
    id: `metric-${metric}`,
    priority: SEVERITY_RANK[severity] * 100,
    severity,
    area,
    metric,
    observed: round(value, 3),
    target,
    problem,
    action,
  };
}

function clipCorrections(luminance) {
  const corrections = [];
  if (!luminance || typeof luminance !== 'object') return corrections;

  if (isFiniteNumber(luminance.clipHigh) && luminance.clipHigh > THRESHOLDS.clipHigh.warn) {
    const severity = luminance.clipHigh > THRESHOLDS.clipHigh.fail ? 'critical' : 'high';
    corrections.push({
      id: 'exposure-clip-high',
      priority: SEVERITY_RANK[severity] * 100 + 10,
      severity,
      area: 'exposição',
      metric: 'clipHigh',
      observed: round(luminance.clipHigh, 4),
      target: `≤ ${THRESHOLDS.clipHigh.warn}`,
      problem: 'há áreas estouradas (clipping de altas luzes) que escondem detalhe e cor',
      action: 'reduzir energia da key light, aumentar o tamanho da fonte ou baixar a exposição; re-renderizar o preview',
    });
  }
  if (isFiniteNumber(luminance.clipLow) && luminance.clipLow > THRESHOLDS.clipLow.warn) {
    const severity = luminance.clipLow > THRESHOLDS.clipLow.fail ? 'high' : 'medium';
    corrections.push({
      id: 'exposure-clip-low',
      priority: SEVERITY_RANK[severity] * 100 + 9,
      severity,
      area: 'exposição',
      metric: 'clipLow',
      observed: round(luminance.clipLow, 4),
      target: `≤ ${THRESHOLDS.clipLow.warn}`,
      problem: 'sombras fechadas demais escondem material e geometria',
      action: 'adicionar fill/rebote ou elevar a luz de preenchimento; re-renderizar o preview',
    });
  }
  if (isFiniteNumber(luminance.mean)) {
    if (luminance.mean < THRESHOLDS.luminanceMin) {
      corrections.push({
        id: 'exposure-dark',
        priority: 3 * 100 + 8,
        severity: 'high',
        area: 'exposição',
        metric: 'luminance.mean',
        observed: round(luminance.mean, 3),
        target: `entre ${THRESHOLDS.luminanceMin} e ${THRESHOLDS.luminanceMax}`,
        problem: 'o preview está subexposto para avaliar material e cor',
        action: 'subir a key light ou a exposição do color management e comparar de novo',
      });
    } else if (luminance.mean > THRESHOLDS.luminanceMax) {
      corrections.push({
        id: 'exposure-bright',
        priority: 3 * 100 + 8,
        severity: 'high',
        area: 'exposição',
        metric: 'luminance.mean',
        observed: round(luminance.mean, 3),
        target: `entre ${THRESHOLDS.luminanceMin} e ${THRESHOLDS.luminanceMax}`,
        problem: 'o preview está lavado; contraste e cor ficam difíceis de julgar',
        action: 'reduzir luz de preenchimento/mundo e conferir o look do color management',
      });
    }
  }
  return corrections;
}

function checklistCorrections(checks) {
  if (!checks || typeof checks !== 'object') return [];
  const corrections = [];
  for (const [key, value] of Object.entries(checks)) {
    if (value !== 'fail' && value !== 'warn') continue;
    const info = CHECK_AREAS[key] || {
      area: key,
      problem: `o checklist marcou "${key}" como ${value}`,
      action: 'revisar o item no preview e corrigir o spec correspondente',
    };
    const severity = value === 'fail' ? 'high' : 'medium';
    corrections.push({
      id: `check-${key}`,
      priority: SEVERITY_RANK[severity] * 100 + 5,
      severity,
      area: info.area,
      metric: `check.${key}`,
      observed: value,
      target: 'ok',
      problem: info.problem,
      action: info.action,
    });
  }
  return corrections;
}

function extraCorrection(metrics) {
  const corrections = [];
  if (isFiniteNumber(metrics.noise) && metrics.noise > 0.5) {
    corrections.push({
      id: 'noise-high',
      priority: 1 * 100 + 4,
      severity: 'medium',
      area: 'ruído',
      metric: 'noise',
      observed: round(metrics.noise, 3),
      target: '≤ 0.5',
      problem: 'ruído residual alto no preview',
      action: 'subir amostras do preview ou revisar denoise antes de iterar direção',
    });
  }
  if (isFiniteNumber(metrics.sharpness) && metrics.sharpness < 0.15) {
    corrections.push({
      id: 'sharpness-low',
      priority: 1 * 100 + 3,
      severity: 'medium',
      area: 'nitidez',
      metric: 'sharpness',
      observed: round(metrics.sharpness, 3),
      target: '≥ 0.15',
      problem: 'a imagem parece mole/desfocada; pode ser DOF, denoise ou foco errado',
      action: 'conferir foco/DOF e reduzir denoise; se for DOF intencional, registrar como aceito',
    });
  }
  return corrections;
}

function critique(metrics, opts = {}) {
  const input = metrics && typeof metrics === 'object' ? metrics : {};
  const reference = input.reference || (opts && opts.reference) || null;
  const corrections = [];

  const missing = [];
  for (const metric of ['ssim', 'deltaE', 'psnr']) {
    if (!isFiniteNumber(input[metric])) missing.push(metric);
  }

  if (isFiniteNumber(input.ssim)) {
    corrections.push(metricCorrection(
      'ssim',
      input.ssim,
      'composição',
      'a estrutura do preview diverge da referência (enquadramento, escala ou geometria)',
      'revisar câmera, escala e posição dos objetos; comparar com a referência alinhada',
      `≥ ${THRESHOLDS.ssim.warn}`,
    ));
  }
  if (isFiniteNumber(input.deltaE)) {
    corrections.push(metricCorrection(
      'deltaE',
      input.deltaE,
      'cor',
      'a cor média do preview diverge da referência',
      'corrigir baseColor do material e conferir sRGB→linear; medir novamente',
      `≤ ${THRESHOLDS.deltaE.warn}`,
    ));
  }
  if (isFiniteNumber(input.psnr)) {
    corrections.push(metricCorrection(
      'psnr',
      input.psnr,
      'estrutura/ruído',
      'a diferença pixel a pixel é alta; pode ser ruído, desalinhamento ou exposição',
      're-renderizar com mais amostras, alinhar a referência e comparar novamente',
      `≥ ${THRESHOLDS.psnr.warn} dB`,
    ));
  }

  corrections.push(...clipCorrections(input.luminance));
  corrections.push(...checklistCorrections(input.checks));
  corrections.push(...extraCorrection(input));

  const filtered = corrections.filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const correction of filtered) {
    if (seen.has(correction.id)) continue;
    seen.add(correction.id);
    unique.push(correction);
  }
  unique.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  const hasBlocking = unique.some((item) => item.severity === 'critical' || item.severity === 'high');
  const onlyMetrics = missing.length === 3 && unique.length === 0;

  let verdict;
  if (onlyMetrics) verdict = 'insufficient-data';
  else if (hasBlocking) verdict = 'needs-work';
  else if (unique.length > 0) verdict = 'needs-work';
  else verdict = 'ok';

  let score = 100;
  for (const correction of unique) score -= SEVERITY_WEIGHT[correction.severity] || 0;
  score = Math.max(0, Math.min(100, Math.round(score)));
  if (verdict === 'insufficient-data') score = 0;

  return {
    criticVersion: CRITIC_VERSION,
    verdict,
    score,
    reference,
    metrics: {
      ssim: isFiniteNumber(input.ssim) ? round(input.ssim, 4) : null,
      deltaE: isFiniteNumber(input.deltaE) ? round(input.deltaE, 3) : null,
      psnr: isFiniteNumber(input.psnr) ? round(input.psnr, 2) : null,
    },
    missing,
    thresholds: THRESHOLDS,
    corrections: unique.slice(0, MAX_CORRECTIONS),
    summary: summarizeVerdict(verdict, unique.length, unique[0], missing),
    disclaimer: 'Métricas comparam pixels/cor contra uma referência; não provam que a cena atende ao pedido. "Realismo absoluto" não é prometido.',
  };
}

function summarizeVerdict(verdict, count, first, missing) {
  if (verdict === 'insufficient-data') {
    return `Sem métricas comparáveis (${missing.join(', ')}); não é possível priorizar correções com honestidade.`;
  }
  if (verdict === 'ok') return 'Preview aprovado pelas métricas e pelo checklist disponíveis.';
  const prefix = `${count} correção(ões) priorizada(s).`;
  return first ? `${prefix} Primeiro: ${first.action}.` : prefix;
}

module.exports = {
  CRITIC_VERSION,
  THRESHOLDS,
  critique,
};
