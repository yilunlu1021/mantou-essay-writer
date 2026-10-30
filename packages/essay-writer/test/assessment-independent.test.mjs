import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { importSession, prepareAssessmentReview, reviewAssessment, assessmentReviewSchema,
  getEssayQualityBenchmark } from '../dist/index.js';

// Synthetic judgments inspect contracts, not real essay quality or admission chances.
const root=resolve('.');
async function fixture(t, profile={essayType:'common-app',promptStatus:'supplied'}) {
  const dir=await mkdtemp(join(tmpdir(),'independent-assessment-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=join(dir,'source.txt'),out=join(dir,'session');
  await writeFile(input,'I repaired a box for my cousin. Its clasp still needs work. The cause of that failure remains unresolved.');
  await importSession(root,{input,out,context:{language:'en',genre:'personal-narrative',authorRole:'student',
    audience:'reader',prompt:'Explain your choice and the question it left you.'}});
  const prepared=await prepareAssessmentReview(root,out,profile),r=structuredClone(prepared.template);
  const b=prepared.document.blocks[0],span={blockId:b.id,start:0,end:Array.from(b.text).length,quote:b.text};
  r.benchmarkReview.reviewerId='Independent synthetic reader';
  r.benchmarkReview.dimensions.forEach(d=>Object.assign(d,{level:d.dimensionId==='prompt-selection'&&profile.promptStatus!=='supplied'?null:3,
    reason:'The supplied synthetic passage supports the declared dimension.',limitation:'No admission outcome or authorship is certified.',
    retainCounterexample:'A small unresolved project can answer the actual prompt.',decision:'retain'}));
  r.benchmarkReview.checks.forEach(c=>Object.assign(c,{status:c.checkId==='school-facts'&&profile.essayType!=='why-school'?'not-applicable':
    c.checkId==='answer-relations'&&profile.promptStatus!=='supplied'?'unverified':'clear',reason:'Synthetic declaration only.',
    ...(c.checkId==='school-facts'&&profile.essayType==='why-school'?{officialSources:[{url:'https://example.edu/subject',checkedAt:'2026-10-20'}]}:{})}));
  r.benchmarkReview.recommendation='adopt';
  r.reading={task:'Explain the choice and its unfinished question.',readerUnderstanding:'The person cares enough to keep investigating a useful repair.',
    anchors:[span],applicationRoleOrLimitation:'No other application essays were provided.',questions:[]};
  r.calibration = { taskValue: 'The family repair reveals why this object matters to the writer.',
    evidenceLimits: 'This episode supports this choice, not a stable trait or general impact.',
    presentationVsContent: 'Synthetic author content and editorial wording remain distinct.', highestLevelJustifications: [] };
  r.target={school:{name:'Synthetic College',status:'confirmed',sourceRef:'Synthetic advisor application plan'},applicantContext:'Synthetic applicant context.',
    minimumScore100:75,rationale:'The advisor accepts this complete task at the stated target.'};
  r.acceptance={decision:'accepted',byRole:'business-owner',sourceRef:'Synthetic human acceptance',acceptedIssueIds:[]};
  r.readiness.forEach(c=>Object.assign(c,{status:c.checkId==='school-facts'&&profile.essayType!=='why-school'?'not-applicable':'clear',
    reason:'Synthetic declaration only.',sourceRef:'Synthetic evidence'}));
  return {r,out,span,prepared};
}
function optional(r,span,dimension='ending-economy') {
  const issue={id:'local',description:'A limited repetition remains.',primaryDimension:dimension,secondaryEffects:[],anchors:[span],
    severity:'optional',decision:'retain-with-reason',reason:'The advisor accepts this local limitation at the current target.'};
  r.issues=[issue];r.acceptance.acceptedIssueIds=['local'];return issue;
}
async function digest(dir) {
  const all=[];
  async function walk(path,relative='') {for(const item of await readdir(path,{withFileTypes:true})) {
    if(item.isDirectory()) await walk(join(path,item.name),relative+item.name+'/');
    else all.push([relative+item.name,createHash('sha256').update(await readFile(join(path,item.name))).digest('hex')]);}}
  await walk(dir);return all.sort(([a],[b])=>a.localeCompare(b));
}

test('independent: the protocol preserves historical rubric and numeric interpretation',()=>{
  const c=getEssayQualityBenchmark();assert.equal(c.rubricVersion,'1.0.0');
  assert.equal(c.rubricHash,'a1afb522d90c9e5e348946f4abcf633e7b06c4e0c13a33bcdcbb48a0c77f88fe');
  assert.equal(c.scoreReportingVersion,'1.0.0');assert.equal(c.assessmentProtocol.protocolVersion,'1.1.0');
  assert.match(c.assessmentProtocol.protocol.genre,/unresolved questions/);assert.match(c.assessmentProtocol.protocol.issueAttribution,/primary dimension/);
});
test('independent: score alone and proposed human acceptance cannot freeze content',async t=>{
  const {r,out}=await fixture(t);r.benchmarkReview.dimensions.forEach(d=>d.level=4);
  r.calibration.highestLevelJustifications=r.benchmarkReview.dimensions.map(d=>({dimensionId:d.dimensionId,whyAboveLevel3:'Synthetic declaration of sufficient support for this dimension, not certification of essay quality.',counterevidenceOrLimit:'This synthetic rating is solely a contract input.'}));r.acceptance.decision='proposed';
  const result=await reviewAssessment(root,out,r);assert.equal(result.benchmark.percentage.fullScore100,100);
  assert.equal(result.editorialStatus,'rework');assert.equal(result.submissionStatus,'blocked');
});
test('independent: target school changes cannot silently change the same essay score',async t=>{
  const {r,out}=await fixture(t);const before=await reviewAssessment(root,out,r);
  r.target.school.name='Different Synthetic College';r.target.applicantContext='A different documented target context.';
  const after=await reviewAssessment(root,out,r);assert.deepEqual(after.benchmark.percentage,before.benchmark.percentage);
  assert.notEqual(after.recordHash,before.recordHash);
});
test('independent: a missing school target permits content acceptance but blocks submission readiness',async t=>{
  const {r,out}=await fixture(t);r.target.school=null;
  const result=await reviewAssessment(root,out,r);assert.equal(result.editorialStatus,'content-accepted');
  assert.equal(result.targetConfirmed,false);assert.equal(result.submissionStatus,'blocked');
});
test('independent: each pending responsibility remains visible after content acceptance',async t=>{
  const {r,out}=await fixture(t);
  for(const key of ['source','authorship','edit-authority','student-final-review']) {
    const copy=structuredClone(r);copy.readiness.find(c=>c.checkId===key).status='unverified';
    const result=await reviewAssessment(root,out,copy);assert.equal(result.editorialStatus,'content-accepted');
    assert.equal(result.submissionStatus,'blocked');assert.ok(result.pendingReadiness.includes(key));
    assert.equal(result.authorshipCertified,false);assert.equal(result.humanApprovalVerified,false);
  }
});
test('independent: known source and factual issues cannot be accepted by a high score',async t=>{
  const {r,out}=await fixture(t);r.benchmarkReview.dimensions.forEach(d=>d.level=4);
  r.calibration.highestLevelJustifications=r.benchmarkReview.dimensions.map(d=>({dimensionId:d.dimensionId,whyAboveLevel3:'Synthetic declaration of sufficient support for this dimension, not certification of essay quality.',counterevidenceOrLimit:'This synthetic rating is solely a contract input.'}));
  for(const key of ['source','authorship','edit-authority','length-mechanics','student-final-review']) {
    const copy=structuredClone(r);copy.readiness.find(c=>c.checkId===key).status='issue';
    const result=await reviewAssessment(root,out,copy);assert.equal(result.editorialStatus,'rework');
    assert.equal(result.submissionStatus,'blocked');
  }
});
test('independent: accepted local limitations stay declared instead of forcing endless polishing',async t=>{
  const {r,out,span}=await fixture(t);r.benchmarkReview.dimensions.at(-1).level=2;r.target.minimumScore100=70;
  optional(r,span);const result=await reviewAssessment(root,out,r);
  assert.equal(result.benchmark.percentage.fullScore100,72.5);assert.equal(result.benchmark.reviewDecision,'needs-rework');
  assert.equal(result.editorialStatus,'content-accepted');assert.deepEqual(result.knownLimitationIds,['local']);
});
test('independent: zero and one remain substantive failures even with an optional ledger label',async t=>{
  const {r,out,span}=await fixture(t);r.target.minimumScore100=0;optional(r,span,'genre-task');
  for(const level of [0,1]) {r.benchmarkReview.dimensions[1].level=level;const result=await reviewAssessment(root,out,r);
    assert.equal(result.editorialStatus,'rework');assert.equal(result.submissionStatus,'blocked');assert.ok(result.severeDimensions.includes('genre-task'));}
});
test('independent: a dimension source request cannot disappear into an optional accepted ledger',async t=>{
  const {r,out,span}=await fixture(t);r.benchmarkReview.dimensions[3].decision='needs-source';optional(r,span,'author-voice');
  await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-readiness'});
});
test('independent: unresolved dimension decisions remain open despite an optional accepted ledger',async t=>{
  const {r,out,span}=await fixture(t);r.benchmarkReview.dimensions[3].decision='unresolved';optional(r,span,'author-voice');
  const result=await reviewAssessment(root,out,r);assert.equal(result.editorialStatus,'rework');
  assert.equal(result.submissionStatus,'blocked');assert.ok(result.unresolvedDimensions.includes('author-voice'));
});
test('independent: missing prompts never yield a complete score or target attainment',async t=>{
  const {r,out}=await fixture(t,{essayType:'common-app',promptStatus:'unselected'});
  r.readiness.find(c=>c.checkId==='prompt').status='unverified';
  const result=await reviewAssessment(root,out,r);assert.equal(result.benchmark.percentage.fullScore100,null);
  assert.equal(result.targetMet,false);assert.equal(result.editorialStatus,'rework');assert.equal(result.submissionStatus,'blocked');
});
test('independent: one issue can have a distinct second effect, not duplicate dimension entries',async t=>{
  const {r,out,span}=await fixture(t);const issue=optional(r,span);issue.secondaryEffects=[{dimensionId:'information-language',effect:'The repetition also displaces information in this sentence group.'}];
  assert.equal((await reviewAssessment(root,out,r)).editorialStatus,'content-accepted');
  issue.secondaryEffects.push({...issue.secondaryEffects[0]});
  await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-issue'});
});
test('independent: unresolved questions require an existing explicit issue record',async t=>{
  const {r,out}=await fixture(t);r.reading.questions=[{question:'Why did the writer choose this repair?',issueId:'absent'}];
  await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-question'});
});
test('independent: full readiness requires complete unique ordered checks',async t=>{
  const {r,out}=await fixture(t);
  const duplicate=structuredClone(r);duplicate.readiness[1]=structuredClone(duplicate.readiness[0]);
  await assert.rejects(reviewAssessment(root,out,duplicate),{code:'assessment-readiness'});
  const reversed=structuredClone(r);reversed.readiness.reverse();
  await assert.rejects(reviewAssessment(root,out,reversed),{code:'assessment-readiness'});
  const short=structuredClone(r);short.readiness.pop();assert.equal(assessmentReviewSchema.safeParse(short).success,false);
});
test('independent: protocol and current-text bindings reject stale records without changing history',async t=>{
  const {r,out}=await fixture(t),before=await digest(out);
  const stale=structuredClone(r);stale.protocolHash='0'.repeat(64);await assert.rejects(reviewAssessment(root,out,stale),{code:'assessment-stale'});
  const staleText=structuredClone(r);staleText.benchmarkReview.bindings.documentHash='0'.repeat(64);
  await assert.rejects(reviewAssessment(root,out,staleText),{code:'benchmark-review-stale'});
  const result=await reviewAssessment(root,out,r);assert.deepEqual(await digest(out),before);
  assert.equal(JSON.stringify(result).includes('cousin'),false);assert.equal(result.submissionAuthorized,false);assert.equal(result.admissionsOutcomePredicted,false);
});
test('independent: fabricated reading spans and undeclared accepted issues are rejected',async t=>{
  const {r,out}=await fixture(t);const quote=structuredClone(r);quote.reading.anchors[0].quote='Invented text';
  await assert.rejects(reviewAssessment(root,out,quote),{code:'assessment-span'});
  r.acceptance.acceptedIssueIds=['undeclared'];await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-acceptance'});
});
test('independent: institution facts cannot be skipped in Why School readiness',async t=>{
  const {r,out}=await fixture(t,{essayType:'why-school',promptStatus:'supplied'});
  r.readiness.find(c=>c.checkId==='school-facts').status='not-applicable';
  await assert.rejects(reviewAssessment(root,out,r),{code:'assessment-readiness'});
});
test('independent: current CLI rejects legacy Common App while SDK history remains non-submitting',async t=>{
  const {r,out}=await fixture(t),reviewFile=join(out,'..','review.json');
  r.readiness.find(c=>c.checkId==='authorship').status='unverified';await writeFile(reviewFile,JSON.stringify(r));
  const expected=await reviewAssessment(root,out,r),before=await digest(out);
  const result=spawnSync(process.execPath,['dist/cli.js','review-assessment','--session',out,'--review-file',reviewFile],
    {cwd:root,encoding:'utf8',maxBuffer:4_000_000});
  assert.equal(result.status,1,result.stderr);assert.equal(JSON.parse(result.stderr).error,'historical-common-app-rubric');
  assert.equal(result.stdout,'');assert.equal(expected.editorialStatus,'content-accepted');assert.equal(expected.submissionStatus,'blocked');
  assert.equal(expected.submissionAuthorized,false);assert.deepEqual(await digest(out),before);
  const schemas=spawnSync(process.execPath,['dist/cli.js','schema'],{cwd:root,encoding:'utf8',maxBuffer:8_000_000});
  assert.equal(schemas.status,0,schemas.stderr);assert.ok(JSON.parse(schemas.stdout).assessmentReview);
});
