# TypeScript自己実装、N/C比較、影響先起動

2026-09-10の「残りも順次進めて。swarmで」に沿い、TypeScriptの静的解析、TS部品の自己実装、N8/16/32とC4/8の局所/広域対照、opt-inの影響先起動を実装・検証した。下位は全て指定の `opencode-go/deepseek-flash`、thinking disabled、上位0。既存Luna/Astra系列のモデルやoracleを変更していない。

## TypeScript adapterとself-host

`.mjs`は既存のSourceTextModule、`.ts`/`.mts`（`.d.ts`を含む）は既存typescript 7.0.2のASTで解析する。type-only import、通常import、re-export、`import('./x.ts').Type`を含む。コメントや文字列中の見かけのimportを拾わず、ソースを実行しない。別process内の仮想filesystemへ明示したbytesだけを渡し、noLib/noResolveの固定projectで構文を解析する。parser失敗・timeoutは成功へ変換せず、POSIXではnative parserもprocess groupごと回収する。

拡張子付き相対参照と公開allowlistに限定し、package/tsconfig pathsの解決、TSX/CTS、任意の意味依存は未対応。TSのdynamic import呼出しとimport-equalsは未解決として拒否する。型検査・Nodeでの実行可否はAST抽出とは別である。compilerは既存devDependenciesを利用するため、TS解析には通常の `npm ci` が必要。Node26/macOS arm64で確認した範囲で、native APIの版はpackage-lockに固定する。

Go swarmが `repo-impact.ts` と規模fixtureの2部品を2call・9,037tokensで実装した。続いて、影響入力の検査を分離する `repo-impact-input.ts` をtask v2経由で1call・2,202tokensで実装した。型だけのimport先 `repo-impact-types.ts` が静的依存として自動配信され、kernelのcheckout・配信ledgerへ記録された。小さな自己のTS部品の実装であり、任意repoの全自動開発を示すものではない。

親はTS parser、接続、固定テスト、実験準備と監査を担当した。Go生成の影響選択を検査helperへ接続するリファクタリングと、疎なedges配列の拒否を補修した。元出力・採用版のhashは[JSON記録](repository-scale-activation.json)で分けている。

初回self-hostの最終コマンドには、snapshotへ明示していないuntrackedの統合テストも指定していた。このNodeのtest runnerは欠落した指定ファイルを実行せず、存在する1テストだけで成功終了した。これを統合成功の根拠にせず、必要ファイルをprotectedへ明示した別snapshotで、ファイル存在を検査してから固定3テストを独立再実行し、全件成功を確認した。追加のモデル再試行はしていない。

## N/Cと初期contextの比較

前段から調整に使っていないseed `holdout-scale-0910`、world7、16個のTS target、64個のopaque policyを固定した。課題familyは前段と同じquote契約であり、独立した新familyのholdoutとは呼ばない。全Nで仕事量は同じ。localはregistry→policyの追加配信、broadは公開65文書を初期配信する。target指示、書込scope、品質oracle、モデル、予算上限を揃えた。world間ではregistryだけが変わり、全資料本文と名前は不変。旧版失敗・全16基準解成功・誤policy拒否をモデル実行前に確認した。

実行順と上限は[profile](../../experiments/read-selection-scale-profile.json)へ保存した。runtimeのsrc/scriptsをコピーしhashを固定して、並行するactivation実装が比較へ入らないようにした。workerごとの私有記憶は既存のままなので、Nを変えると履歴の割当・複製も変わる。単に同じ履歴を複製した対照ではない。

| N | C | 初期context | 品質 | 下位call | tokens | swarm時間 秒 | 参加個体 |
|--:|--:|:--|:--|--:|--:|--:|--:|
| 8 | 4 | local | 成功 | 48 | 123,221 | 26.222 | 8 |
| 8 | 4 | broad | 成功 | 17 | 123,091 | 14.423 | 8 |
| 16 | 4 | broad | 成功 | 17 | 105,137 | 14.982 | 16 |
| 16 | 4 | local | **未完了** | 49 | 114,456 | 30.812 | 16 |
| 32 | 4 | local | 成功 | 48 | 107,340 | 26.454 | 32 |
| 32 | 4 | broad | 成功 | 16 | 97,276 | 13.629 | 16 |
| 16 | 8 | broad | 成功 | 17 | 107,381 | 11.589 | 16 |
| 16 | 8 | local | 成功 | 49 | 114,779 | 19.523 | 16 |

上位は全0、実際の最大同時稼働は各Cと同じ。全8条件でusageは完全、予約超過/残予約/未知usageは0、元repoは不変。保存候補へ固定oracleを新しく再実行した。N16/C4 localは `unit-10.ts` が3回目のreadを要求して上限2に達し、未処理義務とblocking claimが残った。最終oracleも失敗した。15/16対象は二段読取を観測できたが、全体成功にはしない。この条件を成功品質の費用比較へ混ぜない。

