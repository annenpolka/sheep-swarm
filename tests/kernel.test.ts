import assert from "node:assert/strict";
import { test } from "node:test";
import { KernelError, SwarmKernel } from "../src/kernel.ts";
import type { Contents, Lease, ProposalInput, Verifier } from "../src/kernel.ts";

// Expectations originate in work/kernel-acceptance.md, frozen before kernel.ts existed.
// These fixtures intentionally do not call the independent experiment's simulator.
const pass: Verifier = () => ({ ok: true, errors: [] });
const atLeastOne: Verifier = (contents) => {
  const ok = Number(contents.x) + Number(contents.y) >= 1;
  return { ok, errors: ok ? [] : ["x + y must be at least one"] };
};

function kernel(artifacts: Record<string, string>): SwarmKernel {
  return new SwarmKernel({ artifacts, now: () => 0 });
}

function proposal(
  target: SwarmKernel,
  id: string,
  reads: readonly string[],
  writes: Record<string, string>,
  options: { agent?: string; obligations?: readonly string[]; lease?: Lease; kind?: "work" | "intervention" } = {},
) {
  const agent = options.agent ?? id;
  const context = target.checkout(agent, reads);
  const lease = options.lease ?? target.grant(agent, Object.keys(writes).length ? Object.keys(writes) : reads);
  const input: ProposalInput = {
    id, agent, context: context.id, writes, lease: { id: lease.id, epoch: lease.epoch },
    ...(options.obligations === undefined ? {} : { obligations: options.obligations }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
  };
  return { input, context, lease, candidate: target.prepare(input) };
}

async function commit(
  target: SwarmKernel,
  id: string,
  reads: readonly string[],
  writes: Record<string, string>,
  options: Parameters<typeof proposal>[4] = {},
) {
  const prepared = proposal(target, id, reads, writes, options);
  assert.deepEqual(await target.validate(prepared.candidate.id, pass), { ok: true, errors: [] });
  return { ...prepared, result: target.commit(prepared.candidate.id) };
}

function rejectsWithoutMutation(target: SwarmKernel, action: () => unknown, code: string): void {
  const before = target.exportState();
  assert.throws(action, (error: unknown) => error instanceof KernelError && error.code === code);
  assert.deepEqual(target.exportState(), before, `rejected ${code} must not partially mutate state`);
}

function onlyObligation(target: SwarmKernel) {
  const obligations = target.obligations();
  assert.equal(obligations.length, 1);
  return obligations[0]!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

for (const first of ["x", "y"] as const) {
  test(`K01: overlapping reads prevent write skew when ${first} commits first`, async () => {
    const target = kernel({ x: "1", y: "1" });
    const x = proposal(target, "A", ["x", "y"], { x: "0" });
    const y = proposal(target, "B", ["x", "y"], { y: "0" });
    assert.equal((await target.validate(x.candidate.id, atLeastOne)).ok, true);
    assert.equal((await target.validate(y.candidate.id, atLeastOne)).ok, true);
    const candidates = { x, y };
    target.commit(candidates[first].candidate.id);
    rejectsWithoutMutation(target, () => target.commit(candidates[first === "x" ? "y" : "x"].candidate.id), "stale-read");
    assert.equal(Number(target.contents().x) + Number(target.contents().y), 1);
    assert.equal(target.events().length, 1);
  });
}

test("K02: a read-only premise changing rejects an otherwise unchanged write base", async () => {
  const target = kernel({ schema: "v1", client: "old" });
  const work = proposal(target, "worker", ["schema", "client"], { client: "using-v1" });
  await target.validate(work.candidate.id, pass);
  target.change("schema", "v2");
  rejectsWithoutMutation(target, () => target.commit(work.candidate.id), "stale-read");
  assert.equal(target.artifact("client").version, 0);
});

test("K03: unchanged explicit reads do not permit reusing a pass on a different integrated snapshot", async () => {
  const target = kernel({ x: "0", z: "0" });
  const invariant: Verifier = (contents) => {
    const ok = Number(contents.x) + Number(contents.z) <= 1;
    return { ok, errors: ok ? [] : ["x + z exceeds one"] };
  };
  const work = proposal(target, "x-writer", ["x"], { x: "1" });
  assert.equal((await target.validate(work.candidate.id, invariant)).ok, true);
  target.change("z", "1");
  rejectsWithoutMutation(target, () => target.commit(work.candidate.id), "stale-validation");
  target.discard(work.candidate.id, "base advanced; rebuild before validating");
  const rebuilt = proposal(target, "x-retry", ["x"], { x: "1" });
  assert.equal((await target.validate(rebuilt.candidate.id, invariant)).ok, false);
  rejectsWithoutMutation(target, () => target.commit(rebuilt.candidate.id), "candidate-not-validated");
  assert.deepEqual(target.contents(), { x: "0", z: "1" });
});

test("K04: each candidate requires its own validation even on an identical base", async () => {
  const target = kernel({ client: "old" });
  const good = proposal(target, "good", ["client"], { client: "good" });
  const bad = proposal(target, "bad", ["client"], { client: "bad" });
  await target.validate(good.candidate.id, pass);
  rejectsWithoutMutation(target, () => target.commit(bad.candidate.id), "candidate-not-validated");
  target.commit(good.candidate.id);
  assert.equal(target.contents().client, "good");
});

test("K04: agent-visible objects and verifier input cannot mutate the stored candidate", async () => {
  const target = kernel({ client: "old" });
  const work = proposal(target, "writer", ["client"], { client: "good" });
  work.context.contents.client = "forged-context";
  work.context.reads.client!.version = 999;
  work.input.writes.client = "forged-proposal";
  work.candidate.contents.client = "forged-candidate";
  work.lease.scope.push("forged-scope");
  const leaked = target.exportState();
  leaked.artifacts.client!.content = "forged-export";
  let inspected: Contents | undefined;
  await target.validate(work.candidate.id, (contents) => {
    inspected = { ...contents };
    (contents as Record<string, string>).client = "forged-validator";
    return { ok: true, errors: [] };
  });
  assert.deepEqual(inspected, { client: "good" });
  target.commit(work.candidate.id);
  assert.equal(target.contents().client, "good");
});

test("K04: state changes during asynchronous validation invalidate the pass at commit", async () => {
  const target = kernel({ client: "old", unrelated: "old" });
  const work = proposal(target, "writer", ["client"], { client: "new" });
  const finished = deferred<{ ok: boolean; errors: string[] }>();
  const validation = target.validate(work.candidate.id, () => finished.promise);
  target.change("unrelated", "new");
  finished.resolve({ ok: true, errors: [] });
  await validation;
  rejectsWithoutMutation(target, () => target.commit(work.candidate.id), "stale-validation");
});

test("K05: changing host acceptance or environment identity invalidates a candidate's pass", async () => {
  const target = kernel({ result: "old" });
  target.setVerificationPolicy("acceptance-A1/environment-E1");
  const work = proposal(target, "old-policy", ["result"], { result: "new" });
  await target.validate(work.candidate.id, pass);
  target.setVerificationPolicy("acceptance-A1/environment-E2");
  rejectsWithoutMutation(target, () => target.commit(work.candidate.id), "stale-validation-policy");
  target.discard(work.candidate.id, "environment changed");
  await commit(target, "new-policy", ["result"], { result: "new" });
  assert.equal(target.contents().result, "new");
});

test("K05: host policy changes during acceptance invalidate the completion result", async () => {
  const target = kernel({ result: "correct" });
  target.setVerificationPolicy("A1/E1");
  target.closeInput();
  const finished = deferred<{ ok: boolean; errors: string[] }>();
  const completion = target.complete(() => finished.promise);
  target.setVerificationPolicy("A2/E1");
  finished.resolve({ ok: true, errors: [] });
  assert.equal((await completion).ok, false);
});

for (const order of ["change-first", "dependency-first"] as const) {
  test(`K06: dependency registration catches up atomically (${order})`, () => {
    const target = kernel({ provider: "old", consumer: "old", unrelated: "old" });
    if (order === "dependency-first") target.addDependency("consumer", "provider", 0);
    const event = target.change("provider", "new")!;
    if (order === "change-first") {
      target.deliver(event); // No consumer existed when the event was delivered.
      target.addDependency("consumer", "provider", 0);
    } else {
      target.deliver(event);
    }
    target.addDependency("consumer", "provider", 0);
    target.deliver(event);
    const obligation = onlyObligation(target);
    assert.equal(obligation.consumer, "consumer");
    assert.equal(obligation.provider, "provider");
    assert.equal(obligation.requiredVersion, 1);
    assert.equal(obligation.state, "pending");
    assert.equal(target.exportState().dependencies.length, 1);
  });
}

for (const observation of ["explicit-old-evidence", "omitted-evidence"] as const) {
  test(`K06: a delivered evidence-only correction is caught by later dependency registration (${observation})`, () => {
    const target = kernel({ provider: "same-bytes", consumer: "old-assumption" });
    const observed = target.artifact("provider");
    const event = target.correct("provider", "the source interpretation has been corrected");
    target.deliver(event); // Already delivered while no consumer was registered.
    assert.equal(target.pending().length, 0);
    assert.equal(target.artifact("provider").version, observed.version);
    assert.equal(target.artifact("provider").content, observed.content);
    if (observation === "explicit-old-evidence") {
      target.addDependency("consumer", "provider", observed.version, observed.evidenceEpoch);
    } else {
      target.addDependency("consumer", "provider", observed.version);
    }
    const work = onlyObligation(target);
    assert.equal(work.state, "pending");
    assert.equal(work.provider, "provider");
    assert.equal(work.consumer, "consumer");
    assert.equal(work.requiredVersion, observed.version);
    assert.equal(work.requiredEvidenceEpoch, observed.evidenceEpoch + 1);
    assert.equal(work.receipt, null);
    target.addDependency("consumer", "provider", observed.version, observed.evidenceEpoch);
    target.deliver(event);
    assert.equal(target.obligations().length, 1);
    assert.equal(onlyObligation(target).requiredEvidenceEpoch, observed.evidenceEpoch + 1);
  });
}

test("K06: registering a dependency with the current content and evidence observation needs no catchup", () => {
  const target = kernel({ provider: "same-bytes", consumer: "fresh-assumption" });
  target.deliver(target.correct("provider", "corrected interpretation"));
  const observed = target.artifact("provider");
  target.addDependency("consumer", "provider", observed.version, observed.evidenceEpoch);
  assert.equal(target.pending().length, 0);
  assert.deepEqual(target.exportState().dependencies, [{ consumer: "consumer", provider: "provider" }]);
});

test("K07: ignoring one change does not erase the dependency or suppress the next change", async () => {
  let now = 0;
  const target = new SwarmKernel({ artifacts: { provider: "v0", consumer: "unchanged" }, now: () => now });
  target.addDependency("consumer", "provider");
  target.change("provider", "comment-only");
  target.deliverAll();
  const original = onlyObligation(target);
  await commit(target, "ignore-comment", ["provider", "consumer"], {}, { obligations: [original.id] });
  assert.equal(onlyObligation(target).receipt?.outcome, "ignored");
  assert.equal(target.pending().length, 0);
  now = 1_000_000;
  target.change("provider", "new-contract");
  target.deliverAll();
  const next = onlyObligation(target);
  assert.equal(next.requiredVersion, 2);
  assert.equal(next.state, "pending");
  assert.equal(next.receipt, null);
  assert.deepEqual(target.exportState().dependencies, [{ consumer: "consumer", provider: "provider" }]);
});

test("K08: correction reaches a historical reader after its current dependency is retired", async () => {
  const target = kernel({ provider: "wrong", consumer: "unreviewed" });
  target.addDependency("consumer", "provider");
  await commit(target, "review", ["provider", "consumer"], { consumer: "reviewed-wrong" });
  target.deliverAll();
  target.retireDependency("consumer", "provider", "current implementation no longer reads this provider");
  assert.equal(target.exportState().dependencies.length, 0);
  assert.deepEqual(target.exportState().historical, [{ consumer: "consumer", provider: "provider" }]);
  target.change("provider", "corrected");
  target.deliverAll();
  assert.equal(onlyObligation(target).consumer, "consumer");
  assert.equal(onlyObligation(target).state, "pending");
});

test("K09: correction invalidates indirect historical evidence and an old downstream proposal", async () => {
  const target = kernel({ provider: "wrong", review: "empty", decision: "empty" });
  await commit(target, "review-work", ["provider", "review"], { review: "believes-wrong" });
  await commit(target, "decision-work", ["review", "decision"], { decision: "accepted-wrong" });
  target.deliverAll();
  const oldDecision = proposal(target, "old-decision", ["decision"], { decision: "completed-wrong" });
  await target.validate(oldDecision.candidate.id, pass);
  const oldVersion = target.artifact("decision").version;
  target.change("provider", "correct");
  assert.equal(target.artifact("decision").version, oldVersion);
  rejectsWithoutMutation(target, () => target.commit(oldDecision.candidate.id), "stale-read");
  target.deliverAll();
  const consumers = target.pending().filter((item) => item.provider === "provider").map((item) => item.consumer).sort();
  assert.deepEqual(consumers, ["decision", "review"]);
  target.closeInput();
  assert.equal((await target.complete(pass)).ok, false);
});

test("K09: previously handled receipts are reopened after their provider is corrected", async () => {
  const target = kernel({ provider: "old", consumer: "old" });
  target.addDependency("consumer", "provider");
  target.change("provider", "wrong");
  target.deliverAll();
  const obligation = onlyObligation(target);
  await commit(target, "first-pass", ["provider", "consumer"], {}, { obligations: [obligation.id] });
  assert.equal(onlyObligation(target).state, "handled");
  target.retireDependency("consumer", "provider", "current edge retired; evidence must remain");
  target.change("provider", "correct");
  target.deliverAll();
  assert.equal(onlyObligation(target).state, "pending");
  assert.equal(onlyObligation(target).receipt, null);
  assert.equal(onlyObligation(target).requiredVersion, 2);
});

test("K08: an evidence-only correction reopens historical consumers without changing artifact bytes", async () => {
  const target = kernel({ provider: "same-words", consumer: "review" });
  target.addDependency("consumer", "provider");
  const first = target.correct("provider", "first source qualification");
  target.deliver(first);
  const work = onlyObligation(target);
  const handled = await commit(target, "review-qualification", ["provider", "consumer"], {}, { obligations: [work.id] });
  const originalVersion = target.artifact("provider").version;
  const originalEpoch = target.artifact("provider").evidenceEpoch;
  const oldReceipt = onlyObligation(target).receipt;
  assert.equal(oldReceipt?.evidence, handled.result.validation);
  target.retireDependency("consumer", "provider", "current edge retired; past interpretation remains");
  const corrected = target.correct("provider", "source qualification was itself incorrect");
  target.deliver(corrected);
  assert.equal(target.artifact("provider").version, originalVersion);
  assert.equal(target.contents().provider, "same-words");
  assert.equal(target.artifact("provider").evidenceEpoch, originalEpoch + 1);
  assert.equal(onlyObligation(target).state, "pending");
  assert.equal(onlyObligation(target).requiredVersion, originalVersion);
  assert.equal(onlyObligation(target).requiredEvidenceEpoch, originalEpoch + 1);
  assert.equal(onlyObligation(target).receipt, null);
  target.deliver(first);
  assert.equal(onlyObligation(target).requiredEvidenceEpoch, originalEpoch + 1);
});

test("K09: an evidence-only correction invalidates indirect historical assumptions before delivery", async () => {
  const target = kernel({ provider: "same-words", review: "empty", decision: "empty" });
  await commit(target, "review-work", ["provider", "review"], { review: "reviewed" });
  await commit(target, "decision-work", ["review", "decision"], { decision: "accepted" });
  target.deliverAll();
  const old = proposal(target, "old-decision", ["decision"], { decision: "finished" });
  await target.validate(old.candidate.id, pass);
  const before = target.artifact("decision");
  target.correct("provider", "the cited source was retracted");
  assert.equal(target.artifact("decision").content, before.content);
  assert.equal(target.artifact("decision").version, before.version);
  rejectsWithoutMutation(target, () => target.commit(old.candidate.id), "stale-read");
  target.deliverAll();
  assert.deepEqual(target.pending().filter((item) => item.provider === "provider").map((item) => item.consumer).sort(),
    ["decision", "review"]);
});

test("K10: seen is not handled and released work can be acquired by another worker", async () => {
  const target = kernel({ provider: "old", consumer: "old" });
  target.addDependency("consumer", "provider");
  target.change("provider", "new");
  target.deliverAll();
  const work = onlyObligation(target);
  target.seen(work.id, "A");
  assert.equal(onlyObligation(target).state, "running");
  assert.equal(onlyObligation(target).receipt, null);
  target.closeInput();
  assert.ok((await target.complete(pass)).errors.includes("pending-work"));
  target.release(work.id, "A");
  target.seen(work.id, "B");
  assert.equal(onlyObligation(target).agent, "B");
  await commit(target, "B-finish", ["provider", "consumer"], {}, { agent: "B", obligations: [work.id] });
  assert.equal((await target.complete(pass)).ok, true);
});

test("K11: reverse and duplicate delivery cannot regress required versions or duplicate completion", async () => {
  const target = kernel({ provider: "v0", consumer: "unchanged" });
  target.addDependency("consumer", "provider");
  const event1 = target.change("provider", "v1")!;
  const event2 = target.change("provider", "v2")!;
  target.deliver(event2);
  const work = onlyObligation(target);
  assert.equal(work.requiredVersion, 2);
  const handled = await commit(target, "handle-latest", ["provider", "consumer"], {}, { obligations: [work.id] });
  const receipt = onlyObligation(target).receipt;
  target.deliver(event1);
  target.deliver(event2);
  assert.equal(onlyObligation(target).requiredVersion, 2);
  assert.equal(onlyObligation(target).state, "handled");
  assert.deepEqual(onlyObligation(target).receipt, receipt);
  rejectsWithoutMutation(target, () => target.commit(handled.candidate.id), "candidate-not-validated");
  assert.equal(target.events().length, 2);
});

test("K12: an advisory claim grants no authority and does not block an authorized writer", async () => {
  const target = kernel({ consumer: "old" });
  target.reserve("consumer", "reserver");
  const context = target.checkout("reserver", ["consumer"]);
  rejectsWithoutMutation(target, () => target.prepare({
    id: "unauthorized", agent: "reserver", context: context.id,
    writes: { consumer: "unauthorized" }, lease: { id: "nonexistent", epoch: 1 },
  }), "invalid-authority");
  await commit(target, "authorized", ["consumer"], { consumer: "new" });
  assert.equal(target.contents().consumer, "new");
});

test("K13: revocation fences old authority even when the artifact is unchanged", async () => {
  const target = kernel({ consumer: "old" });
  const work = proposal(target, "writer", ["consumer"], { consumer: "new" });
  await target.validate(work.candidate.id, pass);
  target.revoke(work.lease.id);
  assert.equal(target.artifact("consumer").version, 0);
  rejectsWithoutMutation(target, () => target.commit(work.candidate.id), "invalid-authority");
  await commit(target, "fresh-authority", ["consumer"], { consumer: "new" }, { agent: "writer" });
  assert.equal(target.contents().consumer, "new");
});

test("K14: an authority lease is invalid exactly at its expiration time", async () => {
  let now = 0;
  const target = new SwarmKernel({ artifacts: { consumer: "old" }, now: () => now });
  const lease = target.grant("writer", ["consumer"], 100);
  const work = proposal(target, "expiry", ["consumer"], { consumer: "new" }, { agent: "writer", lease });
  now = 99;
  await target.validate(work.candidate.id, pass);
  now = 100;
  rejectsWithoutMutation(target, () => target.commit(work.candidate.id), "invalid-authority");
});

test("K14: authority is bound to its holder and the full write scope", () => {
  const target = kernel({ allowed: "old", forbidden: "old" });
  const lease = target.grant("owner", ["allowed"]);
  const thief = target.checkout("thief", ["allowed"]);
  rejectsWithoutMutation(target, () => target.prepare({
    id: "stolen", agent: "thief", context: thief.id, writes: { allowed: "stolen" }, lease,
  }), "invalid-authority");
  const owner = target.checkout("owner", ["allowed", "forbidden"]);
  rejectsWithoutMutation(target, () => target.prepare({
    id: "partial-scope", agent: "owner", context: owner.id,
    writes: { allowed: "new", forbidden: "new" }, lease,
  }), "outside-authority");
  assert.deepEqual(target.contents(), { allowed: "old", forbidden: "old" });
});

test("K15: an upper-model intervention with stale observations passes no special bypass", async () => {
  const target = kernel({ spec: "old", work: "old" });
  const lease = target.grant("meta", ["spec"], 60_000, "meta");
  const intervention = proposal(target, "intervention", ["spec", "work"], { spec: "new" }, {
    agent: "meta", lease, kind: "intervention",
  });
  await target.validate(intervention.candidate.id, pass);
  target.change("work", "new-observation");
  rejectsWithoutMutation(target, () => target.commit(intervention.candidate.id), "stale-read");
  assert.equal(target.contents().spec, "old");
});

test("K16: valid intervention invalidates dependent work and wakes only affected artifacts", async () => {
  const target = kernel({ spec: "old", consumer: "old", unrelated: "old" });
  target.addDependency("consumer", "spec");
  const oldWork = proposal(target, "old-work", ["spec", "consumer"], { consumer: "using-old" });
  await target.validate(oldWork.candidate.id, pass);
  const lease = target.grant("meta", ["spec"], 60_000, "meta");
  await commit(target, "new-policy", ["spec"], { spec: "new" }, { agent: "meta", lease, kind: "intervention" });
  rejectsWithoutMutation(target, () => target.commit(oldWork.candidate.id), "stale-read");
  target.deliverAll();
  assert.deepEqual(target.pending().map((item) => item.consumer), ["consumer"]);
  assert.equal(target.artifact("unrelated").evidenceEpoch, 0);
  assert.equal(target.trace().filter((item) => item.type === "intervention").length, 1);
});

test("K16: worker authority cannot impersonate a meta intervention", () => {
  const target = kernel({ spec: "old" });
  const context = target.checkout("worker", ["spec"]);
  const lease = target.grant("worker", ["spec"]);
  rejectsWithoutMutation(target, () => target.prepare({
    id: "pretend-meta", agent: "worker", context: context.id, writes: { spec: "new" }, lease, kind: "intervention",
  }), "meta-authority-required");
});

test("K17: an undelivered event alone prevents completion, even with no known consumers", async () => {
  const target = kernel({ artifact: "old" });
  target.change("artifact", "new");
  target.closeInput();
  let calls = 0;
  const result = await target.complete(() => { calls++; return { ok: true, errors: [] }; });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("undelivered-events"));
  assert.equal(calls, 0);
  target.deliverAll();
  assert.equal((await target.complete(pass)).ok, true);
});

for (const state of ["pending", "running"] as const) {
  test(`K17: ${state} obligation alone prevents completion`, async () => {
    const target = kernel({ provider: "old", consumer: "old" });
    target.addDependency("consumer", "provider");
    target.change("provider", "new");
    target.deliverAll();
    if (state === "running") target.seen(onlyObligation(target).id, "worker");
    target.closeInput();
    const result = await target.complete(pass);
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ["pending-work"]);
  });
}

