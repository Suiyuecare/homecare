import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
async function files(dir) { const entries = await readdir(dir, { withFileTypes: true }); return (await Promise.all(entries.map(x => x.isDirectory() ? files(path.join(dir,x.name)) : path.join(dir,x.name)))).flat(); }
const sources = (await Promise.all(['public','src/server','tests','scripts','ops'].map(files))).flat().filter(x=>/\.(m?js)$/.test(x));
for (const file of sources) { const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'}); if(result.status!==0){process.stderr.write(result.stderr);process.exit(1);} }
const pkg=JSON.parse(await readFile('package.json','utf8'));
if(!pkg.private) throw new Error('App package must be private');
console.log(`Checked ${sources.length} JavaScript modules; local application requires no network build dependencies.`);
