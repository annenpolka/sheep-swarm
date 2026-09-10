# 機構実験の実行と記録の読み方

この実行器は、局所作業、公開資料の追加読取、個体の継続記憶、必要時だけの上位介入を、同じ合成課題で比較する。下位と単独対照は `gpt-5.6-luna`、上位介入は `gpt-6-astra` に固定する。2026-09-10の利用者方針により、費用の目安を得たAstra単独は今後の試行から省く。通常の下位処理に、上位への相談や全件承認はない。

本書は実装済みの操作と評価範囲を説明する。[課題研究](task-design.md)に挙げた外部リポジトリや全対照の実施完了を意味しない。試行の実測値は保存した `result.json` と、その出典を確認した集計を使う。

## 課題と比較方式

各domainには、取り込み、時間窓、集計、保存、キャッシュキー、レポートの6つの異なるAPIがある。`--groups 8` は8 domain、48モジュールになる。全方式へ同じ正規契約を渡し、共有指針と個体の過去のメモより優先させる。

| `--family` | 内容 | この条件で観測するもの |
|:---|:---|:---|
| `static` | 明示的なimportと既知の依存を持つ、1段階のAPI移行 | 局所作業と並列実行の基準 |
| `semantic` | 公開レジストリがdomainごとのJSONポリシーを指す、1段階の移行 | 必要な資料を追加で読み、関係を記録する動作 |
| `staged` | 同じ個体群で、フィールド名・時間単位・値の尺度等が変わる3段階の契約更新を処理 | 古い個体履歴や共有指針がある状態での適応 |

| `--method` | 実行と読取範囲 | 記憶・上位 |
|:---|:---|:---|
| `sheep` | Lunaが割り当てられた1成果物を局所的に編集する | 個体ごとに直近4件の履歴。反復する意味上の失敗からAstraが共有指針へ介入できる |
| `single-luna` | Luna単体へ公開成果物全体を渡し、複数ファイルの増分修正を許す | 直近4件のメモを保持。別の上位は置かない |
| `single-astra` | 過去試行の再現用に残す旧対照。今後の試行には含めない | 直近4件のメモを保持 |
| `no-memory` | Sheepと同じ局所編集 | 個体の私有履歴と履歴に基づく割当の優先度を無効化。上位介入は残す |
| `no-upper` | Sheepと同じ局所編集 | 個体履歴を保持し、上位の呼出しを無効化 |

`no-memory` でも、採用済み成果物、共有指針、発見済みの依存、対象ごとの追加読取先、現在の可視検査エラーは保持する。実行系全体を無記憶にした対照ではない。通常の履歴は1件あたりメモ本文を最大1,200文字に切り詰め、読取版の記録も持つ。4件はtoken数の上限ではなく、人数Nが増えると群れ全体の保持容量も増える。総記憶容量を揃えた対照は別途必要になる。

「継続する個体」は、WorkerPoolのIDと最大4件の観測履歴を引き継ぐものを指す。Codex CLIの各呼出し自体は `--ephemeral` で独立して起動し、LLMのセッションや完全な対話履歴を持ち越すわけではない。下位履歴のread setにある版番号も段階内の過去の観測であり、次段階の現在版を証明しない。

Nは保持する個体数、Cは最大同時呼出数である。主比較は同じ48モジュールに対してN=8/16/32、C=8を使う。単体方式はN=1、C=1に正規化する。登録人数だけで活動を評価せず、`participation.actualCalls`、`committedPatches`、`maxActiveModelCalls`を確認する。割当回数 `scheduledAssignments` はモデルが実際に呼ばれた回数と区別する。

## 1試行を実行する

リポジトリのルートで実行する。Node.js 24.12.0以上と認証済みのCodex CLIが必要。通常の検査はモデルを呼ばない。

```sh
npm ci
npm run check
npm run mechanism -- --family staged --method sheep --groups 1 --workers 4 --concurrency 4 --output .sheep/mechanism-example-01
```

