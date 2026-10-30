import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { importSession, prepareAssessmentReview, reviewAssessment, assessmentReviewSchema,
  prepareBenchmarkReview, reviewBenchmark, getEssayAssessmentProtocol,
  getEssayQualityBenchmark } from '../dist/index.js';

// Every passage and judgment in this file is synthetic. These are protocol tests,
// not evidence that a particular essay or manual rating deserves a given level.
const root = resolve('.');
const passage = 'I fixed the clasp on a box for my cousin. She wanted the box to close without losing its worn lid. I kept the lid and changed the clasp. Why the handle still catches remains unresolved.';
const expectedWeights = {
  'common-app': [15, 25, 20, 15, 15, 10],
  'why-major': [15, 35, 20, 10, 15, 5],
  'why-school': [15, 35, 20, 10, 15, 5],
  supplement: [25, 25, 20, 10, 15, 5]
};

async function fixture(t, essayType = 'common-app') {
  const dir = await mkdtemp(join(tmpdir(), 'assessment-calibration-independent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.txt'), out = join(dir, 'session');
  await writeFile(input, passage);
  await importSession(root, { input, out, context: {
    language: 'en', genre: 'personal-narrative', authorRole: 'student', audience: 'reader',
    prompt: 'Describe a choice and explain what matters to you about it.'
  } });
  const profile = { essayType, promptStatus: 'supplied',
    ...(essayType === 'supplement' ? { task: 'Describe the personal choice.' } : {}) };
  const prepared = await prepareAssessmentReview(root, out, profile);
  const r = structuredClone(prepared.template);
  const block = prepared.document.blocks[0];
  const span = { blockId: block.id, start: 0, end: Array.from(block.text).length, quote: block.text };
  r.benchmarkReview.reviewerId = 'Independent synthetic calibration reader';
  r.benchmarkReview.dimensions.forEach(d => Object.assign(d, {
    level: 3, reason: 'This synthetic reader records a specific supported answer.',
    limitation: 'One small experience does not establish a general trait across contexts.',
    retainCounterexample: 'The actual task can be completed through one ordinary choice.', decision: 'retain'
  }));
  r.benchmarkReview.checks.forEach(c => Object.assign(c, {
    status: c.checkId === 'school-facts' && essayType !== 'why-school' ? 'not-applicable' : 'clear',
    reason: 'Synthetic evidence declaration only.',
    ...(c.checkId === 'school-facts' && essayType === 'why-school'
      ? { officialSources: [{ url: 'https://example.edu/program', checkedAt: '2026-10-20' }] } : {})
  }));
  r.benchmarkReview.recommendation = 'adopt';
  r.reading = { task: 'Explain the personal choice and its reason.',
    readerUnderstanding: 'The writer preferred preserving a particular lid while repairing its clasp.',
    anchors: [span], applicationRoleOrLimitation: 'No other application materials were provided.', questions: [] };
  r.calibration = {
    taskValue: 'The small choice gives the reader a concrete preference relevant to this prompt.',
    evidenceLimits: 'The passage supports this choice; it does not establish a stable trait across situations.',
    presentationVsContent: 'Clear prose makes the preference readable but adds no evidence about the writer.',
    highestLevelJustifications: []
  };
  r.target = { school: null, applicantContext: 'Synthetic context.', minimumScore100: 75,
    rationale: 'The synthetic advisor accepts this task at the declared target.' };
  r.acceptance = { decision: 'accepted', byRole: 'advisor', sourceRef: 'Synthetic acceptance', acceptedIssueIds: [] };
  r.readiness.forEach(c => Object.assign(c, {
    status: c.checkId === 'school-facts' && essayType !== 'why-school' ? 'not-applicable' : 'clear',
    reason: 'Synthetic declaration only.', sourceRef: 'Synthetic source'
  }));
  return { r, out, prepared, profile };
}

function setHighest(record, dimensions) {
  record.benchmarkReview.dimensions.forEach(d => { d.level = dimensions.includes(d.dimensionId) ? 4 : 3; });
  record.calibration.highestLevelJustifications = dimensions.map(dimensionId => ({ dimensionId,
    whyAboveLevel3: `The synthetic reader explicitly distinguishes full support from clear support for ${dimensionId}.`,
    counterevidenceOrLimit: 'This declaration is a manual comparison, with the same single-experience limits still visible.'
  }));
}

async function digest(dir) {
  const entries = [];
  async function walk(path, relative = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name), key = relative + entry.name;
      if (entry.isDirectory()) await walk(next, key + '/');
      else entries.push([key, createHash('sha256').update(await readFile(next)).digest('hex')]);
    }
  }
  await walk(dir);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

