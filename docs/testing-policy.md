# 検証方針

kernelの独立した反例試験、実Node fixture、Codex adapter、scheduler、SQLiteの契約試験を実装した。固定oracleでのSIGKILL11境界と実Lunaでの中断・再開も確認した。実測はdocs/resultsへ分けて記録する。並列runnerの再開と一般repositoryでの有用性は未確認。

## 日常のgate

```sh
npm run check
git diff --check
```

`check` はTypeScript型検査、Node.js test runner、資料snapshot照合。`npm run demo` で参照モデルの遷移を観察できる。

## oracleを先に置く

- 受入条件、failure schedule、期待結果をkernel実装の前に固定する。
- 参照モデルはexperiments配下に置き、srcのproduction関数を再利用しない。
- write skewの対照実験は全6順序中4件で失敗すること自体が期待結果。安全な方式だけ残して対照を消さない。
- fixtureやoracleに誤りがあれば、実装修正と区別し、理由と影響を記録する。
- stubの都合に合わせて要求を緩めない。未実装gateは未実装と明記し、skipを成功として数えない。

## kernel実装で必要なケース

M1では以下のうちcrash/restartを除くin-memoryの性質を確認する。durabilityとcrash/restartはM4の完了条件とし、それ以前の中断runを成功や再開可能とは扱わない。

| ケース | 観測すべき性質 |
|:---|:---|
| 無関係artifact | 影響のないworkerを不要に起こさない |
| write skew / stale read | write-setだけでなく判断の前提と統合制約を検査する |
| 重複・逆順通知 | 二重確定と巻き戻った観測版を防ぐ |
| seen後のcrash | 未処理義務から再開する |
| 変更直後の依存登録 | 現在版との差分を処理対象へ入れる |
| 失効lease | 古いepochでの確定を拒否する |
| 未解決claim | 時間経過や別のdoneで消えない |
| 根拠の訂正 | 過去のconsumerと完了証拠を再確認する |
| hidden dependency | 発見するか、外側の受入検証で失敗を捕捉する |
| 無害な循環 / 振動 | 通常の循環を許し、進捗のない反転を検出する |
| 全員idle、配送途中 | 成功を宣言しない |
| ignoredの次に影響あり | 真の依存を削除していない |
| 上位への相談なし | 下位の通常処理に上位呼び出し・返答待ち・全件承認を要求しない |
| 観測による介入 | 通常の履歴から反復失敗等を観測し、条件変更を関連対象へ反映する |
| 介入と古い提案の競合 | 変更された前提・権限による確定を拒否し、必要な証拠を再評価する |
| 上位の古い観測 | 上位も参照版・権限の検査を通し、共有状態を直接上書きしない |
| 介入適用前後のcrash | M4で、介入と通知の取りこぼし・重複適用を防ぐ |

時刻は注入し、sleepでlease試験をしない。状態遷移、拒否理由、artifact版、未処理義務を検査する。固定出力によるreplayと、LLMの再呼び出しは別の実験である。

## 実LLMでの評価

役割分担と規模の既定値は [現在の方針](current-direction.md) に従う。下位4体は動作確認、最初の本実験は下位16体＋上位1体、初期比較は8・16・32体、64体は次の探索候補。実動作の下位は利用者指定のgpt-5.6-lunaに固定し、上位はgpt-6-astraを作業上の既定値とする。Codex CLIの要求モデルと、実際に返ったモデル識別の証拠は区別する。

### 規模探索

同じ仕事で人数を変える比較と、人数に合わせて仕事量も増やす比較を分ける。同じ上下モデルの組、道具、権限、外側の受入条件、上位1体の介入ルールと予算上限を使い、シナリオを複数回実行する。人数N、最大同時実行数C、実際の稼働数、rate limitやtoolの待ち時間を記録する。Cも変えた比較と、Cを固定してNを変えた比較を区別する。

観測するのは品質と完成時間に加え、担当の移動・重複・集中、個体ごとの読む範囲、誤りと訂正の到達範囲・遅延、変更の往復、未解決作業、介入後の復旧、上下の費用。上位の指示による分業と下位の自律的な担当変化を区別する。固定役割で観測したい分業を先に作り込まない。

人数に合わせて仕事量を増やす条件では、1体あたりの仕事量と依存構造の性質をできるだけ揃え、仕事量あたりの上位負担と滞留を確認する。総計算量も報告し、増員による速度向上だけから費用効率を結論しない。

### 有用性の対照

| 対照 | modelと方式 |
|:---|:---|
| 単一Agent | Luna 1体で実行する。Astra単独は費用の目安を得たため今後の試行から省く |
| Manager-local | 同じ上下モデルの組と下位数を使い、管理側が割当・集約する |
| Sheep-fixed | 既知の依存に沿う下位の群れ＋観測して介入する上位 |
| Sheep-full | 同じ構成で未知の依存の発見も行い、その費用を含める |