最後のコマンドは実際にモデルを呼び出す。出力先は新規ディレクトリでなければならず、既存の試行を上書きしない。出力先を省略すると、方式・課題・時刻から名前を生成する。

主比較と同じ規模の単独実行例:

```sh
npm run mechanism -- --family semantic --method sheep --groups 8 --workers 16 --concurrency 8 --max-credits 30 --output .sheep/mechanism-example-02
npm run mechanism -- --family staged --method single-luna --groups 8 --max-credits 30 --output .sheep/mechanism-example-03
```

この単独CLIが管理するのは1試行の予算である。別々に起動した試行の合算には、次節のdispatcherと `--prior` を使う。

| オプション | 既定値 | 適用範囲 |
|:---|---:|:---|
| `--max-credits` | 30 | 全段階・全役割・全再試行のStandardクレジット相当 |
| `--luna-reservation` | 0.25 | Lunaの1呼出しを開始する前の予約 |
| `--astra-reservation` | 15 | Astraの1呼出しを開始する前の予約 |
| `--max-calls` | 400 | 全モデル呼出しの合計 |
| `--timeout-ms` | 90000 | 1呼出しの制限時間 |
| `--max-attempts` | 3 | 段階内の各編集対象の試行上限 |
| `--max-read-calls` | 2 | 段階内の各対象で、追加資料を要求する呼出しの上限 |
| `--max-meta-calls` | 3 | 全段階にわたる上位の呼出し上限 |

`--rates FILE` で単独CLIへ別の価格表を渡せる。比較実験では同じ価格表を固定し、条件ごとの都合で変更しない。

このCLIの既定予算はStandardクレジット相当で、DeepSeekの直接API runtimeはcredit modeの対象外とする。credit modeで`--runtime deepseek`を渡した場合は予約・有料呼出しの前に拒否する。DeepSeek/混合upperは`--budget-mode tokens --max-tokens --reserve-tokens`でtoken予算として別経路に分離する。`src/token-budget.ts`はcache splitを知らなくてもinput+outputの観測下限で受付を制御し、不明usageは新規受付をlockする。tokenの観測値をcreditの金額へ換算せず、credit結果とtoken結果を同等とは扱わない。`--rates`はcredit mode専用で、token modeと併用できない。token系列は`mechanism:experiment --budget-mode tokens ...`で逐次実行し、子runのtoken/回数を合算してfail closedにする。

## 固定した試行行列と研究全体の予算

`mechanism:experiment` は複数試行を順に起動し、全体の受付を管理する。

| モード | 試行構成 |
|:---|:---|
| `pilot` | 1 domainの静的・意味依存・段階更新をSheep N4で各1回、段階更新の単体Lunaを1回。計4試行 |
| `main` | 3課題×N8/16/32×2回の18試行、3課題×単体Lunaの3試行、段階更新N16の記憶なし・上位なしを各2回の4試行。計25試行 |
| `scaling-followup` | 明示的に承認された追加100相当の枠で、意味依存のN16・N32をC=8で各1回。各試行30相当 |

主試行は48モジュール、群れのC=8を固定する。主試行の順序はseed `20260910` で混ぜ、`experiment.json` の `planned` に保存する。開発試行は実行器の確認に使い、主試行の成績へ混ぜない。

研究全体は開発試行を含めて最大1,200 Standardクレジット相当、各試行は30相当を受付基準とする。dispatcherは次の試行の開始前に、過去の確定した概算費用に30を足して全体の上限と比較する。`--prior` は以前の実験ディレクトリを繰り返し指定できる。指定されたレシートを再集計し、過去の失敗・再試行も含める。以前のディレクトリは自動発見しないため、同じ研究に属するものを漏れなく列挙する必要がある。

