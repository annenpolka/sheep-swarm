import { capture, type Capture } from "./sandbox-process.ts";
export { capture, type Capture } from "./sandbox-process.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { ownSandbox, recoverBeforeSandboxStart } from "./sandbox-ownership.ts";
import { assertSupportedSchema, conforms, CodexWorkerError,
  type CodexCallOptions, type CodexCallResult, type CodexTranscript, type CodexUsage } from "./codex-worker.ts";

export const DOCKER_AGENT_VERSION = "v1.137.0";
export const SBX_VERSION = "v0.42.1";
export const SANDBOX_TEMPLATE = "docker/sandbox-templates:docker-agent@sha256:70b4bd213f644ec0e0d11621af84b26f406f6dc4155a0bf7dbefdc9d3c735de0";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LIMIT = 4 * 1024 * 1024;
const WORK = "/home/agent/workspace";
const CONTROL = "/tmp/sheep-control";
const PLACEHOLDER = "sheep-chatgpt-proxy"; // Not a credential.
const HASHES: Record<string, string> = {
  arm64: "1ba05cf2f89dbf2c86e8b6749d22225d22a5067031c9ec17794e57ffe4d46af8",
  amd64: "d7439569a0bd5940221c1201cc691188ee1a263ba62a5b43a19015b646db3d42",
};

export interface DockerAgentOptions extends CodexCallOptions {
  /** Explicit file contents, never a recursive copy of cwd or a Git checkout. */
  readonly files?: Readonly<Record<string, string>>;
  readonly tools?: "none" | "local";
  readonly maxTokens?: number;
}
export interface DockerTranscript extends CodexTranscript {
  runtime: "docker-agent"; runtimeVersion: string; sandboxVersion: string;
  runtimeSha256: string;
  sandbox: string; template: string; receiptDirectory: string;
  cleanupSucceeded: boolean; workspaceChanges: Record<string, string | null>;
  lifecycle: { command: string; result: Capture }[];
  configuredModelEvidence: string | null;
  usageCompleteness: "complete" | "partial-or-unknown";
}


function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

/** Sum per-message usage, never budget_usage or the context-length snapshot. */
export function parseDockerEvents(stdout: string, model: string): {
  events: Record<string, unknown>[]; usage: CodexUsage[]; output: string;
  effectiveModelEvidence: null; configuredModelEvidence: string | null; problem: string | null;
} {
  const events: Record<string, unknown>[] = [];
  let problem: string | null = null;
  for (const line of stdout.split(/\r?\n/).filter((s) => s.trim())) {
    try { const event = record(JSON.parse(line)); if (!event || typeof event.type !== "string") throw new Error(); events.push(event); }
    catch { problem = "Malformed Docker Agent NDJSON"; }
  }
  const sessions = new Set(events.map((e) => e.session_id).filter((id) => typeof id === "string" && id));
  if (sessions.size !== 1) problem = "Expected exactly one fresh session";
  if (events.some((e) => typeof e.agent_name === "string" && e.agent_name !== "" && e.agent_name !== "sheep")) problem = "Unexpected agent delegation";
  const identities: string[] = [];
  for (const event of events) {
    // agent_info is requested configuration, not effective-model evidence.
    const last = record(record(event.usage)?.last_message);
    if (event.type === "token_usage" && typeof last?.Model === "string") identities.push(last.Model);
  }
  if (identities.some((id) => id !== model && id !== `chatgpt/${model}`)) problem = "Returned model differs from requested model";
  const stop = events.findLast((e) => e.type === "stream_stopped");
  if (!stop || stop.reason !== "normal") problem = `No normal stream completion (${String(stop?.reason)})`;
  const starts = events.filter((e) => e.type === "stream_started");
  const stops = events.filter((e) => e.type === "stream_stopped");
  if (starts.length !== 1 || stops.length !== 1 || events.indexOf(starts[0]!) > events.indexOf(stops[0]!))
    problem = "Expected exactly one completed stream";
  if (events.some((e) => e.type === "budget_exceeded")) problem = "Docker Agent budget exceeded";
  if (events.some((e) => e.type === "error")) problem = "Docker Agent error event";
  const usage: CodexUsage[] = [];
  const seen = new Set<string>();
  for (const event of events.filter((e) => e.type === "token_usage")) {
    const raw = record(record(event.usage)?.last_message);
    if (!raw || !count(raw.input_tokens) || !count(raw.output_tokens) || !count(raw.cached_input_tokens) || !count(raw.cached_write_tokens)) {
      problem = "Incomplete per-message usage"; continue;
    }
    // An identical event replay is not a second model generation. Different timestamps remain distinct.
    const key = JSON.stringify(event);
    if (seen.has(key)) { problem = "Duplicate usage event"; continue; }
    seen.add(key);
    const inputTokens = raw.input_tokens + raw.cached_input_tokens + raw.cached_write_tokens;
    usage.push({ event, inputTokens, outputTokens: raw.output_tokens, totalTokens: inputTokens + raw.output_tokens });
  }
  // Tool-mode final JSON arrives through the validated internal tool response, not agent_choice.
  const structured = events.findLast((e) => e.type === "tool_call_response" && record(e.tool_definition)?.name === "__structured_output__" && record(e.result)?.isError !== true);
  const output = structured && typeof structured.response === "string" ? structured.response
    : events.filter((e) => e.type === "agent_choice").map((e) => typeof e.content === "string" ? e.content : "").join("");
  // v1.137.0 loop.go derives last_message.Model from model.ID(), i.e. runtime configuration.
  // It is NOT evidence of the provider's actual serving model.
  return { events, usage, output, effectiveModelEvidence: null, configuredModelEvidence: identities.at(-1) ?? null, problem };
}

