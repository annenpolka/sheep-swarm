import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const MAX_STREAM_BYTES = 4 * 1024 * 1024;

export type JsonSchema = Record<string, unknown>;

export interface CodexCallOptions {
  readonly model: string;
  readonly prompt: string;
  readonly schema: JsonSchema;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Stable conversation identifier forwarded to providers that support routing/caching. */
  readonly sessionId?: string;
  /** Host-local evidence correlation; never a model identity or provider session. */
  readonly callId?: string;
  readonly outputDirectory?: string;
}

export interface CodexUsage {
  readonly event: Record<string, unknown>;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface CodexTranscript {
  readonly events: readonly Record<string, unknown>[];
  readonly usage: readonly CodexUsage[];
  readonly requestedModel: string;
  /** Model fields emitted by the CLI, retained as evidence and not asserted as fact. */
  readonly effectiveModelEvidence: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputLastMessage?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
}

export interface CodexCallResult<T = unknown> {
  readonly result: T;
  readonly requestedModel: string;
  readonly usage: readonly CodexUsage[];
  readonly transcript: CodexTranscript;
}

export class CodexWorkerError extends Error {
  readonly code:
    | "spawn-failed"
    | "nonzero-exit"
    | "malformed-events"
    | "missing-output"
    | "malformed-output"
    | "timeout"
    | "cancelled"
    | "output-too-large";
  readonly transcript: CodexTranscript;

