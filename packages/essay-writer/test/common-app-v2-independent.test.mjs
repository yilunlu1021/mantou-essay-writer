import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { contextSchema, countText, hashValue } from '@mantou/text-quality';
import {
  COMMON_APP_ASSESSMENT_VERSION, COMMON_APP_RUBRIC_VERSION,
  COMMON_APP_QUALITY_FLOOR, COMMON_APP_CRITICAL_ITEMS,
  importSession, prepareCommonAppAssessment, prepareCurrentAssessmentReview,
  reviewCommonAppAssessment, reviewCurrentAssessment, getCommonAppBenchmark,
} from '../dist/index.js';

// These synthetic declarations test contracts only. They never certify text quality.
const root = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(root, '../..');
const expectedIds = [
  'P1.1', 'P1.2', 'P1.3', 'P1.4', 'P1.5',
  'C2.1', 'C2.2', 'C2.3', 'C2.4', 'C2.5',
  'E3.1', 'E3.2', 'E3.3', 'E3.4', 'E3.5',
  'N4.1', 'N4.2', 'V5.1', 'V5.2', 'X6.1',
];
const expectedCritical = ['P1.3', 'P1.5', 'C2.2', 'C2.3', 'C2.4', 'E3.1', 'E3.2', 'E3.3', 'E3.5', 'N4.1'];
let directory, session, prepared, anchor, initial;
const proof = () => ({ positiveProof: 'Synthetic positive declaration only.',
  counterReading: 'Synthetic alternate interpretation only.', whyFourInsufficient: 'Synthetic declared distinction from four.' });
