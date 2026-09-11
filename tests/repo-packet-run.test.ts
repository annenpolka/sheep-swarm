import assert from 'node:assert/strict';
import test from 'node:test';
import {rm,readFile,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {repository} from './repo-test-helpers.ts';
import {runPacketRepository,prepareRepositoryPackets,type PacketCaller} from '../src/repo-packet-run.ts';
import {CodexWorkerError} from '../src/codex-worker.ts';
const config={runtime:'opencode-go' as const,workerModel:'deepseek-flash',maxCalls:8,maxTokens:10000,reserveTokensPerCall:1000,maxTokensPerCall:500,timeoutMs:1000,concurrency:2,maxRounds:16};
const spec={version:1,goal:'a=42, b=43',files:[{path:'a.mjs',instructions:'a=42'},{path:'b.mjs',instructions:'b=43'}],context:['public.txt'],protected:['check.mjs'],checks:[{argv:[process.execPath,'check.mjs']}]};
const files={'b.mjs':'export const value=0;', 'public.txt':'PUBLIC','check.mjs':"import assert from 'node:assert/strict';import {value as a} from './a.mjs';import {value as b} from './b.mjs';assert.equal(a,42,'HIDDEN_MARKER');assert.equal(b,43);"};
const response:PacketCaller=async o=>{
 const paths=(o.schema['properties'] as {files:{required:string[]}}).files.required;
 return {result:{files:Object.fromEntries(paths.map(p=>[p,`export const value=${p==='a.mjs'?42:43};`])),note:''},requestedModel:o.model,usage:[{event:{},inputTokens:20,outputTokens:10}],transcript:{events:[],usage:[{event:{},inputTokens:20,outputTokens:10}],usageCompleteness:'complete',requestedModel:o.model,effectiveModelEvidence:o.model,stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1}};
};
test('one executor handles singleton and all packets with no private context or source mutation',async t=>{
 for(const packetSize of [1,2,'all'] as const) {
  const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));
  const run=await runPacketRepository({...config,packetSize,repository:root,task:spec,outputDirectory:join(root,'run')},async o=>{
   assert.equal(o.thinking,'enabled');assert.ok(!o.prompt.includes('HIDDEN_MARKER'));assert.match(o.prompt,/PUBLIC/);return response(o);
  });
  assert.equal(run.success,true,JSON.stringify(run));assert.equal(run.lowerCalls,packetSize===1?2:1);assert.equal(run.sourceUnchanged,true);
  assert.equal(run.budget.activeReservations,0);assert.equal(await readFile(join(root,'b.mjs'),'utf8'),files['b.mjs']);
 }
});
test('packet public failure rejects all writes and retry receives its previous proposal plus public feedback',async t=>{
 const root=await repository({...files,'public-check.mjs':"import assert from 'node:assert/strict';import {value as a} from './a.mjs';import {value as b} from './b.mjs';assert.equal(a,42,'PUBLIC_FAILURE');assert.equal(b,43);"});t.after(()=>rm(root,{recursive:true,force:true}));let count=0;
 const task={...spec,context:[...spec.context,'public-check.mjs'],files:spec.files.map(f=>({...f,checks:[{argv:[process.execPath,'public-check.mjs']}]}))};
 const run=await runPacketRepository({...config,packetSize:'all',repository:root,task,outputDirectory:join(root,'run')},async o=>{
  count++;const r=await response(o);if(count===1)(r.result as {files:Record<string,string>}).files['b.mjs']='export const value=999;';
  else {const k=JSON.parse(await readFile(join(root,'run','kernel.json'),'utf8'));assert.equal(k.artifacts['a.mjs'].content,'export const value = 0;\n');assert.equal(k.artifacts['b.mjs'].content,'export const value=0;');assert.ok(!o.prompt.includes('HIDDEN_MARKER'));assert.match(o.prompt,/Previous rejected proposal:.*999/);}
  return r;
 });assert.equal(run.success,true);assert.equal(count,2);
});
test('dependency packets receive committed provider versions and cycles stay within one atomic packet',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));
 const task={...spec,files:[spec.files[0],{...spec.files[1],dependsOn:['a.mjs']}]};
 const run=await runPacketRepository({...config,packetSize:1,repository:root,task,outputDirectory:join(root,'run')},async o=>{
  if(o.prompt.includes('Assigned targets: ["b.mjs"]'))assert.match(o.prompt,/Current packet\/dependency files:.*value=42/);
  return response(o);
 });assert.equal(run.success,true);assert.equal(run.lowerCalls,2);assert.equal(run.maxConcurrentModelCalls,1);
 await writeFile(join(root,'a.mjs'),"import './b.mjs'; export const value=0;");
 await writeFile(join(root,'b.mjs'),"import './a.mjs'; export const value=0;");
 const cycle={...spec,version:2,discovery:{mode:'static',readable:[],maxReadCalls:0,maxPathsPerRead:8,maxDeliveredBytes:262144}};
 const cycleRun=await runPacketRepository({...config,packetSize:1,repository:root,task:cycle,outputDirectory:join(root,'cycle')},async o=>{
  const r=await response(o),f=(r.result as {files:Record<string,string>}).files;
  f['a.mjs']="import './b.mjs'; "+f['a.mjs'];f['b.mjs']="import './a.mjs'; "+f['b.mjs'];return r;
 });
 assert.equal(cycleRun.success,true);assert.equal(cycleRun.lowerCalls,1);assert.deepEqual(cycleRun.plan.packets[0]!.oversizeReasons,['strongly-connected-component']);
});
test('unknown usage drains issued peers, locks new admissions, and hidden failures do not trigger repair',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));let count=0;
 const run=await runPacketRepository({...config,packetSize:1,repository:root,task:spec,outputDirectory:join(root,'unknown')},async o=>{
  const first=++count===1,r=await response(o);if(first)throw new CodexWorkerError('timeout','timeout',{...r.transcript,timedOut:true,usage:[]});return r;
 });assert.equal(count,2);assert.equal(run.success,false);assert.equal(run.budget.unknownUsageCalls,1);assert.equal(run.budget.activeReservations,0);assert.equal(run.completedPackets.length,0);
 const hidden=await runPacketRepository({...config,packetSize:'all',repository:root,task:spec,outputDirectory:join(root,'hidden')},async o=>{
  const r=await response(o);(r.result as {files:Record<string,string>}).files['a.mjs']='export const value=0;';return r;
 });assert.equal(hidden.termination,'holdout-failed');assert.equal(hidden.lowerCalls,1);assert.equal(hidden.completionMs,null);
});
test('packet rejects scope escapes, source drift and unsupported policies before applying',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));
 const escape=await runPacketRepository({...config,maxCalls:1,packetSize:'all',repository:root,task:spec,outputDirectory:join(root,'escape')},async o=>{
  const r=await response(o);(r.result as {files:Record<string,string>}).files['check.mjs']='';return r;
 });assert.equal(escape.success,false);assert.equal(escape.changedPaths.length,0);
 const drift=await runPacketRepository({...config,apply:true,packetSize:'all',repository:root,task:spec,outputDirectory:join(root,'drift')},async o=>{
  await writeFile(join(root,'public.txt'),'changed');return response(o);
 });assert.equal(drift.termination,'source-drift');assert.equal(drift.applied,false);
 await assert.rejects(()=>prepareRepositoryPackets({...config,goThinking:'disabled',packetSize:'all',repository:root,task:spec,outputDirectory:join(root,'bad')}));
 await assert.rejects(()=>stat(join(root,'bad')));
});
test('packet CLI dry-run prints the actual plan and performs no run writes',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));const taskPath=join(root,'task.json');await writeFile(taskPath,JSON.stringify(spec));
 const args=['src/sheep-cli.ts','repo','--repo',root,'--task',taskPath,'--packet-size','1','--runtime','opencode-go','--worker-model','deepseek-flash','--dry-run','--output',join(root,'planned')];
 const plan=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}));assert.equal(plan.packetPlan.packets.length,2);assert.equal(plan.configuration.concurrency,4);assert.deepEqual(plan.packetPlan.publicPaths,['a.mjs','b.mjs','public.txt']);
 await assert.rejects(()=>stat(join(root,'planned')));
});

