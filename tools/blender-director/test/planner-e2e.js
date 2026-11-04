#!/usr/bin/env node
'use strict';

/**
 * Teste de fixture do planner + crítico (fase 1), sem Blender e sem rede.
 *
 * Roda as regras determinísticas sobre os três pedidos de examples/request-*,
 * valida o scene-spec resultante com o schema v1, exercita o gancho de modelo
 * externo (sync e async) e confere as correções priorizadas do crítico.
 *
 * Uso:
 *   node tools/blender-director/test/planner-e2e.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TOOL_DIR = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const EXAMPLES = path.join(TOOL_DIR, 'examples');

const { plan, planWithModel, PLAN_VERSION, RULES_VERSION } = require('../planner');
const { critique } = require('../critic');
const { validateAndNormalize } = require('../lib/spec');

function log(message) {
  process.stdout.write(`${message}\n`);
}

function readExample(name) {
  return fs.readFileSync(path.join(EXAMPLES, name), 'utf8').trim();
}

function runPlannerCases() {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'planner-cases.json'), 'utf8'));
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length === 3, 'fixture do planner precisa de 3 casos');

  for (const testCase of fixture.cases) {
    const request = readExample(testCase.requestFile);
    const result = plan(request);
    const expected = testCase.expect;

    assert.equal(result.planVersion, PLAN_VERSION, `${testCase.requestFile}: planVersion`);
    assert.equal(result.rulesVersion, RULES_VERSION, `${testCase.requestFile}: rulesVersion`);
    assert.equal(result.source, 'rules', `${testCase.requestFile}: source deve ser rules sem modelo`);
    assert.equal(result.request, request, `${testCase.requestFile}: request preservado`);
    assert.equal(result.subject.kind, expected.subjectKind, `${testCase.requestFile}: subject.kind`);
    assert.equal(result.subject.recipe, expected.recipe, `${testCase.requestFile}: recipe`);
    assert.equal(result.options.mood, expected.mood, `${testCase.requestFile}: mood`);
    assert.equal(result.options.framing, expected.framing, `${testCase.requestFile}: framing`);
    assert.equal(result.options.background, expected.background, `${testCase.requestFile}: background`);
    assert.deepEqual(result.options.resolution, expected.resolution, `${testCase.requestFile}: resolution`);
    assert.equal(result.sceneSpec.objects.length, expected.objects, `${testCase.requestFile}: objects`);
    assert.equal(result.sceneSpec.lights.length, expected.lights, `${testCase.requestFile}: lights`);
    assert.deepEqual(Object.keys(result.sceneSpec.materials).sort(), expected.materials.slice().sort(), `${testCase.requestFile}: materials`);
    assert.deepEqual(result.ambiguities.map((item) => item.field), expected.ambiguityFields, `${testCase.requestFile}: ambiguidades`);
    assert.equal(result.confidence, expected.confidence, `${testCase.requestFile}: confidence`);
    assert.deepEqual(result.steps.map((step) => step.id), fixture.steps, `${testCase.requestFile}: ordem das etapas`);
    assert.ok(result.summary.toLowerCase().includes(result.subject.label.split(' ')[0].toLowerCase()), `${testCase.requestFile}: summary menciona o sujeito`);
    assert.ok(result.critic.metrics.includes('ssim') && result.critic.metrics.includes('deltaE'), `${testCase.requestFile}: crítico declara métricas`);
    assert.equal(result.sceneSpec.schemaVersion, 1, `${testCase.requestFile}: schemaVersion`);

    const normalized = validateAndNormalize(result.sceneSpec);
    assert.equal(normalized.objects.length, expected.objects, `${testCase.requestFile}: sceneSpec valida no schema v1`);
    assert.ok(normalized.materials[result.primaryMaterial], `${testCase.requestFile}: material principal "${result.primaryMaterial}" existe`);

    log(`[ok] planner fixture: ${testCase.requestFile} (${result.subject.kind}/${result.subject.recipe})`);
  }
  return fixture;
}

function runBlockingAmbiguity(fixture) {
  const result = plan(fixture.blockingAmbiguity.request);
  const expected = fixture.blockingAmbiguity.expect;
  assert.equal(result.subject.kind, expected.subjectKind, 'pedido vago: sujeito genérico');
  assert.deepEqual(result.ambiguities.map((item) => item.field), expected.ambiguityFields, 'pedido vago: pergunta de sujeito');
  assert.equal(result.ambiguities[0].blocking, expected.blocking, 'pedido vago: ambiguidade bloqueante');
  assert.ok(result.confidence <= expected.maxConfidence, 'pedido vago: confiança limitada');
  log('[ok] planner: ambiguidade bloqueante sem inventar cena específica');
}

async function runModelHooks(fixture) {
  const request = fixture.modelHook.request;
  const expected = fixture.modelHook.expect;

  const syncPlan = plan(request, {
    model: () => fixture.modelHook.modelPlan,
  });
  assert.equal(syncPlan.source, 'model', 'gancho sync: source');
  assert.ok(syncPlan.summary.includes(expected.summaryIncludes), 'gancho sync: summary do modelo');
  assert.equal(syncPlan.steps.length, expected.steps, 'gancho sync: steps do modelo');
  assert.doesNotThrow(() => validateAndNormalize(syncPlan.sceneSpec), 'gancho sync: sceneSpec continua válido');

  const asyncPlan = await planWithModel(request, {
    model: async () => fixture.modelHook.modelPlan,
  });
  assert.equal(asyncPlan.source, 'model', 'gancho async: source');
  assert.ok(asyncPlan.summary.includes(expected.summaryIncludes), 'gancho async: summary do modelo');

  const fallback = plan(request, { model: () => null });
  assert.equal(fallback.source, 'rules', 'gancho nulo cai nas regras');
  assert.equal(fallback.sceneSpec.objects.length, syncPlan.sceneSpec.objects.length, 'gancho nulo mantém a cena');

  assert.throws(
    () => plan(request, { model: () => ({ sceneSpec: { schemaVersion: 1, objects: [] } }) }),
    /sceneSpec inválido/,
    'gancho com sceneSpec inválido precisa falhar alto',
  );
  assert.throws(() => plan(request, { model: () => Promise.resolve(fixture.modelHook.modelPlan) }), /planWithModel/, 'plan() rejeita hook async');
  log('[ok] planner: gancho de modelo (sync, async, fallback e erro)');
}

function runCriticCases() {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'critic-cases.json'), 'utf8'));
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length === 3, 'fixture do crítico precisa de 3 casos');

  for (const testCase of fixture.cases) {
    const result = critique(testCase.metrics);
    const expected = testCase.expect;
    assert.equal(result.verdict, expected.verdict, `${testCase.name}: verdict`);
    if (typeof expected.score === 'number') assert.equal(result.score, expected.score, `${testCase.name}: score`);
    if (typeof expected.minScore === 'number') assert.ok(result.score >= expected.minScore, `${testCase.name}: score mínimo`);
    if (typeof expected.maxScore === 'number') assert.ok(result.score <= expected.maxScore, `${testCase.name}: score máximo`);
    if (typeof expected.minCorrections === 'number') assert.ok(result.corrections.length >= expected.minCorrections, `${testCase.name}: correções mínimas`);
    if (Array.isArray(expected.correctionIds)) assert.deepEqual(result.corrections.map((item) => item.id), expected.correctionIds, `${testCase.name}: ids`);
    if (Array.isArray(expected.requireIds)) {
      for (const id of expected.requireIds) {
        assert.ok(result.corrections.some((item) => item.id === id), `${testCase.name}: correção ${id} presente`);
      }
    }
    if (Array.isArray(expected.firstCorrectionIds)) {
      assert.deepEqual(result.corrections.slice(0, expected.firstCorrectionIds.length).map((item) => item.id), expected.firstCorrectionIds, `${testCase.name}: prioridade`);
    }
    if (Array.isArray(expected.missing)) assert.deepEqual(result.missing, expected.missing, `${testCase.name}: missing`);
    assert.ok(typeof result.disclaimer === 'string' && result.disclaimer.length > 20, `${testCase.name}: disclaimer`);
    for (const correction of result.corrections) {
      assert.ok(Number.isFinite(correction.priority), `${testCase.name}: prioridade numérica`);
      assert.ok(correction.action.length > 10, `${testCase.name}: ação acionável`);
    }
    log(`[ok] crítico fixture: ${testCase.name} (${result.verdict}, ${result.corrections.length} correções)`);
  }
}

async function main() {
  log('Planner/crítico — teste de fixture (sem Blender, sem rede)');
  const fixture = runPlannerCases();
  runBlockingAmbiguity(fixture);
  await runModelHooks(fixture);
  runCriticCases();
  assert.throws(() => plan('   '), /não vazio/, 'planner rejeita pedido vazio');
  log('[ok] planner: pedido vazio rejeitado');
  log('Todos os testes de planner/crítico passaram.');
}

main().catch((error) => {
  console.error('[erro]', error && error.stack ? error.stack : error);
  process.exit(1);
});
