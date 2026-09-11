import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir,rename,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {STRATEGIES,digest,sweepPlan,summarizeSweep} from '../experiments/packet-sweep.ts';
import {verifyCorpus,receiptAudit} from './synthetic-paired-benchmark.mjs';
import {buildSyntheticTask} from '../experiments/synthetic-corpus/index.ts';
import {materializeSyntheticTask,preflightSyntheticTask} from './synthetic-corpus.ts';
import {runSingleRepository} from '../experiments/repository-single.ts';
import {runPacketRepository,prepareRepositoryPackets} from '../src/repo-packet-run.ts';
import {captureRepository} from '../src/repo-files.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const optional=async p=>{try{return await load(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const save=async(p,v)=>{await writeFile(p+'.tmp',JSON.stringify(v,null,2)+'\n');await rename(p+'.tmp',p);};
const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
async function sources(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?sources(join(dir,e.name)):[join(dir,e.name)]))).flat();}
const limits={maxCalls:128,maxTokens:2000000,reserveTokensPerCall:200000,maxTokensPerCall:64000,timeoutMs:600000};
const base={...limits,runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'enabled',maxMetaCalls:0,concurrency:4,maxRounds:256};
async function runtime(root,profile,current=true){for(const [p,h] of Object.entries(profile.runtimeHashes)){
 assert.equal(digest(await readFile(join(root,'runtime',p))),h,'saved runtime drift: '+p);if(current)assert.equal(digest(await readFile(p)),h,'runtime drift: '+p);
}}
async function fixture(root,c){const f=buildSyntheticTask(c.id),repository=join(root,'fixtures',c.id);assert.deepEqual(f.hashes,c.hashes);
 assert.equal(git(repository,['status','--porcelain']),'','fixture dirty');assert.deepEqual(await load(join(repository,'task.json')),f.task);
 for(const [p,text] of Object.entries(f.files))assert.equal(await readFile(join(repository,p),'utf8'),text);
 return {f,repository};}
