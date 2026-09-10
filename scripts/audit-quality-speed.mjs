import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const hash=s=>createHash('sha256').update(s).digest('hex');
export async function auditQualitySpeed(directory) {
 const root=resolve(directory),json=async p=>JSON.parse(await readFile(join(root,p),'utf8'));
 const series=await json('series.json'),profile=await json('profile.json');
 assert.equal(series.completedRuns,series.plannedRuns);assert.equal(series.stopReason,null);
 const evidence={};
 const record=async p=>{evidence[p]=hash(await readFile(join(root,p)));};
 await record('series.json');await record('profile.json');
 let tokens=0,receiptCount=0;
 for(const row of series.results) {
  assert.ok(Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0);
  assert.equal(row.completionMs,row.success?row.elapsedMs:null);
  assert.equal(row.sourceUnchanged,true);assert.equal(row.identityVerified,true);
  const name=`${row.fixture}-${row.method}`,run=await json(`${name}/result.json`),budget=run.budget;
  for(const key of ['unknownUsageCalls','activeReservations','reservationOverruns'])assert.equal(budget[key],0);
  assert.equal(budget.locked,false);
  const independent=await json(`${name}-independent.json`);assert.equal(independent.sourceUnchanged,true);
  assert.equal(independent.verification.ok,row.qualityPass);
  assert.equal(row.success,run.success&&independent.verification.ok);
  const artifacts=await json(`${name}/artifacts.json`);
  for(const [p,s] of Object.entries(artifacts))assert.equal(hash(s),independent.artifactHashes[p]);
  const calls=row.method==='single'?run.calls:run.swarm.calls;
  assert.equal(calls.length,row.calls);let runTokens=0;
  for(const call of calls) {
   const p=`${name}/${row.method==='single'?'':'swarm/'}${call.id}.json`,r=await json(p),t=r.transcript;
   assert.equal(r.requestedModel,'deepseek-flash');assert.equal(t.effectiveModelEvidence,'deepseek-flash');assert.equal(t.usageCompleteness,'complete');assert.equal(t.timedOut,false);assert.equal(t.cancelled,false);
   const usage=r.usage??t.usage;assert.equal(usage.length,1);
   const u=usage[0];for(const n of [u.inputTokens,u.outputTokens])assert.ok(Number.isSafeInteger(n)&&n>=0);
   runTokens+=u.inputTokens+u.outputTokens;receiptCount++;await record(p);
   if(row.method==='single'){
    const request=await json(`${name}/${call.id}.request.json`);
    assert.ok(!request.prompt.includes("console.log('holdout passed')"));
    await record(`${name}/${call.id}.request.json`);
   }
  }
  assert.equal(runTokens,row.observedTokens);assert.equal(runTokens,budget.observedTokens);tokens+=runTokens;
  for(const p of [`${name}/result.json`,`${name}/artifacts.json`,`${name}/budget.json`,`${name}-independent.json`,`${row.fixture}-fixture.json`,`${row.fixture}-preflight.json`])await record(p);
  const f=await json(`${row.fixture}-fixture.json`);
  for(const [p,h] of Object.entries(f.hashes))assert.equal(hash(await readFile(join(root,row.fixture,p))),h);
 }
 assert.equal(tokens,series.currentSeriesObservedTokens??series.observedTokens);
 const out={format:1,valid:true,seriesDirectory:relative(process.cwd(),root),profileHash:evidence['profile.json'],runs:series.completedRuns,receiptCount,observedTokens:tokens,sourceUnchanged:true,knownUsage:true,completionNullOnFailure:true,evidence};
 await writeFile(join(root,'audit.json'),JSON.stringify(out,null,2)+'\n');return out;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){if(process.argv.length!==3)throw new Error('Usage: node scripts/audit-quality-speed.mjs SERIES_DIRECTORY');const a=await auditQualitySpeed(process.argv[2]);console.log(JSON.stringify({...a,evidence:undefined}));}
