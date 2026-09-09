# 参照実験

現在は、調査レポート第7.3節・付録Aのwrite skew反例だけを実行できる。

```sh
npm test
npm run demo
```

初期状態 `x=1, y=1`、不変条件 `x+y >= 1`。Aはyを読んでxを0に、Bはxを読んでyを0にしようとする。各workerのread→commit順序を保つ全6順序を `schedules.ts` に明記した。

書き込み先の版だけの検査では4順序で制約を破る。観測した全read setを検査する方式では0順序で、競合する二つ目の提案を棄却する。

これは実障害確率や一般的な安全性の証明ではない。棄却後のretry、未知のread、外部状態、LLM、永続化はモデル化していない。

今後kernelを追加しても、この参照モデルからproduction実装をimportしない。新しいfault modelは独立したfixtureと受入条件を先に定義する。
