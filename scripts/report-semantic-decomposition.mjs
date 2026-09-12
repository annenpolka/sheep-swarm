import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {audit} from './semantic-decomposition-pilot.mjs';
import {compileWorkPlan} from '../src/repo-work-plan.ts';
import {semanticHash as hash} from '../experiments/semantic-decomposition.ts';
const [rootArg,prefixArg]=process.argv.slice(2);
if(!rootArg||!prefixArg||process.argv.length!==4)throw new Error('Usage: node scripts/report-semantic-decomposition.mjs COMPLETE_ROOT OUTPUT_PREFIX');
const root=resolve(rootArg),prefix=resolve(prefixArg),before=await readFile(root+'/state.json');
const state=JSON.parse(before);assert.equal(state.pending,null);assert.equal(state.stopReason,null);
const report=await audit(root);report.publication={stateHash:hash(before),reporterHash:hash(await readFile('scripts/report-semantic-decomposition.mjs')),plotterHash:hash(await readFile('scripts/plot-semantic-decomposition.py'))};assert.ok(report.complete,'report requires all 72 conditions');assert.equal(hash(await readFile(root+'/state.json')),hash(before),'state changed during audit');
for(const row of report.rows) {
 row.runtimeVerificationCommands=0;row.runtimeVerificationDurationSumMs=0;row.independentVerificationCommands=0;row.workerModelDurationSumMs=0;row.plannerKnownTokens=0;row.plannerUnknownUsageCalls=0;
 for(const dir of row.attemptDirectories) {
  const run=JSON.parse(await readFile(dir+'/result.json')),independent=JSON.parse(await readFile(dir+'/independent-check.json'));
  const worker=row.method==='planned'?run.worker:run,checks=(worker?.verifications??[]).flatMap(v=>v.checks);
  row.runtimeVerificationCommands+=checks.length;row.runtimeVerificationDurationSumMs+=checks.reduce((n,c)=>n+c.durationMs,0);row.independentVerificationCommands+=independent.checks.length;
  row.workerModelDurationSumMs+=(worker?.calls??[]).reduce((n,c)=>n+c.durationMs,0);
  for(const c of run.budget.calls.filter(c=>c.callId==='planner-1')){row.plannerKnownTokens+=c.knownTokensLower;if(c.tokens===null)row.plannerUnknownUsageCalls++;}
 }
}
report.phaseAccounting=Object.fromEntries(report.profile.methods.map(m=>{const rs=report.rows.filter(r=>r.method===m);return [m,Object.fromEntries(['plannerMs','plannerCalls','plannerKnownTokens','plannerUnknownUsageCalls','workerModelDurationSumMs','runtimeVerificationCommands','runtimeVerificationDurationSumMs','independentVerificationCommands'].map(k=>[k,rs.reduce((n,r)=>n+r[k],0)]))];}));
report.failureDiagnostics=[];
for(const row of report.rows.filter(r=>!r.success)) {
 const dir=row.attemptDirectories.at(-1),result=JSON.parse(await readFile(dir+'/result.json'));
 const entry={id:row.id,method:row.method,termination:row.termination,errors:result.errors??[],workerStarted:row.method==='planned'?Boolean(result.worker):true};
 if(row.method==='planned'&&row.termination==='invalid-plan') {
  const bytes=await readFile(dir+'/planner-1.json'),receipt=JSON.parse(bytes);entry.receiptHash=hash(bytes);entry.receiptError=receipt.error??null;
  try {const body=JSON.parse(receipt.transcript.stdout),choice=body.choices[0],value=JSON.parse(choice.message.content);entry.finishReason=choice.finish_reason;entry.unexpectedTopLevelFields=Object.keys(value).filter(k=>!['packets','untouchedPaths','rationale'].includes(k));
   const req=JSON.parse(await readFile(dir+'/planner-1.request.json')),task=JSON.parse(await readFile(dir+'/task.json'));
   const edges=JSON.parse(req.prompt.split('\n').find(s=>s.startsWith('Public dependency edges: ')).slice('Public dependency edges: '.length));
   try {const copy=Object.fromEntries(['packets','untouchedPaths','rationale'].map(k=>[k,value[k]])),compiled=compileWorkPlan(copy,task.files.map(f=>f.path),req.publicPaths,edges);
    entry.scopeValidationAfterDroppingExtraTopLevelFields={passes:true,packets:compiled.packets.length,writableTargets:compiled.packets.flatMap(p=>p.paths).length,diagnosticOnly:true,doesNotRescore:true};
   }catch(e){entry.scopeValidationAfterDroppingExtraTopLevelFields={passes:false,error:String(e),diagnosticOnly:true,doesNotRescore:true};}}
  catch {entry.outputCouldNotBeParsed=true;}
 }
 report.failureDiagnostics.push(entry);
}
const seconds=n=>n===null?'—':(n/1000).toFixed(2),fixed=n=>n===null?'—':n.toFixed(3);
await writeFile(prefix+'.json',JSON.stringify(report,null,2)+'\n');
const summary=report.summary.overall,accounting=report.accounting;
let md=`# Semantic decomposition: dev 24課題\n\n${report.completedRuns}/${report.plannedRuns}条件を完了し、receipt・候補・元fixture・固定oracleを監査した。DeepSeek Flash thinking有効、上位0、task間逐次、worker C4、task締切なし。profile hash: \`${report.profileHash}\`。実装revision: \`${report.profile.baseCommit}\`。\n\n## 品質と完了時間\n\n| 方式 | 有効観測 | 成功 | 成功時の時間中央値（秒） | call | 既知tokens | 総tokens |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n`;
for(const [m,v] of Object.entries(summary.methods))md+=`| ${m} | ${v.observed} | ${v.successes} | ${seconds(v.medianCompletionMs)} | ${v.calls} | ${v.knownTokens} | ${v.tokens??'不明'} |\n`;
md+='\nplanner・runtime受入・通信失敗試行・再試行待機を含む。独立監査と準備は別計測。失敗のcompletionはnull。\n\n| 対照 | 有効組 | 両方成功 | 対照だけ成功 | plannedだけ成功 | 対照が速い | plannedが速い | planned/対照の時間比中央値 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n';
for(const [m,v] of Object.entries(summary.comparisons))md+=`| ${m} | ${v.pairs} | ${v.bothSuccess} | ${v.referenceOnly} | ${v.plannedOnly} | ${v.referenceFaster} | ${v.plannedFaster} | ${fixed(v.medianPlannedOverReference)} |\n`;
md+='\n## 失敗の分類\n\n```json\n'+JSON.stringify(report.failureDiagnostics,null,2)+'\n```\n';
md+='\n## 作業境界の選択\n\n'+`有効plan ${summary.planning.validPlans}件。提案時1packet ${summary.planning.onePacket}件、そのうち全targetを担当する1packetは${summary.planning.allTargetsOnePacket}件。提案packet数中央値${summary.planning.medianProposedPackets}、実行packet数中央値${summary.planning.medianExecutedPackets}。担当target数中央値${summary.planning.medianWritableTargets}、実変更target数中央値${summary.planning.medianChangedTargets}。planner API call時間中央値${seconds(summary.planning.medianPlannerMs)}秒。\n\n`;
md+='| 課題 | 全target | 提案packet | 実行packet | 担当target | 実変更target | planner call秒 | 結果 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n';
for(const c of report.profile.cases){const r=report.rows.find(r=>r.id===c.id&&r.method==='planned');md+=`| ${c.id} | ${c.targetCount} | ${r.proposedPacketCount??'—'} | ${r.executedPacketCount??'—'} | ${r.plannedWritableCount??'—'} | ${r.changedTargetCount} | ${seconds(r.plannerMs)} | ${r.success?'成功':r.evidenceErrors.length?'利用不能':r.termination} |\n`;}
md+='\n## target数別の時間比較\n\n両方成功した組だけの時間比。各サイズ6課題で、単独の一般化に使わない。\n\n| target数 | 対照 | 両方成功 | 対照が速い | plannedが速い | planned/対照中央値 |\n| --- | --- | ---: | ---: | ---: | ---: |\n';
for(const [size,s] of Object.entries(report.summary.targetCount))for(const [m,v] of Object.entries(s.comparisons))md+=`| ${size} | ${m} | ${v.bothSuccess} | ${v.referenceFaster} | ${v.plannedFaster} | ${fixed(v.medianPlannedOverReference)} |\n`;
md+=`\n## 使用量と制約\n\n全試行${accounting.calls}call、既知下限${accounting.knownTokens}tokens、総tokensは${accounting.totalTokens??'不明'}。不明usage ${accounting.unknownUsageCalls}call。受付控除${accounting.chargedTokens}tokensは実使用量ではない。再試行条件${report.rows.filter(r=>r.retries>0).length}件、追加試行${report.rows.reduce((n,r)=>n+r.retries,0)}回。全条件の実行時間合計${seconds(accounting.elapsedMs)}秒、独立監査合計${seconds(report.rows.reduce((n,r)=>n+r.auditMs,0))}秒、準備${seconds(report.preparationElapsedMs)}秒。人間の作業時間・請求額は未測定。\n\n既知devから公開metadataだけで選ぶ24課題、各方式1回の探索的比較。plannerは全公開baselineを読み、workerは選択された入力とhost依存閉包を読む。入力選択と分割を含む方式比較であり、純粋な分割の因果効果ではない。1packet選択と全targetを一人で担当することは区別する。evaluationとManagerは実行していない。family・topology・dependencyDepth別の集計はJSONに保存。\n\n生の試行とprofileは\`${root}\`。結果に合わせたsolver変更や課題hash変更は行わない。\n`;
await writeFile(prefix+'.md',md);console.log(JSON.stringify({json:prefix+'.json',markdown:prefix+'.md',summary,accounting}));
