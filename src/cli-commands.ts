import {cliHelp,parseCommandArgs,type CommandName} from './cli-options.ts';
import {resolveCliProfile,type ResolvedCliProfile} from './cli-profile.ts';

async function execute(profile:ResolvedCliProfile) {
  const {outputDirectory}=profile;
  switch(profile.command){
    case 'swarm': {
      const { runSwarm }=await import('./swarm.ts');
      const report=await runSwarm(profile.options as import('./swarm.ts').SwarmOptions);
      return {summary:{ outputDirectory, success: report.success, lowerCalls: report.lowerCalls,
  upperCalls: report.upperCalls, interventions: report.interventions, maxActiveWorkers: report.maxActiveWorkers,
  durationMs: report.durationMs, finalErrors: report.finalErrors },report};
    }
    case 'repo': {
      const { runRepository }=await import('./repo-run.ts');
      const report=await runRepository(profile.options as import('./repo-types.ts').RepoRunOptions);
      return {summary:{
    success: report.success, applied: report.applied, repository: report.repository,
    outputDirectory: report.outputDirectory, changedPaths: report.changedPaths,
    lowerCalls: report.swarm.lowerCalls, upperCalls: report.swarm.upperCalls,
    registeredWorkers: report.swarm.registeredWorkers, concurrency: report.swarm.configuration.concurrency,
    maxActiveWorkers: report.swarm.maxActiveWorkers, budget: report.budget, errors: report.errors,
  },report};
    }
    case 'compare': {
      const { runComparison }=await import('./comparison.ts');
      const report=await runComparison(profile.options as import('./comparison.ts').ComparisonOptions);
      return {summary:{ outputDirectory, method: report.method, success: report.success, qualityPass: report.qualityPass,
  lowerCalls: report.lowerCalls, upperCalls: report.upperCalls, budget: report.budget, discovery: report.discovery,
  finalErrors: report.finalErrors, durationMs: report.times.elapsedMs },report};
    }
    case 'durable': {
      const { runDurableSwarm }=await import('./durable-run.ts');
      const report=await runDurableSwarm(profile.options as import('./durable-run.ts').DurableOptions);
      return {summary:{ directory: report.directory, success: report.success, lowerCalls: report.lowerCalls,
  upperCalls: report.upperCalls, unknownCalls: report.unknownCalls, usageUnknownCalls: report.usageUnknownCalls,
  resumes: report.resumes, generation: report.generation, finalErrors: report.finalErrors },report};
    }
    case 'mechanism': {
      const { runMechanism }=await import('./mechanism-run.ts');
      const report=await runMechanism(profile.options as import('./mechanism-run.ts').MechanismOptions);
      return {summary:{ outputDirectory, method: report.method, family: report.family, success: report.success,
  terminationReason: report.terminationReason, lowerCalls: report.lowerCalls, upperCalls: report.upperCalls, interventions: report.interventions, budget: report.budget,
  stages: report.stages, boundaryViolations: report.boundaryViolations, finalErrors: report.finalErrors, durationMs: report.durationMs },report};
    }
  }
}
export async function runCli(command:CommandName,args:readonly string[],legacy=false):Promise<void>{
  let profile:ResolvedCliProfile;
  let format:'json'|'text';
  try {
    const parsed=parseCommandArgs(command,args);format=parsed.format;
    if(parsed.help){process.stdout.write(cliHelp(command));return;}
    profile=await resolveCliProfile(command,parsed.values);
    if(parsed.dryRun){
      process.stdout.write(format==='json'?JSON.stringify({format:1,status:'planned',dryRun:true,...profile},null,2)+'\n':renderProfile(profile));return;
    }
  }catch(error){process.stderr.write(`${String(error)}\n`);process.exitCode=legacy?1:2;return;}
  try {
    const {summary,report}=await execute(profile);
    const result=legacy?summary:{format:1,command,success:report.success,outputDirectory:profile.outputDirectory,
      configuration:profile.configuration,limits:profile.limits,budget:profile.budget,result:summary};
    process.stdout.write(format==='json'?JSON.stringify(result,null,2)+'\n':`${command}: ${report.success?'passed':'failed'}\nEvidence: ${profile.outputDirectory}\n`);
    if(!report.success)process.exitCode=1;
  }catch(error){process.stderr.write(`${String(error)}\n`);process.exitCode=1;}
}
function renderProfile(p:ResolvedCliProfile):string {
  return `${p.command}: dry-run\nRuntime: ${p.configuration.runtime} / ${p.configuration.workerModel}\nMeta: ${p.configuration.metaRuntime} / ${p.configuration.metaModel}\nWorkers: N=${p.configuration.workers}, C=${p.configuration.concurrency}\nLimits: ${JSON.stringify(p.limits)}\nBudget: ${JSON.stringify(p.budget)}\nCapabilities: ${JSON.stringify(p.capabilities)}\nOutput: ${p.outputDirectory}\n`;
}
