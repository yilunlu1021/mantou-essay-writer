import { createServer } from 'node:http';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { importText } from '@mantou/essay-writer/dist/documents.js';
import { Store } from './store.mjs';
import { Pipeline } from './pipeline.mjs';
import { PROVIDERS, callModel } from './providers.mjs';
import { limitModelCalls } from './model-queue.mjs';

const MAX_BYTES=8_500_000;
const jobInput=z.object({requestId:z.string().uuid(),title:z.string().trim().max(120).default(''),text:z.string().min(1).max(60000).refine(t=>!!t.trim(),'Source text is blank'),prompt:z.string().max(10000).default(''),instructions:z.string().max(6000).default(''),
  mode:z.enum(['review','edit','revision']).default('edit'),language:z.enum(['en','zh','mixed']).default('en'),genre:z.enum(['auto','personal-narrative','application-explanatory','academic','general']).default('auto'),
  maxWords:z.number().int().min(20).max(20000).nullable().default(null),model:z.enum(['glm','deepseek','compare']).default('glm'),
  fileBase64:z.string().max(7_000_000).optional(),fileExtension:z.enum(['.docx','.txt','.md']).optional()}).strict();
const messages={'provider-not-configured':'请管理员先配置所选模型的标准API密钥。','provider-key-rejected':'模型密钥被拒绝，请管理员检查标准API密钥和账户权限。',
  'provider-rate-limited':'模型服务限流，本轮已保留记录，可稍后再试。','provider-timeout':'模型请求超时，请求状态尚未确认，本轮已停止。',
  'job-budget-or-call-limit':'本轮已到处理上限，已有稿件及检查记录已保留。','daily-api-budget-limit':'今天已到网站处理上限，请联系管理员。',
  'model-output-truncated':'模型输出被截断，本轮已保留用量记录。','model-output-incomplete':'模型服务未完成本次输出，本轮已停止。','model-invalid-json':'模型未返回有效的检查记录，本轮已保留待核状态。',
  'docx-structure':'文档含无法可靠自动读取的结构，请提供清洁正文DOCX或粘贴文字。'};
