# Stratal Brief

## Goal

DeepSeek Flash単体と群れを比較し、分担・依存管理・必要時の上位介入によって、同じrepo変更の品質と実際の受入完了までの時間を改善できるか確かめる。費用は上限制約と補助指標に置き、固定時間内成功率は使わない。

## Current Working Contract

現在はkernel、Luna4体、8・16・32体の規模比較、C=1の永続化と実process再開を確認済み。別taskで4方式の初期比較も完了し、失敗と実装修正後の追加試行を分けて保存した。公式価格・cacheによる見積器に加え、静的・レジストリ意味依存・3段階変更とcredit相当受付を実装した。新しい主比較はtimeoutの使用量不明で停止し、承認された追加100相当の枠でN16/32を実行した。N8/16/32はC=8で各1回成功したが、増員の明確な利益は未確認。詳細は [実測](../docs/results/mechanism-findings.md) に残す。方針全体は [docs/current-direction.md](../docs/current-direction.md)、実装順序は [docs/roadmap.md](../docs/roadmap.md) を参照。

今回の実装範囲は[CLI整理とrepoの依存発見計画](../docs/execplan-repository-discovery.md)。2026-09-10の利用者のCLI整理追加を含む。既存入口・task v1・固定受入を保ち、opt-inで読取依存を発見する。書込範囲は自動拡張せず、全runner再設計を前提にしない。A–Dと初期gateを実装し、利用者指定のGo DeepSeek swarmで部品生成とv2疎通を確認した。親の補修・初回失敗・実走範囲は[結果](../docs/results/repository-discovery.md)に残す。新しいLuna疎通とN比較・有用性比較は未実行。[判断の根拠](../docs/discussion-review-20260910.md)。

## Fit Conditions

次のAgentがREADMEから実装済み範囲を把握でき、`npm run check`で確認できること。実験の不利な結果と、未解決の仕様を残すこと。

## Hard Constraints

- 明示された利用者の方針を、Agentの推測で上書きしない。
- referencesの既存snapshotを書き換えない。
- 実装していない機能や試験していない性能を完了として報告しない。
- 2026-09-11の利用者指定により主ベンチマークはopencode-go/deepseek-flash。単体・Manager・Sheepで下位を揃える。過去のLuna/DeepSeek実測とCLI defaultsは黙って置換しない。
- 主目的は品質と実際の受入完了までの時間。固定時間内成功率は使わない。失敗・中断の完了時間はnull。費用は上限と補助指標。Astra単独の新規試行は行わず、必要時のAstra介入と過去の実測は維持する。

## Preference Gradients

有用な設計だけ借りる。実装を小さく保ち、個体数を変えた観測を早く行う。下位の局所作業と上位の観測ループを分ける。大きなframeworkの導入や新規性の主張を目的にしない。

## Judgment Bindings

### 下位がswarmし、上位が観測して必要時に介入する
Authority: Human stated
Evidence: Stated; 2026-09-09の利用者発話「swarmするのはより下位のモデルで、メタマネジメントを上位に」「上位が必要なときだけ干渉するような形が望ましい」「下位の数をある程度膨らませたときの振る舞いが仮説のキモ」。相談経路を設けない二つのループと版付き介入は、この意図を実現するWorking default。
Working default:
- 下位からの相談経路を設けず、上位が通常の履歴と成果物を観測して介入する。下位の自己申告だけに介入判断を任せない。
- 上位の判断は共有仕様・制約・担当等へ版と範囲を持って反映し、kernelの確定検査を通す。
- 運用上の介入を通常動作として計上する。評価用shadowと実験外からの救済を分ける。
Why it matters:
- 下位に上位の必要性の判断を押し付けず、増員時の自律的な作業とメタ管理の負担を観測するため。
Validation:
- 下位の通常手順に相談・返答待ち・上位の全件承認がなくても進行し、観測からの介入とその効果を追えること。
Revisit when:
- 利用者の役割分担の意図が変わるとき。観測や介入の実装方法は実測に応じて見直す。
Status: active

