# Repository runner — Astra independent review and fixes

2026-09-10。PR [#4](https://github.com/annenpolka/sheep-swarm/pull/4)を作者の対話履歴なしでレビューし、再現した4件を同じbranchの作業ツリーへ直接修正した。commit・push・GitHub投稿は親Agentが担当する。

- Review base: `e14d5a8febcd418317caade7c00d60ce51b5e015` (`main`)
- Initial PR head: `23bcda0119d4734baa4d953aaa3124920f4312a1` (`codex/repository-runner`)
- Scope: `repo-*.ts`、既存swarmへの差分、Go thinking指定、関連テスト、利用skillと現行文書。filesystem保全、固定受入、process終了、予算・呼出し停止を重点確認した。
- Method: 実tmp Git repositoryとNode subprocess、注入callerによる独立した反例。追加の実API・有料モデル呼出しは行っていない。

## 再現と修正

### P1: 正常終了した検査が子processを残す

検査commandが`stdio: 'ignore'`の子を起動し、`unref()`してexit 0すると、leaderの`close`時にtimeoutでないためprocess groupが終了されなかった。検査は成功を返す一方、保存した子PIDは1秒後も生存していた。検査後の副作用・資源残留や、後続検査への干渉につながる。

`repo-checks.ts`で、正常終了・非zero終了にも同じprocess groupへSIGKILLを送るようにした。timeout時のTERM→KILLは維持する。回帰テストは本物のbackground childを起動し、成功結果の後にそのPIDが消えることを確認する。テスト自身にも失敗時の回収を置いた。

### P1: 候補内のGit commandが親checkoutを検査する

候補をGit repository配下の`checks/`へ保存すると、`.git`を含まない候補で実行した`git rev-parse --show-toplevel`が元repositoryを返し、exit 0になった。`git diff --check`等も候補の内容を検証した証拠にならず、書込みを伴うGit commandは親checkoutを対象にし得る。

検査環境の`GIT_DIR`を候補自身の`.git`に固定し、親探索を防いだ。snapshotにGit metadataはないので、履歴を必要とするcommandは失敗する。通常pathと`checks:review`を使う回帰テストで両方を確認した。修正中に試した`GIT_CEILING_DIRECTORIES`はコロン入りPOSIX pathを表現できず同じ誤参照を再現したため、採用していない。host隔離や、明示的に別Git directoryを指定するcommandの禁止を意味しない。

### P2: 検査commandの起動失敗を意味的な修復へ回す

局所検査に存在しない実行ファイルを指定すると、正しい候補を返す注入callerでもworker/upper計7回を呼び出した。hostに検査器がないという事実から、新しいcode生成・guidance介入へ費用を使っていた。

`RepoVerification.executionFailure`を追加し、spawn失敗・候補保存先のfilesystem I/O障害・検査環境の準備失敗を分類した。custom taskの`executionFailure`も既存swarmの検査基盤停止経路へ接続し、発行済みcallを回収した後、新しいworker/upperを呼ばない。回帰ケースは実呼出し相当が1回、upper 0回、run失敗、applyなしで終わる。

追加のI/Oケースでは、最初のcallerから候補保存先を通常fileへ置換し、ENOTDIR等によるmaterialization失敗後に呼出しが増えないことを検査する。一方、NUL入りの不正overlayは通常の候補却下として残す。通常の検査非zero終了とtimeoutを一律に基盤障害へ変えていない。

### P2: 局所検査のstdout/stderrを修復workerへ渡さない

局所検査がstderrに固有の診断を出してexit 1しても、次のworkerにはcommand名とexit statusだけが届いた。却下案は保持されていても、具体的な失敗内容が失われていた。

失敗した局所検査のstderr/stdoutから最大8192文字を修復errorsへ追加する。各stream最大65536 bytesの保存logは維持し、最終検査は修復ループへ戻さない。回帰ケースでは最初のpromptに存在しない診断sentinelが2回目に現れ、却下案`value=41`も同時に渡り、`value=42`で固定受入に成功する。

## 検証

初期headに最初の4回帰テストだけを追加して`node --test tests/repo-review.test.ts`を実行し、4件すべての失敗を確認した。既存oracleや期待値は変更していない。

修正後の最終確認:

- `node --test tests/repo-review.test.ts`: 5/5成功。正常終了後の子process、親Git探索（コロン入りpathも含む）、spawn失敗後の受付停止、局所診断、I/O障害と不正overlayの区別。
- `npm run check`: 型検査、434/434 tests、reference snapshot 2件の照合が成功。skip・cancel・fail 0。Node.js `v26.0.0`、macOSで実行した。
- `node src/repo-cli.ts --help`: exit 0。新規provider呼出しなし。
- `git diff --check`: 成功。

実行手順・設計・README・roadmap・検証方針・skillのrepository referenceを現行動作へ更新した。[以前の429検査と実走報告](repository-runner.md)、`repository-runner-evidence.json`、skillの過去の評価資料は変更していない。新しい修正を過去の実API実走済み版として扱わない。

## 残る境界

上記4件は再現テストを通して修正した。これは全repositoryや全hostに対する包括的な承認ではない。追加の実API実行、Windows、別sessionへ離脱する子processの回収、大規模repo、悪意あるcodeの隔離、並行filesystem transaction、crash/resumeは今回確認していない。実APIの保存artifactの再採点と、commit後の親Agentによる最終検証は別の確認として扱う。


## 親Agentによる確認

Astraの修正差分を確認後、親も`npm run check`を独立に実行し、434/434 tests・型検査・reference snapshot 2件に成功した。以前の実Go生成artifactを修正後の検査器で再採点し、JavaScript/Pythonとも固定受入成功、元repoのHEAD・bytes・modeが不変であることを確認した。追加の生成callは0。skill validatorとインストール済み4ファイルのbytes/mode一致も確認した。[親の検証記録](repository-runner-astra-verification.json)。過去の実走レシートを書き換えず、この検証を別記録として追加した。
