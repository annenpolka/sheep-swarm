import {runPublicProbeBenchmark} from '../experiments/public-probe-benchmark.ts';
if(process.argv.length!==3)throw new Error('usage: node scripts/public-probe-benchmark.ts NEW_OUTPUT');
const result=await runPublicProbeBenchmark(process.argv[2]!);if(result.stopReason)process.exitCode=1;
