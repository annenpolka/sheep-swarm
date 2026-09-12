import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {qualityFixture,freshFixture,parallelFixture,type TrialFixture} from './contract-quality-fixtures.ts';
import {summarizeTrials,type TrialMetric} from './quality-metrics.ts';
import {runSingleRepository} from './repository-single.ts';
import {runRepository} from '../src/repo-run.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {captureRepository} from '../src/repo-files.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
import {callOpenCodeGo,type OpenCodeGoOptions} from '../src/opencode-go-worker.ts';
import {extractTokenUsage} from '../src/cost-estimate.ts';
const save=async(p:string,v:unknown)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
const hash=(s:Uint8Array|string)=>createHash('sha256').update(s).digest('hex');
const limits={maxCalls:48,maxTokens:1000000,reserveTokensPerCall:100000,maxTokensPerCall:64000,timeoutMs:600000};
interface Case {phase:'quality'|'baseline'|'speed';fixture:string;repeat:number;method:'single'|'sheep';review:'focused'|'contract'|'selected'|'none';workers:number;concurrency:number;activation:'fixture'|'all'|'impacted';group:string}
export function trialCases():Case[]{
 const cases:Case[]=[];
 for(let repeat=0;repeat<3;repeat++)for(const [i,fixture] of ['multiple','healthy','branching'].entries())for(const review of (repeat+i)%2?['contract','focused'] as const:['focused','contract'] as const)cases.push({phase:'quality',fixture,repeat,method:'sheep',review,workers:4,concurrency:2,activation:'fixture',group:`quality/${review}`});
 for(let repeat=0;repeat<3;repeat++)for(const [i,fixture] of ['independent','propagation'].entries())for(const method of (repeat+i)%2?['sheep','single'] as const:['single','sheep'] as const)cases.push({phase:'baseline',fixture,repeat,method,review:method==='sheep'?'selected':'none',workers:method==='sheep'?4:1,concurrency:method==='sheep'?2:1,activation:'all',group:`baseline/${method}`});
 const speed=[{concurrency:1,activation:'all'},{concurrency:4,activation:'all'},{concurrency:1,activation:'impacted'},{concurrency:4,activation:'impacted'}] as const;
 for(let repeat=0;repeat<2;repeat++)for(const s of repeat?[...speed].reverse():speed)cases.push({phase:'speed',fixture:'parallel',repeat,method:'sheep',review:'none',workers:16,...s,group:`speed/C${s.concurrency}/${s.activation}`});
 return cases;
}
interface Row extends TrialMetric {phase:string;fixture:string;repeat:number;method:string;qualityPass:boolean;review:string;outputDirectory:string;sourceUnchanged:boolean;receiptsValid:boolean;upstreamRechecks:number;verificationCommandCount:number;participants:number;maxConcurrentModelCalls:number;initiallyActivatedTargets:number;changedPaths:readonly string[];termination:string}

