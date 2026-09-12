# 公開された下流失敗から上流を再検査する

## Purpose / Big Picture

受理済みamountの整数変換が誤っていると、正しいinvoiceを何度生成しても公開検査が失敗する。依存する書込対象を有限回だけ再起動し、固定された受入条件を保って回復できるようにする。品質と実所要時間を測り、固定時間で採点しない。今回からOpenCode GoのDeepSeekはthinkingを有効にする。

## Progress

- [x] (2026-09-11 00:00:00Z) 既存の反例とkernelの閉じたinput epochを確認した。
- [x] (2026-09-11 00:20:00Z) thinkingの既定値と比較条件を更新し、payload・CLI・単体・repo経路を検証した。
- [x] (2026-09-11 00:20:00Z) 固定テストに対してdeepseek-flash swarmが上流選択関数を1call/3420tokensで生成。hostはnoUncheckedIndexedAccess用の非null指定2箇所を補い採用した。
- [x] (2026-09-11 00:20:00Z) 公開失敗の証拠、版付き作業条件、有限の再起動を接続し、512テストと参照snapshot検査に合格した。
- [x] (2026-09-11 00:23:00Z) 反例・隔離・回数上限を検証。緩和後4条件/12call/70324tokensを完了し、保存済み不具合は両条件失敗、新規実装は両条件成功と記録した。
- [x] (2026-09-11 00:23:00Z) 文書と512テスト・snapshot hash・差分検査・実測auditを完了。変更をこのブランチへコミットする。

## Surprises & Discoveries

従来の全target起動でも上流が一度受理されると下流だけを5回試行する。初期activationの拡大だけでは直らない。kernel.change/correctはinputを閉じた後には使えないため、既存のlease・prepare・validate・commitを通じてhost専用の作業条件を更新する。

## Decision Log

- Decision: 実測を優先し、今後の比較は1call出力64000tokens、1run総1000000tokens、予約100000tokensに緩和する。今回の4条件は計4000000tokensまで。通信timeoutは600000ms、task全体のdeadlineはなし。
  Rationale: 利用者の追加指示。thinking有効の8000出力上限では、最初の対照5callのうち2callがlength終了となった。旧試行を保持し、緩和後は4条件を同じ設定で新規実行する。
  Date/Author: 2026-09-11 / Codex

- Decision: thinkingをGo DeepSeekの既定として有効化する。明示disabledの過去系列は保持する。
  Rationale: 利用者の追加指示。単体とSheepの今後の条件を揃える。
  Date/Author: 2026-09-11 / Codex
- Decision: task v2のrecovery.maxUpstreamRechecksで明示的に有効化する。各providerはrun内1回まで、総数も上限まで。通常attempt/call/token上限をリセットしない。
  Rationale: 既存の基準挙動を維持し、健全なproviderを疑った場合にも循環再試行を防ぐ。
  Date/Author: 2026-09-11 / Codex
- Decision: 公開checkの通常終了による不合格だけを証拠にする。hidden final、基盤障害、古いcheckout、model claimでは起動しない。
  Rationale: 受入oracleの隔離と版の整合性を保つ。診断は疑いでありproviderの欠陥確定ではない。
  Date/Author: 2026-09-11 / Codex

## Outcomes & Retrospective

固定応答の反例は回復無効7call失敗、有効6call成功。実モデルの保存済み失敗snapshotでは上流再起動が公開エラーを修正したが、別の境界値の不具合が残ってfinalで失敗した。再起動の機構と全体品質を分けて報告する。

## Context and Orientation

src/repo-run.tsが公開local検査と非公開final検査を分ける。src/swarm.tsは局所候補を直列に検証・確定し、依存先がpendingのconsumerを待たせる。src/repo-discovery.tsが公開catalogと実際の配信版を追跡する。tests/quality-speed-upstream-failure.test.tsは前回のamount→cart→invoiceの反例。書込対象以外に権限を広げない。

## Plan of Work

純粋な上流選択を実Go workerに渡す間、host側で公開失敗だけを受け渡す型とhookを実装する。各対象にhost専用の証拠artifactを設け、依存方向を逆転させずにそのartifact更新で再検査を発火させる。証拠にはcall、context、read版、公開command、診断を含める。最終oracleはhookを呼ばない。

## Concrete Steps

作業場所は /Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm。固定したtests/repo-recovery-selection.test.tsを先に作り、repo CLIで新しい候補出力を作る。N4/C2、opencode-go/deepseek-flash、thinking enabled、upper0、最大4call/80000tokensで選択関数を委譲する。候補を固定検査と差分確認後に採用する。統合後はnode --testで対象検査、npm run check、git diff --checkを実行する。

## Validation and Acceptance

既存の回復無効反例が同じ7callで失敗する。有効時は公開失敗を上流へ渡して正しい候補を受理できる。健全な上流、回復不能、古い証拠、hidden失敗、未配信/対象外の依存でも上限・隔離を維持する。モデル呼出しではthinking enabledを送ることを送信payloadで検証する。実走は事前固定した課題・oracleを使い、unknown usageまたは予約超過で新規受付を停止する。

## Idempotence and Recovery

全runは新規の.sheep/upstream-recovery配下へ保存し、過去系列を上書きしない。実行済み候補の採用にモデルを再呼出ししない。認証は既存の許可されたメモリ内注入のみ。失敗や不明使用量を保持する。

## Artifacts and Notes

実測結果はdocs/results/upstream-recovery.md/json。今回18call/108570tokensで全usage既知。緩和後4runではlength終了0、最大出力17943tokens。新規実装はon32.19秒/off38.56秒だが回復未起動であり速度効果とは断定しない。

初回実測のエラーreceiptはrequestedModelがtranscript内にあるのに、集計が外側だけを要求して誤停止した。全5call/34826tokensが既知であることを別auditで確認した。上限緩和の追加指示後は、旧試行を保持して新たな4条件を計測する。

基準commitは922a683。過去のthinking disabled結果はdocs/results/deepseek-quality-speed.mdと.sheep/quality-speed-build配下に保存済み。

## Interfaces and Dependencies

追加する純粋関数selectUpstreamRechecksはtarget、targets、edges、delivered、eligible、rechecked、limitを受け、依存先から順に有限の対象一覧を返す。hostは実配信のread stampが現在と一致することを確認してから使う。新しい外部依存は追加しない。
