# 段階的読取を広い初期contextと同じ品質条件で測る

このExecPlanは実装と観測に合わせて更新する。PR #5は2026-09-10に `fe037dd2069709526e90797abe37cbf4fd9f7193` としてマージ済み。作業branchは `codex/progressive-read-pilot`。

## Purpose / Big Picture

workerの読むファイル数そのものではなく、必要な情報を得て正しく完成するまでの総負担を比較する。公開ファイルの名前を知るだけで正解policyを選べたM6課題を補い、registry本文による二段の要求/配信を観測する。同じrepo・公開scope・指示・N/C・予算で、局所初期contextと全公開資料を初期配信する対照を用意する。

## Progress

- [x] (2026-09-10 13:33:03Z) PR #5を検証済みheadでマージ。
- [x] (2026-09-10 13:35:00Z) 添付の方向を現行実装と照合し、最初の範囲を限定。
- [x] (2026-09-10 13:50:58Z) 1要求のpath数をtask v2で制限し、旧既定32を維持。
- [x] (2026-09-10 13:50:58Z) opaqueな公開資料・registry・別world・固定品質oracleを用意。
- [x] (2026-09-10 13:50:58Z) Go DeepSeek swarmによる生成部品を独立にレビューし統合。
- [x] (2026-09-10 13:50:58Z) 決定論的な局所/広域対照、誤推測・まとめ読取・証拠欠落の反例を検査。
- [x] (2026-09-10 13:50:58Z) 同じ課題で小規模のGo DeepSeek局所/広域実走と独立受入を報告。
- [ ] 後続: TypeScript adapterとself-host、N/C系列、impact/activation（本変更の完了範囲外）。

## Surprises & Discoveries

- Observation: M6のcatalogは全公開path名を渡す。opaque化だけでは推測が不可能にはならず、1path制限も静的な推移依存や初期contextの配信量制限ではない。
  Evidence: src/repo-discovery.ts、M6のcall-1でregistryとpolicyを同時要求。
- Observation: 配信の証拠はモデルの理解や記憶内容そのものを証明しない。固定品質と、registry配信がpolicy要求と同じcallまたは前かという手続きの検査を分ける必要がある。
  Evidence: 添付議論の「何を知っていたか」という表現と、保存されたcheckout/callの観測可能な差。

- Observation: Go生成部品は固定2テストを通ったが、strict型検査のエラーとworldが2資料だけを巡る制約が残った。親が補修し、追加の反例検査を行った。
  Evidence: `.sheep/m7-build/components-run`、`generated`、[採用版hash](results/read-selection-pilot.json)。
- Observation: localは1call最大1,096bytes、broadは3,017bytesだが、全callのJSON context合計は6,044/6,034bytesと近く、tokensはlocalの方が多い。
  Evidence: [同品質pilot](results/read-selection-pilot.md)。

## Decision Log

- Decision: 最初はmaxPathsPerRead、課題、観測器だけを追加する。
  Rationale: 全文配信より局所読取が得かを測る前に、万能parserや探索サービスを構築しない。
  Date/Author: 2026-09-10 / Codex、添付議論を作業上の既定値へ具体化。
- Decision: language-independentな依存証拠とlanguage-specificな観測adapterの分離を方向として採用し、confidenceをkernelの確定根拠にしない。
  Rationale: static候補、実配信、model-claimは異なる証拠。読取要求だけで永続edgeや意味的正しさを確定しない。
  Date/Author: 2026-09-10 / Codex。
- Decision: 既存指定を引き継ぎ、実装部品と初期実走にはopencode-go/deepseek-flashを使う。N=4/C=2、上位0、各12call/100000tokensの範囲とする。
  Rationale: 初期課題の疎通を規模比較と混同せず、unknown usageが出れば後続を止める。
  Date/Author: 2026-09-10 / 利用者の継続指示と既存モデル指定。

## Outcomes & Retrospective

最初の範囲を実装し、実Goで両条件の固定品質と独立受入に成功した。localは6call/8,241tokens、broadは2call/5,593tokens。両targetで二段読取を観測できた一方、この小課題では追加callが総負担を増やした。元のM6成果と[今回の証拠](results/read-selection-pilot.md)を分けて保持する。後続のTS/self-host、N/C、impact/activationは未実装。`npm run check`で472テスト、型検査、原資料2snapshotが成功し、`git diff --check`も成功した。

