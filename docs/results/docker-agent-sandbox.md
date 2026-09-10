# Docker Agent Sandbox導入の実測

2026-09-10、macOS arm64。Docker Agent v1.137.0、sbx v0.42.1。導入手順は[こちら](../docker-agent-sandbox.md)。以下は導入の受入試験であり、比較実験や費用優位の証明ではない。

## 確認できたこと

| 検証 | 結果 |
|:---|:---|
| host CLI | v1.32.4からv1.137.0へ。旧pluginリンクをbackupへ保持 |
| sandbox CLI | v0.39.0からv0.42.1へ更新、Dockerログイン復旧 |
| バイナリ | 公式SHA-256、host pluginの版、VM内binary hashを照合 |
| 隔離 | host canary・host Codex設定が見えず、SSHソケットなし。外向き実HTTPはproxyの403 |
| lifetime | timeout後に個別VM削除。次の新規VMに前のworkerのmarkerなし |
| oracle | 旧実装失敗、基準実装成功、always-empty/null-only変異拒否 |
| 実Luna局所tool | 可視テスト失敗→read/edit→同テスト成功→structured output |
| 外側検査 | 実編集ファイルを別の通信拒否VMで11ケース検査、kernel確定 |
| 4体swarm | N=4、C=2、5 call、5 artifact確定、上位0、全体受入成功、55.097秒 |
| cleanup | 検証VMと個別secretを削除、最後の`sbx ls --json`は空 |

tool pilotの完了したモデル実行は117.881秒、input合計5,933、output合計333 tokens。報告された`content`には末尾改行がなかったが、実際の編集ファイルには改行があった。候補の根拠を実workspace差分に統一し、保存済みの同じ候補を新しい検証runで受け入れた。モデル呼出しのやり直しや元runの書き換えはしていない。

4体swarmの成功runはinput 3,930、output 1,148 tokens。registered 4体、最大稼働2体、同一個体の再利用を含む5 callである。全callで新規VMとsessionを使った。tool pilotとswarmは課題・道具が異なり、時間・tokenを有用性比較に使わない。

## 残した失敗・打切り

1. Sandboxの既存OpenAI OAuthだけではDocker AgentのChatGPT providerに認証が注入されず401になった。承認済みのhost側custom secret resolverで解決した。
2. 最初のadapter設定は`permissions`をagent内へ置いてschema parseに失敗した。config最上位に修正し、実CLIのdry-runで確認した。VM削除は成功した。
3. tool pilotの120秒試行は応答待ちが約93秒あったため最終出力中にtimeout。既に終わった5推論のusageは生レシートに残ったが、最後の推論は不明である。成功や総費用既知とは扱わない。
4. 240秒試行はモデル作業を完了したが、当初のpilotが最終回答と実ファイルの完全一致を要求し、末尾改行差で止まった。実ファイルを候補にする境界へ修正し、同一候補を別runで検査・確定した。
5. 4体swarmを4呼出しで打ち切った試行ではconsumer 4件は確定したが、後続reportの義務が残った。`pending-work`で失敗することを保持した。次の最大6呼出しrunは5回で完了した。
6. 最初のHTTP拒否probeはcurlのCONNECT失敗を想定したが、実際はHTTP 403として返った。期待値を観測したproxy拒否応答へ修正し、policy側のdenyと両方を検査した。

## 証跡

生レシートにはlocal path等を含むため`.sheep`に保持し、公開資料へ丸ごと複製しない。検証時のhash一覧は[docker-agent-evidence.json](docker-agent-evidence.json)。

| 検証 | repository相対path |
|:---|:---|
| 隔離・oracleの成功 | `.sheep/sandbox-probe-2026-09-10T01-24-37.551Z/result.json` |
| 120秒timeout | `.sheep/docker-agent-pilot-2026-09-10T01-22-17.155Z/sheep-docker-call-aPVzii/receipt.json` |
| 完了したtool作業 | `.sheep/docker-agent-pilot-2026-09-10T01-26-09.835Z/response.json` |
| 同じ候補の独立受入と確定 | `.sheep/docker-agent-pilot-2026-09-10T01-29-21.691Z/result.json` |
| 4呼出し打切り | `.sheep/docker-agent-swarm-four-20260910/result.json` |
| 4体swarm成功 | `.sheep/docker-agent-swarm-four-complete-20260910/result.json` |

## 解釈上の境界

`last_message.Model`はv1.137.0のruntimeが設定から生成したID。要求したLuna以外へ自動切替しないが、providerが実際にserveしたmodel名の独立証拠はNDJSONにない。`effectiveModelEvidence`はnullとする。

`token_usage.usage`は名前・コメントから総累積と推定せず、実コードと実出力を確認した。v1.137.0では`streaming.go`の`SetUsage`が直近推論のcontext長を保存し、`loop.go`が`last_message`を付けて出力する。消費は各推論の`last_message`を合計し、cache read/writeをinputに含める。timeout時の既知usageを総費用にしない。

LunaはDocker Agentのcatalogではunpricedだった。表示上のcost=0は支払額や利用枠の消費量ではない。Astra介入、tool付与の有用性対照、pool再利用、一般repository、Node24+、強制終了後の自動回収は未検証。
