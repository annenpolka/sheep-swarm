import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {auditRecoveryReceipts} from '../experiments/recovery-receipts.ts';
import type {SwarmReport} from '../src/swarm.ts';
test('length-limit error envelope is known usage; unknown usage and mismatched identities remain rejected',async t=>{
 const root=await mkdtemp(join(tmpdir(),'recovery-receipts-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'swarm'));
 const call={id:'call-1',model:'deepseek-flash',inputTokens:2,outputTokens:8} as SwarmReport['calls'][number];
 const transcript={runtime:'opencode-go',apiFormat:'chat-completions',requestedModel:'deepseek-flash',effectiveModelEvidence:'deepseek-flash',thinking:'enabled',httpStatus:200,usageCompleteness:'complete',rawUsage:{prompt_tokens:2,completion_tokens:8,total_tokens:10},timedOut:false,cancelled:false};
 const check=async(tr:Record<string,unknown>,expected=10)=>{await writeFile(join(root,'swarm/call-1.json'),JSON.stringify({error:'missing-output',transcript:tr}));return auditRecoveryReceipts(root,[call],expected);};
 assert.deepEqual(await check(transcript),{valid:true,tokens:10});
 for(const patch of [{thinking:'disabled'},{effectiveModelEvidence:'other'},{requestedModel:'other'},{timedOut:true},{httpStatus:429},{usageCompleteness:'partial-or-unknown'},{rawUsage:{}}])assert.equal((await check({...transcript,...patch})).valid,false);
 assert.equal((await check(transcript,11)).valid,false);
});
