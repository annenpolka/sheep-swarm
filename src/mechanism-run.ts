import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { callCodex, CodexWorkerError, type CodexCallOptions, type CodexCallResult } from "./codex-worker.ts";
import { CreditBudget } from "./credit-budget.ts";
import { parseRateCard, type RateCard } from "./cost-estimate.ts";
import { createMechanismFixture } from "./mechanism-fixture.ts";
import { KernelError, SwarmKernel, type Checkout, type Contents } from "./kernel.ts";
import { WorkerPool, type WorkerAssignment } from "./worker-pool.ts";

export const MECHANISM_METHODS = ["sheep", "single-luna", "single-astra", "no-memory", "no-upper"] as const;
export type MechanismMethod = typeof MECHANISM_METHODS[number];
export type MechanismFamily = "static" | "semantic" | "staged";
export interface MechanismResponse { writes: { id: string; content: string }[]; readRequests: string[]; note: string }
export type MechanismCaller = (options: CodexCallOptions) => Promise<CodexCallResult<MechanismResponse>>;
export interface MechanismOptions {
  method?: MechanismMethod; family: MechanismFamily; groups?: number; workers?: number; concurrency?: number;
  outputDirectory: string; rateCard?: RateCard; maxCredits?: number; lunaReservation?: number; astraReservation?: number;
  maxCalls?: number; timeoutMs?: number; maxAttempts?: number; maxReadCalls?: number; maxMetaCalls?: number;
}
export interface MechanismCall {
  id: string; stage: number; agent: string; role: "worker" | "single" | "meta"; target: string | null; model: string;
  outcome: string; errors: string[]; durationMs: number; contextArtifacts: string[]; contextBytes: number;
  memoryEntries: number; readRequests: string[]; writtenIds: string[]; effectiveModelEvidence: string | null;
  credits: number | null; reservationOverrun: boolean;
}
export type MechanismTermination = "completed" | "credit-admission-limit" | "call-limit" | "attempt-limit"
  | "final-quality-failed" | "protocol-incomplete" | "budget-unknown" | "budget-exceeded"
  | "context-boundary" | "scheduler-stalled" | "execution-error";
export interface MechanismStage {
  terminationReason: MechanismTermination;
  stage: number; success: boolean; qualityPass: boolean; protocolClean: boolean; errors: readonly string[];
  calls: number; lowerCalls: number; upperCalls: number; readCalls: number; interventions: number;
  patchAttempts: Record<string, number>; readAttempts: Record<string, number>; elapsedMs: number;
}
const schema = { type: "object", additionalProperties: false, required: ["writes", "readRequests", "note"], properties: {
  writes: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "content"],
    properties: { id: { type: "string" }, content: { type: "string" } } } },
  readRequests: { type: "array", items: { type: "string" } }, note: { type: "string" },
} };
function response(value: unknown): MechanismResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response must be an object");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "note,readRequests,writes" || typeof row.note !== "string"
    || !Array.isArray(row.readRequests) || !row.readRequests.every(id => typeof id === "string" && id.length)
    || !Array.isArray(row.writes) || !row.writes.every(write => write && typeof write === "object"
      && Object.keys(write).sort().join(",") === "content,id" && typeof write.id === "string" && write.id.length && typeof write.content === "string")) {
    throw new Error("response does not satisfy writes/readRequests/note schema");
  }
  const parsed = row as unknown as MechanismResponse;
  if (new Set(parsed.writes.map(write => write.id)).size !== parsed.writes.length
    || new Set(parsed.readRequests).size !== parsed.readRequests.length) throw new Error("duplicate write or read request");
  if (parsed.writes.length && parsed.readRequests.length) throw new Error("request reads before proposing writes, in a separate call");
  return parsed;
}
function toolEvents(receipt: unknown): string[] {
  const events = (receipt as { transcript?: { events?: unknown[] } } | null)?.transcript?.events;
  if (!Array.isArray(events)) return [];
  const violations: string[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : null;
    for (const kind of [event.type, item?.type]) if (typeof kind === "string" && /tool|command_execution|file_change|function_call|web_search|computer_call|image_generation|shell/i.test(kind)) violations.push(kind);
    if (item && typeof item.type === "string" && !["agent_message", "reasoning", "todo_list", "plan", "error"].includes(item.type)
      && !violations.includes(item.type)) violations.push(`unrecognized-item:${item.type}`);
  }
  return [...new Set(violations)];
}

