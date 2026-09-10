import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {callDeepSeek} from '../src/deepseek-worker.ts';
import {runDurableSwarm} from '../src/durable-run.ts';
import {CodexWorkerError} from '../src/codex-worker.ts';
const base={model:'deepseek-flash',prompt:'test',cwd:tmpdir(),schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},apiKey:'FAKE_SECRET_123',timeoutMs:1000,maxTokens:128};
const body=(): any=>({model:'deepseek-flash',usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12},choices:[{finish_reason:'stop',message:{role:'assistant',content:'{"ok":true}'}}]});
test('DeepSeek legacy function_call must fail tool-less boundary',async()=>{const b=body();b.choices[0].message.function_call={name:'execute',arguments:'{}'};await assert.rejects(callDeepSeek({...base,fetch:async()=>new Response(JSON.stringify(b))}));});
test('DeepSeek reflected usage keys must not leak credential',async()=>{const b=body();b.usage.FAKE_SECRET_123='echo';const r=await callDeepSeek({...base,fetch:async()=>new Response(JSON.stringify(b))});assert.equal(JSON.stringify(r.transcript).includes(base.apiKey),false);});
test('DeepSeek 429 must not mark usage complete',async()=>{await assert.rejects(callDeepSeek({...base,fetch:async()=>new Response(JSON.stringify(body()),{status:429})}),(e: any)=>{assert.equal(e.transcript.usageCompleteness,'partial-or-unknown');return true;});});
test('mixed durable run stops after Codex meta timeout without usage',async()=>{
 const root=await mkdtemp(join(tmpdir(),'durable-review-test-'));const calls: string[]=[];
 await runDurableSwarm({directory:root+'/run',runtime:'deepseek',workerModel:'deepseek-flash',size:2,workers:1,maxCalls:6,maxMetaCalls:1},async opts=>{
 const p=JSON.parse(opts.prompt);calls.push(p.role);const transcript: any={requestedModel:opts.model,effectiveModelEvidence:opts.model,events:[],usage:[],stdout:'',stderr:'',exitCode:null,signal:null,timedOut:true,cancelled:false,durationMs:1};
 if(p.role==='meta')throw new CodexWorkerError('timeout','injected timeout',transcript);
 const usage=[{event:{},inputTokens:10,outputTokens:2,totalTokens:12}];return {result:{content:'invalid',note:'failure for intervention'},requestedModel:opts.model,usage,transcript:{...transcript,timedOut:false,runtime:'deepseek',usageCompleteness:'complete',usage}};
 });assert.equal(calls.length,calls.indexOf('meta')+1,JSON.stringify(calls));
});
test('scale series must stop after child unknown usage',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scale-review-test-'));await mkdir(root+'/source/src',{recursive:true});await mkdir(root+'/pilot');
 await writeFile(root+'/source/source-manifest.json','{}');await writeFile(root+'/pilot/source-manifest.json','{"workingTreeFiles":{}}');await writeFile(root+'/pilot/result.json',JSON.stringify({configuration:{workers:16,concurrency:16,size:32,fault:'none'}}));
 await writeFile(root+'/source/src/cli.ts',`import {mkdir,writeFile} from 'node:fs/promises';const out=process.argv[process.argv.indexOf('--output')+1];await mkdir(out);await writeFile(out+'/result.json',JSON.stringify({success:false,finalErrors:['unknown-usage'],calls:[{usageCompleteness:'partial-or-unknown'}],lowerCalls:1,upperCalls:0}));process.exitCode=1;`);
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/scale-experiment.mjs',import.meta.url)),'--source',root+'/source','--pilot',root+'/pilot','--output',root+'/series','--runtime','deepseek','--worker-model','deepseek-flash'],{encoding:'utf8'});
 assert.notEqual(child.status,0);const report=JSON.parse(await readFile(root+'/series/experiment.json','utf8'));assert.equal(report.runs.length,1,`spawn status ${child.status}, launched ${report.runs.length} children`);
});
import {runMechanism} from '../src/mechanism-run.ts';
import {capture} from '../src/docker-agent-worker.ts';
import {ISOLATED_FIXTURE_RUNNER} from '../src/docker-fixture-observer.ts';
test('mechanism Docker worker does not require Docker cleanup on Codex upper',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mixed-review-test-'));
 const observe: import('../src/fixture.ts').FixtureObserver=async(files,calls,timeoutMs,imports=[])=>{const child=await capture(process.execPath,['--permission','--experimental-vm-modules','--input-type=module','-e',ISOLATED_FIXTURE_RUNNER],{input:JSON.stringify({files,calls,timeoutMs,imports}),timeoutMs:5000});return JSON.parse(child.stdout);};
 const report=await runMechanism({outputDirectory:root+'/run',runtime:'docker-agent',metaRuntime:'codex',family:'static',groups:1,workers:1,concurrency:1,budgetMode:'tokens',maxTokens:10000,reserveTokensPerCall:100,maxCalls:6,maxMetaCalls:1},async opts=>{
 const input=JSON.parse(opts.prompt.split('PUBLIC_INPUT_JSON\n')[1]!);
 const event={type:'token_usage',usage:{last_message:{input_tokens:10,cached_input_tokens:0,cached_write_tokens:0,output_tokens:2,Model:`chatgpt/${opts.model}`}}};
 const usage=[{event:{},inputTokens:10,outputTokens:2,totalTokens:12}];
 const transcript: any={requestedModel:opts.model,effectiveModelEvidence:opts.model,usage,stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1,events:[]};
 if(input.role!=='meta')Object.assign(transcript,{runtime:'docker-agent',runtimeVersion:'v1.137.0',usageCompleteness:'complete',cleanupSucceeded:true,events:[{type:'stream_started',session_id:'fake'},event,{type:'stream_stopped',session_id:'fake',reason:'normal'}]});
 return {requestedModel:opts.model,usage,transcript,result:{writes:[{id:input.target,content:input.role==='meta'?'Clarified guidance.':'invalid'}],readRequests:[],note:'injected'}};
 },observe);
 assert.equal(report.upperCalls,1);assert.equal(report.finalErrors.includes('sandbox-cleanup-unverified'),false,JSON.stringify(report.finalErrors));
});
import {runSwarm} from '../src/swarm.ts';
test('mixed swarm stops after Codex meta timeout without usage',async()=>{
 const root=await mkdtemp(join(tmpdir(),'swarm-review-test-'));const calls: string[]=[];
 await runSwarm({outputDirectory:root+'/run',runtime:'deepseek',workerModel:'deepseek-flash',size:2,workers:1,concurrency:1,maxCalls:8,maxMetaCalls:1,maxRounds:8},async opts=>{
 const role=opts.model==='deepseek-flash'?'worker':'meta';calls.push(role);const transcript: any={requestedModel:opts.model,effectiveModelEvidence:opts.model,events:[],usage:[],stdout:'',stderr:'',exitCode:null,signal:null,timedOut:true,cancelled:false,durationMs:1};
 if(role==='meta')throw new CodexWorkerError('timeout','injected timeout',transcript);
 const usage=[{event:{},inputTokens:10,outputTokens:2,totalTokens:12}];return {result:{content:'invalid',note:'failure for intervention'},requestedModel:opts.model,usage,transcript:{...transcript,timedOut:false,runtime:'deepseek',usageCompleteness:'complete',usage}};
 });assert.notEqual(calls.indexOf('meta'),-1);assert.equal(calls.length,calls.indexOf('meta')+1,JSON.stringify(calls));
});
