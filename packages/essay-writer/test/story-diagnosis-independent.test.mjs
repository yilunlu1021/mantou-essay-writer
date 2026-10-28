import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { contextSchema, countText, hashValue } from '@mantou/text-quality';
import {
  importSession, loadSession, patchTemplate, reviseSession,
  prepareCommonAppAssessment, reviewCommonAppAssessment, reviewCurrentAssessment,
  getCommonAppBenchmark,
} from '../dist/index.js';

// Entirely synthetic declarations. Repeated fixture sentences are deliberately
// unsuitable as a real essay and never establish an actual prose-quality score.
const root = fileURLToPath(new URL('..', import.meta.url));
const cp = text => Array.from(text).length;
const span = (blockId, start, quote) => ({ blockId, start, end: start + cp(quote), quote });
let directory, session, prepared, expectedParagraphs, initial;
const fresh = () => structuredClone(initial);
const review = record => reviewCommonAppAssessment(root, session, record);
const reject = record => assert.rejects(review(record));
const maximumProof = () => ({
  positiveProof: 'Synthetic asserted completion for this contract test.',
  counterReading: 'Repetitive fixture text cannot establish actual writing quality.',
  whyFourInsufficient: 'The full-band declaration tests storage and gating only.',
});

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'story-diagnosis-independent-'));
  const input = join(directory, 'synthetic.txt');
  session = join(directory, 'session');
  const half = 'I kept the box. '.repeat(20).trim();
  const full = `${half} ${half}`;
  const text = [`🧭 ${full}`, full, full, full].join('\n\n');
  assert.equal(countText(text).englishWords, 640);
  await writeFile(input, text);
  await importSession(root, { input, out: session, context: contextSchema.parse({
    language: 'en', genre: 'personal-narrative', authorRole: 'student',
    audience: 'Independent synthetic evaluator', stage: 'clean-draft',
    prompt: 'Describe a synthetic decision.', length: { unit: 'english-words', min: 635, max: 650 },
  }) });

  // A real version patch puts two natural paragraphs in p1. Three other blocks
  // remain separate. Expected positions are constructed here, not by the engine
  // helper whose coverage the production validator uses.
  const state = await loadSession(root, session);
  const first = `🧭 ${half}`, boundary = cp(first);
  await reviseSession(root, session, {
    ...patchTemplate(state.manifest.context, state.document, state.policy),
    patches: [{ blockId: 'p1', start: boundary, end: boundary + 1,
      expectedText: ' ', replacement: '\r\n\r\n',
      reason: 'Create a synthetic paragraph boundary without changing any words.' }],
  });
  expectedParagraphs = [span('p1', 0, first), span('p1', boundary + 4, half),
    ...['p2', 'p3', 'p4'].map(id => span(id, 0, full))];
  prepared = await prepareCommonAppAssessment(root, session, { essayType: 'common-app', promptStatus: 'supplied' });
  assert.equal(prepared.document.blocks.length, 4);
  assert.equal(countText(prepared.document.blocks.map(x => x.text).join('\n\n')).englishWords, 640);
  initial = structuredClone(prepared.template);
  initial.reviewer.id = 'Independent story-contract evaluator';
  initial.reading = { task: 'Read the synthetic decision.', personUnderstood: 'No real student is assessed.',
    causalChain: 'Synthetic premise and response only.', keyActions: 'Handling the synthetic object.',
    questions: [], evidenceLimits: 'No real prose quality, source truth or author identity is certified.',
    presentationVsContent: 'The repeated text exists to test accurate coverage.', anchors: structuredClone(expectedParagraphs) };
  initial.items.forEach(item => Object.assign(item, { score: 5, anchors: [structuredClone(expectedParagraphs[0])],
    bandReason: 'Synthetic maximum declaration.', nextBandCondition: 'No higher integer band.',
    limitation: 'No actual essay has been evaluated.', fullMarkTest: maximumProof() }));
  Object.assign(initial.items.at(-1), { score: 0, fullMarkTest: null,
    absenceReason: 'No extra route is claimed by this deliberately ordinary fixture.' });
  initial.bonusBasis = { route: 'none', finding: 'No additional narrative route is asserted.' };
  initial.criticalChecks.forEach(check => Object.assign(check, { status: 'clear',
    reason: 'Synthetic explicit declaration only.', anchors: [structuredClone(expectedParagraphs[0])] }));
  initial.target.rationale = 'No real application target is asserted.';
  initial.acceptance.sourceRef = 'Synthetic fixture with proposed acceptance.';
  initial.readiness.forEach(check => Object.assign(check, { status: 'clear',
    reason: 'Synthetic readiness declaration only.', sourceRef: 'No real student or permission is represented.' }));
  initial.readiness.find(x => x.checkId === 'student-final-review').status = 'unverified';
  initial.storyDiagnosis = {
    scope: 'single-experience',
    personalStakes: 'The synthetic object supplies a bounded concern, without claiming actual personal depth.',
    paragraphProgression: expectedParagraphs.map((anchor, index) => ({ anchor: structuredClone(anchor),
      function: `Synthetic paragraph ${index + 1} function.`,
      addedUnderstanding: `Synthetic asserted information for paragraph ${index + 1}.`,
      status: 'distinct', reason: 'This declaration tests complete ordered storage, not sentence semantics.' })),
    development: { kind: 'stable-character', initialPosition: 'A stable synthetic position.',
      testEvidence: [structuredClone(expectedParagraphs[0])], responseAndScope: 'The declaration stays within the synthetic episode.',
      status: 'supported' },
    turn: { kind: 'none', setup: 'No reader surprise is claimed.', actual: 'The synthetic event proceeds plainly.',
      contribution: 'A turning point is unnecessary for this contract fixture.', anchors: [] },
    verdict: 'sufficient', reason: 'All required synthetic declarations are explicit and current.',
  };
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('story independent: formal versions change together and prepare covers natural paragraphs', () => {
  const rubric = getCommonAppBenchmark();
  assert.equal(rubric.version, 'judgment-evidence-95plus5-2.1');
  assert.equal(rubric.assessmentVersion, 'judgment-evidence-assessment@3');
  assert.equal(rubric.protocolVersion, 'judgment-evidence-protocol-2.1');
  assert.equal(prepared.schemaVersion, 'judgment-evidence-assessment@3');
  assert.ok(prepared.template.storyDiagnosis);
  assert.deepEqual(prepared.template.storyDiagnosis.paragraphProgression.map(x => x.anchor), expectedParagraphs);
});

