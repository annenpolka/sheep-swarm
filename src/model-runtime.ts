import { callCodex, type CodexCallResult } from "./codex-worker.ts";
import { callDeepSeek } from "./deepseek-worker.ts";
import { callOpenCodeGo, assertOpenCodeGoModel } from "./opencode-go-worker.ts";
import { callDockerAgent, type DockerAgentOptions, type DockerTranscript } from "./docker-agent-worker.ts";

export const MODEL_RUNTIMES = ["codex", "docker-agent", "deepseek", "opencode-go"] as const;
export type ModelRuntime = typeof MODEL_RUNTIMES[number];
export type WorkerTools = "none" | "local";

const isRuntime = (value: unknown): value is ModelRuntime =>
  typeof value === "string" && (MODEL_RUNTIMES as readonly string[]).includes(value);

export interface RoleRuntimeSelection {
  readonly runtime?: string;
  readonly metaRuntime?: string;
  readonly workerModel?: string;
  readonly metaModel?: string;
  readonly workerTools?: string;
  readonly maxTokensPerCall?: number;
}
export interface ResolvedRoleRuntimes {
  readonly runtime: ModelRuntime;
  readonly metaRuntime: ModelRuntime;
  readonly workerModel: string;
  readonly metaModel: string;
  readonly workerTools: WorkerTools;
  readonly maxTokensPerCall: number;
}

/**
 * Shared per-role runtime/model resolution. Keeps the same validation contract
 * for the swarm, comparison, durable and mechanism runners: codex defaults to
 * the Luna/Astra pair, DeepSeek requires an explicit raw model id for each role
 * that uses it, and local tools only exist on the Docker Agent runtime.
 */
export function resolveRoleRuntimes(selection: RoleRuntimeSelection): ResolvedRoleRuntimes {
  const runtime = selection.runtime ?? "codex";
  if (!isRuntime(runtime)) throw new Error("unknown runtime");
  const wantsWorkerModel = selection.workerModel !== undefined;
  const workerModel = selection.workerModel ?? "gpt-5.6-luna";
  if (runtime === "deepseek") {
    if (!wantsWorkerModel || selection.workerModel!.trim() === "") throw new Error("the DeepSeek runtime requires an explicit --worker-model");
    if (workerModel.includes("/")) throw new Error("the DeepSeek worker model must be a raw API model id without a provider prefix");
  } else if (runtime === "opencode-go") {
    if (!wantsWorkerModel || selection.workerModel!.trim() === "") throw new Error("the OpenCode Go runtime requires an explicit --worker-model");
    assertOpenCodeGoModel(workerModel);
  } else if (workerModel !== "gpt-5.6-luna") {
    throw new Error("real workers must use gpt-5.6-luna");
  }
  if (selection.workerTools !== undefined && selection.workerTools !== "none" && selection.workerTools !== "local")
    throw new Error("Unknown worker tools");
  const workerTools = (selection.workerTools ?? "none") as WorkerTools;
  if (workerTools === "local" && runtime !== "docker-agent") throw new Error("Local tools require the Docker Agent runtime");
  const metaRuntime = selection.metaRuntime ?? (runtime === "deepseek" || runtime === "opencode-go" ? "codex" : runtime);
  if (!isRuntime(metaRuntime)) throw new Error("unknown meta runtime");
  if (metaRuntime === "deepseek") {
    if (selection.metaModel === undefined || selection.metaModel.trim() === "")
      throw new Error("the DeepSeek meta runtime requires an explicit --meta-model");
    if (selection.metaModel === "gpt-6-astra") throw new Error("do not send the Astra model to the DeepSeek runtime");
    if (selection.metaModel.includes("/")) throw new Error("the DeepSeek meta model must be a raw API model id without a provider prefix");
  }
  if (metaRuntime === "opencode-go") {
    if (selection.metaModel === undefined || selection.metaModel.trim() === "")
      throw new Error("the OpenCode Go meta runtime requires an explicit --meta-model");
    assertOpenCodeGoModel(selection.metaModel);
  }
  const maxTokensPerCall = selection.maxTokensPerCall ?? 30_000;
  if (!Number.isSafeInteger(maxTokensPerCall) || maxTokensPerCall < 1) throw new RangeError("token limit must be positive");
  return { runtime, metaRuntime, workerModel, metaModel: selection.metaModel ?? "gpt-6-astra", workerTools, maxTokensPerCall };
}