for (const state of ["prepared", "validated"] as const) {
  test(`K17: ${state} proposal alone prevents completion`, async () => {
    const target = kernel({ artifact: "old" });
    const work = proposal(target, "writer", ["artifact"], { artifact: "new" });
    if (state === "validated") await target.validate(work.candidate.id, pass);
    target.closeInput();
    assert.deepEqual((await target.complete(pass)).errors, ["pending-proposals"]);
    target.discard(work.candidate.id, "work cancelled with explicit disposition");
    assert.equal((await target.complete(pass)).ok, true);
  });
}

test("K17: scheduled retry remains unfinished even after its due time passes", async () => {
  let now = 0;
  const target = new SwarmKernel({ artifacts: { artifact: "old" }, now: () => now });
  target.scheduleRetry("retry", 10);
  target.closeInput();
  now = 10_000;
  assert.deepEqual((await target.complete(pass)).errors, ["scheduled-retries"]);
  target.clearRetry("retry");
  assert.equal((await target.complete(pass)).ok, true);
});

test("K17: active work alone prevents completion without requiring a proposal or consultation", async () => {
  const target = kernel({ result: "correct" });
  target.beginWork("local-investigation", "worker");
  target.closeInput();
  assert.deepEqual((await target.complete(pass)).errors, ["active-workers"]);
  target.endWork("local-investigation");
  assert.equal((await target.complete(pass)).ok, true);
});

