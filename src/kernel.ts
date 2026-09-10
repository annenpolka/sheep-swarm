import { validateKernelState } from "./kernel-state.ts";

export type Contents = Readonly<Record<string, string>>;
export interface Verdict { readonly ok: boolean; readonly errors: readonly string[] }
export type Verifier = (contents: Contents) => Verdict | Promise<Verdict>;
export interface ArtifactState { id: string; content: string; version: number; evidenceEpoch: number }
export interface KernelEvent { id: string; artifact: string; version: number; evidenceEpoch: number; cause: string; delivered: boolean }
export interface WorkObligation {
  id: string; consumer: string; provider: string; requiredVersion: number; requiredEvidenceEpoch: number;
  state: "pending" | "running" | "handled"; agent: string | null;
  receipt: { context: string; evidence: string; outcome: "handled" | "ignored"; version: number; evidenceEpoch: number } | null;
}
export interface Lease {
  id: string; agent: string; scope: string[]; epoch: number; expiresAt: number; role: "worker" | "meta";
}
export interface Checkout {
  id: string; agent: string; contents: Record<string, string>;
  reads: Record<string, { version: number; evidenceEpoch: number }>;
}
export interface ProposalInput {
  id: string; agent: string; context: string; writes: Record<string, string>;
  lease: { id: string; epoch: number }; obligations?: readonly string[];
  kind?: "work" | "intervention"; reason?: string;
}
export interface PreparedCandidate { id: string; revision: number; contents: Record<string, string> }
interface Candidate extends PreparedCandidate {
  proposal: ProposalInput; validation: { id: string; verdict: Verdict } | null;
  committedRevision: number | null;
  verificationPolicy: string;
  state: "prepared" | "validated" | "committed" | "rejected" | "discarded";
}
export interface TraceEntry { sequence: number; time: number; type: string; details: Record<string, unknown> }
export interface KernelState {
  format: 1; serial: number; revision: number; inputClosed: boolean; verificationPolicy: string;
  artifacts: Record<string, ArtifactState>; dependencies: { consumer: string; provider: string }[];
  historical: { consumer: string; provider: string }[];
  events: KernelEvent[]; obligations: WorkObligation[]; leases: Lease[];
  contexts: Checkout[]; candidates: Candidate[];
  claims: { id: string; subject: string; blocking: boolean; open: boolean; reason: string }[];
  reservations: { consumer: string; agent: string; expiresAt: number }[];
  retries: { id: string; dueAt: number }[];
  activeWork: { id: string; agent: string }[];
  trace: TraceEntry[];
  application?: Record<string, unknown>;
}
export class KernelError extends Error {
  readonly code: string;
  constructor(code: string, message = code, options?: ErrorOptions) { super(message, options); this.code = code; this.name = "KernelError"; }
}
const copy = <T>(value: T): T => structuredClone(value);
function demand(condition: unknown, code: string): asserts condition {
  if (!condition) throw new KernelError(code);
}
function strings(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => key.length > 0 && typeof item === "string");
}

/** In-process authority boundary. Agents receive copies and never mutate this state directly. */
export class SwarmKernel {
  #state: KernelState;
  #now: () => number;
  #save: ((state: KernelState) => void) | undefined;
  #poisoned = false;

