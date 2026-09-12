import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm,stat,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {repository} from './repo-test-helpers.ts';
import {runLazyRepository} from '../src/repo-lazy-run.ts';
import type {GoAssistant} from '../src/opencode-go-conversation.ts';
import type {OpenCodeGoResult} from '../src/opencode-go-worker.ts';
const options={runtime:'opencode-go' as const,workerModel:'deepseek-flash',maxCalls:8,maxTokens:10000,reserveTokensPerCall:1000,maxTokensPerCall:500,timeoutMs:1000,concurrency:2,maxRounds:12};
const task={version:1,goal:'a=42 b=43',files:[{path:'a.mjs',instructions:'a=42'},{path:'b.mjs',instructions:'b=43'}],context:['extra.txt'],protected:['check.mjs'],checks:[{argv:[process.execPath,'check.mjs']}]};
const files={'b.mjs':'export const value=0;', 'extra.txt':'PUBLIC', 'check.mjs':"import assert from 'node:assert/strict';import {value as a} from './a.mjs';import {value as b} from './b.mjs';assert.equal(a,42,'PRIVATE_MARKER');assert.equal(b,43);"};
const fixed={'a.mjs':'export const value=42;','b.mjs':'export const value=43;'};
function receipt(result:GoAssistant):OpenCodeGoResult<GoAssistant>{
 return {requestedModel:'deepseek-flash',result,usage:[],transcript:{events:[],usage:[],requestedModel:'deepseek-flash',effectiveModelEvidence:'deepseek-flash',stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1,runtime:'opencode-go',apiFormat:'chat-completions',thinking:'enabled',httpStatus:200,responseModel:'deepseek-flash',sessionId:'test',usageCompleteness:'complete',rawUsage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}};
}
const submit=(files:Record<string,string>)=>receipt({role:'assistant',reasoning_content:'test continuation',content:JSON.stringify({files,note:''})});
const tool=(name:string,args:unknown,id='tool-1')=>receipt({role:'assistant',content:null,reasoning_content:'test continuation',tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const fork=(more={})=>({paths:['b.mjs'],relevantPaths:[],objective:'Implement b=43',invariants:['Preserve exports'],parentWork:'Implement a=42',checkpoint:{},...more});
async function setup(t:{after:(f:()=>Promise<unknown>)=>unknown},extra={}){const root=await repository({...files,...extra});t.after(()=>rm(root,{recursive:true,force:true}));return {...options,task,repository:root,outputDirectory:join(root,'out')};}
test('lazy direct submission uses one call, no children or completion-only call and preserves source',async t=>{
 const o=await setup(t);let count=0;
 const r=await runLazyRepository({...o,lazyChildren:0},async args=>{count++;assert.equal(args.tools.length,0);assert(!JSON.stringify(args.messages).includes('PRIVATE_MARKER'));return submit(fixed);});
 assert.equal(r.success,true);assert.equal(count,1);assert.equal(r.lowerCalls,1);assert.equal(r.children.length,0);assert.equal(r.budget.observedTokens,30);assert.equal(r.budget.activeReservations,0);assert.equal(r.verifications.filter(v=>v.checks.length).length,1);assert.equal(await readFile(join(o.repository,'a.mjs'),'utf8'),'export const value = 0;\n');
});
test('lazy parent continues while child is active and final submit joins without extra call', {timeout:10000},async t=>{
 const o=await setup(t);let rootCalls=0,release!:()=>void,notifyStarted!:()=>void;
 const childStarted=new Promise<void>(r=>{notifyStarted=r;});
 const barrier=new Promise<void>(r=>{release=r;});
 const r=await runLazyRepository(o,async args=>{
  assert(!JSON.stringify(args.messages).includes('PRIVATE_MARKER'));
  if(args.sessionId!.endsWith('child-1')){notifyStarted();await barrier;return submit({'b.mjs':fixed['b.mjs']});}
  rootCalls++;if(rootCalls===1)return tool('fork',fork());await childStarted;release();
  assert(args.messages.some(m=>m.role==='assistant'&&m.reasoning_content==='test continuation'));return submit({'a.mjs':fixed['a.mjs']});
 });assert.equal(r.success,true);assert.equal(rootCalls,2);assert.equal(r.lowerCalls,3);assert.equal(r.maxConcurrentModelCalls,2);assert.equal(r.children[0]!.status,'accepted');assert.equal(r.budget.observedTokens,90);
});
test('stale delivered child read is rejected and parent takes over within the original budget',async t=>{
 const o=await setup(t);let n=0;
 const r=await runLazyRepository(o,async args=>{
  if(args.sessionId!.endsWith('child-1'))return submit({'b.mjs':fixed['b.mjs']});
  n++;if(n===1)return tool('fork',fork({relevantPaths:['a.mjs']}));if(n===2)return submit({'a.mjs':fixed['a.mjs']});
  assert.match(JSON.stringify(args.messages),/stale-read/);return submit({'b.mjs':fixed['b.mjs']});
 });assert.equal(r.success,true);assert.equal(n,3);assert.equal(r.children[0]!.status,'returned-to-parent');assert.equal(r.lowerCalls,4);
});
test('child scope and root exclusion are host enforced; rejected parent candidate is retained in conversation',async t=>{
 const o=await setup(t);let n=0;
 const r=await runLazyRepository(o,async args=>{
  if(args.sessionId!.endsWith('child-1'))return submit({'a.mjs':'not authorized'});
  n++;if(n===1)return tool('fork',fork());if(n===2)return submit(fixed); // cannot write b while delegated
  if(n===3){assert.match(JSON.stringify(args.messages),/unauthorized/);return tool('join',{jobs:['child-1']},'tool-2');}
  return submit(fixed);
 });assert.equal(r.success,true);assert.equal(r.children[0]!.status,'returned-to-parent');assert.equal(r.lowerCalls,5);
});
test('fork checkpoint commits before child snapshot and explicit join returns current code',async t=>{
 const o=await setup(t);let n=0;
 const r=await runLazyRepository(o,async args=>{
  if(args.sessionId!.endsWith('child-1')){assert.match(JSON.stringify(args.messages),/value=42/);return submit({'b.mjs':fixed['b.mjs']});}
  n++;if(n===1)return tool('fork',fork({relevantPaths:['a.mjs'],checkpoint:{'a.mjs':fixed['a.mjs']}}));
  if(n===2)return tool('join',{jobs:['child-1']},'tool-2');assert.match(JSON.stringify(args.messages),/value=43/);return submit({});
 });assert.equal(r.success,true);assert.equal(r.children[0]!.status,'accepted');
});
test('unknown child usage drains issued calls, blocks success/apply and remains charged as unknown',async t=>{
 const o=await setup(t);let n=0;
 const r=await runLazyRepository({...o,apply:true},async args=>{
  if(args.sessionId!.endsWith('child-1')){const v=submit({'b.mjs':fixed['b.mjs']});return {...v,transcript:{...v.transcript,usageCompleteness:'partial-or-unknown',rawUsage:undefined}};}
  n++;return n===1?tool('fork',fork()):submit({'a.mjs':fixed['a.mjs']});
 });assert.equal(r.success,false);assert.equal(r.applied,false);assert.equal(r.budget.unknownUsageCalls,1);assert.equal(r.budget.activeReservations,0);assert.equal(r.completionMs,null);assert(n<=2);
});
test('holdout failure ends the run with no feedback or extra call',async t=>{
 const o=await setup(t);let n=0;const r=await runLazyRepository(o,async()=>{n++;return submit({'a.mjs':fixed['a.mjs']});});
 assert.equal(r.success,false);assert.equal(r.termination,'holdout-failed');assert.equal(n,1);assert.equal(r.completionMs,null);
});
test('call cap leaves unresolved child non-success without a budget reset',async t=>{
 const o=await setup(t);const r=await runLazyRepository({...o,maxCalls:1},async()=>tool('fork',fork()));
 assert.equal(r.success,false);assert.equal(r.lowerCalls,1);assert.equal(r.budget.activeReservations,0);assert.equal(r.children[0]!.joined,false);
});
test('lazy child cap, private reads and all-work delegation are rejected before child calls',async t=>{
 for(const args of [fork({paths:['a.mjs','b.mjs']}),fork({relevantPaths:['check.mjs']}),fork({parentWork:''})]){
  const o=await setup(t);let n=0;const r=await runLazyRepository(o,async()=>++n===1?tool('fork',args):submit(fixed));assert.equal(r.success,true);assert.equal(r.children.length,0);assert.equal(n,2);
 }
});
test('lazy C1 serializes calls and source drift prevents apply',async t=>{
 const o=await setup(t);let n=0;
 const r=await runLazyRepository({...o,concurrency:1,apply:true},async args=>{
  if(args.sessionId!.endsWith('child-1'))return submit({'b.mjs':fixed['b.mjs']});
  n++;if(n===1)return tool('fork',fork());await writeFile(join(o.repository,'extra.txt'),'drift');return submit({'a.mjs':fixed['a.mjs']});
 });assert.equal(r.maxConcurrentModelCalls,1);assert.equal(r.success,false);assert.equal(r.applied,false);assert.equal(r.termination,'source-drift');
});
test('lazy CLI dry-run is free and distinguishes child-disabled control',async t=>{
 const o=await setup(t);await writeFile(join(o.repository,'task.json'),JSON.stringify(task));
 const args=['src/sheep-cli.ts','repo','--repo',o.repository,'--task',join(o.repository,'task.json'),'--runtime','opencode-go','--worker-model','deepseek-flash','--lazy-swarm','--lazy-children','0','--dry-run','--output',o.outputDirectory];
 const r=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}));assert.equal(r.options.lazyChildren,0);assert.equal(r.configuration.workers,1);await assert.rejects(()=>stat(o.outputDirectory));
 for(const flag of [['--packet-size','all'],['--plan-work'],['--lazy-children','3']])assert.throws(()=>execFileSync(process.execPath,[...args,...flag],{stdio:'pipe'}));
});
test('two children and parent share C3; no third child can reset the run-wide limit',{timeout:10000},async t=>{
 const o=await setup(t,{'c.mjs':'export const value=0;'});let roots=0,started=0,release!:()=>void,notifyStarted!:()=>void;
 const allStarted=new Promise<void>(r=>{notifyStarted=r;});
 const barrier=new Promise<void>(r=>{release=r;});
 const r=await runLazyRepository({...o,concurrency:3,task:{...task,files:[...task.files,{path:'c.mjs',instructions:'c=44'}]}},async args=>{
  if(args.sessionId!.endsWith('child-1')){started++;if(started===2)notifyStarted();await barrier;return submit({'b.mjs':fixed['b.mjs']});}
  if(args.sessionId!.endsWith('child-2')){started++;if(started===2)notifyStarted();await barrier;return submit({'c.mjs':'export const value=44;'});}
  roots++;if(roots===1)return tool('fork',fork());
  if(roots===2)return tool('fork',fork({paths:['c.mjs']}),'tool-2');
  await allStarted;assert.equal(started,2);release();if(roots===3)return tool('fork',fork({paths:['a.mjs']}),'tool-3');
  assert.match(JSON.stringify(args.messages),/run child limit reached/);return submit({'a.mjs':fixed['a.mjs']});
 });assert.equal(r.success,true);assert.equal(r.children.length,2);assert.equal(r.maxConcurrentModelCalls,3);assert(r.metrics.rootChildOverlapMs>0);assert.equal(r.budget.observedTokens,180);
});
test('public rejection continues the same parent with its candidate and hidden checks remain final only',async t=>{
 const o=await setup(t,{'public.mjs':"import assert from 'node:assert/strict';import {value} from './a.mjs';assert.equal(value,42,'PUBLIC_EXPECTATION');"});
 let n=0;
 const publicTask={...task,context:['extra.txt','public.mjs'],files:[{...task.files[0],checks:[{argv:[process.execPath,'public.mjs']}]},task.files[1]]};
 const r=await runLazyRepository({...o,task:publicTask},async args=>{
  n++;if(n===1)return submit({...fixed,'a.mjs':'export const value=41;'});
  assert.match(JSON.stringify(args.messages),/value=41/);assert.match(JSON.stringify(args.messages),/PUBLIC_EXPECTATION/);assert(!JSON.stringify(args.messages).includes('PRIVATE_MARKER'));return submit(fixed);
 });assert.equal(r.success,true);assert.equal(n,2);assert.equal(r.verifications.filter(v=>v.checks.some(c=>c.argv.includes('holdout.mjs')||c.argv.includes('check.mjs'))).length,1);
});
test('receipt write failure and reservation overrun stop new calls; settled usage is preserved',async t=>{
 for(const mode of ['io','overrun']){
  const o=await setup(t);let n=0;
  const r=await runLazyRepository(o,async args=>{n++;if(mode==='io')await mkdir(join(args.outputDirectory!,args.callId+'.json'));const result=submit(fixed);return mode==='io'?result:{...result,transcript:{...result.transcript,rawUsage:{prompt_tokens:2000,completion_tokens:10,total_tokens:2010}}};});
  assert.equal(r.success,false);assert.equal(n,1);assert.equal(r.budget.activeReservations,0);assert.equal(r.budget.unknownUsageCalls,0);assert.equal(r.termination,mode==='io'?'evidence-failure':'reservation-overrun');
 }
});
test('successful lazy apply changes only the accepted declared sources',async t=>{
 const o=await setup(t);const r=await runLazyRepository({...o,apply:true},async()=>submit(fixed));assert.equal(r.success,true);assert.equal(r.applied,true);assert.equal(await readFile(join(o.repository,'a.mjs'),'utf8'),fixed['a.mjs']);assert.equal(await readFile(join(o.repository,'extra.txt'),'utf8'),'PUBLIC');
});
test('a batch of model tools cannot silently reuse a refreshed context for a stale checkpoint',async t=>{
 const o=await setup(t);let n=0;
 const r=await runLazyRepository(o,async args=>{
  n++;if(n===1){const first=tool('fork',fork({checkpoint:{'a.mjs':fixed['a.mjs']}}));return {...first,result:{...first.result,tool_calls:[...first.result.tool_calls!,{id:'tool-2',type:'function',function:{name:'fork',arguments:JSON.stringify(fork({checkpoint:{'a.mjs':'stale overwrite'}}))}}]}};}
  assert.match(JSON.stringify(args.messages),/batch performed no operations/);return submit(fixed);
 });assert.equal(r.success,true);assert.equal(r.children.length,0);assert.equal(n,2);
});