道具、権限、外側の受入条件、総予算を揃える。複数Agentの対照間では下位数とCも揃え、単一Agentの実行並列度の違いは記録する。Broadcastは必要な場合の診断用とする。

### 品質と介入の扱い

成功率を主制約に置き、下位・上位の総token、tool費用、依存発見、観測と読み直し、介入、retry、監査、人間の準備時間を含める。潜在影響先数、起動数、入力tokensを異なる単位のまま一つの比率にしない。

上位の運用メタ管理はprotocolの一部として計上し、その介入だけでrunを実験外の救済扱いにしない。人間や実験外のAgentから意味的な助言を入れたrunは別に集計する。任意のshadow observerの出力をworkerや運用メタ管理が読める場所へ置かない。

外側の受入条件はrun前に固定する。上位の作業仕様の修正が、採点条件の緩和を通じて失敗を成功へ変えていないことを確認する。仕様が本当に変わる比較は別条件として記録する。

少数のpilotで構成を直してから、調整に使っていないtask・repoでpaired比較する。短い成功例からproduction有効性を主張しない。


## 費用見積器の検証

公開レートを日付と出典付きで固定し、input内のcache read/write、output内のreasoningを二重計上しない。欠けたキャッシュ量は範囲、欠けた価格・receiptは未知として表示する。存在しないroot、manifest内run欠落、hash不一致を費用0にしない。実請求・利用枠の実測と仮想レート計算を区別し、原本を変更せず別集計を保存する。

次の比較は[課題研究](task-design.md)のholdout・oracle監査と、単体Luna・記憶/介入/並列数の対照を使う。既存の`swarm`/`compare`のtoken上限と、新しい`mechanism`のcredit相当受付は別の機能である。

`mechanism`では旧実装失敗、基準解成功、単位・境界・null・キー衝突等の変異拒否を検査する。可視検査と最終検査の値を分け、最終検査の失敗を修正用フィードバックへ戻さない。全5方式、局所権限、既に正しい対象への単独モデルの増分提案、実際の参加回数、段階を跨ぐ私有履歴、未知usageの停止を検査する。

dispatcherは結果・レシート・保存ソースのhashを確認し、中断や欠落を費用0へ変えない。承認された追加100相当の系列では、元の不明1件を別の履歴に保持し、新たな不明分が出たら再び停止する。元のsrc/価格表の同一性と、追加系列の過去費用の取りこぼしも検査する。実モデルの[結果と未実行条件](results/mechanism-findings.md)はテスト成功と分けて記録する。

## Docker Agent Sandboxのgate

通常`npm run check`にはNDJSON、per-message usage/cache、設定IDと実model証拠の区別、schema・path・出力量・timeout/取消を追加した。DockerやLLMを通常gateの必須依存にはしない。

`npm run sandbox:probe`は実microVMでhostファイル・SSH・外向き通信拒否、timeout後の削除、次のVMへの状態非継承を検査する。別VMの固定oracleで旧実装失敗・基準実装成功・always-empty/null-only変異拒否を検査する。`npm run sandbox:pilot`は実Lunaの局所tool作業と、別VM受入を経たkernel確定。tool-lessの`swarm --runtime docker-agent`は登録4体・C=2で確認した。

モデルの回答と実workspace差分、可視テストと外側oracle、レシートの設定modelとproviderの実model証拠を分ける。Lunaはruntimeの価格catalog上unpricedであり、cost=0を無料と読まない。timeoutの途中usageは既知下限で、未完了推論を含む総費用として集計しない。[実測](results/docker-agent-sandbox.md)に初回失敗と修正後の検証を残す。

道具付きswarmでは、固定oracleの値・case・閾値・比較を変更せず、観測する実行環境だけを差し替える。通常gateは従来と同じ変異拒否、実差分優先、担当外・テスト改変・削除の拒否、局所contextとread setの一致、usage不明・検証基盤障害時の停止を検査する。guest runnerの局所subprocess試験はVM隔離の実証には数えない。

`npm run sandbox:swarm-probe`は実VMで合成fixtureの基準解成功・旧実装失敗・閾値変異拒否・host API import拒否・無限loopと回収を検査する。setup失敗を変異拒否の成功へ数えない。実Lunaの道具付きswarmは別runに保存する。受入VMは同期`.mjs`の局所importのみを扱い、任意repositoryの実行互換性を保証しない。

`sandbox:comparison-probe`はthermal fixtureの値・境界・必須importを実VMで検査する。等価な値を返す実装でも、importをコメントへ変えた変異を拒否する。通常gateで単独Luna・Manager-local・Sheep-fixed/fullのtool、role権限、oracle、途中usage・cleanup失敗の受付停止を揃える。一括dispatcherは同一profileを全条件へ渡し、使用量不明の最初の結果で後続を止める。

