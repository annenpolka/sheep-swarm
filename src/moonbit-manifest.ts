export type MoonManifest = {name?: string; source?: string; imports: string[]};

const MAX_DEPTH = 64;

function fail(message: string): never {
  throw new Error(message);
}

const MOD_JSON = 'moon.mod.json';
const MOD_DSL = 'moon.mod';
const PKG_JSON = 'moon.pkg.json';
const PKG_DSL = 'moon.pkg';

function baseName(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

type Kind = 'module' | 'package';
type Flavor = 'json' | 'dsl';

function classify(path: string): {kind: Kind; flavor: Flavor} {
  const name = baseName(path);
  if (name === MOD_JSON) return {kind: 'module', flavor: 'json'};
  if (name === MOD_DSL) return {kind: 'module', flavor: 'dsl'};
  if (name === PKG_JSON) return {kind: 'package', flavor: 'json'};
  if (name === PKG_DSL) return {kind: 'package', flavor: 'dsl'};
  fail(`unsupported manifest path '${path}': expected moon.mod.json, moon.mod, moon.pkg.json or moon.pkg`);
}

const NAME_COMPONENT = /^[A-Za-z0-9_-]+$/;
const ALIAS_RE = /^[A-Za-z0-9_-]+$/;

function isValidName(value: string): boolean {
  if (value.length === 0) return false;
  const parts = value.split('/');
  for (const part of parts) {
    if (part.length === 0) return false;
    if (!NAME_COMPONENT.test(part)) return false;
  }
  return true;
}

function requireName(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where}: name must be a string`);
  if (!isValidName(value)) fail(`${where}: invalid name '${value}'`);
  return value;
}

function requireImportPath(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where}: import path must be a string`);
  if (!isValidName(value)) fail(`${where}: invalid import path '${value}'`);
  return value;
}

