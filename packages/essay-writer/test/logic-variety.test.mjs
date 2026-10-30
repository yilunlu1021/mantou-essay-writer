import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { contextSchema } from '@mantou/text-quality';
import { importSession, prepareLogicReview, reviewLogic, expressionInventory, logicScoreConsistency,
  prepareRuleReview, reviewRules, prepareWritingWorkflow, checkWritingWorkflow } from '../dist/index.js';
import { declaredLogic } from './helpers/logic.mjs';
const root = resolve('.');
async function fixture(t, text = 'The door was blue.\n\nThe wall was white.', prompt = 'Describe the supplied scene.') {
  const dir = await mkdtemp(join(tmpdir(), 'logic-review-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'draft.txt'), session = join(dir, 'session'); await writeFile(input, text);
  await importSession(root, { input, out: session, context: contextSchema.parse({ language:'en', genre:'academic', authorRole:'student', prompt, audience:'reader' }) });
  return session;
}
test('logic starts pending and records all prompt, paragraph and bridge coverage without semantic certification', async t => {
  const session = await fixture(t), p = await prepareLogicReview(root, session);
  assert.equal(p.bridges.length, 1);
  const blank = await reviewLogic(root, session, p.template); assert.equal(blank.reviewDecision, 'needs-rework');
  assert.ok(blank.pending.length); assert.equal(blank.relevantLogicScoreCeiling, null);
  const result = await reviewLogic(root, session, declaredLogic(p)); assert.equal(result.reviewDecision, 'recorded');
  for (const field of ['reasoningCertified', 'claimCoverageCertified', 'independentReaderVerified', 'deliveryAuthorized']) assert.equal(result[field], false);
});
test('an adopt conclusion cannot erase a missing bridge, unanswered requirement or consequential unsupported claim', async t => {
  const session = await fixture(t), p = await prepareLogicReview(root, session), base = declaredLogic(p);
  for (const mutate of [r => r.bridges[0].missingPremise = 'The missing reason is not supplied.',
    r => r.requirements[0].status = 'partial', r => r.paragraphs[0].status = 'material-pile',
    r => r.overall.convincing.status = 'issue', r => r.overall.questions.push({question:'Why does the conclusion follow?', anchor:p.paragraphs[0],material:true,resolved:false,reason:'A consequential reason is missing.'}),
    r => r.paragraphs[0].claims.push({anchor:p.paragraphs[0],kind:'inference',evidence:[p.paragraphs[0]],warrant:'An unsupported leap.',counterReading:'A different cause fits.',scopeLimit:'The description cannot establish a cause.',status:'unsupported'})]) {
    const r = structuredClone(base); mutate(r); const result = await reviewLogic(root,session,r);
    assert.equal(result.reviewDecision,'needs-rework'); assert.equal(result.relevantLogicScoreCeiling,3);
  }
});
test('a pending source or process does not become an invented three-point rating', async t => {
  const session = await fixture(t), p = await prepareLogicReview(root,session), r = declaredLogic(p);
  r.reviewer.independence='unknown'; r.overall.convincing.status='unverified';
  const result=await reviewLogic(root,session,r); assert.equal(result.reviewDecision,'needs-review'); assert.equal(result.relevantLogicScoreCeiling,null);
});
test('dropped paragraphs, bridges, prompt conditions, invented spans and stale bindings are rejected', async t => {
  const session=await fixture(t), p=await prepareLogicReview(root,session), base=declaredLogic(p);
  for (const [mutate,code] of [[r=>r.paragraphs.pop(),'logic-review-paragraph-coverage'],[r=>r.bridges.pop(),'logic-review-bridge-coverage'],
    [r=>r.requirements=[],'logic-review-prompt-coverage'], [r=>r.requirements[0].promptSpan.quote='A different task.','logic-review-prompt-span'],
    [r=>r.overall.convincing.anchors[0]={...p.paragraphs[0],quote:'Invented'},'logic-review-span']]) {
    const r=structuredClone(base);mutate(r);await assert.rejects(reviewLogic(root,session,r),{code});
  }
  for(const key of Object.keys(base.bindings)){const r=structuredClone(base);r.bindings[key]='0'.repeat(64);await assert.rejects(reviewLogic(root,session,r),{code:'logic-review-stale'});}
});
test('a real negotiated agreement and a stable descriptive sequence need no invented growth arc', async t=>{
  const session=await fixture(t,'We agreed on one hour.\n\nAt nine, she chose another hour.','Describe the agreement.');
  const p=await prepareLogicReview(root,session),r=declaredLogic(p);r.centralAnswer='A limited visit gave both friends an acceptable plan.';
  r.bridges[0].relation='chronology';r.bridges[0].whyFollows='The later choice follows the agreed initial interval; it does not prove a new personality.';
  assert.equal((await reviewLogic(root,session,r)).reviewDecision,'recorded');
});
test('missing actual prompt and all-N/A requirements remain pending',async t=>{
  const session=await fixture(t,'The door was blue.',''),p=await prepareLogicReview(root,session),r=declaredLogic(p);
  assert.equal((await reviewLogic(root,session,r)).reviewDecision,'needs-review');
  const other=await fixture(t),q=await prepareLogicReview(root,other),all=declaredLogic(q);all.requirements[0].status='not-applicable';
  assert.equal((await reviewLogic(root,other,all)).reviewDecision,'needs-review');
});
test('workflow v1 cannot reuse a historical ready result after mandatory logic is added',async t=>{
  const session=await fixture(t),r=(await prepareWritingWorkflow(root,session)).template;r.schemaVersion='writing-workflow@1';delete r.reviews.logic;
  await assert.rejects(checkWritingWorkflow(root,session,r),{code:'writing-workflow-upgrade-required'});
});
test('to locations distinguish review candidates from errors and include exact Unicode spans',()=>{
  const text='😀 I wrote to Mum. I hoped to visit. She gave me permission to stay. The room was quiet. The goal was clear.';
  const doc={schemaVersion:'1.0.0',blocks:[{id:'p1',kind:'body',text}]},p=expressionInventory(doc);
  assert.equal(p.to.length,3);assert.equal(p.numericLimit,null);assert.equal(p.classificationCertified,false);
  for(const item of p.to)assert.equal(Array.from(text).slice(item.span.start,item.span.end).join(''),'to');
  assert.ok(p.patterns.find(i=>i.id==='opportunity-shell'));
  assert.equal(expressionInventory({blocks:[{id:'p1',kind:'body',text:'I went to school to collect the map.'}]}).patterns.length,0);
});
test('every to candidate and repeated frame needs a disposition even if all policy checks are unverified',async t=>{
  const session=await fixture(t,'I need to visit. I hope to stay.'),p=await prepareRuleReview(root,session);
  assert.equal(p.expressionInventory.to.length,2);assert.ok(p.expressionInventory.patterns.length);
  const r=structuredClone(p.template);r.expression.to.pop();await assert.rejects(reviewRules(root,session,r),{code:'rule-review-coverage'});
  const repeat=structuredClone(p.template);Object.assign(repeat.expression.patterns[0],{judgment:'repetitive-template',status:'retain',operation:'retain',reason:'A declared repeated frame.'});
  assert.ok((await reviewRules(root,session,repeat)).blockers.some(b=>b.code==='expression-pattern-needs-rework'));
});
test('material logic gaps invalidate only attributed high ratings; optional improvements and unrelated maxima remain possible',()=>{
  const r={items:[{id:'C2.2',score:5},{id:'V5.1',score:5}],criticalChecks:[{id:'causal-chain',status:'needs-rework'}],issues:[{id:'gap',itemIds:['C2.2'],severity:'material',decision:'revise'}]};
  let x=logicScoreConsistency(r);assert.equal(x.verified,false);assert.deepEqual(x.conflicts[0].itemIds,['C2.2']);
  r.items[0].score=3;x=logicScoreConsistency(r);assert.equal(x.verified,true);assert.equal(r.items[1].score,5);
  r.items[0].score=5;r.issues[0].severity='optional';r.criticalChecks[0].status='clear';assert.equal(logicScoreConsistency(r).verified,true);
  r.criticalChecks[0].status='needs-rework';assert.equal(logicScoreConsistency(r).conflicts[0].code,'material-logic-gap-needs-criterion-attribution');
  const choice={items:[{id:'P1.4',score:5}],criticalChecks:[],issues:[{id:'choice-gap',itemIds:['P1.4'],severity:'material',decision:'revise'}]};
  assert.equal(logicScoreConsistency(choice).conflicts[0].code,'material-logic-gap-score-above-three');
});
