# Lazy swarm最小版: 実装とGo疎通

PR #11をf16a590でマージし、codex/lazy-swarmへ実装した。独立plannerを必須にせず、実装する親が同じ会話で継続しながら限定scopeの子を起動できる。直接提出・fork・join、子最大2体、共通C/call/token予算、子の現在版read検査、公開統合検査と固定最終oracleを備える。

## 最終の動作確認（smoke-v3）

公開作業構造が異なる小さな3fixtureを先に作り、baseline失敗・reference成功を確認した。モデルは親子ともopencode-go/deepseek-flash、thinking有効、出力64,000 tokens、run総1,000,000 tokens、予約100,000 tokens、上位0、C3、task時間締切なし。課題は順次実行し、三方式の先頭を課題ごとに回した。各条件1回であり、性能ベンチマークではない。

**三課題×三方式は9/9成功。別枠の強制forkも成功。合計14 call / 48,039 tokens、使用量不明0。** 全候補を独立した固定oracleで再検査し、元の品質判定との一致を確認した。要求・receiptのSHA256、実装scriptの前後hashを保存した。

| 課題 | packet-all | 新root・子なし | 新root・fork許可 |
| --- | ---: | ---: | ---: |
| local | 9.13秒 / 1call | 3.36秒 / 1call | 4.25秒 / 1call |
| independent | 54.96秒 / 1call | 25.58秒 / 1call | 9.57秒 / 2call |
| coupled | 3.75秒 / 1call | 2.36秒 / 1call | 1.86秒 / 1call |

fork許可でも自然な三課題は子0体だった。independentの追加callは最終JSONの後に余分な文字を付けてしまった形式エラーへの再提出であり、完了確認専用callではない。子を出さなかったことだけで既存Singleと同じ負担とはいえない。方式間にはprompt・JSON出力方式・会話の差もあるため、この単回の時間差を分業の利益とはしない。

明示的にb.mjsの委譲を要求した別の接続試験では、親1・子1で受入成功、4 call / 13,592 tokens、28.59秒。親子のmodel callの重なりは2.46秒、joinで子を待った時間は17.53秒だった。親は子が処理中でも継続できるが、子待ちは依然として大きい。この強制forkを、モデルが適切な分業を自分で選べた証拠には数えない。

## 初回の失敗も残す

Go会話probeの初回はtool要求と応答後の継続を実行できたが、最終JSONをMarkdown fenceで囲み、厳密なJSON検査で失敗した。2 call / 981 tokens。raw JSONを明記した別probeは2 call / 962 tokensで成功した。双方ともusageは既知で、messageのreasoning_contentをそのまま再送した。thinking本文は公開レポートへ転載していない。

smoke-v1はlocalのpacket-allと子なしが成功後、fork用checkpoint schemaのadditionalPropertiesがローカルvalidatorの未対応形式だったため、送信前に失敗した。runnerが一般のcaller例外として扱ったため、raw ledgerにはunknown usage 1が残った。直接preflightで同じ例外を再現し、boolean形式のschemaへ修正した。現在は実tool定義と会話を予約前に検査する。元3件のreceipt・3,774既知tokens・unknown 1を、修正後の成功へ書き換えていない。

smoke-v2は10条件 / 23 call / 63,407 tokens、unknown 0で完走した。coupledは全三方式で同じ空白差が原因のholdout失敗。公開指示の「user: followed by」に曖昧さがあったため、v3ではliteralが空白なしであると公開側へ明記した。oracleを緩めず、旧失敗を保つ。この品質差をruntime改善とは解釈しない。

v2では全scopeのforkや不明jobのjoinも発生した。tool項目にwrite/readの違いとjob IDの意味を説明し、現時点のjob状態を親へ返すようにした。複数toolのbatchが途中checkpoint後の版を無言で流用する危険も検討し、最小runnerは1turn1toolに限定した。

通常gateの並行試験では、子のrequest保存が遅いと親callerが先に動くことを正しく扱えていなかった。実装の順序を固定せず、試験側で双方の開始を待合せるよう修正した。

## 検証の境界と次の作業

`npm run check` は型検査・613テスト・参照snapshot 2件が成功。`git diff --check` とExecPlan validatorも成功した。

[設計とCLI](../lazy-swarm.md)、[実行計画](../execplan-lazy-swarm.md)。今回の受入は動く最小runtimeと安全な拒否境界であり、swarmの品質・速度優位ではない。旧凍結devを小修正の非退行対照にし、実装量を持つ独立した複数変更と強結合変更を追加して、packet-all / 新root子なし / 新rootfork許可を事前固定して比較する。evaluation corpusは今回使っていない。

保存証拠は [Go会話probe](lazy-go-continuation.json)、[v1の途中停止](lazy-smoke-v1.json)、[v2](lazy-smoke-v2.json)、[v3](lazy-smoke-v3.json)。v1は最初の不具合で終了し、前後source hashの保存も未導入だったため、集計のauditIssuesにその欠落を明示している。v2/v3はsource前後hashが一致する。生のrequest・receipt・候補・kernel・checksはローカルの.sheep/lazy-swarmへ保持する。

再検査は `node scripts/report-lazy-smoke.mjs .sheep/lazy-swarm/smoke-v3 /tmp/lazy-audit.json` で行う。モデルを呼び直さず、固定候補を再採点してreceiptを照合する。`scripts/lazy-swarm-smoke.mjs` と `scripts/probe-go-conversation.mjs` は明示実行時だけ実APIを呼び、通常gateから分離する。
