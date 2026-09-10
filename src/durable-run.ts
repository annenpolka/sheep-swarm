import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { callCodex, CodexWorkerError } from "./codex-worker.ts";
import type { CodexCallOptions, CodexCallResult, CodexUsage } from "./codex-worker.ts";
import { createFixture } from "./fixture.ts";
import { SwarmKernel, KernelError } from "./kernel.ts";
import type { Checkout, KernelState, Verdict } from "./kernel.ts";
import { SqliteJournal } from "./journal.ts";

export type DurableCheckpoint = "initialized" | "before-call" | "after-call" | "after-seen"
  | "before-commit" | "after-commit" | "before-delivery" | "after-delivery"
  | "before-intervention" | "after-intervention" | "completed";
export interface DurableOptions {
  directory: string; resume?: boolean; size?: number; workers?: number; maxCalls?: number; maxMetaCalls?: number;
  timeoutMs?: number; fault?: "none" | "rounded-guidance";
  checkpoint?: (name: DurableCheckpoint, details: Record<string, unknown>) => Promise<void>;
}
interface ModelResponse { content: string; note: string }
export type DurableModelCaller = (options: CodexCallOptions) => Promise<CodexCallResult<ModelResponse>>;
interface DurableConfiguration {
  size: number; workers: number; concurrency: 1; maxCalls: number; maxMetaCalls: number; timeoutMs: number;
  fault: "none" | "rounded-guidance"; workerModel: "gpt-5.6-luna"; metaModel: "gpt-6-astra";
}
export interface DurableCall {
  id: string; role: "worker" | "meta"; agent: string; target: string; model: string; context: string;
  contextArtifacts: string[]; contextBytes: number; specVersion: number;
  status: "reserved" | "responded" | "committed" | "rejected" | "error" | "unknown" | "abandoned";
  startedAt: number; endedAt: number | null; inputTokens: number | null; outputTokens: number | null;
  response: ModelResponse | null; errors: string[]; effectiveModelEvidence: string | null;
}
interface Individual {
  id: string; calls: number;
  memory: { callId: string; target: string; outcome: string; note: string; reads: Checkout["reads"] }[];
}
interface DurableApplication {
  kind: "sheep-durable-fixture"; format: 1; configuration: DurableConfiguration; startedAt: number;
  calls: DurableCall[]; individuals: Individual[]; nextCall: number; nextHost: number;
  lastMetaFailureCount: number; resumes: number;
  lastResult: { success: boolean; finalErrors: string[]; finishedAt: number } | null;
}
export interface DurableReport {
  format: 1; directory: string; success: boolean; finalErrors: readonly string[]; configuration: DurableConfiguration;
  generation: number; lowerCalls: number; upperCalls: number; unknownCalls: number; usageUnknownCalls: number;
  observedInputTokens: number; observedOutputTokens: number; interventions: number; resumes: number;
  calls: DurableCall[]; individuals: Individual[]; limitations: string[];
}

const responseSchema = { type: "object", properties: { content: { type: "string" }, note: { type: "string" } },
  required: ["content", "note"], additionalProperties: false };
const cloned = <T>(value: T): T => structuredClone(value);

function configuration(options: Omit<DurableOptions, "directory">): DurableConfiguration {
  const value: DurableConfiguration = {
    size: options.size ?? 4, workers: options.workers ?? 4, concurrency: 1,
    maxCalls: options.maxCalls ?? (options.size ?? 4) * 6, maxMetaCalls: options.maxMetaCalls ?? 2,
    timeoutMs: options.timeoutMs ?? 120_000, fault: options.fault ?? "none",
    workerModel: "gpt-5.6-luna", metaModel: "gpt-6-astra",
  };
  for (const number of [value.size, value.workers, value.maxCalls, value.timeoutMs])
    if (!Number.isSafeInteger(number) || number < 1) throw new RangeError("durable limits must be positive safe integers");
  if (!Number.isSafeInteger(value.maxMetaCalls) || value.maxMetaCalls < 0) throw new RangeError("invalid meta budget");
  if (value.fault !== "none" && value.fault !== "rounded-guidance") throw new Error("invalid durable fault");
  createFixture({ size: value.size });
  return value;
}

