import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir,rename,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {SEMANTIC_METHODS,semanticHash as hash,semanticPilotCases,semanticPilotOrder,summarizeSemantic} from '../experiments/semantic-decomposition.ts';
import {retryAccounting,retryAction,retryObservation} from '../experiments/transport-retry.ts';
import {verifyCorpus} from './synthetic-paired-benchmark.mjs';
import {semanticReceiptAudit} from './semantic-decomposition-audit.mjs';
import {buildSyntheticTask} from '../experiments/synthetic-corpus/index.ts';
import {materializeSyntheticTask,preflightSyntheticTask} from './synthetic-corpus.ts';
import {runSingleRepository} from '../experiments/repository-single.ts';
import {runPacketRepository} from '../src/repo-packet-run.ts';
import {runPlannedRepository} from '../src/repo-planned-run.ts';
import {captureRepository} from '../src/repo-files.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const save=async(p,v)=>{await writeFile(p+'.tmp',JSON.stringify(v,null,2)+'\n');await rename(p+'.tmp',p);};
const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
async function sources(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?sources(join(dir,e.name)):[join(dir,e.name)]))).flat();}
export const LIMITS={maxCalls:128,maxTokens:2000000,reserveTokensPerCall:200000,maxTokensPerCall:64000,timeoutMs:600000};
const BASE={runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'enabled',maxMetaCalls:0,concurrency:4,maxRounds:256};
async function bindings(root,current=true){const profile=await load(join(root,'profile.json')),state=await load(join(root,'state.json'));
 assert.equal(hash(await readFile(join(root,'profile.json'))),state.profileHash);
 for(const [p,h] of Object.entries(profile.runtimeHashes)){assert.equal(hash(await readFile(join(root,'runtime',p))),h,'saved runtime drift: '+p);if(current)assert.equal(hash(await readFile(p)),h,'runtime drift: '+p);}
 assert.deepEqual(state.groups.map(g=>g.item),profile.plan.slice(0,state.groups.length));return {profile,state};
}
async function fixture(root,c){const f=buildSyntheticTask(c.id),repository=join(root,'fixtures',c.id);assert.deepEqual(f.hashes,c.hashes);
 assert.equal(git(repository,['status','--porcelain']),'','fixture dirty');assert.deepEqual(await load(join(repository,'task.json')),f.task);
 for(const [p,s] of Object.entries(f.files))assert.equal(await readFile(join(repository,p),'utf8'),s);return {f,repository};}
