import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { writeNotices } from './licenses.mjs';
await writeNotices();
await mkdir('artifacts', { recursive: true });
await build({ entryPoints:['src/extension.ts'], bundle:true, platform:'node', target:'node22', format:'cjs', outfile:'dist/extension.cjs', external:['vscode'], sourcemap:false });
