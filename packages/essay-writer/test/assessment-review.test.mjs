import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { importSession, getEssayQualityBenchmark, prepareAssessmentReview, reviewAssessment } from '../dist/index.js';

const root = resolve('.');
async function fixture(t, essayType = 'common-app') {
  const dir = await mkdtemp(join(tmpdir(), 'assessment-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.txt'), out = join(dir, 'session');
  await writeFile(input, 'I repaired the hinge for my sister. She wanted to keep the box. The handle still needs work.');
  await importSession(root, { input, out, context: { language: 'en', genre: 'personal-narrative', authorRole: 'student',
    audience: 'reader', prompt: 'Describe a choice that matters to you.' } });
  const p = await prepareAssessmentReview(root, out, { essayType, promptStatus: 'supplied',
    ...(essayType === 'supplement' ? { task: 'Explain the personal repair choice.' } : {}) });
  const r = structuredClone(p.template);
  const anchor = p.document.blocks[0];
  const span = { blockId: anchor.id, start: 0, end: Array.from(anchor.text).length, quote: anchor.text };
  r.benchmarkReview.reviewerId = 'Synthetic contract reader';
  r.benchmarkReview.dimensions.forEach(d => Object.assign(d, { level: 3,
    reason: 'The repair has a concrete object and personal reason.', limitation: 'This is a synthetic rating.',
    retainCounterexample: 'An ordinary project can reveal an individual.', decision: 'retain' }));
  r.benchmarkReview.checks.forEach(c => Object.assign(c, { status: c.checkId === 'school-facts' && essayType !== 'why-school' ? 'not-applicable' : 'clear',
    reason: 'The declaration is limited to this synthetic test.',
    ...(c.checkId === 'school-facts' && essayType === 'why-school' ? { officialSources: [{url: 'https://example.edu/program', checkedAt: '2026-10-20'}] } : {}) }));
  r.benchmarkReview.recommendation = 'adopt';
  r.reading = { task: 'Explain this personal choice.', readerUnderstanding: 'The writer values a useful repair for a family member.',
    anchors: [span], applicationRoleOrLimitation: 'Other application materials were not supplied.', questions: [] };
  r.calibration = { taskValue: 'The family repair reveals why this object matters to the writer.',
    evidenceLimits: 'This episode supports this choice, not a stable trait or general impact.',
    presentationVsContent: 'Synthetic author content and editorial wording remain distinct.', highestLevelJustifications: [] };
  r.target = { school: { name: 'Synthetic University', status: 'confirmed', sourceRef: 'Synthetic plan' },
    applicantContext: 'A synthetic student preparing this application.', minimumScore100: 75, rationale: 'Synthetic advisor target for this task.' };
  r.acceptance = { decision: 'accepted', byRole: 'advisor', sourceRef: 'Synthetic advisor acceptance', acceptedIssueIds: [] };
  r.readiness.forEach(c => Object.assign(c, { status: c.checkId === 'school-facts' && essayType !== 'why-school' ? 'not-applicable' : 'clear',
    reason: 'Synthetic declaration only.', sourceRef: 'Synthetic review evidence' }));
  return { out, r, p, span };
}

test('new protocol is additive and keeps the existing rubric hash and percentage method', () => {
  const c = getEssayQualityBenchmark();
  assert.equal(c.rubricHash, 'a1afb522d90c9e5e348946f4abcf633e7b06c4e0c13a33bcdcbb48a0c77f88fe');
  assert.equal(c.assessmentProtocol.protocolVersion, '1.1.0');
  assert.match(c.assessmentProtocol.protocol.detail, /Do not require/);
  assert.match(c.assessmentProtocol.protocol.genre, /Ordinary experience/);
});
for (const type of ['common-app','why-major','why-school','supplement']) test(`${type} keeps its actual profile and separate readiness`, async t => {
  const {out,r}=await fixture(t,type); const result=await reviewAssessment(root,out,r);
  assert.equal(result.benchmark.percentage.fullScore100,75);
  assert.equal(result.editorialStatus,'content-accepted');
  assert.equal(result.submissionStatus,'ready-for-human-submission');
  assert.equal(result.humanApprovalVerified,false);
  assert.equal(result.submissionAuthorized,false);
});
test('an accepted local limitation can coexist with legacy needs-rework and frozen content', async t => {
  const {out,r,span}=await fixture(t);
  r.benchmarkReview.dimensions.at(-1).level=2;
  r.target.minimumScore100=70;
  r.issues=[{id:'ending',description:'The closing observation repeats the previous line.',primaryDimension:'ending-economy',
    secondaryEffects:[],anchors:[span],severity:'optional',decision:'retain-with-reason',reason:'The advisor accepts this limited repetition at the current target.'}];
  r.acceptance.acceptedIssueIds=['ending'];
  const result=await reviewAssessment(root,out,r);
  assert.equal(result.editorialStatus,'content-accepted');
  assert.equal(result.benchmark.reviewDecision,'needs-rework');
  assert.deepEqual(result.knownLimitationIds,['ending']);
});
test('source or authorship pending never becomes submission ready after content acceptance', async t => {
  const {out,r}=await fixture(t);
  r.benchmarkReview.checks[0].status='unverified';
  r.readiness.find(c=>c.checkId==='source').status='unverified';
  r.readiness.find(c=>c.checkId==='authorship').status='unverified';
  const result=await reviewAssessment(root,out,r);
  assert.equal(result.editorialStatus,'content-accepted');
  assert.equal(result.submissionStatus,'blocked');
  assert.deepEqual(result.pendingReadiness,['source','authorship']);
});
test('an agent cannot declare human acceptance', async t => {
  const {out,r}=await fixture(t);r.acceptance.byRole='agent';
  await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-acceptance'});
});
test('an unmet or missing target and missing human acceptance keep content open', async t => {
  const {out,r}=await fixture(t);r.target.minimumScore100=85;
  assert.equal((await reviewAssessment(root,out,r)).editorialStatus,'rework');
  r.target.minimumScore100=null;
  assert.equal((await reviewAssessment(root,out,r)).editorialStatus,'target-needed');
  r.target.minimumScore100=70;r.acceptance.decision='proposed';
  assert.equal((await reviewAssessment(root,out,r)).editorialStatus,'rework');
});
test('school target uncertainty is reported without changing essay quality', async t => {
  const {out,r}=await fixture(t);r.target.school.status='unverified';
  const result=await reviewAssessment(root,out,r);
  assert.equal(result.editorialStatus,'content-accepted');assert.equal(result.targetConfirmed,false);
  assert.equal(result.submissionStatus,'blocked');assert.equal(result.benchmark.percentage.fullScore100,75);
});
test('material defects cannot be accepted as optional limitations', async t => {
  const {out,r,span}=await fixture(t);
  r.issues=[{id:'gap',description:'The choice is missing its stated reason.',primaryDimension:'reasoning-discourse',secondaryEffects:[],
    anchors:[span],severity:'material',decision:'revise',reason:'This needs the actual reason.'}];
  r.acceptance.acceptedIssueIds=['gap'];
  await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-acceptance'});
  r.acceptance.acceptedIssueIds=[];
  assert.equal((await reviewAssessment(root,out,r)).editorialStatus,'rework');
});
test('issues and additional dimension effects require unique attribution', async t => {
  const {out,r,span}=await fixture(t);
  const issue={id:'same',description:'A repeated line.',primaryDimension:'ending-economy',secondaryEffects:[],anchors:[span],
    severity:'optional',decision:'retain-with-reason',reason:'The repetition is accepted.'};
  r.issues=[issue,structuredClone(issue)];
  await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-issue'});
  r.issues=[issue];issue.secondaryEffects=[{dimensionId:'ending-economy',effect:'Same primary effect.'}];
  await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-issue'});
});
test('low ratings, unresolved reader questions and exact spans must be accounted for', async t => {
  const {out,r,span}=await fixture(t);r.benchmarkReview.dimensions[0].level=2;
  await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-issue-coverage'});
  r.benchmarkReview.dimensions[0].level=3;r.reading.questions=[{question:'Why was this needed?',issueId:'missing'}];
  await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-question'});
  r.reading.questions=[];r.reading.anchors=[{...span,quote:'A fabricated quotation.'}];
  await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-span'});
});
test('readiness cannot erase known issues or skip authorship', async t => {
  const {out,r}=await fixture(t);
  r.benchmarkReview.checks[0].status='issue';
  await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-readiness'});
  r.benchmarkReview.checks[0].status='clear';r.readiness.find(c=>c.checkId==='authorship').status='not-applicable';
  await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-readiness'});
});
test('assessment leaves immutable session files unchanged and omits prose from summary', async t => {
  const {out,r}=await fixture(t);
  async function snapshot(dir) {const files={};for(const e of await readdir(dir,{withFileTypes:true})) {
    files[e.name]=e.isDirectory()?await snapshot(join(dir,e.name)):createHash('sha256').update(await readFile(join(dir,e.name))).digest('hex');}return files;}
  const before=await snapshot(out),result=await reviewAssessment(root,out,r);
  assert.deepEqual(await snapshot(out),before);
  assert.equal(JSON.stringify(result).includes('hinge'),false);
  assert.equal(result.authorshipCertified,false);
});
