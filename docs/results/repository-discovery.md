# M6 CLI・repo discoveryの実装と実行証拠

2026-09-10、branch `codex/cli-repository-discovery`、基準 `b8720ea330c12bbd667bd5eb89c2a9515b363709`。利用者指定の **opencode-go/deepseek-flashによる実sheep-swarm** を実装に使った。上位callは全試行0。主な部品生成をswarmへ渡し、親は固定oracle、接続、レビューと境界修正を担当した。

## 実装した範囲

- 5主CLIの共通入口、help、dry-run、alias、予算単位、JSON/textと終了コード。旧入口の既定値と概要JSON、失敗時exit 1を維持。
- v1/v2共通の候補・検査・環境識別付きhost verifier。最終検査は通常重複実行しない。
- opt-in task v2、`.mjs`静的解析、担当固有指示、公開catalog、追加read、未解決claim、配信された版に基づく依存とcatch-up。
- 版付き証拠、走査・context量の集計、固定課題の準備script、基準解・変異を含む通常gate。

利用手順は[CLI](../cli.md)と[repo runner](../repository-runner.md)。[実行計画](../execplan-repository-discovery.md)のA–DとEの初期gateを実装した。登録8/16/32体での新しい系列、一般repoのLuna単独/Manager-local対照、任意言語、Docker一般repo、並列resumeは今回の完了に含めない。実装モデルを利用者がGo DeepSeekへ指定したため、今回の実疎通もGoを使い、Luna疎通を実行済みとはしない。

## 実swarmの記録

| 試行 | N / C | 実参加個体 / 最大稼働 | 下位call | 観測tokens | 結果 |
| --- | --- | --- | --- | --- | --- |
| 4部品の生成 | 4 / 2 | 4 / 2 | 6 | 146,998 | 全体失敗。3部品局所確定、依存parserの許可範囲検査が失敗 |
| CLI profile生成 | 4 / 2 | 1 / 1 | 1 | 61,677 | 固定受入成功、親レビューで補修 |
| v2初回疎通 | 4 / 2 | 4 / 2 | 10 | 8,671 | action混合で全案拒否、変更0 |
| v2説明修正後 | 4 / 2 | 4 / 2 | 5 | 5,144 | 3targetの最終受入成功、applyなし |

4試行は計22call、222,490観測tokens。unknown usage、残留予約は全試行0。cache write量は不明というreceipt注記を保持する。利用枠、実請求額、親Codexの使用量は不明であり0とはしない。生成時のv1 contextは大きく、profile生成のLocal-files JSONは202,051 bytesだった。この実装作業の費用を新機能の局所性効果とは扱わない。

部品生成ではworker-proposal、cli-options、repo-verifierが局所確定し、repo-dependenciesは許可されていないproviderへedgeを作ったため固定テストで拒否された。後続の生成はschema不適合で停止した。失敗run全体をapplyせず、親が返却候補を別directoryで検査して採用した。

親は許可先検査、digestの曖昧な連結、検査receiptの整合性、provider共通のschema部分集合、型、CLI既定値・help、根拠のないGo言語制限、durable resumeの設定確認を修正した。repo/swarm接続、discovery制御、固定課題と追加試験は親が実装した。生成原文と採用後hashは[機械可読証拠](repository-discovery-evidence.json)に記録する。swarmが全体を単独実装したという記録ではない。

## v2実疎通で分かったこと

固定課題はpricing/label/summaryの3export。pricingには公開registry/policyの読取が必要で、summaryは他2targetの静的importを持つ。最終oracleと無関係なJSON本文をworkerへ渡さない。初期stubと、定数返却・入力検証欠落・cap欠落・label反転・summary欠落の変異は固定oracleが拒否し、基準解は成功する。

初回は全field必須のwireについて「不要fieldを空にする」という説明だけでは不足し、Goがwriteにpathsや観測を埋めた。hostは10案とも拒否した。固定oracleとaction検査を保ち、完全なJSON例と具体的な混合エラーを追加して新しいrunを実行した。

修正後はcall-1がregistryとpolicyを同時要求、call-2がlabelを確定、call-3が配信を受けた上で混合actionにより拒否、call-4がpricingを確定、call-5がsummaryを確定した。registryからpolicyを逐次探索した実証ではなく、catalogの名前から両方を要求した**一段の追加読取**である。二段の要求/配信は注入callerの別テストで確認した。

要求modelはdeepseek-flash、providerの実model証拠もdeepseek-flash。Local-files JSONの合計4,310 bytes、p95/最大1,148 bytes。全3targetを起動し、4個体が参加した。上位なし・小課題1成功で、人数・局所性・費用の因果効果は結論しない。

保存済みartifactsから現在のhost verifierで固定oracleを独立に再実行し、成功を確認した。source repoの`git status --porcelain`は空、check.mjsのhashは元の固定oracleと一致。配信依存はregistry.json、policies/retail.json、label.mjs、pricing.mjsのみで、check.mjsとunrelated.json本文は配信されていない。

## 検証と証拠の所在

通常gateは型検査、465テスト、原資料2snapshotのhash照合が成功。CLI実process、durable元DBの非更新、read/write混合拒否、未知usage、読取上限、静的循環、旧versionと同bytesの旧evidenceEpoch、選択的な上位観測、基準解/変異を含む。通常gateは実APIを呼ばない。

生receiptと候補はignoredな `.sheep/m6-build/` に保持する。components-run、profile-run、live-discovery/run、live-discovery/run-02が元run。`live-discovery/independent-verification.json`が独立検証、`components-adoption-final.json`が生成と採用の区分、full-check.logがgate。元の失敗結果は再集計で書き換えていない。結果hashと主指標は[repository-discovery-evidence.json](repository-discovery-evidence.json)に残す。
