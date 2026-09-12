# 公開仕様の再確認、方式対照、並列・起動範囲の実測

## Purpose / Big Picture

公開エラーの修正だけで別の欠陥を見逃す問題を、仕様全体の再確認で改善できるか測る。次に単体DeepSeekとSheepを現在の設定で比較し、独立した作業枝で並列度と起動範囲の速度効果を測る。非公開oracleを修復へ戻さず、成功品質と失敗の経過時間を分離する。

## Progress

- [x] (2026-09-11 00:30:00Z) 基準cf6757fとcleanな作業ツリーを確認した。
- [x] (2026-09-11 00:40:00Z) 実Go swarmが集計関数を1call/5568tokensで生成。hostが非null指定と平均計算のoverflow回避を補い、固定テスト・型検査後に採用した。
- [x] (2026-09-11 00:40:00Z) focused/contract比較、3品質課題、2単体対照課題、16targetの並列課題を実装した。521テスト成功。
- [x] (2026-09-11 01:15:35Z) 全課題のpreflightとruntime hashを固定し、38runを完了。品質は両指示8/9成功、単体対照は両方式6/6成功、速度8runも全成功。
- [x] (2026-09-11 01:15:35Z) 179call/900813tokensの全receipt、候補、元source、独立受入を監査した。未知usageと上限到達は0。
- [x] (2026-09-11 01:15:35Z) 結果文書と現行方針を更新し、型検査・521テスト・参照2件を確認した。
- [x] (2026-09-11 01:15:35Z) 最終差分を確認し、今回の成果物だけをコミット対象として確定した。

## Surprises & Discoveries

前回の回復では整数変換は直ったが、15桁超の一律拒否は残った。新しい指示は公開された元仕様だけを材料とし、このhidden診断を文面へ写さない。前回の最大同時callは1なので並列性能を測れていない。

## Decision Log

- Decision: recovery.reviewはfocusedを既定にし、contractをopt-inで追加する。公開仕様全文の再確認を同じworker call内で行い、追加モデルや追加テスト情報は与えない。
  Rationale: 指示の違いだけを比較し、従来の基準挙動を維持する。
  Date/Author: 2026-09-11 / Codex
- Decision: 主モデルopencode-go/deepseek-flash、thinking enabled、upper0、出力64000/総1000000/予約100000 tokens、通信timeout600秒。taskの時間締切はなし。
  Rationale: 利用者が品質と実所要時間の計測を優先し、token上限の緩和を指定した。
  Date/Author: 2026-09-11 / Codex
- Decision: 品質は3課題×2指示×3反復の18run、単体対照は2課題×2方式×3反復の12run、速度は16target/8枝で2並列度×2起動方式×2反復の8run。合計38runの受付上限は38000000tokens。部品委譲は別枠300000tokens、最大4call。
  Rationale: 複数欠陥、健全な上流、分岐を含めて偏りを調べる。速度のCとactivationは別々に比較する。各条件のcall上限48、round上限64で全16targetの起動を可能にする。
  Date/Author: 2026-09-11 / Codex

## Outcomes & Retrospective

[全結果](results/contract-quality.md)と機械可読JSONを保存した。contractは品質を改善せず、7成功組中6組で遅かったためfocusedを維持する。thinking有効の新規2課題×3反復では両方式6/6成功、6組中5組でSheepが速かった。速度比較は全8run成功、全起動C1の99.23秒からC4の43.09秒、C4関連起動の9.99秒へ中央値が減った。各2〜3反復の合成課題であり一般的な優位は示さない。

上位介入は追加していない。分岐の失敗では、別workerが公開エラーの上流原因を診断しても、既に再検査を消費したproviderは修正されなかった。次は診断をhostで検証可能な公開反例・対象版へ変換する仮説を検証する。自己申告やhiddenの失敗内容で受付条件を緩めない。

実測終了後に明示review:nullの拒否を追加した。有効設定の挙動は不変。実測runtimeと差分0の初回監査を保持し、最終監査ではsrc/repo-manifest.tsの差分を明示した。部品生成込みの総量は180call/906381tokens。

## Context and Orientation

src/repo-discovery.tsが上流再検査の証拠を作る。src/repo-manifest.tsはtask v2を検査する。experiments/repository-single.tsは複数fileを1callで変更できる単体対照。scripts/quality-speed-fixture.mjsは独立・伝播課題の公開仕様と固定oracle、experiments/upstream-recovery-seed.jsonは前回の不具合snapshot。これらを変更せず、新しいfixtureとrunnerを追加する。

## Plan of Work

まず集計の純粋関数を実Go workerへ渡し、その間にhostでreview選択と課題を作る。品質課題は保存済み複数欠陥、健全な上流、分岐するconsumerを持つ上流欠陥。新規実装の単体対照は元の独立・伝播課題。速度課題は8本の独立した2段階の枝で、うち2枝に関係する設定変更を伝える。read policyと書込対象と全体oracleは固定し、C1/C4と全起動/関連起動だけを変える。実測前にbaseline/reference/mutantとhashを確認する。

## Concrete Steps

作業場所は /Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm。実Go委譲はrepo CLIを使い、N4/C2、thinking enabled、upper0、最大4call/300000tokensで候補を保存する。集計関数を固定テストと型検査後に採用する。新しいseries CLIは新規output directoryだけを許す。実行は順番に行い、異なる比較runを同時に走らせない。

## Validation and Acceptance

review省略時の従来挙動、無効値拒否、contractモードの公開仕様配信・権限維持・hidden隔離を検査する。fixtureは元候補不合格・独立参照解合格・変異不合格をモデル前に確認する。全callのmodel/thinking/usage、candidateとsourceのhash、独立final oracleを照合する。success時だけcompletionMsを設定し、失敗を平均完了時間へ入れない。npm run check、git diff --check、ExecPlan validatorを完了する。

## Idempotence and Recovery

過去結果を上書きしない。新規runを.sheep/contract-quality配下へ保存する。unknown usage、予約超過、検査基盤障害なら既発行callを回収後、新規受付を停止する。使用量不明をゼロにしない。既存許可による認証のメモリ内注入のみを使う。終了したモデルを採用のために再実行しない。

## Artifacts and Notes

基準cf6757f。前回の結果はdocs/results/upstream-recovery.md。本計画の全設定・実測・raw receiptsとruntime snapshotを新規に保存する。

## Interfaces and Dependencies

recovery.reviewはfocused|contract。追加の外部依存なし。summarizeTrialsはgroupごとに成功数、失敗数、成功時完了時間の中央値、全elapsed中央値、call数、既知tokensの下限とunknown件数を返す。モデルの自己申告を成功判定には使わない。
