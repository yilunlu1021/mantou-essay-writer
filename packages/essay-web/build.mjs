import { build } from 'esbuild';
import { mkdir, cp } from 'node:fs/promises';
await mkdir('build', { recursive:true });
await build({ entryPoints:['src/main.mjs'], outfile:'build/server.mjs', bundle:true, platform:'node', target:'node22', format:'esm',
  banner:{js:"import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"} });
await cp('public','build/public',{recursive:true});
await cp('../essay-writer/policy','build/policy',{recursive:true});