function setItem(record, id, score) {
  const item = record.items.find(x => x.id === id);
  item.score = score;
  item.fullMarkTest = score === 5 ? proof() : null;
  item.unratedReason = score === null ? 'Deliberately unassessed in the synthetic case.' : '';
  item.absenceReason = score === 0 ? 'Synthetic observed absence.' : '';
  return item;
}
function fresh() { return structuredClone(initial); }
function totalRecord(total, bonus = 4) {
  const record = fresh();
  expectedIds.forEach(id => setItem(record, id, id === 'X6.1' ? bonus : 4));
  let difference = total - 76 - bonus;
  for (const id of expectedIds.slice(0, 19)) {
    if (!difference) break;
    const amount = Math.min(1, difference);
    setItem(record, id, 4 + amount); difference -= amount;
  }
  assert.equal(difference, 0, 'The synthetic score helper must reach the exact requested total.');
  record.bonusBasis = bonus ? { route: 'insight', observation: 'Synthetic observation.',
    inference: 'Synthetic inference.', contribution: 'Synthetic additional understanding.' }
    : { route: 'none', finding: 'No extra route in this deliberately plain synthetic case.' };
  return record;
}
const review = record => reviewCommonAppAssessment(root, session, record);
const rejects = (record, code) => assert.rejects(review(record), code ? { code } : undefined);

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'common-app-v2-independent-'));
  const input = join(directory, 'synthetic.txt'); session = join(directory, 'session');
  const text = Array.from({ length: 8 }, () => 'I kept the box. '.repeat(20).trim()).join('\n\n');
  assert.equal(countText(text).englishWords, 640);
  await writeFile(input, text);
  await importSession(root, { input, out: session, context: contextSchema.parse({ language: 'en', genre: 'personal-narrative',
    authorRole: 'student', audience: 'Independent synthetic evaluator', stage: 'clean-draft',
    prompt: 'Describe a synthetic choice.', length: { unit: 'english-words', min: 635, max: 650 } }) });
  prepared = await prepareCommonAppAssessment(root, session, { essayType: 'common-app', promptStatus: 'supplied' });
  const block = prepared.document.blocks[0];
  anchor = { blockId: block.id, start: 0, end: Array.from(block.text).length, quote: block.text };
  initial = structuredClone(prepared.template);
  initial.reviewer.id = 'Independent synthetic evaluator';
  Object.assign(initial.storyDiagnosis, { personalStakes: 'Synthetic personal stakes.', verdict: 'sufficient', reason: 'Synthetic selection declaration.' });
  initial.storyDiagnosis.paragraphProgression.forEach(p => Object.assign(p, { function: 'Synthetic action.', addedUnderstanding: 'Synthetic actor.', status: 'distinct', reason: 'Contract fixture only.' }));
  Object.assign(initial.storyDiagnosis.development, { kind: 'stable-character', initialPosition: 'Synthetic stable position.', testEvidence: [anchor], responseAndScope: 'Synthetic limited position.', status: 'supported' });
  Object.assign(initial.storyDiagnosis.turn, { setup: 'No turn required.', actual: 'Synthetic continuity.', contribution: 'Ordinary continuity is valid.' });
  Object.assign(initial.reading, { task: 'Synthetic contract task.', personUnderstood: 'No real person evaluated.',
    causalChain: 'Synthetic relation, not a semantic certification.', keyActions: 'Synthetic action declaration.',
    evidenceLimits: 'Repetitive fixture cannot establish actual writing quality.', presentationVsContent: 'Arithmetic and gates only.', anchors: [anchor] });
  initial.items.forEach(item => Object.assign(item, { score: 5, anchors: [anchor], bandReason: 'Synthetic asserted band.',
    nextBandCondition: 'Synthetic next-band declaration.', limitation: 'No real quality certified.', fullMarkTest: proof() }));
  initial.bonusBasis = { route: 'insight', observation: 'Synthetic observation.', inference: 'Synthetic inference.', contribution: 'Synthetic extra contribution.' };
  initial.criticalChecks.forEach(check => Object.assign(check, { status: 'clear', reason: 'Synthetic asserted check.', anchors: [anchor] }));
  initial.target.rationale = 'Synthetic threshold test; no real application target.';
  initial.acceptance.sourceRef = 'Synthetic source; acceptance remains proposed.';
  initial.readiness.forEach(check => Object.assign(check, { reason: 'Synthetic declaration.', sourceRef: 'Synthetic test source.' }));
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('v2 independent: versions, exact 20-item order, 120 integer bands and group maxima', () => {
  const rubric = getCommonAppBenchmark();
  assert.equal(COMMON_APP_ASSESSMENT_VERSION, 'judgment-evidence-assessment@3');
  assert.equal(COMMON_APP_RUBRIC_VERSION, 'judgment-evidence-95plus5-2.1');
  assert.equal(COMMON_APP_QUALITY_FLOOR, 83);
  assert.deepEqual(rubric.items.map(x => x.id), expectedIds);
  assert.equal(rubric.items.reduce((sum, item) => sum + item.levels.length, 0), 120);
  rubric.items.forEach(item => { assert.equal(item.max, 5); assert.deepEqual(item.levels.map(x => x.score), [0, 1, 2, 3, 4, 5]); });
  assert.deepEqual(['P1', 'C2', 'E3', 'N4', 'V5', 'X6'].map(group => rubric.items.filter(x => x.group === group).reduce((n, x) => n + x.max, 0)), [25, 25, 25, 10, 10, 5]);
  assert.deepEqual([...rubric.criticalItems], expectedCritical);
  assert.deepEqual(rubric.items.filter(x => x.criticalMinimum === 4).map(x => x.id), expectedCritical);
  assert.equal(rubric.baseMax, 95); assert.equal(rubric.bonusRawMax, 5); assert.equal(rubric.bonusCap, 5); assert.equal(rubric.totalMax, 100);
});
test('v2 independent: frozen protocol and all 120 bands agree with the canonical guide', async () => {
  const guide = await readFile(join(repo, 'docs/benchmarks/common-app-judgment-evidence-v2.md'), 'utf8');
  const rubric = getCommonAppBenchmark();
  assert.equal(rubric.protocolSections.join('\n').trim(), guide.trim());
  for (const item of rubric.items) {
    const section = guide.split(`### ${item.id} `)[1]?.split('\n### ')[0];
    assert.ok(section, `Missing guide section ${item.id}`);
    for (const level of item.levels) assert.ok(section.includes(`${level.score}：${level.description}`), `${item.id}/${level.score} diverges from guide`);
  }
  const { rubricHash, assessmentVersion, ...payload } = rubric;
  assert.equal(hashValue(payload), rubricHash);
  for (const field of ['qualityFloor', 'criticalMinimum', 'protocolVersion']) {
    const changed = structuredClone(payload); changed[field] = 'changed'; assert.notEqual(hashValue(changed), rubricHash);
  }
});
test('v2 independent: prepared template is unscored and daily prepare selects v2', async () => {
  const current = await prepareCurrentAssessmentReview(root, session, { essayType: 'common-app', promptStatus: 'supplied' });
  assert.equal(current.schemaVersion, 'judgment-evidence-assessment@3');
  assert.equal(current.template.items.length, 20); assert.ok(current.template.items.every(x => x.score === null));
  assert.deepEqual(current.template.criticalChecks.map(x => x.id), ['causal-chain', 'action-evidence', 'first-read']);
  assert.equal(current.template.target.minimumScore100, 83); assert.equal(current.submissionAuthorized, false);
});
test('v2 independent: all maximums produce 95 + 5 = 100 without certifying semantics', async () => {
  const result = await review(fresh());
  assert.equal(result.score.base, 95); assert.equal(result.score.bonusRaw, 5); assert.equal(result.score.bonusCounted, 5); assert.equal(result.score.total, 100);
  assert.equal(result.score.assessedItems, 20); assert.deepEqual(result.score.groups, { P1: 25, C2: 25, E3: 25, N4: 10, V5: 10, X6: 5 });
  assert.equal(result.qualityPassed, true); assert.equal(result.studentReviewEligible, true);
  for (const flag of ['reasoningCertified', 'sourceTruthVerified', 'authorshipCertified', 'humanApprovalVerified', 'submissionAuthorized', 'detectorReplicated']) assert.equal(result[flag], false);
  assert.equal(result.submissionStatus, 'blocked');
});
for (const total of [82, 83, 84]) test(`v2 independent: exact ${total} retains the fixed quality floor`, async () => {
  const result = await review(totalRecord(total));
  assert.equal(result.score.total, total); assert.equal(result.qualityPassed, total >= 83); assert.equal(result.studentReviewEligible, total >= 83);
  assert.equal(result.qualityBlockers.includes('below-quality-floor-83'), total < 83);
});
test('v2 independent: all main fours plus five extra cannot reach 83', async () => {
  const record = fresh(); expectedIds.slice(0, 19).forEach(id => setItem(record, id, 4));
  const result = await review(record); assert.equal(result.score.total, 81); assert.equal(result.studentReviewEligible, false);
});
test('v2 independent: an ordinary case with zero extra can reach 83 or main maximum 95', async () => {
  const a = await review(totalRecord(83, 0)); assert.equal(a.score.base, 83); assert.equal(a.score.total, 83); assert.equal(a.studentReviewEligible, true);
  const record = fresh(); setItem(record, 'X6.1', 0); record.bonusBasis = { route: 'none', finding: 'No effective extra route.' };
  const b = await review(record); assert.equal(b.score.total, 95); assert.equal(b.studentReviewEligible, true);
});
for (const id of expectedIds) test(`v2 independent: unassessed ${id} leaves total null`, async () => {
  const record = fresh(); setItem(record, id, null);
  if (id === 'X6.1') record.bonusBasis = { route: 'unassessed', reason: 'Missing comparison in the only proposed route.' };
  const result = await review(record);
  assert.equal(result.score.total, null); assert.equal(result.score.assessedItems, 19); assert.deepEqual(result.score.unratedItems, [id]);
  assert.equal(result.qualityPassed, false); assert.equal(result.studentReviewEligible, false); assert.ok(result.qualityBlockers.includes('incomplete-assessment'));
});
for (const id of expectedCritical) for (const score of [0, 1, 2, 3]) test(`v2 independent: ${id}=${score} cannot be compensated by all other maxima`, async () => {
  const record = fresh(); setItem(record, id, score);
  const result = await review(record); assert.equal(result.score.total, 95 + score); assert.ok(result.score.total >= 83);
  assert.equal(result.qualityPassed, false); assert.equal(result.studentReviewEligible, false); assert.deepEqual(result.criticalFailures, [id]);
});
for (const id of ['causal-chain', 'action-evidence', 'first-read']) for (const status of ['needs-rework', 'unverified'])
  test(`v2 independent: ${id}/${status} blocks despite 100`, async () => {
    const record = fresh(); record.criticalChecks.find(x => x.id === id).status = status;
    const result = await review(record); assert.equal(result.score.total, status === 'needs-rework' ? null : 100); assert.equal(result.score.declaredTotal, 100); assert.equal(result.scoreConsistency.verified, status !== 'needs-rework'); assert.equal(result.studentReviewEligible, false); assert.ok(result.qualityBlockers.includes(`critical-check-${id}`));
  });