test('story independent: the complete new protocol and story instructions are frozen in the rubric hash', async () => {
  const rubric = getCommonAppBenchmark();
  const guide = await readFile(join(root, '../../docs/benchmarks/common-app-judgment-evidence-v2.md'), 'utf8');
  assert.equal(rubric.protocolSections.join('\n').trim(), guide.trim());
  assert.ok(rubric.protocolSections.join('\n').includes('storyDiagnosis'));
  assert.ok(rubric.instructions.some(x => x.includes('storyDiagnosis')));
  const { rubricHash, assessmentVersion, ...payload } = rubric;
  assert.equal(hashValue(payload), rubricHash);
  const changed = structuredClone(payload); changed.protocolSections[0] += '\nChanged story coverage contract.';
  assert.notEqual(hashValue(changed), rubricHash);
});

test('story independent: diagnosis contents enter the record hash without changing the shared rubric', async () => {
  const original = fresh(), changed = fresh(); changed.storyDiagnosis.personalStakes += ' An amended synthetic rationale.';
  const a = await review(original), b = await review(changed);
  assert.equal(a.recordHash, hashValue(original)); assert.equal(b.recordHash, hashValue(changed));
  assert.notEqual(a.recordHash, b.recordHash); assert.equal(a.rubricHash, b.rubricHash);
});

test('story independent: current diagnosis cannot carry an outdated rubric hash', async () => {
  const record = fresh(); record.rubricHash = '0'.repeat(64);
  await assert.rejects(review(record), { code: 'assessment-stale' });
});

test('story independent: a current @3 record cannot claim the old 2.0 rubric version', async () => {
  const record = fresh(); record.rubricVersion = 'judgment-evidence-95plus5-2.0'; await reject(record);
});

