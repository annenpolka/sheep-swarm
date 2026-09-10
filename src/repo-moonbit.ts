import {posix} from 'node:path';
import {parseMoonManifest} from './moonbit-manifest.ts';

export const isMoonManifest=(path:string)=>/(?:^|\/)moon\.(?:pkg|mod)(?:\.json)?$/.test(path);
const dir=(p:string)=>posix.dirname(p)==='.'?'':posix.dirname(p);
const at=(d:string,p:string)=>d?`${d}/${p}`:p;

/** Only the explicit public catalog is parsed. Never runs Moon or build scripts. */
export function discoverMoonBit(contents:Readonly<Record<string,string>>,writable:readonly string[]) {
 const edges:{consumer:string;provider:string;specifier:string}[]=[];
 const issues:{consumer:string;specifier:string;reason:string}[]=[];
 const paths=Object.keys(contents).sort();
 const modules=paths.filter(p=>/(?:^|\/)moon\.mod(?:\.json)?$/.test(p));
 const cache=new Map<string,ReturnType<typeof parseMoonManifest>>();
 const parsed=(p:string)=>{if(!cache.has(p))cache.set(p,parseMoonManifest(p,contents[p]!));return cache.get(p)!;};
 const choose=(d:string,kind:'mod'|'pkg')=>[at(d,`moon.${kind}`),at(d,`moon.${kind}.json`)].find(p=>Object.hasOwn(contents,p));
 const issue=(consumer:string,reason:string)=>issues.push({consumer,specifier:'moonbit',reason});
 const edge=(consumer:string,provider:string)=>{if(consumer!==provider)edges.push({consumer,provider,specifier:'moonbit-package'});};
 for(const consumer of paths.filter(p=>p.endsWith('.mbt'))) {
  try {
   const d=dir(consumer);
   const moduleDirs=[...new Set(modules.map(dir))].filter(m=>m===''||d===m||d.startsWith(`${m}/`)).sort((a,b)=>b.length-a.length);
   const root=moduleDirs[0];
   if(root===undefined)throw new Error('missing public moon.mod or moon.mod.json');
   const modulePath=choose(root,'mod')!;
   const mod=parsed(modulePath);
   const sourceRoot=mod.source?at(root,mod.source):root;
   if(sourceRoot!==''&&d!==sourceRoot&&!d.startsWith(`${sourceRoot}/`))throw new Error('package outside module source directory');
   const pkg=choose(d,'pkg');
   if(!pkg)throw new Error(`missing public package manifest in ${d||'.'}`);
   const config=parsed(pkg);
   edge(consumer,modulePath);edge(consumer,pkg);
   const members=paths.filter(p=>p.endsWith('.mbt')&&dir(p)===d);
   const targets=members.filter(p=>writable.includes(p));
   if(targets.length>1)throw new Error('MoonBit v2 permits one writable .mbt file per package; split the task or use explicit v1 dependencies');
   if(targets.includes(consumer))for(const sibling of members)edge(consumer,sibling);
   for(const specifier of config.imports) {
    if(specifier.startsWith('moonbitlang/core/'))continue;
    if(specifier!==mod.name&&!specifier.startsWith(`${mod.name}/`))throw new Error(`external MoonBit package unsupported: ${specifier}`);
    const suffix=specifier===mod.name?'':specifier.slice(mod.name!.length+1);
    const providerDir=suffix?at(sourceRoot,suffix):sourceRoot;
    if(providerDir===d)throw new Error(`MoonBit package imports itself: ${specifier}`);
    const providerManifest=choose(providerDir,'pkg');
    const providers=paths.filter(p=>p.endsWith('.mbt')&&dir(p)===providerDir);
    if(!providerManifest||!providers.length)throw new Error(`missing public MoonBit package: ${specifier}`);
    // Nested modules must not masquerade as packages of the containing module.
    if(moduleDirs.length&&modules.some(p=>{const m=dir(p);return m!==root&&m!==''&&(providerDir===m||providerDir.startsWith(`${m}/`))&&m.startsWith(root?`${root}/`:'' );}))throw new Error(`nested module package unsupported: ${specifier}`);
    edge(consumer,providerManifest);
    for(const provider of providers)edge(consumer,provider);
   }
  } catch(error) {issue(consumer,`moonbit: ${(error as Error).message}`);}
 }
 for(const target of writable)if(isMoonManifest(target))issue(target,'moonbit: v2 manifest writes unsupported; use a source target or explicit v1 task');
 return {edges,issues};
}

/** A partial catalog must not silently hide same-package declarations or newer metadata. */
export function validateMoonBitCatalog(available:readonly string[],publicPaths:readonly string[]):void {
 const publicSet=new Set(publicPaths);
 const sourceDirs=new Set(publicPaths.filter(p=>p.endsWith('.mbt')).map(dir));
 for(const path of available) {
  const d=dir(path);
  if(path.endsWith('.mbt.md')&&sourceDirs.has(d))throw new Error('MoonBit literate sources are not supported by static discovery');
  const relevant=(path.endsWith('.mbt')&&sourceDirs.has(d)) ||
   (/(?:^|\/)moon\.pkg(?:\.json)?$/.test(path)&&sourceDirs.has(d)) ||
   (/(?:^|\/)moon\.(?:mod(?:\.json)?|work)$/.test(path)&&[...sourceDirs].some(s=>d===''||s===d||s.startsWith(`${d}/`)));
  if(!relevant)continue;
  if(path.endsWith('moon.work'))throw new Error('MoonBit workspace resolution is not supported by static discovery');
  if(!publicSet.has(path))throw new Error(`MoonBit discovery requires an explicit public catalog entry: ${path}`);
 }
}
