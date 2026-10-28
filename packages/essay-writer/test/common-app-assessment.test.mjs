import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { contextSchema, hashValue } from '@mantou/text-quality';
import { importSession, prepareCommonAppAssessment, reviewCommonAppAssessment, reviewCurrentAssessment, getCommonAppBenchmark } from '../dist/index.js';

const root = resolve('.');
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'common-app-v2-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'synthetic.txt'), session = join(dir, 'session');
  await writeFile(input, 'I kept the box. '.repeat(160));
  await importSession(root, { input, out: session, context: contextSchema.parse({ language: 'en', genre: 'personal-narrative',
    authorRole: 'student', audience: 'Synthetic evaluator', stage: 'clean-draft', prompt: 'Describe this synthetic repair.',
    length: { unit: 'english-words', min: 635, max: 650 } }) });
  const p = await prepareCommonAppAssessment(root, session, { essayType: 'common-app', promptStatus: 'supplied' });
  const r = structuredClone(p.template), text = p.document.blocks[0].text;
  const anchor = { blockId: p.document.blocks[0].id, start: 0, end: text.length, quote: text };
  r.reviewer.id = 'Synthetic arithmetic evaluator';
  Object.assign(r.storyDiagnosis, { personalStakes: 'Synthetic personal stakes.', verdict: 'sufficient', reason: 'Synthetic selection declaration.' });
  r.storyDiagnosis.paragraphProgression.forEach(p => Object.assign(p, { function: 'Synthetic action.', addedUnderstanding: 'Synthetic actor.', status: 'distinct', reason: 'Contract fixture only.' }));
  Object.assign(r.storyDiagnosis.development, { kind: 'stable-character', initialPosition: 'Synthetic stable position.', testEvidence: [anchor], responseAndScope: 'Synthetic limited position.', status: 'supported' });
  Object.assign(r.storyDiagnosis.turn, { setup: 'No turn required.', actual: 'Synthetic continuity.', contribution: 'Ordinary continuity is valid.' });
  r.reading = { task: 'Synthetic task.', personUnderstood: 'Synthetic action only.', causalChain: 'Synthetic causal declaration.',
    keyActions: 'Synthetic action declaration.', questions: [], evidenceLimits: 'No real student.', presentationVsContent: 'No real quality claims.', anchors: [anchor] };
  r.items.forEach((item, i) => Object.assign(item, { score: p.rubric.items[i].max, anchors: [anchor], bandReason: 'Synthetic full-band declaration.',
    nextBandCondition: 'This is the maximum of the synthetic item.', limitation: 'No real quality certified.',
    fullMarkTest: { positiveProof: 'Synthetic asserted completion.', counterReading: 'Synthetic alternate reading.', whyFourInsufficient: 'Synthetic distinction beyond four.' } }));
  r.bonusBasis = { route: 'insight', observation: 'Synthetic observation.', inference: 'Synthetic inference.', contribution: 'Synthetic additional understanding.' };
  r.criticalChecks.forEach(check => Object.assign(check, { status: 'clear', reason: 'Synthetic declaration.', anchors: [anchor] }));
  r.target.rationale = 'No actual target.'; r.acceptance.sourceRef = 'Synthetic fixture, not accepted.';
  r.readiness.forEach(check => Object.assign(check, { status: 'clear', reason: 'Synthetic declaration.', sourceRef: 'Synthetic fixture.' }));
  return { r, session, anchor };
}
test('current v2 rubric contains 19 main criteria and one holistic extra with 120 integer bands', () => {
  const r = getCommonAppBenchmark();
  assert.equal(r.items.length, 20); assert.equal(r.items.reduce((n, item) => n + item.levels.length, 0), 120);
  assert.equal(r.items.slice(0, 19).reduce((n, item) => n + item.max, 0), 95);
  assert.equal(r.items[19].max, 5); assert.equal(r.qualityFloor, 83); assert.equal(r.criticalMinimum, 4);
});
test('v2 binds complete instructions, constructed examples, core conditions and full-mark distinctions', () => {
  const r = getCommonAppBenchmark();
  assert.equal(r.version, 'judgment-evidence-95plus5-2.1');
  assert.equal(r.assessmentVersion, 'judgment-evidence-assessment@3');
  r.items.forEach(item => { assert.ok(item.scope.trim()); assert.ok(item.boundary.includes('4到5')); });
  assert.ok(r.protocolSections.join('\n').includes('构造练习'));
  assert.ok(r.instructions.some(text => text.includes('Main maximum 95')));
  const { rubricHash, assessmentVersion, ...payload } = r;
  assert.equal(hashValue(payload), rubricHash);
  const changed = structuredClone(payload); changed.protocolSections[0] += ' changed';
  assert.notEqual(hashValue(changed), rubricHash);
});
test('a caller cannot mutate the canonical rule packet returned to later readers', () => {
  const before = getCommonAppBenchmark(), hash = before.rubricHash;
  before.protocolSections[0] += ' changed';
  before.items[0].levels[0].description = 'changed';
  before.instructions[0] = 'changed';
  const after = getCommonAppBenchmark();
  assert.equal(after.rubricHash, hash);
  assert.notEqual(after.items[0].levels[0].description, 'changed');
});
test('one holistic extra adds at most five and a plain zero-extra draft can score 95', async t => {
  const f = await fixture(t);
  assert.deepEqual((await reviewCommonAppAssessment(root, f.session, f.r)).score.total, 100);
  Object.assign(f.r.items[19], { score: 0, fullMarkTest: null });
  f.r.bonusBasis = { route: 'none', finding: 'No additional understanding in this synthetic case.' };
  const s = (await reviewCommonAppAssessment(root, f.session, f.r)).score;
  assert.equal(s.base, 95); assert.equal(s.bonusRaw, 0); assert.equal(s.bonusCounted, 0); assert.equal(s.total, 95);
});
test('unrated evidence never becomes zero or a normalized full score', async t => {
  const f = await fixture(t); f.r.items[0].score = null; f.r.items[0].fullMarkTest = null; f.r.items[0].unratedReason = 'This test deliberately leaves one judgment unassessed.';
  const s = (await reviewCommonAppAssessment(root, f.session, f.r)).score;
  assert.equal(s.base, null); assert.equal(s.total, null); assert.equal(s.assessedItems, 19);
});
test('positive and reading evidence reject whitespace-only spans', async t => {
  const f = await fixture(t), a = { blockId: f.anchor.blockId, start: 1, end: 2, quote: ' ' };
  f.r.items[0].anchors = [a];
  await assert.rejects(reviewCommonAppAssessment(root, f.session, f.r), { code: 'assessment-span' });
  f.r.items[0].anchors = [f.anchor]; f.r.reading.anchors = [a];
  await assert.rejects(reviewCommonAppAssessment(root, f.session, f.r), { code: 'assessment-span' });
});
test('a positive extra cannot claim that no effective route exists', async t => {
  const f = await fixture(t); f.r.bonusBasis = { route: 'none', finding: 'Synthetic absent extra.' };
  await assert.rejects(reviewCommonAppAssessment(root, f.session, f.r), { code: 'assessment-bonus-basis' });
});
test('an unavailable sole comparison basis leaves the holistic extra unassessed', async t => {
  const f = await fixture(t);
  Object.assign(f.r.items[19], { score: null, fullMarkTest: null, unratedReason: 'The only proposed route lacks a comparison source.' });
  f.r.bonusBasis = { route: 'unassessed', reason: 'The comparison source is missing.' };
  assert.equal((await reviewCommonAppAssessment(root, f.session, f.r)).score.total, null);
});
test('relative-experience requires a comparison source while other supported routes remain available', async t => {
  const f = await fixture(t);
  const supported = structuredClone(f.r.bonusBasis);
  f.r.bonusBasis = { route: 'relative-experience', commonPath: 'Synthetic usual path.', difference: 'Synthetic difference.',
    comparisonLimits: 'Not a real rarity claim.', contribution: 'Synthetic extra.' };
  await assert.rejects(reviewCommonAppAssessment(root, f.session, f.r));
  f.r.bonusBasis = supported;
  assert.equal((await reviewCommonAppAssessment(root, f.session, f.r)).score.total, 100);
});
test('the daily router isolates both integer v1 rubrics as historical instead of converting them', async t => {
  const f = await fixture(t); f.r.schemaVersion = '75+25-assessment@1';
  for (const version of ['75+25-point-benchmarks-1.0', '75+25-point-benchmarks-1.1']) {
    f.r.rubricVersion = version;
    await assert.rejects(reviewCurrentAssessment(root, f.session, f.r), { code: 'historical-common-app-rubric' });
  }
});
test('v2 rejects stale body and rubric bindings', async t => {
  const f = await fixture(t), original = structuredClone(f.r);
  f.r.bindings.documentHash = '0'.repeat(64);
  await assert.rejects(reviewCommonAppAssessment(root, f.session, f.r), { code: 'assessment-stale' });
  original.rubricHash = '0'.repeat(64);
  await assert.rejects(reviewCommonAppAssessment(root, f.session, original), { code: 'assessment-stale' });
});