test('story independent: stable character, no surprise and a single experience may pass all 95 main points', async () => {
  const result = await review(fresh());
  assert.equal(result.score.base, 95); assert.equal(result.score.bonusCounted, 0); assert.equal(result.score.total, 95);
  assert.equal(result.qualityPassed, true); assert.equal(result.studentReviewEligible, true);
  assert.equal(result.submissionAuthorized, false); assert.equal(result.reasoningCertified, false);
});

test('story independent: linked experiences do not receive an automatic score reward', async () => {
  const single = await review(fresh()), linked = fresh(); linked.storyDiagnosis.scope = 'linked-experiences';
  const result = await review(linked);
  assert.equal(result.score.total, single.score.total); assert.equal(result.qualityPassed, true);
});

test('story independent: a necessary context paragraph is allowed without inventing new growth', async () => {
  const record = fresh(); record.storyDiagnosis.paragraphProgression[1].status = 'necessary-context';
  record.storyDiagnosis.paragraphProgression[1].addedUnderstanding = 'Necessary context keeps the synthetic actor and condition recoverable.';
  assert.equal((await review(record)).qualityPassed, true);
});

test('story independent: the complete story diagnosis is mandatory', async () => {
  const record = fresh(); delete record.storyDiagnosis; await reject(record);
});
for (const field of ['scope', 'personalStakes', 'paragraphProgression', 'development', 'turn', 'verdict', 'reason'])
  test(`story independent: missing diagnosis ${field} is rejected`, async () => {
    const record = fresh(); delete record.storyDiagnosis[field]; await reject(record);
  });
for (const field of ['anchor', 'function', 'addedUnderstanding', 'status', 'reason'])
  test(`story independent: missing paragraph ${field} is rejected`, async () => {
    const record = fresh(); delete record.storyDiagnosis.paragraphProgression[0][field]; await reject(record);
  });

const coverageMutations = [
  ['omit an internal natural paragraph', record => record.storyDiagnosis.paragraphProgression.splice(1, 1)],
  ['omit a whole later block', record => record.storyDiagnosis.paragraphProgression.pop()],
  ['duplicate a current paragraph', record => record.storyDiagnosis.paragraphProgression.push(structuredClone(record.storyDiagnosis.paragraphProgression[0]))],
  ['replace a same-text occurrence by another block', record => { record.storyDiagnosis.paragraphProgression[3].anchor = structuredClone(expectedParagraphs[2]); }],
  ['reverse internal paragraphs', record => { const rows = record.storyDiagnosis.paragraphProgression; [rows[0], rows[1]] = [rows[1], rows[0]]; }],
  ['reverse equal-text paragraphs across blocks', record => { const rows = record.storyDiagnosis.paragraphProgression; [rows[2], rows[3]] = [rows[3], rows[2]]; }],
  ['combine two natural paragraphs into one block span', record => {
    const rows = record.storyDiagnosis.paragraphProgression;
    rows[0].anchor = span('p1', 0, prepared.document.blocks[0].text); rows.splice(1, 1);
  }],
  ['use a true but partial paragraph span', record => {
    const row = record.storyDiagnosis.paragraphProgression[0];
    row.anchor = span('p1', 0, Array.from(row.anchor.quote).slice(0, 12).join(''));
  }],
];
for (const [name, mutate] of coverageMutations) test(`story independent: coverage cannot ${name}`, async () => {
  const record = fresh(); mutate(record); await reject(record);
});

test('story independent: a correct Unicode quote with UTF-16 offsets is not an accurate paragraph anchor', async () => {
  const record = fresh(), anchor = record.storyDiagnosis.paragraphProgression[1].anchor;
  anchor.start += 1; anchor.end += 1; await reject(record);
});
for (const location of ['paragraph', 'development', 'turn'])
  test(`story independent: forged ${location} quotes are rejected`, async () => {
    const record = fresh(), bad = { ...expectedParagraphs[0], quote: 'A fabricated quotation.' };
    if (location === 'paragraph') record.storyDiagnosis.paragraphProgression[0].anchor = bad;
    if (location === 'development') record.storyDiagnosis.development.testEvidence = [bad];
    if (location === 'turn') Object.assign(record.storyDiagnosis.turn, { kind: 'self-expectation', anchors: [bad] });
    await reject(record);
  });

