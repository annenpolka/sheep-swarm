# 検証できる公開反例を上流へ渡す

## Purpose / Big Picture

下流workerが上流の原因に気付いてもnoteだけでは修正へ届かない。task作成者が先に用意した公開probe（反例を検査するコマンド）をworkerがIDで選び、hostが配信済みの版で再現してから上流へ渡せるようにする。非公開採点は修復に使わない。

## Progress

- [x] (2026-09-11 01:30:06Z) cleanな38cfc1aと前回失敗を確認した。
- [x] (2026-09-11 01:30:46Z) 受付判定を実Go swarmが1call/10398tokensで実装し、固定テスト後に本体をそのまま採用した。
- [x] (2026-09-11 01:30:46Z) 公開probe宣言・配信版照合・限定workspace・kernel経由の証拠配信を実装した。
- [x] (2026-09-11 01:36:49Z) 型検査・538テスト・参照2件に成功。通常再検査後の追加回復、誤診、古い版、重複、予算、検査障害を確認した。
- [x] (2026-09-11 01:53:15Z) 9条件全成功、58call/366006tokensを独立監査。probe実行4回、証拠付き再起動2回を確認した。
- [x] (2026-09-11 01:53:15Z) 実測終了後に新規providerの欠落entryを修正。元repo不変を含む541テスト・型検査・参照2件に成功した。
- [x] (2026-09-11 01:53:15Z) 結果・現行文書・全検査を完了し、今回の変更だけをコミット対象に確定した。

## Surprises & Discoveries

公開probeには反例確認の印が必要だった。通常の非ゼロexitだけでは、import失敗まで契約違反として上流に渡してしまう。印なしexit・異なるprobe ID・timeout・signal・workspace改変を停止条件として検査した。実モデル系列では同じ版に対する二つの要求を一度の検証にまとめ、修正後にprobeが通る観測も得られた。

前回の分岐失敗では別workerが整数桁補完の誤りをnoteに記録したが、既に一度再検査された上流は直らなかった。自己申告を強めるcontract指示は成功数を増やさなかった。

## Decision Log

- Decision: 初期版はhost作成の公開probe catalogとID選択に限定する。モデル生成の任意コード・期待値は実行しない。
  Rationale: 期待値の正当性までモデルの自己申告で決めず、既存の公開契約を機械的に再現する。
  Date/Author: 2026-09-11 / Codex
- Decision: probeは担当provider一つと明示されたreadonly公開ファイルだけで実行する。その他のtargetとhiddenファイルをmaterializeしない。依存がこのscopeを超えるprobeは拒否する。
  Rationale: 下流候補の誤りをproviderの誤りと混同しない。hostコマンドの信頼境界は既存と同じでOS sandboxを新設しない。
  Date/Author: 2026-09-11 / Codex
- Decision: 既存の自動再検査枠は維持し、probe要求数と証拠付き再起動数を別に有限化する。追加再起動後もworkerの試行数・call・tokensをリセットしない。
  Rationale: 同じ版の反例の重複と無制限の再起動を防ぎ、追加機構の費用を分離する。
  Date/Author: 2026-09-11 / Codex
- Decision: Go Flash、thinking enabled、upper0、出力64000/総1000000/予約100000 tokens、通信600秒、task全体の時間締切なし。実装部品は最大4call/300000tokens。実測は最大9run/9000000tokens。
  Rationale: 利用者の継続指定を守り、品質と実所要時間を計測する。
  Date/Author: 2026-09-11 / Codex

- Decision: 公開probeは契約違反を確認したときだけexit 1とstdoutのJSON {probeId,status:"counterexample"}を返す。印のない失敗は検査不能として停止する。
  Rationale: import失敗などをproviderの契約違反と取り違えない。期待値とテスト自体はhost作成の信頼する公開契約である。
  Date/Author: 2026-09-11 / Codex
