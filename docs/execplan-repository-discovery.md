# CLIを整理し、一般repoで根拠付きの追加読取を行う

このExecPlanは実装に合わせて更新する。`Progress`、`Surprises & Discoveries`、`Decision Log`、`Outcomes & Retrospective`を最新に保つ。状態は**A–DとEの初期gate実装済み、拡大比較は未実行**。2026-09-10の添付議論を精査し、利用者の「CLIインターフェースの整理も含める」という追加指示を反映した。

## Purpose / Big Picture


利用者が共通のCLIから対応範囲と解決後の設定を確認し、信頼するGit repoの限定taskを実行できるようにする。書込を許可したファイルと受入検査は利用者が指定し、下位workerは不足する読取依存を公開された範囲から発見する。必要な情報が見つからなければ未解決のまま終了し、その理由と不足証拠を残す。

最初の到達点は、`.mjs`の静的importと明示された公開ファイルへの追加読取を扱う経路である。完全なtask分解や任意言語の意味依存を自動発見するという主張はしない。登録個体数を増やしたときも、品質、読む範囲、誤りの広がり、上位負担を測れることを研究上の目的として維持する。

CLIでは、実装後に `npm run sheep -- repo --help` と `--dry-run`で対応runtime・予算単位・副作用・設定を確認できる。実行後は依存の根拠、要求と配信を分けた読取記録、未解決事項、固定検査の結果が保存される。現在の実装と実行証拠は[結果](results/repository-discovery.md)を参照。

## Progress


- [x] (2026-09-10 12:04:11Z) 添付・原資料・b8720eaの実装と実測を照合。費用、N/C、既存readRequests、repoの全target起動を区別した。
- [x] (2026-09-10 12:04:11Z) 現行gateを再実行。型検査、434テスト、原資料2snapshotが成功。5主CLIのhelpを実processで確認。
- [x] (2026-09-10 12:04:11Z) CLI整理を含む作業範囲と移行方針を決定。
- [x] (2026-09-10 12:56:58Z) M6-A: 共通CLI、help、設定の事前表示、既存入口の互換検査。
- [x] (2026-09-10 12:56:58Z) M6-B: repo検証のhost実装を候補・検査・環境の識別付き契約へ接続。
- [x] (2026-09-10 12:56:58Z) M6-C: opt-inのrepo task v2で静的依存候補と局所contextを構成。
- [x] (2026-09-10 12:56:58Z) M6-D: 追加読取と未解決状態をkernel・予算・完了判定へ接続。
- [x] (2026-09-10 12:56:58Z) M6-E初期gate: 決定論的反例・固定課題と変異・静的のみの注入対照・利用者指定Go DeepSeek疎通・独立再検証。
- [ ] M6-E拡大評価: 新しいLuna疎通とN/C系列、一般repoの有用性比較。今回のGo実装試行と区別して後続に残す。

## Surprises & Discoveries


Observation: 添付のtoken約8倍という数字から、費用面の不利を結論できない。保存済み通常条件のSheep-fixedは0.540282 credits相当、単体Astraは7.283000相当で、要求モデル・cache込みの事後換算では約1/13.5になる。Evidence: `docs/results/cost-findings.md`。新価格・実請求を確認した値ではない。

Observation: `mechanism`にはwrites/readRequests/noteと、実際に配信した版による依存登録がある。一方、`swarm`/`repo`はcontent/noteで、repoのcontextは全targetへ付与され、goalには全manifestが入る。Evidence: `src/mechanism-run.ts`、`src/swarm.ts`、`src/repo-run.ts`。

Observation: 静的importの追加は、現行repoの「全選択targetを起動」という挙動を自動的には変えない。さらにmanifestのdependsOnはtarget間の非循環関係に限定されている。Evidence: `src/repo-manifest.ts`、`makeTask`、`SwarmKernel.change`へのgoal投入。

Observation: 主CLIのhelpはrepoのみ成功。他4つは未知optionでexit 1。`--max-calls`もswarm/repo/durableでは下位、compare/mechanismでは全roleを数える。Evidence: 2026-09-10の5processの実行と、各runnerの受付コード。

