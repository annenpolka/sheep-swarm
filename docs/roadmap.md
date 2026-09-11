# 実装順序

2026-09-09の [現在の方針](current-direction.md) に基づく計画。小さなkernelから実workerへ進み、人数を変えた振る舞いを早く観測する。各段階の状態は実行証拠に合わせる。詳細な進捗は [ExecPlan](execplan.md)、M2の証拠は [4体pilot](results/luna-four-worker-pilot.md) を参照。

## Work packetの粒度比較 — 共通executor・通信再試行実装、dev比較は継続段階

[決定と検証順序](work-packet-direction.md)。最初に複数targetを原子的に提案・検証できる共通executorとCLI dry-runを実装する。独立fixtureでscope・read版・packet間通知・循環・usage不明停止を確認後、凍結devでall/8/4/2/1target packetを全起動・同じ公開context・C4で比較する。品質と両方成功した組の完了時間を主指標とし、N=1も採用候補にする。変更起点を公開したactivation比較は粒度を固定した別課題へ分ける。自動選択・evaluation・Managerは設定を選んだ後へ置く。

実装: [repo --packet-size](repository-packets.md)でall/1/複数targetを共通経路へ接続した。公開graphのSCC分割、複数writeの原子的commit、変更前baselineと現在依存版の分離、packet内通知の公開再検証、旧版/権限/usageの拒否を含む。単体・循環・並列・scope・失敗・CLIの13追加テストを含む568テストと参照2件が成功。実APIの小規模対照は[別記録](results/repository-packets.md)。dev 128件の粒度比較、適応器、activation比較は次の範囲。

[dev粒度比較の固定計画](packet-sweep-plan.md)を644実runとして開始したが、3完了・1中断で停止。[通知不整合と修正の記録](results/packet-sweep-host-fault.md)。[修正版の新系列](results/packet-sweep-rerun.md)では有効90runが全て成功したが、91run目のHTTP 500・usage不明で停止。全dev比較、粒度選択、evaluationは未完了。stub成功は性能結果に数えない。

利用者の継続指示により、[通信再試行controller](packet-sweep-retry-plan.md)を追加した。完了条件は失敗receipt・未知usageを保持した再実行と残条件の継続、全attemptの時間・call・受付枠の共有。全dev比較完了後に粒度を選択する。

以下の旧系列と完了記録は保持する。PR #9の停止系列の残りを埋めることは、次の最優先作業にはしない。

## 合成課題のSingle/Sheep比較 — 実装済み、dev実測は基盤障害で部分停止

[計画](execplan-synthetic-paired.md)。コーパスのhashを凍結し、dev 128課題を同じDeepSeek Flashで対応比較する。品質と両方式が成功した組の実所要時間をfamily・依存形状・target数・最長依存経路別に報告する。[途中実測](results/synthetic-paired-dev.md)は有効39組。Single 38/39・Sheep 37/39成功、両方成功37組中32組でSingleが速かった。80run目にHTTP 500で1callの使用量が不明となり新規受付を停止。未実行176run、evaluation、Managerは残る。devで設定を選んだ後にevaluation、次にManagerを比較する。

## 合成課題集 — 256課題の生成・全件検査済み

利用者指定のDevin（SWE-2 Max）で16系統・256課題を作成し、呼出し側で補修・検証した。[使い方](synthetic-corpus.md)、[証拠](results/synthetic-corpus.md)。完了条件は全件の元コード失敗・基準解成功・意味変異拒否、family単位のdev/evaluation分離、公開/非公開hash、既存repo runnerへの接続、CLIの再現性。[DeepSeek初回pilot](results/synthetic-corpus-deepseek.md)は16系統の4target課題を各1回実行し、14/16成功・中央値34.63秒。次は残りvariantと規模・方式の対照。課題数を独立した問題系統数と混同しない。

## DeepSeek Flashの品質・実所要時間比較 — 初期実走済み

利用者の2026-09-11指定により主比較をopencode-go/deepseek-flashへ移し、固定時間による採点は採用しない。単体は全targetを1callで修正できるbaselineを追加し、2family×3variant×2方式を実行した。初回の配列応答形式による却下を保全し、対象名固定schemaの別12runも同じoracleで測定した。[結果](results/deepseek-quality-speed.md)。後者は単体5/6、Sheep4/6成功。496テスト・型検査・原資料照合・全receipt監査が成功した。