  constructor(options: { artifacts: Record<string, string>; now?: () => number; save?: (state: KernelState) => void; verificationPolicy?: string }) {
    demand(strings(options.artifacts), "invalid-artifacts");
    this.#now = options.now ?? Date.now;
    this.#save = options.save;
    this.#state = {
      format: 1, serial: 0, revision: 0, inputClosed: false, verificationPolicy: options.verificationPolicy ?? "acceptance-v1/environment-v1",
      artifacts: Object.fromEntries(Object.entries(options.artifacts).map(([id, content]) =>
        [id, { id, content, version: 0, evidenceEpoch: 0 }])),
      dependencies: [], historical: [], events: [], obligations: [], leases: [], contexts: [],
      candidates: [], claims: [], reservations: [], retries: [], activeWork: [], trace: [],
    };
  }

  /** Restore only a validated durable snapshot. Recovery itself is durably recorded. */
  static restore(state: KernelState, options: {
    now?: () => number; save?: (state: KernelState) => void; recover?: boolean;
  } = {}): SwarmKernel {
    let snapshot: KernelState;
    try { snapshot = copy(state); validateKernelState(snapshot); }
    catch (error) { throw new KernelError("invalid-state", "cannot restore an invalid kernel snapshot", { cause: error }); }
    const target = new SwarmKernel({ artifacts: {},
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.save === undefined ? {} : { save: options.save }) });
    target.#state = snapshot;
    if (options.recover !== false) {
      const released: string[] = [], discarded: string[] = [];
      for (const work of snapshot.obligations) if (work.state === "running") {
        work.state = "pending"; work.agent = null; work.receipt = null; released.push(work.id);
      }
      for (const lease of snapshot.leases) { lease.epoch++; lease.expiresAt = Math.min(lease.expiresAt, target.#now()); }
      for (const candidate of snapshot.candidates) if (candidate.state === "prepared" || candidate.state === "validated") {
        candidate.state = "discarded"; discarded.push(candidate.id);
      }
      const abandonedWork = snapshot.activeWork.map((work) => ({ ...work }));
      snapshot.activeWork = []; snapshot.reservations = [];
      target.#record("recovered", { released, discarded, fencedLeases: snapshot.leases.map((lease) => lease.id), abandonedWork });
    }
    return target;
  }

  #assertHealthy(): void {
    if (this.#poisoned) throw new KernelError("persistence-failed", "kernel is fenced after a failed save; reload the journal");
  }
  #id(prefix: string): string { this.#assertHealthy(); return `${prefix}-${++this.#state.serial}`; }
  #record(type: string, details: Record<string, unknown>): void {
    this.#assertHealthy();
    this.#state.trace.push({ sequence: this.#state.trace.length + 1, time: this.#now(), type, details: copy(details) });
    try { this.#save?.(this.exportState()); }
    catch (error) {
      this.#poisoned = true;
      throw new KernelError("persistence-failed", "durable save failed; reload the journal before continuing", { cause: error });
    }
  }
  #artifact(id: string): ArtifactState {
    const value = Object.hasOwn(this.#state.artifacts, id) ? this.#state.artifacts[id] : undefined;
    demand(value, "unknown-artifact");
    return value;
  }
  #context(id: string, agent?: string): Checkout {
    const value = this.#state.contexts.find((item) => item.id === id);
    demand(value && (agent === undefined || value.agent === agent), "invalid-context");
    return value;
  }
  #checkContext(context: Checkout): void {
    for (const [id, read] of Object.entries(context.reads)) {
      const current = this.#artifact(id);
      demand(current.version === read.version && current.evidenceEpoch === read.evidenceEpoch, "stale-read");
    }
  }
  #candidate(id: string): Candidate {
    const value = this.#state.candidates.find((item) => item.id === id);
    demand(value, "unknown-candidate");
    return value;
  }
  #checkLease(input: ProposalInput): void {
    const lease = this.#state.leases.find((item) => item.id === input.lease.id);
    demand(lease && lease.agent === input.agent && lease.epoch === input.lease.epoch
      && this.#now() < lease.expiresAt, "invalid-authority");
    demand((input.kind ?? "work") !== "intervention" || lease.role === "meta", "meta-authority-required");
    demand(Object.keys(input.writes).every((id) => lease.scope.includes(id)), "outside-authority");
  }
  #affected(provider: string): string[] {
    const edges = [...this.#state.dependencies, ...this.#state.historical];
    const visited = new Set([provider]);
    const queue = [provider];
    for (let index = 0; index < queue.length; index++) {
      for (const edge of edges) {
        if (edge.provider === queue[index] && !visited.has(edge.consumer)) {
          visited.add(edge.consumer); queue.push(edge.consumer);
        }
      }
    }
    return queue.slice(1);
  }
  #enqueue(consumer: string, provider: string, requiredVersion: number, requiredEvidenceEpoch = this.#artifact(provider).evidenceEpoch): void {
    const existing = this.#state.obligations.find((item) => item.consumer === consumer && item.provider === provider);
    if (existing) {
      if (existing.requiredVersion >= requiredVersion && existing.requiredEvidenceEpoch >= requiredEvidenceEpoch) return;
      existing.requiredVersion = Math.max(existing.requiredVersion, requiredVersion);
      existing.requiredEvidenceEpoch = Math.max(existing.requiredEvidenceEpoch, requiredEvidenceEpoch);
      existing.state = "pending"; existing.agent = null; existing.receipt = null;
    } else {
      this.#state.obligations.push({ id: this.#id("obligation"), consumer, provider, requiredVersion, requiredEvidenceEpoch,
        state: "pending", agent: null, receipt: null });
    }
  }
  #write(id: string, content: string, cause: string): KernelEvent | null {
    const artifact = this.#artifact(id);
    if (artifact.content === content) return null;
    artifact.content = content; artifact.version++; artifact.evidenceEpoch++;
    for (const consumer of this.#affected(id)) this.#artifact(consumer).evidenceEpoch++;
    const event: KernelEvent = { id: this.#id("event"), artifact: id, version: artifact.version, evidenceEpoch: artifact.evidenceEpoch, cause, delivered: false };
    this.#state.events.push(event);
    return event;
  }

  /** Application budgets and call receipts share the same transaction as kernel state. */
  application(): Record<string, unknown> | null { return copy(this.#state.application ?? null); }
  setApplication(value: Record<string, unknown>): void {
    this.#assertHealthy();
    demand(value !== null && typeof value === "object" && !Array.isArray(value), "invalid-application-state");
    this.#state.application = copy(value); this.#record("application-checkpoint", {});
  }

  artifact(id: string): ArtifactState { return copy(this.#artifact(id)); }
  contents(): Record<string, string> { return Object.fromEntries(Object.values(this.#state.artifacts).map((a) => [a.id, a.content])); }
  exportState(): KernelState { return copy(this.#state); }
  trace(): TraceEntry[] { return copy(this.#state.trace); }
  events(): KernelEvent[] { return copy(this.#state.events); }
  obligations(): WorkObligation[] { return copy(this.#state.obligations); }
  pending(): WorkObligation[] { return this.obligations().filter((item) => item.state !== "handled"); }

  /** Trusted new input, unavailable after the run's input epoch is closed. */
  change(id: string, content: string): string | null {
    this.#assertHealthy();
    demand(!this.#state.inputClosed, "input-closed");
    demand(typeof content === "string", "invalid-content");
    const event = this.#write(id, content, "input");
    if (event) this.#state.revision++;
    this.#record("input", { id, event: event?.id ?? null });
    return event?.id ?? null;
  }
  closeInput(): void { this.#assertHealthy(); this.#state.inputClosed = true; this.#record("input-closed", {}); }

  /** Trusted evidence correction; content bytes may remain identical. */
  correct(id: string, reason: string): string {
    this.#assertHealthy();
    demand(!this.#state.inputClosed, "input-closed");
    demand(reason.trim().length > 0, "correction-reason-required");
    const artifact = this.#artifact(id); artifact.evidenceEpoch++;
    for (const consumer of this.#affected(id)) this.#artifact(consumer).evidenceEpoch++;
    const event: KernelEvent = { id: this.#id("event"), artifact: id, version: artifact.version,
      evidenceEpoch: artifact.evidenceEpoch, cause: "correction", delivered: false };
    this.#state.events.push(event); this.#state.revision++;
    this.#record("corrected", { artifact: id, reason, event: event.id }); return event.id;
  }
  /** Host-side acceptance/environment identity, not a worker or meta operation. */
  setVerificationPolicy(policy: string): void {
    this.#assertHealthy();
    demand(policy.trim().length > 0, "invalid-verification-policy");
    this.#state.verificationPolicy = policy;
    this.#record("verification-policy", { policy });
  }
  beginWork(id: string, agent: string): void {
    this.#assertHealthy();
    demand(id.length > 0 && agent.length > 0 && !this.#state.activeWork.some((w) => w.id === id), "invalid-active-work");
    this.#state.activeWork.push({ id, agent }); this.#record("work-started", { id, agent });
  }
  endWork(id: string): void {
    this.#assertHealthy();
    demand(this.#state.activeWork.some((w) => w.id === id), "unknown-active-work");
    this.#state.activeWork = this.#state.activeWork.filter((w) => w.id !== id); this.#record("work-ended", { id });
  }

  addDependency(consumer: string, provider: string, observedVersion = this.#artifact(provider).version,
    observedEvidenceEpoch = 0): void {
    this.#assertHealthy();
    this.#artifact(consumer); const current = this.#artifact(provider);
    demand(Number.isInteger(observedVersion) && observedVersion >= 0 && observedVersion <= current.version, "invalid-observed-version");
    demand(Number.isInteger(observedEvidenceEpoch) && observedEvidenceEpoch >= 0 && observedEvidenceEpoch <= current.evidenceEpoch, "invalid-observed-evidence");
    if (!this.#state.dependencies.some((item) => item.consumer === consumer && item.provider === provider)) {
      this.#state.dependencies.push({ consumer, provider });
    }
    if (observedVersion < current.version || observedEvidenceEpoch < current.evidenceEpoch)
      this.#enqueue(consumer, provider, current.version);
    this.#record("dependency", { consumer, provider, observedVersion, observedEvidenceEpoch });
  }
  /** Retirement requires explicit evidence; history remains available for corrections. */
  retireDependency(consumer: string, provider: string, reason: string): void {
    this.#assertHealthy();
    demand(reason.trim().length > 0, "retirement-reason-required");
    this.#state.dependencies = this.#state.dependencies.filter((item) => item.consumer !== consumer || item.provider !== provider);
    this.#record("dependency-retired", { consumer, provider, reason });
  }
  deliver(eventId: string): void {
    this.#assertHealthy();
    const event = this.#state.events.find((item) => item.id === eventId);
    demand(event, "unknown-event");
    if (event.delivered) return;
    for (const consumer of this.#affected(event.artifact)) {
      this.#enqueue(consumer, event.artifact, this.#artifact(event.artifact).version);
    }
    event.delivered = true;
    this.#record("delivered", { event: event.id });
  }
  deliverAll(): void { this.#assertHealthy(); for (const event of this.events()) if (!event.delivered) this.deliver(event.id); }

  checkout(agent: string, ids: readonly string[]): Checkout {
    this.#assertHealthy();
    demand(agent.length > 0 && ids.length > 0, "invalid-checkout");
    const reads: Checkout["reads"] = {};
    const contents: Checkout["contents"] = {};
    for (const id of new Set(ids)) {
      const artifact = this.#artifact(id);
      Object.defineProperty(reads, id, { value: { version: artifact.version, evidenceEpoch: artifact.evidenceEpoch }, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(contents, id, { value: artifact.content, enumerable: true, writable: true, configurable: true });
    }
    const context = { id: this.#id("context"), agent, reads, contents };
    this.#state.contexts.push(context);
    this.#record("checkout", { context: context.id, agent, artifacts: Object.keys(reads) });
    return copy(context);
  }
  grant(agent: string, scope: readonly string[], ttlMs = 60_000, role: Lease["role"] = "worker"): Lease {
    this.#assertHealthy();
    demand(agent.length > 0 && scope.length > 0 && Number.isFinite(ttlMs) && ttlMs > 0, "invalid-lease");
    for (const id of scope) this.#artifact(id);
    const lease = { id: this.#id("lease"), agent, scope: [...new Set(scope)], epoch: 1, expiresAt: this.#now() + ttlMs, role };
    this.#state.leases.push(lease); this.#record("authority", { lease: lease.id, agent, role });
    return copy(lease);
  }
  revoke(leaseId: string): void {
    this.#assertHealthy();
    const lease = this.#state.leases.find((item) => item.id === leaseId);
    demand(lease, "unknown-lease");
    lease.epoch++; lease.expiresAt = this.#now();
    this.#record("authority-revoked", { lease: leaseId, epoch: lease.epoch });
  }
  reserve(consumer: string, agent: string, ttlMs = 60_000): void {
    this.#assertHealthy();
    this.#artifact(consumer); demand(ttlMs > 0 && Number.isFinite(ttlMs), "invalid-reservation");
    this.#state.reservations.push({ consumer, agent, expiresAt: this.#now() + ttlMs });
    this.#record("reservation", { consumer, agent });
  }
  seen(obligationId: string, agent: string): void {
    this.#assertHealthy();
    const obligation = this.#state.obligations.find((item) => item.id === obligationId);
    demand(obligation && obligation.state !== "handled", "invalid-obligation");
    demand(obligation.agent === null || obligation.agent === agent, "already-running");
    obligation.state = "running"; obligation.agent = agent;
    this.#record("seen", { obligation: obligationId, agent });
  }
  release(obligationId: string, agent: string): void {
    this.#assertHealthy();
    const obligation = this.#state.obligations.find((item) => item.id === obligationId);
    demand(obligation && obligation.state === "running" && obligation.agent === agent, "invalid-obligation");
    obligation.state = "pending"; obligation.agent = null;
    this.#record("released", { obligation: obligationId, agent });
  }

  prepare(raw: ProposalInput): PreparedCandidate {
    this.#assertHealthy();
    demand(raw && typeof raw.id === "string" && raw.id.length > 0 && typeof raw.agent === "string"
      && typeof raw.context === "string" && strings(raw.writes)
      && raw.lease && typeof raw.lease.id === "string" && Number.isInteger(raw.lease.epoch), "invalid-proposal");
    demand(!this.#state.candidates.some((item) => item.proposal.id === raw.id), "duplicate-proposal");
    const input = copy(raw);
    const context = this.#context(input.context, input.agent);
    this.#checkContext(context); this.#checkLease(input);
    demand(Object.keys(input.writes).every((id) => Object.hasOwn(context.reads, id)), "write-without-read");
    for (const id of input.obligations ?? []) {
      const obligation = this.#state.obligations.find((item) => item.id === id);
      demand(obligation && obligation.state !== "handled" && (obligation.agent === null || obligation.agent === input.agent), "invalid-obligation");
      demand(Object.hasOwn(context.reads, obligation.consumer) && Object.hasOwn(context.reads, obligation.provider)
        && context.reads[obligation.provider]!.version >= obligation.requiredVersion
        && context.reads[obligation.provider]!.evidenceEpoch >= obligation.requiredEvidenceEpoch, "unobserved-obligation");
    }
    const contents = { ...this.contents(), ...input.writes };
    const candidate: Candidate = { id: this.#id("candidate"), proposal: input, revision: this.#state.revision,
      contents, validation: null, committedRevision: null, verificationPolicy: this.#state.verificationPolicy, state: "prepared" };
    this.#state.candidates.push(candidate);
    this.#record("prepared", { candidate: candidate.id, agent: input.agent, kind: input.kind ?? "work" });
    return copy({ id: candidate.id, revision: candidate.revision, contents });
  }
  async validate(candidateId: string, verifier: Verifier): Promise<Verdict> {
    this.#assertHealthy();
    const candidate = this.#candidate(candidateId);
    demand(candidate.state === "prepared", "candidate-not-prepared");
    let verdict: Verdict;
    try { verdict = await verifier(copy(candidate.contents)); }
    catch (error) {
      candidate.state = "rejected"; this.#record("validator-error", { candidate: candidateId, error: String(error) });
      throw new KernelError("validator-error", String(error));
    }
    this.#assertHealthy();
    demand(verdict && typeof verdict.ok === "boolean" && Array.isArray(verdict.errors)
      && verdict.errors.every((item) => typeof item === "string"), "invalid-verdict");
    demand(candidate.state === "prepared", "candidate-no-longer-prepared");
    candidate.validation = { id: this.#id("validation"), verdict: copy(verdict) };
    candidate.state = verdict.ok ? "validated" : "rejected";
    this.#record("validated", { candidate: candidateId, ...verdict });
    return copy(verdict);
  }
  commit(candidateId: string): { revision: number; events: string[]; validation: string } {
    this.#assertHealthy();
    const candidate = this.#candidate(candidateId);
    demand(candidate.state === "validated" && candidate.validation?.verdict.ok, "candidate-not-validated");
    const input = candidate.proposal;
    const context = this.#context(input.context, input.agent);
    this.#checkContext(context); this.#checkLease(input);
    demand(candidate.revision === this.#state.revision, "stale-validation");
    demand(candidate.verificationPolicy === this.#state.verificationPolicy, "stale-validation-policy");
    // All refusal checks precede mutation, including work receipts.
    for (const id of input.obligations ?? []) {
      const work = this.#state.obligations.find((item) => item.id === id);
      demand(work && work.state !== "handled" && (work.agent === null || work.agent === input.agent)
        && context.reads[work.provider]!.version >= work.requiredVersion
        && context.reads[work.provider]!.evidenceEpoch >= work.requiredEvidenceEpoch, "stale-obligation");
    }
    const changed: string[] = [];
    for (const [id, content] of Object.entries(input.writes)) {
      const event = this.#write(id, content, input.kind ?? "work");
      if (event) changed.push(event.id);
    }
    if (changed.length) this.#state.revision++;
    const consumers = new Set([...Object.keys(input.writes), ...(input.obligations ?? []).map((id) =>
      this.#state.obligations.find((item) => item.id === id)!.consumer)]);
    for (const consumer of consumers) for (const provider of Object.keys(context.reads)) {
      if (consumer !== provider && !this.#state.historical.some((item) => item.consumer === consumer && item.provider === provider))
        this.#state.historical.push({ consumer, provider });
    }
    for (const id of input.obligations ?? []) {
      const work = this.#state.obligations.find((item) => item.id === id)!;
      work.state = "handled"; work.agent = null;
      work.receipt = { context: context.id, evidence: candidate.validation.id,
        outcome: changed.length ? "handled" : "ignored", version: work.requiredVersion, evidenceEpoch: work.requiredEvidenceEpoch };
    }
    candidate.state = "committed";
    candidate.committedRevision = this.#state.revision;
    this.#record(input.kind === "intervention" ? "intervention" : "committed", {
      candidate: candidateId, agent: input.agent, writes: Object.keys(input.writes), events: changed,
      reason: input.reason ?? "", validation: candidate.validation.id,
    });
    return { revision: this.#state.revision, events: changed, validation: candidate.validation.id };
  }
  discard(candidateId: string, reason: string): void {
    this.#assertHealthy();
    const candidate = this.#candidate(candidateId);
    demand(candidate.state !== "committed", "already-committed");
    candidate.state = "discarded"; this.#record("discarded", { candidate: candidateId, reason });
  }
  openClaim(subject: string, reason: string, blocking = true): string {
    this.#assertHealthy();
    this.#artifact(subject); demand(reason.trim().length > 0, "claim-reason-required");
    const id = this.#id("claim"); this.#state.claims.push({ id, subject, reason, blocking, open: true });
    this.#record("claim-opened", { id, subject, blocking, reason }); return id;
  }
  resolveClaim(id: string, contextId: string, evidence: string): void {
    this.#assertHealthy();
    const claim = this.#state.claims.find((item) => item.id === id);
    demand(claim?.open, "unknown-open-claim");
    const context = this.#context(contextId);
    const candidate = this.#state.candidates.find((item) => item.validation?.id === evidence);
    demand(candidate?.state === "committed" && candidate.proposal.context === contextId
      && Object.hasOwn(context.reads, claim.subject), "invalid-claim-evidence");
    demand(candidate.committedRevision === this.#state.revision, "stale-claim-evidence");
    demand(candidate.verificationPolicy === this.#state.verificationPolicy, "stale-validation-policy");
    claim.open = false; this.#record("claim-resolved", { id, context: contextId, evidence });
  }
  scheduleRetry(id: string, dueAt: number): void {
    this.#assertHealthy();
    demand(Number.isFinite(dueAt), "invalid-retry");
    demand(!this.#state.retries.some((item) => item.id === id), "duplicate-retry");
    this.#state.retries.push({ id, dueAt }); this.#record("retry-scheduled", { id, dueAt });
  }
  clearRetry(id: string): void {
    this.#assertHealthy();
    this.#state.retries = this.#state.retries.filter((item) => item.id !== id); this.#record("retry-cleared", { id });
  }
  #incomplete(): string[] {
    const reasons: string[] = [];
    if (!this.#state.inputClosed) reasons.push("input-open");
    if (this.#state.events.some((e) => !e.delivered)) reasons.push("undelivered-events");
    if (this.#state.obligations.some((o) => o.state !== "handled")) reasons.push("pending-work");
    if (this.#state.candidates.some((p) => p.state === "prepared" || p.state === "validated")) reasons.push("pending-proposals");
    if (this.#state.claims.some((c) => c.open && c.blocking)) reasons.push("blocking-claims");
    if (this.#state.retries.length) reasons.push("scheduled-retries");
    if (this.#state.activeWork.length) reasons.push("active-workers");
    return reasons;
  }
  async complete(verifier: Verifier): Promise<Verdict> {
    this.#assertHealthy();
    const reasons = this.#incomplete(); if (reasons.length) return { ok: false, errors: reasons };
    const revision = this.#state.revision;
    const serial = this.#state.serial;
    const policy = this.#state.verificationPolicy;
    const transition = this.#state.trace.length;
    const verdict = await verifier(this.contents());
    this.#assertHealthy();
    demand(verdict && typeof verdict.ok === "boolean" && Array.isArray(verdict.errors)
      && verdict.errors.every((item) => typeof item === "string"), "invalid-verdict");
    const after = this.#incomplete();
    if (revision !== this.#state.revision || serial !== this.#state.serial || policy !== this.#state.verificationPolicy
      || transition !== this.#state.trace.length || after.length)
      return { ok: false, errors: ["state-changed-during-completion", ...after] };
    this.#record("completion", { revision, ...verdict });
    return copy(verdict);
  }
}