Observation: provider共通のschemaはanyOf/const等を受け付けないため、全7fieldのwireとhostの厳密union検査を分けた。Goは汎用的な空fieldの説明だけではactionを混合した。完全JSON例と具体的エラーを追加すると、同じ固定oracleで自己修正・完走した。Evidence: `docs/results/repository-discovery.md`。

## Decision Log


- Decision: 実装・初期疎通は利用者指定のopencode-go/deepseek-flashで実施。Lunaと拡大評価は別の未実行段階として保持する。
  Rationale: 実行モデルを無断置換せず、実装検証と規模・有用性比較を混同しないため。
  Date/Author: 2026-09-10 / 利用者指定、Codexによる実行。

- Decision: dry-runのdurable設定は安定したDB/WALの一時コピーで読む。v2の追加bytesは共通contextを除いた累積再配信量とし、成功応答を得たcallだけ配信確認済みとする。
  Rationale: 元DBを更新せず、予約拒否や未応答を配信した証拠にせず、追加読取の増加を有界にするため。
  Date/Author: 2026-09-10 / 実装レビュー。

- Decision: CLI整理を最初の独立した変更にし、次にhost検証契約、依存発見、追加読取の順で進める。
  Rationale: 利用者の追加要望を早く具体化し、既存の意味を保つ変更と研究上の新機能を別々に検証する。
  Date/Author: 2026-09-10 / Codex、CLI整理の追加は利用者指定。

- Decision: 全runnerをTaskAdapter/RunStore/各Policyへ作り直す作業は今回の前提にしない。
  Rationale: 既存のSwarmTask、CodeFixture.verify、FixtureObserver、model-runtime、TokenBudgetを再利用できる。隔離とdurabilityの任意組合せは未保証。
  Date/Author: 2026-09-10 / Codexによる作業上の既定値。

- Decision: manifest v1と凍結実験を保持し、新しい読取規則はv2で明示選択する。
  Rationale: 今まで渡していたcontext、response schema、予算、最終検査の観測条件を黙って変更しない。
  Date/Author: 2026-09-10 / Codexによる作業上の既定値。

- Decision: 書込targetは人間が固定したまま、公開範囲の読取を発見する。発見しただけでは書込権限を増やさない。
  Rationale: 読取依存、作業分解、authorityを別に検証するため。未知consumerへの自動書込は初回の範囲に含めない。
  Date/Author: 2026-09-10 / Codexによる作業上の既定値。

- Decision: 初回は現行wave schedulerを保ち、早期受付制御とDocker一般repo接続を後続にする。
  Rationale: 発見・出力形式・並列受付の変更を同時に入れると効果を識別できない。信頼するhost検査の限定実験は今の境界で可能。
  Date/Author: 2026-09-10 / Codexによる作業上の既定値。

## Outcomes & Retrospective


共通CLI、host verifier、task v2、追加read/uncertainと根拠追跡を実装した。基準版434テストに対し通常gateは465テストと原資料2snapshotで成功。Go DeepSeekによる部品生成は7call（最初の4部品runは全体失敗）で、親が採用前に補修した。v2の実疎通は初回10call失敗後、action例を修正した新runが5callで全3targetを受入。保存した候補に対する独立固定検査も成功した。

実モデルはregistryとpolicyを同時に要求したため、二段の意味探索の実証とはしない。二段の要求/配信・旧版/旧evidenceEpoch・上位観測は注入callerで検証した。CLI互換、durable元DBの非更新、予算・scope・最終受入の境界は通常gateに含む。元失敗runと生成原文は保存し、作者区分とhashを[結果](results/repository-discovery.md)に残す。全22call・222,490観測tokens、料金と親の使用量は不明。拡大比較と一般repoでの費用優位は未検証。

## Context and Orientation


作業rootは `/Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm`。Node.js 24.12.0以上、TypeScriptのtype stripping、ESMと明示的な`.ts` importを使う。初回確認環境はNode v26.0.0。runtimeのnpm依存は未追加で、今回もCLI frameworkを導入しない。

