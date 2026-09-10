import {cliHelp,type CommandName} from './cli-options.ts';
import {runCli} from './cli-commands.ts';
const [command,...args]=process.argv.slice(2);
if(command===undefined||command==='--help'||command==='-h'){
  if(args.length){process.stderr.write('Root help accepts no additional arguments\n');process.exitCode=2;}
  else process.stdout.write(cliHelp());
}else if(['repo','swarm','compare','durable','mechanism'].includes(command))await runCli(command as CommandName,args);
else{process.stderr.write(`Unknown command: ${command}\nUse --help for commands.\n`);process.exitCode=2;}
