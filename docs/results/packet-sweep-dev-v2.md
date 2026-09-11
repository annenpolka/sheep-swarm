# devのpacket粒度比較

状態: **途中停止/未完了**。91/644実runの終了記録、最終reportなし0run、証拠が揃ったrunは90。停止理由: evidence-stop。

[事前固定条件](../packet-sweep-rerun-plan.md)。DeepSeek Flash thinking有効、上位0、packet C4上限、task締切なし。旧Singleとpacket-all/8/4/2/1をdev128件で各1回。実際の分割が同じ条件は共有観測として一度だけ実行する。

| 方式 | 観測課題 | 成功 | 成功時中央値 秒 | 既知tokens（共有観測を含む） |
| --- | ---: | ---: | ---: | ---: |
| legacy-single | 18/128 | 18/18 | 12.18 | 204683 |
| packet-all | 18/128 | 18/18 | 12.47 | 219533 |
| packet-8 | 18/128 | 18/18 | 13.23 | 503896 |
| packet-4 | 18/128 | 18/18 | 15.76 | 873264 |
| packet-2 | 17/128 | 17/17 | 47.76 | 1657592 |
| packet-1 | 17/128 | 17/17 | 37.81 | 3071237 |

方式別の成功集合は異なる。上の中央値同士を速度差にしない。共有観測の消費を合計して系列消費へ二重計上しない。

## packet-allとの対応比較

| 比較先 | 有効組 | 同値のため除外 | 両成功 | 参照のみ成功 | 比較先のみ成功 | 両失敗 | 参照が速い | 比較先が速い | 参照/比較先 時間比中央値 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| legacy-single | 18 | 0 | 18 | 0 | 0 | 0 | 9 | 9 | 0.98 |
| packet-8 | 9 | 9 | 9 | 0 | 0 | 0 | 8 | 1 | 0.68 |
| packet-4 | 11 | 7 | 11 | 0 | 0 | 0 | 8 | 3 | 0.63 |
| packet-2 | 17 | 0 | 17 | 0 | 0 | 0 | 15 | 2 | 0.44 |
| packet-1 | 17 | 0 | 17 | 0 | 0 | 0 | 15 | 2 | 0.38 |

## legacy-singleとの対応比較

| 比較先 | 有効組 | 同値のため除外 | 両成功 | 参照のみ成功 | 比較先のみ成功 | 両失敗 | 参照が速い | 比較先が速い | 参照/比較先 時間比中央値 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| packet-all | 18 | 0 | 18 | 0 | 0 | 0 | 9 | 9 | 1.03 |
| packet-8 | 18 | 0 | 18 | 0 | 0 | 0 | 10 | 8 | 0.85 |
| packet-4 | 18 | 0 | 18 | 0 | 0 | 0 | 10 | 8 | 0.89 |
| packet-2 | 17 | 0 | 17 | 0 | 0 | 0 | 15 | 2 | 0.41 |
| packet-1 | 17 | 0 | 17 | 0 | 0 | 0 | 14 | 3 | 0.33 |

## family別: 旧Singleとの比較

