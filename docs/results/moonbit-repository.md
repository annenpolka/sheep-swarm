# MoonBit repository supportの実装と実走

2026-09-10。指定の`opencode-go/deepseek-flash`（thinking disabled）を使用。parser実装と、パッケージ依存を持つMoonBit projectの修正を実行した。rawは`.sheep/moonbit-build/`、機械可読集計とhashは[JSON](moonbit-repository.json)。

| 試行 | N / C / 最大実稼働 | 実参加 | 下位 / 上位call | 観測tokens | 受入 |
| --- | --- | --- | --- | --- | --- |
| manifest parser生成 | 4 / 2 / 1 | 3 | 3 / 0 | 30,669 | 固定runtimeテスト合格、親で修正後採用 |
| MoonBit project修正 | 4 / 2 / 1 | 2 | 2 / 0 | 2,323 | compiler・固定テスト合格 |

計32,992 input+output tokens。全5callのusageはcomplete、未知usage・稼働中予約・予約超過は0。要求・effective model evidenceはdeepseek-flash。cache write量と通貨換算、親Codexによる設計・レビューの消費は不明。上位0はswarm内の呼出し数で、親の検証工数を含まない。

parserの最初の提案は却下、2回目はschema不一致、3回目に固定テストへ合格した。親の型検査で未使用引数、独立レビューでDSL depsの黙認・文字列escape・optionの型境界を検出した。生成物そのままの成功と区別し、rawを保持したうえで親がparserを補修した。

実projectはpolicy → a → bのpackage依存を持つ。aは同一packageのhelperを使い、bは受理済みaのversion 1を読む。無関係なunusedも書換候補には登録するが、activationで起動しない。新moon.pkgと旧moon.pkg.jsonを混在させた。テストは別の非公開oracle packageから境界値を検査する。

モデルを呼ぶ前に同じhost checkでbaseline失敗、正しい参照実装成功、下限処理を省いた誤実装失敗を確認した。実候補の最終受入後にも、新しい検査workspaceで`moon check --frozen --target js`と`moon test --frozen --target js`を独立再実行し、2テスト成功を確認した。元projectのGit statusは空、3つの元targetの内容は不変。a/helperの配信、bへのaの受理済みversion/hashも照合済み。

使用したcompilerは`moon 0.1.20260427 (48d7def 2026-04-27)`、Node v26.0.0。通常gateは488テスト、型検査、原資料2snapshotが成功。新8テストはparser・依存探索・公開範囲・activation/配信を検査する。注入callerによる通常テストを実モデル・compilerの実行回数へ混ぜていない。

これは限定したadapterと小規模動作確認であり、MoonBit全機能、複数targetを同一packageへ置くv2、外部module/workspace解決、生成/条件付き/FFI/literate sourceを保証しない。実走後の親レビューでliterate sourceの明示拒否も追加し、通常gateで検査した。新module DSLはparser/探索テストで確認し、実compiler fixtureのmodule設定は旧JSON形式を使った。[対応範囲と使い方](../moonbit-repositories.md)、[実行計画](../execplan-moonbit.md)。