成功したlocalは全16対象で二段読取を観測した。context JSONの合計は約75.9–76.8KB、broadは約114.8–122.0KB。これは全promptサイズではなく、catalog・制御指示・私有記憶などは別に加わる。providerの総tokensではlocalが全ての成功ペアでbroadより多く、N8の差は130tokensに留まった。1回の配信量や追加bytesだけで優位を判断しない。

各条件1回・同じ課題familyであり、人数増加の因果効果、創発、最適人数は示さない。C8の所要時間が短い観測もprovider待ち時間を制御した反復ではない。今回は同じtoken上限を揃えたN/C・初期contextの対照までで、単独Luna/Manager-localとの有用性比較、総記憶量を揃えた対照、上位介入の効果は別の未実施課題である。

### 最初の停止と条件修正

最初は各200,000tokens・受付予約10,000tokens、局所検査に `node --check` を使った。N8 localは48call・123,370tokensで成功したが、broadは18call・134,493tokens、予約超過1件で停止し、JSON importのattribute不足で最終oracleも失敗した。usage不明は0。さらに、この環境の `--check` が `as const` を不正構文として却下した診断を保存した。

TSの局所検査をNodeのmodule読み込みへ変更し、正しいTS構文とJSON importを実行環境で検査するようにした。採点case・期待値は変更していない。新しい比較では全条件を各最大300,000tokens・予約20,000tokensに揃え、最初の2試行257,863tokensを総受付上限1,600,000tokensへ繰り越した。元の試行を上書き・成功扱いにはしていない。

修正後のN16/C4 localで一度dispatcherを止め、停止原因を確認した。これは既知精算済みの意味的な未完了なので、回数や品質条件を緩めず、残り4つの独立条件を実行した。未知usage・予約超過・検証基盤障害・証拠欠落は引き続き後続停止条件。修正後8条件は892,681tokens、最初の停止分を含め1,150,544tokens。部品実装・self-host・activationを加えると今回の既知総量は1,163,551tokens。親の実装/レビュー費用は未測定、cache write量と通貨費用は不明のまま残す。

## 変更からの必要target起動

task v2へ `activation: {changedPaths:["policy.ts"]}` を追加した。省略時は従来どおり全targetを起動する。changedPathsはhostの明示宣言で、Git diffの自動推測ではない。静的依存・明示dependsOn・共通contextの逆向き到達範囲から、最初のgoal変更で起動するtargetを求める。未対応言語のtargetは保守的に起動する。

write authorityは元のmanifest内のまま。初期に起動しないtargetもkernelの既知依存を保持し、その後の確定変更で必要になれば起動する。モデルのconfidenceで対象・権限・oracleを緩めない。全体oracleは起動しなかったtargetも含めて検査するため、静的graphにない意味依存を見逃したケースは失敗となる。任意の意味依存の完全な影響分析とはしない。

実Goの3target課題では、policy→a→bの関連2targetだけが2call・1,768tokensで成功した。N4/C2、実最大同時稼働1（依存順序による）、上位0。bはaの受入済みversion1を受け取り、unused.tsは呼出しも変更もなし。元repoのHEAD/bytesは不変。独立検査で旧版失敗・保存候補成功を確認した。

## 検証・再現

`npm run check` は型検査・480テスト・原資料2snapshotが成功した。新しい反例はTS type-only依存、構文/公開範囲/循環、実行しないAST解析、疎な入力配列、TS module検査、必要2targetの起動と受入版配信、0callの全体受入、意味依存の見逃しによる非成功を含む。通常gateはAPIを呼ばない。

```sh
node scripts/prepare-read-selection-pilot.mjs --output .sheep/scale-new --seed holdout-scale-0910 --world 7 --targets 16 --documents 64
npm run sheep -- repo --repo .sheep/scale-new/repo --task .sheep/scale-new/local.json --runtime opencode-go --worker-model deepseek-flash --go-thinking disabled --workers 16 --concurrency 4 --max-worker-calls 64 --max-meta-calls 0 --max-rounds 24 --max-tokens 300000 --reserve-tokens 20000 --max-tokens-per-call 6000 --timeout-ms 120000 --output .sheep/scale-new-local
node scripts/audit-read-selection.mjs --run .sheep/scale-new-local --fixture .sheep/scale-new/fixture.json --output .sheep/scale-new-local-audit
```

認証は既存のGo手順に従って環境へ明示する。broadは同じ生成物のbroad.jsonを使い、出力を新しい名前にする。比較表のrunはactivation追加前の固定runtimeを使用した。現在のruntimeはactivation省略時の全target起動を保持しているが、厳密な再集計には保存したraw/profile/hashを用いる。

rawは `.sheep/m8-build/` のcomponents-run、self-host-run、最初のn8系列、module-n*系列、activation-run、各独立監査に保存した。JSON記録にはresult/artifacts/task/ledger/kernelと独立受入のhashを含む。rawはignoredなローカル資料であり、Git内の集計だけから全呼出しを再構成できるとは主張しない。前段の結果は凍結したまま保持している。