`/Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm/src/kernel.ts` は唯一の共有状態の確定主体である。artifactは版付きファイル内容、read setは判断に使った版と根拠epochの組、leaseは対象と期限・epochを持つ書込権限、obligationは未処理の仕事、blocking claimは成功を妨げる未解決事項を表す。`prepare → validate → commit`と最後の`complete`を通す。新しい依存は`addDependency`へ実際に観測した版を渡し、過去の変更にも追いつく。

`/Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm/src/swarm.ts` はworker pool、局所context、wave実行、失敗記録、共有guidanceの上位修正を持つ。waveとは最大C件を発行して全件を待つ区切りで、Nは登録個体数、Cは最大同時実行数である。現行の静的fixture依存を読む箇所がcontext構築、準備順序、割当の複数にあるため、kernelへedgeを足すだけでは動的発見を接続できない。

`/Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm/src/repo-manifest.ts`、`src/repo-files.ts`、`src/repo-run.ts` はtask JSONの検査、Git作業bytesのsnapshot、swarmへの接続、成功後のapplyを担う。候補だけを保存するのが既定。`src/repo-checks.ts`は信頼するhost commandを新しい候補directoryで実行する。OS sandboxではない。

`/Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm/src/mechanism-run.ts` の追加読取は、要求と書込を別callにし、実際の配信後だけ依存を記録する先例である。`src/heldout-fixture.ts`の発見器は専用の正規表現走査なので、一般parserとして使わない。`src/docker-fixture-observer.ts`は専用fixtureの別VM検査で、任意build環境を用意するものではない。

主CLIは同rootの `src/cli.ts`、`src/repo-cli.ts`、`src/compare-cli.ts`、`src/durable-cli.ts`、`src/mechanism-cli.ts`。基準版では各ファイルが独自にparseして即実行していた。現在は共通設定解決とdispatchへの薄いwrapperである。`src/model-runtime.ts`には既に共通のrole別runtime解決がある。共通CLIからもこれを利用し、保存済みdurable設定へのoverride拒否も残す。

## Plan of Work


### M6-A: CLIの入口と設定を整理する


`src/sheep-cli.ts`を新入口とし、`npm run sheep -- <command>`を追加する。最初のcommandは`repo`、`swarm`、`compare`、`durable`、`mechanism`。`src/cli-options.ts`にoption定義・alias・値検査・help、`src/cli-profile.ts`にモデル/検査を起動しない設定解決、`src/cli-commands.ts`にrunnerへのdispatchを置く。既存5CLIは同じ関数を使う薄い互換入口へ変える。rootを引数なしで呼ぶとhelp、未知commandは実行前エラーにする。

`--help/-h`は全commandに設け、必須taskがなくてもhelpを表示する。helpからruntimeとmodelの既定値、N/C、利用できる予算、出力先、再開、適用の条件を確認できるようにする。`--dry-run`は入力manifestや保存profileを読むが、モデル、検査command、VM、apply、出力directory作成、SQLite作成・更新を行わない。内部の設定解決関数と実行時の解決を共通化し、実行では変化し得る入力を改めて確認する。

推奨option名は`--output`、`--max-meta-calls`に揃える。durableの`--directory`、compareの`--max-upper-calls`はaliasとして保持する。同じ意味のaliasを複数指定したら値が一致しても曖昧な入力として拒否する。旧`--max-calls`は元の意味を保持し、推奨表示ではswarm/repo/durableを`--max-worker-calls`、compare/mechanismを`--max-total-calls`とする。対応しない方の上限optionは拒否する。counterの意味を変えるrunner改造はこのmilestoneへ含めない。

runtime/modelの省略時挙動、既存CLIとAPIのdefault差、commandごとのbudget既定値を基準版から固定する。特にcompareの`maxUpperCalls`既定値を他commandの2へ揃える等の変更はしない。新入口は各既存CLIと同じ設定へ解決する。token系列、credit系列、総token受付のないswarm/durableをprofileで区別し、未対応の予算optionは拒否する。`--max-tokens-per-call`や`--timeout-ms`をrun全体の予算・時間上限とは表示しない。

