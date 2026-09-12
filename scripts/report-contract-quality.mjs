import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve,relative,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2]??'');if(process.argv.length!==3)throw new Error('usage: node scripts/report-contract-quality.mjs SERIES');
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const series=await load(join(root,'series.json')),profile=await load(join(root,'profile.json')),audit=await load(join(root,'audit.json'));
if(!audit.valid||series.stopReason||series.completedRuns!==38)throw new Error('complete audited series required');
// This report includes reviewed observations specific to the archived campaign.
if(hash(await readFile(join(root,'series.json')))!=='72dbce3efa674c2fcd4893b2f51fcb9ee116ba8d246d64991c5bb4d01fcc7f51')throw new Error('this report is pinned to the archived 38-run campaign; write a separate report for a new series');
const secs=v=>v===null?'—':(v/1000).toFixed(2);
const summary=series.summary.map(g=>`| ${g.group} | ${g.successes}/${g.runs} | ${secs(g.medianCompletionMs)} | ${g.calls} | ${g.knownTokens.toLocaleString('en-US')} |`).join('\n');
const trials=series.results.map((r,i)=>`| ${i+1} | ${r.group} | ${r.fixture} | ${r.repeat+1} | ${r.success?'成功':'失敗'} | ${secs(r.completionMs)} | ${secs(r.elapsedMs)} | ${r.calls} | ${r.upstreamRechecks} |`).join('\n');
const pairs=audit.comparisons.map(p=>`| ${p.left} / ${p.right} | ${p.matchedSuccesses} | ${p.leftFaster} | ${p.rightFaster} |`).join('\n');
const paths=[join(root,'profile.json'),join(root,'series.json'),join(root,'audit.json'),join(root,'review-selection.json')];
paths.push(join(root,'audit-before-schema-hardening.json'),join(dirname(root),'check-final.log'));
for(const file of ['result.json','artifacts.json','profile.json','budget.json','task.json'])paths.push(join(dirname(root),'component-run',file));
for(const row of series.results)for(const file of ['result.json','artifacts.json','task.json','profile.json','budget.json','independent-check.json'])paths.push(join(row.outputDirectory,file));
const hashes=Object.fromEntries(await Promise.all(paths.map(async p=>[relative(process.cwd(),p),hash(await readFile(p))])));
const data={format:1,baseCommit:profile.baseCommit,profilePath:relative(process.cwd(),join(root,'profile.json')),model:profile.model,thinking:profile.thinking,limits:profile.limits,seriesTokenAdmissionCap:profile.seriesTokenAdmissionCap,selectionRule:profile.selectionRule,series,audit,evidenceHashes:hashes};
await writeFile('docs/results/contract-quality.json',JSON.stringify(data)+'\n');
const text=`# 公開仕様の再確認・単体対照・並列起動の実測

事前に固定した38条件を実行し、全receipt・元source・候補・独立受入を照合した。主モデルはopencode-go/deepseek-flash、thinking enabled、upper0。集計表の完了時間は成功したrunだけの中央値で、失敗の経過時間とは分離する。全38結果・設定・hashは[JSON](contract-quality.json)、設計は[ExecPlan](../execplan-contract-quality.md)。

## 条件

品質比較は複数欠陥・健全な上流・分岐の3課題×focused/contract×3反復。指示以外の公開仕様・check・oracle・再起動上限は共通。contractは同じcall内で元の公開仕様を要件ごとに確認させる。自己申告は受入証拠にしない。単体対照は独立/伝播の新規課題×single/Sheep×3反復。品質段階の成功数が多い指示、同点ならcallが少ない指示、さらに同点ならfocusedを選ぶ規則を先に固定し、今回は${series.selectedReview}をSheep対照に用いた。既定のreviewは互換性のためfocusedを保つ。

速度比較は8本の独立した2段階の枝（16target）、うち2枝の設定変更。N16、C1/C4、全起動/関連4target起動×2反復。read policy・公開情報・全体oracleは固定。API workerはtool-less、host checkは信頼するsubprocessでOS sandboxではない。各run出力64000tokens/call、総1000000tokens、予約100000tokens、最大48call/64round、通信timeout600秒。task全体の時間締切と固定時間採点はない。独立したrunを同時には実行せず、条件順を交互・逆順にした。

単体は全targetを1callで変更でき、Sheepは1callで担当fileのみ変更する。単体は全公開情報を最初に受け取り、Sheepは既存の局所配信を使う。方式全体の比較であり、read量やcall数だけを独立に比較したものではない。

## 集計

| 条件 | 全体受入成功 | 成功時完了中央値・秒 | 総call | 観測tokens |
|---|---:|---:|---:|---:|
${summary}

合計${audit.calls}call/${audit.tokens.toLocaleString('en-US')}tokens。出力上限到達${audit.lengthLimitedCalls}call、最大出力${audit.maxOutputTokens.toLocaleString('en-US')}tokens。部品集計関数の実Go委譲1call/5568tokensは別計上。fixture作成とpreflightは${secs(series.preparationElapsedMs)}秒、手作業の課題作成・実装・レビュー時間は未計測（null）。これらをモデルの完了時間へ混ぜていない。計測elapsedはrun開始から独立した確認終了までを含む。

## 同じ課題・反復で両方成功した組

| 左 / 右 | 両方成功した組 | 左が速い | 右が速い |
|---|---:|---:|---:|
${pairs}

各条件2〜3反復の合成課題であり、一般的な優位や統計的な有意差は示さない。group全体の成功時中央値だけを比較すると成功した課題の偏りが混ざるため、時間はこの対応する組も確認する。失敗は全体成功率・総call・総tokens・下表のelapsedに残す。

## 観測からの判断

contractはfocusedと同じ8/9成功だったが、40対35call、両方成功した7組のうち6組で遅かった。指示文を強めるだけの品質改善は今回確認できず、既定はfocusedを維持する。healthy条件では両指示とも再起動0回であり、誤って健全な上流を再起動した場合の実モデル耐性を示す対照ではない。その不変性は既存の決定論的テストで別に検証する。

品質の非成功はrun5（focused・分岐・1反復目）とrun11（contract・分岐・2反復目）。前者は公開検査を通った後に固定finalで失敗、後者は公開検査の失敗を残して試行上限に達した。run11の保存された公開側の観測では、上流workerは仕様確認を自己申告し、桁数による過剰拒否を直した一方、整数の小数桁補完の誤りを残した。後続の別workerはその原因をnoteで指摘できたが、既に再検査を消費した上流へ修正として届かなかった。非公開の失敗内容を追加配信したり、その場で再起動上限を変えたりはしていない。

次の品質仮説は、診断を実行可能な公開の反例と対象版へ結び付け、hostで再現できた証拠を担当上流へ渡すこと。modelのnoteだけで依存や書込権限を増やさず、古い版・誤診・健全な上流を含めて検証する。必要時の上位介入はこの経路と分けて比較する。今回この追加経路は未実装。

新規課題のsingle/Sheepはともに6/6成功。成功時間中央値は55.20秒対42.83秒、同じ課題・反復の6組中5組でSheepが速かった。ただし異なる課題は2種類だけであり、幅広いrepositoryでの品質同等性や速度優位を示すものではない。単体は入力6711・出力98164tokens、Sheepは入力29382・出力68603tokensで、局所配信・分担・推論量が同時に変わる。reasoning tokensは出力に含まれるため二重加算しない。

独立枝の速度条件は8/8成功。全起動でC1からC4にすると中央値99.23秒から43.09秒、C4で関連起動にすると9.99秒だった。同じ反復の比較でも両方で同じ方向の差が出た。全起動は16call、関連起動は4callで全16targetのoracleを保った。登録Nは全条件16、実際の最大同時callは全起動C4で4、関連起動C4で2、C1で1。関連する枝が2本しかないため、C4を指定しても実並列度4にはならない。N16が最適であるとは判断しない。

## 個別結果

| run | 条件 | 課題 | 反復 | 受入 | 完了秒 | 経過秒 | call | 上流再起動 |
|---|---|---|---:|---|---:|---:|---:|---:|
${trials}

## 検証と再現

全runのruntimeを実行前にhashで固定し、同じdirectoryのruntime/へ保存した。baseline不合格・独立参照解合格・変異不合格を6課題で確認。全callのrequested/effective model、thinking、HTTP終端、usageと予算の一致を検査した。元sourceと独立検査workspaceの候補hashも照合済み。未知usage・予約超過・基盤障害なら後続を止める。監査時の現行runtimeとの差分はJSONのcurrentRuntimeDifferencesに明示する。全実測終了時の初回監査は差分0で保存した。その後、reviewに明示nullを渡す入力を拒否する検査を追加したため、最終監査ではsrc/repo-manifest.tsだけが異なる。有効な実測設定の意味は変えていない。実測時のruntimeと修正前の監査を保持する。

最終のnpm run checkは型検査・521テスト・2参照snapshot照合に成功した。集計関数は実Go swarm（N4/C2、実参加1・最大同時1）が1callで生成し、hostが配列参照の非null指定と中央値の加算overflow回避を補修して採用した。その他の比較基盤・本体への接続・検査とレビューはhostが実装した。部品生成を含む今回の実モデル総量は180call/906381tokens。部品runと最終検査logのhashもJSONへ保存した。

OPENCODE_GO_API_KEY設定後、node scripts/contract-quality-benchmark.ts .sheep/NEW_OUTPUTで新しい有料系列を実行する。node scripts/audit-contract-quality.mjs SERIESは保存済み結果を監査し、モデルを呼ばない。node scripts/report-contract-quality.mjs SERIESは本系列のhashに固定したレポート再生成で、モデルを呼ばない。新しい系列の解釈とレポートは別に作る。生データは${relative(process.cwd(),root)}。過去のdisabled系列と旧token上限の試行は変更していない。
`;
await writeFile('docs/results/contract-quality.md',text);
console.log('Wrote docs/results/contract-quality.md and .json');
