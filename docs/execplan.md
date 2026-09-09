# Lunaで実作業を観測できる羊型Swarmを実装する

このExecPlanは実装と実行証拠に合わせて更新する。未完了の段階をgoalの完了として扱わない。

## Purpose / Big Picture

共有APIの変更を下位モデルの群れが局所的に修正し、上位モデルが作業履歴から必要時に介入する実験を動かす。下位が上位に相談する手順は設けない。4体で動作確認した後、16体から8・16・32体へ規模を変え、品質、重複、訂正の波及、上位の負担を実際のコードと受入結果で確認する。

実動作の下位モデルは利用者指定の `gpt-5.6-luna` に固定する。上位は別設定の高能力モデルとし、モデル名・実行条件・使用量を記録する。費用優位や一般的な性能向上は結果が示す範囲だけを報告する。

## Progress

- [x] (2026-09-09 16:58:58Z) 公開済みMITのmainを確認し、goalと作業用worktreeを作成。
- [x] (2026-09-09 17:22:57Z) M1: kernelの53ケースと実コードfixture接続を検証。完了判定中の一時的な作業開始・終了と、内容不変の訂正を修正した。
- [x] (2026-09-09 17:22:57Z) M2: Luna4体の通常修正5呼出しと、誤指示からの上位1介入＋下位9呼出しが最終受入pass。
- [x] (2026-09-09 18:05:44Z) M3: 主比較15run＋別pilot。両仕事量条件・誤指示・C固定の対照で全体受入pass。adapter誤分類10callのusageを元レシートから復元。
- [x] (2026-09-09 18:05:44Z) M4: C=1のSQLite runner。固定oracleでSIGKILL11境界、実Lunaで確定後/介入後の中断再開を確認。
- [x] (2026-09-09 18:35:19Z) M5: 共通oracle/token上限で4方式12runと、Manager修正後の追加3runを完了。予備実行・未完了・実装不具合を分けて記録。
- [x] (2026-09-09 18:40:22Z) 最終状態と実測の限界をREADME・設計・報告へ反映。型検査、137テスト、原文2資料の照合が通過。

## Surprises & Discoveries

開始時点では型草案と独立したwrite skewの参照実験のみで、kernelは未実装。既存の3テストを、機能全体の検証とは扱わない。ローカルCodex CLIは0.153.4で、`exec --json --ephemeral --output-schema` が利用可能。

M3で、CLIの途中の接続error後に成功していた10callをadapterが誤分類していたと判明。元runを保持し、使用量195,774tokenを復元した。M5前の独立レビューでは必須import検査の欠落と単一上位の増分確定制限を修正し、予備比較を本比較から分けた。M4実走probeはnoop再検証を二重確定と誤認したため、proposal IDと保存済みprefixの保持で再監査した。

M5のManagerでは全体の観測を仕様の継続的な依存にしたため、妥当な下位候補をstaleとして拒否していた。観測snapshotの版検査を維持したまま依存を分離し、追加3runでstale拒否0を確認。誤指示1runは上位が丸め指示を維持し、残予算で未完了となった。最終検証ではcrashテスト用markerの書込み途中を親が読める競合を見つけ、全量書込み後のrenameで通知するように直した。

## Decision Log

- Decision: 実workerの下位モデルをgpt-5.6-lunaに固定する。
  Rationale: 2026-09-10の利用者の明示指示。利用不可の場合も別モデルに黙って置換しない。
  Date/Author: 2026-09-09 16:58:58Z / Codex
- Decision: 実コードfixtureとその外側の採点器を分け、局所patchの検証と最終全体検証を用意する。
  Rationale: 他のconsumerが未修正であることだけで、妥当な局所patchの確定が阻止されないようにする。最終合格条件は固定する。
  Date/Author: 2026-09-09 16:58:58Z / Codex
- Decision: checkoutで読んだ版をkernel側に保存し、workerの自己申告だけでread setを決めない。
  Rationale: 古い根拠を隠した提案と、検証候補のすり替えを拒否するため。
  Date/Author: 2026-09-09 16:58:58Z / Codex

## Outcomes & Retrospective

M1〜M5を限定した実験系で実装・検証・報告した。M3では32体まで収束する一方、Cを8へ固定するとNだけの増員効果は見えなかった。誤指示条件ではwave先頭のN件が失敗し、早い観測を比較する必要が見えた。M4の再開はC=1に限定する。M5の通常条件は全方式で成功し、Sheepが約32〜34秒、単体上位が約47秒だった。ただしSheepのtokenは単体の約8.1倍。Managerの誤指示条件は、観測依存の実装修正後も予算内で未完了だった。創発、金額での費用優位、一般repositoryでの有用性は未確認。

## Context and Orientation

正本リポジトリは `/Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm`。実装worktreeは `/Users/annenpolka/Documents/Codex/2026-09-09/users-annenpolka-inbox-md-agent-swarm/work/sheep-swarm-runtime`、branchは `codex/swarm-runtime`。既存のdocs/referencesの2原文資料は変更しない。

artifactは版付きのファイル内容、dependencyはconsumerがproviderを参照する関係、obligationは変更後に再確認すべき作業である。checkoutはworkerへ渡す内容とその版の記録。proposalは変更候補で、確定にはcheckoutの版、変更権限、検証した候補の一致を必要とする。leaseは有効期限と失効世代を持つ権限。作業予約は権限を与えない。

`src/protocol.ts` は初期の用語草案。`src/kernel.ts` で実行可能な状態遷移を定義し、`tests/kernel.test.ts` で具体的な反例を検証する。`experiments/write-skew.ts` は独立の参照モデルのまま保つ。

