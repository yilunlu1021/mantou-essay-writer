import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { contextSchema } from '@mantou/text-quality';
import { importSession, loadSession, patchTemplate, reviseSession,
  BENCHMARK_RUBRIC_VERSION, BENCHMARK_DIMENSION_IDS, BENCHMARK_CHECK_IDS,
  getEssayQualityBenchmark, benchmarkProfileSchema, benchmarkReviewSchema,
  prepareBenchmarkReview, reviewBenchmark } from '../dist/index.js';

const root = resolve('.');
const dimensionIds = ['prompt-selection', 'genre-task', 'reasoning-discourse', 'author-voice', 'information-language', 'ending-economy'];
const checkIds = ['source-fidelity', 'edit-authority', 'answer-relations', 'school-facts', 'length-mechanics'];
const expectedWeights = { 'common-app': [15, 25, 20, 15, 15, 10], 'why-major': [15, 35, 20, 10, 15, 5],
  'why-school': [15, 35, 20, 10, 15, 5], supplement: [25, 25, 20, 10, 15, 5] };
const profile = (essayType = 'common-app', promptStatus = 'supplied') => ({ essayType, promptStatus,
  ...(essayType === 'supplement' ? { task: 'Describe the responsibility stated in the actual prompt.' } : {}) });
const context = contextSchema.parse({ language: 'en', genre: 'application-explanatory', authorRole: 'student',
  audience: 'admission reader', prompt: 'Explain the sensor check and what remains to be learned.' });
async function fixture(t, text = 'I checked the sensor. I compared its reading with the meter.\n\nBefore replacing the circuit, I will learn to calibrate it.', extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'essay-benchmark-independent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.txt'), out = join(dir, 'session');
  await writeFile(input, text);
  await importSession(root, { input, out, context: contextSchema.parse({ ...context, ...extra }) });
  return { dir, input, out };
}
async function snapshot(directory) {
  const files = {};
  async function visit(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name, path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path, name + '/');
      else files[name] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await visit(directory);
  return files;
}
async function complete(out, selected = profile()) {
  const prepared = await prepareBenchmarkReview(root, out, selected), value = structuredClone(prepared.template);
  value.reviewerId = 'independent-synthetic-rater';
  value.dimensions = value.dimensions.map(item => ({ ...item, level: 4,
    reason: 'This is a declared synthetic manual rating for contract testing, not a calibrated quality judgment.',
    limitation: 'The validator cannot establish whether the supplied editorial reason is true.',
    retainCounterexample: 'A plain sentence or necessary technical clause can perform useful work.', decision: 'retain' }));
  value.checks = value.checks.map(item => ({ ...item,
    status: item.checkId === 'school-facts' ? 'not-applicable' : item.checkId === 'length-mechanics' && prepared.observedMechanicalErrors > 0 ? 'issue' : 'clear',
    reason: item.checkId === 'school-facts' ? 'The synthetic sensor excerpt asserts no real institutional facts.' :
      'This explicit synthetic declaration tests state validation without certifying free-text truth.' }));
  if (selected.essayType === 'why-school') {
    const school = value.checks.find(item => item.checkId === 'school-facts');
    school.status = 'clear';
    school.reason = 'This reserved example URL tests declaration form only; it is not evidence of a real school resource.';
    school.officialSources = [{ url: 'https://example.com/synthetic-catalog', checkedAt: '2026-10-18' }];
  }
  if (selected.promptStatus !== 'supplied') {
    value.dimensions[0].level = null;
    value.dimensions[0].decision = 'unresolved';
    value.checks.find(item => item.checkId === 'answer-relations').status = 'unverified';
  }
  value.recommendation = 'adopt';
  return { prepared, value };
}
async function changeFixture(out) {
  const s = await loadSession(root, out);
  await reviseSession(root, out, { ...patchTemplate(s.manifest.context, s.document, s.policy), patches: [{
    blockId: 'p1', start: 2, end: 9, expectedText: 'checked', replacement: 'tested', reason: 'Correct the synthetic action.'
  }] });
}

