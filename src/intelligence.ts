import { classAt, Declaration, functionAt, FunctionScope, isType, namespaceAt, parseSource, PhpFile, resolveName, splitTopLevel, Token, tokenIndex } from './phpSyntax';

export interface SymbolReference { file: PhpFile; uri: string; declaration: Declaration }
export interface MemberContext { receiver: Token[]; operator: string; prefix: string; start: number }
const normalize = (name: string) => name.replace(/^\\/, '').toLowerCase();
const scopedTokens = new WeakMap<PhpFile, Map<FunctionScope | undefined, { code: Token[]; comments: Token[] }>>();
function tokensInScope(file: PhpFile, scope: FunctionScope | undefined): { code: Token[]; comments: Token[] } {
  let scopes = scopedTokens.get(file);
  if (!scopes) { scopes = new Map(); scopedTokens.set(file, scopes); }
  let tokens = scopes.get(scope);
  if (!tokens) {
    tokens = { code: [], comments: [] };
    const end = tokenIndex(file.tokens, scope?.end ?? file.text.length);
    for (let i = tokenIndex(file.tokens, scope?.bodyStart ?? 0); i < end; i++) {
      const t = file.tokens[i];
      if (functionAt(file, t.start) !== scope) continue;
      if (t.kind === 'comment') tokens.comments.push(t);
      else if (scope || !classAt(file, t.start)) tokens.code.push(t);
    }
    scopes.set(scope, tokens);
  }
  return tokens;
}

/** Shared semantic model for completion, navigation, hover and call signatures. */
export class PhpProject {
  readonly files = new Map<string, PhpFile>();
  private readonly types = new Map<string, Set<SymbolReference>>();
  private readonly members = new Map<string, Set<SymbolReference>>();
  private readonly functions = new Map<string, Set<SymbolReference>>();
  private readonly byUri = new Map<string, SymbolReference[]>();
  private readonly byName = new Map<string, Set<SymbolReference>>();
  private readonly globals = new Map<string, Set<SymbolReference>>();
  private readonly prefixes = new Map<string, Set<SymbolReference>>();
  private readonly qualifiedPrefixes = new Map<string, Set<SymbolReference>>();
  private readonly fileOrder = new Map<string, number>();
  private nextFileOrder = 0;
  private symbols?: SymbolReference[];

