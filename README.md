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
| 現在の設計・不変条件 | [docs/design.md](docs/design.md) |
| 実装順序と各段階の完了条件 | [docs/roadmap.md](docs/roadmap.md) |
| 検証方針と故障シナリオ | [docs/testing-policy.md](docs/testing-policy.md) |
| 継続する設計判断 | [.stratal/brief.md](.stratal/brief.md) |
| kernelと独立受入テスト | [src/kernel.ts](src/kernel.ts)、[tests/kernel.test.ts](tests/kernel.test.ts) |
| 実コードfixtureとCodex adapter | [src/fixture.ts](src/fixture.ts)、[src/codex-worker.ts](src/codex-worker.ts) |
| Docker Agentとmountless microVMの導入 | [導入手順](docs/docker-agent-sandbox.md)、[実測](docs/results/docker-agent-sandbox.md)、[adapter](src/docker-agent-worker.ts) |
| 実装の進捗と実行証拠 | [docs/execplan.md](docs/execplan.md)、[4体の実測](docs/results/luna-four-worker-pilot.md) |
| 8・16・32体の反復と誤指示条件 | [規模比較の結果](docs/results/scaling-findings.md) |
| SQLiteと実process中断・再開 | [src/durable-run.ts](src/durable-run.ts)、[実Luna再開の結果](docs/results/durable-restart.md) |
| モデル別の費用概算・実行前の見積 | [使い方](pricing/README.md)、[キャッシュ反映の再集計](docs/results/cost-findings.md) |
| 次の課題設定と対照実験 | [研究と設計案](docs/task-design.md)、[条件案JSON](experiments/task-design-v2.json) |
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

追加のruntime npm packageは使わない。実LLM呼出しには認証済みのCodex CLIを使う。下位は利用者指定の `gpt-5.6-luna`、上位の既定値は `gpt-6-astra`。

`swarm --runtime docker-agent`ではDocker Agent v1.137.0＋sbx v0.42.1へ切り替えられる。各呼出しをhost repo未マウントの新規VMで実行し、承認済み認証をhost proxyから注入する。`npm run sandbox:probe`は実VMの隔離検査、`npm run sandbox:pilot`はLunaの局所編集・別VMでの受入・kernel確定を実行する。下位4体・C=2の既存fixtureも5呼出しで成功した。詳細と未対応範囲は[導入手順](docs/docker-agent-sandbox.md)を参照。

```sh
npm run swarm -- --workers 4 --concurrency 4 --size 4
npm run swarm -- --workers 4 --concurrency 4 --size 4 --fault rounded-guidance
npm run swarm -- --workers 16 --concurrency 16 --size 32
npm run durable -- --directory .sheep/durable-luna --size 4 --workers 4
npm run durable -- --directory .sheep/durable-luna --resume
npm run compare -- --method sheep-full --size 8 --workers 4 --concurrency 4 --max-tokens 500000 --reserve-tokens 30000
npm run mechanism -- --family staged --method sheep --groups 1 --workers 4 --concurrency 4 --output .sheep/my-mechanism-pilot
```

これらは実モデルを呼び出す。結果・コード・使用量・失敗履歴は `.sheep/` の一意なrunディレクトリへ保存する。`--max-calls`、`--max-meta-calls`、`--max-rounds`、`--timeout-ms` で上限を指定できる。通常の `npm run check` はモデルを呼び出さない。

`compare` の方式は `single-upper`、`manager-local`、`sheep-fixed`、`sheep-full`。token予約は呼出しの受付制御であり、providerの強制上限ではない。超過・使用量不明は予算付き比較の成功にしない。Sheep-fullが発見するのは実ファイルの静的importと明示された仕様依存であり、任意の意味依存ではない。

今後の単独比較はLunaに統一し、費用の目安を得たAstra単独は新規試行から省く。Astraは群れへの必要時介入で継続する。`mechanism:experiment` はpilot 4条件・main 25条件、旧 `scripts/compare-experiment.mjs` の既定も単独上位を除外する。旧単独方式の実装は過去の再現用に残す。

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
