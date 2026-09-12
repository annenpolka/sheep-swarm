# Devinによる合成課題の生成と検査

2026-09-11。利用者の「devin-delegateに大量の合成課題を作らせて」に基づく。16系統×16variantの256課題を、モデル呼出しなしで再生成できるrepository fixtureとして追加した。[利用方法と比較上の制約](../synthetic-corpus.md)。ブランチは`codex/synthetic-task-corpus`、作業開始時のHEADは`d00c1c021d256db4145c8303ed52eea556a42e7d`。PR #7の上に積んだ変更で、マージ操作は行っていない。

## 委譲と採用範囲

Devin CLI 3000.10.21のACPで、要求モデル`swe-2-max`、返されたモデル名`SWE-2 Max`を照合した。既存ログインを使用し、shellは個々の許可済みコマンドに限定した。別モデルへの代替やDevin Cloudへの引継ぎはしていない。

| セッション | 作業 | 採用 |
| --- | --- | --- |
| `troubled-cheetah` | 共通生成器、数値・集合の8系統 | Devinの草稿を親が補修 |
| `imaginary-aftermath` | 文字列の4系統 | Devinの実装、親による仕様文の明確化と独立例の追加 |
| `bottled-magpie` | 状態の4系統 | 別の一時workspaceで生成、親が補修・検証して取り込み |

CLI、registry、独立した回帰テスト、通常文書と監査は呼出し側が作成した。後半2セッションは別々の4系統を並行して生成する独立した作業分担で、先頭8系統の修正用セッションを置き換えたものではない。修正依頼はそれぞれ元のsessionをresumeした。

最初のセッションはshell許可待ちに加え、同一tool IDの再送でrelayが2回停止した。停止時のログと生成ファイルを保存し、子processの終了を確認してから親が補修を引き取った。状態系の修正も正確なshellコマンドの許可待ちが繰り返されたため、親が生成物を保存して引き取った。relayの回収欄に権限エラーが残る呼出しはあるが、最終的に全11個の所有process groupが空であることを別途確認した。Devinの自己申告を受入の根拠にはしていない。

全呼出しのraw記録はignoredな`.sheep/synthetic-corpus-devin/`へ保存した。公開用の[呼出し記録](synthetic-corpus-provenance.json)はモデル、session、停止理由、報告されたusageを残す。compactionやsubturnのusageをsession全体の完全な使用量とみなさず、加算した総tokensや請求額は算出しない。costは不明のまま保持する。

## 生成後に修正した問題

最初の128課題の実行検査は43件だけが合格した（当時のgateには公開check通過予測の一致も含む）。課題の正解例が失敗するケース、誤実装をoracleが見逃すケース、公開check通過の予測が下流checkと一致しないケースを分けて調べた。

- `Case = [args, expected]`の配列の入れ子、fan-inの対象数、存在しない依存先、逆転するpart範囲を修正した。
- 小数点を省略できるunitsの公開仕様にparserを合わせ、仕様側の期待値計算を整数による計算へ分けた。上限の説明は整数単位に統一した。
- 空配列、上限、同順位、入れ子の区間、出力順、入力の変更を確認するケースを追加した。型が合うだけのDateや独自prototypeをplain objectとして扱う問題も修正した。
- 正解と同じ結果になる変異（配分総和の別計算、未使用変数の追加等）を、仕様上の違いが観測できる変異に置き換えた。参照先の挙動に隠れて差が出ない変異を成功扱いにしない。
- 最終oracleは追加ケースだけでなく全公開条件も再検査する。元コード・変異の構文エラー、timeout、検査起動失敗は意味変異の検出として数えない。
- 状態系は過剰な引数配列の入れ子を直し、構成上差が出ない変異を候補から外した。誤りを埋め込む対象も観測可能な候補から選ぶ。workflowの表はown propertyだけを参照し、ledgerの整数overflowと疎な入力配列を拒否する条件を明記・検査した。
- `predictedPublicPass`は作者側の予測に改名し、実行した全公開checkの結果を`result.publicPass`として保存する。予測との一致で課題の合否を決めない。

これらは解答モデルによる本比較を始める前の課題作成・監査である。既に採点したモデルの成績を改善するためにoracleを変更したものではない。

## 検証

- 全256課題のbaselineは構文が有効なまま最終oracleで不合格、referenceは公開checkと最終oracleで合格。
- 784個の選択済み意味変異を全て検出。そのうち365個は全公開checkを通過してから最終oracleで検出した。
- family単位でdev 128課題／evaluation 128課題を分離。全256件の公開入力hashが異なり、再生成時の内容・公開/非公開hashが一致した。
- 16系統の代表課題をfresh Git repositoryへ置き、既存の`captureRepository`・`RepositoryDiscovery`・`runRepoChecks`を通してbaseline/reference/変異を再検査。protected oracleの非配信と元repoの不変性も確認した。
- `npm run check`: 551テスト成功、失敗0、凍結reference snapshot 2件一致。既存source・設定を変更していない。
- 実CLIでevaluation 128件の一覧と`materialize syn-workflow-v00`の書出しを確認。書出し先は`.sheep/corpus-examples/syn-workflow-v00`。既存ディレクトリ拒否と解答非混入は独立したCLIテストで検査した。

[全256件のhash・合否・意味変異結果](synthetic-corpus-validation.json)。全件preflightはNode v26.0.0、同時検査8で174.21秒。通常gateやhost検査も並行したため、この時間を性能比較には使わない。再検査コマンドは次のとおり。

```sh
npm run check
node scripts/synthetic-corpus.ts preflight --all --concurrency 8 --output .sheep/corpus-preflight.json
git diff --check
```


この作業ではDeepSeekによる解答ベンチマークを実行していない。ここでの時間は課題の生成・検査時間であり、solverの品質や解答までの所要時間とは別である。256variantは16の同系統群を含み、独立した256種類の実務課題や一般repositoryへの有用性を示すものではない。