export type RoleModelCaller<T> = (options: DockerAgentOptions) => Promise<CodexCallResult<T>>;

export function callerForRuntime<T>(runtime: ModelRuntime): RoleModelCaller<T> {
  const caller = runtime === "docker-agent" ? callDockerAgent<T> : runtime === "deepseek" ? callDeepSeek<T> : runtime === "opencode-go" ? callOpenCodeGo<T> : callCodex<T>;
  return caller as unknown as RoleModelCaller<T>;
}

export type UsageCompleteness = "complete" | "partial-or-unknown";

export function usageCompleteness(transcript: unknown): UsageCompleteness | null {
  const value = (transcript as Partial<DockerTranscript> | undefined)?.usageCompleteness;
  return value === "complete" || value === "partial-or-unknown" ? value : null;
}

export function isApiRuntime(runtime: ModelRuntime): boolean {
  return runtime === "deepseek" || runtime === "opencode-go";
}

/** True when either role of a run uses a provider-metered API runtime. */
export function apiRun(runtime: ModelRuntime, metaRuntime: ModelRuntime): boolean {
  return isApiRuntime(runtime) || isApiRuntime(metaRuntime);
}

/**
 * A legacy/Codex receipt is a final total only when the transcript is not a
 * timeout/cancel and its usage is exactly one fully-counted normalized row.
 * Several normalized rows may be interim or cumulative; the offline estimator
 * already calls those ambiguous, so they are never treated as a final total.
 */
function countedFinalUsage(transcript: unknown): boolean {
  const receipt = transcript as { usage?: unknown; timedOut?: unknown; cancelled?: unknown } | undefined;
  if (!receipt || receipt.timedOut === true || receipt.cancelled === true) return false;
  const usage = receipt.usage;
  if (!Array.isArray(usage) || usage.length !== 1) return false;
  const entry = usage[0];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const row = entry as { inputTokens?: unknown; outputTokens?: unknown };
  return typeof row.inputTokens === "number" && Number.isSafeInteger(row.inputTokens) && row.inputTokens >= 0
    && typeof row.outputTokens === "number" && Number.isSafeInteger(row.outputTokens) && row.outputTokens >= 0;
}

/**
 * Failure codes that mean the transcript or terminal execution is incomplete or
 * invalid, so interim counters are lower bounds rather than a final total.
 * Ordinary schema/content failures (missing-output, malformed-output) are not
 * here: a fully metered semantic failure keeps its established semantics.
 */
const INCOMPLETE_TRANSCRIPT_CODES = new Set<string>([
  "spawn-failed", "output-too-large", "malformed-events", "timeout", "cancelled", "nonzero-exit",
]);

/**
 * Fail-closed metering rule for API and mixed runs. An incomplete/invalid
 * transcript or failed terminal execution code locks admission. Explicit
 * timeout/cancel facts override any adapter marker. An explicit adapter
 * completeness value otherwise wins. A legacy/Codex transcript without that
 * field is a known total only when it is a single counted normalized row; an
 * absent receipt is never free. Pure Codex runs keep their legacy behavior.
 */
export function unknownUsageForRun(transcript: unknown, roleRuntime: ModelRuntime, mixed: boolean, errorCode?: string): boolean {
  if (!mixed) return false;
  if (errorCode !== undefined && INCOMPLETE_TRANSCRIPT_CODES.has(errorCode)) return true;
  const terminal = transcript as { timedOut?: unknown; cancelled?: unknown } | undefined;
  if (terminal?.timedOut === true || terminal?.cancelled === true) return true;
  const explicit = usageCompleteness(transcript);
  if (explicit !== null) return explicit === "partial-or-unknown";
  if (isApiRuntime(roleRuntime)) return true;
  return !countedFinalUsage(transcript);
}

export function sumUsage(usage: readonly { readonly inputTokens?: number; readonly outputTokens?: number }[]): {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
} {
  const inputs = usage.map((item) => item.inputTokens).filter((value): value is number => value !== undefined);
  const outputs = usage.map((item) => item.outputTokens).filter((value): value is number => value !== undefined);
  return {
    inputTokens: inputs.length ? inputs.reduce((sum, value) => sum + value, 0) : null,
    outputTokens: outputs.length ? outputs.reduce((sum, value) => sum + value, 0) : null,
  };
}