  update(uri: string, text: string): PhpFile {
    const previous = this.files.get(uri);
    if (previous?.text === text) return previous;
    const file = parseSource(text);
    this.removeReferences(uri);
    this.files.set(uri, file);
    if (!this.fileOrder.has(uri)) this.fileOrder.set(uri, this.nextFileOrder++);
    const refs = file.declarations.map(declaration => ({ uri, file, declaration }));
    this.byUri.set(uri, refs);
    for (const ref of refs) this.indexReference(ref, true);
    this.symbols = undefined;
    return file;
  }
  remove(uri: string): boolean {
    if (!this.files.delete(uri)) return false;
    this.removeReferences(uri); this.fileOrder.delete(uri); return true;
  }
  private removeReferences(uri: string): void {
    for (const ref of this.byUri.get(uri) ?? []) this.indexReference(ref, false);
    this.byUri.delete(uri); this.symbols = undefined;
  }
  private indexReference(ref: SymbolReference, add: boolean): void {
    const d = ref.declaration;
    const change = (table: Map<string, Set<SymbolReference>>, key: string) => {
      if (add) { const bucket = table.get(key) ?? new Set(); bucket.add(ref); table.set(key, bucket); }
      else { const bucket = table.get(key); bucket?.delete(ref); if (!bucket?.size) table.delete(key); }
    };
    change(this.byName, d.name.toLowerCase());
    if (isType(d)) change(this.types, normalize(d.fqName));
    else if (d.owner) change(this.members, normalize(d.owner));
    else if (d.kind === 'function') change(this.functions, normalize(d.fqName));
    if (!d.owner) {
      change(this.globals, normalize(d.fqName));
      for (const name of new Set([d.name.toLowerCase(), initials(d.name)])) {
        if (name) change(this.prefixes, name.slice(0, 1));
        if (name.length > 1) change(this.prefixes, name.slice(0, 2));
      }
      const qualified = normalize(d.fqName);
      change(this.qualifiedPrefixes, qualified.slice(0, 1));
      if (qualified.length > 1) change(this.qualifiedPrefixes, qualified.slice(0, 2));
    }
  }
  /** Explicit full rebuild for callers replacing the file map; normal edits are incremental. */
  rebuild(): void {
    this.types.clear(); this.members.clear(); this.functions.clear(); this.byUri.clear();
    this.byName.clear(); this.globals.clear(); this.prefixes.clear(); this.qualifiedPrefixes.clear();
    this.fileOrder.clear(); this.nextFileOrder = 0; this.symbols = undefined;
    for (const [uri, file] of this.files) {
      this.fileOrder.set(uri, this.nextFileOrder++);
      const refs = file.declarations.map(declaration => ({ uri, file, declaration }));
      this.byUri.set(uri, refs);
      for (const ref of refs) this.indexReference(ref, true);
    }
  }
  all(): SymbolReference[] { return this.symbols ??= [...this.files.keys()].flatMap(uri => this.byUri.get(uri) ?? []); }
  forDocument(uri: string): SymbolReference[] { return this.byUri.get(uri) ?? []; }
  named(name: string): SymbolReference[] {
    const normalized = normalize(name);
    return [...this.byName.get(normalized.split('\\').pop()!) ?? []].filter(r => !name.includes('\\') || normalize(r.declaration.fqName) === normalized).sort((a, b) => this.compareSourceOrder(a, b));
  }
  globalNamed(fqName: string): SymbolReference[] { return [...this.globals.get(normalize(fqName)) ?? []]; }
  completionCandidates(query: string, qualified?: string, aliases: string[] = []): SymbolReference[] {
    const needle = query.toLowerCase();
    const candidates = new Set<SymbolReference>();
    if (!needle) { for (const refs of this.globals.values()) for (const ref of refs) candidates.add(ref); }
    else for (const ref of this.prefixes.get(needle.slice(0, 2)) ?? []) if (matches(ref.declaration.name, needle)) candidates.add(ref);
    if (qualified) {
      const prefix = normalize(qualified);
      for (const ref of this.qualifiedPrefixes.get(prefix.slice(0, 2)) ?? []) if (normalize(ref.declaration.fqName).startsWith(prefix)) candidates.add(ref);
    }
    for (const alias of aliases) for (const ref of this.globalNamed(alias)) candidates.add(ref);
    return [...candidates];
  }
  // Preserve deterministic resolution when duplicate declarations exist in different files.
  private latest(refs?: Set<SymbolReference>): SymbolReference | undefined {
    let found: SymbolReference | undefined;
    for (const ref of refs ?? []) if (!found || this.compareSourceOrder(ref, found) > 0) found = ref;
    return found;
  }
  private compareSourceOrder(a: SymbolReference, b: SymbolReference): number {
    return this.fileOrder.get(a.uri)! - this.fileOrder.get(b.uri)! || a.declaration.nameStart - b.declaration.nameStart;
  }
  type(name: string): SymbolReference | undefined { return this.latest(this.types.get(normalize(name))); }
  parent(name: string): string | undefined { return this.type(name)?.declaration.parents[0]; }
  isSubclass(child: string, parent: string, seen = new Set<string>()): boolean {
    if (normalize(child) === normalize(parent)) return true;
    if (seen.has(normalize(child))) return false; seen.add(normalize(child));
    return this.type(child)?.declaration.parents.some(p => this.isSubclass(p, parent, seen)) ?? false;
  }
  membersOf(name: string, caller?: string, access?: 'instance' | 'static' | 'parent'): SymbolReference[] {
    const found = new Map<string, SymbolReference>(); const seen = new Set<string>();
    const visit = (owner: string, effectiveOwner = owner) => {
      if (seen.has(normalize(owner))) return; seen.add(normalize(owner));
      for (const ref of [...this.members.get(normalize(owner)) ?? []].sort((a, b) => this.compareSourceOrder(a, b))) {
        const d = ref.declaration;
        if (d.visibility === 'private' && normalize(caller ?? '') !== normalize(effectiveOwner)) continue;
        if (d.visibility === 'protected' && (!caller || !(this.isSubclass(caller, effectiveOwner) || this.isSubclass(effectiveOwner, caller)))) continue;
        if (access === 'instance' && (d.isStatic || d.kind === 'constant')) continue;
        if (access === 'static' && !d.isStatic && d.kind !== 'constant') continue;
        if (access === 'parent' && d.kind === 'property' && !d.isStatic) continue;
        const key = `${d.kind}:${d.kind === 'method' ? d.name.toLowerCase() : d.name}`;
        if (!found.has(key)) found.set(key, ref);
      }
      const type = this.type(owner)?.declaration;
      for (const trait of type?.traits ?? []) visit(trait, effectiveOwner);
      for (const parent of type?.parents ?? []) visit(parent);
    };
    visit(name); return [...found.values()];
  }

