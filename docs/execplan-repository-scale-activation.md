# TypeScript self-host、規模対照、影響先起動を順に実装する

## Purpose / Big Picture

利用者の「残りも順次進めて。swarmで」に従い、前段の未完了項目を進める。TSの型依存を含む静的解析、自己のTS部品を作る実swarm、同じ仕事量のN/C対照、変更からの必要target起動を、固定品質を保って順に確認する。

## Progress

- [x] (2026-09-10 14:17:08Z) TS adapterと反例検査。
- [x] (2026-09-10 14:17:08Z) 指定Go swarmによる影響選択・規模fixtureの実装と独立検証。
- [x] (2026-09-10 14:17:08Z) v2によるTS自己実装の小規模実走。
- [x] (2026-09-10 14:17:08Z) 未調整seed/worldでN8/16/32、C固定の局所/広域比較。
- [x] (2026-09-10 14:17:08Z) opt-inの変更起点と必要target起動、見逃しを外側oracleで拒否する検査。
- [x] (2026-09-10 14:17:08Z) 全gate、実走証拠、現行文書の更新とcommit。

## Surprises & Discoveries

- Observation: 既存typescriptは7.0.2で、旧createSourceFile APIではなくnative APIと仮想filesystemを持つ。
  Evidence: node_modules/typescriptのpackage exportsと、仮想repoだけを使うAST取得の実行確認。

- Observation: 最初の広域試行は修復時の10k予約超過とJSON import不備で停止した。Node --checkは一部の有効なTS構文も却下した。
  Evidence: `.sheep/m8-build/n8-c4-broad`。同一oracleのまま局所module検査と20k予約へ揃え直し、最初の消費を集計に繰り越した。
- Observation: N16/C4 localは3度目のread要求で上限に達した。usageは完全で、全体oracleは失敗した。
  Evidence: `.sheep/m8-build/module-n16-c4-local`。この条件を再試行せず、残りの独立条件を実行した。
- Observation: self-hostの最終testコマンドは欠落したuntrackedテストを実行せず、1件で成功終了した。
  Evidence: snapshotへ必要ファイルを明示し、存在を検査してから固定3件を独立再実行した。rawを成功3件の記録へ書き換えていない。

## Decision Log

- Decision: TS解析は既存の固定compilerを仮想filesystem・別processで使用し、対象codeを実行しない。
  Rationale: 型だけのimportも扱い、正規表現の誤検出や未知のpackage解決を避ける。
  Date/Author: 2026-09-10 / Codex。
- Decision: N系列は16target/64文書、N8/16/32・C4、local/broadを同じ各最大300000token上限で各1回。C依存を調べる別N16/C8対照も同じ予算で各1回。最初の2試行257863tokensも含む総受付上限1600000tokens。未知usage・基盤障害・予約超過で後続停止。既知精算済みの意味的失敗は失敗品質として保持し、別の独立条件は継続する。
  Rationale: 登録数と同時稼働を分け、前段より作業を増やす。各1回の機構観測として扱い、一般的有用性や介入効果を断定しない。
  Date/Author: 2026-09-10 / Codex、利用者の継続指定を具体化。
- Decision: 今回の下位は継続指定のopencode-go/deepseek-flash、thinking disabled、上位0。既存Luna/Astra比較方針は変更しない。
  Rationale: 指定モデルの実swarmで続行し、N/Cと初期context以外を揃える。
  Date/Author: 2026-09-10 / 利用者の継続指定。

- Decision: 最初の停止を残し、TS局所検査をmodule importへ変更、各runの上限300k・受付予約20kへ統一した。総受付上限1.6Mは保持する。
  Rationale: 型構文の誤拒否を直し、JSON import不備を固定採点値を漏らさず修復できるようにする。初回分を含む既知量は1,150,544tokens。
  Date/Author: 2026-09-10 / Codex、停止原因の確認後。

## Outcomes & Retrospective

実装と実走を完了。TS自己実装は1call、規模対照8条件は7成功・1未完了、影響先起動は関連2targetのみの2callで成功した。480テスト・型検査・原資料2snapshotが成功。前段の472テスト・2target pilotは凍結したまま、新しい[証拠](results/repository-scale-activation.md)を別保存した。型解析の対応拡大とstatic impactは限定した実装で、意味依存の完全性や単独/Manager-localとの有用性比較は未実施。

## Context and Orientation

rootは /Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm。src/repo-dependencies.tsは.mjsだけを走査し、src/repo-discovery.tsが読取版と配信を持つ。src/repo-run.tsは全targetをgoal変更で起動する。今回、TS adapterを前者へ追加し、明示changedPathsから逆向きに辿ったtargetだけへ初期goal依存を付ける。書込対象はmanifestのまま、外側oracleは全体を検査する。

## Plan of Work

親がTS解析のhost接続と固定テストを用意する。Go swarmは純粋な影響選択と規模fixtureを実装する。その後v2のTS依存発見経由で実部品を実装し、self-hostの受入を確認する。未調整seed/worldの比較は固定manifestとoracleを先に保存し、局所/広域の順序をNごとに交互にする。影響先起動は最後にhost設定として追加し、静的・明示依存の範囲と意味依存の見逃しを分けて検査する。

## Concrete Steps

rootで node --test tests/remaining-*.test.ts、npm run check、git diff --check。Go実装はrepo CLI、N4/C2、各max12call/200000tokens。規模系列は新しい .sheep/m8-build/ 配下に条件ごとのprofile・receiptを保存する。

## Validation and Acceptance

TSのimport/type import/re-export、コメント/文字列、型import式、非公開参照、構文不正、循環を評価せず検査する。self-hostは生成したTS部品を固定oracleと親の型検査で再確認。規模比較は同じ品質・元repo不変・完全usage・N/C/実参加・全contextとtokensを記録する。activationは関連targetだけを呼び、無関係targetを編集しない。新規依存の確定前読取、古い版の再検査、隠れた依存による最終失敗を成功にしない。

## Idempotence and Recovery

出力は新directoryのみ。失敗や未知usageを消去・リセットしない。認証は既存keyを親processのメモリに明示設定し、出力しない。モデルの自己申告ではなく固定検査を採用する。

## Artifacts and Notes

新しいrawは .sheep/m8-build/、公開集計は docs/results/repository-scale-activation.md とJSON。前段のraw・結果は書き換えない。

## Interfaces and Dependencies

既存typescript 7.0.2、Node、既存kernelを使う。selectImpactedTargetsはhostのtargets/changedPaths/edges/uncertainConsumersからactiveTargets/unaffectedTargetsを返す純関数。activationはtask v2の明示opt-in。推測confidenceをleaseやcommitの権限にしない。
