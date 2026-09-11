import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {qualityFixture} from './contract-quality-fixtures.ts';
import {summarizeTrials,type TrialMetric} from './quality-metrics.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {captureRepository} from '../src/repo-files.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
import {runRepository} from '../src/repo-run.ts';
import {callOpenCodeGo,type OpenCodeGoOptions} from '../src/opencode-go-worker.ts';
import {extractTokenUsage} from '../src/cost-estimate.ts';
const save=async(p:string,v:unknown)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
export async function publicProbeFixture(){
 const f=await qualityFixture('branching');
 f.files['amount-probe.mjs']=`import assert from 'node:assert/strict';\nimport {parseAmount} from './amount.mjs';\nimport {places} from './settings.mjs';\ntry{assert.equal(parseAmount('1'),10**places,'PUBLIC whole-unit conversion');}catch(error){if(!(error instanceof assert.AssertionError))throw error;console.log(JSON.stringify({probeId:'whole_amount',status:'counterexample'}));console.error(error);process.exitCode=1;}\n`;
 const task=parseRepoTask({...f.task,context:[...f.task.context,'amount-probe.mjs'],recovery:{maxUpstreamRechecks:2,review:'focused'}});
 return {...f,task};
}
export async function runPublicProbeBenchmark(directory:string){
 const root=resolve(directory);await mkdir(root);
 const paths=[...(await readdir('src')).filter(p=>p.endsWith('.ts')).map(p=>'src/'+p),...(await readdir('experiments')).filter(p=>p.endsWith('.ts')||p==='upstream-recovery-seed.json').map(p=>'experiments/'+p),'scripts/quality-speed-fixture.mjs','scripts/quality-speed-reference.mjs','scripts/public-probe-benchmark.ts','package.json','package-lock.json'];
 const runtimeHashes=Object.fromEntries(await Promise.all(paths.map(async p=>[p,hash(await readFile(p))])));
 for(const p of paths){const dest=join(root,'runtime',p);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,await readFile(p));}
 const cases=Array.from({length:3},(_,repeat)=>['baseline','observe','route'].map((_,i)=>({repeat,mode:['baseline','observe','route'][(i+repeat)%3]!}))).flat();
 const limits={maxCalls:32,maxRounds:64,maxTokens:1000000,reserveTokensPerCall:100000,maxTokensPerCall:64000,timeoutMs:600000};
 const profile={format:1,baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtime:'opencode-go',model:'deepseek-flash',thinking:'enabled',upperCalls:0,workers:4,concurrency:2,taskDeadlineMs:null,limits,seriesAdmissionTokens:9000000,cases,runtimeHashes};await save(join(root,'profile.json'),profile);
 const started=performance.now(),f=await publicProbeFixture(),repository=join(root,'fixture');await mkdir(repository);
 for(const [p,s] of Object.entries(f.files))await writeFile(join(repository,p),s);
 execFileSync('git',['init','-q'],{cwd:repository});execFileSync('git',['add','.'],{cwd:repository});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-qm','Freeze public probe comparison'],{cwd:repository});
 const snapshot=await captureRepository(repository,f.task),hashes=Object.fromEntries([...snapshot.entries].map(([p,e])=>[p,hash(e.bytes)]));
 const preflightRoot=join(root,'preflight'),checks=[...f.task.files.flatMap(t=>t.checks),...f.task.checks];
 const baseline=await runRepoChecks(snapshot,{},f.task.checks,preflightRoot),reference=await runRepoChecks(snapshot,f.reference,checks,preflightRoot),mutant=await runRepoChecks(snapshot,f.mutant,f.task.checks,preflightRoot);
 const probeCheck={argv:[process.execPath,'amount-probe.mjs'],timeoutMs:30000};
 const probeBad=await runRepoChecks(snapshot,{},[probeCheck],preflightRoot),probeGood=await runRepoChecks(snapshot,f.reference,[probeCheck],preflightRoot);
 await save(join(root,'fixture.json'),{task:f.task,hashes});await save(join(root,'preflight.json'),{baseline,reference,mutant,probeBad,probeGood});
 if(baseline.ok||!reference.ok||mutant.ok||probeBad.ok||!probeGood.ok||!probeBad.checks[0]?.stdout.includes('counterexample')||[baseline,reference,mutant,probeBad,probeGood].some(v=>v.executionFailure))throw new Error('preflight failed');
 const preparationElapsedMs=performance.now()-started;
 const rows:(TrialMetric&{repeat:number;outputDirectory:string;qualityPass:boolean;sourceUnchanged:boolean;receiptsValid:boolean;probeRequests:number;probeRechecks:number;automaticRechecks:number;participants:number;maxConcurrentModelCalls:number;verificationCommands:number})[]=[];
 let stopReason:string|null=null,observedTokens=0;
 const persist=()=>save(join(root,'series.json'),{format:1,plannedRuns:9,completedRuns:rows.length,observedTokens,stopReason,preparationElapsedMs,authoringLaborMs:null,summary:summarizeTrials(rows),results:rows});await persist();
 for(const [i,c] of cases.entries()){
  if(observedTokens+limits.maxTokens>profile.seriesAdmissionTokens){stopReason='series-token-admission';break;}
  for(const [p,h] of Object.entries(runtimeHashes))if(hash(await readFile(p))!==h)throw new Error('runtime drift '+p);
  const task=parseRepoTask({...f.task,recovery:{maxUpstreamRechecks:2,review:'focused',...(c.mode==='baseline'?{}:{publicProbes:{maxRequests:6,maxRechecks:c.mode==='route'?2:0,catalog:[{id:'whole_amount',provider:'amount.mjs',description:'Verify the public integer-string requirement: parseAmount("1") returns 10**places.',paths:['amount.mjs','settings.mjs','amount-probe.mjs'],check:probeCheck}]}})}});
  const outputDirectory=join(root,`run-${i+1}-${c.mode}`),start=performance.now();console.log(JSON.stringify({event:'run-start',index:i+1,...c}));
  try {
   const caller:typeof callOpenCodeGo=async<T>(o:OpenCodeGoOptions)=>{console.log(JSON.stringify({event:'call-start',index:i+1,callId:o.callId}));return callOpenCodeGo<T>(o);};
   const run=await runRepository({...limits,repository,task,outputDirectory,runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'enabled',workers:4,concurrency:2,maxMetaCalls:0},caller);
   const artifacts=JSON.parse(await readFile(join(outputDirectory,'artifacts.json'),'utf8'));
   const independent=await runRepoChecks(await captureRepository(repository,task),artifacts,checks,join(root,'independent'));await save(join(outputDirectory,'independent-check.json'),independent);
   let sourceUnchanged=execFileSync('git',['status','--porcelain'],{cwd:repository,encoding:'utf8'})==='';for(const [p,h] of Object.entries(hashes))if(hash(await readFile(join(repository,p)))!==h)sourceUnchanged=false;
   let receiptsValid=run.swarm.calls.length>0,tokens=0;
   for(const call of run.swarm.calls){const r=JSON.parse(await readFile(join(outputDirectory,'swarm',call.id+'.json'),'utf8')),tr=r.transcript,u=extractTokenUsage(r);if(tr.requestedModel!=='deepseek-flash'||tr.effectiveModelEvidence!=='deepseek-flash'||tr.thinking!=='enabled'||tr.usageCompleteness!=='complete'||tr.httpStatus!==200||tr.timedOut||tr.cancelled||u.inputTokens===null||u.outputTokens===null||u.partial)receiptsValid=false;tokens+=(u.inputTokens??0)+(u.outputTokens??0);}
   if(tokens!==run.budget.observedTokens)receiptsValid=false;
   const blocked=!sourceUnchanged||!receiptsValid||run.budget.unknownUsageCalls>0||run.budget.activeReservations>0||run.budget.reservationOverruns>0||[...run.verifications,independent].some(v=>v.executionFailure||v.checks.some(c=>c.timedOut||c.signal!==null));
   const ledger=JSON.parse(await readFile(join(outputDirectory,'swarm/public-probes.json'),'utf8'));
   const evidenceStop=blocked||ledger.records.some((r:{status:string})=>r.status==='probe-verification-unavailable');
   const success=run.success&&independent.ok&&!evidenceStop,elapsedMs=performance.now()-start;
   const row={group:c.mode,repeat:c.repeat,outputDirectory,success,qualityPass:independent.ok,completionMs:success?elapsedMs:null,elapsedMs,calls:run.swarm.calls.length,tokens:receiptsValid?tokens:null,sourceUnchanged,receiptsValid,probeRequests:ledger.requests,probeRechecks:ledger.rechecks,automaticRechecks:run.discovery?.upstreamRechecks??0,participants:run.swarm.individuals.filter(x=>x.assignments>0).length,maxConcurrentModelCalls:run.swarm.maxConcurrentModelCalls,verificationCommands:[...run.verifications,independent].reduce((n,v)=>n+v.checks.length,0)};
   rows.push(row);observedTokens+=run.budget.observedTokens;if(evidenceStop)stopReason='evidence-stop';await persist();console.log(JSON.stringify({event:'run-finished',index:i+1,...row}));if(stopReason)break;
  }catch(error){stopReason='orchestrator-error';await save(join(root,'error.json'),{error:String(error),index:i+1,usage:'inspect raw receipts, not assumed zero'});await persist();throw error;}
 }
 await persist();return {rows,stopReason};
}
