import {runContractQualityBenchmark} from '../experiments/contract-quality-benchmark.ts';
if(process.argv.length!==3)throw new Error('usage: node scripts/contract-quality-benchmark.ts NEW_OUTPUT');
await runContractQualityBenchmark(process.argv[2]!);
