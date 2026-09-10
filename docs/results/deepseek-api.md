# DeepSeek直接APIの接続確認

この文書は初回接続時点の記録。以後のrunner横断対応は[追加の実行記録](deepseek-runners.md)を参照。

2026-09-10。`swarm`へtool-lessのDeepSeek直接API接続を追加した。既存のCodex/Dockerと固定oracleを維持し、DeepSeekはmodelを明示した場合に選ぶ。`compare`・`mechanism`・`durable`への接続と価格比較は未実装。

## 実装と独立検証

利用者指定の`opencode-delegate`で`deepseek/deepseek-v4.1-flash-expires-on-0910`へadapter、swarm/CLI接続、テスト、文書の初稿を委譲した。OpenCode 1.18.29、session `ses_f76551045ffeVsWQ2LVtScEAeW`。relayの結果は`completed`。CLIのcost欄は0だったが、実請求額や無料を意味しない。

呼出し側が追加した[独立した境界テスト](../../tests/deepseek-boundaries.test.ts)で、providerが反射したcredentialの漏れ、不正なcache/reasoning counter、assistant以外の応答を再現した。実装側が修正し、正常なreasoning counterがcompletionへ二重加算されず受理されることも確認した。呼出し側は文書の表現・導入例を整え、CLIからloopback HTTPまでの接続を別途検査した。

- `npm run check`: 呼出し側で再実行してexit 0。303テスト、型検査、2つの参照snapshot照合が成功。
- 既存のtests/experiments/referencesの40ファイルと、独立した境界テストのhashを照合。意図しない変更なし。
- CLIからloopbackへの3呼出しで固定基準解が成功。`/v1/chat/completions`、要求model、4096のtoken上限、異なる応答model名の記録を確認。
- loopbackのusage欠落では1呼出し後に受付停止・run失敗。非対応local toolsは通信前に拒否。
- `git diff --check`: 成功。

## 実APIでの小さな課題

`DEEPSEEK_API_KEY`をchild process環境だけに渡し、次の条件で実行した。検証時には呼出し側が既存認証を明示的に利用したが、adapter自体はOpenCodeの認証storeを読み込まない。

```sh
npm run swarm -- --runtime deepseek --worker-model deepseek-v4.1-flash-expires-on-0910 --workers 1 --concurrency 1 --size 2 --max-calls 4 --max-meta-calls 0 --max-tokens-per-call 4096 --timeout-ms 60000
```

| 観測 | 結果 |
|:---|:---|
| 課題 | measurement-migration-v1、直接consumer 2つと集約1つ |
| 下位／上位call | 3／0 |
| 固定oracle・kernel確定 | 3/3成果物が成功、最終errorなし |
| runner実行時間 | 4,826 ms（単一試行） |
| HTTP・usage | 全3応答が200、usage完全 |
| input／output／total tokens | 2,970／662／3,632 |
| cache hit | 0 tokens |
| 要求model | `deepseek-v4.1-flash-expires-on-0910` |
| provider応答model | 全3応答が`deepseek-flash` |

要求IDと応答名の一致、betaの実backend、期限後の可用性は確認していない。上位の実API介入、並列規模、有用性、費用優位、請求額もこの試行からは判断しない。

生のrunはローカルの`.sheep/deepseek-smoke-2026-09-10T05-03-00.720Z/`、委譲証拠は`.sheep/deepseek-delegation-2026-09-10/`へ保存した。いずれもGit対象外であり、公開物へ自動添付しない。接続仕様の出典は[DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)。
