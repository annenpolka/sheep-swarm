# Semantic decomposition: dev 24課題

72/72条件を完了し、receipt・候補・元fixture・固定oracleを監査した。DeepSeek Flash thinking有効、上位0、task間逐次、worker C4、task締切なし。profile hash: `e603bd3d0aae66685547eba8c08fa57b4f1e365bebf2af8bac7b7a0879c2ed90`。実装revision: `4b3b00a713ae47e8f3cc52ca65ec483419111414`。

## 品質と完了時間

| 方式 | 有効観測 | 成功 | 成功時の時間中央値（秒） | call | 既知tokens | 総tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| single | 24 | 24 | 24.82 | 25 | 372462 | 372462 |
| fixed-all | 24 | 24 | 21.10 | 24 | 362442 | 362442 |
| planned | 24 | 23 | 28.91 | 52 | 537601 | 537601 |

planner・runtime受入・通信失敗試行・再試行待機を含む。独立監査と準備は別計測。失敗のcompletionはnull。

| 対照 | 有効組 | 両方成功 | 対照だけ成功 | plannedだけ成功 | 対照が速い | plannedが速い | planned/対照の時間比中央値 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| single | 24 | 23 | 1 | 0 | 15 | 8 | 1.362 |
| fixed-all | 24 | 23 | 1 | 0 | 18 | 5 | 1.481 |

## 失敗の分類

```json
[
  {
    "id": "syn-dedup-v10",
    "method": "planned",
    "termination": "invalid-plan",
    "errors": [],
    "workerStarted": false,
    "receiptHash": "3c6bf06f5202c92e0af55c850ab01bb27da96f9bc9cb2c3770b40415d039c32a",
    "receiptError": "malformed-output",
    "finishReason": "stop",
    "unexpectedTopLevelFields": [
      "rationale_note_unused"
    ],
    "scopeValidationAfterDroppingExtraTopLevelFields": {
      "passes": true,
      "packets": 1,
      "writableTargets": 2,
      "diagnosticOnly": true,
      "doesNotRescore": true
    }
  }
]
```

## 作業境界の選択

有効plan 23件。提案時1packet 21件、そのうち全targetを担当する1packetは2件。提案packet数中央値1、実行packet数中央値1。担当target数中央値1、実変更target数中央値1。planner API call時間中央値24.31秒。

| 課題 | 全target | 提案packet | 実行packet | 担当target | 実変更target | planner call秒 | 結果 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| syn-intervals-v04 | 8 | 1 | 1 | 1 | 1 | 16.25 | 成功 |
| syn-baseconv-v09 | 32 | 1 | 1 | 1 | 1 | 15.05 | 成功 |
| syn-window-v07 | 16 | 1 | 1 | 1 | 1 | 22.92 | 成功 |
| syn-dedup-v10 | 32 | — | — | 0 | 0 | 69.62 | invalid-plan |
| syn-dedup-v12 | 4 | 1 | 1 | 4 | 1 | 8.37 | 成功 |
| syn-stats-v06 | 16 | 1 | 1 | 1 | 1 | 10.51 | 成功 |
| syn-baseconv-v07 | 16 | 1 | 1 | 1 | 1 | 14.18 | 成功 |
| syn-apportion-v06 | 16 | 1 | 1 | 1 | 1 | 13.42 | 成功 |
| syn-stats-v09 | 32 | 1 | 1 | 1 | 1 | 18.16 | 成功 |
| syn-window-v05 | 8 | 1 | 1 | 1 | 1 | 44.96 | 成功 |
| syn-topk-v06 | 16 | 1 | 1 | 2 | 1 | 30.20 | 成功 |
| syn-window-v12 | 4 | 1 | 1 | 1 | 1 | 15.64 | 成功 |
| syn-units-v01 | 4 | 4 | 4 | 4 | 2 | 56.74 | 成功 |
| syn-apportion-v09 | 32 | 1 | 1 | 1 | 1 | 25.17 | 成功 |
| syn-topk-v00 | 4 | 1 | 1 | 1 | 1 | 36.90 | 成功 |
| syn-topk-v10 | 32 | 1 | 1 | 1 | 1 | 29.67 | 成功 |
| syn-stats-v03 | 8 | 1 | 1 | 1 | 1 | 11.15 | 成功 |
| syn-baseconv-v00 | 4 | 1 | 1 | 1 | 1 | 15.07 | 成功 |
| syn-apportion-v04 | 8 | 1 | 1 | 8 | 8 | 24.31 | 成功 |
| syn-dedup-v04 | 8 | 1 | 1 | 1 | 1 | 28.47 | 成功 |
| syn-units-v14 | 32 | 2 | 2 | 16 | 16 | 44.79 | 成功 |
| syn-units-v05 | 8 | 1 | 1 | 3 | 3 | 65.55 | 成功 |
| syn-intervals-v02 | 4 | 1 | 1 | 1 | 1 | 35.81 | 成功 |
| syn-intervals-v08 | 16 | 1 | 1 | 15 | 15 | 31.15 | 成功 |

## target数別の時間比較

両方成功した組だけの時間比。各サイズ6課題で、単独の一般化に使わない。

| target数 | 対照 | 両方成功 | 対照が速い | plannedが速い | planned/対照中央値 |
| --- | --- | ---: | ---: | ---: | ---: |
| 4 | single | 6 | 5 | 1 | 3.252 |
| 4 | fixed-all | 6 | 6 | 0 | 2.979 |
| 8 | single | 6 | 4 | 2 | 1.652 |
| 8 | fixed-all | 6 | 4 | 2 | 1.222 |
| 16 | single | 6 | 3 | 3 | 1.097 |
| 16 | fixed-all | 6 | 4 | 2 | 1.391 |
| 32 | single | 5 | 3 | 2 | 1.254 |
| 32 | fixed-all | 5 | 4 | 1 | 1.218 |

## 使用量と制約

全試行101call、既知下限1272505tokens、総tokensは1272505。不明usage 0call。受付控除1272505tokensは実使用量ではない。再試行条件0件、追加試行0回。全条件の実行時間合計2223.56秒、独立監査合計67.11秒、準備36.92秒。人間の作業時間・請求額は未測定。

既知devから公開metadataだけで選ぶ24課題、各方式1回の探索的比較。plannerは全公開baselineを読み、workerは選択された入力とhost依存閉包を読む。入力選択と分割を含む方式比較であり、純粋な分割の因果効果ではない。1packet選択と全targetを一人で担当することは区別する。evaluationとManagerは実行していない。family・topology・dependencyDepth別の集計はJSONに保存。

生の試行とprofileは`/Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm/.sheep/semantic-decomposition/dev-v1`。結果に合わせたsolver変更や課題hash変更は行わない。
