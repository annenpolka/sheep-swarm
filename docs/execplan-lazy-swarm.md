# 実装者が必要な部分だけ委譲するlazy swarm

このExecPlanは作業中も進捗・判断・証拠を更新する。

## Purpose / Big Picture

既存packet-allを維持し、単体の実装者が直接候補を出す通常経路に、必要時だけ子へ任せる選択肢を追加する。別plannerを必須にせず、親は会話と作業候補を保って継続する。最小版は親1体・子はrun全体で最大2体・再帰なし。品質と受入完了までの実所要時間を測り、forkしない場合の同等速度を仮定しない。

## Progress

- [x] (2026-09-12 03:51:28Z) 添付の議論とPR #11の結果を確認、#11をbaseへマージ。新規codex/lazy-swarmへ分岐。
- [x] (2026-09-12 03:59:00Z) Goのthinking/tool会話継続を専用adapterで実確認。初回の出力形式失敗と再確認成功を保存。
- [x] (2026-09-12 04:03:00Z) 親の直接提出、非同期fork、明示join、scope/read版/shared budgetをrunnerとCLIへ接続。
- [x] (2026-09-12 04:16:15Z) 注入callerの反例を含む613テスト、型検査、参照2件、最終smoke10条件と全候補・receiptの独立監査が成功。
- [x] (2026-09-12 04:15:03Z) 三方式の比較軸と実装境界、Go probe、smoke-v1/v2/v3の成功・失敗・修正理由を文書化した。

## Surprises & Discoveries

- Observation: tool checkpointのadditionalPropertiesへschemaを渡す形は既存validatorの未対応だった。
  Evidence: smoke-v1のlocal-lazyはnetwork前の例外をunknown usageに分類した。実tool schemaの通常gateと予約前の会話preflightを追加し、元記録は保持した。
- Observation: 最初のcoupled fixtureは公開仕様にコロン後の空白の扱いが曖昧だった。
  Evidence: smoke-v2は三方式とも同じ空白差でholdout失敗。oracleを変えず、smoke-v3の公開仕様へexact literalを追加した。系列間の成績差をruntime改善としない。
- Observation: 同じassistantが複数toolをまとめて返すと、途中checkpoint後の新しいread版を後続toolへ無言で割り当てる危険がある。
  Evidence: lazyは1turn1toolに限定し、複数toolは全件無実行で返す反例を追加した。一般Go adapterの複数tool対応とは別のrunner制限。

既存Go adapterは毎回system/userを組み直す。session headerだけでは継続できない。packet runnerはwave単位でモデル完了を待つため、そのままでは親子の非同期実行にならない。

## Decision Log

- Decision: 既存tool-less adapterを保ち、明示的なmessages/toolsを扱う専用入口を追加する。
  Rationale: 凍結packet-allの挙動を変えずに継続契約を検証する。
  Date/Author: 2026-09-12 / Codex
- Decision: 実装は同じGo DeepSeek Flash・thinking有効、子2体まで、非再帰、上位0、task締切なし。
  Rationale: 引継ぎと並行実装の効果をモデル差や常設管理費から分離する。
  Date/Author: 2026-09-12 / Codex
- Decision: 使用量不明のrunは確定・applyを拒否して既発行callを回収する。再試行は元の不明費用を残した別attemptとし、子の増員で予算をリセットしない。
  Rationale: 既存受付規則と利用者の失敗再試行方針を両立させる。
  Date/Author: 2026-09-12 / Codex

## Outcomes & Retrospective

最小runtimeとCLIを実装し、強制forkの実DeepSeek試行で親子のmodel callが重なり、固定受入まで成功した。自然な小課題でのfork選択と速度改善は別の評価課題。大規模比較や一般repoの有効性は未実証。

## Context and Orientation

作業rootは /Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm。src/opencode-go-worker.tsは単発APIとreceipt、src/kernel.tsはscopeと版の確定境界、src/token-budget.tsは全callの予約と使用量精算、src/repo-files.tsは固定snapshotと採用時drift検査、src/repo-checks.tsは固定host検査を担う。forkは限定scopeの子jobの起動、joinは必要な子の完了を待って候補を検査する操作。read stampsは実配信した現在内容のversionとevidenceEpochを指す。

## Plan of Work

まずGo専用の会話型を追加し、assistant/toolの対応IDとthinking履歴を検査する。既存単発呼出しは変更せず、会話入口だけtoolsを許可する。実Goでtool要求・host応答・次turnの継続を確認する。

続いてrepoのsnapshot、kernel、budgetと組み合わせたlazy runnerを追加する。子は起動時の固定current snapshotを読み、限定scopeの候補だけを返す。親のwrite scopeから子の担当を外す。親は子が処理中でも次callへ進める。同時model call上限は親子で共有し、call開始前に予約とrequestを保存する。子の結果をjoinで検査し、古いreadは自動採用せず親へ引き取る。最終oracleの失敗内容をモデルへ返さない。

最後に旧packet-all、新rootの子なし、新rootのfork許可という3対照を準備する。今回の小規模試行は通信・動作確認に限定し、速度仮説の本採点は別の凍結系列にする。

## Concrete Steps

作業rootで npm run typecheck、node --test tests/opencode-go-conversation.test.ts tests/repo-lazy-run.test.ts、npm run check、git diff --check を実行する。通常gateは外部APIを呼ばない。実Go probeは scripts/probe-go-conversation.mjs を新しいoutputに指定し、request/receiptとsummaryを保存する。二重実行で証拠を上書きしない。

## Validation and Acceptance

直接提出は子0・1 model callで固定検査まで完了する。fork後に子の完了を待たず親callが開始し、C上限を守る。親子writeの重複、未配信path、古いread、未解決子、使用量不明、予約超過、検査基盤失敗、source driftを成功へ変えない。公開検査の失敗は候補とともに親へ返し、hidden失敗後には追加model callをしない。全発行callを精算し、失敗completionはnullとする。

小修正の追加負担は群全体で測り、fork成功例だけの速度を成果としない。本比較は公開作業構造で事前選択した局所修正・独立した複数変更・共通仕様で結合した変更を含め、方式順を均衡化する。paired成功時間と品質を主指標に、fork判断時刻・実model重複時間・join待ち・追加継続call・破棄した子tokensを残す。

## Idempotence and Recovery

output directoryの再利用を拒否する。共有repoへは成功・全call精算・drift一致後の明示apply時だけ書く。子は共有repoを直接変更しない。crash後の会話/並行run再開は今回未対応。失敗の元receiptを保持する。

## Artifacts and Notes

マージcommit: f16a5905c6a7b00e48fd4d82f9883840cd87f93a。PR #11はSingle/固定allが24/24、planned23/24で、独立plannerは既定に採用しない。今回も性能判定を実装成功と区別する。

## Interfaces and Dependencies

callOpenCodeGoTurn はGoMessage列とGoTool列を受け、GoAssistantと既存形式のusage/receiptを返す。GoMessageのassistantはreasoning_contentを保持する。root/child callerはテストで注入可能にする。新依存packageは追加せずNode fetch、既存SwarmKernel、TokenBudget、snapshot/checksを使う。
