import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {audit} from './packet-sweep-retry.mjs';
import {digest,summarizeSweep} from '../experiments/packet-sweep.ts';
const [directory,prefix]=process.argv.slice(2);
if(!directory||!prefix)throw new Error('Usage: node scripts/report-packet-sweep-retry.mjs RUN_DIRECTORY OUTPUT_PREFIX');
const root=resolve(directory),load=async p=>JSON.parse(await readFile(p,'utf8'));
const before=await readFile(join(root,'state.json')),state=JSON.parse(before);
assert.equal(state.pending,null);assert.equal(state.stopReason,null);
const source=await load(join((await load(join(root,'profile.json'))).sourceRoot,'profile.json'));
assert.equal(state.nextIndex,source.plan.length,'all conditions must finish before final audit');
const start=performance.now(),r=await audit(root);assert.equal(r.complete,true);
assert.equal(digest(await readFile(join(root,'state.json'))),digest(before),'state changed during audit');
const notes=await load(join(root,'measurement-notes.json'));
const exclusions=r.rows.filter(row=>row.historicalRecovery||notes.timingExclusions.some(e=>e.id===row.id&&e.method===row.method)).map(row=>({id:row.id,method:row.method,reason:row.historicalRecovery?'operator-interrupted recovery':notes.timingExclusions.find(e=>e.id===row.id&&e.method===row.method).reason}));
for(const e of notes.timingExclusions)assert.equal(r.rows.filter(row=>row.id===e.id&&row.method===e.method).length,1);
const timed=r.rows.filter(row=>!exclusions.some(e=>e.id===row.id&&e.method===row.method));
const retried=r.rows.filter(row=>row.retries>0).map(row=>({id:row.id,method:row.method,retries:row.retries,success:row.success,elapsedMs:row.elapsedMs,knownTokens:row.knownTokens,tokens:row.tokens,unknownUsageCalls:row.unknownUsageCalls}));
const attempts=state.groups.flatMap(g=>g.attempts);
const report={...r,rows:r.rows.map(({finalAttemptBudget,...row})=>row),summary:summarizeSweep(source.cases,timed),timingExclusions:exclusions,measurementNotes:notes,
 plotRunUnit:'conditions',trialDescription:'One scheduled observation per condition; transport retries included',
 sourceProfile:{...source,cases:source.cases.map(({packetPlans,...c})=>c)},
 physicalAttempts:attempts.length,retriedConditions:retried,
 cohortCounts:{inheritedCompleted:state.groups.filter(g=>g.attempts.every(a=>a.inherited)).length,continuedConditions:state.groups.filter(g=>g.attempts.some(a=>!a.inherited)).length},
 audit:{at:new Date().toISOString(),durationMs:performance.now()-start,stateHash:digest(before),profileHash:state.profileHash,measurementNotesHash:digest(await readFile(join(root,'measurement-notes.json'))),finalizerHash:digest(await readFile(new URL(import.meta.url))),
  scope:'Frozen controller/solver/profile/series hashes, all attempt rows/results/receipts, budgets, artifact digests, fixture bytes/git status and saved independent checks. No model calls or new candidate evaluation.'},
 summaryDefinition:'Quality includes all accepted evidence, including recovered transport failures. Primary timing excludes both documented contaminated conditions. Failed attempts and retry waits count. Shared aliases are not independent observations; never sum strategy token totals. Total tokens remain unknown.'};