## Context and Orientation

rootは `/Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm`。`src/repo-manifest.ts` はhost task入力を検査し、`src/repo-discovery.ts` は公開catalog・要求・配信・未解決事項を持つ。`src/kernel.ts` は版/read set/lease/受入を確定する。read scopeは本文を得る範囲、impact scopeは変更の影響候補、write authorityは実際に書ける範囲。今回はread scopeの初期条件だけを比較する。全target起動は維持する。

`src/repo-types.ts`のv2 discoveryへmaxPathsPerReadを追加する。`scripts/read-selection-fixture.mjs`はseedとworldから固定課題を作る純関数、`src/read-selection-audit.ts`は保存されたcall順・read要求・配信を照合する純関数。後者はruntimeの判断へ情報を返さず、固定品質oracleとも分離する。

## Plan of Work

まず固定した受入テストを置き、上の2部品を実swarmへ渡す。親はmanifestの上限制御、fixtureのGit準備script、独立oracle、run証拠の集計を担当する。opaqueな文書の内容と名前は同じseedでは同一にし、world間ではregistryの指示先だけを変える。これで名前の一覧から正解を一意に決められない反例を作る。実モデルが推測で当てた場合も品質成功と二段読取の観測を分ける。

広域対照は同じ公開readableをcontextにも加える。target指示と品質検査は一致させる。広域配信の量をread追加bytesだけで比較せず、初期contextと全callのprompt/使用tokensも記録する。1回のpaired pilotから一般的な費用優位を断定しない。自動write/impact範囲の拡張は行わない。

## Concrete Steps

rootで `node --test tests/read-selection-*.test.ts`、`npm run check`、`git diff --check` を実行する。

`node scripts/prepare-read-selection-pilot.mjs --output .sheep/read-selection-01 --seed pilot-01` は新しいrepoとlocal/broadの2taskを作る。各runを異なる出力へ保存し、worker-model=deepseek-flash、runtime=opencode-go、thinking=disabled、N4/C2、max-worker-calls12、max-meta-calls0、max-tokens100000、reserve-tokens20000で実行する。seed/課題/oracle/hashはモデル実行前に固定する。

## Validation and Acceptance

未実装部品は固定試験で失敗し、実装後はopaque world不識別、oracleの旧版失敗・基準解成功・誤policy拒否を通す。maxPathsPerReadは1..32の整数、省略32、v1には未追加。cap超過は部分配信せず未解決にする。1pathでもその静的推移依存が多い場合を切り捨てない。

実走の品質と読取順を別々に表示する。二段証拠は同じtargetのregistry配信がpolicy要求と同じcallまたは前、policy配信がその要求より後で最初の受入writeまでに存在すること。call順は記録配列を使い、文字列IDの辞書順や時刻だけで推定しない。未知call、未知target、欠落・矛盾するreceiptは判定不能/拒否にして成功扱いしない。ローカルrepoはapplyなしで不変、保存候補に同じ固定検査を独立再実行する。

## Idempotence and Recovery

出力は新directoryのみ、過去runの再開・書換えはしない。失敗runを残し、未知usage時は自動で次runへ進めない。認証は既存のGo keyを親processで明示使用し、出力へ残さない。source修正の受入はworker自己申告ではなく固定テスト・親レビューで判断する。

## Artifacts and Notes

元議論は2026-09-10添付 `a53c1042-75d8-4993-b066-24d97846b17c/pasted-text.txt`。M6は `docs/results/repository-discovery.md`、今回の証拠は新しい `.sheep/m7-build/` と `docs/results/read-selection-pilot.md` へ分ける。

## Interfaces and Dependencies

既存Node/TypeScript/runtimeのみを使う。RepoDiscoveryOptions.maxPathsPerReadは正規化後の整数。生成部品の正確な型とfixture shapeは先に固定した `tests/read-selection-components.test.ts` を契約とする。ASTのTS adapterは次の段階で既存toolchainを使う方向だが、現時点の`.mjs`対応を多言語対応とはしない。