export function validateFiles(files: Readonly<Record<string, string>>): void {
  if (!record(files)) throw new Error("Expected a local file map");
  let bytes = 0;
  if (Object.keys(files).length > 128) throw new Error("Too many local files");
  for (const [path, contents] of Object.entries(files)) {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path) || posix.normalize(path) !== path || path.split("/").some((part) => part.startsWith(".")))
      throw new Error(`Unsafe local path: ${path}`);
    if (typeof contents !== "string") throw new Error("Expected file text");
    bytes += Buffer.byteLength(contents);
  }
  if (bytes > LIMIT) throw new Error("Local context exceeds 4 MiB");
}

export function dockerAgentConfig(options: DockerAgentOptions): Record<string, unknown> {
  const local = options.tools === "local";
  return {
    version: "15", models: { requested: { provider: "chatgpt", model: options.model, thinking_budget: "low" } },
    agents: { sheep: {
      model: "requested", instruction: "You are one artifact-local worker. Use only the supplied context and workspace. No delegation or manager conversation. Return the requested JSON. Private tests are feedback, not authority to commit.",
      skills: false, add_prompt_files: [], max_iterations: local ? 12 : 2,
      toolsets: local ? [
        { type: "filesystem", tools: ["read_file", "read_multiple_files", "list_directory", "search_files_content", "write_file", "edit_file"], allow_list: [WORK] },
        { type: "script", shell: { check_local: { description: "Run the provided local feedback tests", cmd: "node --test visible.test.mjs", working_dir: WORK } } },
      ] : [],
      structured_output: { name: "sheep_result", strict: true, mode: local ? "tool" : "native", schema: options.schema },
    } },
    budget: { max_tokens: options.maxTokens ?? 30_000, max_time: `${options.timeoutMs}ms` },
    permissions: { allow: ["read_file", "read_multiple_files", "list_directory", "search_files_content", "write_file", "edit_file", "check_local", "__structured_output__"] },
    runtime: { safety: "restricted" },
  };
}

