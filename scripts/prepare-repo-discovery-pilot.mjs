import {mkdir,cp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
const {values}=parseArgs({options:{output:{type:'string'},mode:{type:'string',default:'static+reads'}}});
if(!values.output||!['static','static+reads'].includes(values.mode))throw new Error('Required --output NEW_DIRECTORY [--mode static|static+reads]');
const root=resolve(values.output);await mkdir(root,{recursive:false});
const repo=join(root,'repo');const fixture=fileURLToPath(new URL('../tests/fixtures/repo-discovery/',import.meta.url));
await cp(join(fixture,'baseline'),repo,{recursive:true});await cp(join(fixture,'check.mjs'),join(repo,'check.mjs'));
execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'add','.']);
execFileSync('git',['-C',repo,'-c','user.name=Sheep fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixed baseline']);
const task={version:2,goal:'Implement the three assigned exports using the published business policy. Preserve the assigned contracts.',
  files:[{path:'pricing.mjs',instructions:'Implement quote(units). For nonnegative safe integers, clamp units to the policy minimum and cap, then multiply by rate. Other inputs return null. Request registry.json to locate the pricing policy, then request that policy before writing. Do not guess policy values.'},
    {path:'label.mjs',instructions:'Implement label(units): exactly numeric 1 gives item; every other value gives items.'},
    {path:'summary.mjs',instructions:'Implement summary(units): use quote and label from the two imported modules. Return null when quote returns null, otherwise {units,total,label}, with total from quote and label from label.'}],
  context:[],protected:['check.mjs'],checks:[{argv:[process.execPath,'check.mjs'],timeoutMs:10000}],
  discovery:{mode:values.mode,readable:['registry.json','policies/retail.json','unrelated.json'],maxReadCalls:2,maxDeliveredBytes:65536}};
await writeFile(join(root,'task.json'),JSON.stringify(task,null,2)+'\n');
process.stdout.write(JSON.stringify({repository:repo,task:join(root,'task.json'),mode:values.mode})+'\n');