test('independent benchmark: four profiles have exactly six ordered dimensions and 100 total weight', () => {
  const catalog = getEssayQualityBenchmark();
  assert.equal(BENCHMARK_RUBRIC_VERSION, '1.0.0');
  assert.deepEqual([...BENCHMARK_DIMENSION_IDS], dimensionIds);
  assert.deepEqual([...BENCHMARK_CHECK_IDS], checkIds);
  assert.deepEqual(catalog.rubric.dimensions.map(item => item.id), dimensionIds);
  assert.deepEqual(catalog.rubric.checks, checkIds);
  assert.deepEqual(catalog.rubric.levels.map(item => item.level), [0, 1, 2, 3, 4]);
  for (const item of catalog.rubric.dimensions) {
    assert.deepEqual(item.levelAnchors.map(anchor => anchor.level), [0, 1, 2, 3, 4]);
    assert.ok(item.levelAnchors.every(anchor => anchor.description.trim()));
  }
  assert.ok(catalog.rubric.profileSelection.trim());
  assert.ok(catalog.rubric.prestige.trim());
  assert.equal(catalog.rubric.profiles.length, 4);
  for (const item of catalog.rubric.profiles) {
    assert.deepEqual(item.weights, expectedWeights[item.essayType]);
    assert.equal(item.weights.reduce((sum, weight) => sum + weight, 0), 100);
    assert.ok(item.task.trim());
  }
  assert.match(catalog.rubricHash, /^[a-f0-9]{64}$/u);
  catalog.rubric.profiles[0].weights[0] = 0;
  catalog.rubric.dimensions[0].title = 'Mutated caller copy';
  assert.deepEqual(getEssayQualityBenchmark().rubric.profiles[0].weights, expectedWeights['common-app']);
  assert.notEqual(getEssayQualityBenchmark().rubric.dimensions[0].title, 'Mutated caller copy');
});

test('independent benchmark: explicit genre and prompt status are required, with a task only for Supplement', () => {
  for (const type of Object.keys(expectedWeights)) assert.deepEqual(benchmarkProfileSchema.parse(profile(type)), profile(type));
  for (const invalid of [{ essayType: 'common-app' }, { promptStatus: 'supplied' },
    { ...profile(), essayType: 'universal-growth-story' }, { ...profile(), promptStatus: 'probably-supplied' },
    { ...profile(), task: 'Unrequested supplemental task' }, { ...profile('supplement'), task: '  ' },
    { essayType: 'supplement', promptStatus: 'supplied' }, { ...profile(), humanApproved: true }])
    assert.throws(() => benchmarkProfileSchema.parse(invalid));
});

test('independent benchmark: preparation is incomplete, bound and byte-for-byte read-only', async t => {
  const { out } = await fixture(t), before = await snapshot(out);
  for (const type of Object.keys(expectedWeights)) {
    const prepared = await prepareBenchmarkReview(root, out, profile(type));
    assert.equal(Object.keys(prepared.bindings).length, 9);
    assert.equal(prepared.bindings.rubricVersion, BENCHMARK_RUBRIC_VERSION);
    assert.equal(prepared.bindings.rubricHash, getEssayQualityBenchmark().rubricHash);
    assert.deepEqual(prepared.template.dimensions.map(item => item.dimensionId), dimensionIds);
    assert.deepEqual(prepared.template.dimensions.map(item => item.weight), expectedWeights[type]);
    assert.deepEqual(prepared.template.checks.map(item => item.checkId), checkIds);
    assert.ok(prepared.template.dimensions.every(item => item.level === null));
    assert.throws(() => benchmarkReviewSchema.parse(prepared.template));
    assert.equal(prepared.containsDocumentText, true);
    assert.equal(prepared.deliveryAuthorized, false);
  }
  assert.deepEqual(await snapshot(out), before);
});