### 規模の観測を早期に行う
Authority: Working default
Evidence: Derived; 利用者が増員時の振る舞いを重視し、Agentが設計対話で4体の動作確認、16体開始、8・16・32体比較、64体の次段階探索を提案した。具体数は未検証の作業上の既定値。
Working default:
- 上位1体＋下位16体で最初の本実験。4体は動作確認、8・16・32体を初期比較範囲とし、64体は次の探索候補にする。
- 小さなkernelの必要な性質を確認後に実workerへ接続し、永続化の完成を待たず規模を観測する。中断runは未完了とする。
- 同じ仕事での増員と仕事量も増やす比較を分け、N・最大同時実行数C・実際の稼働数を記録する。
Why it matters:
- 3〜4体の成功や、登録数だけから大きな群れの成立を推定しないため。
Validation:
- 各規模で品質・分業・訂正の伝播・収束・上位負担を比較できること。外側の受入条件を緩めないこと。
Revisit when:
- 並列に進める仕事が足りない、実行基盤の制限が支配的、または反復観測が別の人数を調べる必要を示したとき。
Status: tentative

### 製品を導入する前に、設計を借りる
Authority: Human stated
Evidence: Observed; 抽出資料の原文5917・6728行にある利用者の方針と、調査レポート第1・11節。
Working default:
- Agent Mail等を必須依存にせず、identity、claim、receipt、auditの考え方を最小限に使う。
Why it matters:
- 元対話の途中の製品導入案へ戻ることを防ぐ。
Validation:
- 追加依存が現在の受入条件に必要か説明できること。
Revisit when:
- 実測で自前の小さな機構が足りない、または利用者が製品の採用を指定したとき。
Status: active

### 初期実装言語と実行環境
Authority: Working default
Evidence: Derived; 元対話のTypeScript／Node.js案と、既存runnerへ接続しやすい構成からの選択。
Working default:
- TypeScript、ESM、Node.js 24.12.0以上、npm。runtime依存は未導入。
Why it matters:
- 一つの検証コマンドで開発を始めるため。
Validation:
- 現在のNode.jsでtypecheck・test・demoを実行する。初期化時の実測は26.0.0。
Revisit when:
- 利用者が言語を指定する、worker adapterやstoreの制約が見つかるとき。
Status: tentative

### 初期化とkernelの実装を区別する
Authority: Working default
Evidence: Derived; 「ドキュメントを元にinitして」という依頼と、調査レポートの段階A〜D。
Working default:
- M0は資料と開発基盤。型と有限モデルからkernelの保証を推定しない。
Why it matters:
- 後続作業が架空の実装完了を前提にするのを防ぐ。
Validation:
- READMEとroadmapに実装済み範囲と未着手範囲が明示されていること。
Revisit when:
- 各milestoneの受入条件を実際に通したとき。
Status: active

### 予約・権限・確定・終了を別に検証する
Authority: Working default
Evidence: Derived; 調査レポート第7・9節の反例と、提案された境界。
Working default:
- claimはadvisory。確定はread set、authority epoch、統合snapshotを検証。終了は未処理義務とblocking claimを含めて判定する。
Why it matters:
- 局所的に正しく見える処理を、全体の成功と取り違えないため。
Validation:
- docs/testing-policy.mdに列挙した反例をkernel実装時の受入fixtureにする。
Revisit when:
- 反例に不備がある、または異なる一貫性モデルを意図的に採用するとき。
Status: tentative