await writeFile(prefix+'.json',JSON.stringify(report,null,2)+'\n');
const f=n=>n===null?'—':Number(n).toFixed(2),s=report.summary.overall,q=report.qualitySummary.overall;
let md=`# dev packet粒度比較 — 全条件完了\n\n凍結dev128課題、全${r.completedRuns}/${r.plannedRuns}条件を処理した。同値条件を共有した${r.completedRuns}条件に対し、通信再試行を含む実試行は${attempts.length}回。DeepSeek Flash・thinking有効・上位0・packet最大C4・task締切なし。[事前方針](../packet-sweep-retry-plan.md)。\n\n## 品質\n\n| 方式 | 成功/観測 | 既知token下限（共有観測を含む） | 総tokens |\n| --- | ---: | ---: | ---: |\n`;
for(const [m,v] of Object.entries(q.methods))md+=`| ${m} | ${v.successes}/${v.cases} | ${v.knownTokens} | ${v.totalTokens??'不明'} |\n`;
md+='\n方式別消費は同値条件を共有するため合計しない。成功品質と使用量の完全性は別の指標。\n';
for(const [reference,pairs] of Object.entries(s.pairs)){
 md+=`\n## ${reference}との時間比較\n\n同一課題で両方式が成功した組を使う。手動停止と親の検証負荷が重なった2条件を除外し、その他の通信再試行時間・待機を含める。\n\n| 比較先 | 両成功組 | 同値除外 | 参照が速い | 比較先が速い | 参照/比較先 時間比中央値 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n`;
 for(const [m,p] of Object.entries(pairs))md+=`| ${m} | ${p.bothSuccess} | ${p.equivalentCases} | ${p.referenceFaster} | ${p.methodFaster} | ${f(p.medianReferenceOverMethod)} |\n`;
}
md+='\n![target数別の対応時間比](packet-sweep-dev-complete.png)\n';
for(const key of ['family','targetCount','topology','dependencyDepth']){
 md+=`\n## ${key}別: packet-allとの時間比較\n\n| 区分 | 比較先 | 両成功組 | allが速い | 比較先が速い | all/比較先 時間比中央値 |\n| --- | --- | ---: | ---: | ---: | ---: |\n`;
 for(const [label,g] of Object.entries(report.summary[key]))for(const [m,p] of Object.entries(g.pairs['packet-all']))md+=`| ${label} | ${m} | ${p.bothSuccess} | ${p.referenceFaster} | ${p.methodFaster} | ${f(p.medianReferenceOverMethod)} |\n`;
}
md+=`\n## 再試行と消費\n\n再試行した条件${retried.length}、回復成功${retried.filter(x=>x.success).length}。利用不能条件${r.rows.filter(x=>x.outcome==='unavailable').length}。実call ${r.accounting.calls}、既知token下限${r.accounting.knownTokens}、総tokens不明、使用量不明${r.accounting.unknownUsageCalls}call、上位0。予約控除${r.accounting.chargedTokens}は受付上の値であり実請求ではない。全試行の実行と再試行待機の合計${f(r.accounting.elapsedMs/3600000)}時間、独立検査・監査の合計${f(r.rows.reduce((n,x)=>n+x.auditMs,0)/1000)}秒。人間の停止時間や課題作成時間を実行時間へ含めていない。\n\n| 課題 | 方式 | 再試行回数 | 回復成功 | 使用量不明call |\n| --- | --- | ---: | --- | ---: |\n`;
for(const x of retried)md+=`| ${x.id} | ${x.method} | ${x.retries} | ${x.success} | ${x.unknownUsageCalls} |\n`;
md+='\n## 品質失敗\n\n';
for(const x of r.rows.filter(x=>!x.success))md+=`- ${x.id} / ${x.method}: ${x.termination}。証拠異常${x.evidenceErrors.length}件。\n`;
md+='\n## 監査と解釈の範囲\n\n全attemptのrow/result/receipt、budget、候補hash、固定fixture、保存された独立受入結果、元profile/series/solver/controllerのhashを再照合した。失敗receiptと未知usageは保持した。これは実走中の独立受入を監査したもので、モデルや候補の追加再実行ではない。\n\n停止前90条件と継続後554条件は時期が異なる。時間除外はunits-v02のpacket-2（手動停止）とpacket-1（親の検証負荷）。品質と全消費には両者を残す。各family内のvariantは相関し、devにはchainがなく、既観測のevaluation8件は今回使っていない。evaluationとManagerの比較は未実行。\n\n旧Singleとpacket-allはprompt・検証・確定経路が違う。共通executor内の粒度比較にも、context配信量・検査回数・provider/cache変動が含まれる。現在の小さな合成repoで得た結果を、大規模実務repoや公開変更起点のactivationへ一般化しない。\n';
await writeFile(prefix+'.md',md);
console.log(JSON.stringify({complete:report.complete,conditions:r.completedRuns,attempts:attempts.length,quality:q.methods,pairs:s.pairs['packet-all'],accounting:r.accounting}));