test('independent benchmark: supplied status cannot fabricate a missing prompt', async t => {
  const { out } = await fixture(t, 'I checked the sensor.', { prompt: '' });
  await assert.rejects(prepareBenchmarkReview(root, out, profile()), { code: 'benchmark-prompt' });
  for (const status of ['unselected', 'missing'])
    assert.equal((await prepareBenchmarkReview(root, out, profile('common-app', status))).profile.promptStatus, status);
});

test('independent benchmark: recorded ratings expose a broad band and hashes without certifying prose or leaking reviewer identity', async t => {
  const { out } = await fixture(t);
  for (const type of Object.keys(expectedWeights)) {
    const { value } = await complete(out, profile(type)), result = await reviewBenchmark(root, out, value);
    assert.equal(result.reviewDecision, 'recorded');
    assert.deepEqual(result.totalBand, { min: 95, max: 100, maxInclusive: true });
    assert.equal(result.dimensionCount, 6); assert.equal(result.checkCount, 5);
    assert.equal(result.referencesVerified, true); assert.equal(result.calculationVerified, true);
    assert.match(result.reviewerHash, /^[a-f0-9]{64}$/u);
    for (const key of ['reasoningCertified', 'judgmentsVerified', 'semanticEquivalenceChecked', 'independentReaderVerified',
      'voiceCertified', 'sourceTruthVerified', 'officialSourcesVerified', 'detectorReplicated', 'automaticRewrite',
      'admissionsOutcomePredicted', 'deliveryAuthorized', 'replacesExistingReviews', 'containsDocumentText']) assert.equal(result[key], false, key);
    assert.ok(!JSON.stringify(result).includes('calibration before'));
    assert.ok(!JSON.stringify(result).includes(value.reviewerId));
    for (const key of ['score', 'totalScore', 'weightedScore', 'rawScore', 'probability', 'aiLabel']) assert.ok(!(key in result), key);
  }
});

test('independent benchmark: exact profile weights produce enclosing five-point intervals, including fractional totals and endpoints', async t => {
  const { out } = await fixture(t);
  for (const type of Object.keys(expectedWeights)) {
    const { value } = await complete(out, profile(type));
    for (const levels of [[0, 0, 0, 0, 0, 0], [4, 4, 4, 4, 4, 4], [3, 4, 2, 3, 3, 2],
      [4, 3, 3, 4, 3, 4], [4, 4, 4, 4, 4, 3]]) {
      const changed = structuredClone(value); changed.dimensions.forEach((item, index) => { item.level = levels[index]; });
      const result = await reviewBenchmark(root, out, changed), raw = levels.reduce((sum, level, index) => sum + level * expectedWeights[type][index] / 4, 0);
      const band = result.totalBand;
      assert.ok(band && raw >= band.min && (band.maxInclusive ? raw <= band.max : raw < band.max), type + '/' + raw);
      assert.equal(band.max - band.min, 5);
      assert.equal(band.min % 5, 0);
      assert.equal(band.maxInclusive, band.max === 100);
      assert.ok(!Object.values(result).includes(raw) || raw === result.referenceCount || raw === result.observedMechanicalErrors || raw === result.reworkCount,
        'The exact manual total is not exposed as a top-level numeric score.');
    }
  }
});

test('independent benchmark: every defined incomplete or weak level overrides retain and adopt even inside a high band', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (let index = 0; index < 6; index++) for (const level of [0, 1, 2]) {
    const changed = structuredClone(value); changed.dimensions[index].level = level;
    const result = await reviewBenchmark(root, out, changed);
    assert.equal(result.reviewDecision, 'needs-rework', dimensionIds[index] + '/' + level);
    assert.ok(result.rework.lowRatedDimensions.includes(dimensionIds[index]));
    assert.ok(result.totalBand !== null, 'A diagnostic band can remain visible without approving the text.');
  }
});

