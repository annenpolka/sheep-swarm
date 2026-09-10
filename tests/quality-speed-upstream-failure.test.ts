import assert from 'node:assert/strict';
import test from 'node:test';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {repository} from './repo-test-helpers.ts';
import {runRepository} from '../src/repo-run.ts';
// @ts-expect-error host-only fixture
import {buildQualitySpeedFixture} from '../scripts/quality-speed-fixture.mjs';
// @ts-expect-error independent reference candidates
import {referenceContents} from '../scripts/quality-speed-reference.mjs';

test('public downstream failure currently retries the consumer without reopening an accepted faulty provider',async t=>{
 const f=buildQualitySpeedFixture('propagation',1),reference=referenceContents('propagation');
 const root=await repository(f.files);t.after(()=>rm(root,{recursive:true,force:true}));
 const badAmount=reference['amount.mjs'].replace('const digits=parts[0]',"if(parts[1]===undefined)return Number(parts[0]);const digits=parts[0]");
 const seen:Record<string,number>={};
 const result=await runRepository({repository:root,task:f.task,outputDirectory:join(root,'run'),runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'disabled',workers:4,concurrency:2,maxCalls:12,maxMetaCalls:0,maxTokens:10000,reserveTokensPerCall:100},async o=>{
  const target=/Update only ([^\s]+\.mjs)/.exec(o.prompt)?.[1];assert.ok(target);seen[target]=(seen[target]??0)+1;
  const content=target==='amount.mjs'?badAmount:reference[target];assert.equal(typeof content,'string');
  return {requestedModel:o.model,result:{kind:'write',content,paths:[],observed:[],missing:[],hypothesis:'',note:''},usage:[{event:{},inputTokens:10,outputTokens:5}],transcript:{events:[],usage:[{event:{},inputTokens:10,outputTokens:5}],usageCompleteness:'complete',requestedModel:o.model,effectiveModelEvidence:'injected-test',stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1}};
 });
 assert.equal(result.success,false);assert.equal(seen['amount.mjs'],1);assert.equal(seen['cart.mjs'],1);assert.equal(seen['invoice.mjs'],5);
 assert.equal(result.budget.unknownUsageCalls,0);assert.equal(result.swarm.lowerCalls,7);
});
