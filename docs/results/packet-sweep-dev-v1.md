# devのpacket粒度比較

状態: **途中停止/未完了**。3/644実run完了、1run未完了、証拠が揃ったrunは3。停止理由: host kernel unobserved-obligation repeatedly rejected packet-8; externally stopped at receipt boundary。

[事前固定条件](../packet-sweep-plan.md)。DeepSeek Flash thinking有効、上位0、packet C4上限、task締切なし。旧Singleとpacket-all/8/4/2/1をdev128件で各1回。実際の分割が同じ条件は共有観測として一度だけ実行する。

| 方式 | 観測課題 | 成功 | 成功時中央値 秒 | 既知tokens（共有観測を含む） |
| --- | ---: | ---: | ---: | ---: |
| legacy-single | 1/128 | 1/1 | 26.11 | 19726 |
| packet-all | 1/128 | 1/1 | 24.12 | 22884 |
| packet-8 | 1/128 | 1/1 | 32.39 | 63427 |
| packet-4 | 0/128 | 0/0 | — | 0 |
| packet-2 | 0/128 | 0/0 | — | 0 |
| packet-1 | 0/128 | 0/0 | — | 0 |

方式別の成功集合は異なる。上の中央値同士を速度差にしない。共有観測の消費を合計して系列消費へ二重計上しない。

## packet-allとの対応比較

| 比較先 | 有効組 | 同値のため除外 | 両成功 | 参照のみ成功 | 比較先のみ成功 | 両失敗 | 参照が速い | 比較先が速い | 参照/比較先 時間比中央値 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| legacy-single | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 | 0.92 |
| packet-8 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 | 0.74 |
| packet-4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| packet-2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| packet-1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |

## legacy-singleとの対応比較

| 比較先 | 有効組 | 同値のため除外 | 両成功 | 参照のみ成功 | 比較先のみ成功 | 両失敗 | 参照が速い | 比較先が速い | 参照/比較先 時間比中央値 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| packet-all | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 1 | 1.08 |
| packet-8 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 | 0.81 |
| packet-4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| packet-2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| packet-1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |

## family別: 旧Singleとの比較

| 区分 | 方式 | 成功/観測 | 両成功組 | 旧Singleが速い | packetが速い | 旧Single/packet 時間比中央値 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| apportion | packet-all | 0/0 | 0 | 0 | 0 | — |
| apportion | packet-8 | 0/0 | 0 | 0 | 0 | — |
| apportion | packet-4 | 0/0 | 0 | 0 | 0 | — |
| apportion | packet-2 | 0/0 | 0 | 0 | 0 | — |
| apportion | packet-1 | 0/0 | 0 | 0 | 0 | — |
| baseconv | packet-all | 0/0 | 0 | 0 | 0 | — |
| baseconv | packet-8 | 0/0 | 0 | 0 | 0 | — |
| baseconv | packet-4 | 0/0 | 0 | 0 | 0 | — |
| baseconv | packet-2 | 0/0 | 0 | 0 | 0 | — |
| baseconv | packet-1 | 0/0 | 0 | 0 | 0 | — |
| dedup | packet-all | 0/0 | 0 | 0 | 0 | — |
| dedup | packet-8 | 0/0 | 0 | 0 | 0 | — |
| dedup | packet-4 | 0/0 | 0 | 0 | 0 | — |
| dedup | packet-2 | 0/0 | 0 | 0 | 0 | — |
| dedup | packet-1 | 0/0 | 0 | 0 | 0 | — |
| intervals | packet-all | 0/0 | 0 | 0 | 0 | — |
| intervals | packet-8 | 0/0 | 0 | 0 | 0 | — |
| intervals | packet-4 | 0/0 | 0 | 0 | 0 | — |
| intervals | packet-2 | 0/0 | 0 | 0 | 0 | — |
| intervals | packet-1 | 0/0 | 0 | 0 | 0 | — |
| stats | packet-all | 1/1 | 1 | 0 | 1 | 1.08 |
| stats | packet-8 | 1/1 | 1 | 1 | 0 | 0.81 |
| stats | packet-4 | 0/0 | 0 | 0 | 0 | — |
| stats | packet-2 | 0/0 | 0 | 0 | 0 | — |
| stats | packet-1 | 0/0 | 0 | 0 | 0 | — |
| topk | packet-all | 0/0 | 0 | 0 | 0 | — |
| topk | packet-8 | 0/0 | 0 | 0 | 0 | — |
| topk | packet-4 | 0/0 | 0 | 0 | 0 | — |
| topk | packet-2 | 0/0 | 0 | 0 | 0 | — |
| topk | packet-1 | 0/0 | 0 | 0 | 0 | — |
| units | packet-all | 0/0 | 0 | 0 | 0 | — |
| units | packet-8 | 0/0 | 0 | 0 | 0 | — |
| units | packet-4 | 0/0 | 0 | 0 | 0 | — |
| units | packet-2 | 0/0 | 0 | 0 | 0 | — |
| units | packet-1 | 0/0 | 0 | 0 | 0 | — |
| window | packet-all | 0/0 | 0 | 0 | 0 | — |
| window | packet-8 | 0/0 | 0 | 0 | 0 | — |
| window | packet-4 | 0/0 | 0 | 0 | 0 | — |
| window | packet-2 | 0/0 | 0 | 0 | 0 | — |
| window | packet-1 | 0/0 | 0 | 0 | 0 | — |

