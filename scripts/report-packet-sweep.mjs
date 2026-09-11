import {writeFile} from 'node:fs/promises';
import {audit} from './packet-sweep.mjs';
const [root,prefix,planLink='../packet-sweep-plan.md']=process.argv.slice(2);if(!root||!prefix)throw new Error('Usage: node scripts/report-packet-sweep.mjs RUN_DIRECTORY OUTPUT_PREFIX [PLAN_LINK]');
const r=await audit(root),valid=r.rows.filter(x=>!x.evidenceErrors.length),physicalCalls=r.rows.reduce((n,x)=>n+x.calls,0)+(r.interrupted?.calls??0),unknownCalls=r.inFlight&&!r.interrupted?null:r.rows.reduce((n,x)=>n+x.unknownUsageCalls,0)+(r.interrupted?.unknownCalls.length??0);
const report={...r,profile:{...r.profile,cases:r.profile.cases.map(({packetPlans,...c})=>c)},accounting:{startedRuns:r.rows.length+(r.inFlight?1:0),completedRuns:r.rows.length,interruptedRuns:r.interrupted?1:0,validRuns:valid.length,physicalCalls,knownTokens:r.knownTokens,totalTokens:r.totalTokens,unknownUsageCalls:unknownCalls,upperCalls:0,actualCost:null},
 summaryDefinition:'Aliases share one observation; never sum per-strategy consumption. Equivalent observations excluded from paired wins. Evidence-invalid observations excluded from quality/time; resources retained.'};
await writeFile(prefix+'.json',JSON.stringify(report,null,2)+'\n');
const f=n=>n===null?'—':Number(n).toFixed(2),s=r.summary.overall;
let md=`# devのpacket粒度比較\n\n状態: **${r.complete?'完了':'途中停止/未完了'}**。${r.completedRuns}/${r.plannedRuns}実runの終了記録、最終reportなし${r.inFlight?1:0}run、証拠が揃ったrunは${valid.length}。停止理由: ${r.stopReason??'なし'}。\n\n[事前固定条件](${planLink})。DeepSeek Flash thinking有効、上位0、packet C4上限、task締切なし。旧Singleとpacket-all/8/4/2/1をdev128件で各1回。実際の分割が同じ条件は共有観測として一度だけ実行する。\n\n| 方式 | 観測課題 | 成功 | 成功時中央値 秒 | 既知tokens（共有観測を含む） |\n| --- | ---: | ---: | ---: | ---: |\n`;
for(const [method,m] of Object.entries(s.methods))md+=`| ${method} | ${m.cases}/128 | ${m.successes}/${m.cases} | ${f(m.medianCompletionMs===null?null:m.medianCompletionMs/1000)} | ${m.knownTokens} |\n`;
md+='\n方式別の成功集合は異なる。上の中央値同士を速度差にしない。共有観測の消費を合計して系列消費へ二重計上しない。\n';
for(const [reference,pairs] of Object.entries(s.pairs)) {
 md+=`\n## ${reference}との対応比較\n\n| 比較先 | 有効組 | 同値のため除外 | 両成功 | 参照のみ成功 | 比較先のみ成功 | 両失敗 | 参照が速い | 比較先が速い | 参照/比較先 時間比中央値 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n`;
 for(const [m,p] of Object.entries(pairs))md+=`| ${m} | ${p.completePairs} | ${p.equivalentCases} | ${p.bothSuccess} | ${p.referenceOnly} | ${p.methodOnly} | ${p.neither} | ${p.referenceFaster} | ${p.methodFaster} | ${f(p.medianReferenceOverMethod)} |\n`;
}
for(const key of ['family','targetCount','topology','dependencyDepth']) {
 md+=`\n## ${key}別: 旧Singleとの比較\n\n| 区分 | 方式 | 成功/観測 | 両成功組 | 旧Singleが速い | packetが速い | 旧Single/packet 時間比中央値 |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |\n`;
 for(const [label,g] of Object.entries(r.summary[key]))for(const [method,p] of Object.entries(g.pairs['legacy-single'])) {
  const m=g.methods[method];md+=`| ${label} | ${method} | ${m.successes}/${m.cases} | ${p.bothSuccess} | ${p.referenceFaster} | ${p.methodFaster} | ${f(p.medianReferenceOverMethod)} |\n`;
 }
}
md+=`\n## 消費と証拠\n\n実call ${physicalCalls}、上位0。既知token下限${r.knownTokens}、総tokens ${r.totalTokens??'不明'}、使用量不明${unknownCalls??'不明'}call。実請求額は不明。準備${f(r.preparationElapsedMs/1000)}秒、独立監査計${f(r.rows.reduce((n,x)=>n+x.auditMs,0)/1000)}秒。未開始${r.plannedRuns-r.completedRuns-(r.inFlight?1:0)}run。\n\n`;
if(r.interrupted)md+=`外部停止した ${r.inFlight.id}/${r.inFlight.method} は ${r.interrupted.calls}call、既知${r.interrupted.knownTokens}tokens。品質・完了時間は未判定として比較から除外し、消費にだけ含めた。元のseries/budget/kernel checkpointは書き換えず、外部停止記録とraw receiptのhashを別保存した。\n\n`;
const failed=r.rows.filter(x=>!x.success);if(failed.length){md+='| 課題 | 方式 | 終了分類 | 証拠異常 |\n| --- | --- | --- | --- |\n';for(const x of failed)md+=`| ${x.id} | ${x.method} | ${x.termination} | ${x.evidenceErrors.length?'あり':'なし'} |\n`;}
md+='\n## 解釈の範囲\n\ndevの8family内のvariantは独立した128種類の実務課題ではない。devにchainはなく、宣言依存深さは1〜3。evaluationは構造の分布が異なり、既にpilot8件を観測済み。この系列ではevaluationを呼んでいない。\n\n旧Singleは公開ファイルをまとめた提案、packetは不変の変更前baselineと現在依存overlayを使うため、旧Singleとの違いは粒度だけではない。共通executor内でも、分割に伴い現在版の配信量や公開検査回数が変わる。実行順・cache・provider変動を完全には除けず、単一試行の最速粒度から適応器の性能を作らない。\n\nJSONには全観測、同値条件、固定順序、runtime hash、family/topology/target数/依存深さ別集計を保存する。rawと完全なpacket planは実行ディレクトリへ保存。再送・採点変更はしない。\n';
await writeFile(prefix+'.md',md);process.stdout.write(JSON.stringify(report.accounting)+'\n');
