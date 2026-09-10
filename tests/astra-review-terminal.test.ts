import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {runSwarm} from '../src/swarm.ts';
import {runDurableSwarm} from '../src/durable-run.ts';
import {callCodex,CodexWorkerError} from '../src/codex-worker.ts';
for(const runner of ['swarm','durable'] as const)test(`${runner} stops on actual Codex adapter malformed terminal with partial counters`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'astra-malformed-terminal-'));await mkdir(root+'/bin');
 // Local executable emits a valid interim usage event then truncated terminal JSONL; no network/model.
 await writeFile(root+'/bin/codex',`#!${process.execPath}\nprocess.stdout.write(JSON.stringify({type:'usage',input_tokens:10,output_tokens:2,total_tokens:12})+'\\n{"type":"turn.comp');`,{mode:0o755});
 const savedPath=process.env.PATH;process.env.PATH=root+'/bin:'+savedPath;
 const roles:string[]=[];const errors:string[]=[];
 const caller=async(opts:any)=>{const role=opts.model==='deepseek-flash'?'worker':'meta';roles.push(role);
 if(role==='meta'){try{return await callCodex<{content:string;note:string}>(opts);}catch(e){assert.ok(e instanceof CodexWorkerError);errors.push(e.code);assert.equal(e.transcript.timedOut,false);assert.equal(e.transcript.usage.length,1);throw e;}}
 const usage=[{event:{},inputTokens:10,outputTokens:2,totalTokens:12}];const transcript:any={requestedModel:opts.model,effectiveModelEvidence:opts.model,events:[],usage,stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1,runtime:'deepseek',usageCompleteness:'complete'};
 return {result:{content:'invalid',note:'failure for intervention'},requestedModel:opts.model,usage,transcript};};
 try{
 if(runner==='swarm')await runSwarm({outputDirectory:root+'/run',runtime:'deepseek',workerModel:'deepseek-flash',size:2,workers:1,concurrency:1,maxCalls:8,maxMetaCalls:1,maxRounds:8},caller);
 else await runDurableSwarm({directory:root+'/run',runtime:'deepseek',workerModel:'deepseek-flash',size:2,workers:1,maxCalls:6,maxMetaCalls:1},caller);
 }finally{process.env.PATH=savedPath;}
 assert.deepEqual(errors,['malformed-events']);assert.equal(roles.length,roles.indexOf('meta')+1,JSON.stringify(roles));
});
