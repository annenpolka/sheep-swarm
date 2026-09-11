# 修正版でのdev packet比較

2026-09-11の「修正し、やり直して」に基づく再実行。`5104ad3`のpacket同居関係を含むread閉包とkernel基盤障害の即時停止を使う。旧系列`.sheep/packet-sweep/dev-v1/`は保全し、旧3条件の成功を新系列へ流用しない。

新系列は`.sheep/packet-sweep/dev-v2/`。対象dev128件、旧Singleとpacket-all/8/4/2/1を各1回。task順・条件順・同値判定・C4・thinking有効・上位0・task締切なし・各runのcall/token枠は[初回計画](packet-sweep-plan.md)を維持する。read policyは`immutable-public-baseline+upstream-packet-closure`。修正後の実分割・現在版read範囲・runtime hashをprepare時に再計算して固定する。

元の不具合は4ファイルの独立反例と、止まった32target課題へ正解stubを返す対照で解消済み。型検査・574テスト・参照snapshot2件が成功した同じsolverを使う。基盤の修正確認と、実モデルの性能測定を混同しない。

全256件の凍結hashとdev128件のbaseline/reference/mutant preflightを再検査してから実APIを開始する。全条件を固定順で再実行し、品質不合格は記録して続行、usage不明や基盤障害では発行済みcallを精算して受付を停止する。途中結果を見てsolverを変更せず、evaluationとManagerは呼ばない。

準備結果: dev128件すべてpreflight成功、同値条件を除いて644実run。準備159.38秒。profile SHA-256は`4e7cefd595dab48ded3fffabe13296c7b30de5a8eff2a90bec0695f0b882c35d`、solver commitは`5104ad326ab0bb7bca4313be7de136e4954a8e24`。2026-09-11に実API開始。最初の`stats-v11`は全6条件成功し、前回停止したpacket-4も8call・40.11秒で成功した。以降の全結果は新系列のrow/receiptへ保存する。

終了結果: 91実runの終了記録を保存。有効90runは全て成功、残る1runはHTTP 500・usage不明による基盤障害で比較から除外。526call、既知token下限6,459,555、使用量不明1call。予約残0、系列は停止。残り553runは未開始。[結果と解釈](results/packet-sweep-rerun.md)。
