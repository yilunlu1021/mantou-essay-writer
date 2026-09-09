#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { z } from 'zod';
import { contextSchema, describeContracts, validationDetails } from '@mantou/text-quality';
import { UserError, fail, json, readJson, readLimited, utf8, writeNew } from './files.js';
import { loadPolicy } from './policy.js';
import { importSession, loadSession, sessionStatus, prepareSession, auditSession, reviseSession, recoverSession, patchSchema, patchTemplate } from './sessions.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const VERSION='0.1.0-preview.1';
const HELP=`Mantou Essay Writer ${VERSION}
Local writing review and versioned edits. Uses your existing agent for writing.

node bin/essay.mjs doctor
node bin/essay.mjs demo --out "my demo"
node bin/essay.mjs import --input draft.docx --out "my essay" --language en --genre personal-narrative --prompt-file prompt.txt
node bin/essay.mjs prepare --session "my essay"
node bin/essay.mjs revise --session "my essay" --patch-file edits.json
node bin/essay.mjs status --session "my essay"
node bin/essay.mjs audit --session "my essay"
node bin/essay.mjs recover --session "my essay"
node bin/essay.mjs schema
node bin/essay.mjs example

Import options:
  --language en|zh|mixed (required)  --genre personal-narrative|application-explanatory|academic|advisor-feedback|general|unknown (required)
  --prompt-file FILE  --audience TEXT  --role student|advisor|institution
  --mode edit|revision (default edit)  --authorize-revision (explicit structural-edit permission)
  --stage material|working|clean-draft  --channel document|wechat|chat|unknown
  --min NUMBER  --max NUMBER  --unit english-words|han-characters|non-whitespace-codepoints
  --protect-blocks p1,p2  --edit-budget NUMBER (default 2000 changed codepoints per revision)

UTF-8 TXT/MD (1 MB) and body-paragraph DOCX (5 MB) supported. Markdown imports as literal text.
Offsets use Unicode codepoints. Each version contains working-draft.docx, review.md and patch-template.json.
Copy the template outside the versions folder before editing it. Never edit stored session files.
Exit codes: 0 utility success, 1 invalid request/runtime failure, 2 mechanically blocked, 3 human review pending.
A completed import/revise can return 2 or 3. Check JSON and existing files before retrying.
No AI detector score or submission approval is provided. See README.md and AGENTS.md.
`;
const allowed:Record<string,string[]>={
  import:['input','out','language','genre','prompt-file','audience','role','mode','authorize-revision','stage','channel','min','max','unit','protect-blocks','edit-budget'],
  prepare:['session'],audit:['session'],status:['session'],revise:['session','patch-file'],recover:['session'],demo:['out'],doctor:[],schema:[],example:[]
};
async function main(){
  const args=process.argv.slice(2);
  if(args.length===0||args.includes('--help')||args.includes('-h')){process.stdout.write(HELP);return;}
  if(args.length===1&&args[0]==='--version'){process.stdout.write(VERSION+'\n');return;}
  const {values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:Object.fromEntries([...new Set(Object.values(allowed).flat())].map(k=>[k,{type:k==='authorize-revision'?'boolean':'string'}]))});
  const command=positionals[0];if(positionals.length!==1||!command||!allowed[command])fail('command','Use --help for available commands.');
  for(const k of Object.keys(values))if(!allowed[command].includes(k))fail('option','Option --'+k+' does not apply to '+command+'.');
  const required=(key:string)=>{const v=values[key];if(typeof v!=='string'||!v.trim())return fail('required-option','Provide --'+key+'.');return v;};
  const optional=(key:string)=>typeof values[key]==='string'?values[key] as string:undefined;
  const number=(key:string)=>{const value=optional(key);if(value===undefined)return undefined;if(!/^\d+$/.test(value)||Number(value)>200000)fail('number','--'+key+' must be an integer from 0 to 200000.');return Number(value);};
  let result:unknown;
  if(command==='schema')result={...describeContracts(),patch:z.toJSONSchema(patchSchema),sessionContext:z.toJSONSchema(contextSchema)};
  else if(command==='example')result={instructions:'Use the hashes from your version\'s patch-template.json. Replace one exact span, keeping every hash unchanged.',patchExample:{schemaVersion:'1.0.0',expectedDocumentHash:'FROM_TEMPLATE',expectedContextHash:'FROM_TEMPLATE',expectedPolicyHash:'FROM_TEMPLATE',patches:[{blockId:'p1',start:0,end:1,expectedText:'i',replacement:'I',reason:'Capitalize the existing first-person pronoun.'}]}};
  else if(command==='doctor'){
    const policy=await loadPolicy(root);const major=Number(process.versions.node.split('.')[0]);
    if(![22,24].includes(major))fail('node-version','Install Node.js 22 or 24 LTS, then rerun doctor.');
    result={status:'ready',version:VERSION,node:process.versions.node,platform:process.platform,arch:process.arch,policyGroups:policy.rules.length,
      dependencies:'bundled',networkRequired:false,pythonRequired:false,modelProvidedBy:'your existing agent',deliveryAuthorized:false};
  }else if(command==='import'){
    const language=required('language'); const mode=optional('mode')??'edit';
    if(!['edit','revision'].includes(mode))fail('mode','Use --mode edit or --mode revision.');
    if(values['authorize-revision']&&mode!=='revision')fail('mode','Use --authorize-revision only with --mode revision.');
    const stage=optional('stage')??'working';const max=number('max');let min=number('min');
    const unit=optional('unit')??(language==='en'?'english-words':language==='zh'?'han-characters':'non-whitespace-codepoints');
    if(stage==='clean-draft'){
      if(max===undefined)fail('length-required','Provide the official limit using --max. Verify the prompt before choosing a limit.');
      if(min===undefined&&unit==='english-words')min=Math.max(0,max-20);
    }
    const promptFile=optional('prompt-file');const context=contextSchema.parse({language,genre:required('genre'),authorRole:optional('role')??'student',
      mode,revisionAuthorized:values['authorize-revision']===true,stage,channel:optional('channel')??'document',audience:optional('audience')??'reader',
      prompt:promptFile?utf8(await readLimited(promptFile,40000)).replace(/^\uFEFF/,''):'',
      ...((min!==undefined||max!==undefined)?{length:{unit,...(min!==undefined?{min}:{}),...(max!==undefined?{max}:{})}}:{})});
    const budget=number('edit-budget'); const protectedValue=optional('protect-blocks');
    result=await importSession(root,{input:required('input'),out:required('out'),context,
      ...(budget!==undefined?{maxChangedCodepoints:budget}:{}),...(protectedValue?{protectedBlocks:protectedValue.split(',')}: {})});
  }else if(command==='demo'){
    const out=required('out');const temp=await mkdtemp(join(tmpdir(),'essay-demo-'));
    try{
      const input=join(temp,'draft.txt');await writeNew(input,'I kept the damaged wheel; we tested it after lunch.\n\nThe cart rolled to the doorway.');
      await importSession(root,{input,out,context:contextSchema.parse({language:'en',genre:'personal-narrative',authorRole:'student',audience:'reader',prompt:'Describe a project you worked on.'})});
      const s=await loadSession(root,out);const patch={...patchTemplate(s.manifest.context,s.document,s.policy),patches:[{blockId:'p1',start:24,end:28,expectedText:'; we',replacement:'. We',reason:'Split the existing sentence without adding facts.'}]};
      await reviseSession(root,out,patch);result={demo:'completed',...await sessionStatus(root,out)};
    }finally{await rm(temp,{recursive:true,force:true});}
  }else if(command==='prepare')result=await prepareSession(root,required('session'));
  else if(command==='audit')result=await auditSession(root,required('session'));
  else if(command==='status')result=await sessionStatus(root,required('session'));
  else if(command==='recover')result=await recoverSession(root,required('session'));
  else result=await reviseSession(root,required('session'),await readJson(required('patch-file')));
  process.stdout.write(json(result));
  if(command!=='demo'&&result&&typeof result==='object'&&'qualityDecision' in result){process.exitCode=result.qualityDecision==='blocked'?2:result.qualityDecision==='needs-review'?3:0;}
}
main().catch((error:unknown)=>{
  const fields=validationDetails(error); const e=error as NodeJS.ErrnoException;
  const hint=error instanceof UserError?error.hint:fields.length?'Correct the listed fields.':e.code==='ENOENT'?'A required file or directory was not found. Check the supplied path.':e.code==='EACCES'||e.code==='EPERM'?'Use a writable local folder and check file permissions.':error instanceof SyntaxError?'Provide valid UTF-8 JSON.':'Use --help and check your options and input files.';
  process.stderr.write(json({error:error instanceof UserError?error.code:fields.length?'invalid-request':e.code??'invalid-request',hint,...(fields.length?{fields}:{})}));process.exitCode=1;
});
