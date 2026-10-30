import test from 'node:test';
import assert from 'node:assert/strict';
import{mkdtemp,rm,stat}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join,resolve}from'node:path';
import{randomUUID}from'node:crypto';
import{Store}from'../src/store.mjs';
import{Pipeline}from'../src/pipeline.mjs';
// Entirely synthetic declarations. This checks seven real SDK contracts, never actual model prose quality.
function syntheticRecord(user){
 if(user.phase==='diagnose')return{promptQuote:'',genre:'academic',centralAnswer:'The door is blue.',concerns:[],instructionConflicts:[],missingFacts:[]};
 const r=structuredClone(user.template),catalog=user.evidenceCatalog??{},d=Object.entries(catalog).find(([,x])=>x.source==='document'),o=Object.entries(catalog).find(([,x])=>x.source==='original');
 const anchors=d?[{$ref:d[0]}]:[];
 if(user.phase.startsWith('rules-')){r.checks.forEach(c=>Object.assign(c,{status:'PASS',reason:'Synthetic bound scene description is retained.',evidence:[{kind:'document',span:anchors[0]}],authority:'',details:[{requirement:c.checkId+' synthetic contract fixture',status:'PASS',reason:'This fixture declares a review, not semantic certification.',evidence:[{kind:'document',span:anchors[0]}],authority:''}]}));return r;}
 if(user.phase==='grammar')return r;
 if(user.phase==='source'){
  r.passages.forEach(p=>Object.assign(p,{sources:[{$ref:o[0]}],changeKind:'expression',semanticStatus:'preserved',semanticNote:'The same supplied color is stated.',voiceStatus:'preserved',voiceNote:'The source wording is unchanged.',function:'event',relevanceStatus:'relevant',relevanceNote:'The prompt asks for the scene.',verdict:'retain'}));
  r.wholeDocument={verdict:'retain',standaloneReason:'The object and color are explicit.',interchangeabilityReason:'This is the exact supplied scene.',endingReason:'The statement ends after its source detail.'};return r;
 }
 if(user.phase==='answer'){
  r.response={status:'answered',promptInterpretation:'Describe the supplied scene.',readerTakeaway:'The door is blue.',anchors,reason:'The supplied color describes the scene.'};r.relationsReason='No additional relationship is asserted.';r.conclusionsReason='No inference extends beyond the description.';r.selection={status:'relevant',anchors,reason:'The color describes the scene.'};r.standaloneRead={status:'clear',anchors,reason:'Object and color are stated.',questions:[]};r.recommendation='adopt';return r;
 }
 if(user.phase==='style'){
  r.paragraphs.forEach(p=>Object.assign(p,{purpose:'Describe the door.',concreteContent:'The supplied blue door.',status:'distinct',reason:'A single feature answers the question.'}));
  r.languageChecks.forEach(c=>Object.assign(c,{anchors,observation:'The exact source description remains.',decision:'retain',reason:'No added meaning or qualification.',retainCounterexample:'A precise plain description can remain.'}));
  r.patternsReason='No repeated paragraph pattern in one statement.';r.voice={status:'unavailable',anchors:[],preserve:'Keep this supplied description.',avoidCopying:'No other author is a reference.',reason:'No independent voice sample supplied.'};r.feedbackReason='No detector supplied.';r.protectedChoices.forEach(c=>c.reason='The source scene detail remains.');r.overall={status:'retain',reason:'The source description addresses the task.'};r.recommendation='adopt';return r;
 }
 if(user.phase==='linguistic'){
  r.decisions.forEach(c=>Object.assign(c,{decision:'retain',linguisticObservation:'A surface candidate requires context.',informationFunction:'context',sourceBasis:'editorial-hypothesis',originalAnchors:[],referents:[],perspective:'not-applicable',clauseFunction:'not-applicable',reason:'The same source feature remains.',preserveCounterexample:'A useful plain description can stay.'}));
  r.paragraphs.forEach(p=>Object.assign(p,{role:'context',status:'retain',informationIncrement:'The source color is stated.',authorAccess:'This is the supplied description.'}));r.overall={decision:'retain',reason:'References are declared, not grammar certified.'};return r;
 }
 if(user.phase==='discourse'){
  r.windows.forEach(w=>Object.assign(w,{sentences:w.sentences.map(s=>({...s,informationGain:'The source color is given.'})),readerConnection:'One explicit scene detail.',alternative:{kind:'deletion',text:'Delete this statement.',informationLost:'The only scene feature.',choice:'retain',reason:'The feature answers the prompt.'},decision:'retain',reason:'The sole description is useful.'}));
  Object.assign(r.order,{alternativeOrder:[...r.order.currentOrder],currentOrderReason:'There is one description.',alternativeOrderReason:'No distinct permutation exists.',sourceLimit:'No further sequence is supplied.',choice:'retain',decision:'retain',reason:'The one description remains.'});r.recommendation='adopt';return r;
 }
 if(user.phase==='logic'){
  r.centralAnswer='The supplied door is blue.';r.requirements.forEach(q=>Object.assign(q,{requirement:'Describe the supplied scene.',status:'answered',answerAnchors:anchors,reason:'The object and color supply the answer.'}));
  r.paragraphs.forEach(p=>Object.assign(p,{requirementIds:r.requirements.map(q=>q.id),contribution:'State the supplied door color.',status:'supports-answer',claimCoverageReason:'No additional inference or outcome is claimed.',reason:'The scene feature answers the question.'}));
  for(const k of ['makesSense','convincing','answersPrompt'])r.overall[k]={status:'clear',reason:'The exact supplied feature is explicit.',anchors};r.overall.skepticalReading='This fixture adds no causal inference or achievement.';r.recommendation='adopt';return r;
 }
 throw new Error('unknown synthetic phase '+user.phase);
}
test('a synthetic full pipeline revalidates all seven actual raw SDK reviews and preserves advisor instructions',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'essay-pipeline-')),store=new Store(dir,{bootstrapPassword:'synthetic-only-password'});t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 store.setProvider('glm','synthetic-only-standard-api-key');const user=store.login('admin','synthetic-only-password').user;
 const instructions='Preserve the exact source color and use a direct sentence.';
 const input={requestId:randomUUID(),text:'The door was blue.',prompt:'Describe the supplied scene.',title:'Synthetic contract fixture',instructions,mode:'review',language:'en',genre:'academic',maxWords:null};
 const id=store.createJob(user.id,input,'glm'),observed=[];
 const pipeline=new Pipeline({store,policyRoot:resolve('../essay-writer'),dataRoot:dir,modelCall:async args=>{observed.push(args.user.task.instructions);return{value:syntheticRecord(args.user),model:'SYNTHETIC-CONTRACT-FIXTURE',cost:{known:true,cny:0.0001},latencyMs:1};}});
 await pipeline.run(id);const job=store.internalJob(id);assert.equal(job.state,'completed',job.detail);assert.equal(job.result.quality,'ready-for-human-review',JSON.stringify(job.result.reviewErrors));
 assert.deepEqual(job.result.workflow.reviews.map(r=>r.name),['rules','source','answer','style','linguistic','discourse','logic']);assert.ok(job.result.workflow.reviews.every(r=>r.state==='recorded'));
 assert.equal(job.result.deliveryAuthorized,false);assert.equal(job.result.workflow.factsCertified,false);assert.ok(observed.length>7&&observed.every(x=>x===instructions));
 assert.ok((await stat(join(dir,'jobs',id,'working-draft.docx'))).size>100);
});
