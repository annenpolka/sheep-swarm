# 合成課題でのDeepSeek Flash初回pilot

2026-09-11の利用者依頼「Deepseekで回してみて」に基づく。モデルなしの全件検査に通った[合成課題集](../synthetic-corpus.md)から、16系統のvariant 0を1件ずつ、計16課題に固定して実行する。各4targetで、規模比較や単体との対照は含まない。

## 固定条件

- `opencode-go/deepseek-flash`、thinking enabled、N=4、C=2、上位call 0。
- 各課題maxCalls 32、maxRounds 64、総1,000,000tokens、予約100,000tokens/call、出力64,000tokens/call。系列の受付枠は16,000,000tokens。
- task全体の締切なし。通信timeout 600秒は不明なprovider実行を停止するための設定で、固定時間内の成功を採点しない。
- 課題を順番に実行し、実行中のsource・task・oracleを変更しない。activation起点に非公開の不具合箇所を与えず、元manifestの全4target起動を使う。
- 改変前の課題・manifest・source hashと実装コピーを保存。先に各課題のbaseline/reference/意味変異を再検査する。
- 未知usage、予約超過、429等のprovider障害、検証基盤障害、元repoの変更を確認したら新規課題の受付を止める。既知usageの品質失敗は残して次へ進む。

`elapsedMs`は`runRepository`の呼出し開始から戻るまで（hostの最終検査を含む）。成功した課題だけ同じ値を`completionMs`に置き、失敗時はnull。別途行う候補の独立再検査とreceipt照合は`auditMs`へ分ける。準備時間や課題作成の人手を解答時間に混ぜない。人手の時間と実請求額は不明のまま記録する。

runnerは[`scripts/synthetic-corpus-benchmark.ts`](../../scripts/synthetic-corpus-benchmark.ts)。通常の再実行は既存のGo keyを環境に設定してから、次のコマンドを使う（実モデルを呼ぶ）。credential storeの自動読込は実装していない。今回の呼出しは以前の実走と同じ認証経路を使い、keyは子processの環境だけへ渡した。

```sh
node scripts/synthetic-corpus-benchmark.ts NEW_OUTPUT_DIRECTORY
```

## 結果

**16課題中14成功（87.5%）**。これは各系統1回の観測値で、256課題全体の成功率ではない。全64callの要求・返却モデルはdeepseek-flash、thinking enabled、使用量完全。上位callは0、未知usage・予約超過・source driftは0。各課題4call、全local提案は受理され、追加callは発生しなかった。

成功14課題の完了時間中央値は34.63秒、最短7.44秒、最長110.18秒。成功・失敗を含むrun時間の合計は528.65秒。モデル呼出し前の準備は31.44秒、各run後の独立監査は計4.61秒で別計上した。通常テストは実モデル系列の終了後に実行した。

総使用量は**300,036tokens**（入力159,818、出力140,218）。reasoning 120,667tokensは出力の内数。実請求額は不明。

| 系統 | 最終受入 | 実行秒 | call | tokens | 最大同時call |
| --- | --- | ---: | ---: | ---: | ---: |
| units | 成功 | 43.08 | 4 | 17,684 | 2 |
| baseconv | 成功 | 35.36 | 4 | 15,183 | 2 |
| window | 成功 | 17.67 | 4 | 10,311 | 1 |
| stats | 成功 | 15.19 | 4 | 10,830 | 2 |
| intervals | 成功 | 33.90 | 4 | 15,866 | 1 |
| apportion | 成功 | 43.51 | 4 | 18,546 | 1 |
| topk | 成功 | 18.08 | 4 | 13,055 | 1 |
| dedup | 成功 | 35.99 | 4 | 16,220 | 1 |
| text-normalize | 成功 | 7.44 | 4 | 10,771 | 2 |
| kvcodec | 成功 | 110.18 | 4 | 45,753 | 1 |
| rle | 成功 | 37.81 | 4 | 25,690 | 2 |
| paths | 成功 | 22.57 | 4 | 21,696 | 2 |
| inventory | 成功 | 55.86 | 4 | 31,478 | 2 |
| workflow | 成功 | 13.15 | 4 | 10,843 | 1 |
| permissions | 失敗 | 13.98 | 4 | 13,344 | 2 |
| ledger | 失敗 | 24.89 | 4 | 22,766 | 2 |

失敗2課題とも、全公開checkを通過した後にhostの固定holdoutで不合格となり、独立再検査でも同じ失敗を確認した。最初に検出された反例は`Array(2)`のような空き要素を持つ配列。permissionsは`[undefined]`、ledgerは空き要素を持つ配列を返し、期待する`null`と違った。候補の一部で、元コードの`Array.from(...).every(...)`が空き要素を飛ばす`.every(...)`等へ書き換わっていた。hidden結果をworkerへ戻していないので、4call後の最終失敗をそのまま保存した。他の不具合が存在しないという主張ではない。

疎配列の拒否はモデル実行前に凍結したoracleに含まれていた。公開文は「文字列の配列」「非負のsafe integerの配列」であり、denseという語は使っていない。失敗はこの固定契約下の結果として扱い、より明示的な公開仕様との比較は新しいhashの別条件で行う。

[課題ごとのhash・結果・使用量・固定profile](synthetic-corpus-deepseek.json)。`node scripts/audit-synthetic-corpus-benchmark.mjs .sheep/synthetic-deepseek/pilot-16`で、raw API usageとrun budgetの一致、モデル・thinking、非公開oracleの非配信、元repoの不変性、成功判定と独立検査の一致を再監査した。`npm run check`は551テスト成功・reference snapshot 2件一致、`git diff --check`も成功。

今回の実走ではgenerator・kernel・oracleを補修していない。残り240variant、N=8/16/32、単体・Managerとの同条件比較は未実行。4targetの初回対照として利用し、今回の失敗だけを見てSheep固有の原因と断定しない。

全16系統をここで解かせるが、evaluation側の8系統をsolver調整へ流用しない。1系統1試行であり、同一課題の反復による成功率推定や、Sheepの単体・Managerに対する優位は示さない。
