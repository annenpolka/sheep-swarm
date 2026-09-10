# 機構実験の集計

金額とcreditsはStandard公開単価による概算。実際の請求・残高消費は観測していない。

| 課題 | 方式 | N/C | 回 | 結果 | 秒 | 下位/上位 | credits相当 | API USD相当 | 個体呼出し min–max |
|:---|:---|:---|---:|:---|---:|---:|---:|---:|:---|
| 静的変更 | sheep | 4/4 | 1 | pass | 28.77 | 6/0 | 0.6667 | 0.0267 | 1–2 |
| 意味依存 | sheep | 4/4 | 1 | pass | 65.33 | 15/0 | 1.2579 | 0.0503 | 3–4 |
| 段階更新 | sheep | 4/4 | 1 | pass | 131.15 | 26/0 | 1.5925 | 0.0637 | 6–7 |
| 段階更新 | single-luna | 1/1 | 1 | pass | 98.48 | 3/0 | 0.2859 | 0.0114 | 3–3 |
| 段階更新 | single-astra | 1/1 | 1 | budget-admission-limit | 97.09 | 0/2 | 16.5005 | 0.6600 | 2–2 |

確認済みレシート 52件、欠落 0件。合計 20.3035 credits相当 / $0.8121相当。

凍結ソースmanifest SHA-256: `d6a86de85be472fc9c6fe0cd75c4c6ac439ae74f43f98a18327ed7593cffe63d`

- Published Standard-rate equivalents with observed cached-input splits; neither observed account debits nor invoices.
- API USD is the hypothetical API price for these tokens, not a Codex subscription charge.
- All discovered call receipts count, including failed calls. Missing receipts produce unknown upper costs.
- Never-started planned conditions remain in rows; their lack of a result is not a quality failure or a measured zero-cost success.
- Numbers compare this frozen synthetic development experiment; case-level repeats do not establish generalization or emergence.
- Semantic tasks exercise registry/JSON policy dependencies absent from the initial static graph; arbitrary semantic discovery is not established.
- Private-memory measurements count entries, not tokens; worker participation counts actual model calls including read requests.
- Registered-worker minima include idle workers; a single baseline counts its actual single actor, not the unused worker-pool slot.