  resolveTypes(file: PhpFile, raw: string, offset: number, receiver?: string): string[] {
    return raw.replace(/[?()]/g, '').split(/[|&]/).map(part => {
      const name = part.trim();
      if (['static', '$this'].includes(name)) return receiver ?? classAt(file, offset)?.fqName ?? '';
      if (name === 'self') return classAt(file, offset)?.fqName ?? receiver ?? '';
      if (name === 'parent') return this.parent(classAt(file, offset)?.fqName ?? '') ?? '';
      if (name.endsWith('[]')) return this.resolveTypes(file, name.slice(0, -2), offset, receiver).map(t => `${t}[]`).join('|');
      // Collection element types are preserved for foreach and array access.
      const generic = name.match(/^(?:array|list|iterable|Collection)<(?:[^,]+,\s*)?(.+)>$/);
      if (generic) return this.resolveTypes(file, generic[1], offset, receiver).map(t => `${t}[]`).join('|');
      return name ? resolveName(file, name, offset) : '';
    }).flatMap(t => t.split('|')).filter(t => t && !['null', 'false', 'true', 'void', 'never', 'mixed'].includes(t));
  }
  private functionNamed(file: PhpFile, name: string, offset: number): SymbolReference | undefined {
    return this.latest(this.functions.get(normalize(resolveName(file, name, offset, 'function'))))
      ?? (!name.includes('\\') ? this.latest(this.functions.get(normalize(name))) : undefined);
  }
  private returned(ref: SymbolReference, receiver?: string): string[] {
    return this.resolveTypes(ref.file, ref.declaration.type ?? '', ref.declaration.bodyStart ?? ref.declaration.start, receiver);
  }

  variables(file: PhpFile, offset: number): string[] {
    const scope = functionAt(file, offset); const names = new Set(scope?.parameters.map(p => p.name) ?? []);
    for (const capture of scope?.captures ?? []) names.add(capture);
    if (scope?.owner && !scope.isStatic) names.add('this');
    for (const t of tokensInScope(file, scope).code) {
      if (t.start >= offset) break;
      if (t.kind !== 'variable') continue;
      names.add(t.value.slice(1));
    }
    if (scope?.arrow) for (const name of this.variables(file, scope.start - 1)) names.add(name);
    return [...names];
  }

