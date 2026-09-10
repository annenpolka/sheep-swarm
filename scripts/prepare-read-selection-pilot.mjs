import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildReadSelectionFixture} from './read-selection-fixture.mjs';
const {values}=parseArgs({options:{output:{type:'string'},seed:{type:'string'},world:{type:'string',default:'0'},documents:{type:'string',default:'24'}}});
if(!values.output||!values.seed)throw new Error('Required: --output NEW_DIRECTORY --seed SEED [--world 0] [--documents 24]');
const options={seed:values.seed,world:Number(values.world),documents:Number(values.documents)};
const fixture=buildReadSelectionFixture(options);
const root=resolve(values.output),repo=join(root,'repo');await mkdir(root);await mkdir(repo);
for(const [path,content] of Object.entries(fixture.files)){await mkdir(dirname(join(repo,path)),{recursive:true});await writeFile(join(repo,path),content);}
// Acceptance derives expected numbers from frozen host data, not generated code or runtime discovery.
const oracle=`import assert from 'node:assert/strict';
const expectations=${JSON.stringify(fixture.expectations)};
for(const e of expectations){
 const {quote}=await import('./'+e.target);
 const {rate,minimum,cap}=e.policy;
 for(const n of [...new Set([0,1,minimum,minimum+1,cap-1,cap,cap+1,100,10000])].filter(n=>n>=0))assert.equal(quote(n),Math.min(cap,Math.max(minimum,n))*rate,e.target+' at '+n);
 for(const n of [-1,0.5,NaN,Infinity,'1',null,undefined,Number.MAX_SAFE_INTEGER+1])assert.equal(quote(n),null,e.target+' invalid '+String(n));
}
`;
await writeFile(join(repo,'check.mjs'),oracle);
const files=fixture.targets.map(path=>({path,instructions:`Implement quote(units) for ${path}. Use registry.json's mapping for this exact target to select its policy. For nonnegative safe integer units, clamp to policy minimum and cap, then multiply by policy rate. All other inputs return null. If needed files are not already delivered, request registry.json and then the policy path learned from its contents in separate calls. Do not guess values or pick a policy from its filename.`,checks:[{argv:[process.execPath,'--check',path],timeoutMs:10000}]}));
const base={version:2,goal:'Implement the assigned quote exports according to their target-specific published business policies.',files,protected:['check.mjs'],checks:[{argv:[process.execPath,'check.mjs'],timeoutMs:10000}],discovery:{mode:'static+reads',readable:fixture.catalog,maxReadCalls:2,maxPathsPerRead:1,maxDeliveredBytes:65536}};
for(const condition of ['local','broad'])await writeFile(join(root,condition+'.json'),JSON.stringify({...base,context:condition==='local'?[]:fixture.catalog},null,2)+'\n');
await writeFile(join(root,'fixture.json'),JSON.stringify({format:1,options,targets:fixture.targets,catalog:fixture.catalog,expectations:fixture.expectations,oracleSha256:createHash('sha256').update(oracle).digest('hex'),filesSha256:Object.fromEntries(Object.entries(fixture.files).map(([p,c])=>[p,createHash('sha256').update(c).digest('hex')]))},null,2)+'\n');
execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'add','.']);execFileSync('git',['-C',repo,'-c','user.name=Sheep fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixed read selection baseline']);
console.log(JSON.stringify({repository:repo,localTask:join(root,'local.json'),broadTask:join(root,'broad.json'),hostFixture:join(root,'fixture.json')}));