function readApplication(state: KernelState): DurableApplication {
  const raw = state.application;
  if (!raw || raw.kind !== "sheep-durable-fixture" || raw.format !== 1 || !Array.isArray(raw.calls)
    || !Array.isArray(raw.individuals) || typeof raw.configuration !== "object" || raw.configuration === null)
    throw new Error("invalid durable application state");
  const value = cloned(raw) as unknown as DurableApplication;
  const config = value.configuration;
  const checked = configuration(config);
  if (JSON.stringify(checked) !== JSON.stringify(config)) throw new Error("durable configuration or model identity changed");
  for (const counter of [value.nextCall, value.nextHost, value.lastMetaFailureCount, value.resumes])
    if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("invalid durable counter");
  if (!Number.isFinite(value.startedAt) || value.individuals.length !== config.workers
    || new Set(value.individuals.map((individual) => individual.id)).size !== config.workers)
    throw new Error("invalid persisted individuals");
  const callIds = new Set<string>();
  for (const call of value.calls) {
    if (!call || typeof call.id !== "string" || callIds.has(call.id) || !["worker", "meta"].includes(call.role)
      || call.model !== (call.role === "worker" ? config.workerModel : config.metaModel)
      || !["reserved", "responded", "committed", "rejected", "error", "unknown", "abandoned"].includes(call.status))
      throw new Error("invalid persisted call reservation");
    callIds.add(call.id);
  }
  if (value.nextCall < value.calls.length) throw new Error("durable call counter regressed");
  return value;
}

