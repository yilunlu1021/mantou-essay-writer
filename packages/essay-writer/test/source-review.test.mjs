import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {contextSchema} from '@mantou/text-quality';
import {importSession,prepareSourceReview,reviewSource,loadSession,patchTemplate,reviseSession} from '../dist/index.js';
const root=resolve('.');
const context=contextSchema.parse({language:'en',genre:'personal-narrative',authorRole:'student',audience:'reader'});
const span=(text,blockId='p1',start=0)=>({blockId,start,end:start+Array.from(text).length,quote:text});
async function fixture(t,text='Nobody volunteered to read. I tried.'){
  const dir=await mkdtemp(join(tmpdir(),'humanier-review-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=join(dir,'source.txt'),out=join(dir,'session');await writeFile(input,text);
  await importSession(root,{input,out,context});return out;
}
async function record(out){
  const prep=await prepareSourceReview(root,out);const value=structuredClone(prep.template);
  value.passages=value.passages.map((p,i)=>({...p,sources:[span(prep.original.blocks[i].text,prep.original.blocks[i].id)],
    semanticStatus:'preserved',semanticNote:'The same attempt and outcome are stated.',voiceStatus:'preserved',
    voiceNote:'The direct first-person judgment is retained.',relevanceStatus:'relevant',relevanceNote:'The absence of volunteers explains the choice to try.',verdict:'retain'}));
  value.wholeDocument={verdict:'retain',standaloneReason:'The actor and choice are explicit.',
    interchangeabilityReason:'The choice depends on the stated absence of volunteers.',endingReason:'The attempt completes the action.'};return value;
}
test('useful plain language is recorded without claiming authorship or semantic approval',async t=>{
  const out=await fixture(t);const value=await record(out);const before=await loadSession(root,out);
  const bytes=await readFile(join(out,'versions/v0000/audit.json'));
  const result=await reviewSource(root,out,value);
  assert.equal(result.reviewDecision,'recorded');assert.equal(result.coverageVerified,true);
  for(const key of ['deliveryAuthorized','semanticEquivalenceChecked','voiceCertified','containsDocumentText'])assert.equal(result[key],false);
  assert.equal(result.requiresHumanReview,true);assert.ok(!JSON.stringify(result).includes('Nobody volunteered'));
  assert.equal((await loadSession(root,out)).current.versionHash,before.current.versionHash);
  assert.deepEqual(await readFile(join(out,'versions/v0000/audit.json')),bytes);
});
test('stale bindings and forged source or candidate quotes are rejected',async t=>{
  const out=await fixture(t);const value=await record(out);
  for(const key of Object.keys(value.bindings)){
    const altered=structuredClone(value);altered.bindings[key]='0'.repeat(64);
    await assert.rejects(reviewSource(root,out,altered),{code:'source-review-stale'});
  }
  for(const target of ['candidate','source']){
    const altered=structuredClone(value);(target==='candidate'?altered.passages[0].candidate:altered.passages[0].sources[0]).quote='A fabricated event.';
    await assert.rejects(reviewSource(root,out,altered),{code:'source-review-span'});
  }
});
test('candidate gaps, overlap, source gaps, invalid ranges and blank notes are rejected',async t=>{
  const out=await fixture(t);const value=await record(out);
  const gap=structuredClone(value);gap.passages[0].candidate=span('Nobody volunteered to read.');
  await assert.rejects(reviewSource(root,out,gap),{code:'source-review-incomplete'});
  const overlap=structuredClone(value);overlap.passages.push(overlap.passages[0]);
  await assert.rejects(reviewSource(root,out,overlap),{code:'source-review-overlap'});
  const missing=structuredClone(value);missing.passages[0].sources=[span('Nobody volunteered to read.')];
  await assert.rejects(reviewSource(root,out,missing),{code:'source-review-incomplete'});
  const bounds=structuredClone(value);bounds.passages[0].candidate.end+=1;
  await assert.rejects(reviewSource(root,out,bounds),{code:'source-review-span'});
  const blank=structuredClone(value);blank.passages[0].voiceNote='  ';
  await assert.rejects(reviewSource(root,out,blank));
});
test('deletions require a reason and source coverage while Unicode uses codepoints',async t=>{
  const text='😀 I felt like a champion. The club had five medals.';const out=await fixture(t,text);
  const s=await loadSession(root,out);const cut=' The club had five medals.';
  await reviseSession(root,out,{...patchTemplate(s.manifest.context,s.document,s.policy),patches:[{
    blockId:'p1',start:Array.from(text).length-cut.length,end:Array.from(text).length,expectedText:cut,replacement:'',
    reason:'The club medals do not explain the student judgment.'}]});
  const prep=await prepareSourceReview(root,out);const value=await record(out);const retained='😀 I felt like a champion.';
  value.passages[0].sources=[span(retained)];value.passages[0].voiceNote='The subjective excitement remains unqualified.';
  await assert.rejects(reviewSource(root,out,value),{code:'source-review-incomplete'});
  value.omissions=[{source:span(cut,'p1',Array.from(retained).length),reason:'Sourced club history adds no necessary context to the personal judgment.'}];
  assert.equal((await reviewSource(root,out,value)).reviewDecision,'recorded');
  const wrong=structuredClone(value);wrong.passages[0].candidate.end=retained.length;
  await assert.rejects(reviewSource(root,out,wrong),{code:'source-review-span'});
  assert.equal(prep.original.blocks[0].text,text);
});
test('added psychology, adult qualifications, weak relevance and unresolved review stay rework',async t=>{
  const out=await fixture(t,'I felt like a champion.');const value=await record(out);
  const cases=[
    {changeKind:'meaning',semanticNote:'The rewrite substitutes fear of disappointing the teacher for an unspecified fear.'},
    {voiceStatus:'unresolved',voiceNote:'An adult qualification has softened the original excited comparison.'},
    {changeKind:'addition',semanticNote:'The new causal explanation is absent from the source.'},
    {relevanceStatus:'padding',relevanceNote:'The sourced club medals were inserted only to reach the length floor.'},
    {relevanceStatus:'unresolved',relevanceNote:'The sourced club history may not explain this personal choice.'},
    {semanticStatus:'unresolved',semanticNote:'The actor behind the new motive is unclear.'}
  ];
  for(const fields of cases){const changed=structuredClone(value);Object.assign(changed.passages[0],fields);
    const result=await reviewSource(root,out,changed);assert.equal(result.reviewDecision,'needs-rework');assert.deepEqual(result.reworkPassages,[1]);}
  value.wholeDocument.verdict='rework';assert.equal((await reviewSource(root,out,value)).reviewDecision,'needs-rework');
});
test('cross-block and repeated source references are valid and revision makes a review stale',async t=>{
  const out=await fixture(t,'I tried.\n\nWe stayed.');const value=await record(out);
  value.passages[0].sources.push(span('We stayed.','p2'));assert.equal((await reviewSource(root,out,value)).reviewDecision,'recorded');
  const s=await loadSession(root,out);await reviseSession(root,out,{...patchTemplate(s.manifest.context,s.document,s.policy),patches:[{
    blockId:'p1',start:2,end:7,expectedText:'tried',replacement:'read',reason:'Correct the stated action.'}]});
  await assert.rejects(reviewSource(root,out,value),{code:'source-review-stale'});
});
