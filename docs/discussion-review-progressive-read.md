# M6後の議論を次の作業へ落とす

2026-09-10添付 `a53c1042-75d8-4993-b066-24d97846b17c/pasted-text.txt` を、PR #5の実装と保存証拠に照らして精査した。元の2資料snapshotやM6実測を書き換えず、今回の判断を分けて記録する。

## 採用する点

M6は読む範囲と配信版を扱う装置を作った段階で、局所性の費用優位や増員効果の実証ではない。公開catalogはファイル名を最初から配信し、従来課題ではregistryとpolicyを一度に要求できた。opaqueな複数資料と、registry本文だけが正しい参照先を区別する課題で補う必要がある。

局所性の目的は「読むファイルを最小にする」ことではなく、必要な情報を得て正しく完成するまでの負担を抑えること。広い初期contextを強い対照として残し、読取の追加call、再試行、準備/走査、全promptのtokens、上位の負担も含める。大きな初期配信が小課題で有利でも矛盾しない。

read scope（どの本文を得るか）、impact scope（何に影響しうるか）、write authority（実際に何を書けるか）は別の判断。今回は最初の比較だけを実装し、manifestで指定した全targetを起動する。読取要求やmodelの自信を権限拡張の根拠にしない。

多言語化は言語別adapterと、版・証拠・確定を扱うkernelの分離を方向とする。static候補、実配信、model-claimを同じ確度のedgeに潰さない。次のTS adapterも、実装後の動作と対応境界を確認してから対応済みと報告する。

## 表現を補正する点

「何を知っていたか」は配信証拠からは強すぎる。観測できるのは、あるcallのpromptに特定bytes/版が含まれたことと、その後の要求/出力である。理解、注意、記憶、思考上の因果関係は保証しない。品質oracleと配信順監査を分ける。

opaqueな名前も推測を不可能にはしない。今回のworldは同じcatalogと全policy本文を保持し、registryだけを変える。同じ名前から異なる正解になる反例を作れるが、1回の当たりを意味依存の発見と認定しない。二段読取監査も、registry配信がpolicy要求と同じcallなら有効とする。promptはそのcallの応答より前だからである。

`maxPathsPerRead=1`は列挙するpath数の制約で、1pathから辿る静的closure、共通初期context、全token量の制約ではない。広域対照の追加配信bytesが0でも、無料・本文0という意味ではない。

現在の環境識別はNode/platform/arch等に限る。今回の監査は同じhostで固定検査を新しく実行し、他runのreceiptを再利用しない。将来のreceipt再利用にはrun nonce、toolchainや依存を含むfingerprint、証拠の保存契約を別途定義する。現状を強い環境同一性の証明とは呼ばない。

## 作業順序

1. opaque資料、1要求のpath上限、別worldの固定oracle、局所/広域のN4/C2 pilotを実装する。本変更で実行済み。[結果](results/read-selection-pilot.md)。
2. TS adapterと小さなself-host課題を追加し、未調整の課題でも配信量と品質を観測する。
3. 同じ仕事のN=8/16/32と、総予算を揃える有用性比較を分けて実行する。C固定・実稼働数・上位の負担を明示する。
4. 確定した変更からimpact候補を更新し、必要targetだけを起動する。read/writeの権限とは分離し、見逃しと過剰起動を外側から検査する。

CLIはM6の共通入口を使い、今回の上限はtask v2のdiscovery設定として追加した。実験準備と監査は明示的なscriptとし、runの再開や自動applyを混ぜない。[実行計画](execplan-progressive-read.md)。
