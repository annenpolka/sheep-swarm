import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {buildSyntheticTask} from '../experiments/synthetic-corpus/index.ts';
const load = async p => JSON.parse(await readFile(p, 'utf8'));
const hash = s => createHash('sha256').update(s).digest('hex');
if (process.argv.length !== 3) throw new Error('Usage: node scripts/audit-synthetic-corpus-benchmark.mjs COMPLETED_OUTPUT');
const root = resolve(process.argv[2]), profile = await load(join(root, 'profile.json')), series = await load(join(root, 'series.json'));
assert.equal(series.stopReason, null); assert.equal(series.completedRuns, 16); assert.equal(series.results.length, 16);
assert.deepEqual(series.results.map(r => r.id), profile.cases.map(c => c.id));
for (const [p, h] of Object.entries(profile.runtimeHashes)) {
  assert.equal(hash(await readFile(p)), h, `current runtime drift: ${p}`);
  assert.equal(hash(await readFile(join(root, 'runtime', p))), h, `saved runtime drift: ${p}`);
}
const rows = []; let tokens = 0, calls = 0;
for (const row of series.results) {
  const directory = join(root, 'runs', row.id), r = await load(join(directory, 'result.json'));
  const independent = await load(join(directory, 'independent-check.json'));
  const f = buildSyntheticTask(row.id), c = profile.cases.find(c => c.id === row.id);
  assert.deepEqual(f.hashes, c.hashes);
  for (const [p, s] of Object.entries(f.files)) assert.equal(await readFile(join(root, 'fixtures', row.id, p), 'utf8'), s);
  assert.equal(execFileSync('git', ['status', '--porcelain'], {cwd: join(root, 'fixtures', row.id), encoding: 'utf8'}), '');
  assert.equal(r.applied, false);
  for (const k of ['unknownUsageCalls', 'reservationOverruns', 'activeReservations']) assert.equal(r.budget[k], 0);
  let runTokens = 0, reasoning = 0, input = 0, output = 0, cache = 0;
  for (const call of r.swarm.calls) {
    assert.equal(call.role, 'worker'); assert.equal(call.model, 'deepseek-flash');
    for (const p of f.task.protected) assert.ok(!call.contextArtifacts.includes(p), `${row.id}: hidden oracle delivered`);
    const receipt = await load(join(directory, 'swarm', call.id + '.json')), tr = receipt.transcript, u = tr.rawUsage;
    assert.equal(tr.requestedModel, 'deepseek-flash'); assert.equal(tr.effectiveModelEvidence, 'deepseek-flash');
    assert.equal(tr.thinking, 'enabled'); assert.equal(tr.httpStatus, 200); assert.equal(tr.usageCompleteness, 'complete');
    assert.equal(tr.timedOut, false); assert.equal(tr.cancelled, false);
    for (const n of [u.prompt_tokens, u.completion_tokens, u.total_tokens, u.completion_tokens_details.reasoning_tokens, u.prompt_cache_hit_tokens]) assert.ok(Number.isSafeInteger(n) && n >= 0);
    assert.equal(u.prompt_tokens + u.completion_tokens, u.total_tokens);
    assert.ok(u.completion_tokens_details.reasoning_tokens <= u.completion_tokens);
    assert.equal(u.prompt_cache_hit_tokens + u.prompt_cache_miss_tokens, u.prompt_tokens);
    runTokens += u.total_tokens; input += u.prompt_tokens; output += u.completion_tokens; cache += u.prompt_cache_hit_tokens; reasoning += u.completion_tokens_details.reasoning_tokens;
  }
  assert.equal(runTokens, r.budget.observedTokens); assert.equal(runTokens, row.tokens);
  assert.equal(input, row.inputTokens); assert.equal(output, row.outputTokens); assert.equal(cache, row.cachedInputTokens); assert.equal(reasoning, row.reasoningTokens);
  assert.equal(row.success, r.success && independent.ok); assert.equal(row.qualityPass, independent.ok);
  assert.equal(row.completionMs, row.success ? row.elapsedMs : null);
  assert.ok(!independent.executionFailure); assert.ok(independent.checks.every(c => !c.timedOut && c.signal === null));
  rows.push({...row, outputDirectory: `runs/${row.id}`, hiddenOracleDelivered: false, rawUsageMatched: true, upperCalls: 0, rejectedCalls: r.swarm.calls.filter(c => c.outcome !== 'committed').length, candidateDigest: hash(await readFile(join(directory, 'artifacts.json')))});
  calls += r.swarm.calls.length; tokens += runTokens;
}
assert.equal(tokens, series.totalTokens);
const durations = rows.filter(r => r.success).map(r => r.completionMs).sort((a, b) => a - b);
const median = durations.length ? (durations[Math.floor((durations.length - 1) / 2)] + durations[Math.floor(durations.length / 2)]) / 2 : null;
const audit = {format: 1, requestedModel: 'opencode-go/deepseek-flash', thinking: 'enabled', workers: 4, concurrency: 2, completedRuns: rows.length, successes: rows.filter(r => r.success).length, calls, upperCalls: 0, tokens, cost: null, medianCompletionMs: median, minCompletionMs: durations[0] ?? null, maxCompletionMs: durations.at(-1) ?? null, totalRunElapsedMs: rows.reduce((s, r) => s + r.elapsedMs, 0), preparationElapsedMs: series.preparationElapsedMs, independentAuditMs: rows.reduce((s, r) => s + r.auditMs, 0), rows};
await writeFile(join(root, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify({...audit, rows: undefined}));