| 区分 | 方式 | 成功/観測 | 両成功組 | 旧Singleが速い | packetが速い | 旧Single/packet 時間比中央値 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| apportion | packet-all | 0/0 | 0 | 0 | 0 | — |
| apportion | packet-8 | 0/0 | 0 | 0 | 0 | — |
| apportion | packet-4 | 0/0 | 0 | 0 | 0 | — |
| apportion | packet-2 | 0/0 | 0 | 0 | 0 | — |
| apportion | packet-1 | 0/0 | 0 | 0 | 0 | — |
| baseconv | packet-all | 3/3 | 3 | 2 | 1 | 0.71 |
| baseconv | packet-8 | 3/3 | 3 | 2 | 1 | 0.61 |
| baseconv | packet-4 | 3/3 | 3 | 2 | 1 | 0.79 |
| baseconv | packet-2 | 3/3 | 3 | 2 | 1 | 0.51 |
| baseconv | packet-1 | 3/3 | 3 | 2 | 1 | 0.40 |
| dedup | packet-all | 1/1 | 1 | 1 | 0 | 0.84 |
| dedup | packet-8 | 1/1 | 1 | 1 | 0 | 0.36 |
| dedup | packet-4 | 1/1 | 1 | 1 | 0 | 0.32 |
| dedup | packet-2 | 1/1 | 1 | 1 | 0 | 0.44 |
| dedup | packet-1 | 1/1 | 1 | 1 | 0 | 0.15 |
| intervals | packet-all | 3/3 | 3 | 0 | 3 | 1.11 |
| intervals | packet-8 | 3/3 | 3 | 0 | 3 | 1.12 |
| intervals | packet-4 | 3/3 | 3 | 1 | 2 | 1.11 |
| intervals | packet-2 | 3/3 | 3 | 2 | 1 | 0.13 |
| intervals | packet-1 | 3/3 | 3 | 2 | 1 | 0.42 |
| stats | packet-all | 4/4 | 4 | 4 | 0 | 0.86 |
| stats | packet-8 | 4/4 | 4 | 4 | 0 | 0.64 |
| stats | packet-4 | 4/4 | 4 | 4 | 0 | 0.58 |
| stats | packet-2 | 4/4 | 4 | 4 | 0 | 0.40 |
| stats | packet-1 | 4/4 | 4 | 3 | 1 | 0.36 |
| topk | packet-all | 0/0 | 0 | 0 | 0 | — |
| topk | packet-8 | 0/0 | 0 | 0 | 0 | — |
| topk | packet-4 | 0/0 | 0 | 0 | 0 | — |
| topk | packet-2 | 0/0 | 0 | 0 | 0 | — |
| topk | packet-1 | 0/0 | 0 | 0 | 0 | — |
| units | packet-all | 4/4 | 4 | 1 | 3 | 1.16 |
| units | packet-8 | 4/4 | 4 | 2 | 2 | 0.92 |
| units | packet-4 | 4/4 | 4 | 1 | 3 | 1.10 |
| units | packet-2 | 3/3 | 3 | 3 | 0 | 0.25 |
| units | packet-1 | 3/3 | 3 | 3 | 0 | 0.22 |
| window | packet-all | 3/3 | 3 | 1 | 2 | 2.24 |
| window | packet-8 | 3/3 | 3 | 1 | 2 | 1.34 |
| window | packet-4 | 3/3 | 3 | 1 | 2 | 1.41 |
| window | packet-2 | 3/3 | 3 | 3 | 0 | 0.41 |
| window | packet-1 | 3/3 | 3 | 3 | 0 | 0.31 |

## targetCount別: 旧Singleとの比較

| 区分 | 方式 | 成功/観測 | 両成功組 | 旧Singleが速い | packetが速い | 旧Single/packet 時間比中央値 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 4 | packet-all | 7/7 | 7 | 3 | 4 | 1.11 |
| 4 | packet-8 | 7/7 | 7 | 3 | 4 | 1.11 |
| 4 | packet-4 | 7/7 | 7 | 3 | 4 | 1.11 |
| 4 | packet-2 | 6/6 | 6 | 5 | 1 | 0.51 |
| 4 | packet-1 | 6/6 | 6 | 4 | 2 | 0.36 |
| 8 | packet-all | 2/2 | 2 | 1 | 1 | 0.73 |
| 8 | packet-8 | 2/2 | 2 | 1 | 1 | 0.73 |
| 8 | packet-4 | 2/2 | 2 | 2 | 0 | 0.32 |
| 8 | packet-2 | 2/2 | 2 | 2 | 0 | 0.31 |
| 8 | packet-1 | 2/2 | 2 | 2 | 0 | 0.33 |
| 16 | packet-all | 4/4 | 4 | 3 | 1 | 0.82 |
| 16 | packet-8 | 4/4 | 4 | 3 | 1 | 0.62 |
| 16 | packet-4 | 4/4 | 4 | 3 | 1 | 0.65 |
| 16 | packet-2 | 4/4 | 4 | 4 | 0 | 0.22 |
| 16 | packet-1 | 4/4 | 4 | 4 | 0 | 0.31 |
| 32 | packet-all | 5/5 | 5 | 2 | 3 | 1.19 |
| 32 | packet-8 | 5/5 | 5 | 3 | 2 | 0.71 |
| 32 | packet-4 | 5/5 | 5 | 2 | 3 | 1.02 |
| 32 | packet-2 | 5/5 | 5 | 4 | 1 | 0.44 |
| 32 | packet-1 | 5/5 | 5 | 4 | 1 | 0.28 |

## topology別: 旧Singleとの比較