function requireSource(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where}: source must be a string`);
  if (value.length === 0) fail(`${where}: source must be nonempty`);
  if (value.startsWith('/') || value.startsWith('\\')) fail(`${where}: source must be relative, got '${value}'`);
  const parts = value.split('/');
  for (const part of parts) {
    if (!/^[A-Za-z0-9_.-]+$/.test(part)) fail(`${where}: invalid source component`);
    if (part === '.' || part === '..') fail(`${where}: source must not contain '${part}' component`);
  }
  return value;
}

class ImportCollector {
  private seen = new Set<string>();
  private list: string[] = [];
  add(path: string): void {
    if (!this.seen.has(path)) {
      this.seen.add(path);
      this.list.push(path);
    }
  }
  result(): string[] {
    return this.list.slice();
  }
}

function collectImportArray(value: unknown, where: string, collector: ImportCollector): void {
  if (!Array.isArray(value)) fail(`${where}: imports must be an array`);
  value.forEach((entry, index) => {
    const ctx = `${where}[${index}]`;
    if (typeof entry === 'string') {
      collector.add(requireImportPath(entry, ctx));
      return;
    }
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (key !== 'path' && key !== 'alias') fail(`${ctx}: unexpected key '${key}'`);
      }
      if (!Object.prototype.hasOwnProperty.call(obj, 'path')) fail(`${ctx}: import object requires 'path'`);
      const path = requireImportPath(obj['path'], ctx);
      if (Object.prototype.hasOwnProperty.call(obj, 'alias')) {
        const alias = obj['alias'];
        if (typeof alias !== 'string') fail(`${ctx}: alias must be a string`);
        if (!ALIAS_RE.test(alias)) fail(`${ctx}: invalid alias '${alias}'`);
      }
      collector.add(path);
      return;
    }
    fail(`${ctx}: import entry must be a string or object with path`);
  });
}

const MODULE_ALLOWED = new Set([
  'name','source','version','license','readme','repository','description','keywords','authors','deps',
]);

function validateModuleJson(raw: Record<string, unknown>): MoonManifest {
  for (const key of Object.keys(raw)) {
    if (!MODULE_ALLOWED.has(key)) fail(`moon.mod.json: unsupported configuration key '${key}'`);
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'name')) fail('moon.mod.json: missing required field name');
  const name = requireName(raw['name'], 'moon.mod.json');
  const out: MoonManifest = {name, imports: []};
  if (Object.prototype.hasOwnProperty.call(raw, 'source')) {
    out.source = requireSource(raw['source'], 'moon.mod.json');
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'deps')) {
    const deps = raw['deps'];
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
      fail('moon.mod.json: deps must be an object');
    }
    if (Object.keys(deps as Record<string, unknown>).length > 0) {
      fail('moon.mod.json: external modules are unsupported (deps must be empty)');
    }
  }
  return out;
}

const PKG_JSON_ALLOWED = new Set([
  'import','test-import','wbtest-import','is-main','warn-list','alert-list','test-import-all',
]);

function validatePackageJson(raw: Record<string, unknown>): MoonManifest {
  for (const key of Object.keys(raw)) {
    if (!PKG_JSON_ALLOWED.has(key)) fail(`moon.pkg.json: unsupported configuration key '${key}'`);
  }
  const collector = new ImportCollector();
  for (const key of ['import', 'test-import', 'wbtest-import']) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      collectImportArray(raw[key], `moon.pkg.json:${key}`, collector);
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'is-main') && typeof raw['is-main'] !== 'boolean') {
    fail('moon.pkg.json: is-main must be a boolean');
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'test-import-all') && typeof raw['test-import-all'] !== 'boolean') {
    fail('moon.pkg.json: test-import-all must be a boolean');
  }
  for (const key of ['warn-list', 'alert-list']) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && typeof raw[key] !== 'string') {
      fail(`moon.pkg.json: ${key} must be a string`);
    }
  }
  return {imports: collector.result()};
}

function parseJson(raw: unknown, kind: Kind): MoonManifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${kind === 'module' ? 'moon.mod.json' : 'moon.pkg.json'}: manifest must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  return kind === 'module' ? validateModuleJson(obj) : validatePackageJson(obj);
}

type TokenType = 'ident' | 'string' | 'integer' | 'bool' | 'punct' | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '=', '@', ',']);
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      fail(`DSL: block comments are not supported at offset ${i}`);
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      let closed = false;
      while(i<n) {
        if(text[i]==='\\'){i+=2;continue;}
        if(text[i]==='"'){i++;closed=true;break;}
        i++;
      }
      if(!closed)fail(`DSL: unterminated string at ${start}`);
      let out:string;
      try {out=JSON.parse(text.slice(start,i)) as string;} catch {fail(`DSL: invalid string at ${start}`);}
      tokens.push({type: 'string', value: out, pos: start});
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const start = i;
      while (i < n) {
        const c = text[i]!;
        if (c >= '0' && c <= '9') i += 1;
        else break;
      }
      if (i < n && IDENT_START.test(text[i]!)) fail(`DSL: invalid number literal at offset ${start}`);
      tokens.push({type: 'integer', value: text.slice(start, i), pos: start});
      continue;
    }
    if (IDENT_START.test(ch)) {
      const start = i;
      i += 1;
      while (i < n && IDENT_PART.test(text[i]!)) i += 1;
      const word = text.slice(start, i);
      if (word === 'true' || word === 'false') {
        tokens.push({type: 'bool', value: word, pos: start});
      } else {
        tokens.push({type: 'ident', value: word, pos: start});
      }
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({type: 'punct', value: ch, pos: i});
      i += 1;
      continue;
    }
    fail(`DSL: unexpected character '${ch}' at offset ${i}`);
  }
  tokens.push({type: 'eof', value: '', pos: n});
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    const t = this.tokens[this.pos]!;
    this.pos += 1;
    return t;
  }
  private atPunct(value: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.value === value;
  }
  private atIdent(value: string): boolean {
    const t = this.peek();
    return t.type === 'ident' && t.value === value;
  }
  private expectPunct(value: string): Token {
    const t = this.peek();
    if (t.type !== 'punct' || t.value !== value) {
      fail(`DSL: expected '${value}' but found '${t.value || t.type}' at offset ${t.pos}`);
    }
    return this.next();
  }
  private expectString(where: string): string {
    const t = this.peek();
    if (t.type !== 'string') fail(`DSL: ${where} expected a string literal at offset ${t.pos}`);
    this.next();
    return t.value;
  }
  private expectIdent(where: string): string {
    const t = this.peek();
    if (t.type !== 'ident') fail(`DSL: ${where} expected an identifier at offset ${t.pos}`);
    this.next();
    return t.value;
  }
  atEof(): boolean {
    return this.peek().type === 'eof';
  }
  parseModule(): MoonManifest {
    const fields:Record<string,unknown>=Object.create(null);
    while(!this.atEof()) {
      const key=this.expectIdent('module declaration');
      if(key==='options')this.options(fields);
      else {this.expectPunct('=');this.field(fields,key,this.value(0));}
    }
    return validateModuleJson(fields);
  }
  parsePackage(): MoonManifest {
    const collector=new ImportCollector();
    const fields:Record<string,unknown>=Object.create(null);
    while(!this.atEof()) {
      const key=this.expectIdent('package declaration');
      if(key==='import'){this.parseImportDecl(collector);continue;}
      if(key==='options'){this.options(fields);continue;}
      if(key==='pkgtype'){
        const options:Record<string,unknown>=Object.create(null);this.options(options);
        if(Object.keys(options).length!==1||options['kind']!=='executable')fail('unsupported pkgtype');
        this.field(fields,'is-main',true);continue;
      }
      this.expectPunct('=');this.field(fields,key,this.value(0));
    }
    const validated=validatePackageJson(fields);
    for(const p of validated.imports)collector.add(p);
    return {imports:collector.result()};
  }
  private field(fields:Record<string,unknown>,key:string,value:unknown):void {
    if(Object.hasOwn(fields,key))fail(`duplicate configuration key: ${key}`);
    fields[key]=value;
  }
  private key():string {
    return this.peek().type==='string'?this.expectString('key'):this.expectIdent('key');
  }
  private options(fields:Record<string,unknown>):void {
    this.expectPunct('(');
    while(!this.atPunct(')')) {
      const key=this.key();this.expectPunct(':');this.field(fields,key,this.value(0));
      if(!this.atPunct(','))break;this.next();
    }
    this.expectPunct(')');
  }
  private value(depth:number):unknown {
    if(depth>MAX_DEPTH)fail('expression nesting too deep');
    const t=this.peek();
    if(t.type==='string'){this.next();return t.value;}
    if(t.type==='bool'){this.next();return t.value==='true';}
    if(t.type==='integer'){this.next();const n=Number(t.value);if(!Number.isSafeInteger(n))fail('integer out of range');return n;}
    if(this.atPunct('[')) {
      this.next();const array:unknown[]=[];
      while(!this.atPunct(']')){array.push(this.value(depth+1));if(!this.atPunct(','))break;this.next();}
      this.expectPunct(']');return array;
    }
    if(this.atPunct('{')) {
      this.next();const obj:Record<string,unknown>=Object.create(null);
      while(!this.atPunct('}')){const key=this.key();this.expectPunct(':');this.field(obj,key,this.value(depth+1));if(!this.atPunct(','))break;this.next();}
      this.expectPunct('}');return obj;
    }
    fail(`unsupported expression at ${t.pos}`);
  }
  private parseImportDecl(collector: ImportCollector): void {
    this.expectPunct('{');
    const paths: string[] = [];
    while (!this.atPunct('}')) {
      const p = this.expectString('import');
      paths.push(requireImportPath(p, 'moon.pkg:import'));
      if (this.atPunct('@')) {
        this.next();
        const alias = this.expectIdent('import alias');
        if (!ALIAS_RE.test(alias)) fail(`moon.pkg: invalid alias '${alias}'`);
      }
      if (this.atPunct(',')) {
        this.next();
        continue;
      }
      break;
    }
    this.expectPunct('}');
    if (this.atIdent('for')) {
      this.next();
      const kind = this.expectString('import for');
      if (kind !== 'test' && kind !== 'wbtest') {
        fail(`moon.pkg: import 'for' must be "test" or "wbtest", got '${kind}'`);
      }
    }
    for (const p of paths) collector.add(p);
  }
}

export function parseMoonManifest(path: string, text: string): MoonManifest {
  if (typeof path !== 'string' || typeof text !== 'string') {
    fail('parseMoonManifest requires string path and text');
  }
  const {kind, flavor} = classify(path);
  const label = kind === 'module' ? 'moon.mod' : 'moon.pkg';
  if (flavor === 'json') {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      fail(`${label}.json: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    return parseJson(raw, kind);
  }
  const tokens = tokenize(text);
  const parser = new Parser(tokens);
  return kind === 'module' ? parser.parseModule() : parser.parsePackage();
}
