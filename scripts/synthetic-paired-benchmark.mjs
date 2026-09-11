import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile, readdir, rename, rm} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildSyntheticTask} from '../experiments/synthetic-corpus/index.ts';
import {dependencyDepth, digest, pairedPlan, summarizePaired} from '../experiments/synthetic-paired.ts';
import {materializeSyntheticTask, preflightSyntheticTask} from './synthetic-corpus.ts';
import {runSingleRepository} from '../experiments/repository-single.ts';
import {runRepository} from '../src/repo-run.ts';
import {captureRepository} from '../src/repo-files.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
import {callOpenCodeGo} from '../src/opencode-go-worker.ts';

const load = async p => JSON.parse(await readFile(p, 'utf8'));
const save = async (p, v) => {
  await writeFile(p + '.tmp', JSON.stringify(v, null, 2) + '\n');
  await rename(p + '.tmp', p);
};
const git = (repository, args) => execFileSync('git', args, {cwd: repository, encoding: 'utf8'});
async function sources(dir) {
  return (await Promise.all((await readdir(dir, {withFileTypes: true})).map(e => e.isDirectory() ? sources(join(dir, e.name)) : [join(dir, e.name)]))).flat();
}
const lockPath = 'experiments/synthetic-corpus-v1-lock.json';
export async function verifyCorpus() {
  const lock = await load(lockPath);
  assert.equal(lock.cases.length, 256);
  assert.equal(digest(await readFile('docs/results/synthetic-corpus-validation.json')), lock.validationSha256);
  for (const c of lock.cases) {
    const f = buildSyntheticTask(c.id);
    assert.deepEqual(f.hashes, c.hashes, `frozen corpus drift: ${c.id}`);
    for (const k of ['id', 'family', 'variant', 'split', 'targetCount', 'topology']) assert.equal(f.metadata[k], c[k]);
    assert.equal(dependencyDepth(f.task), c.dependencyDepth);
  }
  return lock;
}
async function verifyRuntime(root, profile) {
  for (const [p, h] of Object.entries(profile.runtimeHashes)) {
    assert.equal(digest(await readFile(p)), h, `current runtime drift: ${p}`);
    assert.equal(digest(await readFile(join(root, 'runtime', p))), h, `saved runtime drift: ${p}`);
  }
}
async function verifyFixture(root, c) {
  const f = buildSyntheticTask(c.id), repository = join(root, 'fixtures', c.id);
  assert.deepEqual(f.hashes, c.hashes);
  assert.equal(git(repository, ['status', '--porcelain']), '', 'fixture working tree changed');
  for (const [p, s] of Object.entries(f.files)) assert.equal(await readFile(join(repository, p), 'utf8'), s, `fixture changed: ${p}`);
  assert.deepEqual(await load(join(repository, 'task.json')), f.task);
  return {f, repository};
}

