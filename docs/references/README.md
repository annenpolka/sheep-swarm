# 調査資料のsnapshot

この2資料を、2026-09-09の初期化時に元のbytesのままコピーした。

- [羊型Agent Swarm再検討](raw--deep-research-sheep-agent-swarm-theory-20260909.md) — 理論、原典照合、設計案、評価計画。
- [元対話からの抽出と整理](raw--session-extract-sheep-agent-swarm-20260909.md) — 15対話、原文5,154行と整理。

`manifest.json` はファイル名、サイズ、SHA-256、元の保存先識別子を記録する。`npm run check:references` で照合する。

ここは過去の資料の固定保存先。過去の発話・製品推奨・実装案を現在の指示や実装済み事実と取り違えない。原文には当時のローカル絶対パスも残っているが、開発コマンドはそれらに依存しない。

現在の方針は [docs/current-direction.md](../current-direction.md)、設計は [docs/design.md](../design.md)、実装状況は [README](../../README.md)、継続する判断は [.stratal/brief.md](../../.stratal/brief.md) を参照。資料に訂正が必要なら、原文を修正せず別資料と現在の設計へ反映する。
