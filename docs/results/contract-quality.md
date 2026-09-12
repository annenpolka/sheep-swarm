# 公開仕様の再確認・単体対照・並列起動の実測

事前に固定した38条件を実行し、全receipt・元source・候補・独立受入を照合した。主モデルはopencode-go/deepseek-flash、thinking enabled、upper0。集計表の完了時間は成功したrunだけの中央値で、失敗の経過時間とは分離する。全38結果・設定・hashは[JSON](contract-quality.json)、設計は[ExecPlan](../execplan-contract-quality.md)。

## 条件

品質比較は複数欠陥・健全な上流・分岐の3課題×focused/contract×3反復。指示以外の公開仕様・check・oracle・再起動上限は共通。contractは同じcall内で元の公開仕様を要件ごとに確認させる。自己申告は受入証拠にしない。単体対照は独立/伝播の新規課題×single/Sheep×3反復。品質段階の成功数が多い指示、同点ならcallが少ない指示、さらに同点ならfocusedを選ぶ規則を先に固定し、今回はfocusedをSheep対照に用いた。既定のreviewは互換性のためfocusedを保つ。

速度比較は8本の独立した2段階の枝（16target）、うち2枝の設定変更。N16、C1/C4、全起動/関連4target起動×2反復。read policy・公開情報・全体oracleは固定。API workerはtool-less、host checkは信頼するsubprocessでOS sandboxではない。各run出力64000tokens/call、総1000000tokens、予約100000tokens、最大48call/64round、通信timeout600秒。task全体の時間締切と固定時間採点はない。独立したrunを同時には実行せず、条件順を交互・逆順にした。

単体は全targetを1callで変更でき、Sheepは1callで担当fileのみ変更する。単体は全公開情報を最初に受け取り、Sheepは既存の局所配信を使う。方式全体の比較であり、read量やcall数だけを独立に比較したものではない。

## 集計

| 条件 | 全体受入成功 | 成功時完了中央値・秒 | 総call | 観測tokens |
|---|---:|---:|---:|---:|
| baseline/sheep | 6/6 | 42.83 | 18 | 97,985 |
| baseline/single | 6/6 | 55.20 | 6 | 104,875 |
| quality/contract | 8/9 | 60.72 | 40 | 287,482 |
| quality/focused | 8/9 | 48.03 | 35 | 238,692 |
| speed/C1/all | 2/2 | 99.23 | 32 | 71,896 |
| speed/C1/impacted | 2/2 | 20.70 | 8 | 14,009 |
| speed/C4/all | 2/2 | 43.09 | 32 | 71,972 |
| speed/C4/impacted | 2/2 | 9.99 | 8 | 13,902 |

合計179call/900,813tokens。出力上限到達0call、最大出力28,484tokens。部品集計関数の実Go委譲1call/5568tokensは別計上。fixture作成とpreflightは3.00秒、手作業の課題作成・実装・レビュー時間は未計測（null）。これらをモデルの完了時間へ混ぜていない。計測elapsedはrun開始から独立した確認終了までを含む。

## 同じ課題・反復で両方成功した組

| 左 / 右 | 両方成功した組 | 左が速い | 右が速い |
|---|---:|---:|---:|
| quality/contract / quality/focused | 7 | 1 | 6 |
| baseline/sheep / baseline/single | 6 | 5 | 1 |
| speed/C4/all / speed/C1/all | 2 | 2 | 0 |
| speed/C4/impacted / speed/C1/impacted | 2 | 2 | 0 |
| speed/C1/impacted / speed/C1/all | 2 | 2 | 0 |
| speed/C4/impacted / speed/C4/all | 2 | 2 | 0 |

各条件2〜3反復の合成課題であり、一般的な優位や統計的な有意差は示さない。group全体の成功時中央値だけを比較すると成功した課題の偏りが混ざるため、時間はこの対応する組も確認する。失敗は全体成功率・総call・総tokens・下表のelapsedに残す。

## 観測からの判断

contractはfocusedと同じ8/9成功だったが、40対35call、両方成功した7組のうち6組で遅かった。指示文を強めるだけの品質改善は今回確認できず、既定はfocusedを維持する。healthy条件では両指示とも再起動0回であり、誤って健全な上流を再起動した場合の実モデル耐性を示す対照ではない。その不変性は既存の決定論的テストで別に検証する。

