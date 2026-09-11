# 任意Gitリポジトリで実行する

`npm run repo -- --repo PATH --task TASK.json` は、指定したGit作業ツリーのファイルを既存のswarmへ渡す。専用のTypeScript fixture factoryを書く必要はなく、言語ごとの検査はtask JSONのコマンドで定義する。API workerには指定したファイルだけを送り、検査には作業ツリーのsnapshotを使う。

## 実行例

対象repoに `src/value.mjs` と固定の `tests/value.test.mjs` がある場合、taskは次の形になる。taskファイル自体は対象repoの外に保存してよい。

```json
{
  "version": 1,
  "goal": "value関数が負数を0に丸めるようにする",
  "files": [
    {
      "path": "src/value.mjs",
      "instructions": "既存のexportを保ち、負数は0、非負数は入力値を返す。",
      "checks": [{"argv": ["node", "--check", "src/value.mjs"]}]
    }
  ],
  "context": ["README.md"],
  "protected": ["tests/value.test.mjs"],
  "checks": [{"argv": ["node", "--test", "tests/value.test.mjs"], "timeoutMs": 30000}]
}
```

```sh
npm run repo -- --repo /path/to/project --task /path/to/task.json \
  --runtime opencode-go --worker-model deepseek-flash --go-thinking enabled \
  --workers 4 --concurrency 2 --max-calls 12 --max-meta-calls 0 \
  --max-tokens 200000 --reserve-tokens 30000 --max-tokens-per-call 16000 \
  --timeout-ms 180000 --output .sheep/my-repository-run
```

Go DeepSeekは省略時もthinkingを有効にする。`--go-thinking disabled`で過去条件を明示的に再現できる。このrepo optionはworkerにだけ転送する。Go adapterを使う他runnerやGo DeepSeekのupperも、明示指定がなければ有効になる。過去のdisabled実測は元の条件のまま保持する。

Goのkeyは`OPENCODE_GO_API_KEY`を使う。CLIは認証storeを自動で読まない。`opencode-go/deepseek-flash`という指定はruntime `opencode-go`とraw model ID `deepseek-flash`へ分ける。keyを引数やtaskへ書かない。

別ディレクトリからは `node /path/to/sheep-swarm/src/repo-cli.ts ...` と呼べる。`--help`はモデルを呼ばない。このrepo用CLIは`swarm`の合成課題CLIと別の入口である。

## taskの決め方

- `files`は変更対象の明示リスト。各ファイルに具体的な指示を書く。新規ファイルも指定できる。
- `dependsOn`は他の変更対象への依存。providerを先に更新し、その版をconsumerへ渡す。targetを`context`にも列挙しても暗黙の相互依存は作らず、順序は`dependsOn`で指定する。循環は事前に拒否する。
- `context`はworkerへ読ませる既存ファイル。必要な仕様・型・上位の`AGENTS.md`等を明示する。対象repoの指示はtaskを作るAgentが先に読む。
- `protected`は固定の受入テストやその設定。変更対象と重ねられない。受入結果を左右するscript・設定・testを保護対象に含める。
- ファイルごとの`checks`は局所検査。省略時はファイル範囲と構造の検査だけなので、局所確定は意味上の成功ではない。
- 最上位`checks`は全成果物を合わせた最終受入。最低1つ必要で、全件成功したときだけrun全体を成功とする。失敗を根拠に検査条件を緩めない。

コマンドはshell文字列ではなくargv配列で指定する。たとえばPythonなら `{"argv":["python3","-m","unittest","discover","-s","tests"]}` を使える。検査に必要な依存の準備も利用者が明示する。自動で`npm install`等を追加しない。既存の`node_modules`やignoredな仮想環境はsnapshotへコピーしない。

候補には`.git`をコピーせず、親ディレクトリのGit repositoryも探索しない。`git diff --check`等を元repoの検査として暗黙に成功させることはできない。Git履歴を必要とする検査は、このsnapshot方式の外で準備する。

失敗した局所検査のstdout/stderrは最大8192文字を次の修復workerへ渡し、全体の最終検査は修復ループへ戻さない。検査コマンドの起動失敗・候補保存先のI/O障害は`executionFailure`として記録し、発行済みの呼出しを精算した後、新しいworker/upper呼出しを止める。通常の非zero終了や候補コードの不正は局所修復の対象に残る。

## 出力と書き戻し

既定では元repoを書き換えず、runディレクトリに次を残す。

- `profile.json`: runtime・model・thinking指定・各種上限。
- `result.json`: 全体成功・書き戻し状態・変更パス・検査と使用量。
- `artifacts.json`、`changes.json`、`task.json`、`budget.json`: 候補内容、変更前の根拠、固定task、受付予算。
- `swarm/`: 既存kernelの状態、callごとのreceipt、個体ごとの履歴。
- `checks/`: 検査した候補workspaceとstdout/stderr。