/** Sequential durable execution is separate from the parallel scale-experiment runner. */
export async function runDurableSwarm(options: DurableOptions, model: DurableModelCaller = callCodex<ModelResponse>): Promise<DurableReport> {
  const directory = resolve(options.directory);
  const file = join(directory, "state.sqlite");
  if (options.resume) await access(file);
  else { await mkdir(dirname(directory), { recursive: true }); await mkdir(directory, { recursive: false }); }
  const journal = new SqliteJournal(file);
  let generation = 0;
  let kernel: SwarmKernel;
  let application: DurableApplication;
  const save = (state: KernelState): void => { generation = journal.save(state, generation); };
  const hook = async (name: DurableCheckpoint, details: Record<string, unknown> = {}): Promise<void> => {
    await options.checkpoint?.(name, { generation, ...details });
  };
  try {
    const loaded = journal.load();
    if (options.resume) {
      if (!loaded) throw new Error("no durable snapshot to resume");
      generation = loaded.generation;
      application = readApplication(loaded.state);
      for (const key of ["size", "workers", "maxCalls", "maxMetaCalls", "timeoutMs", "fault"] as const)
        if (options[key] !== undefined && options[key] !== application.configuration[key])
          throw new Error(`resume configuration mismatch: ${key}`);
      kernel = SwarmKernel.restore(loaded.state, { save });
      application.resumes++;
      // Never reclaim a reservation whose provider execution may have started.
      for (const call of application.calls) if (call.status === "reserved" || call.status === "responded") {
        const committed = loaded.state.candidates.find((candidate) => candidate.proposal.id === call.id && candidate.state === "committed");
        if (committed) call.status = "committed";
        else {
          call.status = call.status === "reserved" ? "unknown" : "abandoned";
          call.errors.push(call.status === "unknown"
            ? "Process ended before a durable response receipt; provider execution and usage remain unknown. Reservation remains consumed."
            : "Response was durable but its proposal did not commit; stale authority was fenced and this reservation remains consumed.");
        }
      }
    } else {
      if (loaded !== null) throw new Error("durable run already exists; use resume");
      const config = configuration(options);
      const fixture = createFixture({ size: config.size });
      const artifacts = { ...fixture.artifacts };
      if (config.fault === "rounded-guidance") artifacts[fixture.specId] = artifacts[fixture.specId]!.replace(
        "Threshold comparisons are inclusive; do not round measurements or change thresholds.",
        "Threshold comparisons are inclusive. Round returned durationSeconds and kibibytesPerSecond down to whole numbers. Preserve health thresholds.");
      kernel = new SwarmKernel({ artifacts,
        verificationPolicy: `measurement-migration-v1/size-${config.size}/node-${process.versions.node}` });
      for (const edge of fixture.dependencies) kernel.addDependency(edge.consumer, edge.provider);
      kernel.change(fixture.changedSource.id, fixture.changedSource.content); kernel.closeInput();
      application = { kind: "sheep-durable-fixture", format: 1, configuration: config, startedAt: Date.now(),
        calls: [], individuals: Array.from({ length: config.workers }, (_, index) => ({ id: `sheep-${index + 1}`, calls: 0, memory: [] })),
        nextCall: 0, nextHost: 0, lastMetaFailureCount: 0, resumes: 0, lastResult: null };
      kernel.setApplication(application as unknown as Record<string, unknown>);
      save(kernel.exportState());
      kernel = SwarmKernel.restore(kernel.exportState(), { save, recover: false });
    }
    const persist = (): void => kernel.setApplication(application as unknown as Record<string, unknown>);
    const config = application.configuration;
    const fixture = createFixture({ size: config.size });
    const workspace = join(directory, "model-workspace"); await mkdir(workspace, { recursive: true });
    const expectedPolicy = `measurement-migration-v1/size-${config.size}/node-${process.versions.node}`;
    if (kernel.exportState().verificationPolicy !== expectedPolicy)
      throw new Error("resume verifier environment changed; start a separately assessed run");

    const remember = (call: DurableCall): void => {
      const individual = application.individuals.find((item) => item.id === call.agent);
      if (!individual || individual.memory.some((item) => item.callId === call.id)) return;
      const context = kernel.exportState().contexts.find((item) => item.id === call.context);
      individual.memory.push({ callId: call.id, target: call.target, outcome: call.status,
        note: (call.response?.note ?? call.errors.join("\n")).slice(0, 1200), reads: context?.reads ?? {} });
      individual.memory = individual.memory.slice(-4);
    };
    for (const call of application.calls) if (call.status !== "reserved" && call.status !== "responded") remember(call);
    persist(); await hook("initialized", { resumed: Boolean(options.resume) });

    const deliver = async (): Promise<void> => {
      await hook("before-delivery"); kernel.deliverAll(); await hook("after-delivery");
    };
    const contextFor = (agent: string, target: string): Checkout => {
      const ids = new Set([target, fixture.specId, fixture.sourceId]);
      for (const id of ids) for (const edge of fixture.dependencies) if (edge.consumer === id) ids.add(edge.provider);
      for (const work of kernel.pending()) if (work.consumer === target) ids.add(work.provider);
      return kernel.checkout(agent, [...ids]);
    };
    const count = (role: DurableCall["role"]): number => application.calls.filter((call) => call.role === role).length;
    // The upper model edits semantics; transport errors and unknown calls are not evidence that the specification is wrong.
    const failures = (): DurableCall[] => application.calls.filter((call) => call.role === "worker" && call.status === "rejected");
    const tokens = (usage: readonly CodexUsage[], field: "inputTokens" | "outputTokens"): number | null => {
      const values = usage.map((item) => item[field]).filter((value): value is number => value !== undefined);
      return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    };
    const invoke = async (role: DurableCall["role"], agent: string, target: string, context: Checkout): Promise<DurableCall> => {
      if (count(role) >= (role === "worker" ? config.maxCalls : config.maxMetaCalls)) throw new Error("durable call budget exhausted");
      const call: DurableCall = { id: `call-${++application.nextCall}`, role, agent, target,
        model: role === "worker" ? config.workerModel : config.metaModel, context: context.id,
        contextArtifacts: Object.keys(context.reads), contextBytes: Buffer.byteLength(JSON.stringify(context.contents)),
        specVersion: kernel.artifact(fixture.specId).version, status: "reserved", startedAt: Date.now(), endedAt: null,
        inputTokens: null, outputTokens: null, response: null, errors: [], effectiveModelEvidence: null };
      application.calls.push(call);
      const individual = application.individuals.find((item) => item.id === agent);
      if (individual) individual.calls++;
      kernel.beginWork(call.id, agent); persist();
      await hook("before-call", { role, target, callId: call.id });
      try {
        const response = await model({ model: call.model, schema: responseSchema, cwd: workspace,
          timeoutMs: config.timeoutMs, outputDirectory: join(directory, "transcripts", call.id),
          prompt: JSON.stringify({ role, target, context, observations: failures().slice(-6).map((item) => ({
            target: item.target, status: item.status, errors: item.errors.slice(0, 3), callId: item.id })),
          privateMemory: individual?.memory ?? [],
          instructions: role === "worker"
            ? "Update only target using the supplied local files and migration contract. Preserve physical health thresholds. Return complete replacement content and a short note. No tools or manager consultation. Current read versions override private past notes."
            : "Observe these recorded failures; workers did not request consultation. Clarify the shared specification so workers can satisfy the fixed acceptance evidence and library. Return complete replacement specification content and a rationale. Preserve supported requirements; do not implement worker files or weaken acceptance. No tools." }) });
        // This transcript is an external evidence file, not the authoritative transaction receipt.
        // A crash before persist() below leaves the reservation unknown even if this file exists.
        await writeFile(join(directory, `${call.id}.json`), JSON.stringify(response, null, 2) + "\n");
        call.inputTokens = tokens(response.usage, "inputTokens"); call.outputTokens = tokens(response.usage, "outputTokens");
        call.effectiveModelEvidence = response.transcript.effectiveModelEvidence ?? null;
        if (response.requestedModel !== call.model || !response.result || typeof response.result.content !== "string"
          || typeof response.result.note !== "string") throw new Error("invalid durable model response");
        call.response = cloned(response.result); call.status = "responded";
      } catch (error) {
        call.status = "error"; call.errors = [String(error)];
        if (error instanceof CodexWorkerError) {
          call.inputTokens = tokens(error.transcript.usage, "inputTokens"); call.outputTokens = tokens(error.transcript.usage, "outputTokens");
          call.effectiveModelEvidence = error.transcript.effectiveModelEvidence ?? null;
          await writeFile(join(directory, `${call.id}.json`), JSON.stringify({ error: error.code, transcript: error.transcript }, null, 2) + "\n");
        }
      }
      call.endedAt = Date.now(); persist(); kernel.endWork(call.id);
      await hook("after-call", { role, target, callId: call.id });
      return call;
    };

    const recordFailure = (target: string, errors: readonly string[]): void => {
      if (!kernel.exportState().claims.some((claim) => claim.subject === target && claim.open && claim.blocking))
        kernel.openClaim(target, errors.join("\n").slice(0, 3000) || "unresolved model work");
    };
    const resolveClaims = (target: string, context: string, evidence: string): void => {
      for (const claim of kernel.exportState().claims.filter((item) => item.subject === target && item.open))
        kernel.resolveClaim(claim.id, context, evidence);
    };
    const perform = async (target: string, meta: boolean): Promise<void> => {
      const individual = [...application.individuals].sort((a, b) => a.calls - b.calls || a.id.localeCompare(b.id))[0]!;
      const agent = meta ? "meta" : individual.id;
      const obligations = meta ? [] : kernel.pending().filter((work) => work.consumer === target);
      for (const work of obligations) kernel.seen(work.id, agent);
      if (!meta) await hook("after-seen", { role: "worker", target });
      const context = meta ? kernel.checkout(agent, [fixture.specId, fixture.sourceId]) : contextFor(agent, target);
      const lease = kernel.grant(agent, [target], config.timeoutMs * 2 + 60_000, meta ? "meta" : "worker");
      const call = await invoke(meta ? "meta" : "worker", agent, target, context);
      let candidateId: string | null = null;
      try {
        if (!call.response) { recordFailure(target, call.errors); return; }
        const candidate = kernel.prepare({ id: call.id, agent, context: context.id, writes: { [target]: call.response.content }, lease,
          obligations: obligations.map((work) => work.id), kind: meta ? "intervention" : "work", reason: call.response.note });
        candidateId = candidate.id;
        const verdict = await kernel.validate(candidate.id, meta
          ? (contents) => ({ ok: contents[target]!.trim().length > 0, errors: [] })
          : (contents) => fixture.verify(contents, [target]));
        if (!verdict.ok) {
          call.status = "rejected"; call.errors = [...verdict.errors]; recordFailure(target, call.errors); return;
        }
        await hook(meta ? "before-intervention" : "before-commit", { role: call.role, target, callId: call.id, candidate: candidate.id });
        const committed = kernel.commit(candidate.id);
        await hook(meta ? "after-intervention" : "after-commit", { role: call.role, target, callId: call.id, candidate: candidate.id });
        call.status = "committed"; resolveClaims(target, context.id, committed.validation);
      } catch (error) {
        if (error instanceof KernelError && error.code === "persistence-failed") throw error;
        if (candidateId) {
          const candidate = kernel.exportState().candidates.find((item) => item.id === candidateId);
          if (candidate && candidate.state !== "committed") kernel.discard(candidateId, String(error));
        }
        call.status = "error"; call.errors = [String(error)]; recordFailure(target, call.errors);
      } finally {
        for (const work of kernel.pending()) if (work.consumer === target && work.state === "running" && work.agent === agent)
          kernel.release(work.id, agent);
        remember(call); persist();
      }
    };

    const hostChecks = async (): Promise<void> => {
      const targets = new Set(kernel.pending().filter((work) => work.consumer === fixture.sourceId).map((work) => work.consumer));
      for (const claim of kernel.exportState().claims) if (claim.open && !kernel.pending().some((work) => work.consumer === claim.subject))
        targets.add(claim.subject);
      for (const target of targets) {
        const context = contextFor("host-verifier", target);
        const lease = kernel.grant("host-verifier", [target]);
        const id = `host-${++application.nextHost}`; persist();
        const candidate = kernel.prepare({ id, agent: "host-verifier", context: context.id, writes: {}, lease,
          obligations: kernel.pending().filter((work) => work.consumer === target).map((work) => work.id) });
        const verdict = await kernel.validate(candidate.id, (contents) => fixture.verify(contents, [target]));
        if (verdict.ok) { const result = kernel.commit(candidate.id); resolveClaims(target, context.id, result.validation); }
      }
    };
    await deliver();
    for (;;) {
      await hostChecks();
      const pendingTargets = [...new Set(kernel.pending().map((work) => work.consumer))].filter((id) => fixture.writableIds.includes(id));
      if (pendingTargets.length === 0) break;
      const specVersion = kernel.artifact(fixture.specId).version;
      const available = pendingTargets.filter((target) => !fixture.dependencies.some((edge) => edge.consumer === target
        && edge.provider !== target && pendingTargets.includes(edge.provider))
        && application.calls.filter((call) => call.role === "worker" && call.target === target && call.specVersion === specVersion).length < 3);
      const needsMeta = failures().length - application.lastMetaFailureCount >= 2 || available.length === 0;
      if (needsMeta && count("meta") < config.maxMetaCalls && failures().length > 0) {
        application.lastMetaFailureCount = failures().length; persist(); await perform(fixture.specId, true);
      } else if (available.length && count("worker") < config.maxCalls) await perform(available[0]!, false);
      else break;
      await deliver();
    }
    await deliver(); await hostChecks();
    const final: Verdict = await kernel.complete((contents) => fixture.verify(contents));
    application.lastResult = { success: final.ok, finalErrors: [...final.errors], finishedAt: Date.now() }; persist();
    const report: DurableReport = {
      format: 1, directory, success: final.ok, finalErrors: final.errors, configuration: config, generation,
      lowerCalls: count("worker"), upperCalls: count("meta"), unknownCalls: application.calls.filter((call) => call.status === "unknown").length,
      usageUnknownCalls: application.calls.filter((call) => call.inputTokens === null || call.outputTokens === null).length,
      observedInputTokens: application.calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
      observedOutputTokens: application.calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
      interventions: kernel.trace().filter((entry) => entry.type === "intervention").length, resumes: application.resumes,
      calls: cloned(application.calls), individuals: cloned(application.individuals),
      limitations: ["This durable fixture runner uses C=1; it does not make the separate parallel scale runner resumable.",
        "Unknown or abandoned provider calls retain consumed call-budget reservations; reported tokens are observed lower bounds when usage is unknown.",
        "A killed parent may leave a provider process running; unknown execution is not treated as free or safely cancelled.",
        "Durability relies on SQLite WAL/FULL and the host filesystem. This is a synthetic known-dependency fixture, not arbitrary repository recovery."],
    };
    await writeFile(join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n");
    await writeFile(join(directory, "artifacts.json"), JSON.stringify(kernel.contents(), null, 2) + "\n");
    await hook("completed", { success: report.success });
    return report;
  } finally { journal.close(); }
}