次は、公開された下流エラーを使った上流前提の再検査・受理済みprovider再起動を固定反例で実装・比較する。現行の全target起動でも下流だけ5回修復する例があるため、初期起動数削減よりこの回復経路を先に検証する。Manager/上位介入、progressive activationの一般化、read widening、追加言語は別段階。過去Luna系列とPR #6の実測は書き換えない。

## MoonBit adapter — 限定対応と実走済み

利用者の追加指定により[MoonBit対応](moonbit-repositories.md)を実装。[計画](execplan-moonbit.md)の完了条件は、新旧manifestの純粋解析、public catalogの完全性検査、package依存と補助ファイルの配信、関連targetだけの起動、実compilerの固定oracle受入。Go実走は関連2target/2call/2,323tokens、通常gateは488テスト成功。[証拠](results/moonbit-repository.md)。各packageの書換対象1ファイル、module内通常sourceの範囲。外部依存・workspace・生成等は未対応として明示拒否する。

## M8: TS自己実装・N/C対照・static impact/activation — 実装・初期実走済み

「残りも順次進めて。swarmで」に従い、[計画](execplan-repository-scale-activation.md)のTS adapter、自己実装、8条件のN/C対照、変更からの対象起動を実装した。[結果](results/repository-scale-activation.md)。TS type-only依存の配信、Goの自己実装1call、固定16targetの7成功/1未完了、関連2targetだけの実起動、480テストと原資料照合を確認した。

完了条件: AST解析でsourceを実行しない、固定oracleの旧版/誤policy拒否、全条件の既知usageと失敗保持、source不変、起動しなかった対象を含む全体受入。最初の検査/予約修正分を別記し、N16/C4 localの読取上限による未完了を再試行して成功へ置換しない。

対応境界は拡張子付きTS ESMと公開allowlist内の静的/明示依存。一般的な意味依存の完全性、TSX/CTS/package解決、反復による因果推定、単独Luna/Manager-localとの有用性、総記憶量を揃えた比較は引き続き未実施。次の研究は、今回の読取上限失敗を固定反例へ分けた上で、課題familyと反復を増やすこと。完了済みpilotの閾値を遡って変更しない。

## M7: 段階読取の同品質pilot — 最初の範囲を実装・実走済み

PR #5のマージ後、添付議論を[精査](discussion-review-progressive-read.md)し、[ExecPlan](execplan-progressive-read.md)を作成した。task v2のmaxPathsPerRead、opaque資料とregistryだけを変えるworld、固定oracle、配信順監査、局所/広域の同一N4/C2実走を追加した。両条件が固定受入に成功し、局所6call/8,241tokens、広域2call/5,593tokens。小課題での追加読取負担を含め[結果](results/read-selection-pilot.md)へ残す。

この範囲の完了条件は、1path要求と静的closureの区別、名前と資料本文を固定したworldの不識別、旧版/誤policy/入力境界変異の拒否、call順とcheckoutの照合、同じ固定oracleの独立再検査、既知usageと元repo不変。

この段階で計画した後続（上のM8で初期実走済み）は、TypeScriptの静的adapterと小さなself-host、未調整taskでの局所/広域対照、N=8/16/32（C固定と総予算固定を別系列）、impact候補から必要targetだけを起動する仕組み。TS対応やN比較を今回の2target pilotで完了扱いにしない。言語別の解析結果は証拠種別を持たせ、modelのconfidenceをwrite authorityや確定条件に代用しない。

## M6: CLI整理と、一般repoでの依存発見 — A–D・初期gate実装済み

2026-09-10の添付議論と、利用者のCLI整理の追加依頼を[精査](discussion-review-20260910.md)した。[ExecPlan](execplan-repository-discovery.md)に従い、1–3と4の初期gateを実装した。[実装・実走記録](results/repository-discovery.md)。

1. **CLIの互換整理。** 共通入口、全commandのhelp、モデルを呼ばない設定表示、option名・call上限の意味・出力・終了コードを整理する。旧入口のdefaultとJSON、durableだけの再開、repoの明示applyを保持する。
2. **host検証の契約。** 候補・検査・環境の識別、局所/最終の出力境界、基盤障害・cleanupを明示し、既存repo検査を接続する。Docker一般repo接続はこの時点では未対応のまま。
3. **静的依存と追加読取。** opt-inのtask v2で、許可済みtargetと公開読取範囲の中から依存を発見する。要求と配信済みreadを分け、現版の根拠と未解決事項をkernelへ接続する。
4. **品質とN/Cの観測。** 反例試験、N=4のLuna疎通、N=16から8/16/32・C固定の対照へ進む。task分解と書込権限は人間が与えた条件として計上する。

