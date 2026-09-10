# DeepSeek workerのrunner横断対応と実行確認

2026-09-10。利用者の「一通り対応して。使えるならworkerをdeepseekにして使ってみて」に基づき、直接API runtimeを`swarm`・`compare`・`durable`・`mechanism`へ接続し、DeepSeek workerによる8条件がすべて固定受入検査に成功した。下位DeepSeekは52call、Manager-localの上位Codex/Astraは2call。初回の3call smokeとは別の追加試行である。

## 利用方法

CLIには`DEEPSEEK_API_KEY`を環境変数で渡す。API keyをコード・引数・成果物へ書かず、adapterはOpenCodeの認証storeを自動で読まない。workerのmodelはprovider prefixのないAPI IDを明示する。以下は今回成功した機構実験の条件で、出力先には未使用のdirectoryを指定する。

```sh
npm run mechanism:experiment -- \
  --budget-mode tokens \
  --runtime deepseek \
  --worker-model deepseek-v4.1-flash-expires-on-0910 \
  --families static,semantic,staged --methods sheep \
  --groups 1 --workers 4 --concurrency 2 \
  --max-tokens 300000 --reserve-tokens 12000 --max-calls 80 \
  --max-meta-calls 0 --max-tokens-per-call 4096 --timeout-ms 60000 \
  --output .sheep/my-deepseek-series
```

`swarm`・`compare`・`durable`も`--runtime deepseek --worker-model <API ID>`を受ける。`compare --method single-worker`は選択modelの単体対照。上位の既定はCodex/Astraで、上位もDeepSeekにする場合は`--meta-runtime deepseek --meta-model <API ID>`を明示する。今回は上位DeepSeekの経路を注入callerで検査し、実上位はAstraで確認した。

`mechanism`は`--budget-mode tokens --max-tokens N --reserve-tokens N`を要求し、従来のcredit系列と分離する。直接APIではtoolを渡さず、局所promptから返る成果物を既存の固定oracleで検証する。`--worker-tools local`はDocker runtime専用のまま。

## 実APIの結果

要求modelは全DeepSeek callで`deepseek-v4.1-flash-expires-on-0910`、providerが返した名はすべて`deepseek-flash`。52callすべてHTTP 200、usage完全。要求IDと応答名は別recordに保持し、betaの実backendや期限後の可用性は推定しない。通常の既定modelはLunaのままで、今回は明示してDeepSeekへ切り替えた。

| 条件 | 下位call | 上位call | input+output tokens | 結果 |
|:---|---:|---:|---:|:---|
| swarm、size 4、N=4/C=2 | 5 | 0 | 5,308 | 全5成果物が確定 |
| compare、sheep-full、size 2、N=2/C=2 | 3 | 0 | 3,263 | 固定受入成功 |
| compare、single-worker、size 2 | 1 | 0 | 1,739 | 固定受入成功 |
| durable、size 2、N=2/C=1 | 3 | 0 | 3,373 | 確定後のresumeも成功 |
| compare、manager-local、size 2、N=2/C=2 | 3 | 2 | 47,868 | DeepSeek worker＋Astra管理で成功 |
| mechanism、static、1 group、N=4/C=2 | 6 | 0 | 15,249 | 6 module・最終受入成功 |
| mechanism、semantic、1 group、N=4/C=2 | 10 | 0 | 28,191 | 6 module・意味依存の受入成功 |
| mechanism、staged、1 group、N=4/C=2 | 21 | 0 | 66,554 | 全3stageで受入・kernel完了 |

Managerのtokenは上下両方の合計。durableは完了後、API keyを渡さずにresumeして下位3call・上位0callのまま成功し、再発行しなかった。上位Astraの単独試行は行っていない。

機構実験3条件は公開dispatcherから逐次実行した。系列の集計は37call・109,994tokens、usage不明0、pendingなし、`status: completed`。受付上限は30万tokens・80call、各callの出力上限4,096tokens、予約12,000tokens、timeout 60秒。予約はproviderの総input+outputに対する強制上限ではなく、呼出し受付の制御である。

これは少数の合成課題による接続・動作確認であり、N=16/32での規模比較、一般repositoryでの有用性、速度・費用優位、請求額は評価していない。上位もDeepSeekとする実API試行、DeepSeekでの実processクラッシュ後の未完了再開は今回の実API範囲外。

## 実装・委譲と独立検証

指定skill `opencode-delegate`を使い、OpenCode 1.18.29、model `deepseek/deepseek-v4.1-flash-expires-on-0910`、session `ses_f76551045ffeVsWQ2LVtScEAeW`を継続利用した。初回adapter/swarmと次のrunner横断runはrelayの`completed`を確認した。最後のtoken予算runはtool処理後に正常な終了stepを出さず`failed`だった。一時ファイル削除の拒否も記録され、不要な削除は再試行していない。部分差分は独立検証後に採用し、呼出し側が残りを修正した。

委譲側は共通runtime、compare/durableの接続、token budget、mechanism接続、dispatcher初稿と対応テストを実装した。呼出し側は永続snapshotの旧形式と破損形式の区別、使用量の集計、invalid arithmeticの停止、dispatcherの事前記録・中断処理・receipt再集計・失敗時の既知消費保持を修正し、pricingと実行記録を整えた。modelの自己申告を受入成功の根拠にしていない。

- `npm run check`: 347テスト、型検査、2つの参照snapshot照合が成功。実API/keyを通常gateへ持ち込まない。
- 独立CLI→loopback検証: swarm、compare、Managerの上下同一model ID、single-worker、durableと完了resume、mechanism 3family。usage欠落ではcompare/durable/mechanismの新規受付停止と失敗を確認した。
- token予算の境界: cache内訳不明でも完全なinput+outputを集計、総量不整合・overflow・partialは完全使用量にせず受付lock。子の改変集計・receipt欠落・起動失敗・既存出力先の上書きを拒否する。
- 公開dispatcherのSIGTERMをloopback通信中に試し、1 request後に子process終了・系列停止・`usageComplete:false`となり、次条件を起動しなかった。usage不明の0観測を無料と扱わない。
- 変更前の40ファイルのhashを照合。固定fixture・参照資料は不変。既存テスト3ファイルの変更は追加methodの正答caller対応とbudget unionの型絞込みで、従来の期待値は維持した。
- `git diff --check`: 成功。`git pull --ff-only`でmainは既に最新だった。commit/pushは実施していない。

DeepSeekのtoken receiptは価格計算の入力としても読める。[価格表](../../pricing/README.md)には公開modelのpeak/off-peakを分けて保存したが、beta単価はnullのまま。応答aliasを理由に別modelの料金へ置換せず、実請求額や無料を推定しない。

生の証拠はGit対象外の`.sheep/deepseek-full-validation-2026-09-10/`へ保存した。`verified-summary.json`は生のcall receiptを再集計した結果、`mechanism-series/token-series.json`は系列受付記録、各`*-execution.json`は引数と実行時の主要source hashを含む。loopback監査・最終gate・委譲結果も同じworkspaceの`.sheep/`へ保存した。認証値や生のruntimeデータを公開文書へ添付していない。