/** Public artifact mechanism pilot. The final oracle is a barrier, never model feedback. */
export async function runMechanism(options: MechanismOptions, caller: MechanismCaller = callCodex<MechanismResponse>) {
  const method = options.method ?? "sheep";
  if (!MECHANISM_METHODS.includes(method)) throw new Error("unknown mechanism method");
  if (!["static", "semantic", "staged"].includes(options.family)) throw new Error("unknown mechanism family");
  const single = method === "single-luna" || method === "single-astra";
  const configuration = { method, family: options.family, groups: options.groups ?? 8,
    workers: single ? 1 : options.workers ?? 16, concurrency: single ? 1 : options.concurrency ?? 8,
    maxCredits: options.maxCredits ?? 30, lunaReservation: options.lunaReservation ?? 0.25,
    astraReservation: options.astraReservation ?? 15, maxCalls: options.maxCalls ?? 400,
    timeoutMs: options.timeoutMs ?? 90_000, maxAttempts: options.maxAttempts ?? 3, maxReadCalls: options.maxReadCalls ?? 2,
    maxMetaCalls: options.maxMetaCalls ?? 3, workerModel: "gpt-5.6-luna", metaModel: "gpt-6-astra",
    memoryLimit: method === "no-memory" ? 0 : 4 };
  for (const key of ["groups", "workers", "concurrency", "maxCalls", "timeoutMs", "maxAttempts"] as const)
    if (!Number.isSafeInteger(configuration[key]) || configuration[key] < 1) throw new RangeError(`${key} must be positive`);
  for (const key of ["maxReadCalls", "maxMetaCalls"] as const)
    if (!Number.isSafeInteger(configuration[key]) || configuration[key] < 0) throw new RangeError(`${key} must be nonnegative`);
  if (configuration.concurrency > configuration.workers) throw new RangeError("concurrency exceeds workers");
  const rateCard = options.rateCard ?? parseRateCard(JSON.parse(await readFile(new URL("../pricing/openai-2026-09-10.json", import.meta.url), "utf8")));
  const budget = new CreditBudget({ maxCredits: configuration.maxCredits, rateCard,
    reservations: { "gpt-5.6-luna": configuration.lunaReservation, "gpt-6-astra": configuration.astraReservation } });
  const fixture = createMechanismFixture({ family: configuration.family, groups: configuration.groups });
  const catalogIds = new Set(fixture.catalog.map(item => item.id));
  const writable = new Set(fixture.writableIds);
  const learned = new Map(fixture.initialDependencies.map(edge => [`${edge.consumer}\0${edge.provider}`, edge]));
  const selectedReads = new Map<string, Set<string>>();
  const pool = new WorkerPool({ workers: configuration.workers, concurrency: configuration.concurrency, memoryLimit: configuration.memoryLimit });
  const calls: MechanismCall[] = [], stages: MechanismStage[] = [], boundaryViolations: { callId: string; events: string[] }[] = [];
  const discovery: { stage: number; callId: string; target: string; provider: string }[] = [];
  const controller = new AbortController();
  const singleMemory: { stage: number; note: string; outcome: string }[] = [];
  let serial = 0, active = 0, maxActiveModelCalls = 0, interventions = 0;
  const started = performance.now();
  let contents: Contents = fixture.artifacts;
  let kernel: SwarmKernel | null = null;
  const fatalErrors: string[] = [];
  await mkdir(dirname(options.outputDirectory), { recursive: true });
  await mkdir(options.outputDirectory);
  const workspace = join(options.outputDirectory, "model-workspace"); await mkdir(workspace);
  const fingerprint = createHash("sha256").update(JSON.stringify({ task: fixture.task, family: fixture.family,
    groups: configuration.groups, artifacts: fixture.artifacts, stages: fixture.stageCount })).digest("hex");
  const budgetOkay = () => { const current = budget.snapshot(); return !current.exceeded && current.unknownUsageCalls === 0 && boundaryViolations.length === 0; };
  const protocol = (state: SwarmKernel) => {
    const s = state.exportState();
    return s.inputClosed && s.events.every(e => e.delivered) && !state.pending().length
      && !s.claims.some(c => c.open && c.blocking) && !s.activeWork.length && !s.retries.length
      && !s.candidates.some(c => c.state === "prepared" || c.state === "validated");
  };
  try {
    for (let stage = 0; stage < fixture.stageCount; stage++) {
      const stageStart = performance.now(), firstCall = calls.length, firstIntervention = interventions;
      const current = new SwarmKernel({ artifacts: { ...contents }, verificationPolicy: `${fixture.task}/stage-${stage}/node-${process.versions.node}` });
      kernel = current;
      for (const edge of learned.values()) current.addDependency(edge.consumer, edge.provider);
      for (const [id, content] of Object.entries(fixture.changesForStage(stage))) current.change(id, content);
      current.closeInput(); current.deliverAll();
      const claims = new Map(fixture.writableIds.map(id => [id, current.openClaim(id, `Stage ${stage} requires current visible acceptance evidence`)]));
      const attempts = new Map<string, number>(), reads = new Map<string, number>(), failures = new Map<string, string[]>();
      let lastMetaFailure = 0;
      let terminationReason: MechanismTermination | null = null;
      const inspected = new Map<string, string>();
      let lane: Promise<void> = Promise.resolve();
      const serialize = async <T>(fn: () => Promise<T>): Promise<T> => {
        const previous = lane; let release = () => {};
        lane = new Promise<void>(resolve => { release = resolve; });
        await previous; try { return await fn(); } finally { release(); }
      };
      const targets = () => [...new Set([...claims.keys(), ...current.pending().map(item => item.consumer)])].filter(id => writable.has(id));
      const contextFor = (agent: string, target: string | null, full = false): Checkout => {
        const ids = new Set(full ? Object.keys(current.contents()) : [fixture.specId, fixture.guidanceId, ...(target ? [target] : [])]);
        if (target) {
          for (const provider of selectedReads.get(target) ?? []) ids.add(provider);
          for (const work of current.pending()) if (work.consumer === target) ids.add(work.provider);
          for (const id of ids) for (const edge of learned.values()) if (edge.consumer === id) ids.add(edge.provider);
        }
        return current.checkout(agent, [...ids]);
      };
      const resolveClaim = (id: string, context: string, validation: string) => {
        const claim = claims.get(id); if (claim) { current.resolveClaim(claim, context, validation); claims.delete(id); }
        failures.delete(id);
      };
      const discard = (id: string | null, reason: string) => {
        if (id && current.exportState().candidates.find(c => c.id === id)?.state !== "committed") current.discard(id, reason);
      };
      const invoke = async (role: MechanismCall["role"], agent: string, target: string | null, context: Checkout,
        memory: readonly unknown[], extra: Record<string, unknown> = {}) => {
        const model = role === "meta" || method === "single-astra" ? "gpt-6-astra" : "gpt-5.6-luna";
        if (calls.length >= configuration.maxCalls || !budgetOkay()) return null;
        const id = `call-${++serial}`;
        if (!budget.reserve(model, id)) return null;
        const record: MechanismCall = { id, stage, agent, role, target, model, outcome: "running", errors: [], durationMs: 0,
          contextArtifacts: Object.keys(context.reads), contextBytes: Buffer.byteLength(JSON.stringify(context.contents)),
          memoryEntries: memory.length, readRequests: [], writtenIds: [], effectiveModelEvidence: null, credits: null, reservationOverrun: false };
        calls.push(record); active++; maxActiveModelCalls = Math.max(maxActiveModelCalls, active); current.beginWork(id, agent);
        const instruction = role === "meta"
          ? "Observe repeated visible local verification failures. Workers did not request consultation. Repair only shared guidance when it contradicts normative requirements. Do not write worker files or normative/source artifacts; do not use readRequests."
          : role === "single"
            ? "Complete the current public task using all supplied files. You may return incremental patches to any writable artifact and the shared guidance within its remainingPatchAttempts. readyTargets lists pending work to prioritize, not the complete edit authority. Prefer bounded subsets (for example 1–6 modules per call); a response need not finish the whole task. Preserve pinned normative/source artifacts."
            : `Implement only ${target}. You can request additional public artifacts by returning readRequests with their catalog IDs and empty writes. After receiving those files, propose a complete replacement for your assigned target only. No upper consultation channel exists.`;
        const prompt = `${instruction}\nReturn strict JSON {writes:[{id,content}],readRequests:[id],note}. Use either reads or writes in a call, never both. Do not use any tools, shell, browser, file access, or paths outside supplied JSON. Only the provided public contents and catalog may be used. Shared guidance is advisory; current normative specification takes precedence. Private memories are past observations; versions are stage-local and must be reread.\nPUBLIC_INPUT_JSON\n${JSON.stringify({ task: fixture.task, family: fixture.family, stage, target,
          role, context: { contents: context.contents, reads: context.reads }, catalog: fixture.catalog,
          writableIds: role === "worker" ? [target] : role === "meta" ? [fixture.guidanceId] : [...fixture.writableIds, fixture.guidanceId],
          memory, previousVisibleErrors: target ? failures.get(target) ?? [] : [], ...extra })}`;
        const at = performance.now();
        let receipt: unknown = { requestedModel: model, error: "no receipt" };
        let value: MechanismResponse | null = null;
        let transcriptIntegrityFailure: string | null = null;
        try {
          const result = await caller({ model, prompt, schema, cwd: workspace, timeoutMs: configuration.timeoutMs,
            outputDirectory: join(options.outputDirectory, "transcripts"), signal: controller.signal });
          receipt = result; record.effectiveModelEvidence = result.transcript.effectiveModelEvidence;
          if (result.requestedModel !== model || result.transcript.requestedModel !== model
            || (record.effectiveModelEvidence !== null && record.effectiveModelEvidence !== model)) throw new Error("requested model identity mismatch");
          value = response(result.result); record.outcome = "received";
        } catch (error) {
          if (error instanceof CodexWorkerError) {
            receipt = { error: error.code, transcript: error.transcript };
            if (["malformed-events", "output-too-large"].includes(error.code)) transcriptIntegrityFailure = error.code;
          }
          record.outcome = "model-error"; record.errors = [String(error)];
        } finally {
          record.durationMs = performance.now() - at;
          const tools = [...toolEvents(receipt), ...(transcriptIntegrityFailure ? [`incomplete-transcript:${transcriptIntegrityFailure}`] : [])];
          if (tools.length) { boundaryViolations.push({ callId: id, events: tools }); controller.abort(); record.outcome = "boundary-violation"; value = null; }
          const settled = budget.settle(id, receipt); record.credits = settled.credits; record.reservationOverrun = settled.overrun;
          await writeFile(join(options.outputDirectory, `${id}.json`), JSON.stringify(receipt, null, 2) + "\n");
          active--; current.endWork(id);
        }
        if (!budgetOkay()) value = null;
        return { value, record };
      };
      const apply = async (record: MechanismCall, value: MechanismResponse, context: Checkout, scope: string[], meta = false): Promise<boolean> => serialize(async () => {
        if (!budgetOkay()) { record.outcome = "budget-or-boundary-rejected"; return false; }
        const allowed = meta ? [fixture.guidanceId] : single ? [...fixture.writableIds, fixture.guidanceId] : scope;
        let candidate: string | null = null;
        try {
          if (value.writes.some(write => !allowed.includes(write.id))) throw new Error("write exceeds edit authority");
          if (!value.writes.length) throw new Error("empty patch without read request");
          const obligations = current.pending().filter(item => scope.includes(item.consumer));
          const lease = current.grant(record.agent, allowed, configuration.timeoutMs * 2 + 60_000, meta ? "meta" : "worker");
          const prepared = current.prepare({ id: `stage-${stage}-${record.id}`, agent: record.agent, context: context.id, lease,
            writes: Object.fromEntries(value.writes.map(write => [write.id, write.content])), obligations: meta ? [] : obligations.map(item => item.id),
            ...(meta ? { kind: "intervention", reason: value.note || "Repair shared guidance" } : {}) });
          candidate = prepared.id;
          const verdict = await current.validate(candidate, next => meta
            ? { ok: next[fixture.guidanceId]!.trim().length > 0, errors: ["guidance must not be empty"].filter(() => !next[fixture.guidanceId]!.trim()) }
            : fixture.verify(next, stage, scope, "visible"));
          if (!verdict.ok) {
            record.outcome = "semantic-rejected"; record.errors = [...verdict.errors];
            for (const id of scope) failures.set(id, [...verdict.errors]);
            discard(candidate, "visible verification rejected"); return false;
          }
          const committed = current.commit(candidate); record.outcome = "committed"; record.writtenIds = value.writes.map(write => write.id);
          for (const id of scope) resolveClaim(id, context.id, committed.validation);
          if (meta && committed.events.length) interventions++;
          current.deliverAll(); return true;
        } catch (error) {
          discard(candidate, String(error)); record.outcome = error instanceof KernelError ? error.code : "invalid-patch";
          record.errors = [String(error)]; return false;
        }
      });
      const settleValid = async () => {
        current.deliverAll();
        const check = [...new Set([...claims.keys(), ...current.pending().map(item => item.consumer)])];
        for (const target of check) {
          const state = current.artifact(target), stamp = `${state.version}/${state.evidenceEpoch}`;
          if (inspected.get(target) === stamp && failures.has(target)) continue;
          const context = contextFor("visible-verifier", target);
          const obligations = current.pending().filter(item => item.consumer === target);
          const lease = current.grant("visible-verifier", [target]);
          const prepared = current.prepare({ id: `stage-${stage}-check-${++serial}`, agent: "visible-verifier", context: context.id,
            lease, writes: {}, obligations: obligations.map(item => item.id) });
          const verdict = await current.validate(prepared.id, next => fixture.verify(next, stage, [target], "visible"));
          if (verdict.ok) { const committed = current.commit(prepared.id); resolveClaim(target, context.id, committed.validation); }
          else { inspected.set(target, stamp); failures.set(target, [...verdict.errors]); current.discard(prepared.id, "current artifact needs visible repair"); }
        }
      };
      const perform = async (assignment: WorkerAssignment) => {
        const target = assignment.target, context = contextFor(assignment.workerId, target);
        let note = "No call admitted", outcome = "not-admitted";
        try {
          const called = await invoke("worker", assignment.workerId, target, context, assignment.memory);
          if (!called) return;
          const { record, value } = called; note = value?.note.slice(0, 1200) ?? record.errors.join("\n").slice(0, 1200);
          // A dependency is registered only when its selected public content is actually delivered.
          if (value) for (const provider of selectedReads.get(target) ?? []) if (provider !== target) {
            const key = `${target}\0${provider}`;
            if (!learned.has(key)) {
              const stamp = context.reads[provider]!; current.addDependency(target, provider, stamp.version, stamp.evidenceEpoch);
              learned.set(key, { consumer: target, provider }); discovery.push({ stage, callId: record.id, target, provider });
            }
          }
          if (value?.readRequests.length) {
            reads.set(target, (reads.get(target) ?? 0) + 1); record.readRequests = value.readRequests;
            if (reads.get(target)! > configuration.maxReadCalls || value.readRequests.some(id => !catalogIds.has(id))) {
              record.outcome = "invalid-read-request"; failures.set(target, ["Read request limit exceeded or unknown public artifact ID"]);
              attempts.set(target, configuration.maxAttempts);
            } else {
              const selected = selectedReads.get(target) ?? new Set<string>(); for (const id of value.readRequests) selected.add(id);
              selectedReads.set(target, selected); record.outcome = "read-requested";
            }
          } else {
            attempts.set(target, (attempts.get(target) ?? 0) + 1);
            if (value) await apply(record, value, context, [target]);
          }
          outcome = record.outcome;
        } finally {
          pool.finish(assignment.workerId, { target, note: `[stage ${stage}] ${note}`, outcome, reads: context.reads });
        }
      };
      const intervene = async () => {
        const context = contextFor("meta", null);
        const observations = calls.filter(call => call.stage === stage && call.role === "worker" && call.outcome === "semantic-rejected"
          && call.target && targets().includes(call.target)).slice(-8).map(call => ({ call: call.id, target: call.target, errors: call.errors }));
        const called = await invoke("meta", "meta", fixture.guidanceId, context, [], { observations });
        if (!called?.value) return;
        if (called.value.readRequests.length) { called.record.outcome = "invalid-read-request"; return; }
        await apply(called.record, called.value, context, [], true);
      };
      while (calls.length < configuration.maxCalls && budgetOkay()) {
        await settleValid();
        const pending = targets();
        if (!pending.length) break;
        const eligible = pending.filter(id => (attempts.get(id) ?? 0) < configuration.maxAttempts);
        if (single) {
          if (!eligible.length) { terminationReason = "attempt-limit"; break; }
          const context = contextFor("single", null, true);
          const called = await invoke("single", "single", null, context, singleMemory, { readyTargets: eligible,
            remainingPatchAttempts: Object.fromEntries([...fixture.writableIds, fixture.guidanceId].map(id => [id, Math.max(0, configuration.maxAttempts - (attempts.get(id) ?? 0))])),
            previousVisibleErrors: Object.fromEntries(failures) });
          if (!called) { terminationReason = "credit-admission-limit"; break; }
          const rememberSingle = () => {
            singleMemory.push({ stage, note: (called.value?.note ?? called.record.errors.join("\n")).slice(0, 1200), outcome: called.record.outcome });
            if (singleMemory.length > 4) singleMemory.shift();
          };
          if (!called.value || called.value.readRequests.length || !called.value.writes.length) {
            for (const id of eligible) attempts.set(id, (attempts.get(id) ?? 0) + 1);
            if (called.value) called.record.outcome = "invalid-single-response";
            rememberSingle(); continue;
          }
          const scope = called.value.writes.map(write => write.id);
          const exhausted = scope.filter(id => (writable.has(id) || id === fixture.guidanceId) && (attempts.get(id) ?? 0) >= configuration.maxAttempts);
          if (exhausted.length) {
            called.record.outcome = "attempt-limit"; called.record.errors = exhausted.map(id => `Per-stage patch attempt limit reached: ${id}`);
            terminationReason = "attempt-limit"; rememberSingle(); break;
          }
          for (const id of scope) attempts.set(id, (attempts.get(id) ?? 0) + 1);
          await apply(called.record, called.value, context, scope); rememberSingle();
        } else {
          if (!eligible.length) { terminationReason = "attempt-limit"; break; }
          const availableBudget = budget.snapshot();
          const affordable = Math.max(0, Math.floor((availableBudget.maxCredits - availableBudget.observedCredits - availableBudget.reservedCredits) / configuration.lunaReservation));
          if (affordable < 1) { terminationReason = "credit-admission-limit"; break; }
          const jobs = eligible.slice(0, Math.min(configuration.concurrency, configuration.maxCalls - calls.length, affordable));
          const assignments = pool.assign(jobs.map(target => ({ target, neighbors: [...learned.values()].filter(edge => edge.consumer === target).map(edge => edge.provider) })));
          const previousCalls = calls.length;
          const results = await Promise.allSettled(assignments.map(perform));
          const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
          if (rejected.length) throw new AggregateError(rejected.map(r => r.reason), "mechanism worker failed");
          const semantic = calls.filter(call => call.stage === stage && call.role === "worker" && call.outcome === "semantic-rejected");
          const unresolved = semantic.some(call => call.target && targets().includes(call.target));
          if (method !== "no-upper" && unresolved && semantic.length - lastMetaFailure >= 2
            && calls.filter(call => call.role === "meta").length < configuration.maxMetaCalls && budgetOkay()) {
            lastMetaFailure = semantic.length; await intervene();
          }
          if (calls.length === previousCalls || !assignments.length) { terminationReason = "scheduler-stalled"; break; }
        }
      }
      if (terminationReason === null && calls.length >= configuration.maxCalls) terminationReason = "call-limit";
      await settleValid();
      const quality = await fixture.verify(current.contents(), stage, undefined, "final");
      const clean = protocol(current);
      const completion = await current.complete(() => quality);
      const success = quality.ok && completion.ok && budgetOkay() && budget.snapshot().activeReservations === 0;
      const stageCalls = calls.slice(firstCall), stageBudget = budget.snapshot();
      terminationReason = success ? "completed" : boundaryViolations.length ? "context-boundary"
        : stageBudget.unknownUsageCalls ? "budget-unknown" : stageBudget.exceeded ? "budget-exceeded"
          : terminationReason ?? (!quality.ok ? "final-quality-failed" : !completion.ok ? "protocol-incomplete" : "scheduler-stalled");
      stages.push({ stage, terminationReason, success, qualityPass: quality.ok, protocolClean: clean,
        errors: [...new Set([...quality.errors, ...completion.errors, ...(!budgetOkay() ? ["budget-or-boundary-unverified"] : [])])],
        calls: stageCalls.length, lowerCalls: stageCalls.filter(c => c.model === "gpt-5.6-luna").length,
        upperCalls: stageCalls.filter(c => c.model === "gpt-6-astra").length,
        readCalls: stageCalls.filter(c => c.outcome === "read-requested").length, interventions: interventions - firstIntervention,
        patchAttempts: Object.fromEntries(attempts), readAttempts: Object.fromEntries(reads), elapsedMs: performance.now() - stageStart });
      contents = current.contents();
      await writeFile(join(options.outputDirectory, `kernel-stage-${stage}.json`), JSON.stringify(current.exportState(), null, 2) + "\n");
      await writeFile(join(options.outputDirectory, `artifacts-stage-${stage}.json`), JSON.stringify(contents, null, 2) + "\n");
      if (!success) break;
    }
  } catch (error) { fatalErrors.push(`execution-error: ${String(error)}`); }
  const finalBudget = budget.snapshot();
  const report = { format: 1, task: fixture.task, method, family: fixture.family, fixtureFingerprint: fingerprint, configuration,
    success: stages.length === fixture.stageCount && stages.every(s => s.success) && !fatalErrors.length,
    terminationReason: fatalErrors.length ? "execution-error" as const : stages.at(-1)?.terminationReason ?? "scheduler-stalled" as const,
    qualityPass: stages.length === fixture.stageCount && stages.every(s => s.qualityPass),
    finalErrors: [...fatalErrors, ...stages.filter(s => !s.success).flatMap(s => s.errors)],
    calls, lowerCalls: calls.filter(c => c.model === "gpt-5.6-luna").length, upperCalls: calls.filter(c => c.model === "gpt-6-astra").length,
    interventions, stages, budget: finalBudget, maxActiveModelCalls, workerStats: pool.stats(),
    discovery: { deliveredEdges: discovery, edges: [...learned.values()] }, boundaryViolations,
    singleMemory,
    participation: single ? [{ id: "single", scheduledAssignments: calls.filter(call => call.role === "single").length, actualCalls: calls.filter(call => call.role === "single").length,
      committedPatches: calls.filter(call => call.role === "single" && call.outcome === "committed").length }] : pool.stats().map(worker => ({ id: worker.id, scheduledAssignments: worker.assignments,
      actualCalls: calls.filter(call => call.agent === worker.id).length,
      committedPatches: calls.filter(call => call.agent === worker.id && call.outcome === "committed").length })),
    durationMs: performance.now() - started,
    limitations: ["Codex read-only sandbox is not filesystem read isolation. Transcript tool activity is audited after the call and invalidates the run; undisclosed external reads cannot be proven absent.",
      "Standard credit rates are conditional estimates. Reservations gate admission; provider billing can exceed a reservation before settlement.",
      "Each stage uses a new kernel and stage-local versions; accepted contents, registered discovery, and private worker histories persist across successful barriers.",
      "The host scheduler allocates work; this pilot does not establish emergent specialization.",
      "Final oracle errors appear only in artifacts/reports and are never used for model repair feedback."] };
  await writeFile(join(options.outputDirectory, "result.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(options.outputDirectory, "artifacts.json"), JSON.stringify(kernel?.contents() ?? contents, null, 2) + "\n");
  if (kernel) await writeFile(join(options.outputDirectory, "kernel-state.json"), JSON.stringify(kernel.exportState(), null, 2) + "\n");
  return report;
}
