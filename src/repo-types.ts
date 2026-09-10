import type { ModelCaller, SwarmReport } from "./swarm.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { TokenBudgetSnapshot } from "./token-budget.ts";

/** Host-authored contract for repository tasks. Commands are supplied by the operator. */
export interface RepoCommand { readonly argv: readonly string[]; readonly timeoutMs: number }
export interface RepoFileTask {
  readonly path: string;
  readonly instructions: string;
  readonly dependsOn: readonly string[];
  readonly checks: readonly RepoCommand[];
}
export interface RepoTask {
  readonly version: 1;
  readonly goal: string;
  readonly files: readonly RepoFileTask[];
  readonly context: readonly string[];
  readonly protected: readonly string[];
  readonly checks: readonly RepoCommand[];
}
export interface RepoEntry { readonly bytes: Buffer; readonly mode: number }
export interface RepoSnapshot {
  readonly root: string;
  readonly head: string;
  readonly task: RepoTask;
  readonly entries: ReadonlyMap<string, RepoEntry>;
  readonly initialTargets: Readonly<Record<string, string>>;
}
export interface RepoCheckResult {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}
export interface RepoVerification {
  readonly ok: boolean;
  /** The host could not execute verification; generated-code retries cannot repair this. */
  readonly executionFailure?: true;
  readonly workspace: string;
  readonly checks: readonly RepoCheckResult[];
  readonly errors: readonly string[];
}
export interface RepoRunOptions {
  readonly repository: string;
  readonly task: unknown;
  readonly outputDirectory: string;
  readonly runtime?: ModelRuntime;
  readonly metaRuntime?: ModelRuntime;
  readonly workerModel?: string;
  readonly metaModel?: string;
  readonly workers?: number;
  readonly concurrency?: number;
  readonly maxCalls?: number;
  readonly maxMetaCalls?: number;
  readonly maxRounds?: number;
  readonly timeoutMs?: number;
  readonly maxTokensPerCall?: number;
  readonly maxTokens?: number;
  readonly reserveTokensPerCall?: number;
  readonly apply?: boolean;
  readonly goThinking?: "enabled" | "disabled";
}
export interface RepoRunReport {
  readonly success: boolean;
  readonly applied: boolean;
  readonly repository: string;
  readonly head: string;
  readonly outputDirectory: string;
  readonly changedPaths: readonly string[];
  readonly budget: TokenBudgetSnapshot;
  readonly swarm: SwarmReport;
  readonly verifications: readonly RepoVerification[];
  readonly errors: readonly string[];
}
export type RepoCaller = ModelCaller;
