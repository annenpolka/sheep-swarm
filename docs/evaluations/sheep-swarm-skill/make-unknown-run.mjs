// Offline evaluation fixture: executes the real durable runner with an injected
// response whose usage is unknown. Never invokes an API or reads credentials.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runDurableSwarm } from '../../../src/durable-run.ts';
import { createFixture } from '../../../src/fixture.ts';

const directory = resolve(process.argv[2]);
const reference = createFixture({ size: 2, variant: 'migrated' });
let calls = 0;
const report = await runDurableSwarm({ directory, size: 2, workers: 2,
  runtime: 'opencode-go', workerModel: 'gpt-5.6-luna',
  maxCalls: 4, maxMetaCalls: 0, timeoutMs: 1000, maxTokensPerCall: 4096,
}, async options => {
  calls++;
  const { target } = JSON.parse(options.prompt);
  return { requestedModel: options.model,
    result: { content: reference.artifacts[target], note: 'Done; simulated exit 0 with unknown usage.' },
    usage: [], transcript: { events: [], usage: [], requestedModel: options.model,
      effectiveModelEvidence: 'gpt-5.6-luna', usageCompleteness: 'partial-or-unknown',
      stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false,
      cancelled: false, durationMs: 1 } };
});
assert.equal(calls, 1);
assert.equal(report.success, false);
assert.equal(report.usageUnknownCalls, 1);
console.log(JSON.stringify({ fixture: 'injected-unknown-usage', directory, calls, success: report.success }));
