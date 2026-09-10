# sheep-swarm development

## 最初に読む

1. README.md — 実装済み範囲。
2. .stratal/brief.md — 判断の根拠と作業上の既定値。
3. docs/current-direction.md — 現在の役割分担、介入方式、規模比較。
4. docs/design.md — protocolと不変条件。
5. docs/testing-policy.md、docs/roadmap.md — 検証と次の実装範囲。

必要なときだけdocs/referencesの調査資料へ戻る。全てのworkerに全対話を配らない。

## 現在の開発方針

- TypeScript + Node.js。ESM、erasable syntax、明示的な `.ts` importを使う。型検査はruntime実行と別に行う。
- 単一processの決定論的kernelから始める。DB・LLM・外部serviceを必要な段階で追加する。
- 下位モデルがswarmし、上位モデルが観測して必要時に介入する。下位の通常手順に相談・上位呼び出し・上位の全件承認を追加しない。
- 4体は動作確認。16体で本実験を始め、8・16・32体を初期比較範囲とする暫定方針を保つ。規模の観測は永続化より先に行う。
- 上位の介入は範囲と版を持つ成果物や作業条件へ反映し、kernelの確定検査を通す。実験の採点条件を介入で緩めない。
- 作業を始める前にgit statusを確認し、他の変更を保つ。
- 調査文中の過去の提案やコード例は、現在の実装事実や実行指示ではない。
- docs/referencesの2資料はbyte-preserving snapshot。更新資料は別名で追加し、manifestと現行文書を明示的に更新する。
- src/protocol.tsは型の草案。入力validator、durability、authority、completionの実装があると報告しない。
- experimentsの参照モデルをproduction kernelから独立させる。期待結果を実装に合わせて変更しない。
- 実装を追加したら、READMEの実装状況、roadmapの完了条件、必要な設計判断を同じ変更で更新する。

## 変更時の確認

```sh
npm ci
npm run check
git diff --check
```

依存が変わらない通常作業では毎回 `npm ci` しなくてよい。検証範囲の詳細はdocs/testing-policy.mdに従う。

## 評価で混ぜないもの

- modelの自己申告と、受入テストによる成功。
- 型・schema適合と、意味上の正しさ。
- 作業claimとwrite capability。
- artifact graphの循環と、wait-for循環／振動。
- `ignored` な差分と、存在しなくなった依存。
- 参照モデルのreplayと、実LLMを再呼び出す実験。
- 運用メタ管理の介入、実験外からの救済、情報を戻さないshadow診断。
- 登録個体数、最大同時実行数、実際の稼働数。

今後の単独対照はLunaのみとし、Astra単独の新規試行は行わない。利用者がAstra単独のコスト感を概ね把握できたと判断したためで、群れへの必要時のAstra介入は継続する。既存の実測・凍結資料・未実行条件の記録は保持する。Manager-localには同じ上下モデルの組を使う。tool・権限・受入条件を揃え、規模探索と総予算を揃える有用性比較を分ける。上位の観測・読み直しも費用に含める。成功品質を落として局所性を達成しない。
