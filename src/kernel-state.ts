import type { KernelState } from "./kernel.ts";

export class KernelStateError extends Error {
  constructor(message: string) { super(message); this.name = "KernelStateError"; }
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const strings = (value: unknown): value is Record<string, string> => record(value)
  && Object.entries(value).every(([key, item]) => text(key) && typeof item === "string");

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new KernelStateError(message);
}

/** Structural and referential checks, not a proof of a run's semantic correctness. */
export function validateKernelState(value: unknown): asserts value is KernelState {
  check(record(value) && value.format === 1, "KernelState format must be 1");
  check(integer(value.serial) && integer(value.revision) && typeof value.inputClosed === "boolean"
    && text(value.verificationPolicy) && record(value.artifacts), "invalid state header");
  const arrays = ["dependencies", "historical", "events", "obligations", "leases", "contexts", "candidates",
    "claims", "reservations", "retries", "activeWork", "trace"];
  check(arrays.every((key) => Array.isArray(value[key])), "missing state collection");
  const state = value as unknown as KernelState;
  const hasArtifact = (id: unknown): id is string => text(id) && Object.hasOwn(state.artifacts, id);
  for (const [id, artifact] of Object.entries(state.artifacts)) {
    check(text(id) && record(artifact) && artifact.id === id && typeof artifact.content === "string"
      && integer(artifact.version) && integer(artifact.evidenceEpoch) && artifact.evidenceEpoch >= artifact.version,
    "invalid artifact");
  }
  const ids = new Set<string>();
  const uniqueId = (id: unknown, prefix: string): void => {
    check(text(id) && !ids.has(id), `duplicate or invalid ${prefix} id`);
    const match = new RegExp(`^${prefix}-([1-9][0-9]*)$`).exec(id);
    check(match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) <= state.serial,
      `${prefix} id exceeds the stored serial`);
    ids.add(id);
  };
  for (const edges of [state.dependencies, state.historical]) {
    const pairs = new Set<string>();
    for (const edge of edges) {
      check(record(edge) && hasArtifact(edge.consumer) && hasArtifact(edge.provider), "dangling dependency");
      const pair = JSON.stringify([edge.consumer, edge.provider]);
      check(!pairs.has(pair), "duplicate dependency"); pairs.add(pair);
    }
  }
  for (const event of state.events) {
    check(record(event) && hasArtifact(event.artifact) && integer(event.version) && integer(event.evidenceEpoch)
      && text(event.cause) && typeof event.delivered === "boolean", "invalid event");
    uniqueId(event.id, "event");
    const artifact = state.artifacts[event.artifact]!;
    check(event.version <= artifact.version && event.evidenceEpoch <= artifact.evidenceEpoch, "event from future state");
  }
  for (const context of state.contexts) {
    check(record(context) && text(context.agent) && strings(context.contents) && record(context.reads), "invalid context");
    uniqueId(context.id, "context");
    check(Object.keys(context.reads).length > 0 && Object.keys(context.reads).length === Object.keys(context.contents).length,
      "context contents/read-set mismatch");
    for (const [id, read] of Object.entries(context.reads)) {
      check(hasArtifact(id) && Object.hasOwn(context.contents, id) && record(read) && integer(read.version)
        && integer(read.evidenceEpoch) && read.version <= state.artifacts[id]!.version
        && read.evidenceEpoch <= state.artifacts[id]!.evidenceEpoch, "invalid context read");
    }
  }
  for (const lease of state.leases) {
    check(record(lease) && text(lease.agent) && Array.isArray(lease.scope) && lease.scope.length > 0
      && lease.scope.every(hasArtifact) && new Set(lease.scope).size === lease.scope.length
      && integer(lease.epoch) && lease.epoch > 0 && finite(lease.expiresAt)
      && ["worker", "meta"].includes(lease.role), "invalid lease");
    uniqueId(lease.id, "lease");
  }
  const obligationIds = new Set<string>();
  const obligationPairs = new Set<string>();
  for (const work of state.obligations) {
    check(record(work) && hasArtifact(work.consumer) && hasArtifact(work.provider)
      && integer(work.requiredVersion) && integer(work.requiredEvidenceEpoch)
      && work.requiredVersion <= state.artifacts[work.provider]!.version
      && work.requiredEvidenceEpoch <= state.artifacts[work.provider]!.evidenceEpoch
      && ["pending", "running", "handled"].includes(work.state), "invalid obligation");
    uniqueId(work.id, "obligation"); obligationIds.add(work.id);
    const pair = JSON.stringify([work.consumer, work.provider]);
    check(!obligationPairs.has(pair), "duplicate obligation target"); obligationPairs.add(pair);
    check(work.state === "running" ? text(work.agent) : work.agent === null, "obligation ownership mismatch");
    if (work.state === "handled") {
      check(record(work.receipt) && text(work.receipt.context) && text(work.receipt.evidence)
        && ["handled", "ignored"].includes(work.receipt.outcome)
        && work.receipt.version === work.requiredVersion && work.receipt.evidenceEpoch === work.requiredEvidenceEpoch,
      "handled obligation lacks matching receipt");
    } else check(work.receipt === null, "unfinished obligation has a completion receipt");
  }
  const proposalIds = new Set<string>();
  for (const candidate of state.candidates) {
    check(record(candidate) && integer(candidate.revision) && candidate.revision <= state.revision
      && strings(candidate.contents) && text(candidate.verificationPolicy)
      && ["prepared", "validated", "committed", "rejected", "discarded"].includes(candidate.state)
      && record(candidate.proposal), "invalid candidate");
    uniqueId(candidate.id, "candidate");
    check(Object.keys(candidate.contents).length === Object.keys(state.artifacts).length
      && Object.keys(candidate.contents).every(hasArtifact), "candidate snapshot scope mismatch");
    const proposal = candidate.proposal;
    check(text(proposal.id) && !proposalIds.has(proposal.id) && text(proposal.agent) && text(proposal.context)
      && strings(proposal.writes) && record(proposal.lease) && text(proposal.lease.id)
      && integer(proposal.lease.epoch) && proposal.lease.epoch > 0
      && (proposal.kind === undefined || ["work", "intervention"].includes(proposal.kind))
      && (proposal.reason === undefined || typeof proposal.reason === "string"), "invalid proposal");
    proposalIds.add(proposal.id);
    const context = state.contexts.find((item) => item.id === proposal.context);
    const lease = state.leases.find((item) => item.id === proposal.lease.id);
    check(context && context.agent === proposal.agent && lease && lease.agent === proposal.agent
      && Object.keys(proposal.writes).every((id) => hasArtifact(id) && Object.hasOwn(context.reads, id)),
    "dangling candidate context or authority");
    check(proposal.obligations === undefined || (Array.isArray(proposal.obligations)
      && proposal.obligations.every((id) => obligationIds.has(id))), "dangling candidate obligation");
    if (candidate.validation !== null) {
      check(record(candidate.validation) && record(candidate.validation.verdict)
        && typeof candidate.validation.verdict.ok === "boolean" && Array.isArray(candidate.validation.verdict.errors)
        && candidate.validation.verdict.errors.every((error) => typeof error === "string"), "invalid validation");
      uniqueId(candidate.validation.id, "validation");
    }
    if (candidate.state === "validated" || candidate.state === "committed")
      check(candidate.validation?.verdict.ok === true, "accepted candidate has no passing validation");
    check(candidate.state === "committed"
      ? integer(candidate.committedRevision) && candidate.committedRevision <= state.revision
      : candidate.committedRevision === null, "candidate commit revision mismatch");
  }
  for (const work of state.obligations) if (work.receipt !== null) {
    const receipt = work.receipt;
    const candidate = state.candidates.find((item) => item.validation?.id === receipt.evidence);
    check(candidate?.state === "committed" && candidate.proposal.context === receipt.context
      && candidate.proposal.obligations?.includes(work.id), "receipt references no committed evidence");
  }
  for (const claim of state.claims) {
    check(record(claim) && hasArtifact(claim.subject) && typeof claim.blocking === "boolean"
      && typeof claim.open === "boolean" && text(claim.reason), "invalid epistemic claim");
    uniqueId(claim.id, "claim");
  }
  for (const reservation of state.reservations) check(record(reservation) && hasArtifact(reservation.consumer)
    && text(reservation.agent) && finite(reservation.expiresAt), "invalid advisory reservation");
  for (const items of [state.retries, state.activeWork]) {
    const localIds = new Set<string>();
    for (const item of items) {
      check(record(item) && text(item.id) && !localIds.has(item.id), "duplicate or invalid work id"); localIds.add(item.id);
      check("dueAt" in item ? finite(item.dueAt) : text(item.agent), "invalid active work or retry");
    }
  }
  for (const [index, entry] of state.trace.entries()) check(record(entry) && entry.sequence === index + 1
    && finite(entry.time) && text(entry.type) && record(entry.details), "invalid trace sequence or entry");
}
