import { mkdir, readdir, realpath, lstat, rename, rm } from 'node:fs/promises';
import { resolve, join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import { auditText, prepareWriting, validateEdits, contextSchema, documentSchema, editInputSchema,
  hashValue, parseJsonText, isPortableFilename, type TextContext, type TextDocument, type Policy } from '@mantou/text-quality';
import { createNewDirectory, writeNew, readLimited, regularWithin, utf8, json, sha, fail } from './files.js';
import { importText, writeDocx } from './documents.js';
import { loadPolicy } from './policy.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revisionName = /^v\d{4}$/;
const filesSchema = z.record(z.string(), digest);
const rootSchema = z.object({ schemaVersion:z.literal('1.0.0'), context:contextSchema,
  sourceExtension:z.enum(['.txt','.md','.docx']), sourceHash:digest, originalHash:digest, policyHash:digest,
  protectedBlocks:z.array(z.string()).max(200), maxChangedCodepoints:z.number().int().nonnegative().max(200000), sessionHash:digest }).strict();
const versionSchema = z.object({schemaVersion:z.literal('1.0.0'), number:z.number().int().min(0).max(9999),
  parentHash:digest, documentHash:digest, files:filesSchema, versionHash:digest}).strict();
export const patchSchema = z.object({schemaVersion:z.literal('1.0.0'), expectedDocumentHash:digest,
  expectedContextHash:digest, expectedPolicyHash:digest, patches:editInputSchema.shape.patches}).strict();
export type ImportOptions = { input:string; out:string; context:TextContext; protectedBlocks?:string[]; maxChangedCodepoints?:number };
type Root = z.infer<typeof rootSchema>;
type Version = z.infer<typeof versionSchema>;
function digestWithout<T extends Record<string,unknown>>(v:T, key:string){ const copy={...v}; delete copy[key]; return hashValue(copy); }
async function readObject(root:string,name:string){return parseJsonText(utf8(await regularWithin(root,name)));}
async function directory(root:string, name:string){ const target=join(root,name); const stat=await lstat(target);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(target)!==target)fail('session-directory','Session directories cannot be links.'); return target; }
function inputFor(root:Root, original:TextDocument, document:TextDocument){return {schemaVersion:'1.0.0',context:root.context,original,document};}
export function patchTemplate(context:TextContext, document:TextDocument, policy:Policy){ return {schemaVersion:'1.0.0' as const,
  expectedDocumentHash:hashValue(document),expectedContextHash:hashValue(context),expectedPolicyHash:hashValue(policy),patches:[]}; }