## Plan of Work

M1ではin-memory kernelを作る。変更eventと未処理作業を同じ状態更新で保持する。依存への通知は明示的な配送操作にし、重複と逆順の配送を検証する。観測された読取先を履歴へ残し、現在の依存が変わっても過去の証拠を使ったconsumerへ訂正を届ける。上位の介入も通常の版・権限検査を通す。

M2では `src/codex-worker.ts` から構造化された応答を取得する。子processは引数配列とstdinで起動し、タイムアウト、失敗、使用量を保存する。`src/fixture.ts` が生成するESMコードをLunaへ局所contextとして渡す。受入コードは変更対象へ含めず、固定した期待値で検証する。上位は失敗の反復や節目の履歴から起動する。

M3では人数Nと最大同時実行数Cを設定から変え、実際の稼働数と待ち時間を測る。同じ仕事量の比較と、仕事量を人数に合わせる比較を別に行う。試行ごとに独立した作業状態を作り、失敗を含む報告を残す。API制限が支配した場合は群れの性質と区別する。

M4では状態、変更履歴、未配送eventを一つのSQLite transactionへ保存する。再開時は処理途中の仕事を未処理へ戻し、古い実行権限を失効させる。M5では同じ受入条件と総予算上限で対照方式を実行し、調整に使わなかったtaskの結果を示す。

## Concrete Steps

作業ディレクトリは上記worktree。現在実行できる確認は次の通り。

    npm ci --ignore-scripts --no-audit --no-fund --cache /private/tmp/sheep-swarm-npm-cache
    npm run check
    git diff --check

初期化時には3件の反例テストと原文2資料の照合が成功した。M1〜M5の完了時はkernel・実コード・budget・crash等を含む137件。最終確認でcrash試験のチェックポイント通知の競合を修正し、全件と型検査、原文2資料のハッシュ照合が通過した。2026-09-10の追加依頼では費用見積器の17件を加え、計154件・型検査・原文照合が通過した。追加するkernel・adapter・fixtureのテストも `npm run check` に含まれる。実験CLIは次の通り。これらは実モデルを呼ぶ。

    npm run swarm -- --workers 4 --concurrency 4 --size 4
    npm run swarm -- --workers 4 --concurrency 4 --size 4 --fault rounded-guidance
    npm run swarm -- --workers 16 --concurrency 16 --size 32

成功時はsuccess:true、lowerCalls、upperCalls、interventions、maxActiveWorkersと出力先を返す。失敗時は未処理義務や受入不合格を残しexit 1とする。

## Validation and Acceptance

M1ではwrite skew、stale read、検証中のbase変更、重複と逆順通知、後から追加した依存、ignored後に意味を持つ変更、古い根拠のconsumerへの訂正、失効lease、上位の古い観測、未解決claim、未配送eventが残る完了要求を検証する。拒否した提案は共有状態を変えないことを確認する。

M2はLuna4体の実行記録、コード差分、実Nodeの受入結果、上位の観測から介入に至る記録を必要とする。要求したモデル名とproviderが返したモデルの証拠を区別する。下位の相談や上位の全件承認を経由しない。

M3は8・16・32体の反復結果と両方の仕事量条件が対象。登録数だけで並列動作を報告せず、N・C・実稼働・完了品質・上下の費用を分けて示す。M4は実process中断を伴う再開、M5は対照との同条件比較を必要とする。

## Idempotence and Recovery

原文資料と既存テストを変更しない。各実験の作業領域と出力先は一意に作り、途中結果を上書きしない。新しい実行を過去の成功として再利用しない。永続化前の中断は未完了として残す。M4以後の再開では保存した未処理義務と権限世代から再構成する。未知のモデル応答や受入不合格は証拠付きの失敗として扱う。

## Artifacts and Notes

2026-09-10の追加依頼で[費用概算](results/cost-findings.md)と[使い方](../pricing/README.md)、[課題設定の研究](task-design.md)を追加。モデルは再実行せず、保存済み994レシートを公式価格で再計算した。次の課題・同credit予算のruntime受付は設計案であり、M1〜M5の過去runと混ぜない。

結果は [規模比較](results/scaling-findings.md)、[実Lunaの再開](results/durable-restart.md)、[4方式比較](results/comparison-findings.md)、[Manager追加試行](results/manager-observation-fix.md) に保存する。実行時ソース4版は [凍結archive](results/frozen-runtime-sources.zip) に含め、結果と最終修正版を混同しない。

baseline commitは `4b09f0b`。原文snapshotのハッシュ照合と依存のインストールを確認済み。実験の生ログはgitignore対象の `.sheep/` またはタスクの `work/` に保存し、共有する結果は内容を確認してdocsへ要約する。ユーザー向け報告のコピーはタスクのoutputsへ置く。

## Interfaces and Dependencies

TypeScript、Node.js、既存Codex CLIを用い、M1〜M3に新しいruntime packageを必須化しない。kernelは内容のmap、版付きcheckout、権限、候補検証、確定、配送、完了のAPIを持つ。検証関数は候補snapshotを受け取り、booleanの合否とerrorsを返す。時刻は注入する。

Codex adapterは `callCodex({model, prompt, schema, cwd, timeoutMs, ...})` を公開し、JSON結果・使用量・実行記録を返す。fixtureは `createFixture({size, variant})` から固定された外側のoracleを取得する。runnerはJSONの内容変更提案だけをkernelへ渡し、workerに直接共有状態を確定させない。
