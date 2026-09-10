# Docker Agent導入の完了検証とswarmによる実装

2026-09-10。利用者が指定した[完了条件](../tasks/docker-goal-completion.md)に沿った継続作業。以前の[機構実験の失敗](docker-agent-mechanism.md)は保存し、今回の実走と分ける。

## 既存swarmで実装した部分

`runSwarm`に信頼する`CodeFixture` factoryを渡す接続口を追加し、既存のWorkerPool、checkout、lease、validate/commitを通して2つの診断関数を実装した。独自の簡易schedulerへ置き換えていない。

- `scripts/lib/docker-tool-summary.mjs`: 実NDJSONから完全tool call、応答、エラー、終了tool到達を集計する。
- `scripts/lib/mechanism-progress.mjs`: 保存済みreportのstage、確定対象、未知usage、完了条件を集計する。

上位側が仕様・固定oracle・CLI・接続口を先に作り、関数本体をLunaへ委ねた。N=4、C=2、上位call=0、最大8call、受付3 credit相当、予約0.5/call、60,000 token/call、240秒/call。実際の稼働個体は3体で、3callから2成果物を確定した。最初のprogress候補は可視検査を通ったが、欠けた予算証拠をTypeErrorにする追加ケースで不合格。同じswarmの次のcallが修正し、49＋42の固定ケースを満たした。

2ファイルは全差分と禁止機能をレビューし、生成物をそのまま採用した。上位による関数本体の修正は0。既知usageは完全で、合計0.337782 credit相当。実API請求額や一般的な開発生産性の比較ではない。新しい集計CLIも今回の実走レシートに使用した。

## 実走から修正した指示

ingestの単一call probeは編集、可視検査、終了tool、独立VMの受入まで成功した。その後のsemanticは4成果物確定後、report workerが平文JSONを返して停止し、reminder中のusage明細1件が欠落した。16call、既知下限0.414186相当、unknown 1。元のreportとreceiptを上書きしていない。

固定したDocker Agent v1.137.0のローカルソースで、次を確認した。

1. Responsesの`tool_choice`は`auto`。tool形式の終了はモデルの呼出しに依存し、未達には2回のreminderがある。
2. `recordAssistantMessage`は内容もtool callも空の応答を保存せず、`token_usage.last_message`がnilになる。context snapshotから失われた明細を再構成することはしない。
3. adapterのシステム指示は「JSONを返せ」、user指示は「終了toolを呼べ」だった。local tool時のシステム指示も終了toolへ統一した。これで常に終了が保証されるとは扱わず、失敗・unknown usageの受付停止を維持する。

同時に走らせたstagedは18call、0.381220相当、unknown 0でstage 0の読取上限に達した。すでに配信されたregistry/policyをworkerが再要求していた。現在のcheckoutと過去の要求が混同されないよう、自動的な読取記録、配信済みファイル、現在の不足ファイル、残り読取回数を説明した。上限、配信を有料callに限定する条件、固定oracleは変えていない。

根拠: [loop.go](https://github.com/docker/docker-agent/blob/v1.137.0/pkg/runtime/loop.go)、[structured_output.go](https://github.com/docker/docker-agent/blob/v1.137.0/pkg/runtime/structured_output.go)、[Responses provider](https://github.com/docker/docker-agent/blob/v1.137.0/pkg/model/provider/openai/client.go)。ローカルcheckoutのtagを確認した上で読んだ。VM内のbinaryは公式releaseの固定hashを維持している。

システム指示の修正後、失敗したreportモジュールの単一call probeも成功した。初回のcheck_local不合格から編集・再検査合格・終了toolを経て、別VMの固定受入を通した。0.051984相当、usage完全、cleanup成功。最初のingest probeは0.072924相当だった。2つのprobeは必要な公開入力を最初から与える終了形式の検査であり、依存発見の実走とは区別する。

## 完走した機構実験

いずれもLuna、N=4/C=2、上位0、1 domain・6 module、60,000 token/call、240秒/call、予約0.5相当。semanticは最大24call・受付3相当、stagedは最大48call・受付5相当で実行した。

| 観測 | semantic | staged |
|:---|---:|---:|
| 全体受入・kernel完了 | 成功 | 3段階すべて成功 |
| 実model call | 18 | 28（18 / 5 / 5） |
| 新規の追加読取要求 | 12 | 12 / 0 / 0 |
| 登録した意味依存edge | 12 | 12を保持 |
| credit相当 | 0.444392 | 0.985571 |
| usage不明・未解放予約・境界違反 | すべて0 | すべて0 |
| worker VM / 受入VM | 18 / 7 | 28 / 31 |

semanticは6ファイルを各1回の編集候補で確定した。stagedは初段階の6ファイル、以後の各段階で5ファイルを編集し、reportは現版のpolicyにそのまま対応できたため可視verifierが再検証した。新たな読取要求が0でも、依存を保持したcheckoutには現段階の内容を渡している。全callの入力にある仕様・decoder・registry・policyを固定fixtureの当該段階と照合した。最終採点は毎回独立VMで行い、採点値の変更や実験外からの候補修正は0。

全46callで終了tool応答・完全usage・cleanupを確認した。各段階のqualityPass/protocolCleanはtrue、finalErrorsは空。成功判定は保存したreportだけでなく個別レシート、実差分、kernelのstage snapshotから確認した。採用した集計関数によるCLIも、過去の失敗をfalse、今回の完走をtrueと判定した。

## 検証と記録の範囲

`npm run check`は281テスト成功、固定資料2件一致。追加の機械検査は、既存swarmへ課題を渡した際の担当範囲、生成物の固定91ケース、診断CLIの欠けたレシート、配信済み読取と残り回数の更新を含む。`git diff --check`も成功。GitHub CI workflowはなく、この結果はローカルgateである。

このgoalの7runは合計85call、既知下限2.688059 credit相当、使用量不明1call。失敗runも含む141台のVMをすべて削除し、最終の`sbx ls --json`は空だった。前回PR更新までの費用・失敗は別記録で、ここへ重複加算していない。少数の合成課題での導入確認であり、並行して走らせたrunの所要時間を性能比較に使わない。

公開する[集計と原本hash](docker-agent-completion-evidence.json)に、run別のusage・終了tool・stage・cleanupと採用ファイルのhashを記録した。生レシートは各項目の`.sheep/`配下に保持する。再現手順は[導入ガイド](../docker-agent-sandbox.md)。今回の完了条件を満たしたので、Node 24+ template、VM pool、一般repo・規模比較、Astra介入を含む実比較は後続の拡張として扱う。
