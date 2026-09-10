import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,cp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const fixtures=fileURLToPath(new URL('./fixtures/repo-discovery/',import.meta.url));
test('fixed discovery oracle rejects baseline and independent policy, validation and composition mutations',async t=>{
  const root=await mkdtemp(join(tmpdir(),'sheep-discovery-oracle-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await cp(join(fixtures,'baseline'),root,{recursive:true});await cp(join(fixtures,'check.mjs'),join(root,'check.mjs'));
  const check=()=>spawnSync(process.execPath,['check.mjs'],{cwd:root,encoding:'utf8',timeout:10000});
  assert.notEqual(check().status,0);await cp(join(fixtures,'solution'),root,{recursive:true});assert.equal(check().status,0);
  for(const [path,mutation] of [['pricing.mjs','export function quote(){return 42;}'],['pricing.mjs','export function quote(n){return Math.min(8,Math.max(3,n))*7;}'],
    ['pricing.mjs','export function quote(n){return Number.isSafeInteger(n)&&n>=0?Math.max(3,n)*7:null;}'],
    ['label.mjs',"export function label(n){return n===1?'items':'item';}"],['summary.mjs','export function summary(){return null;}']]){
    const original=await readFile(join(root,path!));await writeFile(join(root,path!),mutation!);assert.notEqual(check().status,0,`mutation survived ${mutation}`);await writeFile(join(root,path!),original);
  }
  assert.equal(check().status,0);
});