test("K18: elapsed time and unrelated successful work cannot erase a blocking claim", async () => {
  let now = 0;
  const target = new SwarmKernel({ artifacts: { contested: "unknown", other: "old" }, now: () => now });
  const claim = target.openClaim("contested", "missing independent evidence");
  for (let index = 0; index < 3; index++) await commit(target, `other-${index}`, ["other"], { other: String(index) });
  target.deliverAll();
  target.closeInput();
  now = 1_000_000;
  assert.deepEqual((await target.complete(pass)).errors, ["blocking-claims"]);
  assert.equal(target.exportState().claims.find((item) => item.id === claim)?.open, true);
});

test("K18: a blocking claim can be resolved using committed evidence that fixes its subject", async () => {
  const target = kernel({ subject: "wrong" });
  const claim = target.openClaim("subject", "subject violates acceptance");
  const fixed = await commit(target, "fix", ["subject"], { subject: "correct" });
  target.resolveClaim(claim, fixed.context.id, fixed.result.validation);
  target.deliverAll();
  target.closeInput();
  assert.equal(target.exportState().claims.find((item) => item.id === claim)?.open, false);
  assert.equal((await target.complete((contents) => ({ ok: contents.subject === "correct", errors: [] }))).ok, true);
});

test("K18: a nonblocking claim permits completion and invented evidence cannot resolve a blocking claim", async () => {
  const target = kernel({ subject: "value" });
  target.openClaim("subject", "optional follow-up", false);
  target.closeInput();
  assert.equal((await target.complete(pass)).ok, true);
  const blocking = target.openClaim("subject", "requires evidence");
  const context = target.checkout("worker", ["subject"]);
  rejectsWithoutMutation(target, () => target.resolveClaim(blocking, context.id, "invented-pass"), "invalid-claim-evidence");
  assert.equal((await target.complete(pass)).ok, false);
});