今回の証跡は次の実行系列で保存している。これらはAstra単独を含む旧pilot 5条件・旧main 28条件であり、現行の4条件・25条件とは区別する。v1/v2/v3は異なる開発時点での試行であり、各時点のソースはそれぞれの `frozen-source/` にある。過去の構成の再現には対応する凍結ソースを使う。既存名のままコマンドを再実行しても上書きはできない。新しい試行では出力名を変え、引き継ぐ過去の費用を指定する。

```sh
npm run mechanism:experiment -- --mode pilot --output .sheep/mechanism-dev-v1
npm run mechanism:experiment -- --mode pilot --output .sheep/mechanism-dev-v2 --prior .sheep/mechanism-dev-v1
npm run mechanism:experiment -- --mode pilot --output .sheep/mechanism-dev-v3 --prior .sheep/mechanism-dev-v1 --prior .sheep/mechanism-dev-v2
npm run mechanism:experiment -- --mode main --output .sheep/mechanism-study-v1 --prior .sheep/mechanism-dev-v1 --prior .sheep/mechanism-dev-v2 --prior .sheep/mechanism-dev-v3
```

正常に費用を確定できた品質上の失敗では、dispatcherは次の予定試行へ進む。使用量不明、モデルの観測境界違反、試行予算の超過があれば止める。開始直前の `activeJob` を保存し、中断中の仕事や欠けた宣言済みレシートを費用0として再利用しない。`status: completed` は予定した試行行列の処理が終わったことを表し、全試行の品質成功を表すものではない。

### 承認された追加比較

本試行で1呼出しの使用量が不明になった後、利用者は不明分を記録したまま、追加100クレジット相当を上限に16・32体を先に比較することを承認した。そのための限定した別系列を次で起動する。

```sh
npm run mechanism:experiment -- --mode scaling-followup --output .sheep/mechanism-scaling-followup-v1 --unpriced-prior .sheep/mechanism-study-v1
```

`--unpriced-prior` はこのモードだけで必須となる。対象は使用量不明で停止したmainの完全な結果・レシート台帳で、不明呼出しがちょうど1件あることを検査する。元のsource manifestと保存ソースを確認し、実行する `src/` と価格表が元と同じことも確認する。元の停止状態、費用下限、不明分を変更しない。

`previousStudy` は開発費用を含む過去の既知下限と不明呼出し数を保持する。`additionalBudgetAuthorization` は追加上限100と比較対象を記録する。追加系列の `observed` と費用集計は新しい呼出しだけを数え、過去の不明分を0にせず、過去の既知費用も新枠へ二重に計上しない。全研究の総費用は不明分が残る限り確定値にならない。

追加系列をやり直す場合、同じ追加キャンペーンの過去ディレクトリ全てを `--prior` で含める。その分を追加100の枠から差し引く。ここでも新たな使用量不明、予算超過、観測境界違反が生じたら停止する。一般の未知費用を無視して続行するオプションではない。

## 費用・クレジットの意味

換算は[2026-09-10の公開価格表](../pricing/openai-2026-09-10.json)を固定して行う。キャッシュ読取は入力tokenの内数、reasoningは出力tokenの内数として扱い、二重に足さない。失敗終了でも使用量が確定していれば費用へ含める。単価と式の詳細は[見積器の説明](../pricing/README.md)を参照。

モデルを呼ぶ前に予約を同期的に確保し、終端レシートを得たらその呼出しの概算費用で精算する。未使用の予約は解放する。Astraの予約は15相当なので、残りが15未満なら、実際の次の呼出しがそれより安く済む可能性があっても開始しない。`credit-admission-limit` は予約粒度による未完了であり、必ずしも30相当を使い切った状態ではない。

