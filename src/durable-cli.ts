import {runCli} from './cli-commands.ts';
await runCli('durable',process.argv.slice(2),true);
