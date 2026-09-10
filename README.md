# sheep-swarm

成果物の変更と依存関係に沿って必要なAgentだけが働く、羊型Agent Swarmの実験用リポジトリ。

下位モデルの群れが局所作業を進め、上位モデルが群れを観測して必要時に介入する。下位から上位への相談経路は設けない。個体数を増やしたときの分業、情報伝播、混雑、収束を、品質・費用とともに確かめる。既存製品から設計を借り、小さなprotocolから始める。

現在の方針は [docs/current-direction.md](docs/current-direction.md) にまとめている。下位4体の動作確認から16体へ進み、8・16・32体の初期比較を実行した。64体は次の探索候補で、最適人数や成功の境目はまだ示していない。

## 現在の状態

**kernel、実Luna worker、選択的な上位介入、8・16・32体の実測、SQLiteからの再開を実装し、別taskで4方式の初期比較まで完了した。**

静的変更・公開レジストリを使う意味依存・3段階の仕様変更も実装し、クレジット相当による実行受付を追加した。新しい48モジュール課題はN8/16/32、C=8で各1回成功した。元の28条件の比較は使用量不明で2条件目に停止し、その後の承認された追加2条件と分けて記録している。

| あるもの | 位置 |
|:---|:---|
| 調査レポートと関連15対話の原文snapshot | [docs/references](docs/references/README.md) |
| 現在の方針・役割分担・規模比較 | [docs/current-direction.md](docs/current-direction.md) |
| 共通CLI・repo v2の依存発見と追加読取 | [CLI](docs/cli.md)、[議論の精査](docs/discussion-review-20260910.md)、[実装・実走](docs/results/repository-discovery.md)、[実行計画](docs/execplan-repository-discovery.md) |
| 段階読取と広い初期contextの同品質pilot | [実測・再現手順](docs/results/read-selection-pilot.md)、[次の計画](docs/execplan-progressive-read.md) |
| TS自己実装・N/C比較・変更からの対象起動 | [結果と限界](docs/results/repository-scale-activation.md)、[実行計画](docs/execplan-repository-scale-activation.md) |
| 現在の設計・不変条件 | [docs/design.md](docs/design.md) |
| 実装順序と各段階の完了条件 | [docs/roadmap.md](docs/roadmap.md) |
| 検証方針と故障シナリオ | [docs/testing-policy.md](docs/testing-policy.md) |
| 継続する設計判断 | [.stratal/brief.md](.stratal/brief.md) |
| kernelと独立受入テスト | [src/kernel.ts](src/kernel.ts)、[tests/kernel.test.ts](tests/kernel.test.ts) |
| 実コードfixtureとCodex adapter | [src/fixture.ts](src/fixture.ts)、[src/codex-worker.ts](src/codex-worker.ts) |
| Docker Agentとmountless microVMの導入 | [導入手順](docs/docker-agent-sandbox.md)、[実測](docs/results/docker-agent-sandbox.md)、[adapter](src/docker-agent-worker.ts) |
| 実験用の直接DeepSeek API adapter | [src/deepseek-worker.ts](src/deepseek-worker.ts)、[共通runtime選択](src/model-runtime.ts)、[runner試験](tests/deepseek-runners.test.ts) |
| OpenCode Goの3 API形式と全runner接続 | [導入方法](docs/opencode-go.md)、[実Lunaによる検証](docs/results/opencode-go.md) |
| 任意Gitリポジトリの対象ファイルを実行 | [利用手順](docs/repository-runner.md)、[実装・実走記録](docs/results/repository-runner.md)、[CLI](src/repo-cli.ts) |
| Agent向けのツール利用skill | [sheep-swarm skill](skills/sheep-swarm/SKILL.md)、[実行評価](docs/evaluations/sheep-swarm-skill/report.md) |
| 実装の進捗と実行証拠 | [docs/execplan.md](docs/execplan.md)、[4体の実測](docs/results/luna-four-worker-pilot.md) |
| 8・16・32体の反復と誤指示条件 | [規模比較の結果](docs/results/scaling-findings.md) |
| SQLiteと実process中断・再開 | [src/durable-run.ts](src/durable-run.ts)、[実Luna再開の結果](docs/results/durable-restart.md) |
| モデル別の費用概算・実行前の見積 | [使い方](pricing/README.md)、[キャッシュ反映の再集計](docs/results/cost-findings.md) |
| 次の課題設定と対照実験 | [研究と設計案](docs/task-design.md)、[条件案JSON](experiments/task-design-v2.json) |
| Docker機構実験の追加読取・段階別隔離 | [実装と検証](docs/results/docker-agent-mechanism.md)、[実行手順](docs/docker-agent-sandbox.md) |
| 3課題・クレジット受付・追加のN比較 | [実測と限界](docs/results/mechanism-findings.md)、[実行ガイド](docs/mechanism-experiment.md)、[実行計画](docs/execplan-mechanism.md) |
| 単一上位・中央管理・2種のSheep対照 | [4方式の結果](docs/results/comparison-findings.md)、[Manager修正後の追加試行](docs/results/manager-observation-fix.md)、[実装](src/comparison.ts) |
| 初期protocolの型草案 | [src/protocol.ts](src/protocol.ts) |
| write skewの有限反例と検証 | [experiments](experiments/README.md) |

