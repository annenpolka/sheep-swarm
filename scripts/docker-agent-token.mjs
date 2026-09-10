// Host-only credential resolver for `sbx secret set-custom --command`.
// Never run this interactively: stdout is consumed ONLY by the sbx secret proxy.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

try {
  const file = process.env.SHEEP_CODEX_AUTH_FILE ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  const auth = JSON.parse(await readFile(file, "utf8"));
  const token = auth.tokens?.access_token;
  if (typeof token !== "string" || !token) throw new Error("missing token");
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() + 60_000) throw new Error("expired token");
  // This helper never refreshes or rewrites Codex credentials. Codex owns refresh.
  process.stdout.write(token);
} catch {
  process.stderr.write("An unexpired Codex ChatGPT sign-in is required; refresh it through Codex.\n");
  process.exitCode = 1;
}
