# Stratal Brief

## Goal

下位モデルの群れを増やしたとき、成果物依存に沿う局所作業と、上位モデルの必要時の介入で、品質と作業の継続を保てるか確かめる。分業・伝播・混雑・収束と、認知範囲・費用・障害範囲を実コード上で観測する。

## Current Working Contract

現在はkernel、Luna4体、8・16・32体の規模比較、C=1の永続化と実process再開を確認済み。別taskで4方式の初期比較も完了し、失敗と実装修正後の追加試行を分けて保存した。公式価格・cacheによる見積器に加え、静的・レジストリ意味依存・3段階変更とcredit相当受付を実装した。新しい主比較はtimeoutの使用量不明で停止し、承認された追加100相当の枠でN16/32を実行した。N8/16/32はC=8で各1回成功したが、増員の明確な利益は未確認。詳細は [実測](../docs/results/mechanism-findings.md) に残す。方針全体は [docs/current-direction.md](../docs/current-direction.md)、実装順序は [docs/roadmap.md](../docs/roadmap.md) を参照。

## Fit Conditions

次のAgentがREADMEから実装済み範囲を把握でき、`npm run check`で確認できること。実験の不利な結果と、未解決の仕様を残すこと。

## Hard Constraints

- 明示された利用者の方針を、Agentの推測で上書きしない。
- referencesの既存snapshotを書き換えない。
- 実装していない機能や試験していない性能を完了として報告しない。
- 実動作の下位モデルは利用者が2026-09-10に指定したgpt-5.6-lunaを用いる。利用できない場合も黙って置換しない。
- 2026-09-10の利用者方針により、Astra単独のコスト感は概ね把握できたため、今後の単独対照はLunaのみとする。群れへの必要時のAstra介入と、過去の実測・凍結記録は維持する。

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
- 今後の単独対照にはLuna、Manager-localには同じ上下モデルの組を使う。Astra単独の新規試行は利用者方針により省く。規模探索と総予算を揃える有用性比較を分ける。
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

## Open Questions And Discomfort

- 未知の意味依存を何から発見するか。発見費用が局所化の利益を上回らないか。
- 一つのartifactが多数のconsumerを持つとき、どの粒度で検証するか。
- 下位はgpt-5.6-lunaを利用者指定として固定。上位gpt-6-astraとCodex CLIは現在の作業上の既定値。費用上限、観測間隔、兆候の閾値は実験ごとに記録して見直す。
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
