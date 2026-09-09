import {build} from 'esbuild';
import {mkdir,cp,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
const root=process.cwd();await mkdir('bin',{recursive:true});
await cp('packages/essay-writer/policy','policy',{recursive:true});
const all=new Set();
for(const [name,entry] of [['essay','packages/essay-writer/src/cli.ts'],['sdk','packages/essay-writer/src/index.ts']]){
  const result=await build({entryPoints:[entry],outfile:'bin/'+name+'.mjs',bundle:true,platform:'node',target:'node22',format:'esm',metafile:true,sourcemap:false,
    legalComments:'inline',banner:{js:"import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"}});
  for(const input of Object.keys(result.metafile.inputs))if(input.includes('node_modules/'))all.add(input);
}
const packages=new Map();
for(const input of all){let dir=dirname(resolve(input));
  while(dir!==dirname(dir)){
    try{const p=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));if(p.name&&p.version){packages.set(p.name,{dir,...p});break;}}catch{}
    dir=dirname(dir);
  }
}
let notices='Bundled runtime dependency licenses\n';
for(const p of [...packages.values()].sort((a,b)=>a.name.localeCompare(b.name))){
  const files=(await readdir(p.dir)).filter(n=>/^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:\.|$)/i.test(n));
  if(!files.length&&p.name==='@nodable/entities'&&p.version==='3.0.0'){notices+='\n@nodable/entities 3.0.0 (MIT)\n'+await readFile('licenses/nodable-entities-3.0.0.txt','utf8')+'\n';continue;}
  if(!files.length)throw new Error('License missing for '+p.name);
  notices+='\n'+p.name+' '+p.version+' ('+p.license+')\n';
  for(const f of files)notices+='\n'+await readFile(join(p.dir,f),'utf8')+'\n';
}
await writeFile('THIRD_PARTY_NOTICES.txt',notices.trimEnd()+'\n');
console.log('Built CLI and SDK with '+packages.size+' dependency notices.');
