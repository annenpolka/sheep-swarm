import { randomUUID } from "node:crypto";
import { capture, SANDBOX_TEMPLATE, type Capture } from "./docker-agent-worker.ts";
import type { Verdict } from "./kernel.ts";

// Frozen acceptance for the introduction pilot. Never sent to the worker.
// VM isolation protects the host; the inner vm context limits this fixture's API.
const VERIFY = `import vm from 'node:vm';
import assert from 'node:assert/strict';
let source=''; for await (const chunk of process.stdin) source+=chunk;
const context=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
const mod=new vm.SourceTextModule(source,{context});
await mod.link(()=>{throw new Error('This fixture has no imports')});
await mod.evaluate({timeout:1000});
assert.equal(typeof mod.namespace.normalize,'function');
context.normalize=mod.namespace.normalize;
for(const [input,expected] of [['null',''],['undefined',''],['""',''],['" Hi "','hi'],['" MiXeD "','mixed'],['"  日本語  "','日本語'],['"0"','0']]) {
 assert.equal(vm.runInContext('normalize('+input+')',context,{timeout:1000}),expected);
}
for(const input of ['0','false','{}','[]']) {
 let threw=false; try {vm.runInContext('normalize('+input+')',context,{timeout:1000})} catch {threw=true}
 assert.ok(threw,'preserve non-string failure: '+input);
}
process.stdout.write(JSON.stringify({verified:true,cases:11}));
`;

export async function verifySandboxPilot(source: string): Promise<Verdict & { evidence: unknown }> {
  const name = `sheep-verify-${randomUUID()}`;
  const operations: { operation: string; result: Capture }[] = [];
  let verdict: Verdict = { ok: false, errors: ["verifier not run"] };
  try {
    const created = await capture("sbx", ["create", "--name", name, "--cpus", "2", "--memory", "4g", "--deny-network", "**", "--template", SANDBOX_TEMPLATE, "docker-agent"], { timeoutMs: 120_000 });
    operations.push({ operation: "create", result: created });
    if (created.exitCode !== 0) throw new Error("Verifier sandbox creation failed");
    const result = await capture("sbx", ["exec", "-i", name, "node", "--experimental-vm-modules", "--input-type=module", "-e", VERIFY], { input: source, timeoutMs: 10_000 });
    operations.push({ operation: "verify", result });
    const ok = result.exitCode === 0 && !result.timedOut && !result.tooLarge && JSON.parse(result.stdout).verified === true;
    verdict = { ok, errors: ok ? [] : ["Frozen isolated acceptance failed"] };
  } catch (error) { verdict = { ok: false, errors: [String(error)] }; }
  finally {
    const cleanup = await capture("sbx", ["rm", "--force", name], { timeoutMs: 60_000 });
    operations.push({ operation: "cleanup", result: cleanup });
    if (cleanup.exitCode !== 0) verdict = { ok: false, errors: [...verdict.errors, `Verifier cleanup failed: ${name}`] };
  }
  return { ...verdict, evidence: { name, operations } };
}
