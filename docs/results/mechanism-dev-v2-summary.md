# 機構実験の集計

金額とcreditsはStandard公開単価による概算。実際の請求・残高消費は観測していない。

| 課題 | 方式 | N/C | 回 | 結果 | 秒 | 下位/上位 | credits相当 | API USD相当 | 個体呼出し min–max |
|:---|:---|:---|---:|:---|---:|---:|---:|---:|:---|
| 静的変更 | sheep | 4/4 | 1 | pass | 33.01 | 6/0 | 0.6683 | 0.0267 | 1–2 |
| 意味依存 | sheep | 4/4 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | sheep | 4/4 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | single-luna | 1/1 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | single-astra | 1/1 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |

確認済みレシート 6件、欠落 0件。合計 0.6683 credits相当 / $0.0267相当。

凍結ソースmanifest SHA-256: `52c36dab954686569fa8a74f0687057cb0b2d91c026d3f19ae0c67eeff94a9e9`

- Published Standard-rate equivalents with observed cached-input splits; neither observed account debits nor invoices.
- API USD is the hypothetical API price for these tokens, not a Codex subscription charge.
- All discovered call receipts count, including failed calls. Missing receipts produce unknown upper costs.
- Never-started planned conditions remain in rows; their lack of a result is not a quality failure or a measured zero-cost success.
- Numbers compare this frozen synthetic development experiment; case-level repeats do not establish generalization or emergence.
- Semantic tasks exercise registry/JSON policy dependencies absent from the initial static graph; arbitrary semantic discovery is not established.
- Private-memory measurements count entries, not tokens; worker participation counts actual model calls including read requests.
- Registered-worker minima include idle workers; a single baseline counts its actual single actor, not the unused worker-pool slot.