test('v2 independent: critical check identity/order cannot be changed or duplicated', async () => {
  const record = fresh(); record.criticalChecks[1].id = record.criticalChecks[0].id; await rejects(record, 'assessment-critical-check');
});
test('v2 independent: a material first-reader question blocks and an optional question does not', async () => {
  const record = fresh(); record.reading.questions = [{ question: 'A deliberately material unanswered synthetic question.', material: true }];
  assert.ok((await review(record)).qualityBlockers.includes('material-reader-question'));
  record.reading.questions[0].material = false; assert.equal((await review(record)).qualityPassed, true);
});
function issue(severity = 'material', decision = 'retain-with-reason') {
  return { id: 'gap-1', itemIds: ['C2.3'], description: 'Synthetic explicitly declared gap.', anchors: [anchor], severity, decision, reason: 'Synthetic test.' };
}
for (const [severity, decision] of [['material', 'retain-with-reason'], ['optional', 'revise'], ['optional', 'needs-source']])
  test(`v2 independent: ${severity}/${decision} blocks quality`, async () => {
    const record = fresh(); record.issues = [issue(severity, decision)];
    const result = await review(record); assert.equal(result.studentReviewEligible, false); assert.ok(result.qualityBlockers.includes('material-issue-gap-1'));
  });
test('v2 independent: advisor acceptance cannot erase a material issue', async () => {
  const record = fresh(); record.issues = [issue()]; Object.assign(record.acceptance, { decision: 'accepted', byRole: 'advisor', acceptedIssueIds: ['gap-1'] });
  await rejects(record, 'assessment-acceptance');
});
test('v2 independent: an optional retained issue is separate from quality and content adoption', async () => {
  const record = fresh(); record.issues = [issue('optional')];
  const result = await review(record); assert.equal(result.qualityPassed, true); assert.equal(result.studentReviewEligible, true); assert.equal(result.editorialStatus, 'quality-qualified');
});
for (const target of [0, 60, 82, 83, null]) test(`v2 independent: target ${target} never lowers the 83 floor`, async () => {
  const record = totalRecord(82); record.target.minimumScore100 = target;
  const result = await review(record); assert.equal(result.effectiveTarget, 83); assert.equal(result.targetMet, false); assert.equal(result.studentReviewEligible, false);
});
test('v2 independent: a higher revision target stays separate from student reading eligibility', async () => {
  const record = totalRecord(83); record.target.minimumScore100 = 90;
  const result = await review(record); assert.equal(result.effectiveTarget, 90); assert.equal(result.targetMet, false); assert.equal(result.studentReviewEligible, true);
});
test('v2 independent: student final review remains a final gate, not a first-reading prerequisite', async () => {
  const record = totalRecord(83);
  for (const status of ['unverified', 'issue']) {
    record.readiness.find(x => x.checkId === 'student-final-review').status = status;
    const result = await review(record); assert.equal(result.studentReviewEligible, true); assert.equal(result.submissionStatus, 'blocked');
  }
});
for (const id of ['prompt', 'source', 'authorship', 'professionalism', 'edit-authority', 'length-mechanics'])
  test(`v2 independent: a known ${id} readiness issue blocks student reading separately from raw quality`, async () => {
    const record = fresh(); record.readiness.find(x => x.checkId === id).status = 'issue';
    const result = await review(record); assert.equal(result.qualityPassed, true); assert.equal(result.studentReviewEligible, false); assert.ok(result.studentReviewBlockers.includes(`readiness-${id}`));
  });
