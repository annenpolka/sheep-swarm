import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {extractTokenUsage} from '../src/cost-estimate.ts';
import {transientReceipt} from '../experiments/transport-retry.ts';
import {parseGoAssistant,validateGoConversation} from '../src/opencode-go-conversation.ts';
import {prepareRepositoryPackets} from '../src/repo-packet-run.ts';
import {packetReceiptAudit} from './packet-sweep.mjs';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
export async function auditLazyAttempt(directory,method,run,options,independent){
 const errors=[];let transient=0,inputTokens=0,outputTokens=0;const hashes={};
 assert.equal(run.budget.activeReservations,0);assert.equal(run.lowerCalls,run.budget.calls.length);
 const prepared=await prepareRepositoryPackets({...options,packetSize:'all'}),publicPaths=new Set(prepared.plan.publicPaths);
 const kernel=await load(join(directory,'kernel.json'));
 for(const call of run.budget.calls){
  const receipt=await load(join(directory,call.callId+'.json')),request=await load(join(directory,call.callId+'.request.json')),t=receipt.transcript,u=extractTokenUsage(receipt);
  assert.equal(call.status,'settled');assert.equal(call.knownTokensLower,(u.inputTokens??0)+(u.outputTokens??0));
  inputTokens+=u.inputTokens??0;outputTokens+=u.outputTokens??0;
  if(call.tokens!==null){assert.equal(call.tokens,(u.inputTokens??0)+(u.outputTokens??0));assert.equal(u.partial,false);}
  if(transientReceipt(receipt))transient++;
  else if(call.tokens===null||receipt.requestedModel!=='deepseek-flash'||t?.requestedModel!=='deepseek-flash'||t?.effectiveModelEvidence!=='deepseek-flash'||t?.thinking!=='enabled'||t?.httpStatus!==200||t?.timedOut||t?.cancelled||t?.usageCompleteness!=='complete'||(receipt.error&&receipt.error!=='malformed-output'))errors.push(call.callId+': invalid model/usage/terminal evidence');
  if(method==='packet-all')continue;
  validateGoConversation(request);assert.equal(request.model,'deepseek-flash');assert.equal(request.thinking,'enabled');
  const row=run.calls.find(c=>c.id===call.callId);assert(row);assert.equal(request.sessionId.endsWith('-'+row.agent),true);
  assert.equal(request.tools.length,row.agent==='root'&&method==='lazy'?2:0);
  if(receipt.result){const body=JSON.parse(t.stdout);assert.equal(body.model,t.effectiveModelEvidence);assert.deepEqual(parseGoAssistant(body.choices[0].message,body.choices[0].finish_reason,request.tools),receipt.result);}
  for(const message of request.messages){
   if(message.role!=='user'&&message.role!=='tool')continue;
   let data;try{data=JSON.parse(message.content);}catch{continue;}
   if(data.originalPublicBaseline)assert.deepEqual(data.originalPublicBaseline,prepared.initial);
   if(data.currentFiles){
    assert(Object.keys(data.currentFiles).every(p=>publicPaths.has(p)));assert.deepEqual(Object.keys(data.currentFiles).sort(),Object.keys(data.readStamps).sort());
    assert(kernel.contexts.some(c=>c.agent===row.agent&&JSON.stringify(c.contents)===JSON.stringify(data.currentFiles)&&JSON.stringify(c.reads)===JSON.stringify(data.readStamps)),'delivered current content lacks a kernel checkout');
   }
  }
 }
 assert.equal(inputTokens+outputTokens,run.budget.observedTokens);
 assert.deepEqual(await load(join(directory,'artifacts.json')),Object.fromEntries(options.task.files.map(f=>[f.path,kernel.artifacts[f.path].content])));
 for(const verification of [...run.verifications,independent])if(verification.executionFailure||verification.checks.some(c=>c.timedOut||c.signal!==null))errors.push('verification infrastructure');
 if(run.budget.reservationOverruns)errors.push('reservation overrun');
 if(!run.sourceUnchanged)errors.push('source drift');
 const retryable=transient>0&&!errors.length&&['unknown-usage','transport-failure'].includes(run.termination);
 if(['runner-infrastructure','evidence-failure','invalid-conversation','verification-infrastructure','model-or-usage-evidence'].includes(run.termination))errors.push('non-transient infrastructure');
 if(method==='packet-all'&&!transient&&!errors.length)await packetReceiptAudit(directory,run,options.task,prepared.plan);
 if(run.success){assert(independent.ok);assert.equal(run.budget.unknownUsageCalls,0);assert(run.completionMs>0);}
 else assert.equal(run.completionMs,null);
 return {transportRetryable:retryable,evidenceErrors:[...new Set([...errors,...(transient?['transient transport failure']:[])])],inputTokens,outputTokens,hashes};
}
