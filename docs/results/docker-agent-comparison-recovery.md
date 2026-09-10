# Docker比較系と復帰時回収の継続実装

2026-09-10。「わかっているところまで進めて」に対し、thermal比較fixtureへの共通tool接続、単独Luna対照、所有process終了後のVM回収、Docker usageの見積器対応を追加した。既存の[道具付きswarm導入](docker-agent-tools-swarm.md)とは別の実走記録である。

## 実装と通常gate

- `compare`の単独Luna・Manager-local・Sheep-fixed/fullは、filesystemと固定可視テスト、独立VMからの観測、hostの固定採点を共通にする。管理・介入は元のtool-less方式を保ち、各roleのread/write範囲を変えない。
- 必須importはVM内の構文情報で検査する。期待値・case・閾値・照合式は従来のthermal oracleを保持した。
- 単独Astraの新規Docker実行を拒否する。上位呼出し数の受付上限を追加し、使用量不明・受入基盤障害・worker cleanup失敗で新規受付を止める。
- 比較dispatcherは単独Lunaを含む4方式×3条件を既定とし、共通runtime/toolを渡す。不明usageや信用できない結果で後続条件を止める。12条件の実LLM一括実走は未実施。
- VM作成前に所有記録を同期保存し、同じhostの所有PIDが死んでいる場合だけ、UUID名・image・mountを照合して復帰時に回収する。不在の作成意図も保持する。
- offline費用見積器はv1.137.0の`last_message`を合計し、cache read/writeをinputへ一度だけ計上する。中断分は金額の既知下限と不明な上限を区別し、CreditBudgetの次の受付をlockする。見積器のruntime依存を避け、固定sourceだけを使う従来dispatcherの検査も保持した。

`npm run check`は260テスト成功、固定資料snapshot 2件一致。`git diff --check`も成功。Manager-localとSheep-fullのtool経路、上位role、途中usage、基盤障害、cleanup失敗、dispatcher停止は制御したテストで検証した。これらを実Astra試行の証拠には数えない。

## 実VMの故障・oracle検査

`sandbox:recovery-probe`で実child processをSIGKILLした。生存中の所有processのVMは保持し、死亡後のVMを回収した。作成前crashでは不在の記録を残し、遅れて同名VMが現れた後のsweepで回収した。3つの試験VMは全て削除した。

`sandbox:comparison-probe`では基準解が成功し、旧target・温度閾値の変異・値は等価だが必須importをコメント化した変異が失敗した。4つの新規VMを使い、基盤障害を変異拒否として数えていない。全てのVMを削除した。

## 実Lunaの比較経路

両試行の共通条件はthermal fixtureのsize=2（sensor 2件＋region 1件）、Docker Agent v1.137.0、sbx v0.42.1、同じdigestのtemplate、local tool、最大5call、上位0call、200,000 tokenの受付上限、40,000 tokenの呼出し予約、240秒のmodel timeout。順番に実行した。fixture fingerprintは一致する。

```sh
npm run compare -- --runtime docker-agent --worker-tools local \
  --method single-luna --size 2 --workers 2 --concurrency 2 \
  --max-calls 5 --max-upper-calls 0 --max-tokens 200000 \
  --reserve-tokens 40000 --timeout-ms 240000 \
  --output .sheep/docker-compare-single-luna-20260910
# 2本目はmethodをsheep-fixed、outputを別名へ変更。
```

| 観測 | 単独Luna | Sheep-fixed |
|:---|---:|---:|
| 実際のN / model同時数上限 | 1 / 1 | 2 / 2 |
| 下位call / 上位call | 1 / 0 | 3 / 0 |
| 確定 | 3成果物 | 3成果物 |
| 全体受入 | 成功 | 成功 |
| 全体時間 | 271.158秒 | 287.673秒 |
| input tokens | 19,588 | 23,591 |
| output tokens | 1,267 | 1,468 |
| 使用量不明 / 予約超過 | 0 / 0 | 0 / 0 |
| worker VM / 受入VM | 1 / 8 | 3 / 8 |

単独Lunaは可視テスト3件失敗→3ファイル編集→3件成功。Sheep-fixedは各callで担当1件の失敗→編集→成功を確認した。実ファイル差分から確定し、全20台のworker/受入VMのcleanupを確認した。終了後の`sbx ls --json`は空だった。

この小課題の単回観測では、単独Lunaの時間・tokenが少なかった。各1回、少数artifact、上位介入なしの導入受入であり、モデル応答のばらつき・課題規模・介入効果を分離した有用性実験ではない。要求したmodelと、providerが実際にserveしたmodelの独立証拠は引き続き区別する。

## 証跡と残る範囲

生データは`.sheep/docker-compare-single-luna-20260910/`と`.sheep/docker-compare-sheep-fixed-20260910/`に保持した。故障probeは`.sheep/docker-recovery-probe-1789006556675/result.json`、oracle probeは`.sheep/docker-comparison-probe-1789006776634/result.json`。hashと公開可能な集計は[docker-agent-comparison-recovery-evidence.json](docker-agent-comparison-recovery-evidence.json)。原本を成功へ書き換えていない。

所有記録の回収は次のruntime process起動時、または`npm run sandbox:reap`による。常駐削除・元runの再開・未保存usageの復元ではない。PID再利用、別host、手で再利用されたVM名、電源断で失われた記録は自動復旧の保証外である。

`mechanism`の移植では、課金付きreadRequestsをtoolから迂回させず、未読policyを可視テスト生成から漏らさず、各stageの最終採点値をworkerへ戻さない条件が必要になる。この契約の検査を置いてから接続する。pool再利用、Node24+ template、一般repository、Astraを含む実比較、並列run再開も後続範囲として残る。
