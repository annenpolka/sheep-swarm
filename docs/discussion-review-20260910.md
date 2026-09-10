# 添付議論の精査と、次段階の判断

2026-09-10。確認対象はローカルmainの `b8720ea330c12bbd667bd5eb89c2a9515b363709`。作業開始時の差分はなかった。添付議論、固定された元資料、現行コード、保存済み実測を照合した。新しい性能比較や実LLM呼出しは行っていない。

結論は、**一般repoで必要な依存を発見し、読む範囲を制御することを次の研究課題にする。ただし、最初の実装はCLIの整理と小さな検証境界の分離から始め、既存のkernelとrunnerを利用して進める。** 下位の増員時の振る舞いという目的を維持し、発見機能の追加だけで完了にはしない。[次の実行計画](execplan-repository-discovery.md)に実装順と受入条件を記す。

## 議論の主張をどう扱うか

| 議論の主張・提案 | 判定と修正 | 確認根拠 |
|:---|:---|:---|
| mainはb8720ea、434テスト成功 | 今回のローカルHEADと再実行で一致。open PR/issueの有無は今回照合しておらず、計画の根拠にしない | `git rev-parse HEAD`、`npm run check` |
| 版・read set・lease・確定・完了を分離したkernelがある | 正しい。ただし「小さなkernelにほぼ到達」という成熟度表示は測定ではない。一般的な意味正当性や並列durabilityまで保証しない | [kernel](../src/kernel.ts)、[実装済み境界](design.md#実装で確定した境界) |
| 任意repositoryを実行できる | manifestで選んだ対象・明示依存・信頼するhost検査の範囲で正しい。自動task分解、任意build環境、未知依存、悪意あるコードの隔離は未達 | [repo利用手順](repository-runner.md)、[repo-run](../src/repo-run.ts) |
| Sheepは単体Astraの約8倍のtokenなので、安くない | token比は正しいが、費用についての含意は修正が必要。同じ通常taskの保存済み価格換算ではSheep-fixedは約1/13.5の費用相当。両方とも一般repoでの優位は示さない | [費用再集計](results/cost-findings.md) |
| 小さいtaskなら単独Luna/Astraが明らかに安い | 一括して断定できない。Astraには上記の反例があり、単独Lunaとの同一条件の反復も不足している | [費用再集計](results/cost-findings.md)、[機構実験の限界](results/mechanism-findings.md) |
| Nを増やす期待は半分反証され始めた | 強すぎる。C固定で速度利益が見えないことは、品質・context・復旧・仕事量あたりの調整費用を含む中心仮説の反証ではない | [現在の目的](current-direction.md#目的と仮説)、[規模実測](results/scaling-findings.md) |
| 誤指示の被害がNに比例する | 観測はN=Cかつwave単位の条件で8/16/32候補が拒否されたもの。誤コードが共有状態へ確定した件数ではない。登録N一般への比例則ではない | [規模実測](results/scaling-findings.md#誤指示が増員でどう広がったか)、[scheduler](../src/swarm.ts) |
| 通常worker出力はcontent/noteだけ | `swarm`と`repo`では正しい。`mechanism`には既にwrites/readRequests/noteと、配信後の依存登録がある。全経路についての説明にはしない | [swarm](../src/swarm.ts)、[mechanism](../src/mechanism-run.ts) |
| 一般repoで自然に近傍を発見する機能が未達 | 重要な未回答。ただし発見は「読む候補」「起動対象」「書込権限」を自動的に一体化することではない | [manifest](../src/repo-manifest.ts)、[元調査4.1・4.2](references/raw--deep-research-sheep-agent-swarm-theory-20260909.md) |
| verification backendを先に抽象化する | 小さく採用する。`CodeFixture.verify`、`FixtureObserver`、`runRepoChecks`という分離点は既にある。全runnerの再設計を前提にしない | [fixture](../src/fixture.ts)、[repo-checks](../src/repo-checks.ts)、[Docker observer](../src/docker-fixture-observer.ts) |
| runtime・store・policyをすべて直交化する | 目標図としては理解できるが、現時点では過大。worker隔離、verifier環境、再開保証には互換条件があり、任意の直積で選べない | [durable](../src/durable-run.ts)、[runtime選択](../src/model-runtime.ts)、[設計](design.md) |
| Metaが研究者から牧羊犬へ変質した | 過去案との差の説明としてはよいが、現在の運用介入は後続の利用者の明示方針。原案への復帰を理由に変更しない | [.stratal/brief](../.stratal/brief.md)、[現在の二つのループ](current-direction.md#役割と二つのループ) |
| Shadow Astraも常設したい | 任意の事後診断として保持。次の実装・比較の必須構成にはせず、runへ助言を返さないことと費用の分離を守る | [元調査9.5](references/raw--deep-research-sheep-agent-swarm-theory-20260909.md)、[観測方針](current-direction.md#観測と介入) |

## 費用の判断を訂正する

保存された通常条件は各方式2runの平均で、Sheep-fixedが192,651.5 tokens / 0.540282 credits相当、単体Astraが23,832 tokens / 7.283000 credits相当だった。前者のtokenは約8.1倍でも、要求モデル別の単価とキャッシュを反映した費用相当は約1/13.5になる。[元集計](results/cost-findings.md#通常条件の比較)

これは2026-09-10に保存された単価での事後換算であり、現在価格の再調査、実請求、利用枠の減少、同額予算での再実験ではない。要求モデルとproviderの実model証拠も区別する。したがって「swarmだから安い」も「tokenが多いから高い」も採用しない。次の対照は同じLuna単独を含め、モデル差、cache、並列度、依存発見、人間の準備を分ける。Astra単独の新規試行は追加しない。

## 元構想との距離は、三つに分解する

元資料は、潜在影響範囲、実際の起動対象、実際に読むcontextを明確に分けていた。また、局所観測から区別できない二つの世界は、追加観測なしには区別できないと述べている。`uncertain`を出すだけで未知の意味依存が分かる、という構想ではない。[元調査4.1・4.2](references/raw--deep-research-sheep-agent-swarm-theory-20260909.md)

現状の一般repoには三つの独立した不足がある。

1. **依存の候補を見つける入口。** `dependsOn`は書込target同士を人間が指定し、循環も拒否する。`context`は全targetへ依存として追加される。静的import・公開文書から読み先を増やす機能は、この経路にはない。
2. **必要な本文だけを配信する制御。** `swarm.contextFor`は依存の推移閉包を取り、repoのgoal artifactは全manifest、guidanceは全targetの指示を含む。各workerが全ソースを読まないことは事実でも、Nやtaskサイズが増えても個体contextが小さいことを保証してはいない。
3. **影響と作業範囲の区別。** repoはgoal変更で選択targetを全て起動する。自動import走査を足すだけでは「影響のあるtargetだけが動く」にならない。また、未指定consumerを見つけても、その発見だけで書込権限は増えない。

根拠は [repoのmakeTask](../src/repo-run.ts)、[contextと割当](../src/swarm.ts)、[manifestの依存制約](../src/repo-manifest.ts)。次の最初の範囲は、**既に許可されたtarget内で、足りない読取依存を発見して局所contextへ届けること**とする。作業対象自体の発見と自動分解は後続に残し、研究結果もこの条件付きで記述する。

既存の`discoverThermalDependencies`は実ファイルを走査するが、importの発見は正規表現と専用contractコメントに限定される。一般repo用parserの完成品として移植しない。`mechanism`の追加readは有用な前例だが、fixtureが用意したcatalogと段階管理に依存するため、schemaだけ共通化して完成とはしない。[静的走査](../src/heldout-fixture.ts)、[追加読取の配信](../src/mechanism-run.ts)

## 検証基盤は小さく分離する

議論の`verify(snapshot, overlay, commands)`だけでは、どの候補・検査定義・環境で実行した結果か、局所修復へ返してよい出力か、cleanupが完了したかを表しきれない。最低限、候補hash、検査定義hash、環境識別、local/finalの区別、pass/reject/infrastructure-error、cleanup結果をhostが記録する契約にする。

初回は既存のhost検査をこの契約で包み、snapshot生成・元repoへのapply・予算・kernelを動かさない。Docker版は同じ候補と検査の互換性を示せる限定環境から接続する。fixture向けの`.mjs`観測VMがあることから、任意repoのpackage install・OS tool・build互換を推定しない。

基盤障害で上位を呼ばず、final検査の失敗情報を修復workerへ戻さず、snapshotや検査が変わった証拠を使い回さない。既存のprocess group回収・親Git探索防止・候補改変検査は抽象化後も保持する。[独立レビュー後の検証](results/repository-runner-astra-review.md)

## CLI整理の実際の対象

追加の利用者依頼に基づく。2026-09-10の実行では、5つの主CLIのうち`repo --help`だけがexit 0でヘルプを表示し、残る4つは未知optionでexit 1になった。以下は名前の揺れと機能差を分けて扱う。

| 項目 | 現状 | 計画での扱い |
|:---|:---|:---|
| 入口 | npm scriptsと複数の即時実行CLI | `npm run sheep -- <command>`を追加。旧scriptsと直接CLIを互換入口として保持 |
| ヘルプ | repoのみ`--help/-h`対応 | 全commandで共通生成。runtime対応、model既定値、予算単位、作成/再開/適用を表示 |
| 出力先 | durableは`--directory`、他は`--output` | 推奨名を`--output`へ。durableの旧名はalias、resumeは明示必須 |
| 上位call上限 | compareは`--max-upper-calls`、他は`--max-meta-calls` | 推奨名を`--max-meta-calls`へ。内部APIと旧名の意味を維持 |
| call総数 | swarm/repo/durableの`--max-calls`は下位数、compare/mechanismは全roleの合計 | 推奨名をそれぞれ`--max-worker-calls` / `--max-total-calls`へ。旧名を黙って再解釈しない |
| token予算 | repo/compare、mechanismのtoken系列にある。swarm/durableには同じ総token受付がない | capabilityとして表示。未対応optionは実行前拒否。全commandへ同名を足しただけで保証を作らない |
| credit予算 | mechanismだけの独立系列 | token/creditsを混在させない。Go subscriptionへ換算しない |
| 再開 | durableのみC=1 | repoや並列swarmで`--resume`を受理しない |
| 保存・適用 | repoは候補保存が既定、`--apply`は明示 | 入口を統一しても暗黙applyにしない |
| defaultと出力 | CLIとAPIのdefault差、commandごとのJSON | 解決後profileを可視化。旧default/JSONを保持し、新入口だけ版付き共通結果へ |

単一parserに押し込むだけでは、API呼出し・ファイル作成後に不正設定が分かる問題を防げない。helpと設定解決を副作用のある実行から分離し、`--dry-run`で解決後profileを示せるようにする。dry-runではモデル・検査command・VM・applyを実行せず、出力directoryやdurable DBも作らない。入力manifestや保存済みprofileの読取は行う。これはtaskの成功や実環境の疎通を保証する機能ではない。

## 早期失敗の観測は、別の実験にする

提案の価値はあるが、現在はwave全体を発射してから待つ。C件が既に発行済みなら、早く失敗を見つけてもそのC件の消費は消えない。最初の誤作業を減らすには、少数先行実行や異なる受付方針も必要になり、それ自体が並列度と待機時間を変える。

まず現行waveのまま、候補失敗の発生時刻・観測時刻・介入時刻・旧前提で受け付けたcall数を保存する。その後で早期観測のみ、少数先行受付つき、現行waveを同じN/C・仕事・予算で比べる。使える兆候は公開の局所検査やhostの機械的観測に限り、final oracleを途中のセンサーにしない。無関係な部分まで停止させる誤検出も測る。

依存発見、worker出力拡張、scheduler変更を同時に導入すると、改善の原因が分からなくなるため、最初の依存発見実験には早期受付制御を混ぜない。

## 次の順序と、判断の分岐

最初の変更はCLIの互換整理。次にrepoの検証契約をhost実装で固定し、静的依存走査・追加読取・未解決状態を小さな縦の経路で実装する。決定論的な反例とN=4のLuna疎通後、N=16を中心に8/16/32・C固定で観測する。

発見込みの方式が、正しいgraphを事前指定した対照の成功品質を維持できなければ、人数を増やす前に発見入口とcontextを見直す。品質を保てても読取・検査・上位の費用が増えるなら、その不利を報告する。全targetの指示を全員が読む量も含める。完全な地図を不要にしたという主張は、target分解と書込範囲を人間が与えている間は行わない。

Dockerの一般repo接続、並列durability、全runnerのpolicy/store統合、最小AND/OR根拠管理、常設Shadow Astra、64体探索はこの最初の範囲から外す。必要性が測定または利用条件で明らかになったものを、同じ固定受入の下で別の変更として進める。

## 今回の確認記録

Node.js v26.0.0で`npm run check`を実行し、型検査・434テスト・原資料2snapshotの照合が成功した。`--help`の5経路を実processで確認した。これは現行版の再検証であり、計画内の新CLI・依存発見・検証契約が実装済みという意味ではない。

添付`pasted-text.txt`のSHA-256は `abf469a399bc00a0b2cae451789d2aae0d36f1c1ef1c8715de5e6fe4fc381d5c`。添付全文は既存の2原資料snapshotへ追記していない。元資料の固定hashは[manifest](references/manifest.json)に従う。
