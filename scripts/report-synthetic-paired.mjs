import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {buildSyntheticTask} from '../experiments/synthetic-corpus/index.ts';
import {digest, summarizePaired} from '../experiments/synthetic-paired.ts';
import {auditSeries} from './synthetic-paired-benchmark.mjs';
const load = async p => JSON.parse(await readFile(p, 'utf8'));
if (process.argv.length !== 4) throw new Error('Usage: node scripts/report-synthetic-paired.mjs RUN_DIRECTORY OUTPUT_PREFIX');
const root = resolve(process.argv[2]), prefix = resolve(process.argv[3]);
const audit = await auditSeries(root), profile = await load(join(root, 'profile.json'));
const changes = [], accounting = [], evidenceStops = [];
for (const row of audit.rows) {
  const f = buildSyntheticTask(row.id), a = await load(join(root, 'runs', row.id, row.method, 'artifacts.json'));
  const edited = f.task.files.map(t => t.path).filter(p => a[p] !== f.files[p]);
  changes.push({id: row.id, method: row.method, knownDefectedTargets: f.metadata.defectedPaths.length, editedTargets: edited.length,
    editedOriginallyNondefectedTargets: edited.filter(p => !f.metadata.defectedPaths.includes(p)).length});
  const directory = join(root, 'runs', row.id, row.method), run = await load(join(directory, 'result.json'));
  accounting.push({id: row.id, method: row.method, knownTokensLower: run.budget.observedTokens, totalTokens: row.tokens,
    unknownUsageCalls: run.budget.unknownUsageCalls});
  if (row.evidenceErrors.length) {
    const calls = [];
    for (const c of row.method === 'single' ? run.calls : run.swarm.calls) {
      const receipt = await load(join(directory, row.method === 'single' ? '' : 'swarm', c.id + '.json'));
      const tr = receipt.transcript;
      calls.push({id: c.id, outcome: c.outcome, error: receipt.error ?? null, httpStatus: tr?.httpStatus ?? null,
        requestedModel: tr?.requestedModel ?? null, effectiveModel: tr?.effectiveModelEvidence ?? null,
        usageCompleteness: tr?.usageCompleteness ?? null, timedOut: tr?.timedOut ?? null, cancelled: tr?.cancelled ?? null});
    }
    evidenceStops.push({id: row.id, method: row.method, knownTokensLower: run.budget.observedTokens,
      unknownUsageCalls: run.budget.unknownUsageCalls, activeReservations: run.budget.activeReservations, locked: run.budget.locked, calls});
  }
}
const comparableRows = audit.rows.filter(r => r.evidenceErrors.length === 0);
const comparableSummary = summarizePaired(profile.cases, comparableRows);
const report = {...audit, summary: comparableSummary, profile, accounting, evidenceStops, exploratoryEdits: changes,
  summaryDefinition: 'Only runs without evidence errors; method totals include unmatched runs, paired comparisons require both methods.',
  generatedAt: new Date().toISOString(),
  analysis: {sourceSha256: digest(await readFile(import.meta.filename)),
    timing: 'Edit-count analysis added after dev series began. Counts source changes, not semantic regressions. Private defect metadata never fed to solvers.'}};
