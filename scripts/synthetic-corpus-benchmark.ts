import {mkdir, readFile, writeFile, readdir} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildSyntheticTask, listSyntheticTasks} from '../experiments/synthetic-corpus/index.ts';
import {materializeSyntheticTask, preflightSyntheticTask} from './synthetic-corpus.ts';
import {runRepository} from '../src/repo-run.ts';
import {captureRepository} from '../src/repo-files.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
import {callOpenCodeGo, type OpenCodeGoOptions} from '../src/opencode-go-worker.ts';
import {extractTokenUsage} from '../src/cost-estimate.ts';
import {summarizeTrials, type TrialMetric} from '../experiments/quality-metrics.ts';

const save = async (p: string, v: unknown) => writeFile(p, JSON.stringify(v, null, 2) + '\n');
const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {withFileTypes: true});
  return (await Promise.all(entries.map(e => e.isDirectory() ? sources(join(dir, e.name)) : Promise.resolve([join(dir, e.name)])))).flat();
}

if (process.argv.length !== 3) throw new Error('Usage: node scripts/synthetic-corpus-benchmark.ts NEW_OUTPUT_DIRECTORY');
if (!process.env.OPENCODE_GO_API_KEY) throw new Error('OPENCODE_GO_API_KEY is required; this script does not import credentials');
const root = resolve(process.argv[2]!);
await mkdir(root);
const started = performance.now();
const selected = listSyntheticTasks().filter(s => s.variant === 0);
if (selected.length !== 16 || selected.some(s => s.targetCount !== 4)) throw new Error('pilot selection changed');
const limits = {maxCalls: 32, maxRounds: 64, maxTokens: 1000000, reserveTokensPerCall: 100000, maxTokensPerCall: 64000, timeoutMs: 600000};
const sourcePaths = [...await sources('src'), ...await sources('experiments/synthetic-corpus'), 'scripts/synthetic-corpus.ts', 'scripts/synthetic-corpus-benchmark.ts', 'package.json', 'package-lock.json'];
const runtimeHashes: Record<string, string> = {};
for (const p of sourcePaths) {
  const bytes = await readFile(p); runtimeHashes[p] = hash(bytes);
  await mkdir(dirname(join(root, 'runtime', p)), {recursive: true}); await writeFile(join(root, 'runtime', p), bytes);
}
const profile = {format: 1, baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), runtime: 'opencode-go', model: 'deepseek-flash', thinking: 'enabled', workers: 4, concurrency: 2, upperCalls: 0, limits, seriesAdmissionTokens: 16000000, taskDeadlineMs: null, repeats: 1, selection: 'variant 0 from each family, fixed before calls', cases: selected.map(s => ({id: s.id, family: s.family, split: s.split, hashes: buildSyntheticTask(s.id).hashes})), runtimeHashes};
await save(join(root, 'profile.json'), profile);
const prepared = [];
for (const spec of selected) {
  const f = buildSyntheticTask(spec.id), check = await preflightSyntheticTask(f);
  await mkdir(join(root, 'preflight'), {recursive: true}); await save(join(root, 'preflight', spec.id + '.json'), check);
  if (!check.ok) throw new Error(`preflight failed: ${spec.id}`);
  const repository = await materializeSyntheticTask(f, join(root, 'fixtures', spec.id));
  const git = (args: string[]) => execFileSync('git', args, {cwd: repository, encoding: 'utf8'});
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Freeze synthetic task']);
  prepared.push({f, repository});
}
const preparationElapsedMs = performance.now() - started;
type Row = TrialMetric & {id: string; split: string; outputDirectory: string; qualityPass: boolean; sourceUnchanged: boolean; receiptsValid: boolean; auditMs: number; participants: number; activeTargets: number; maxConcurrentModelCalls: number; verificationCommands: number; requestedModel: string; effectiveModels: string[]; reasoningTokens: number | null; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null};
const rows: Row[] = [];
let stopReason: string | null = null, observedTokens = 0;
const persist = () => save(join(root, 'series.json'), {format: 1, plannedRuns: selected.length, completedRuns: rows.length, stopReason, preparationElapsedMs, authoringLaborMs: null, knownTokens: observedTokens, totalTokens: rows.every(r => r.tokens !== null) && stopReason !== 'orchestrator-error' ? observedTokens : null, cost: null, summary: summarizeTrials(rows), results: rows});
await persist();
for (const [index, {f, repository}] of prepared.entries()) {
  if (observedTokens + limits.maxTokens > profile.seriesAdmissionTokens) {stopReason = 'series-token-admission'; break;}
  for (const [p, h] of Object.entries(runtimeHashes)) if (hash(await readFile(p)) !== h) throw new Error(`runtime drift: ${p}`);
  const outputDirectory = join(root, 'runs', f.metadata.id); await mkdir(dirname(outputDirectory), {recursive: true});
  console.log(JSON.stringify({event: 'run-start', index: index + 1, id: f.metadata.id}));
  const runStart = performance.now();
  try {
    const caller: typeof callOpenCodeGo = async<T>(o: OpenCodeGoOptions) => {
      console.log(JSON.stringify({event: 'call-start', id: f.metadata.id, callId: o.callId}));
      return callOpenCodeGo<T>(o);
    };
    const run = await runRepository({...limits, repository, task: f.task, outputDirectory, runtime: 'opencode-go', workerModel: 'deepseek-flash', goThinking: 'enabled', workers: 4, concurrency: 2, maxMetaCalls: 0}, caller);
    const elapsedMs = performance.now() - runStart, auditStart = performance.now();
    const artifacts = JSON.parse(await readFile(join(outputDirectory, 'artifacts.json'), 'utf8'));
    const independent = await runRepoChecks(await captureRepository(repository, f.task), artifacts, [...f.task.files.flatMap(t => t.checks), ...f.task.checks], join(outputDirectory, 'independent'));
    await save(join(outputDirectory, 'independent-check.json'), independent);
    let sourceUnchanged = execFileSync('git', ['status', '--porcelain'], {cwd: repository, encoding: 'utf8'}) === '';
    for (const [p, s] of Object.entries(f.files)) if (await readFile(join(repository, p), 'utf8') !== s) sourceUnchanged = false;
    let receiptsValid = run.swarm.calls.length > 0, tokens = 0, input = 0, output = 0, reasoning = 0, cached = 0, reasoningKnown = true, cachedKnown = true;
    const effectiveModels = new Set<string>();
    for (const call of run.swarm.calls) {
      const receipt = JSON.parse(await readFile(join(outputDirectory, 'swarm', call.id + '.json'), 'utf8')), tr = receipt.transcript, u = extractTokenUsage(receipt);
      if (typeof tr.effectiveModelEvidence === 'string') effectiveModels.add(tr.effectiveModelEvidence);
      if (tr.requestedModel !== 'deepseek-flash' || tr.effectiveModelEvidence !== 'deepseek-flash' || tr.thinking !== 'enabled' || tr.usageCompleteness !== 'complete' || tr.httpStatus !== 200 || tr.timedOut || tr.cancelled || u.inputTokens === null || u.outputTokens === null || u.partial) receiptsValid = false;
      input += u.inputTokens ?? 0; output += u.outputTokens ?? 0;
      reasoningKnown &&= u.reasoningOutputTokens !== null; reasoning += u.reasoningOutputTokens ?? 0;
      cachedKnown &&= u.cachedInputTokens !== null; cached += u.cachedInputTokens ?? 0;
      tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    }
    if (tokens !== run.budget.observedTokens) receiptsValid = false;
    const evidenceStop = !sourceUnchanged || !receiptsValid || run.budget.unknownUsageCalls > 0 || run.budget.activeReservations > 0 || run.budget.reservationOverruns > 0 || run.budget.exceeded || [...run.verifications, independent].some(v => v.executionFailure || v.checks.some(c => c.timedOut || c.signal !== null));
    const success = run.success && independent.ok && !evidenceStop;
    const row: Row = {id: f.metadata.id, group: f.metadata.family, split: f.metadata.split, outputDirectory, success, qualityPass: independent.ok, completionMs: success ? elapsedMs : null, elapsedMs, auditMs: performance.now() - auditStart, calls: run.swarm.calls.length, tokens: receiptsValid ? tokens : null, sourceUnchanged, receiptsValid, participants: run.swarm.individuals.filter(x => x.assignments > 0).length, activeTargets: run.discovery?.activatedTargets ?? 0, maxConcurrentModelCalls: run.swarm.maxConcurrentModelCalls, verificationCommands: [...run.verifications, independent].reduce((n, v) => n + v.checks.length, 0), requestedModel: 'deepseek-flash', effectiveModels: [...effectiveModels], reasoningTokens: receiptsValid && reasoningKnown ? reasoning : null, inputTokens: receiptsValid ? input : null, outputTokens: receiptsValid ? output : null, cachedInputTokens: receiptsValid && cachedKnown ? cached : null};
    rows.push(row); observedTokens += run.budget.observedTokens;
    if (evidenceStop) stopReason = 'evidence-stop';
    await persist(); console.log(JSON.stringify({event: 'run-finished', ...row}));
    if (stopReason) break;
  } catch (error) {
    stopReason = 'orchestrator-error'; await save(join(root, 'error.json'), {id: f.metadata.id, error: String(error), usage: 'unknown; inspect issued-call receipts'}); await persist(); throw error;
  }
}
await persist();
if (stopReason) process.exitCode = 1;
