import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { callCodex, CodexWorkerError, type CodexCallOptions, type CodexCallResult, type CodexUsage } from "./codex-worker.ts";
import { createHeldoutFixture, discoverThermalDependencies, type FixtureEdge } from "./heldout-fixture.ts";
import { KernelError, SwarmKernel, type Checkout, type Contents, type Verdict } from "./kernel.ts";
import { WorkerPool, type WorkerAssignment, type WorkerStats } from "./worker-pool.ts";

export const COMPARISON_METHODS = ["single-upper", "manager-local", "sheep-fixed", "sheep-full"] as const;
export type ComparisonMethod = typeof COMPARISON_METHODS[number];
export interface ComparisonResponse {
  readonly writes: readonly { readonly id: string; readonly content: string }[];
  readonly targets: readonly string[];
  readonly note: string;
}
export type ComparisonCaller = (options: CodexCallOptions) => Promise<CodexCallResult<ComparisonResponse>>;
export interface ComparisonOptions {
  readonly method: ComparisonMethod;
  readonly outputDirectory: string;
  readonly size?: number;
  readonly workers?: number;
  readonly concurrency?: number;
  readonly maxCalls?: number;
  readonly maxTokens?: number;
  readonly reserveTokensPerCall?: number;
  readonly timeoutMs?: number;
  readonly maxRounds?: number;
  readonly maxAttempts?: number;
  readonly fault?: "none" | "rounded-guidance";
}
type Phase = "implementation" | "management" | "intervention";
export interface ComparisonCall {
  id: string; model: "gpt-6-astra" | "gpt-5.6-luna"; agent: string; phase: Phase; target: string | null;
  retry: boolean; contextArtifacts: string[]; contextBytes: number; promptBytes: number;
  durationMs: number; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  usageComplete: boolean; reservedTokens: number; reservationOverrun: boolean;
  effectiveModelEvidence: string | null; outcome: string; errors: string[];
  failureKind: "semantic" | "transport" | "response" | "stale" | "budget" | null;
  persistentContext?: { id: string; reads: Checkout["reads"] };
  planningObservation?: { id: string; reads: Checkout["reads"]; bytes: number };
}
export interface ComparisonReport {
  format: 1; task: string; fixtureFingerprint: string; method: ComparisonMethod;
  configuration: Required<Omit<ComparisonOptions, "outputDirectory">>;
  success: boolean; qualityPass: boolean; finalErrors: readonly string[];
  calls: ComparisonCall[]; lowerCalls: number; upperCalls: number; interventions: number; retries: number;
  maxActiveModelCalls: number; workerStats: WorkerStats[];
  budget: { maxTokens: number; reserveTokensPerCall: number; observedTokens: number; observedInputTokens: number;
    observedOutputTokens: number; unknownUsageCalls: number; reservationOverruns: number; exceeded: boolean; admissionDenied: boolean };
  times: { preparationMs: number; readingMs: number; acceptanceMs: number; discoveryMs: number; modelMs: number; retryModelMs: number; elapsedMs: number };
  discovery: { scans: number; filesRead: number; bytesRead: number; edges: number; missingDeclaredEdges: number };
  acceptanceChecks: number; contextBytes: number; unknownPreparationCost: string[]; limitations: string[];
}

const schema = {
  type: "object", properties: {
    writes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, content: { type: "string" } },
      required: ["id", "content"], additionalProperties: false } },
    targets: { type: "array", items: { type: "string" } }, note: { type: "string" },
  }, required: ["writes", "targets", "note"], additionalProperties: false,
};

function response(value: unknown): ComparisonResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response must be an object");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["writes", "targets", "note"].includes(key)) || typeof item.note !== "string"
    || !Array.isArray(item.targets) || item.targets.some(target => typeof target !== "string")
    || !Array.isArray(item.writes)) throw new Error("invalid comparison response");
  const seen = new Set<string>();
  for (const entry of item.writes) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid patch entry");
    const patch = entry as Record<string, unknown>;
    if (Object.keys(patch).some(key => key !== "id" && key !== "content")
      || typeof patch.id !== "string" || typeof patch.content !== "string" || seen.has(patch.id)) throw new Error("invalid or duplicate patch target");
    seen.add(patch.id);
  }
  if (new Set(item.targets).size !== item.targets.length) throw new Error("duplicate management targets");
  return item as unknown as ComparisonResponse;
}

