import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

/** Frozen semantic oracle; Moon installation is supplied explicitly by the host. */
export function moonBitFixture(moonHome) {
 const files={
  '.gitignore':'_build/\n.moon/\n',
  'moon.mod.json':JSON.stringify({name:'swarm/moonbit'}),
  'policy/moon.pkg':'',
  'policy/policy.mbt':'pub fn rate() -> Int { 7 }\n',
  'a/moon.pkg':'import { "swarm/moonbit/policy" }\n',
  'a/main.mbt':'pub fn price(n : Int) -> Int { 0 }\n',
  'a/helper.mbt':'fn floor_units(n : Int) -> Int { if n < 2 { 2 } else { n } }\n',
  'oracle/price_test.mbt':'test "price boundaries" { assert_eq(@a.price(-1), 14); assert_eq(@a.price(0), 14); assert_eq(@a.price(2), 14); assert_eq(@a.price(5), 35) }\n',
  'b/moon.pkg.json':JSON.stringify({import:['swarm/moonbit/a']}),
  'b/main.mbt':'pub fn invoice(n : Int) -> Int { 0 }\n',
  'oracle/invoice_test.mbt':'test "invoice boundaries" { assert_eq(@b.invoice(0), 17); assert_eq(@b.invoice(5), 38) }\n',
  'oracle/moon.pkg':'import { "swarm/moonbit/a", "swarm/moonbit/b" }\n',
  'unused/moon.pkg':'',
  'unused/main.mbt':'pub fn untouched() -> Int { 99 }\n',
  'check-moon.mjs':`import {execFileSync} from 'node:child_process';\nimport {join} from 'node:path';\nconst home=process.argv[2];if(!home)throw new Error('Moon home required');\nfor(const command of ['check','test'])execFileSync(join(home,'bin/moon'),[command,'--frozen','--target','js'],{stdio:'inherit',env:{...process.env,MOON_HOME:home}});\n`,
 };
 const targets=['a/main.mbt','b/main.mbt','unused/main.mbt'];
 const task={version:2,goal:'Propagate policy rate through price and invoice. Preserve the unrelated package.',
  files:targets.map((path,i)=>({path,instructions:[
   'Implement pub fn price(n : Int) -> Int using same-package floor_units and @policy.rate(). Preserve the signature. Price is floor_units(n) * rate().',
   'Implement pub fn invoice(n : Int) -> Int as @a.price(n) + 3. Preserve the signature.',
   'Preserve untouched() returning 99.',
  ][i]})),context:[],protected:['check-moon.mjs','oracle/moon.pkg','oracle/price_test.mbt','oracle/invoice_test.mbt'],
  discovery:{mode:'static+reads',readable:Object.keys(files).filter(p=>!targets.includes(p)&&!p.startsWith('oracle/')&&p!=='check-moon.mjs'&&p!=='.gitignore'),maxDeliveredBytes:65536,maxReadCalls:2},
  activation:{changedPaths:['policy/policy.mbt']},checks:[{argv:[process.execPath,'check-moon.mjs',moonHome],timeoutMs:120000}]};
 return {files,task};
}
export async function writeMoonBitFixture(directory,moonHome) {
 const root=resolve(directory);await mkdir(root,{recursive:false});
 const {files,task}=moonBitFixture(resolve(moonHome));
 for(const [path,text] of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),text);}
 await writeFile(join(root,'task.json'),JSON.stringify(task,null,2)+'\n');
 execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['add','.'],{cwd:root});
 execFileSync('git',['-c','user.name=Swarm Fixture','-c','user.email=fixture@localhost','commit','-qm','Freeze MoonBit acceptance fixture'],{cwd:root});
 return root;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length!==4)throw new Error('Usage: node scripts/moonbit-repository-fixture.mjs NEW_DIRECTORY MOON_HOME');
 console.log(await writeMoonBitFixture(process.argv[2],process.argv[3]));
}
