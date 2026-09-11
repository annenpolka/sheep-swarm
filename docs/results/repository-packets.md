# Repository packet実装と実DeepSeek疎通

2026-09-11。「進めよう」に基づき、[packet executor](../repository-packets.md)とCLIを実装した。dev 128件の粒度比較、適応選択、activationやManagerの追加比較はまだ行っていない。

## 実装と部品生成

`src/repo-packets.ts`の分割と`src/repo-packet-response.ts`の応答検査は、opencode-go/deepseek-flash・thinking有効の既存swarmへ委譲した。独立した2target、N2/C2、最大8call、上位0、総2,000,000tokens、予約200,000tokens/call、出力64,000tokens/call、通信timeout600秒。固定host検査を先に用意した。

2callで受入成功、既知31,221tokens、unknown usage・active reservation・overrunは0。親が生成コードを検査し、返却型とstrict indexed accessを補修、疎配列のown-property確認を追加した。kernel接続・CLI・実行制御・テスト・集計器は親の実装。生成直後の固定検査成功と、repoへの統合後の型検査成功を区別する。

## 凍結dev 1件の疎通対照

`syn-apportion-v00`の同じ公開/非公開hashを使い、baseline不合格・reference合格・変異検査のpreflight後に5条件を実行した。順序は旧Single → packet-all → packet-2 → packet-1 → 旧Sheep。各1回、task間並列なし。runtimeのhash/copyと分割はcall前に保存した。

共通モデルはopencode-go/deepseek-flash、thinking有効、上位0。各条件は16call・2,000,000tokens・予約200,000・出力64,000・通信timeout600秒。task締切なし。旧SheepはN4/C4、packetはC4上限でpacketごとの状態を持つ。全部を起動し、不具合位置metadataは渡していない。

| 条件 | 全体受入・独立検査 | call | tokens | runnerを含む経過 秒 |
| --- | --- | ---: | ---: | ---: |
| 旧Single | 成功 | 1 | 3,090 | 5.81 |
| packet-all | 成功 | 1 | 7,709 | 23.88 |
| packet-2 | 成功 | 2 | 10,329 | 26.03 |
| packet-1 | 成功 | 4 | 16,851 | 41.23 |
| 旧Sheep | 成功 | 4 | 19,957 | 52.83 |

計12call・57,936tokens、上位0。不明usageはなく、全callの生usage算術、HTTP 200、requested/effective model、thinking有効、public context、凍結runtime copyを独立に照合した。reasoning tokensは出力tokenの内数で二重加算しない。実請求額は不明。各候補は公開checkとhidden oracleを独立再実行し、元fixtureのGit/bytesが変わっていないことを確認した。独立監査は表のrunner経過の外で実行した。

この課題はpacket間に依存があり、実最大同時callは全条件1だった。C4の速度効果や広い独立課題の並列性能を検証した結果ではない。並列callと直列commitの接続は注入callerのbarrierで別途検証した。

全条件が通ったことは互換範囲の確認であり、品質同等や速度改善の証明ではない。新しいall経路もこの1回では旧Singleより遅く、tokenが多い。変更前baselineと現在overlayの重複、prompt・check粒度・実行順・モデル変動があるため、packet粒度だけの効果へ読み替えない。本比較では同時期のallを含め、旧Singleも実用対照として保持する必要がある。

## 失敗・補修と検証範囲

最初のsmoke準備は、生成fixtureのGit初期化漏れにより親repoが探索され、公開pathが見つからず停止した。profile作成・モデルdispatch前で0call。元ディレクトリを保存し、Git初期化を追加したsmoke-v2で上の5条件を実行した。usage不明の系列を再開したものではなく、PR #9の停止系列も変更していない。

最初の統合テストでは明示dependsOn循環が既存manifest validatorに拒否された。validatorを緩めず、v2静的importの循環を実行ケースにし、明示循環の非対応を文書化した。疎通実行後には、新規targetにoutputディレクトリが重なる場合の事前拒否を追加した。回帰テストでmacOSの/varと/private/varのpath表記差による見逃しを検出し、出力の既存ancestorをrealpathで正規化して修正した。実測のruntime copyはその補修前で、実測成績は書き換えていない。

最終gateは568テストと参照snapshot 2件。追加13テストは全3node有向graphの分割、同一executorの1/複数/all、原子的却下、旧read/lease/候補拒否、現在provider版、静的循環、未知usage精算、hidden失敗の非再試行、検証基盤障害、source drift、scope/graph変更拒否、CLI dry-run、新規targetのoutput衝突、成功時applyを含む。

[固定profile・生usage照合済み集計](repository-packets.json)。raw証拠はignoredの`.sheep/packet-implementation/run/`（部品生成）、`smoke-v1/`（準備失敗）、`smoke-v2/`（5条件）。再集計は以下でモデルを呼ばずに実行できる。

```sh
node scripts/report-packet-smoke.mjs .sheep/packet-implementation/smoke-v2 docs/results/repository-packets.json
```

実走の入口`node scripts/packet-smoke.mjs NEW_OUTPUT_DIRECTORY`は5条件を実際に呼ぶ。認証は既存の`OPENCODE_GO_API_KEY`を明示する。checked-inのscriptは認証storeを自動読取しない。