export async function prepare(root) {
 const start=performance.now(),lock=await verifyCorpus(),cases=semanticPilotCases(lock.cases);
 await mkdir(root,{recursive:false});await mkdir(join(root,'preflight'));
 let i=0;await Promise.all(Array.from({length:4},async()=>{while(i<cases.length){const c=cases[i++],f=buildSyntheticTask(c.id),check=await preflightSyntheticTask(f);
  await save(join(root,'preflight',c.id+'.json'),check);assert.ok(check.ok);
  const repository=await materializeSyntheticTask(f,join(root,'fixtures',c.id));git(repository,['init','-q']);git(repository,['add','.']);git(repository,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Frozen semantic pilot input']);
  console.log(JSON.stringify({event:'prepared',id:c.id}));
 }}));
 const paths=[...await sources('src'),...await sources('experiments/synthetic-corpus'),'experiments/repository-single.ts','experiments/repository-patch.ts','experiments/semantic-decomposition.ts','experiments/transport-retry.ts','experiments/synthetic-paired.ts','experiments/packet-sweep.ts',
  'experiments/synthetic-corpus-v1-lock.json','docs/results/synthetic-corpus-validation.json','scripts/synthetic-corpus.ts','scripts/synthetic-paired-benchmark.mjs','scripts/packet-sweep.mjs','scripts/semantic-decomposition-audit.mjs','scripts/semantic-decomposition-pilot.mjs','package.json','package-lock.json'];
 const runtimeHashes={};for(const p of paths){const bytes=await readFile(p);runtimeHashes[p]=hash(bytes);const dest=join(root,'runtime',p);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,bytes);}
 const plan=semanticPilotOrder(cases),profile={format:1,createdAt:new Date().toISOString(),baseCommit:git('.',['rev-parse','HEAD']).trim(),corpusLockHash:hash(await readFile('experiments/synthetic-corpus-v1-lock.json')),runtimeHashes,
  model:'opencode-go/deepseek-flash',thinking:'enabled',upperCalls:0,taskDeadlineMs:null,limits:LIMITS,base:BASE,methods:SEMANTIC_METHODS,taskConcurrency:1,repeats:1,cases,plan,
  seriesAdmissionTokens:plan.length*LIMITS.maxTokens,maxRetries:3,backoffMs:[2000,4000,8000],
  selection:'Dev only. Alphabetical family i omits size i mod 4 from [4,8,16,32]. Each remaining size selects smallest sha256(semantic-dev-v1:ID). Order by sha256(semantic-order-v1:ID). Cycle all six method permutations.',
  hypothesis:'Planned decomposition may match quality and reduce end-to-end completion versus both contemporaneous Single and fixed packet-all. Do not adopt on speed if quality decreases. Exploratory 24-case pilot, no significance or generalization claim.',
  context:'Planner reads all public baseline + task. Planned workers read selected public baseline plus host dependency closure. Fixed-all retains the previous packet-all prompt. This is a method comparison, not a pure partition ablation.',
  retry:'Only transient transport errors restart the whole condition from baseline, up to 3 retries within shared caps; unknown tokens remain null and reservation charges govern admission. Quality/invalid-plan failures are terminal; exhausted transport conditions are unavailable.',
  timing:'Condition elapsed includes planning, execution, runtime checks, failed attempts and backoff; independent audit/preparation/operator pauses excluded and reported separately. No task deadline.',
  analysis:'Quality on valid observations; paired times on both-success observations. Stratify by family, targetCount, topology and dependencyDepth. Separate proposed/normalized packets, one-packet/all-target-one-packet, planned writable/actual changed targets. Prior dev exposure is exploratory; no evaluation or Manager.'};
 await save(join(root,'profile.json'),profile);await save(join(root,'state.json'),{format:1,profileHash:hash(await readFile(join(root,'profile.json'))),nextIndex:0,groups:[],pending:null,stopReason:null,preparationElapsedMs:performance.now()-start});
 await report(root);console.log(JSON.stringify({event:'ready',root,cases:cases.length,runs:plan.length}));return profile;
}
export async function executeAttempt(root,profile,item,directory,limits,retryWaitMs=0,caller) {
 const c=profile.cases.find(c=>c.id===item.id),{f,repository}=await fixture(root,c),options={...BASE,...limits,repository,task:f.task,outputDirectory:directory};
 const before=await captureRepository(repository,f.task),startedAt=new Date().toISOString(),start=performance.now();
 const run=item.method==='single'?await runSingleRepository(options,caller):item.method==='fixed-all'?await runPacketRepository({...options,packetSize:'all'},caller):await runPlannedRepository(options,caller);
 const elapsedMs=performance.now()-start,auditStart=performance.now(),bytes=await readFile(join(directory,'artifacts.json')),artifacts=JSON.parse(bytes);
 const independent=await runRepoChecks(before,artifacts,[...f.task.files.flatMap(t=>t.checks),...f.task.checks],join(directory,'independent'));await save(join(directory,'independent-check.json'),independent);
 await fixture(root,c);
 let evidence;try{evidence=await semanticReceiptAudit(directory,item.method,run,options,independent);}catch(e){evidence={transportRetryable:false,evidenceErrors:[String(e)]};}
 const success=run.success&&independent.ok&&!evidence.evidenceErrors.length;
 const changedTargetCount=f.task.files.filter(f=>artifacts[f.path]!==before.initialTargets[f.path]).length;
 const row={...item,startedAt,success,qualityPass:independent.ok,termination:run.termination,elapsedMs,completionMs:success?elapsedMs:null,retryWaitMs,auditMs:performance.now()-auditStart,
  budget:run.budget,...evidence,knownTokens:run.budget.observedTokens,tokens:run.budget.unknownUsageCalls?null:run.budget.observedTokens,calls:run.budget.calls.length,
  changedTargetCount,proposedPacketCount:item.method==='planned'?run.proposedPacketCount:null,executedPacketCount:item.method==='planned'?run.executedPacketCount:1,
  plannedWritableCount:item.method==='planned'?run.plannedWritablePaths.length:f.task.files.length,
  plannerMs:run.plannerMs??0,plannerCalls:run.plannerCalls??0,plannerChoseSingle:run.plannerChoseSingle??false,
  allTargetsOnePacket:item.method==='planned'?run.plannerChoseSingle&&run.plannedWritablePaths.length===f.task.files.length:true,
  maxConcurrentModelCalls:run.worker?.maxConcurrentModelCalls??run.maxConcurrentModelCalls??1,
  candidateDigest:hash(bytes),resultHash:hash(await readFile(join(directory,'result.json'))),independentHash:hash(await readFile(join(directory,'independent-check.json')))};
 await save(join(directory,'row.json'),row);return {...row,directory,rowHash:hash(await readFile(join(directory,'row.json')))};
}
export async function run(root) {
 assert.ok(process.env.OPENCODE_GO_API_KEY,'OPENCODE_GO_API_KEY required');const {profile,state}=await bindings(root);
 assert.equal(state.pending,null,'uncertain attempt requires receipt review');assert.equal(state.stopReason,null,'non-transient stop requires review');await mkdir(join(root,'runner.lock'));
 try{while(state.nextIndex<profile.plan.length){await bindings(root);
  const item=profile.plan[state.nextIndex];let group=state.groups[state.nextIndex];if(!group){group={item,attempts:[],finalized:false};state.groups.push(group);}
  const action=retryAction(group.attempts,profile.limits,profile.maxRetries);
  if(action!=='run'){if(action==='stop'){state.stopReason='non-transient-infrastructure';break;}group.finalized=true;group.outcome=action;state.nextIndex++;await save(join(root,'state.json'),state);await report(root);continue;}
  const spent=retryAccounting(group.attempts),all=retryAccounting(state.groups.flatMap(g=>g.attempts));
  const limits={...profile.limits,maxCalls:profile.limits.maxCalls-spent.calls,maxTokens:profile.limits.maxTokens-spent.chargedTokens};
  if(all.chargedTokens+limits.maxTokens>profile.seriesAdmissionTokens){state.stopReason='series-admission';break;}
  const number=group.attempts.length+1,directory=join(root,'runs',item.id,item.method,'attempt-'+number);
  state.pending={index:state.nextIndex,item,number,directory,limits,startedAt:new Date().toISOString()};await save(join(root,'state.json'),state);await report(root);
  const waitStart=performance.now();if(number>1)await sleep(profile.backoffMs[number-2]);const retryWaitMs=number>1?performance.now()-waitStart:0;
  console.log(JSON.stringify({event:'attempt-start',index:state.nextIndex+1,...item,number}));
  const attempt=await executeAttempt(root,profile,item,directory,limits,retryWaitMs);group.attempts.push(attempt);state.pending=null;await save(join(root,'state.json'),state);await report(root);
  console.log(JSON.stringify({event:'attempt-end',index:state.nextIndex+1,...item,number,success:attempt.success,retryable:attempt.transportRetryable,errors:attempt.evidenceErrors,seconds:attempt.elapsedMs/1000,tokens:attempt.tokens,proposed:attempt.proposedPacketCount,executed:attempt.executedPacketCount,writable:attempt.plannedWritableCount,changed:attempt.changedTargetCount}));
 }}catch(e){state.stopReason='orchestrator-error';state.error=String(e);throw e;}
 finally{await save(join(root,'state.json'),state);await report(root);await rm(join(root,'runner.lock'),{recursive:true});}
 if(state.stopReason)throw new Error(state.stopReason);
}
export async function report(root) {
 const profile=await load(join(root,'profile.json')),state=await load(join(root,'state.json'));
 const rows=state.groups.filter(g=>g.finalized).map(g=>{const {budget,...last}=g.attempts.at(-1),a=retryObservation(g.attempts);return {...last,...a,completionMs:a.success?a.elapsedMs:null,outcome:g.outcome,plannerMs:g.attempts.reduce((n,a)=>n+a.plannerMs,0),plannerCalls:g.attempts.reduce((n,a)=>n+a.plannerCalls,0),auditMs:g.attempts.reduce((n,a)=>n+a.auditMs,0),attemptDirectories:g.attempts.map(a=>a.directory)};});
 const result={format:1,profileHash:state.profileHash,model:profile.model,thinking:profile.thinking,complete:state.nextIndex===profile.plan.length&&!state.stopReason&&!state.pending,completedRuns:rows.length,plannedRuns:profile.plan.length,stopReason:state.stopReason,pending:state.pending,profile,rows,summary:summarizeSemantic(profile.cases,rows),accounting:retryAccounting(state.groups.flatMap(g=>g.attempts)),preparationElapsedMs:state.preparationElapsedMs,accountingScope:'Settled attempts only. Pending work has additional unaccounted usage. Unknown reservations are admission charges, not actual usage.'};
 await save(join(root,'report.json'),result);
 let md=`# Semantic decomposition pilot\n\n${result.complete?'Complete':state.stopReason??'Running'}: ${rows.length}/${profile.plan.length}. DeepSeek Flash thinking enabled, upper 0, no task deadline.\n\n| Method | Valid | Success | Median completion s | Known tokens | Total tokens |\n| --- | ---: | ---: | ---: | ---: | ---: |\n`;
 for(const [m,s] of Object.entries(result.summary.overall.methods))md+=`| ${m} | ${s.observed} | ${s.successes} | ${s.medianCompletionMs===null?'—':(s.medianCompletionMs/1000).toFixed(2)} | ${s.knownTokens} | ${s.tokens??'unknown'} |\n`;
 md+='\nPlanner/execution/retries/backoff included; independent audits and preparation excluded. Both-success time comparisons and planner choices:\n\n```json\n'+JSON.stringify({comparisons:result.summary.overall.comparisons,planning:result.summary.overall.planning},null,2)+'\n```\n';
 await writeFile(join(root,'report.md'),md);return result;
}
export async function audit(root) {
 const {profile,state}=await bindings(root);assert.ok(state.groups.slice(0,state.nextIndex).every(g=>g.finalized));assert.ok(state.groups.slice(state.nextIndex).every(g=>!g.finalized));
 for(const g of state.groups)for(const a of g.attempts){const d=a.directory;
  for(const [file,h] of [['row.json',a.rowHash],['result.json',a.resultHash],['artifacts.json',a.candidateDigest],['independent-check.json',a.independentHash]])assert.equal(hash(await readFile(join(d,file))),h);
  const row=await load(join(d,'row.json'));for(const [k,v] of Object.entries(row))assert.deepEqual(a[k],v);
  const run=await load(join(d,'result.json')),independent=await load(join(d,'independent-check.json')),c=profile.cases.find(c=>c.id===a.id),{f,repository}=await fixture(root,c);
  const evidence=await semanticReceiptAudit(d,a.method,run,{...BASE,...profile.limits,repository,task:f.task,outputDirectory:d},independent);
  assert.deepEqual(evidence.evidenceErrors,a.evidenceErrors);assert.equal(evidence.transportRetryable,a.transportRetryable);assert.deepEqual(run.budget,a.budget);assert.equal(a.success,run.success&&independent.ok&&!evidence.evidenceErrors.length);
 }
 const result=await report(root);await save(join(root,'audit.json'),result);return result;
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){const [command,root]=process.argv.slice(2);if(!['prepare','run','report','audit'].includes(command)||!root||process.argv.length!==4)throw new Error('Usage: node scripts/semantic-decomposition-pilot.mjs prepare|run|report|audit DIRECTORY');
 const result=await ({prepare,run,report,audit}[command])(resolve(root));if(['report','audit'].includes(command))console.log(JSON.stringify({complete:result.complete,completedRuns:result.completedRuns,plannedRuns:result.plannedRuns,stopReason:result.stopReason,accounting:result.accounting}));}