## targetCount別: 旧Singleとの比較

| 区分 | 方式 | 成功/観測 | 両成功組 | 旧Singleが速い | packetが速い | 旧Single/packet 時間比中央値 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 4 | packet-all | 0/0 | 0 | 0 | 0 | — |
| 4 | packet-8 | 0/0 | 0 | 0 | 0 | — |
| 4 | packet-4 | 0/0 | 0 | 0 | 0 | — |
| 4 | packet-2 | 0/0 | 0 | 0 | 0 | — |
| 4 | packet-1 | 0/0 | 0 | 0 | 0 | — |
| 8 | packet-all | 0/0 | 0 | 0 | 0 | — |
| 8 | packet-8 | 0/0 | 0 | 0 | 0 | — |
| 8 | packet-4 | 0/0 | 0 | 0 | 0 | — |
| 8 | packet-2 | 0/0 | 0 | 0 | 0 | — |
| 8 | packet-1 | 0/0 | 0 | 0 | 0 | — |
| 16 | packet-all | 0/0 | 0 | 0 | 0 | — |
| 16 | packet-8 | 0/0 | 0 | 0 | 0 | — |
| 16 | packet-4 | 0/0 | 0 | 0 | 0 | — |
| 16 | packet-2 | 0/0 | 0 | 0 | 0 | — |
| 16 | packet-1 | 0/0 | 0 | 0 | 0 | — |
| 32 | packet-all | 1/1 | 1 | 0 | 1 | 1.08 |
| 32 | packet-8 | 1/1 | 1 | 1 | 0 | 0.81 |
| 32 | packet-4 | 0/0 | 0 | 0 | 0 | — |
| 32 | packet-2 | 0/0 | 0 | 0 | 0 | — |
| 32 | packet-1 | 0/0 | 0 | 0 | 0 | — |

## topology別: 旧Singleとの比較