const positiveBases = () => [
  { route: 'symbol', carrier: 'Synthetic carrier.', correspondence: 'Synthetic correspondence.', contribution: 'Additional synthetic understanding.' },
  { route: 'expectation', expected: 'Synthetic expectation.', establishedBy: [anchor], actual: 'Synthetic deviation.', contribution: 'Additional synthetic understanding.' },
  { route: 'insight', observation: 'Synthetic observation.', inference: 'Synthetic inference.', contribution: 'Additional synthetic understanding.' },
  { route: 'relative-experience', reference: { title: 'Synthetic comparator.', url: 'https://example.com/comparison', checkedAt: '2026-10-25', values: 'Synthetic declared comparison.' },
    commonPath: 'Synthetic common path.', difference: 'Synthetic difference.', comparisonLimits: 'Not an empirical rarity claim.', contribution: 'Additional synthetic understanding.' },
  { route: 'value-practice', value: 'Synthetic value.', choice: 'Synthetic choice.', method: 'Synthetic practice.', consequence: 'Synthetic consequence.', contribution: 'Additional synthetic understanding.' },
];
for (const route of ['symbol', 'expectation', 'insight', 'relative-experience', 'value-practice'])
  test(`v2 independent: one supported ${route} declaration permits exactly one holistic extra`, async () => {
    const record = fresh(); record.bonusBasis = positiveBases().find(x => x.route === route); setItem(record, 'X6.1', 3);
    if (route === 'expectation') Object.assign(record.storyDiagnosis.turn, { kind: 'reader-expectation', anchors: [anchor] });
    const result = await review(record); assert.equal(result.score.bonusCounted, 3); assert.equal(result.score.total, 98);
  });