### 成功品質を先に固定する
Authority: Working default
Evidence: Derived; 調査レポート第10節の評価提案。Observed; 2026-09-10の利用者によるAstra単独の新規試行を省く方針と、上下モデルを分ける意図。
Working default:
- 主ベンチマークの単独対照にはDeepSeek Flash、Manager-localにはSheepと同じ上下モデルの組を使う。Astra単独の新規試行は利用者方針により省く。規模探索と総予算を揃える有用性比較を分ける。
- 外側の受入条件をrun前に固定し、上位が作業仕様を直しても採点条件を緩めない。上位の観測・読み直し・介入、依存発見、監査を費用から落とさない。
Why it matters:
- 通知削減や少ないtokenだけで成功を装わないため。
Validation:
- 調整に使っていないtaskでpaired比較する。運用メタ管理の介入は通常動作として含め、実験外からの救済を別に記録する。
Revisit when:
- 評価対象の目的が変わる、または実測で指標が目的を捉えていないと分かったとき。
Status: tentative

### Docker Agentを局所作業runtimeとして導入する
Authority: Human stated
Evidence: Stated; 2026-09-10の利用者依頼「この議論をもとに調査・精緻化し、docker-agentをsandbox付きで導入して」。host proxyからChatGPT endpointへ既存Codex認証を使うことも明示承認された。
Working default:
- Docker Agent v1.137.0、sbx v0.42.1、digest付きtemplate。mountlessの新規VMに明示したファイルだけを渡す。
- kernelのauthorityと局所記憶を維持し、上位への相談・Docker Agentのsub_agentsへ置換しない。
- SSH転送を無効化し、MCP toolを渡さず、ネットワークはChatGPT宛てのみ。実トークンはhost proxyで扱う。
- 実際のworkspace変更を回収してlease/read set/外側受入で確定する。modelの自己申告との差は保存する。
Validation: [導入手順](../docs/docker-agent-sandbox.md)と[実測](../docs/results/docker-agent-sandbox.md)。一般repo、pool再利用、並列durability、費用優位は未確認。

2026-09-10のPR化・継続依頼を受け、次の局所範囲を既存swarm fixtureのtool接続とした。可視テストは固定feedbackとして追加し、採点値を変えずに受入実行を独立VMへ移す。全workspace差分の検査を保ち、基盤障害を上位への意味的相談の材料にしない。

「わかっているところまで進めて」に対し、`compare`の4方式への同一tool追加、単独Luna対照、所有process終了後の復帰時回収を進めた。機構実験のreadRequests・段階別oracleまで同じ形で移植できるとは仮定しない。Docker usageのper-message計上と中断時の既知下限を費用見積器へ接続し、資源回収や価格catalogの0から成功・総費用を推定しない。
Status: active

