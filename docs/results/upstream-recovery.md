# 上流再検査とthinking有効の実測

公開された下流checkの失敗から、配信済みの上流targetを有限回再検査する機構を追加した。固定応答の反例は従来7call失敗、有効時6call成功。実DeepSeekでも公開エラーの原因を上流で修正できたが、別の境界値バグが残ったため、保存済み失敗snapshotの全体品質は改善できていない。

## 設定

利用者の追加指示により、今後のGo DeepSeekはthinking enabledが既定。単体・Sheepの品質/所要時間benchmarkも同じ設定へ変更した。今回の実測は`opencode-go/deepseek-flash`、N4/C2、upper0。1call出力64,000 tokens、1条件総1,000,000 tokens、予約100,000 tokens。4条件の受付上限は4,000,000 tokens。最大12call、targetごとの既存attempt上限を維持する。通信timeoutは600秒、task全体の時間締切や固定時間採点はない。時間にはrun開始から独立した最終確認までを含む。失敗の`completionMs`はnullとし、経過時間だけを残す。

新規の2条件は従来のpropagation-1 fixtureを全target起動したもの。保存済み不具合の2条件は前回のnamed-series/propagation-1-sheepのamount/cartとinvoice stubをそのまま初期値にして、invoiceだけ初期起動する。public/final checksは元のfixtureと同じ。preflightで元候補の失敗と独立参照解の成功を確認し、実行前にsource/runtime hashesを保存した。回復有効条件だけtaskに`recovery.maxUpstreamRechecks:2`を指定する。順序は保存済み不具合off→on、新規on→off。

## 上限緩和後の結果

| 課題 | 上流再検査 | 全体受入 | 実所要時間 | call | tokens | 上流再起動 |
|---|---|---|---:|---:|---:|---:|
| 保存済み不具合 | 無効 | 失敗 | 経過91.90秒 | 2 | 25,150 | 0 |
| 保存済み不具合 | 有効 | 失敗 | 経過33.03秒 | 4 | 18,415 | 2 |
| 新規実装 | 有効 | 成功 | 完了32.19秒 | 3 | 12,838 | 0 |
| 新規実装 | 無効 | 成功 | 完了38.56秒 | 3 | 13,921 | 0 |

全12callのusage・要求model・応答model・thinking設定を確認した。未知usage・予約超過・timeout・出力上限到達は0。最大出力は17,943 tokensで、旧8,000上限を超える応答を最後まで観測できた。全条件で元sourceのhashは不変。登録N4、許容C2だが、この依存連鎖で実際の最大同時callは1。参加worker数は表順に2/4/3/3。

保存済み不具合の有効条件は、invoiceの公開失敗→amount再検査→cart再検査→invoice再試行の4call。amountが整数文字列を最小単位へ変換しないバグは直った。amountの15桁超を一律拒否する実装は残り、safe integer上限の有効値を拒否してfinalで失敗した。このfinal診断はモデルへ返していない。無効条件はinvoice内で補正して公開checkを通ったが、上流の不具合が残るためfinalで失敗した。

新規実装では両条件とも3callで成功し、回復hookは起動しなかった。各1回の小規模観測であり、約6秒の差を回復機構の速度改善と解釈しない。失敗条件の経過時間の差も、品質を揃えた完了時間の比較ではない。現在示せたのは公開失敗から上流を再検査できることまで。

## 旧上限の試行と実装委譲

最初はthinking enabled、出力8,000/総120,000/予約20,000 tokensで開始した。保存済み不具合の回復無効条件は5call/34,826 tokens・経過106.92秒で失敗。2callが`finish_reason:length`で終了した。集計がエラーreceiptの外側にrequestedModelを要求して誤って証拠不足停止にしたが、実際は全callのtranscriptにmodelと完全usageがあった。元の停止記録を保持し、別receipt auditで既知使用量を確認した。集計の修正後、利用者が上限緩和を指示したため、新条件の4runを別系列で実行した。旧試行を成功に変更していない。

純粋な上流選択関数はthinking有効の実Go swarmに委譲し、固定したテストへ1call/3,420 tokensで成功した。N4/C2、実同時数1・参加1。hostはTypeScriptのnoUncheckedIndexedAccessに対応する非null指定を2箇所補い、固定テストと型検査後に採用した。host側がscheduler・公開検査・証拠artifactの接続を実装した。今回全体は18call/108,570 tokens、upper0。上限緩和後の比較12call/70,324 tokensと、旧試行5call/34,826 tokens、部品実装1call/3,420 tokensを分けている。

## 検証と保存先

`npm run check`で512テスト成功、参照snapshot 2件のhash一致。回復無効の旧反例、回復成功、回復不能、健全なproviderのnoop、未起動provider、hidden-only失敗、基盤障害、timeout、signal、候補の構造変更、古い観測、総再起動上限を検査した。thinking既定のHTTP payload、CLI dry-run、単体/Sheepへの転送と、length終了の既知usage判定も確認した。`git diff --check`とExecPlan validatorにも合格。

機械可読の設定・結果・hashは[upstream-recovery.json](upstream-recovery.json)。生データは`.sheep/upstream-recovery/`の`component-run/`、旧`series/`、新`relaxed-series/`。新系列のruntimeは同directoryの`runtime/`へhashを照合して保存した。`audit.json`が12call、固定source/runtime、受入、completion区分を照合している。tokenは観測値であり実請求額ではない。host checkは信頼するsubprocessで、OS sandboxではない。

再現は`OPENCODE_GO_API_KEY`設定後、repository rootで`node scripts/upstream-recovery-benchmark.ts .sheep/NEW_OUTPUT`を実行する。新しい有料呼出しになる。過去のdisabled系列と旧上限を再現する場合は保存済みruntime/profileを使い、現在の既定値と混ぜない。

次は、公開エラーに合わせた局所修正と、元の契約全体の再確認を分けて測る。今回の再検査指示だけでは、公開checkに現れない別の欠陥まで直すことを保証できなかった。追加の公開検証項目を使うなら、新しい条件として先に固定し、対照にも同じ情報を与えて測る。
