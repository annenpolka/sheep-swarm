import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {captureRepository} from '../src/repo-files.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
import {TokenBudget} from '../src/token-budget.ts';
import {unknownUsageForRun} from '../src/model-runtime.ts';
import {callOpenCodeGo,type OpenCodeGoOptions} from '../src/opencode-go-worker.ts';
import {CodexWorkerError,type CodexCallResult} from '../src/codex-worker.ts';
import type {RepoVerification} from '../src/repo-types.ts';
import {parseRepositoryPatch} from './repository-patch.ts';

export type SingleCaller=(options:OpenCodeGoOptions)=>Promise<CodexCallResult<unknown>>;
export interface SingleOptions {repository:string;task:unknown;outputDirectory:string;maxCalls:number;maxTokens:number;reserveTokensPerCall:number;maxTokensPerCall:number;timeoutMs:number;responseFormat?:'array'|'named'}
const save=async(path:string,value:unknown)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
const arraySchema={type:'object',additionalProperties:false,required:['files','note'],properties:{files:{type:'array',items:{type:'object',additionalProperties:false,required:['path','content'],properties:{path:{type:'string'},content:{type:'string'}}}},note:{type:'string'}}};

export function parseSingleResponse(value:unknown,targets:readonly string[],format:'array'|'named') {
 if(format==='array')return parseRepositoryPatch(value,targets);
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('expected response object');
 const raw=value as Record<string,unknown>,files=raw['files'];
 if(!files||typeof files!=='object'||Array.isArray(files))throw new Error('expected files keyed by declared target');
 return parseRepositoryPatch({...raw,files:Object.entries(files).map(([path,content])=>({path,content}))},targets);
}

