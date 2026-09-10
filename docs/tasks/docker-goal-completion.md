# Docker sandbox完了と既存swarmによる実装

2026-09-10の利用者指示「一通り終わらせることをgoalとして。実装の際、今あるswarmを試すこともしてみて」に基づく。

## Goalの完了条件

1. 実Lunaでlocal toolによる編集・可視検査・`__structured_output__`終了・完全usage・VM削除を確認する。
2. `mechanism`のsemantic 1 domain（6 module）で、公開readの有料配信から独立採点・kernel確定まで成功する。
3. staged 1 domainの3段階すべてが、現版依存の読取りと最終barrierを維持して成功する。
4. 既存`runSwarm`で実装の一部を実際に生成し、固定したoracle、担当範囲、全差分、通常gateで検査する。採用・不採用と上位による修正を区別する。
5. 通常gate、実測と失敗履歴、再現手順を整備し、既存PR #2へ反映する。

既存のunknown usageを0へ直さず、今回のrunとは分ける。個別runのcall/time/token/credit相当受付上限を設定し、未知usageはそのrunの受付を停止する。問題の診断・修正を伴う後続runは別に記録する。終了指示の修正だけで成功したと報告しない。一般repo環境・VM pool・規模比較は今回の完了条件に含めない。

## Swarmへの固定した実装課題

Granularity: standard / new behavior。採用予定は以下の2ファイルのみ。認証・金額計算・kernelの採点条件を委譲しない。

- `scripts/lib/docker-tool-summary.mjs`: `summarizeTools(events)`をexportする。
- `scripts/lib/mechanism-progress.mjs`: `summarizeProgress(report)`をexportする。

### summarizeTools

入力はDocker NDJSONをparseしたevent配列。`tool_call`の完全なeventだけを数え、`partial_tool_call`や`toolset_info`を数えない。tool名は`tool_call.function.name`、IDは`tool_call.id`から取る。同じIDの重複完全eventは一度だけ数える。ID/nameが非空文字列でないものを無視する。

返り値は正確に`{calls, byTool, responded, pending, errors, structuredOutputDelivered}`。`calls`は一意の完全tool call数、`byTool`は名前別の数。`tool_call_response`を同じIDへ対応させ、`result.isError === true`ならerrorsへIDを入れる。それ以外は正常応答。応答がないIDはpendingへ入れる。respondedは応答のある一意のcall数であり、error応答も含む。pending/errorsはcallの出現順。複数応答では一つでもerrorならそのcallはerror。成功した`__structured_output__`のcallが1件以上あり、そのIDにerror応答がなければstructuredOutputDelivered=true。対応する完全callのない応答を数えない。未知event、null、prototypeに衝突する文字列ID/nameで壊れない。非配列入力はTypeError。入力を変更しない。

### summarizeProgress

機構runnerのreport（`src/mechanism-run.ts`の既存出力）を受け取り、正確に`{complete, expectedStages, stages, calls, lowerCalls, upperCalls, readCalls, committedTargets, unknownUsageCalls, terminationReason}`を返す。非object、未知family、calls/stages/budgetが欠ける入力はTypeError。

expectedStagesはfamily=stagedなら3、それ以外のstatic/semanticなら1。callsはreport.calls.length、lowerCalls/upperCallsはcall.modelがそれぞれgpt-5.6-luna/gpt-6-astraの件数、readCallsはoutcome=read-requestedの件数。committedTargetsはoutcome=committedのcallのwrittenIdsから、最初の出現順で一意の文字列IDを取る。stage別返り値は`{stage, success, qualityPass, protocolClean}`をboolean厳密判定で作り、入力順を保持する。unknownUsageCallsはbudgetの非負整数、terminationReasonは文字列を必要とする。

completeはreport.success===true、stage数がexpectedStagesと一致、stage indexが順に0..expectedStages-1、全stageの3booleanがtrue、unknownUsageCalls=0、activeReservations=0、budget.exceeded===false、terminationReason=completedの全条件を満たす時だけtrue。欠けた完了証拠から成功を推定しない。金額は計算しない。入力を変更しない。

### 採用条件と反例

- 正常tool→正常応答、error応答、未応答、複数tool、途中event、重複/未知応答を固定ケースで検査する。全toolを単純集計した実装や常時trueは不合格。
- 単一stage・3stageの完了、途中stage、不明usage、未解放予約、超過、虚偽のsuccess、呼出し数と登録数の違いを検査する。
- 公開する可視ケースと、hostに保持する追加ケースを分ける。期待値はモデルへ変更させない。
- `.mjs`のpure functionだけ。外部import、filesystem、network、process、eval、依存追加を禁止する。
- 同じ`runSwarm`のWorkerPool、checkout、lease、validate/commitを通す。workerの最終文やcheck_localの自己申告だけで採用しない。
- `package.json`の`npm run check`を最終gateとし、追加の局所検査には既存の`node --test`を使う。実VM/モデルは通常gateへ必須化しない。

### Descent Test / freeze

自動検査が通っても、hostへのアクセス、担当外差分、テスト改変、下位以外の実装、失敗runの上書きがあれば採用しない。これらは上記の制約とレシート検査へ含めた。残る手動レビューは最終diffの読みやすさであり、検査成功から自動的に良い設計と推定しない。この文書を実装前のfreeze点とする。既存schedulerへの接続口とoracleは上位側で作り、2モジュール本体は先回りして実装しない。