  variableTypes(file: PhpFile, name: string, offset: number, depth = 0): string[] {
    if (depth > 16) return [];
    const scope = functionAt(file, offset);
    if (name === 'this') return scope?.owner && !scope.isStatic ? [scope.owner] : [];
    const scoped = tokensInScope(file, scope);
    const ts = scoped.code.slice(0, tokenIndex(scoped.code, offset));
    const annotations = scoped.comments.slice(0, tokenIndex(scoped.comments, offset));
    const annotation = annotations.map(t => ({ token: t, type: t.value.match(new RegExp(`@var\\s+(\\S+)\\s+\\$${name}\\b`))?.[1] ?? t.value.match(new RegExp(`@var\\s+\\$${name}\\s+(\\S+)`))?.[1] })).filter(a => a.type).at(-1);
    for (let i = ts.length - 1; i >= 0; i--) {
      if (annotation && annotation.token.start > ts[i].start) return this.resolveTypes(file, annotation.type!, annotation.token.start);
      if (ts[i].value !== `$${name}` || ['->', '?->', '::'].includes(ts[i - 1]?.value)) continue;
      if (ts[i + 1]?.value === 'instanceof' && ts[i + 2]?.kind === 'word') {
        const index = tokenIndex(file.code, ts[i].start);
        for (let open = index - 1; open >= 0; open--) {
          if (file.code[open].value !== '(' || file.code[open - 1]?.value !== 'if') continue;
          const close = file.pairs.get(open); if (close === undefined || close <= index) continue;
          const body = close + 1, end = file.pairs.get(body);
          const condition = file.code.slice(open + 1, close);
          if (file.code[body]?.value === '{' && file.code[body].end <= offset && (end === undefined || offset < file.code[end].start) && !condition.some(t => ['!', '||', 'or', '===', '==', '!=', '!=='].includes(t.value))) {
            return this.resolveTypes(file, ts[i + 2].value, ts[i].start);
          }
          break;
        }
      }
      if (ts[i + 1]?.value === '=') {
        let j = i + 2, level = 0;
        for (; j < ts.length; j++) {
          const v = ts[j].value;
          if (level === 0 && [';', ','].includes(v)) break;
          if (['(', '[', '{'].includes(v)) level++;
          if ([')', ']', '}'].includes(v)) { if (level === 0) break; level--; }
        }
        // Latest assignment wins, including assignments to an unknown/scalar value.
        return this.expressionTypes(file, ts.slice(i + 2, j), ts[i].start, depth + 1);
      }
      if (ts[i - 1]?.value === 'as' || ts[i - 1]?.value === '=>') {
        let as = i - 1; while (as >= 0 && !['as', ';', '{'].includes(ts[as].value)) as--;
        let open = as - 1; while (open >= 0 && !(ts[open].value === '(' && ts[open - 1]?.value === 'foreach')) open--;
        if (open >= 0) return this.expressionTypes(file, ts.slice(open + 1, as), ts[open].start, depth + 1).filter(t => t.endsWith('[]')).map(t => t.slice(0, -2));
      }
    }
    if (annotation) return this.resolveTypes(file, annotation.type!, annotation.token.start);
    const parameter = scope?.parameters.find(p => p.name === name);
    if (parameter) return this.resolveTypes(file, parameter.type, scope!.start);
    if (scope && (scope.arrow || scope.captures.includes(name))) return this.variableTypes(file, name, scope.start - 1, depth + 1);
    return [];
  }

  expressionTypes(file: PhpFile, input: Token[], offset: number, depth = 0): string[] {
    if (depth > 16 || !input.length) return [];
    const ts = input; const last = ts.at(-1)!;
    const caller = classAt(file, offset)?.fqName;
    const matchingOpen = (close: number) => {
      const closing = ts[close].value, opening = closing === ')' ? '(' : '['; let level = 0;
      for (let i = close; i >= 0; i--) { if (ts[i].value === closing) level++; if (ts[i].value === opening && --level < 0) return -1; if (ts[i].value === opening && level === 0) return i; }
      return -1;
    };
    if (last.value === ')') {
      const open = matchingOpen(ts.length - 1); if (open < 0) return [];
      const callee = ts[open - 1];
      if (!callee || callee.kind !== 'word') return this.expressionTypes(file, ts.slice(open + 1, -1), offset, depth + 1);
      if (ts[open - 2]?.value === 'new') return this.resolveTypes(file, callee.value, offset);
      const op = ts[open - 2]?.value;
      if (['->', '?->', '::'].includes(op)) {
        const receivers = this.expressionTypes(file, ts.slice(0, open - 2), offset, depth + 1);
        return [...new Set(receivers.flatMap(type => this.membersOf(type, caller, op === '::' ? 'parent' : 'instance').filter(r => r.declaration.kind === 'method' && r.declaration.name.toLowerCase() === callee.value.toLowerCase()).flatMap(r => this.returned(r, type))))];
      }
      const ref = this.functionNamed(file, callee.value, offset); return ref ? this.returned(ref) : [];
    }
    if (last.value === ']') {
      const open = matchingOpen(ts.length - 1);
      return open > 0 ? this.expressionTypes(file, ts.slice(0, open), offset, depth + 1).filter(t => t.endsWith('[]')).map(t => t.slice(0, -2)) : [];
    }
    const op = ts.at(-2)?.value;
    if (['->', '?->', '::'].includes(op ?? '')) {
      const receivers = this.expressionTypes(file, ts.slice(0, -2), offset, depth + 1);
      return [...new Set(receivers.flatMap(type => this.membersOf(type, caller, op === '::' ? 'static' : 'instance').filter(r => r.declaration.kind !== 'method' && r.declaration.name === last.value.replace(/^\$/, '')).flatMap(r => this.returned(r, type))))];
    }
    if (last.kind === 'variable') return this.variableTypes(file, last.value.slice(1), offset, depth + 1);
    if (last.kind === 'word') return this.resolveTypes(file, last.value, offset);
    return [];
  }

