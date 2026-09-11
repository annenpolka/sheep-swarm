# 通信障害の再試行と実行継続

2026-09-11の利用者指定に従い、[再試行方針](../packet-sweep-retry-plan.md)を実装して実APIを再開した。停止していた`syn-units-v02 / packet-2`は再実行で成功し、次の条件へ進んだ。全644条件の比較はまだ実行中。

| 観測 | 初回の失敗 | 再実行 | 条件全体 |
| --- | ---: | ---: | ---: |
| call | 2 | 2 | 4 |
| 既知tokens | 2,312 | 8,217 | 10,529 |
| 使用量不明call | 1 | 0 | 1 |
| 実行時間 | 47.88秒 | 20.52秒 | 約70.40秒（再試行待機を含む） |
| 固定oracleによる成功 | 比較無効 | 成功 | 回復成功 |

総tokensは不明のまま。以前のHTTP 500のreceipt・不明usage・budget lockを保持し、再試行へ検査結果や旧候補を渡していない。元の成功90条件は再実行せず引き継いだ。回復先の2callはDeepSeek Flash・thinking有効・HTTP 200・完全usageを生レシートで確認し、独立受入も成功している。

継続profile SHA-256: `4e3e6521d5a00c84a7135bfb633adbc8f72891e027ff17c106c020f5ff6a2cfd`。solverは元系列に保存された`5104ad3`のruntimeを使う。新しいruntimeやpromptによる再試行ではない。元系列のprofile SHA-256は`4e7cefd595dab48ded3fffabe13296c7b30de5a8eff2a90bec0695f0b882c35d`。

通常gateは579テスト・型検査・参照snapshot2件が成功した。HTTP 500の注入試験でbaselineからの回復、旧receipt保持、未知usageを含む共有受付枠、元repo不変を確認した。実API前に旧91試行のreceipt・row・候補・source・集計をモデルなしで監査した。

## 時間比較での除外

回復した`units-v02 / packet-2`は人間による停止を挟んだため、成功品質と消費に含め、主な時間比較から除外する。停止時間も別に保存する。

再開直後に親側の全gateを重複して実行し、回復条件と次の`units-v02 / packet-1`にhost負荷が重なった。gateは終了済み。後者も主な時間比較から除外し、品質・消費・raw時間を保持する。これは実装方式の効果ではない。`.sheep/packet-sweep/dev-v2-retry/measurement-notes.json`へ除外理由を記録した。自動reportは手動停止の回復条件だけを除外するため、速度を解釈する際にはこの追加除外も適用する。現段階で再試行前後の時間差から性能改善を主張しない。

[回復の証拠とcheckpoint](packet-sweep-transport-retry.json)。最新進捗は`.sheep/packet-sweep/dev-v2-retry/report.json`、`report.md`、各attemptDirectoryへ継続保存する。この文書と添付JSONは回復直後の固定snapshotであり、完了結果ではない。