export async function prepare(root) {
  const started = performance.now(), lock = await verifyCorpus();
  const cases = lock.cases.filter(c => c.split === 'dev');
  assert.equal(cases.length, 128);
  await mkdir(root);
  const limits = {maxCalls: 128, maxTokens: 2000000, reserveTokensPerCall: 200000, maxTokensPerCall: 64000, timeoutMs: 600000};
  const paths = [...await sources('src'), ...await sources('experiments/synthetic-corpus'), lockPath,
    'experiments/repository-single.ts', 'experiments/repository-patch.ts', 'experiments/synthetic-paired.ts',
    'scripts/synthetic-corpus.ts', 'scripts/synthetic-paired-benchmark.mjs', 'package.json', 'package-lock.json'];
  const runtimeHashes = {};
  for (const p of paths) {
    const bytes = await readFile(p); runtimeHashes[p] = digest(bytes);
    await mkdir(dirname(join(root, 'runtime', p)), {recursive: true}); await writeFile(join(root, 'runtime', p), bytes);
  }
  const profile = {format: 1, baseCommit: git('.', ['rev-parse', 'HEAD']).trim(), corpusLockHash: digest(await readFile(lockPath)),
    model: 'opencode-go/deepseek-flash', thinking: 'enabled', upperCalls: 0, taskDeadlineMs: null,
    single: {workers: 1, concurrency: 1, responseFormat: 'named', granularity: 'all declared targets in one atomic proposal'},
    sheep: {workers: 16, concurrency: 4, maxRounds: 256, activation: 'all targets; no defectedPaths hint', granularity: 'one target per proposal'},
    limits, seriesAdmissionTokens: cases.length * 2 * limits.maxTokens, taskConcurrency: 1, repeats: 1,
    order: 'sha256(sheep-dev-paired-v1:ID); single first for even variants, sheep first for odd variants',
    priorPilotEvaluationExposure: '8 evaluation variant-0 tasks observed in PR #8; no untouched-evaluation claim',
    cases, plan: pairedPlan(cases), runtimeHashes};
  await save(join(root, 'profile.json'), profile);
  await mkdir(join(root, 'preflight'));
  let index = 0;
  await Promise.all(Array.from({length: 4}, async () => {
    while (index < cases.length) {
      const c = cases[index++], f = buildSyntheticTask(c.id), check = await preflightSyntheticTask(f);
      await save(join(root, 'preflight', c.id + '.json'), check);
      assert.ok(check.ok, `preflight failed: ${c.id}`);
      const repository = await materializeSyntheticTask(f, join(root, 'fixtures', c.id));
      git(repository, ['init', '-q']); git(repository, ['add', '.']);
      git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Frozen paired benchmark input']);
      console.log(JSON.stringify({event: 'prepared', id: c.id}));
    }
  }));
  await save(join(root, 'series.json'), {format: 1, profileHash: digest(await readFile(join(root, 'profile.json'))),
    plannedRuns: profile.plan.length, results: [], inFlight: null, stopReason: null,
    preparationElapsedMs: performance.now() - started, authoringLaborMs: null, knownTokens: 0, totalTokens: 0, cost: null});
  console.log(JSON.stringify({event: 'ready', root, plannedRuns: profile.plan.length}));
}

/** Audit API evidence independently from runner-normalized token accounting. */
export async function receiptAudit(directory, method, run, task) {
  const calls = method === 'single' ? run.calls : run.swarm.calls;
  assert.ok(calls.length > 0, 'no model receipts');
  const usage = {inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, tokens: 0};
  for (const call of calls) {
    if (method === 'sheep') {
      assert.equal(call.role, 'worker'); assert.equal(call.model, 'deepseek-flash');
      for (const p of task.protected) assert.ok(!call.contextArtifacts.includes(p), 'protected oracle delivered');
    } else {
      const request = await load(join(directory, call.id + '.request.json'));
      // Public content is a single JSON line; inspect its keys, not text coincidences.
      const line = request.prompt.split('\n').find(s => s.startsWith('Public files: '));
      assert.ok(line, 'single public context not recorded');
      const actual = Object.keys(JSON.parse(line.slice('Public files: '.length))).sort();
      const expected = [...new Set([...task.files.map(f => f.path), ...task.context, ...(task.discovery?.readable ?? [])])].sort();
      assert.deepEqual(actual, expected);
      for (const p of task.protected) assert.ok(!actual.includes(p));
    }
    const receipt = await load(join(directory, method === 'single' ? '' : 'swarm', call.id + '.json'));
    const tr = receipt.transcript, u = tr.rawUsage;
    assert.equal(tr.requestedModel, 'deepseek-flash'); assert.equal(tr.effectiveModelEvidence, 'deepseek-flash');
    assert.equal(tr.thinking, 'enabled'); assert.equal(tr.httpStatus, 200); assert.equal(tr.usageCompleteness, 'complete');
    assert.equal(tr.timedOut, false); assert.equal(tr.cancelled, false);
    for (const n of [u.prompt_tokens, u.completion_tokens, u.total_tokens]) assert.ok(Number.isSafeInteger(n) && n >= 0);
    assert.equal(u.prompt_tokens + u.completion_tokens, u.total_tokens);
    usage.inputTokens += u.prompt_tokens; usage.outputTokens += u.completion_tokens; usage.tokens += u.total_tokens;
    const reasoning = u.completion_tokens_details?.reasoning_tokens, cache = u.prompt_cache_hit_tokens;
    if (reasoning === undefined) usage.reasoningTokens = null;
    else {assert.ok(Number.isSafeInteger(reasoning) && reasoning >= 0 && reasoning <= u.completion_tokens); if (usage.reasoningTokens !== null) usage.reasoningTokens += reasoning;}
    if (cache === undefined) usage.cachedInputTokens = null;
    else {assert.ok(Number.isSafeInteger(cache) && cache >= 0 && cache <= u.prompt_tokens); if (usage.cachedInputTokens !== null) usage.cachedInputTokens += cache;}
  }
  assert.equal(usage.tokens, run.budget.observedTokens);
  for (const k of ['unknownUsageCalls', 'activeReservations', 'reservationOverruns']) assert.equal(run.budget[k], 0);
  assert.equal(run.budget.exceeded, false);
  return usage;
}