### DeepSeek直接APIを実験用opt-in runtimeとして追加する
Authority: Human stated
Evidence: Stated; 2026-09-10の利用者依頼「DeepSeek APIを使えるようにする」。実装の委譲先としてopencode-delegateとdeepseek-v4.1-flash-expires-on-0910を指定。直接API adapterとswarmへの初期接続範囲は、この依頼に対するWorking default。
Working default:
- `src/deepseek-worker.ts`を追加し、`swarm`・`compare`・`durable`・`mechanism`の`--runtime deepseek`から共通`src/model-runtime.ts`経由で選ぶ。既存のCodex既定・Luna workerは変えない。`mechanism`のcredit予算seriesは凍結し、credit modeでのDeepSeekは有料callの前に拒否する。
- bearer認証、JSON mode、`stream:false`、明示`max_tokens`、`thinking`無効。toolは渡さず自動retryしない。base URLはhttpsとloopback httpのみ。
- 要求modelと応答の実model証拠を別に保持し、`finish_reason: stop`とschema適合を検査する。HTTP失敗・応答過大・timeout・取消はboundedで秘匿情報を伏せたtranscriptにする。providerの応答aliasは証拠として保持し、`requestedModel`の不一致だけを拒否する。
- `--worker-model`はprovider prefixのない生API idを必須とする。meta既定はCodex、`--meta-runtime deepseek`は`--meta-model`明示とAstra拒否を要求する。
- usageは主要counterが整合する場合だけ完全とし、欠落・不一致は0と数えず不明として受付と上位介入を止め、runを失敗にする。`durable`は不明usageをsnapshotへlockし、再開時の新規callとoverrideを拒否する。
- `compare`はrole単位で下位・上位callを数え、同一model idでも区別する。`durable`はruntime/model/maxTokensPerCallを保存し、legacy format-1は既定値へ正規化して再開する。`mechanism`のcredit系列は凍結し、DeepSeek/混合upperは`--budget-mode tokens`の独立token予算（cache split不要、input+output下限、不明usageで恒久lock）に分離する。credit modeのDeepSeekは有料call前に拒否し、tokenとcreditを換算・混在しない。
Validation: [DeepSeek adapter試験](../tests/deepseek-worker.test.ts)、[swarm接続試験](../tests/deepseek-swarm.test.ts)、[runner横断試験](../tests/deepseek-runners.test.ts)、[token予算境界試験](../tests/token-budget-boundaries.test.ts)、[mechanism token試験](../tests/mechanism-token.test.ts)、[token系列dispatcher試験](../tests/mechanism-token-series.test.ts)。実network・実keyを通常gateに持ち込まない。実APIでの全3成果物の確定を[別試行](../docs/results/deepseek-api.md)で確認し、課金・一般repo有用性は未確認。
Revisit when:
- 実DeepSeekでの観測範囲を広げるとき。またはtoken系列の実billing見積りや、credit結果との比較方法を定めるとき。
Status: active

## Open Questions And Discomfort

- 未知の意味依存を何から発見するか。発見費用が局所化の利益を上回らないか。
- 一つのartifactが多数のconsumerを持つとき、どの粒度で検証するか。
- 既存比較の下位はgpt-5.6-luna、上位gpt-6-astraとCodex CLIは現在の作業上の既定値。DeepSeekは各runnerで明示選択する追加経路。費用上限、観測間隔、兆候の閾値は実験ごとに記録して見直す。
- 上位が全件を読み直さず、全員共通の誤解を何から発見するか。
- Commit policy: recommend commit（共有のrepo規約のみ）。初期化では未stageとし、commitの依頼時に含める。

## Rejected Directions

- 元対話の製品導入案を最終決定として扱うこと: 利用者の後続発話で修正されている。
- いきなり分散message brokerや巨大なorchestratorを作ること: 最小protocolの検証が先。
- 全情報を見るLLMを正解oracleとすること: 採点器とshadow診断を分ける。

## Evidence Notes

原文snapshotとSHA-256はdocs/references/manifest.jsonに保持。2026-09-09の現在の方針はdocs/current-direction.md、検証対象はdocs/testing-policy.md、実装の進捗はdocs/roadmap.mdを参照。このbriefはプロジェクト共通の判断を保持し、個別runのイベントログにはしない。

### 機構実験のsandbox内readを版付きcontextへ閉じる

Evidence: Stated / implementation; 利用者の継続指示により、`mechanism`のDocker tool経路を実装。読取要求は次の有料callで配信し、未配信の選択をverifierの自動確定に使わない。registryを読む前にpolicy所有先を明かさず、必要な現版policyが揃うまで可視ケース・値を含むフィードバック・編集採用を解禁しない。

既存oracleの期待値と最終stage barrierを保持する。可視観測VMはそのcontextだけ、最終観測VMは全候補を受け取り、期待値はhostで比較する。旧Codex凍結系列の予算・結果をDocker条件へ流用せず、単独Lunaと上位のguidance権限を保つ。[検証](../docs/results/docker-agent-mechanism.md)

### 完了goalとswarm自身による実装を区別して記録する