export async function prepare(root) {
 const started=performance.now(),lock=await verifyCorpus();await mkdir(root);await mkdir(join(root,'preflight'));
 const cases=lock.cases.filter(c=>c.split==='dev');assert.equal(cases.length,128);let index=0;
 await Promise.all(Array.from({length:4},async()=>{while(index<cases.length){
  const c=cases[index++],f=buildSyntheticTask(c.id),check=await preflightSyntheticTask(f);await save(join(root,'preflight',c.id+'.json'),check);assert.ok(check.ok);
  const repository=await materializeSyntheticTask(f,join(root,'fixtures',c.id));
  git(repository,['init','-q']);git(repository,['add','.']);git(repository,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Frozen packet sweep input']);
  c.packetPlans={};c.conditions=[{method:'legacy-single',signature:'legacy-single',packetSize:null}];
  for(const size of ['all',8,4,2,1]){const {plan}=await prepareRepositoryPackets({...base,repository,task:f.task,packetSize:size,outputDirectory:join(root,'unused')});
   c.packetPlans[size]=plan;const signature=digest(JSON.stringify(plan.packets.map(p=>({paths:p.paths,dependsOn:p.dependsOn,currentReadPaths:p.currentReadPaths}))));
   c.conditions.push({method:'packet-'+size,signature,packetSize:size});
  }
  process.stdout.write(JSON.stringify({event:'prepared',id:c.id})+'\n');
 }}));
 const plan=sweepPlan(cases),runtimeHashes={};
 const paths=[...await sources('src'),...await sources('experiments/synthetic-corpus'),'experiments/packet-sweep.ts','experiments/synthetic-paired.ts','experiments/repository-single.ts','experiments/repository-patch.ts',
  'experiments/synthetic-corpus-v1-lock.json','docs/results/synthetic-corpus-validation.json','scripts/packet-sweep.mjs','scripts/synthetic-paired-benchmark.mjs','scripts/synthetic-corpus.ts','package.json','package-lock.json'];
 for(const p of paths){const bytes=await readFile(p);runtimeHashes[p]=digest(bytes);const target=join(root,'runtime',p);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);}
 const profile={format:1,baseCommit:git('.',['rev-parse','HEAD']).trim(),corpusLockHash:digest(await readFile('experiments/synthetic-corpus-v1-lock.json')),model:'opencode-go/deepseek-flash',thinking:'enabled',upperCalls:0,taskDeadlineMs:null,
  limits,packet:{concurrency:4,maxRounds:256,activation:'all',contextPolicy:'immutable-public-baseline+upstream-packet-closure'},single:{responseFormat:'named'},
  repeats:1,taskConcurrency:1,strategies:STRATEGIES,cases,plan,seriesAdmissionTokens:plan.length*limits.maxTokens,runtimeHashes,
  order:'sha256(packet-dev-v1:ID); within family and alias-class set, rotate unique methods by rank, reverse on alternating full cycles; cases adjacent',
  analysis:'quality on all valid observations; paired both-success times against packet-all and legacy-single; equivalent aliases excluded from paired wins, resources counted once',
  exclusions:'evidence/infrastructure rows excluded from quality/time, consumed resources retained; no evaluation or Manager; prior dev observations are exploratory'};
 await save(join(root,'profile.json'),profile);
 await save(join(root,'series.json'),{format:1,profileHash:digest(await readFile(join(root,'profile.json'))),results:[],inFlight:null,stopReason:null,knownTokens:0,totalTokens:0,preparationElapsedMs:performance.now()-started});
 process.stdout.write(JSON.stringify({event:'ready',cases:cases.length,plannedRuns:plan.length,seriesAdmissionTokens:profile.seriesAdmissionTokens})+'\n');return profile;
}
export async function packetReceiptAudit(directory,run,task,expectedPlan) {
 assert.deepEqual(run.plan,expectedPlan);const kernel=await load(join(directory,'kernel.json'));
 const publicPaths=[...new Set([...task.files.map(f=>f.path),...task.context,...(task.discovery?.readable??[])])].sort();
 const usage={inputTokens:0,outputTokens:0,tokens:0};assert.ok(run.calls.length>0);
 for(const call of run.calls){
  const receipt=await load(join(directory,call.id+'.json')),request=await load(join(directory,call.id+'.request.json')),tr=receipt.transcript,u=tr.rawUsage;
  assert.equal(tr.requestedModel,'deepseek-flash');assert.equal(tr.effectiveModelEvidence,'deepseek-flash');assert.equal(tr.thinking,'enabled');assert.equal(tr.httpStatus,200);assert.equal(tr.usageCompleteness,'complete');assert.equal(tr.timedOut,false);assert.equal(tr.cancelled,false);
  for(const n of [u.prompt_tokens,u.completion_tokens,u.total_tokens])assert.ok(Number.isSafeInteger(n)&&n>=0);assert.equal(u.prompt_tokens+u.completion_tokens,u.total_tokens);
  assert.equal(u.total_tokens,run.budget.calls.find(c=>c.callId===call.id).tokens);usage.inputTokens+=u.prompt_tokens;usage.outputTokens+=u.completion_tokens;usage.tokens+=u.total_tokens;
  const packet=run.plan.packets.find(p=>p.id===call.packet),context=kernel.contexts.find(c=>c.id===call.readContext);assert.ok(packet&&context);
  assert.deepEqual(request.reads,context.reads);assert.deepEqual(Object.keys(request.reads).sort(),['.sheep-internal/packet-baseline',...packet.currentReadPaths].sort());
  const baselineLine=request.prompt.split('\n').find(s=>s.startsWith('Public baseline: '));assert.ok(baselineLine);const baseline=JSON.parse(baselineLine.slice('Public baseline: '.length));
  assert.deepEqual(Object.keys(baseline.files).sort(),publicPaths);assert.equal(JSON.stringify(baseline),context.contents['.sheep-internal/packet-baseline']);
  for(const p of task.protected)assert.ok(!Object.hasOwn(baseline.files,p));
  const line=request.prompt.split('\n').find(s=>s.startsWith('Current packet/dependency files: '));assert.ok(line);const overlay=JSON.parse(line.slice('Current packet/dependency files: '.length));
  assert.deepEqual(overlay,Object.fromEntries(packet.currentReadPaths.map(p=>[p,context.contents[p]])));
 }
 assert.equal(usage.tokens,run.budget.observedTokens);for(const key of ['unknownUsageCalls','activeReservations','reservationOverruns'])assert.equal(run.budget[key],0);assert.equal(run.budget.locked,false);
 const artifacts=await load(join(directory,'artifacts.json'));assert.deepEqual(artifacts,Object.fromEntries(task.files.map(f=>[f.path,kernel.artifacts[f.path].content])));
 return usage;
}
export async function runSeries(root) {
 assert.ok(process.env.OPENCODE_GO_API_KEY,'OPENCODE_GO_API_KEY required');const profile=await load(join(root,'profile.json')),series=await load(join(root,'series.json'));
 assert.equal(digest(await readFile(join(root,'profile.json'))),series.profileHash);assert.equal(series.stopReason,null,'stopped series cannot resume');assert.equal(series.inFlight,null,'uncertain in-flight run cannot resume');
 assert.equal(await optional(join(root,'external-stop.json')),null,'externally stopped series cannot resume');
 assert.deepEqual(profile.plan.slice(0,series.results.length),series.results.map(r=>({id:r.id,method:r.method,packetSize:r.packetSize,aliases:r.aliases})));
 await runtime(root,profile);await mkdir(join(root,'runner.lock'));
 try {for(const item of profile.plan.slice(series.results.length)) {
  if(series.knownTokens+profile.limits.maxTokens>profile.seriesAdmissionTokens){series.stopReason='series-token-admission';break;}
  await runtime(root,profile);const c=profile.cases.find(c=>c.id===item.id),{f,repository}=await fixture(root,c),directory=join(root,'runs',item.id,item.method);
  series.inFlight={...item,startedAt:new Date().toISOString()};series.totalTokens=null;await save(join(root,'series.json'),series);
  process.stdout.write(JSON.stringify({event:'run-start',index:series.results.length+1,...series.inFlight})+'\n');
  const started=performance.now(),options={...profile.limits,repository,task:f.task,outputDirectory:directory};
  const run=item.method==='legacy-single'?await runSingleRepository(options):await runPacketRepository({...options,runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'enabled',maxMetaCalls:0,concurrency:profile.packet.concurrency,maxRounds:profile.packet.maxRounds,packetSize:item.packetSize});
  const elapsedMs=performance.now()-started,auditStarted=performance.now(),evidenceErrors=[];let usage=null;
  const artifactsBytes=await readFile(join(directory,'artifacts.json')),artifacts=JSON.parse(artifactsBytes);
  const independent=await runRepoChecks(await captureRepository(repository,f.task),artifacts,[...f.task.files.flatMap(t=>t.checks),...f.task.checks],join(directory,'independent'));await save(join(directory,'independent-check.json'),independent);
  try{await fixture(root,c);}catch(e){evidenceErrors.push('fixture drift: '+String(e));}
  try{usage=item.method==='legacy-single'?await receiptAudit(directory,'single',run,f.task):await packetReceiptAudit(directory,run,f.task,c.packetPlans[item.packetSize]);}catch(e){evidenceErrors.push('receipt: '+String(e));}
  const verifications=[...run.verifications,independent],commands=verifications.flatMap(v=>v.checks);
  if(run.infrastructureFailure||verifications.some(v=>v.executionFailure)||commands.some(c=>c.timedOut||c.signal!==null))evidenceErrors.push('provider or verification infrastructure');
  const success=run.success&&independent.ok&&!evidenceErrors.length;
  const row={...item,family:c.family,targetCount:c.targetCount,topology:c.topology,dependencyDepth:c.dependencyDepth,startedAt:series.inFlight.startedAt,
   success,qualityPass:independent.ok,elapsedMs,completionMs:success?elapsedMs:null,auditMs:performance.now()-auditStarted,
   tokens:usage?.tokens??null,knownTokens:run.budget.observedTokens,unknownUsageCalls:run.budget.unknownUsageCalls,usage,calls:run.calls.length,upperCalls:0,evidenceErrors,
   termination:run.termination,packetCount:item.method==='legacy-single'?1:run.plan.packets.length,
   maxConcurrentModelCalls:run.maxConcurrentModelCalls??1,nonAcceptedProposals:run.calls.filter(c=>!['committed','public-checks-passed'].includes(c.outcome)).length,
   modelCallDurationSumMs:run.calls.reduce((n,c)=>n+c.durationMs,0),verificationCommands:commands.length,verificationDurationSumMs:commands.reduce((n,c)=>n+c.durationMs,0),candidateDigest:digest(artifactsBytes)};
  await save(join(directory,'row.json'),row);series.results.push(row);series.knownTokens+=run.budget.observedTokens;series.inFlight=null;
  if(evidenceErrors.length)series.stopReason='evidence-stop';series.totalTokens=series.results.some(r=>r.tokens===null)?null:series.knownTokens;
  await save(join(root,'series.json'),series);await save(join(root,'summary.json'),summarizeSweep(profile.cases,series.results));
  process.stdout.write(JSON.stringify({event:'run-finished',index:series.results.length,...row})+'\n');if(series.stopReason)break;
 }}catch(e){series.stopReason='orchestrator-error';series.totalTokens=null;series.error=String(e);await save(join(root,'series.json'),series);throw e;}
 finally{await save(join(root,'series.json'),series);await rm(join(root,'runner.lock'),{recursive:true});}
 if(series.stopReason)throw new Error('series stopped: '+series.stopReason);
}
/** Receipt accounting after an external stop; never manufactures a scored row
 * or rewrites an interrupted kernel/budget checkpoint. */