export async function runContractQualityBenchmark(directory:string){
 const root=resolve(directory);await mkdir(root);
 const runtimePaths=[...(await readdir('src')).filter(p=>p.endsWith('.ts')).map(p=>`src/${p}`),...(await readdir('experiments')).filter(p=>p.endsWith('.ts')||p==='upstream-recovery-seed.json').map(p=>`experiments/${p}`),'scripts/quality-speed-fixture.mjs','scripts/quality-speed-reference.mjs','scripts/contract-quality-benchmark.ts','package.json','package-lock.json'];
 const runtimeHashes=Object.fromEntries(await Promise.all(runtimePaths.map(async p=>[p,hash(await readFile(p))])));
 for(const p of runtimePaths){const dest=join(root,'runtime',p);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,await readFile(p));}
 const cases=trialCases(),profile={format:1,runtime:'opencode-go',model:'deepseek-flash',thinking:'enabled',upperCalls:0,limits,taskDeadlineMs:null,seriesTokenAdmissionCap:38000000,cases,runtimeHashes,selectionRule:'higher quality-phase success count; if tied fewer calls; if still tied focused',baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()};
 await save(join(root,'profile.json'),profile);
 const fixtures=new Map<string,{repository:string;fixture:TrialFixture;hashes:Record<string,string>}>();
 const preparationStarted=performance.now();
 for(const name of ['multiple','healthy','branching','independent','propagation','parallel'] as const){
  const fixture=name==='parallel'?parallelFixture():name==='independent'||name==='propagation'?freshFixture(name):await qualityFixture(name);
  const repository=join(root,name);await mkdir(repository);
  for(const [p,s] of Object.entries(fixture.files)){await mkdir(dirname(join(repository,p)),{recursive:true});await writeFile(join(repository,p),s);}
  execFileSync('git',['init','-q'],{cwd:repository});execFileSync('git',['add','.'],{cwd:repository});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-qm','Freeze comparison fixture'],{cwd:repository});
  const snapshot=await captureRepository(repository,fixture.task),out=join(root,`${name}-preflight`);
  const baseline=await runRepoChecks(snapshot,{},fixture.task.checks,out);
  const reference=await runRepoChecks(snapshot,fixture.reference,[...fixture.task.files.flatMap(f=>f.checks),...fixture.task.checks],out);
  const mutant=await runRepoChecks(snapshot,fixture.mutant,fixture.task.checks,out);
  await save(join(root,`${name}-preflight.json`),{baseline,reference,mutant});
  if(baseline.ok||!reference.ok||mutant.ok||[baseline,reference,mutant].some(v=>v.executionFailure))throw new Error(`preflight failed ${name}`);
  const hashes=Object.fromEntries([...snapshot.entries].map(([p,e])=>[p,hash(e.bytes)]));
  await save(join(root,`${name}-fixture.json`),{task:fixture.task,hashes,changedPaths:fixture.changedPaths});fixtures.set(name,{repository,fixture,hashes});
 }
 const preparationElapsedMs=performance.now()-preparationStarted;
 let observedTokens=0,stopReason:string|null=null,selectedReview:'focused'|'contract'|undefined;
 const rows:Row[]=[];
 const persist=()=>save(join(root,'series.json'),{format:1,plannedRuns:cases.length,completedRuns:rows.length,observedTokens,stopReason,preparationElapsedMs,authoringLaborMs:null,selectedReview:selectedReview??null,summary:summarizeTrials(rows),results:rows});
 await persist();
 for(const [index,c] of cases.entries()){
  if(observedTokens+limits.maxTokens>profile.seriesTokenAdmissionCap){stopReason='series-token-admission';break;}
  for(const [p,h] of Object.entries(runtimeHashes))if(hash(await readFile(p))!==h)throw new Error(`runtime drift: ${p}`);
  if(c.phase==='baseline'&&!selectedReview){
   const summary=summarizeTrials(rows),a=summary.find(g=>g.group==='quality/focused')!,b=summary.find(g=>g.group==='quality/contract')!;
   selectedReview=b.successes>a.successes||(b.successes===a.successes&&b.calls<a.calls)?'contract':'focused';
   await save(join(root,'review-selection.json'),{selectedReview,rule:profile.selectionRule,evidence:[a,b]});
  }
  const f=fixtures.get(c.fixture)!,review=c.review==='selected'?selectedReview!:c.review;
  const task=parseRepoTask({...f.fixture.task,...(c.activation==='impacted'?{activation:{changedPaths:f.fixture.changedPaths}}:{}),...(review==='focused'||review==='contract'?{recovery:{maxUpstreamRechecks:2,review}}:{})});
  const outputDirectory=join(root,`run-${String(index+1).padStart(2,'0')}-${c.fixture}-${c.method}`),started=performance.now();
  console.log(JSON.stringify({event:'run-start',index:index+1,...c,review}));
  try{
   const snapshot=await captureRepository(f.repository,task);
   const caller:typeof callOpenCodeGo=async <T>(o:OpenCodeGoOptions)=>{console.log(JSON.stringify({event:'call-start',index:index+1,id:o.callId,target:/Update only ([^\s]+)/.exec(o.prompt)?.[1]??'all'}));const r=await callOpenCodeGo<T>(o);console.log(JSON.stringify({event:'call-finished',index:index+1,id:o.callId,durationMs:r.transcript.durationMs}));return r;};
   const run=c.method==='single'?await runSingleRepository({...limits,repository:f.repository,task,outputDirectory},caller):await runRepository({...limits,repository:f.repository,task,outputDirectory,runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'enabled',workers:c.workers,concurrency:c.concurrency,maxMetaCalls:0,maxRounds:64},caller);
   const artifacts=JSON.parse(await readFile(join(outputDirectory,'artifacts.json'),'utf8')) as Record<string,string>;
   const independent=await runRepoChecks(snapshot,artifacts,[...task.files.flatMap(f=>f.checks),...task.checks],join(root,`audit-${index+1}`));
   await save(join(outputDirectory,'independent-check.json'),independent);
   let sourceUnchanged=execFileSync('git',['status','--porcelain'],{cwd:f.repository,encoding:'utf8'})==='';
   for(const [p,h] of Object.entries(f.hashes))if(hash(await readFile(join(f.repository,p)))!==h)sourceUnchanged=false;
   const calls='swarm' in run?run.swarm.calls:run.calls;
   let receiptsValid=calls.length>0,receiptTokens=0;
   const receiptDirectory=c.method==='sheep'?join(outputDirectory,'swarm'):outputDirectory;
   for(const c of calls){
    const receipt=JSON.parse(await readFile(join(receiptDirectory,`${c.id}.json`),'utf8')),tr=receipt.transcript,usage=extractTokenUsage(receipt);
    if((receipt.requestedModel!==undefined&&receipt.requestedModel!=='deepseek-flash')||tr?.requestedModel!=='deepseek-flash'||tr?.effectiveModelEvidence!=='deepseek-flash'||tr?.thinking!=='enabled'||tr?.usageCompleteness!=='complete'||tr?.httpStatus!==200||tr?.timedOut||tr?.cancelled||usage.inputTokens===null||usage.outputTokens===null||usage.partial)receiptsValid=false;
    receiptTokens+=(usage.inputTokens??0)+(usage.outputTokens??0);
   }
   if(receiptTokens!==run.budget.observedTokens)receiptsValid=false;
   const checks=[...run.verifications,independent].flatMap(v=>v.checks);
   const blocked=!sourceUnchanged||!receiptsValid||run.budget.unknownUsageCalls>0||run.budget.reservationOverruns>0||run.budget.activeReservations>0||[...run.verifications,independent].some(v=>v.executionFailure)||checks.some(c=>c.timedOut||c.signal!==null);
   const success=run.success&&independent.ok&&!blocked,elapsedMs=performance.now()-started;
   const row:Row={group:c.group,phase:c.phase,fixture:c.fixture,repeat:c.repeat,method:c.method,review,success,qualityPass:independent.ok,elapsedMs,completionMs:success?elapsedMs:null,calls:calls.length,tokens:receiptsValid?receiptTokens:null,sourceUnchanged,receiptsValid,upstreamRechecks:'swarm' in run?run.discovery?.upstreamRechecks??0:0,verificationCommandCount:checks.length,participants:'swarm' in run?run.swarm.individuals.filter(i=>i.assignments>0).length:1,maxConcurrentModelCalls:'swarm' in run?run.swarm.maxConcurrentModelCalls:1,initiallyActivatedTargets:'swarm' in run?run.discovery?.initiallyActivatedTargets??task.files.length:task.files.length,changedPaths:Object.keys(artifacts).filter(p=>artifacts[p]!==snapshot.initialTargets[p]),termination:success?'accepted':blocked?'evidence-stop':'termination' in run?run.termination:'not-accepted',outputDirectory};
   observedTokens+=run.budget.observedTokens;rows.push(row);if(blocked)stopReason='evidence-stop';await persist();console.log(JSON.stringify({event:'run-finished',index:index+1,...row}));if(blocked)break;
  }catch(error){stopReason='orchestrator-error';await save(join(root,'error.json'),{case:c,index:index+1,error:String(error),elapsedMs:performance.now()-started,usage:'inspect receipts; not assumed zero'});await persist();throw error;}
 }
 await persist();return {rows,stopReason};
}
