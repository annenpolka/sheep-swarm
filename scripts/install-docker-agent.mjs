import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Release checksums published by docker/docker-agent, 2026-09-09.
export const version = "v1.137.0";
export const checksums = {
  "darwin-arm64": "e34a5f25af2216ff71bd06145506a6cf06b6d274eb64a8197f4dc5683911be72",
  "darwin-amd64": "9c8a3bb955e7f6181562888d632e7a5a68d44ce7d3a91593a1bcf0b82d03ace0",
  "linux-arm64": "1ba05cf2f89dbf2c86e8b6749d22225d22a5067031c9ec17794e57ffe4d46af8",
  "linux-amd64": "d7439569a0bd5940221c1201cc691188ee1a263ba62a5b43a19015b646db3d42",
};
const directory = fileURLToPath(new URL("../.sheep/tools/", import.meta.url));
const arch = process.arch === "x64" ? "amd64" : process.arch;
if (process.argv.slice(2).some((arg) => arg !== "--user-plugin")) throw new Error("Usage: node scripts/install-docker-agent.mjs [--user-plugin]");
for (const platform of new Set([`${process.platform}-${arch}`, `linux-${arch}`])) {
  const expected = checksums[platform];
  if (!expected) throw new Error(`Unsupported platform: ${platform}`);
  await mkdir(directory, { recursive: true });
  const destination = join(directory, `docker-agent-${platform}-${version}`);
  let bytes;
  try { bytes = await readFile(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== expected) {
    const url = `https://github.com/docker/docker-agent/releases/download/${version}/docker-agent-${platform}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`Checksum mismatch: ${platform}`);
    await writeFile(`${destination}.part`, bytes, { mode: 0o755 });
    await rename(`${destination}.part`, destination);
  }
  await chmod(destination, 0o755);
  console.log(`${destination} sha256:${expected}`);
}
if (process.argv.includes("--user-plugin")) {
  const pluginDir = join(homedir(), ".docker", "cli-plugins");
  await mkdir(pluginDir, { recursive: true });
  const plugin = join(pluginDir, "docker-agent");
  const source = join(directory, `docker-agent-${process.platform}-${arch}-${version}`);
  const expected = checksums[`${process.platform}-${arch}`];
  let same = false;
  try { same = createHash("sha256").update(await readFile(plugin)).digest("hex") === expected; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!same) {
    let exists = false;
    try { await lstat(plugin); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    const backupDirectory = join(homedir(), ".docker", "sheep-swarm-backups");
    await mkdir(backupDirectory, { recursive: true });
    const backup = join(backupDirectory, "docker-agent");
    if (exists) {
      try { await lstat(backup); throw new Error(`Backup already exists: ${backup}; inspect before replacing plugin`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await copyFile(source, `${plugin}.part`); await chmod(`${plugin}.part`, 0o755);
    if (exists) await rename(plugin, backup);
    await rename(`${plugin}.part`, plugin);
  }
  console.log(`Installed Docker CLI plugin: ${plugin}`);
}