| `budget` の項目 | 意味 |
|:---|:---|
| `observedCredits` | 価格を適用できる部分の下限合計。使用量不明があると全費用の確定値にならない |
| `reservedCredits` / `activeReservations` | 開始済みで未精算の予約額・呼出し数 |
| `unknownUsageCalls` | 使用量、適用単価、呼出しまたはモデル識別を確定できない呼出し数 |
| `reservationOverruns` | 個別の実測概算が開始時の予約を上回った件数 |
| `exceeded` | 既知の費用下限が試行の上限を超えたか |
| `admissionDenied` | これまでに受付拒否があったか。個別拒否後の最終状態は終了理由も見る |

使用量不明は無料扱いにせず、その時点から追加の受付を停止する。既に開始した呼出しは終了・精算まで進み得るため、予約はプロバイダが強制する支出上限ではない。ここでのクレジットは公開Standard単価からの条件付き換算であり、実際の請求額、購入クレジットの残高や引落し、契約に含まれる利用枠の消費率を観測したものではない。

## 観測と受入の境界

下位は公開カタログにある資料を `readRequests` で要求できる。応答は `{writes:[{id,content}],readRequests:[id],note}` で、追加読取と書込を同じ呼出しへ混在させない。要求された内容を後続の有効なモデル応答まで届けた関係を、実際のcall IDとともに `discovery.deliveredEdges` へ記録する。資料要求だけ、または予算拒否だけでは発見済みと数えない。

意味依存課題では、カタログと正規仕様がレジストリ経由の解決方法を明示する。モデルは追加資料を読まず、既存の動的ポリシー参照を残して正しい実装を返すこともできる。さらに各段階の開始時に、hostが全編集対象の完了義務を作る。このため、最終成功だけから未知の依存を発見できたとは言えない。これは公開資料の要求と登録を観測する機構であり、任意のリポジトリの隠れた意味依存を推論する実装ではない。

段階更新では、各段階の共通の完了バリア後に新しいkernelを作り、採用済みの成果物、登録済み依存、個体プールと履歴を引き継ぐ。版番号の権威は段階内に限定する。過去のメモには段階を記し、現在の正規契約を読み直すよう指示する。実行中の旧提案へ時刻指定で仕様変更を割り込ませる実験や、並列runnerの中断再開とは区別する。

公開の局所検査によるエラーは修正用の観測として返す。最終検査は異なる具体値も使い、最終検査のエラーをモデルの修正フィードバックへ戻さない。基準解・最終検査・固定された正規資料はモデルの書込対象ではない。成功には各段階の外側の品質検査とkernel完了の両方が必要で、未精算の予約や不明な費用を残したまま成功にしない。

Codex CLIは `--sandbox read-only --ignore-user-config --ephemeral` で起動し、プロンプトは供給した公開JSON以外のツール利用を禁じる。呼出し後のイベントを監査し、shell・ファイル変更・外部ツール等が観測されれば試行を無効化する。読み取り専用sandboxはファイルの読取隔離ではなく、この監査は出力イベントに現れない外部読取まで証明するものではない。

## 保存物と終了理由

各試行の `result.json` は `success`、`qualityPass`、`terminationReason`、段階別の結果、全呼出し、予算、介入、個体の参加状況を持つ。`kernel-stage-*.json` と `artifacts-stage-*.json` は段階ごとの採用状態を保存し、`call-*.json` は生のCLIレシートを保持する。生のレシートや私有メモを公開集計へそのまま転記しない。

`lowerCalls` はLuna、`upperCalls` はAstraの呼出し数で、単体Astraの作業も `upperCalls` に入る。実際のメタ管理の回数は `calls[].role === "meta"` で数える。`interventions` はメタ管理が共有指針を変更した件数であり、単に上位を呼んだ回数でも、その変更が正しい訂正だったという採点でもない。介入の有効性は変更内容と後続の品質・復旧を併せて見る。

