import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir,rename,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {buildLazyCases,lazyOrder,summarizeLazy,structure,hash,METHODS} from '../experiments/lazy-benchmark.ts';
import {retryAccounting,retryAction,retryObservation} from '../experiments/transport-retry.ts';
import {materializeSyntheticTask,preflightSyntheticTask} from './synthetic-corpus.ts';
import {runPacketRepository} from '../src/repo-packet-run.ts';
import {runLazyRepository} from '../src/repo-lazy-run.ts';
import {captureRepository} from '../src/repo-files.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
import {auditLazyAttempt} from './lazy-benchmark-audit.mjs';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const save=async(p,v)=>{await writeFile(p+'.tmp',JSON.stringify(v,null,2)+'\n');await rename(p+'.tmp',p);};
const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
async function sources(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?sources(join(dir,e.name)):[join(dir,e.name)]))).flat();}
export const LIMITS={maxCalls:32,maxTokens:2000000,reserveTokensPerCall:200000,maxTokensPerCall:64000,timeoutMs:600000};
const BASE={runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'enabled',maxMetaCalls:0,concurrency:3,maxRounds:64};
async function bindings(root,current=true){const profile=await load(join(root,'profile.json')),state=await load(join(root,'state.json'));
 assert.equal(hash(await readFile(join(root,'profile.json'))),state.profileHash);
 for(const [p,h]of Object.entries(profile.runtimeHashes)){assert.equal(hash(await readFile(join(root,'runtime',p))),h,'saved runtime drift: '+p);if(current)assert.equal(hash(await readFile(p)),h,'runtime drift: '+p);}
 assert(Number.isInteger(state.nextIndex)&&state.nextIndex>=0&&state.nextIndex<=profile.plan.length);assert(state.groups.length>=state.nextIndex&&state.groups.length<=state.nextIndex+1);assert(state.groups.slice(0,state.nextIndex).every(g=>g.finalized));assert.deepEqual(state.groups.map(g=>g.item),profile.plan.slice(0,state.groups.length));return {profile,state};
}
async function fixture(root,c){
 const repository=join(root,'fixtures',c.id),f=await load(join(root,'private',c.id+'.json'));assert.deepEqual(f.hashes,c.hashes);assert.equal(hash(JSON.stringify(f)),c.fixtureDigest,'private fixture drift');
 assert.equal(git(repository,['status','--porcelain']),'','fixture dirty');assert.deepEqual(await load(join(repository,'task.json')),f.task);
 for(const [p,s]of Object.entries(f.files))assert.equal(await readFile(join(repository,p),'utf8'),s);return {f,repository};
}
export async function prepare(root){
 const start=performance.now(),built=buildLazyCases(),lock=await load('experiments/synthetic-corpus-v1-lock.json');
 for(const c of built.filter(c=>c.group==='local'))assert.deepEqual(c.fixture.hashes,lock.cases.find(x=>x.id===c.id).hashes);
 await mkdir(root);await mkdir(join(root,'private'));await mkdir(join(root,'preflight'));
 let i=0;await Promise.all(Array.from({length:4},async()=>{while(i<built.length){const c=built[i++],f=c.fixture;
  let check;try{check=await load(join(dirname(root),'preflight-v1',c.id+'.json'));assert.deepEqual(check.hashes,f.hashes);}catch{check=await preflightSyntheticTask(f);}
  await save(join(root,'preflight',c.id+'.json'),check);assert(check.ok,JSON.stringify({id:c.id,errors:check.errors}));
  await save(join(root,'private',c.id+'.json'),f);const repository=await materializeSyntheticTask(f,join(root,'fixtures',c.id));git(repository,['init','-q']);git(repository,['add','.']);git(repository,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Frozen lazy benchmark input']);
  console.log(JSON.stringify({event:'prepared',id:c.id}));
 }}));
 const paths=[...await sources('src'),...await sources('experiments'),...await sources('scripts'),'package.json','package-lock.json'];
 const runtimeHashes={};for(const p of paths){const bytes=await readFile(p);runtimeHashes[p]=hash(bytes);const dest=join(root,'runtime',p);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,bytes);}
 const cases=built.map(c=>({id:c.id,group:c.group,fixtureDigest:hash(JSON.stringify(c.fixture)),targetCount:c.fixture.task.files.length,...structure(c.fixture.task),hashes:c.fixture.hashes})),plan=lazyOrder(cases);
 const profile={format:1,createdAt:new Date().toISOString(),baseCommit:git('.',['rev-parse','HEAD']).trim(),runtimeHashes,model:'opencode-go/deepseek-flash',thinking:'enabled',upperCalls:0,taskDeadlineMs:null,limits:LIMITS,base:BASE,methods:METHODS,taskConcurrency:1,repeats:1,cases,plan,seriesAdmissionTokens:plan.length*LIMITS.maxTokens,maxRetries:3,backoffMs:[2000,4000,8000],
  selection:'local: first six original dev families, v00 unchanged. independent: cyclic triples of their v00 under separate directories, all function bodies scaffolded. coupled: same family, 16 targets, connected graph, greatest depth then smallest ID, scaffolded. No private defect hints passed to solver.',
  adoption:{quality:'no fewer successes than either reference in any stratum; list discordant pairs',medianLazyOverEachReference:{local:1.10,independent:0.90,coupled:1.10},missing:'defer if any condition unavailable',meaning:'necessary for follow-up, not sufficient for a new default on this small single-repeat sample'},
  retry:'Only transient transport faults restart baseline within shared condition call/token caps, at most three retries. Unknown reservations are charged for admission, never called actual cost. Quality failures are terminal.',
  timing:'Includes execution checks, retries and backoff. Independent audits, preparation and operator pauses excluded. No task deadline.',
  limitations:'Exploratory dev reuse, overlapping component families, one repeat. Different workloads across strata; not an ablation of graph alone. New root differs from packet-all in prompts and output protocol. Evaluation and Manager untouched.'};
 await save(join(root,'profile.json'),profile);await save(join(root,'state.json'),{format:1,profileHash:hash(await readFile(join(root,'profile.json'))),nextIndex:0,groups:[],pending:null,stopReason:null,preparationElapsedMs:performance.now()-start});await report(root);return profile;
}
export async function executeAttempt(root,profile,item,directory,limits,retryWaitMs=0,caller){
 const c=profile.cases.find(c=>c.id===item.id),{f,repository}=await fixture(root,c),options={...BASE,...limits,repository,task:f.task,outputDirectory:directory};
 const before=await captureRepository(repository,f.task),start=performance.now(),startedAt=new Date().toISOString();
 const run=item.method==='packet-all'?await runPacketRepository({...options,packetSize:'all'},caller):await runLazyRepository({...options,lazyChildren:item.method==='root-only'?0:2},caller);
 const elapsedMs=performance.now()-start,auditStart=performance.now(),bytes=await readFile(join(directory,'artifacts.json')),artifacts=JSON.parse(bytes);
 const independent=await runRepoChecks(before,artifacts,[...f.task.files.flatMap(t=>t.checks),...f.task.checks],join(directory,'independent'));await save(join(directory,'independent-check.json'),independent);await fixture(root,c);
 let evidence;try{evidence=await auditLazyAttempt(directory,item.method,run,options,independent);}catch(e){evidence={transportRetryable:false,evidenceErrors:[String(e)]};}
 const success=run.success&&independent.ok&&!evidence.evidenceErrors.length;
 const row={...item,startedAt,success,qualityPass:independent.ok,termination:run.termination,elapsedMs,completionMs:success?elapsedMs:null,retryWaitMs,auditMs:performance.now()-auditStart,budget:run.budget,...evidence,knownTokens:run.budget.observedTokens,tokens:run.budget.unknownUsageCalls?null:run.budget.observedTokens,calls:run.budget.calls.length,children:run.children?.length??0,forkRequests:run.metrics?.forkRequests??0,overlapMs:run.metrics?.rootChildOverlapMs??0,metrics:run.metrics??null,changedTargetCount:f.task.files.filter(f=>artifacts[f.path]!==before.initialTargets[f.path]).length,
  candidateDigest:hash(bytes),resultHash:hash(await readFile(join(directory,'result.json'))),independentHash:hash(await readFile(join(directory,'independent-check.json')))};
 await save(join(directory,'row.json'),row);return {...row,directory,rowHash:hash(await readFile(join(directory,'row.json')))};
}
export async function run(root){
 assert(process.env.OPENCODE_GO_API_KEY,'OPENCODE_GO_API_KEY required');const {profile,state}=await bindings(root);assert.equal(state.pending,null);assert.equal(state.stopReason,null);await mkdir(join(root,'runner.lock'));
 try{while(state.nextIndex<profile.plan.length){await bindings(root);const item=profile.plan[state.nextIndex];let group=state.groups[state.nextIndex];if(!group){group={item,attempts:[],finalized:false};state.groups.push(group);}
  const action=retryAction(group.attempts,profile.limits,profile.maxRetries);
  if(action!=='run'){if(action==='stop'){state.stopReason='non-transient-infrastructure';break;}group.finalized=true;group.outcome=action;state.nextIndex++;await save(join(root,'state.json'),state);await report(root);continue;}
  const spent=retryAccounting(group.attempts),limits={...profile.limits,maxCalls:profile.limits.maxCalls-spent.calls,maxTokens:profile.limits.maxTokens-spent.chargedTokens};
  const number=group.attempts.length+1,directory=join(root,'runs',item.id,item.method,'attempt-'+number);state.pending={index:state.nextIndex,item,number,directory,limits};await save(join(root,'state.json'),state);await report(root);
  const waitStart=performance.now();if(number>1)await sleep(profile.backoffMs[number-2]);const retryWaitMs=number>1?performance.now()-waitStart:0;
  console.log(JSON.stringify({event:'start',index:state.nextIndex+1,...item,number}));
  const attempt=await executeAttempt(root,profile,item,directory,limits,retryWaitMs);group.attempts.push(attempt);state.pending=null;await save(join(root,'state.json'),state);await report(root);
  console.log(JSON.stringify({event:'end',index:state.nextIndex+1,...item,number,success:attempt.success,retryable:attempt.transportRetryable,errors:attempt.evidenceErrors,seconds:attempt.elapsedMs/1000,tokens:attempt.tokens,children:attempt.children,forkRequests:attempt.forkRequests}));
 }}catch(e){state.stopReason='orchestrator-error';state.error=String(e);throw e;}finally{await save(join(root,'state.json'),state);await report(root);await rm(join(root,'runner.lock'),{recursive:true});}
 if(state.stopReason)throw new Error(state.stopReason);
}
export async function report(root){
 const profile=await load(join(root,'profile.json')),state=await load(join(root,'state.json'));
 const rows=state.groups.filter(g=>g.finalized).map(g=>{const {budget,...last}=g.attempts.at(-1),a=retryObservation(g.attempts);return {...last,...a,completionMs:a.success?a.elapsedMs:null,outcome:g.outcome,children:g.attempts.reduce((n,a)=>n+a.children,0),forkRequests:g.attempts.reduce((n,a)=>n+a.forkRequests,0),overlapMs:g.attempts.reduce((n,a)=>n+a.overlapMs,0),attemptDirectories:g.attempts.map(a=>a.directory)};});
 const result={format:1,profileHash:state.profileHash,complete:state.nextIndex===profile.plan.length&&!state.stopReason&&!state.pending,completedRuns:rows.length,plannedRuns:profile.plan.length,stopReason:state.stopReason,pending:state.pending,profile,rows,summary:summarizeLazy(rows),accounting:retryAccounting(state.groups.flatMap(g=>g.attempts)),preparationElapsedMs:state.preparationElapsedMs};await save(join(root,'report.json'),result);return result;
}
export async function audit(root){
 const {profile,state}=await bindings(root);assert(state.groups.slice(0,state.nextIndex).every(g=>g.finalized));
 for(const g of state.groups)for(const a of g.attempts){
  for(const [p,h]of [['row.json',a.rowHash],['result.json',a.resultHash],['artifacts.json',a.candidateDigest],['independent-check.json',a.independentHash]])assert.equal(hash(await readFile(join(a.directory,p))),h);
  const row=await load(join(a.directory,'row.json'));for(const [k,v]of Object.entries(row))assert.deepEqual(a[k],v);
  const {f,repository}=await fixture(root,profile.cases.find(c=>c.id===a.id)),run=await load(join(a.directory,'result.json')),independent=await load(join(a.directory,'independent-check.json'));
  const evidence=await auditLazyAttempt(a.directory,a.method,run,{...BASE,...profile.limits,repository,task:f.task,outputDirectory:a.directory},independent);assert.deepEqual(evidence.evidenceErrors,a.evidenceErrors);assert.equal(evidence.transportRetryable,a.transportRetryable);assert.deepEqual(run.budget,a.budget);
 }
 const result=await report(root);await save(join(root,'audit.json'),result);return result;
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){const [command,root]=process.argv.slice(2);if(!['prepare','run','report','audit'].includes(command)||!root)throw new Error('Usage: node scripts/lazy-benchmark.mjs prepare|run|report|audit DIRECTORY');const r=await ({prepare,run,report,audit}[command])(resolve(root));if(r)console.log(JSON.stringify({complete:r.complete,completed:r.completedRuns,planned:r.plannedRuns,accounting:r.accounting}));}
