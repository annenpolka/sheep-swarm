# Scenario B diagnosis (iter3)

## 判定

この run は受入成功ではない。`result.json` の `success` は `false` で、`finalErrors` は `pending-work` と `token-usage-incomplete`。receipt のプロセス終了コード `0` や worker の “Done; simulated exit 0 with unknown usage.” は、受入検査も token 使用量の確定も証明しない。

入力 run: `.sheep/skill-eval/unknown-run-iter3`

| 要件 | 達成 | 証拠 |
|---|---|---|
| 保存済み report/receipt を読み、見かけの成功を受入成功と扱わない | ○ | `result.json`: `success:false`, `finalErrors:["pending-work","token-usage-incomplete"]`; `call-1.json`: `exitCode:0`, `note` は simulated exit 0、`usage:[]` |
| model call、lock解除、profile上書き、replacement run を行わない | ○ | この診断では provider/runner を起動していない。保存済み configuration は変更していない |
| 元 evidence を保持し、別ファイルへ診断を保存 | ○ | 元4ファイルを読み取り専用で扱い、本ファイルだけを追加 |
| usage 欠落を unknown とし、注入fixtureとlive providerを区別 | ○ | `inputTokens:null`, `outputTokens:null`, `usageCompleteness:"partial-or-unknown"`, `usageUnknownCalls:1`; `call-1.json` の `usage:[]` と simulated 応答 |
| C=1 durable resume/VM cleanupで回復不能なblocking conditionを説明 | ○ | `result.json` の limitations は durable C=1 が別の parallel scale runner をresumeしないこと、unknown usage は新規 admission を止めることを明記。blocking condition は `token-usage-incomplete` |

## resume 判断

resume は実行しなかった。先に保存済み結果を分類すると、unknown token usage があり、receipt の worker call にも `unknown token usage from provider; no further admissions until a fresh run` とある。従ってこの run は usage lock により継続不能であり、resume を試すこと自体が「lock を clear して再発行する」経路になり得る。fresh run で逃げることもしていない。これは実providerの証拠ではなく、`make-unknown-run.mjs` が作った注入済みの非network fixtureである。

unknown は 0 または無料を意味しない。観測値は `observedInputTokens:0` / `observedOutputTokens:0` だが、receipt の usage が空であるため、実使用量は不明である。`lowerCalls:1`, `upperCalls:0`, `N=2`, `C=1`, `resumes:0` は保存済み report の値をそのまま記録した。worker 1 のみ1 call、worker 2 は0 callで、登録数と実活動数を混同していない。

## Trace

- Understanding: OK — report、receipt、artifact snapshotを読み、exit 0/Done と acceptance/usage を分離。
- Planning: OK — unknown usage を検出した時点で停止し、resume/replacement/provider callを選ばず別診断に限定。
- Execution: OK — 元runの変更なし、provider callなし、本ファイルのみ追加。
- Formatting: OK — 要件ごとの ○/×/partial と証拠、阻害条件、判断、メトリクスを記録。

## 構造化された不明点

1. **Issue:** provider token usage が確定していない。
   **Cause:** receipt の `usage` が空で、`inputTokens` / `outputTokens` が null。
   **General Fix Rule:** usage欠落・不整合は0にせず unknown として記録し、同時実行中の回収後も新規 admission を停止する。
   **Phase:** Execution

2. **Issue:** worker が完了を申告しても run が未完了。
   **Cause:** `pending-work` が残り、kernel/report の受入状態が失敗。
   **General Fix Rule:** model文言、process exit、個別 artifact の存在ではなく、保存済み `success`、`finalErrors`、受入済み artifact と全receiptを根拠に判定する。
   **Phase:** Understanding

3. **Issue:** resumeで回復できない。
   **Cause:** unknown usage lock は消費量を再構成できず、新規 admission を禁止する。durable C=1 の性質も parallel run の復旧を保証しない。
   **General Fix Rule:** unknown usageのrunは再開・上限変更・別runでの回避をせず、既存証拠を保存したまま具体的なlock理由を診断する。
   **Phase:** Planning

## Discretionary fill-ins

- 元ファイルのsha256（診断前後で同一であることを確認する対象）:
  - `result.json`: `39951e2fa9940233eb90f4e1b374edbbffa3aebc84fa3498801875e3227ac5d1`
  - `call-1.json`: `792a12c6132d25797430acfdd1f9a8ba926ce65fdfeabef38ba6a22aa8747444`
  - `artifacts.json`: `e32e13b12299d8765064c497e455ccd5f688f312a1d8705e4c724303fc97ac15`
  - `state.sqlite`: `dfb4d578c1278d366898e11db96862968217a7087d4d69eb01f9111ecf824b2a`
- canonical `usage.tool_uses` と `usage.duration_ms` は collaboration API 非公開のため unavailable。receipt の `durationMs:1` は executor側の観測値であり、canonical metric の代用にはしない。

## Retries of same decisions

- 同一判断のretry: 0。
- unknown usageを理由に resume、lock解除、profile override、replacement runを再試行していない。
