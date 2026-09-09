# モデル別単価とキャッシュを反映した費用概算

2026-09-10に公式価格を確認。[単価設定](../../pricing/openai-2026-09-10.json)、[再計算結果](cost-estimates-20260910.json)、[元の方式比較](comparison-findings.md)。

**今回の通常taskでは、Sheep-fixedのtokenは単体Astraの約8.1倍だったが、公開Standard単価と実際のキャッシュ読取を掛けると、費用相当は約1/13.5になった。** Sheep-fullは約1/15.8。前回のtoken比を、そのまま費用比にしてはいけない。一方、この事後換算は金額予算を揃えた再実験ではなく、一般的な費用優位の証明にはならない。

## 確認できた単価

全て100万tokenあたり。入力のうちキャッシュ読取・書込を除いた部分へ「通常入力」を適用する。

| モデル | API通常入力 USD | APIキャッシュ読取 USD | API出力 USD | Codex通常入力 credits | Codexキャッシュ読取 credits | Codex出力 credits |
|:---|---:|---:|---:|---:|---:|---:|
| gpt-5.6-luna | 0.20 | 0.02 | 1.20 | 5 | 0.5 | 30 |
| gpt-6-astra | 10.00 | 1.00 | 50.00 | 250 | 25 | 1,250 |

