// Invoked only by the bounded dependency-parser child. Never execute source text.
import {API} from 'typescript/unstable/sync';
import {createVirtualFileSystem} from 'typescript/unstable/fs';
import {SyntaxKind,visitEachChild} from 'typescript/unstable/ast';

export function parseTypeScriptEntries(entries) {
  const edges=[],issues=[];
  if(!entries.length)return {edges,issues};
  const files=Object.fromEntries(entries.map(e=>['/input/'+e.path,e.text]));
  files['/input/tsconfig.json']=JSON.stringify({compilerOptions:{noLib:true,noResolve:true},files:entries.map(e=>e.path)});
  const api=new API({cwd:'/input',fs:createVirtualFileSystem(files)});
  try {
    const snapshot=api.updateSnapshot({openProjects:['/input/tsconfig.json']});
    try {
      const program=snapshot.getProject('/input/tsconfig.json')?.program;
      if(!program)throw new Error('TypeScript parser project unavailable');
      for(const entry of entries){
        const path='/input/'+entry.path;
        const diagnostics=program.getSyntacticDiagnostics(path);
        if(diagnostics.length){issues.push({consumer:entry.path,specifier:'',reason:'syntax-error: TypeScript'});continue;}
        const source=program.getSourceFile(path);
        if(!source)throw new Error('TypeScript AST unavailable');
        function visit(node){
          let specifier;
          if(node.kind===SyntaxKind.ImportDeclaration||node.kind===SyntaxKind.ExportDeclaration)specifier=node.moduleSpecifier?.text;
          if(node.kind===SyntaxKind.ImportType)specifier=node.argument?.literal?.text;
          if(typeof specifier==='string')edges.push({consumer:entry.path,specifier});
          if(node.kind===SyntaxKind.ImportEqualsDeclaration)issues.push({consumer:entry.path,specifier:'',reason:'unsupported-import-equals'});
          if(node.kind===SyntaxKind.CallExpression&&node.expression.kind===SyntaxKind.ImportKeyword)issues.push({consumer:entry.path,specifier:'',reason:'unsupported-dynamic-import'});
          visitEachChild(node,visit);
          return node;
        }
        visit(source);
      }
    } finally {snapshot.dispose();}
  } finally {api.close();}
  return {edges,issues};
}
