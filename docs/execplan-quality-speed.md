# DeepSeek Flashの品質と実所要時間を比較する

## Purpose / Big Picture

利用者指定に従い、opencode-go/deepseek-flashを主ベンチマークにし、単体と現行Sheepが同じrepo変更を正しく完了できるか、実際に何秒かかったかを測る。固定時間内成功率は使わない。コストは上限制約と補助指標。PR #6のf04b191を基準に、policyや言語adapterを増やさず比較器と固定課題を追加する。

## Progress

- [x] (2026-09-10 23:20:00Z) clean mainからcodex/deepseek-quality-speedを作成。既存runnerと計測・検証契約を確認。
- [x] (2026-09-10 23:35:00Z) 単体の複数file応答validator、公開検査と非公開oracleのfixtureを作る。
- [x] (2026-09-10 23:35:00Z) 単体runnerと比較script、失敗時nullの完了時間と独立検査を実装する。
- [x] (2026-09-10 23:35:00Z) 初回12runを保存。
- [x] (2026-09-10 23:34:37Z) 単体schemaを対象名固定へ修正した別12runを実行し、初回と区別して保存した。
- [x] (2026-09-10 23:34:37Z) 496テスト・型検査・原資料照合、全24run監査、現行方針・実測文書・commit準備を完了。

## Surprises & Discoveries

既存repoは1callにつき1target。workers=1は複数fileを一度に変更できる単体対照ではない。単体専用runnerは同じsnapshot/host check/TokenBudgetを再利用するが、1callで全targetの候補を提出できる。

## Decision Log

- Decision: 固定時間による採点・task締切は設けず、完了は固定oracleと独立再検査で決める。未完了はelapsedMsを残し、completionMsはnull。
  Rationale: 利用者の「どれだけかかるかだけ測る」に従う。通信単位timeoutは基盤停止として記録し速度得点にしない。
  Date/Author: 2026-09-11 / 利用者。
- Decision: runtime opencode-go/model deepseek-flash/thinking disabled、upper0、単体1/C1、Sheep N4/C2。独立3targetと依存連鎖3target、各variant3つで6paired task。
  Rationale: 小規模な比較器の初期実走。N16の規模実験やManager/上位介入の効果はここでは主張しない。
  Date/Author: 2026-09-11 / Codex。
- Decision: 各方式同じ全公開catalog・指示・書込範囲・公開check・holdoutを使う。単体は全公開情報を初期配信、Sheepは既存の静的/追加配信。単体へ未知の依存正解を渡さない。hidden oracleは終了時だけ、結果を修復promptへ戻さない。
  Rationale: 単体の自由な複数file修正を認める。これは方式全体の比較で、contextやactivation単独の効果とは呼ばない。
  Date/Author: 2026-09-11 / Codex。
- Decision: 各run最大12call/120000tokens、予約20000、出力上限8000、通信timeout120000ms。12runの総受付上限1440000tokens、部品実装最大60000を別会計。未知usage・予約超過・検証基盤障害で後続停止。既知の品質失敗は保持して次の独立条件を続ける。
  Rationale: 費用は有限にし、時間は打切採点にしない。上限による未完了を速い成功へ扱わない。
  Date/Author: 2026-09-11 / Codex。

- Decision: 初回の単体応答は配列長とpathをschemaで限定せず、readonly file追加返却で修復が続いた。単体の返却file名をschemaの必須propertyとして固定する。受入・scope・課題内容は変えず、初回を置換しない。
  Rationale: コード品質と出力形式の負担を分ける対照。修正にhidden診断や採点値を使用していない。初回分を含む総token上限を保持する。
  Date/Author: 2026-09-11 / Codex。

## Outcomes & Retrospective

対象名固定系列は単体5/6・Sheep4/6成功。両成功3課題の所要時間はSheepが1課題、単体が2課題で短かった。公開下流エラーから上流へ戻れず5回修復する失敗を固定テストへ追加した。比較74call/171836tokens、部品1call/2514tokens。未知usage・予約超過0。全24runの独立検査・元repo不変・receipt監査が成功し、通常gate496件。一般的優位を主張せず、次は公開証拠による受理済みproviderの再検査を優先する。

初回12runは単体3/6・Sheep6/6。単体の1条件でreadonly fileを追加返却して12callを使い切り、配列応答の形式負担が比較に混入した。初回を保持し、対象名をschemaで固定するnamed responseへ変更した対照12runを別directoryに追加する。総受付上限1440000tokensは初回の既知消費を繰り越して維持する。Manager比較、progressive activation、read widening、追加言語は次の段階として残す。

## Context and Orientation

repo rootは/Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm。src/repo-run.tsはfile単位のSheep実行、src/repo-files.tsはGit snapshot、src/repo-checks.tsは隔離HOMEのhost検査、src/token-budget.tsは未知usageで停止する台帳。experiments/repository-patch.tsとrepository-single.tsを追加し、scripts/quality-speed-fixture.mjsとquality-speed-benchmark.tsで同一課題の比較を組み立てる。holdoutとはworkerへ本文も診断も戻さない最終採点用テストである。

## Plan of Work

Go swarmへ純粋な複数file応答validatorを委譲する。親がoracleと基準解を独立に作り、baseline失敗・基準解成功・変異失敗を先に確認する。単体runnerは公開検査だけを修復へ返し、hidden oracleは最後の1回だけ実行する。比較scriptは開始前から独立再検査・元repo確認までの総時間を測り、失敗時間をnullの完了時間から分ける。6課題を方式の先後交互で実行する。

## Concrete Steps

rootでnode --test tests/repository-patch.test.ts tests/quality-speed*.test.ts、npm run check、git diff --check。比較はnode scripts/quality-speed-benchmark.ts OUTPUTで実行する。既存keyの親メモリ明示設定を再利用し、認証を書き出さない。

## Validation and Acceptance

単体が複数fileを同時更新できること、未公開fileを書けないこと、未知usageで停止すること、hidden oracleが次callへ戻らないことを注入callerで検査する。全runは同じ独立受入、完全usage、元repo不変、actual model証拠、全体elapsedと成功時だけのcompletionを保存する。準備工数は計測開始以降の経過を保存し、人間の実作業時間と混同しない。個々のcall時間合計は並列総時間と区別する。

## Idempotence and Recovery

新しいoutput directoryへ保存し、過去runや原資料を上書きしない。失敗を再試行して成功に置換しない。採点条件に不備があればモデル実行前に修正し、実走後なら別profileで再計画する。元repoへapplyしない。

## Artifacts and Notes

.sheep/quality-speed-buildに部品実走・preflight・本比較rawを保持し、docs/results/deepseek-quality-speed.mdとJSONへ公開集計する。

## Interfaces and Dependencies

parseRepositoryPatch(unknown,targets)は全targetのstring map。runSingleRepositoryは既存RepoRunOptionsの限定subset、Go caller、TokenBudget、runRepoChecksを使う実験専用baseline。npm依存追加なし。既存CLI/default modelを変えず、主benchmark方針を文書へ反映する。