test('independent packet calls overlap while validation commits remain serialized',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));
 let entered=0,release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});
 const run=await runPacketRepository({...config,packetSize:1,repository:root,task:spec,outputDirectory:join(root,'parallel')},async o=>{
  if(++entered===2)release();await barrier;return response(o);
 });assert.equal(run.success,true);assert.equal(run.maxConcurrentModelCalls,2);assert.equal(run.lowerCalls,2);
});
test('verification infrastructure errors stop the next wave and settled peers cannot commit',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));
 const task={...spec,files:spec.files.map(f=>({...f,checks:[{argv:['/no-such-packet-check']}]}))};
 const run=await runPacketRepository({...config,packetSize:1,repository:root,task,outputDirectory:join(root,'infra')},response);
 assert.equal(run.success,false);assert.equal(run.termination,'verification-infrastructure');assert.equal(run.lowerCalls,2);assert.deepEqual(run.changedPaths,[]);assert.equal(run.budget.activeReservations,0);
});
test('static packet graph refuses newly introduced dependencies before any commit',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));
 const task={...spec,version:2,discovery:{mode:'static',readable:[],maxReadCalls:0,maxPathsPerRead:8,maxDeliveredBytes:262144}};
 const run=await runPacketRepository({...config,maxCalls:1,packetSize:'all',repository:root,task,outputDirectory:join(root,'edge')},async o=>{
  const r=await response(o);(r.result as {files:Record<string,string>}).files['b.mjs']="import './a.mjs'; export const value=43;";return r;
 });assert.equal(run.success,false);assert.deepEqual(run.changedPaths,[]);assert.match(run.calls[0]!.errors.join(' '),/frozen public dependency graph/);
});
test('packet output cannot occupy a newly declared target and successful apply uses the original drift guard',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 const task={...spec,files:[...spec.files,{path:'new.mjs',instructions:'new source'}]};
 await assert.rejects(()=>runPacketRepository({...config,packetSize:'all',repository:root,task,outputDirectory:join(root,'new.mjs')},async o=>{calls++;return response(o);}),/overlaps/);
 assert.equal(calls,0);await assert.rejects(()=>stat(join(root,'new.mjs')));
 const accepted=await runPacketRepository({...config,apply:true,packetSize:'all',repository:root,task:spec,outputDirectory:join(root,'apply')},response);
 assert.equal(accepted.success,true);assert.equal(accepted.applied,true);assert.equal(await readFile(join(root,'b.mjs'),'utf8'),'export const value=43;');
});