初期gateは、465テスト・原資料2snapshot・Go DeepSeekの小規模実走と独立した候補再検査が成功した。Lunaによる新しい疎通、N=8/16/32系列、単独/Manager-localとの一般repo比較は後続段階に残す。

完了条件は、CLIの互換と事前拒否、固定oracleの品質、観測版に基づく依存登録、未解決・不明usage・検証障害での非成功、各個体へ実配信したcontextの計測。実装追加だけで一般repoの有用性や増員効果を完了としない。早期受付制御、全runner統合、並列durability、64体はこの最初の範囲から分ける。過去の実測・凍結series・未実行条件は保持する。

## M0: リポジトリ初期化 — 完了

- 調査資料と抽出資料を原文のまま保存し、ハッシュで照合する。
- README、開発方針、設計、検証方針、判断の既定値を用意する。
- TypeScriptの開発環境とprotocol用語の型草案を置く。
- write skewの独立した参照モデルを移植し、全6順序、危険な対照4件、安全な方式0件を再現する。

完了確認: `npm run check`、`npm run demo`。これはkernel、メタ管理、規模比較の実装完了を意味しない。

## M1: 小さなin-memory kernel — 完了（限定した実行API）

範囲: 固定出力workerと観測側の固定判断、注入する時刻とID、版付きartifact、根拠付きdependency、event／obligation／receipt、proposal検査、advisory claimとauthority epoch、blocking claim、完了判定、版と範囲を持つ介入の反映。

一つの変更が既知のconsumerへ波及するケースから始める。下位の通常手順に上位への相談を設けない。人数と実行並列度を設定値として扱い、型草案をそのままwire schemaへ固定せず、受入fixtureから状態遷移を決める。

完了条件: [検証方針](testing-policy.md) のin-memoryで必要なケースを決定論的scheduleで検査できる。未解決状態を保持し、介入後の古い提案・権限・完了証拠を再評価できる。意味的判断は観測側に明示し、kernelの機械処理へ隠さない。crash/restartの保証はM4で検証する。

## M2: 下位4体＋上位1体の実worker接続 — 完了（合成fixture）

範囲: 小さなfixture repo、下位モデル4体、上位モデル1体、差分と局所context、分離した作業領域、統合候補の受入テスト、既存coding agent adapter、観測と介入の記録。

完了条件: 下位が上位を呼ばずにAPI変更を必要なconsumerへ波及させる。上位が通常の作業履歴から反復失敗等を観測し、版付き作業条件の変更を通して介入する経路を実行できる。古い前提の拒否、未解決と失敗、実際の稼働数、上下の費用を観測できる。

4体は動作確認であり、増員時の仮説検証の完了とはしない。永続化前の中断runは未完了として扱い、再開の保証を報告しない。

## M3: 下位16体から8・16・32体の規模比較 — 完了（初期の合成task比較）

範囲: 数十個の意味のある変更箇所、局所依存と境界をまたぐ依存を持つfixture。上位1体、下位16体で最初の本実験を行い、8・16・32体を初期比較範囲とする。

同じ仕事で人数を変える比較と、人数に合わせて仕事量も増やす比較を行う。固定チームを作り込みすぎず、分業や担当の偏りも観測する。人数N、最大同時実行数C、実際の稼働数を別に記録する。

完了条件: 各規模で同じシナリオを複数回実行し、品質、分業、誤りと訂正の伝播、振動、復旧、上位の観測・介入負担を比較できる。モデルの組、上位の介入方針と予算上限を揃え、変更した条件を記録する。失敗や不利な結果も残す。

実行証拠: [規模比較](results/scaling-findings.md)。主比較15runと別の16体pilotを保存。回復済み通信の誤分類も除外せず記録し、生usageを復元した。

16体で設計を作り込みすぎる前に32体を試す。64体は結果と予算を踏まえた次の探索候補。人数は暫定値であり、成功の境目とは主張しない。

## M4: 永続化と再開 — 完了（C=1の専用runner）

範囲: SQLite等の最小store、短いtransaction、durable obligation、read-set検査、outbox、重複排除、介入の保存と再適用、crash/restart。

