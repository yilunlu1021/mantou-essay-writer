import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { contextSchema } from '@mantou/text-quality';
import { importSession, prepareBenchmarkReview, reviewBenchmark,
  getEssayQualityBenchmark, benchmarkReviewSchema } from '../dist/index.js';

// Independently specified arithmetic cases. Synthetic ratings make no admissions claim.
const policyRoot = resolve('.');
const historicalRubricHash = 'a1afb522d90c9e5e348946f4abcf633e7b06c4e0c13a33bcdcbb48a0c77f88fe';
const context = contextSchema.parse({ language: 'en', genre: 'personal-narrative',
  authorRole: 'student', audience: 'reader', prompt: 'Explain the repair decision.' });

async function createRecord(t, levels, essayType = 'common-app', promptStatus = 'supplied') {
  const dir = await mkdtemp(join(tmpdir(), 'independent-percentage-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const input = join(dir, 'source.txt'), session = join(dir, 'session');
  await writeFile(input, 'I repaired the latch. I replaced its screw. The lid closed.');
  await importSession(policyRoot, { input, out: session, context });
  const profile = { essayType, promptStatus,
    ...(essayType === 'supplement' ? { task: 'Explain the repair decision directly.' } : {}) };
  const prepared = await prepareBenchmarkReview(policyRoot, session, profile);
  const record = structuredClone(prepared.template);
  record.reviewerId = 'Independent synthetic percentage reviewer';
  record.dimensions = record.dimensions.map((dimension, index) => ({ ...dimension,
    level: levels[index], decision: levels[index] === null ? 'unresolved' : 'retain',
    reason: 'This supplied rating is used to inspect the arithmetic contract.',
    limitation: 'The synthetic record does not establish text quality or admissions outcomes.',
    retainCounterexample: 'A simple repair account can contain useful information.' }));
  record.checks = record.checks.map(check => ({ ...check,
    status: check.checkId === 'school-facts' && essayType !== 'why-school' ? 'not-applicable' :
      check.checkId === 'answer-relations' && promptStatus !== 'supplied' ? 'unverified' :
        check.checkId === 'length-mechanics' && prepared.observedMechanicalErrors > 0 ? 'issue' : 'clear',
    reason: check.checkId === 'school-facts' && essayType !== 'why-school'
      ? 'This repair account makes no school resource claim.'
      : 'The status is declared only for this synthetic calculation fixture.',
    ...(check.checkId === 'school-facts' && essayType === 'why-school'
      ? { officialSources: [{ url: 'https://example.edu/repair', checkedAt: '2026-10-18' }] } : {}) }));
  record.recommendation = 'adopt';
  return { dir, session, record, prepared };
}

function percentage(scope, fullScore100, assessedScore100, assessedWeight, unassessedWeight) {
  return { scope, fullScore100, assessedScore100, assessedWeight, unassessedWeight };
}

async function sessionDigest(directory) {
  const entries = [];
  async function walk(path, relative = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name), name = relative + entry.name;
      if (entry.isDirectory()) await walk(child, name + '/');
      else entries.push([name, createHash('sha256').update(await readFile(child)).digest('hex')]);
    }
  }
  await walk(directory);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

test('independent: all-null is unassessed rather than zero or a full score', async t => {
  const { session, record } = await createRecord(t, [null, null, null, null, null, null]);
  const result = await reviewBenchmark(policyRoot, session, record);
  assert.equal(result.scoreReportingVersion, '1.0.0');
  assert.deepEqual(result.percentage, percentage('partial', null, null, 0, 100));
  assert.equal(result.totalBand, null);
  assert.equal(result.reviewDecision, 'needs-rework');
  assert.equal(result.rework.unratedDimensions.length, 6);
});

test('independent: a rated zero contributes assessed weight and retains rework', async t => {
  const { session, record } = await createRecord(t, [0, null, null, null, null, null]);
  const result = await reviewBenchmark(policyRoot, session, record);
  assert.deepEqual(result.percentage, percentage('partial', null, 0, 15, 85));
  assert.deepEqual(result.rework.lowRatedDimensions, ['prompt-selection']);
  assert.equal(result.totalBand, null);
});

test('independent: unknown prompt exposes 75 assessed out of 100 with 85 weight, never full75', async t => {
  for (const status of ['missing', 'unselected']) {
    const { session, record } = await createRecord(t, [null, 3, 3, 3, 3, 3], 'common-app', status);
    const result = await reviewBenchmark(policyRoot, session, record);
    assert.deepEqual(result.percentage, percentage('partial', null, 75, 85, 15));
    assert.equal(result.totalBand, null);
    assert.equal(result.reviewDecision, 'needs-rework');
    const forged = structuredClone(record);
    forged.dimensions[0].level = 3;
    await assert.rejects(reviewBenchmark(policyRoot, session, forged), { code: 'benchmark-review-prompt' });
  }
});

test('independent: any other unassessed dimension also prevents a full score', async t => {
  const { session, record } = await createRecord(t, [3, null, 3, 3, 3, 3]);
  const result = await reviewBenchmark(policyRoot, session, record);
  assert.deepEqual(result.percentage, percentage('partial', null, 75, 75, 25));
  assert.equal(result.totalBand, null);
});

test('independent: partial fractional score rounds to one decimal without changing original weights', async t => {
  const { session, record } = await createRecord(t, [null, 3, 2, 3, 3, 3], 'common-app', 'unselected');
  const result = await reviewBenchmark(policyRoot, session, record);
  assert.deepEqual(result.percentage, percentage('partial', null, 69.1, 85, 15));
  assert.deepEqual(result.dimensions.map(d => d.weight), [15, 25, 20, 15, 15, 10]);
  assert.equal(result.totalBand, null);
  assert.deepEqual(result.rework.lowRatedDimensions, ['reasoning-discourse']);
});

test('independent: mixed partial scores include zero-rated dimensions in denominator', async t => {
  const { session, record } = await createRecord(t, [null, 1, 4, 0, 2, 3], 'common-app', 'missing');
  const result = await reviewBenchmark(policyRoot, session, record);
  assert.deepEqual(result.percentage, percentage('partial', null, 48.5, 85, 15));
  assert.equal(result.rework.lowRatedDimensions.length, 3);
});

test('independent: perfect partial ratings cannot become a100 full score at any coverage', async t => {
  for (const [levels, coverage] of [
    [[null, 4, 4, 4, 4, 4], 85],
    [[4, null, null, null, null, null], 15],
    [[null, null, null, null, null, 4], 10]
  ]) {
    const { session, record } = await createRecord(t, levels);
    const result = await reviewBenchmark(policyRoot, session, record);
    assert.deepEqual(result.percentage, percentage('partial', null, 100, coverage, 100 - coverage));
    assert.equal(result.totalBand, null);
    assert.equal(result.reviewDecision, 'needs-rework');
  }
});

test('independent: fully rated zero is a full0 score, with the existing0to5 band', async t => {
  const { session, record } = await createRecord(t, [0, 0, 0, 0, 0, 0]);
  const result = await reviewBenchmark(policyRoot, session, record);
  assert.deepEqual(result.percentage, percentage('full', 0, 0, 100, 0));
  assert.deepEqual(result.totalBand, { min: 0, max: 5, maxInclusive: false });
  assert.equal(result.reviewDecision, 'needs-rework');
});

test('independent: all grade3 and grade4 calculate full75 and100 respectively', async t => {
  for (const [level, expected, band] of [
    [3, 75, { min: 75, max: 80, maxInclusive: false }],
    [4, 100, { min: 95, max: 100, maxInclusive: true }]
  ]) {
    const { session, record } = await createRecord(t, Array(6).fill(level));
    const result = await reviewBenchmark(policyRoot, session, record);
    assert.deepEqual(result.percentage, percentage('full', expected, expected, 100, 0));
    assert.deepEqual(result.totalBand, band);
    assert.equal(result.reviewDecision, 'recorded');
  }
});

test('independent: fractional full scores round without changing their five-point band', async t => {
  for (const [levels, expected, band] of [
    [[3, 4, 2, 3, 1, 4], 71.3, { min: 70, max: 75, maxInclusive: false }],
    [[0, 0, 0, 0, 1, 0], 3.8, { min: 0, max: 5, maxInclusive: false }],
    [[4, 4, 4, 4, 3, 4], 96.3, { min: 95, max: 100, maxInclusive: true }]
  ]) {
    const { session, record } = await createRecord(t, levels);
    const result = await reviewBenchmark(policyRoot, session, record);
    assert.deepEqual(result.percentage, percentage('full', expected, expected, 100, 0));
    assert.deepEqual(result.totalBand, band);
  }
});

test('independent: each profile uses its own weights for nonuniform partial ratings', async t => {
  for (const [type, expected, assessedWeight] of [
    ['common-app', 64.7, 85], ['why-major', 63.2, 85],
    ['why-school', 63.2, 85], ['supplement', 61.7, 75]
  ]) {
    const { session, record } = await createRecord(t, [null, 3, 2, 4, 1, 3], type, 'missing');
    const result = await reviewBenchmark(policyRoot, session, record);
    assert.deepEqual(result.percentage, percentage('partial', null, expected, assessedWeight, 100 - assessedWeight));
    assert.equal(result.totalBand, null);
  }
});

test('independent: each profile uses its own weights for full ratings', async t => {
  for (const [type, expected] of [
    ['common-app', 50], ['why-major', 45], ['why-school', 45], ['supplement', 42.5]
  ]) {
    const { session, record } = await createRecord(t, [0, 1, 2, 3, 4, 3], type);
    const result = await reviewBenchmark(policyRoot, session, record);
    assert.deepEqual(result.percentage, percentage('full', expected, expected, 100, 0));
  }
});

test('independent: calculation output cannot be injected into strict review input', async t => {
  const { session, record } = await createRecord(t, [3, 3, 3, 3, 3, 3]);
  for (const field of [
    { percentage: percentage('full', 100, 100, 100, 0) },
    { scoreReportingVersion: '1.0.0' },
    { fullScore100: 100 }, { assessedScore100: 100 }
  ]) {
    assert.throws(() => benchmarkReviewSchema.parse({ ...record, ...field }));
    await assert.rejects(reviewBenchmark(policyRoot, session, { ...record, ...field }));
  }
  const noninteger = structuredClone(record);
  noninteger.dimensions[0].level = 3.5;
  await assert.rejects(reviewBenchmark(policyRoot, session, noninteger));
  const weight = structuredClone(record);
  weight.dimensions[0].weight = 0;
  await assert.rejects(reviewBenchmark(policyRoot, session, weight), { code: 'benchmark-review-dimensions' });
});

test('independent: additive score reporting preserves historical rubric bindings and session bytes', async t => {
  const { session, record, prepared } = await createRecord(t, [3, 3, 3, 3, 3, 3]);
  const before = await sessionDigest(session);
  const catalog = getEssayQualityBenchmark();
  assert.equal(catalog.rubricVersion, '1.0.0');
  assert.equal(catalog.rubricHash, historicalRubricHash);
  assert.equal(prepared.bindings.rubricHash, historicalRubricHash);
  const result = await reviewBenchmark(policyRoot, session, record);
  assert.deepEqual(result.bindings, prepared.bindings);
  assert.equal(result.admissionsOutcomePredicted, false);
  assert.equal(result.detectorReplicated, false);
  assert.equal(result.voiceCertified, false);
  assert.equal(result.containsDocumentText, false);
  assert.ok(!JSON.stringify(result).includes('latch'));
  assert.deepEqual(await sessionDigest(session), before);
});

test('independent: CLI returns explicit partial coverage while leaving full total null', async t => {
  const { dir, session, record } = await createRecord(t, [null, 3, 2, 3, 3, 3], 'common-app', 'unselected');
  const reviewFile = join(dir, 'review.json');
  await writeFile(reviewFile, JSON.stringify(record));
  const run = spawnSync(process.execPath, ['dist/cli.js', 'review-benchmark', '--session', session,
    '--review-file', reviewFile], { cwd: policyRoot, encoding: 'utf8', maxBuffer: 4_000_000 });
  assert.equal(run.status, 3, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.percentage, percentage('partial', null, 69.1, 85, 15));
  assert.equal(result.totalBand, null);
  assert.ok(!run.stdout.includes('latch'));
});