test('calibration independent: protocol advances separately from the unchanged numeric rubric', () => {
  const catalog = getEssayQualityBenchmark(), protocol = getEssayAssessmentProtocol();
  assert.equal(protocol.protocolVersion, '1.1.0');
  assert.equal(protocol.protocol.version, '1.1.0');
  assert.match(protocol.protocolHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(catalog.assessmentProtocol, protocol);
  assert.equal(catalog.rubricVersion, '1.0.0');
  assert.equal(catalog.rubricHash, 'a1afb522d90c9e5e348946f4abcf633e7b06c4e0c13a33bcdcbb48a0c77f88fe');
  assert.equal(catalog.scoreReportingVersion, '1.0.0');
  for (const profile of catalog.rubric.profiles) assert.deepEqual(profile.weights, expectedWeights[profile.essayType]);
});

test('calibration independent: prepare provides an explicit calibration shell without inventing judgments', async t => {
  const { out, profile, prepared } = await fixture(t);
  const before = await digest(out), second = await prepareAssessmentReview(root, out, profile);
  assert.deepEqual(second, prepared);
  assert.equal(prepared.template.schemaVersion, '1.1.0');
  assert.deepEqual(prepared.template.calibration, {
    taskValue: '', evidenceLimits: '', presentationVsContent: '', highestLevelJustifications: []
  });
  assert.ok(prepared.template.benchmarkReview.dimensions.every(d => d.level === null));
  assert.deepEqual(await digest(out), before);
});

test('calibration independent: calibration is mandatory and each note must be nonblank', async t => {
  const { r, out } = await fixture(t);
  assert.equal((await reviewAssessment(root, out, r)).benchmark.percentage.fullScore100, 75);
  const omitted = structuredClone(r); delete omitted.calibration;
  assert.equal(assessmentReviewSchema.safeParse(omitted).success, false);
  for (const field of ['taskValue', 'evidenceLimits', 'presentationVsContent', 'highestLevelJustifications']) {
    const missing = structuredClone(r); delete missing.calibration[field];
    assert.equal(assessmentReviewSchema.safeParse(missing).success, false, field);
  }
  for (const field of ['taskValue', 'evidenceLimits', 'presentationVsContent']) {
    const blank = structuredClone(r); blank.calibration[field] = '  \n\t ';
    assert.equal(assessmentReviewSchema.safeParse(blank).success, false, field);
  }
});

test('calibration independent: no highest-level ratings require an empty justification set', async t => {
  const { r, out } = await fixture(t);
  const result = await reviewAssessment(root, out, r);
  assert.equal(result.benchmark.percentage.fullScore100, 75);
  assert.equal(result.editorialStatus, 'content-accepted');
  assert.equal(result.schemaVersion, '1.1.0');
  assert.equal(result.authorshipCertified, false);
  assert.equal(result.submissionAuthorized, false);
  r.calibration.highestLevelJustifications = [{ dimensionId: 'genre-task',
    whyAboveLevel3: 'An entry for a level that was never awarded.', counterevidenceOrLimit: 'Still synthetic.' }];
  await assert.rejects(reviewAssessment(root, out, r), { code: 'assessment-calibration' });
});

test('calibration independent: one ordinary experience remains eligible for an explicitly justified highest level', async t => {
  const { r, out } = await fixture(t);
  setHighest(r, ['genre-task']);
  r.calibration.highestLevelJustifications[0].whyAboveLevel3 =
    'The choice between replacing the lid and changing the clasp makes this answer specific to its writer; no further scene is required by this prompt.';
  const result = await reviewAssessment(root, out, r);
  assert.equal(result.benchmark.percentage.fullScore100, 81.3);
  assert.equal(result.benchmark.dimensions.find(d => d.dimensionId === 'genre-task').level, 4);
  assert.equal(result.benchmark.judgmentsVerified, false);
});

test('calibration independent: all six highest levels accept six distinct justifications in any order', async t => {
  const { r, out } = await fixture(t);
  setHighest(r, r.benchmarkReview.dimensions.map(d => d.dimensionId));
  r.calibration.highestLevelJustifications.reverse();
  const result = await reviewAssessment(root, out, r);
  assert.equal(result.benchmark.percentage.fullScore100, 100);
  assert.deepEqual(result.benchmark.totalBand, { min: 95, max: 100, maxInclusive: true });
});

test('calibration independent: every highest-level dimension requires its own comparison', async t => {
  const { r, out } = await fixture(t);
  const dimensions = r.benchmarkReview.dimensions.map(d => d.dimensionId);
  setHighest(r, dimensions);
  for (const missing of dimensions) {
    const candidate = structuredClone(r);
    candidate.calibration.highestLevelJustifications = candidate.calibration.highestLevelJustifications.filter(j => j.dimensionId !== missing);
    await assert.rejects(reviewAssessment(root, out, candidate), { code: 'assessment-calibration' }, missing);
  }
});

test('calibration independent: duplicate justification cannot replace a missing highest-level dimension', async t => {
  const { r, out } = await fixture(t);
  setHighest(r, ['prompt-selection', 'genre-task']);
  r.calibration.highestLevelJustifications[1] = structuredClone(r.calibration.highestLevelJustifications[0]);
  await assert.rejects(reviewAssessment(root, out, r), { code: 'assessment-calibration' });
});

test('calibration independent: duplicate justification is rejected even when all highest dimensions are covered', async t => {
  const { r, out } = await fixture(t);
  setHighest(r, ['genre-task']);
  r.calibration.highestLevelJustifications.push(structuredClone(r.calibration.highestLevelJustifications[0]));
  await assert.rejects(reviewAssessment(root, out, r), { code: 'assessment-calibration' });
});

test('calibration independent: justification for an unrated or lower dimension is rejected', async t => {
  const { r, out } = await fixture(t);
  setHighest(r, ['genre-task']);
  for (const level of [null, 0, 1, 2, 3]) {
    const candidate = structuredClone(r); candidate.benchmarkReview.dimensions.find(d => d.dimensionId === 'genre-task').level = level;
    await assert.rejects(reviewAssessment(root, out, candidate), { code: 'assessment-calibration' }, String(level));
  }
});

test('calibration independent: highest-level entries reject missing, blank, unknown and surplus fields', async t => {
  const { r } = await fixture(t);
  setHighest(r, ['genre-task']);
  for (const key of ['dimensionId', 'whyAboveLevel3', 'counterevidenceOrLimit']) {
    const missing = structuredClone(r); delete missing.calibration.highestLevelJustifications[0][key];
    assert.equal(assessmentReviewSchema.safeParse(missing).success, false, key);
  }
  for (const key of ['whyAboveLevel3', 'counterevidenceOrLimit']) {
    const blank = structuredClone(r); blank.calibration.highestLevelJustifications[0][key] = ' \t\n ';
    assert.equal(assessmentReviewSchema.safeParse(blank).success, false, key);
  }
  const unknown = structuredClone(r); unknown.calibration.highestLevelJustifications[0].dimensionId = 'personality';
  assert.equal(assessmentReviewSchema.safeParse(unknown).success, false);
  const extra = structuredClone(r); extra.calibration.highestLevelJustifications[0].automaticTraitScore = 4;
  assert.equal(assessmentReviewSchema.safeParse(extra).success, false);
});

for (const essayType of Object.keys(expectedWeights)) test(`calibration independent: ${essayType} preserves score arithmetic and legacy benchmark records`, async t => {
  const { r, out, profile } = await fixture(t, essayType);
  const prepared = await prepareBenchmarkReview(root, out, profile);
  assert.deepEqual(r.benchmarkReview.bindings, prepared.bindings);
  assert.deepEqual(r.benchmarkReview.dimensions.map(d => d.weight), expectedWeights[essayType]);
  const historical = await reviewBenchmark(root, out, r.benchmarkReview);
  const current = await reviewAssessment(root, out, r);
  assert.equal(historical.percentage.fullScore100, 75);
  assert.deepEqual(current.benchmark, historical);
  assert.equal('calibration' in r.benchmarkReview, false);
});

test('calibration independent: calibration edits change the record binding without inflating manual ratings', async t => {
  const { r, out } = await fixture(t);
  const before = await reviewAssessment(root, out, r);
  r.calibration.presentationVsContent = 'Additional smooth wording could improve readability; it cannot prove care, curiosity, or an enduring habit.';
  r.calibration.taskValue = 'A single choice can answer the task without establishing several independent personality traits.';
  const after = await reviewAssessment(root, out, r);
  assert.notEqual(after.recordHash, before.recordHash);
  assert.deepEqual(after.benchmark, before.benchmark);
});

test('calibration independent: stale protocol inputs and invalid reviews do not rewrite the session', async t => {
  const { r, out } = await fixture(t), before = await digest(out);
  const old = structuredClone(r); old.protocolVersion = '1.0.0';
  assert.equal(assessmentReviewSchema.safeParse(old).success, false);
  const stale = structuredClone(r); stale.protocolHash = '0'.repeat(64);
  await assert.rejects(reviewAssessment(root, out, stale), { code: 'assessment-stale' });
  const invalid = structuredClone(r); setHighest(invalid, ['genre-task']); invalid.calibration.highestLevelJustifications = [];
  await assert.rejects(reviewAssessment(root, out, invalid), { code: 'assessment-calibration' });
  await reviewAssessment(root, out, r);
  assert.deepEqual(await digest(out), before);
});

test('calibration independent: legacy SDK replay remains available while current CLI rejects the historical rubric', async t => {
  const { r, out } = await fixture(t);
  setHighest(r, ['genre-task']);
  const reviewFile = join(out, '..', 'review.json'); await writeFile(reviewFile, JSON.stringify(r));
  const expected = await reviewAssessment(root, out, r), before = await digest(out);
  const result = spawnSync(process.execPath, ['dist/cli.js', 'review-assessment', '--session', out, '--review-file', reviewFile],
    { cwd: root, encoding: 'utf8', maxBuffer: 4_000_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stderr).error, 'historical-common-app-rubric');
  assert.equal(result.stdout, '');
  assert.equal(result.stdout.includes(passage), false);
  assert.equal(expected.containsDocumentText, false);
  assert.equal(expected.submissionAuthorized, false);
  assert.deepEqual(await digest(out), before);
});
