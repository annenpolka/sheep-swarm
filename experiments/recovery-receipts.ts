import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {extractTokenUsage} from '../src/cost-estimate.ts';
import type {SwarmReport} from '../src/swarm.ts';
/** A cleanly terminated HTTP length-limit response still has a known usage receipt. */
export async function auditRecoveryReceipts(directory:string,calls:SwarmReport['calls'],expectedTokens:number) {
 let valid=calls.length>0,tokens=0;
 for(const c of calls){
  const receipt=JSON.parse(await readFile(join(directory,'swarm',`${c.id}.json`),'utf8'));
  const tr=receipt.transcript,usage=extractTokenUsage(receipt);
  if((receipt.requestedModel!==undefined&&receipt.requestedModel!=='deepseek-flash')||c.model!=='deepseek-flash'||tr?.requestedModel!=='deepseek-flash'||tr?.effectiveModelEvidence!=='deepseek-flash'||tr?.thinking!=='enabled'||tr?.usageCompleteness!=='complete'||tr?.httpStatus!==200||tr?.timedOut||tr?.cancelled||usage.inputTokens===null||usage.outputTokens===null||usage.partial||usage.inputTokens!==c.inputTokens||usage.outputTokens!==c.outputTokens)valid=false;
  tokens+=(usage.inputTokens??0)+(usage.outputTokens??0);
 }
 return {valid:valid&&tokens===expectedTokens,tokens};
}