完了条件: 確定前後・受信前後・処理途中・介入適用前後のcrash後に、変更と通知の取りこぼし、二重確定、偽の成功がない。M1の性質を維持する。M2/M3で見つけた問題のうち永続化に関係するケースを含める。

実行証拠: [再開試験](results/durable-restart.md)。固定oracleでSIGKILL11境界、実Lunaで確定後・介入後の2条件を検証。並列M3 runnerの再開対応は対象外として明示する。

DB選定とschemaは、この段階でruntimeの要件とローカルの互換性を確認する。LLM実行中にDB transactionを保持しない。

## M5: 有用性の比較 — 完了（別の合成taskによる初期比較）

範囲: 上位モデル単体、同じ上下モデルの組を使うManager-local、Sheep-fixed、Sheep-full。Broadcastやshadow診断は必要な場合の追加対照。

完了条件: 調整に使っていないtaskで、外側の受入条件と総予算を揃えて品質・費用・復旧性を比較する。上位の観測・読み直し・介入、依存発見、retry、監査、準備時間を含める。運用メタ管理の介入を通常動作として計上し、実験外からの救済を別に記録する。

実行証拠: [4方式比較](results/comparison-findings.md)の12runと、[Manager修正後の追加試行](results/manager-observation-fix.md)3run。外側oracle、権限、token上限を共通化し、未完了と予備runの使用量も保存した。単体上位のtokenが最少で、Sheepの通常所要時間が短かった。Managerの初期実装不具合は修正したが、追加の誤指示試行も予算内で未完了だった。

この完了は初期比較の実行と報告を指す。金額換算は後述の再評価で追加した。fixture/既知graphの人間による準備費用、任意の意味依存、一般repository、完全な盲検評価を含む本格的な有用性評価は継続課題として残す。

## 費用の再評価と、次の課題研究 — 調査・見積器まで完了

2026-09-10の公式価格とCodex tokenレートを保存し、994callのキャッシュ読取まで含む[費用概算](results/cost-findings.md)を追加した。[事前見積と実レシートの集計](../pricing/README.md)はモデルを呼ばずに実行できる。

[課題設定の研究](task-design.md)と[条件案](../experiments/task-design-v2.json)の一部を、次の機構実験へ実装した。任意repoへのadapter、外部課題の採点器、総記憶量を揃えた比較は未実施として残す。

## 3課題とクレジット受付 — 実装・限定した実測を完了

`src/mechanism-fixture.ts` に静的・レジストリ経由の意味依存・3段階変更を追加し、基準解・独立した境界値と変異検査を固定した。`CreditBudget` は全役割・読取・再試行を精算する。個体記憶なし・上位なしを含む5方式を実装し、220検査と参照ハッシュを通した。

実測は[機構実験](results/mechanism-findings.md)。小規模のLuna群れ3課題と単独Lunaの3段階更新は成功。48モジュールの主試行はN8が成功した後、単独Lunaのtimeout・使用量不明で2/28条件にて停止した。利用者承認の追加100相当の系列でN16/32を各1回実行し、両方成功、追加23.729217相当だった。元の26条件は未実行のまま残す。

各NでC=8を固定した所要時間は約271/295/274秒。16/32体は上位が各1回介入し、その費用が約半分を占めた。人数だけの優位、介入の因果効果、一般的な意味依存発見は示していない。3段階のN比較、実モデルの記憶・上位なし対照、総記憶量を揃えた対照、timeout時の使用量保存は次の課題である。[実行ガイド](mechanism-experiment.md)と[実行計画](execplan-mechanism.md)に範囲を記録する。

## Docker Agent Sandbox導入 — 実機pilot完了

2026-09-10の利用者依頼により、Docker Agent v1.137.0＋sbx v0.42.1を導入した。`swarm --runtime docker-agent`は従来のkernelを維持してcallerを切り替える。mountless、新規VM/session、局所ファイルの明示投入、host側proxy認証、制限tool、timeout/取消後のVM削除とレシート保存を実装した。

完了条件: CLIのhash/版を照合、実host/SSH/network隔離、timeout後削除と状態非継承、Lunaの編集・可視テスト失敗→成功、別VMの固定oracleとkernel確定、登録4体・C=2の5 artifact全体受入を確認した。失敗・打切りrunも別に残す。[結果](results/docker-agent-sandbox.md)を参照。

