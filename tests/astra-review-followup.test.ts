import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {runDurableSwarm} from '../src/durable-run.ts';
import {CodexWorkerError} from '../src/codex-worker.ts';
import {runSwarm} from '../src/swarm.ts';
test('mixed durable run stops after Codex meta timeout with partial numeric usage',async()=>{
 const root=await mkdtemp(join(tmpdir(),'durable-review-test-'));const calls: string[]=[];
 await runDurableSwarm({directory:root+'/run',runtime:'deepseek',workerModel:'deepseek-flash',size:2,workers:1,maxCalls:6,maxMetaCalls:1},async opts=>{
 const p=JSON.parse(opts.prompt);calls.push(p.role);const transcript: any={requestedModel:opts.model,effectiveModelEvidence:opts.model,events:[],usage:[{event:{type:'usage',input_tokens:10,output_tokens:2},inputTokens:10,outputTokens:2,totalTokens:12}],stdout:'',stderr:'',exitCode:null,signal:null,timedOut:true,cancelled:false,durationMs:1};
 if(p.role==='meta')throw new CodexWorkerError('timeout','injected timeout',transcript);
 const usage=[{event:{},inputTokens:10,outputTokens:2,totalTokens:12}];return {result:{content:'invalid',note:'failure for intervention'},requestedModel:opts.model,usage,transcript:{...transcript,timedOut:false,runtime:'deepseek',usageCompleteness:'complete',usage}};
 });assert.equal(calls.length,calls.indexOf('meta')+1,JSON.stringify(calls));
});

test('mixed swarm stops after Codex meta timeout with partial numeric usage',async()=>{
 const root=await mkdtemp(join(tmpdir(),'swarm-review-test-'));const calls: string[]=[];
 await runSwarm({outputDirectory:root+'/run',runtime:'deepseek',workerModel:'deepseek-flash',size:2,workers:1,concurrency:1,maxCalls:8,maxMetaCalls:1,maxRounds:8},async opts=>{
 const role=opts.model==='deepseek-flash'?'worker':'meta';calls.push(role);const transcript: any={requestedModel:opts.model,effectiveModelEvidence:opts.model,events:[],usage:[{event:{type:'usage',input_tokens:10,output_tokens:2},inputTokens:10,outputTokens:2,totalTokens:12}],stdout:'',stderr:'',exitCode:null,signal:null,timedOut:true,cancelled:false,durationMs:1};
 if(role==='meta')throw new CodexWorkerError('timeout','injected timeout',transcript);
 const usage=[{event:{},inputTokens:10,outputTokens:2,totalTokens:12}];return {result:{content:'invalid',note:'failure for intervention'},requestedModel:opts.model,usage,transcript:{...transcript,timedOut:false,runtime:'deepseek',usageCompleteness:'complete',usage}};
 });assert.notEqual(calls.indexOf('meta'),-1);assert.equal(calls.length,calls.indexOf('meta')+1,JSON.stringify(calls));
});
test('mixed durable partial timeout remains locked after receipt persistence and resume',async()=>{
 const root=await mkdtemp(join(tmpdir(),'durable-partial-resume-'));const directory=root+'/run';
 await assert.rejects(runDurableSwarm({directory,runtime:'deepseek',workerModel:'deepseek-flash',size:2,workers:1,maxCalls:6,maxMetaCalls:1,
 checkpoint:async(name,details)=>{if(name==='after-call'&&details.role==='meta')throw new Error('pause after error receipt persisted');}},async opts=>{
 const role=JSON.parse(opts.prompt).role;const usage=[{event:{type:'usage',input_tokens:10,output_tokens:2},inputTokens:10,outputTokens:2,totalTokens:12}];
 const transcript:any={requestedModel:opts.model,effectiveModelEvidence:opts.model,events:[],usage,stdout:'',stderr:'',exitCode:null,signal:null,timedOut:true,cancelled:false,durationMs:1};
 if(role==='meta')throw new CodexWorkerError('timeout','injected timeout',transcript);
 return {result:{content:'invalid',note:'failure for intervention'},requestedModel:opts.model,usage,transcript:{...transcript,timedOut:false,runtime:'deepseek',usageCompleteness:'complete'}};
 }),/pause after error receipt persisted/);
 let calls=0;await runDurableSwarm({directory,resume:true},async()=>{calls++;throw new Error('must remain locked');});assert.equal(calls,0);
});

test('scale series must stop after an empty result object',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scale-review-test-'));await mkdir(root+'/source/src',{recursive:true});await mkdir(root+'/pilot');
 await writeFile(root+'/source/source-manifest.json','{}');await writeFile(root+'/pilot/source-manifest.json','{"workingTreeFiles":{}}');await writeFile(root+'/pilot/result.json',JSON.stringify({configuration:{workers:16,concurrency:16,size:32,fault:'none'}}));
 await writeFile(root+'/source/src/cli.ts',`import {mkdir,writeFile} from 'node:fs/promises';const out=process.argv[process.argv.indexOf('--output')+1];await mkdir(out);await writeFile(out+'/result.json',JSON.stringify({}));process.exitCode=0;`);
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/scale-experiment.mjs',import.meta.url)),'--source',root+'/source','--pilot',root+'/pilot','--output',root+'/series','--runtime','deepseek','--worker-model','deepseek-flash'],{encoding:'utf8'});
 assert.notEqual(child.status,0);const report=JSON.parse(await readFile(root+'/series/experiment.json','utf8'));assert.equal(report.runs.length,1,`spawn status ${child.status}, launched ${report.runs.length} children`);
});