品質の非成功はrun5（focused・分岐・1反復目）とrun11（contract・分岐・2反復目）。前者は公開検査を通った後に固定finalで失敗、後者は公開検査の失敗を残して試行上限に達した。run11の保存された公開側の観測では、上流workerは仕様確認を自己申告し、桁数による過剰拒否を直した一方、整数の小数桁補完の誤りを残した。後続の別workerはその原因をnoteで指摘できたが、既に再検査を消費した上流へ修正として届かなかった。非公開の失敗内容を追加配信したり、その場で再起動上限を変えたりはしていない。

次の品質仮説は、診断を実行可能な公開の反例と対象版へ結び付け、hostで再現できた証拠を担当上流へ渡すこと。modelのnoteだけで依存や書込権限を増やさず、古い版・誤診・健全な上流を含めて検証する。必要時の上位介入はこの経路と分けて比較する。今回この追加経路は未実装。

新規課題のsingle/Sheepはともに6/6成功。成功時間中央値は55.20秒対42.83秒、同じ課題・反復の6組中5組でSheepが速かった。ただし異なる課題は2種類だけであり、幅広いrepositoryでの品質同等性や速度優位を示すものではない。単体は入力6711・出力98164tokens、Sheepは入力29382・出力68603tokensで、局所配信・分担・推論量が同時に変わる。reasoning tokensは出力に含まれるため二重加算しない。

独立枝の速度条件は8/8成功。全起動でC1からC4にすると中央値99.23秒から43.09秒、C4で関連起動にすると9.99秒だった。同じ反復の比較でも両方で同じ方向の差が出た。全起動は16call、関連起動は4callで全16targetのoracleを保った。登録Nは全条件16、実際の最大同時callは全起動C4で4、関連起動C4で2、C1で1。関連する枝が2本しかないため、C4を指定しても実並列度4にはならない。N16が最適であるとは判断しない。

## 個別結果

