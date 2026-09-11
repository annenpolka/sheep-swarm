# 公開反例の検証と上流への配信

repository task v2の任意設定 `recovery.publicProbes` に、task作成者が信頼する公開検査を宣言する。workerは既知の上流に誤りがあると考えたとき、probe IDを選ぶ。hostは配信済みの版で検査を実行し、失敗を確認してから上流の回復artifactへ渡す。モデルのnote、任意コード、モデルが決めた期待値を受入証拠として実行する経路ではない。

## 設定例

```json
{
  "recovery": {
    "maxUpstreamRechecks": 2,
    "review": "focused",
    "publicProbes": {
      "maxRequests": 6,
      "maxRechecks": 2,
      "catalog": [{
        "id": "whole_amount",
        "provider": "amount.mjs",
        "description": "parseAmount(\"1\") must return 10**places.",
        "paths": ["amount.mjs", "settings.mjs", "amount-probe.mjs"],
        "check": {"argv": ["node", "amount-probe.mjs"], "timeoutMs": 30000}
      }]
    }
  }
}
```

これは既存taskに追加する断片。providerは宣言済みのwrite targetで、pathsにはそのproviderと、contextまたはdiscovery.readable内のreadonly公開ファイルだけを指定する。他のwrite targetや非公開protectedファイルは含められない。catalogは1〜16件、idは英数字・underscore・hyphenの1〜64文字で重複不可。maxRequestsとmaxRechecksはそれぞれ0〜64の整数。maxRequestsは受付したhost検査の数であり、未登録・古い版などの拒否要求はこの数に含めず、ledgerと通常のworker試行・call予算に残す。省略時は従来の挙動を維持する。maxRechecks=0は検証のみの対照として使える。

probeの入力は、該当provider自身およびそのproviderを既に読むtargetへ追加配信し、通常のread bytesに計上する。provider以外の入力はreadonlyのまま。probeが必要とする静的依存がpaths外にある場合は実行を拒否する。初期版は一つのproviderを検査できる構成に限る。

## 公開検査の契約

probeが通ればexit 0。指定の契約違反を確認した場合だけexit 1と、stdoutにJSON `{ "probeId": "whole_amount", "status": "counterexample" }` を出す。stdoutにはこのオブジェクト以外を混ぜず、実際値・期待値などの診断はstderrへ出す。例:

```js
import assert from 'node:assert/strict';
import {parseAmount} from './amount.mjs';
import {places} from './settings.mjs';
try {
  assert.equal(parseAmount('1'), 10 ** places, 'whole-unit conversion');
} catch (error) {
  if (!(error instanceof assert.AssertionError)) throw error;
  console.log(JSON.stringify({probeId:'whole_amount',status:'counterexample'}));
  console.error(error);
  process.exitCode = 1;
}
```

import失敗、印のないexit、timeout、signal、候補の改変、receipt不一致は「反例を再現した」と扱わず、新規モデル受付を停止する。例の関数が例外を投げた場合も検査不能となるため、その契約違反を扱うにはhost作成のテストで明示的なassertionにする。印自体は意味上の正しさの証明ではなく、固定検査が所定の結果を報告する形式である。検査コマンドは既存の信頼するhost subprocessで、OS sandboxではない。

検査workspaceにはpaths内だけをコピーし、providerを配信済みの内容で上書きする。下流の未受理候補とhidden oracleはコピーしない。command・候補・環境を結び付けた既存の検証receiptと、入力hash・version・evidenceEpochを保存する。

## worker actionと受付

有効なtaskでは、既存の7フィールドを持つ応答に次を追加する:

```json
{"kind":"diagnose","content":"","paths":["whole_amount"],"observed":[],"missing":[],"hypothesis":"","note":"unverified diagnosis"}
```

追加call・新しいtool・上位への相談を要求することなく、そのモデル応答に続いてhost検査を行う。このactionはファイルを変更せず、consumerの通常試行を一回消費する。次のモデルcallは通常通り別途計測する。

既知の推移的な上流であること、必要入力が全て配信済みであること、read setの全version/evidenceEpochが現在と一致すること、providerが未処理作業を抱えず試行上限内にあることを確認する。同じprobeと入力版の組を二度実行しない。未登録ID、未配信、無関係なprovider、重複は反例を作らない。

正常な失敗を確認した場合、対象provider専用の回復artifactへ固定の診断・版・入力hashをkernelのprepare→validate→commitで保存する。providerからconsumerへの逆依存は作らず、write authorityとfinal oracleを変更しない。既存の自動再検査 `maxUpstreamRechecks` と、probeによる追加再起動 `maxRechecks` は別枠である。providerが既に自動再検査済みでも、新しい証拠で追加起動できるが、workerの試行数・総call・token予算をリセットしない。

## 記録と限界

`swarm/public-probes.json` に要求、未検証claim、入力版/hash、検査結果、拒否理由、kernelの検証IDを保存する。discovery metricsのpublicProbeRequests/publicProbeRechecksは、自動再検査upstreamRechecksと分ける。probeを一つ通したことは全契約の正しさの証明ではない。

これはhostが先に公開反例を用意する方式であり、任意の反例生成や期待値の自動検証、未知の意味依存発見は未対応。課題準備の手間も評価対象に残す。[実行計画](execplan-public-probes.md)、実測は[結果](results/public-probes.md)。
