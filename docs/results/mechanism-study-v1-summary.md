# 機構実験の集計

金額とcreditsはStandard公開単価による概算。実際の請求・残高消費は観測していない。

| 課題 | 方式 | N/C | 回 | 結果 | 秒 | 下位/上位 | credits相当 | API USD相当 | 個体呼出し min–max |
|:---|:---|:---|---:|:---|---:|---:|---:|---:|:---|
| 意味依存 | sheep | 8/8 | 1 | pass | 270.68 | 134/0 | 5.4207 | 0.2168 | 16–17 |
| 意味依存 | single-luna | 1/1 | 1 | unknown-usage | 93.47 | 1/0 | ≥0.0000（上限不明） | ≥0.0000（上限不明） | 1–1 |
| 意味依存 | sheep | 32/8 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 静的変更 | sheep | 32/8 | 2 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | single-luna | 1/1 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | sheep | 16/8 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 静的変更 | sheep | 32/8 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 意味依存 | single-astra | 1/1 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | no-upper | 16/8 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 意味依存 | sheep | 16/8 | 2 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 静的変更 | sheep | 16/8 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | sheep | 8/8 | 2 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 意味依存 | sheep | 16/8 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 意味依存 | sheep | 32/8 | 2 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 静的変更 | sheep | 16/8 | 2 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | sheep | 8/8 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | sheep | 32/8 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | single-astra | 1/1 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 静的変更 | single-astra | 1/1 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | no-upper | 16/8 | 2 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | sheep | 16/8 | 2 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | no-memory | 16/8 | 2 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 静的変更 | sheep | 8/8 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | no-memory | 16/8 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 意味依存 | sheep | 8/8 | 2 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 静的変更 | sheep | 8/8 | 2 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 静的変更 | single-luna | 1/1 | 1 | not-run | — | —/— | 未実行 | 未実行 | —–— |
| 段階更新 | sheep | 32/8 | 2 | not-run | — | —/— | 未実行 | 未実行 | —–— |

確認済みレシート 135件、欠落 0件。合計 ≥5.4207（上限不明） credits相当 / $≥0.2168（上限不明）相当。

凍結ソースmanifest SHA-256: `af51b857af61e04f51ee86d67fe40f7f9e4478ed01fd59017830e0feca12da7e`

- Published Standard-rate equivalents with observed cached-input splits; neither observed account debits nor invoices.
- API USD is the hypothetical API price for these tokens, not a Codex subscription charge.
- All discovered call receipts count, including failed calls. Missing receipts produce unknown upper costs.
- Never-started planned conditions remain in rows; their lack of a result is not a quality failure or a measured zero-cost success.
- Numbers compare this frozen synthetic development experiment; case-level repeats do not establish generalization or emergence.
- Semantic tasks exercise registry/JSON policy dependencies absent from the initial static graph; arbitrary semantic discovery is not established.
- Private-memory measurements count entries, not tokens; worker participation counts actual model calls including read requests.
- Registered-worker minima include idle workers; a single baseline counts its actual single actor, not the unused worker-pool slot.
