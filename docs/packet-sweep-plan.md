# devのpacket粒度比較: 実行前の固定条件

2026-09-11。「やってみよう」に基づき実施する。共通packet executorを追加した`a1e4a4b`を基準とし、solverのprompt・分割・check・retryを途中で変更しない。旧系列の停止を解除せず、独立した新系列にする。

- 対象: 凍結したdev 128件、各条件1回。evaluationとManagerは対象外。既に見たdev結果は探索情報であり、完全未見とは主張しない。
- 方式: 旧Singleと共通packet executorのall/8/4/2/1。旧Singleは実用対照、packet-allは共通executor内の対照。
- 同値条件: 実際のpacket割当・packet依存・現在read閉包が同じなら一度だけ実行し、aliasesを保存。共有観測を別試行や速度の引分けに数えない。旧Singleは同じ全targetでも別の実装なので統合しない。
- 順序: 課題を`sha256(packet-dev-v1:ID)`で並べ、同じ課題の方式を隣接させる。familyと同値class構成が同じ群ごとに、方式の順序をrankで回転し、一巡ごとに反転する。各群の件数が方式数で割り切れない場合は完全均衡ではない。実際の順序はprofileへ全件保存する。
- モデル: opencode-go/deepseek-flash、thinking有効、上位0。task間の並列は1、packetの最大C4。全target起動、変更前の公開baselineと現在のpacket依存閉包を分けて配信する。非公開の不具合位置を起動hintにしない。
- 各条件の枠: 128call、2,000,000tokens、予約200,000tokens/call、出力64,000tokens/call、通信timeout600秒。packetは最大256round。taskの固定時間締切はない。
- 系列の受付枠: 同値を除いた実run数×2,000,000tokens。これは上限の予約容量であり、実消費や請求見積ではない。

`node scripts/packet-sweep.mjs prepare NEW_DIRECTORY`で全256件の凍結hashを照合し、dev128のbaseline/reference/mutant preflight、独立したGit fixture、分割、runtimeのcopy/hash、profileを先に保存する。`run DIRECTORY`は実APIを呼ぶ。認証は環境変数で明示し、checked-inのcontrollerは認証storeを自動読取しない。

品質は有効な全観測から報告する。時間は旧Singleとpacket-allのそれぞれを参照し、同じ課題で両方式が成功した組の比を測る。失敗elapsedと成功completionを分け、同値条件をpaired winsから除外する。family・topology・target数・依存深さ別にも集計する。各方式の成功集合が異なる中央値をそのまま速度差にしない。単一試行やfamily内variantの相関から、品質同等や有意差を断定しない。

全callと既知token下限は、品質失敗・証拠不足を含め一度ずつ計上する。方式表にはaliasを含む同じ観測が現れるため、方式別tokensを合算して系列消費を求めない。実請求額は不明として保持する。準備・独立監査をrunnerの実所要時間と別計上し、packet内部の公開再検査はrunner時間に含む。

各run後に元fixture不変、raw usage、requested/effective model、thinking、配信範囲、候補hash、独立公開/hidden検査を照合する。品質不合格は候補を保存して次へ進む。使用量不明、receipt欠落、検証/実行基盤障害では新規受付を停止する。発行済みcallは精算し、inFlightや停止理由がある系列は自動再送しない。独立監査で隠れた失敗を見つけても、その内容を修復callへ返さない。

実行中の勝敗を見て順序・課題・prompt・採点を変えない。途中停止した場合は残りを未実行として明記し、途中結果から適応器やevaluationの設定を確定しない。


準備結果: 128件すべてpreflight成功。6条件×128=768から、同じ実分割の124条件を共有し644実runに固定した。系列受付枠1,288,000,000tokens、準備166.12秒。profile SHA-256は`a3cb6d9bd7348a06e41343d43c9787871d7c39da82301d2190f274f15fc82996`。rawは`.sheep/packet-sweep/dev-v1/`。通常gateは571テスト・参照2件成功。

実行結果: 初回課題で3run完了後、packet-4のhost通知/read不整合で中断。26call・445,343tokens、使用量不明0。元profile/runtime/seriesを保全した。[障害と修正](results/packet-sweep-host-fault.md)。修正後はread policyが変わるため、この系列へ結果を継ぎ足さない。