- Decision: 実走は同じ分岐課題のbaseline、observe（同じprobe catalog、maxRechecks=0）、route（maxRechecks=2）を各3反復し、順番を循環する。公開probe本文は全条件のcontextへ含める。
  Rationale: 追加公開情報だけの効果と、検証・再起動経路の差を分ける。routeは追加再起動枠を持つことを明示し、同じcall数の比較とはしない。
  Date/Author: 2026-09-11 / Codex

- Decision: 実走中の追加検査で、新規providerが元snapshotのentriesに存在しない場合の例外を再現した。実測完走後にscopeのMapから欠落entryを除外する修正を行う。
  Rationale: 元から存在するproviderの比較を同じruntimeで完走させる。新規providerはoverlayでmaterializeし、元repoに存在しないまま保つ既存仕様に合わせる。
  Date/Author: 2026-09-11 / Codex

## Outcomes & Retrospective

[結果](results/public-probes.md)と機械可読JSONを保存した。全方式3/3成功、成功時間中央値は従来43.61秒・検証のみ65.36秒・上流配信62.97秒。上流配信が従来より速かったのは同じ反復の1/3組で、改善は確認できない。上流配信3run中2runで実際にprobeが再現した反例から上流が修正され、残る1runでは従来経路だけを使った。opt-inを維持する。

全9runのruntime・fixtureを固定したまま実行し、差分0の監査後に新規providerの欠落entryだけを補修した。最終runtime差分はsrc/repo-run.tsで明示し、元のruntimeと監査を保管する。Go生成の受付関数は本文を変えず採用し、接続と検査はhostが実装した。部品を含む実モデル総量は59call/376404tokens。新規課題での再現性と課題準備の負担が次の課題。任意の反例生成、一般的な意味依存発見、上位介入は本範囲外。

## Context and Orientation

作業場所は /Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm。
同ディレクトリのsrc/repo-discovery.tsが配信版・上流再検査を管理し、src/swarm.tsがモデルcallと確定処理を直列化する。src/repo-verifier.tsが候補の独立検査receiptを発行する。probeとは公開された固定の再現テストであり、workerのnoteは未検証の主張である。

## Plan of Work

src/repo-probe-admission.tsの受付判定を固定テスト付きで委譲し、hostが入力宣言と検査経路を接続する。workerはdiagnose actionでcatalog IDを一つ選ぶ。配信された版が現行であり、既知の上流・再試行可能・未重複であることをhostが検査する。公開入力だけのworkspaceで検査し、正常に失敗したときだけ版付きの回復artifactをkernel経由で更新する。誤診は不合格証拠を作らない。基盤障害は新規受付を停止する。

## Concrete Steps

作業場所でnode --test tests/repo-probe-admission.test.tsを先に固定する。repo CLIでN4/C2のGo workerを実行し、受理済みcandidateをレビュー後に採用する。npm run checkとgit diff --checkを行う。新規.sheep/public-probes配下に比較run・receipt・候補・独立検査・hashを保存する。

## Validation and Acceptance

通常経路の反例回復、健全上流の誤診拒否、古い版、未配信probe、無関係provider、同じ版での重複、上限、timeout・signal・workspace改変・基盤障害を検査する。hiddenの情報が配信されず、既存の書込権限と全体oracleが変わらないことを検査する。実走は成功のみcompletionMsを記録し、失敗elapsedと全usageを保持する。

## Idempotence and Recovery

既存runは上書きしない。unknown usage、予約超過、検査基盤障害なら新規有料受付を停止し、既発行callを精算する。認証は既存許可のメモリ内読取のみで、keyを保存・表示しない。

## Artifacts and Notes

基準38cfc1a。前回の38runは変更しない。今回の証拠は.sheep/public-probesに置く。

## Interfaces and Dependencies

recovery.publicProbesにmaxRequests、maxRechecks、catalogを宣言する。catalog項目はid/provider/description/paths/checkである。diagnoseは既存の全フィールドwire形式を保ちpathsにID一つ、他の未使用値は空。新規外部依存なし。
