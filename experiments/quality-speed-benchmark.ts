import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {runRepository} from '../src/repo-run.ts';
import {captureRepository} from '../src/repo-files.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
import {runSingleRepository} from './repository-single.ts';
// @ts-expect-error host-only JS fixture builder
import {prepareQualitySpeedFixture} from '../scripts/quality-speed-fixture.mjs';
// @ts-expect-error host-only independent reference
import {referenceContents} from '../scripts/quality-speed-reference.mjs';
const save=async(p:string,v:unknown)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
const hash=(s:Uint8Array|string)=>createHash('sha256').update(s).digest('hex');
const limits={maxCalls:12,maxTokens:120000,reserveTokensPerCall:20000,maxTokensPerCall:8000,timeoutMs:120000};

export async function runQualitySpeedBenchmark(directory:string,priorSeriesPath?:string) {
 const root=resolve(directory);await mkdir(root,{recursive:false});
 const prior=priorSeriesPath===undefined?undefined:JSON.parse(await readFile(priorSeriesPath,'utf8')) as {observedTokens:number;stopReason:string|null;completedRuns:number;plannedRuns:number};
 if(prior&&(!Number.isSafeInteger(prior.observedTokens)||prior.observedTokens<0||prior.stopReason!==null||prior.completedRuns!==prior.plannedRuns))throw new Error('prior series must be completed with known usage');
 const priorObservedTokens=prior?.observedTokens??0;
 const runtimePaths=[...(await readdir('src')).filter(p=>p.endsWith('.ts')).map(p=>`src/${p}`),'experiments/repository-patch.ts','experiments/repository-single.ts','experiments/quality-speed-benchmark.ts','scripts/quality-speed-fixture.mjs','scripts/quality-speed-reference.mjs','scripts/quality-speed-benchmark.ts','package.json','package-lock.json'];
 const runtimeHashes=Object.fromEntries(await Promise.all(runtimePaths.map(async p=>[p,hash(await readFile(p))])));
 const assertRuntime=async()=>{for(const [p,h] of Object.entries(runtimeHashes))if(hash(await readFile(p))!==h)throw new Error(`runtime drift: ${p}`);};
 const profile={format:1,runtime:'opencode-go',model:'deepseek-flash',thinking:'disabled',upperCalls:0,limits,taskDeadlineMs:null,scoring:'quality and elapsed duration, no fixed-time score',single:{workers:1,concurrency:1,atomicMultiFile:true,responseFormat:'named'},sheep:{workers:4,concurrency:2,activation:'all',readPolicy:'existing static+reads'},priorObservedTokens,priorSeriesPath:priorSeriesPath??null,priorSeriesHash:priorSeriesPath?hash(await readFile(priorSeriesPath)):null,totalTokenAdmissionCap:1440000,fixtures:['independent-0','independent-1','independent-2','propagation-0','propagation-1','propagation-2'],order:'alternate single-first and sheep-first per fixture',baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtimeHashes};
 await save(join(root,'profile.json'),profile);
 const prepared=[];const prepStarted=performance.now();
 for(const family of ['independent','propagation'])for(const variant of [0,1,2]) {
  const name=`${family}-${variant}`,repository=join(root,name);const f=await prepareQualitySpeedFixture(repository,family,variant);
  const task=parseRepoTask(f.task),snapshot=await captureRepository(repository,task);
  const reference=referenceContents(family) as Record<string,string>;
  const out=join(root,`${name}-preflight`);
  const baseline=await runRepoChecks(snapshot,{},task.checks,out);
  const accepted=await runRepoChecks(snapshot,reference,[...task.files.flatMap(f=>f.checks),...task.checks],out);
  const wrong={...reference,'amount.mjs':reference['amount.mjs']!.replace('const digits=parts[0]',"if(value.startsWith('00'))return null;const digits=parts[0]")};
  const rejected=await runRepoChecks(snapshot,wrong,task.checks,out);
  await save(join(root,`${name}-preflight.json`),{baseline,accepted,rejected});
  if(baseline.ok||!accepted.ok||rejected.ok||[baseline,accepted,rejected].some(v=>v.executionFailure))throw new Error(`preflight failed: ${name}`);
  const hashes=Object.fromEntries([...snapshot.entries].map(([p,e])=>[p,hash(e.bytes)]));
  await save(join(root,`${name}-fixture.json`),{task,hashes});
  prepared.push({name,repository,task,hashes});
 }
 const preparationElapsedMs=performance.now()-prepStarted;
 const results:Record<string,unknown>[]=[];let observedTokens=priorObservedTokens;let stopReason:string|null=null;
 const persist=()=>save(join(root,'series.json'),{format:1,profile:'profile.json',preparationElapsedMs,preparationDefinition:'fixture generation, git snapshots and preflight oracle checks; excludes authoring/review labor',authoringLaborMs:null,priorObservedTokens,currentSeriesObservedTokens:observedTokens-priorObservedTokens,observedTokens,stopReason,completedRuns:results.length,plannedRuns:12,results});
 await persist();
 outer:for(const [index,fixture] of prepared.entries())for(const method of index%2?['sheep','single']:['single','sheep']) {
  if(observedTokens+limits.maxTokens>profile.totalTokenAdmissionCap){stopReason='series-token-admission';break outer;}
  await assertRuntime();
  const outputDirectory=join(root,`${fixture.name}-${method}`),startedAt=new Date().toISOString(),started=performance.now();
  try {
   const snapshot=await captureRepository(fixture.repository,fixture.task);
   const run=method==='single'?await runSingleRepository({...limits,repository:fixture.repository,task:fixture.task,outputDirectory}):await runRepository({...limits,repository:fixture.repository,task:fixture.task,outputDirectory,runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'disabled',workers:4,concurrency:2,maxMetaCalls:0,maxRounds:24});
   const artifacts=JSON.parse(await readFile(join(outputDirectory,'artifacts.json'),'utf8')) as Record<string,string>;
   const independent=await runRepoChecks(snapshot,artifacts,[...fixture.task.files.flatMap(f=>f.checks),...fixture.task.checks],join(root,`${fixture.name}-${method}-independent`));
   const sourceStatus=execFileSync('git',['status','--porcelain'],{cwd:fixture.repository,encoding:'utf8'});
   let sourceUnchanged=sourceStatus==='';
   for(const [p,h] of Object.entries(fixture.hashes))if(hash(await readFile(join(fixture.repository,p)))!==h)sourceUnchanged=false;
   const checks=[...run.verifications,independent].flatMap(v=>v.checks);
   const budget=run.budget;
   const calls='swarm' in run?run.swarm.calls:run.calls;
   const apiTranscriptFailure='infrastructureFailure' in run&&run.infrastructureFailure;
   const blocked=apiTranscriptFailure||budget.unknownUsageCalls>0||budget.activeReservations>0||budget.reservationOverruns>0||run.verifications.some(v=>v.executionFailure)||independent.executionFailure||checks.some(c=>c.timedOut||c.signal!==null)||!sourceUnchanged;
   const identityVerified=calls.length>0&&calls.every(c=>c.effectiveModelEvidence==='deepseek-flash');
   const qualityPass=independent.ok;
   const success=run.success&&qualityPass&&!blocked&&identityVerified;
   const elapsedMs=performance.now()-started;
   await save(join(root,`${fixture.name}-${method}-independent.json`),{verification:independent,sourceUnchanged,sourceStatus,artifactHashes:Object.fromEntries(Object.entries(artifacts).map(([p,s])=>[p,hash(s)]))});
   const row={fixture:fixture.name,method,startedAt,success,qualityPass,elapsedMs,completionMs:success?elapsedMs:null,termination:success?'accepted':blocked?'infrastructure-or-evidence-stop':'termination' in run?run.termination:'sheep-not-accepted',calls:calls.length,upperCalls:'swarm' in run?run.swarm.upperCalls:0,registeredWorkers:'swarm' in run?run.swarm.registeredWorkers:1,maxConcurrentModelCalls:'swarm' in run?run.swarm.maxConcurrentModelCalls:1,participants:'swarm' in run?run.swarm.individuals.filter(i=>i.assignments>0).length:1,modelCallDurationSumMs:calls.reduce((n,c)=>n+c.durationMs,0),verificationCommandCount:checks.length,verificationCommandDurationSumMs:checks.reduce((n,c)=>n+c.durationMs,0),nonAcceptedProposals:calls.filter(c=>!['committed','public-checks-passed'].includes(c.outcome)).length,firstProposalAccepted:calls.length>0&&calls.every(c=>['committed','public-checks-passed'].includes(c.outcome))&&success,observedTokens:budget.observedTokens,unknownUsageCalls:budget.unknownUsageCalls,reservationOverruns:budget.reservationOverruns,identityVerified,sourceUnchanged,outputDirectory};
   results.push(row);observedTokens+=budget.observedTokens;
   if(blocked||!identityVerified)stopReason='infrastructure-or-evidence-stop';
   await persist();console.log(JSON.stringify(row));
   if(stopReason)break outer;
  } catch(error) {
   stopReason='orchestrator-error';results.push({fixture:fixture.name,method,startedAt,success:false,qualityPass:null,completionMs:null,elapsedMs:performance.now()-started,error:String(error),usageStatus:'inspect raw receipts; not assumed zero'});await persist();throw error;
  }
 }
 await persist();return {results,stopReason};
}
