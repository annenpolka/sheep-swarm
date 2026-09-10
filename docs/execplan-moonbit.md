# MoonBit repository support

## Purpose / Big Picture

MoonBitのパッケージ依存と同一パッケージの補助宣言をv2 repository taskへ渡し、変更の影響を受けるtargetのみ起動できるようにする。指定のopencode-go/deepseek-flash swarmと実Moon compilerで確認する。

## Progress

- [x] (2026-09-10 14:30:00Z) 公式module/package文法とインストール済みmoonを確認。
- [x] (2026-09-10 14:30:00Z) 固定parserテストを先に保存し、Go swarmへ実装委譲。
- [x] (2026-09-10 14:30:00Z) 親で型・入力境界を修正し、依存探索とactivationへ接続。
- [x] (2026-09-10 14:35:00Z) 実compilerのbaseline/reference/wrong検査とGo swarm実走。
- [x] (2026-09-10 14:34:53Z) 全gate・文書・証拠・commit準備を完了。

## Surprises & Discoveries

Go生成parserは固定runtimeテストに合格したが、未使用引数、DSL depsの黙認、文字列のescape不足があった。親の型検査・独立境界テストで検出し修正した。検証checkはHOMEを隔離するため、Moon toolchainの絶対パスをhost指定で渡す。

## Decision Log

- Decision: public catalogだけを解析し、同一パッケージのsnapshot内.mbtとmetadataが未掲載なら開始前に拒否する。
  Rationale: 依存を黙って省かず、読取権限を広げない。
- Decision: v2は各packageに書換対象1ファイル。補助ファイルはreadonly。import/test-import/wbtest-importを保守的に合併する。
  Rationale: 同一packageの相互可視性をkernelの循環write依存へ変換しない。複数対象は分割か明示v1を使う。
- Decision: 単一module内の通常sourceとcore package、JSON/DSLの宣言的subsetを扱い、外部module・workspace・生成・条件付き・virtual/FFI等の設定は拒否する。
  Rationale: Moonやbuild scriptを依存解析で実行しない。受入にはhostのmoon check/testを使う。

## Outcomes & Retrospective

実Go修正2call/2323tokensで関連2targetが受入成功。元repo不変・受理済みprovider版配信を独立確認した。488テスト・型検査・原資料2snapshot成功。外部依存等の未対応範囲は明示した。

## Context and Orientation

src/repo-dependencies.tsが静的edge、src/repo-discovery.tsが読取配信とactivationを持つ。新規src/moonbit-manifest.tsは純粋parser、src/repo-moonbit.tsはpublic catalogのpackage解決を担当する。

## Plan of Work

parserのみをGoへ委譲し、親がscoped resolverとfixed oracleを用意する。実MoonBit fixtureはpolicyからa、bへ伝播させ、unusedを起動しない。oracleを別packageに置き、非公開の固定テストとして保持する。

## Concrete Steps

node --test tests/moonbit-*.test.ts。node scripts/moonbit-repository-fixture.mjs NEW_DIRECTORY MOON_HOME。repo CLIはGo/deepseek-flash、N4/C2、upper0、parser最大4call/80k tokens、Moon修正最大6call/80k tokens。npm run checkとgit diff --check。

## Validation and Acceptance

別process/compiler oracleでbaseline失敗・reference成功・境界誤実装失敗を実走前に確認。候補は同じ固定oracleへ合格し、元repo不変、関連2targetだけ起動、後段が受理済みprovider版を読むことを検査する。parser JSON/DSL、source root、missing/外部/cycle、public範囲、型検査を通常gateへ追加する。

## Idempotence and Recovery

rawは.sheep/moonbit-buildの別directoryへ保持。未知usage・予約超過で新規受付停止。既存keyは親メモリだけに設定。候補の採用でモデルを再呼出ししない。

## Artifacts and Notes

parser-runは3call/30669tokens、runtime合格後に親が境界と型を修正。実走のpublic集計はdocs/results/moonbit-repository.jsonとMarkdownへ保存する。

## Interfaces and Dependencies

parseMoonManifest(path,text)はname/source/imports。discoverMoonBit(contents,writable)はedge/issue。compilerは任意host checkであり、通常npm gateや静的探索の必須依存にはしない。npm依存追加なし。