継続実装: `swarm --worker-tools local`で局所編集・可視テストを接続。全差分のscope検査、別VMの受入実行とhostの固定採点、usage不明・検証基盤障害時の新規受付停止を実装した。通常gateにoracle互換・改変拒否・誤自己申告・停止条件を追加し、実VMのprobeを分けた。

継続範囲の完了証拠: [道具付きの実Luna N=4/C=2](results/docker-agent-tools-swarm.md)で5call・5artifact・全体受入成功。全件の可視テスト失敗→成功と、worker 5台・受入6台の削除を確認した。

追加の既知範囲: `compare`の単独Luna・Manager-local・Sheep-fixed/fullへ共通toolと独立VM受入を追加した。必須importと固定採点値を保持し、単独Astraの新規Docker実行を拒否する。比較系列の共通profileと使用量不明時の停止、Docker usageの費用見積、作成前の所有記録と復帰時のVM回収も実装した。[継続結果](results/docker-agent-comparison-recovery.md)

`mechanism`への接続も実装した。課金付きreadRequests、未読policyを含まない可視feedback、版付きread set、stageごとの独立VM採点を検査する。終了指示と配信済みreadの説明を修正し、実Lunaのsemantic 6 module・18callとstaged 3段階・28callが全工程に成功した。両runの全callで終了tool、完全usage、cleanupを確認した。既存swarm自身も診断用2モジュールを3callで実装・自己修正し、固定91ケースを通して本体をそのまま採用した。通常gateは281検査。[完了と採用の記録](results/docker-agent-completion.md)、[以前の停止理由](results/docker-agent-mechanism.md)を参照。

次の範囲: pool再利用と汚染検査、Node 24+のtemplate、Astra介入を含む実走、Docker条件での規模・対照実験。今回の復帰時回収は常駐watcherやrun再開ではない。一般repo・32 VM並列・費用優位・並列durabilityは本導入の完了条件に含まない。

## DeepSeek直接API — 実験用opt-in adapter完了

2026-09-10の利用者依頼により、DeepSeek APIへ直接接続する任意runtimeを追加した。実装は指定のOpenCodeモデルへ委譲し、実行時はNodeのfetchを使う。`src/deepseek-worker.ts`はbearer認証、JSON mode、`thinking`無効化、明示`max_tokens`、4MiB上限のbounded bodyで1回だけ呼び出し、`finish_reason: stop`・内容・schema適合を検査する。要求modelとproviderが返したmodel名は別に保存し、HTTP失敗・応答過大・timeout・取消は秘匿情報を伏せたtranscriptへ残す。

完了条件: `swarm --runtime deepseek`が`--worker-model`の生API idを要求し、provider prefix・Astraのmeta・不明meta runtimeをCLI/`runSwarm`の入力段階で拒否する。`--meta-runtime`未指定時のmetaはCodexとし、`--max-tokens-per-call`をDeepSeek呼出しへ渡す。使用量欠落・不整合は0と数えず、発行済み同時callの回収後に新規受付と上位介入を止め、runを失敗にする。すべて注入`fetch`またはloopbackのテストで確認し、実network・実keyを通常gateへ持ち込まない。

呼出し側で303テストを再検証し、実APIでも1 worker・size 2の全3成果物が3callで確定した。要求beta IDと応答名`deepseek-flash`は別々に保存した。[実行証拠と未確認範囲](results/deepseek-api.md)

## DeepSeek runtimeのrunner横断 — compare・durable・mechanism token予算

runtime選択とusage判定を`src/model-runtime.ts`へ集約し、`compare`と`durable`へ接続した。`compare`は`--runtime`/`--meta-runtime`/`--worker-model`/`--meta-model`/`--max-tokens-per-call`を受け、`single-worker`対照とrole単位の下位・上位call計数を行う。同じmodel idの下位・上位はroleで区別し、providerの応答aliasは証拠として保持しつつ`requestedModel`の不一致だけを拒否する。`durable`はruntime/model/maxTokensPerCallをsnapshotへ保存し、legacy format-1 snapshotは既定値へ正規化して再開し、不明usageはlockして完了扱いにせず、再開時の新規callとoverrideを拒否する。`scripts/compare-experiment.mjs`と`scripts/scale-experiment.mjs`は選択したprofileを転送・記録する。