Evidence: Stated; 2026-09-10の「一通り終わらせることをgoalとして。実装の際、今あるswarmを試すこともしてみて」。[固定した完了条件と実装課題](../docs/tasks/docker-goal-completion.md)を置き、下位Lunaの2 helper実装を、既存runSwarmのtrusted fixture接続口から実行する。親は接続口・独立oracle・CLIを実装し、helperを先に書かない。返却コードの受入、自己修正、採用時の変更有無を記録する。

前回の使用量不明は保持したまま、goal内の終了形式・semantic全工程・3段階更新を別runで実行する。実行が重なる区間の所要時間は性能比較に使わない。完了には実Lunaの正常終了・完全usage・固定採点とkernel確定・cleanupが必要である。

Evidence: Observed; semantic 18call、staged 28callで完走し、生成helperは3call・固定91ケース後に本体変更0で採用した。システム側の終了指示と、現在の配信済みreadと過去の要求を区別する説明を修正した。oracleや予算上限は維持し、以前のunknown usageを復元済みとは扱わない。[完了検証](../docs/results/docker-agent-completion.md)

2026-09-10追加検証: 利用者の「一通り対応して。使えるならworkerをdeepseekにして使ってみて」に基づき、各runnerとtoken系列でDeepSeek workerを実行した。8条件・52下位callとManager-localの2上位callが成功し、[実行記録](../docs/results/deepseek-runners.md)へ保存した。既存のcredit系列や固定oracleを変更せず、一般repoでの有用性や請求額はこの合成課題から推定しない。

### OpenCode Goの追加経路

Evidence: Stated; 利用者のOpenCode Go対応依頼と「luna swarmで実装を進めて」に基づく。Lunaの作業エージェントが通信・runner・計数を分担し、親が独立した固定条件で検証する。`opencode-go`を明示したときだけGoへ送信し、provider/model/session/usageを識別する。既定のLuna/Astra、直接DeepSeek、固定oracleは保持する。Goのsubscription枠を既存Codex creditへ換算しない。

### API混合runの不完全な使用量と独立レビュー

Evidence: Stated; 利用者が実装後の独立レビューをAstra、修正をOpenCode GoのDeepSeek V4.1 Flashに指定した。実装者と独立レビューを分け、再現を固定して修正後に再検証した。

API runtimeを含むrunでは、上位Codexの数値usageも途中値かもしれない。timeout・取消・不完全な終了イベントは既知数値を保持して受付を止め、durable再開で解除しない。正常終了した単一usageと、完全に計測されたschema不適合を区別する。Docker cleanupは呼出roleのruntimeに従う。規模比較の子run失敗・不正reportで次条件へ進まない。[AstraレビューとGo修正の証拠](../docs/results/astra-go-review.md)。


### 指定GitリポジトリをGo DeepSeekのswarmへ渡す
Authority: Human stated
Evidence: Stated; 2026-09-10「任意リポジトリで実行できるようにしよう。opencode-go/deepseek-flashのswarmで進める」。
Working default:
- 専用fixture factoryの代わりにtask JSONで対象・context・依存・固定検査を宣言し、既存runSwarm/kernelを再利用する。
- 候補保存を既定にし、明示した`--apply`で受入・使用量・元ファイルのdrift確認後だけ書き戻す。
- 今回の実装と実走は指定したGo/deepseek-flashを使う。既存比較の下位Luna方針を黙って置換しない。
- 検査コマンドは信頼するhost subprocess。tool-less API workerの権限と、host検査の信頼境界を混同しない。
Validation:
- 通常gate、実JavaScript/Python repoのcandidate-onlyとapply、dirty/untracked保存。[記録](../docs/results/repository-runner.md)。
Revisit when:
- 削除/rename、巨大repo、複雑な依存setup、resume、隔離した検査が必要になったとき。
Status: active