for (const [score, route] of [[null, 'none'], [0, 'unassessed'], [0, 'insight'], [1, 'none'], [1, 'unassessed']])
  test(`v2 independent: extra score ${score} rejects inconsistent route ${route}`, async () => {
    const record = fresh(); setItem(record, 'X6.1', score);
    record.bonusBasis = route === 'none' ? { route, finding: 'Synthetic absence.' } : route === 'unassessed' ? { route, reason: 'Synthetic missing basis.' } : positiveBases().find(x => x.route === route);
    await rejects(record, 'assessment-bonus-basis');
  });
test('v2 independent: extra routes cannot stack or skip required comparison fields', async () => {
  const record = fresh(); record.bonusBasis = { ...positiveBases()[0], routes: positiveBases(), score: 5 }; await rejects(record);
  record.bonusBasis = positiveBases().find(x => x.route === 'relative-experience'); delete record.bonusBasis.reference; await rejects(record);
});
for (const field of ['positiveProof', 'counterReading', 'whyFourInsufficient']) test(`v2 independent: score five requires nonempty ${field}`, async () => {
  const record = fresh(); record.items[0].fullMarkTest[field] = '  '; await rejects(record);
});
test('v2 independent: fullMarkTest is required only for five, including the holistic extra', async () => {
  for (const id of ['P1.1', 'X6.1']) {
    const record = fresh(); record.items.find(x => x.id === id).fullMarkTest = null; await rejects(record, 'assessment-full-mark');
    setItem(record, id, 4); record.items.find(x => x.id === id).fullMarkTest = proof(); await rejects(record, 'assessment-full-mark');
  }
});
for (const score of [-1, 1.5, 6, '4']) test(`v2 independent: invalid score ${JSON.stringify(score)} is rejected`, async () => {
  const record = fresh(); record.items[0].score = score; await rejects(record);
});
test('v2 independent: exact length, order and uniqueness of all 20 items are enforced', async () => {
  const missing = fresh(); missing.items.pop(); await rejects(missing);
  const duplicate = fresh(); duplicate.items[1].id = duplicate.items[0].id; await rejects(duplicate, 'assessment-item');
  const reordered = fresh(); [reordered.items[0], reordered.items[1]] = [reordered.items[1], reordered.items[0]]; await rejects(reordered, 'assessment-item');
});
test('v2 independent: positive score requires evidence and a zero without quotes needs an absence reason', async () => {
  const record = fresh(); record.items[0].anchors = []; await rejects(record, 'assessment-evidence');
  setItem(record, 'P1.1', 0); record.items[0].absenceReason = ''; await rejects(record, 'assessment-evidence');
  record.items[0].absenceReason = 'Synthetic observed absence.'; assert.equal((await review(record)).score.total, 95);
});
test('v2 independent: quote mismatch, whitespace and foreign block references are rejected', async () => {
  for (const bad of [{ ...anchor, quote: 'not the quoted body' }, { ...anchor, blockId: 'foreign-block' }, { blockId: anchor.blockId, start: 1, end: 2, quote: ' ' }]) {
    const record = fresh(); record.items[0].anchors = [bad]; await rejects(record, 'assessment-span');
  }
});
test('v2 independent: reading, critical and expectation anchors are independently checked', async () => {
  const bad = { ...anchor, quote: 'synthetic mismatch' };
  const record = fresh(); record.reading.anchors = [bad]; await rejects(record, 'assessment-span');
  const other = fresh(); other.criticalChecks[0].anchors = [bad]; await rejects(other, 'assessment-span');
  const bonus = fresh(); bonus.bonusBasis = { ...positiveBases().find(x => x.route === 'expectation'), establishedBy: [bad] };
  Object.assign(bonus.storyDiagnosis.turn, { kind: 'reader-expectation', anchors: [anchor] }); await rejects(bonus, 'assessment-span');
});
for (const binding of ['sessionHash', 'versionHash', 'originalHash', 'documentHash', 'contextHash', 'policyHash'])
  test(`v2 independent: changed ${binding} is stale`, async () => {
    const record = fresh(); record.bindings[binding] = '0'.repeat(64); await rejects(record, 'assessment-stale');
  });
