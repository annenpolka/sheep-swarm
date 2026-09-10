# OpenCode Go runtime

OpenCode GoのAPIへ直接接続する、明示選択のworker runtime。`swarm`・`compare`・`durable`・`mechanism`で`--runtime opencode-go --worker-model <生API model ID>`を指定する。既存のCodex/Docker/DeepSeek runtimeを維持する。

## 認証と実行

環境変数`OPENCODE_GO_API_KEY`にGoのAPI keyを設定する。keyをCLI引数やrepositoryへ書かない。adapterはOpenCodeの認証storeを自動で読まない。

```sh
npm run swarm -- \
  --runtime opencode-go --worker-model gpt-5.6-luna \
  --workers 4 --concurrency 2 --size 4 \
  --max-calls 8 --max-meta-calls 0 --max-tokens-per-call 4096 \
  --timeout-ms 90000 --output .sheep/my-go-swarm

npm run compare -- \
  --runtime opencode-go --worker-model gpt-5.6-luna \
  --method single-worker --size 2 --max-calls 4 --max-upper-calls 0 \
  --max-tokens 50000 --reserve-tokens 12000 --max-tokens-per-call 4096 \
  --output .sheep/my-go-single

npm run durable -- \
  --runtime opencode-go --worker-model gpt-5.6-luna \
  --directory .sheep/my-go-durable --size 2 --workers 2 \
  --max-calls 6 --max-meta-calls 0 --max-tokens-per-call 4096
npm run durable -- --directory .sheep/my-go-durable --resume

npm run mechanism:experiment -- \
  --budget-mode tokens --runtime opencode-go --worker-model gpt-5.6-luna \
  --families static --methods sheep --groups 1 --workers 4 --concurrency 2 \
  --max-tokens 100000 --reserve-tokens 12000 --max-calls 16 \
  --max-meta-calls 0 --max-tokens-per-call 4096 --timeout-ms 90000 \
  --output .sheep/my-go-mechanism
```

上位は既定でCodex/Astra。上位もGoにする場合は`--meta-runtime opencode-go --meta-model <生API model ID>`を明示する。workerとmetaのmodelが同じでも、roleとsessionは別に記録する。

接続先は既定`https://opencode.ai/zen/go/v1`。テストや明示proxyには`OPENCODE_GO_BASE_URL`またはadapterの`baseUrl`optionを使う。httpsとloopback httpのみ許可し、credential・query・fragmentを含むbase URLは拒否する。Go keyをDeepSeek用環境変数へ入れる必要はない。

## API形式とsession

モデルごとのAPI形式は明示catalogで選ぶ。主な対応は次のとおり。未知のmodelや`opencode-go/`付きIDは通信前に拒否し、別modelや別providerへ自動置換しない。

| API形式 | model例 |
|:---|:---|
| Chat Completions | `deepseek-flash`、`deepseek-v4-flash`、`glm-5.3-flash`、`kimi-k3` |
| Responses | `gpt-5.6-luna`、`grok-4.6` |
| Messages | `minimax-m3`、`minimax-m2.7`、`qwen3.8-max` |

出典: [Goの公式endpoint一覧](https://opencode.ai/docs/go/#endpoints)。catalogは実装時点の対応表であり、providerが将来追加するmodelを自動で認可するものではない。vision名のmodelでも本adapterが送るのはtextだけ。

[公式クライアント要件](https://opencode.ai/docs/go/#where-can-i-use-it)に合わせ、`User-Agent: sheep-swarm/0.0.0`と`x-opencode-session`を送る。sessionはrunとworker/roleからなるopaque IDで、同じworkerの継続callで安定し、他workerや別runと区別する。repository pathをsession headerへ送らない。durableはseedをsnapshotへ保存して再開後も同じsessionを使う。Go snapshotのseed欠損を新規sessionでごまかさない。

このsessionはproviderのrouting/cache用識別子である。adapterは各callへ明示された局所promptとschemaを送り、provider側に隠れた会話履歴があることを前提にしない。tool、shell、ファイル探索はモデルへ渡さない。

## 検証と予算

返却されたJSONを既存schemaで検証し、runnerの固定oracle・kernel確定条件を通す。応答modelのaliasは要求modelと別に保存する。HTTP失敗・429・timeout・取消・不完全応答を成功へ変えず、adapterはretryや別課金経路へのfallbackを行わない。出力上限は各callで明示し、応答保存は4MiBに制限する。

Goの使用量は`runtime: opencode-go`とAPI形式を付けて記録する。Messagesの総入力はuncached inputとcache read/writeの合計、Chat Completions/Responsesのcacheは入力の内数として扱う。reasoningは出力の内数。[Messagesの計数根拠](https://platform.claude.com/docs/en/api/rate-limits)。使用量の欠落・不整合は0や無料とせず、新規受付を止める。

mechanismのGo実行にはtoken予算が必須。Go subscriptionの枠をCodex creditやDeepSeek直接APIの価格へ換算しない。金銭の実請求額やGoの残り利用枠はtoken集計からはわからない。Go console側の追加残高利用設定も、この実装から変更しない。

通常の`npm run check`は注入fetch/callerと固定fixtureを使い、実key・実課金を必要としない。実APIではGo経由のLunaで4条件・13callが成功した。[実行記録と未確認範囲](results/opencode-go.md)を参照。
