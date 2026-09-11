# 初回dev packet比較の中断とhost修正

2026-09-11。dev128件の[固定系列](../packet-sweep-plan.md)を開始したが、最初の課題のpacket-4がhost kernelの`unobserved-obligation`を繰り返したため、644実runのうち3完了・1中断で停止した。これはDeepSeekの品質失敗として数えない。修正後の実API系列は未実行で、粒度の優劣はまだ判定できない。

## 実APIで観測した範囲

全てopencode-go/deepseek-flash、thinking enabled、上位0。課題は`dev / syn-stats-v11`、32target、diamond、宣言依存深さ3。task締切なし、packet C4上限。3条件はraw receipt・元fixture不変・独立公開/hidden検査が通った。各方式1回、1課題だけの途中観測である。

| 条件 | 完了 | runner所要秒 | 実call | tokens | 実最大同時call |
| --- | --- | ---: | ---: | ---: | ---: |
| 旧Single | 成功 | 26.11 | 1 | 19,726 | 1 |
| packet-all | 成功 | 24.12 | 1 | 22,884 | 1 |
| packet-8 | 成功 | 32.39 | 4 | 63,427 | 2 |
| packet-4 | host基盤障害で中断 | 完了時間なし | 20 | 339,306 | 完了reportなし |

**合計26call、445,343 tokens、使用量不明0、上位0**。実請求額は不明。準備166.12秒はrunner時間と分ける。残り640runは未開始。中断した1runは品質・完了時間の集計へ入れず、その20callは消費へ入れる。

最後の発行済みcallのreceipt保存を確認してからrunnerを停止した。元の`series.json`は3完了・inFlightあり、`budget.json`や`kernel.json`も最後のcheckpointのまま保持した。外部停止記録とreceiptから会計を別計算しており、checkpointを精算済みに書き換えていない。runner/launcherの終了も確認した。

詳細は[集計](packet-sweep-dev-v1.md)、[機械可読結果とhash](packet-sweep-dev-v1.json)。rawは`.sheep/packet-sweep/dev-v1/`。profile SHA-256: `a3cb6d9bd7348a06e41343d43c9787871d7c39da82301d2190f274f15fc82996`。凍結solverは`a1e4a4b`のcopyであり、今回の修正版ではない。

## 再現した原因

公開source graphに直接の依存がなくても、packet内の全targetは同じcheckoutを読み、kernelは全writeへその配信readの依存を記録する。この同居関係によって、変更通知が元のsource依存閉包より遠くへ伝わる。

独立した`a`、依存`b → c → d`を`[a,b] [c,d]`へ分ける4ファイルだけで再現した。旧実装では後半packetが`b,c,d`だけを現在版として読むため、`a`変更から来た通知の処理をkernelが拒否する。正しいコードを何回返してもcheckoutへ`a`が追加されず、修復callが浪費される。

実課題では`src/audit-0.mjs`がこの未配信providerだった。packet-8へ4件の未処理通知が残った。公開check失敗ではなく、candidate作成前のkernel拒否である。

修正版は分割後の公開graphへpacket同居関係を加えてread閉包を求める。上流packetの同居targetとその上流も、現在版overlayとして事前に配信する。write authorityや採点条件は増やさない。またkernel例外をモデルのコード修正feedbackへ変換せず、`kernel-infrastructure`として発行済みpeerの精算後に新規受付を停止する。

## モデルを呼ばない検証

4ファイルの回帰テストは修正前に`unobserved-obligation`の反復で失敗し、修正後は2 stub callで成功。kernel例外を注入する別テストでは2件の発行済みpeerを精算し、次wave・修復call・hidden checkを発行しないことを確認した。

`node scripts/check-packet-host.mjs .sheep/packet-sweep/dev-v1 NEW_OUTPUT`は同じ32target課題・同じoracleへhost stubがreferenceを返す対照。凍結executorは9 stub call上限まで失敗し、修正版は8 stub callで成功した。[診断JSON](packet-sweep-host-diagnosis.json)。referenceはこのoffline診断だけの入力であり、実API promptへ渡していない。stub成功をDeepSeekの品質や速度として数えない。

## 次の測定へ持ち越すこと

read配信量が変わったため、修正版は別のruntime hash/profileで測る必要がある。元系列は終了・保全し、既存3条件を修正版とのpaired比較へ使い回さない。dev全件比較・粒度選択・evaluation・Managerは未完了のまま残す。

変更後の通常gateは`npm run check`（型検査、574テスト、参照snapshot 2件）と`git diff --check`が成功した。