新入口の出力は既定をJSONにし、`--format text`を選べるようにする。JSONはversion、command、status、success、outputDirectory、profile、usage、errorsと元reportへの参照を持つ。ログと診断はstderrへ送る。`status: planned`のdry-runはtask成功ではない。exitは0が正常な表示・dry-run・成功、1が実行不成功、2が入力不正とする。既存入口のJSONと0/1の終了規約は維持し、既存dispatcherを壊さない。

再開はdurableだけが`--resume`を受け、既存directoryを明示する。新規runが同じ出力先を勝手に再利用しない。repoの`--apply`は実行時の明示指定だけ有効で、dry-runでは予定を示すだけにする。repoのDocker拒否、API workerのtool制約、durableのC=1もcapabilityとして表示・検査する。

`scripts/scale-experiment.mjs`、`scripts/compare-experiment.mjs`、`scripts/mechanism-experiment.mjs`、sandbox/cost補助scriptはroot helpから用途と現行コマンドへ案内する。凍結seriesを新しい万能`run`へ変換しない。この段階では補助scriptの実行引数を維持し、次の依存実験用scriptだけ新profileを使う。`docs/cli.md`を新設し、README、利用手順、`skills/sheep-swarm/SKILL.md`の推奨例を更新する。skillの新しい実行評価をしていなければ既存評価を新版の実証にしない。

完了は、全commandのhelp/dry-runがモデルなしで動き、不正な組合せが副作用前に拒否され、旧CLIの代表profileとJSONが一致すること。確認は`tests/cli-contract.test.ts`の実process試験と注入runnerの引数検査で行う。

### M6-B: 検証結果を候補と環境へ結び付ける


`src/repo-verifier.ts`にhost所有の検証契約と`createHostRepoVerifier`を追加する。`runRepoChecks`の候補生成、environment、process group回収、出力上限、親Git探索防止、bytes/mode/path種別検査を使い、`makeTask`からこの接続口を呼ぶ。最終検査の重複実行を増やさない。

要求はsnapshotとoverlay、local/final、検査command、出力先を受ける。結果にはcandidateDigest、checksDigest、environmentId、status、cleanup、実行証拠を持たせる。digestは整列したpath、bytes、mode、固定command引数・timeoutから作り、曖昧な文字列連結を避ける。localのbounded診断だけを修復に戻し、finalの失敗はrun終端に保存する。

statusはpass、reject、infrastructure-errorを区別する。候補の不適合はreject、spawn・保存・検査環境・回収の障害はinfrastructure-error。結果の識別子が要求と一致しないときも採用せず新規callを止める。既に発行済みのcallは回収・精算する。hostのcleanup表記は所有process groupに限り、別sessionやWindowsのprocess treeまで完全回収したとは言わない。

`tests/repo-verifier.test.ts`で現行host動作との一致と、候補/検査/環境のすり替え、基盤障害、局所診断とfinal隔離を検証する。Docker backendはこの段階では未対応のままとし、hostからDockerへの暗黙fallbackも作らない。

### M6-C: 静的依存の候補と、配信するcontextを分ける


`src/repo-types.ts`と`src/repo-manifest.ts`にv2を追加する。v1のfiles/context/protected/checksと挙動は保つ。v2には`discovery`を追加し、modeを`static`または`static+reads`、readableを追加読取が許される明示path集合、maxReadCallsをtargetあたりの追加call上限、maxDeliveredBytesをtargetの追加配信量上限として固定する。初回の既定値は2callと65,536 bytes。超過時に黙って切り捨てず未解決とする。

`src/repo-dependencies.ts`で、snapshot内の許可済み`.mjs`を実行せずに構文解析し、相対静的importとre-exportをconsumer→providerの候補として返す。既存のNode子processと`vm.SourceTextModule.moduleRequests`方式を用い、link/evaluateは呼ばない。ファイル拡張子を明示した相対pathだけを解決する。コメント文字列をimportと数えない。Node builtinは環境依存として記録する。package、alias、TypeScript、動的import、反射的な読取、意味上の契約は被覆を保証しない。未解決specifierと対応外構文を記録し、走査した範囲外を「依存なし」とは扱わない。