test("K18: stale committed evidence cannot resolve a claim after a premise changes", async () => {
  const target = kernel({ premise: "old", subject: "wrong" });
  const claim = target.openClaim("subject", "requires premise-dependent repair");
  const fixed = await commit(target, "fix", ["premise", "subject"], { subject: "correct-under-old-premise" });
  target.correct("premise", "the original premise is no longer supported");
  rejectsWithoutMutation(target, () => target.resolveClaim(claim, fixed.context.id, fixed.result.validation), "stale-claim-evidence");
  assert.equal(target.exportState().claims.find((item) => item.id === claim)?.open, true);
});

test("K18: acceptance-policy changes also invalidate evidence offered to resolve a claim", async () => {
  const target = kernel({ subject: "wrong" });
  const claim = target.openClaim("subject", "requires validated repair");
  const fixed = await commit(target, "fix", ["subject"], { subject: "correct" });
  target.setVerificationPolicy("different acceptance and environment");
  rejectsWithoutMutation(target, () => target.resolveClaim(claim, fixed.context.id, fixed.result.validation), "stale-validation-policy");
});

test("K19: open input prevents completion; a closed, clean run passes actual acceptance", async () => {
  const target = kernel({ result: "correct" });
  assert.deepEqual((await target.complete(pass)).errors, ["input-open"]);
  target.closeInput();
  let checked: Contents | undefined;
  assert.equal((await target.complete((contents) => {
    checked = contents;
    return { ok: contents.result === "correct", errors: [] };
  })).ok, true);
  assert.deepEqual(checked, { result: "correct" });
  rejectsWithoutMutation(target, () => target.change("result", "late-input"), "input-closed");
  rejectsWithoutMutation(target, () => target.correct("result", "late evidence correction"), "input-closed");
});