test('independent benchmark: one unrated dimension leaves the full band null without redistributing its weight', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (let index = 0; index < 6; index++) {
    const changed = structuredClone(value); changed.dimensions[index].level = null;
    const result = await reviewBenchmark(root, out, changed);
    assert.equal(result.totalBand, null); assert.equal(result.reviewDecision, 'needs-rework');
    assert.ok(result.rework.unratedDimensions.includes(dimensionIds[index]));
    assert.deepEqual(result.dimensions.map(item => item.weight), expectedWeights['common-app']);
  }
});

test('independent benchmark: unselected or missing prompts force abstention and an unverified or issue answer check', async t => {
  const { out } = await fixture(t);
  for (const status of ['unselected', 'missing']) {
    const { value } = await complete(out, profile('common-app', status));
    const result = await reviewBenchmark(root, out, value);
    assert.equal(result.totalBand, null); assert.equal(result.reviewDecision, 'needs-rework');
    const scored = structuredClone(value); scored.dimensions[0].level = 4;
    await assert.rejects(reviewBenchmark(root, out, scored), { code: 'benchmark-review-prompt' });
    for (const invalidStatus of ['clear', 'not-applicable']) {
      const invalid = structuredClone(value); invalid.checks.find(item => item.checkId === 'answer-relations').status = invalidStatus;
      await assert.rejects(reviewBenchmark(root, out, invalid), { code: 'benchmark-review-prompt' });
    }
  }
});

test('independent benchmark: all bindings, declared profile changes and actual new versions reject stale ratings', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (const key of Object.keys(value.bindings)) {
    const invalid = structuredClone(value); invalid.bindings[key] = key === 'rubricVersion' ? '0.9.0' : '0'.repeat(64);
    await assert.rejects(reviewBenchmark(root, out, invalid), { code: 'benchmark-review-stale' }, key);
  }
  const wrongProfile = structuredClone(value); wrongProfile.profile = profile('why-major');
  await assert.rejects(reviewBenchmark(root, out, wrongProfile), { code: 'benchmark-review-stale' });
  await changeFixture(out);
  await assert.rejects(reviewBenchmark(root, out, value), { code: 'benchmark-review-stale' });
});

test('independent benchmark: missing, duplicate, reordered dimensions and wrong profile weights cannot validate', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (const mutate of [v => v.dimensions.pop(), v => v.dimensions.push(structuredClone(v.dimensions[0])),
    v => v.dimensions.reverse(), v => { v.dimensions[0].dimensionId = v.dimensions[1].dimensionId; },
    v => { v.dimensions[0].weight++; }, v => { v.dimensions[0].weight = 0; }]) {
    const invalid = structuredClone(value); mutate(invalid);
    await assert.rejects(reviewBenchmark(root, out, invalid));
  }
  for (const level of [-1, 5, 2.5, '4']) {
    const invalid = structuredClone(value); invalid.dimensions[0].level = level;
    await assert.rejects(reviewBenchmark(root, out, invalid));
  }
});

test('independent benchmark: all five compliance checks must appear once in the prepared order', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (const mutate of [v => v.checks.pop(), v => v.checks.push(structuredClone(v.checks[0])),
    v => v.checks.reverse(), v => { v.checks[0].checkId = v.checks[1].checkId; }]) {
    const invalid = structuredClone(value); mutate(invalid);
    await assert.rejects(reviewBenchmark(root, out, invalid));
  }
});

