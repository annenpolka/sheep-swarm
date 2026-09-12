# Lazy swarmの三対照を凍結して測る

このExecPlanは進捗・発見・採用判断を作業中も更新する。

## Purpose / Big Picture

旧packet-all、新しい継続型rootの子なし、同じrootのfork許可を比較し、小修正の追加負担と独立した複数変更での利益を分ける。実装成功を速度優位に読み替えない。18課題・各三方式・1反復の54条件を完走し、失敗・通信再試行も含む集計を残す。

## Progress

- [x] (2026-09-12 04:32:23Z) 18課題を生成し、旧hash不変、baseline失敗・reference成功・意味変異と実装必須箇所を検査する。
- [x] (2026-09-12 04:33:26Z) 実装・課題・条件・採用基準を凍結し、controllerと監査のgateを通す。
- [x] (2026-09-12 04:47:14Z) 同じGo DeepSeek Flash、thinking有効で全54条件を実行する。
- [x] (2026-09-12 04:48:04Z) 全receiptと候補を監査し、層別結果・限界・次の方針を文書へ反映する。

## Surprises & Discoveries

着手時のruntimeはe6e6e74。18/18課題のpreflightが成功した。243/243意味変異を検出し、うち145個は単一の未実装ファイルを残した候補、29個は公開検査を通る変異。型検査・617テスト・参照2件のgate後にモデル計測を開始した。dev-v1はモデル呼出し前の準備のみで、監査テストのダミーsecret衝突とfixture全体digestの追加後にdev-v2へ再凍結した。未実走のv1も上書きしていない。既存typescript 7は従来のcreateSourceFile APIを提供しないため、repoですでに使うnative AST APIでfixtureの関数本体を取り除く。sourceを評価せずにinterfaceとimportを保つ。

## Decision Log

- Decision: localは旧devの最初の6family（units/baseconv/window/stats/intervals/apportion）のv00をそのまま使う。
  Rationale: 公開IDとfamily順による選択に固定し、成功・失敗や非公開defect位置で選ばない。
  Date/Author: 2026-09-12 / Codex
- Decision: independentは上記familyの循環する3つのv00を別directoryにまとめ、全関数をstubにする。coupledは同familyの16targetのうちgraphが連結し最大depthのもの（同点はID順）をstubにする。
  Rationale: 既存の仕様とoracleを再利用しながら、実装が必要な複数箇所を持たせる。graphのみの純粋な効果ではなく、異なる作業構造の探索とする。
  Date/Author: 2026-09-12 / Codex
- Decision: 同じ層で六つの方式順を1回ずつ使う。課題間の同時実行はせず、親子共有C3・子上限2・上位0とする。
  Rationale: 方式順の偏りと他taskのprovider競合を減らす。1反復のため推定精度と一般化は限定する。
  Date/Author: 2026-09-12 / Codex
- Decision: 品質非低下を前提に、localのlazy/reference時間比中央値<=1.10、independent<=0.90、coupled<=1.10を双方のreferenceに対する次段階採用の必要条件とする。
  Rationale: 小修正への一律の負担を避け、独立作業では引継ぎを上回る利益を要求する。この小標本の通過だけで既定へ昇格させない。
  Date/Author: 2026-09-12 / Codex

## Outcomes & Retrospective

dev-v2の54条件を完走・監査した。packet-all/子なしroot 18/18、lazy 16/18成功。lazyは子なしroot比の成功組の時間比中央値1.31倍、総tokens 2.07倍。事前採用条件は未達でlazyをopt-inに留める。全67call・670,565tokens、通信再試行・使用量不明0。runtime/promptを途中変更せず、hidden失敗を引き直していない。2失敗は終了後の差し替え診断で親の意味上の誤りへ切り分けた。集計は別Python計算とも一致し、型検査・617テスト・参照2件を確認した。[結果と次の範囲](results/lazy-benchmark-findings.md)。

## Context and Orientation

作業rootは /Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm。src/repo-lazy-run.tsは直接実装・fork/join、src/repo-packet-run.tsは強い旧基準。experiments/synthetic-corpusは凍結されたdev/evaluation課題を提供する。新しいexperiments/lazy-benchmark.tsはdevだけから18課題と方式順を作る。stubは実装本体を返却値undefinedへ置換した構文上有効な未実装関数。基準解と意味変異は親側の検査専用で、workerへ渡さない。

## Plan of Work

native ASTで既存生成物の関数本体だけを取り除き、仕様・固定チェック・必要な依存を保持する。independentでは別directoryの三課題を組み合わせ、対応するコマンドpathだけを変える。元のtarget引数と同一directory内importは保持する。各stubを単独で残したreference候補が最終oracleで落ちることも確認する。

controllerはprepare/run/report/auditを備える。prepareで選択条件、公開・private hash、完全なruntimeのcopy、call/token制約、method順を固定する。runは逐次実行し、request/receipt・artifact・独立受入・rowを保存する。中断の不明attemptを勝手に完了へしない。通信障害のみ元のbaselineから最大3回再試行し、前attemptのcall・既知下限・不明予約額・経過時間を引き継ぐ。

最後に小修正・独立複数実装・連結実装を別々に集計する。品質と両方式成功の時間比を主指標に、fork要求/実子数/却下tool/重なり/待ち/破棄tokensを示す。局所課題のforkしなかった例だけを抜いて都合よく比較しない。

## Concrete Steps

作業rootで npm run check と git diff --check を実行する。続いて node scripts/lazy-benchmark.mjs prepare .sheep/lazy-benchmark/dev-v2、run、auditを順に使う。prepareは18課題のpreflightを保存し、runは54条件を実行、auditは全attemptを照合する。実API認証は環境へ明示的に渡し、認証情報を保存しない。

## Validation and Acceptance

全18課題でbaselineが構文正しくassertion失敗し、referenceが全公開・非公開検査に成功し、すべての選択mutantが非公開oracleでassertion失敗する。6localのhashが旧lockと一致する。三層各6課題、各方式18条件、全6順序の均衡、再試行時の予算引継ぎ、欠落receipt/不正model/不明usageの扱い、fixture/runtime drift拒否を検査する。

受入時間はrunner・実行検査・再試行・backoff込み、独立監査・準備・人間の中断を除く。失敗completionはnull、task締切はなし。54条件のうち通信回復不能は未評価とし、採用判断は未評価を含む場合保留する。成功率の非低下は件数だけでなくreferenceのみ成功の個別課題も示す。両方式成功のpaired比に加えて全失敗の費用を記録する。

## Idempotence and Recovery

同じprepare出力を上書きしない。新run前にprofile hash、保存したruntime、現在のruntimeとfixture bytesを照合する。既発行attemptは保存・監査し、state.pendingが残れば自動再実行しない。runner.lockで二重実行を防ぐ。通信障害以外の基盤不整合は停止し、元の証拠を残した新しい版で扱う。

## Artifacts and Notes

.sheep/lazy-benchmark/dev-v2へ実行証拠、docs/resultsへ監査済み集計と採用判断を保存する。evaluation、Manager、言語adapterの追加は今回行わない。derived課題間には同じfamily/componentの再利用があるため、18件を完全に独立した標本とは扱わない。

## Interfaces and Dependencies

buildLazyCases()はid/group/fixture、lazyOrder()は固定のid/group/method列、summarizeLazy()は全体と層別のpaired集計を返す。controllerは既存transport-retryの受付規則を再利用する。既存kernel、runtime、promptは変更しない。新たなpackage依存は追加しない。
