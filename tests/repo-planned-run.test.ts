import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {repository} from './repo-test-helpers.ts';
import {runPlannedRepository} from '../src/repo-planned-run.ts';
import {prepareRepositoryPackets,type PacketCaller} from '../src/repo-packet-run.ts';
import {CodexWorkerError} from '../src/codex-worker.ts';
const {semanticReceiptAudit}=await import('../scripts/'+'semantic-decomposition-audit.mjs');
const options={runtime:'opencode-go' as const,workerModel:'deepseek-flash',maxCalls:8,maxTokens:10000,reserveTokensPerCall:1000,maxTokensPerCall:500,timeoutMs:1000,concurrency:2,maxRounds:16};
const task={version:1,goal:'a=42 b=43',files:[{path:'a.mjs',instructions:'a=42'},{path:'b.mjs',instructions:'b=43'}],context:['extra.txt'],protected:['check.mjs'],checks:[{argv:[process.execPath,'check.mjs']}]};
const files={'b.mjs':'export const value=43;', 'extra.txt':'UNRELATED_PUBLIC_MARKER','check.mjs':"import assert from 'node:assert/strict';import {value as a} from './a.mjs';import {value as b} from './b.mjs';assert.equal(a,42,'PRIVATE_MARKER');assert.equal(b,43);"};
const packet=(id:string,paths:string[],extra={})=>({id,writablePaths:paths,relevantPaths:[],objective:'Repair values',invariants:['Keep other behavior'],dependsOn:[],...extra});
const plan=(packets:unknown[],untouchedPaths:string[]=[])=>({packets,untouchedPaths,rationale:'Choose the smallest coherent repair'});
function receipt(model:string,result:unknown) {
 return {requestedModel:model,result,usage:[],transcript:{events:[],usage:[],requestedModel:model,effectiveModelEvidence:model,stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1,
  runtime:'opencode-go',apiFormat:'chat-completions',thinking:'enabled',httpStatus:200,usageCompleteness:'complete',rawUsage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}};
}
const code=(o:Parameters<PacketCaller>[0])=>({files:Object.fromEntries(((o.schema.properties as {files:{required:string[]}}).files.required).map(p=>[p,`export const value=${p==='a.mjs'?42:43};`])),note:''});
test('planner gets full public input; selected worker input and writes exclude untouched targets; all usage counts',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));let count=0;
 const r=await runPlannedRepository({...options,repository:root,task,outputDirectory:join(root,'out')},async o=>{
  count++;assert.equal(o.thinking,'enabled');assert.ok(!o.prompt.includes('PRIVATE_MARKER'));
  if(o.callId==='planner-1'){assert.match(o.prompt,/UNRELATED_PUBLIC_MARKER/);return receipt(o.model,plan([packet('repair',['a.mjs'])],['b.mjs']));}
  assert.ok(!o.prompt.includes('UNRELATED_PUBLIC_MARKER'));assert.ok(!o.prompt.includes('b.mjs'));return receipt(o.model,code(o));
 });assert.equal(r.success,true);assert.equal(count,2);assert.equal(r.budget.observedTokens,60);assert.equal(r.worker!.budget.maxTokens,9970);assert.equal(r.worker!.budget.calls.length,1);
 const normalized=(await prepareRepositoryPackets({...options,packetSize:'all',repository:root,task,outputDirectory:join(root,'unused')})).snapshot.task;
 const audited=await semanticReceiptAudit(join(root,'out'),'planned',r,{...options,repository:root,task:normalized,outputDirectory:join(root,'unused')},{executionFailure:false,checks:[],ok:true});assert.deepEqual(audited.evidenceErrors,[]);assert.equal(audited.inputTokens,40);
 const reqPath=join(root,'out','workers','call-1.request.json');const req=JSON.parse(await readFile(reqPath,'utf8'));req.reads['check.mjs']=0;await writeFile(reqPath,JSON.stringify(req));
 await assert.rejects(()=>semanticReceiptAudit(join(root,'out'),'planned',r,{...options,repository:root,task:normalized,outputDirectory:join(root,'unused')},{executionFailure:false,checks:[],ok:true}));
 assert.deepEqual(r.changedPaths,['a.mjs']);assert.equal(r.plannerChoseSingle,true);assert.deepEqual(r.untouchedPaths,['b.mjs']);assert.equal(await readFile(join(root,'a.mjs'),'utf8'),'export const value = 0;\n');
});
test('planner can choose one all-target packet and independent packets overlap',async t=>{
 for(const grouped of [true,false]) {
  const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));let active=0,max=0,release!:()=>void;
  const barrier=new Promise<void>(r=>{release=r;});
  const r=await runPlannedRepository({...options,repository:root,task,outputDirectory:join(root,'out')},async o=>{
   if(o.callId==='planner-1')return receipt(o.model,plan(grouped?[packet('all',['a.mjs','b.mjs'])]:[packet('a',['a.mjs']),packet('b',['b.mjs'])]));
   active++;max=Math.max(max,active);if(grouped||active===2)release();await barrier;active--;return receipt(o.model,code(o));
  });assert.equal(r.success,true);assert.equal(r.executedPacketCount,grouped?1:2);assert.equal(max,grouped?1:2);assert.equal(r.lowerCalls,grouped?2:3);
 }
});
test('wrong untouched selection fails whole oracle without another planner or worker call',async t=>{
 const root=await repository({...files,'b.mjs':'export const value=0;'});t.after(()=>rm(root,{recursive:true,force:true}));let count=0;
 const r=await runPlannedRepository({...options,repository:root,task,outputDirectory:join(root,'out')},async o=>{count++;return receipt(o.model,o.callId==='planner-1'?plan([packet('a',['a.mjs'])],['b.mjs']):code(o));});
 assert.equal(count,2);assert.equal(r.success,false);assert.equal(r.termination,'holdout-failed');assert.equal(r.completionMs,null);
});
test('invalid plan, unknown planner usage, wrong model, budget exhaustion and scope escapes do not dispatch workers',async t=>{
 for(const mode of ['invalid','unknown','identity','budget','escape']){
  const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));let count=0;
  const r=await runPlannedRepository({...options,maxCalls:mode==='budget'?1:8,repository:root,task,outputDirectory:join(root,'out')},async o=>{
   count++;const good=receipt(o.model,plan([packet('all',['a.mjs','b.mjs'])]));
   if(mode==='unknown')throw new CodexWorkerError('nonzero-exit','HTTP 500',{...good.transcript,effectiveModelEvidence:null,usage:[],rawUsage:undefined,httpStatus:500} as unknown as typeof good.transcript);
   if(mode==='identity')return {...good,transcript:{...good.transcript,effectiveModelEvidence:'other'}};
   if(mode==='invalid')return receipt(o.model,plan([packet('one',['a.mjs'])]));
   if(mode==='escape')return receipt(o.model,plan([packet('one',['check.mjs'])],['a.mjs','b.mjs']));return good;
  });assert.equal(count,1);assert.equal(r.success,false);assert.equal(r.worker,undefined);assert.equal(r.completionMs,null);
  if(mode==='unknown')assert.equal(r.budget.unknownUsageCalls,1);
 }
});
test('declared provider reads use its current committed version and untouched consumers still get final checks',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));
 const dependent={...task,files:[task.files[0],{...task.files[1],dependsOn:['a.mjs']}]};
 const r=await runPlannedRepository({...options,repository:root,task:dependent,outputDirectory:join(root,'out')},async o=>{
  if(o.callId==='planner-1')return receipt(o.model,plan([packet('b',['b.mjs']),packet('a',['a.mjs'])]));
  if(o.prompt.includes('Assigned targets: ["b.mjs"]'))assert.match(o.prompt,/Current packet\/dependency files:.*value=42/);
  return receipt(o.model,code(o));
 });assert.equal(r.success,true);assert.equal(r.worker!.maxConcurrentModelCalls,1);
});
test('planner source drift and output overlap fail without adopting stale plans',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 await assert.rejects(()=>runPlannedRepository({...options,repository:root,task,outputDirectory:join(root,'a.mjs')},async o=>{calls++;return receipt(o.model,{});}),/overlaps/);assert.equal(calls,0);
 const r=await runPlannedRepository({...options,repository:root,task,outputDirectory:join(root,'out')},async o=>{calls++;await writeFile(join(root,'extra.txt'),'changed');return receipt(o.model,plan([packet('all',['a.mjs','b.mjs'])]));});assert.equal(calls,1);assert.equal(r.termination,'source-drift');assert.equal(r.success,false);
});
test('planned CLI dry-run marks worker count unknown and never calls the model',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'task.json'),JSON.stringify(task));
 const args=['src/sheep-cli.ts','repo','--repo',root,'--task',join(root,'task.json'),'--runtime','opencode-go','--worker-model','deepseek-flash','--plan-work','--dry-run','--output',join(root,'out')];
 const r=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}));assert.equal(r.configuration.workers,null);assert.equal(r.planning.state,'requires-model-call');assert.equal(r.packetPlan,undefined);await assert.rejects(()=>stat(join(root,'out')));
 assert.throws(()=>execFileSync(process.execPath,[...args,'--packet-size','4'],{stdio:'pipe'}));
});
