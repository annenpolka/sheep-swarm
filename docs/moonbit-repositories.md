# MoonBitのrepository task

`.mbt`をtask v2のtargetに指定できる。`moon.mod` / `moon.mod.json`のmodule名・source directoryと、`moon.pkg` / `moon.pkg.json`のimportを読み取り、同じmodule内のpackage依存を配信する。新形式がある場合は新形式を優先する。構文の根拠は公式の[package設定](https://docs.moonbitlang.com/en/latest/toolchain/moon/package.html)と[module設定](https://docs.moonbitlang.com/en/latest/toolchain/moon/module.html)。

## 使い方

通常と同じ`repo` commandを使う。言語選択flagは不要。Moon toolchainが必要なのはhost側の検査であり、静的探索ではMoonを実行しない。

再現用の小さなGit projectとtaskを生成できる。`NEW_DIRECTORY`はまだ存在しないdirectory、`MOON_HOME`は利用するMoon installationへ置き換える。

```sh
node scripts/moonbit-repository-fixture.mjs NEW_DIRECTORY MOON_HOME
npm run sheep -- repo --repo NEW_DIRECTORY --task NEW_DIRECTORY/task.json \
  --runtime opencode-go --worker-model deepseek-flash --go-thinking disabled \
  --workers 4 --concurrency 2 --max-calls 6 --max-meta-calls 0 \
  --max-tokens 80000 --reserve-tokens 12000 --max-tokens-per-call 4000 \
  --output .sheep/my-moonbit-run
```

既存の`OPENCODE_GO_API_KEY`を親環境へ設定して使う。候補が既定で、受入後に元projectへ反映したい場合は`--apply`を追加する。checkは`moon check --frozen --target js`と`moon test --frozen --target js`。隔離HOMEでもtoolchainを見つけるため、生成されたcheck wrapperが明示MOON_HOMEを使う。依存downloadやtoolchain installは行わない。

実projectでは、書換対象を`files`、必要なmodule/package設定とsourceを`discovery.readable`に列挙する。対象packageとimport先packageのsnapshot内`.mbt`をすべて公開範囲へ含める。同一packageの補助ファイルも配信される。`context`に入れたfileは全targetの依存になるため、局所性を保つには必要なものを`readable`へ入れる。固定テストを非公開にする例では、oracleを別packageに置いて`protected`だけへ指定している。

## 対応範囲

- module内のpackage import、alias、test/wbtest import。テスト用importも保守的に合併するため、不要な依存が増えたり、テストだけの循環を拒否することがある。
- 明示source directoryとdefault root。module/import名は英数字・`_`・`-`のpath components。sourceは通常の相対directoryを扱い、`.`・`..`やbackslashを拒否する。
- metadataはname/source、一般的なversion/license等とpackageのis-main、警告設定、test-import-all、`pkgtype(kind: "executable")`。JSONはstrict JSON、DSLはコメントと文字列をtokenizeして全入力を消費する。宣言的なsubsetであり、Moonの全構文validatorではない。
- core packageはtoolchain提供として扱う。依存内容の正しさ、`.mbt`本文の構文・型・挙動は固定host checkで検査する。
- `activation.changedPaths`から影響先だけを初期起動する。配信したproviderの版・hashと全体oracleの受入は従来どおり記録する。

v2では**各packageの書換対象を1つの`.mbt`に限定**する。同じpackageの他ファイルはreadonlyとして配信し、相互可視性による循環writeを避ける。複数ファイルを同時に書き換える作業はtaskを分割するか、v1で依存・context・検査を明示する。v2でのmanifest書換も拒否する。

外部module、`moon.work`、生成source、条件付きtargets、virtual package、FFI/native-stub等の未対応設定、literate `.mbt.md`は静的探索の対応外。該当する構成や公開catalogの不足を検出した場合は拒否する。未知の依存を「なし」として続けず、v1の明示契約か別のadapterを使う。snapshot外のignored/untracked fileは従来どおり探索対象外である。

## 確認した実走

Go swarmが2つの`.mbt`を修正し、実Moon compilerの固定2テストを通過した。N4/C2設定、実同時稼働1、参加2個体、2call・2,323tokens。無関係packageは未起動、元repoは不変。[測定と制約](results/moonbit-repository.md)。