test('independent benchmark: every dimension and compliance reference rejects fabricated or non-substantive text', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  const targets = record => [...record.dimensions, ...record.checks].map(item => item.anchors[0]);
  for (let index = 0; index < targets(value).length; index++) {
    const invalid = structuredClone(value); targets(invalid)[index].quote = 'An invented result.';
    await assert.rejects(reviewBenchmark(root, out, invalid), { code: 'benchmark-review-span' });
  }
  for (const fields of [{ blockId: 'missing' }, { start: -1 }, { end: 99999 }, { start: 8, end: 2 }]) {
    const invalid = structuredClone(value); Object.assign(invalid.dimensions[0].anchors[0], fields);
    await assert.rejects(reviewBenchmark(root, out, invalid));
  }
  const blank = structuredClone(value); blank.dimensions[0].anchors = [{ blockId: 'p1', start: 1, end: 2, quote: ' ' }];
  await assert.rejects(reviewBenchmark(root, out, blank), { code: 'benchmark-review-span' });
});

test('independent benchmark: Unicode spans use codepoints rather than UTF-16 code units', async t => {
  const { out } = await fixture(t, '🧭 I checked the sensor. I compared the reading.'), { value } = await complete(out);
  const quote = 'I checked the sensor.';
  value.dimensions[0].anchors = [{ blockId: 'p1', start: 2, end: 2 + Array.from(quote).length, quote }];
  assert.equal((await reviewBenchmark(root, out, value)).reviewDecision, 'recorded');
  const invalid = structuredClone(value); invalid.dimensions[0].anchors[0].start = '🧭 '.length;
  invalid.dimensions[0].anchors[0].end = invalid.dimensions[0].anchors[0].start + Array.from(quote).length;
  await assert.rejects(reviewBenchmark(root, out, invalid), { code: 'benchmark-review-span' });
});

test('independent benchmark: evidence and absence declarations are exclusive and no positive level can claim complete absence', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (const level of [null, 0]) {
    const changed = structuredClone(value); Object.assign(changed.dimensions[0], { anchors: [], absenceReason: 'The target content is explicitly absent or cannot be assessed.', level });
    assert.equal((await reviewBenchmark(root, out, changed)).reviewDecision, 'needs-rework');
  }
  for (const level of [1, 2, 3, 4]) {
    const invalid = structuredClone(value); Object.assign(invalid.dimensions[0], { anchors: [], absenceReason: 'No target content is present.', level });
    await assert.rejects(reviewBenchmark(root, out, invalid));
  }
  const missing = structuredClone(value); missing.dimensions[0].anchors = [];
  await assert.rejects(reviewBenchmark(root, out, missing));
  const both = structuredClone(value); both.dimensions[0].absenceReason = 'The content is absent despite this evidence claim.';
  await assert.rejects(reviewBenchmark(root, out, both));
});

test('independent benchmark: required reasons and declared reviewer identity reject blanks and injected certifications', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (const path of [['reviewerId'], ['dimensions', 0, 'reason'], ['dimensions', 0, 'limitation'],
    ['dimensions', 0, 'retainCounterexample'], ['checks', 0, 'reason']]) {
    const invalid = structuredClone(value); let object = invalid;
    for (const key of path.slice(0, -1)) object = object[key];
    object[path.at(-1)] = '   ';
    await assert.rejects(reviewBenchmark(root, out, invalid));
  }
  for (const fields of [{ reviewerRole: 'human-certified' }, { humanApproved: true }, { methodVersion: '1.3.0' },
    { voiceCertified: true }, { aiProbability: 0 }, { rawScore: 100 }]) await assert.rejects(reviewBenchmark(root, out, { ...value, ...fields }));
  const advisor = structuredClone(value); advisor.reviewerRole = 'advisor'; advisor.reviewerId = 'declared-synthetic-advisor';
  const agentResult = await reviewBenchmark(root, out, value), advisorResult = await reviewBenchmark(root, out, advisor);
  assert.equal(advisorResult.reviewerRole, 'advisor');
  assert.notEqual(agentResult.reviewerHash, advisorResult.reviewerHash);
  assert.equal(advisorResult.judgmentsVerified, false);
});