  memberCandidates(file: PhpFile, offset: number, context: MemberContext): SymbolReference[] {
    const caller = classAt(file, offset)?.fqName;
    const parentAccess = context.operator === '::' && ['parent', 'self', 'static'].includes(context.receiver.at(-1)?.value ?? '') && !functionAt(file, offset)?.isStatic;
    const types = this.expressionTypes(file, context.receiver, offset);
    const result = new Map<string, SymbolReference>();
    for (const type of types) for (const ref of this.membersOf(type, caller, context.operator === '::' ? parentAccess ? 'parent' : 'static' : 'instance')) {
      if (matches(ref.declaration.name, context.prefix.replace(/^\$/, ''))) result.set(`${ref.declaration.kind}:${ref.declaration.name}`, ref);
    }
    return [...result.values()];
  }
  symbolAt(file: PhpFile, offset: number): SymbolReference[] {
    const token = file.code.find(t => t.start <= offset && offset <= t.end && ['word', 'variable'].includes(t.kind));
    if (!token) return [];
    const context = memberContext(file, token.end);
    if (context) return this.memberCandidates(file, token.end, context).filter(r => normalize(r.declaration.name) === normalize(token.value.replace(/^\$/, '')));
    const declared = this.named(token.value).find(r => r.file === file && r.declaration.nameStart === token.start);
    if (declared) return [declared];
    if (token.kind === 'variable') return this.variableTypes(file, token.value.slice(1), offset).flatMap(t => this.type(t) ?? []);
    const next = file.code.find(t => t.start >= token.end);
    if (next?.value === '(' && file.code[file.code.indexOf(token) - 1]?.value !== 'new') {
      const fn = this.functionNamed(file, token.value, offset); return fn ? [fn] : [];
    }
    const ref = this.type(resolveName(file, token.value, offset));
    const constantName = resolveName(file, token.value, offset, 'const');
    return ref ? [ref] : this.globalNamed(constantName).filter(r => r.declaration.kind === 'constant' && r.declaration.fqName === constantName);
  }
  callable(file: PhpFile, tokens: Token[], offset: number): SymbolReference | undefined {
    const name = tokens.at(-1); if (!name) return;
    if (tokens.at(-2)?.value === 'new') {
      const type = resolveName(file, name.value, offset);
      return this.membersOf(type, classAt(file, offset)?.fqName).find(r => r.declaration.name.toLowerCase() === '__construct');
    }
    const context = memberContext({ ...file, code: tokens }, name.end);
    if (context) return this.memberCandidates(file, offset, context).find(r => r.declaration.kind === 'method' && r.declaration.name.toLowerCase() === name.value.toLowerCase());
    return this.functionNamed(file, name.value, offset);
  }
}