export async function runSeries(root) {
  assert.ok(process.env.OPENCODE_GO_API_KEY, 'OPENCODE_GO_API_KEY required; credentials are not imported');
  const profile = await load(join(root, 'profile.json')), series = await load(join(root, 'series.json'));
  assert.equal(digest(await readFile(join(root, 'profile.json'))), series.profileHash);
  assert.equal(series.stopReason, null, 'stopped series requires diagnosis; no automatic retry');
  assert.equal(series.inFlight, null, 'interrupted call may have unknown usage; do not restart');
  assert.deepEqual(profile.plan.slice(0, series.results.length), series.results.map(r => ({id: r.id, method: r.method})));
  await verifyRuntime(root, profile);
  await mkdir(join(root, 'runner.lock')); // Atomic admission guard; crash leaves this intact.
  try {
    for (const item of profile.plan.slice(series.results.length)) {
      if (series.knownTokens + profile.limits.maxTokens > profile.seriesAdmissionTokens) {
        series.stopReason = 'series-token-admission'; break;
      }
      await verifyRuntime(root, profile);
      const c = profile.cases.find(c => c.id === item.id), {f, repository} = await verifyFixture(root, c);
      const directory = join(root, 'runs', item.id, item.method);
      series.inFlight = {...item, startedAt: new Date().toISOString()}; series.totalTokens = null;
      await save(join(root, 'series.json'), series);
      console.log(JSON.stringify({event: 'run-start', index: series.results.length + 1, ...series.inFlight}));
      const started = performance.now();
      const caller = async o => {
        console.log(JSON.stringify({event: 'call-start', ...item, callId: o.callId}));
        return callOpenCodeGo(o);
      };
      const options = {...profile.limits, repository, task: f.task, outputDirectory: directory};
      const run = item.method === 'single' ? await runSingleRepository(options, caller)
        : await runRepository({...options, runtime: 'opencode-go', workerModel: 'deepseek-flash', goThinking: 'enabled',
          workers: profile.sheep.workers, concurrency: profile.sheep.concurrency, maxRounds: profile.sheep.maxRounds, maxMetaCalls: 0}, caller);
      const elapsedMs = performance.now() - started, auditStarted = performance.now();
      const artifactsBytes = await readFile(join(directory, 'artifacts.json')), artifacts = JSON.parse(artifactsBytes);
      const independent = await runRepoChecks(await captureRepository(repository, f.task), artifacts,
        [...f.task.files.flatMap(t => t.checks), ...f.task.checks], join(directory, 'independent'));
      await save(join(directory, 'independent-check.json'), independent);
      let usage = null, sourceUnchanged = true; const evidenceErrors = [];
      try {await verifyFixture(root, c);} catch (e) {sourceUnchanged = false; evidenceErrors.push(String(e));}
      try {usage = await receiptAudit(directory, item.method, run, f.task);} catch (e) {evidenceErrors.push(String(e));}
      const verifications = [...run.verifications, independent], commands = verifications.flatMap(v => v.checks);
      if (run.infrastructureFailure || verifications.some(v => v.executionFailure) || commands.some(c => c.timedOut || c.signal !== null)) evidenceErrors.push('verification or provider infrastructure failure');
      const calls = item.method === 'single' ? run.calls : run.swarm.calls;
      const success = run.success && independent.ok && evidenceErrors.length === 0;
      const row = {...item, family: c.family, targetCount: c.targetCount, topology: c.topology, dependencyDepth: c.dependencyDepth,
        startedAt: series.inFlight.startedAt, success, qualityPass: independent.ok, elapsedMs, completionMs: success ? elapsedMs : null,
        auditMs: performance.now() - auditStarted, calls: calls.length, tokens: usage?.tokens ?? null, usage, evidenceErrors,
        termination: run.termination ?? (run.success ? 'accepted' : 'sheep-not-accepted'),
        registeredWorkers: item.method === 'single' ? 1 : run.swarm.registeredWorkers,
        participants: item.method === 'single' ? 1 : run.swarm.individuals.filter(i => i.assignments > 0).length,
        maxConcurrentModelCalls: item.method === 'single' ? 1 : run.swarm.maxConcurrentModelCalls,
        activeTargets: item.method === 'single' ? f.task.files.length : run.discovery?.activatedTargets,
        upperCalls: item.method === 'single' ? 0 : run.swarm.upperCalls,
        nonAcceptedProposals: calls.filter(c => !['committed', 'public-checks-passed'].includes(c.outcome)).length,
        modelCallDurationSumMs: calls.reduce((n, c) => n + c.durationMs, 0),
        verificationCommands: commands.length, verificationDurationSumMs: commands.reduce((n, c) => n + c.durationMs, 0),
        candidateDigest: digest(artifactsBytes), sourceUnchanged};
      await save(join(directory, 'row.json'), row);
      series.results.push(row); series.knownTokens += run.budget.observedTokens;
      if (evidenceErrors.length) series.stopReason = 'evidence-stop';
      series.totalTokens = series.results.some(r => r.tokens === null) ? null : series.knownTokens;
      series.inFlight = null; await save(join(root, 'series.json'), series);
      await save(join(root, 'summary.json'), summarizePaired(profile.cases, series.results));
      console.log(JSON.stringify({event: 'run-finished', ...row}));
      if (series.stopReason) break;
    }
    await save(join(root, 'series.json'), series);
  } catch (e) {
    series.stopReason = 'orchestrator-error'; series.totalTokens = null;
    series.error = String(e); await save(join(root, 'series.json'), series); throw e;
  } finally {await rm(join(root, 'runner.lock'), {recursive: true});}
  if (series.stopReason) throw new Error(`series stopped: ${series.stopReason}`);
}