for (const status of ['repeats', 'unresolved'])
  test(`story independent: a ${status} paragraph blocks despite a sufficient top verdict and 95 points`, async () => {
    const record = fresh(); record.storyDiagnosis.paragraphProgression[1].status = status;
    assert.equal(record.storyDiagnosis.verdict, 'sufficient');
    const result = await review(record);
    assert.equal(result.score.total, 95); assert.equal(result.qualityPassed, false);
    assert.equal(result.studentReviewEligible, false); assert.ok(result.qualityBlockers.length > 0);
  });
for (const status of ['needs-rework', 'unverified']) {
  test(`story independent: development ${status} cannot be hidden by a sufficient top verdict`, async () => {
    const record = fresh(); record.storyDiagnosis.development.status = status;
    const result = await review(record);
    assert.equal(result.score.total, 95); assert.equal(result.qualityPassed, false); assert.equal(result.studentReviewEligible, false);
  });
  test(`story independent: top verdict ${status} blocks even when all local entries are supported`, async () => {
    const record = fresh(); record.storyDiagnosis.verdict = status;
    const result = await review(record);
    assert.equal(result.score.total, 95); assert.equal(result.qualityPassed, false); assert.equal(result.studentReviewEligible, false);
  });
}

for (const field of ['kind', 'initialPosition', 'testEvidence', 'responseAndScope', 'status'])
  test(`story independent: missing development ${field} is rejected`, async () => {
    const record = fresh(); delete record.storyDiagnosis.development[field]; await reject(record);
  });
test('story independent: a supported development declaration still requires actual current evidence', async () => {
  const record = fresh(); record.storyDiagnosis.development.testEvidence = []; await reject(record);
});
test('story independent: a change story can be supported within the same experience', async () => {
  const record = fresh(); record.storyDiagnosis.development.kind = 'change';
  record.storyDiagnosis.development.responseAndScope = 'The declared change concerns only this synthetic episode.';
  assert.equal((await review(record)).qualityPassed, true);
});

for (const kind of ['reader-expectation', 'self-expectation', 'relationship-development']) {
  test(`story independent: ${kind} records its role without automatically awarding extra points`, async () => {
    const record = fresh(); Object.assign(record.storyDiagnosis.turn, { kind, anchors: [expectedParagraphs[1]] });
    const result = await review(record);
    assert.equal(result.qualityPassed, true); assert.equal(result.score.bonusCounted, 0); assert.equal(result.score.total, 95);
  });
  test(`story independent: ${kind} requires current turn evidence`, async () => {
    const record = fresh(); record.storyDiagnosis.turn.kind = kind; await reject(record);
  });
}
for (const field of ['kind', 'setup', 'actual', 'contribution', 'anchors'])
  test(`story independent: missing turn ${field} is rejected even when no surprise is claimed`, async () => {
    const record = fresh(); delete record.storyDiagnosis.turn[field]; await reject(record);
  });

test('story independent: no-turn declaration cannot also claim an expectation-deviation extra', async () => {
  const record = fresh(); Object.assign(record.items.at(-1), { score: 2, fullMarkTest: null, absenceReason: '' });
  record.bonusBasis = { route: 'expectation', expected: 'A synthetic immediate reader expectation.',
    establishedBy: [structuredClone(expectedParagraphs[0])], actual: 'A synthetic departure from that expectation.',
    contribution: 'The declaration would contradict the explicit no-turn diagnosis.' };
  await reject(record);
});

test('story independent: no-turn declaration can retain a supported non-surprise insight extra', async () => {
  const record = fresh(); Object.assign(record.items.at(-1), { score: 2, fullMarkTest: null, absenceReason: '' });
  record.bonusBasis = { route: 'insight', observation: 'A synthetic observation.',
    inference: 'A synthetic supported inference.', contribution: 'Extra understanding without a reader surprise.' };
  const result = await review(record);
  assert.equal(result.qualityPassed, true); assert.equal(result.score.total, 97);
});

test('story independent: a v2.0 @2 record is historical and cannot be silently converted', async () => {
  const historical = fresh(); historical.schemaVersion = 'judgment-evidence-assessment@2';
  historical.rubricVersion = 'judgment-evidence-95plus5-2.0'; delete historical.storyDiagnosis;
  await assert.rejects(reviewCurrentAssessment(root, session, historical), { code: 'historical-common-app-rubric' });
});