export function matches(name: string, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return name.toLowerCase().startsWith(needle) || initials(name).startsWith(needle);
}
function initials(name: string): string { return (name.match(/(?:^[a-z]|[A-Z]|(?<=_)[a-z])/g) ?? []).join('').toLowerCase(); }
export function memberContext(file: PhpFile, offset: number): MemberContext | undefined {
  const ts = file.code;
  let i = tokenIndex(ts, offset) - 1; let prefix = ''; let start = offset;
  if (ts[i] && (['word', 'variable'].includes(ts[i].kind) || ts[i].value === '$')) { prefix = ts[i].value.slice(0, offset - ts[i].start); start = ts[i].start; i--; }
  if (!['->', '?->', '::'].includes(ts[i]?.value)) return;
  return { receiver: ts.slice(0, i), operator: ts[i].value, prefix, start };
}
export function activeCall(file: PhpFile, offset: number): { callee: Token[]; argument: number; name?: string; usedNames: string[]; atArgumentStart: boolean } | undefined {
  const ts = file.code, end = tokenIndex(ts, offset); let depth = 0;
  for (let i = end - 1; i >= 0; i--) {
    const v = ts[i].value;
    if ([')', ']', '}'].includes(v)) depth++;
    else if (['(', '[', '{'].includes(v)) {
      if (depth > 0) { depth--; continue; }
      if (v !== '(' || ts[i - 1]?.kind !== 'word') return;
      if (['if', 'while', 'for', 'foreach', 'switch', 'catch', 'match', 'isset', 'empty', 'array', 'function'].includes(ts[i - 1].value) || ts[i - 2]?.value === 'function') return;
      const args = splitTopLevel(ts.slice(i + 1, end)); const last = args.at(-1)!;
      return { callee: ts.slice(0, i), argument: args.length - 1, name: last[1]?.value === ':' ? last[0].value : undefined,
        usedNames: args.slice(0, -1).filter(a => a[1]?.value === ':').map(a => a[0].value), atArgumentStart: last.length === 0 || last.length === 1 && last[0].kind === 'word' };
    }
  }
  return;
}

export function completionLocation(file: PhpFile, offset: number): 'code' | 'doc' | 'none' {
  const preceding = file.tokens[tokenIndex(file.tokens, offset) - 1];
  const token = preceding && (offset < preceding.end || offset === preceding.end && (preceding.kind === 'comment' && !preceding.value.endsWith('*/') || preceding.kind === 'string' && !/['"`]$/.test(preceding.value))) ? preceding : undefined;
  if (token?.kind === 'comment') return token.value.startsWith('/**') ? 'doc' : 'none';
  if (token?.kind === 'string') return 'none';
  if (file.text.includes('<?')) {
    const before = file.text.slice(0, offset); if (before.lastIndexOf('<?') < before.lastIndexOf('?>') || !before.includes('<?')) return 'none';
  }
  return 'code';
}

export function importEdit(project: PhpProject, file: PhpFile, offset: number, ref: SymbolReference, typed: string): { name: string; offset?: number; text?: string } {
  const d = ref.declaration, ns = namespaceAt(file, offset);
  if (typed.includes('\\')) return { name: `\\${d.fqName}` };
  const kind = d.kind === 'function' ? 'function' : d.kind === 'constant' ? 'const' : 'type';
  const imported = ns.imports.find(i => i.kind === kind && normalize(i.name) === normalize(d.fqName));
  if (imported) return { name: imported.alias };
  if (d.namespace === ns.name) return { name: d.name };
  const collision = ns.imports.some(i => i.kind === kind && normalize(i.alias) === normalize(d.name)) || project.globalNamed([ns.name, d.name].filter(Boolean).join('\\')).some(r => r.declaration.namespace === ns.name && (kind === 'type' ? isType(r.declaration) : r.declaration.kind === d.kind));
  if (collision || ns.insertOffset === 0) return { name: `\\${d.fqName}` };
  const newline = file.text.includes('\r\n') ? '\r\n' : '\n';
  return { name: d.name, offset: ns.insertOffset, text: `${newline}use ${kind === 'type' ? '' : `${kind} `}${d.fqName};${newline}` };
}
