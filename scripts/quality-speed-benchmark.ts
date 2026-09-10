import {runQualitySpeedBenchmark} from '../experiments/quality-speed-benchmark.ts';
if(process.argv.length<3||process.argv.length>4)throw new Error('Usage: node scripts/quality-speed-benchmark.ts NEW_OUTPUT_DIRECTORY [COMPLETED_PRIOR_SERIES_JSON]');
await runQualitySpeedBenchmark(process.argv[2]!,process.argv[3]);
