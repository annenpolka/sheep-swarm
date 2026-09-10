import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {auditReadSelection} from '../src/read-selection-audit.ts';
import {captureRepository} from '../src/repo-files.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {createHostRepoVerifier,assertVerificationReceipt} from '../src/repo-verifier.ts';
const {values}=parseArgs({options:{run:{type:'string'},fixture:{type:'string'},output:{type:'string'}}});
if(!values.run||!values.fixture||!values.output)throw new Error('Required --run RUN_DIRECTORY --fixture HOST_FIXTURE.json --output NEW_DIRECTORY');
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const run=resolve(values.run),output=resolve(values.output),fixture=await load(values.fixture);
const report=await load(join(run,'result.json')),ledger=await load(join(run,'read-deliveries.json'));
const state=await load(join(run,'swarm/kernel-state.json'));
const calls=report.swarm.calls;
const audit=auditReadSelection({expectations:fixture.expectations,calls,requests:ledger.requests,deliveries:ledger.deliveries});
const hash=s=>createHash('sha256').update(s).digest('hex');
// Link deliveries to the exact checkout in the kernel, independently of model claims.
for(const d of ledger.deliveries){
 const c=calls.find(c=>c.id===d.callId),context=state.contexts.find(x=>x.id===c?.context);
 if(!context||context.contents[d.path]===undefined||hash(context.contents[d.path])!==d.sha256||Buffer.byteLength(context.contents[d.path])!==d.bytes||JSON.stringify(context.reads[d.path])!==JSON.stringify(d.stamp))throw new Error('delivery does not match saved checkout');
}
const task=parseRepoTask(await load(join(run,'task.json')));
// The replay command is fixed here, not selected by the saved run report.
if(JSON.stringify(task.files.map(f=>f.path))!==JSON.stringify(fixture.targets))throw new Error('target scope mismatch');
const fixedChecks=[{argv:[process.execPath,'check.mjs'],timeoutMs:10000}];
const snapshot=await captureRepository(report.repository,task);
if(hash(await readFile(join(snapshot.root,'check.mjs')))!==fixture.oracleSha256)throw new Error('fixed oracle changed');
for(const [p,h] of Object.entries(fixture.filesSha256))if(hash(await readFile(join(snapshot.root,p)))!==h)throw new Error('source fixture changed');
const sourceStatus=execFileSync('git',['-C',snapshot.root,'status','--porcelain'],{encoding:'utf8'});if(sourceStatus)throw new Error('source is not clean');
const budget=report.budget;
const known=budget.unknownUsageCalls===0&&budget.activeReservations===0&&budget.reservationOverruns===0&&!budget.locked&&!budget.exceeded&&!budget.admissionDenied;
if(!known)throw new Error('usage incomplete or exceeded; no successful experiment classification');
await mkdir(output);
const overlay=await load(join(run,'artifacts.json'));const verifier=createHostRepoVerifier();
const request={snapshot,overlay,commands:fixedChecks,phase:'final',outputRoot:join(output,'checks')};
const receipt=await verifier.verify(request);assertVerificationReceipt(request,receipt,verifier.environmentId);
const summary={format:1,run,qualityPass:report.success&&receipt.ok,audit,verification:receipt,sourceUnchanged:true,
 N:report.swarm.registeredWorkers,C:report.swarm.configuration.concurrency,maxActiveWorkers:report.swarm.maxActiveWorkers,participatingWorkers:new Set(calls.filter(c=>c.role==='worker').map(c=>c.agent)).size,
 lowerCalls:report.swarm.lowerCalls,upperCalls:report.swarm.upperCalls,tokens:budget.observedTokens,usageComplete:known,context:report.discovery,
 retries:calls.filter(c=>c.role==='worker'&&!['committed','deferred'].includes(c.outcome)).length,
 durationMs:report.swarm.durationMs,requestedModel:report.swarm.configuration.workerModel,effectiveEvidence:[...new Set(calls.map(c=>c.effectiveModelEvidence))],
 evidenceSha256:Object.fromEntries(await Promise.all(['result.json','artifacts.json','task.json','read-deliveries.json','swarm/kernel-state.json'].map(async p=>[p,hash(await readFile(join(run,p)))]))),fixtureSha256:hash(await readFile(values.fixture)),cost:null};
await writeFile(join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));if(!summary.qualityPass||!audit.valid)process.exitCode=1;