mechanismのcredit予算seriesは[実行計画](execplan-mechanism.md)ごと凍結したまま、`--budget-mode tokens --max-tokens --reserve-tokens`でDeepSeek/混合upperをcreditと分離したtoken予算で実行できる。`src/token-budget.ts`はcache splitを知らなくてもinput+outputの観測下限で受付を制御し、不明usageは恒久的に新規受付をlockする。credit modeでのDeepSeekは有料callの前に拒否する。`scripts/mechanism-token-experiment.mjs`は条件を逐次実行し、残予算を子runへ転送して子のtoken/回数を合算し、unknown usage・receipt欠落・model不一致・子run失敗/interruptでfail closedになる。mechanismのcredit結果をtokenと比較可能とは主張しない。実network・実key・実課金は通常gateに含めない。

## 再検討する条件

- 下位が局所作業を完遂できない: 分割、context、道具、モデルの組を見直す。
- 上位がほぼ全件を読み直す、または代わりに作業する: 介入の範囲と負担を見直す。
- 増員しても作業が足りない: 課題の並列性と仕事量を調べる。
- providerやqueueの待ち時間が支配的になる: 実際の並列度を測り、群れの調整不全と分ける。
- 隠れた依存が受入テストでも分からない: 検証のscopeを拡大し、保証を限定する。

2026-09-10の追加方針: Astra単独は費用の目安を得たため、今後の試行から省く。単独対照はLuna、群れの必要時介入はAstraを継続する。新規の機構実験はpilot 4条件・main 25条件とし、過去の実行証跡は上記の件数で保持する。

2026-09-10追加の完了証拠: 各runnerの実API実行8条件が成功。token系列の3familyは37call・109,994tokens、全stageの固定oracleが成功した。永続runは完了後のresumeで追加callなし。既存単価を捏造せず、beta価格は不明のまま保持した。[横断実行と独立検証](results/deepseek-runners.md)

## OpenCode Go runtime

利用者の「luna swarmで実装を進めて」に従い、Lunaの作業エージェントでAPI adapter・runner接続・使用量集計を分担する。完了条件は3 API形式のschema検査、workerごとの安定session、durable再開互換、不明usageと429時の新規受付停止、既存runtimeの回帰検査。GoをCodex creditや直接DeepSeekの料金へ置換しない。[導入仕様](opencode-go.md)。上記条件を満たし、378テストとGo経由の実Luna 4条件・13callに成功した。[実装と検証記録](results/opencode-go.md)。

2026-09-10追加: Astra独立レビューの6指摘と再確認で見つかった停止判定の不足を、Go DeepSeek V4.1 Flashの同一sessionで修正した。Astraが既出指摘の解消を確認し、親の404テスト・型検査・参照照合が成功した。[修正と独立検証](results/astra-go-review.md)。

## ツール利用skill — 作成・実行評価済み

CLIの選択、runtimeと予算、保存証拠の確認、durable再開、trusted task adapterの準備を[skill](../skills/sheep-swarm/SKILL.md)にまとめた。新規Luna評価役で5ラウンドを回し、Codexの外側実行権限、再開による証拠変更、runtime別のusage判定を調整した。最後の2ラウンドと未使用のGoローカル拒否シナリオは全要件を満たした。実Lunaの成功runは全3成果物を受入検査で再確認し、停止runは証拠不変を確認した。数値収束用のtool/duration metadataは取得できないため、厳密な数値収束とはしない。[評価と失敗履歴](evaluations/sheep-swarm-skill/report.md)。この5ラウンドはrepo用CLI追加前の版に対する評価であり、以下の新しい利用経路の評価とは分ける。


## 任意Gitリポジトリの対象ファイル実行 — 実装・小規模実走済み

`repo --repo PATH --task TASK.json`を追加した。task manifest、現在の作業bytesのsnapshot、固定host検査、既存swarmへの接続と共有token予算、候補保存、成功時のdrift検査付き`--apply`を実装した。workerは指定されたtarget/contextだけを読み、検査はsnapshot全体に対して行う。symlink・特殊ファイル・submodule・秘密用予約pathを拒否/除外し、元のdirty変更と無関係なuntrackedを保つ。失敗案の本文とread版を次のworkerへ渡す補修も既存swarmへ追加した。

