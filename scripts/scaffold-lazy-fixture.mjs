// Parse controlled fixture sources without linking/evaluating them.
import {API} from 'typescript/unstable/sync';
import {createVirtualFileSystem} from 'typescript/unstable/fs';
import {SyntaxKind,visitEachChild} from 'typescript/unstable/ast';
export function scaffoldSources(entries){
 const files=Object.fromEntries(Object.entries(entries).map(([p,s])=>['/input/'+p,s]));
 files['/input/tsconfig.json']=JSON.stringify({compilerOptions:{noLib:true,noResolve:true,allowJs:true},files:Object.keys(entries)});
 const api=new API({cwd:'/input',fs:createVirtualFileSystem(files)});
 try{const snapshot=api.updateSnapshot({openProjects:['/input/tsconfig.json']});try{
  const program=snapshot.getProject('/input/tsconfig.json')?.program;if(!program)throw new Error('no scaffold parser');
  return Object.fromEntries(Object.entries(entries).map(([path,source])=>{
   if(program.getSyntacticDiagnostics('/input/'+path).length)throw new Error('invalid fixture source');
   const spans=[];
   const visit=node=>{if(node.kind===SyntaxKind.FunctionDeclaration&&node.body){spans.push({start:node.body.pos,end:node.body.end});return node;}visitEachChild(node,visit);return node;};
   visit(program.getSourceFile('/input/'+path));
   let text=source;for(const {start,end}of spans.sort((a,b)=>b.start-a.start))text=text.slice(0,start)+'{ return undefined; /* implement the public contract */ }'+text.slice(end);
   return [path,text];
  }));
 }finally{snapshot.dispose();}}finally{api.close();}
}
