import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const repo = resolve(new URL("../../..", import.meta.url).pathname);
const evidenceDirectory = resolve(repo, ".sheep/skill-eval/holdout-go-invalid");
const outputDirectory = resolve(evidenceDirectory, "run");
await mkdir(evidenceDirectory, { recursive: true });

let requests = 0;
const server = createServer((request, response) => {
  requests += 1;
  request.resume();
  response.statusCode = 500;
  response.end("unexpected request");
});
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen({ port: 0, host: "127.0.0.1" }, resolvePromise);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("loopback server did not expose a port");

const args = [
  "run", "mechanism", "--",
  "--runtime", "opencode-go", "--worker-model", "gpt-5.6-luna",
  "--family", "semantic", "--method", "sheep",
  "--groups", "1", "--workers", "2", "--concurrency", "1",
  "--budget-mode", "credits", "--max-credits", "1",
  "--max-calls", "12", "--max-meta-calls", "0",
  "--max-tokens-per-call", "4096", "--timeout-ms", "90000",
  "--output", outputDirectory,
];
const command = `npm ${args.map((arg) => JSON.stringify(arg)).join(" ")}`;
const child = spawn("npm", args, {
  cwd: repo,
  env: {
    ...process.env,
    OPENCODE_GO_API_KEY: "dummy-go-key",
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${address.port}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolvePromise({ code, signal }));
});
await new Promise((resolvePromise) => server.close(resolvePromise));

const evidence = {
  command,
  cwd: repo,
  loopbackUrl: `http://127.0.0.1:${address.port}`,
  credentials: "OPENCODE_GO_API_KEY=dummy-go-key",
  exitCode: exitCode.code,
  signal: exitCode.signal,
  requests,
  stdout,
  stderr,
  outputDirectory,
};
await writeFile(resolve(evidenceDirectory, "probe-result.json"), `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
if (exitCode.code === 0 || requests !== 0) process.exitCode = 1;