test('v2 independent: an outdated rubric hash is not converted', async () => {
  const record = fresh(); record.rubricHash = '0'.repeat(64); await rejects(record, 'assessment-stale');
});
for (const version of ['75+25-point-benchmarks-1.0', '75+25-point-benchmarks-1.1'])
  test(`v2 independent: ${version} remains historical at the daily entry`, async () => {
    const record = fresh(); record.schemaVersion = '75+25-assessment@1'; record.rubricVersion = version;
    await assert.rejects(reviewCurrentAssessment(root, session, record), { code: 'historical-common-app-rubric' });
  });
test('v2 independent: historical six-dimension Common App is refused by the daily entry', async () => {
  await assert.rejects(reviewCurrentAssessment(root, session, { benchmarkReview: { profile: { essayType: 'common-app' } } }), { code: 'historical-common-app-rubric' });
});
test('v2 independent: agent cannot self-certify human adoption', async () => {
  const record = fresh(); record.acceptance.decision = 'accepted'; await rejects(record, 'assessment-acceptance');
});
test('v2 independent: returned rubric and prepared objects cannot pollute later reads', async () => {
  const before = getCommonAppBenchmark(), hash = before.rubricHash;
  before.items[0].id = 'corrupted'; before.items[0].levels[0].description = 'corrupted';
  before.criticalItems.splice(0); before.protocolSections[0] = 'corrupted'; before.instructions[0] = 'corrupted';
  const after = getCommonAppBenchmark(); assert.equal(after.rubricHash, hash); assert.equal(after.items[0].id, 'P1.1'); assert.equal(after.criticalItems.length, 10);
  const packet = await prepareCommonAppAssessment(root, session, { essayType: 'common-app', promptStatus: 'supplied' });
  packet.rubric.items[0].levels[0].description = 'corrupted'; packet.template.items[0].id = 'corrupted';
  const later = await prepareCommonAppAssessment(root, session, { essayType: 'common-app', promptStatus: 'supplied' });
  assert.equal(later.rubric.rubricHash, hash); assert.equal(later.template.items[0].id, 'P1.1');
});
test('v2 independent: the public critical-item export cannot mutate the canonical gate', async () => {
  const baseline = [...COMMON_APP_CRITICAL_ITEMS], rubricHash = getCommonAppBenchmark().rubricHash;
  try {
    try { COMMON_APP_CRITICAL_ITEMS.splice(0); } catch (error) { assert.ok(error instanceof TypeError); }
    const newPacket = await prepareCommonAppAssessment(root, session, { essayType: 'common-app', promptStatus: 'supplied' });
    const record = fresh(); record.rubricHash = newPacket.rubricHash; setItem(record, 'C2.3', 3);
    const result = await review(record);
    assert.equal(result.studentReviewEligible, false, 'A consumer must not remove critical gates through an exported array.');
    assert.ok(result.criticalFailures.includes('C2.3'));
    assert.equal(getCommonAppBenchmark().rubricHash, rubricHash);
  } finally {
    if (!Object.isFrozen(COMMON_APP_CRITICAL_ITEMS)) COMMON_APP_CRITICAL_ITEMS.splice(0, COMMON_APP_CRITICAL_ITEMS.length, ...baseline);
  }
});
test('v2 independent: the exported data module cannot pollute the live criteria after initialization', async () => {
  const module = await import('../dist/common-app-v2-rubric-data.js');
  const before = structuredClone(module.COMMON_APP_V2_ITEMS), rubricHash = getCommonAppBenchmark().rubricHash;
  try {
    module.COMMON_APP_V2_ITEMS[0].id = 'corrupted-external-data';
    module.COMMON_APP_V2_ITEMS[0].levels[0].description = 'corrupted-external-data';
    module.COMMON_APP_V2_ITEMS[2].criticalMinimum = null;
    const rubric = getCommonAppBenchmark(); assert.equal(rubric.rubricHash, rubricHash); assert.equal(rubric.items[0].id, 'P1.1');
    const result = await review(fresh()); assert.equal(result.score.total, 100);
  } finally {
    module.COMMON_APP_V2_ITEMS.splice(0, module.COMMON_APP_V2_ITEMS.length, ...before);
  }
});
test('v2.1 independent: a stable-character story without a turn is a valid contract path', async () => {
  const result = await review(fresh()); assert.equal(result.qualityPassed, true);
});
test('v2.1 independent: all exact logical paragraphs require diagnosis in prepared order', async () => {
  const missing = fresh(); missing.storyDiagnosis.paragraphProgression.pop(); await rejects(missing, 'assessment-story-coverage');
  const reordered = fresh(); reordered.storyDiagnosis.paragraphProgression.reverse(); await rejects(reordered, 'assessment-story-coverage');
});
for (const status of ['repeats', 'unresolved']) test(`v2.1 independent: paragraph ${status} blocks raw 100`, async () => {
  const record = fresh(); record.storyDiagnosis.paragraphProgression[0].status = status;
  const result = await review(record); assert.equal(result.score.total, 100); assert.equal(result.qualityPassed, false); assert.equal(result.studentReviewEligible, false);
  assert.ok(result.qualityBlockers.includes(`story-paragraph-1-${status}`));
});
for (const status of ['needs-rework', 'unverified']) test(`v2.1 independent: story selection ${status} blocks raw 100`, async () => {
  const record = fresh(); record.storyDiagnosis.verdict = status;
  const result = await review(record); assert.equal(result.score.total, 100); assert.ok(result.qualityBlockers.includes('story-selection-not-sufficient'));
});
for (const status of ['needs-rework', 'unverified']) test(`v2.1 independent: story development ${status} blocks raw 100`, async () => {
  const record = fresh(); record.storyDiagnosis.development.status = status;
  const result = await review(record); assert.equal(result.score.total, 100); assert.ok(result.qualityBlockers.includes('story-development-not-supported'));
});
test('v2.1 independent: a claimed turn needs actual current evidence', async () => {
  const record = fresh(); record.storyDiagnosis.turn.kind = 'relationship-development'; await rejects(record, 'assessment-story-turn');
});
test('v2.1 independent: development evidence cannot quote a foreign text', async () => {
  const record = fresh(); record.storyDiagnosis.development.testEvidence = [{ ...anchor, quote: 'foreign text' }]; await rejects(record, 'assessment-span');
});
test('v2.1 independent: an old v2.0 assessment cannot be silently converted to the current schema', async () => {
  const record = fresh(); record.schemaVersion = 'judgment-evidence-assessment@2'; record.rubricVersion = 'judgment-evidence-95plus5-2.0'; delete record.storyDiagnosis;
  await assert.rejects(reviewCurrentAssessment(root, session, record));
});
test('v2.1 independent: declaring no turn cannot support an expectation extra', async () => {
  const record = fresh(); record.bonusBasis = positiveBases().find(x => x.route === 'expectation');
  await rejects(record, 'assessment-story-turn');
});