function reviewMarkdown(audit:ReturnType<typeof auditText>, policy:Policy){
  return '# Working draft review\n\nMachine result: '+audit.qualityDecision+'. Human review is required. Delivery is not authorized.\n\n'+
    'Facts, semantic equivalence and author voice have not been certified.\n\n'+
    '## Findings\n\n'+(audit.findings.map(f=>'- '+f.ruleId+' / '+f.code+' ('+f.severity+'): '+f.message+(f.blockId?' ['+f.blockId+']':'')).join('\n')||'No mechanical findings.')+
    '\n\n## Human review\n\n'+audit.coverage.filter(c=>c.status==='needs-review'||c.status==='not-checked').map(c=>'- '+c.ruleId+': '+(policy.rules.find(r=>r.id===c.ruleId)?.requirement??c.reason)).join('\n')+'\n';
}
async function writeVersion(folder:string, number:number, parentHash:string, root:Root, original:TextDocument, doc:TextDocument, policy:Policy, patches:unknown){
  await mkdir(folder,{mode:0o700}); const input=inputFor(root,original,doc);
  const audit=auditText(input,policy); const prepared=prepareWriting(input,policy);
  const content:Record<string,string|Uint8Array>={
    'document.json':json(doc), 'document.txt':doc.blocks.map(b=>b.text).join('\n\n'),
    'audit.json':json(audit),'prepare.json':json(prepared),'review.md':reviewMarkdown(audit,policy),
    'patch-template.json':json(patchTemplate(root.context,doc,policy)), 'changes.json':json(patches),
    'working-draft.docx':writeDocx(root.context.prompt,doc)
  };
  const files:Record<string,string>={};
  for(const [name,value] of Object.entries(content)){await writeNew(join(folder,name),value);files[name]=sha(value);}
  const base={schemaVersion:'1.0.0' as const,number,parentHash,documentHash:hashValue(doc),files};
  const manifest={...base,versionHash:hashValue(base)}; await writeNew(join(folder,'version.json'),json(manifest));
  return {manifest,audit};
}
export async function importSession(policyRoot:string, options:ImportOptions){
  const policy=await loadPolicy(policyRoot); const context=contextSchema.parse(options.context);
  if(context.mode==='revision'&&!context.revisionAuthorized)fail('revision-authorization-required','Use edit mode or explicitly authorize structural revision.');
  if(!isPortableFilename(basename(resolve(options.out))))fail('output-name','Choose a folder name valid on Windows and macOS.');
  const extension=extname(options.input).toLowerCase(); if(!['.txt','.md','.docx'].includes(extension))fail('input-format','Choose a UTF-8 .txt/.md or paragraph-only .docx file.');
  const bytes=await readLimited(options.input,extension==='.docx'?5_000_000:1_000_000); const original=importText(bytes,extension);
  const protectedBlocks=options.protectedBlocks??[];
  if(new Set(protectedBlocks).size!==protectedBlocks.length || protectedBlocks.some(id=>!original.blocks.some(b=>b.id===id)))fail('protected-block','Use existing block IDs once each.');
  const raw={schemaVersion:'1.0.0',context,sourceExtension:extension,sourceHash:sha(bytes),originalHash:hashValue(original),policyHash:hashValue(policy),
    protectedBlocks,maxChangedCodepoints:options.maxChangedCodepoints??2000};
  const manifest=rootSchema.parse({...raw,sessionHash:hashValue(raw)});
  const target=await createNewDirectory(options.out);
  try {
    const root=await realpath(target); await writeNew(join(root,'original.bin'),bytes); await writeNew(join(root,'original.json'),json(original));
    await mkdir(join(root,'versions'),{mode:0o700}); await writeVersion(join(root,'versions','v0000'),0,manifest.sessionHash,manifest,original,original,policy,[]);
    await writeNew(join(root,'session.json'),json(manifest));
    return await sessionStatus(policyRoot,root);
  } catch(e){ await rm(target,{recursive:true,force:true}); throw e; }
}
export async function loadSession(policyRoot:string, input:string){
  const root=await realpath(resolve(input)); const policy=await loadPolicy(policyRoot);
  const manifest=rootSchema.parse(await readObject(root,'session.json'));
  if(digestWithout(manifest,'sessionHash')!==manifest.sessionHash||manifest.policyHash!==hashValue(policy))fail('session-integrity','Session context or policy differs. Restore a matching copy or import into a new session.');
  const originalBytes=await regularWithin(root,'original.bin',5_000_000); const original=documentSchema.parse(await readObject(root,'original.json'));
  if(sha(originalBytes)!==manifest.sourceHash||hashValue(original)!==manifest.originalHash||hashValue(importText(originalBytes,manifest.sourceExtension))!==manifest.originalHash)fail('original-integrity','The original snapshot changed. Restore the source snapshot.');
  const versions=await directory(root,'versions'); const names=(await readdir(versions)).filter(n=>!n.startsWith('.pending-')).sort();
  if(!names.length||names.length>100)fail('version-limit','A session must contain 1-100 versions. Start a new session when needed.');
  let parentHash=manifest.sessionHash; let document=original; let current:Version|undefined;
  for(const [index,name] of names.entries()){
    if(!revisionName.test(name)||name!=='v'+String(index).padStart(4,'0'))fail('version-sequence','The version history has missing or unknown entries.');
    const folder=await directory(versions,name); const v=versionSchema.parse(await readObject(folder,'version.json'));
    if(v.number!==index||v.parentHash!==parentHash||digestWithout(v,'versionHash')!==v.versionHash)fail('version-integrity','A version record changed. Restore the session from backup.');
    const expected=['document.json','document.txt','audit.json','prepare.json','review.md','patch-template.json','changes.json','working-draft.docx'].sort();
    if(JSON.stringify(Object.keys(v.files).sort())!==JSON.stringify(expected))fail('version-files','The version has an unexpected file manifest.');
    for(const [file,hash] of Object.entries(v.files))if(sha(await regularWithin(folder,file,5_000_000))!==hash)fail('version-integrity','A generated file changed. Keep edits in a separate patch file.');
    document=documentSchema.parse(await readObject(folder,'document.json'));
    if(hashValue(document)!==v.documentHash||(index===0&&v.documentHash!==manifest.originalHash))fail('version-integrity','The version document changed.');
    current=v; parentHash=v.versionHash;
  }
  return {root,manifest,original,document,current:current!,policy};
}
export async function sessionStatus(policyRoot:string, path:string){ const s=await loadSession(policyRoot,path); const audit=auditText(inputFor(s.manifest,s.original,s.document),s.policy);
  return {schemaVersion:'1.0.0',session:s.root,version:'v'+String(s.current.number).padStart(4,'0'),qualityDecision:audit.qualityDecision,
    findings:audit.findings.length,pendingRules:audit.coverage.filter(c=>c.status==='needs-review'||c.status==='not-checked').length,
    metrics:audit.metrics,bindings:audit.bindings,requiresHumanReview:true,semanticEquivalenceChecked:false,deliveryAuthorized:false}; }
