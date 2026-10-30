import { hashValue } from '@mantou/text-quality';
const originFor=(key,parent,current)=>key==='sources'||key==='originalAnchors'||key==='source'&&parent==='omissions'?'original':current;
// Only structural references are expanded. Judgments, reasons and PASS states are never invented.
export function referencePack(value,document,original) {
  const catalog={},seen=new Map();let seq=0;
  const remember=(span,source='document')=>{const key=source+':'+hashValue(span);if(seen.has(key))return seen.get(key);const id='a'+(++seq);seen.set(key,id);catalog[id]={source,...span};return id;};
  for(const [source,doc]of [['document',document],['original',original]])for(const b of doc.blocks){
    if(!b.text.trim())continue;
    remember({blockId:b.id,start:0,end:Array.from(b.text).length,quote:b.text},source);
    for(const part of new Intl.Segmenter('en',{granularity:'sentence'}).segment(b.text)){
      const quote=part.segment.trim();if(!quote)continue;const start=Array.from(b.text.slice(0,part.index+part.segment.indexOf(quote))).length;
      remember({blockId:b.id,start,end:start+Array.from(quote).length,quote},source);
    }
  }
  const walk=(v,source='document',parent='')=>{
    if(Array.isArray(v))return v.map(x=>walk(x,source,parent));
    if(v&&typeof v==='object'){
      if(typeof v.blockId==='string'&&Number.isInteger(v.start)&&Number.isInteger(v.end)&&typeof v.quote==='string')return {$ref:remember(v,source)};
      return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x,v.kind==='original'?'original':originFor(k,parent,source),k)]));
    }return v;
  };
  return {value:walk(value),catalog};
}
export function expandReferences(value,catalog,document,original,prompt) {
  const locate=(v,text,quote)=>{
    if(typeof quote!=='string'||!quote.trim())throw new Error('invalid-evidence-quote');
    const chars=Array.from(text);
    if(Number.isInteger(v.start)&&Number.isInteger(v.end)&&v.start>=0&&v.end>v.start&&v.end<=chars.length&&chars.slice(v.start,v.end).join('')===quote)
      return {start:v.start,end:v.end,quote};
    const index=text.indexOf(quote);if(index<0||text.indexOf(quote,index+1)>=0)throw new Error('evidence-quote-not-unique');
    const start=Array.from(text.slice(0,index)).length;return {start,end:start+Array.from(quote).length,quote};
  };
  const exact=(v,source,quote)=>{
    const doc=source==='original'?original:document,b=doc.blocks.find(b=>b.id===v.blockId);
    if(!b)throw new Error('invalid-evidence-quote');return {blockId:b.id,...locate(v,b.text,quote)};
  };
  const walk=(v,source='document',parent='')=>{
    if(Array.isArray(v))return v.map(x=>walk(x,source,parent));
    if(v&&typeof v==='object'){
      if('$ref'in v){if(typeof v.$ref!=='string'||!/^a\d+$/.test(v.$ref)||!Object.hasOwn(catalog,v.$ref))throw new Error('unknown-evidence-reference');const {source,...span}=catalog[v.$ref];return span;}
      if('$quote'in v)return exact(v,v.source??source,v.$quote);
      // Offsets are mechanical metadata. Resolve an unchanged exact quote, never fuzzy text or an opinion.
      if(typeof v.blockId==='string'&&typeof v.quote==='string')return {...v,...exact(v,source,v.quote)};
      if(parent==='promptSpan'&&typeof prompt==='string')return {...v,...locate(v,prompt,v.quote)};
      return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x,v.kind==='original'?'original':originFor(k,parent,source),k)]));
    }return v;
  };return walk(value);
}
export function bindMetadata(value,template){
  // These constants bind the response to the exact immutable request. Every review opinion is supplied by the model.
  const output={...value};for(const key of Object.keys(template))if(['schemaVersion','bindings','methodVersion','reviewerRole'].includes(key)||/Hash$|Version$/.test(key))output[key]=template[key];return output;
}
