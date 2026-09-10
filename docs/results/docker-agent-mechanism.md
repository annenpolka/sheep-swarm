# 機構実験のDocker Agent接続

追記: 後続の完了goalでsemantic全工程とstaged 3段階の実Luna検証を終えた。[完了記録](docker-agent-completion.md)を参照。以下は修正前に停止した時点の記録として保持する。

2026-09-10。`mechanism`にsandbox付きの局所tool・課金付き追加読取・段階別の独立VM採点を接続した。通常275テストと実VMのoracle検査8件は成功。実Lunaは終了tool不履行とusage欠落で停止したため、機構実験の全工程成功は未確認である。

## 実装した境界

- `static`・`semantic`・`staged`と、群れ・単独Luna・記憶なし・上位なしに対応。上位介入はtool-lessでguidanceのみを編集し、単独Astraの新規Docker実行は拒否する。
- `readRequests`は次の別の有料callで配信する。選択しただけのファイルを可視verifierが先取りして自動確定しない。正常な応答を得たcallに配信済みのreadだけを依存edgeへ登録する。
- 未読registryからpolicy所有先を明かさず、必要な現版の仕様・policy・decoderがcheckoutに揃うまで、可視ケース・値を含む事前採点・編集採用を解禁しない。可視検査VMにも同じcontextのIDだけを渡す。
- 可視bundleは既存の可視ケース生成から作る。独立した期待値・数値照合・境界値・最終ケース生成のブロックは変更前と一致する。最終失敗はstage barrierで止め、修正用promptへ戻さない。
- 実ファイル差分の全件をroleとleaseで検査する。読取要求と実編集の混在、可視テスト改変、担当外の変更、削除は採用しない。未知usage・cleanup不明・検証基盤障害では新しい呼出しを止める。

受入VMでは相対`.mjs` import、同期・Promise戻り値と6操作のpipelineを扱う。JSON読取はrealm内の`URL`、`node:fs`の`readFileSync`、`node:fs/promises`の`readFile`に限定し、供給済みJSONをUTF-8文字列として返す。実filesystemや一般のNode builtinは公開しない。これは合成fixture用の実行契約で、一般repoやNode 24+環境の互換保証ではない。

## 通常検査と実VM

`npm run check`: 275テスト成功、固定資料snapshot 2件一致。従来のCodex機構検査も保持した。Dockerの追加検査は3課題・3段階のoracle互換、読取配信と精算、旧版policy、追加read前の可視情報、全方式の履歴・role、実差分、最終失敗後の停止を含む。上位介入は制御したcallerで検査し、実Astra試行として数えていない。

`npm run sandbox:mechanism-probe`は以下をそれぞれ新しい認証なし・通信拒否VMで検査した。

| 検査 | 観測 |
|:---|:---|
| staticの基準解 | 成功 |
| semanticの基準解 | 成功 |
| stagedの各stage 0 / 1 / 2の基準解 | すべて成功 |
| semanticの旧実装 | 失敗 |
| 負の時刻にfloorでなくtruncを使う変異 | 失敗 |
| 必須decoder importのコメント化 | 失敗 |

8台すべてを削除した。基盤障害を変異拒否として数えていない。通常gateでは同じ観測runnerを制限付きNode子processで実行し、実VMのNode 22.22.1での動作と区別している。

## 実Lunaで分かったこと

共通条件はsemantic、1 domain・6 module、登録4体・同時2呼出し、上位0、最大24call、call当たり60,000 tokenの受付上限、240秒timeout。公開リポジトリの合成fixtureを使い、私有repoや対話資料をworkspaceへコピーしていない。

初回は2call後に`budget-unknown`で停止した。完全なusageがある一方、費用台帳が`agent_info.model = chatgpt/gpt-5.6-luna`を予約したLunaと異なるmodelとして扱った。Docker v1.137.0のこのeventは設定IDであるため、固定版の正確なprovider/model表記を許容し、実際の提供modelの証拠には格上げしないよう修正した。異なるmodel、別provider、明示された実modelの相違は引き続き拒否する。保存した2レシートの再監査額は0.028165 credits相当で、元の停止結果は変更していない。

修正後は別runで受付上限を2.9相当に下げた。4callでregistryとpolicyの読取を済ませ、次の2callがingest/windowを編集し、それぞれの可視検査が成功した。ingest側は`__structured_output__`を呼ばず、2回のreminder後にエラー終了した。usage event 1件に`last_message`がなく、総額を確定できない。新規callを止め、実行中だったwindow側の完了とcleanupを回収した。元runのkernel確定は0件、全体受入は失敗である。

| 観測 | 初回 | 台帳修正後 |
|:---|---:|---:|
| 実Luna call / 上位call | 2 / 0 | 6 / 0 |
| 正常に処理した追加読取要求 | 0 | 4 |
| kernel確定 | 0 | 0 |
| 全体時間 | 23.529秒 | 161.247秒 |
| input tokens | 4,823 | 30,876以上 |
| output tokens | 135 | 1,657以上 |
| 再監査したcredit相当 | 0.028165 | 0.162618以上、総額不明 |
| worker VM / 受入VM | 2 / 1 | 6 / 1 |

合計は0.190783 credits相当以上、使用量不明1call。Standard token-rateによる見積であり、利用枠の実減算や請求額ではない。不明分を0扱いして再試行していない。

window側は正しい終了toolを使い、完全なusageと実差分を回収できた。モデルを再呼出しせず、その保存候補だけを追加の独立VMで検査し、可視oracleに合格した。停止した元runへの採用や、全課題成功への読み替えはしていない。今回のprobe・2実走・保存候補の再検査で作成した19台はすべて削除した。

## 次に確認すること

最終のlocal-tool指示には`__structured_output__`で終了し、ファイル本文を回答へ重複出力しないことを明記した。この指示修正後の実Luna再試行はまだ行っていない。usage不明の履歴を保持したまま、別枠の小さな終了形式検証を経て、6 moduleの全工程・段階更新へ進める必要がある。

Dockerでの単独Luna・記憶なし・上位なし・上位介入は制御検査まで。既存の`mechanism:experiment`凍結系列はCodex/tool-lessとして保持した。今回の記録をN比較、介入効果、速度・費用優位の証拠には使わない。

生レシートは`.sheep/docker-mechanism-semantic-20260910/`と`.sheep/docker-mechanism-semantic-fixed-20260910/`。実VM probeは`.sheep/docker-mechanism-probe-1789009246460/`、保存候補検査は`.sheep/docker-mechanism-window-replay-20260910/`。公開可能な集計・原本hash・cleanup証跡は[docker-agent-mechanism-evidence.json](docker-agent-mechanism-evidence.json)。最終ソースhashと実走時の指示修正前という差も記録した。
