import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const { values } = parseArgs({ options: { source: { type: "string" }, output: { type: "string" } } });
if (!values.source || !values.output) throw new Error("--source and --output are required");
const source = resolve(values.source), output = resolve(values.output);
const manifest = JSON.parse(await readFile(join(source, "source-manifest.json"), "utf8"));
for (const [file, expected] of Object.entries(manifest)) assert.equal(createHash("sha256")
  .update(await readFile(join(source, file))).digest("hex"), expected, file);
const { SqliteJournal } = await import(pathToFileURL(join(source, "src/journal.ts")).href);
const { createFixture } = await import(pathToFileURL(join(source, "src/fixture.ts")).href);
await mkdir(output);
const receipt = { format: 1, source, sourceManifest: manifest, startedAt: new Date().toISOString(), runs: [] };
const save = () => writeFile(join(output, "experiment.json"), JSON.stringify(receipt, null, 2) + "\n");
await save();
for (const [boundary, fault] of [["after-commit", "none"], ["after-intervention", "rounded-guidance"]]) {
  const directory = join(output, boundary);
  const record = { boundary, fault, directory, startedAt: new Date().toISOString(), status: "running" };
  receipt.runs.push(record); await save(); process.stdout.write(`START ${boundary}\n`);
  let stdout = "", stderr = "", closed = false;
  const child = spawn(process.execPath, [fileURLToPath(new URL("durable-probe-child.mjs", import.meta.url)), source, directory, boundary, fault],
    { cwd: source, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const ended = new Promise(resolveEnd => child.once("close", (code, signal) => { closed = true; resolveEnd({ code, signal }); }));
  let reached = false;
  const deadline = Date.now() + 10 * 60 * 1000;
  try {
    while (!closed && Date.now() < deadline) {
      try { await access(join(directory, "interrupt-marker.json")); reached = true; break; } catch { /* Keep waiting for the exact boundary. */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    assert.ok(reached, `child never reached ${boundary}: ${stderr.slice(-3000)}`);
    record.marker = JSON.parse(await readFile(join(directory, "interrupt-marker.json"), "utf8"));
    child.kill("SIGKILL"); record.termination = await ended;
    assert.equal(record.termination.signal, "SIGKILL");
    const before = new SqliteJournal(join(directory, "state.sqlite"));
    try { record.beforeResume = before.load(); } finally { before.close(); }
    // The old parent has exited. Resume uses the saved call ledger and fresh leases.
    const resumed = spawn(process.execPath, [join(source, "src/durable-cli.ts"), "--directory", directory, "--resume"],
      { cwd: source, stdio: ["ignore", "pipe", "pipe"] });
    let resumedOutput = "", resumedError = "";
    resumed.stdout.on("data", data => { resumedOutput += data; }); resumed.stderr.on("data", data => { resumedError += data; });
    record.resumeExit = await new Promise((accept, reject) => { resumed.once("error", reject); resumed.once("close", accept); });
    await writeFile(join(output, `${boundary}-resume.stdout.txt`), resumedOutput);
    await writeFile(join(output, `${boundary}-resume.stderr.txt`), resumedError);
    const report = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
    assert.equal(record.resumeExit, 0); assert.equal(report.success, true);
    const journal = new SqliteJournal(join(directory, "state.sqlite"));
    let finalState;
    try { finalState = journal.load().state; } finally { journal.close(); }
    const fixture = createFixture({ size: 4 });
    const contents = Object.fromEntries(Object.entries(finalState.artifacts).map(([id, artifact]) => [id, artifact.content]));
    assert.equal((await fixture.verify(contents)).ok, true);
    // An intervention may legitimately invalidate and revise a previously correct file.
    // Check identities and the durable prefix, not a fixed count of semantic revisions.
    const committed = finalState.candidates.filter(candidate => candidate.state === "committed");
    assert.equal(new Set(committed.map(candidate => candidate.proposal.id)).size, committed.length);
    for (const previous of record.beforeResume.state.candidates.filter(candidate => candidate.state === "committed"))
      assert.equal(committed.filter(candidate => candidate.id === previous.id && candidate.proposal.id === previous.proposal.id).length, 1);
    for (const [id, artifact] of Object.entries(finalState.artifacts)) {
      assert.ok(artifact.version >= record.beforeResume.state.artifacts[id].version);
      assert.equal(artifact.version, finalState.events.filter(event => event.artifact === id && event.cause !== "correction").length);
    }
    assert.ok(finalState.events.every(event => event.delivered));
    assert.ok(finalState.obligations.every(work => work.state === "handled"));
    assert.ok(!finalState.claims.some(claim => claim.open && claim.blocking));
    const interruptedCall = report.calls.find(call => call.id === record.marker.details.callId);
    assert.equal(interruptedCall.status, "committed");
    assert.ok(report.calls.filter(call => call.role === "worker").every(call => call.model === "gpt-5.6-luna"));
    if (boundary === "after-intervention") assert.equal(committed.filter(candidate => candidate.proposal.id === interruptedCall.id).length, 1);
    record.result = { success: report.success, lowerCalls: report.lowerCalls, upperCalls: report.upperCalls,
      interventions: report.interventions, unknownCalls: report.unknownCalls, usageUnknownCalls: report.usageUnknownCalls,
      inputTokens: report.observedInputTokens, outputTokens: report.observedOutputTokens, resumes: report.resumes,
      generation: report.generation, interruptedCall: { id: interruptedCall.id, status: interruptedCall.status } };
    record.status = "passed";
  } catch (error) { record.status = "failed"; record.error = String(error); process.exitCode = 1; }
  finally {
    if (!closed) { child.kill("SIGKILL"); await ended; }
    await writeFile(join(output, `${boundary}-initial.stdout.txt`), stdout);
    await writeFile(join(output, `${boundary}-initial.stderr.txt`), stderr);
    record.finishedAt = new Date().toISOString(); await save();
  }
  process.stdout.write(`END ${boundary} ${JSON.stringify(record.result ?? { error: record.error })}\n`);
}
receipt.finishedAt = new Date().toISOString(); await save();