`sandbox:recovery-probe`は実child processをSIGKILLし、残留VMの回収、生存中のVMの保護、作成前crashの記録保持と遅延出現の回収を検査する。通常gateでは他host、PID生存、不正record、symlink、image不一致、削除失敗、同時回収を拒否・保留できることを確認する。VM資源の回収を、元runの成功・再開・usage復元とは扱わない。

DeepSeek直接APIの通常gateは注入`fetch`だけを使い、実network・実key・実課金を呼び出さない。要求body（model・JSON mode・`thinking`無効・`max_tokens`・tool不在）と、要求model／応答model証拠の区別、`finish_reason`不一致・schema違反・非JSON・応答過大・timeout・取消の拒否を検査する。base URLはhttpsとloopback httpだけを許し、credential・query・fragmentを拒否する。HTTP失敗は秘匿情報を伏せたbounded transcriptとし、fetchのcauseを転送しない。usage欠落・不整合は0にせず不明として、同時実行分の回収後に受付を止める。`swarm --runtime deepseek`は`--worker-model`必須・meta既定Codex・Astra拒否・不明usageでの受付停止を検査する。共通の`resolveRoleRuntimes`を注入callerの`compare`・`durable`試験でも使い、`compare`のrole計数（同一model idの下位・上位区別）、provider alias保持と`requestedModel`不一致拒否、`durable`のprofile永続化・完了resumeのzero call・不明usage lock・legacy format-1正規化・override拒否を確認する。`mechanism`はcredit予算seriesを凍結したまま、DeepSeek/混合upperを`--budget-mode tokens`で実行できる。注入callerの試験で、token予約の同時受付・重複ID拒否・観測下限・不明usageの恒久lock・cache split不在での完走・credit modeでのDeepSeek早期拒否・token/credit optionの混在拒否を確認する。token系列dispatcherは、集計予算内の逐次完走と、unknown usage・receipt欠落・子run失敗でのfail closedを注入child seamで検証する。実network・実key・実課金は呼び出さない。

## 現在の実行証拠の範囲

M3は既知依存の合成taskで、主比較15runと別pilot1run。M4はC=1の専用実行系。M5は温度・圧力の別合成task、下位Luna/上位Astra、共通500,000token上限、30,000tokenの受付予約で比較する。単一上位にも増分の局所確定を許し、最終全体受入を共通にする。

必須の静的importは外側oracleで構文解析して検査する。Sheep-fullの発見は明示されたimport/仕様依存の走査に限る。各方式の呼出し、再試行、上位読取、走査と受入時間を記録する。人間によるfixture/既知graph作成と開発Agentの費用は未測定として分離し、全工程の費用優位を主張しない。

CLIの途中errorの後にturn.completedとexit 0が来る回復経路を保持し、出力schemaも検査する。元runは再集計で書き換えず、使用量の復元は生レシートとSHA256を根拠にした別集計へ記録する。

`mechanism`のDocker検査は、3課題・3段階のhost oracleとの一致、負の時刻等の変異、必須import、非同期JSON読取、供給外ファイル拒否を含む。可視bundleの旧版/基準解、未読・旧版policyのケース非公開、選択したreadの先取り禁止、全methodの読取精算・read set・履歴、実差分の権限、最終失敗後の呼出し不在を検査する。上位のtool-less/guidance権限、使用量不明・cleanup失敗・検証基盤障害の受付停止も通常gateに含む。`sandbox:mechanism-probe`はモデルなしで8つの実VMを作成・検査・削除する。実Lunaと通常gateの証拠は[結果](results/docker-agent-mechanism.md)で分ける。

既存swarmの実装課題では、固定した未実装stubの失敗、担当外変更の拒否、返却された2 helperの可視・追加ケース（入力不変、途中/重複tool、未知応答、prototypeに衝突する名前、不完全なstage/budget証拠）を検査する。集計CLIは欠落レシートを無視せず、元runのunknown usageから完了を推定しない。helper本体の作者と、親が書いたfactory・oracle・CLI接続を分けて記録する。

OpenCode Goの通常gateは3形式の注入fetchとrunnerの注入callerで行う。sessionの同一worker内継続・worker間分離・durable再開、認証情報の反射時redaction、不正role/tool出力、usage算術、HTTP失敗・429・timeout・取消を検証する。既存DeepSeek snapshotの移行と、Go snapshotのsession欠損拒否を別ケースにする。live APIは既存認証を親processで明示使用し、通常gateから分離した小さな固定課題に限定する。

