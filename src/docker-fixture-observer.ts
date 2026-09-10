import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capture, SANDBOX_TEMPLATE, SBX_VERSION, validateFiles, type Capture } from "./docker-agent-worker.ts";
import type { FixtureObserver } from "./fixture.ts";
import { ownSandbox, recoverBeforeSandboxStart } from "./sandbox-ownership.ts";

// No oracle expectations enter this runner. Only explicitly supplied modules can
// be imported. The inner context keeps candidate code away from the output channel;
// the separate microVM is the host isolation boundary, not node:vm alone.
export const ISOLATED_FIXTURE_RUNNER = `import vm from 'node:vm';
import { posix } from 'node:path';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const {files,calls,timeoutMs,imports=[]}=JSON.parse(input);
const context=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
const modules=new Map();
const invalid=new Set();
for(const [id,source] of Object.entries(files)) if(id.endsWith('.mjs')){
 try {modules.set(id,new vm.SourceTextModule(source,{context,identifier:id}));}
 catch {invalid.add(id);}
}
let importError='';
for(const edge of imports){
 const mod=modules.get(edge.consumer);
 const requests=mod?.dependencySpecifiers??[];
 if(!requests.some(specifier=>posix.normalize(posix.join(posix.dirname(edge.consumer),specifier))===edge.provider))
  importError='missing required import: '+edge.consumer+' -> '+edge.provider;
}
const link=(specifier,from)=>{
 if(!specifier.startsWith('./')&&!specifier.startsWith('../')) throw new Error('Only local fixture imports are permitted');
 const id=posix.normalize(posix.join(posix.dirname(from.identifier),specifier));
 if(!modules.has(id)) throw new Error('Import outside supplied context: '+id);
 return modules.get(id);
};
const observations=[];
for(const call of calls){
 if(importError){observations.push({id:call.id,error:importError});continue;}
 try {
  const mod=modules.get(call.id);
  if(!mod||invalid.has(call.id)) throw new Error('Invalid fixture module');
  if(mod.status==='unlinked') await mod.link(link);
  if(mod.status==='linked') await mod.evaluate({timeout:timeoutMs});
  context.__invoke=mod.namespace[call.method];
  // Stringify inside the timed realm, including candidate getters/toJSON.
  const encoded=vm.runInContext('JSON.stringify(__invoke(...'+JSON.stringify(call.args)+'))',context,{timeout:timeoutMs});
  observations.push({id:call.id,output:JSON.parse(encoded)});
 } catch { observations.push({id:call.id,error:'Isolated fixture invocation failed'}); }
}
process.stdout.write(JSON.stringify(observations));
`;

/** Each verification gets a fresh deny-all VM, no model secret, and an audit receipt. */
export function createDockerFixtureObserver(outputDirectory: string): FixtureObserver {
  return async (files, calls, timeoutMs, imports = []) => {
    validateFiles(files);
    const name = `sheep-accept-${randomUUID()}`;
    const directory = join(outputDirectory, name);
    await mkdir(directory, { recursive: true });
    const operations: { operation: string; result: Capture }[] = [];
    let attemptedCreate = false, cleanupSucceeded = false, failure: unknown, observations: unknown;
    let owner: Awaited<ReturnType<typeof ownSandbox>> | undefined;
    const run = async (args: string[], input?: string, timeout = 120_000) => {
      const result = await capture("sbx", args, { timeoutMs: timeout, ...(input === undefined ? {} : { input }) });
      operations.push({ operation: args.slice(0, 3).join(" "), result });
      if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.tooLarge)
        throw new Error(`Sandbox verifier ${args[0]} failed`);
      return result.stdout;
    };
    try {
      if (!(await run(["version"])).includes(`sbx version: ${SBX_VERSION} `)) throw new Error("Pinned sbx required");
      if ((await run(["settings", "get", "ssh.agentForwardingEnabled"])).trim() !== "false") throw new Error("Disable SSH forwarding first");
      const mcp = JSON.parse(await run(["mcp", "ls", "--json"]));
      if (!Array.isArray(mcp.servers) || mcp.servers.length) throw new Error("Empty sbx MCP registry required");
      await recoverBeforeSandboxStart();
      owner = await ownSandbox(name, SANDBOX_TEMPLATE);
      attemptedCreate = true;
      await run(["create", "--name", name, "--cpus", "2", "--memory", "4g", "--deny-network", "**", "--template", SANDBOX_TEMPLATE, "docker-agent"]);
      const inspect = JSON.parse(await run(["inspect", name, "--json"]));
      if (inspect.workspace || inspect.workspaces?.length || inspect.kits?.length || inspect.daemon_version !== SBX_VERSION)
        throw new Error("Unexpected verifier mounts or version");
      const policies = JSON.parse(await run(["policy", "ls", name, "--json"]));
      if (!Array.isArray(policies.rules) || policies.rules.some((rule: Record<string, unknown>) =>
        rule.resource_type === "network" && rule.decision === "allow" && rule.status === "active"))
        throw new Error("Verifier requires deny-all network policy");
      await run(["exec", name, "python3", "-c", "import os,pathlib; assert not pathlib.Path(os.getenv('SSH_AUTH_SOCK','/__absent__')).exists(); assert not pathlib.Path('/Users').exists()"]);
      observations = JSON.parse(await run(["exec", "-i", name, "node", "--experimental-vm-modules", "--max-old-space-size=64", "--input-type=module", "-e", ISOLATED_FIXTURE_RUNNER],
        JSON.stringify({ files, calls, timeoutMs, imports }), timeoutMs + 5000));
    } catch (error) { failure = error; }
    finally {
      if (attemptedCreate) {
        const result = await capture("sbx", ["rm", "--force", name], { timeoutMs: 60_000 });
        operations.push({ operation: `rm --force ${name}`, result });
        cleanupSucceeded = result.exitCode === 0 && !result.timedOut;
        if (!cleanupSucceeded) {
          operations.push({ operation: `stop ${name}`, result: await capture("sbx", ["stop", name], { timeoutMs: 30_000 }) });
          failure ??= new Error(`Verifier cleanup failed: ${name}`);
        } else try { await owner?.release(); } catch (error) { failure ??= error; }
      }
      await writeFile(join(directory, "receipt.json"), JSON.stringify({ name, template: SANDBOX_TEMPLATE,
        inputSha256: createHash("sha256").update(JSON.stringify({ files, calls, imports })).digest("hex"),
        cleanupSucceeded, failure: failure ? String(failure) : null, operations }, null, 2) + "\n");
    }
    if (failure) throw failure;
    return observations;
  };
}