const safeError=e=>messages[e?.code??e?.message]??(e?.issues?'输入格式或长度不符合要求。':'本次操作未完成，请检查输入或联系管理员。');
export async function createWorkbench({dataDir,origin='http://127.0.0.1:8787',policyRoot,publicDir,bootstrapPassword,modelCall,maxCost=10,concurrency=2}={}){
  origin=new URL(origin).origin;
  const base=dirname(fileURLToPath(import.meta.url));dataDir=resolve(dataDir??join(base,'../runtime-data'));policyRoot??=base;publicDir??=join(base,'public');
  await mkdir(dataDir,{recursive:true,mode:0o700});const store=new Store(dataDir,{bootstrapPassword}),invokeModel=limitModelCalls(modelCall??callModel,2),pipeline=new Pipeline({store,policyRoot,dataRoot:dataDir,maxCost,modelCall:invokeModel});
  // Monetary accounting stays server-side, including downloadable review records.
  const publicCalls=id=>store.callsFor(id).map(({phase,provider,state,usage})=>({phase,provider,state,model:usage?.model??null}));
  const publicResult=result=>{
    const rules=result?.reviewResults?.rules;if(!rules?.execution)return result;
    return {...result,reviewResults:{...result.reviewResults,rules:{...rules,execution:{...rules.execution,settings:'独立请求；固定端点；JSON校验；有界输出与调用'}}}};
  };
  const queue=[];let active=0;const limits=new Map();
  function limit(key,max=15,window=60000){const now=Date.now(),old=limits.get(key),r=old&&old.until>now?old:{count:0,until:now+window};r.count++;limits.set(key,r);if(limits.size>10000)for(const[k,x]of limits)if(x.until<now)limits.delete(k);return r.count<=max;}
  function drain(){while(active<concurrency&&queue.length){const id=queue.shift();active++;pipeline.run(id).catch(()=>store.updateJob(id,'failed','本轮未完成','服务处理失败，请联系管理员。')).finally(()=>{active--;drain();});}}
  const server=createServer(async(req,res)=>{
    const headers={'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Cache-Control':'no-store','X-Frame-Options':'DENY'};
    for(const[k,v]of Object.entries(headers))res.setHeader(k,v);
    const send=(status,value,extra={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(value));};
    const token=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('essay_session='))?.slice(14),user=store.user(token);
    if(user)res.setHeader('X-Essay-User',user.id);
    let url;try{url=new URL(req.url,origin);}catch{return send(400,{error:'invalid-request'});}
    const path=url.pathname;
    try{
      if(path==='/health'&&req.method==='GET')return send(200,{status:'ok',version:'0.1.0'});
      if(path.startsWith('/api/')&&req.method!=='GET'&&req.headers.origin!==origin)return send(403,{error:'origin-rejected',message:'请从本网站提交操作。'});
      if(path.startsWith('/api/')&&path!=='/api/login'&&req.method!=='GET'&&user&&req.headers['x-essay-actor']&&req.headers['x-essay-actor']!==user.id)return send(409,{error:'account-changed',message:'登录账号已变化，请重新进入工作台。'});
      const body=async()=>{const chunks=[];let n=0;for await(const chunk of req){n+=chunk.length;if(n>MAX_BYTES)throw new Error('request-too-large');chunks.push(chunk);}const data=Buffer.concat(chunks);try{return JSON.parse(data.toString('utf8'));}catch{throw new Error('invalid-json');}};
      if(path==='/api/session'&&req.method==='GET')return send(200,{user,providers:store.providerStatus().map(p=>({...p,label:PROVIDERS[p.id].label})),policyVersion:(await pipeline.policyPromise).version,limits:{formats:['.docx','.txt','.md']}});
      if(path==='/api/login'&&req.method==='POST'){
        const input=await body();if(typeof input.username!=='string'||typeof input.password!=='string'||input.username.length>60||input.password.length>200)return send(400,{error:'invalid-login'});
        const peer=req.socket.remoteAddress??'unknown',forwarded=req.headers['x-real-ip'],client=(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)&&typeof forwarded==='string'&&/^[a-f0-9:.]{1,60}$/i.test(forwarded))?forwarded:peer;
        const key='login:'+createHash('sha256').update(client+'|'+input.username.toLowerCase()).digest('hex'),failed=limits.get(key);
        if(failed&&failed.until>Date.now()&&failed.count>=10)return send(429,{error:'login-rate-limited',message:'尝试次数过多，请稍后再试。'});
        const login=store.login(input.username,input.password);if(!login){limit(key,10,600000);return send(401,{error:'invalid-login',message:'账号或密码不正确。'});}limits.delete(key);
        return send(200,{user:login.user},{'Set-Cookie':`essay_session=${login.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${origin.startsWith('https:')?'; Secure':''}`});
      }
      if(path==='/api/logout'&&req.method==='POST'){store.logout(token);return send(200,{ok:true},{'Set-Cookie':`essay_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${origin.startsWith('https:')?'; Secure':''}`});}
      if(path.startsWith('/api/')&&!user)return send(401,{error:'login-required',message:'请先登录员工账号。'});
      if(path.startsWith('/api/admin/')&&user.role!=='admin')return send(403,{error:'admin-required'});
      if(path==='/api/me/password'&&req.method==='POST'){const input=await body();const check=store.login(user.username,input.currentPassword??'');if(!check)return send(403,{error:'current-password-invalid'});store.logout(check.token);store.changePassword(user.id,input.password);return send(200,{ok:true,relogin:true});}
      if(path==='/api/admin/staff'&&req.method==='GET')return send(200,{users:store.listUsers()});
      if(path==='/api/admin/staff'&&req.method==='POST'){const input=await body();const created=store.addUser(input);store.audit(user.id,'staff-create',created.id);return send(201,{user:created});}
      const staff=path.match(/^\/api\/admin\/staff\/([a-f0-9-]{36})$/);
      if(staff&&req.method==='PATCH'){const input=await body();if(staff[1]===user.id)return send(400,{error:'cannot-disable-self'});store.setDisabled(staff[1],input.disabled===true);store.audit(user.id,'staff-state',staff[1]);return send(200,{ok:true});}
      if(path==='/api/admin/providers'&&req.method==='GET')return send(200,{providers:store.providerStatus()});
      const provider=path.match(/^\/api\/admin\/providers\/(glm|deepseek)(\/test)?$/);
      if(provider&&req.method==='POST'){
        if(!limit('provider:'+user.id,8))return send(429,{error:'rate-limited'});
        if(provider[2]){const key=store.providerKey(provider[1]);if(!key)return send(409,{error:'provider-not-configured',message:messages['provider-not-configured']});const price=PROVIDERS[provider[1]].price,callId=store.reserveAdminCall(user.id,provider[1],(2048*price.input+1024*price.output)/1e6);let settled=false;
          try{const result=await invokeModel({provider:provider[1],key,employeeId:user.id,phase:'ping',maxTokens:1024,
            system:'You are testing the standard API connection. Return only valid JSON.',user:'Return JSON: {"ok":true}. Do not add explanation.',onUsage:async r=>{store.finishAdminCall(callId,r);settled=true;}});
            if(!settled){store.finishAdminCall(callId,result);settled=true;}store.audit(user.id,'provider-test',provider[1]);return send(200,{ok:result.value?.ok===true,model:result.model});
          }finally{if(!settled)store.finishAdminCall(callId,null);}}
        const input=await body();store.setProvider(provider[1],input.apiKey);store.audit(user.id,'provider-config',provider[1]);return send(200,{ok:true,providers:store.providerStatus()});
      }
      if(path==='/api/extract'&&req.method==='POST'){
        if(!limit('extract:'+user.id,15))return send(429,{error:'rate-limited'});
        const input=await body(),ext=input.extension;if(!['.docx','.txt','.md'].includes(ext)||typeof input.base64!=='string'||input.base64.length>7_000_000)return send(400,{error:'unsupported-file'});
        const bytes=Buffer.from(input.base64,'base64');if(bytes.length>(ext==='.docx'?5_000_000:1_000_000))return send(413,{error:'file-too-large'});
        const doc=importText(bytes,ext);return send(200,{text:doc.blocks.map(b=>b.text).join('\n\n').replace(/\r\n?/g,'\n'),format:ext,warnings:[]});
      }
      if(path==='/api/jobs'&&req.method==='GET')return send(200,{jobs:store.listJobs(user.id).map(({id,title,provider,state,stage,created_at,updated_at})=>({id,title,provider,state,stage,created_at,updated_at}))});
      if(path==='/api/jobs'&&req.method==='POST'){
        if(!limit('submit:'+user.id,6))return send(429,{error:'job-rate-limited'});
        const input=jobInput.parse(await body());if(input.fileBase64){const bytes=Buffer.from(input.fileBase64,'base64'),ext=input.fileExtension;if(!ext||bytes.length>(ext==='.docx'?5_000_000:1_000_000))return send(400,{error:'invalid-source-file'});const text=importText(bytes,ext).blocks.map(b=>b.text).join('\n\n').replace(/\r\n?/g,'\n');if(text!==input.text)return send(400,{error:'source-file-text-mismatch',message:'提取文本已改变，请按粘贴文本提交或重新上传原稿。'});}
        const providers=input.model==='compare'?['glm','deepseek']:[input.model],existing=store.existingRequest(user.id,input,providers);if(existing)return send(202,{jobs:existing,replayed:true});
        if(store.listJobs(user.id).filter(j=>['queued','running'].includes(j.state)).length+providers.length>2)return send(429,{error:'too-many-active-jobs',message:'请等待当前任务完成。'});
        for(const id of providers)if(!store.providerKey(id))return send(409,{error:'provider-not-configured',message:messages['provider-not-configured']});
        const jobs=store.createJobs(user.id,input,providers);queue.push(...jobs.map(x=>x.id));setImmediate(drain);return send(202,{jobs});
      }
      const match=path.match(/^\/api\/jobs\/([a-f0-9-]{36})(\/(download|report|cancel|source))?$/);
      if(match){const job=store.getJob(user.id,match[1]);if(!job)return send(404,{error:'job-not-found'});
        if(req.method==='GET'&&!match[2])return send(200,{job:{id:job.id,title:job.title,provider:job.provider,state:job.state,stage:job.stage,detail:messages[job.detail]??(job.state==='failed'?'本轮未完成，输入及调用记录已保留。请检查模型配置或联系管理员。':job.detail),created_at:job.created_at,result:publicResult(job.result),inputSummary:{text:job.input.text,prompt:job.input.prompt,instructions:job.input.instructions}},calls:publicCalls(job.id)});
        if(req.method==='POST'&&match[3]==='cancel'){store.cancelQueued(user.id,job.id);return send(200,{ok:true});}
        if(req.method==='GET'&&match[3]==='report')return send(200,{job:{id:job.id,title:job.title,provider:job.provider,state:job.state},result:publicResult(job.result),calls:publicCalls(job.id)},{'Content-Disposition':'attachment; filename="review.json"'});
        if(req.method==='GET'&&match[3]==='source'){const ext=job.input.fileExtension??'.txt',data=job.input.fileBase64?Buffer.from(job.input.fileBase64,'base64'):Buffer.from(job.input.text);res.writeHead(200,{'Content-Type':ext==='.docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="original${ext}"`});return res.end(data);}
        if(req.method==='GET'&&match[3]==='download'){
          if(!job.result)return send(409,{error:'draft-not-ready'});const file=await readFile(join(dataDir,'jobs',job.id,'working-draft.docx'));
          const safe=job.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,80)||'文书';res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':`attachment; filename="draft_Beta.docx"; filename*=UTF-8''${encodeURIComponent(safe+'_Beta.docx')}`});return res.end(file);
        }
      }
      if(req.method==='GET'&&['/','/index.html','/app.js','/style.css'].includes(path)){const file=path==='/'?'index.html':path.slice(1);const bytes=await readFile(join(publicDir,file));res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});return res.end(bytes);}
      send(404,{error:'not-found'});
    }catch(e){const code=e?.code??e?.message;send(code==='request-id-conflict'?409:e?.issues||['invalid-account','invalid-password','invalid-api-key','request-too-large','invalid-json'].includes(code)||String(code).startsWith('docx-')?400:500,{error:e?.code??(e?.issues?'invalid-input':'operation-failed'),message:safeError(e)});}
  });
  server.requestTimeout=30000;server.headersTimeout=15000;
  return {server,store,pipeline,close:()=>new Promise(r=>server.close(()=>{store.close();r();}))};
}
