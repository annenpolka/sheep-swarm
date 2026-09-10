export { dockerWorkspaceWrites } from "./docker-agent-worker.ts";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createFixture, type CodeFixture, type FixtureObserver } from "./fixture.ts";
import { callCodex, CodexWorkerError, type CodexCallResult } from "./codex-worker.ts";
import { callDockerAgent, dockerWorkspaceWrites, validateFiles, SANDBOX_TEMPLATE, type DockerAgentOptions, type DockerTranscript } from "./docker-agent-worker.ts";
import { createDockerFixtureObserver } from "./docker-fixture-observer.ts";
import { SwarmKernel, KernelError, type Checkout, type Verdict } from "./kernel.ts";
import { WorkerPool, type WorkerMemory, type WorkerStats } from "./worker-pool.ts";

export interface SwarmOptions {
  workers: number; concurrency: number; size: number; outputDirectory: string;
  workerModel?: "gpt-5.6-luna"; metaModel?: string; timeoutMs?: number;
  maxCalls?: number; maxMetaCalls?: number; maxRounds?: number;
  fault?: "none" | "rounded-guidance"; memoryLimit?: number;
  runtime?: "codex" | "docker-agent";
  workerTools?: "none" | "local";
  maxTokensPerCall?: number;
}
/** Trusted host-owned task definition; model responses cannot replace its oracle. */
export interface SwarmTask {
  readonly id: string;
  readonly createFixture: (observe?: FixtureObserver) => CodeFixture;
}
interface Response { content: string; note: string }
export type ModelCaller = (options: DockerAgentOptions) => Promise<CodexCallResult<Response>>;
interface CallRecord {
  id: string; role: "worker" | "meta"; agent: string; target: string; model: string;
  context: string; contextArtifacts: string[]; contextBytes: number;
  startedAt: number; durationMs: number; commitWaitMs: number;
  outcome: string; errors: string[]; inputTokens: number | null; outputTokens: number | null;
  effectiveModelEvidence: string | null;
  memoryEntries: number;
  usageCompleteness: "complete" | "partial-or-unknown" | null;
}
export interface SwarmReport {
  task: string;
  format: 2; startedAt: string; durationMs: number; configuration: Required<Omit<SwarmOptions, "outputDirectory">>;
  success: boolean; finalErrors: readonly string[]; maxActiveWorkers: number;
  registeredWorkers: number; completedArtifacts: number; writableArtifacts: number;
  lowerCalls: number; upperCalls: number; interventions: number; rounds: number;
  maxConcurrentModelCalls: number; everCommittedArtifacts: number; individuals: WorkerStats[];
  calls: CallRecord[];
  limitations: string[];
}
const SCHEMA = { type: "object", properties: { content: { type: "string" }, note: { type: "string" } },
  required: ["content", "note"], additionalProperties: false };

