import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildSyntheticTask} from '../experiments/synthetic-corpus/index.ts';
import {CodexWorkerError} from '../src/codex-worker.ts';
import {type PacketCaller} from '../src/repo-packet-run.ts';
import {retryAction,retryObservation} from '../experiments/transport-retry.ts';
const {executeAttempt,LIMITS}=await import('../scripts/'+'semantic-decomposition-pilot.mjs');
const {materializeSyntheticTask}=await import('../scripts/'+'synthetic-corpus.ts');
function receipt(result:unknown){return {requestedModel:'deepseek-flash',result,usage:[],transcript:{events:[],usage:[],requestedModel:'deepseek-flash',effectiveModelEvidence:'deepseek-flash',stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1,runtime:'opencode-go',apiFormat:'chat-completions',thinking:'enabled',httpStatus:200,usageCompleteness:'complete',rawUsage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}};}
test('pilot independently audits all three methods and retries planner transport without hiding unknown usage',async t=>{
 const root=await mkdtemp(join(tmpdir(),'sheep-semantic-pilot-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const f=buildSyntheticTask('syn-units-v00'),repo=await materializeSyntheticTask(f,join(root,'fixtures',f.metadata.id));
 for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-qm','fixture']])execFileSync('git',args,{cwd:repo});
 const paths=f.task.files.map(f=>f.path),profile={cases:[{...f.metadata,hashes:f.hashes}]};
 const caller:PacketCaller=async o=>receipt(o.callId==='planner-1'?{packets:[{id:'all',writablePaths:paths,relevantPaths:[...f.task.context],objective:'Repair units',invariants:['Preserve conversion contracts'],dependsOn:[]}],untouchedPaths:[],rationale:'One coherent repair'}:{files:f.reference,note:'Reference fixture for runner validation'});
 for(const method of ['single','fixed-all','planned']){
  const a=await executeAttempt(root,profile,{id:f.metadata.id,method},join(root,method),LIMITS,0,caller);assert.deepEqual(a.evidenceErrors,[]);assert.equal(a.success,true);assert.equal(a.tokens,method==='planned'?60:30);
 }
 const fault:PacketCaller=async()=>{const tr=receipt({}).transcript;throw new CodexWorkerError('nonzero-exit','HTTP 500',{...tr,rawUsage:undefined,effectiveModelEvidence:null,httpStatus:500} as unknown as typeof tr);};
 const failed=await executeAttempt(root,profile,{id:f.metadata.id,method:'planned'},join(root,'transport'),LIMITS,0,fault);
 assert.equal(failed.transportRetryable,true,JSON.stringify(failed.evidenceErrors));assert.equal(failed.tokens,null);assert.equal(retryAction([failed],LIMITS),'run');
 const recovered=await executeAttempt(root,profile,{id:f.metadata.id,method:'planned'},join(root,'retry'),{...LIMITS,maxCalls:127,maxTokens:LIMITS.maxTokens-LIMITS.reserveTokensPerCall},2000,caller);
 assert.equal(recovered.success,true);const observation=retryObservation([failed,recovered]);assert.equal(observation.tokens,null);assert.equal(observation.calls,3);assert.equal(observation.knownTokens,60);assert.equal(observation.success,true);
});