function countUsage(usage: readonly CodexUsage[]) {
  let input = 0, output = 0, total = 0;
  let inputComplete = usage.length > 0, outputComplete = usage.length > 0, totalComplete = usage.length > 0;
  const valid = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;
  for (const row of usage) {
    const i = valid(row.inputTokens) ? row.inputTokens : null;
    const o = valid(row.outputTokens) ? row.outputTokens : null;
    if (i === null) inputComplete = false;
    if (o === null) outputComplete = false;
    if ((i === null || o === null) && !valid(row.totalTokens)) totalComplete = false;
    input += i ?? 0; output += o ?? 0;
    total += Math.max((i ?? 0) + (o ?? 0), valid(row.totalTokens) ? row.totalTokens : 0);
  }
  return { input, output, total, complete: inputComplete && outputComplete, inputComplete, outputComplete, totalComplete };
}

/** Small paired-pilot runner. Every method uses the same pinned source, oracle and mutation boundary. */
export async function runComparison(options: ComparisonOptions, caller: ComparisonCaller = callCodex<ComparisonResponse>): Promise<ComparisonReport> {
  const start = performance.now();
  if (!COMPARISON_METHODS.includes(options.method)) throw new TypeError("unknown comparison method");
  const config: ComparisonReport["configuration"] = {
    method: options.method, size: options.size ?? 8, workers: options.workers ?? 4, concurrency: options.concurrency ?? 4,
    maxCalls: options.maxCalls ?? 48, maxTokens: options.maxTokens ?? 120_000,
    reserveTokensPerCall: options.reserveTokensPerCall ?? 12_000, timeoutMs: options.timeoutMs ?? 120_000,
    maxRounds: options.maxRounds ?? 24, maxAttempts: options.maxAttempts ?? 3, fault: options.fault ?? "none",
  };
  for (const key of ["size", "workers", "concurrency", "maxCalls", "maxTokens", "reserveTokensPerCall", "timeoutMs", "maxRounds", "maxAttempts"] as const)
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new RangeError(`${key} must be a positive integer`);
  if (config.reserveTokensPerCall > config.maxTokens) throw new RangeError("reservation exceeds total token budget");
  if (!["none", "rounded-guidance"].includes(config.fault)) throw new TypeError("unknown comparison fault");
  const pool = new WorkerPool({ workers: config.workers, concurrency: config.concurrency });
  const fixture = createHeldoutFixture({ size: config.size });
  const initialArtifacts = { ...fixture.artifacts };
  if (config.fault === "rounded-guidance") initialArtifacts[fixture.specId] = initialArtifacts[fixture.specId]!.replace(
    "Do not round or widen limits.", "Round returned kelvin and pascals down to whole integers; preserve the physical limits.");
  await mkdir(dirname(options.outputDirectory), { recursive: true });
  await mkdir(options.outputDirectory);
  const workspace = join(options.outputDirectory, "model-workspace");
  await mkdir(workspace);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    artifacts: initialArtifacts, change: fixture.changedSource, editable: [...fixture.writableIds, fixture.specId], fault: config.fault,
  })).digest("hex");
  const kernel = new SwarmKernel({ artifacts: initialArtifacts, verificationPolicy: `${fixture.task}/size-${config.size}/node-${process.versions.node}` });
  const times = { preparationMs: 0, readingMs: 0, acceptanceMs: 0, discoveryMs: 0, modelMs: 0, retryModelMs: 0, elapsedMs: 0 };
  const discovery = { scans: 0, filesRead: 0, bytesRead: 0, edges: 0, missingDeclaredEdges: 0 };
  let graph: readonly FixtureEdge[] = [];
  const registerGraph = () => {
    if (config.method === "sheep-full") {
      const scan = discoverThermalDependencies(kernel.contents());
      graph = scan.edges; discovery.scans++; discovery.filesRead += scan.filesRead; discovery.bytesRead += scan.bytesRead;
      times.discoveryMs += scan.durationMs;
    } else graph = fixture.dependencies;
    const registered = new Set(kernel.exportState().dependencies.map(edge => `${edge.consumer}\0${edge.provider}`));
    for (const edge of graph) if (!registered.has(`${edge.consumer}\0${edge.provider}`)) kernel.addDependency(edge.consumer, edge.provider, 0);
    discovery.edges = graph.length;
  };
  registerGraph();
  kernel.change(fixture.changedSource.id, fixture.changedSource.content);
  kernel.closeInput(); kernel.deliverAll();
  times.preparationMs = performance.now() - start;

  const calls: ComparisonCall[] = [];
  const budget = { maxTokens: config.maxTokens, reserveTokensPerCall: config.reserveTokensPerCall,
    observedTokens: 0, observedInputTokens: 0, observedOutputTokens: 0, unknownUsageCalls: 0,
    reservationOverruns: 0, exceeded: false, admissionDenied: false };
  let reserved = 0, active = 0, maxActive = 0, acceptanceChecks = 0, serial = 0, interventions = 0;
  let lane: Promise<void> = Promise.resolve();
  const attempts = new Map<string, number>();
  const failures = new Map<string, string[]>();
  const semanticFailures = new Set<string>();
  const claims = new Map<string, string>();
  let lastInterventionFailureCount = 0;
  const budgetOkay = () => !budget.exceeded && budget.unknownUsageCalls === 0;
  const slots = () => budgetOkay() ? Math.max(0, Math.min(config.maxCalls - calls.length,
    Math.floor((config.maxTokens - budget.observedTokens - reserved) / config.reserveTokensPerCall))) : 0;
  const serialize = async <T>(action: () => Promise<T>): Promise<T> => {
    const previous = lane; let release = () => {};
    lane = new Promise<void>(resolve => { release = resolve; });
    await previous; try { return await action(); } finally { release(); }
  };
  const verify = async (contents: Contents, scope?: readonly string[]): Promise<Verdict> => {
    const before = performance.now(); acceptanceChecks++;
    try { return await fixture.verify(contents, scope); } finally { times.acceptanceMs += performance.now() - before; }
  };
  const checkout = (agent: string, targets: readonly string[], global = false) => {
    const before = performance.now();
    const ids = new Set(global ? Object.keys(kernel.contents()) : [...targets, fixture.specId, fixture.sourceId]);
    for (const id of ids) for (const edge of graph) if (edge.consumer === id) ids.add(edge.provider);
    for (const item of kernel.pending()) if (targets.includes(item.consumer)) ids.add(item.provider);
    const context = kernel.checkout(agent, [...ids]); times.readingMs += performance.now() - before; return context;
  };
  const fail = (target: string, errors: readonly string[], semantic = false) => {
    failures.set(target, [...errors]);
    if (semantic) semanticFailures.add(target);
    if (!claims.has(target)) claims.set(target, kernel.openClaim(target, errors.join("\n").slice(0, 2000) || "unresolved acceptance failure"));
  };
  const resolved = (target: string, context: string, validation: string) => {
    const claim = claims.get(target);
    if (claim) { kernel.resolveClaim(claim, context, validation); claims.delete(target); }
    failures.delete(target); semanticFailures.delete(target);
  };
  const invoke = async (agent: string, phase: Phase, target: string | null, context: Checkout,
    instruction: string, extra: Record<string, unknown> = {}, observation?: Checkout): Promise<{ value: ComparisonResponse | null; record: ComparisonCall } | null> => {
    if (!slots()) { budget.admissionDenied = true; return null; }
    const readStart = performance.now();
    const planningObservation = observation ? { id: observation.id, contents: observation.contents, reads: observation.reads } : undefined;
    const suppliedExtra = planningObservation ? { ...extra, planningObservation } : extra;
    const observationBytes = planningObservation ? Buffer.byteLength(JSON.stringify(planningObservation)) : 0;
    const prompt = `${instruction}\nReturn JSON {writes:[{id,content}],targets:[artifactId],note}. Use complete replacement files. All context is supplied; do not use tools or read other paths. The pinned source and external acceptance cannot be changed.\n\nCONTEXT_JSON\n${JSON.stringify(context.contents)}\nEXTRA_JSON\n${JSON.stringify(suppliedExtra)}`;
    // Preserve the complete management input even when the model call fails. The
    // wider observation is paid-for input, but is not a future code dependency.
    const inputReceipt = planningObservation ? { input: { context, extra: suppliedExtra } } : {};
    times.readingMs += performance.now() - readStart;
    const retry = target !== null ? (attempts.get(target) ?? 0) > 1
      : phase === "implementation" && calls.some(call => call.phase === "implementation");
    const record: ComparisonCall = { id: `compare-call-${++serial}`, model: agent === "upper" ? "gpt-6-astra" : "gpt-5.6-luna",
      agent, phase, target, retry, contextArtifacts: [...new Set([...Object.keys(context.reads), ...Object.keys(observation?.reads ?? {})])],
      contextBytes: Buffer.byteLength(JSON.stringify(context.contents)) + observationBytes,
      promptBytes: Buffer.byteLength(prompt), durationMs: 0, inputTokens: null, outputTokens: null, totalTokens: null,
      usageComplete: false, reservedTokens: config.reserveTokensPerCall, reservationOverrun: false,
      effectiveModelEvidence: null, outcome: "running", errors: [], failureKind: null };
    if (observation) {
      record.persistentContext = { id: context.id, reads: structuredClone(context.reads) };
      record.planningObservation = { id: observation.id, reads: structuredClone(observation.reads), bytes: observationBytes };
    }
    calls.push(record); reserved += config.reserveTokensPerCall; active++; maxActive = Math.max(maxActive, active);
    kernel.beginWork(record.id, agent);
    const calledAt = performance.now();
    let usage: readonly CodexUsage[] = [];
    let value: ComparisonResponse | null = null;
    let returned = false;
    try {
      if (planningObservation) await writeFile(join(options.outputDirectory, `${record.id}.json`), JSON.stringify(inputReceipt, null, 2) + "\n");
      const result = await caller({ model: record.model, prompt, schema, cwd: workspace, timeoutMs: config.timeoutMs,
        outputDirectory: join(options.outputDirectory, "transcripts") });
      returned = true;
      usage = result.usage;
      record.effectiveModelEvidence = result.transcript.effectiveModelEvidence ?? null;
      await writeFile(join(options.outputDirectory, `${record.id}.json`), JSON.stringify({ ...result, ...inputReceipt }, null, 2) + "\n");
      if (result.requestedModel !== record.model || (record.effectiveModelEvidence !== null && record.effectiveModelEvidence !== record.model))
        throw new Error("model identity does not match requested role");
      value = response(result.result); record.outcome = "received";
    } catch (error) {
      record.outcome = "error"; record.errors = [String(error)];
      record.failureKind = returned ? "response" : "transport";
      if (error instanceof CodexWorkerError) {
        if (["malformed-events", "missing-output", "malformed-output"].includes(error.code)) record.failureKind = "response";
        usage = error.transcript.usage;
        record.effectiveModelEvidence = error.transcript.effectiveModelEvidence ?? null;
        await writeFile(join(options.outputDirectory, `${record.id}.json`), JSON.stringify({ error: error.code, transcript: error.transcript, ...inputReceipt }, null, 2) + "\n");
      }
    } finally {
      record.durationMs = performance.now() - calledAt; times.modelMs += record.durationMs;
      if (retry) times.retryModelMs += record.durationMs;
      const observed = countUsage(usage);
      record.usageComplete = observed.complete;
      record.inputTokens = observed.inputComplete ? observed.input : null;
      record.outputTokens = observed.outputComplete ? observed.output : null;
      record.totalTokens = observed.totalComplete ? observed.total : null;
      budget.observedInputTokens += observed.input; budget.observedOutputTokens += observed.output; budget.observedTokens += observed.total;
      if (!observed.complete) budget.unknownUsageCalls++;
      record.reservationOverrun = observed.total > record.reservedTokens;
      if (record.reservationOverrun) budget.reservationOverruns++;
      budget.exceeded = budget.observedTokens > config.maxTokens;
      reserved -= record.reservedTokens; active--; kernel.endWork(record.id);
    }
    if (!budgetOkay()) { record.outcome = "budget-rejected"; record.failureKind ??= "budget"; value = null; }
    return { value, record };
  };

  const apply = async (record: ComparisonCall, value: ComparisonResponse, context: Checkout,
    allowed: readonly string[], scope: readonly string[] | undefined, intervention = false): Promise<boolean> => serialize(async () => {
    let candidateId: string | null = null;
    try {
      if (value.writes.some(write => !allowed.includes(write.id))) throw new Error("patch exceeds role edit authority");
      const pending = kernel.pending().filter(item => (scope ?? fixture.writableIds).includes(item.consumer));
      const lease = kernel.grant(record.agent, allowed, config.timeoutMs * 2 + 60_000, intervention ? "meta" : "worker");
      const candidate = kernel.prepare({ id: record.id, agent: record.agent, context: context.id,
        writes: Object.fromEntries(value.writes.map(write => [write.id, write.content])), lease,
        obligations: intervention ? [] : pending.map(item => item.id),
        ...(intervention ? { kind: "intervention", reason: value.note } : {}) });
      candidateId = candidate.id;
      const verdict = await kernel.validate(candidate.id, contents => verify(contents, scope));
      if (!verdict.ok) { record.outcome = "rejected"; record.failureKind = "semantic"; record.errors = [...verdict.errors]; return false; }
      const committed = kernel.commit(candidate.id); record.outcome = "committed";
      for (const target of scope ?? fixture.writableIds) resolved(target, context.id, committed.validation);
      if (intervention && committed.events.length) interventions++;
      if (committed.events.length) registerGraph();
      kernel.deliverAll(); return true;
    } catch (error) {
      record.outcome = error instanceof KernelError ? error.code : "patch-error"; record.errors = [String(error)];
      record.failureKind = ["stale-read", "stale-validation", "stale-obligation"].includes(record.outcome) ? "stale" : "response";
      if (candidateId) {
        const state = kernel.exportState().candidates.find(candidate => candidate.id === candidateId);
        if (state && state.state !== "committed") kernel.discard(candidateId, String(error));
      }
      return false;
    }
  });

  // Equal for every method: recheck existing artifacts instead of asking a model to rewrite already-correct files.
  const settleValid = async () => {
    kernel.deliverAll();
    for (const target of [...new Set(kernel.pending().map(item => item.consumer))]) {
      const context = checkout("acceptance", [target]);
      const lease = kernel.grant("acceptance", [target]);
      const work = kernel.pending().filter(item => item.consumer === target);
      if (!work.length) continue;
      const candidate = kernel.prepare({ id: `acceptance-${++serial}`, agent: "acceptance", context: context.id,
        writes: {}, lease, obligations: work.map(item => item.id) });
      const verdict = await kernel.validate(candidate.id, contents => verify(contents, [target]));
      if (verdict.ok) { const committed = kernel.commit(candidate.id); resolved(target, context.id, committed.validation); }
    }
  };
  const perform = async (assignment: WorkerAssignment) => {
    const target = assignment.target;
    attempts.set(target, (attempts.get(target) ?? 0) + 1);
    const context = checkout(assignment.workerId, [target]);
    let note = "No model response", outcome = "not-called";
    try {
      const result = await invoke(assignment.workerId, "implementation", target, context,
        `You are a local worker. Repair only ${target}. Preserve its physical behavior while migrating the API. targets must be empty. No upper-model consultation is part of the task.`,
        { target, errors: failures.get(target) ?? [], ownPastObservations: assignment.memory,
          memoryRule: "These notes describe past attempts at the recorded versions, not current facts." });
      if (!result) return;
      note = result.value?.note ?? result.record.errors.join("\n"); outcome = result.record.outcome;
      if (!result.value) { if (budgetOkay()) fail(target, result.record.errors); return; }
      if (result.value.targets.length) { result.record.outcome = "patch-error"; result.record.failureKind = "response"; result.record.errors = ["workers cannot assign tasks"]; }
      else if (await apply(result.record, result.value, context, [target], [target])) { outcome = "committed"; return; }
      outcome = result.record.outcome;
      if (!["stale-read", "stale-validation", "stale-obligation"].includes(outcome)) fail(target, result.record.errors, result.record.failureKind === "semantic");
    } finally { pool.finish(assignment.workerId, { target, note, outcome, reads: context.reads }); }
  };

  let infrastructureError: string | null = null;
  let final: Verdict = { ok: false, errors: ["not-completed"] };
  let quality: Verdict = { ok: false, errors: ["not-checked"] };
  try {
    for (let round = 0; round < config.maxRounds; round++) {
      await settleValid();
      const pending = [...new Set(kernel.pending().map(item => item.consumer))].filter(id => fixture.writableIds.includes(id));
      if (!pending.length) break;
      if (!slots()) { budget.admissionDenied = true; break; }
      if (config.method === "single-upper") {
        if (pending.some(id => (attempts.get(id) ?? 0) >= config.maxAttempts)) break;
        const context = checkout("upper", [...fixture.writableIds, fixture.specId], true);
        const result = await invoke("upper", "implementation", null, context,
          "Solve the complete thermal API migration. You may edit all sensor files, regional files and the specification, but never the pinned library. You may return an incremental subset of replacement files; accepted files are retained for subsequent calls. Each submitted file and its dependencies must satisfy local acceptance; final success still requires the whole migration. targets must be empty.",
          { pending, previousErrors: [...failures] });
        // Charge actual submitted targets, not untouched files elsewhere in the task.
        // Missing, empty or unauthorized responses still consume an attempt at the pending work.
        const submitted = result?.value?.writes.map(write => write.id) ?? [];
        const allowed = [...fixture.writableIds, fixture.specId];
        const scoped = submitted.length > 0 && submitted.every(id => allowed.includes(id)) && !result?.value?.targets.length;
        const attempted = scoped ? submitted : pending;
        const retry = attempted.some(id => (attempts.get(id) ?? 0) > 0);
        if (result && result.record.retry !== retry) {
          times.retryModelMs += (retry ? 1 : -1) * result.record.durationMs;
          result.record.retry = retry;
        }
        if (result) for (const id of attempted) attempts.set(id, (attempts.get(id) ?? 0) + 1);
        if (!result?.value) continue;
        if (result.value.targets.length) {
          result.record.outcome = "invalid-plan"; result.record.failureKind = "response";
          result.record.errors = ["single-upper cannot delegate targets"]; continue;
        }
        if (!await apply(result.record, result.value, context, allowed, submitted))
          for (const id of attempted) fail(id, result.record.errors, result.record.failureKind === "semantic");
        continue;
      }
      const ready = pending.filter(id => !graph.some(edge => edge.consumer === id && pending.includes(edge.provider))
        && (attempts.get(id) ?? 0) < config.maxAttempts);
      let jobs = [...ready];
      if (config.method === "manager-local") {
        const context = checkout("upper", [fixture.specId, fixture.sourceId]);
        const observation = checkout("upper", [], true);
        const result = await invoke("upper", "management", null, context,
          "Manage local workers: select up to concurrency entries from readyTargets as targets, in execution order. You may clarify only the specification in writes; do not implement worker files. Read the complete planningObservation snapshot and recorded validation results to select the next work. These are immutable observations at their recorded versions, not enduring requirements on worker code. Ground lasting specification guidance in the specification and pinned source supplied in CONTEXT_JSON.",
          { readyTargets: ready, concurrency: config.concurrency, failures: [...failures], recentCalls: calls.slice(-6).map(call => ({ target: call.target, outcome: call.outcome, errors: call.errors.slice(0, 2) })) }, observation);
        if (!result?.value) continue;
        // Planning still depends on a current global observation when applied.
        // Validate it once here; only the persistent spec/source context goes
        // through prepare/commit and becomes a historical dependency.
        const stale = Object.entries(observation.reads).filter(([id, read]) => {
          const current = kernel.artifact(id);
          return current.version !== read.version || current.evidenceEpoch !== read.evidenceEpoch;
        });
        if (stale.length) {
          result.record.outcome = "stale-planning-observation"; result.record.failureKind = "stale";
          result.record.errors = [`planning observation changed before application: ${stale.map(([id]) => id).join(", ")}`]; continue;
        }
        if (result.value.targets.length > config.concurrency || !result.value.targets.length || result.value.targets.some(id => !ready.includes(id))) {
          result.record.outcome = "invalid-plan"; result.record.failureKind = "response"; result.record.errors = ["management must select available targets within concurrency"]; continue;
        }
        if (result.value.writes.length && !await apply(result.record, result.value, context, [fixture.specId], [fixture.specId], true)) continue;
        if (!result.value.writes.length) result.record.outcome = "planned";
        jobs = [...result.value.targets];
      } else {
        const failureCount = calls.filter(call => call.phase === "implementation" && call.failureKind === "semantic").length;
        if (semanticFailures.size && failureCount > lastInterventionFailureCount && (failureCount - lastInterventionFailureCount >= 2 || !jobs.length)) {
          lastInterventionFailureCount = failureCount;
          const context = checkout("upper", [fixture.specId, fixture.sourceId]);
          const result = await invoke("upper", "intervention", null, context,
            "Observe the swarm's failure evidence without a worker consultation. Clarify only the shared specification if necessary, preserving the fixed acceptance contract. Do not implement worker files; targets must be empty.",
            { observations: calls.filter(call => call.failureKind === "semantic").slice(-6).map(call => ({ target: call.target, errors: call.errors.slice(0, 3) })) });
          if (result?.value && !result.value.targets.length) await apply(result.record, result.value, context, [fixture.specId], [fixture.specId], true);
          else if (result?.value) {
            result.record.outcome = "invalid-plan"; result.record.failureKind = "response";
            result.record.errors = ["Sheep meta guidance cannot assign worker targets"];
          }
          continue;
        }
      }
      const availableSlots = slots();
      if (jobs.length && !availableSlots) budget.admissionDenied = true;
      jobs = jobs.slice(0, Math.min(config.concurrency, availableSlots));
      if (!jobs.length) break;
      const assignments = pool.assign(jobs.map(target => ({ target, neighbors: graph.filter(edge => edge.consumer === target).map(edge => edge.provider) })));
      const settled = await Promise.allSettled(assignments.map(perform));
      const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      if (rejected.length) throw new AggregateError(rejected.map(item => item.reason), "comparison worker execution failed");
    }
    await settleValid();
    quality = await verify(kernel.contents());
    final = await kernel.complete(async () => quality);
  } catch (error) { infrastructureError = String(error); }
  const finalErrors = [...final.errors];
  if (infrastructureError) finalErrors.push(`infrastructure-error: ${infrastructureError}`);
  if (budget.exceeded) finalErrors.push("total-token-budget-exceeded");
  if (budget.unknownUsageCalls) finalErrors.push("token-usage-incomplete");
  const discovered = new Set(graph.map(edge => `${edge.consumer}\0${edge.provider}`));
  discovery.missingDeclaredEdges = fixture.dependencies.filter(edge => !discovered.has(`${edge.consumer}\0${edge.provider}`)).length;
  times.elapsedMs = performance.now() - start;
  const report: ComparisonReport = {
    format: 1, task: fixture.task, fixtureFingerprint: fingerprint, method: config.method, configuration: config,
    success: final.ok && budgetOkay() && infrastructureError === null, qualityPass: quality.ok, finalErrors,
    calls, lowerCalls: calls.filter(call => call.model === "gpt-5.6-luna").length,
    upperCalls: calls.filter(call => call.model === "gpt-6-astra").length, interventions,
    retries: calls.filter(call => call.retry).length, maxActiveModelCalls: maxActive, workerStats: pool.stats(), budget, times,
    discovery, acceptanceChecks, contextBytes: calls.reduce((sum, call) => sum + call.contextBytes, 0),
    unknownPreparationCost: ["Human fixture/oracle authorship and the supplied known graph are not timed by the runtime."],
    limitations: [
      "One synthetic held-out task with static imports and declared contract dependencies; not general-repository evidence.",
      "All methods share editable artifacts, external oracle, retries and the host's validation of already-correct artifacts. Role-specific write scopes differ intentionally.",
      "Sheep-full scans actual source bytes initially and after accepted changes. It does not discover arbitrary semantic dependencies.",
      "The CLI has no enforced per-call token cap. Reservation controls admission only; usage is settled after the call. Overshoot or unknown usage prevents success.",
      "Token totals are observed CLI usage; they are not currency cost. Preparation, reading, discovery and acceptance times overlap some elapsed categories and must not be summed blindly.",
      "Single-upper is sequential; multi-agent methods use the same configured pool and concurrency. This is a pilot, not statistical significance or optimal tuning.",
      "Every artifact has the same attempt cap across methods. Only semantic acceptance rejections trigger Sheep guidance; transport and response failures retry without semantic escalation.",
    ],
  };
  await writeFile(join(options.outputDirectory, "result.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(options.outputDirectory, "artifacts.json"), JSON.stringify(kernel.contents(), null, 2) + "\n");
  await writeFile(join(options.outputDirectory, "kernel-state.json"), JSON.stringify(kernel.exportState(), null, 2) + "\n");
  return report;
}
