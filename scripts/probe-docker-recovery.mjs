import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, SANDBOX_TEMPLATE } from "../src/docker-agent-worker.ts";
import { ownSandbox, recoverOwnedSandboxes } from "../src/sandbox-ownership.ts";

if (process.argv[2] === "--child") {
  await ownSandbox(process.argv[3], SANDBOX_TEMPLATE);
  process.send({ ready: true });
  setInterval(() => {}, 1000);
} else {
  const directory = resolve(`.sheep/docker-recovery-probe-${Date.now()}`); await mkdir(directory);
  const children = [], names = [], observations = [];
  const run = async args => {
    const result = await capture("sbx", args, { timeoutMs: 120000 });
    observations.push({ args, result }); assert.equal(result.exitCode, 0, result.stderr); return result;
  };
  const start = async () => {
    const name = `sheep-recovery-${randomUUID()}`; names.push(name);
    const child = fork(fileURLToPath(import.meta.url), ["--child", name], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    children.push(child);
    await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("owner child startup timeout")), 10000);
      child.once("message", () => { clearTimeout(timer); accept(); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    return { child, name };
  };
  const create = name => run(["create", "--name", name, "--cpus", "2", "--memory", "4g", "--deny-network", "**", "--template", SANDBOX_TEMPLATE, "docker-agent"]);
  const kill = child => new Promise(accept => { child.once("exit", accept); child.kill("SIGKILL"); });
  try {
    const active = await start(); await create(active.name);
    const orphan = await start(); await create(orphan.name); await kill(orphan.child);
    const delayed = await start(); await kill(delayed.child);
    const first = await recoverOwnedSandboxes(); observations.push({ first });
    assert.equal(first.find(row => row.name === active.name)?.action, "active");
    assert.equal(first.find(row => row.name === orphan.name)?.action, "reaped");
    assert.equal(first.find(row => row.name === delayed.name)?.action, "absent");
    await create(delayed.name); // Simulate completion of a create after its owner died.
    const second = await recoverOwnedSandboxes(); observations.push({ second });
    assert.equal(second.find(row => row.name === active.name)?.action, "active");
    assert.equal(second.find(row => row.name === delayed.name)?.action, "reaped");
    await kill(active.child);
    const third = await recoverOwnedSandboxes(); observations.push({ third });
    assert.equal(third.find(row => row.name === active.name)?.action, "reaped");
    await writeFile(join(directory, "result.json"), JSON.stringify({ success: true, modelCalls: 0, observations }, null, 2) + "\n");
    console.log(JSON.stringify({ success: true, modelCalls: 0, directory }));
  } catch (error) {
    await writeFile(join(directory, "result.json"), JSON.stringify({ success: false, error: String(error), observations }, null, 2) + "\n"); throw error;
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await kill(child);
    const live = JSON.parse((await run(["ls", "--json"])).stdout).sandboxes;
    for (const name of names) if (live.some(row => row.name === name)) await run(["rm", "--force", name]);
  }
}
