# 全体を読んでから作業境界を選ぶplanner

この文書は実装・検証・実走に合わせて更新する実行計画である。

## Purpose / Big Picture

固定したファイル数で分割する代わりに、DeepSeek Flashが全公開repoとtaskを1callで読み、担当・必要な入力・依存順・触らないtargetを提案する。hostが検証してscopeを固定し、workerは担当に必要な入力だけで実装する。全targetを1packetにまとめる判断も許す。plannerの費用と時間を含め、分解する価値があるかを小規模な実測で調べる。

## Progress

- [x] (2026-09-11 23:49:16Z) PR #10をPR #8のブランチへマージした。
- [x] (2026-09-12 00:13:30Z) WorkPlanの入力検証・重複scopeの統合・依存の正規化を実装する。
- [x] (2026-09-12 00:13:30Z) 同じkernelで計画を実行し、plannerを含む共有予算と証拠を保存する。
- [x] (2026-09-12 00:13:30Z) CLIと独立反例を追加。593 tests、型検査、参照2件、diff checkが成功。
- [x] (2026-09-12 00:52:44Z) dev24課題×3条件を凍結し、全72試行・101callを実行・監査した。

## Surprises & Discoveries

監査試験で、JSON保存後の通常objectとメモリ上のnull-prototype objectの比較差を検出した。内容を通常objectへ揃えて比較し、HTTP 500からの回復試験が成功した。

#10のworkerは全公開baselineを既に受け取っていた。新方式ではplannerが全公開入力を見て、workerには選択した公開入力と現在依存版を渡すため、旧固定packetとの比較は分割だけでなく入力選択を含む方式比較になる。

plannerの形式拒否1件は余分なtop-level fieldによるものだった。コピーからそのfieldを除けばscope検証を通ったが、worker未起動の原試行を成功へ読み替えない。

## Decision Log

- Decision: 固定packet対照はpacket-allを使う。
  Rationale: dev全件比較で最も良かった方式を対照にし、弱い固定分割へ勝つことを目標にしない。
  Date/Author: 2026-09-12 / Codex
- Decision: plannerは同じDeepSeek Flashの1call。全targetの担当またはuntouchedへの明示分類を要求し、重複writeと依存循環はhostが一つのpacketへ統合する。
  Rationale: 分割しない判断を許し、競合するwriteを複数agentに与えない。plannerのtextは主張であり、write権限と採点条件はhostが決める。
  Date/Author: 2026-09-12 / Codex
- Decision: 24課題は8dev familyから各3件を公開metadataだけで決定し、Single・固定all・plannedの3条件を新規実行する。
  Rationale: 同時期の対照を取り、既知の失敗場所を起動hintにしない。evaluationとManagerは今回呼ばない。
  Date/Author: 2026-09-12 / Codex

## Outcomes & Retrospective

実装・593 tests・型検査・参照2件と、24課題×3方式の実モデル比較・独立監査を完了した。[結果](results/semantic-decomposition-findings.md)。Single/固定allは24/24、plannedは23/24成功。有効23plan中21件が1packetだが、成功組の時間比中央値はplannedがSingle比1.36倍・固定all比1.48倍。独立plannerを既定にせず、opt-inの研究経路に保つ。

## Context and Orientation

作業先は/Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm。src/repo-packet-run.tsは全対象を機械的に分割するexecutor、src/repo-packets.tsは公開依存から循環を壊さず分割する関数。kernelは読んだ版とwrite権限を検査し、候補全体を原子的に確定する。experiments/repository-single.tsは全体一括修正の旧Single対照。凍結corpusはexperiments/synthetic-corpus配下、前回profileとfixtureは.sheep/packet-sweep/dev-v2に保存されている。protectedはモデルへ配信しない最終採点ファイルであり、plannerにも渡さない。

## Plan of Work

src/repo-work-plan.tsでWorkPlanを厳密に検証し、target全集合のcoverage・public read scope・ID/依存・重複writeを処理する。公開static依存とplannerが要求したreadから依存を補い、循環は同じpacketへ統合する。hostが追加した統合・readを別記録にする。

src/repo-packet-run.tsへ検証済みWorkPlanによるpartitionを追加し、既存の固定packet経路は同じ出力とpromptを維持する。新経路のbaselineはpacketごとに必要な公開pathへ限定し、current overlayと全体oracleを維持する。untouchedにモデルwrite権限を与えず、最終受入から除外しない。

src/repo-planned-run.tsでplannerを1call実行し、使用量を精算してからworkerへ移る。planner分を差し引いた残りcall/token枠をexecutorへ渡し、全消費を保存する。不正planや品質失敗を再抽選しない。通信障害は利用者指定どおり条件全体を最大3回再試行し、未知usageと予約控除を保持する。

CLIへopt-inを接続し、dry-runでは有料plannerを呼ばない。最後に3条件×24課題を固定順で実行し、planner overheadを含むpaired結果を保存する。

## Concrete Steps

作業先で次を実行する。通常gateは全成功を期待し、モデルを呼ばない。

    npm run check
    git diff --check

新しい実験はprepareで公開/非公開hash・fixture・順序・runtimeを凍結し、その出力先だけでrunする。`node scripts/semantic-decomposition-pilot.mjs prepare|run|audit .sheep/semantic-decomposition/dev-v1`を使う。既存Go認証は承認済みのメモリ内読込だけを使い、秘密を保存しない。

## Validation and Acceptance

plannerが全targetを1packetへ入れる例、少数targetだけを書いて残りをuntouchedにする例、複数独立packetを並列に動かす例を実repo fixtureで確認する。重複write/循環が統合され、protected・未知path・欠落target・不正IDはworker開始前に拒否されることを確認する。planner依存とstatic依存がscopeを超えて権限を増やさず、workerには選択した入力だけが届くことを確認する。untouchedを誤って選ぶと全体oracleが失敗し、hidden診断がplanner/workerへ戻らないことを確認する。planner usage欠落・認証違い・予約超過でworkerを起動しない。実験完了には全72条件の記録とreceipt/候補/固定fixture監査が必要。

## Idempotence and Recovery

各runは新規outputを要求する。既存の凍結系列とcontrollerは変更しない。通信障害のみ新しいattemptへbaselineから再実行する。過去試行の費用と待機を合算し、共有上限をリセットしない。pendingが残った場合は発行済みcallの生存と精算を確認してから対応する。task全体の時間締切はなく、通信timeout600秒、出力64,000tokens、1call予約200,000、条件総2,000,000tokens/128callをplannerも含めて共有する。

## Artifacts and Notes

PR #10 merge commit: 11bee3551d007776374df359ad86f650a477afb4。新ブランチはcodex/semantic-decomposition。生のplan、hostで正規化したplan、prompt/read、planner/worker receipts、全体受入、全消費を出力先に保存する。

## Interfaces and Dependencies

WorkPlanはpackets（id、writablePaths、relevantPaths、objective、invariants、dependsOn）、untouchedPaths、rationaleを持つ。parse/compileはunknownから検証する純粋関数。実行は既存のcallOpenCodeGo、TokenBudget、SwarmKernel、runRepoChecksを使い、新しい外部依存やmerge agentを追加しない。planner textは固定taskとoracleを上書きできない。

完了profile hash: e603bd3d0aae66685547eba8c08fa57b4f1e365bebf2af8bac7b7a0879c2ed90。実走revision: 4b3b00a713ae47e8f3cc52ca65ec483419111414。保存先は.sheep/semantic-decomposition/dev-v1、公開結果はdocs/results/semantic-decomposition-dev.{json,md,png,svg}。通信再試行0・不明usage0、全tokens 1,272,505。