走査はhost snapshotだけを対象とし、source repoの新しいbytesを途中で読まない。pathは既存の拒否規則・UTF-8検査・size制限を通す。readableにあるだけで本文を全workerへ渡さず、hostがindexを持つ。protectedの検査専用ファイルは明示的に公開contextへ指定したものを除き配信しない。走査したファイル数・bytes・時間と、workerへ渡した本文を別に計測する。

v2のgoal artifactは共通goalだけとし、全manifestはhostの固定契約として保存する。targetごとのinstructionsを別artifactにし、そのtargetだけへ届ける。既存contextは共通読取として尊重し、依存で必要な本文だけを追加する。target数を増やしただけで全targetのinstructionsが各workerへ複製されないことを検査する。

追加graphは影響関係として保持し、既存のdeclared dependsOnによる準備順序と分ける。静的な循環を上位呼出しの理由にしない。初回は相互更新を必要とする循環componentを`unsupported-cycle`として有限に停止・報告し、edge削除や直列化だけで意味正当性を主張しない。全選択targetの初回起動は保持する。未選択consumerの作業起動や新規権限発行はしない。

完了は`tests/repo-dependencies.test.ts`で、import/re-export、コメント偽装、未解決path、対象外・protected読取、循環、余分な無関係ファイルを含むケースを通すこと。v1の既存試験も通し、発見対象と読む本文が別に報告されること。

### M6-D: 追加読取と不確実性を処理する


`src/worker-proposal.ts`にv2専用の判別可能な出力を置く。writeは担当targetの完全な内容、readは追加pathの要求、uncertainは観測・不足情報・仮説を表し、一つのcallで一種類だけ返す。v1のcontent/noteとmechanismの既存schemaは変更しない。SwarmTaskにopt-inのworker protocolとcontext選択・依存追跡の接続口を追加し、通常fixtureは既存経路を使う。

`src/repo-discovery.ts`がhost所有のcatalog、要求、配信、根拠を管理する。readはallowlistを検査し、次の有料callで現時点のkernel内容をcheckoutして届ける。要求しただけでは読了にも永続依存にも数えない。配信されたproviderのversionとevidenceEpoch、call ID、本文hashをhostが記録し、`addDependency`へ渡す。providerがその間に変わっていれば新しいobligationへ追いつき、古いstampの提案を拒否する。

static走査のedgeには根拠source hashとspecifierを持たせる。モデルが依存を主張しただけの場合は候補として記録し、本文配信や機械的走査の証拠と区別する。実際の配信も意味的に必要だった証明ではなく、消費した前提を保守的に追跡する証拠とする。accepted内容に新しいimportがあれば次の作業前にindexを更新する。未読の必要providerを含むwriteは先に追加読取へ戻し、同じcallの要求を先取りして採用しない。過去edgeは自動的に時間切れで削除しない。

context、準備順序、WorkerPoolの近傍選択、変更通知が同じ現在graphを参照するよう、`swarm.ts`の静的fixture.dependencies参照をopt-inで接続する。kernelのread stamp・lease・candidate検査は迂回しない。workを新たに始める前に不足読取を処理し、受付回数・予算へ追加readも含める。

uncertainにはhostがtarget版、配信済みread stamps、call ID、source=`model-claim`を付ける。機械的な観測は別recordにする。未解決はblocking claimとして保持し、TTL、同文の多数決、別targetの完了で消さない。解消は必要なreadが揃った現版候補の検証・確定証拠を伴う経路だけとし、LLMの「解決した」というnoteでは解除しない。各targetの既存attempt上限と新read上限で打ち切り、独立したtargetは続行可能にする。

read要求は上位宛ての相談ではない。上位は通常の失敗履歴と未解決状態を観測し、現在どおり共有guidanceだけを変更できる。新schemaを上位へそのまま渡してwrite/readable/protected権限を広げない。final採点を上位の観測材料にも使わない。

完了は`tests/repo-discovery.test.ts`の注入callerと実tmp Git repoで、登録→公開資料要求→配信→現版での修復→固定検査→kernel完了を実行できること。readだけを繰り返すworker、虚偽の読取、失効版、unknown usage、最終検査失敗では成功・applyにならないこと。

### M6-E: 成功品質と増員時の振る舞いを測る