test("K19: completing again invokes acceptance on current contents rather than reusing a prior pass", async () => {
  const target = kernel({ result: "correct" });
  target.closeInput();
  assert.equal((await target.complete(pass)).ok, true);
  await commit(target, "later-work", ["result"], { result: "wrong" });
  target.deliverAll();
  const result = await target.complete((contents) => ({ ok: contents.result === "correct", errors: ["wrong result"] }));
  assert.equal(result.ok, false);
});

test("K19: a blocker created during asynchronous acceptance invalidates completion", async () => {
  const target = kernel({ subject: "correct" });
  target.closeInput();
  const finished = deferred<{ ok: boolean; errors: string[] }>();
  const completion = target.complete(() => finished.promise);
  target.openClaim("subject", "new evidence requires review");
  finished.resolve({ ok: true, errors: [] });
  const result = await completion;
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("state-changed-during-completion"));
  assert.ok(result.errors.includes("blocking-claims"));
});

test("K19: transient retry transitions during acceptance are observable state changes", async () => {
  const target = kernel({ subject: "correct" });
  target.closeInput();
  const finished = deferred<{ ok: boolean; errors: string[] }>();
  const completion = target.complete(() => finished.promise);
  target.scheduleRetry("raced-work", 1);
  target.clearRetry("raced-work");
  finished.resolve({ ok: true, errors: [] });
  const result = await completion;
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("state-changed-during-completion"));
});