実行時に`--apply`を付けると、全体受入と使用量検査の成功後にだけ変更対象を書き戻す。HEAD、snapshot内の元ファイル、削除状態、新規targetの衝突等を再確認し、実行中に元repoが変わった場合は失敗として候補を残す。未指定のuntrackedファイルを消さない。複数ファイルの書き戻しはOSのtransactionではなく、同じrepoを同時編集する用途を保証しない。

最終検査に失敗したrunや使用量不明のrunは書き戻さない。再開機能はなく、既存durable runnerのSQLiteとは別の経路である。予算予約は受付制御であり、provider側の強制的な料金上限ではない。Goの利用枠や請求額をtokenから推定しない。

## 対応境界

Node.js 24.12+とGitが必要。検査コマンドは利用者が信頼するhost subprocessとして動き、OS sandboxではない。API credentialを検査環境へ渡さず、候補内の元ファイルの書換えも検査するが、任意の悪意あるコードのhost隔離を保証しない。Docker runtimeはこのrunnerでは拒否する。

POSIXでは検査コマンドごとにprocess groupを分け、正常終了・失敗・timeout後に残る同じgroupの子processも終了させる。別sessionへ離脱したprocessやWindowsのprocess tree回収は保証しない。検査で常駐serviceを残す用途には使わない。

trackedな通常ファイルの現在のbytesと、明示したcontext/protected/targetを採用する。既存のtracked変更・削除を反映し、無関係なuntrackedやignoredファイルは含めない。binaryはsnapshotとして保持できるが、workerが読むtarget/contextはUTF-8 textに限定する。symlink・submodule・特殊ファイルは拒否する。`.git`、`.sheep`、`.env*`、`node_modules`は対象外。snapshotは最大10000ファイル・128MiB、workerへ渡す各textは2MiBまで。

任意の言語へ検査コマンドを設定できることと、あらゆるbuild環境・依存関係・リポジトリで成功することは別である。固定した対象範囲・検査の受入結果として報告する。

## task v2: 局所contextと根拠付き追加読取

共通入口 `npm run sheep -- repo ...` と旧入口の両方で利用できる。[CLIの対応表](cli.md)も参照。v1は全targetへの明示context、全manifest入りgoal、content/note応答を保持する。v2は上のtaskを `version:2` にして、次を追加する。

```json
"discovery": {
  "mode": "static+reads",
  "readable": ["registry.json", "policies/retail.json"],
  "maxReadCalls": 2,
  "maxPathsPerRead": 1,
  "maxDeliveredBytes": 65536
}
```

`readable`は本文を配信してよい既存ファイルの明示集合。targetと共通contextも公開catalogに入り、workerには最初から全catalogの**名前**を見せる。本文は担当target・固有の指示・共通goal/guidance/context・必要な依存先だけを渡す。他targetの指示、未公開の固定検査は渡さない。protectedを追加公開するには、従来どおりcontextにも明示する必要がある。source snapshotのUTF-8・サイズ・path・symlink等の検査を通す。

`.mjs`の静的import/reexportをNodeの構文parserで、`.ts`/`.mts`（`.d.ts`含む）のimport/reexportと型importを固定typescript 7.0.2の仮想projectで走査する。link/evaluateせず局所依存を求める。`node:`組込みはrepo依存に含めず、相対pathは拡張子付きの公開ファイルへ解決する。bare package、解決不能参照、対象に到達する循環は有限の拒否となる。初期targetの解決不能参照/循環はrun全体のpreflightを止める。TSの動的import呼出し/import-equalsは未解決として拒否する。TSX/CTS、package/tsconfig paths解決、他言語、意味依存の完全性は保証しない。関係のない公開ファイルもhost indexでは走査するため、走査量と配信量は別の指標になる。

`static`はモデルの追加readを拒否し、`static+reads`は許可する。どちらも新しい静的importを含むwriteの依存先が未配信なら、そのwriteを確定せず追加配信へ戻す。`maxReadCalls`はtargetごとのread応答と、このhostによる追加配信要求の合計上限（既定2、最大32）。配信は次の通常worker callで行い、そのcallも下位回数・token予算へ計上する。`maxDeliveredBytes`はtargetごとに配信を確認できた追加context本文の**累積**bytes上限（既定65,536、最大2MiB）。再配信も数え、担当target・固有指示・goal/guidance・明示共通contextは除く。全promptの出力量上限ではない。

workerは一度にwrite/read/uncertainの一つだけを返す。provider adapter共通のschema部分集合に合わせ、wireには必ず7fieldを置く。使わない配列は`[]`、文字列は`""`。hostが厳密な判別unionへ変換し、混合actionを拒否する。