  constructor(code: CodexWorkerError["code"], message: string, transcript: CodexTranscript, cause?: unknown) {
    super(message, { cause });
    this.name = "CodexWorkerError";
    this.code = code;
    this.transcript = transcript;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberField(record: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return undefined;
}

function usageFromEvent(event: Record<string, unknown>): CodexUsage | undefined {
  const usage = asRecord(event.usage) ?? (event.type === "usage" ? event : undefined);
  if (!usage) return undefined;
  const inputTokens = numberField(usage, "input_tokens", "inputTokens", "prompt_tokens");
  const outputTokens = numberField(usage, "output_tokens", "outputTokens", "completion_tokens");
  const totalTokens = numberField(usage, "total_tokens", "totalTokens");
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return { event, ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(totalTokens === undefined ? {} : { totalTokens }) };
}

function modelsFromEvent(event: Record<string, unknown>): string[] {
  const models: string[] = [];
  for (const key of ["effective_model", "effectiveModel", "model", "model_name", "modelName"]) {
    const value = event[key];
    if (typeof value === "string" && value.length > 0) models.push(value);
  }
  return models;
}

export function conforms(value: unknown, schema: Record<string, unknown>): boolean {
  const type = schema.type;
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    const required = schema.required;
    if (Array.isArray(required) && required.some((key) => typeof key !== "string" || !Object.hasOwn(object, key))) return false;
    const properties = asRecord(schema.properties);
    if (properties !== undefined) {
      for (const [key, child] of Object.entries(properties)) {
        if (Object.hasOwn(object, key) && asRecord(child) !== undefined && !conforms(object[key], asRecord(child)!)) return false;
      }
    }
    if (schema.additionalProperties === false && (properties === undefined ? Object.keys(object).length > 0 : Object.keys(object).some((key) => !Object.hasOwn(properties, key)))) return false;
    return true;
  }
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") return typeof value === "string";
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isInteger(value));
  if (type === "array") {
    if (!Array.isArray(value)) return false;
    const items = asRecord(schema.items);
    return items === undefined || value.every((item) => conforms(item, items));
  }
  return false;
}

export function assertSupportedSchema(schema: unknown, path = "$ "): asserts schema is Record<string, unknown> {
  const record = asRecord(schema);
  if (record === undefined) throw new RangeError(`Unsupported JSON schema at ${path}`);
  const allowed = new Set(["type", "title", "description", "properties", "required", "additionalProperties", "items"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new RangeError("Unsupported JSON schema keyword at " + path);
  const type = record.type;
  if (type !== "object" && type !== "boolean" && type !== "string" && type !== "number" && type !== "integer" && type !== "array") {
    throw new RangeError(`Unsupported JSON schema type at ${path}`);
  }
  if (type === "object") {
    if (record.required !== undefined && (!Array.isArray(record.required) || record.required.some((key) => typeof key !== "string"))) throw new RangeError(`Invalid required at ${path}`);
    if (record.properties !== undefined) {
      const properties = asRecord(record.properties);
      if (properties === undefined) throw new RangeError(`Invalid properties at ${path}`);
      for (const [key, child] of Object.entries(properties)) assertSupportedSchema(child, `${path}.${key}`);
    }
    if (record.additionalProperties !== undefined && typeof record.additionalProperties !== "boolean") throw new RangeError(`Invalid additionalProperties at ${path}`);
  }
  if (type === "array" && record.items !== undefined) assertSupportedSchema(record.items, `${path}[]`);
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export async function callCodex<T = unknown>(options: CodexCallOptions): Promise<CodexCallResult<T>> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new RangeError("timeoutMs must be a positive integer");
  assertSupportedSchema(options.schema);
  const startedAt = Date.now();
  const ownDirectory = options.outputDirectory === undefined;
  const parentDirectory = options.outputDirectory ?? tmpdir();
  await mkdir(parentDirectory, { recursive: true });
  const directory = await mkdtemp(join(parentDirectory, "sheep-codex-call-"));
  const schemaPath = join(directory, "schema.json");
  const outputPath = join(directory, "output.json");
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let streamTooLarge = false;
  let timedOut = false;
  let cancelled = false;
  let child: ChildProcess;
  try {
    await writeFile(schemaPath, JSON.stringify(options.schema), "utf8");
    const args = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--model", options.model,
      "--sandbox", "read-only", "--skip-git-repo-check", "--output-schema", schemaPath,
      "--output-last-message", outputPath, "-C", options.cwd, "-"];
    child = spawn("codex", args, { cwd: options.cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => { stdoutBytes += chunk.byteLength; if (stdoutBytes <= MAX_STREAM_BYTES) stdoutChunks.push(chunk); else { streamTooLarge = true; killTree(child); } });
    child.stderr?.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (stderrBytes <= MAX_STREAM_BYTES) stderrChunks.push(chunk); else { streamTooLarge = true; killTree(child); } });
    child.stdin?.on("error", () => { /* EPIPE means the CLI exited; preserve its real termination metadata. */ });
    const abort = () => { cancelled = true; killTree(child); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, options.timeoutMs);
    try { child.stdin?.end(options.prompt); } catch { /* closing stdin races with an early CLI exit */ }
    const termination = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>((resolve) => {
      let spawnError: Error | undefined;
      child.once("error", (error: Error) => { spawnError = error; });
      child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => resolve({ exitCode, signal, ...(spawnError === undefined ? {} : { spawnError }) }));
    });
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    let outputLastMessage: string | undefined;
    let outputTooLarge = false;
    try {
      const outputStat = await stat(outputPath);
      if (outputStat.size > MAX_STREAM_BYTES) outputTooLarge = true;
      else outputLastMessage = await readFile(outputPath, "utf8");
    } catch { /* metadata records missing output */ }
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    const events: Record<string, unknown>[] = [];
    let malformedEvents = false;
    for (const line of stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      try {
        const parsed = asRecord(JSON.parse(line));
        if (parsed === undefined) malformedEvents = true;
        else events.push(parsed);
      } catch { malformedEvents = true; }
    }
    const usage = events.flatMap((event) => { const value = usageFromEvent(event); return value === undefined ? [] : [value]; });
    const identities = events.flatMap(modelsFromEvent);
    const evidence = identities[0];
    const transcript: CodexTranscript = {
      events, usage, requestedModel: options.model, effectiveModelEvidence: evidence ?? null,
      stdout, stderr, ...(outputLastMessage === undefined ? {} : { outputLastMessage }),
      exitCode: termination.exitCode, signal: termination.signal, timedOut, cancelled,
      durationMs: Date.now() - startedAt,
    };
    if (streamTooLarge) throw new CodexWorkerError("output-too-large", "Codex CLI output exceeded the bounded capture size", transcript);
    if (outputTooLarge) throw new CodexWorkerError("output-too-large", "Codex final output exceeded the bounded capture size", transcript);
    if (termination.spawnError) throw new CodexWorkerError("spawn-failed", termination.spawnError.message, transcript, termination.spawnError);
    if (cancelled) throw new CodexWorkerError("cancelled", "Codex CLI call was cancelled", transcript);
    if (timedOut) throw new CodexWorkerError("timeout", "Codex CLI timed out", transcript);
    if (termination.exitCode !== 0) throw new CodexWorkerError("nonzero-exit", `Codex CLI exited with ${String(termination.exitCode)}`, transcript);
    if (malformedEvents) throw new CodexWorkerError("malformed-events", "Codex CLI emitted malformed JSONL", transcript);
    // The CLI can emit transport errors while reconnecting, then finish the same turn.
    // A later successful terminal event supersedes those errors; a later failure does not.
    const completedAt = events.findLastIndex((event) => event.type === "turn.completed");
    const failedAt = events.findLastIndex((event) => event.type === "turn.failed" || event.type === "error");
    if (failedAt > completedAt) throw new CodexWorkerError("nonzero-exit", "Codex CLI did not recover from its final error", transcript);
    if (completedAt < 0) throw new CodexWorkerError("malformed-events", "Codex CLI did not emit turn.completed", transcript);
    if (identities.some((identity) => identity !== options.model)) throw new CodexWorkerError("malformed-events", "Codex effective model differs from requested " + options.model, transcript);
    if (outputLastMessage === undefined || outputLastMessage.trim() === "") throw new CodexWorkerError("missing-output", "Codex CLI did not write its final output", transcript);
    let result: T;
    try { result = JSON.parse(outputLastMessage) as T; } catch (cause) { throw new CodexWorkerError("malformed-output", "Codex final output is not valid JSON", transcript, cause); }
    if (!conforms(result, options.schema)) throw new CodexWorkerError("malformed-output", "Codex final output does not match the requested schema", transcript);
    return { result, requestedModel: options.model, usage, transcript };
  } finally {
    if (ownDirectory) await rm(directory, { recursive: true, force: true });
  }
}
