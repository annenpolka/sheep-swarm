import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {digest,summarizeSweep} from '../experiments/packet-sweep.ts';
import {retryAccounting,retryAction,retryObservation,transientReceipt} from '../experiments/transport-retry.ts';
import {extractTokenUsage} from '../src/cost-estimate.ts';
import {audit as sourceAudit,packetReceiptAudit} from './packet-sweep.mjs';
import {receiptAudit} from './synthetic-paired-benchmark.mjs';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const save=async(p,x)=>{await writeFile(p+'.tmp',JSON.stringify(x,null,2)+'\n');await rename(p+'.tmp',p);};
const ownFiles=['scripts/packet-sweep-retry.mjs','experiments/transport-retry.ts','experiments/packet-sweep.ts','scripts/packet-sweep.mjs','scripts/synthetic-paired-benchmark.mjs','src/cost-estimate.ts'];
async function bindings(root) {
 const profile=await load(join(root,'profile.json')),state=await load(join(root,'state.json'));
 assert.equal(digest(await readFile(join(root,'profile.json'))),state.profileHash);
 assert.equal(digest(await readFile(join(profile.sourceRoot,'profile.json'))),profile.sourceProfileHash);
 assert.equal(digest(await readFile(join(profile.sourceRoot,'series.json'))),profile.sourceSeriesHash);
 for(const [p,h] of Object.entries(profile.controllerHashes))assert.equal(digest(await readFile(p)),h,'controller drift: '+p);
 const source=await load(join(profile.sourceRoot,'profile.json'));
 for(const [p,h] of Object.entries(source.runtimeHashes))assert.equal(digest(await readFile(join(profile.sourceRoot,'runtime',p))),h,'frozen solver drift: '+p);
 return {profile,state,source};
}
async function frozenModules(sourceRoot) {
 const get=p=>import(pathToFileURL(join(sourceRoot,'runtime',p)).href);
 const [single,packets,files,checks,corpus]=await Promise.all(['experiments/repository-single.ts','src/repo-packet-run.ts','src/repo-files.ts','src/repo-checks.ts','experiments/synthetic-corpus/index.ts'].map(get));
 return {single,packets,files,checks,corpus};
}
async function checkFixture(profile,c,modules) {
 const f=modules.corpus.buildSyntheticTask(c.id),repository=join(profile.sourceRoot,'fixtures',c.id);
 assert.deepEqual(f.hashes,c.hashes);
 assert.equal(execFileSync('git',['status','--porcelain'],{cwd:repository,encoding:'utf8'}),'');
 assert.deepEqual(await load(join(repository,'task.json')),f.task);
 for(const [p,s] of Object.entries(f.files))assert.equal(await readFile(join(repository,p),'utf8'),s);
 return {f,repository};
}
/** Inspect raw failures, not hidden-check diagnostics, to decide transport retry. */
export async function inspectAttempt(directory,row,run) {
 let retryable=0;const problems=[];
 for(const call of run.budget.calls) {
  assert.equal(call.status,'settled','unfinished call');
  const receipt=await load(join(directory,call.callId+'.json')),tr=receipt.transcript,u=extractTokenUsage(receipt);
  const lower=(u.inputTokens??0)+(u.outputTokens??0);
  assert.equal(call.knownTokensLower,lower,'receipt lower bound differs from ledger');
  if(call.tokens!==null){assert.equal(call.tokens,lower);assert.equal(u.partial,false);}
  if(transientReceipt(receipt)){retryable++;continue;}
  if(call.tokens===null||receipt.requestedModel!=='deepseek-flash'||tr?.effectiveModelEvidence!=='deepseek-flash'||tr?.thinking!=='enabled')problems.push(call.callId+': non-transport evidence fault');
  if(receipt.error&&!['malformed-output'].includes(receipt.error))problems.push(call.callId+': non-transient error');
 }
 const independent=await load(join(directory,'independent-check.json'));
 const checks=[...run.verifications,independent];
 const transportRetryable=retryable>0&&!problems.length&&['transport-failure','unknown-usage'].includes(run.termination)&&
  !checks.some(c=>c.executionFailure||c.checks.some(x=>x.timedOut||x.signal!==null))&&run.budget.reservationOverruns===0;
 return {...row,budget:run.budget,directory,transportRetryable,receiptProblems:problems,retryWaitMs:row.retryWaitMs??0,
  resultHash:digest(await readFile(join(directory,'result.json'))),rowHash:digest(await readFile(join(directory,'row.json')))};
}
export async function prepare(sourceRoot,root) {
 sourceRoot=resolve(sourceRoot);root=resolve(root);
 await sourceAudit(sourceRoot);
 const source=await load(join(sourceRoot,'profile.json')),previous=await load(join(sourceRoot,'series.json'));
 assert.equal(previous.inFlight,null);assert.equal(previous.stopReason,'evidence-stop');assert.ok(previous.results.length);
 const groups=[];
 for(const row of previous.results) {
  const directory=join(sourceRoot,'runs',row.id,row.method),run=await load(join(directory,'result.json'));
  const attempt=await inspectAttempt(directory,row,run);
  if(row.evidenceErrors.length)assert.equal(attempt.transportRetryable,true,'only a settled transient transport stop can continue');
  groups.push({item:source.plan[groups.length],attempts:[{...attempt,inherited:true}],finalized:!row.evidenceErrors.length});
 }
 assert.equal(groups.slice(0,-1).every(g=>g.finalized),true);assert.equal(groups.at(-1).finalized,false);
 const controllerHashes={};for(const p of ownFiles)controllerHashes[p]=digest(await readFile(p));
 await mkdir(root);
 const profile={format:1,sourceRoot,sourceProfileHash:digest(await readFile(join(sourceRoot,'profile.json'))),sourceSeriesHash:digest(await readFile(join(sourceRoot,'series.json'))),
  controllerHashes,maxRetries:3,backoffMs:[2000,4000,8000],createdAt:new Date().toISOString(),
  policy:'Retry the whole condition for transient transport failures; retain unknown usage and charge its reservation; shared per-condition call/token caps; exhausted transport conditions remain unavailable and the next condition runs.',
  timing:'Active execution includes failed attempts, checks and retry waits. The one condition recovered across an operator pause is excluded from primary timing pairs. Historical pause is recorded separately.',
  model:source.model,thinking:source.thinking,taskDeadlineMs:null,upperCalls:0};
 await save(join(root,'profile.json'),profile);
 const state={format:1,profileHash:digest(await readFile(join(root,'profile.json'))),nextIndex:groups.length-1,groups,pending:null,stopReason:null};
 await save(join(root,'state.json'),state);await report(root);
 console.log(JSON.stringify({prepared:true,inheritedValid:state.nextIndex,remaining:source.plan.length-state.nextIndex,maxRetries:profile.maxRetries}));
}
async function executeAttempt(profile,source,modules,item,directory,limits,retryWaitMs) {
 const c=source.cases.find(c=>c.id===item.id),{f,repository}=await checkFixture(profile,c,modules);
 const started=performance.now(),startedAt=new Date().toISOString(),options={...limits,repository,task:f.task,outputDirectory:directory};
 const run=item.method==='legacy-single'?await modules.single.runSingleRepository(options):await modules.packets.runPacketRepository({...options,runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'enabled',maxMetaCalls:0,concurrency:source.packet.concurrency,maxRounds:source.packet.maxRounds,packetSize:item.packetSize});
 const elapsedMs=performance.now()-started,auditStarted=performance.now(),evidenceErrors=[];
 const bytes=await readFile(join(directory,'artifacts.json')),artifacts=JSON.parse(bytes);
 const independent=await modules.checks.runRepoChecks(await modules.files.captureRepository(repository,f.task),artifacts,[...f.task.files.flatMap(t=>t.checks),...f.task.checks],join(directory,'independent'));
 await save(join(directory,'independent-check.json'),independent);await checkFixture(profile,c,modules);
 let usage=null;try{usage=item.method==='legacy-single'?await receiptAudit(directory,'single',run,f.task):await packetReceiptAudit(directory,run,f.task,c.packetPlans[item.packetSize]);}catch(e){evidenceErrors.push('receipt: '+String(e));}
 const verifications=[...run.verifications,independent],commands=verifications.flatMap(v=>v.checks);
 if(run.infrastructureFailure||verifications.some(v=>v.executionFailure||v.checks.some(x=>x.timedOut||x.signal!==null)))evidenceErrors.push('provider or verification infrastructure');
 const success=run.success&&independent.ok&&!evidenceErrors.length;
 const row={...item,family:c.family,targetCount:c.targetCount,topology:c.topology,dependencyDepth:c.dependencyDepth,startedAt,
  success,qualityPass:independent.ok,elapsedMs,completionMs:success?elapsedMs:null,retryWaitMs,auditMs:performance.now()-auditStarted,
  tokens:usage?.tokens??null,knownTokens:run.budget.observedTokens,unknownUsageCalls:run.budget.unknownUsageCalls,usage,calls:run.calls.length,upperCalls:0,evidenceErrors,
  termination:run.termination,packetCount:item.method==='legacy-single'?1:run.plan.packets.length,maxConcurrentModelCalls:run.maxConcurrentModelCalls??1,
  nonAcceptedProposals:run.calls.filter(c=>!['committed','public-checks-passed'].includes(c.outcome)).length,
  modelCallDurationSumMs:run.calls.reduce((n,c)=>n+c.durationMs,0),verificationCommands:commands.length,verificationDurationSumMs:commands.reduce((n,c)=>n+c.durationMs,0),candidateDigest:digest(bytes)};
 await save(join(directory,'row.json'),row);
 const attempt=await inspectAttempt(directory,row,run);
 if(independent.executionFailure||independent.checks.some(x=>x.timedOut||x.signal!==null))attempt.transportRetryable=false;
 return {...attempt,inherited:false};
}
export async function run(root) {
 assert.ok(process.env.OPENCODE_GO_API_KEY,'OPENCODE_GO_API_KEY required');
 let {profile,state,source}=await bindings(root);
 assert.equal(state.pending,null,'uncertain in-flight attempt cannot automatically resume');assert.equal(state.stopReason,null,'non-transient stop cannot resume');
 await mkdir(join(root,'runner.lock'));
 try {
  const modules=await frozenModules(profile.sourceRoot);
  while(state.nextIndex<source.plan.length) {
   await bindings(root);
   const item=source.plan[state.nextIndex];let group=state.groups[state.nextIndex];
   if(!group){group={item,attempts:[],finalized:false};state.groups.push(group);}
   assert.deepEqual(group.item,item);
   const action=retryAction(group.attempts,source.limits,profile.maxRetries);
   if(action!=='run') {
    if(action==='stop'){state.stopReason='non-transient-infrastructure';break;}
    group.finalized=true;group.outcome=action;state.nextIndex++;
    await save(join(root,'state.json'),state);await report(root);continue;
   }
   const spent=retryAccounting(group.attempts),all=retryAccounting(state.groups.flatMap(g=>g.attempts));
   const limits={...source.limits,maxCalls:source.limits.maxCalls-spent.calls,maxTokens:source.limits.maxTokens-spent.chargedTokens};
   if(all.chargedTokens+limits.maxTokens>source.seriesAdmissionTokens){state.stopReason='series-admission';break;}
   const number=group.attempts.length+1,directory=join(root,'runs',item.id,item.method,'attempt-'+number);
   state.pending={index:state.nextIndex,item,number,directory,startedAt:new Date().toISOString(),limits};await save(join(root,'state.json'),state);await report(root);
   const waitStarted=performance.now();if(number>1)await sleep(profile.backoffMs[number-2]);const retryWaitMs=number>1?performance.now()-waitStarted:0;
   console.log(JSON.stringify({event:'attempt-start',index:state.nextIndex+1,id:item.id,method:item.method,attempt:number}));
   const attempt=await executeAttempt(profile,source,modules,item,directory,limits,retryWaitMs);group.attempts.push(attempt);
   state.pending=null;await save(join(root,'state.json'),state);await report(root);
   console.log(JSON.stringify({event:'attempt-end',index:state.nextIndex+1,id:item.id,method:item.method,attempt:number,success:attempt.success,retryable:attempt.transportRetryable,tokens:attempt.tokens,seconds:attempt.elapsedMs/1000}));
  }
 } catch(e){state.stopReason='orchestrator-error';state.error=String(e);throw e;}
 finally{await save(join(root,'state.json'),state);await report(root);await rm(join(root,'runner.lock'),{recursive:true});}
 if(state.stopReason)throw new Error(state.stopReason);
}
export async function report(root,persist=true) {
 const profile=await load(join(root,'profile.json')),state=await load(join(root,'state.json')),source=await load(join(profile.sourceRoot,'profile.json'));
 const rows=state.groups.filter(g=>g.finalized).map(g=>{
  const last=g.attempts.at(-1),a=retryObservation(g.attempts);
  const historicalRecovery=g.attempts.some(x=>x.inherited)&&g.attempts.some(x=>!x.inherited);
  const firstNew=g.attempts.find(x=>!x.inherited),prior=g.attempts.filter(x=>x.inherited).at(-1);
  const operatorPauseMs=historicalRecovery?Math.max(0,Date.parse(firstNew.startedAt)-Date.parse(prior.startedAt)-prior.elapsedMs):0;
  const overhead=Object.fromEntries(['auditMs','nonAcceptedProposals','modelCallDurationSumMs','verificationCommands','verificationDurationSumMs'].map(k=>[k,g.attempts.reduce((n,x)=>n+(x[k]??0),0)]));
  const {budget,usage,...lastRow}=last;
  return {...lastRow,...a,...overhead,...g.item,finalAttemptBudget:budget,finalAttemptUsage:usage,completionMs:a.success?a.elapsedMs:null,historicalRecovery,operatorPauseMs,attemptDirectories:g.attempts.map(a=>a.directory),outcome:g.outcome??'done'};
 });
 const accounting=retryAccounting(state.groups.flatMap(g=>g.attempts));
 const result={format:1,complete:state.nextIndex===source.plan.length&&!state.stopReason&&!state.pending,completedRuns:rows.length,plannedRuns:source.plan.length,
  stopReason:state.stopReason,pending:state.pending,model:source.model,thinking:source.thinking,profile,rows,accounting,
  accountingScope:'Completed attempts only; any pending attempt is additional unaccounted work.',
  qualitySummary:summarizeSweep(source.cases,rows),summary:summarizeSweep(source.cases,rows.filter(r=>!r.historicalRecovery)),
  summaryDefinition:'Primary timing excludes the operator-interrupted recovery condition. Quality includes it if independently accepted. Tokens remain null if any prior attempt is unknown. Unknown reservation charges are admission accounting, not actual usage.'};
 if(!persist)return result;
 await save(join(root,'report.json'),result);
 let md=`# 通信失敗の再試行を含むdev比較\n\n状態: ${result.complete?'完了':state.stopReason??'実行中'}。${rows.length}/${source.plan.length}条件を処理済み。DeepSeek Flash thinking有効、上位0、packet C4、task締切なし。\n\n終了した試行のcall ${accounting.calls}、既知token下限${accounting.knownTokens}、総tokens ${accounting.totalTokens??'不明'}、使用量不明${accounting.unknownUsageCalls}call。予算上の控除${accounting.chargedTokens}は実使用量ではない。実行中試行の消費は未計上。利用不能条件${rows.filter(r=>r.outcome==='unavailable').length}件。\n\n| 方式 | 有効観測 | 成功 |\n| --- | ---: | ---: |\n`;
 for(const [m,v] of Object.entries(result.qualitySummary.overall.methods))md+=`| ${m} | ${v.cases} | ${v.successes} |\n`;
 md+='\n## 一括処理との速度比較\n\n手動停止を挟んだ回復条件を除外。同値観測は勝敗へ数えない。時間は失敗試行と再試行待機も含む。\n\n| 条件 | 有効組 | allが速い | 分割が速い | all/分割 時間比中央値 |\n| --- | ---: | ---: | ---: | ---: |\n';
 for(const [m,v] of Object.entries(result.summary.overall.pairs['packet-all']))md+=`| ${m} | ${v.completePairs} | ${v.referenceFaster} | ${v.methodFaster} | ${v.medianReferenceOverMethod?.toFixed(3)??'—'} |\n`;
 md+='\nraw試行と失敗履歴は各attemptDirectoryへ保存する。旧系列の記録・budget lockは変更しない。通信失敗のみ最大3回再試行し、継続して失敗する条件は利用不能として次へ進む。品質失敗は再抽選しない。\n';
 await writeFile(join(root,'report.md'),md);return result;
}
export async function audit(root) {
 const {profile,state,source}=await bindings(root),modules=await frozenModules(profile.sourceRoot);
 assert.deepEqual(state.groups.map(g=>g.item),source.plan.slice(0,state.groups.length));
 assert.ok(state.groups.slice(0,state.nextIndex).every(g=>g.finalized));
 assert.ok(state.groups.slice(state.nextIndex).every(g=>!g.finalized));
 for(const group of state.groups)for(const a of group.attempts) {
  assert.equal(digest(await readFile(join(a.directory,'result.json'))),a.resultHash);
  assert.equal(digest(await readFile(join(a.directory,'row.json'))),a.rowHash);
  const row=await load(join(a.directory,'row.json')),run=await load(join(a.directory,'result.json'));
  for(const [k,v] of Object.entries(row))assert.deepEqual(a[k],v,'saved row drift: '+k);
  const inspected=await inspectAttempt(a.directory,row,run);assert.deepEqual(inspected.budget,a.budget);assert.equal(inspected.transportRetryable,a.transportRetryable);
  const c=source.cases.find(c=>c.id===a.id),{f}=await checkFixture(profile,c,modules);
  assert.equal(digest(await readFile(join(a.directory,'artifacts.json'))),a.candidateDigest);
  if(!a.evidenceErrors.length) {
   const usage=a.method==='legacy-single'?await receiptAudit(a.directory,'single',run,f.task):await packetReceiptAudit(a.directory,run,f.task,c.packetPlans[a.packetSize]);
   assert.deepEqual(usage,a.usage);const independent=await load(join(a.directory,'independent-check.json'));assert.equal(a.success,run.success&&independent.ok);
  }
 }
 return report(root,false);
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){const [command,a,b]=process.argv.slice(2);
 if(command==='prepare'&&a&&b)await prepare(a,b);
 else if(['run','report','audit'].includes(command)&&a&&!b){const r=await ({run,report:r=>report(r,false),audit}[command])(resolve(a));if(r)console.log(JSON.stringify({complete:r.complete,completedRuns:r.completedRuns,accounting:r.accounting}));}
 else throw new Error('Usage: packet-sweep-retry.mjs prepare SOURCE NEW_DIRECTORY | run/report/audit DIRECTORY');}
