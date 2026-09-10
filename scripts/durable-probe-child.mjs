import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

const [source, directory, boundary, fault] = process.argv.slice(2);
if (!source || !directory || !boundary || !fault) throw new Error("source, directory, boundary and fault required");
const { runDurableSwarm } = await import(pathToFileURL(join(source, "src/durable-run.ts")).href);
await runDurableSwarm({ directory, size: 4, workers: 4, maxCalls: 24, maxMetaCalls: 2, timeoutMs: 90000, fault,
  checkpoint: async (name, details) => {
    if (name !== boundary) return;
    await writeFile(join(directory, "interrupt-marker.json"), JSON.stringify({ name, details, timestamp: Date.now() }) + "\n");
    await new Promise(() => { setInterval(() => {}, 1000); });
  },
});