/** A bounded experimental scheduler. Semantic work belongs to the requested models. */
export async function runSwarm(options: SwarmOptions,
  model: ModelCaller = options.runtime === "docker-agent" ? callDockerAgent<Response> : callCodex<Response>,
  observe?: FixtureObserver,
  task?: SwarmTask,
): Promise<SwarmReport> {
  for (const value of [options.workers, options.concurrency, options.size])
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("worker, concurrency and size counts must be positive integers");
  if (options.concurrency > options.workers) throw new RangeError("concurrency must not exceed registered workers");
  if (options.workerModel !== undefined && options.workerModel !== "gpt-5.6-luna") throw new Error("real workers must use gpt-5.6-luna");
  if (options.workerTools !== undefined && !["none", "local"].includes(options.workerTools)) throw new Error("Unknown worker tools");
  if (options.workerTools === "local" && options.runtime !== "docker-agent") throw new Error("Local tools require the Docker Agent runtime");
  if (task && (!/^[a-z0-9][a-z0-9-]+$/.test(task.id) || options.fault && options.fault !== "none"))
    throw new Error("Custom tasks require a stable ID and no measurement-specific fault");
  const configuration: SwarmReport["configuration"] = {
    workers: options.workers, concurrency: options.concurrency, size: options.size,
    workerModel: "gpt-5.6-luna", metaModel: options.metaModel ?? "gpt-6-astra",
    timeoutMs: options.timeoutMs ?? 120_000, maxCalls: options.maxCalls ?? Math.ceil(options.size * 5),
    maxMetaCalls: options.maxMetaCalls ?? 2, maxRounds: options.maxRounds ?? 12, fault: options.fault ?? "none",
    memoryLimit: options.memoryLimit ?? 4,
    runtime: options.runtime ?? "codex",
    workerTools: options.workerTools ?? "none",
    maxTokensPerCall: options.maxTokensPerCall ?? 30_000,
  };
  for (const value of [configuration.timeoutMs, configuration.maxCalls, configuration.maxMetaCalls, configuration.maxRounds])
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("limits must be non-negative integers");
  if (!Number.isSafeInteger(configuration.maxTokensPerCall) || configuration.maxTokensPerCall < 1) throw new RangeError("token limit must be positive");
  await mkdir(dirname(options.outputDirectory), { recursive: true });
  await mkdir(options.outputDirectory); // A new run must never reuse old output as evidence.
  const workspace = await mkdtemp(join(options.outputDirectory, "model-workspace-"));
  const observer = observe ?? (configuration.runtime === "docker-agent" ? createDockerFixtureObserver(join(options.outputDirectory, "acceptance")) : undefined);
  const fixture = task ? task.createFixture(observer) : createFixture({ size: options.size, ...(observer ? { observe: observer } : {}) });
  if (configuration.runtime === "docker-agent") validateFiles({ ...fixture.artifacts, "visible.test.mjs": "" });
  const artifacts = { ...fixture.artifacts };
  if (configuration.fault === "rounded-guidance") {
    artifacts[fixture.specId] = artifacts[fixture.specId]!.replace(
      "Threshold comparisons are inclusive; do not round measurements or change thresholds.",
      "Threshold comparisons are inclusive. Round returned durationSeconds and kibibytesPerSecond down to whole numbers. Preserve health thresholds.");
  }
  const taskId = task?.id ?? "measurement-migration-v1";
  const kernel = new SwarmKernel({ artifacts, verificationPolicy: `${taskId}/size-${options.size}/${configuration.runtime === "docker-agent" ? SANDBOX_TEMPLATE : `node-${process.versions.node}`}` });
  for (const edge of fixture.dependencies) kernel.addDependency(edge.consumer, edge.provider);
  kernel.change(fixture.changedSource.id, fixture.changedSource.content);
  kernel.closeInput(); kernel.deliverAll();
  const start = Date.now();
  const calls: CallRecord[] = [];
  const attempts = new Map<string, number>();
  const errors = new Map<string, string[]>();
  const claims = new Map<string, string>();
  const successful = new Set<string>();
  const verifiedStates = new Map<string, { version: number; evidenceEpoch: number }>();
  let active = 0, maxActive = 0, upperCalls = 0, interventions = 0, rounds = 0;
  let activeModelCalls = 0, maxConcurrentModelCalls = 0;
  let lastMetaFailureCount = 0;
  let serial = 0;
  let unknownModelUsage = false;
  let runtimeCleanupFailed = false;
  let verificationUnavailable = false;
  const verify: typeof fixture.verify = async (contents, scope) => {
    const result = await fixture.verify(contents, scope);
    if (configuration.runtime === "docker-agent" && result.executionFailure) {
      verificationUnavailable = true;
      throw new Error(result.errors.join("\n"));
    }
    return result;
  };
  let lane: Promise<void> = Promise.resolve();
  const pool = new WorkerPool({ workers: options.workers, concurrency: options.concurrency, memoryLimit: configuration.memoryLimit });
  const serialize = async <T>(action: () => Promise<T>): Promise<T> => {
    const previous = lane;
    let release: () => void = () => {};
    lane = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  };
  const contextFor = (agent: string, target: string): Checkout => {
    const ids = new Set([target, fixture.specId, fixture.sourceId]);
    for (const id of ids) for (const edge of fixture.dependencies) if (edge.consumer === id) ids.add(edge.provider);
    for (const work of kernel.pending()) if (work.consumer === target) ids.add(work.provider);
    return kernel.checkout(agent, [...ids]);
  };
  const snapshot = async () => {
    await writeFile(join(options.outputDirectory, "calls.json"), JSON.stringify(calls, null, 2) + "\n");
    await writeFile(join(options.outputDirectory, "kernel-state.json"), JSON.stringify(kernel.exportState(), null, 2) + "\n");
    await writeFile(join(options.outputDirectory, "individuals.json"), JSON.stringify(pool.stats(), null, 2) + "\n");
  };
  const recordFailure = (target: string, messages: string[]): void => {
    errors.set(target, messages);
    if (!claims.has(target)) claims.set(target, kernel.openClaim(target, messages.join("\n").slice(0, 3000)));
  };
  const resolve = (target: string, context: string, validation: string): void => {
    const claim = claims.get(target);
    if (claim) { kernel.resolveClaim(claim, context, validation); claims.delete(target); }
    errors.delete(target); successful.add(target);
    const artifact = kernel.artifact(target);
    verifiedStates.set(target, { version: artifact.version, evidenceEpoch: artifact.evidenceEpoch });
  };

  const invoke = async (role: "worker" | "meta", agent: string, target: string, context: Checkout, prompt: string): Promise<{ response: Response; record: CallRecord; writes: Record<string, string> }> => {
    const id = `call-${++serial}`;
    const record: CallRecord = {
      id, role, agent, target, model: role === "worker" ? configuration.workerModel : configuration.metaModel,
      context: context.id, contextArtifacts: Object.keys(context.reads), contextBytes: Buffer.byteLength(JSON.stringify(context.contents)),
      startedAt: Date.now(), durationMs: 0, commitWaitMs: 0, outcome: "running", errors: [],
      inputTokens: null, outputTokens: null, effectiveModelEvidence: null, memoryEntries: 0, usageCompleteness: null,
    };
    calls.push(record); kernel.beginWork(id, agent);
    if (role === "worker") { activeModelCalls++; maxConcurrentModelCalls = Math.max(maxConcurrentModelCalls, activeModelCalls); }
    try {
      const response = await model({ model: record.model, prompt, schema: SCHEMA, cwd: workspace,
        timeoutMs: configuration.timeoutMs, outputDirectory: join(options.outputDirectory, "transcripts"),
        ...(configuration.runtime === "docker-agent" ? { maxTokens: configuration.maxTokensPerCall } : {}),
        ...(role === "worker" && configuration.workerTools === "local"
          ? { tools: "local", files: { ...context.contents, "visible.test.mjs": fixture.visibleTest(target) } } : {}) });
      await writeFile(join(options.outputDirectory, `${id}.json`), JSON.stringify(response, null, 2) + "\n");
      record.durationMs = response.transcript.durationMs;
      const inputs = response.usage.map((item) => item.inputTokens).filter((item): item is number => item !== undefined);
      const outputs = response.usage.map((item) => item.outputTokens).filter((item): item is number => item !== undefined);
      record.inputTokens = inputs.length ? inputs.reduce((a, b) => a + b, 0) : null;
      record.outputTokens = outputs.length ? outputs.reduce((a, b) => a + b, 0) : null;
      record.effectiveModelEvidence = response.transcript.effectiveModelEvidence ?? null;
      record.usageCompleteness = (response.transcript as Partial<DockerTranscript>).usageCompleteness ?? null;
      if (!response.result || typeof response.result.content !== "string" || typeof response.result.note !== "string")
        throw new Error("model output did not contain string content and note");
      return { response: response.result, record, writes: role === "worker" && configuration.workerTools === "local"
        ? dockerWorkspaceWrites(response.transcript) : { [target]: response.result.content } };
    } catch (error) {
      record.durationMs = Date.now() - record.startedAt;
      record.outcome = error instanceof CodexWorkerError ? error.code : "model-error";
      record.errors = [String(error)];
      if (error instanceof CodexWorkerError) {
        const usage = error.transcript.usage;
        const inputs = usage.map((item) => item.inputTokens).filter((item): item is number => item !== undefined);
        const outputs = usage.map((item) => item.outputTokens).filter((item): item is number => item !== undefined);
        record.inputTokens = inputs.length ? inputs.reduce((a, b) => a + b, 0) : null;
        record.outputTokens = outputs.length ? outputs.reduce((a, b) => a + b, 0) : null;
        record.effectiveModelEvidence = error.transcript.effectiveModelEvidence;
        record.usageCompleteness = (error.transcript as Partial<DockerTranscript>).usageCompleteness ?? null;
        if (record.usageCompleteness === "partial-or-unknown") unknownModelUsage = true;
        if ((error.transcript as Partial<DockerTranscript>).runtime === "docker-agent" && (error.transcript as Partial<DockerTranscript>).cleanupSucceeded === false)
          runtimeCleanupFailed = true;
        await writeFile(join(options.outputDirectory, `${id}.json`), JSON.stringify({ error: error.code, transcript: error.transcript }, null, 2) + "\n");
      }
      throw error;
    } finally {
      kernel.endWork(id); if (role === "worker") activeModelCalls--;
    }
  };

  const perform = async (agent: string, target: string, memory: readonly WorkerMemory[]): Promise<void> => {
    active++; maxActive = Math.max(maxActive, active);
    attempts.set(target, (attempts.get(target) ?? 0) + 1);
    const work = kernel.pending().filter((item) => item.consumer === target);
    for (const item of work) kernel.seen(item.id, agent);
    const context = contextFor(agent, target);
    const lease = kernel.grant(agent, [target], configuration.timeoutMs * 2 + 60_000);
    let candidateId: string | null = null;
    let note = "";
    try {
      const task = configuration.workerTools === "local"
        ? "The supplied files are materialized in your workspace. Read the local files, run check_local to observe the failure, edit only the target, then run check_local again. Do not modify visible.test.mjs or any dependency. The actual workspace delta is the proposal. Finish by calling __structured_output__ with content as an empty string and note as a short summary. Plain-text JSON is not a completed run; do not duplicate the file body in your final tool arguments."
        : "Return JSON with the complete replacement file as content and a short note. All needed files are provided below; do not use tools or inspect other paths.";
      const { response, record, writes } = await invoke("worker", agent, target, context,
        `You are local code worker ${agent}. Update only ${target} to satisfy the supplied task contract and preserve its requirements. ${task} Record any unresolved issue in note. No manager conversation is part of this task.\n\nLocal files:\n${JSON.stringify(context.contents)}\n\nYour private recent memory (past observations, not current facts; current files and versions take precedence):\n${JSON.stringify(memory)}\n\nCurrent read versions:\n${JSON.stringify(context.reads)}\n\nPrevious local verification errors:\n${JSON.stringify(errors.get(target) ?? [])}`);
      record.memoryEntries = memory.length;
      note = response.note.slice(0, 1200);
      const queuedAt = Date.now();
      await serialize(async () => {
        record.commitWaitMs = Date.now() - queuedAt;
        const candidate = kernel.prepare({ id: record.id, agent, context: context.id, writes,
          lease, obligations: work.map((item) => item.id) });
        candidateId = candidate.id;
        const verdict = await kernel.validate(candidate.id, (contents) => verify(contents, [target]));
        if (!verdict.ok) {
          record.outcome = "rejected"; record.errors = [...verdict.errors]; recordFailure(target, record.errors); return;
        }
        const committed = kernel.commit(candidate.id);
        resolve(target, context.id, committed.validation);
        record.outcome = "committed"; kernel.deliverAll();
      });
    } catch (error) {
      if (candidateId) {
        const candidate = kernel.exportState().candidates.find((item) => item.id === candidateId);
        if (candidate && candidate.state !== "committed") kernel.discard(candidateId, String(error));
      }
      const record = calls.findLast((item) => item.context === context.id);
      if (record && record.outcome === "running") { record.outcome = error instanceof KernelError ? error.code : "worker-error"; record.errors = [String(error)]; }
      if (!(error instanceof KernelError && ["stale-read", "stale-validation", "stale-obligation"].includes(error.code)))
        recordFailure(target, [String(error)]);
    } finally {
      for (const item of kernel.pending()) if (item.consumer === target && item.state === "running" && item.agent === agent)
        kernel.release(item.id, agent);
      const record = calls.findLast((item) => item.context === context.id);
      pool.finish(agent, { target, note: note || record?.errors.join("\n").slice(0, 1200) || "No model result",
        outcome: record?.outcome ?? "worker-error", reads: context.reads });
      active--;
    }
  };

  const intervene = async (): Promise<boolean> => {
    upperCalls++;
    // Failure records are immutable observations, not dependencies on future worker edits.
    const context = kernel.checkout("meta", [fixture.specId, fixture.sourceId]);
    const lease = kernel.grant("meta", [fixture.specId], configuration.timeoutMs * 2 + 60_000, "meta");
    let candidateId: string | null = null;
    try {
      const observations = calls.filter((item) => item.role === "worker" && item.outcome === "rejected" && errors.has(item.target)).slice(-6)
        .map((item) => ({ call: item.id, context: item.context, target: item.target, outcome: item.outcome, errors: item.errors.slice(0, 3) }));
      const { response, record } = await invoke("meta", "meta", fixture.specId, context,
        `You are observing an artifact-local worker swarm. Workers did not request consultation. Inspect the failures and shared guidance. If the guidance contradicts the library and fixed acceptance evidence, repair the guidance so workers can continue. Do not implement worker files or alter acceptance criteria. Return JSON with complete replacement ${fixture.specId} as content and a short rationale as note. Preserve requirements supported by the evidence. All context is supplied; do not use tools.\n\nObserved failures:\n${JSON.stringify(observations)}\n\nRelevant files:\n${JSON.stringify(context.contents)}`);
      return await serialize(async () => {
        const candidate = kernel.prepare({ id: record.id, agent: "meta", context: context.id,
          writes: { [fixture.specId]: response.content }, lease, kind: "intervention", reason: response.note });
        candidateId = candidate.id;
        const verdict = await kernel.validate(candidate.id, (contents) => ({ ok: contents[fixture.specId]!.trim().length > 0, errors: [] }));
        if (!verdict.ok) { record.outcome = "rejected"; return false; }
        const committed = kernel.commit(candidate.id);
        record.outcome = "committed"; kernel.deliverAll();
        if (committed.events.length) { interventions++; attempts.clear(); return true; }
        return false;
      });
    } catch (error) {
      if (candidateId && kernel.exportState().candidates.find((candidate) => candidate.id === candidateId)?.state !== "committed")
        kernel.discard(candidateId, String(error));
      const record = calls.findLast((item) => item.context === context.id);
      if (record) { record.outcome = "meta-error"; record.errors = [String(error)]; }
      return false;
    }
  };

  // The immutable API is checked by the fixed oracle; no model rewrites it.
  const verifyPinnedSource = async () => {
    const work = kernel.pending().filter((item) => item.consumer === fixture.sourceId);
    if (!work.length) return;
    const context = contextFor("source-verifier", fixture.sourceId);
    const lease = kernel.grant("source-verifier", [fixture.sourceId]);
    const candidate = kernel.prepare({ id: `source-check-${++serial}`, agent: "source-verifier", context: context.id,
      writes: {}, lease, obligations: work.map((item) => item.id) });
    const verdict = await kernel.validate(candidate.id, (contents) => verify(contents, [fixture.sourceId]));
    if (verdict.ok) kernel.commit(candidate.id);
  };

  let final: Verdict = { ok: false, errors: ["not-run"] };
  try {
    while (rounds < configuration.maxRounds && calls.filter((item) => item.role === "worker").length < configuration.maxCalls) {
      rounds++; kernel.deliverAll(); await verifyPinnedSource();
      const pending = kernel.pending();
      if (!pending.length) break;
      const targets = [...new Set(pending.map((item) => item.consumer))].filter((id) => fixture.writableIds.includes(id));
      const available = targets.filter((id) => (attempts.get(id) ?? 0) < 3 && !fixture.dependencies.some((edge) =>
        edge.consumer === id && edge.provider !== id && targets.includes(edge.provider)));
      const remaining = configuration.maxCalls - calls.filter((item) => item.role === "worker").length;
      const wave = pool.assign(available.slice(0, Math.min(configuration.concurrency, remaining)).map((target) => ({
        target, neighbors: fixture.dependencies.filter((edge) => edge.consumer === target).map((edge) => edge.provider),
      })));
      const results = await Promise.allSettled(wave.map((assignment) => perform(assignment.workerId, assignment.target, assignment.memory)));
      const unexpected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (unexpected.length) throw new AggregateError(unexpected.map((result) => result.reason), "worker scheduler failed");
      // Already dispatched concurrent calls finish and clean up; admit no further spend.
      if (unknownModelUsage || verificationUnavailable || runtimeCleanupFailed) break;
      // Transport failures provide no evidence that shared semantic guidance needs changing.
      const semanticFailures = calls.filter((item) => item.role === "worker" && item.outcome === "rejected");
      const failureCount = semanticFailures.length;
      const unresolvedSemanticFailure = semanticFailures.some((item) => errors.has(item.target));
      if (configuration.maxMetaCalls > upperCalls && unresolvedSemanticFailure && (failureCount - lastMetaFailureCount >= 2 || !wave.length)) {
        lastMetaFailureCount = failureCount;
        await intervene();
      } else if (!wave.length) break;
      await snapshot();
      if (unknownModelUsage || runtimeCleanupFailed) break;
    }
    kernel.deliverAll(); await verifyPinnedSource();
    final = await kernel.complete((contents) => verify(contents));
  } catch (error) {
    final = { ok: false, errors: [`execution-error: ${String(error)}`] };
  } finally { await snapshot(); }
  if (runtimeCleanupFailed) final = { ok: false, errors: [...final.errors, "sandbox-cleanup-failed"] };
  const report: SwarmReport = {
    task: taskId,
    format: 2, startedAt: new Date(start).toISOString(), durationMs: Date.now() - start, configuration,
    success: final.ok, finalErrors: final.errors, maxActiveWorkers: maxActive, registeredWorkers: pool.stats().length,
    completedArtifacts: [...verifiedStates].filter(([id, value]) => {
      const current = kernel.artifact(id);
      return current.version === value.version && current.evidenceEpoch === value.evidenceEpoch
        && !kernel.pending().some((work) => work.consumer === id);
    }).length, writableArtifacts: fixture.writableIds.length,
    everCommittedArtifacts: successful.size, maxConcurrentModelCalls, individuals: pool.stats(),
    lowerCalls: calls.filter((item) => item.role === "worker").length, upperCalls, interventions, rounds, calls,
    limitations: ["Synthetic known-dependency fixture; not evidence for general repository work or discovery.",
      "Commit verification is serialized; model calls can overlap. No crash recovery before M4.",
      "Token counts are observed CLI usage. Currency cost is not inferred.",
      "Requested model is recorded separately from any model identity emitted by the CLI.",
      "Each individual keeps bounded private notes and read versions; affinity scheduling is a host rule, not proof of emergent semantic roles."],
  };
  await writeFile(join(options.outputDirectory, "result.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(options.outputDirectory, "artifacts.json"), JSON.stringify(kernel.contents(), null, 2) + "\n");
  return report;
}
