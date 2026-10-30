import { access, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export function runtimeConfiguration(env) {
  const preview=env.ESSAY_AGENT_PREVIEW==='1',agent=env.ESSAY_AGENT_ENABLED==='1';
  if(preview&&agent)throw new Error('Preview and production agent modes are mutually exclusive');
  if((preview||agent)&&!env.ESSAY_DATA_DIR?.trim())throw new Error('Agent mode requires an explicit data directory');
  const researchEnabled=(preview||agent)&&env.ESSAY_RESEARCH_DISABLED!=='1';
  if(agent&&researchEnabled&&!env.ESSAY_DSH_RUNTIME_ROOT?.trim())throw new Error('Production agent requires the pinned research runtime');
  const concurrency=Number(env.ESSAY_JOB_CONCURRENCY??(agent?1:2));
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>2)throw new Error('Invalid job concurrency');
  return{preview,agent,researchEnabled,concurrency,enabled:preview||agent,environment:preview?'research-preview':agent?'agent':'stable',cookie:preview?'essay_preview_session':'essay_session'};
}

export async function assertAgentDataDirectory(path) {
  if(!path?.trim())throw new Error('Production agent requires an explicit data directory');
  await mkdir(path,{recursive:true,mode:0o700});const root=await realpath(path);
  const marked=await access(join(root,'.essay-preview.json')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  if(marked)throw new Error('Production agent cannot use a preview data directory');
  return root;
}
