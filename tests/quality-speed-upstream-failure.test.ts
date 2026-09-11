import assert from 'node:assert/strict';
import test from 'node:test';
import {rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {repository} from './repo-test-helpers.ts';
import {runRepository} from '../src/repo-run.ts';
// @ts-expect-error host-only fixture
import {buildQualitySpeedFixture} from '../scripts/quality-speed-fixture.mjs';
// @ts-expect-error independent reference candidates
import {referenceContents} from '../scripts/quality-speed-reference.mjs';

test('public downstream failure currently retries the consumer without reopening an accepted faulty provider',async t=>{
 const f=buildQualitySpeedFixture('propagation',1),reference=referenceContents('propagation');
 const root=await repository(f.files);t.after(()=>rm(root,{recursive:true,force:true}));
 const badAmount=reference['amount.mjs'].replace('const digits=parts[0]',"if(parts[1]===undefined)return Number(parts[0]);const digits=parts[0]");
 const seen:Record<string,number>={};
 const result=await runRepository({repository:root,task:f.task,outputDirectory:join(root,'run'),runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'disabled',workers:4,concurrency:2,maxCalls:12,maxMetaCalls:0,maxTokens:10000,reserveTokensPerCall:100},async o=>{
  const target=/Update only ([^\s]+\.mjs)/.exec(o.prompt)?.[1];assert.ok(target);seen[target]=(seen[target]??0)+1;
  const content=target==='amount.mjs'?badAmount:reference[target];assert.equal(typeof content,'string');
  return {requestedModel:o.model,result:{kind:'write',content,paths:[],observed:[],missing:[],hypothesis:'',note:''},usage:[{event:{},inputTokens:10,outputTokens:5}],transcript:{events:[],usage:[{event:{},inputTokens:10,outputTokens:5}],usageCompleteness:'complete',requestedModel:o.model,effectiveModelEvidence:'injected-test',stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1}};
 });
 assert.equal(result.success,false);assert.equal(seen['amount.mjs'],1);assert.equal(seen['cart.mjs'],1);assert.equal(seen['invoice.mjs'],5);
 assert.equal(result.budget.unknownUsageCalls,0);assert.equal(result.swarm.lowerCalls,7);
});

for(const scenario of ['repair','still-broken','healthy-provider','hidden-only','inactive-provider','verification-unavailable','timeout','signal','candidate-drift','contract-review'] as const) test(`upstream recovery: ${scenario}`,async t=>{
 const f=buildQualitySpeedFixture('propagation',1),reference=referenceContents('propagation');
 const badAmount=reference['amount.mjs'].replace('const digits=parts[0]',"if(parts[1]===undefined)return Number(parts[0]);const digits=parts[0]");
 if(scenario==='inactive-provider'){f.files['amount.mjs']=badAmount;f.files['cart.mjs']=reference['cart.mjs'];f.task.activation={changedPaths:['invoice.mjs']};}
 if(scenario==='verification-unavailable')f.task.files.find((f:{path:string})=>f.path==='invoice.mjs').checks=[{argv:['missing-recovery-check-command']}];
 if(scenario==='timeout')f.task.files.find((f:{path:string})=>f.path==='invoice.mjs').checks=[{argv:[process.execPath,'-e','setTimeout(()=>{},10000)'],timeoutMs:10}];
 if(scenario==='signal')f.task.files.find((f:{path:string})=>f.path==='invoice.mjs').checks=[{argv:[process.execPath,'-e','process.kill(process.pid,"SIGTERM")']}];
 if(scenario==='candidate-drift')f.task.files.find((f:{path:string})=>f.path==='invoice.mjs').checks=[{argv:[process.execPath,'-e',`require('node:fs').writeFileSync('amount.mjs','changed');process.exit(1)`]}];
 const root=await repository(f.files);t.after(()=>rm(root,{recursive:true,force:true}));
 const seen:Record<string,number>={},prompts:string[]=[];
 const result=await runRepository({repository:root,task:{...f.task,recovery:{maxUpstreamRechecks:2,...(scenario==='contract-review'?{review:'contract'}:{})}},outputDirectory:join(root,'run'),runtime:'opencode-go',workerModel:'deepseek-flash',workers:4,concurrency:2,maxCalls:12,maxMetaCalls:0,maxTokens:10000,reserveTokensPerCall:100},async o=>{
  assert.equal((o as typeof o & {thinking?:string}).thinking,'enabled');
  const target=/Update only ([^\s]+\.mjs)/.exec(o.prompt)?.[1];assert.ok(target);seen[target]=(seen[target]??0)+1;prompts.push(o.prompt);
  let content=reference[target];
  if(target==='amount.mjs'){
   if(scenario==='still-broken'||(['repair','contract-review'].includes(scenario)&&seen[target]===1))content=badAmount;
   if(scenario==='hidden-only')content=content.replace('const n=BigInt(digits);',"if(digits.length>15)return null;const n=BigInt(digits);");
   if(seen[target]!>1){if(scenario==='contract-review')assert.match(o.prompt,/EVERY requirement/);assert.match(o.prompt,/public-local-check-failure/);assert.match(o.prompt,/diagnostic/);assert.match(o.prompt,/invoice/);}
  }
  if(target==='invoice.mjs'&&scenario==='healthy-provider'&&seen[target]===1)content=f.files['invoice.mjs'];
  return {requestedModel:o.model,result:{kind:'write',content,paths:[],observed:[],missing:[],hypothesis:'',note:''},usage:[{event:{},inputTokens:10,outputTokens:5}],transcript:{events:[],usage:[{event:{},inputTokens:10,outputTokens:5}],usageCompleteness:'complete',requestedModel:o.model,effectiveModelEvidence:'injected-test',stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1}};
 });
 const recovery=JSON.parse(await readFile(join(root,'run/swarm/upstream-recovery.json'),'utf8'));
 assert.equal(result.budget.unknownUsageCalls,0);assert.equal(result.swarm.upperCalls,0);
 assert.equal(result.success,scenario==='repair'||scenario==='healthy-provider'||scenario==='inactive-provider'||scenario==='contract-review');
 if(['hidden-only','verification-unavailable','timeout','signal','candidate-drift'].includes(scenario)){
  assert.equal(result.swarm.lowerCalls,['hidden-only','verification-unavailable'].includes(scenario)?3:7);assert.deepEqual(recovery.observations,[]);assert.deepEqual(recovery.rechecked,[]);
 }else{
  assert.equal(seen['amount.mjs'],scenario==='inactive-provider'?1:2);assert.equal(seen['cart.mjs'],scenario==='inactive-provider'?1:2);
  assert.equal(seen['invoice.mjs'],scenario==='still-broken'?5:2);
  assert.deepEqual(recovery.rechecked,['amount.mjs','cart.mjs']);
  assert.equal(recovery.observations.filter((r:{selected:string[]})=>r.selected.length>0).length,1);
 }
 for(const prompt of prompts)assert.ok(!prompt.includes('holdout.mjs'));
});
