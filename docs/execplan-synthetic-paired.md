# 凍結した合成課題でSingleとSheepを比較する

2026-09-11の利用者指示に基づく。次の主作業は機構追加ではなく、dev 128課題で同じDeepSeek Flashを使うSingleとSheepの品質・完了時間を対応づけて比較すること。

## 固定した条件

- コーパスはPR #8のcommit `ffe53f1975d4cb89f8ce4ef8a0d4bdef448be14b`。全256件の公開/非公開hashとmetadataを`experiments/synthetic-corpus-v1-lock.json`へ保存し、既存の全件検査記録と照合する。generatorとoracleは変更しない。
- 初回はdevの8 family×16 variantだけを対象とする。4targetが46件、8が32件、16と32が各25件。サイズとtopologyは非直交であり、topology名のindependentも枝内部の依存を含む。devの実際の宣言依存深さは1〜3段で、chainというtopologyは0件。evaluationにはchainが24件あり、深さは最大31段。分割にはfamilyだけでなく依存構造の分布差もあり、devから深いchainの性能へ一般化しない。
- モデルは両方式とも`opencode-go/deepseek-flash`、thinking enabled、上位0、toolなし。入力repository・公開契約・公開check・書換可能な全target・最終oracleを共通にする。既存のSingle/Sheep実装を使い、prompt、read、recoveryの機構追加は行わない。
- SingleはN1/C1、全targetの完全な内容を名前付きobjectで1提案として返す。SheepはN16/C4、1targetずつ提案し、全targetを起動する。不具合箇所metadataをactivation hintやpromptへ渡さない。公開情報へのアクセス範囲は同じだが、Singleの広い初期contextとSheepの局所配信、提案形式、検証・再試行の粒度の違いは方式に含まれる。
- 各方式/課題の上限は128call、総2,000,000tokens、予約200,000tokens/call、出力64,000tokens/call。Sheepのround上限256。系列受付上限512,000,000tokensは各runの予算を予約できる枠で、消費見積や実請求額ではない。実測を優先して両方式の上限を揃え、途中で引き上げない。
- task全体の固定締切なし。通信600秒と既存checkのtimeoutは実行停止用であり、固定時間内成功を採点しない。
- 課題順は`sha256('sheep-dev-paired-v1:' + ID)`で固定。各課題の両方式を隣接して順番に実行する。偶数variantはSingle先行、奇数はSheep先行で各familyの先攻は8/8。task間の並行実行なし。キャッシュとprovider時刻変動の影響を完全には除けない。

## 採点と監査

`elapsedMs`はrunnerの開始から最終検査を含む返却まで。成功時だけ同じ値を`completionMs`へ保存する。モデルなしの課題準備と実行後の独立再検査は別時間として記録する。作成者の作業時間と費用は不明のまま残す。

公開checkからの既存の修正手順は使うが、hiddenの不合格内容は次のcallへ渡さない。各run後に全公開checkと固定最終oracleを独立再検査し、API receiptのモデル・thinking・実usageとbudgetを照合する。未知usage、予約超過、provider/検査障害、元repoや実装のdriftで新規受付を停止する。既知usageでの品質失敗は残して次へ進む。

課題・実装・実行順・予算を実行前に保存する。系列の状態はatomic renameで書き、各callを含むrunの開始前にinFlightを記録する。同時起動をlockで拒否し、途中中断やevidence-stopの系列を自動再送しない。完了行は再実行しない。これは個別swarmのdurable resumeではない。

集計では全予定件数、実行済み件数、成功数、Singleだけ成功、Sheepだけ成功、両方失敗、欠測を区別する。速度比Single/Sheepと差は両方成功した同じ課題だけで計算する。family、topology、target数、宣言依存の最長経路（辺数）、その組合せごとに件数も報告する。各課題1回、8系統内のvariant相関があるため、独立した128試行の有意差や因果効果を主張しない。token、call、提案不受理、検査回数/時間、登録数・実参加数・最大同時callも保存する。

## 手順と完了条件

```sh
node scripts/synthetic-paired-benchmark.mjs prepare .sheep/synthetic-paired/dev-v1
# 既存の認証を環境へ設定してから実モデルを実行する。
node scripts/synthetic-paired-benchmark.mjs run .sheep/synthetic-paired/dev-v1
node scripts/synthetic-paired-benchmark.mjs audit .sheep/synthetic-paired/dev-v1
```

prepareとauditはモデルを呼ばない。既存outputをprepareで上書きしない。runは停止していない系列の未実行分だけを受け付ける。停止理由を消して再開したり、新outputで残りを自動再試行したりしない。

- [x] PR #8の全256課題のhashを照合して凍結。
- [x] dev限定の対応比較、固定順序、方式別実測、集計、独立監査を実装。
- [x] 通常gate555テストと参照2件、dev全128件のモデルなしpreflightを確認（準備149.40秒）。
- [x] 実測80runで停止理由と不足範囲を保存・監査。HTTP 500で1callのusage/モデル証拠が不明。39有効組、未実行176run。全128組の比較は未完了。
- [ ] dev結果から方式・粒度・Cを選び、その理由を凍結。
- [ ] 選択後にevaluation 128件を固定設定で1回実行。
- [ ] その後、Manager比較を別条件で設計。

PR #8でevaluation 8件のvariant 0は既に観測されている。evaluationは完全未見とは呼ばず、この既知露出を記録する。今回はevaluationの追加実行を行わず、その失敗例からpromptを調整しない。

## 実走の停止記録

[結果](results/synthetic-paired-dev.md)。`syn-intervals-v12/sheep`の3call目がHTTP 500となりusageを返さなかった。既知の2callは4986tokens、失敗callは不明のままbudgetをlockした。系列の既知下限は3351612tokens、総量は不明。独立検査でrunを品質の負けに数えず、有効39組と片側Single成功1件を分けた。下位486call、上位0、残存runner/launcher processなしを確認した。

コーパス・prompt・C・oracleは実走中に変更していない。新しい出力先での再試行や不明usageの0扱いはしていない。未実行176runと未確定1runの扱いを決めるまで、この系列から最終設定を選んでevaluationへ進まない。
