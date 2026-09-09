import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,rm,readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {zipSync,unzipSync} from 'fflate';
const source=resolve('.');
function run(root,args,expected=0){const r=spawnSync(process.execPath,[join(root,'bin/essay.mjs'),...args],{cwd:root,encoding:'utf8',timeout:20000});assert.equal(r.status,expected,r.stdout+r.stderr);return r;}
test('release ZIP: Node-only first use, Chinese paths, DOCX, BOM patch and rejection',async t=>{
  const temp=await mkdtemp(join(tmpdir(),'essay 发行 '));t.after(()=>rm(temp,{recursive:true,force:true}));
  const staging=join(temp,'pack');await mkdir(staging);
  for(const file of ['bin','policy','README.md','AGENTS.md','LICENSE','THIRD_PARTY_NOTICES.txt','start.ps1','start.sh'])await cp(join(source,file),join(staging,file),{recursive:true});
  const items={};async function walk(dir,prefix=''){for(const e of await readdir(dir,{withFileTypes:true})){if(e.isDirectory())await walk(join(dir,e.name),prefix+e.name+'/');else items[prefix+e.name]=await readFile(join(dir,e.name));}}await walk(staging);
  const zip=zipSync(items);const unpack=join(temp,'解压 release');await mkdir(unpack);
  for(const [name,data] of Object.entries(unzipSync(zip))){const path=join(unpack,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,data);}
  assert.equal(JSON.parse(run(unpack,['doctor']).stdout).policyGroups,55);
  assert.match(run(unpack,['--help']).stdout,/Import options/);assert.match(run(unpack,['--version']).stdout,/preview/);
  assert.ok(JSON.parse(run(unpack,['schema']).stdout).patch);assert.ok(JSON.parse(run(unpack,['example']).stdout).patchExample);
  const demo=JSON.parse(run(unpack,['demo','--out','演示 case']).stdout);assert.equal(demo.version,'v0001');assert.equal(demo.deliveryAuthorized,false);
  assert.equal(JSON.parse(run(unpack,['status','--session','演示 case'],3).stdout).qualityDecision,'needs-review');
  run(unpack,['import','--input','演示 case/versions/v0001/working-draft.docx','--out','word roundtrip','--language','en','--genre','academic'],3);
  const policyPath=join(unpack,'policy/language-standards.md');await writeFile(policyPath,(await readFile(policyPath,'utf8')).replaceAll('\n','\r\n'));run(unpack,['doctor']);
  await writeFile(join(unpack,'draft.txt'),'\uFEFFi tested the wheel.\r\n\r\nThe cart rolled.');
  run(unpack,['import','--input','draft.txt','--out','own draft','--language','en','--genre','application-explanatory'],3);
  const template=JSON.parse(await readFile(join(unpack,'own draft/versions/v0000/patch-template.json'),'utf8'));template.patches=[{blockId:'p1',start:0,end:1,expectedText:'i',replacement:'I',reason:'Capitalize pronoun.'}];
  await writeFile(join(unpack,'edits.json'),'\uFEFF'+JSON.stringify(template));run(unpack,['revise','--session','own draft','--patch-file','edits.json'],3);run(unpack,['revise','--session','own draft','--patch-file','edits.json'],1);
  await writeFile(join(unpack,'bad.json'),JSON.stringify({...template,patches:[{...template.patches[0],start:'SECRET_PROSE'}]}));
  const bad=run(unpack,['revise','--session','own draft','--patch-file','bad.json'],1);assert.match(bad.stderr,/patches.0.start/);assert.doesNotMatch(bad.stderr,/SECRET_PROSE/);
  run(unpack,['import','--input','draft.txt','--out','CON','--language','en','--genre','general'],1);
  if(process.platform==='win32'){const p=spawnSync('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(unpack,'start.ps1')],{encoding:'utf8',timeout:20000});assert.equal(p.status,0,p.stdout+p.stderr);}
  else {const p=spawnSync('sh',[join(unpack,'start.sh')],{encoding:'utf8',timeout:20000});assert.equal(p.status,0,p.stdout+p.stderr);}
  console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,bundleBytes:zip.length,firstUse:'passed'}));
});
