import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { callCodex, CodexWorkerError } from "../src/codex-worker.ts";

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

async function withFakeCli(mode: string, fn: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "sheep-fake-codex-"));
  const executable = join(directory, "codex");
  await writeFile(executable, `#!/bin/sh
mode=${mode}
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
if [ "$mode" = success ]; then
  printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5},"model":"gpt-5.6-luna"}'
  printf '%s' '{"ok":true}' > "$out"
  exit 0
fi
if [ "$mode" = malformed ]; then printf '%s\\n' 'not-json'; exit 0; fi
if [ "$mode" = missing ]; then exit 0; fi
if [ "$mode" = nooutput ]; then
  printf '%s\\n' '{"type":"turn.completed"}'
  exit 0
fi
if [ "$mode" = recovered ]; then
  printf '%s\\n' '{"type":"error","message":"WebSocket disconnected; reconnecting"}'
  printf '%s\\n' '{"type":"error","message":"Falling back to HTTPS"}'
  printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":19000,"output_tokens":220}}'
  printf '%s' '{"ok":true}' > "$out"
  exit 0
fi
if [ "$mode" = latefailure ]; then
  printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":2}}'
  printf '%s\\n' '{"type":"turn.failed","error":{"message":"final failure"}}'
  printf '%s' '{"ok":true}' > "$out"
  exit 0
fi
if [ "$mode" = arraybad ]; then
  printf '%s\\n' '{"type":"turn.completed"}'
  printf '%s' '{"ok":true}' > "$out"
  exit 0
fi
if [ "$mode" = modelmismatch ]; then
  printf '%s\\n' '{"type":"turn.completed","model":"gpt-5.6-luna"}'
  printf '%s\\n' '{"type":"item.completed","model":"other-model"}'
  printf '%s' '{"ok":true}' > "$out"
  exit 0
fi
if [ "$mode" = usageunknown ]; then
  printf '%s\\n' '{"type":"turn.completed","usage":{"cache_read":0}}'
  printf '%s' '{"ok":true}' > "$out"
  exit 0
fi
if [ "$mode" = stdouthuge ]; then
  head -c 5000000 /dev/zero
  printf '%s' '{"ok":true}' > "$out"
  exit 0
fi
if [ "$mode" = invalid ]; then
  printf '%s\\n' '{"type":"turn.completed"}'
  printf '%s' '{"ok":"bad"}' > "$out"
  exit 0
fi
if [ "$mode" = huge ]; then
  printf '%s\\n' '{"type":"turn.completed"}'
  head -c 5000000 /dev/zero > "$out"
  exit 0
fi
if [ "$mode" = slow ]; then sleep 10; exit 0; fi
printf '%s\\n' 'fake failure' >&2
exit 17
`, "utf8");
  await chmod(executable, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${directory}:${oldPath ?? ""}`;
  process.env.SHEEP_FAKE_MODE = mode;
  try { await fn(); } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    delete process.env.SHEEP_FAKE_MODE;
    await rm(directory, { recursive: true, force: true });
  }
}

function options(timeoutMs = 2_000) {
  return { model: "gpt-5.6-luna", prompt: "Return the requested object.", schema, cwd: process.cwd(), timeoutMs };
}

test("adapter uses argv/stdin and returns parsed output plus usage/transcript", async () => {
  await withFakeCli("success", async () => {
    const response = await callCodex<{ ok: boolean }>(options());
    assert.deepEqual(response.result, { ok: true });
    assert.equal(response.requestedModel, "gpt-5.6-luna");
    assert.equal(response.usage[0]?.inputTokens, 3);
    assert.equal(response.usage[0]?.outputTokens, 2);
    assert.equal(response.transcript.effectiveModelEvidence, "gpt-5.6-luna");
    assert.equal(response.transcript.exitCode, 0);
  });
});

test("a recovered transport error keeps its successful output and metered usage; a later failure still rejects", async () => {
  await withFakeCli("recovered", async () => {
    const result = await callCodex<{ ok: boolean }>(options());
    assert.equal(result.result.ok, true);
    assert.equal(result.usage[0]?.inputTokens, 19000);
    assert.equal(result.transcript.events.filter(event => event.type === "error").length, 2);
  });
  await withFakeCli("latefailure", async () => {
    await assert.rejects(callCodex(options()), (error: unknown) => error instanceof CodexWorkerError && error.code === "nonzero-exit");
  });
});

test("nonzero, malformed, and missing final output remain distinct failures", async () => {
  await withFakeCli("failure", async () => {
    await assert.rejects(callCodex(options()), (error: unknown) => error instanceof CodexWorkerError && error.code === "nonzero-exit" && error.transcript.stderr.includes("fake failure"));
  });
  await withFakeCli("malformed", async () => {
    await assert.rejects(callCodex(options()), (error: unknown) => error instanceof CodexWorkerError && error.code === "malformed-events");
  });
  await withFakeCli("missing", async () => {
    await assert.rejects(callCodex(options()), (error: unknown) => error instanceof CodexWorkerError && error.code === "malformed-events");
  });
});

test("missing effective model evidence stays null", async () => {
  await withFakeCli("invalid", async () => {
    await assert.rejects(callCodex(options()), (error: unknown) => error instanceof CodexWorkerError && error.transcript.effectiveModelEvidence === null);
  });
});

test("rejects unsupported schemas and bounds final output before reading it", async () => {
  await assert.rejects(callCodex({ ...options(), schema: { type: "object", minLength: 1 } }), (error: unknown) => error instanceof RangeError);
  await withFakeCli("huge", async () => {
    await assert.rejects(callCodex(options()), (error: unknown) => error instanceof CodexWorkerError && error.code === "output-too-large");
  });
});

test("checks completed event, array items, and every model identity", async () => {
  await withFakeCli("nooutput", async () => {
    await assert.rejects(callCodex(options()), (error: unknown) => error instanceof CodexWorkerError && error.code === "missing-output");
  });
  await withFakeCli("modelmismatch", async () => {
    await assert.rejects(callCodex(options()), (error: unknown) => error instanceof CodexWorkerError && error.code === "malformed-events");
  });
  await withFakeCli("arraybad", async () => {
    await assert.rejects(callCodex({ ...options(), schema: { type: "array", items: { type: "boolean" } } }), (error: unknown) => error instanceof CodexWorkerError && error.code === "malformed-output");
  });
});

test("unknown usage remains an unavailable empty usage list and stdout overflow fails", async () => {
  await withFakeCli("usageunknown", async () => {
    const result = await callCodex(options());
    assert.deepEqual(result.usage, []);
  });
  await withFakeCli("stdouthuge", async () => {
    await assert.rejects(callCodex(options()), (error: unknown) => error instanceof CodexWorkerError && error.code === "output-too-large");
  });
});

test("required names use own properties and do not accept inherited toString", async () => {
  await withFakeCli("usageunknown", async () => {
    await assert.rejects(callCodex({ ...options(), schema: { type: "object", properties: {}, required: ["toString"], additionalProperties: false } }), (error: unknown) => error instanceof CodexWorkerError && error.code === "malformed-output");
  });
});

test("timeout and cancellation terminate the spawned process", async () => {
  await withFakeCli("slow", async () => {
    await assert.rejects(callCodex(options(30)), (error: unknown) => error instanceof CodexWorkerError && error.code === "timeout" && error.transcript.timedOut);
    const controller = new AbortController();
    const pending = callCodex({ ...options(2_000), signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof CodexWorkerError && error.code === "cancelled" && error.transcript.cancelled);
  });
});
