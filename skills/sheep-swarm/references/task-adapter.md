# Trusted coding-task adapter

Use `npm run repo -- --repo PATH --task TASK.json` for ordinary scoped repository work; see [repository-task.md](repository-task.md). Use this lower-level factory only when the requested task needs behavior beyond that manifest. The experiment CLI's `--size` controls a built-in fixture; running it in another checkout does not edit that checkout.

The host API is `runSwarm(options, model?, observe?, task?)` in `src/swarm.ts`. `SwarmTask` contains a stable lowercase/hyphenated `id` and `createFixture(observe?) => CodeFixture`. The smallest existing real coding example is `experiments/docker-diagnostics-task.ts`; its bounded launch and budget wrapper are in `scripts/swarm-docker-diagnostics.mjs`. Read these from the verified sheep-swarm checkout when preparing an adapter. `npm run swarm:diagnostics` runs that fixed two-module task, not a task passed in prose.

1. Select the actual target files, their necessary local dependencies, and the intended change. Preserve the destination's working changes. Keep unrelated/private material outside the worker bundle.
2. Implement the host-owned `CodeFixture` interface from `src/fixture.ts`: initial `artifacts`, dependency edges, `sourceId`, `specId`, a `changedSource` whose content differs from the initial source (equal bytes cause no work), `consumerIds`, `reportIds`, `writableIds`, `visibleTest(target)`, and `verify(contents, scope?)`.
3. Freeze the contract and independent acceptance before calling workers. Check initial stubs fail, a separately prepared reference passes, and relevant incorrect variants fail. `verify` must preserve the contract, restrict the artifact set/scope, and check observations against host-owned expected values. The candidate cannot replace the verifier or its thresholds.
4. For local read/edit/test, choose Docker Agent and supply only scoped files and visible tests. The existing isolated observer handles the supported `.mjs` fixture operations; do not promise arbitrary Node dependencies or repository build compatibility. The diagnostics fixture requires an isolated observer; `runSwarm` supplies one for the Docker runtime.
5. Put a small launch file in the sheep-swarm checkout (adjust imports to its location). The API shape is:

```ts
import { runSwarm } from "./src/swarm.ts";
import { task } from "./my-task.ts";

const report = await runSwarm({
  runtime: "docker-agent", workerTools: "local",
  workers: 4, concurrency: 2, size: 2,
  maxCalls: 8, maxMetaCalls: 0, maxRounds: 6,
  timeoutMs: 240000, maxTokensPerCall: 60000,
  outputDirectory: `.sheep/custom-${Date.now()}`,
}, undefined, undefined, task);
if (!report.success) process.exitCode = 1;
```

This is an API skeleton: `my-task.ts` must implement the actual fixed task before execution. Call caps are not a money budget; reuse the existing diagnostics wrapper only when credit admission is requested and its model/rate assumptions apply.

6. Read the run's accepted content from `artifacts.json`, compare only intended files with the destination checkout, and run the destination's checks. Adopt the reviewed content within the user's authorized coding scope. Record worker-authored code separately from the parent's factory, tests and integration. Never auto-copy all artifacts over a repository or report acceptance from the workers' self-report.

When the task cannot fit this interface without new infrastructure, make the missing adapter or execution support explicit and prepare that bounded work. Do not present a built-in smoke as implementation of the user's requested code.