export async function prepareSession(policyRoot:string,path:string){const s=await loadSession(policyRoot,path);return prepareWriting(inputFor(s.manifest,s.original,s.document),s.policy);}
export async function auditSession(policyRoot:string,path:string){const s=await loadSession(policyRoot,path);return auditText(inputFor(s.manifest,s.original,s.document),s.policy);}
export async function reviseSession(policyRoot:string,path:string,rawPatch:unknown){
  const patch=patchSchema.parse(rawPatch); const root=await realpath(resolve(path)); const lock=join(root,'.writer-lock');
  try {await mkdir(lock,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')fail('session-busy','Another writer or an interrupted write holds the lock. See the recovery guide.');throw e;}
  let pending:string|undefined;
  try {
    await writeNew(join(lock,'owner.json'),json({pid:process.pid,host:hostname()}));
    const s=await loadSession(policyRoot,root);
    if(patch.expectedPolicyHash!==s.manifest.policyHash)fail('stale-policy','Prepare a new patch for the current policy.');
    // Whole-block protection also forbids insertion at either boundary.
    if(patch.patches.some(p=>s.manifest.protectedBlocks.includes(p.blockId)))fail('protected-block','The patch touches a protected source block.');
    const result=validateEdits({schemaVersion:'1.0.0',context:s.manifest.context,original:s.document,
      expectedDocumentHash:patch.expectedDocumentHash,expectedContextHash:patch.expectedContextHash,
      maxChangedCodepoints:s.manifest.maxChangedCodepoints,patches:patch.patches});
    if(!result.candidate)fail('patch-rejected',result.issues.join(', '));
    if(!result.changedCodepoints)fail('empty-patch','Provide a patch that changes text.');
    if(s.current.number>=99)fail('version-limit','This session has 100 versions. Start a new session.');
    const next=s.current.number+1; pending=join(root,'versions','.pending-'+randomUUID());
    await writeVersion(pending,next,s.current.versionHash,s.manifest,s.original,result.candidate,s.policy,patch);
    await rename(pending,join(root,'versions','v'+String(next).padStart(4,'0')));pending=undefined;
    return await sessionStatus(policyRoot,root);
  } finally {if(pending)await rm(pending,{recursive:true,force:true});await rm(lock,{recursive:true,force:true});}
}
export async function recoverSession(policyRoot:string,path:string){
  const s=await loadSession(policyRoot,path); const recovery=join(s.root,'.recovery-lock');
  try{await mkdir(recovery,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')fail('recovery-busy','Another recovery is running.');throw e;}
  try {
  const lock=await directory(s.root,'.writer-lock');
  const owner=z.object({pid:z.number().int().positive(),host:z.string()}).strict().parse(await readObject(lock,'owner.json'));
  if(owner.host!==hostname())fail('recovery-host','Recover this session on the computer that created the lock.');
  try {process.kill(owner.pid,0);fail('writer-running','The recorded writer process still exists. Wait for it to finish.');}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
  // Rename claims this exact lock. A second recovery cannot remove a newly created writer lock.
  const stale=join(s.root,'.stale-lock-'+randomUUID());await rename(lock,stale);await rm(stale,{recursive:true,force:true});
  return {recovered:true,deliveryAuthorized:false};
  } finally {await rm(recovery,{recursive:true,force:true});}
}
