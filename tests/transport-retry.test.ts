import assert from 'node:assert/strict';
import test from 'node:test';
import {TokenBudget} from '../src/token-budget.ts';
import {retryAccounting,retryAction,retryObservation,transientReceipt,type RetryAttempt} from '../experiments/transport-retry.ts';
const limits={maxCalls:8,maxTokens:1000,reserveTokensPerCall:100};
function attempt(unknown:boolean,extra:Partial<RetryAttempt>={}):RetryAttempt {
 const b=new TokenBudget(limits);b.reserve('deepseek-flash','call-1');
 b.settle('call-1',unknown?{requestedModel:'deepseek-flash'}:{requestedModel:'deepseek-flash',transcript:{runtime:'opencode-go',apiFormat:'chat-completions',httpStatus:200,usageCompleteness:'complete',rawUsage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}});
 return {success:!unknown,transportRetryable:unknown,elapsedMs:40,retryWaitMs:0,budget:b.snapshot(),evidenceErrors:unknown?['missing usage']:[],...extra};
}
test('retry preserves unknown usage and charges its reservation without clearing the original lock',()=>{
 const failed=attempt(true),accepted=attempt(false,{retryWaitMs:2000});
 assert.equal(failed.budget.locked,true);assert.equal(retryAction([failed],limits),'run');
 assert.deepEqual(retryAccounting([failed,accepted]),{calls:2,knownTokens:30,totalTokens:null,unknownUsageCalls:1,chargedTokens:130,activeReservations:0,elapsedMs:2080});
 const row=retryObservation([failed,accepted]);assert.equal(row.success,true);assert.equal(row.tokens,null);assert.equal(row.retries,1);assert.deepEqual(row.evidenceErrors,[]);
 assert.equal(retryAction([failed,accepted],limits),'done');assert.equal(failed.budget.locked,true);
});
test('only transient transport errors retry; auth, cancellation, successful missing usage and kernel faults do not',()=>{
 const receipt=(httpStatus:number|null,error='nonzero-exit')=>({requestedModel:'deepseek-flash',error,transcript:{requestedModel:'deepseek-flash',httpStatus,cancelled:false}});
 for(const status of [null,408,429,500,502,503,504])assert.equal(transientReceipt(receipt(status)),true);
 for(const status of [200,400,401,403,404])assert.equal(transientReceipt(receipt(status)),false);
 assert.equal(transientReceipt({...receipt(500),transcript:{...receipt(500).transcript,cancelled:true}}),false);
 assert.equal(transientReceipt(receipt(500,'malformed-output')),false);
 assert.equal(retryAction([attempt(true,{transportRetryable:false,evidenceErrors:['kernel fault']})],limits),'stop');
 assert.equal(retryAction([attempt(false,{success:false})],limits),'done');
});
test('retry exhaustion advances as unavailable, while shared token/call caps and active reservations are enforced',()=>{
 const failed=attempt(true);
 assert.equal(retryAction([failed,failed,failed,failed],limits),'unavailable');
 assert.equal(retryAction([failed],{...limits,maxCalls:1}),'unavailable');
 assert.equal(retryAction([failed],{...limits,maxTokens:199}),'unavailable');
 const b=new TokenBudget(limits);b.reserve('deepseek-flash','active');
 assert.equal(retryAction([{...failed,budget:b.snapshot()}],limits),'stop');
});

test('real repository executor recovers from an HTTP 500 in a fresh attempt and preserves the failed receipt',async t=>{
 const {readFile,writeFile,rm}=await import('node:fs/promises');
 const {join}=await import('node:path');
 const {repository,manifest}=await import('./repo-test-helpers.ts');
 const {runPacketRepository}=await import('../src/repo-packet-run.ts');
 const {CodexWorkerError}=await import('../src/codex-worker.ts');
 // The executable controller is JavaScript; exercise its receipt classification too.
 // @ts-expect-error no declaration file for the benchmark controller
 const {inspectAttempt}=await import('../scripts/packet-sweep-retry.mjs');
 const root=await repository();t.after(()=>rm(root,{recursive:true,force:true}));
 const cap={maxCalls:4,maxTokens:10000,reserveTokensPerCall:1000};
 const attempts:RetryAttempt[]=[];let calls=0;
 while(retryAction(attempts,cap)==='run') {
  const spent=retryAccounting(attempts),directory=join(root,'attempt-'+(attempts.length+1));
  const run=await runPacketRepository({...cap,maxCalls:cap.maxCalls-spent.calls,maxTokens:cap.maxTokens-spent.chargedTokens,
   runtime:'opencode-go',workerModel:'deepseek-flash',maxTokensPerCall:500,timeoutMs:1000,concurrency:1,maxRounds:8,packetSize:'all',repository:root,task:manifest(),outputDirectory:directory},async o=>{
   calls++;assert.ok(!o.prompt.includes('assert.equal'));assert.match(o.prompt,/value = 0/);
   const transcript={events:[],usage:[],requestedModel:o.model,effectiveModelEvidence:null,stdout:'Internal server error',stderr:'',exitCode:1,signal:null,timedOut:false,cancelled:false,durationMs:1,httpStatus:500,thinking:'enabled'};
   if(calls===1)throw new CodexWorkerError('nonzero-exit','HTTP 500',transcript);
   return {requestedModel:o.model,result:{files:{'a.mjs':'export const value = 42;'},note:''},usage:[],transcript:{...transcript,
    runtime:'opencode-go',apiFormat:'chat-completions',httpStatus:200,stdout:'',exitCode:0,effectiveModelEvidence:o.model,usageCompleteness:'complete',rawUsage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}};
  });
  const row={success:run.success,elapsedMs:run.elapsedMs,retryWaitMs:attempts.length?2000:0,evidenceErrors:run.infrastructureFailure?['provider or verification infrastructure']:[]};
  await writeFile(join(directory,'row.json'),JSON.stringify(row));
  await writeFile(join(directory,'independent-check.json'),JSON.stringify(run.verifications.at(-1)??{ok:false,checks:[]}));
  attempts.push(await inspectAttempt(directory,row,run));
 }
 assert.equal(calls,2);assert.equal(attempts.length,2);assert.equal(attempts[0]!.budget.locked,true);
 const accepted=retryObservation(attempts);assert.equal(accepted.success,true);assert.equal(accepted.tokens,null);assert.equal(accepted.knownTokens,30);
 assert.equal(accepted.chargedTokens,1030);assert.equal(accepted.unknownUsageCalls,1);assert.ok(accepted.elapsedMs>=2000);
 assert.equal(JSON.parse(await readFile(join(root,'attempt-1','call-1.json'),'utf8')).transcript.httpStatus,500);
 assert.equal(await readFile(join(root,'a.mjs'),'utf8'),'export const value = 0;\n');
});
