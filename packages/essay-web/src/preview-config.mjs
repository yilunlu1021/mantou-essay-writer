import {mkdir,readFile,writeFile,realpath,access}from'node:fs/promises';import{join,resolve}from'node:path';import{randomUUID}from'node:crypto';
export async function assertPreviewDataDirectory(path){
  if(!path)throw new Error('Preview requires an explicit isolated data directory');await mkdir(path,{recursive:true,mode:0o700});const root=await realpath(path);
  const production=await realpath('/var/lib/essaydm').catch(()=>resolve('/var/lib/essaydm'));
  if(root===production||root.startsWith(production+'/'))throw new Error('Preview cannot use production data');
  const marker=join(root,'.essay-preview.json');let value;try{value=JSON.parse(await readFile(marker,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('Invalid preview identity');let exists=false;try{await access(join(root,'workbench.sqlite'));exists=true;}catch{}if(exists)throw new Error('Refuse to start preview against an unmarked existing database');value={environment:'research-preview',id:randomUUID()};await writeFile(marker,JSON.stringify(value),{mode:0o600,flag:'wx'});}
  if(value.environment!=='research-preview'||!value.id)throw new Error('Invalid preview identity');return root;
}
