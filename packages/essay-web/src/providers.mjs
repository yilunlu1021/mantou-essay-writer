export const PROVIDERS = Object.freeze({
  glm: { id:'glm', label:'GLM-5.3-Flash', model:'glm-5.3-flash', url:'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    price:{input:0.8,cached:0.23,output:2.8}, priceBasis:'官方标准价，2026-10-30' },
  deepseek: { id:'deepseek', label:'DeepSeek V4.1 Flash', model:'deepseek-flash', url:'https://api.deepseek.com/chat/completions',
    price:{input:2,cached:0.04,output:8}, priceBasis:'按官方高峰价估算上限，空闲时实际账单较低，2026-10-30' }
});
export function usageCost(provider, usage) {
  if(!Object.hasOwn(PROVIDERS,provider))throw new Error('invalid-provider');const p=PROVIDERS[provider];
  if(!usage || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens<0 || !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens<0)
    return {known:false,cny:null,inputTokens:null,outputTokens:null,cachedTokens:null,basis:p.priceBasis};
  const input=Math.max(0,usage.prompt_tokens),output=Math.max(0,usage.completion_tokens);
  const raw=usage.prompt_cache_hit_tokens??usage.prompt_tokens_details?.cached_tokens??0;
  if(!Number.isSafeInteger(raw)||raw<0||raw>input)return {known:false,cny:null,inputTokens:input,outputTokens:output,cachedTokens:null,basis:p.priceBasis};
  const cached=raw;
  return {known:true,cny:((input-cached)*p.price.input+cached*p.price.cached+output*p.price.output)/1_000_000,
    inputTokens:input,outputTokens:output,cachedTokens:cached,basis:p.priceBasis};
}
export function extractJson(content) {
  if(typeof content!=='string'||!content.trim())throw new Error('model-empty-response');
  const clean=content.trim().replace(/^```(?:json)?\s*/u,'').replace(/\s*```$/u,'');
  try{return JSON.parse(clean);}catch{throw new Error('model-invalid-json');}
}
export class ProviderError extends Error {
  constructor(code,status=0){super(code);this.code=code;this.status=status;}
}
export async function callModel({provider,key,system,user,phase='review',employeeId,maxTokens=12288,fetchImpl=fetch,timeoutMs=240000,onUsage}) {
  if(!Object.hasOwn(PROVIDERS,provider))throw new ProviderError('invalid-provider');const p=PROVIDERS[provider];
  if(!key)throw new ProviderError('provider-not-configured');
  const thinking=provider==='glm'||phase==='logic';
  const body={model:p.model,messages:[{role:'system',content:system},{role:'user',content:typeof user==='string'?user:JSON.stringify(user)}],
    response_format:{type:'json_object'},stream:false,max_tokens:maxTokens,
    thinking:{type:thinking?'enabled':'disabled'},...(thinking?{reasoning_effort:'low'}:{temperature:0.6})};
  if(provider==='glm'){body.temperature=1;body.top_p=0.95;}
  else {body.user_id=employeeId;if(thinking)body.top_p=0.95;}
  const started=Date.now();let response;
  try{response=await fetchImpl(p.url,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});}
  catch(e){throw new ProviderError(e?.name==='TimeoutError'?'provider-timeout':'provider-network-error');}
  if(!response.ok)throw new ProviderError(response.status===401||response.status===403?'provider-key-rejected':response.status===429?'provider-rate-limited':'provider-http-error',response.status);
  let data;try{data=await response.json();}catch{throw new ProviderError('provider-invalid-response');}
  const result={model:data.model??p.model,cost:usageCost(provider,data.usage),latencyMs:Date.now()-started,requestId:data.id??null};
  await onUsage?.(result);
  if(data.choices?.[0]?.finish_reason==='length')throw new ProviderError('model-output-truncated');
  if(data.choices?.[0]?.finish_reason!=='stop')throw new ProviderError('model-output-incomplete');
  return {...result,value:extractJson(data.choices?.[0]?.message?.content)};
}
