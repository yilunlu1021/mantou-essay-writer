import { resolve } from 'node:path';
import { policySchema, hashValue } from '@mantou/text-quality';
import { DEFAULT_POLICY_HASH } from './policy-integrity.js';
import { readJson, readLimited, utf8, sha, fail } from './files.js';
export async function loadPolicy(root: string) {
  const policy=policySchema.parse(await readJson(resolve(root,'policy/default.json')));
  if(hashValue(policy)!==DEFAULT_POLICY_HASH)fail('policy-integrity','Restore the policy files from the matching release.');
  for(const source of policy.sources){
    if(!['policy/language-standards.md','policy/collaboration-writing.md'].includes(source.path))fail('policy-source','Unsupported policy source.');
    const value=utf8(await readLimited(resolve(root,source.path))).replace(/\r\n/g,'\n');
    if(sha(value)!==source.sha256)fail('policy-source-drift','Restore the policy source from the matching release.');
  }
  return policy;
}