実測は合成fixtureでの結果。個体数だけを増やす効果、創発、一般repositoryでの費用優位は未確認。永続化runnerはC=1で、並列の規模比較runnerの再開対応とは区別する。詳細は [実装計画](docs/roadmap.md) を参照。

## 開発を始める

Node.js **24.12.0以上**、npm。初期化時にはNode.js 26.0.0で確認した。

```sh
npm ci
npm run check
npm run demo
```

`check` は型検査、kernel・fixture・adapter・scheduler・SQLite・process中断再開・比較方式・反例モデルのテスト、資料snapshotのハッシュ照合を行う。`demo` は全6スケジュールの遷移と次の集計をJSONで表示する。

```json
{
  "schedules": 6,
  "writeSetOnlyViolations": 4,
  "allObservedReadsViolations": 0
}
```

TypeScriptの実行にはNode.jsのtype strippingを使い、型検査は別に `tsc` で行う。[Node.jsの公式説明](https://nodejs.org/api/typescript.html)

追加のruntime npm packageは使わない。既定の実LLM呼出しには認証済みのCodex CLIを使う。下位は利用者指定の `gpt-5.6-luna`、上位の既定値は `gpt-6-astra`。

`npm run sheep -- repo --repo /path/to/project --task /path/to/task.json`で、別のGit作業ツリーの対象ファイルを既存swarmへ渡せる。固定の検査コマンドをJSONで宣言し、候補を保存する。`--apply`は全体受入・使用量・元ファイルの変更確認に成功した場合だけ指定範囲へ書き戻す。Go DeepSeekの例と対応境界は[repo実行手順](docs/repository-runner.md)へ。専用factoryは不要だが、hostで信頼する検査コマンドと明示した書込対象が必要になる。v1は明示依存、v2は公開範囲内の静的依存発見と追加読取を使う。JavaScript/Pythonの実走を確認した範囲であり、全build環境や費用優位を保証しない。

5主commandは共通のhelp・dry-run・alias・JSON/textに対応する。`npm run sheep -- repo --help`で確認でき、旧入口のJSONと既定値も保持する。task v2は担当固有の指示と実配信した版を追跡し、未解決・不明usageを成功にしない。Go DeepSeekの小規模実走は3targetが5callで固定受入に成功した。[失敗試行を含む証拠](docs/results/repository-discovery.md)。

task v2には1要求のpath上限を追加した。opaqueな24文書からregistryでpolicyを選ぶ2target課題で、Go DeepSeekの局所/広域条件が同じ固定検査に成功した。局所は6call・8,241tokens、広域は2call・5,593tokensで、この小課題では追加読取の総tokensが多かった。読取順の証拠と品質を分離して記録している。[実測と限界](docs/results/read-selection-pilot.md)。

`.ts`/`.mts`の型だけのimportを含む静的解析と、`activation.changedPaths`から依存先のtargetだけを初期起動するopt-inを追加した。TSの実自己実装、16targetでN8/16/32・C4/8の8条件、関連2targetだけの実起動を確認した。規模対照は7成功・1未完了で、失敗分も含めて報告する。TS解析は既存typescript 7.0.2のnative APIを使うため、通常のdevDependenciesを含む `npm ci` が必要。[実測・検証](docs/results/repository-scale-activation.md)。

独立レビューで、検査後のprocess group回収、親Gitの誤参照防止、検査基盤障害での呼出し停止、局所検査の診断引継ぎを補修した。[再現と検証](docs/results/repository-runner-astra-review.md)。

`swarm --runtime deepseek`はDeepSeek APIへ直接接続する。CLIでは環境変数`DEEPSEEK_API_KEY`を設定し、`--worker-model`にprovider prefixのないAPI model idを明示する。OpenCodeの認証storeは自動で読み込まない。toolは使わず、局所promptとschemaを送信し、`finish_reason: stop`と要求schemaへの適合を検査する。要求modelとproviderが返したmodel名は別に保存する。接続仕様は[DeepSeek公式API](https://api-docs.deepseek.com/api/create-chat-completion/)を参照。

```sh
export DEEPSEEK_API_KEY='YOUR_DEEPSEEK_API_KEY'
npm run swarm -- --runtime deepseek --worker-model deepseek-v4-flash --workers 1 --concurrency 1 --size 2 --max-calls 4 --max-meta-calls 0 --max-tokens-per-call 4096
```

利用可能なmodel名を指定する。期限付きの`deepseek-v4.1-flash-expires-on-0910`も明示指定できるが、恒久的な既定値にはしない。`DEEPSEEK_BASE_URL`で接続先を変更でき、既定は`https://api.deepseek.com`。adapterを直接呼ぶ場合は`apiKey`・`baseUrl`も明示指定できる。

DeepSeek workerの上位は既定でCodex/Astra。上位もDeepSeekにする場合は`--meta-runtime deepseek --meta-model <API model id>`を指定する。使用量が欠落・不整合のcallは0と数えず、新規受付と上位介入を止めてrunを失敗にする。

同じruntime選択は`swarm`のほか`compare`・`durable`・`mechanism`にも`--runtime`・`--meta-runtime`・`--worker-model`・`--meta-model`・`--max-tokens-per-call`として渡せる。`compare --method single-worker`はDeepSeekの単独worker対照に使える。`durable`はruntimeとmodelをsnapshotへ保存し、完了runの`resume`は新しいcallを発行せず、不明usageはsnapshotへlockして再開時の再課金を拒否する。`mechanism`はcredit予算seriesを凍結したまま、`--budget-mode tokens --max-tokens --reserve-tokens`でDeepSeek/混合upperをcredit系列と分離したtoken予算で実行できる。credit modeでDeepSeekを指定した場合は有料callの前に拒否する。token予算では消費tokenを合算し、不明usage・receipt欠落・子run失敗で新規受付を止めてfail closedにする。`docs/mechanism-experiment.md`のcredit系列は変更しない。

指定beta IDのworkerで8条件を実行し、すべて受入検査に成功した。DeepSeekは計52call、Manager-localの上位Astraは2call。機構実験は静的依存・意味依存・3段階変更を含む。応答名は`deepseek-flash`として要求IDと別に保存した。[runner横断の実行記録と導入例](docs/results/deepseek-runners.md)、[初回の接続確認](docs/results/deepseek-api.md)を参照。

`--runtime opencode-go --worker-model <API model ID>`でOpenCode Goにも接続できる。LunaのResponses、DeepSeek等のChat Completions、MiniMax等のMessagesを明示catalogで選び、workerごとのsession headerと使用量記録を保存する。認証は`OPENCODE_GO_API_KEY`。各runnerとtoken系列で使える。[導入方法・対応範囲](docs/opencode-go.md)を参照。

Astraの独立レビュー後、OpenCode GoのDeepSeek V4.1 Flashで修正を行った。混合runtimeの使用量不明・途中終了と再開時の停止、role別Docker cleanup、DeepSeek応答の拒否・伏字処理を検証し、404テストが成功した。[レビュー・修正の記録](docs/results/astra-go-review.md)。

`swarm --runtime docker-agent`ではDocker Agent v1.137.0＋sbx v0.42.1へ切り替えられる。各呼出しをhost repo未マウントの新規VMで実行し、承認済み認証をhost proxyから注入する。`npm run sandbox:probe`は実VMの隔離検査、`npm run sandbox:pilot`はLunaの局所編集・別VMでの受入・kernel確定を実行する。下位4体・C=2の既存fixtureも5呼出しで成功した。詳細と未対応範囲は[導入手順](docs/docker-agent-sandbox.md)を参照。

`--worker-tools local`を併用すると、各workerへ版付きの局所ファイルと可視テストを投入し、read/edit/testを利用できる。全workspace差分をlease検査へ渡し、Docker runtimeの受入実行は独立した通信拒否VMで行う。`npm run sandbox:swarm-probe`で基準解・変異・禁止import・timeoutをモデル呼出しなしで検証する。可視テストの成功や最終回答のコードだけでは確定しない。

`compare`にも同じruntime/toolを追加した。単独Luna・Manager-local・Sheep-fixed/fullで共通の可視検査と別VMの固定受入を使う。`npm run sandbox:comparison-probe`は必須importを含むoracle互換を、`npm run sandbox:recovery-probe`は所有processのSIGKILLとVM回収を検証する。次回のruntime起動時に死んだ所有processの残留VMを回収し、`npm run sandbox:reap`でも実行できる。[継続実装と検証](docs/results/docker-agent-comparison-recovery.md)

`mechanism`も`--runtime docker-agent --worker-tools local`に対応する。追加の公開ファイルは別の有料呼出しで届け、現段階の読取が揃ってから可視検査と編集採用を許す。各stageの最終採点は別の通信拒否VMで行い、失敗を次のmodelへ戻さない。`npm run sandbox:mechanism-probe`でモデルなしの互換検査を実行できる。実Lunaでsemanticの6 moduleが18call、3段階更新が28callで完走した。終了tool・完全usage・独立採点・kernel完了・VM削除を確認し、[以前の失敗と今回の成功](docs/results/docker-agent-completion.md)を分けて残している。

```sh
npm run swarm -- --workers 4 --concurrency 4 --size 4
npm run swarm -- --workers 4 --concurrency 4 --size 4 --fault rounded-guidance
npm run swarm -- --workers 16 --concurrency 16 --size 32
npm run durable -- --directory .sheep/durable-luna --size 4 --workers 4
npm run durable -- --directory .sheep/durable-luna --resume
npm run compare -- --method sheep-full --size 8 --workers 4 --concurrency 4 --max-tokens 500000 --reserve-tokens 30000
npm run compare -- --runtime docker-agent --worker-tools local --method single-luna --size 2 --max-calls 5 --max-upper-calls 0 --max-tokens 200000 --reserve-tokens 40000 --timeout-ms 240000
npm run mechanism -- --runtime docker-agent --worker-tools local --family semantic --method sheep --groups 1 --workers 4 --concurrency 2 --max-meta-calls 0 --max-credits 3 --luna-reservation 0.5 --max-calls 24 --max-tokens-per-call 60000 --timeout-ms 240000
npm run mechanism -- --family staged --method sheep --groups 1 --workers 4 --concurrency 4 --output .sheep/my-mechanism-pilot
npm run mechanism -- --runtime deepseek --worker-model deepseek-v4.1-flash-expires-on-0910 --family static --method single-worker --groups 1 --max-meta-calls 0 --workers 1 --concurrency 1 --budget-mode tokens --max-tokens 100000 --reserve-tokens 4000 --max-calls 8 --max-tokens-per-call 4096 --output .sheep/my-token-mechanism
npm run mechanism:experiment -- --budget-mode tokens --runtime deepseek --worker-model deepseek-v4.1-flash-expires-on-0910 --families static,semantic,staged --methods sheep --groups 1 --workers 4 --concurrency 2 --max-tokens 300000 --reserve-tokens 12000 --max-calls 80 --max-meta-calls 0 --max-tokens-per-call 4096 --timeout-ms 60000 --output .sheep/my-token-series
```

これらは実モデルを呼び出す。結果・コード・使用量・失敗履歴は `.sheep/` の一意なrunディレクトリへ保存する。`--max-calls`、`--max-meta-calls`、`--max-rounds`、`--timeout-ms` で上限を指定できる。通常の `npm run check` はモデルを呼び出さない。

`compare` の新規対照は `single-luna`（DeepSeekでは`single-worker`）、`manager-local`、`sheep-fixed`、`sheep-full`。`single-upper`は過去の再現用に保持し、Docker runtimeでの新規実行は拒否する。token予約は呼出しの受付制御であり、providerの強制上限ではない。超過・使用量不明は予算付き比較の成功にしない。`--max-upper-calls`で上位の受付数も制限できる。Sheep-fullが発見するのは実ファイルの静的importと明示された仕様依存であり、任意の意味依存ではない。

通常の単独比較はLunaを使い、利用者が明示したDeepSeekの試行を追加の例外とする。費用の目安を得たAstra単独は新規試行から省く。Astraは群れへの必要時介入で継続する。`mechanism:experiment` はpilot 4条件・main 25条件。`scripts/compare-experiment.mjs`の既定は単独Lunaを含む4方式×3条件で、共通runtime/toolを指定できる。使用量不明・検証基盤障害・cleanup失敗で系列の新規実行を止める。旧単独方式の実装は過去の再現用に残す。

`mechanism:experiment`の既存系列はCodex/tool-lessのまま保持し、今回のDocker試行は個別CLIで記録する。

`npm run swarm:diagnostics`は既存`runSwarm`へ信頼した実装課題を渡し、Lunaの群れが2つの集計モジュールを作る。可視検査と別VMの追加ケースを通してkernelで確定し、repoへは自動で書き戻さない。実際に3callで生成・自己修正し、固定91ケースと差分レビュー後に本体をそのまま採用した。`npm run summarize:docker-mechanism -- <result.json>`で機構runの完了状態・tool応答・usage欠落を集計できる。[固定した実装課題](docs/tasks/docker-goal-completion.md)、[実装と採用の記録](docs/results/docker-agent-completion.md)

`mechanism` の方式は `sheep`、`single-luna`、`single-astra`、`no-memory`、`no-upper`。既定30 credits相当の中で、下位・上位・追加読取・再試行を精算する。使用量不明は0とせず停止する。今回の追加N16/32比較は23.729217／100 credits相当、今回の機構実験全体の既知下限は58.395228相当＋使用量不明1呼出し。N16/32の試行費用では上位介入が約半分を占め、Nを増やす明確な利点はまだ見えていない。各1回・合成課題の観測として[結果](docs/results/mechanism-findings.md)を参照する。

価格とクレジットは2026-09-10の公式レートを保存し、キャッシュを含む994呼出しから再計算した。通常taskのSheep-fixedは平均0.540282 credits相当、単体Astraは7.283 credits相当。実際の請求額・Proの利用枠消費とは区別する。実行前の概算は `npm run estimate:cost -- --rates pricing/openai-2026-09-10.json --scenario pricing/planned-run.example.json --output .sheep/planned-cost.json` で試せる。

## 守る設計

- 会話相手を固定する代わりに、版付きartifactの依存から影響先を求める。
- 作業の予約、変更権限、共有状態への確定を分ける。
- 判断のread set、根拠、欠けた情報を保持する。
- 訂正時には、古い根拠から作られたレビューや完了証拠も再確認する。
- `seen`、処理終了、run全体の成功を別に扱う。
- 下位の作業ループと上位の観測・介入ループを分ける。介入は版付きの仕様・制約・担当等へ反映する。
- 運用メタ管理の介入は通常動作として計上する。評価用shadow observerの助言はrunへ戻さない。
- 人数、最大同時実行数、実際の稼働数を分け、同じ仕事での増員と仕事量も増やす比較を行う。

詳細と未解決点は [設計](docs/design.md) を参照。Agentで作業するときは先に [AGENTS.md](AGENTS.md) を読む。

## License

[MIT](LICENSE)
