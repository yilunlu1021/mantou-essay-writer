import {dirname,join,resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createWorkbench} from './server.mjs';
import {createHarnessResearchRunner} from './harness.mjs';
import {assertPreviewDataDirectory} from './preview-config.mjs';
const base=dirname(fileURLToPath(import.meta.url));
const policyRoot=process.env.ESSAY_POLICY_ROOT??(existsSync(join(base,'policy/default.json'))?base:resolve(base,'..'));
const publicDir=process.env.ESSAY_PUBLIC_DIR??(existsSync(join(base,'public/index.html'))?join(base,'public'):resolve(base,'../web-public'));
const budget=Number(process.env.ESSAY_JOB_BUDGET_CNY??10);if(!Number.isFinite(budget)||budget<=0||budget>10)throw new Error('Invalid job budget');
const preview=process.env.ESSAY_AGENT_PREVIEW==='1';
if(preview&&!process.env.ESSAY_DATA_DIR)throw new Error('Preview requires an explicit isolated data directory');
if(preview)await assertPreviewDataDirectory(process.env.ESSAY_DATA_DIR);
const researchRunner=preview&&process.env.ESSAY_DSH_RUNTIME_ROOT?createHarnessResearchRunner({runtimeRoot:process.env.ESSAY_DSH_RUNTIME_ROOT,searchProvider:process.env.ESSAY_SEARCH_PROVIDER??'deepseek'}):undefined;
const app=await createWorkbench({dataDir:process.env.ESSAY_DATA_DIR??resolve(base,'../runtime-data'),origin:process.env.PUBLIC_ORIGIN??'http://127.0.0.1:8787',policyRoot,publicDir,
  bootstrapPassword:process.env.BOOTSTRAP_PASSWORD,maxCost:budget,enableStudentLibrary:preview,researchRunner,sessionCookieName:preview?'essay_preview_session':'essay_session'});
await app.pipeline.policyPromise;
app.server.listen(Number(process.env.PORT??8787),process.env.HOST??'127.0.0.1',()=>console.log('Essay workbench is listening.'));