const importFiles = `import sys,json,pathlib
root=pathlib.Path('${WORK}')
root.mkdir(parents=True,exist_ok=True)
for name,text in json.load(sys.stdin).items():
 p=root/name
 p.parent.mkdir(parents=True,exist_ok=True)
 p.write_text(text)
`;
const exportFiles = `import os,json,pathlib,stat
root=pathlib.Path('${WORK}'); result={}; size=0
for base,dirs,files in os.walk(root,followlinks=False):
 for name in dirs+files:
  p=pathlib.Path(base)/name; s=p.lstat()
  if stat.S_ISLNK(s.st_mode): raise RuntimeError('symlink in export')
  if stat.S_ISDIR(s.st_mode): continue
  if not stat.S_ISREG(s.st_mode): raise RuntimeError('nonregular export')
  size+=s.st_size
  if size>${LIMIT} or len(result)>=128: raise RuntimeError('export too large')
  result[str(p.relative_to(root))]=p.read_text()
print(json.dumps(result))
`;

function shellQuote(text: string): string { return "'" + text.replaceAll("'", "'\\''") + "'"; }

export async function callDockerAgent<T = unknown>(options: DockerAgentOptions): Promise<CodexCallResult<T> & { transcript: DockerTranscript }> {
  assertSupportedSchema(options.schema); validateFiles(options.files ?? {});
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Invalid timeout");
  if (!Number.isSafeInteger(options.maxTokens ?? 30_000) || (options.maxTokens ?? 30_000) < 1) throw new Error("Invalid token budget");
  if (!["gpt-5.6-luna", "gpt-6-astra"].includes(options.model)) throw new Error("Unsupported experiment model");
  const started = Date.now();
  const parent = options.outputDirectory ?? join(ROOT, ".sheep", "docker-agent-calls");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "sheep-docker-call-"));
  const name = `sheep-${randomUUID()}`;
  const transcript: DockerTranscript = {
    runtime: "docker-agent", runtimeVersion: DOCKER_AGENT_VERSION, runtimeSha256: "", sandboxVersion: SBX_VERSION,
    sandbox: name, template: SANDBOX_TEMPLATE, receiptDirectory: directory, cleanupSucceeded: false,
    workspaceChanges: Object.create(null) as Record<string, string | null>, lifecycle: [], configuredModelEvidence: null, usageCompleteness: "partial-or-unknown", events: [], usage: [], requestedModel: options.model,
    effectiveModelEvidence: null, stdout: "", stderr: "", exitCode: null, signal: null,
    timedOut: false, cancelled: false, durationMs: 0,
  };
  let attemptedCreate = false, failure: unknown, result: T | undefined;
  let owner: Awaited<ReturnType<typeof ownSandbox>> | undefined;
  const run = async (args: string[], input?: string, timeoutMs = 120_000): Promise<Capture> => {
    if (options.signal?.aborted) { Object.assign(transcript, { cancelled: true }); throw new Error("cancelled before sandbox operation"); }
    const output = await capture("sbx", args, { timeoutMs, ...(input === undefined ? {} : { input }), ...(options.signal ? { signal: options.signal } : {}) });
    transcript.lifecycle.push({ command: args.slice(0, 3).join(" "), result: output });
    if (output.cancelled) Object.assign(transcript, { cancelled: true });
    if (output.timedOut) Object.assign(transcript, { timedOut: true });
    if (output.exitCode !== 0 || output.tooLarge || output.timedOut || output.cancelled) throw new Error(`sbx ${args[0]} failed: ${output.stderr.slice(0, 1500)}`);
    return output;
  };
  try {
    const version = await run(["version"]);
    if (!version.stdout.includes(`sbx version: ${SBX_VERSION} `)) throw new Error("Install the pinned sbx version before running");
    const ssh = await run(["settings", "get", "ssh.agentForwardingEnabled"]);
    if (ssh.stdout.trim() !== "false") throw new Error("Disable SSH forwarding with sbx settings set ssh.agentForwardingEnabled false and restart its daemon");
    const mcp = JSON.parse((await run(["mcp", "ls", "--json"])).stdout);
    if (!Array.isArray(mcp.servers) || mcp.servers.length) throw new Error("This isolated profile requires an empty sbx MCP registry");
    const arch = process.arch === "x64" ? "amd64" : process.arch;
    const binary = join(ROOT, ".sheep", "tools", `docker-agent-linux-${arch}-${DOCKER_AGENT_VERSION}`);
    const bytes = await readFile(binary);
    if (createHash("sha256").update(bytes).digest("hex") !== HASHES[arch]) throw new Error("Docker Agent binary hash mismatch; run npm run sandbox:install");
    transcript.runtimeSha256 = HASHES[arch]!;
    await recoverBeforeSandboxStart();
    owner = await ownSandbox(name, SANDBOX_TEMPLATE);
    attemptedCreate = true;
    await run(["create", "--name", name, "--cpus", "2", "--memory", "4g", "--deny-network", "**", "--template", SANDBOX_TEMPLATE, "docker-agent"]);
    // No workspace argument, no kits, no host Docker socket, no user config.
    const inspect = JSON.parse((await run(["inspect", name, "--json"])).stdout);
    if (inspect.workspace || inspect.workspaces?.length || inspect.kits?.length || inspect.daemon_version !== SBX_VERSION) throw new Error("Unexpected sandbox identity or workspace mounts");
    const policies = JSON.parse((await run(["policy", "ls", name, "--json"])).stdout);
    for (const rule of policies.rules ?? []) if (rule.resource_type === "network" && rule.decision === "allow" && rule.status === "active")
      throw new Error("Existing network allow rules would broaden this sandbox; a dedicated deny-default policy is required");
    await run(["exec", name, "mkdir", "-p", CONTROL, WORK]);
    await run(["cp", binary, `${name}:${CONTROL}/docker-agent`]);
    const guestHash = (await run(["exec", name, "sha256sum", `${CONTROL}/docker-agent`])).stdout.split(/\s/)[0];
    if (guestHash !== transcript.runtimeSha256) throw new Error("Sandbox binary differs from pinned release");
    await run(["exec", name, "python3", "-c", "import os,pathlib; assert not pathlib.Path(os.getenv('SSH_AUTH_SOCK','/__absent__')).exists(); assert not pathlib.Path('/Users').exists()"]);
    const configFile = join(directory, "agent.yaml");
    await writeFile(configFile, JSON.stringify(dockerAgentConfig(options), null, 2) + "\n");
    await writeFile(join(directory, "input-files.json"), JSON.stringify(options.files ?? {}) + "\n");
    await run(["cp", configFile, `${name}:${CONTROL}/agent.yaml`]);
    await run(["exec", name, "chmod", "755", `${CONTROL}/docker-agent`]);
    await run(["exec", "-i", name, "python3", "-c", importFiles], JSON.stringify(options.files ?? {}));
    // The resolver is executed only on the host by sbx. No token is printed or copied here.
    const resolver = `${shellQuote(process.execPath)} ${shellQuote(join(ROOT, "scripts/docker-agent-token.mjs"))}`;
    await run(["secret", "set-custom", "--sandbox", name, "--host", "chatgpt.com", "--env", "CHATGPT_OAUTH_TOKEN", "--placeholder", PLACEHOLDER, "--command", resolver, "--refresh", "on-demand"]);
    await run(["policy", "allow", "network", "--sandbox", name, "chatgpt.com:443"]);
    await run(["policy", "rm", "network", "--sandbox", name, "--resource", "**"]);
    const modelProcess = await capture("sbx", ["exec", "-i", "-w", WORK,
      "-e", `CHATGPT_OAUTH_TOKEN=${PLACEHOLDER}`, "-e", "TELEMETRY_ENABLED=false", "-e", "DOCKER_AGENT_AUTO_UPDATE=false",
      name, `${CONTROL}/docker-agent`, "run", `${CONTROL}/agent.yaml`, "--exec", "--json", "--safety", "restricted",
      "--working-dir", WORK, "--config-dir", `${CONTROL}/config`, "--data-dir", `${CONTROL}/data`, "--cache-dir", `${CONTROL}/cache`,
      "--session-db", `${CONTROL}/session.db`, "-"], {
      timeoutMs: options.timeoutMs, input: options.prompt, ...(options.signal ? { signal: options.signal } : {}),
    });
    const parsed = parseDockerEvents(modelProcess.stdout, options.model);
    Object.assign(transcript, modelProcess, { events: parsed.events, usage: parsed.usage, effectiveModelEvidence: parsed.effectiveModelEvidence, configuredModelEvidence: parsed.configuredModelEvidence, outputLastMessage: parsed.output });
    if (modelProcess.tooLarge) throw new Error("Docker Agent output too large");
    if (modelProcess.exitCode !== 0 || modelProcess.timedOut || modelProcess.cancelled) throw new Error("Docker Agent process failed");
    if (parsed.problem) throw new Error(parsed.problem);
    if (!parsed.usage.length) throw new Error("Missing usage; cost is unknown, not zero");
    transcript.usageCompleteness = "complete";
    result = JSON.parse(parsed.output) as T;
    if (!conforms(result, options.schema)) throw new Error("Docker Agent output violates schema");
    if (options.tools === "local") {
      const files = JSON.parse((await run(["exec", name, "python3", "-c", exportFiles])).stdout) as Record<string, string>;
      validateFiles(files);
      for (const path of new Set([...Object.keys(files), ...Object.keys(options.files ?? {})]))
        if (files[path] !== options.files?.[path]) transcript.workspaceChanges[path] = files[path] ?? null;
    }
  } catch (error) { failure = error; }
  finally {
    if (attemptedCreate) {
      const cleanup = await capture("sbx", ["rm", "--force", name], { timeoutMs: 60_000 });
      transcript.lifecycle.push({ command: `rm --force ${name}`, result: cleanup });
      transcript.cleanupSucceeded = cleanup.exitCode === 0 && !cleanup.timedOut;
      if (!transcript.cleanupSucceeded) {
        const stop = await capture("sbx", ["stop", name], { timeoutMs: 30_000 });
        transcript.lifecycle.push({ command: `stop ${name}`, result: stop });
        failure ??= new Error(`Sandbox cleanup failed: ${name}`);
      } else try { await owner?.release(); } catch (error) { failure ??= error; }
    } else transcript.cleanupSucceeded = true;
    Object.assign(transcript, { durationMs: Date.now() - started });
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ failure: failure ? String(failure) : null, transcript }, null, 2) + "\n");
  }
  if (failure) throw new CodexWorkerError(transcript.cancelled ? "cancelled" : transcript.timedOut ? "timeout" : "nonzero-exit", `Docker Agent: ${String(failure)}; receipt: ${directory}`, transcript, failure);
  return { result: result!, requestedModel: options.model, usage: transcript.usage, transcript };
}

/** Every change reaches kernel scope checks; final-answer text never substitutes for files. */
export function dockerWorkspaceWrites(transcript: CodexTranscript): Record<string, string> {
  const receipt = transcript as Partial<DockerTranscript>;
  if (receipt.runtime !== "docker-agent" || receipt.cleanupSucceeded !== true || receipt.usageCompleteness !== "complete"
    || !receipt.workspaceChanges || typeof receipt.workspaceChanges !== "object" || Array.isArray(receipt.workspaceChanges)) throw new Error("Missing completed Docker workspace receipt");
  if (Object.values(receipt.workspaceChanges).some(value => typeof value !== "string")) throw new Error("Workspace deletions are unsupported");
  const changes = receipt.workspaceChanges as Record<string, string>;
  validateFiles(changes);
  return changes;
}