await writeFile(prefix + '.json', JSON.stringify(report, null, 2) + '\n');
const s = comparableSummary.overall, resources = audit.summary.overall.methods;
const n = v => v === null ? '不明' : v.toLocaleString('en-US');
const sec = v => v === null ? '—' : (v / 1000).toFixed(2), ratio = v => v === null ? '—' : v.toFixed(3);
const groups = (heading, data) => [`## ${heading}`, '',
  '| 条件 | 完了組/予定組 | Single成功/run | Sheep成功/run | 両方成功 | Singleのみ成功 | Sheepのみ成功 | 両方失敗 | 速度比中央値 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...Object.entries(data).map(([k, g]) => `| ${k} | ${g.completedPairs}/${g.plannedPairs} | ${g.methods.single.successes}/${g.methods.single.runs} | ${g.methods.sheep.successes}/${g.methods.sheep.runs} | ${g.bothSuccess} | ${g.singleOnlySuccess} | ${g.sheepOnlySuccess} | ${g.neitherSuccess} | ${ratio(g.medianSingleOverSheep)} |`), ''];
const lines = ['# dev合成課題のSingle/Sheep対応比較', '',
  `状態: **${audit.complete ? '全件完了' : '未完了'}**。${audit.completedRuns}/${audit.plannedRuns} run、証拠が揃った比較は${s.completedPairs}/${s.plannedPairs}組。停止理由: ${audit.stopReason ?? (audit.inFlight ? '実行中' : 'なし')}。`, '',
  '[事前計画](../execplan-synthetic-paired.md)に従い、PR #8の全256件の公開/非公開hashを凍結した。今回の対象はdev 128件のみ。evaluationの追加呼出しやManagerの呼出しは含まない。', '',
  '## 固定条件', '',
  '- `opencode-go/deepseek-flash`、thinking enabled、上位0、toolなし。Single N1/C1・名前付き全file提案、Sheep N16/C4・1target提案・全target起動。',
  '- 同じrepository・公開契約/check・write範囲・最終oracleを使用。公開情報へのアクセス範囲は共通だが、初期context、提案、検証、再試行の粒度は方式に含まれる。',
  '- 各課題/方式で128call、総2,000,000tokens、予約200,000tokens/call、出力64,000tokens/call。task締切なし。通信timeout600秒は採点の制限時間ではない。',
  '- 課題順をhashで固定し、同じ課題の両方式を隣接実行。各familyで先攻8/8、課題間の並列実行なし。各課題は方式ごとに1回。',
  '- 完了時間はrunner開始から最終検査を含む返却まで。成功時のみcompletionを記録。準備と独立監査を別計上。', '',
  '## 観測', '',
  `対応が揃った${s.completedPairs}組ではSingle ${s.bothSuccess + s.singleOnlySuccess}/${s.completedPairs}成功、Sheep ${s.bothSuccess + s.sheepOnlySuccess}/${s.completedPairs}成功。両方成功${s.bothSuccess}組、Singleのみ${s.singleOnlySuccess}組、Sheepのみ${s.sheepOnlySuccess}組、両方失敗${s.neitherSuccess}組。`, '',
  `有効なrun全体ではSingle ${s.methods.single.successes}/${s.methods.single.runs}成功、Sheep ${s.methods.sheep.successes}/${s.methods.sheep.runs}成功。こちらには片側だけ結果が揃った課題も含む。`, '',
  `証拠/基盤の異常がある${audit.rows.length - comparableRows.length} runは品質・速度の対応比較から除外し、未確定として扱う。消費したcall/tokenや停止記録は資源表とJSONへ残す。`, '',
  `両方成功した同じ課題ではSheepが速い${s.sheepFaster}組、Singleが速い${s.singleFaster}組。速度比Single/Sheepの中央値は${ratio(s.medianSingleOverSheep)}（1より大きいとSheepが速い）。差Single−Sheepの中央値は${sec(s.medianSingleMinusSheepMs)}秒。成功集合が異なる方式別中央値を速度差として比較しない。`, '',
  '![対応した完了時間と受入結果](synthetic-paired-dev.png)', '',
  '| 方式 | call | 既知tokens | 総tokens | 成功時完了中央値 秒 | 全run経過時間計 秒 |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...['single', 'sheep'].map(m => {const v = resources[m], known = accounting.filter(r => r.method === m).reduce((n, r) => n + r.knownTokensLower, 0); return `| ${m} | ${n(v.calls)} | ${n(known)} | ${n(v.totalTokens)} | ${sec(s.methods[m].medianCompletionMs)} | ${sec(v.elapsedMs)} |`;}), '',
  `系列の既知tokensは${n(audit.knownTokens)}、総tokensは${n(audit.totalTokens)}。準備${sec(audit.preparationElapsedMs)}秒、独立監査計${sec(audit.rows.reduce((n, r) => n + r.auditMs, 0))}秒。reasoningは出力tokenの内数で二重加算しない。実請求額と作成人手時間は不明。未確定callがあれば既知tokensを全消費量とみなさない。`, '',
  ...groups('family別', comparableSummary.family), ...groups('target数別', comparableSummary.targetCount),
  ...groups('topology名別', comparableSummary.topology), ...groups('実際の依存深さ別', comparableSummary.dependencyDepth),
  '## 未受入のrun', '',
  '| 課題 | 方式 | target数 | elapsed 秒 | call | 終了分類 |', '| --- | --- | ---: | ---: | ---: | --- |',
  ...audit.rows.filter(r => !r.success).map(r => `| ${r.id} | ${r.method} | ${r.targetCount} | ${sec(r.elapsedMs)} | ${r.calls} | ${r.evidenceErrors.length ? '証拠/基盤停止' : r.termination} |`), '',
  '品質の不合格は候補を保存して次へ進む。hiddenの失敗内容を修正callへ戻していない。実行基盤や証拠の異常による停止と、意味上の不合格を区別する。', '',
  ...evidenceStops.flatMap(e => [`停止した${e.id}/${e.method}ではunknown usage ${e.unknownUsageCalls} call、既知の消費下限${n(e.knownTokensLower)}tokens、active reservation ${e.activeReservations}。応答HTTP statusは${e.calls.map(c => c.httpStatus ?? '不明').join('/')}。使用量やモデル識別が欠けたcallを0消費とみなさず、系列はlockしたままにする。`, '']),
  `未実行は${audit.plannedRuns - audit.completedRuns} run。未確定の片側結果がある組も含め、全${s.plannedPairs}組の比較は未完了である。`, '',
  '## 解釈の限界', '',
  'devは8系統内の128 variantで、独立した128種類の実務課題ではない。target数とtopologyは非直交。devの宣言依存深さは1〜3段で、chainは0件。evaluationにはchainが24件あり最大31段なので、分割にはfamilyだけでなく依存構造の分布差もある。devから深いchainへの外挿はできない。方式の速度比は両方成功した集合に条件づけられている。APIの時刻変動・cache・実行環境の影響を完全には除けない。', '',
  'PR #8でevaluationのvariant 0を8件観測済みなので、evaluationを完全未見とは呼ばない。今回のdev結果から設定を固定するまでevaluationを追加実行しない。Managerや新しいrecovery機構の優位もこの系列では検証していない。', '',
  '元コードから編集されたtarget数を実行開始後の探索的分析としてJSONに収録する。既知不具合のないtargetを編集した数は意味上の回帰数ではない。作者側の不具合metadataはこのhost集計だけで使い、solverへの入力には使っていない。', '',
  '## 検証と再現', '',
  '通常gateは555テスト成功、参照snapshot2件一致。全256課題のhash一致、dev 128件の元コード・基準解・意味変異のpreflightを確認した。独立監査はAPI raw usageとbudget、モデル・thinking、公開context、元repo不変、候補hash、独立受入、予定順序を照合する。', '',
  '```sh', 'node scripts/synthetic-paired-benchmark.mjs audit .sheep/synthetic-paired/dev-v1',
  'node scripts/report-synthetic-paired.mjs .sheep/synthetic-paired/dev-v1 docs/results/synthetic-paired-dev', '```', '',
  '図はMatplotlibで生成する。任意の隔離Python環境へ`experiments/synthetic-paired-plot-requirements.txt`を入れ、`python scripts/plot-synthetic-paired.py docs/results/synthetic-paired-dev.json docs/results/synthetic-paired-dev`でPNG/SVGを出力する。描画依存はbenchmark runtimeへ追加していない。', '',
  '[固定profile・全観測行・交差集計・探索的編集数](synthetic-paired-dev.json)。raw記録はignoredの`.sheep/synthetic-paired/dev-v1/`へ保存。途中のrunを再送して欠測や費用不明を隠さない。', ''];
await writeFile(prefix + '.md', lines.join('\n'));
