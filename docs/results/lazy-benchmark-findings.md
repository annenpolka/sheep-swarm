# Lazy swarm: 三対照の凍結dev比較

**18課題×三方式の54条件を完了・監査した。子なしrootは18/18成功、lazyは16/18成功。lazyは子なしrootに対し成功組の時間比中央値で1.31倍、総tokensで2.07倍だった。事前の採用条件を満たさず、lazyを実験用opt-inに留める。**

| 方式 | 受入成功 | 成功時の時間中央値 | 全call | 総tokens |
| --- | ---: | ---: | ---: | ---: |
| 旧packet-all | 18/18 | 17.45秒 | 18 | 171,410 |
| 新root・子なし | 18/18 | 11.21秒 | 18 | 162,408 |
| 新root・fork許可 | 16/18 | 13.77秒 | 31 | 336,747 |

全体で67call / 670,565tokens。通信再試行・使用量不明・未評価は0、上位callも0。失敗を含む実行時間の合計は789.93秒（準備・独立監査を除く）。失敗の完了時間はnullで保持した。

## 層別の結果

時間比は同じ課題で両方式が成功した組ごとの比を取り、その中央値を示す。上の全体の時間中央値同士を割った値ではない。

| 課題群（各6件） | packet-all / root-only / lazyの成功数 | lazy / packet-all | lazy / root-only | forkした課題 |
| --- | --- | ---: | ---: | ---: |
| 小修正 | 6 / 6 / 6 | 0.75倍 | 1.54倍 | 1/6 |
| 独立実装 | 6 / 6 / 5 | 0.84倍 | 1.26倍 | 0/6 |
| 連結実装 | 6 / 6 / 5 | 0.79倍 | 1.31倍 | 2/6 |

lazyは旧packet-allとの両成功16組で13勝したが、子なしrootには13敗・3勝だった。小修正は子なし対照への追加負担の条件を満たさず、独立・連結実装は品質も1件ずつ下回った。独立実装で求めた両基準比0.90以下の時間も、子なしrootに対して満たさない。

子なしrootは全18件を各1callで完了し、旧packet-allより15/18件で速かった。paired時間比中央値は0.52倍。入力tokensは118,478対83,192と増え、出力tokensは43,930対88,218と減った。prompt、変更ファイルだけを提出できる形式、会話構造が違うため、どの変更が時間差の原因かはこの比較だけでは分離できない。この速さをswarmの利益とは数えない。

## 実際の分業と失敗

自然なfork要求は4回、成功した起動は3課題・各子1体だった。独立実装6件ではfork要求自体が0回。全18件中15件は子なしで終わった。却下toolは4回、親の初回後のcallは10回、join後の親callは2回。親子のモデル実行が重なった時間は合計14.05秒、joinでの待ちは30.71秒、子候補の破棄tokensは0だった。

| forkした課題 | 品質 | 所要時間 | 親子の重なり | join待ち |
| --- | --- | ---: | ---: | ---: |
| syn-units-v00（小修正） | 成功 | 26.79秒 | 2.57秒 | 14.54秒 |
| lazy-coupled-2（window） | 失敗 | 29.28秒 | 4.69秒 | 16.17秒 |
| lazy-coupled-3（stats） | 成功 | 22.51秒 | 6.79秒 | 0.00秒 |

失敗2件は公開検査を通り、固定oracleで落ちた。子候補の版不整合やscope違反での失敗ではない。

- `lazy-independent-0`: 子のない状態で空のjoinを要求して却下された後、親が直接実装した。unitsのparse関数が小数を許可し、`1.9`を2へ丸めた。公開仕様には「No dot or fractional part is allowed.」とある。計測後にこのparseファイルだけを基準解へ差し替えると、全公開検査とoracleが通った。
- `lazy-coupled-2`: 子9ファイルは公開検査を通って統合された。失敗は親のdecide関数で、すでにbucket番号である引数を再びbucketIndexへ通し、別のbucketとして扱った。計測後に親のdecide 2ファイルだけを基準解へ戻すと全検査が通り、子scopeだけを基準解にしても失敗が残った。

差し替えは[終了後の診断](lazy-benchmark-diagnostics.json)であり、失敗2件を成功へ変更していない。親の意味上の誤りという切り分けはできるが、1反復からtoolの存在が誤りを引き起こしたとまではいえない。変更target数の中央値は三方式とも9だが、これはbaselineとの差分bytesを持つファイル数で、意味上必要な変更数ではない。