まずLLMなしの固定出力で「明示graph」「静的走査」「静的走査＋追加read」を同じtaskに適用する。taskには静的importだけで解けるもの、公開registryから別資料を読むもの、許可範囲外または観測不能の依存が残るものを含める。期待graphと受入結果はテスト側で独立に固定し、production発見器から正解を生成しない。旧実装と変異が失敗し、基準解が成功することを先に確認する。

実動作の疎通はCodexのgpt-5.6-luna、N=4/C=2、上位0callで、信頼する一時Git repoを使う。新CLI例の上限を適用し、出力receipt、固定検査、source不変、read stamps、usageの完全性を親が確認する。これは一般repo adapterの動作確認で、実プロジェクトの有用性ではない。

研究用の次の単位はN=16/C=8。独立したtask選定時にrevision、oracle、公開/最終検査、target、readable範囲、条件順、総予算を固定する。静的依存と公開資料探索の2taskを各2反復し、「明示graph」と「static+reads」をpairedで比較する8runを最初の観測単位にする。明示graphは人間が正しい依存を与えた診断対照であり、同じ情報条件の有用性対照とは呼ばない。static-onlyはまずモデルなしの対照として残す。

この規模用taskには少なくとも32件の意味のあるtarget作業と複数waveを用意し、N=32が単なる登録だけにならないかを実稼働記録で確認する。既存repoにこの仕事がなければ無意味な分割をせず、制御されたfixtureの機構観測として報告する。条件順は反復間で入れ替え、provider待ちやcache状態を記録する。失敗・打切りを分母から除外せず、品質の結果を見てtaskを差し替えない。

N=16の品質・usage・停止判定が確認できたら、同じ2taskについてN=8/32、C=8で同じ2反復を追加する。Nを変更した理由と総個体記憶量も記録し、記憶量やcacheの差をN固有の効果にしない。各run上限とseries総受付上限は実行前にversion付き条件ファイルで固定する。元の停止seriesや追加100 credits枠を新規予算として再利用しない。今回の計画作成では有料seriesを実行しない。

Luna単独と同じLuna/AstraのManager-localによる有用性比較は、その後の別段階とする。現行`compare`は専用fixtureなので一般repoへそのまま使えない。共通task・verifierを受ける比較接続を追加し、同じreadable、tool、書込権限、品質条件、予算を揃えた後に実行する。単独にも公開情報の検索を許し、Managerに不要な全文読取を強制しない。新規Astra単独条件は作らない。

品質を最初の合格条件とし、同じtaskで明示graphが合格するのに発見込みが不合格なら、局所性や速度による成功扱いをしない。観測不能の依存を含む課題では固定oracleによる不合格と未解決の保持を期待し、「全依存を発見した」とは報告しない。既存projectの費用優位を報告する前には、taskを分解する人間の時間も測った別repoのholdoutが必要である。

## Concrete Steps


以下はrepo rootで実行する。依存に変更がなければ毎回npm ciを行わない。

    cd /Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm
    git status --short --branch
    npm run check
    git diff --check

基準版では434テスト、原資料2snapshotが成功した。実装後に数は増えてよいが、fail・skipを成功として数えない。

M6-A実装後のモデルなし確認:

    npm run sheep -- --help
    npm run sheep -- repo --help
    npm run sheep -- durable --help
    node --test tests/cli-contract.test.ts

helpはexit 0で、repoが候補保存、durableがC=1再開、mechanismがcredit/tokenを区別すると分かること。全5commandの確認と誤入力・alias衝突は契約テストで行う。機械処理時はnpmの付帯表示が混ざらない`node src/sheep-cli.ts ...`または`npm run --silent sheep -- ...`を使う。

M6-B〜D実装後のモデルなし確認:

    node --test tests/repo-verifier.test.ts tests/repo-dependencies.test.ts tests/repo-discovery.test.ts
    npm run check
    git diff --check

新しい試験は変更前に未実装として失敗し、変更後に実tmp repoの候補とkernel状態まで検証する。既存のrepo-review、budget、durable、Dockerの通常gateも成功を必要とする。通常gateでVMやAPIを起動しない。

