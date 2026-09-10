import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runRepository } from "./repo-run.ts";
import type { RepoRunOptions } from "./repo-types.ts";
import type { ModelRuntime } from "./model-runtime.ts";

const { values } = parseArgs({ options: {
  help: { type: "boolean", short: "h" }, repo: { type: "string" }, task: { type: "string" },
  output: { type: "string" }, apply: { type: "boolean", default: false },
  "go-thinking": { type: "string" },
  runtime: { type: "string" }, "meta-runtime": { type: "string" },
  "worker-model": { type: "string" }, "meta-model": { type: "string" },
  workers: { type: "string" }, concurrency: { type: "string" },
  "max-calls": { type: "string" }, "max-meta-calls": { type: "string" }, "max-rounds": { type: "string" },
  "timeout-ms": { type: "string" }, "max-tokens-per-call": { type: "string" },
  "max-tokens": { type: "string" }, "reserve-tokens": { type: "string" },
} });

if (values.help) {
  process.stdout.write(`Usage: npm run repo -- --repo PATH --task TASK.json [options]

Runs a declared task on a snapshot of a Git worktree. By default the source stays
unchanged; --apply writes accepted target files after checking for source drift.
Checks are operator-supplied host commands, not a security sandbox.

--runtime codex|deepseek|opencode-go   --worker-model RAW_MODEL_ID
--go-thinking enabled|disabled       (Go DeepSeek worker; default: provider setting)
--meta-runtime RUNTIME                --meta-model RAW_MODEL_ID
--workers N --concurrency C           --max-calls N --max-meta-calls N
--max-rounds N --timeout-ms MS        --max-tokens-per-call N
--max-tokens N --reserve-tokens N     --output NEW_DIRECTORY --apply

Task JSON: version:1, goal, files:[{path,instructions,dependsOn?,checks?}],
context?:[path], protected:[path], checks:[{argv:[command,...args],timeoutMs?}].
See docs/repository-runner.md for examples and supported filesystem boundaries.
`);
} else {
  if (!values.repo || !values.task) throw new Error("--repo and --task are required; use --help for the task schema");
  const task: unknown = JSON.parse(await readFile(resolve(values.task), "utf8"));
  const limits: Partial<RepoRunOptions> = Object.fromEntries([
    ["workers", values.workers], ["concurrency", values.concurrency],
    ["maxCalls", values["max-calls"]], ["maxMetaCalls", values["max-meta-calls"]],
    ["maxRounds", values["max-rounds"]], ["timeoutMs", values["timeout-ms"]],
    ["maxTokensPerCall", values["max-tokens-per-call"]], ["maxTokens", values["max-tokens"]],
    ["reserveTokensPerCall", values["reserve-tokens"]],
  ].filter((row): row is [string, string] => row[1] !== undefined).map(([key, value]) => [key, Number(value)]));
  const report = await runRepository({
    repository: resolve(values.repo), task, apply: values.apply,
    ...(values["go-thinking"] === undefined ? {} : {goThinking:values["go-thinking"] as "enabled"|"disabled"}),
    outputDirectory: resolve(values.output ?? `.sheep/repository-${Date.now()}`), ...limits,
    ...(values.runtime === undefined ? {} : { runtime: values.runtime as ModelRuntime }),
    ...(values["meta-runtime"] === undefined ? {} : { metaRuntime: values["meta-runtime"] as ModelRuntime }),
    ...(values["worker-model"] === undefined ? {} : { workerModel: values["worker-model"] }),
    ...(values["meta-model"] === undefined ? {} : { metaModel: values["meta-model"] }),
  });
  process.stdout.write(JSON.stringify({
    success: report.success, applied: report.applied, repository: report.repository,
    outputDirectory: report.outputDirectory, changedPaths: report.changedPaths,
    lowerCalls: report.swarm.lowerCalls, upperCalls: report.swarm.upperCalls,
    registeredWorkers: report.swarm.registeredWorkers, concurrency: report.swarm.configuration.concurrency,
    maxActiveWorkers: report.swarm.maxActiveWorkers, budget: report.budget, errors: report.errors,
  }, null, 2) + "\n");
  if (!report.success) process.exitCode = 1;
}