| 区分 | 方式 | 成功/観測 | 両成功組 | 旧Singleが速い | packetが速い | 旧Single/packet 時間比中央値 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| diamond | packet-all | 1/1 | 1 | 0 | 1 | 1.08 |
| diamond | packet-8 | 1/1 | 1 | 1 | 0 | 0.81 |
| diamond | packet-4 | 0/0 | 0 | 0 | 0 | — |
| diamond | packet-2 | 0/0 | 0 | 0 | 0 | — |
| diamond | packet-1 | 0/0 | 0 | 0 | 0 | — |
| fanin | packet-all | 0/0 | 0 | 0 | 0 | — |
| fanin | packet-8 | 0/0 | 0 | 0 | 0 | — |
| fanin | packet-4 | 0/0 | 0 | 0 | 0 | — |
| fanin | packet-2 | 0/0 | 0 | 0 | 0 | — |
| fanin | packet-1 | 0/0 | 0 | 0 | 0 | — |
| fanout | packet-all | 0/0 | 0 | 0 | 0 | — |
| fanout | packet-8 | 0/0 | 0 | 0 | 0 | — |
| fanout | packet-4 | 0/0 | 0 | 0 | 0 | — |
| fanout | packet-2 | 0/0 | 0 | 0 | 0 | — |
| fanout | packet-1 | 0/0 | 0 | 0 | 0 | — |
| independent | packet-all | 0/0 | 0 | 0 | 0 | — |
| independent | packet-8 | 0/0 | 0 | 0 | 0 | — |
| independent | packet-4 | 0/0 | 0 | 0 | 0 | — |
| independent | packet-2 | 0/0 | 0 | 0 | 0 | — |
| independent | packet-1 | 0/0 | 0 | 0 | 0 | — |
| sparse | packet-all | 0/0 | 0 | 0 | 0 | — |
| sparse | packet-8 | 0/0 | 0 | 0 | 0 | — |
| sparse | packet-4 | 0/0 | 0 | 0 | 0 | — |
| sparse | packet-2 | 0/0 | 0 | 0 | 0 | — |
| sparse | packet-1 | 0/0 | 0 | 0 | 0 | — |

## dependencyDepth別: 旧Singleとの比較

| 区分 | 方式 | 成功/観測 | 両成功組 | 旧Singleが速い | packetが速い | 旧Single/packet 時間比中央値 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | packet-all | 0/0 | 0 | 0 | 0 | — |
| 1 | packet-8 | 0/0 | 0 | 0 | 0 | — |
| 1 | packet-4 | 0/0 | 0 | 0 | 0 | — |
| 1 | packet-2 | 0/0 | 0 | 0 | 0 | — |
| 1 | packet-1 | 0/0 | 0 | 0 | 0 | — |
| 2 | packet-all | 0/0 | 0 | 0 | 0 | — |
| 2 | packet-8 | 0/0 | 0 | 0 | 0 | — |
| 2 | packet-4 | 0/0 | 0 | 0 | 0 | — |
| 2 | packet-2 | 0/0 | 0 | 0 | 0 | — |
| 2 | packet-1 | 0/0 | 0 | 0 | 0 | — |
| 3 | packet-all | 1/1 | 1 | 0 | 1 | 1.08 |
| 3 | packet-8 | 1/1 | 1 | 1 | 0 | 0.81 |
| 3 | packet-4 | 0/0 | 0 | 0 | 0 | — |
| 3 | packet-2 | 0/0 | 0 | 0 | 0 | — |
| 3 | packet-1 | 0/0 | 0 | 0 | 0 | — |

## 消費と証拠

実call 26、上位0。既知token下限445343、総tokens 445343、使用量不明0call。実請求額は不明。準備166.12秒、独立監査計5.57秒。未開始640run。

外部停止した syn-stats-v11/packet-4 は 20call、既知339306tokens。品質・完了時間は未判定として比較から除外し、消費にだけ含めた。元のseries/budget/kernel checkpointは書き換えず、外部停止記録とraw receiptのhashを別保存した。


## 解釈の範囲

devの8family内のvariantは独立した128種類の実務課題ではない。devにchainはなく、宣言依存深さは1〜3。evaluationは構造の分布が異なり、既にpilot8件を観測済み。この系列ではevaluationを呼んでいない。

旧Singleは公開ファイルをまとめた提案、packetは不変の変更前baselineと現在依存overlayを使うため、旧Singleとの違いは粒度だけではない。共通executor内でも、分割に伴い現在版の配信量や公開検査回数が変わる。実行順・cache・provider変動を完全には除けず、単一試行の最速粒度から適応器の性能を作らない。

JSONには全観測、同値条件、固定順序、runtime hash、family/topology/target数/依存深さ別集計を保存する。rawと完全なpacket planは実行ディレクトリへ保存。再送・採点変更はしない。
