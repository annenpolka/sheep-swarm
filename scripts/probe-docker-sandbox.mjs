import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { capture, SANDBOX_TEMPLATE } from "../src/docker-agent-worker.ts";
import { verifySandboxPilot } from "../src/docker-sandbox-verifier.ts";

const directory = resolve(`.sheep/sandbox-probe-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(directory, { recursive: true });
const sentinel = join(directory, "host-only-canary.txt");
await writeFile(sentinel, "Host-only sandbox acceptance canary.\n");
const observations = [];
const execute = async (args, timeoutMs = 120_000) => {
  const result = await capture("sbx", args, { timeoutMs });
  observations.push({ args, ...result });
  return result;
};
try {
  for (let index = 0; index < 2; index++) {
    const name = `sheep-probe-${randomUUID()}`;
    try {
      const create = await execute(["create", "--name", name, "--cpus", "2", "--memory", "4g", "--deny-network", "**", "--template", SANDBOX_TEMPLATE, "docker-agent"]);
      assert.equal(create.exitCode, 0);
      const inspection = JSON.parse((await execute(["inspect", name, "--json"])).stdout);
      assert.equal(inspection.workspace, undefined);
      const probe = await execute(["exec", name, "python3", "-c", `import os,pathlib,json
p=pathlib.Path('/tmp/sheep-prior-session')
print(json.dumps({'kernel':os.uname().sysname,'host_canary_visible':pathlib.Path(${JSON.stringify(sentinel)}).exists(),'host_codex_visible':pathlib.Path(${JSON.stringify(join(process.env.HOME, ".codex"))}).exists(),'ssh_socket':pathlib.Path(os.getenv('SSH_AUTH_SOCK','/__absent__')).exists(),'previous_worker_state':p.exists()}))
p.write_text('do not inherit')`]);
      assert.equal(probe.exitCode, 0);
      assert.deepEqual(JSON.parse(probe.stdout), { kernel: "Linux", host_canary_visible: false, host_codex_visible: false, ssh_socket: false, previous_worker_state: false });
      const policy = JSON.parse((await execute(["policy", "check", "network", "--json", "--sandbox", name, "example.com:443"])).stdout);
      assert.equal(policy.allowed, false);
      const network = await execute(["exec", name, "curl", "--max-time", "10", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"], 15_000);
      assert.equal(network.stdout, "403", "sbx proxy must reject the real HTTP request");
      if (index === 0) {
        const timeout = await execute(["exec", name, "sleep", "30"], 500);
        assert.equal(timeout.timedOut, true);
      }
    } finally {
      const cleanup = await execute(["rm", "--force", name], 60_000);
      assert.equal(cleanup.exitCode, 0);
      const remaining = JSON.parse((await execute(["ls", "--json"])).stdout);
      assert.equal(remaining.sandboxes.some((s) => s.name === name), false);
    }
  }
  for (const [label, source, expected] of [
    ["old implementation", "export function normalize(value) { return value.trim().toLowerCase(); }", false],
    ["valid fix", "export function normalize(value) { return value == null ? '' : value.trim().toLowerCase(); }", true],
    ["always-empty mutation", "export function normalize(value) { return ''; }", false],
    ["null-only mutation", "export function normalize(value) { return value === null ? '' : value.trim().toLowerCase(); }", false],
  ]) {
    const result = await verifySandboxPilot(source);
    observations.push({ label, ...result });
    assert.equal(result.ok, expected, label);
  }
  await writeFile(join(directory, "result.json"), JSON.stringify({ success: true, modelCalls: 0, observations }, null, 2) + "\n");
  console.log(JSON.stringify({ success: true, modelCalls: 0, directory }, null, 2));
} catch (error) {
  await writeFile(join(directory, "result.json"), JSON.stringify({ success: false, error: String(error), observations }, null, 2) + "\n");
  throw error;
}