export async function interruptedPacketAudit(directory) {
 const names=await readdir(directory),budget=await load(join(directory,'budget.json'));
 const requests=names.filter(n=>/^call-\d+\.request\.json$/.test(n)),receipts=names.filter(n=>/^call-\d+\.json$/.test(n));
 const ids=[...new Set([...requests,...receipts].map(n=>n.split('.')[0]).concat(budget.calls.map(c=>c.callId)))].sort((a,b)=>Number(a.slice(5))-Number(b.slice(5)));
 let knownTokens=0;const unknownCalls=[],evidenceErrors=[],hashes={};
 for(const name of [...requests,...receipts,'budget.json','kernel.json'])hashes[name]=digest(await readFile(join(directory,name)));
 for(const id of ids) {
  const receipt=await optional(join(directory,id+'.json')),tr=receipt?.transcript,u=tr?.rawUsage;
  const complete=tr?.usageCompleteness==='complete'&&tr.httpStatus===200&&!tr.timedOut&&!tr.cancelled&&
   [u?.prompt_tokens,u?.completion_tokens,u?.total_tokens].every(n=>Number.isSafeInteger(n)&&n>=0)&&u.prompt_tokens+u.completion_tokens===u.total_tokens;
  if(complete)knownTokens+=u.total_tokens;else unknownCalls.push(id);
  if(!requests.includes(id+'.request.json'))evidenceErrors.push(id+': missing request');
  if(tr?.requestedModel!=='deepseek-flash'||tr?.effectiveModelEvidence!=='deepseek-flash'||tr?.thinking!=='enabled')evidenceErrors.push(id+': model/thinking evidence');
 }
 return {calls:ids.length,knownTokens,totalTokens:unknownCalls.length?null:knownTokens,unknownCalls,evidenceErrors,hashes,
  checkpointObservedTokens:budget.observedTokens,checkpointActiveReservations:budget.activeReservations,quality:null,completionMs:null};
}
export async function audit(root) {
 const profile=await load(join(root,'profile.json')),series=await load(join(root,'series.json'));assert.equal(digest(await readFile(join(root,'profile.json'))),series.profileHash);await runtime(root,profile,false);
 assert.deepEqual(profile.plan.slice(0,series.results.length),series.results.map(r=>({id:r.id,method:r.method,packetSize:r.packetSize,aliases:r.aliases})));
 let knownTokens=0;
 for(const row of series.results){const c=profile.cases.find(c=>c.id===row.id),{f}=await fixture(root,c),dir=join(root,'runs',row.id,row.method),run=await load(join(dir,'result.json')),independent=await load(join(dir,'independent-check.json'));
  assert.deepEqual(row,await load(join(dir,'row.json')));assert.equal(row.candidateDigest,digest(await readFile(join(dir,'artifacts.json'))));
  if(!row.evidenceErrors.length){const usage=row.method==='legacy-single'?await receiptAudit(dir,'single',run,f.task):await packetReceiptAudit(dir,run,f.task,c.packetPlans[row.packetSize]);assert.deepEqual(usage,row.usage);assert.equal(row.success,run.success&&independent.ok);}
  else {assert.equal(row.success,false);assert.ok(series.stopReason);}
  assert.equal(row.completionMs,row.success?row.elapsedMs:null);knownTokens+=run.budget.observedTokens;
 }
 assert.equal(knownTokens,series.knownTokens);
 const externalStop=await optional(join(root,'external-stop.json'));let interrupted=null;
 if(externalStop) {
  assert.deepEqual(externalStop.case,series.inFlight);assert.ok(series.inFlight&&series.inFlight.method!=='legacy-single');
  assert.deepEqual(profile.plan[series.results.length],Object.fromEntries(['id','method','packetSize','aliases'].map(k=>[k,series.inFlight[k]])));
  interrupted=await interruptedPacketAudit(join(root,'runs',series.inFlight.id,series.inFlight.method));
  assert.equal(interrupted.knownTokens,externalStop.knownTokens);assert.deepEqual(interrupted.unknownCalls,externalStop.unknownCalls);
 }
 const totalTokens=interrupted?(interrupted.totalTokens===null||series.results.some(r=>r.tokens===null)?null:knownTokens+interrupted.totalTokens):series.totalTokens;
 const result={format:1,profileHash:series.profileHash,corpusLockHash:profile.corpusLockHash,model:profile.model,thinking:profile.thinking,plannedRuns:profile.plan.length,completedRuns:series.results.length,
  complete:series.results.length===profile.plan.length&&!series.stopReason&&!series.inFlight&&!externalStop,stopReason:externalStop?.reason??series.stopReason,inFlight:series.inFlight,
  knownTokens:knownTokens+(interrupted?.knownTokens??0),totalTokens,cost:null,externalStop,interrupted,
  originalSeriesAccounting:{knownTokens:series.knownTokens,totalTokens:series.totalTokens,stopReason:series.stopReason},
  preparationElapsedMs:series.preparationElapsedMs,profile,rows:series.results,summary:summarizeSweep(profile.cases,series.results)};
 await save(join(root,'audit.json'),result);return result;
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){const [command,root]=process.argv.slice(2);if(!['prepare','run','audit'].includes(command)||!root||process.argv.length!==4)throw new Error('Usage: node scripts/packet-sweep.mjs prepare|run|audit DIRECTORY');
 const result=await ({prepare,run:runSeries,audit}[command])(resolve(root));if(command==='audit')process.stdout.write(JSON.stringify({complete:result.complete,completedRuns:result.completedRuns,plannedRuns:result.plannedRuns,stopReason:result.stopReason,knownTokens:result.knownTokens})+'\n');}
