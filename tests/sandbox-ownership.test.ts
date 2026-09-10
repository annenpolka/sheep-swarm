import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownSandbox, recoverOwnedSandboxes, type RecoveryIO } from "../src/sandbox-ownership.ts";
import { SANDBOX_TEMPLATE, type Capture } from "../src/docker-agent-worker.ts";

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "sheep-owners-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = `sheep-${randomUUID()}`;
  const owner = await ownSandbox(name, SANDBOX_TEMPLATE, directory);
  const names = new Set([name, "unrelated-user-vm"]), commands: string[][] = [];
  const okay = (value: unknown): Capture => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false, tooLarge: false });
  const io: RecoveryIO = { alive: () => false, run: async args => {
    commands.push(args);
    if (args[0] === "ls") return okay({ sandboxes: [...names].map(name => ({ name })) });
    if (args[0] === "inspect") return okay({ name: args[1], agent: "docker-agent", image: SANDBOX_TEMPLATE, kits: [] });
    if (args[0] === "rm") { names.delete(args[2]!); return okay({}); }
    throw new Error("unexpected command");
  } };
  return { directory, name, owner, names, commands, io, okay };
}
test("dead owners are reaped by exact UUID while unrelated VMs remain", async t => {
  const s = await setup(t);
  assert.deepEqual(await recoverOwnedSandboxes(s.directory, s.io), [{ name: s.name, action: "reaped" }]);
  assert.deepEqual([...s.names], ["unrelated-user-vm"]);
  assert.deepEqual(s.commands.filter(args => args[0] === "rm"), [["rm", "--force", s.name]]);
  assert.equal(JSON.parse(await readFile(join(s.directory, s.name + ".json"), "utf8")).released, false);
});
test("live owners and conservative PID reuse never trigger sandbox commands", async t => {
  const s = await setup(t);
  assert.deepEqual(await recoverOwnedSandboxes(s.directory, { ...s.io, alive: () => true }), [{ name: s.name, action: "active" }]);
  assert.equal(s.commands.length, 0);
});
test("normally released records do not trigger recovery or repeat cleanup", async t => {
  const s = await setup(t); await s.owner.release();
  assert.deepEqual(await recoverOwnedSandboxes(s.directory, s.io), []);
  assert.equal(s.commands.length, 0);
});
test("crash-before-create intent is retained and catches a later appearing VM", async t => {
  const s = await setup(t); s.names.delete(s.name);
  assert.deepEqual(await recoverOwnedSandboxes(s.directory, s.io), [{ name: s.name, action: "absent" }]);
  s.names.add(s.name);
  assert.deepEqual(await recoverOwnedSandboxes(s.directory, s.io), [{ name: s.name, action: "reaped" }]);
});
test("foreign host, mismatched image, invalid identity and symlinks cannot authorize deletion", async t => {
  const s = await setup(t), path = join(s.directory, s.name + ".json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...saved, host: "another-host" }));
  assert.equal((await recoverOwnedSandboxes(s.directory, s.io))[0]!.action, "foreign-host");
  await writeFile(path, JSON.stringify(saved));
  const changed: RecoveryIO = { ...s.io, run: args => args[0] === "inspect"
    ? Promise.resolve(s.okay({ name: s.name, agent: "docker-agent", image: "other" })) : s.io.run(args) };
  assert.equal((await recoverOwnedSandboxes(s.directory, changed))[0]!.action, "refused");
  await writeFile(path, JSON.stringify({ ...saved, name: "unrelated-user-vm" }));
  assert.equal((await recoverOwnedSandboxes(s.directory, s.io))[0]!.action, "refused");
  await rm(path); await symlink(join(s.directory, "missing"), path);
  assert.equal((await recoverOwnedSandboxes(s.directory, s.io))[0]!.action, "refused");
  assert.ok(s.commands.every(args => args[0] !== "rm"));
});
test("failed cleanup cannot be marked recovered; peer recovery of the same VM is tolerated", async t => {
  const s = await setup(t);
  const failed: RecoveryIO = { ...s.io, run: args => args[0] === "rm" ? Promise.resolve({ ...s.okay({}), exitCode: 1 }) : s.io.run(args) };
  await assert.rejects(recoverOwnedSandboxes(s.directory, failed), /recovery command failed/);
  const peer: RecoveryIO = { ...s.io, run: async args => {
    if (args[0] === "inspect") { s.names.delete(s.name); return { ...s.okay({}), exitCode: 1 }; }
    return s.io.run(args);
  } };
  assert.deepEqual(await recoverOwnedSandboxes(s.directory, peer), [{ name: s.name, action: "absent" }]);
});