test('independent benchmark: any local editorial or compliance problem overrides a high band and adopt', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (const checkId of checkIds) for (const status of ['issue', 'unverified']) {
    const changed = structuredClone(value); changed.checks.find(item => item.checkId === checkId).status = status;
    const result = await reviewBenchmark(root, out, changed);
    assert.equal(result.reviewDecision, 'needs-rework', checkId + '/' + status);
    assert.ok(result.rework.checks.includes(checkId));
    assert.deepEqual(result.totalBand, { min: 95, max: 100, maxInclusive: true });
  }
  for (const decision of ['revise', 'needs-source', 'unresolved']) {
    const changed = structuredClone(value); changed.dimensions[0].decision = decision;
    const result = await reviewBenchmark(root, out, changed);
    assert.equal(result.reviewDecision, 'needs-rework'); assert.ok(result.rework.dimensions.includes(dimensionIds[0]));
  }
  const changed = structuredClone(value); changed.recommendation = 'rework';
  assert.equal((await reviewBenchmark(root, out, changed)).reviewDecision, 'needs-rework');
});

test('independent benchmark: actual edits cannot mark source fidelity or editing authority inapplicable', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (const checkId of ['source-fidelity', 'edit-authority']) {
    const unchanged = structuredClone(value); unchanged.checks.find(item => item.checkId === checkId).status = 'not-applicable';
    assert.equal((await reviewBenchmark(root, out, unchanged)).reviewDecision, 'recorded');
  }
  await changeFixture(out);
  const { value: edited } = await complete(out);
  for (const checkId of ['source-fidelity', 'edit-authority']) {
    const invalid = structuredClone(edited); invalid.checks.find(item => item.checkId === checkId).status = 'not-applicable';
    await assert.rejects(reviewBenchmark(root, out, invalid), { code: 'benchmark-review-applicability' });
  }
});

test('independent benchmark: known mechanical errors cannot be hidden as clear, unverified or inapplicable', async t => {
  const { out } = await fixture(t, 'I checked the sensor; I recorded the reading.'), { prepared, value } = await complete(out);
  assert.ok(prepared.observedMechanicalErrors > 0);
  assert.equal((await reviewBenchmark(root, out, value)).reviewDecision, 'needs-rework');
  for (const status of ['clear', 'unverified', 'not-applicable']) {
    const invalid = structuredClone(value); invalid.checks.find(item => item.checkId === 'length-mechanics').status = status;
    await assert.rejects(reviewBenchmark(root, out, invalid), { code: 'benchmark-review-mechanics' });
  }
});

test('independent benchmark: Why School clear facts require an HTTPS source and real calendar date declaration', async t => {
  const { out } = await fixture(t), { value } = await complete(out, profile('why-school'));
  for (const mutate of [item => { item.status = 'not-applicable'; }, item => { delete item.officialSources; },
    item => { item.officialSources = []; }, item => { item.officialSources[0].url = 'http://example.com/synthetic'; },
    item => { item.officialSources[0].url = 'javascript:alert(1)'; }, item => { item.officialSources[0].checkedAt = '2026-02-30'; },
    item => { item.officialSources[0].checkedAt = 'not-a-date'; }]) {
    const invalid = structuredClone(value); mutate(invalid.checks.find(item => item.checkId === 'school-facts'));
    await assert.rejects(reviewBenchmark(root, out, invalid));
  }
  const result = await reviewBenchmark(root, out, value);
  assert.equal(result.reviewDecision, 'recorded'); assert.equal(result.officialSourcesVerified, false);
  for (const status of ['issue', 'unverified']) {
    const changed = structuredClone(value), item = changed.checks.find(item => item.checkId === 'school-facts');
    item.status = status; delete item.officialSources;
    assert.equal((await reviewBenchmark(root, out, changed)).reviewDecision, 'needs-rework');
  }
});