export async function auditSeries(root) {
  const profile = await load(join(root, 'profile.json')), series = await load(join(root, 'series.json'));
  assert.equal(digest(await readFile(join(root, 'profile.json'))), series.profileHash);
  await verifyRuntime(root, profile);
  assert.deepEqual(profile.plan.slice(0, series.results.length), series.results.map(r => ({id: r.id, method: r.method})));
  let knownTokens = 0;
  for (const row of series.results) {
    const c = profile.cases.find(c => c.id === row.id), {f} = await verifyFixture(root, c);
    const directory = join(root, 'runs', row.id, row.method), run = await load(join(directory, 'result.json'));
    const independent = await load(join(directory, 'independent-check.json'));
    assert.deepEqual(await load(join(directory, 'row.json')), row);
    assert.equal(digest(await readFile(join(directory, 'artifacts.json'))), row.candidateDigest);
    if (row.evidenceErrors.length === 0) {
      const usage = await receiptAudit(directory, row.method, run, f.task);
      assert.deepEqual(usage, row.usage); assert.equal(usage.tokens, row.tokens);
      assert.equal(row.success, run.success && independent.ok);
      assert.ok(!independent.executionFailure && independent.checks.every(c => !c.timedOut && c.signal === null));
    } else {assert.equal(row.success, false); assert.ok(series.stopReason);}
    assert.equal(row.completionMs, row.success ? row.elapsedMs : null);
    knownTokens += run.budget.observedTokens;
  }
  assert.equal(knownTokens, series.knownTokens);
  const report = {format: 1, profileHash: series.profileHash, corpusLockHash: profile.corpusLockHash,
    model: profile.model, thinking: profile.thinking, plannedRuns: profile.plan.length, completedRuns: series.results.length,
    complete: series.results.length === profile.plan.length && !series.stopReason && !series.inFlight,
    stopReason: series.stopReason, inFlight: series.inFlight, knownTokens, totalTokens: series.totalTokens, cost: null,
    preparationElapsedMs: series.preparationElapsedMs, authoringLaborMs: null,
    summary: summarizePaired(profile.cases, series.results), rows: series.results};
  await save(join(root, 'audit.json'), report);
  console.log(JSON.stringify({...report, rows: undefined, summary: report.summary.overall}));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [command, directory] = process.argv.slice(2);
  if (!['prepare', 'run', 'audit'].includes(command) || !directory || process.argv.length !== 4) throw new Error('Usage: node scripts/synthetic-paired-benchmark.mjs prepare|run|audit DIRECTORY');
  await ({prepare, run: runSeries, audit: auditSeries}[command])(resolve(directory));
}
