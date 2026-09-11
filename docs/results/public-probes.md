# 公開反例の検証と上流への配信 — 実装・9条件の実測

task v2に、workerが公開probe IDを選び、hostが配信済みprovider版で反例を再現して上流へ渡すopt-in経路を追加した。実Go Flashで経路の動作は確認できたが、今回の1課題×各3反復では品質・速度の改善は確認できなかった。既定のfocusedと従来経路を維持する。[使用手順](../public-probes.md)、[計画](../execplan-public-probes.md)、[全結果・profile・hash](public-probes.json)。

## 比較条件

前回の分岐課題のsource・公開check・最終oracleをbyte単位で保持し、amount-probe.mjsだけを追加した。全条件の公開contextに同じprobe本文を含める。probeは既存の公開契約にあるparseAmount("1")の単位変換を検査する。従来方式にはdiagnose actionがなく、検証のみと上流配信の条件は同じcatalog・指示・maxRequests=6を持つ。両者の差はmaxRechecks=0対2。既存の自動再検査枠maxUpstreamRechecks=2は全条件で同じで、上流配信は別の追加枠を持つ。通常のworker試行・総call・token予算をリセットしない。

Go opencode-go/deepseek-flash、thinking enabled、upper0、N4/C2。出力64000tokens/call、総1000000tokens/run、予約100000tokens、最大32call/64round、通信timeout600秒。task全体の時間締切と固定時間採点はない。9条件の受付枠9000000tokensを先に固定し、条件順を反復ごとに循環させ、一系列のrunを同時に実行しなかった。元候補不合格・参照解合格・変異不合格と、probeの元候補失敗・参照解成功を先に確認した。

## 結果

| 条件 | 全体受入 | 成功時完了中央値・秒 | 総call | 観測tokens |
|---|---:|---:|---:|---:|
| 従来方式 | 3/3 | 43.61 | 18 | 107,437 |
| probeで検証のみ | 3/3 | 65.36 | 22 | 133,157 |
| 検証して上流へ配信 | 3/3 | 62.97 | 18 | 125,412 |

全9runが固定finalと独立再検査に成功。合計58call/366,006tokens、全件usage既知。run9の形式不適合1callを含む再試行と消費も残した。最大出力は12,116tokensで上限到達なし。実装部品の1call/10398tokensを加えると、今回の実モデル総量は59call/376404tokens。登録4・最大同時2・実参加4・実最大同時2は全実測条件で共通。部品生成はN4/C2、実参加1・実最大同時1だった。

完了時間はrun開始から独立検査・元source不変確認・receipt照合まで。準備処理とpreflightは0.55秒、手作業の課題作成・host実装・レビュー時間は未計測（null）で別扱い。成功だけにcompletionMsを設定し、非成功ならelapsedと消費を保持する設計だが、今回の9runに非成功はなかった。

| run | 条件 | 反復 | 受入 | 完了秒 | call | probe実行 | 証拠付き再起動 | 自動再検査 |
|---|---|---:|---|---:|---:|---:|---:|---:|
| 1 | 従来方式 | 1 | 成功 | 43.29 | 6 | 0 | 0 | 2 |
| 2 | probeで検証のみ | 1 | 成功 | 88.95 | 9 | 2 | 0 | 2 |
| 3 | 検証して上流へ配信 | 1 | 成功 | 120.42 | 6 | 1 | 1 | 0 |
| 4 | probeで検証のみ | 2 | 成功 | 45.43 | 6 | 0 | 0 | 2 |
| 5 | 検証して上流へ配信 | 2 | 成功 | 51.21 | 6 | 0 | 0 | 2 |
| 6 | 従来方式 | 2 | 成功 | 84.17 | 6 | 0 | 0 | 2 |
| 7 | 検証して上流へ配信 | 3 | 成功 | 62.97 | 6 | 1 | 1 | 0 |
| 8 | 従来方式 | 3 | 成功 | 43.61 | 6 | 0 | 0 | 2 |
| 9 | probeで検証のみ | 3 | 成功 | 65.36 | 7 | 0 | 0 | 2 |