| 区分 | 方式 | 成功/観測 | 両成功組 | 旧Singleが速い | packetが速い | 旧Single/packet 時間比中央値 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| diamond | packet-all | 6/6 | 6 | 3 | 3 | 0.99 |
| diamond | packet-8 | 6/6 | 6 | 4 | 2 | 0.68 |
| diamond | packet-4 | 6/6 | 6 | 2 | 4 | 1.10 |
| diamond | packet-2 | 5/5 | 5 | 4 | 1 | 0.31 |
| diamond | packet-1 | 5/5 | 5 | 4 | 1 | 0.22 |
| fanin | packet-all | 3/3 | 3 | 3 | 0 | 0.84 |
| fanin | packet-8 | 3/3 | 3 | 3 | 0 | 0.36 |
| fanin | packet-4 | 3/3 | 3 | 3 | 0 | 0.33 |
| fanin | packet-2 | 3/3 | 3 | 3 | 0 | 0.44 |
| fanin | packet-1 | 3/3 | 3 | 2 | 1 | 0.31 |
| fanout | packet-all | 0/0 | 0 | 0 | 0 | — |
| fanout | packet-8 | 0/0 | 0 | 0 | 0 | — |
| fanout | packet-4 | 0/0 | 0 | 0 | 0 | — |
| fanout | packet-2 | 0/0 | 0 | 0 | 0 | — |
| fanout | packet-1 | 0/0 | 0 | 0 | 0 | — |
| independent | packet-all | 8/8 | 8 | 3 | 5 | 1.09 |
| independent | packet-8 | 8/8 | 8 | 3 | 5 | 1.12 |
| independent | packet-4 | 8/8 | 8 | 5 | 3 | 0.65 |
| independent | packet-2 | 8/8 | 8 | 8 | 0 | 0.21 |
| independent | packet-1 | 8/8 | 8 | 8 | 0 | 0.37 |
| sparse | packet-all | 1/1 | 1 | 0 | 1 | 2.75 |
| sparse | packet-8 | 1/1 | 1 | 0 | 1 | 2.75 |
| sparse | packet-4 | 1/1 | 1 | 0 | 1 | 2.75 |
| sparse | packet-2 | 1/1 | 1 | 0 | 1 | 2.24 |
| sparse | packet-1 | 1/1 | 1 | 0 | 1 | 1.80 |

## dependencyDepth別: 旧Singleとの比較

| 区分 | 方式 | 成功/観測 | 両成功組 | 旧Singleが速い | packetが速い | 旧Single/packet 時間比中央値 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | packet-all | 4/4 | 4 | 4 | 0 | 0.78 |
| 1 | packet-8 | 4/4 | 4 | 4 | 0 | 0.49 |
| 1 | packet-4 | 4/4 | 4 | 4 | 0 | 0.61 |
| 1 | packet-2 | 4/4 | 4 | 4 | 0 | 0.50 |
| 1 | packet-1 | 4/4 | 4 | 3 | 1 | 0.37 |
| 2 | packet-all | 7/7 | 7 | 3 | 4 | 1.13 |
| 2 | packet-8 | 7/7 | 7 | 4 | 3 | 0.71 |
| 2 | packet-4 | 7/7 | 7 | 3 | 4 | 1.02 |
| 2 | packet-2 | 6/6 | 6 | 5 | 1 | 0.28 |
| 2 | packet-1 | 6/6 | 6 | 5 | 1 | 0.32 |
| 3 | packet-all | 7/7 | 7 | 2 | 5 | 1.11 |
| 3 | packet-8 | 7/7 | 7 | 2 | 5 | 1.12 |
| 3 | packet-4 | 7/7 | 7 | 3 | 4 | 1.11 |
| 3 | packet-2 | 7/7 | 7 | 6 | 1 | 0.21 |
| 3 | packet-1 | 7/7 | 7 | 6 | 1 | 0.28 |

## 消費と証拠

実call 526、上位0。既知token下限6459555、総tokens 不明、使用量不明1call。実請求額は不明。準備159.38秒、独立監査計83.92秒。未開始553run。

| 課題 | 方式 | 終了分類 | 証拠異常 |
| --- | --- | --- | --- |
| syn-units-v02 | packet-2 | transport-failure | あり |

## 解釈の範囲

devの8family内のvariantは独立した128種類の実務課題ではない。devにchainはなく、宣言依存深さは1〜3。evaluationは構造の分布が異なり、既にpilot8件を観測済み。この系列ではevaluationを呼んでいない。

旧Singleは公開ファイルをまとめた提案、packetは不変の変更前baselineと現在依存overlayを使うため、旧Singleとの違いは粒度だけではない。共通executor内でも、分割に伴い現在版の配信量や公開検査回数が変わる。実行順・cache・provider変動を完全には除けず、単一試行の最速粒度から適応器の性能を作らない。

JSONには全観測、同値条件、固定順序、runtime hash、family/topology/target数/依存深さ別集計を保存する。rawと完全なpacket planは実行ディレクトリへ保存。再送・採点変更はしない。
