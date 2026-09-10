import { recoverOwnedSandboxes } from "../src/sandbox-ownership.ts";
const entries = await recoverOwnedSandboxes();
console.log(JSON.stringify({ entries }, null, 2));
if (entries.some(entry => entry.action === "refused")) process.exitCode = 1;
