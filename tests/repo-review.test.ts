import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { repository, manifest } from "./repo-test-helpers.ts";
import { parseRepoTask } from "../src/repo-manifest.ts";
import { captureRepository } from "../src/repo-files.ts";
import { runRepoChecks } from "../src/repo-checks.ts";
import { runRepository } from "../src/repo-run.ts";

const profile = {
  runtime: "opencode-go" as const, workerModel: "deepseek-flash",
  metaRuntime: "opencode-go" as const, metaModel: "deepseek-flash",
  workers: 1, concurrency: 1, maxCalls: 8, maxMetaCalls: 2,
  maxTokens: 10000, reserveTokensPerCall: 1000,
};
const answer = (model: string, content: string) => ({
  requestedModel: model, result: { content, note: "review fixture" },
  usage: [{ event: {}, inputTokens: 10, outputTokens: 5 }],
  transcript: { requestedModel: model, effectiveModelEvidence: model, events: [],
    usage: [{ event: {}, inputTokens: 10, outputTokens: 5 }], stdout: "", stderr: "",
    exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1,
    usageCompleteness: "complete" },
});

test("repository checks reap background descendants after a successful command exit", { skip: process.platform === "win32" }, async t => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await captureRepository(root, parseRepoTask(manifest()));
  const code = `const child = require('node:child_process').spawn(process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    require('node:fs').writeFileSync('child.pid', String(child.pid)); child.unref();`;
  const result = await runRepoChecks(snapshot, {}, [{ argv: [process.execPath, "-e", code], timeoutMs: 2000 }], join(root, "checks"));
  const pid = Number(await readFile(join(result.workspace, "child.pid"), "utf8"));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ } });
  assert.equal(result.ok, true, result.errors.join("\n"));
  for (let i = 0; i < 100 && alive(); i++) await delay(10);
  assert.equal(alive(), false, "successful acceptance left its background child alive");
});

test("repository checks cannot discover an ancestor checkout as their own Git repository", async t => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await captureRepository(root, parseRepoTask(manifest()));
  for (const directory of process.platform === "win32" ? ["checks"] : ["checks", "checks:review"]) {
    const result = await runRepoChecks(snapshot, {}, [{ argv: ["git", "rev-parse", "--show-toplevel"], timeoutMs: 2000 }], join(root, directory));
    assert.equal(result.ok, false, `candidate check inspected ancestor repository: ${result.checks[0]?.stdout}`);
    assert.notEqual(result.checks[0]?.exitCode, 0);
  }
});

test("repository verification spawn failure stops new worker and upper calls", async t => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = { ...manifest(), files: [{ ...manifest().files[0],
    checks: [{ argv: ["/definitely/not/an/installed/review-check"] }] }] };
  let calls = 0;
  const result = await runRepository({ ...profile, repository: root, task, outputDirectory: join(root, "run"), apply: true }, async options => {
    calls++;
    return answer(options.model, "export const value=42;\n");
  });
  assert.equal(result.success, false);
  assert.equal(result.applied, false);
  assert.equal(calls, 1, "unavailable verification must not consume semantic retries or upper intervention");
  assert.equal(result.swarm.upperCalls, 0);
  assert.equal(result.budget.settledCalls, 1);
});

test("repository local check diagnostics reach repair prompts with the rejected draft", async t => {
  const root = await repository({ "local.mjs": "import {value} from './a.mjs'; if(value!==42){console.error('LOCAL_CHECK_EXPECTED_42_SENTINEL');process.exit(1)}\n" });
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = { ...manifest(), files: [{ ...manifest().files[0], checks: [{ argv: [process.execPath, "local.mjs"] }] }] };
  const prompts: string[] = [];
  const result = await runRepository({ ...profile, repository: root, task, outputDirectory: join(root, "run") }, async options => {
    prompts.push(options.prompt);
    return answer(options.model, `export const value=${prompts.length === 1 ? 41 : 42};\n`);
  });
  assert.equal(result.success, true, result.errors.join("\n"));
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0]!.includes("LOCAL_CHECK_EXPECTED_42_SENTINEL"), false);
  assert.ok(prompts[1]!.includes("LOCAL_CHECK_EXPECTED_42_SENTINEL"), "repair worker only received the command's exit status");
  assert.ok(prompts[1]!.includes("export const value=41;"));
});

test("repository materialization I/O failure stops calls without classifying invalid code as infrastructure", async t => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await captureRepository(root, parseRepoTask(manifest()));
  const invalid = await runRepoChecks(snapshot, { "a.mjs": "\0" }, [], join(root, "invalid"));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.executionFailure, undefined);
  let calls = 0;
  const outputDirectory = join(root, "run");
  const result = await runRepository({ ...profile, repository: root, task: manifest(), outputDirectory }, async options => {
    calls++;
    if (calls === 1) {
      await rm(join(outputDirectory, "checks"), { recursive: true });
      await writeFile(join(outputDirectory, "checks"), "simulated unavailable candidate storage");
    }
    return answer(options.model, "export const value=42;\n");
  });
  assert.equal(result.success, false);
  assert.equal(calls, 1);
  assert.equal(result.swarm.upperCalls, 0);
  assert.ok(result.verifications.some(verification => verification.executionFailure));
  assert.ok(result.swarm.finalErrors.includes("verification-unavailable"));
});
