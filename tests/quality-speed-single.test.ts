import assert from 'node:assert/strict';
import test from 'node:test';
import {rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {repository} from './repo-test-helpers.ts';
import {runSingleRepository,parseSingleResponse,type SingleCaller} from '../experiments/repository-single.ts';
import {CodexWorkerError} from '../src/codex-worker.ts';
const config={responseFormat:'array' as const,maxCalls:3,maxTokens:10000,reserveTokensPerCall:1000,maxTokensPerCall:500,timeoutMs:1000};
const spec={version:1,goal:'a=42, b=43',files:[{path:'a.mjs',instructions:'a=42'},{path:'b.mjs',instructions:'b=43'}],context:['public.txt'],protected:['check.mjs'],checks:[{argv:[process.execPath,'check.mjs']}]};
const files={'b.mjs':'export const value=0;', 'public.txt':'PUBLIC','check.mjs':"import assert from 'node:assert/strict';import {value as a} from './a.mjs';import {value as b} from './b.mjs';assert.equal(a,42,'HIDDEN_MARKER');assert.equal(b,43);"};
const response=(value=42):SingleCaller=>async o=>({result:{files:[{path:'a.mjs',content:`export const value=${value};`},{path:'b.mjs',content:'export const value=43;'}],note:''},requestedModel:o.model,usage:[{event:{},inputTokens:20,outputTokens:10}],transcript:{events:[],usage:[{event:{},inputTokens:20,outputTokens:10}],usageCompleteness:'complete',requestedModel:o.model,effectiveModelEvidence:o.model,stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1}});
test('single baseline edits multiple files atomically without leaking hidden oracle and keeps source intact',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 const run=await runSingleRepository({...config,repository:root,task:spec,outputDirectory:join(root,'run')},async o=>{calls++;assert.ok(!o.prompt.includes('HIDDEN_MARKER'));assert.match(o.prompt,/PUBLIC/);return response()(o);});
 assert.equal(run.success,true);assert.equal(calls,1);assert.equal(run.termination,'accepted');assert.ok(run.completionMs!>0);assert.equal(await readFile(join(root,'b.mjs'),'utf8'),files['b.mjs']);
});
test('single baseline never retries hidden quality failures and never scores them as completion',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 const run=await runSingleRepository({...config,repository:root,task:spec,outputDirectory:join(root,'run')},async o=>{calls++;return response(0)(o);});
 assert.equal(calls,1);assert.equal(run.success,false);assert.equal(run.completionMs,null);assert.equal(run.termination,'holdout-failed');assert.ok(run.elapsedMs>0);
});
test('single baseline unknown usage locks admission and retains evidence',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 const run=await runSingleRepository({...config,repository:root,task:spec,outputDirectory:join(root,'run')},async o=>{calls++;const r=await response()(o);throw new CodexWorkerError('timeout','timeout',{...r.transcript,timedOut:true,usage:[]});});
 assert.equal(calls,1);assert.equal(run.success,false);assert.equal(run.completionMs,null);assert.equal(run.infrastructureFailure,true);assert.equal(run.budget.unknownUsageCalls,1);
});

test('named single response schema fixes file names while preserving exact write authority',async t=>{
 const root=await repository(files);t.after(()=>rm(root,{recursive:true,force:true}));
 const run=await runSingleRepository({...config,responseFormat:'named',repository:root,task:spec,outputDirectory:join(root,'run')},async o=>{
  assert.deepEqual((o.schema['properties'] as Record<string,{required:string[]}>)['files']!.required,['a.mjs','b.mjs']);
  const r=await response()(o);const raw=r.result as {files:{path:string;content:string}[];note:string};return {...r,result:{files:Object.fromEntries(raw.files.map(f=>[f.path,f.content])),note:raw.note}};
 });assert.equal(run.success,true);
 assert.throws(()=>parseSingleResponse({files:{'a.mjs':'a','b.mjs':'b','public.txt':'x'},note:''},['a.mjs','b.mjs'],'named'));
 assert.throws(()=>parseSingleResponse({files:{'a.mjs':'a'},note:''},['a.mjs','b.mjs'],'named'));
});