## 機構として確認できたこと

上流配信条件の3回中2回（run3/7）で、workerがwhole_amountを選び、hostが配信版で失敗を再現してamount.mjsへ渡した。kernelの回復artifact確定から上流修正・全体受入まで成功した。同じwaveの別consumerによる要求はprovider-unavailableとして拒否され、同じ上流を重ねて起動しなかった。この2回は自動再検査を使っていない。残るrun5はprobeを使わず従来の自動再検査だけで完了した。

検証のみのrun2では、一つの反例を確認した後、別consumerの同じ版への要求をduplicate-probeとして拒否した。後の修正版ではprobeが通った。全体ではprobe検査4回（反例3・pass1）、証拠付き再起動2回。未検証のnoteそのものを受入証拠にせず、限定workspaceの検査receipt、入力hash/read stamp、確定candidateを監査した。

通常再検査を一度使ってもproviderが誤ったまま残るケースから、この追加経路で回復することは決定論的テストで確認した。今回の実モデルで起きた追加経路は自動再検査の前であり、この固定反例をそのまま実モデルで再現したと主張しない。

## 判断と限界

同じ反復で上流配信が従来方式より速かったのは1/3組。成功数はどちらも3/3、総callも18で同じ。完了時間中央値は従来43.61秒対配信62.97秒で、今回は改善を示していない。検証のみは22callに増えた。機構が動くことと、課題を速く高品質に解けることを分ける。

新しい公開probe本文を全条件に加えたため、この従来方式を前回の8/9等と直接比較して品質向上を推定できない。今回は1種類の合成課題だけで、従来方式も全成功するため品質改善を測る余地が小さい。hostが公開probeを準備する手間も未計測で、任意の反例生成・期待値の自動検証・未知の意味依存発見の成果ではない。通常利用の既定として有効化しない。

次は、従来方式が同じ種類の誤りを繰り返し残す新しい課題を固定し、必要時だけprobeを使う条件を比較する。診断actionがworkerの試行を一回消費する負担と、上流を再起動する便益を分けて測る。公開probeを先に用意する準備負担も記録する。検査内容・hidden oracleを実走後の失敗に合わせて緩めない。

## 実装・検証・再現

受付判定src/repo-probe-admission.tsは実Go swarmが固定テストに対して1callで生成し、hostがレビュー・型検査後に本文をそのまま採用した。manifest・wire形式・検査とkernelへの接続・比較基盤・テストはhostが実装した。全実装をモデル生成と表示しない。

最終npm run checkは型検査・541テスト・参照snapshot2件に成功。健全上流の誤診、未配信・無関係・古い版・重複・上限、検査中の版変更、timeout・signal・ファイル改変・未存在command・印なし/誤IDの失敗・unknown usageでの受付停止を確認した。probeのworkspaceに下流やhiddenファイルがコピーされないことも検査した。host checkは信頼するsubprocessであり、OS sandboxではない。

実測中に、新規作成されたproviderが元snapshotにないとprobe検査が例外になる問題を追加テストで再現した。実測対象は全て既存providerであるため、9runを同一runtimeで完走し、差分0の監査を保存してから修正した。新規providerは元entryを捏造せず、overlayからmaterializeする。最終監査で実測版との違いはsrc/repo-run.tsの欠落entry除外だけ。実測runtime、修正前の監査、修正前に失敗したテストlogを保持している。

生の証拠は.sheep/public-probes/series、部品生成は.sheep/public-probes/component-run。OPENCODE_GO_API_KEYを設定し、node scripts/public-probe-benchmark.ts NEW_OUTPUTで新しい有料系列を実行する。node scripts/audit-public-probes.mjs SERIESは保存済み系列のreceipt・元source・独立候補・公開probe入力・確定artifactを照合し、追加モデルcallを行わない。過去のdisabled系列と38条件の実測は変更していない。
