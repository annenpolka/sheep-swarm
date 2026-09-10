import {runCli} from './cli-commands.ts';
await runCli('repo',process.argv.slice(2),true);
