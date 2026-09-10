# Astra独立レビューとGo DeepSeekによる修正

2026-09-10。`codex/deepseek-api`のDeepSeek直接API・OpenCode Go対応一式を、実装に参加していないAstra（`gpt-6-astra`）がレビューした。利用者の指定に従い、修正はOpenCode GoのDeepSeek V4.1 Flashへ委譲し、親が固定テスト・差分・実行結果を検証した。

## 委譲の識別

`opencode-delegate`の明示モデルは`opencode-go/deepseek-flash`、セッションは`ses_f75a411f3ffe4lEFkgPOr7s4M7`。初回修正と2回の具体的反例による追加修正を同じセッションで実行した。3実行とも`result.json`の`completed`、終了理由`stop`、exit 0を確認した。モデル名の対応は[Go公式一覧](https://opencode.ai/docs/go/#endpoints)と実行時の`opencode models opencode-go`で確認した。

初期実装のLuna 3体、今回の独立レビューAstra、修正したGo DeepSeek、テストを統合して検証した親を区別する。親は今回の修正対象sourceを編集していない。既存認証をOpenCode自身が使用し、briefへkeyを転記していない。delegateの完了自己申告だけで採用せず、Astraの再確認と親のgateを行った。

## 指摘と修正

| 指摘 | 修正した挙動 |
|:---|:---|
| 規模比較がusage不明の子run後も残り14条件を起動し、親がexit 0 | 非zero終了、signal、結果欠落・不正なreport shape、usage不明で次の条件を起動せず、開始済みrunの記録と非zero終了を残す |
| API workerとCodex上位の混合swarm/durableが上位の使用量不明後も4call追加 | 上下のruntimeを通じて新規受付を止め、durableの予約不明・失敗receipt保存後の再開でも停止を維持する |
| mechanismが非Docker上位にもVM cleanupを要求 | 呼び出したroleのruntimeがDockerのときだけcleanup証拠を要求する。逆の組合せも検査した |
| DeepSeekがJSONと同居するlegacy function_callを受理 | function_call、refusal、不正・非空tool_callsを拒否し、tool-less契約を維持する |
| DeepSeekの反射metadataのobject keyに認証情報が残る | 値とkeyの両方を再帰的に伏せ、prototype名を持つkeyも安全に保存する |
| DeepSeek HTTP429に数値usageがあるとcomplete扱い | 非2xxはpartial-or-unknownとし、既知の数値下限と伏字済みmetadataを保持する |

最初の再現7件を固定した後、途中token数付きtimeoutと空の結果JSON、さらに実`callCodex`を経由する末尾JSONL破損を追加で再現した。数値があるだけでは完了usageとしない。timeout・取消と、`malformed-events`、応答過大、回復していない非zero終了等の失敗文脈を共通判定へ渡す。複数のCodex usage行は累積・途中値を区別できないため不明として止める。正常な単一行の使用量と、完全に計測済みの通常のschema失敗は既存の扱いを保つ。

## 検証と証拠

最終の`npm run check`は親の独立実行で404テスト・型検査・2参照snapshot照合すべて成功。Astraの最終限定レビューは28検査（repositoryの26件と元の実adapter反例2件）に成功し、既出の指摘をすべて解消と判定した。レビュー開始時の既存tests・experiments・参照資料56ファイル、および修正前に凍結した追加反例のhashは不変。`git diff --check`も成功し、変更は未コミットである。

固定した独立反例は`tests/astra-review-regressions.test.ts`、`astra-review-followup.test.ts`、`astra-review-terminal.test.ts`。DeepSeekが加えた近傍検査は`tests/go-deepseek-review-repair.test.ts`、`go-deepseek-review-followup.test.ts`、`go-deepseek-terminal-repair.test.ts`。すべて通常gateに含め、外部モデルや実keyは呼び出さない。Codexの末尾破損検査はローカルの偽CLIを実adapter経由で起動する。

親の規模比較検査では正常時15条件・exit 0、usage不明・結果欠落・非zero終了・signal・空の結果objectは各1条件で停止・exit 1を確認した。既知usageを持つ意味上の失敗と、支出不明による停止は区別する。

生のreview、delegateの3実行、変更前hash、固定反例hash、親のgateログと規模比較検査はGit対象外の`.sheep/astra-review-go-repair-2026-09-10/`へ保存した。従来のGo/Luna実API13callの証拠は[元の検証記録](opencode-go.md)に保持する。今回の修正検証でworkerの実APIを追加実行しておらず、修正委譲のモデル呼出とは分けて扱う。

scaleは信頼した同一source snapshotのCLIが生成するreportを前提とする。任意に偽造したusage行を暗号学的に認証する機能はなく、通常のrun出力を悪意ある外部reportの受入機構として提供しない。少数の合成課題と境界検査から、実請求額や一般repositoryでの性能優位は主張しない。