| `terminationReason` | 読み方 |
|:---|:---|
| `completed` | 全段階の品質・完了・予算確認を通過 |
| `credit-admission-limit` | 次の呼出しの予約を確保できない |
| `call-limit` / `attempt-limit` | 総呼出し数または対象ごとの試行上限 |
| `final-quality-failed` | 最終の意味検査を満たさない |
| `protocol-incomplete` | 品質以外の未処理義務等が残る |
| `budget-unknown` / `budget-exceeded` | 費用の確定不能または既知費用の超過 |
| `context-boundary` | 禁止したモデル側ツール等の境界違反 |
| `scheduler-stalled` / `execution-error` | 実行の停滞または実行器の例外 |

`terminationReason` は停止の分類である。品質は `qualityPass` と各段階の検査結果で別に読む。例えば上限で止まった試行にも未修正箇所はあり、単一の分類だけでモデルの能力不足と判定しない。dispatcher側の `stopReason` は研究全体を止めた理由で、試行単位の終了理由とは別の項目になる。

## 固定ソースからの検証と再実行

dispatcherは開始時の `src/`、`scripts/`、`tests/`、`pricing/`、package設定、実行計画を `frozen-source/` へ保存し、各ファイルのSHA-256を `source-manifest.json` へ記録する。各試行の起動前にも現行の実行元と照合する。実験中に凍結対象を編集すると、次の試行を開始する前に停止する。乱数seedが固定するのは試行順序であり、モデル応答の再現を保証するものではない。

保存済みの試行を集計する操作はモデルを呼ばない。

```sh
node scripts/summarize-mechanism.mjs --run .sheep/mechanism-study-v1 --output .sheep/mechanism-study-v1-summary.json --markdown .sheep/mechanism-study-v1-summary.md
```

集計器はソースmanifest、保存したソース、価格表、宣言済みのrun結果のハッシュを確認し、生レシートから費用を再計算する。未実行の予定条件は未実行として残す。費用推定のコードが凍結版と異なる場合も停止する。

モデルを再呼出しして再現を試す場合は、実験に対応するリポジトリの新規checkoutを用意し、その上へ対応する `frozen-source/` の内容をコピーする。そこで `npm ci` と `npm run check` を実行した後、新しい出力先で同じ設定を実行する。凍結ディレクトリには `experiments/` や参照資料snapshotの全体を含めないため、単独で完全なリポジトリ検査を再現できるアーカイブではない。保存原本へ依存ファイルや新しいrunを追加しない。再呼出しは追加費用を伴う新しい試行であり、保存済み結果のリプレイではない。

この実行器とdispatcherに途中再開機能はない。中断した試行を同じIDで成功に置き換えず、旧記録と未確定の使用量を保持する。未知の使用量が残る過去ディレクトリは `--prior` として受付を通らない。元の[永続化・再開実験](results/durable-restart.md)はC=1の別実行器についての証拠である。

## DeepSeek workerのtoken系列

`npm run mechanism:experiment -- --budget-mode tokens`は独立したtoken系列を起動する。`--families static,semantic,staged`、`--methods sheep,single-worker`で条件を指定し、`--max-tokens`・`--reserve-tokens`・`--max-calls`が系列全体の受付を制限する。`--max-meta-calls`は子runごとの上限で既定0。`--timeout-ms`と`--max-tokens-per-call`も子runへ転送する。

出力先は新規directoryに限定し、子run起動前に`token-series.json`へpending条件と引数を保存する。子の集計をそのまま信用せず、各call receiptを要求modelごとに再集計する。usage不明・receipt欠落・model不一致・集計不一致・子run失敗・割込で次条件を止め、既知の使用量は失敗時も保持する。`usageComplete:false`の観測値は下限であり、0でも無料を意味しない。中断した系列の自動resumeは提供しない。

2026-09-10、指定betaのDeepSeek workerで3 familyすべてを実行し、37call・109,994tokensで固定oracleと全stageのkernel完了を確認した。[全runnerの実行記録](results/deepseek-runners.md)。これは従来credit系列の比較実験とは別の接続・動作検証である。
