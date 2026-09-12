# Lazy swarm: 実装者が必要な部分だけ任せる

PR #11で独立plannerは対象を絞れたが、引継ぎの負担を回収できなかった。次の仮説は「実装者が自分の仕事を続けながら独立した一部だけを委譲すれば、小修正の性能を大きく落とさず、本当に並行できる変更を早く完了できるか」に限定する。単体の限界の自動検出や最適な組織の発見は今回の必須条件にしない。

## 実装した通常経路

`repo --lazy-swarm` は親1体が公開repoとtaskを読んで直接修正する。最終回答の `{files:{path:source},note:string}` をhostが検査し、そのまま終了できる。完了を言い直すためだけのモデルcallは追加しない。部分的な変更と変更なしの提出を許し、全targetの最終oracleは固定する。

親は `fork` toolでscope・関連read・目的・固定前提・親に残る仕事を指定する。必要なら自分の変更をcheckpointとして公開検査・kernel確定してから子のsnapshotを作る。子の終了を待たずjob IDを返し、親は同じ会話で次callへ進む。子は1run全体で最大2体、再帰なし、専任planner/reviewer/Managerなし。親子とも `opencode-go/deepseek-flash`、thinking有効を要求する。

最小版では1turn1toolに限定し、複数toolのbatchは副作用なしで拒否する。checkpoint後の新しい版を、同じturn内の古い判断へ無言で割り当てないためである。

`join` は指定した子だけを待ち、候補を検査する。親の直接提出時にも残りの子をまとめてjoinする。子から通知が来るたびに親を呼び直す処理はない。子の候補が却下された場合は元候補と公開feedbackを親へ返して担当を引き取らせる。今回、同じ子を再起動する経路はなく、回復は親が担当する。

## 会話と権限

Goの従来の単発adapterはtool-lessのまま維持する。新しい `callOpenCodeGoTurn` は明示したmessage列を送信し、assistantのcontent・tool call ID・reasoning_contentを保持して次callへ戻す。session header自体を会話保存とはみなさない。tool結果の欠落・重複・不明ID・途中のuser挿入を送信前に拒否する。ローカルshellや自由なfilesystem toolは公開しない。

[DeepSeek公式のthinking/tool継続契約](https://api-docs.deepseek.com/guides/thinking_mode/)はtool付きリクエストで以前のreasoning_contentの再送を要求する。Go経由については専用probeの実走を別途記録する。これはモデル内部状態の複製ではなく、履歴の明示的な再配信である。記録したthinkingは公開レポートへ転載しない。

子へ渡す現在内容はwrite scope・指定されたrelevant paths・hostの静的依存閉包。非公開oracleや基準解は渡さない。親の前提は未検証の指示としてラベルを付ける。子の候補は共有状態へ直接確定せず、join時に配信した全readのversion/evidenceEpochを検査する。親が子の前提を更新していれば、write範囲が別でもstaleとして親へ戻す。

子が未解決の間はそのscopeを親の書込許可から外す。同じscopeへの別の子も拒否する。joinが終わると親が必要な統合変更をできる。公開検査・全体oracle・候補採用時のsource drift検査は既存kernel/snapshotの境界を使う。全体oracleの失敗内容は修復用の会話へ返さない。

## 予算と実行範囲

call開始前に親子共通のtoken予約とrequestを保存し、全receiptを同じrun予算へ精算する。親を含むmodel call数に共通Cを適用し、空きslotができれば次の待機callを開始する。C=1も使えるが、同時実行による利益はない。子を増やしてcall/token予算をリセットしない。使用量不明、予約超過、model証拠不一致、検査基盤障害では新規受付を止め、発行済みcallを回収し、成功・applyを拒否する。

runに時間締切は設けない。通信timeoutとcall/token上限は受付制約として残す。失敗のelapsedは保存しcompletionはnull。既存の失敗再試行方針は、元attemptの不明費用を残した外側の新attemptで扱う。新runner自身の通信再試行・crash後の再開・並列durabilityは未対応である。

## CLI

以下のtask JSONは既存repo manifestと同じ形式で、target・公開context・protectedと固定checksを先に指定する。`--apply`を省くと候補保存だけを行う。

    npm run repo -- --repo /path/to/repo --task /path/to/task.json \
      --runtime opencode-go --worker-model deepseek-flash --go-thinking enabled \
      --lazy-swarm --lazy-children 2 --concurrency 3 --max-calls 24 \
      --max-meta-calls 0 --max-tokens 1000000 --reserve-tokens 100000 \
      --max-tokens-per-call 64000 --timeout-ms 600000 --output .sheep/lazy-new

子なし対照は `--lazy-children 0`。`--lazy-children` 単独、`--plan-work` / `--packet-size` / 明示workersとの併用を拒否する。`--dry-run`はモデルも子も起動せず、初期root1体と子の上限を設定に示す。runtimeはGo DeepSeek Flashのみ。activation/recovery/static+readsはこの最小版では併用しない。

## 三対照の凍結比較

比較するのは既存packet-all、同じ新rootの子なし、同じ新rootのfork許可という三方式。旧dev課題は「小修正で余計な分業をしないか」の非退行対照として維持する。新規課題は独立した複数の実装が必要なものと、共通仕様で強く結合したものを含め、公開作業構造で選ぶ。Singleの失敗を見てから課題を選ばない。

[最小版の実走](results/lazy-swarm.md)に続き、[18課題・54条件の本比較](results/lazy-benchmark-findings.md)を完了した。packet-all/子なしrootは18/18、lazyは16/18成功し、lazyは子なしrootより成功組の時間比中央値で1.31倍遅かった。事前採用条件を満たさず、lazyを実験用opt-inに留める。task/hash・反復数・方式順・C・予算・採用閾値をprofileへ固定して実行した。品質低下を許して速度改善としない。小修正群全体の追加負担を示し、forkした成功例だけで判断しない。まず同数成功を必要条件とし、同時期のpaired成功時間を比較する。小さな通信確認から実用性へ一般化しない。

reportはfork要求数（却下された要求も含む）・却下tool数・forkまでのelapsed、親子model callが実際に重なった時間、子を待つ時間、親の継続call数とjoin後call数、破棄した子tokensを保存する。join後のcall全てが統合専用とは限らないので、統合費用の厳密な分類にはtraceを読む必要がある。価格やhuman preparation timeは未測定。
