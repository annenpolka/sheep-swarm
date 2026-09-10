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
  --runtime opencode-go --worker-model deepseek-flash --go-thinking disabled \
  --workers 4 --concurrency 2 --max-calls 12 --max-meta-calls 0 \
  --max-tokens 200000 --reserve-tokens 30000 --max-tokens-per-call 16000 \
  --timeout-ms 180000 --output .sheep/my-repository-run
```

`--go-thinking disabled`はGo DeepSeek workerの推論モードを明示する。省略時はproviderの既定値。上位には転送しない。今回の実装試行では既定の推論だけで出力上限に達したため、この明示設定で生成を確認した。CLI全般への暗黙の既定変更はしていない。

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

trackedな通常ファイルの現在のbytesと、明示したcontext/protected/targetを採用する。既存のtracked変更・削除を反映し、無関係なuntrackedやignoredファイルは含めない。binaryはsnapshotとして保持できるが、workerが読むtarget/contextはUTF-8 textに限定する。symlink・submodule・特殊ファイルは拒否する。`.git`、`.sheep`、`.env*`、`node_modules`は対象外。snapshotは最大10000ファイル・128MiB、workerへ渡す各textは2MiBまで。

任意の言語へ検査コマンドを設定できることと、あらゆるbuild環境・依存関係・リポジトリで成功することは別である。固定した対象範囲・検査の受入結果として報告する。