## 今回の判断と次の範囲

lazyの機構追加や子の増員を先に進めない。旧packet-allを既存基準、子なしrootを有望な新しい対照、lazyを実験用opt-inとして残す。「分業しない経路を壊さない」という必要条件は、現在のfork許可経路ではまだ確認できていない。

次の検証は、同じ小さなdev課題の反復拡大より、公開contextと必要な実装量が大きい少数の課題で三対照を再確認すること。独立した部分と親が続ける仕事を公開仕様で定義し、選択にhidden defect情報を使わない。そこでも子なしrootを必ず残し、分業の有無と単なるrunner差を分ける。今回も入力がSingleで扱える規模に収まるため、独立作業一般での分業の価値を否定する結果へ拡張しない。

## 比較の意味

旧packet-allは全targetを一括で実装する既存経路。root-onlyは新しい継続型の親を使い、子の作成を無効にする。lazyは同じ親にfork/joinを許し、親が実装を続けながら子を最大2体まで起動できる。全方式の下位モデルはopencode-go/deepseek-flash、thinking有効、上位0。親子を合わせてC3、課題間は逐次実行する。

小修正6件は旧devの最初の6familyのv00をbyte/hashを変えずに使う。独立実装6件は各3familyの4target課題を別directoryに置いた12target・3component構成。連結実装6件は同familyの16target・1component構成である。後二群は関数本体を未実装にし、既存の仕様・公開検査・最終oracleを再利用した。各未実装ファイルを一つだけ残した基準解がoracleで落ちることも事前検査した。18/18課題でbaseline失敗・reference成功、243/243意味変異の検出を確認した。145変異は一つの実装必須ファイルを未実装のまま残した候補で、29変異は公開検査を通り非公開oracleだけで落ちる。

連結実装にも並行実装できる部分はあり得る。また三群はサイズ・実装量・family構成も異なり、graphの接続性だけを変えた比較ではない。18課題にはfamilyの再利用があり、1反復の探索的dev比較である。evaluation corpusとManagerは使わない。

## 事前に固定した判断条件

三群それぞれでlazyの成功数が両基準を下回らず、両方式成功のpaired時間比中央値が小修正<=1.10、独立実装<=0.90、連結実装<=1.10であることを次段階へ進む必要条件にした。未評価があれば判断を保留する。通過しても、この小標本だけで既定方式は変えない。

実行順は三群を交互にし、各群で三方式の全6順序を一度ずつ使う。時間はrunnerと実行検査、通信再試行とbackoffを含む。課題の時間締切はない。失敗の完了時間はnullとし、費用と経過時間は残す。事前準備、独立監査、操作待ちは性能時間から除く。

各条件32call、2,000,000tokens、call予約200,000tokens、出力上限64,000tokens。通信のtimeout/408/429/5xxのみ同じbaselineから最大3回再試行し、前attemptの使用量と予算を引き継ぐ。未知usageの予約分は受付制約の計算に使い、実消費とは呼ばない。公開検査からの通常修正は各runtimeの方式内で許し、hidden oracle失敗は引き直さない。

## 再現と証拠

型検査・617テスト・参照snapshot 2件が成功。全54候補を独立検査し、完了後の全receipt監査も成功した。集計の成功数・tokens・paired比は別のPython計算とも一致した。[監査済み集計とhash一覧](lazy-benchmark-dev.json)。

実行計画は[ExecPlan](../execplan-lazy-benchmark.md)。`.sheep/lazy-benchmark/dev-v2` にfixture、公開/private hash、runtimeのbyte snapshot、条件と順序、request/receipt、候補、独立oracle、controller stateを保存する。`dev-v1` は実モデル呼出し前の準備だけで、fixture全体のdigest照合を追加後にv2へ凍結し直した。

`node scripts/lazy-benchmark.mjs audit .sheep/lazy-benchmark/dev-v2` はモデルを呼ばず保存証拠を照合する。各attempt終了時に候補を独立検査済みであり、auditはその記録のhashとreceipt、kernelの現在版配信、モデル・thinking・token使用量を再照合する。`node scripts/report-lazy-benchmark.mjs .sheep/lazy-benchmark/dev-v2 docs/results/lazy-benchmark-dev.json` は完了監査から公開集計を作る。raw thinkingとprivate基準解は公開集計へ転載しない。
