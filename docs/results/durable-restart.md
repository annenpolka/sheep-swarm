# 永続化と実Lunaの再開

2026-09-10 JST。[実走の再検証データ](durable-restart-v1.json)。`src/durable-run.ts` は並列の規模比較runnerとは別のC=1実行系であり、M3の並列実行をそのまま再開する機能とは区別する。

## 保存する境界

SQLite WAL/FULLへ、artifact、版、根拠世代、event/outbox、義務、検証済み候補、介入履歴、個体記憶、呼出予約をまとめて保存する。保存世代の比較により、二つの接続が古いsnapshotを上書きすることを拒否する。LLM実行中はtransactionを開いたままにしない。

再開時は未処理通知を配送し、runningの義務をpendingへ戻す。旧leaseのepochを更新し、準備中・検証中の候補を破棄する。既に確定したproposal IDとその結果は保持する。保存失敗後のkernelは新たな確定と完了を拒否し、DBを読み直すまで続行しない。

モデルへの呼出しは先に予算枠を保存する。応答receiptがないまま終了したcallはunknownとして枠を消費したまま残し、使用量をゼロへ置換しない。応答済みでも未確定ならabandonedとして保持し、新しい権限で再試行する。確定済みならledgerからcommittedへ照合する。

## 実processの検証

固定出力の独立oracleを使い、initialized、before/after-call、after-seen、before/after-commit、before/after-delivery、before/after-intervention、completedの11境界で子processをSIGKILLした。再open後に実Nodeの外側oracle、未配送通知、未処理義務、旧権限、確定IDを検証した。

実Lunaでも次の二条件を実行した。試験対象の子processだけを停止し、同じDBから専用CLIで再開した。

| 強制終了位置 | 下位呼出し | 上位呼出し | 仕様変更 | 入力 / 出力token | 最終受入 |
|:---|---:|---:|---:|---:|:---:|
| 最初のworker確定直後 | 5 | 0 | 0 | 94,858 / 1,191 | pass |
| 誤指示を修正する上位の確定直後 | 8 | 1 | 1 | 177,091 / 2,902 | pass |

中断したcall-1 / call-4は再開後も同じcommitted IDとして1件だけ存在し、中断した提案そのものの二重確定はない。両runとも使用量不明0、最終の未処理義務・未配送通知・blocking claimなし。

二つ目の実走では、共有仕様の変更前に一つのconsumerが局所の受入エラーを見て修正を完了し、仕様変更後に再確認された。内容の版は1のまま、異なる前提に対する正当なnoop提案が追加された。最初のprobeは「artifactごとの確定提案は常に1件」という過剰な仮定で失敗したため、元receiptを保持した上で、保存済みproposal IDの一意性とprefix保持、eventと版の一致、外側受入へ検査を修正して再監査した。実行結果を成功へ書き換えたわけではない。

## 限界

既知依存の合成fixture、単一process、C=1が対象。並列runnerの再開、任意repositoryの外部副作用、複数host間の耐障害性を保証しない。親processの停止はprovider処理の確実な取消しを意味しないため、不明な呼出しは消費済み枠として扱う。unknownを含むrunのtoken合計は観測済み分の下限になる。