Astraの独立レビューで固定した反例も通常gateに含める。混合API/Codex上位のusage欠落・数値付き途中終了・末尾JSONL破損は新規受付を止め、durableの予約・失敗receipt保存後の再開でも追加呼出を許さない。末尾破損はローカル偽CLIを実Codex adapter経由で検証する。規模比較の子run失敗・結果欠落・不正report・usage不明、上下を入れ替えたDocker cleanup、DeepSeekのtool/refusal混入とmetadata keyの伏字も検査する。[レビュー証拠](results/astra-go-review.md)。


## Repository adapterのgate

`repo-*.test.ts`は実tmp Git作業ツリーとNode subprocessを使い、manifestの不正値、dirty bytes・binary・mode・選択untracked・削除のsnapshot、symlink/parent置換、HEAD/index/bytes drift、新規衝突、候補改変、timeout、bounded stdout/stderr、credential環境の非継承を検査する。注入callerでkernel完了、明示依存順序、並列呼出し、予算の同時予約/拒否、不明usageでの停止、成功時だけのapplyを確認する。最終検査を重複実行しないことも確認する。既存swarmの却下案はread版付きでtargetごとに引き継ぎ、採用内容へ混ぜない。

通常gateで実APIは呼ばない。実Go DeepSeekのJavaScript/Python fixture repoは別証拠に保存し、実call・結果・指定ファイル差分・dirty/untracked保存を確認する。実装swarmの失敗と親の補修を分離し、最初の固定テストに加えた境界テストは要求の追加検査として記録する。[結果](results/repository-runner.md)。

`repo-review.test.ts`は独立レビューの回帰ケースとして、正常終了した検査の残留子process、候補から親Gitへの探索、検査コマンドの起動失敗と候補保存先のI/O障害後の呼出し停止、局所stderrと却下案の修復promptへの引継ぎを検査する。通常の不正overlayは検査基盤障害と混同せず、元の受入条件を維持する。[再現記録](results/repository-runner-astra-review.md)。

## M6 CLI / repository discovery

`cli-entry.test.ts`は新旧5入口を実processで起動し、help/dry-run、alias、JSON形状、終了コード、副作用前の不正設定拒否を検査する。durableの元DB/WAL非変更と完了resumeを含む。`cli-profile.test.ts`はruntime・token/creditと設定既定値を比較する。

`repo-discovery.test.ts`はv1互換・v2 manifestとtransportを分け、二段read、未公開本文の非配信、他target指示の非配信、call/bytes上限、旧read版と同bytesの旧evidenceEpochによるcatch-up、未解決claim、unknown usage、host検証後だけの解決を検査する。staticのみの意味read拒否と、新しいimportの未配信先がwriteと同時に先取りされないことも含む。上位へ渡すmodel-claimは未確認のまま扱う。

`repo-discovery-fixture.test.ts`は固定したbaseline失敗・基準解成功・意味変異拒否を確認する。`next-components.test.ts`は独立に固定した生成部品の受入と追加境界検査で、parserの評価不在・公開allowlist・循環、receiptの候補/command/環境/phaseのすり替え・偽pass・入力変異を拒否する。通常gateはAPI・認証を使わない。実Go swarmの失敗と成功、親の補修、独立候補再検査は[結果](results/repository-discovery.md)へ分離する。

## M7 read-selection pilot

`read-selection-*.test.ts`はopaque資料のworld間不変、全資料へのregistry切替、固定oracleの旧版失敗・基準解成功・別world推測と入力境界変異の拒否を検査する。maxPathsPerReadの既定/範囲、超過時の非配信、host新規import要求、1pathからの推移closureを含む。call IDの辞書順に頼らず、同targetの配信/要求/最初のcommit順、欠落・重複・未知参照を検査する。

実tmp Gitと注入callerで同じ課題の局所/広域を実行し、候補へ固定oracleを再実行する。改変delivery hashとunknown usageの監査拒否、元repo不変も確認する。通常gateはAPIを呼ばない。実Goの部品生成、親の補修、同品質pilotは[別証拠](results/read-selection-pilot.md)。構造上妥当なledger、手続き上の二段読取、意味的品質は独立の結果とし、文書配信をモデル理解の証明にはしない。

## M8 TS / scaling / activation

`remaining-*.test.ts`はASTでの通常/型import、reexport、型import式、非公開参照、構文不正、循環とソース非実行、疎な配列や入力変異、全opaque資料のregistry切替、TS moduleの実読み込みとJSON import attribute不備を検査する。changedPathsのscopeとv1拒否、関連targetだけの起動、受入後のprovider版の配信、元ファイル不変、0callの全体受入、見逃した意味依存による非成功を含む。

実Goの部品生成、TS自己実装、規模比較、影響起動は[別証拠](results/repository-scale-activation.md)。各1回の比較を反復や一般的な有用性にしない。既知usageの意味的失敗はそのまま記録し、未知usage/予約超過/検証障害と分ける。自己実装でsnapshotに含まれなかった追加testは、存在を検査する独立snapshotで再検証した。原runのcase数を増やして書き換えない。
