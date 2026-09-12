import {runUpstreamRecoveryBenchmark} from '../experiments/upstream-recovery-benchmark.ts';
if(process.argv.length!==3)throw new Error('usage: node scripts/upstream-recovery-benchmark.ts NEW_OUTPUT');
await runUpstreamRecoveryBenchmark(process.argv[2]!);