test("K19: starting and finishing active work during acceptance invalidates that completion pass", async () => {
  const target = kernel({ result: "correct" });
  target.closeInput();
  const finished = deferred<{ ok: boolean; errors: string[] }>();
  const completion = target.complete(() => finished.promise);
  target.beginWork("during-acceptance", "worker");
  target.endWork("during-acceptance");
  finished.resolve({ ok: true, errors: [] });
  const result = await completion;
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("state-changed-during-completion"));
});

test("K20: external acceptance catches a hidden dependency missing from the known graph", async () => {
  const target = kernel({ provider: "v1", consumer: "uses-v1" });
  target.change("provider", "v2");
  target.deliverAll();
  assert.equal(target.pending().length, 0);
  target.closeInput();
  const result = await target.complete((contents) => {
    const ok = contents.consumer === `uses-${contents.provider}`;
    return { ok, errors: ok ? [] : ["consumer contract is stale"] };
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["consumer contract is stale"]);
});

test("K21: a stable dependency cycle is not itself pending work or a completion failure", async () => {
  const target = kernel({ a: "stable", b: "stable" });
  target.addDependency("a", "b");
  target.addDependency("b", "a");
  target.closeInput();
  assert.equal(target.pending().length, 0);
  assert.equal((await target.complete(pass)).ok, true);
});

test("K22: invalid dependencies, duplicate proposals, and unknown receipt IDs preserve state", () => {
  const target = kernel({ a: "old", b: "old" });
  rejectsWithoutMutation(target, () => target.addDependency("a", "missing"), "unknown-artifact");
  rejectsWithoutMutation(target, () => target.addDependency("a", "b", 999), "invalid-observed-version");
  rejectsWithoutMutation(target, () => target.seen("missing", "worker"), "invalid-obligation");
  rejectsWithoutMutation(target, () => target.checkout("worker", ["a", "missing"]), "unknown-artifact");
  const work = proposal(target, "unique", ["a"], { a: "new" });
  rejectsWithoutMutation(target, () => target.prepare(work.input), "duplicate-proposal");
  rejectsWithoutMutation(target, () => target.prepare({ ...work.input, id: "duplicate-with-different-content", writes: { a: 1 } } as unknown as ProposalInput), "invalid-proposal");
});

test("K22: unseen provider assumptions cannot discharge an obligation", () => {
  const target = kernel({ provider: "old", consumer: "old" });
  target.addDependency("consumer", "provider");
  target.change("provider", "new");
  target.deliverAll();
  const work = onlyObligation(target);
  const context = target.checkout("worker", ["consumer"]);
  const lease = target.grant("worker", ["consumer"]);
  rejectsWithoutMutation(target, () => target.prepare({
    id: "unseen-provider", agent: "worker", context: context.id, writes: {}, lease, obligations: [work.id],
  }), "unobserved-obligation");
});

test("K22: a proposal's read context is bound to its agent", () => {
  const target = kernel({ a: "old" });
  const context = target.checkout("reader", ["a"]);
  const lease = target.grant("thief", ["a"]);
  rejectsWithoutMutation(target, () => target.prepare({
    id: "stolen-context", agent: "thief", context: context.id, writes: { a: "new" }, lease,
  }), "invalid-context");
});

test("K22: invalid verifier output and verifier exceptions cannot authorize a candidate", async () => {
  const target = kernel({ a: "old" });
  const invalid = proposal(target, "invalid-verifier", ["a"], { a: "new" });
  await assert.rejects(target.validate(invalid.candidate.id, (() => ({ ok: "yes", errors: [] })) as unknown as Verifier),
    (error: unknown) => error instanceof KernelError && error.code === "invalid-verdict");
  rejectsWithoutMutation(target, () => target.commit(invalid.candidate.id), "candidate-not-validated");
  const throwing = proposal(target, "throwing-verifier", ["a"], { a: "new" });
  await assert.rejects(target.validate(throwing.candidate.id, () => { throw new Error("validator failed"); }),
    (error: unknown) => error instanceof KernelError && error.code === "validator-error");
  rejectsWithoutMutation(target, () => target.commit(throwing.candidate.id), "candidate-not-validated");
  assert.equal(target.contents().a, "old");
});

test("K22: completion validates every error entry just as candidate validation does", async () => {
  const target = kernel({ a: "old" });
  target.closeInput();
  await assert.rejects(target.complete((() => ({ ok: true, errors: [123] })) as unknown as Verifier),
    (error: unknown) => error instanceof KernelError && error.code === "invalid-verdict");
});
