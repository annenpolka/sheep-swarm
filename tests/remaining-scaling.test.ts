import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execute} from './repo-test-helpers.ts';

test('scaled TS local checks load valid assertions and reject missing JSON import attributes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'sheep-scaled-check-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const fixture=join(root,'fixture'),repo=join(fixture,'repo');
 await execute(process.execPath,[resolve('scripts/prepare-read-selection-pilot.mjs'),'--output',fixture,'--seed','ts-check-contract','--targets','4','--documents','8']);
 const task=JSON.parse(await readFile(join(fixture,'local.json'),'utf8'));
 const host=JSON.parse(await readFile(join(fixture,'fixture.json'),'utf8'));
 const target=task.files[0],policy=host.expectations[0];
 const command=target.checks[0].argv;
 await writeFile(join(repo,target.path),`const p=${JSON.stringify(policy.policy)} as const;export const quote=(n: unknown): number | null => typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?Math.min(p.cap,Math.max(p.minimum,n))*p.rate:null;`);
 await execute(command[0],command.slice(1),{cwd:repo});
 await writeFile(join(repo,target.path),`import p from '../${policy.policyPath}';export const quote=(n: number)=>n*p.rate;`);
 await assert.rejects(execute(command[0],command.slice(1),{cwd:repo}),/import attribute/);
 const broad=JSON.parse(await readFile(join(fixture,'broad.json'),'utf8'));
 assert.deepEqual({...task,context:broad.context},broad);
});
