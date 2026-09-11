# Repository work packets

`repo --packet-size all|N`は、許可された複数targetを一つのモデルcallで提案するopt-in経路。allと1targetも同じexecutorを通る。既存のfile単位runnerはflag省略時に維持する。現在はOpenCode Goのdeepseek-flash・thinking有効・上位0に限定する。

```sh
npm run sheep -- repo --repo /path/to/repository --task /path/to/task.json \
  --runtime opencode-go --worker-model deepseek-flash \
  --packet-size 2 --concurrency 4 --dry-run
```

JSON/textのdry-runに、packetのtarget割当、依存先packet、現在版のread範囲、共通公開baselineのpath、境界edge数、循環によるサイズ上限超過を表示する。snapshot取得と静的解析だけを行い、モデル・check・出力ディレクトリ作成は行わない。`--dry-run`を外すと実行し、候補を保存する。`--apply`は全体受入・使用量・source drift確認後だけ書き戻す。

既定値は最大C4、128call、2,000,000tokens、予約200,000tokens/call、出力64,000tokens/call、通信timeout600秒。task全体の時間締切はない。`--max-calls`、`--max-tokens`、`--reserve-tokens`、`--max-tokens-per-call`、`--timeout-ms`で明示変更できる。workerはpacketごとに状態を持ち、`--workers`は指定できない。Cは上限で、packetが一つなら実同時数は1。内部round上限は256で、CLIの`--max-rounds`はこの経路では受け付けない。

## 分割と版管理

公開manifestの依存と、v2では公開catalog内の静的依存を使う。readonlyファイル経由のtarget依存も収集する。SCCを分割不能単位にし、providerから順に、現在のpacketとの隣接edgeが多いready SCCを選ぶ。同点はpathの辞書順。容量に収まらなければ次packetへ送り、SCC自体が容量を超える場合は理由を記録して一つに保つ。独立した小componentも同じpacketへまとめられる。結果は入力配列順に依存せず、縮約graphは非循環になる。

全packetに、全公開ファイル・全target指示・goalからなる不変の**変更前baseline**を渡す。さらにpacket自身と公開graphの依存閉包にあるtargetの**現在版overlay**を渡す。baselineはkernel上でも書込不能な別artifactで、現在版の代用とは扱わない。overlayの全配信版をcheckoutへ登録し、前提が古くなれば採用を拒否する。

これは全ファイルの最新状態を毎callへ配るpolicyではない。全最新状態をread-setへ登録すると、独立したpacket同士も互いのcommitで古くなるため、変更前の共通情報と変更中の依存を分離した。同じbaseline・同じ閉包計算規則を全粒度へ適用するが、配信する現在版の量はpacketで変わる。PR #9の旧Single/Sheepと同一prompt・同一read policyという主張はしない。未宣言の意味依存の完全性は保証せず、最終oracleでの失敗を保持する。

各packetは名前付き`files`で担当の全targetを返す。不足、担当外path、非文字列、2MiB超のcontent、余分なresponse keyを拒否する。kernelがpacket scopeのlease、read版、検査した統合候補を確認し、全writeを一括commitする。候補の一部だけを採用しない。公開checkに落ちた案は現在状態と分けて保存し、次callに案と公開feedbackを渡す。

モデルcallは依存が解決したpacketから最大C件をwaveとして並列実行する。waveの全callを精算後、検査・commitを順に行う。wave途中で次waveを補充するschedulerではない。変更通知で完了済みpacketの前提が変われば完了を取り消す。packet内部の通知は現在snapshotへの追加公開検査とkernelのno-op commitで処理し、同じ確認だけのモデルcallを発行しない。この追加検査時間も完了時間に含む。

## 対応境界と証拠

manifest v1、またはv2のstatic mode・全target起動に対応する。既存manifest validatorによる明示dependsOn循環拒否は維持し、v2の静的importで見つけた循環はpacketへ統合する。activation、動的read要求、recovery、上位介入、実行中の新規依存追加は未対応として拒否する。候補の静的graphに新しいedgeや未解決specifierが出た場合は、その候補を採用しない。

`profile.json`に分割・context policy・予算・baseline hash、`call-*.request.json`に配信内容と版、`call-*.json`に応答/usage、`kernel.json`に候補・lease・検査・通知の履歴を保存する。`result.json`は実同時call、packet別attempt、公開/最終check、source不変、既知token下限、失敗elapsedと成功時completionを分ける。kernel snapshotは監査用であり、並列runのdurable resumeではない。

HTTP障害・usage不明・検証基盤障害では、既に発行したcallの精算後に新規受付を止める。hidden oracleは全packetの処理後に一度だけ実行し、その診断を修復callへ返さない。候補のcheckは既存のhost subprocess境界を使い、OS sandboxを新設したとは扱わない。

[部品生成・実API疎通の記録](results/repository-packets.md)。粒度の性能比較は[次の方針](work-packet-direction.md)に従い、別の実行profileで固定する。