APIは[Lunaのモデルページ](https://developers.openai.com/api/docs/models/gpt-5.6-luna)と[Astraのモデルページ](https://developers.openai.com/api/docs/models/gpt-6-astra)、クレジットは[Codexの料金表](https://learn.chatgpt.com/docs/pricing)に基づく。価格の確認日を設定ファイルへ固定し、再集計時にどの価格を使ったかを保持する。

APIのcache write単価は通常入力の1.25倍で、Luna $0.25、Astra $12.50。今回の994呼出しでは `cache_write_input_tokens` が全件明示0だったため、この料金の影響はない。Codexのcache write単価は独立項目として確認できなかったのでnullのまま残す。値が分からない費用を0として扱わない。[API料金表](https://developers.openai.com/api/docs/pricing)、[キャッシュの計算式](https://developers.openai.com/api/docs/guides/prompt-caching)。

## 算定するものと、実際の支払い

今回のCodex CLIはChatGPT認証で実行した。次の三つは異なる。

| 指標 | 算定・確認方法 |
|:---|:---|
| API通常単価での費用相当 | 同じtoken利用をAPI Standardの価格で評価する仮想額 |
| Codexクレジット相当 | 公開tokenレートに基づくStandard利用の概算 |
| 購入クレジットの実際の減少・請求 | 利用枠、購入条件、実請求履歴による。今回のrun別ログだけでは復元できない |

料金表では、含まれる利用枠を使った後に利用可能なクレジットを使うと説明され、購入単価はplanや契約による。したがってPro月額をtoken数で割ったり、API換算額を追加請求額と呼んだりしない。購入時のUSD/creditが分かる場合だけ、明示した換算率でクレジット相当の購入費用を計算する。

Standard・通常contextが概算の条件。FastはCodexでAstraやGPT-5.6に2.5倍、APIで2倍という別の係数になる。APIは1requestの入力が272Kを超える場合も別料金で、複数callの合計inputにこの閾値を適用しない。service tierの証拠がない過去runをFast/Standardの実請求と断定しない。[Codex Speed](https://learn.chatgpt.com/docs/agent-configuration/speed)。

[見積器の使い方](../../pricing/README.md)から、呼出し前のシナリオ、新しいrun、今回の全実験をそれぞれ計算できる。

## 計算式とログの扱い

通常入力を `U`、キャッシュ読取を `R`、キャッシュ書込を `W`、出力を `O` とすると、

```text
U = input_tokens - cached_input_tokens - cache_write_input_tokens
費用 = (U × 通常入力単価 + R × 読取単価 + W × 書込単価 + O × 出力単価) / 1,000,000
```

reasoning_output_tokensはoutput_tokensの内数なので加算し直さない。raw eventと正規化済みusageを両方足すことも避ける。既存の集計はcached inputを落としていたが、生のCLIレシートには残っていたため、原本を変更せず再抽出した。

今回の対象は994call、入力19,267,602token（1turnの最大は63,122）、そのうちキャッシュ読取13,408,384token、出力245,248token（reasoning70,250を含む）。全件で5つのusage欄を確認した。要求モデルは953callがLuna、41callがAstra。CLIが応答中のモデル名を明示した証拠は全件nullなので、要求モデルに基づく見積である。

## 通常条件の比較

各方式2runの平均。元比較の固定token上限は変えていない。

| 方式 | 秒 | 入出力token | キャッシュ反映API USD相当 | Codex credits相当 |
|:---|---:|---:|---:|---:|
| 単体Astra | 47.17 | 23,832 | 0.291320 | 7.283000 |
| Manager-local（初期版） | 58.10 | 260,548 | 0.706558 | 17.663954 |
| Sheep-fixed | 32.36 | 192,651.5 | 0.021611 | 0.540282 |
| Sheep-full | 33.54 | 192,733 | 0.018427 | 0.460673 |
| Manager-local（修正後の追加試行） | 61.44 | 262,379 | 0.568309 | 14.207718 |

Sheepが低価格のLunaだけで通常修正を完了したことが大きい。単体Astraにはキャッシュ読取がなく、Sheepには読取があったため、この比率にはキャッシュ状態の差も含まれる。全入力を通常入力料金とする感度分析でも、Sheepは約$0.041、単体は$0.291。単価差による効果は残るが、過去runのcache状態を実験的に揃えたことにはならない。

Sheep-fullとfixedのわずかな費用差はキャッシュ率も異なるので、依存発見が費用を減らした証拠にしない。Manager修正後は独立した追加試行として残す。

## 誤指示条件

| 方式 | 成功 | API USD相当 | Codex credits相当 |
|:---|:---:|---:|---:|
| 単体Astra | pass | 1.014360 | 25.359000 |
| Manager-local（初期版） | 未完了 | 1.540047 | 38.501164 |
| Sheep-fixed | pass | 0.260571 | 6.514278 |
| Sheep-full | pass | 0.264285 | 6.607125 |
| Manager-local（修正後の追加試行） | 未完了 | 1.178626 | 29.465640 |

Sheepも上位が1回入ると通常条件より費用が増える。仕様編集が誤りを訂正できたかと、単に編集したかを分けて評価する。失敗runも費用に含める。

## 実験全体の台帳

予備・中断再開・追加比較を含む保存済み8familyの合計は **$11.102785相当 / 277.569634credits相当**。内訳はLuna953callが$1.539929、Astra41callが$9.562856で、Astraが約86.1%を占めた。これはM2〜M5の実験CLIレシートの範囲。開発Agent、今回の調査、初期adapter疎通、月額料金、人間のfixture設計、tool料金や税は含めていない。

より上位のモデルを少ない回数に保つことは、今回の単価では大きな費用要因になる。一方、上位を減らして成功率が落ちる可能性もあるため、次の実験は成功率を維持した上で比較する。

## 次の比較で揃える条件

次の課題研究は[課題設定の設計案](../task-design.md)にまとめる。固定token予算に加えて、公開価格を固定したcredits予算を主軸に置く。実際の受付制御は現在もmax-tokensであり、この見積器を追加しただけでruntimeがクレジット上限を強制するわけではない。

同じLuna単体、同じCの局所worker群、個体記憶なし、上位介入なしを比較し、安いモデルの利用、並列化、キャッシュ、群れの履歴それぞれの寄与を切り分ける。公開レートでの概算を足場にし、実請求の検証にはrun前後の使用量記録と、他taskの同時消費を区別できる記録が必要になる。