M6-Eでは`tests/fixtures/repo-discovery/`に、固定したbaseline・公開検査・最終検査・基準解と変異を置く。`scripts/prepare-repo-discovery-pilot.mjs`を新設し、新しいoutput rootへbaselineだけのGit repoとtask v2を作る。基準解や最終期待graphを公開catalogへコピーしない。この準備scriptもモデルを呼ばない。

    node scripts/prepare-repo-discovery-pilot.mjs --output .sheep/repo-discovery-pilot-01
    npm run sheep -- repo --repo .sheep/repo-discovery-pilot-01/repo --task .sheep/repo-discovery-pilot-01/task.json --runtime codex --worker-model gpt-5.6-luna --workers 4 --concurrency 2 --max-worker-calls 12 --max-meta-calls 0 --max-tokens 300000 --reserve-tokens 30000 --max-tokens-per-call 16000 --timeout-ms 120000 --output .sheep/repo-discovery-pilot-01/run --dry-run

dry-runは`status: planned`、limits.workerCalls=12、limits.metaCalls=0、token予算、host verifier、apply=falseを表示し、run directoryを作らない。実Luna疎通は同じコマンドから`--dry-run`だけを外して実行する。既存出力がある場合は末尾番号を変え、再利用しない。12callまたは予算に達して未完了ならそのまま記録し、自動で増額しない。

実走後は同じ固定検査を保存済み候補へ独立に適用し、result、receipt、dependency-evidence、read-deliveries、uncertainties、source repoの差分を照合する。runの自己申告だけを実証にしない。

## Validation and Acceptance


CLIの契約は、全help、正しいdry-run、不正runtime、未指定API model、NaN/負数/不正整数、N<C、alias衝突、未対応resume、token/credit混在、repo Docker拒否を含む。拒否時にはrunner呼出し・出力作成・VM・外部callが0件であることを検査する。旧入口の代表例は同じruntime、model、budget、出力schemaへ解決されること。新入口だけの終了コード変更を旧dispatcherへ漏らさないこと。

検証の契約は、localとfinalの同一候補識別、検査のすり替え拒否、再利用した古い結果の拒否、command起動失敗の基盤障害化、正常終了後のprocess group回収、最終検査の診断非配信を含む。基盤障害はsemantic failureへ変えず、上位を起動しない。

依存の契約は、parseした静的参照、実際に配信した読取、モデルの仮説が別に記録されること。予約path、symlink、binary、対象外のpublic path、未公開protected、観測後に変更したprovider、同じbytesでevidenceEpochだけ進んだproviderを含む。要求とwriteを同時に返した案、未配信の内容を読了と称する案は採用しない。新edge登録とcatch-upの間に変更を挟む決定論的scheduleで取りこぼしがないこと。

局所性の契約は、taskに無関係なtargetとファイルを追加しても、既存targetへ他targetの指示全文を配信しないこと。graph走査の総bytes、候補近傍数、起動target数、配信context bytes/p95/最大、共通goal量、固有読取ファイル数を別々に記録する。初回に全選択targetを起動した事実は隠さない。広い依存が実在するtaskでは広いcontextを正当な結果として残す。

完了の契約は、read要求待ち、blocking claim、stale proposal、基盤障害、unknown usage、最終受入不合格が残ればsuccess=falseかつapply=falseであること。打切りは収束成功ではない。sourceのdirty/untracked・HEAD・mode・新規衝突の既存保護も保持する。

実測ではN、C、実際の稼働数、成功品質、call数、provider待ち、検査待ち、read追加費用、上位の観測/介入費用、再試行、単価とcache、準備時間を区別する。新規価格情報が必要なら実行前に公式情報を確認して固定し、保存済みの2026-09-10単価を現在価格として扱わない。usage不明は既知下限として残し、新規受付を止める。token上限が同じだけの実験を同額予算比較と呼ばない。

## Idempotence and Recovery


各runは新しい出力rootを使い、元snapshot、task、profile、oracle、ソースrevisionのhashを保存する。失敗後はその証拠を変更せず、新しいrunとして再試行する。モデル結果・usage・cleanupが不明なrunを自動resumeで再課金しない。repoの並列run再開はこの計画では実装しない。

