import assert from 'node:assert/strict';
import test from 'node:test';
import {summarizeTrials,type TrialMetric} from '../experiments/quality-metrics.ts';
const a:TrialMetric={group:'b',success:true,elapsedMs:20,completionMs:20,calls:2,tokens:100};
test('failed elapsed is excluded from completion, unknown tokens remain unknown, medians are numeric',()=>{
 const rows=[a,{...a,elapsedMs:40,completionMs:40,tokens:300},{...a,success:false,elapsedMs:900,completionMs:null,tokens:null},{...a,group:'a',success:false,elapsedMs:5,completionMs:null}];const before=JSON.stringify(rows);
 assert.deepEqual(summarizeTrials(rows),[{group:'a',runs:1,successes:0,failures:1,medianCompletionMs:null,medianElapsedMs:5,calls:2,knownTokens:100,totalTokens:100,unknownTokenRuns:0},{group:'b',runs:3,successes:2,failures:1,medianCompletionMs:30,medianElapsedMs:40,calls:6,knownTokens:400,totalTokens:null,unknownTokenRuns:1}]);assert.equal(JSON.stringify(rows),before);assert.deepEqual(summarizeTrials([]),[]);
});
test('reject misleading success/completion and invalid numeric observations',()=>{
 for(const patch of [{success:false},{completionMs:null},{completionMs:19},{elapsedMs:-1},{elapsedMs:NaN},{elapsedMs:Infinity},{calls:1.5},{tokens:-1},{tokens:NaN},{tokens:1.5},{group:''}])assert.throws(()=>summarizeTrials([{...a,...patch}]));
 assert.equal(summarizeTrials([{...a,group:'__proto__',elapsedMs:0,completionMs:0,calls:0,tokens:0}])[0]?.totalTokens,0);
});
