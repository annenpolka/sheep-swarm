# 通信障害の再試行とdev比較の継続

2026-09-11の「失敗したときは単にやり直して続ける」に基づき、HTTP 500等による使用量不明で系列全体を止める方針を変更する。対象は進行中のdev packet比較。一般CLIや過去の実験のbudget lockは変更しない。

## 継続する条件

停止済み`.sheep/packet-sweep/dev-v2`の成功90条件を引き継ぎ、失敗した`syn-units-v02 / packet-2`と未開始553条件を固定順で実行する。元のprofile・series・receiptは保持する。継続先は`.sheep/packet-sweep/dev-v2-retry`。元の保存runtimeを直接importし、source profile/seriesと継続controllerをhashで固定する。コーパス、prompt、packet分割、read policy、oracleは変更しない。

DeepSeek Flash、thinking有効、上位0、task同時数1、packet最大C4。固定時間の採点やtask全体の締切は設けない。通信timeout 600秒は維持する。evaluationとManagerは実行しない。

## 再試行

並列executorは部分再開できないため、その条件を元のbaselineから新しいattemptDirectoryへ実行し直す。失敗したcallだけの再送でも、受理済みpacketの再利用でもない。成功済みの別条件は再実行しない。

HTTP 408/429/5xx、HTTP応答のない通信障害・timeoutをレシートから判定する。最大3回の再試行、待機2/4/8秒。連続失敗で上限を使い切った条件は利用不能として次へ進む。取消・認証エラー・検証基盤やkernelの異常・通信障害によらないusage欠落は停止する。hidden oracleの不合格は品質失敗として保存し、再抽選しない。再試行へ検査結果や失敗候補を渡さない。

## 時間と消費

各条件の全attemptの実行時間と再試行待機を合算する。独立再検査とreceipt監査の時間も合算して別項目に保持する。最初の回復条件だけは手動停止を挟んだため、その停止時間を別に記録し、主な時間比較から除外する。独立検査で成功した品質と全消費は集計する。停止前90条件と継続後の条件は時期が異なる観測として識別できるようにする。

未知usageは最後までnull、既知分は下限として記録する。再実行が成功しても、先行する失敗callの使用量は既知にならない。受付予算では不明callごとに予約額と既知下限の大きい方を控除する。この控除は実請求や実使用量の推定ではない。

1条件128call・2,000,000 tokens、1call予約200,000・出力64,000を、失敗試行も含めて共有する。枠を使い切った条件は利用不能として次へ進む。系列の元の受付枠も増やさない。予算予約はproviderの強制上限ではない。実行中attemptは未精算として表示し、終了済みattemptの消費と区別する。

## 実行と監査

```sh
node scripts/packet-sweep-retry.mjs prepare .sheep/packet-sweep/dev-v2 .sheep/packet-sweep/dev-v2-retry
# OPENCODE_GO_API_KEYをprocess環境へ設定して実行する。鍵は成果物へ保存しない。
node scripts/packet-sweep-retry.mjs run .sheep/packet-sweep/dev-v2-retry
node scripts/packet-sweep-retry.mjs report .sheep/packet-sweep/dev-v2-retry
node scripts/packet-sweep-retry.mjs audit .sheep/packet-sweep/dev-v2-retry
```

runnerはattemptの開始・終了と条件の確定ごとにstateとreportを更新する。終了すれば完了結果を保存する。process自体が落ちてpendingが残った場合は、自動再送せず、発行済みcallの生存・精算を確認する。通常gateではHTTP 500を注入し、元repoからの再実行成功、失敗receipt保持、未知usageの維持、残予算の共有、品質失敗の再試行抑止を確認する。モデルを使わない検証と実APIの結果を分ける。

実APIでの初回回復と検証結果は[記録](results/packet-sweep-transport-retry.md)を参照する。成功済み90条件の引継ぎと停止条件の再実行成功を確認し、残条件を実行中。実測の時間除外に関する追加注記も同記録へ保存する。