v1と旧CLIを移行中も維持する。v2の挙動に問題があれば次の新規runでv1を明示選択できるが、不明usageのrunをv1へ変換して受付lockを解除してはいけない。依存走査の失敗でreadable全体を無断配信したり、Dockerに失敗してhostへ切り替えたりしない。

実装はCLI、host verifier、静的発見、read/uncertain、実測の順にreview可能な変更へ分ける。変更のたびに既存差分を確認し、README・roadmap・必要な設計判断を実装済みの範囲だけ更新する。資料snapshot、過去の結果、凍結sourceは編集しない。

## Artifacts and Notes


基準版は`b8720ea330c12bbd667bd5eb89c2a9515b363709`。今回の判断の詳細は`docs/discussion-review-20260910.md`に保存した。原資料は`docs/references/manifest.json`の2snapshotで、現在の指示ではなく設計の根拠として読む。

実装後の各runでは`profile.json`、`result.json`、検査のdigest付きreceiptに加え、`dependency-evidence.json`、`read-deliveries.json`、`uncertainties.json`を保存する。後三つには版付きformatを持たせ、上限拒否や配信しなかった要求も含める。provider usageとhostの処理量を混ぜない。

集計は`docs/results/repository-discovery.md`へ新規作成する。実装受入、制御されたtaskの機構観測、実projectの有用性を別に書く。既知graphを人間が用意した時間が不明なら不明とし、0扱いしない。

## Interfaces and Dependencies


以下は新規のhost内部契約の形であり、既存のwire形式ではない。型だけでなく実入力のvalidatorを実装する。CLIはNode標準`parseArgs`を使う。

    type CommandName = "repo" | "swarm" | "compare" | "durable" | "mechanism";
    type ResolvedCliInvocation =
      | { kind: "help"; command: CommandName | null; text: string }
      | { kind: "dry-run" | "execute"; command: CommandName;
          profile: ResolvedCommandProfile; legacyOutput: boolean };
    // ResolvedCommandProfileはcommandで判別するunion。
    // 対応しないbudget/resume/toolをoptional項目の組合せで表さない。

`ResolvedCommandProfile`はCLIからrunnerへ渡す実値と、callLimitの対象role、budget単位、worker/verifierの能力、apply/resumeを含む。runner呼出しに使わない架空のdefaultを表示しない。help/profileの定義元とruntime preflightの検査規則は同じものを参照する。

    interface RepoVerifier {
      verify(request: RepoVerificationRequest): Promise<RepoVerificationReceipt>;
    }
    // request: snapshot, overlay, commands, phase, outputRoot。
    // receipt: candidateDigest, checksDigest, environmentId, phase,
    // status(pass/reject/infrastructure-error), cleanup, checks, errors。

`RepoVerificationReceipt`のenvironmentIdはhostのNode/OS/検査実行方式を識別する。将来Dockerを足す場合はtemplate digest、dependency bundle、ネットワーク方針、toolchainも束縛する。worker runtimeからverifier環境を暗黙に推定しない。

    type RepoWorkerProposal =
      | { kind: "write"; content: string; note: string }
      | { kind: "read"; paths: string[]; note: string }
      | { kind: "uncertain"; observed: string[]; missing: string[];
          hypothesis: string | null; note: string };

write先はhostが割り当てた単一targetで、responseに任意の書込範囲を持たせない。claimのblocking判定・読取版・evidence source・解決証拠はhostが付ける。モデルが決めたepoch、usage、validator結果を信頼するfieldは設けない。

    interface DependencyEvidence {
      consumer: string;
      provider: string;
      source: "static-import" | "delivered-read" | "model-hypothesis";
      consumerStamp: { version: number; evidenceEpoch: number };
      providerStamp: { version: number; evidenceEpoch: number } | null;
      evidenceId: string;
    }

static-importは構文とsnapshotの証拠、delivered-readは実配信したcallの証拠、model-hypothesisは未確認の主張である。kernelへ確定する依存と、未配信候補の集合を分ける。M6-C/Dで必要な補助fieldを追加したら型・validator・受入試験・本計画を同じ変更で更新する。
