# Hold-out: OpenCode Go Luna semantic smoke

実行日: 2026-09-10

## Deliverable

再現用 probe: [holdout-go.mjs](./holdout-go.mjs)

Runtime evidence: [.sheep/skill-eval/holdout-go-invalid/probe-result.json](../../../.sheep/skill-eval/holdout-go-invalid/probe-result.json)

## Frozen requirements

1. ○ **正しい mechanism コマンドを作成**

   以下を完全な実行コマンドとして作成した。Go/Luna、semantic/sheep、N=2/C=1、groups=1、token mode、総量50,000、予約4,000、call出力上限4,096、12 calls、90秒、upper 0、および fresh output path を指定している。これは provider を呼ばないため、実行はしていない。

   ```sh
   npm run mechanism -- --runtime opencode-go --worker-model gpt-5.6-luna \
     --family semantic --method sheep --groups 1 --workers 2 --concurrency 1 \
     --budget-mode tokens --max-tokens 50000 --reserve-tokens 4000 \
     --max-tokens-per-call 4096 --max-calls 12 --max-meta-calls 0 \
     --timeout-ms 90000 --output .sheep/skill-eval/holdout-go-token-20260910
   ```

2. ○ **無効な Go credit-mode をloopback観測下で拒否**

   [probe](./holdout-go.mjs) が `OPENCODE_GO_API_KEY=dummy-go-key` と loopback URL を設定し、`--runtime opencode-go --budget-mode credits --max-credits 1` を実行した。証拠は exit code `1`、stderr の `the mechanism credit budget does not support API runtimes; use --budget-mode tokens`、loopback requests `0`。拒否は `src/mechanism-run.ts:124` で network adapter より前に発生した。live provider は呼んでいない。

3. ○ **Go設定・model・tools・upper default を明記**

   Go key は `OPENCODE_GO_API_KEY`。model は provider prefix を付けない raw catalog ID（ここでは `gpt-5.6-luna`）。local tools は API runtime では使用不可で、worker tools は `none`。upper は未指定なら Codex/Astra default だが、本コマンドは `--max-meta-calls 0` で無効化している。

4. ○ **予算の意味を分離**

   `--max-tokens` と `--reserve-tokens` は token admission/reservation であり、provider の spending ceiling を保証しない。Go token は Codex credits、直接 DeepSeek pricing、または Go subscription の実利用額・残枠ではない。実請求額と subscription usage はこの集計から判定しない。

5. ○ **証拠と再現コマンド**

   実行可能な probe と、stdout/stderr、終了状態、loopback URL、request count、使用コマンドを JSON に保存した。canonical `usage.tool_uses` と `usage.duration_ms` は collaboration API 非公開のため unavailable。probe の wall time は約4.3秒だが、canonical duration の代替にはしていない。

## Trace

### Understanding

対象を Hold-out のみと解釈した。要求されたのは実 Go smoke の実行ではなく、正しい token-mode command の準備と、credit-mode の事前拒否を no-network で検証することだった。

### Planning

Go credit-mode が API runtime に非対応である実装上の拒否を選び、loopback HTTP server の request counter と dummy key を使う probe を作成した。上位呼出しは `--max-meta-calls 0` とした。

### Execution

最終 probe は repo root から実行。CLI は非0終了し、requests は 0。生成された runtime evidence は上記 JSON のみ。CLI は事前検証で終了したため、run output の result/artifact/call receipt は生成されていない。

### Formatting

要件ごとに ○/×/partial と具体的証拠を記録し、実行 command・probe path・evidence path・unavailable metadata を明示した。

## Actual instruction ambiguities

- **Issue:** “invalid Go credit-mode combination” は、token option と credit option の混在を指すのか、API runtime と credit budget の組合せを指すのか曖昧。
  **Cause:** CLI には両方の事前拒否があり、前者なら runtime-specific rejection に到達しない。
  **General Fix Rule:** provider/runtime-specific no-network probeでは、他の budget option を混ぜず、対象 runtime と対象 modeだけが拒否原因になる最小 command を使う。
  **Phase:** Planning.

- **Issue:** “fresh output path” に命名規則・一意性の指定がない。
  **Cause:** frozen requirement は新規 path のみ定めている。
  **General Fix Rule:** 日付または実行IDを含む、既存成果物と衝突しない path を選び、command と evidence に同じ絶対/相対解決先を保存する。
  **Phase:** Planning.

## Discretionary fill-ins

- invalid probe の credit budget は `--max-credits 1` とした。credit validation を明示しつつ、token budget option との混在を避けるため。
- loopback は `127.0.0.1` の ephemeral port、key は固定文字列 `dummy-go-key` とした。
- probe evidence は `.sheep/skill-eval/holdout-go-invalid/probe-result.json` に保存した。

## Retries of decisions

1. 初回 probe は相対 URL の解決を `../..` と誤り、repo root ではなく `docs` を cwd にした。probe のみ修正して `../../..` に変更。
2. sandbox 内の loopback listen は `EPERM` だったため、許可された local loopback observer に限定して escalation し、同じ probe を再実行した。
3. 最終実行では exit code 1 / requests 0 を得た。provider invocation、live credential、子agent、skill/production/criteria/prior report の変更は行っていない。