```json
{"kind":"read","content":"","paths":["registry.json"],"observed":[],"missing":[],"hypothesis":"","note":"policyの所在を確認する"}
```

writeではcontentとnoteのみ、uncertainではobserved/missing/hypothesis/noteのみを埋める。uncertainのmissingは1項目以上。仮説は未確認のmodel-claimとして保存し、blocking claimで完了を妨げる。上位は通常の反復失敗観測時に限定してこの記録を見られるが、workerが上位を直接呼ぶactionはない。claimはworkerの現版に対するhost検証・kernel確定後に閉じ、上位の発言だけでは閉じない。

read要求の受理と本文の配信記録を分ける。成功したprovider応答が返ったcallについて、実際に送ったcheckoutのversion/evidenceEpoch・本文hashを記録する。予約拒否や応答のないtransport失敗を、配信確認済みとは数えない。usage不明は従来どおり受付と成功を止める。配信確認時にproviderが変わっていればkernelにcatch-upの仕事が発生し、古いread stampのwriteは拒否される。発見でwrite leaseは増えず、過去の依存edgeを自動で削除しない。

v2の出力には `dependency-evidence.json`（parser証拠と配信に基づく依存）、`read-deliveries.json`（要求・拒否・配信）、`uncertainties.json`（未確認の観測と解決証拠）を追加する。作業中のsnapshotは`swarm/`にも残る。`result.json.discovery`は走査量、選択/起動target数、workerのLocal-files JSONのcontext bytes合計/p95/最大、固有配信依存数を示す。context bytesにはpromptの指示、履歴、schema等は含まれず、provider tokensと同一ではない。成功runでも最初は全選択targetを起動する。起動自体を静的差分だけに絞る仕組みではない。

v1/v2とも `result.json.verifications` にcandidateDigest、checksDigest、environmentId、local/final、pass/reject/infrastructure-error、cleanupを保存する。候補のbytes/mode・固定command/timeout・実行環境識別が一致しないreceiptは受け入れない。cleanupはprocess-groupの終了処理を試みた記録であり、別sessionまで完全回収したという証明ではない。

固定した疎通用repoは `node scripts/prepare-repo-discovery-pilot.mjs --output NEW_DIRECTORY` で作れる。親directoryは先に用意する。基準解は公開repoへコピーしない。[実装と実モデルの結果](results/repository-discovery.md)には失敗試行と親の修正も含める。

`maxPathsPerRead`は1要求に列挙できるpath数（1..32、省略32）。モデルのreadとhostが新しいimportから作る追加要求の両方に適用し、超過時は部分配信せず未解決にする。1pathから辿る静的推移依存や、既に指定した初期contextの量はこの数で切り捨てない。総配信量や総tokensは別に測る。[段階読取と広域対照の手順・実測](results/read-selection-pilot.md)。

### 必要なtargetだけを初期起動する

v2で `"activation":{"changedPaths":["policy.ts"]}` を追加すると、公開scope内でhostが指定した起点から静的依存・明示dependsOn・共通contextを逆向きに辿り、初期goal変更で起動するtargetを選ぶ。省略時は全target、空配列は既知の変更起点なし。未対応言語targetは保守的に起動する。`activation.json`に初期選択を保存し、実際に呼ばれた数はresult.discovery.activatedTargetsで別に記録する。

changedPathsはGit差分の自動検出ではなく作業者の宣言。書込範囲はfilesのままで、未起動のtargetも全体oracleへ含める。隠れた意味依存の見逃しや不正な元コードをidleだけで成功にしない。[実走と境界](results/repository-scale-activation.md)。

TS targetの局所検査は `node --check` だけに頼らず、実行環境のmodule読み込みや型検査を明示する。新しいuntrackedのテスト/依存もcontextまたはprotected等へ指定し、snapshotへ含める。検査programが存在しない入力を無視する場合、processのexit 0だけでは意図したcaseを実行した証拠にならない。


### 公開された下流失敗から上流を再検査する

task v2に`"recovery":{"maxUpstreamRechecks":2}`を追加すると、公開local checkの不合格から配信済みの上流targetを再起動する。各providerはrun内1回、全体で指定数まで。省略すると従来の動作。`activation.changedPaths`で初期起動しなかったproviderも、宣言済みの書込対象なら再検査できる。試行回数・token・追加context bytesの上限は引き継ぐ。内部の診断artifactの再配信も追加bytesに含める。

`swarm/upstream-recovery.json`が起動理由・対象・検証receiptを保存し、内部artifactに公開command・診断・観測版が残る。候補のコード権限や非公開final検査は変わらない。公開checkを通る誤りにはこの方法だけでは対応できない。[検証・実走](results/upstream-recovery.md)。