### 段階読取と広い初期配信の対照
Authority: Human direction / agent scoped implementation
Evidence: 2026-09-10の「マージして、添付した議論をもとに次の作業へ」。PR #5をマージし、[議論](../docs/discussion-review-progressive-read.md)を現行実装と照合した。
Working default: ファイル数を最小化することを目的にしない。read scope、impact scope、write authorityを分け、全文に近い公開context対照と同じ品質で総負担を比べる。言語別解析はadapter、版と証拠の確定はkernel。confidenceだけで確定しない。
Validation: opaqueな資料24件・2targetのGo N4/C2 pilotで、局所/広域とも固定受入成功。局所の総tokensが多い結果も保持する。[証拠](../docs/results/read-selection-pilot.md)。
Next: TS adapter/self-host、未調整taskの反復、N/C比較、activation。今回の実装部品と小規模実走は継続指定のGo DeepSeekを使用。新規Astra単独対照は追加しない。
Status: active

### TS self-hostとstatic impactの継続結果
Authority: Human stated / agent bounded implementation
Evidence: 2026-09-10「残りも順次進めて。swarmで」。指定Go swarmで部品生成とTS自己実装を実行し、N/C・局所/広域の8条件と関連targetだけの起動を観測した。
Working default: 言語別解析は既存compilerのAST、起点はhostのchangedPaths。品質oracleを起動対象に縮めない。通常TS検査はmoduleの実読み込みを含め、全caseがsnapshotにあることを確認する。方式の既知失敗は実験データとして残し、未知usageや予約超過と混ぜない。
Validation: 480テスト、8条件の7成功/1未完了、実影響起動2call。最初の停止分も総予算へ繰り越した。[証拠](../docs/results/repository-scale-activation.md)。
Revisit: 新family/反復、総記憶量の対照、Luna/Manager-localとの有用性、意味依存の取りこぼし。今回のGo小規模対照をLuna系列へ置換しない。
Status: active

### MoonBit repository support

利用者の追加指定により、MoonBit packageの静的依存と補助ファイル配信を追加。各packageのv2 write対象は1つとし、公開catalog不足や外部/生成/条件付き等の未対応依存は拒否する。指定のGo swarmを継続使用。parser生成後は親が型・入力境界を補修し、実MoonBit修正は2callで固定compiler oracleに合格。通常gate488件。[結果](../docs/results/moonbit-repository.md)。

### DeepSeek Flashの品質と実所要時間
Authority: Human stated (2026-09-11)

「低費用はモデル選択である程度達成。品質と速度が問題」「主ベンチマークはdeepseek-flash」「固定時間はやめ、どれだけかかるか測る」を採用した。PR #6を基準に、まず独立3targetと依存連鎖3targetで単体/現行Sheepを比較する。完了はhidden oracleと独立再検査、時間は実行開始から元repo不変確認まで。準備・親レビューは別会計。詳細は[計画](../docs/execplan-quality-speed.md)。

Validation: 初回の形式負担を保全し、対象名固定系列は単体5/6・Sheep4/6成功。固定時間採点なし、非成功のcompletionはnull。496テストと全24runのreceipt/候補/元repoを監査した。次は公開下流失敗から受理済み上流を再検査する経路を固定反例で検証する。[証拠](../docs/results/deepseek-quality-speed.md)。


2026-09-11の追加指示に従い、主モデルopencode-go/deepseek-flashのthinkingは今後有効にする。比較は単体とSheepを同じ設定に揃え、過去のdisabled系列とは分ける。上流再検査はtask v2のopt-inとして実装し、公開local checkの失敗と配信済み版だけを起動根拠にする。再検査はproviderごと1回・総数上限内で、試行予算をリセットしない。完了条件は反例の回復、健全な上流・非公開失敗・古い証拠・上限の検証、thinking有効の実走と使用量保存。[詳細](../docs/execplan-upstream-recovery.md)。

計測優先の追加指示により、今後の比較は1call出力64,000 tokens、1条件総1,000,000 tokens、予約100,000 tokensとする。通信timeoutは600秒に広げ、task全体の時間締切や固定時間採点は設けない。旧上限の実測は別条件として保持する。


