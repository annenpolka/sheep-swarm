// Explicit live probe. Authentication is supplied by the caller; no credential-store import.
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {callOpenCodeGoTurn} from '../src/opencode-go-worker.ts';
import {TokenBudget} from '../src/token-budget.ts';
const output=process.argv[2];if(!output)throw new Error('usage: node scripts/probe-go-conversation.mjs NEW_OUTPUT');
await mkdir(output,{recursive:false});
const save=(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n');
const marker=randomUUID(),answer=randomUUID(),sessionId=randomUUID();
const messages=[{role:'user',content:`Keep marker ${marker}. Call lookup_ticket with ticket "probe" exactly once. Then return JSON {"marker": the original marker, "answer": the value returned by the tool}. Do not invent the tool value. Return raw JSON only with no markdown fences.`}];
const tools=[{type:'function',function:{name:'lookup_ticket',description:'Fetch the ticket answer from the host.',parameters:{type:'object',properties:{ticket:{type:'string'}},required:['ticket'],additionalProperties:false}}}];
const budget=new TokenBudget({maxTokens:400000,reserveTokensPerCall:100000});
let success=false,error=null,first;
try{
 for(let i=1;i<=2;i++){
  const id=`call-${i}`;assert(budget.reserve('deepseek-flash',id));
  await save(`${id}.request.json`,{messages,tools,model:'deepseek-flash',thinking:'enabled',sessionId});
  let receipt;
  try{receipt=await callOpenCodeGoTurn({model:'deepseek-flash',thinking:'enabled',messages,tools,sessionId,timeoutMs:600000,maxTokens:64000,cwd:process.cwd(),callId:id,outputDirectory:output});}
  catch(e){receipt={requestedModel:'deepseek-flash',error:e.code??'unknown',transcript:e.transcript};await save(`${id}.json`,receipt);budget.settle(id,receipt);throw e;}
  await save(`${id}.json`,receipt);const settlement=budget.settle(id,receipt);assert.notEqual(settlement.tokens,null);assert(!settlement.overrun);assert(receipt.transcript.effectiveModelEvidence);
  const message=receipt.result;messages.push(message);
  if(i===1){first=message;assert.equal(message.tool_calls?.length,1);assert.equal(message.tool_calls[0].function.name,'lookup_ticket');assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments),{ticket:'probe'});messages.push({role:'tool',tool_call_id:message.tool_calls[0].id,content:JSON.stringify({answer})});}
  else{assert(!message.tool_calls?.length);assert.deepEqual(JSON.parse(message.content),{marker,answer});success=true;}
 }
}catch(e){error=String(e);process.exitCode=1;}
await save('summary.json',{success,error,model:'opencode-go/deepseek-flash',thinking:'enabled',budget:budget.snapshot(),assistantThinkingBytes:first?Buffer.byteLength(first.reasoning_content??''):null,assistantHash:first?createHash('sha256').update(JSON.stringify(first)).digest('hex'):null});
console.log(JSON.stringify({success,error,calls:budget.snapshot().settledCalls,tokens:budget.snapshot().observedTokens,unknown:budget.snapshot().unknownUsageCalls}));
