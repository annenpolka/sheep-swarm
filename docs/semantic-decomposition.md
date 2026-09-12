# モデルが選ぶ作業境界

PR #10のdev比較では、固定細分化よりpacket-allが速かった。次はDeepSeek Flashに全公開repoとtaskを1callで読ませ、作業を分ける価値がある場合だけ分割する。`repo --plan-work`で有効にする実験的な経路であり、通常repoの既定値は変えない。

    npm run sheep -- repo --repo /absolute/repository --task /absolute/task.json \
      --runtime opencode-go --worker-model deepseek-flash --plan-work \
      --concurrency 4 --max-calls 128 --max-tokens 2000000 \
      --reserve-tokens 200000 --max-tokens-per-call 64000 \
      --output /absolute/new-output

`--packet-size`と`--workers`は併用できない。thinking有効、上位0、static graphに対応する。dry-runではplannerを呼ばず、worker数をnull、planning.stateをrequires-model-callとする。実際のscopeは有料plannerの結果を検証してから決まる。`--apply`を指定しなければ元repoへ書かない。

## WorkPlanとhostの責務

plannerは`packets`、`untouchedPaths`、`rationale`を返す。各packetは`id`、`writablePaths`、`relevantPaths`、`objective`、`invariants`、`dependsOn`を持つ。1packetに全targetを入れてよい。修正不要と判断したtargetはuntouchedへ明示する。

hostは未知path・非公開path・欠落target・不正ID・未知依存を拒否する。重複したwrite scopeは統合し、公開static依存、relevant pathの依存閉包、plannerのdependsOnを合わせた循環も統合する。モデルの提案とhostの統合結果を別々に保存する。統合は権限の追加ではなく、同じ担当を競合なしで実行するための正規化である。

plannerには全公開baseline、公開依存、元taskの目標と全targetの指示を渡す。protected、reference、変異情報、不具合位置metadataは渡さない。workerには担当の元指示、objective/invariants、選択した公開入力とhost依存閉包だけを渡す。baselineと現在のprovider版を分離する既存kernelを使い、複数writeは原子的に検証・確定する。

untouchedにはwrite権限を与えないが、固定された全体oracleから除外もしない。plannerの判断が誤れば失敗となり、hidden診断をplannerへ戻して再計画しない。不正planもその試行の失敗として保存する。

## 証拠と予算

plannerは1call。時間とtokensを合算し、元のcall/token枠からplanner分を引いた残りだけをworkerへ渡す。使用量不明・予約超過・モデル不一致・source driftではworkerを起動しない。`planner-1.request.json`とreceipt、`work-plan.json`、`compiled-plan.json`、`workers/`内のkernel/read/receipt、rootの合算budget/resultを保存する。

実験controllerは通信障害だけを条件全体の再試行へ送る。最大3回、2/4/8秒の待機を使い、失敗attemptも共有予算と経過時間へ数える。不明usageはnullのまま、予約分は受付上の控除だけに使う。品質失敗・不正planは再抽選しない。

## 24課題の比較

凍結devの8familyから各3課題を公開metadataのhashで選ぶ。4/8/16/32targetを各6課題とし、3方式の全6順列を各4回使う。Single、固定packet-all、plannedを新規に72条件実行する。基準は#10で最も良かったpacket-allであり、弱い固定分割へ勝つことを採用基準にしない。

    mkdir -p .sheep/semantic-decomposition
    node scripts/semantic-decomposition-pilot.mjs prepare .sheep/semantic-decomposition/dev-v1
    node scripts/semantic-decomposition-pilot.mjs run .sheep/semantic-decomposition/dev-v1
    node scripts/semantic-decomposition-pilot.mjs audit .sheep/semantic-decomposition/dev-v1

実走には承認済みGo認証が必要。prepareがcorpus全hash、選択24課題のbaseline/reference/変異検査、fixture、順序、solverと監査コードを保存する。runはhashを照合し、task間逐次、packet C4、thinking有効、上位0。条件共有128call/200万tokens、出力64,000、予約200,000、通信timeout600秒。task締切は設けない。

成功率と両方成功した組の完了時間を主指標にする。plannerを含む実行・runtime受入・失敗試行・再試行待機を計測し、独立監査と準備時間は別記録にする。tokens、提案/実行packet数、担当/実変更target数、1packet率、全targetの1packet率も報告する。family・target数・topology・依存深さ別の探索的集計を残す。

この比較は入力選択と分割を含む方式比較であり、分割だけの因果効果ではない。既知devの小規模実験で、一般repoや未観測evaluationへの優越を主張しない。品質が落ちた場合に速度だけで採用しない。evaluationとManagerは今回の範囲外。

## 実測後の位置付け

[24課題×3方式の比較と監査](results/semantic-decomposition-findings.md)を完了した。Single/固定allが24/24、plannedが23/24成功。有効23plan中21件が1packetで、plannedの成功組の時間比中央値はSingle比1.36倍・固定all比1.48倍だった。独立plannerは既定にせず、実験用opt-inに保つ。
