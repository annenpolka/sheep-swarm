# 共通CLI

`npm run sheep -- <command> [options]`から `repo`、`swarm`、`compare`、`durable`、`mechanism` を実行する。既存の `npm run <command> -- ...` も同じ設定解決へ接続し、既定値・JSON結果の項目・失敗時exit 1を保つ。

```sh
npm run sheep -- --help
npm run sheep -- repo --help
npm run sheep -- swarm --workers 4 --concurrency 2 --max-worker-calls 12 --dry-run
npm run sheep -- mechanism --budget-mode tokens --max-tokens 200000 --reserve-tokens 30000 --dry-run --format text
```

`--help`は必須引数を要求しない。`--dry-run`は設定を解決するだけで、モデル・受入コマンド・VMを起動せず、runの出力先を作らない。repoではtask JSON、mechanismでは指定した価格表を読む。これは実行環境の疎通検査ではない。repoのGit snapshot・既存出力先・ファイル境界・静的依存の検査は実行時のpreflightで行う。

| 項目 | 対応・意味 |
| --- | --- |
| `--workers N` / `--concurrency C` | 登録個体数と最大同時実行数。実稼働数は結果で確認。durableはC=1固定 |
| `--max-worker-calls` | repo / swarm / durableの下位call上限。旧名 `--max-calls` |
| `--max-total-calls` | compare / mechanismの全role合計上限。旧名 `--max-calls` |
| `--max-meta-calls` | 上位call上限。compareの旧名 `--max-upper-calls` |
| `--output` | 出力先。durableの旧名 `--directory` |
| `--apply` | repoのみ。固定受入・使用量・元repoの変更検査後に指定targetを書き戻す |
| `--resume` | durableのみ。保存された設定と異なるoverrideを拒否 |
| `--format json\|text` | 既定JSON。helpは常にテキスト |

同じoptionの重複や新旧aliasの同時指定は、値が同じでも拒否する。未対応option、NaN、負数、不正整数、N<C、単位混在、API worker modelの欠落、repo/durableのDocker選択も拒否する。swarmの旧来のcall/round/timeoutゼロ、mechanismの予算ゼロは維持する。詳細な既定値とruntime制約は各commandのhelpに出る。

新入口のJSONは `format:1, command, success, outputDirectory, configuration, limits, budget, result`。`result`が旧入口と同じ概要、`budget`が設定した予算で、消費実績は各runnerの結果にある。dry-runは `status:planned, dryRun:true, options, configuration, limits, budget, capabilities` を返す。`capabilities`は対応機能、`options.apply`は今回の適用指定。text形式は概要で、詳しい設定確認にはJSONを使う。

新入口は成功/help/dry-runがexit 0、入力・設定エラーが2、実行失敗が1。repo snapshot等の実行前検査の失敗も実行失敗に含む。旧入口はエラーがすべて1。stderrに診断、stdoutに結果を出し、旧dispatcherが読むJSONに新しいenvelopeを追加しない。

repo/compareはtoken予算、mechanismは明示したcreditsまたはtokens、swarm/durableにはaggregate予算はない。`--max-tokens-per-call`は出力上限であり総使用量ではない。creditは固定価格表からの条件付き換算で、実利用枠・実請求を表さない。

`durable --resume --dry-run`は、元DBとWALの安定したbytesを一時directoryへコピーしてjournalを検証し、コピーを削除する。元DBを開いてWAL/SHMを作ることはなく、古い`result.json`から設定を推定しない。`resumeState`は保存済み世代・usage lockを表示する。実行時にもrunnerが設定一致を再検査する。稼働中のDBの原子的なlive backupは保証せず、読取中にbytesが変われば再試行を要求する。

補助実験・sandbox・費用見積は従来のnpm scriptに残る。CLIの整理によって、一般repoにDocker隔離や並列resumeが追加されたわけではない。


repoの`--go-thinking enabled|disabled`はOpenCode GoのDeepSeek workerに限る。省略時は`enabled`となり、dry-runのoptionsにも明示される。上位のGo DeepSeekはadapter側の既定で有効になる。


## 複数targetのpacket実行

`repo --packet-size all|N`は[共通packet executor](repository-packets.md)へのopt-in。Go deepseek-flash・thinking有効・上位0に対応する。`--concurrency`は上限で、worker数は分割結果から決まる。`--dry-run`に実際のpacket割当・read範囲・依存・循環による上限超過を表示する。省略時の既存repo動作は保持する。

`repo --plan-work`は[semantic planner](semantic-decomposition.md)へのopt-in。`--packet-size`と`--workers`は併用不可。plannerがscopeを選び、重複write/循環をhostが統合する。dry-runはモデルを呼ばずworker数null・`planning.state=requires-model-call`を返す。plannerも総call/token枠と実行時間に含む。
