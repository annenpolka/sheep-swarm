# DeepSeek Flash単体とSheepの品質・実所要時間

2026-09-11、PR #6の`f04b191`を基準に、単体モデルと現行Sheepのrepo比較を実装・実走した。**対象名を固定した応答形式の系列では単体5/6成功、Sheep4/6成功。両方が成功した3課題のうち、Sheepが短時間だったのは1課題、単体が短時間だったのは2課題。** 小規模・各条件1回であり、一般的な優劣の結論にはしない。

利用者指定どおり主モデルは`opencode-go/deepseek-flash`、thinking disabled。固定時間内成功率やtaskの時間締切を設定していない。失敗の経過時間は成功時の完了時間と分離した。機械可読の全24結果・hashは[JSON](deepseek-quality-speed.json)、実装計画は[ExecPlan](../execplan-quality-speed.md)。

## 比較条件

独立3target（金額文字列の整数化、比率配分、区間統合）と、依存する3target（金額整数化→小計→税計算）の2family。小数桁数2/3/4の3variantずつ、同じ6課題を両方式へ渡した。単体は1callで全targetを修正できる。Sheepは既存の1targetごとの版管理・依存順序・修復を用いる。単体N1/C1、Sheep N4/C2、上位0。N4は動作確認で、規模の効果を示す実験ではない。

全方式で公開catalog、target指示、書込対象、公開テスト、非公開oracle、call/token上限を揃えた。単体は全公開情報を最初から受け取り、Sheepは共通contextと静的/追加読取を使う。単体の返却は複数fileをまとめた候補で、Sheepの返却は割当fileの候補。この配信・検査・schedulerの違いを含む方式全体の比較であり、activationやcontext選択だけの効果ではない。全targetを起動し、progressive activationは加えていない。

各run最大12call、120000tokens、予約20000tokens、出力8000tokens。Sheepは既存のtargetごとのattempt上限も保つ。通信単位timeout120秒とhost check単位timeoutは停止条件であり、固定時間の採点条件ではない。今回timeout・未知usage・予約超過による停止はなかった。hidden oracleは終了時のみ評価し、workerへ修復診断として返さない。公開テストの診断だけを修復に使う。API workerはtool-lessで、host check自体は従来どおりOS sandboxではない。

## 対象名を固定した系列の結果

| 課題 | 単体の完了時間 | Sheepの完了時間 | 単体call / Sheep call |
| --- | ---: | ---: | ---: |
| 独立・小数2桁 | 8.19秒 | 5.62秒 | 1 / 3 |
| 独立・小数3桁 | 4.77秒 | 5.18秒 | 1 / 3 |
| 独立・小数4桁 | 未完了（経過5.97秒） | 5.82秒 | 1 / 3 |
| 依存連鎖・小数2桁 | 5.33秒 | 未完了（経過7.20秒） | 1 / 3 |
| 依存連鎖・小数3桁 | 3.63秒 | 未完了（経過17.63秒） | 1 / 7 |
| 依存連鎖・小数4桁 | 5.10秒 | 7.63秒 | 1 / 3 |

時間は準備済み課題の実行開始からsnapshot、モデルcall、公開検査・修復、最終oracle、独立再検査、元repoのbytes/status確認まで。成功時だけ`completionMs=elapsedMs`、非成功時は`completionMs=null`。公開・非公開検査のコマンド実行数は単体計48、Sheep計51。並列call時間の合計はwall timeとは別の補助指標に保存した。

この系列は単体6call・14181tokens、Sheep22call・46418tokens。Sheepの最大同時モデル呼出しは独立課題で2、連鎖で1。単体側に形式違反による再試行はなく、Sheepの連鎖1条件は下流だけを繰り返し修復した。金額費用・cache write量・親作業のtokensは未測定。

## 初回の形式負担を残した記録

最初の12runでは単体に`files:[{path,content},...]`を返させたが、schemaはpath名・件数を固定していなかった。単体がreadonlyなsettingsやcontractまで返し、hostの書込検査で却下された。独立・小数4桁ではこの形式違反などを12call繰り返し、86.06秒でcall上限の未完了となった。初回は単体3/6、Sheep6/6成功だった。

これを単体のコード品質の劣位と扱わず、対象名を必須propertyにした`files:{"amount.mjs":"...",...}`へ返却schemaを変更した。write authorityとoracleは維持し、修正にhiddenテストの失敗内容は使わなかった。初回を上書きせず、同じ6課題・同じ順序規則を別系列で再実行した。両系列のfixture/task hashが一致することを確認済み。

初回46call・111237tokens、対象名固定系列28call・60599tokens、比較計74call・171836tokens。初回消費を総受付上限1440000tokensへ繰り越した。部品validatorのGo生成1call・2514tokensを別計上すると計174350tokens。全75callのusageはcomplete、model evidenceはdeepseek-flash。schema以外にも確率的な出力・provider待ち・cacheが変わるため、成功数の変化をschema修正の因果効果とは断定しない。

## 固定反例と次に調べること

対象名固定系列の非成功は次の3件だった。

- 単体の独立課題: 区間の端が接していない場合も`start <= end + 1`で統合した。公開例には通ったが、間に隙間がある非公開例で失敗。
- Sheepの連鎖・小数2桁: 金額変換が15桁を超える整数を一律拒否し、仕様内のMAX_SAFE_INTEGER境界を拒否した。候補の税計算にも大きな中間積を拒否する制約があり、全体の仕様を満たさない。
- Sheepの連鎖・小数3桁: 上流が整数文字列の桁上げを省いたまま公開局所テストを通過した。下流invoiceの公開テストは繰り返し`net=2`と期待値`2000`の差を示したが、上流を再起動せず、invoiceだけ5回修復して未完了になった。

最後の問題を`tests/quality-speed-upstream-failure.test.ts`に固定した。注入callerが正しい下流を返し続けても、誤った上流を受理したままではamount1回・cart1回・invoice5回で未完了になる。このテストは現行限界の再現であり、修復機構の実装ではない。

次の優先仮説は、**公開された下流の失敗から上流の前提を再検査し、必要なら受理済みproviderを再起動できると、品質と所要時間が改善するか**。全targetは既に一度起動しているため、初期activation範囲を広げるだけではこの例を直せない。非公開oracleの診断を流用せず、再検査・再起動の根拠と版を保持する設計が必要になる。Manager/上位介入はその後の同条件比較とする。

## 検証と再現

通常gateは496テスト・型検査・原資料2snapshotに成功。6課題すべて、モデル実行前にbaseline拒否・独立基準解成功・境界変異拒否を確認した。全24runに対し別workspaceで固定検査を再実行し、元repo不変・候補hash・call receipt・usageを監査した。準備の機械処理は各系列約2.1秒。課題執筆・実装・レビューの実作業時間は未測定で、その時間へ置き換えない。

```sh
# 既存OPENCODE_GO_API_KEYを親環境へ明示して実行。出力先は未作成のdirectory。
node scripts/quality-speed-benchmark.ts .sheep/new-quality-speed
node scripts/audit-quality-speed.mjs .sheep/new-quality-speed
npm run check
```

rawは`.sheep/quality-speed-build/series`と`named-series`。初回runtimeは事前hashに一致するbytesを`initial-runtime`へ保存した。現在の単体runnerはnamed形式が既定、array形式は実験APIの明示指定で保持。rawはignoredなローカル証拠で、Git内の集計だけから全応答は再構成できない。各条件1回・3target・2family・順序交互の初期観測であり、一般repoの成功率や速度の推定、大規模swarm、Manager、上位介入の評価は未実施。