/** Experimental tool-less single-model baseline: each proposal may replace every target. */
export async function runSingleRepository(options:SingleOptions,caller:SingleCaller=callOpenCodeGo) {
 const started=performance.now();
 for(const [key,n] of Object.entries(options))if(['maxCalls','maxTokens','reserveTokensPerCall','maxTokensPerCall','timeoutMs'].includes(key)&&(!Number.isSafeInteger(n)||Number(n)<1))throw new Error(`invalid ${key}`);
 const task=parseRepoTask(options.task),snapshot=await captureRepository(options.repository,task);
 const output=resolve(options.outputDirectory);
 for(const p of snapshot.entries.keys()){
  const absolute=join(snapshot.root,p);
  if(output===absolute||output.startsWith(absolute+sep)||absolute.startsWith(output+sep))throw new Error('output overlaps repository files');
 }
 await mkdir(dirname(output),{recursive:true});await mkdir(output);
 const budget=new TokenBudget({maxTokens:options.maxTokens,reserveTokensPerCall:options.reserveTokensPerCall});
 const targets=task.files.map(f=>f.path);
 const responseFormat=options.responseFormat??'named';
 const schema=responseFormat==='array'?arraySchema:{type:'object',additionalProperties:false,required:['files','note'],properties:{files:{type:'object',additionalProperties:false,required:targets,properties:Object.fromEntries(targets.map(p=>[p,{type:'string'}]))},note:{type:'string'}}};
 const publicPaths=[...new Set([...targets,...task.context,...(task.discovery?.readable??[])])];
 const initial=Object.fromEntries(publicPaths.map(p=>[p,snapshot.initialTargets[p]??snapshot.entries.get(p)!.bytes.toString('utf8')]));
 let artifacts:Record<string,string>={...snapshot.initialTargets},diagnostic='',termination='call-limit',qualityPass=false,infrastructureFailure=false;
 const calls:{id:string;outcome:string;durationMs:number;promptBytes:number;errors:string[];effectiveModelEvidence:string|null}[]=[];
 const verifications:RepoVerification[]=[];
 const sessionId=`single-${randomUUID()}`;
 await save(join(output,'task.json'),task);await save(join(output,'profile.json'),{...options,task:undefined,runtime:'opencode-go',model:'deepseek-flash',thinking:'enabled',responseFormat,taskDeadlineMs:null});
 await save(join(output,'budget.json'),budget.snapshot());
 for(let attempt=0;attempt<options.maxCalls;attempt++) {
  const id=`call-${attempt+1}`;
  if(!budget.reserve('deepseek-flash',id)){termination='token-budget';break;}
  await save(join(output,'budget.json'),budget.snapshot());
  const prompt=[`Repository goal: ${task.goal}`,`You are the single implementation agent. You may repair any or all declared targets together. No tools or upper consultation. ${responseFormat==='array'?'Return files with exactly one {path,content} per target':'Return files as an object mapping exactly the declared target paths to complete source strings'}, preserving unchanged files as needed, plus note. Fixed public checks are repair feedback; the hidden acceptance oracle is not available.`,`Target instructions: ${JSON.stringify(task.files.map(f=>({path:f.path,instructions:f.instructions})))}`,`Public files: ${JSON.stringify({...initial,...artifacts})}`,`Previous public-check or transport feedback: ${diagnostic}`].join('\n');
  await save(join(output,`${id}.request.json`),{prompt,schema});
  let receipt:CodexCallResult<unknown>|undefined,failure:unknown;
  const callStarted=performance.now();
  try{receipt=await caller({model:'deepseek-flash',prompt,schema,cwd:snapshot.root,timeoutMs:options.timeoutMs,maxTokens:options.maxTokensPerCall,thinking:'enabled',sessionId,callId:id,outputDirectory:output});}catch(error){failure=error;}
  const err=failure instanceof CodexWorkerError?failure:undefined;
  const metered=receipt??{requestedModel:'deepseek-flash',error:err?.code??'unknown',transcript:err?.transcript};
  const settlement=budget.settle(id,metered);
  const transcript=receipt?.transcript??err?.transcript;
  const unknown=unknownUsageForRun(transcript,'opencode-go',true,err?.code);
  await save(join(output,`${id}.json`),metered);await save(join(output,'budget.json'),budget.snapshot());
  const call={id,outcome:'rejected',durationMs:performance.now()-callStarted,promptBytes:Buffer.byteLength(prompt),errors:[] as string[],effectiveModelEvidence:transcript?.effectiveModelEvidence??null};calls.push(call);
  if(unknown||settlement.tokens===null||settlement.overrun){termination=settlement.overrun?'reservation-overrun':'unknown-usage';call.outcome=termination;infrastructureFailure=true;break;}
  if(failure!==undefined){diagnostic=String(failure).slice(0,8192);call.errors.push(diagnostic);call.outcome='malformed-output';continue;}
  try{artifacts=parseSingleResponse(receipt!.result,targets,responseFormat);}catch(error){diagnostic=String(error);call.errors.push(diagnostic);continue;}
  await save(join(output,'artifacts.json'),artifacts);
  const commands=task.files.flatMap(f=>f.checks);
  const verification=await runRepoChecks(snapshot,artifacts,commands,join(output,'checks'));verifications.push(verification);
  if(verification.executionFailure){termination='verification-infrastructure';infrastructureFailure=true;break;}
  if(!verification.ok){
   diagnostic=JSON.stringify({errors:verification.errors,checks:verification.checks.filter(c=>c.exitCode!==0||c.timedOut||c.signal).map(c=>({argv:c.argv,stdout:c.stdout,stderr:c.stderr}))}).slice(0,8192);
   call.errors.push(diagnostic);continue;
  }
  call.outcome='public-checks-passed';
  // Exactly one final hidden assessment. Its diagnostics are never fed to another call.
  const final=await runRepoChecks(snapshot,artifacts,task.checks,join(output,'checks'));verifications.push(final);
  qualityPass=final.ok;infrastructureFailure=final.executionFailure===true;
  termination=qualityPass?'accepted':infrastructureFailure?'verification-infrastructure':'holdout-failed';break;
 }
 await save(join(output,'artifacts.json'),artifacts);
 const elapsedMs=performance.now()-started;
 const report={format:1,method:'single',qualityPass,success:qualityPass&&!infrastructureFailure,termination,infrastructureFailure,elapsedMs,completionMs:qualityPass&&!infrastructureFailure?elapsedMs:null,calls,verifications,budget:budget.snapshot()};
 await save(join(output,'result.json'),report);return report;
}
