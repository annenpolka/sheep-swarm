# sheep-swarm

成果物の変更と依存関係に沿って必要なAgentだけが働く、羊型Agent Swarmの実験用リポジトリ。

下位モデルの群れが局所作業を進め、上位モデルが群れを観測して必要時に介入する。下位から上位への相談経路は設けない。個体数を増やしたときの分業、情報伝播、混雑、収束を、品質・費用とともに確かめる。既存製品から設計を借り、小さなprotocolから始める。

現在の方針は [docs/current-direction.md](docs/current-direction.md) にまとめている。下位4体は動作確認、最初の本実験は下位16体＋上位1体、初期比較は8・16・32体、64体は次の探索候補。具体的な人数は検証前の作業上の既定値である。

## 現在の状態

**初期化済み。kernel、LLM worker、メタ管理、規模比較は未実装。**

| あるもの | 位置 |
|:---|:---|
| 調査レポートと関連15対話の原文snapshot | [docs/references](docs/references/README.md) |
| 現在の方針・役割分担・規模比較 | [docs/current-direction.md](docs/current-direction.md) |
| 現在の設計・不変条件 | [docs/design.md](docs/design.md) |
| 実装順序と各段階の完了条件 | [docs/roadmap.md](docs/roadmap.md) |
| 検証方針と故障シナリオ | [docs/testing-policy.md](docs/testing-policy.md) |
| 継続する設計判断 | [.stratal/brief.md](.stratal/brief.md) |
| protocolの型の草案 | [src/protocol.ts](src/protocol.ts) |
| write skewの有限反例と検証 | [experiments](experiments/README.md) |

型の存在はruntimeの入力検証や権限制御を意味しない。反例実験が通ることも、羊型が実コードを修正できることを意味しない。次に実装する対象は [M1: 小さなin-memory kernel](docs/roadmap.md) である。その後、実worker接続と規模比較へ進む。

## 開発を始める

Node.js **24.12.0以上**、npm。初期化時にはNode.js 26.0.0で確認した。

```sh
npm ci
npm run check
npm run demo
```

`check` は型検査、反例モデルのテスト、資料snapshotのハッシュ照合を行う。`demo` は全6スケジュールの遷移と次の集計をJSONで表示する。

```json
{
  "schedules": 6,
  "writeSetOnlyViolations": 4,
  "allObservedReadsViolations": 0
}
```

TypeScriptの実行にはNode.jsのtype strippingを使い、型検査は別に `tsc` で行う。[Node.jsの公式説明](https://nodejs.org/api/typescript.html)

runtime依存はまだない。SQLite、LLM adapter、worktree操作、message brokerを初期化のためだけに追加しない。

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
