import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {extractTokenUsage} from '../src/cost-estimate.ts';
import {summarizeTrials} from '../experiments/quality-metrics.ts';
if(process.argv.length!==3)throw Error('usage: node scripts/audit-public-probes.mjs SERIES');
const root=resolve(process.argv[2]),load=async p=>JSON.parse(await readFile(p,'utf8')),hash=s=>createHash('sha256').update(s).digest('hex');
const series=await load(join(root,'series.json')),profile=await load(join(root,'profile.json')),fixture=await load(join(root,'fixture.json'));
assert.equal(series.completedRuns,series.results.length);assert.ok(series.completedRuns<=9);assert.equal(profile.taskDeadlineMs,null);assert.equal(profile.thinking,'enabled');
if(!series.stopReason)assert.equal(series.completedRuns,9);
const currentRuntimeDifferences=[];
for(const [p,h] of Object.entries(profile.runtimeHashes)){assert.equal(hash(await readFile(join(root,'runtime',p))),h);if(hash(await readFile(p))!==h)currentRuntimeDifferences.push(p);}
let tokens=0,calls=0,requests=0,rechecks=0,maxOutputTokens=0,lengthLimitedCalls=0;const details=[],evidenceHashes={};
const retain=async p=>{evidenceHashes[relative(process.cwd(),p)]=hash(await readFile(p));};
for(const name of ['series.json','profile.json','fixture.json','preflight.json'])await retain(join(root,name));
for(const [i,row] of series.results.entries()){
 assert.equal(row.group,profile.cases[i].mode);assert.equal(row.repeat,profile.cases[i].repeat);
 const out=row.outputDirectory,run=await load(join(out,'result.json')),budget=await load(join(out,'budget.json')),artifacts=await load(join(out,'artifacts.json')),independent=await load(join(out,'independent-check.json')),ledger=await load(join(out,'swarm/public-probes.json')),state=await load(join(out,'swarm/kernel-state.json')),task=await load(join(out,'task.json'));
 for(const name of ['result.json','budget.json','artifacts.json','independent-check.json','task.json','swarm/public-probes.json','swarm/kernel-state.json'])await retain(join(out,name));
 assert.equal(budget.unknownUsageCalls,0);assert.equal(budget.activeReservations,0);assert.equal(budget.reservationOverruns,0);
 assert.equal(run.swarm.upperCalls,0);assert.equal(run.swarm.registeredWorkers,4);assert.ok(run.swarm.maxConcurrentModelCalls<=2);assert.equal(run.swarm.maxConcurrentModelCalls,row.maxConcurrentModelCalls);
 assert.equal(row.sourceUnchanged,true);assert.equal(row.receiptsValid,true);assert.equal(row.success,run.success&&independent.ok);assert.equal(row.completionMs,row.success?row.elapsedMs:null);
 let used=0,input=0,output=0;
 for(const call of run.swarm.calls){
  const path=join(out,'swarm',call.id+'.json'),r=await load(path),tr=r.transcript,u=extractTokenUsage(r);await retain(path);
  assert.equal(tr.requestedModel,'deepseek-flash');assert.equal(tr.effectiveModelEvidence,'deepseek-flash');assert.equal(tr.thinking,'enabled');assert.equal(tr.usageCompleteness,'complete');assert.equal(tr.httpStatus,200);assert.equal(tr.timedOut,false);assert.equal(tr.cancelled,false);assert.equal(u.partial,false);assert.notEqual(u.inputTokens,null);assert.notEqual(u.outputTokens,null);
  if(JSON.parse(tr.stdout).choices?.[0]?.finish_reason==='length')lengthLimitedCalls++;
  used+=u.inputTokens+u.outputTokens;input+=u.inputTokens;output+=u.outputTokens;maxOutputTokens=Math.max(maxOutputTokens,u.outputTokens);
  const context=state.contexts.find(c=>c.id===call.context);assert.ok(context);
  for(const p of Object.keys(context.contents))assert.ok(!p.includes('holdout'));
 }
 assert.equal(used,row.tokens);assert.equal(used,budget.observedTokens);assert.equal(row.calls,run.swarm.calls.length);tokens+=used;calls+=row.calls;
 for(const [p,h] of Object.entries(fixture.hashes)){
  assert.equal(hash(await readFile(join(root,'fixture',p))),h);
  assert.equal(hash(await readFile(join(independent.workspace,p))),Object.hasOwn(artifacts,p)?hash(artifacts[p]):h);
 }
 assert.equal(ledger.requests,row.probeRequests);assert.equal(ledger.rechecks,row.probeRechecks);requests+=ledger.requests;rechecks+=ledger.rechecks;
 const seen=new Set();let verified=0;
 for(const record of ledger.records){
  const context=state.contexts.find(c=>c.id===record.context);assert.ok(context);assert.deepEqual(record.reads,context.reads);
  if(!record.verification)continue;
  const probe=task.recovery.publicProbes.catalog.find(p=>p.id===record.probeId);assert.ok(probe);assert.ok(!seen.has(record.key));seen.add(record.key);
  const v=record.verification;assert.equal(v.executionFailure,undefined);assert.equal(v.checks.length,1);assert.deepEqual(v.checks[0].argv,probe.check.argv);
  for(const p of probe.paths){assert.equal(record.inputHashes[p],hash(context.contents[p]));assert.equal(hash(await readFile(join(v.workspace,p))),record.inputHashes[p]);}
  for(const p of Object.keys(fixture.hashes).filter(p=>!probe.paths.includes(p)))await assert.rejects(readFile(join(v.workspace,p)));
  // Verification receipts/expected bytes establish the host check, not a model note.
  if(record.status==='upstream-recheck'||record.status==='verified-recheck-limit'){
   assert.equal(v.ok,false);assert.equal(v.checks[0].exitCode,1);assert.equal(v.checks[0].signal,null);assert.equal(v.checks[0].timedOut,false);
   assert.deepEqual(JSON.parse(v.checks[0].stdout),{probeId:record.probeId,status:'counterexample'});verified++;
  }
  if(record.status==='upstream-recheck'){
   const candidate=state.candidates.find(c=>c.proposal.id==='probe-'+record.callId);assert.equal(candidate?.state,'committed');
   const evidence=JSON.parse(Object.values(candidate.proposal.writes)[0]);assert.equal(evidence.source,'verified-public-probe');assert.equal(evidence.provider,probe.provider);assert.deepEqual(evidence.inputHashes,record.inputHashes);assert.equal(typeof record.validation,'string');
  }
 }
 assert.equal(seen.size,ledger.requests);assert.equal(ledger.records.filter(r=>r.status==='upstream-recheck').length,ledger.rechecks);
 details.push({outcomes:run.swarm.calls.map(c=>({target:c.target,outcome:c.outcome})),index:i+1,group:row.group,repeat:row.repeat,inputTokens:input,outputTokens:output,verifiedCounterexamples:verified,statuses:ledger.records.map(r=>r.status)});
}
assert.equal(tokens,series.observedTokens);assert.deepEqual(series.summary,summarizeTrials(series.results));
const audit={valid:true,complete:series.completedRuns===9&&!series.stopReason,runs:series.completedRuns,calls,tokens,probeRequests:requests,probeRechecks:rechecks,maxOutputTokens,lengthLimitedCalls,currentRuntimeDifferences,details,evidenceHashes};
await writeFile(join(root,'audit.json'),JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify(audit,null,2));
