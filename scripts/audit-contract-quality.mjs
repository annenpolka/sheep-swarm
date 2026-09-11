import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {extractTokenUsage} from '../src/cost-estimate.ts';
import {summarizeTrials} from '../experiments/quality-metrics.ts';
const root=resolve(process.argv[2]??'');if(process.argv.length!==3)throw new Error('usage: node scripts/audit-contract-quality.mjs SERIES');
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const profile=await load(join(root,'profile.json')),series=await load(join(root,'series.json'));
assert.equal(series.stopReason,null);assert.equal(series.completedRuns,38);assert.equal(series.results.length,profile.cases.length);
assert.equal(profile.thinking,'enabled');assert.equal(profile.taskDeadlineMs,null);
const currentRuntimeDifferences=[];
for(const [p,h] of Object.entries(profile.runtimeHashes)){
 assert.equal(hash(await readFile(join(root,'runtime',p))),h);
 if(hash(await readFile(p))!==h)currentRuntimeDifferences.push(p);
}
let calls=0,tokens=0,lengthLimitedCalls=0,maxOutputTokens=0;const details=[];
for(const [index,row] of series.results.entries()){
 const expected=profile.cases[index];for(const key of ['group','fixture','repeat','method','phase'])assert.equal(row[key],expected[key]);
 const run=await load(join(row.outputDirectory,'result.json')),budget=await load(join(row.outputDirectory,'budget.json'));
 const receiptRoot=row.method==='single'?row.outputDirectory:join(row.outputDirectory,'swarm');
 const records=row.method==='single'?run.calls:run.swarm.calls;
 assert.equal(records.length,row.calls);assert.equal(budget.unknownUsageCalls,0);assert.equal(budget.reservationOverruns,0);assert.equal(budget.activeReservations,0);
 let runTokens=0,inputTokens=0,outputTokens=0,reasoningTokens=0,reasoningUnknown=false;
 for(const c of records){
  const raw=await load(join(receiptRoot,c.id+'.json')),tr=raw.transcript,usage=extractTokenUsage(raw);
  assert.equal(tr.requestedModel,'deepseek-flash');assert.equal(tr.effectiveModelEvidence,'deepseek-flash');assert.equal(tr.thinking,'enabled');assert.equal(tr.usageCompleteness,'complete');assert.equal(tr.httpStatus,200);assert.equal(tr.timedOut,false);assert.equal(tr.cancelled,false);
  assert.notEqual(usage.inputTokens,null);assert.notEqual(usage.outputTokens,null);assert.equal(usage.partial,false);
  inputTokens+=usage.inputTokens;outputTokens+=usage.outputTokens;
  const reasoning=tr.rawUsage?.completion_tokens_details?.reasoning_tokens;
  if(Number.isSafeInteger(reasoning)&&reasoning>=0)reasoningTokens+=reasoning;else reasoningUnknown=true;
  runTokens+=usage.inputTokens+usage.outputTokens;maxOutputTokens=Math.max(maxOutputTokens,usage.outputTokens);
  const response=JSON.parse(tr.stdout);if(response.choices[0].finish_reason==='length')lengthLimitedCalls++;
 }
 assert.equal(runTokens,row.tokens);assert.equal(runTokens,budget.observedTokens);tokens+=runTokens;calls+=records.length;
 const events=records.flatMap(c=>c.startedAt===undefined?[]:[{time:c.startedAt,delta:1},{time:c.startedAt+c.durationMs,delta:-1}]).sort((a,b)=>a.time-b.time||a.delta-b.delta);
 let active=0,observedMax=0;for(const event of events){active+=event.delta;observedMax=Math.max(active,observedMax);}
 const modelDurationSumMs=records.reduce((sum,c)=>sum+c.durationMs,0),envelope=events.length?events.at(-1).time-events[0].time:null;
 details.push({index:index+1,group:row.group,fixture:row.fixture,repeat:row.repeat,inputTokens,outputTokens,reasoningTokens:reasoningUnknown?null:reasoningTokens,modelDurationSumMs,modelEnvelopeMs:envelope,averageRequestConcurrency:envelope?modelDurationSumMs/envelope:null,observedMaxConcurrency:observedMax||1,commitWaitMs:records.reduce((sum,c)=>sum+(c.commitWaitMs??0),0),outcomes:Object.fromEntries([...new Set(records.map(c=>c.outcome))].map(outcome=>[outcome,records.filter(c=>c.outcome===outcome).length]))});
 const independent=await load(join(row.outputDirectory,'independent-check.json'));
 assert.equal(independent.ok,row.qualityPass);assert.equal(row.success,run.success&&independent.ok);assert.equal(row.completionMs,row.success?row.elapsedMs:null);
 assert.equal(row.receiptsValid,true);assert.equal(row.sourceUnchanged,true);
 const fixture=await load(join(root,row.fixture+'-fixture.json')),artifacts=await load(join(row.outputDirectory,'artifacts.json'));
 for(const [p,h] of Object.entries(fixture.hashes)){
  assert.equal(hash(await readFile(join(root,row.fixture,p))),h);
  assert.equal(hash(await readFile(join(independent.workspace,p))),Object.hasOwn(artifacts,p)?hash(artifacts[p]):h);
 }
 if(row.phase==='speed')assert.equal(row.initiallyActivatedTargets,expected.activation==='all'?16:4);
}
assert.equal(tokens,series.observedTokens);assert.deepEqual(summarizeTrials(series.results),series.summary);
const paired=(a,b)=>{
 const pairs=[];
 for(const x of series.results.filter(r=>r.group===a)){
  const y=series.results.find(r=>r.group===b&&r.fixture===x.fixture&&r.repeat===x.repeat);assert.ok(y);
  pairs.push({fixture:x.fixture,repeat:x.repeat,leftSuccess:x.success,rightSuccess:y.success,leftMs:x.completionMs,rightMs:y.completionMs,ratio:x.success&&y.success?x.completionMs/y.completionMs:null});
 }
 return {left:a,right:b,matchedSuccesses:pairs.filter(p=>p.ratio!==null).length,leftFaster:pairs.filter(p=>p.ratio!==null&&p.ratio<1).length,rightFaster:pairs.filter(p=>p.ratio!==null&&p.ratio>1).length,pairs};
};
const audit={valid:true,runs:38,calls,tokens,lengthLimitedCalls,maxOutputTokens,currentRuntimeDifferences,details,comparisons:[paired('quality/contract','quality/focused'),paired('baseline/sheep','baseline/single'),paired('speed/C4/all','speed/C1/all'),paired('speed/C4/impacted','speed/C1/impacted'),paired('speed/C1/impacted','speed/C1/all'),paired('speed/C4/impacted','speed/C4/all')]};
await writeFile(join(root,'audit.json'),JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify(audit,null,2));
