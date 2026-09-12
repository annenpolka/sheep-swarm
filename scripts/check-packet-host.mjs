// Offline diagnosis only: reference code is injected by a host stub. No API call.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {buildSyntheticTask} from '../experiments/synthetic-corpus/index.ts';
import {runPacketRepository} from '../src/repo-packet-run.ts';
const [seriesPath,outputPath]=process.argv.slice(2);
if(!seriesPath||!outputPath)throw new Error('Usage: node scripts/check-packet-host.mjs FROZEN_SERIES NEW_OUTPUT');
const series=resolve(seriesPath),output=resolve(outputPath),id='syn-stats-v11';
const profile=JSON.parse(await readFile(join(series,'profile.json'),'utf8'));
const oldPath=join(series,'runtime/src/repo-packet-run.ts');
assert.equal(createHash('sha256').update(await readFile(oldPath)).digest('hex'),profile.runtimeHashes['src/repo-packet-run.ts']);
const old=await import(pathToFileURL(oldPath).href),f=buildSyntheticTask(id);
assert.deepEqual(f.hashes,profile.cases.find(c=>c.id===id).hashes);
await mkdir(output);
const results=[];
for(const [label,run] of [['frozen',old.runPacketRepository],['corrected',runPacketRepository]]) {
 const result=await run({repository:join(series,'fixtures',id),task:f.task,outputDirectory:join(output,label),runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'enabled',packetSize:4,concurrency:4,maxCalls:9,maxRounds:16},async o=>{
  const paths=o.schema.properties.files.required,usage=[{event:{offlineStub:true},inputTokens:0,outputTokens:0}];
  return {result:{files:Object.fromEntries(paths.map(p=>[p,f.reference[p]??f.files[p]])),note:'OFFLINE HOST REFERENCE STUB'},requestedModel:o.model,usage,
   transcript:{events:[],usage,usageCompleteness:'complete',requestedModel:o.model,effectiveModelEvidence:o.model,stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:0}};
 });
 results.push({label,offlineStub:true,success:result.success,termination:result.termination,stubCalls:result.lowerCalls,errors:result.calls.flatMap(c=>c.errors),sourceUnchanged:result.sourceUnchanged});
}
assert.equal(results[0].success,false);assert.ok(results[0].errors.includes('unobserved-obligation'));
assert.equal(results[1].success,true);assert.equal(results[1].stubCalls,8);
const report={caseId:id,packetSize:4,diagnostic:'Offline reference stub; no real model or token usage; excluded from benchmark quality and speed',results};
await writeFile(join(output,'diagnosis.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
