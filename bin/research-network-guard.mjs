// SDK transport guard. Research children may contact only their owning loopback gateway.
const allowed=new URL(process.env.MANTOU_RESEARCH_GATEWAY);
if(allowed.hostname!=='127.0.0.1'||allowed.protocol!=='http:')throw new Error('Invalid research gateway');
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options={})=>{const raw=typeof input==='string'||input instanceof URL?input:input.url,u=new URL(raw);if(u.origin!==allowed.origin)throw new Error('Research child network endpoint rejected');return originalFetch(input,{...options,redirect:'error'});};
