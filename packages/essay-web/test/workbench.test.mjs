import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile}from'node:fs/promises';
import {tmpdir}from'node:os';
import {join,resolve}from'node:path';
import {randomUUID}from'node:crypto';
import {Store}from'../src/store.mjs';
import {usageCost,callModel,PROVIDERS}from'../src/providers.mjs';
import {referencePack,expandReferences,bindMetadata,reviewWireSchema}from'../src/references.mjs';
import {ruleReviewSchema}from'@mantou/essay-writer/dist/rule-review.js';
import {z}from'zod';
import {createWorkbench}from'../src/server.mjs';
import {limitModelCalls}from'../src/model-queue.mjs';
import {writeDocx}from'@mantou/essay-writer/dist/documents.js';
const secret='synthetic-secret-ONLY-not-live';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'essay-web-'));const store=new Store(dir,{bootstrapPassword:secret});t.after(()=>{store.close();return rm(dir,{recursive:true,force:true});});return{store,dir};}
test('employee passwords are hashed, sessions authenticate, and disable revokes access',async t=>{
 const{store}=await fixture(t);assert.equal(store.login('admin','wrong'),null);const a=store.login('admin',secret);assert.equal(store.user(a.token).role,'admin');
 const user=store.addUser({username:'mira',name:'Mira',password:secret});const login=store.login('mira',secret);assert.equal(store.user(login.token).id,user.id);store.setDisabled(user.id,true);assert.equal(store.user(login.token),null);
 assert.ok(!JSON.stringify(store.listUsers()).includes(secret));assert.ok(!JSON.stringify(store.db.prepare('SELECT password_hash FROM users').all()).includes(secret));
});
test('provider secrets are encrypted at rest and never included in status',async t=>{
 const{store,dir}=await fixture(t);store.setProvider('glm',secret);assert.equal(store.providerKey('glm'),secret);assert.ok(!JSON.stringify(store.providerStatus()).includes(secret));
 assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM providers').all()).includes(secret));assert.ok(!(await readFile(join(dir,'workbench.sqlite'))).includes(Buffer.from(secret)));
 assert.throws(()=>store.setProvider('elsewhere',secret));
});
test('request keys are idempotent per employee and provider; conflicting reuse is rejected',async t=>{
 const{store}=await fixture(t);const user=store.login('admin',secret).user,input={requestId:randomUUID(),text:'The door was blue.',title:'Synthetic'};
 const rows=store.createJobs(user.id,input,['glm','deepseek']);assert.equal(rows.length,2);assert.deepEqual(store.createJobs(user.id,input,['glm','deepseek']),rows);assert.equal(store.listJobs(user.id).length,2);
 assert.throws(()=>store.createJobs(user.id,{...input,text:'Changed.'},['glm','deepseek']),/request-id-conflict/);
 const other=store.addUser({username:'other',name:'Other',password:secret});assert.equal(store.getJob(other.id,rows[0].id),null);
});
test('known usage settles reservations; missing usage conservatively consumes its reservation',async t=>{
 const{store}=await fixture(t);const user=store.login('admin',secret).user,id=store.createJob(user.id,{requestId:randomUUID(),text:'Synthetic'},'glm');store.updateJob(id,'running','test');
 const call=store.reserveCall(id,'test','glm',0.2,{maxCost:0.3});assert.throws(()=>store.reserveCall(id,'test','glm',0.2,{maxCost:0.3}),/job-budget/);
 store.finishCall(call,{cost:{known:true,cny:0.02}});assert.equal(store.internalJob(id).reserved,0);assert.equal(store.internalJob(id).cost,0.02);
 const next=store.reserveCall(id,'test','glm',0.2,{maxCost:0.3});store.finishCall(next,null);assert.equal(store.internalJob(id).unknown_usage,1);assert.ok(store.internalJob(id).cost>0.21);assert.throws(()=>store.reserveCall(id,'test','glm',-1));
});
test('terminal cancellation cannot be overwritten by a late successful result',async t=>{
 const{store}=await fixture(t);const user=store.login('admin',secret).user,id=store.createJob(user.id,{requestId:randomUUID(),text:'Synthetic'},'glm');store.updateJob(id,'running','test');assert.equal(store.cancelQueued(user.id,id),true);
 assert.equal(store.updateJob(id,'completed','done','',{body:'Late result'}),false);assert.equal(store.updateJob(id,'running','again'),false);assert.equal(store.internalJob(id).state,'cancelled');assert.equal(store.internalJob(id).result,null);
});
test('admin connection tests and jobs share the daily cost ledger',async t=>{
 const{store}=await fixture(t),user=store.login('admin',secret).user;const call=store.reserveAdminCall(user.id,'glm',0.01);assert.equal(store.dailyTotal(),0.01);store.finishAdminCall(call,{cost:{known:true,cny:0.002}});assert.equal(store.dailyTotal(),0.002);
 assert.throws(()=>store.reserveAdminCall(user.id,'glm',50),/daily-api-budget/);assert.equal(store.db.prepare('SELECT state FROM admin_calls WHERE id=?').get(call).state,'recorded');
});
test('not-sent cancellation releases reserved costs without inventing vendor usage',async t=>{
 const{store}=await fixture(t),user=store.login('admin',secret).user,id=store.createJob(user.id,{requestId:randomUUID(),text:'Synthetic'},'glm');store.updateJob(id,'running','test');const call=store.reserveCall(id,'test','glm',0.2);store.finishUnsentCall(call);assert.equal(store.internalJob(id).cost,0);assert.equal(store.internalJob(id).unknown_usage,0);assert.equal(store.callsFor(id)[0].state,'not-sent');assert.equal(store.callsFor(id)[0].usage.requestSent,false);
});
test('provider concurrency is bounded and cancelled waiting requests are never sent',async()=>{
 let active=0,peak=0,sent=0;const invoke=limitModelCalls(async()=>{active++;peak=Math.max(peak,active);sent++;await new Promise(r=>setTimeout(r,5));active--;return{};},2);
 const results=await Promise.allSettled([invoke({provider:'glm'}),invoke({provider:'glm'}),invoke({provider:'glm',shouldRun:()=>false}),invoke({provider:'glm'})]);assert.equal(peak,2);assert.equal(sent,3);assert.equal(results[2].status,'rejected');assert.equal(results[2].reason.notSent,true);
});
test('cost uses output usage once, includes cache details, and never invents zero for unknown usage',()=>{
 assert.equal(usageCost('glm',{prompt_tokens:50000,completion_tokens:15000}).cny,0.082);
 assert.equal(usageCost('deepseek',{prompt_tokens:50000,completion_tokens:15000}).cny,0.22);
 assert.equal(usageCost('glm',null).known,false);assert.equal(usageCost('glm',{prompt_tokens:100}).cny,null);
 assert.equal(usageCost('glm',{prompt_tokens:-1,completion_tokens:10}).known,false);assert.equal(usageCost('glm',{prompt_tokens:1,completion_tokens:10,prompt_cache_hit_tokens:2}).known,false);
 const u=usageCost('glm',{prompt_tokens:10000,prompt_tokens_details:{cached_tokens:8000},completion_tokens:3000,completion_tokens_details:{reasoning_tokens:2000}});assert.equal(u.outputTokens,3000);assert.equal(u.cachedTokens,8000);
});
test('the provider adapter fixes endpoints, sends standard keys only as headers and limits output',async()=>{
 let request;const fake=async(url,options)=>{request={url,...options};return new Response(JSON.stringify({model:'actual-model',usage:{prompt_tokens:10,completion_tokens:20},choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));};
 const r=await callModel({provider:'glm',key:secret,system:'Return JSON',user:{task:'synthetic'},employeeId:'non-pii-id',fetchImpl:fake,maxTokens:1000});assert.equal(r.value.ok,true);assert.equal(request.url,PROVIDERS.glm.url);
 const payload=JSON.parse(request.body);assert.equal(payload.thinking.type,'enabled');assert.equal(payload.max_tokens,1000);assert.equal(payload.model,'glm-5.3-flash');assert.ok(!request.body.includes(secret));
 await assert.rejects(callModel({provider:'https://example.com',key:secret,system:'',user:'',fetchImpl:fake}),/invalid-provider/);
 await callModel({provider:'deepseek',key:secret,system:'JSON',user:'Synthetic logic check',phase:'logic',maxTokens:16384,fetchImpl:fake});const logic=JSON.parse(request.body);assert.equal(logic.thinking.type,'enabled');assert.equal(logic.reasoning_effort,'low');assert.equal(logic.max_tokens,16384);
 await callModel({provider:'deepseek',key:secret,system:'JSON',user:'Synthetic draft',phase:'draft',fetchImpl:fake});assert.equal(JSON.parse(request.body).thinking.type,'enabled');assert.equal(JSON.parse(request.body).reasoning_effort,'low');
});
test('truncation and malformed JSON do not hide billed usage',async()=>{
 let charged=0;const fake=async()=>new Response(JSON.stringify({usage:{prompt_tokens:10,completion_tokens:100},choices:[{finish_reason:'length',message:{content:'{}'}}]}));
 await assert.rejects(callModel({provider:'deepseek',key:secret,system:'JSON',user:'test',fetchImpl:fake,onUsage:()=>{charged++;}}),/model-output-truncated/);assert.equal(charged,1);
 for(const finish of ['content_filter','tool_calls',null]){const response=async()=>new Response(JSON.stringify({usage:{prompt_tokens:10,completion_tokens:100},choices:[{finish_reason:finish,message:{content:'{"ok":true}'}}]}));await assert.rejects(callModel({provider:'glm',key:secret,system:'JSON',user:'test',fetchImpl:response,onUsage:()=>{charged++;}}),/model-output-incomplete/);}assert.equal(charged,4);
});
test('Unicode references expand exactly; unknown, prototype and ambiguous evidence is rejected',()=>{
 const document={revision:'v1',blocks:[{id:'p1',text:'😀 I closed the door. I closed the door.'}]},original={revision:'o1',blocks:[{id:'p1',text:'The wall was blue.'}]};
 const pack=referencePack({anchor:{blockId:'p1',start:0,end:1,quote:'😀'}},document,original);assert.deepEqual(expandReferences(pack.value,pack.catalog,document,original).anchor,{blockId:'p1',start:0,end:1,quote:'😀'});
 for(const id of ['a999','__proto__','toString'])assert.throws(()=>expandReferences({$ref:id},pack.catalog,document,original),/unknown/);
 assert.throws(()=>expandReferences({$quote:'I closed the door.',blockId:'p1'},pack.catalog,document,original),/not-unique/);
 assert.deepEqual(expandReferences({$quote:'The wall was blue.',blockId:'p1',source:'original'},pack.catalog,document,original),{blockId:'p1',start:0,end:18,quote:'The wall was blue.'});
 const bound=bindMetadata({status:'unverified',reason:''},{bindings:{current:'hash'},catalogHash:'a',schemaVersion:'v'});assert.equal(bound.status,'unverified');assert.equal(bound.reason,'');assert.ok(!('checks'in bound));
});
test('exact quoted evidence derives offsets in its declared source without changing text or judgments',()=>{
 const document={revision:'v1',blocks:[{id:'p1',text:'😀 New text. A repeated word: word.'}]},original={revision:'o1',blocks:[{id:'p1',text:'Old text.'}]};
 const pack=referencePack({passages:[{candidate:{blockId:'p1',start:0,end:11,quote:'😀 New text.'},sources:[{blockId:'p1',start:0,end:9,quote:'Old text.'}]}]},document,original);
 const originalRef=pack.value.passages[0].sources[0].$ref;assert.equal(pack.catalog[originalRef].source,'original');
 const raw={status:'FAIL',reason:'Keep this unresolved judgment.',passages:[{candidate:{blockId:'p1',start:100,end:110,quote:'😀 New text.'},sources:[{blockId:'p1',start:4,end:80,quote:'Old text.'}]}],omissions:[{source:{blockId:'p1',start:0,end:999,quote:'Old text.'},reason:'Declared omission.'}],evidence:[{kind:'original',span:{blockId:'p1',start:999,end:1000,quote:'Old text.'}}]};
 const result=expandReferences(raw,pack.catalog,document,original);assert.equal(result.status,'FAIL');assert.equal(result.reason,raw.reason);assert.equal(result.passages[0].candidate.start,0);assert.equal(result.passages[0].candidate.end,11);assert.equal(result.passages[0].sources[0].end,9);assert.equal(result.omissions[0].source.end,9);assert.equal(result.evidence[0].span.end,9);
 assert.throws(()=>expandReferences({blockId:'p1',start:0,end:4,quote:'word'},pack.catalog,document,original),/not-unique/);
 assert.throws(()=>expandReferences({blockId:'p1',start:0,end:8,quote:'New claim.'},pack.catalog,document,original),/not-unique/);
 assert.throws(()=>expandReferences({sources:[{blockId:'p1',start:0,end:9,quote:'New text.'}]},pack.catalog,document,original),/not-unique/);
 assert.equal(expandReferences({blockId:'p1',start:23,end:27,quote:'word'},pack.catalog,document,original).start,23);
 assert.deepEqual(expandReferences({promptSpan:{start:99,end:100,quote:'Describe the scene.'}},pack.catalog,document,original,'Describe the scene.').promptSpan,{start:0,end:19,quote:'Describe the scene.'});
});
test('wire schemas permit the exact reference protocol and omit only program-bound requirement hashes',()=>{
 const schema=z.toJSONSchema(ruleReviewSchema),before=JSON.stringify(schema),wire=reviewWireSchema(schema);
 assert.equal(JSON.stringify(schema),before);const checks=wire.properties.checks.items;assert.ok(!('requirementHash'in checks.properties));assert.ok(!checks.required.includes('requirementHash'));assert.deepEqual(checks.properties.status,schema.properties.checks.items.properties.status);
 assert.equal(checks.properties.details.minItems,1);
 const spans=[];function walk(v){if(!v||typeof v!=='object')return;if(v.anyOf?.some(s=>s.properties?.$ref))spans.push(v);Object.values(v).forEach(walk);}walk(wire);assert.ok(spans.length>0);for(const span of spans){assert.ok(span.anyOf.some(s=>s.required?.includes('$quote')));assert.ok(span.anyOf.some(s=>s.required?.includes('quote')&&s.required?.includes('start')));}
});
async function httpFixture(t,overrides={}){const dir=await mkdtemp(join(tmpdir(),'essay-http-'));const origin='http://127.0.0.1:8787';const app=await createWorkbench({dataDir:dir,origin,policyRoot:resolve('../essay-writer'),publicDir:resolve('public'),bootstrapPassword:secret,
 modelCall:async()=>{throw new Error('SYNTHETIC-STOP-NO-LIVE-MODEL');},...overrides});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const request=(path,{method='GET',body,cookie,requestOrigin=origin}={})=>fetch(url+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(method!=='GET'?{Origin:requestOrigin}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const response=await request('/api/login',{method:'POST',body:{username:'admin',password:secret}});const cookie=response.headers.get('set-cookie').split(';')[0];return{app,request,cookie};}
test('HTTP auth, admin boundaries, CSRF and private path isolation are enforced',async t=>{
 const{app,request,cookie}=await httpFixture(t);assert.equal((await request('/api/jobs')).status,401);assert.equal((await request('/runtime-data/master.key')).status,404);
 assert.equal((await request('/api/admin/staff',{method:'POST',cookie,requestOrigin:'https://evil.example',body:{}})).status,403);
 app.store.addUser({username:'reader',name:'Reader',password:secret});const login=await request('/api/login',{method:'POST',body:{username:'reader',password:secret}});const other=login.headers.get('set-cookie').split(';')[0];assert.equal((await request('/api/admin/providers',{cookie:other})).status,403);
 const input={requestId:randomUUID(),text:'Synthetic source.'},id=app.store.createJob(app.store.user(cookie.slice(14)).id,input,'glm');assert.equal((await request('/api/jobs/'+id,{cookie:other})).status,404);
 const html=await request('/');assert.ok(html.headers.get('content-security-policy').includes("script-src 'self'"));assert.equal((await request('/api/jobs',{method:'POST',cookie,body:{requestId:randomUUID(),text:'Source',model:'http://evil'}})).status,400);
});
test('HTTP upload extracts exact plain text and rejects unsupported formats without model calls',async t=>{
 const{app,request,cookie}=await httpFixture(t);const source='The door was blue.\n\nThe wall was white.';let r=await request('/api/extract',{method:'POST',cookie,body:{extension:'.txt',base64:Buffer.from(source).toString('base64')}});assert.equal((await r.json()).text,source);
 r=await request('/api/extract',{method:'POST',cookie,body:{extension:'.pdf',base64:'dGVzdA=='}});assert.equal(r.status,400);
 const windows='The door was blue.\r\nThe wall was white.';r=await request('/api/extract',{method:'POST',cookie,body:{extension:'.txt',base64:Buffer.from(windows).toString('base64')}});assert.equal((await r.json()).text,windows.replaceAll('\r\n','\n'));
 const bytes=writeDocx('',{revision:'sample',blocks:[{id:'p1',text:'The door was blue.'}]});r=await request('/api/extract',{method:'POST',cookie,body:{extension:'.docx',base64:Buffer.from(bytes).toString('base64')}});assert.equal((await r.json()).text,'The door was blue.');
 assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM calls').get().n,0);
});
test('HTTP requests cannot enable mocks, expose provider keys or duplicate jobs',async t=>{
 const{app,request,cookie}=await httpFixture(t);app.store.setProvider('glm',secret);const payload={requestId:randomUUID(),text:'The door was blue.',model:'glm',prompt:'Describe the supplied scene.'};
 let r=await request('/api/jobs',{method:'POST',cookie,body:{...payload,mock:true}});assert.equal(r.status,400);
 r=await request('/api/jobs',{method:'POST',cookie,body:payload});assert.equal(r.status,202);const a=await r.json();r=await request('/api/jobs',{method:'POST',cookie,body:payload});const b=await r.json();assert.deepEqual(a.jobs,b.jobs);
 const status=await(await request('/api/admin/providers',{cookie})).text();assert.ok(!status.includes(secret));
 await new Promise(r=>setTimeout(r,25));assert.equal(app.store.listJobs(app.store.user(cookie.slice(14)).id).length,1);
});
test('successful login does not lock other employees out; blank source is rejected before any model call',async t=>{
 const{app,request,cookie}=await httpFixture(t);for(let i=0;i<12;i++)assert.equal((await request('/api/login',{method:'POST',body:{username:'admin',password:secret}})).status,200);
 app.store.setProvider('glm',secret);const r=await request('/api/jobs',{method:'POST',cookie,body:{requestId:randomUUID(),text:' \n\t ',model:'glm'}});assert.equal(r.status,400);assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM calls').get().n,0);
});
test('the default task budget allows ten yuan and blocks further reservations without changing password policy',async t=>{
 const{app,cookie}=await httpFixture(t);assert.equal(app.pipeline.maxCost,10);
 const user=app.store.user(cookie.slice(14)),id=app.store.createJob(user.id,{text:'Synthetic'},'glm');app.store.updateJob(id,'running','Synthetic');
 const first=app.store.reserveCall(id,'test','glm',9.75);app.store.reserveCall(id,'test','glm',0.25);
 assert.equal(app.store.internalJob(id).reserved,10);assert.throws(()=>app.store.reserveCall(id,'test','glm',0.01),/job-budget-or-call-limit/);
 app.store.finishCall(first,{cost:{known:true,cny:0.5}});assert.equal(app.store.internalJob(id).cost,0.5);
 assert.throws(()=>app.store.addUser({username:'shorttest',name:'Synthetic',password:'shorttest'}),/invalid-account/);
 assert.throws(()=>app.store.changePassword(user.id,'short'),/invalid-password/);
});
test('browser responses and review downloads omit monetary fields while internal billing remains intact',async t=>{
 const{app,request,cookie}=await httpFixture(t,{modelCall:async()=>({value:{ok:true},model:'SYNTHETIC',cost:{known:true,cny:0.001}})});
 app.store.setProvider('glm',secret);const user=app.store.user(cookie.slice(14)),id=app.store.createJob(user.id,{text:'The cost was disputed.'},'glm');app.store.updateJob(id,'running','Synthetic');
 const a=app.store.reserveCall(id,'known','glm',0.2);app.store.finishCall(a,{model:'SYNTHETIC',cost:{known:true,cny:0.125},latencyMs:1});
 const b=app.store.reserveCall(id,'unknown','glm',0.05);app.store.finishCall(b,null);
 const result={body:'The cost was disputed.',quality:'needs-rework',deliveryAuthorized:false,reviewResults:{rules:{execution:{settings:'独立请求；固定端点；JSON校验；有界输出与费用'}}}};app.store.updateJob(id,'completed','待返修','',result);
 const projected=structuredClone(result);projected.reviewResults.rules.execution.settings='独立请求；固定端点；JSON校验；有界输出与调用';
 const forbidden=new Set(['cost','reserved','usage','usage_json','unknownUsage','unknown_usage','maxCostPerModel']);
 function check(value){if(!value||typeof value!=='object')return;for(const[key,item]of Object.entries(value)){assert.ok(!forbidden.has(key),key);check(item);}}
 for(const path of ['/api/session','/api/jobs','/api/jobs/'+id,'/api/jobs/'+id+'/report']){const response=await request(path,{cookie});assert.equal(response.status,200);const data=await response.json();check(data);if(data.result)assert.deepEqual(data.result,projected);if(data.job?.result)assert.deepEqual(data.job.result,projected);}
 const ping=await request('/api/admin/providers/glm/test',{method:'POST',cookie});assert.equal(ping.status,200);check(await ping.json());
 assert.equal(app.store.internalJob(id).cost,0.175);assert.equal(app.store.internalJob(id).unknown_usage,1);assert.deepEqual(app.store.internalJob(id).result,result);assert.equal(app.store.callsFor(id)[0].usage.cost.cny,0.125);assert.equal(app.store.db.prepare('SELECT cost FROM admin_calls').get().cost,0.001);
 for(const detail of ['job-budget-or-call-limit','daily-api-budget-limit','provider-timeout']){const blocked=app.store.createJob(user.id,{text:'Synthetic'},'glm');app.store.updateJob(blocked,'failed','本轮未完成',detail);const data=await(await request('/api/jobs/'+blocked,{cookie})).json();assert.doesNotMatch(data.job.detail,/费用|金额|[¥￥]/);}
 for(const path of ['/','/app.js']){const text=await(await request(path)).text();assert.doesNotMatch(text,/result-cost|maxCostPerModel|费用|[¥￥]/);}
});
