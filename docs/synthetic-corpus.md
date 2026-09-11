# 合成repository課題

品質と完了までの実所要時間を、課題の系統・依存構造・対象数ごとに比較するための合成課題集。課題本体の作成はDevinのSWE-2 Maxへ委譲し、呼出し側でCLI、独立検査、仕様との照合を行う。既存の実験fixtureと実測資料は別系列として保持する。

16系統×16variantの256課題を生成する。variantには仕様パラメータ、依存構造、対象数、不具合箇所の違いを含む。256件を256個の独立した問題分布とは扱わない。一般repositoryやMoonBit等の言語横断性能を測る課題集でもなく、Nodeの`.mjs`で実行する制御された修正課題である。

## 利用

```sh
# 一覧。生成と検査にモデル呼出しは不要。
node scripts/synthetic-corpus.ts list
node scripts/synthetic-corpus.ts list --family units
node scripts/synthetic-corpus.ts list --split evaluation

# 新しいディレクトリへ元コードとtask.jsonを書き出す。
node scripts/synthetic-corpus.ts materialize syn-units-v00 .sheep/corpus-tasks/units-v00

# 全件、または指定課題を実行検査する。
node scripts/synthetic-corpus.ts preflight --all --concurrency 4 --output .sheep/corpus-preflight.json
node scripts/synthetic-corpus.ts preflight --id syn-units-v00 --output .sheep/units-preflight.json
```

`materialize`は既存ディレクトリを空であっても拒否する。書き出すのはbaselineファイルとmanifestだけで、reference・mutantの解答マップや不具合箇所のmetadataは含めない。最終採点用の`holdout.mjs`はhost実行のために存在し、manifestでは`protected`へ置く。workerに配信する`context`/`discovery.readable`から除外する。これは既存repo runnerの配信範囲の分離であり、Gitディレクトリ全体を別のAgentへ渡した場合の秘密性を保証するものではない。

既存のrepo runnerで使う前に、書き出した課題を独立したGit repositoryにする。

```sh
git -C .sheep/corpus-tasks/units-v00 init
git -C .sheep/corpus-tasks/units-v00 add .
git -C .sheep/corpus-tasks/units-v00 -c user.name=Fixture -c user.email=fixture@example.invalid commit -m 'Freeze synthetic task'
```

実モデルを使う実行と方式比較は別工程。[repository taskの使い方](repository-runner.md)と[現在の方針](current-direction.md)に従い、主モデルは`opencode-go/deepseek-flash`、thinking有効、緩いtoken受付上限を使う。固定時間内の成功を採点せず、成功時のcompletionと失敗時のelapsedを分ける。

## APIと採点

`experiments/synthetic-corpus/index.ts`は`listSyntheticTasks()`と`buildSyntheticTask(id)`を提供する。後者はbaselineの`files`、既存schemaへ適合する`task`、targetだけを置換する`reference`、referenceへ重ねる`mutants[].patch`、metadataとハッシュを返す。未知のIDは拒否する。呼出しごとに生成し、別の呼出しへ変更を持ち越さない。

公開仕様は必要な振る舞いを説明し、公開checkはその例を与える。最終oracleは公開条件と追加ケースを検査する。oracleの期待値は、基準解をimportして求めず、生成器側の別の仕様計算から作る。ただし同じ作者が書いた仕様計算と基準解には共通の誤りがあり得るため、基準解が通ることだけで仕様の正しさを証明したとは扱わない。別に選んだ境界入力とコードレビューを併用する。

preflightは一時ディレクトリでbaseline、reference、各mutantを実行する。全ての公開checkと全体oracleを使い、元コードは不合格、基準解は合格、各意味変異は不合格であることを求める。構文エラーや採点processの起動失敗を意味変異の検出として数えない。公開checkを通り抜けた変異数も別に報告する。`predictedPublicPass`は生成器の予測で、下流の公開checkまで実行した`result.publicPass`を測定値として使う。予測との不一致はoracleの合否や課題の品質点ではない。対象外の置換、非公開ファイルの公開scopeへの混入、checkによる既存ファイルの書換えも拒否する。

command単位のtimeoutは停止用であり、課題の品質点や成功までの制限時間ではない。preflight自身の所要時間も、LLMが課題を解く時間とは別である。

## 比較で固定するもの

先頭8系統を`dev`、後半8系統を`evaluation`へ割り当て、同じ系統のvariantを両方へ分けない。評価用の系統をsolverの指示調整に使わず、採点を固定してから方式を対照する。これはsolver調整用の分割であり、独立した外部ベンチマークの盲検性を主張するものではない。

公開入力・manifestのハッシュと、非公開oracle・基準解・変異のハッシュを分けて保存する。変更した課題は新しいハッシュの条件として扱う。対象数は4/8/16/32だが、各系統の依存構造とサイズの組合せは完全な直交計画ではない。metadataから実際の件数を確認し、比較する課題IDを先に固定する。`independent`は独立した枝を含む構成で、枝内部にも依存がある。

方式間で同じ課題ID・公開入力・write authority・採点条件を使い、系統ごとの成功率、両方が成功した同一課題での完了時間、N/C/実稼働、再試行・検証の呼出しを報告する。合成課題の作成・監査は準備作業として別計上する。作成者が知る不具合箇所を使ったactivationは、依存発見そのものの性能と区別する。

DeepSeek Flashの[初回16課題pilot](results/synthetic-corpus-deepseek.md)を実行した。各4target、N4/C2、thinking enabledで14/16成功、成功時の中央値34.63秒。残り240variantと規模・方式の対照は未実行。課題生成・preflightの成績と解答実測を分ける。

## 系統

| 分割 | 系統 | 課題数 |
| --- | --- | ---: |
| dev | units / baseconv / window / stats | 64 |
| dev | intervals / apportion / topk / dedup | 64 |
| evaluation | text-normalize / kvcodec / rle / paths | 64 |
| evaluation | inventory / workflow / permissions / ledger | 64 |

`permissions`は公開契約に沿った集合操作、`ledger`は整数ポイントの移転を扱う玩具課題で、実サービスの認可や金銭処理の適合性を評価するものではない。後半の文字列系は元入力に対する各nodeの変換結果を依存順に連結し、状態系はgateや逐次適用を使う。系統名だけから実サービス相当の難度を推定しない。

256/256課題で元コード失敗・基準解成功、784意味変異の拒否を確認した（公開checkを通過した変異は365）。[生成・補修・全件検査の記録](results/synthetic-corpus.md)。
