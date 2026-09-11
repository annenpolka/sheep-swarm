import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {auditRecoveryReceipts} from './recovery-receipts.ts';
import {runRepository} from '../src/repo-run.ts';
import {captureRepository} from '../src/repo-files.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
// @ts-expect-error host-only fixture
import {buildQualitySpeedFixture} from '../scripts/quality-speed-fixture.mjs';
// @ts-expect-error host-only independent reference
import {referenceContents} from '../scripts/quality-speed-reference.mjs';
const save=async(p:string,v:unknown)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
const hash=(s:Uint8Array|string)=>createHash('sha256').update(s).digest('hex');
const limits={maxCalls:12,maxTokens:1000000,reserveTokensPerCall:100000,maxTokensPerCall:64000,timeoutMs:600000};

/** Four frozen runs: a retained failure snapshot and a fresh propagation task, off/on. */
export async function runUpstreamRecoveryBenchmark(directory:string) {
 const root=resolve(directory);await mkdir(root);
 const runtimePaths=[...(await readdir('src')).filter(p=>p.endsWith('.ts')).map(p=>`src/${p}`),'experiments/upstream-recovery-benchmark.ts','experiments/recovery-receipts.ts','experiments/upstream-recovery-seed.json','scripts/quality-speed-fixture.mjs','scripts/quality-speed-reference.mjs','package.json','package-lock.json'];
 const runtimeHashes=Object.fromEntries(await Promise.all(runtimePaths.map(async p=>[p,hash(await readFile(p))])));
 const profile={format:1,runtime:'opencode-go',model:'deepseek-flash',thinking:'enabled',workers:4,concurrency:2,upperCalls:0,limits,taskDeadlineMs:null,seriesTokenAdmissionCap:4000000,plannedRuns:4,
  seedSource:'named-series/propagation-1-sheep/artifacts.json',seedMeaning:'retained accepted provider bytes and rejected consumer stub; initial activation invoice only',freshMeaning:'original propagation-1 baseline with all targets active',runtimeHashes};
 await save(join(root,'profile.json'),profile);
 const fixtures=[];
 for(const name of ['seeded','fresh']){
  const f=buildQualitySpeedFixture('propagation',1),repository=join(root,name);await mkdir(repository);
  const files:Record<string,string>={...f.files};
  if(name==='seeded')Object.assign(files,JSON.parse(await readFile('experiments/upstream-recovery-seed.json','utf8')));
  for(const [p,s] of Object.entries(files))await writeFile(join(repository,p),s);
  execFileSync('git',['init','-q'],{cwd:repository});execFileSync('git',['add','.'],{cwd:repository});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-qm','Freeze recovery fixture'],{cwd:repository});
  const task=parseRepoTask({...f.task,...(name==='seeded'?{activation:{changedPaths:['invoice.mjs']}}:{})});
  const snapshot=await captureRepository(repository,task),reference=referenceContents('propagation');
  const commands=[...task.files.flatMap(f=>f.checks),...task.checks],out=join(root,`${name}-preflight`);
  const baseline=await runRepoChecks(snapshot,{},commands,out),accepted=await runRepoChecks(snapshot,reference,commands,out);
  await save(join(root,`${name}-preflight.json`),{baseline,accepted});
  if(baseline.ok||!accepted.ok||baseline.executionFailure||accepted.executionFailure)throw new Error('preflight failed');
  const hashes=Object.fromEntries([...snapshot.entries].map(([p,e])=>[p,hash(e.bytes)]));
  await save(join(root,`${name}-fixture.json`),{task,hashes});fixtures.push({name,repository,task,hashes});
 }
 let observedTokens=0,stopReason:string|null=null;const results:Record<string,unknown>[]=[];
 const persist=()=>save(join(root,'series.json'),{format:1,plannedRuns:profile.plannedRuns,completedRuns:results.length,observedTokens,stopReason,results});await persist();
 outer:for(const f of fixtures)for(const enabled of f.name==='seeded'?[false,true]:[true,false]){
  if(observedTokens+limits.maxTokens>profile.seriesTokenAdmissionCap){stopReason='series-token-admission';break outer;}
  for(const [p,h] of Object.entries(runtimeHashes))if(hash(await readFile(p))!==h)throw new Error('runtime drift: '+p);
  const outputDirectory=join(root,`${f.name}-${enabled?'on':'off'}`),task=parseRepoTask({...f.task,...(enabled?{recovery:{maxUpstreamRechecks:2}}:{})});
  const started=performance.now();
  try{
   const snapshot=await captureRepository(f.repository,task);
   const run=await runRepository({...limits,repository:f.repository,task,outputDirectory,runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'enabled',workers:4,concurrency:2,maxMetaCalls:0,maxRounds:24});
   const artifacts=JSON.parse(await readFile(join(outputDirectory,'artifacts.json'),'utf8')) as Record<string,string>;
   const independent=await runRepoChecks(snapshot,artifacts,[...task.files.flatMap(f=>f.checks),...task.checks],join(root,`${f.name}-${enabled?'on':'off'}-audit`));
   await save(join(outputDirectory,'independent-check.json'),independent);
   let sourceUnchanged=execFileSync('git',['status','--porcelain'],{cwd:f.repository,encoding:'utf8'})==='';
   for(const [p,h] of Object.entries(f.hashes))if(hash(await readFile(join(f.repository,p)))!==h)sourceUnchanged=false;
   const {valid:receiptsValid}=await auditRecoveryReceipts(outputDirectory,run.swarm.calls,run.budget.observedTokens);
   const checks=[...run.verifications,independent].flatMap(v=>v.checks);
   const blocked=!sourceUnchanged||!receiptsValid||run.budget.unknownUsageCalls>0||run.budget.reservationOverruns>0||run.budget.activeReservations>0||[...run.verifications,independent].some(v=>v.executionFailure)||checks.some(c=>c.timedOut||c.signal!==null);
   const success=run.success&&independent.ok&&!blocked,elapsedMs=performance.now()-started;
   const row={fixture:f.name,recovery:enabled,success,qualityPass:independent.ok,elapsedMs,completionMs:success?elapsedMs:null,termination:success?'accepted':blocked?'evidence-stop':'not-accepted',calls:run.swarm.lowerCalls,upperCalls:run.swarm.upperCalls,registeredWorkers:run.swarm.registeredWorkers,maxConcurrentModelCalls:run.swarm.maxConcurrentModelCalls,participants:run.swarm.individuals.filter(i=>i.assignments>0).length,observedTokens:run.budget.observedTokens,receiptsValid,sourceUnchanged,upstreamRechecks:run.discovery?.upstreamRechecks??0,verificationCommandCount:checks.length,outputDirectory};
   observedTokens+=run.budget.observedTokens;results.push(row);if(blocked)stopReason='evidence-stop';await persist();console.log(JSON.stringify(row));if(blocked)break outer;
  }catch(error){stopReason='orchestrator-error';results.push({fixture:f.name,recovery:enabled,success:false,completionMs:null,elapsedMs:performance.now()-started,error:String(error),usage:'unknown; inspect receipts'});await persist();throw error;}
 }
 await persist();return {results,stopReason};
}
