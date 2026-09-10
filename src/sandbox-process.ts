import { spawn } from "node:child_process";
const LIMIT = 4 * 1024 * 1024;

export interface Capture {
  stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null;
  timedOut: boolean; cancelled: boolean; tooLarge: boolean;
}
/** Bounded capture; killing an sbx client alone is insufficient: caller must remove its VM. */
export async function capture(command: string, args: string[], options: {
  timeoutMs: number; signal?: AbortSignal; input?: string;
}): Promise<Capture> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "USER", "LANG"]) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(command, args, { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const result: Capture = { stdout: "", stderr: "", exitCode: null, signal: null, timedOut: false, cancelled: false, tooLarge: false };
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const sizes = { stdout: 0, stderr: 0 };
  const kill = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
  for (const name of ["stdout", "stderr"] as const) child[name].on("data", (chunk: Buffer) => {
    sizes[name] += chunk.length;
    if (sizes[name] > LIMIT) { result.tooLarge = true; kill(); } else chunks[name].push(chunk);
  });
  const abort = () => { result.cancelled = true; kill(); };
  const timer = setTimeout(() => { result.timedOut = true; kill(); }, options.timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  child.stdin.on("error", () => {});
  child.on("error", (error) => { result.stderr = error.message; });
  child.stdin.end(options.input);
  await new Promise<void>((resolve) => child.once("close", (code, signal) => { result.exitCode = code; result.signal = signal; resolve(); }));
  clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
  result.stdout = Buffer.concat(chunks.stdout).toString("utf8");
  result.stderr += Buffer.concat(chunks.stderr).toString("utf8");
  return result;
}
