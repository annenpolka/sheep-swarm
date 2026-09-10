# 道具付きDocker Agent swarmの実測

2026-09-10、macOS arm64。Docker Agent v1.137.0、sbx v0.42.1、digest固定template。合成measurement migration fixtureに対する導入受入であり、有用性比較の本実験ではない。

後続の[比較系・復帰時回収](docker-agent-comparison-recovery.md)は別の実走として記録した。以下の結果は当時のscopeで保持する。

## 実行条件と結果

```sh
npm run swarm -- --runtime docker-agent --worker-tools local \
  --workers 4 --concurrency 2 --size 4 --max-calls 6 \
  --max-meta-calls 0 --timeout-ms 240000 \
  --output .sheep/docker-agent-swarm-tools-20260910
```

| 指標 | 観測 |
|:---|:---|
| 登録worker / 最大同時model call | 4 / 2 |
| 下位 / 上位呼出し | Luna 5 / Astra 0 |
| 確定 | consumer 4件 + report 1件、全体受入成功 |
| 全体時間 | 318.135秒 |
| usage | input 44,474 / output 3,124 tokens、全5call complete |
| 実際の道具 | read_file、read_multiple_files、write_file、edit_file、check_local |
| 可視検査 | 全5callで失敗1回→編集→成功1回 |
| 差分 | 各callで担当1ファイルだけ。実workspace差分を確定 |
| worker / 受入VM | 新規5台 / 新規6台、全11台cleanup成功 |
| 終了後 | `sbx ls --json`のsandbox一覧は空 |

個別callの所要時間は33.021、30.026、126.252、127.895、125.506秒。並列callの時間を全体時間へ加算しない。上位の相談・介入・外部からの意味的助言は行っていない。

受入は候補ごとに5回、最後の全体に1回。候補と依存閉包だけを別の通信拒否VMで実行し、hostに保持した従来の期待値・case・比較式で照合した。可視テストやworkerの認証を受入VMへ継承していない。一般repositoryの互換性まで検査したものではない。

## モデルを呼ばない検査

`sandbox:swarm-probe`は5つの新規VMを使用し、基準解の全体成功、libraryだけを変更した旧target群の失敗、`<=`を`<`へ変えた閾値変異の拒否、`node:fs` import拒否、無限loopの拒否とcleanupを確認した。基盤の起動失敗を変異拒否として数えていない。

通常gateは241テスト成功、固定資料snapshot 2件一致、`git diff --check`成功。追加10件は局所runnerと従来oracleの互換、可視テスト、供給ファイルとread set、全差分の権限、虚偽の最終回答、usage不明、基盤障害、cleanupの境界を検査する。実走中に基盤障害の分類と新規受付停止を追加し、最後の通常gateで検証した。この分類の実障害注入は行っていない。

## 証跡と解釈

原本は`.sheep/docker-agent-swarm-tools-20260910/`の`result.json`、`call-*.json`、`artifacts.json`、`kernel-state.json`、`acceptance/*/receipt.json`。probeは`.sheep/docker-swarm-probe-2026-09-10T01-53-28.551Z/result.json`。hashと公開可能な集計を[docker-agent-tools-evidence.json](docker-agent-tools-evidence.json)に保存した。

以前の[tool-less試行](docker-agent-sandbox.md)の55.097秒・input 3,930/output 1,148より、今回の時間とtokenは多い。可視テストを使う対話に加え、受入を別VMへ移す変更も含むため、この差から道具単独の寄与は分離できない。比較条件を揃える前の単回導入試験として扱う。

providerが実際にserveしたmodel名の独立証拠はないため`effectiveModelEvidence`はnull。Lunaのruntime価格catalogはunpricedで、cost=0を無料や請求額に読み替えない。Node24+、一般repo、pool再利用、SIGKILL後の自動回収、比較条件への共通tool導入は後続範囲である。