### thinking有効の38条件からの更新
Authority: Human direction / measured agent judgment (2026-09-11)
Evidence: 「一通り進めて」に基づき、[再検査指示・単体対照・Cとactivationの実測](../docs/results/contract-quality.md)を完了。
Working default: contract指示はfocusedと同じ8/9成功でcallと時間が増えたため、focusedを維持する。単体/Sheepは2課題×3反復でともに6/6成功、6組中5組でSheepが速かった。速度8条件は全成功、C増加と関連起動の差を別々に確認した。小規模課題の優位を一般化せず、N・C・実稼働を分ける。
Next: workerの診断をhostで検証できる公開反例・対象版に結び付けて上流へ渡す品質仮説を優先する。noteの自己申告だけを起動・権限・完了の根拠にしない。上位介入、progressive activation、read wideningは別の比較として残す。
Validation: 38runのreceipt・使用量・候補・元source・独立受入を照合、521テストと参照hash成功。thinking有効、緩いtoken上限、時間締切なしを継続。旧系列を保存する。
Status: active


### 公開反例の検証と上流配信
Authority: Human continuation / measured agent judgment (2026-09-11)
Evidence: 「進めて」に従い、host作成の公開probeをworkerがIDで選び、配信版に対する検証後だけ上流へ渡す経路を実装した。[結果](../docs/results/public-probes.md)。
Working default: publicProbesはopt-in。従来・検証のみ・配信が各3/3成功、中央値43.61/65.36/62.97秒で優位を確認できず、通常のfocused設定を維持する。全条件で同じ新規公開probe本文を与えたため、以前の成功率と直接比較しない。
Validation: 実Goの58call/366006tokensと全9runの独立受入を監査。probe検査4回・証拠付き再起動2回。部品生成1call/10398tokensは別計上。通常gate541テスト、参照2件。新規providerの修正は実測後に分離して記録した。
Next: 従来方式が同じ誤りを繰り返し残す新規課題と、必要時だけ診断する条件を固定する。hostが公開probeを用意する手間も測る。noteだけで期待値・依存・権限を承認しない。
Status: active


### Devinによる合成課題の拡充
Authority: Human request (2026-09-11)
Evidence: 「devin-delegateに大量の合成課題を作らせて」に基づく。[仕様](../docs/synthetic-corpus.md)、[生成と検査の記録](../docs/results/synthetic-corpus.md)。
Working default: 16系統×16variant、Node .mjsの修正課題。SWE-2 Maxで生成し、親が基準解・誤実装・公開scopeを実行検査する。初期生成の失敗と親の補修を記録する。
Validation: 256/256課題でbaseline失敗・reference成功、784意味変異を検出（公開check通過365）。既存repo runnerを16系統で検証し、通常gate551テスト成功。構文不正・process障害を意味変異の検出に数えず、公開check通過は予測と実測を分ける。
Next: 課題を凍結し、Go DeepSeek thinking有効・緩いtoken上限で品質と完了時間を比較する。今回の生成・検査では解答モデルを呼ばない。
Status: active


### 合成課題でのDeepSeek初回pilot
Authority: Human request (2026-09-11)
Evidence: 「Deepseekで回してみて」に基づき、16系統のvariant 0、各4targetを固定して実走。[記録](../docs/results/synthetic-corpus-deepseek.md)。
Validation: N4/C2、上位0、thinking enabled、14/16成功、成功時中央値34.63秒、64call/300036tokens。全receipt・独立受入・元repo不変を監査。permissions/ledgerは疎配列の扱いで最終不合格。通常gate551件。
Working default: 最終oracleを途中で返さず、失敗した候補・採点条件を保存する。4targetの1試行を256課題や一般repositoryへ一般化しない。
Next: 残りvariantと規模比較、同じ公開情報を与えた単体対照を別条件で測る。疎配列の契約を明文化するなら別hashで扱い、今回の成績を書き換えない。
Status: active