| run | 条件 | 課題 | 反復 | 受入 | 完了秒 | 経過秒 | call | 上流再起動 |
|---|---|---|---:|---|---:|---:|---:|---:|
| 1 | quality/focused | multiple | 1 | 成功 | 46.88 | 46.88 | 4 | 2 |
| 2 | quality/contract | multiple | 1 | 成功 | 70.61 | 70.61 | 4 | 2 |
| 3 | quality/contract | healthy | 1 | 成功 | 21.31 | 21.31 | 1 | 0 |
| 4 | quality/focused | healthy | 1 | 成功 | 12.48 | 12.48 | 1 | 0 |
| 5 | quality/focused | branching | 1 | 失敗 | — | 102.04 | 6 | 2 |
| 6 | quality/contract | branching | 1 | 成功 | 66.21 | 66.21 | 6 | 2 |
| 7 | quality/contract | multiple | 2 | 成功 | 66.27 | 66.27 | 4 | 2 |
| 8 | quality/focused | multiple | 2 | 成功 | 49.18 | 49.18 | 4 | 2 |
| 9 | quality/focused | healthy | 2 | 成功 | 11.28 | 11.28 | 1 | 0 |
| 10 | quality/contract | healthy | 2 | 成功 | 19.91 | 19.91 | 1 | 0 |
| 11 | quality/contract | branching | 2 | 失敗 | — | 200.38 | 13 | 2 |
| 12 | quality/focused | branching | 2 | 成功 | 227.03 | 227.03 | 8 | 2 |
| 13 | quality/focused | multiple | 3 | 成功 | 51.29 | 51.29 | 4 | 2 |
| 14 | quality/contract | multiple | 3 | 成功 | 93.76 | 93.76 | 4 | 2 |
| 15 | quality/contract | healthy | 3 | 成功 | 10.25 | 10.25 | 1 | 0 |
| 16 | quality/focused | healthy | 3 | 成功 | 18.29 | 18.29 | 1 | 0 |
| 17 | quality/focused | branching | 3 | 成功 | 51.44 | 51.44 | 6 | 2 |
| 18 | quality/contract | branching | 3 | 成功 | 55.23 | 55.23 | 6 | 2 |
| 19 | baseline/single | independent | 1 | 成功 | 45.95 | 45.95 | 1 | 0 |
| 20 | baseline/sheep | independent | 1 | 成功 | 23.26 | 23.26 | 3 | 0 |
| 21 | baseline/sheep | propagation | 1 | 成功 | 70.51 | 70.51 | 3 | 0 |
| 22 | baseline/single | propagation | 1 | 成功 | 89.65 | 89.65 | 1 | 0 |
| 23 | baseline/sheep | independent | 2 | 成功 | 42.28 | 42.28 | 3 | 0 |
| 24 | baseline/single | independent | 2 | 成功 | 58.47 | 58.47 | 1 | 0 |
| 25 | baseline/single | propagation | 2 | 成功 | 40.23 | 40.23 | 1 | 0 |
| 26 | baseline/sheep | propagation | 2 | 成功 | 39.17 | 39.17 | 3 | 0 |
| 27 | baseline/single | independent | 3 | 成功 | 73.12 | 73.12 | 1 | 0 |
| 28 | baseline/sheep | independent | 3 | 成功 | 43.38 | 43.38 | 3 | 0 |
| 29 | baseline/sheep | propagation | 3 | 成功 | 65.92 | 65.92 | 3 | 0 |
| 30 | baseline/single | propagation | 3 | 成功 | 51.92 | 51.92 | 1 | 0 |
| 31 | speed/C1/all | parallel | 1 | 成功 | 99.71 | 99.71 | 16 | 0 |
| 32 | speed/C4/all | parallel | 1 | 成功 | 34.30 | 34.30 | 16 | 0 |
| 33 | speed/C1/impacted | parallel | 1 | 成功 | 16.77 | 16.77 | 4 | 0 |
| 34 | speed/C4/impacted | parallel | 1 | 成功 | 10.49 | 10.49 | 4 | 0 |
| 35 | speed/C4/impacted | parallel | 2 | 成功 | 9.49 | 9.49 | 4 | 0 |
| 36 | speed/C1/impacted | parallel | 2 | 成功 | 24.64 | 24.64 | 4 | 0 |
| 37 | speed/C4/all | parallel | 2 | 成功 | 51.87 | 51.87 | 16 | 0 |
| 38 | speed/C1/all | parallel | 2 | 成功 | 98.76 | 98.76 | 16 | 0 |

## 検証と再現

全runのruntimeを実行前にhashで固定し、同じdirectoryのruntime/へ保存した。baseline不合格・独立参照解合格・変異不合格を6課題で確認。全callのrequested/effective model、thinking、HTTP終端、usageと予算の一致を検査した。元sourceと独立検査workspaceの候補hashも照合済み。未知usage・予約超過・基盤障害なら後続を止める。監査時の現行runtimeとの差分はJSONのcurrentRuntimeDifferencesに明示する。全実測終了時の初回監査は差分0で保存した。その後、reviewに明示nullを渡す入力を拒否する検査を追加したため、最終監査ではsrc/repo-manifest.tsだけが異なる。有効な実測設定の意味は変えていない。実測時のruntimeと修正前の監査を保持する。

最終のnpm run checkは型検査・521テスト・2参照snapshot照合に成功した。集計関数は実Go swarm（N4/C2、実参加1・最大同時1）が1callで生成し、hostが配列参照の非null指定と中央値の加算overflow回避を補修して採用した。その他の比較基盤・本体への接続・検査とレビューはhostが実装した。部品生成を含む今回の実モデル総量は180call/906381tokens。部品runと最終検査logのhashもJSONへ保存した。

OPENCODE_GO_API_KEY設定後、node scripts/contract-quality-benchmark.ts .sheep/NEW_OUTPUTで新しい有料系列を実行する。node scripts/audit-contract-quality.mjs SERIESは保存済み結果を監査し、モデルを呼ばない。node scripts/report-contract-quality.mjs SERIESは本系列のhashに固定したレポート再生成で、モデルを呼ばない。新しい系列の解釈とレポートは別に作る。生データは.sheep/contract-quality/series。過去のdisabled系列と旧token上限の試行は変更していない。
