/**
 * Draft vocabulary for the first kernel milestone.
 * Types describe proposals; they do not validate input or enforce authority.
 */
export type ArtifactId = string;
export type AgentId = string;
export type Version = string;
export type RunId = string;
export type EvidenceId = string;

export interface ArtifactRef {
  readonly artifactId: ArtifactId;
  readonly version: Version;
}

export interface Artifact extends ArtifactRef {
  readonly kind: "code" | "schema" | "test" | "doc" | "decision" | "log";
  readonly contentRef: string;
}

/** consumer depends on provider. Direction is never inferred from adjacency. */
export interface Dependency {
  readonly consumer: ArtifactRef;
  readonly provider: ArtifactRef;
  readonly relation: "reads" | "calls" | "implements" | "tests" | "generated-from" | "documents";
  readonly evidence: readonly EvidenceId[];
  readonly discoveredBy: AgentId;
  readonly status: "supported" | "suspect" | "retired";
}

export interface ChangedEvent {
  readonly eventId: string;
  readonly runId: RunId;
  readonly kind: "changed";
  readonly artifactId: ArtifactId;
  readonly fromVersion: Version;
  readonly toVersion: Version;
  readonly causeId: string;
  readonly evidence: readonly EvidenceId[];
}

export interface Obligation {
  readonly obligationId: string;
  readonly eventId: string;
  readonly runId: RunId;
  readonly consumer: ArtifactId;
  readonly contractVersion: Version;
  readonly state: "pending" | "running" | "discharged";
}

export type Receipt = {
  readonly obligationId: string;
  readonly agentId: AgentId;
  readonly subject: ArtifactRef;
} & (
  | { readonly state: "seen" }
  | {
      readonly state: "handled" | "ignored";
      readonly reason: string;
      readonly evidence: readonly EvidenceId[];
    }
);

/** Advisory reservations never grant write authority. */
export interface WorkClaim {
  readonly kind: "work-claim";
  readonly artifactId: ArtifactId;
  readonly holder: AgentId;
  readonly expiresAt: number;
}

export interface AuthorityLease {
  readonly kind: "authority-lease";
  readonly leaseId: string;
  readonly role: "writer" | "reviewer" | "coordinator";
  readonly scope: readonly ArtifactId[];
  readonly holder: AgentId;
  readonly expiresAt: number;
  readonly epoch: number;
}

export interface EpistemicClaim {
  readonly claimId: string;
  readonly runId: RunId;
  readonly subject: ArtifactRef;
  readonly proposition: string;
  readonly observed: readonly EvidenceId[];
  readonly assumptions: readonly string[];
  readonly missingEvidence: readonly string[];
  readonly supportSets: readonly (readonly EvidenceId[])[];
  readonly blocking: boolean;
  readonly status: "open" | "supported" | "contested" | "superseded";
}

export interface Proposal {
  readonly proposalId: string;
  readonly runId: RunId;
  readonly author: AgentId;
  readonly baseSnapshot: Version;
  readonly readSet: readonly ArtifactRef[];
  readonly writes: readonly {
    readonly base: ArtifactRef;
    readonly patchRef: string;
  }[];
  readonly evidence: readonly EvidenceId[];
  readonly authority: readonly {
    readonly leaseId: string;
    readonly epoch: number;
  }[];
}

export interface Validation {
  readonly validationId: EvidenceId;
  readonly snapshot: Version;
  readonly acceptanceVersion: Version;
  readonly environmentVersion: Version;
  readonly result: "pass" | "fail";
  readonly evidenceRef: string;
}

/** Completion is a kernel decision; no public setDone() operation is defined. */
export interface Run {
  readonly runId: RunId;
  readonly objective: string;
  readonly scope: readonly ArtifactId[];
  readonly acceptanceVersion: Version;
  readonly inputEpoch: number;
  readonly inputClosed: boolean;
  readonly status: "running" | "blocked" | "failed" | "succeeded";
  readonly externalIntervention: boolean;
}
