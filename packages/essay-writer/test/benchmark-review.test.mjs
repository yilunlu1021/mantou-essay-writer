import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { contextSchema } from '@mantou/text-quality';
import { importSession, loadSession, patchTemplate, reviseSession, BENCHMARK_RUBRIC_VERSION,
  BENCHMARK_DIMENSION_IDS, BENCHMARK_CHECK_IDS, benchmarkProfileSchema, benchmarkReviewSchema,
  getEssayQualityBenchmark, prepareBenchmarkReview, reviewBenchmark } from '../dist/index.js';

// Synthetic contract tests do not calibrate an admissions judgment or predict a detector result.
const root = resolve('.');
const context = contextSchema.parse({ language: 'en', genre: 'personal-narrative', authorRole: 'student',
  audience: 'reader', prompt: 'Describe a decision while repairing an object.' });
const profile = { essayType: 'common-app', promptStatus: 'supplied' };
async function fixture(t, text = 'I opened the case. The hinge was loose. I tightened it.', override = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'essay-benchmark-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.txt'), out = join(dir, 'session');
  await writeFile(input, text);
  await importSession(root, { input, out, context: { ...context, ...override } });
  return { dir, input, out };
}
async function complete(out, selected = profile, level = 3) {
  const prepared = await prepareBenchmarkReview(root, out, selected), value = structuredClone(prepared.template);
  value.reviewerId = 'Synthetic builder reviewer';
  value.dimensions = value.dimensions.map(dimension => ({ ...dimension,
    level: dimension.dimensionId === 'prompt-selection' && selected.promptStatus !== 'supplied' ? null : level,
    reason: 'The supplied actions provide specific support for this manual rating.',
    limitation: 'This synthetic rating is not an admissions calibration or an authorship claim.',
    retainCounterexample: 'Ordinary action sentences can carry distinct information without literary devices.', decision: 'retain' }));
  value.checks = value.checks.map(check => ({ ...check,
    status: check.checkId === 'school-facts' && selected.essayType !== 'why-school' ? 'not-applicable' :
      check.checkId === 'answer-relations' && selected.promptStatus !== 'supplied' ? 'unverified' :
      check.checkId === 'length-mechanics' && prepared.observedMechanicalErrors > 0 ? 'issue' : 'clear',
    reason: check.checkId === 'school-facts' ? 'No institution facts are asserted in this synthetic general narrative.' :
      'This manual declaration is limited to the supplied text and the scope of this check.',
    ...(check.checkId === 'school-facts' && selected.essayType === 'why-school' ? {
      officialSources: [{ url: 'https://example.edu/program', checkedAt: '2026-10-18' }]
    } : {}) }));
  value.recommendation = 'adopt';
  return value;
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
  await visit(directory); return files;
}
test('catalog supplies four distinct 100-weight profiles, six dimensions and honest calibration limits', () => {
  const catalog = getEssayQualityBenchmark();
  assert.equal(catalog.rubricVersion, BENCHMARK_RUBRIC_VERSION);
  assert.deepEqual(catalog.rubric.dimensions.map(d => d.id), [...BENCHMARK_DIMENSION_IDS]);
  for (const dimension of catalog.rubric.dimensions) {
    assert.deepEqual(dimension.levelAnchors.map(anchor => anchor.level), [0, 1, 2, 3, 4]);
    assert.ok(dimension.levelAnchors.every(anchor => anchor.description.trim().length > 10));
  }
  assert.match(catalog.rubric.prestige, /earns no points/);
  assert.deepEqual(catalog.rubric.checks, [...BENCHMARK_CHECK_IDS]);
  assert.deepEqual(catalog.rubric.profiles.map(p => p.weights), [
    [15, 25, 20, 15, 15, 10], [15, 35, 20, 10, 15, 5], [15, 35, 20, 10, 15, 5], [25, 25, 20, 10, 15, 5]
  ]);
  assert.ok(catalog.rubric.profiles.every(p => p.weights.reduce((a, b) => a + b, 0) === 100));
  assert.match(catalog.rubric.calibration, /unverified/);
  assert.equal(catalog.scoreReportingVersion, '1.0.0');
  assert.match(catalog.scoreReporting.partial, /only rated dimensions/);
  assert.match(catalog.scoreReporting.limits, /not finer editorial calibration/);
  assert.equal(catalog.rubricHash, 'a1afb522d90c9e5e348946f4abcf633e7b06c4e0c13a33bcdcbb48a0c77f88fe');
  catalog.rubric.profiles[0].weights[0] = 99;
  catalog.scoreReporting.method = 'Mutated reporting description';
  assert.equal(getEssayQualityBenchmark().rubric.profiles[0].weights[0], 15);
  assert.notEqual(getEssayQualityBenchmark().scoreReporting.method, catalog.scoreReporting.method);
  assert.equal(getEssayQualityBenchmark().rubricHash, catalog.rubricHash);
});
test('strict profiles require the actual supplemental task without modifying session context', async t => {
  const { out } = await fixture(t);
  for (const selected of [{ ...profile, task: 'Unused extra task' }, { essayType: 'supplement', promptStatus: 'supplied' },
    { essayType: 'supplement', promptStatus: 'supplied', task: ' ' }, { ...profile, newContextField: true }])
    assert.throws(() => benchmarkProfileSchema.parse(selected));
  const supplement = { essayType: 'supplement', promptStatus: 'supplied', task: 'State the specific repair decision directly.' };
  assert.equal((await prepareBenchmarkReview(root, out, supplement)).profile.task, supplement.task);
  const missing = await fixture(t, 'I opened the case.', { prompt: '' });
  await assert.rejects(prepareBenchmarkReview(root, missing.out, profile), { code: 'benchmark-prompt' });
});
test('preparation is incomplete; recorded review returns arithmetic views without text and keeps session bytes unchanged', async t => {
  const { out } = await fixture(t), before = await snapshot(out);
  const prepared = await prepareBenchmarkReview(root, out, profile);
  assert.equal(prepared.bindings.rubricVersion, '1.0.0');
  assert.equal(Object.keys(prepared.bindings).length, 9);
  assert.equal(prepared.scoreReportingVersion, '1.0.0');
  assert.throws(() => benchmarkReviewSchema.parse(prepared.template));
  const result = await reviewBenchmark(root, out, await complete(out));
  assert.equal(result.reviewDecision, 'recorded');
  assert.deepEqual(result.totalBand, { min: 75, max: 80, maxInclusive: false });
  assert.equal(result.dimensionCount, 6); assert.equal(result.checkCount, 5);
  for (const key of ['containsDocumentText', 'voiceCertified', 'reasoningCertified', 'officialSourcesVerified',
    'detectorReplicated', 'admissionsOutcomePredicted', 'deliveryAuthorized', 'replacesExistingReviews']) assert.equal(result[key], false);
  for (const text of ['hinge', 'Synthetic builder reviewer', 'specific support', 'without literary']) assert.ok(!JSON.stringify(result).includes(text));
  for (const key of ['score', 'rawScore', 'weightedScore', 'reviewerId', 'reason']) assert.ok(!(key in result));
  assert.deepEqual(await snapshot(out), before);
});
test('all grade extremes keep five-point bands alongside the separately versioned percentage view', async t => {
  const { out } = await fixture(t);
  for (const [level, band] of [[0, { min: 0, max: 5, maxInclusive: false }], [1, { min: 25, max: 30, maxInclusive: false }], [2, { min: 50, max: 55, maxInclusive: false }],
    [3, { min: 75, max: 80, maxInclusive: false }], [4, { min: 95, max: 100, maxInclusive: true }]])
    assert.deepEqual((await reviewBenchmark(root, out, await complete(out, profile, level))).totalBand, band);
});
test('full percentage reporting preserves manual levels, weights, legacy bands and review decisions', async t => {
  const { out } = await fixture(t);
  for (const [level, score] of [[0, 0], [1, 25], [2, 50], [3, 75], [4, 100]]) {
    const value = await complete(out, profile, level), result = await reviewBenchmark(root, out, value);
    assert.equal(result.scoreReportingVersion, '1.0.0');
    assert.deepEqual(result.percentage, { scope: 'full', fullScore100: score, assessedScore100: score,
      assessedWeight: 100, unassessedWeight: 0 });
    assert.deepEqual(result.dimensions.map(d => d.level), Array(6).fill(level));
    assert.equal(result.reviewDecision, level <= 2 ? 'needs-rework' : 'recorded');
    assert.equal(result.admissionsOutcomePredicted, false);
  }
});
test('partial percentage uses only the rated denominator without inventing a full prompt score', async t => {
  const { out } = await fixture(t), selected = { ...profile, promptStatus: 'unselected' };
  const value = await complete(out, selected, 3), before = structuredClone(value);
  const result = await reviewBenchmark(root, out, value);
  assert.deepEqual(result.percentage, { scope: 'partial', fullScore100: null, assessedScore100: 75,
    assessedWeight: 85, unassessedWeight: 15 });
  assert.equal(result.totalBand, null);
  assert.equal(result.reviewDecision, 'needs-rework');
  assert.deepEqual(value, before);
  assert.deepEqual(result.dimensions.map(d => d.weight), [15, 25, 20, 15, 15, 10]);
  value.dimensions[2].level = 2;
  const changed = await reviewBenchmark(root, out, value);
  assert.equal(changed.percentage.assessedScore100, 69.1);
  assert.equal(changed.percentage.fullScore100, null);
});
test('all-null percentage reporting retains missing coverage and avoids NaN or an invented zero', async t => {
  const { out } = await fixture(t), value = await complete(out);
  value.dimensions.forEach(dimension => { dimension.level = null; });
  const result = await reviewBenchmark(root, out, value);
  assert.deepEqual(result.percentage, { scope: 'partial', fullScore100: null, assessedScore100: null,
    assessedWeight: 0, unassessedWeight: 100 });
  assert.equal(result.totalBand, null);
  assert.equal(result.reviewDecision, 'needs-rework');
});
test('a rated zero contributes assessed weight and remains distinct from an unrated dimension', async t => {
  const { out } = await fixture(t), value = await complete(out);
  value.dimensions.forEach(dimension => { dimension.level = null; });
  value.dimensions[2].level = 0;
  const result = await reviewBenchmark(root, out, value);
  assert.deepEqual(result.percentage, { scope: 'partial', fullScore100: null, assessedScore100: 0,
    assessedWeight: 20, unassessedWeight: 80 });
  assert.deepEqual(result.rework.lowRatedDimensions, ['reasoning-discourse']);
  assert.equal(result.rework.unratedDimensions.length, 5);
});
test('fractional percentage arithmetic rounds once to one decimal without changing legacy band boundaries', async t => {
  const { out } = await fixture(t), value = await complete(out, profile, 4);
  value.dimensions[0].level = 3;
  const result = await reviewBenchmark(root, out, value);
  assert.deepEqual(result.percentage, { scope: 'full', fullScore100: 96.3, assessedScore100: 96.3,
    assessedWeight: 100, unassessedWeight: 0 });
  assert.deepEqual(result.totalBand, { min: 95, max: 100, maxInclusive: true });
  const major = await complete(out, { essayType: 'why-major', promptStatus: 'supplied' }, 4);
  major.dimensions[5].level = 3;
  assert.equal((await reviewBenchmark(root, out, major)).percentage.fullScore100, 98.8);
});
test('unselected and missing prompts force null prompt rating, null total and unresolved answer review', async t => {
  const { out } = await fixture(t);
  for (const promptStatus of ['unselected', 'missing']) {
    const selected = { ...profile, promptStatus }, value = await complete(out, selected, 4);
    const result = await reviewBenchmark(root, out, value);
    assert.equal(result.totalBand, null); assert.equal(result.reviewDecision, 'needs-rework');
    assert.deepEqual(result.rework.unratedDimensions, ['prompt-selection']);
    const grade = structuredClone(value); grade.dimensions[0].level = 4;
    await assert.rejects(reviewBenchmark(root, out, grade), { code: 'benchmark-review-prompt' });
    for (const status of ['clear', 'not-applicable']) {
      const check = structuredClone(value); check.checks[2].status = status;
      await assert.rejects(reviewBenchmark(root, out, check), { code: 'benchmark-review-prompt' });
    }
  }
});
test('every null dimension remains unrated without redistributing any weight', async t => {
  const { out } = await fixture(t), value = await complete(out, profile, 4);
  for (let index = 0; index < 6; index++) {
    const changed = structuredClone(value); changed.dimensions[index].level = null;
    const result = await reviewBenchmark(root, out, changed);
    assert.equal(result.totalBand, null); assert.equal(result.reviewDecision, 'needs-rework');
    assert.deepEqual(result.dimensions.map(d => d.weight), [15, 25, 20, 15, 15, 10]);
  }
});
test('levels zero through two force rework despite retained decisions and fractional totals stay inside their interval', async t => {
  const { out } = await fixture(t), value = await complete(out, profile, 4);
  for (let index = 0; index < 6; index++) for (const level of [0, 1, 2]) {
    const changed = structuredClone(value); changed.dimensions[index].level = level;
    const result = await reviewBenchmark(root, out, changed);
    assert.equal(result.reviewDecision, 'needs-rework');
    assert.deepEqual(result.rework.lowRatedDimensions, [BENCHMARK_DIMENSION_IDS[index]]);
  }
  value.dimensions[0].level = 3;
  value.dimensions[1].level = 2;
  const result = await reviewBenchmark(root, out, value);
  assert.deepEqual(result.totalBand, { min: 80, max: 85, maxInclusive: false });
  const raw = value.dimensions.reduce((sum, d) => sum + d.level * d.weight / 4, 0);
  assert.ok(raw >= result.totalBand.min && raw < result.totalBand.max);
});
test('dimension and check ordering, all weights and strict coverage cannot be forged', async t => {
  const { out } = await fixture(t), value = await complete(out);
  for (const key of ['dimensions', 'checks']) {
    for (const alter of [items => items.slice(1), items => [...items].reverse(), items => [items[0], items[0], ...items.slice(2)]]) {
      const changed = structuredClone(value); changed[key] = alter(changed[key]);
      await assert.rejects(reviewBenchmark(root, out, changed));
    }
  }
  for (const weight of [0, 16, 35]) {
    const changed = structuredClone(value); changed.dimensions[0].weight = weight;
    await assert.rejects(reviewBenchmark(root, out, changed), { code: 'benchmark-review-dimensions' });
  }
  for (const level of [-1, 5, 2.5]) {
    const changed = structuredClone(value); changed.dimensions[0].level = level;
    await assert.rejects(reviewBenchmark(root, out, changed));
  }
});
test('each hash, profile and an actual later revision invalidate the old bound review', async t => {
  const { out } = await fixture(t), value = await complete(out);
  for (const key of Object.keys(value.bindings)) {
    const changed = structuredClone(value); changed.bindings[key] = key === 'rubricVersion' ? '0.0.1' : '0'.repeat(64);
    await assert.rejects(reviewBenchmark(root, out, changed), { code: 'benchmark-review-stale' });
  }
  const changed = structuredClone(value); changed.profile.essayType = 'why-major';
  await assert.rejects(reviewBenchmark(root, out, changed), { code: 'benchmark-review-stale' });
  const session = await loadSession(root, out);
  await reviseSession(root, out, { ...patchTemplate(session.manifest.context, session.document, session.policy), patches: [{
    blockId: 'p1', start: 2, end: 8, expectedText: 'opened', replacement: 'lifted', reason: 'Correct the stated action.'
  }] });
  await assert.rejects(reviewBenchmark(root, out, value), { code: 'benchmark-review-stale' });
  const current = await complete(out);
  for (const index of [0, 1]) {
    const skipped = structuredClone(current); skipped.checks[index].status = 'not-applicable';
    await assert.rejects(reviewBenchmark(root, out, skipped), { code: 'benchmark-review-applicability' });
  }
});
test('exact codepoint evidence or a substantive absence reason is required without pretending to prove the reason', async t => {
  const { out } = await fixture(t, 'I held 🧭. I closed the case.'), value = await complete(out);
  const quote = 'I closed the case.', start = Array.from('I held 🧭. ').length;
  value.dimensions[0].anchors = [{ blockId: 'p1', start, end: start + Array.from(quote).length, quote }];
  assert.equal((await reviewBenchmark(root, out, value)).reviewDecision, 'recorded');
  const bad = structuredClone(value); bad.dimensions[0].anchors[0].start = 'I held 🧭. '.length;
  await assert.rejects(reviewBenchmark(root, out, bad), { code: 'benchmark-review-span' });
  const absent = structuredClone(value); absent.dimensions[0].anchors = [];
  await assert.rejects(reviewBenchmark(root, out, absent), { code: 'benchmark-review-absence' });
  absent.dimensions[0].absenceReason = 'The specific target content has not been supplied.';
  await assert.rejects(reviewBenchmark(root, out, absent), { code: 'benchmark-review-absence' });
  absent.dimensions[0].level = 0;
  assert.equal((await reviewBenchmark(root, out, absent)).reviewDecision, 'needs-rework');
  const both = structuredClone(value); both.dimensions[0].absenceReason = absent.dimensions[0].absenceReason;
  await assert.rejects(reviewBenchmark(root, out, both), { code: 'benchmark-review-absence' });
  const forged = structuredClone(value); forged.checks[0].anchors[0].quote = 'An invented event.';
  await assert.rejects(reviewBenchmark(root, out, forged), { code: 'benchmark-review-span' });
});
test('high bands and adopt cannot override any local decision, check issue or unverified state', async t => {
  const { out } = await fixture(t), value = await complete(out, profile, 4);
  for (const decision of ['revise', 'needs-source', 'unresolved']) {
    const changed = structuredClone(value); changed.dimensions[3].decision = decision;
    const result = await reviewBenchmark(root, out, changed);
    assert.equal(result.reviewDecision, 'needs-rework'); assert.deepEqual(result.totalBand, { min: 95, max: 100, maxInclusive: true });
  }
  for (let index = 0; index < 5; index++) for (const status of ['issue', 'unverified']) {
    const changed = structuredClone(value); changed.checks[index].status = status;
    assert.equal((await reviewBenchmark(root, out, changed)).reviewDecision, 'needs-rework');
  }
  value.recommendation = 'rework'; assert.equal((await reviewBenchmark(root, out, value)).reviewDecision, 'needs-rework');
});
test('Why School needs declared HTTPS official sources and real calendar dates for clear status', async t => {
  const { out } = await fixture(t), selected = { essayType: 'why-school', promptStatus: 'supplied' }, value = await complete(out, selected);
  assert.equal((await reviewBenchmark(root, out, value)).officialSourcesVerified, false);
  for (const status of ['not-applicable', 'clear']) {
    const changed = structuredClone(value); changed.checks[3].status = status; changed.checks[3].officialSources = [];
    await assert.rejects(reviewBenchmark(root, out, changed), { code: 'benchmark-review-school' });
  }
  for (const fields of [{ url: 'http://example.edu' }, { url: 'file:///tmp/claim' }, { checkedAt: '2026-02-30' }, { checkedAt: '2026-10-18T00:00:00Z' }]) {
    const changed = structuredClone(value); Object.assign(changed.checks[3].officialSources[0], fields);
    await assert.rejects(reviewBenchmark(root, out, changed));
  }
});
test('live mechanical errors cannot be hidden by clear, unverified or not-applicable declarations', async t => {
  const { out } = await fixture(t, 'I opened the case; I tightened the hinge.'), value = await complete(out, profile, 4);
  assert.ok((await prepareBenchmarkReview(root, out, profile)).observedMechanicalErrors > 0);
  assert.equal((await reviewBenchmark(root, out, value)).reviewDecision, 'needs-rework');
  for (const status of ['clear', 'unverified', 'not-applicable']) {
    const changed = structuredClone(value); changed.checks[4].status = status;
    await assert.rejects(reviewBenchmark(root, out, changed), { code: 'benchmark-review-mechanics' });
  }
});
test('CLI exposes catalog, profile/review schemas and read-only preparation plus rating validation', async t => {
  const { dir, out } = await fixture(t), before = await snapshot(out);
  const run = (...args) => spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 4_000_000 });
  const schema = run('schema'); assert.equal(schema.status, 0); assert.ok(JSON.parse(schema.stdout).benchmarkProfile); assert.ok(JSON.parse(schema.stdout).benchmarkReview);
  const catalog = run('benchmark'); assert.equal(catalog.status, 0); assert.equal(JSON.parse(catalog.stdout).version, 'judgment-evidence-95plus5-2.1');
  const prepared = run('prepare-benchmark-review', '--session', out, '--essay-type', 'common-app', '--prompt-status', 'supplied');
  assert.equal(prepared.status, 0, prepared.stderr); assert.equal(JSON.parse(prepared.stdout).template.dimensions.length, 6);
  const reviewFile = join(dir, 'benchmark.json'); await writeFile(reviewFile, JSON.stringify(await complete(out)));
  const result = run('review-benchmark', '--session', out, '--review-file', reviewFile);
  assert.equal(result.status, 3, result.stderr); assert.equal(JSON.parse(result.stdout).reviewDecision, 'recorded');
  assert.ok(!result.stdout.includes('hinge')); assert.deepEqual(await snapshot(out), before);
});