test('independent benchmark: SDK reads call no network, subprocess or database and do not mutate session bytes', async t => {
  const { dir, out } = await fixture(t), { value } = await complete(out), before = await snapshot(dir), calls = [], restorers = [];
  const block = (object, key) => { const old = object[key]; restorers.push(() => { object[key] = old; });
    object[key] = () => { calls.push(key); throw new Error('Unexpected external operation: ' + key); }; };
  block(globalThis, 'fetch');
  for (const object of [http, https]) for (const key of ['request', 'get']) block(object, key);
  for (const key of ['connect', 'createConnection']) block(net, key);
  block(tls, 'connect');
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) block(childProcess, key);
  try {
    await prepareBenchmarkReview(root, out, profile());
    assert.equal((await reviewBenchmark(root, out, value)).reviewDecision, 'recorded');
  } finally { for (const restore of restorers.reverse()) restore(); }
  assert.deepEqual(calls, []); assert.deepEqual(await snapshot(dir), before);
  assert.ok(!Object.keys(await snapshot(dir)).some(path => /\.sqlite(?:-|$)|\.db(?:-|$)/u.test(path)));
});

test('independent benchmark: CLI catalog, schemas, all profile preparations and review agree with SDK', async t => {
  const { dir, out } = await fixture(t), { value } = await complete(out), before = await snapshot(out);
  const run = (...args) => spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 3_000_000 });
  const catalog = run('benchmark'); assert.equal(catalog.status, 0, catalog.stderr);
  assert.equal(JSON.parse(catalog.stdout).version, 'judgment-evidence-95plus5-2.1');
  assert.notEqual(JSON.parse(catalog.stdout).rubricHash, getEssayQualityBenchmark().rubricHash);
  const schema = run('schema'); assert.equal(schema.status, 0, schema.stderr);
  assert.ok(JSON.parse(schema.stdout).benchmarkProfile); assert.ok(JSON.parse(schema.stdout).benchmarkReview);
  for (const type of Object.keys(expectedWeights)) {
    const args = ['prepare-benchmark-review', '--session', out, '--essay-type', type, '--prompt-status', 'supplied'];
    if (type === 'supplement') args.push('--task', profile(type).task);
    const prepared = run(...args); assert.equal(prepared.status, 0, prepared.stderr);
    assert.deepEqual(JSON.parse(prepared.stdout).bindings, (await prepareBenchmarkReview(root, out, profile(type))).bindings);
  }
  const missingTask = run('prepare-benchmark-review', '--session', out, '--essay-type', 'supplement', '--prompt-status', 'supplied');
  assert.equal(missingTask.status, 1);
  const reviewFile = join(dir, 'review.json'); await writeFile(reviewFile, JSON.stringify(value));
  const reviewed = run('review-benchmark', '--session', out, '--review-file', reviewFile);
  assert.equal(reviewed.status, 3, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).reviewDecision, 'recorded');
  assert.ok(!reviewed.stdout.includes(value.reviewerId));
  assert.deepEqual(await snapshot(out), before);
});

test('independent benchmark: ten calibration cases preserve genre and grammar counterexamples without claiming preference fit', async () => {
  const fixtureData = JSON.parse(await readFile(new URL('./fixtures/benchmark-calibration.json', import.meta.url), 'utf8'));
  assert.equal(fixtureData.cases.length, 10);
  assert.equal(new Set(fixtureData.cases.map(item => item.id)).size, 10);
  assert.ok(fixtureData.cases.some(item => item.expectedDirection === 'no-syntax-based-preference'));
  assert.deepEqual(new Set(fixtureData.cases.map(item => item.essayType)), new Set(Object.keys(expectedWeights)));
  for (const item of fixtureData.cases) {
    assert.ok(item.prompt.trim() && item.variantA.trim() && item.variantB.trim());
    assert.ok(item.sourceFacts.length && item.reason.trim() && item.retainCounterexample.trim());
    if (item.essayType === 'supplement') assert.ok(item.task.trim());
  }
  for (const claim of Object.values(fixtureData.claims)) assert.equal(claim, false);
});
