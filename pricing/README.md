# 費用の概算

LunaとAstraの2026-09-10時点の[公式レート設定](openai-2026-09-10.json)を使う、モデルを呼ばない見積器。過去の[実験費用の再集計](../docs/results/cost-findings.md)と、[課題設定の研究](../docs/task-design.md)を参照。

## 実行前に見積もる

まず[入力例](planned-run.example.json)をコピーし、モデル別の総呼出し数、1呼出しの入力・キャッシュ読取・書込・出力tokenを編集する。

```sh
npm run estimate:cost -- --rates pricing/openai-2026-09-10.json --scenario pricing/planned-run.example.json --output .sheep/planned-cost.json
```

入力例はLuna40call（各入力19,000、うちキャッシュ読取13,300、出力250）とAstra1call（入力25,000、読取0、出力500）。結果はAPI Standardで **$0.34324相当、Codexで8.581 credits相当**。仮定した利用量に基づく例で、実行上限や新たなモデル実験ではない。

`calls` は全workerを合計した回数。個体数Nをさらに掛けない。Nが増えると仕事量や再試行回数がどう変わるかは、この料金計算の外で予測する。未知のtoken欄はnullを指定でき、キャッシュを0と仮定した確定額ではなく上下限を返す。

クレジットを実際に購入するUSD単価が分かる場合は、`--usd-per-credit` にその単価を渡す。価格を渡さなければ購入クレジットのUSD換算はnull。例に無根拠な換算レートを埋め込まない。

## 新しいrunを集計する

```sh
npm run estimate:cost -- --rates pricing/openai-2026-09-10.json --run .sheep/my-next-run --output .sheep/my-next-cost.json --markdown .sheep/my-next-cost.md
```

swarm/durable/compareが保存するrunディレクトリ、またはexperiment manifestのある実験ディレクトリを指定する。存在しないディレクトリや空の記録はエラーとなる。レシートが欠けた既知callは未知費用として残す。manifestが宣言したrunの欠落やhash不一致も、安い実験として集計しない。

## 今回の全実験を再集計する

```sh
npm run estimate:cost -- --rates pricing/openai-2026-09-10.json --root .sheep --output .sheep/recorded-cost.json --markdown .sheep/recorded-cost.md
```

`--root` はM2〜M5の既存8familyを名前で選ぶ。予備実行も集計し、本比較とは別のfamilyへ置く。公開リポジトリには生対話を含めていないため、生レシートを持つ作業worktreeで使う。公開された集計JSONにはモデル別・run別・call別のtokenとhashを含めており、本文は含めない。

## 計算の条件

通常入力、キャッシュ読取、キャッシュ書込、出力を別料金で計算する。reasoningは出力に含まれ、キャッシュは入力に含まれる。正規化usageと元eventを重複加算しない。価格やusageが分からない場合、上限nullは「不明」であって0ではない。

この見積はStandard・通常contextの条件付き。APIでの仮想token費用、Codex tokenレートのcredit相当、購入単価を明示した換算を分ける。Proなどの含まれる利用枠からの実際の減少、月額料金の割当、Fast、tool料金、税、開発Agent、人間の準備費用は自動推定しない。入力例・レートを変えても、実workerやその予算制御は変わらない。

単価変更時は新しい日付のJSONを作り、出典と確認日を記録する。過去のレートは過去の概算を再現するために残す。

## DeepSeek API

直接APIのレシートから`prompt_cache_hit_tokens`・`prompt_cache_miss_tokens`・`completion_tokens_details.reasoning_tokens`を読み、cacheとreasoningを二重計上しない。使用量欠落、壊れたcounter、途中終了は確定費用にしない。

2026-09-10確認の[公式料金](https://api-docs.deepseek.com/quick_start/pricing/)を[off-peak](deepseek-2026-09-10-off-peak.json)と[peak](deepseek-2026-09-10-peak.json)に分けて保存した。平日01:00–04:00・06:00–10:00 UTCがpeak。run全体の時刻から料金帯を推測せず、用途に応じて料金表を明示する。通常モデルの条件付きAPI見積に使い、DeepSeekのCodexクレジット料金は設定しない。

```sh
npm run estimate:cost -- --rates pricing/deepseek-2026-09-10-peak.json --run .sheep/my-deepseek-run --output .sheep/my-deepseek-cost.json
```

期限付き`deepseek-v4.1-flash-expires-on-0910`の公表料金は確認できないためnull。要求名とprovider応答名が異なる場合も、別modelの料金を自動適用しない。これらのrunのtoken上限は費用・残高の強制上限ではない。

OpenCode Goのreceiptは`runtime: opencode-go`とAPI形式に従ってtokenを読む。同じ`gpt-5.6-luna`やDeepSeekのmodel名でも、Goの利用枠を既存の直接API単価・Codex creditへ流用しない。現在はGoの金銭見積をunknownとし、tokenとsubscription残枠・実請求額を区別する。[Go実測と料金識別確認](../docs/results/opencode-go.md)。
