import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {repository} from './repo-test-helpers.ts';
import {runRepository} from '../src/repo-run.ts';
import type {RepoCaller} from '../src/repo-types.ts';
// @ts-expect-error fixture generator is a host-only JavaScript helper
import {moonBitFixture} from '../scripts/moonbit-repository-fixture.mjs';
const profile={runtime:'opencode-go' as const,workerModel:'deepseek-flash',workers:4,concurrency:2,maxCalls:4,maxMetaCalls:0,maxTokens:10000,reserveTokensPerCall:100};
const reply=(content:string):RepoCaller=>async o=>({requestedModel:o.model,result:{kind:'write',content,paths:[],observed:[],missing:[],hypothesis:'',note:''},usage:[{event:{},inputTokens:10,outputTokens:5}],transcript:{events:[],usage:[{event:{},inputTokens:10,outputTokens:5}],usageCompleteness:'complete',requestedModel:o.model,effectiveModelEvidence:'injected-test',stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1}});
test('MoonBit repository activation delivers siblings and the accepted imported package version',async t=>{
 const {files,task}=moonBitFixture('/unused-in-this-injected-test');
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));
 task.checks=[{argv:[process.execPath,'-e','process.exit(0)']}];
 const seen:string[]=[];
 const result=await runRepository({...profile,repository:root,task,outputDirectory:join(root,'run')},async o=>{
  const local=JSON.parse(/Local files:\n([^\n]+)\n/.exec(o.prompt)![1]!);
  if(o.prompt.includes('Update only a/main.mbt')){
   seen.push('a');assert.match(local['a/helper.mbt'],/floor_units/);assert.match(local['policy/policy.mbt'],/7/);
   return reply('pub fn price(n : Int) -> Int { floor_units(n) * @policy.rate() }\n')(o);
  }
  assert.match(o.prompt,/Update only b\/main.mbt/);seen.push('b');assert.match(local['a/main.mbt'],/floor_units\(n\)/);
  return reply('pub fn invoice(n : Int) -> Int { @a.price(n) + 3 }\n')(o);
 });
 assert.equal(result.success,true,result.errors.join('\n'));assert.deepEqual(seen,['a','b']);assert.deepEqual(result.changedPaths,['a/main.mbt','b/main.mbt']);
 const deliveries=JSON.parse(await readFile(join(root,'run/read-deliveries.json'),'utf8'));
 assert.ok(deliveries.deliveries.some((r:{target:string;path:string;stamp:{version:number}})=>r.target==='b/main.mbt'&&r.path==='a/main.mbt'&&r.stamp.version===1));
 assert.equal(await readFile(join(root,'a/main.mbt'),'utf8'),files['a/main.mbt']);
});
test('MoonBit incomplete package catalog fails before any worker admission',async t=>{
 const {files,task}=moonBitFixture('/unused');const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));
 task.discovery.readable=task.discovery.readable.filter((p:string)=>p!=='a/helper.mbt');
 await assert.rejects(runRepository({...profile,repository:root,task,outputDirectory:join(root,'run')},async()=>{throw new Error('must not call');}),/explicit public.*helper.mbt/);
});
