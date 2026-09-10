# 段階読取と広い初期contextの同品質pilot

2026-09-10、PR #5を `fe037dd2069709526e90797abe37cbf4fd9f7193` としてマージした後の観測。**両条件が同じ固定oracleに成功した。局所読取の1callあたりcontextは小さかったが、総tokensは広域より多かった。** 各1回・2targetの小課題であり、一般的な優劣や増員効果は示さない。

## 課題と固定条件

seed `pilot-01`、world 0、24個のopaque JSON文書とregistry、2つのquote関数を使う。registryだけがtargetからpolicy文書への対応を持つ。各policyはrate/minimum/capを定義し、有効なunitsを範囲内へ丸めてrateを掛ける。それ以外の入力はnull。同じseedではworldを変えてもファイル名と全policy本文は同じで、registryの参照先だけが変わる。全24文書が別worldでは選択対象になる。

localは初期共通contextなし、broadは全公開資料25件を初期共通contextにする。他のtask指示、読取可能範囲、write権限、固定検査は同じ。両方でmaxReadCalls=2、maxPathsPerRead=1。検査caseとhost期待値をworkerへ配信せず、構文検査だけを局所feedbackに使った。モデルが正しい定数を直接書いても品質検査は許し、読取の手続きを別集計する。

runtime `opencode-go`、要求/応答証拠 `deepseek-flash`、thinking disabled。N=4、C=2、上位0、各最大12call/100,000tokens、call受付予約20,000tokens、出力上限8,000tokens、timeout120秒。local→broadの順に1回ずつ実行し、追加のモデル修復や助言は行っていない。元repoへapplyせず、各保存候補にhostの固定oracleを新しく再実行した。

## 観測

| 指標 | local | broad |
|:--|--:|--:|
| 固定品質oracle / 独立再検査 | 成功 / 成功 | 成功 / 成功 |
| 登録N / 最大同時C / 実際の最大同時稼働 | 4 / 2 / 2 | 4 / 2 / 2 |
| 参加した個体 | 4 | 2 |
| 下位call / 上位call / 却下による再試行 | 6 / 0 / 0 | 2 / 0 / 0 |
| 観測input+output tokens | 8,241 | 5,593 |
| swarm所要時間 ms | 6,535 | 2,930 |
| 全callのcontext JSON bytes合計 | 6,044 | 6,034 |
| context JSON bytes最大 / p95 | 1,096 / 1,096 | 3,017 / 3,017 |
| 要求read / 受入read | 4 / 4 | 0 / 0 |
| 異なる配信依存path | 3 | 25 |
| 二段読取証拠のあるtarget | 2 / 2 | 0 / 2 |
| commit前に正しいpolicyを配信したtarget | 2 / 2 | 2 / 2 |

localのcall1/2がregistryを要求、call3/4がその本文を受け取って正しいopaque policyを要求、call5/6がpolicyを受け取ってcommitした。broadは最初のcall1/2にregistryとpolicyが含まれ、そのままcommitした。後者の二段読取falseは方式の違いで、品質失敗ではない。

context bytesは保存checkoutのJSONサイズで、catalogや制御指示を含む全promptのbytesではない。全tokensにはこれらの入力と応答も入る。追加配信bytesはlocal388/broad0だが、broadの共通初期contextがこの指標から除外されるため、これだけで比較してはいけない。走査は両3回、local901bytes/173ms、broad936bytes/189ms。モデルの出力長が異なるので走査量も完全一致ではない。

全callの総input/output usageは完全、unknown/reservation overrun/残予約はいずれも0。cache write量には不明が残り、通貨費用やsubscription枠消費はnull。開発親の思考・準備費用は未測定。実行順、cache、provider待ち時間を制御した反復ではなく、時間差の因果効果も主張しない。次は資料量や依存構造を増やして比較する。

## 実装と検証の作者

指定のGo swarmへ2つの純粋部品を委譲し、4call・24,014tokens・上位0で固定した2テストに成功した。生成器の初回は文書数、2回目はcap整合性で却下され、3回目に通過。監査器は初回通過。元の失敗候補、検査診断、raw応答を保持した。

親がmanifest上限、接続script、固定oracle、追加試験を実装した。生成本体のレビュー後、監査器のstrict型エラー、空入力/重複path検査、tuple識別を補修し、生成器を全資料へのworld循環と同一のpolicy生成式へ広げた。元部品と採用版のhashは[機械可読記録](read-selection-pilot.json)に分けてある。swarm単独で完成したとは報告しない。

通常gateの `npm run check` は型検査・472テスト・原資料2snapshotが成功した。`git diff --check` とExecPlan validatorも成功。追加試験は固定oracleの旧版/誤world/入力境界変異の拒否、同じ課題の注入caller対照、超過要求の非配信、静的closureの保持、最初のcommitを越えた配信の不採用、欠落・矛盾する証拠とunknown usageを扱う。実APIは通常gateから呼ばない。

## 再現と保存証拠

新しい出力directoryを指定する。認証は[Go手順](../opencode-go.md)に従い、既存keyを環境へ明示してから実runを呼ぶ。

```sh
node scripts/prepare-read-selection-pilot.mjs --output .sheep/read-selection-new --seed pilot-01
npm run sheep -- repo --repo .sheep/read-selection-new/repo --task .sheep/read-selection-new/local.json --runtime opencode-go --worker-model deepseek-flash --go-thinking disabled --workers 4 --concurrency 2 --max-worker-calls 12 --max-meta-calls 0 --max-rounds 12 --max-tokens 100000 --reserve-tokens 20000 --max-tokens-per-call 8000 --timeout-ms 120000 --output .sheep/read-selection-new-local
node scripts/audit-read-selection.mjs --run .sheep/read-selection-new-local --fixture .sheep/read-selection-new/fixture.json --output .sheep/read-selection-new-local-audit
```

広域対照はtaskを `broad.json` にし、出力を別名にする。未知usageが出たら後続を止める。監査は保存taskの検査コマンドを採用せず、固定の `node check.mjs` を新しく実行する。構造上の `audit.valid`、各targetの `sequentialRead`、`qualityPass` は別の値。配信が欠ければ二段証拠はfalseで、理解や推論の失敗を直接断定しない。

rawは `.sheep/m7-build/components-run`、`generated`、`pilot`、`local-run`、`broad-run`、各 `*-audit`。元repoは両run後も同じHEAD/bytesでclean。集計JSONにはresult/task/artifacts/ledger/kernel stateと独立監査のSHA-256を残した。これらのrun証拠はignoredなローカル保存で、Gitにある集計だけから全rawを再構成することはできない。M6以前の結果・固定資料は変更していない。
