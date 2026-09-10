# Repository runner — implementation and live verification

2026-09-10。base checkout `e14d5a8febcd418317caade7c00d60ce51b5e015`上の変更。利用者指定のruntime `opencode-go` / model `deepseek-flash`で実装swarmを動かし、任意Git worktreeの明示ファイルを扱う`repo` CLIを追加した。[使用手順](../repository-runner.md)、[機械可読のreceipt・source hash一覧](repository-runner-evidence.json)。

## 完了した範囲

- JSONで対象・依存・context・保護対象・固定host検査を宣言する。専用fixture factoryは不要。
- 現在のtracked bytesと明示したuntrackedをsnapshot化し、既存kernel/swarmを使ってファイル単位で生成する。
- 局所検査と最終検査、共有token予算、失敗証拠を保存する。使用量不明・予約超過・予算拒否を成功としない。
- 既定は候補だけ保存。`--apply`ではHEAD・tracked集合・bytes/mode・path種別・新規衝突を再確認し、全体受入に成功した対象だけ適用する。
- 既存swarmへ、却下案とそのread版を次のworkerに引き継ぐ仕組みを追加した。未採用案はaccepted checkoutへ混ぜない。

## 実モデルの作者と親の補修

親が先に[4モジュールの契約](../tasks/repository-adapter.md)、共有型、未実装stub、manifest/files/checks/runの固定受入テストを用意した。workerの戻り値を型検査と実tmp Git/Node検査へ通し、受入テストは緩めていない。境界レビューで追加したテストは元の期待値を置換せず追加した。

`runSwarm`にN4/C2、下位`deepseek-flash`、上位call上限0の実装課題を渡した。モジュール間に依存があるためこの実装課題の実API並列数は最大1。4体登録を4同時実行とは扱わない。

manifest・snapshot/files・checksの3モジュールはswarm内の固定受入を通過した。runner接続は生成案が受入を通らず、親がsource初期marker、検査overlayの対象限定、既存kernelへの接続を補修した。親はさらに、選択したuntracked target、UTF-8、symlink親、index drift、全ファイルstage、候補logとの名前衝突、境界テスト、CLI・docs・Go thinkingの明示指定を補修・追加した。全体を「swarmが無介入で完成した」とは報告しない。

## 失敗を含む実装履歴

| 保存先（`.sheep/`配下） | 実provider call | 観測tokens | 結果 |
|---|---:|---:|---|
| `repo-adapter-build` | 6 | 133,050 | 既定thinkingが16,000出力tokenを消費し、5件は完全なcodeを返せず。1件manifestを採用 |
| `repo-adapter-build-low` | 6 | 68,760 | thinking disabledを明示。manifestを修正採用、filesは型検査で棄却 |
| `repo-adapter-build-repair` | 3 | 72,936 | 却下案引継ぎ後にfilesを採用。後続3件の受付拒否はprovider未呼出し |
| `repo-adapter-build-final` | 6 | 197,849 | checksを採用、run接続は棄却。1call予約の超過を2件記録 |
| `repo-adapter-build-connect` | 3 | 63,793 | API契約を縮小して再提示したがrun接続が未完了。親が補修 |

実装の実provider callは24件、観測input+output計536,388tokens。使用量不明0、全予約精算済み。最初の30万枠、追加20万枠、接続10万枠は別stageとして記録し、失敗や予約超過を消していない。親の作業tokenはこのprovider集計に含まれない。通貨・Go subscription使用枠・料金へ換算していない。

DeepSeekの明示的なthinking切替は[公式API仕様](https://api-docs.deepseek.com/guides/thinking_mode/)に対応する。Goが同じparameterを受けることは今回の実API応答で確認した。`--go-thinking disabled`をrepo CLIのworkerへ明示指定する経路を追加し、省略時のprovider既定と既存CLIの動作は変えていない。

## 別リポジトリでの実CLI確認

各fixtureはsheep-swarm本体と別のGit repoを作り、そのcwdから絶対pathの`src/repo-cli.ts --repo … --task …`を実行した。認証は親が既存Go storeからメモリへ明示的に読み、子processの`OPENCODE_GO_API_KEY`へ渡した。CLI自身の自動importやkeyの保存は追加していない。

共通profile: `opencode-go/deepseek-flash`, thinking disabled, N4/C2, maxCalls6, upper0, rounds8, timeout120000 ms, output4000, token budget40000/reservation6000。

| 別repo | 成果物と検査 | 結果 | 実call / 最大同時 | tokens |
|---|---|---|---|---:|
| JavaScript | clamp/titleの2utility、固定Node assert | 候補保存成功。元の2対象は不変 | 下位2・上位0 / 2 | 1,811 |
| Python | squared_sum/slugの2utility、固定Python assert | `--apply`成功。適用後に元repoで再検査も成功 | 下位2・上位0 / 2 | 1,630 |

両方とも登録4体・実呼出し最大2、usage不明0、予算超過0。dirtyな`notes.txt`と無関係なuntrackedファイルのbytesを保存した。[実行ログ](../../.sheep/repository-live/execution.log)、[JavaScript結果](../../.sheep/repository-live/javascript-run/result.json)、[Python結果](../../.sheep/repository-live/python-run/result.json)。成功token計3,441は実装コストとは別である。

## 通常gateと未実証の範囲

`npm run check`: 429/429 tests、型検査、2 reference snapshot照合が成功。`git diff --check`とskill validatorも成功。APIは通常gateで呼ばず、上記の実走証拠と分ける。追加テストには並列予約拒否、contextにtargetが重なる場合の依存、明示依存の順序、最終検査の単回実行も含む。

検査は信頼するhost subprocessで、OS sandboxではない。snapshotは通常Git filesと明示範囲、最大10000files/128MiB、target/contextはUTF-8各2MiB。symlink/submodule/特殊file、削除/rename、parallel resume、未知依存探索、あらゆるbuild環境、大規模repoや費用優位は対応・検証済みとしない。

skillに新repo経路を追加し、構造検査と上記CLI実走を確認した。以前の5ラウンドのempirical記録は旧版の証拠として保持し、新版に対するblank-slateの連続clearとして流用しない。
