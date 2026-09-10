# OpenCode Go対応 — Luna swarmの実装と実行確認

2026-09-10。`codex/deepseek-api`上で、利用者指定のLuna 3体に実装を分担した。通信adapter、runner統合、使用量集計を並行して進め、親が固定条件による独立検証と統合を行った。OpenCode Go経由の実Lunaでも4条件すべてが成功した。

## 実装範囲

- `src/opencode-go-worker.ts`: 明示model catalog、Chat Completions / Responses / Messages、Go専用key・base URL、User-Agent/session header、JSON/schema検査、上限付き応答保存、timeout・取消・HTTP失敗の記録。
- 共通runtimeと`swarm`・`compare`・`durable`・`mechanism`: `opencode-go`を明示選択し、role別model、出力上限、opaque sessionを渡す。durableはsession seedを保存し、旧Codex/DeepSeek snapshotとGoの欠損snapshotを区別する。
- 使用量: provider形式に従ってcacheとreasoningを一度だけ数え、欠落・矛盾・HTTP失敗を完全usageへ変えない。GoのsubscriptionをCodex creditや直接DeepSeekの価格で評価しない。

使い方と対応model例は[導入手順](../opencode-go.md)に記載した。上位は既定でCodex/Astra、上位もGoにする場合はruntimeとmodelの明示が必要。

## 実APIの結果

既存のGo認証を親が明示的に取得し、child process環境の`OPENCODE_GO_API_KEY`だけへ渡した。adapter自体にはhost認証storeを読む機能を追加していない。全13callがOpenCode GoのResponses endpointを通り、要求・応答modelはともに`gpt-5.6-luna`、HTTP 200、usage完全だった。

| 条件 | worker数 / 最大同時数 | 下位 / 上位call | input / output tokens | 結果 |
|:---|:---|---:|---:|:---|
| swarm、size 2 | 2 / 2 | 3 / 0 | 2,569 / 818 | 全3成果物が確定 |
| compare、single-worker、size 2 | 1 / 1 | 1 / 0 | 990 / 573 | 固定受入成功 |
| durable、size 2 | 1 / 1 | 3 / 0 | 2,719 / 756 | 完了・再開成功 |
| mechanism token系列、static、1 group | 4 / 2 | 6 / 0 | 12,789 / 1,858 | 全6module・固定受入成功 |

合計13call・23,072tokens。全call receiptを再集計し、worker内のsession安定性とworker間の分離を確認した。durableは完了後にAPI keyを渡さずresumeし、追加callなしで成功した。未完了runの安全なcheckpoint後に新しいcallを発行し、sessionが変わらないことは注入callerの独立テストで確認した。

出力上限は全callで4,096tokens、timeout 90秒。機構実験は受付上限100,000tokens、予約12,000tokens、16call以内で実施し、実測14,647tokens・6callで終了した。上位callはどの実試行でも0。

## 独立検証

親側の反例で、credentialの反射、非assistant応答、JSONと同居するtool出力、cache/reasoning不整合、異なるAPI形式のusage混入、出力上限なしの要求を検出した。Lunaへ具体的な反例を戻して修正し、最後に親が通信側とreceipt側のusage正規化を統一して、Messagesの計数と例外経路を整えた。swarmにも要求model identityの照合を追加した。

- `npm run check`: 378テスト・型検査・2参照snapshot照合に成功。
- 3 API形式それぞれでCLI→loopback HTTPを通し、swarm、比較、上下GoのManager、durable再開、mechanismのstatic/semantic/staged、公開token系列を検証した。正答は固定fixtureから与え、oracleは変更していない。
- usage欠落では新規受付停止・run失敗。usage metadata付き429も1 request後に停止し、adapterやrunnerが再試行しないことを検証した。
- timeout/取消、応答過大、HTTP失敗、schema違反、不正model/role/session、旧snapshot移行とGo seed欠損拒否を検査した。
- 実Go/Luna receiptに既存OpenAI価格表を渡しても、API USD/Codex creditはunknownのまま。tokenは1,563と集計され、同じmodel名だけで料金を流用しなかった。
- 作業開始時の既存tests・experiments・参照資料のhashはすべて不変。今回追加したテストだけを増補した。
- `git diff --check`: 成功。変更は未コミット。

GoのLuna以外のmodel、Chat Completions/Messagesの認証付き実API、Goを上位にした実API介入は今回のlive検証に含まない。少数の合成課題から、一般repositoryでの有用性、規模効果、実請求額や性能優位は判断しない。直接APIはtextとJSON成果物を扱い、モデルによるtool実行や画像入力は提供しない。

生の証拠はGit対象外の`.sheep/opencode-go-validation-2026-09-10/`へ保存した。各`*-execution.json`は引数と実行時の主要source hash、`verified-summary.json`はreceipt再集計、`cost-isolation.json`は料金識別確認を含む。公開model一覧、CLI監査ログ、最終gateのログも同じdirectoryへ保存した。

## 後続の独立レビュー

この初期検証の後、Astraの独立レビューとGo DeepSeek V4.1 Flashによる修正を行い、親の404テスト・型検査・参照照合が成功した。混合runtimeの停止・再開、role別cleanup、直接DeepSeekの応答検査等を修正した。[後続のレビュー記録](astra-go-review.md)。上記13callの実API記録は元の実行時点の証拠として保持する。