利用者指定の`opencode-go/deepseek-flash`で3モジュールを受入まで生成し、接続モジュールの生成案と境界条件は親が補修した。受入テストを弱めず、通常gateと実JavaScript/Python repoの候補保存・適用を確認した。[結果と作者の区分](results/repository-runner.md)。Go DeepSeekのthinkingはrepo CLIの明示指定だけに追加し、既存runtimeの既定値は維持する。

並列runのresume、任意の依存探索、ファイル削除/rename、悪意あるcodeのOS隔離、大規模repoの実用性と費用比較は未対応・未実証。新repo経路はskillへ反映したが、既存5ラウンドのempirical評価を新版のblank-slate評価として流用しない。

PR #4の独立レビューでは、実processと注入callerで4件の不具合を再現し、検査終了時のgroup回収・親Git探索の停止・検査基盤障害での受付停止・局所診断の引継ぎを修正した。元の実走証拠と429検査の記録は変更せず、[追加検証](results/repository-runner-astra-review.md)へ分離した。


2026-09-11の追加指示に従い、主モデルopencode-go/deepseek-flashのthinkingは今後有効にする。比較は単体とSheepを同じ設定に揃え、過去のdisabled系列とは分ける。上流再検査はtask v2のopt-inとして実装し、公開local checkの失敗と配信済み版だけを起動根拠にする。再検査はproviderごと1回・総数上限内で、試行予算をリセットしない。完了条件は反例の回復、健全な上流・非公開失敗・古い証拠・上限の検証、thinking有効の実走と使用量保存。[詳細](execplan-upstream-recovery.md)。

計測優先の追加指示により、今後の比較は1call出力64,000 tokens、1条件総1,000,000 tokens、予約100,000 tokensとする。通信timeoutは600秒に広げ、task全体の時間締切や固定時間採点は設けない。旧上限の実測は別条件として保持する。


## 公開仕様の再確認と品質・速度の反復 — 完了

[38条件のthinking有効実測](results/contract-quality.md)を完了した。指示だけを強めるcontractはfocusedと同じ8/9成功、40対35callで、両方成功した7組中6組で遅かった。既定はfocusedを保つ。新規2課題×3反復の単体/Sheepはともに6/6成功、同じ課題・反復の6組中5組でSheepが速かった。この小規模な方式対照を一般repoの優位へ拡張しない。

16targetの独立枝でC1/C4と全起動/関連4target起動を各2反復し、8/8成功。全起動の成功時間中央値99.23秒（C1）対43.09秒（C4）、関連起動C4は9.99秒。全体oracleとread policyを保ち、Cとactivationを別々に比較した。実最大同時callはC4全起動4、C4関連起動2で、登録N16と実稼働を分ける。38runの179call/900813tokensはreceiptと独立受入を監査済み。実Goによる集計部品生成は別の1call/5568tokens。通常gate521テストと参照2件を確認した。

次の品質課題は、workerが気付いた原因を、hostで再現できる公開反例・対象版と結び付けて担当上流へ渡す経路である。分岐の失敗では別workerが原因をnoteへ書けたが、既に再検査を消費した上流は直らなかった。noteを真実として採用せず、誤診・古い証拠・健全な上流で検証する。固定hidden oracleを修復へ戻さず、上限緩和や上位介入とは別条件にする。この経路、Manager比較、progressive activation、予算付きread wideningは未実装または未実測の次段階として保持する。


## 公開反例を検証して上流へ渡す — opt-in実装・実走済み

`recovery.publicProbes` と `diagnose` actionを追加した。workerはhostが先に作った公開probeのIDを選び、hostが配信済みのprovider版・readonly公開入力で反例を確認する。入力版・重複・scope・試行可能性・回数枠を照合し、kernelの回復artifactを通してだけ上流へ渡す。通常の自動再検査と追加再起動枠を分け、workerの試行・call・token予算をリセットしない。新規providerの作成も含む541テストと参照2件を確認した。[仕様](public-probes.md)。

[Go thinking有効の9run](results/public-probes.md)は従来・検証のみ・上流配信が各3/3成功。成功時間中央値43.61/65.36/62.97秒で改善は確認できず、既定にしない。probeは4回検査され、証拠付き再起動2回から最終受入まで成功した。公開probe本文は全条件で共通だが前回系列にはなかった情報なので、過去の成功率との差を機構の効果にしない。次は従来方式が誤りを繰り返し残す新規課題を先に固定し、必要時の利用・通常試行を消費する負担・課題準備時間を測る。モデルが任意に反例と期待値を生成して採用する機能は未対応。
