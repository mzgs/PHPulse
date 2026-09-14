/** Tolerant PHP lexical analysis. Offsets always refer to the original source. */
export interface Token { value: string; start: number; end: number; kind: 'word' | 'variable' | 'string' | 'comment' | 'symbol' }
export type SymbolKind = 'class' | 'interface' | 'trait' | 'enum' | 'function' | 'method' | 'property' | 'constant';
export interface Import { name: string; alias: string; kind: 'type' | 'function' | 'const'; end: number }
export interface NamespaceScope { name: string; start: number; end: number; imports: Import[]; insertOffset: number }
export interface Parameter { name: string; type: string; label: string; optional: boolean; variadic: boolean }
export interface Declaration {
  name: string; fqName: string; kind: SymbolKind; start: number; end: number; nameStart: number;
  namespace: string; owner?: string; signature?: string; doc?: string; type?: string;
  visibility: 'public' | 'protected' | 'private'; isStatic: boolean;
  parents: string[]; traits: string[]; parameters: Parameter[]; bodyStart?: number;
}
export interface FunctionScope { start: number; end: number; bodyStart: number; parameters: Parameter[]; captures: string[]; arrow: boolean; isStatic: boolean; owner?: string }
export interface PhpFile {
  text: string; tokens: Token[]; code: Token[]; pairs: Map<number, number>;
  namespaces: NamespaceScope[]; declarations: Declaration[]; functions: FunctionScope[];
}

export function tokenize(text: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  // PHP-only files under construction may not have an opening tag yet.
  let php = !text.includes('<?');
  while (i < text.length) {
    if (!php) { const next = text.indexOf('<?', i); if (next < 0) break; i = next + (text.startsWith('<?php', next) ? 5 : text.startsWith('<?=', next) ? 3 : 2); php = true; continue; }
    if (text.startsWith('?>', i)) { php = false; i += 2; continue; }
    if (/\s/.test(text[i])) { i++; continue; }
    const start = i;
    let kind: Token['kind'] = 'symbol';
    if (text.startsWith('//', i) || (text[i] === '#' && text[i + 1] !== '[')) {
      kind = 'comment'; while (i < text.length && text[i] !== '\n' && !text.startsWith('?>', i)) i++;
    } else if (text.startsWith('/*', i)) {
      kind = 'comment'; const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2;
    } else if (text.startsWith('<<<', i)) {
      const header = text.slice(i).match(/^<<<[ \t]*['"]?([A-Za-z_]\w*)['"]?[^\n]*\n/);
      if (header) {
        kind = 'string'; i += header[0].length;
        const end = new RegExp(`^[ \\t]*${header[1]}\\b`, 'm').exec(text.slice(i));
        i = end ? i + end.index + end[0].length : text.length;
      } else i += 3;
    } else if (['\'', '"', '`'].includes(text[i])) {
      kind = 'string'; const quote = text[i++];
      while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i++] === quote) break; }
      i = Math.min(i, text.length);
    } else {
      const name = text.slice(i).match(/^(?:\$[A-Za-z_\x80-\uffff][\w\x80-\uffff]*|\\?[A-Za-z_\x80-\uffff][\w\x80-\uffff]*(?:\\[A-Za-z_\x80-\uffff][\w\x80-\uffff]*)*)/);
      if (name) { i += name[0].length; kind = name[0][0] === '$' ? 'variable' : 'word'; }
      else { const op = ['?->', '...', '===', '!==', '=>', '->', '::', '??', '==', '!=', '&&', '||', '#['].find(v => text.startsWith(v, i)); i += op?.length ?? 1; }
    }
    result.push({ value: text.slice(start, i), start, end: i, kind });
  }
  return result;
}

export function splitTopLevel(tokens: Token[], delimiter = ','): Token[][] {
  const result: Token[][] = []; let part: Token[] = []; let depth = 0;
  for (const t of tokens) {
    if (t.value === delimiter && depth === 0) { result.push(part); part = []; continue; }
    part.push(t);
    if (['(', '[', '{', '#['].includes(t.value)) depth++;
    if ([')', ']', '}'].includes(t.value)) depth--;
  }
  result.push(part); return result;
}

export function namespaceAt(file: PhpFile, offset: number): NamespaceScope {
  return file.namespaces.find(s => s.start <= offset && offset <= s.end) ?? file.namespaces[0];
}
export function classAt(file: PhpFile, offset: number): Declaration | undefined {
  let index = classScopes.get(file);
  if (!index) { index = scopeIndex(file.declarations.filter(d => isType(d) && d.bodyStart !== undefined), d => d.bodyStart!); classScopes.set(file, index); }
  return scopeAt(file, index, offset);
}
export function functionAt(file: PhpFile, offset: number): FunctionScope | undefined {
  let index = functionScopes.get(file);
  if (!index) { index = scopeIndex(file.functions, s => s.start); functionScopes.set(file, index); }
  return scopeAt(file, index, offset);
}
interface ScopeIndex<T> { scopes: T[]; starts: number[]; parents: number[] }
const classScopes = new WeakMap<PhpFile, ScopeIndex<Declaration>>();
const functionScopes = new WeakMap<PhpFile, ScopeIndex<FunctionScope>>();
function scopeIndex<T extends { end: number }>(scopes: T[], start: (scope: T) => number): ScopeIndex<T> {
  const sorted = [...scopes].sort((a, b) => start(a) - start(b));
  const starts = sorted.map(start), parents: number[] = [], stack: number[] = [];
  sorted.forEach((scope, i) => {
    while (stack.length && sorted[stack.at(-1)!].end <= starts[i]) stack.pop();
    parents.push(stack.at(-1) ?? -1); stack.push(i);
  });
  return { scopes: sorted, starts, parents };
}
function scopeAt<T extends { end: number }>(file: PhpFile, index: ScopeIndex<T>, offset: number): T | undefined {
  let low = 0, high = index.starts.length;
  while (low < high) { const mid = (low + high) >>> 1; if (index.starts[mid] <= offset) low = mid + 1; else high = mid; }
  for (let i = low - 1; i >= 0; i = index.parents[i]) if (containsOffset(file, index.scopes[i], offset)) return index.scopes[i];
  return undefined;
}
/** First token whose start is at or after the offset. Token arrays are source ordered. */
export function tokenIndex(tokens: Token[], offset: number): number {
  let low = 0, high = tokens.length;
  while (low < high) { const mid = (low + high) >>> 1; if (tokens[mid].start < offset) low = mid + 1; else high = mid; }
  return low;
}
function containsOffset(file: PhpFile, scope: { end: number }, offset: number): boolean {
  return offset < scope.end || offset === file.text.length && scope.end === offset && !['}', ';'].includes(file.text[offset - 1]);
}
export function isType(d: Declaration): boolean { return ['class', 'interface', 'trait', 'enum'].includes(d.kind); }
const scalarTypes = new Set(['int', 'float', 'string', 'bool', 'array', 'object', 'mixed', 'void', 'never', 'null', 'false', 'true', 'callable', 'iterable', 'resource']);
export function resolveName(file: PhpFile, name: string, offset: number, kind: Import['kind'] = 'type'): string {
  if (name.startsWith('\\')) return name.slice(1);
  if (scalarTypes.has(name.toLowerCase())) return name.toLowerCase();
  const ns = namespaceAt(file, offset);
  if (name.toLowerCase().startsWith('namespace\\')) return [ns.name, name.slice(10)].filter(Boolean).join('\\');
  const parts = name.split('\\');
  const imp = ns.imports.find(x => x.kind === kind && x.alias.toLowerCase() === parts[0].toLowerCase());
  if (imp) return [imp.name, ...parts.slice(1)].join('\\');
  return [ns.name, name].filter(Boolean).join('\\');
}

export function parseSource(text: string): PhpFile {
  const tokens = tokenize(text), code = tokens.filter(t => t.kind !== 'comment');
  const file: PhpFile = { text, tokens, code, pairs: new Map(), namespaces: [], declarations: [], functions: [] };
  const stack: number[] = [];
  code.forEach((t, i) => {
    if (['{', '(', '[', '#['].includes(t.value)) stack.push(i);
    else if (['}', ')', ']'].includes(t.value)) {
      const expected = t.value === '}' ? '{' : t.value === ')' ? '(' : '[';
      const top = stack.at(-1);
      if (top !== undefined && (code[top].value === expected || expected === '[' && code[top].value === '#[')) {
        stack.pop(); file.pairs.set(top, i); file.pairs.set(i, top);
      }
    }
  });
  const value = (i: number) => code[i]?.value ?? '';
  const endOf = (i: number) => file.pairs.get(i) ?? code.length;
  const raw = (ts: Token[]) => ts.length ? text.slice(ts[0].start, ts.at(-1)!.end) : '';
  const docBefore = (offset: number) => {
    let low = 0, high = tokens.length;
    while (low < high) { const mid = (low + high) >>> 1; if (tokens[mid].end <= offset) low = mid + 1; else high = mid; }
    const prev = tokens[low - 1];
    return prev?.kind === 'comment' && prev.value.startsWith('/**') ? prev.value : undefined;
  };
  function parameters(start: number, end: number, doc?: string): Parameter[] {
    return splitTopLevel(code.slice(start, end)).flatMap(part => {
      const v = part.findIndex(t => t.kind === 'variable'); if (v < 0) return [];
      const name = part[v].value.slice(1);
      const native = part.slice(0, v).filter((t, i) => !['public', 'protected', 'private', 'readonly', '...'].includes(t.value) && !(t.value === '&' && (i === v - 1 || part[i + 1]?.value === '...')));
      const documented = doc?.match(new RegExp(`@param\\s+(\\S+)\\s+(?:\\.\\.\\.)?\\$${name}\\b`))?.[1];
      return [{ name, type: documented ?? native.map(t => t.value).join(''), label: raw(part), optional: part.some(t => t.value === '='), variadic: part.some(t => t.value === '...') }];
    });
  }
  function imports(start: number, end: number, ns: NamespaceScope): void {
    let list = code.slice(start, end); let kind: Import['kind'] = 'type';
    if (list[0]?.value === 'function' || list[0]?.value === 'const') { kind = list[0].value as Import['kind']; list = list.slice(1); }
    const group = list.findIndex(t => t.value === '{');
    const prefix = group >= 0 ? list.slice(0, group).map(t => t.value).join('').replace(/\\?$/, '\\') : '';
    if (group >= 0) list = list.slice(group + 1, list.at(-1)?.value === '}' ? -1 : undefined);
    for (let part of splitTopLevel(list)) {
      let itemKind = kind;
      if (['function', 'const'].includes(part[0]?.value)) { itemKind = part[0].value as Import['kind']; part = part.slice(1); }
      const as = part.findIndex(t => t.value.toLowerCase() === 'as');
      const name = (prefix + part.slice(0, as < 0 ? undefined : as).map(t => t.value).join('')).replace(/^\\/, '');
      if (name) ns.imports.push({ name, alias: as < 0 ? name.split('\\').pop()! : part[as + 1]?.value ?? '', kind: itemKind, end: code[end]?.end ?? text.length });
    }
    ns.insertOffset = code[end]?.end ?? ns.insertOffset;
  }
  function scan(start: number, end: number, ns: NamespaceScope, owner?: Declaration, inFunction = false): void {
    let i = start;
    while (i < end) {
      const begin = i;
      if (value(i) === '#[') { i = endOf(i) + 1; continue; }
      const modifiers: string[] = [];
      while (['abstract', 'final', 'public', 'protected', 'private', 'static', 'readonly', 'var'].includes(value(i))) modifiers.push(value(i++));
      const visibility = modifiers.includes('private') ? 'private' : modifiers.includes('protected') ? 'protected' : 'public';
      const doc = docBefore(code[begin].start);
      const common = { start: code[begin].start, namespace: ns.name, visibility, isStatic: modifiers.includes('static'), doc, parents: [] as string[], traits: [] as string[], parameters: [] as Parameter[] } as const;
      if (value(i) === 'namespace' && !owner && !inFunction) {
        let j = i + 1; while (j < end && ![';', '{'].includes(value(j))) j++;
        if (ns.end === text.length) ns.end = code[begin].start - 1;
        const next: NamespaceScope = { name: code.slice(i + 1, j).map(t => t.value).join(''), start: code[begin].start, end: text.length, imports: [], insertOffset: code[j]?.end ?? text.length };
        file.namespaces.push(next);
        if (value(j) === '{') { const close = endOf(j); next.end = code[close]?.end ?? text.length; scan(j + 1, close, next); i = close + 1; }
        else { ns = next; i = j + 1; }
        continue;
      }
      if (value(i) === 'use' && !inFunction) {
        let j = i + 1;
        while (j < end && value(j) !== ';') { if (value(j) === '{') { j = endOf(j) + 1; if (owner) break; } else j++; }
        if (owner) owner.traits.push(...splitTopLevel(code.slice(i + 1, j).filter(t => t.start < (code.slice(i + 1, j).find(t => t.value === '{')?.start ?? Infinity))).map(p => resolveName(file, raw(p), code[i].start)));
        else imports(i + 1, j, ns);
        i = j + (value(j) === ';' ? 1 : 0); continue;
      }
      if (['class', 'interface', 'trait', 'enum'].includes(value(i)) && code[i + 1]?.kind === 'word' && value(i - 1) !== '::') {
        const name = code[i + 1]; let j = i + 2; while (j < end && value(j) !== '{') j++;
        const close = endOf(j);
        const d: Declaration = { ...common, name: name.value, fqName: [ns.name, name.value].filter(Boolean).join('\\'), kind: value(i) as SymbolKind, nameStart: name.start, end: code[close]?.end ?? text.length, bodyStart: code[j]?.end, signature: text.slice(code[i].start, code[j]?.start ?? text.length).trim() };
        let parent = false;
        for (let k = i + 2; k < j; k++) { if (['extends', 'implements'].includes(value(k))) parent = true; else if (parent && code[k].kind === 'word') d.parents.push(resolveName(file, value(k), d.start)); }
        file.declarations.push(d); scan(j + 1, Math.min(close, end), ns, d); i = close + 1; continue;
      }
      if (value(i) === 'function' || value(i) === 'fn') {
        const arrow = value(i) === 'fn'; let n = i + 1; if (value(n) === '&') n++;
        const named = code[n]?.kind === 'word'; const name = named ? code[n++] : undefined;
        if (value(n) !== '(') { i++; continue; }
        const closeParams = endOf(n); if (closeParams >= end) { i = end; continue; }
        const params = parameters(n + 1, closeParams, doc);
        let j = closeParams + 1; const captures: string[] = [];
        if (value(j) === 'use' && value(j + 1) === '(') { const close = endOf(j + 1); captures.push(...code.slice(j + 2, close).filter(t => t.kind === 'variable').map(t => t.value.slice(1))); j = close + 1; }
        const returnStart = value(j) === ':' ? ++j : -1;
        while (j < end && !['{', ';', '=>'].includes(value(j))) j++;
        const returnType = returnStart < 0 ? '' : code.slice(returnStart, j).map(t => t.value).join('');
        let close = value(j) === '{' ? endOf(j) : j;
        if (arrow) { close = j + 1; while (close < end && ![';', ','].includes(value(close))) { if (file.pairs.has(close) && ['(', '[', '{'].includes(value(close))) close = endOf(close); close++; } }
        const scope: FunctionScope = { start: code[begin].start, end: code[close]?.end ?? text.length, bodyStart: code[j]?.end ?? text.length, parameters: params, captures, arrow, isStatic: common.isStatic, owner: owner?.fqName };
        file.functions.push(scope);
        if (name) {
          const d: Declaration = { ...common, name: name.value, fqName: owner && !inFunction ? `${owner.fqName}::${name.value}` : [ns.name, name.value].filter(Boolean).join('\\'), kind: owner && !inFunction ? 'method' : 'function', owner: owner && !inFunction ? owner.fqName : undefined, nameStart: name.start, end: scope.end, bodyStart: scope.bodyStart, parameters: params, type: doc?.match(/@return\s+(\S+)/)?.[1] ?? returnType, signature: `${name.value}(${params.map(p => p.label).join(', ')})${returnType ? `: ${returnType}` : ''}` };
          file.declarations.push(d);
          if (owner && name.value.toLowerCase() === '__construct') {
            for (const part of splitTopLevel(code.slice(n + 1, closeParams))) {
              const v = part.find(t => t.kind === 'variable'); const access = part.find(t => ['public', 'protected', 'private'].includes(t.value));
              if (v && access) file.declarations.push({ ...common, name: v.value.slice(1), fqName: `${owner.fqName}::${v.value.slice(1)}`, kind: 'property', owner: owner.fqName, nameStart: v.start + 1, end: v.end, type: params.find(p => p.name === v.value.slice(1))?.type, visibility: access.value as Declaration['visibility'], isStatic: false });
            }
          }
        }
        if (value(j) === '{') scan(j + 1, Math.min(close, end), ns, owner, true);
        i = close + 1; continue;
      }
      if (!inFunction && (value(i) === 'const' || owner && value(i) === 'case')) {
        let j = i + 1; while (j < end && value(j) !== ';') j++;
        for (const part of splitTopLevel(code.slice(i + 1, j))) {
          const eq = part.findIndex(t => t.value === '='); const name = part.slice(0, eq < 0 ? undefined : eq).at(-1);
          if (name?.kind === 'word') file.declarations.push({ ...common, name: name.value, fqName: owner ? `${owner.fqName}::${name.value}` : [ns.name, name.value].filter(Boolean).join('\\'), owner: owner?.fqName, kind: 'constant', nameStart: name.start, end: code[j]?.end ?? text.length, isStatic: true, type: owner?.kind === 'enum' ? `\\${owner.fqName}` : undefined });
        }
        i = j + 1; continue;
      }
      if (owner && !inFunction) {
        let j = i; while (j < end && ![';', '{', '}'].includes(value(j))) { if (value(j) === '(' || value(j) === '[') j = endOf(j) + 1; else j++; }
        const parts = splitTopLevel(code.slice(i, j)); const firstVar = parts[0]?.findIndex(t => t.kind === 'variable') ?? -1;
        if (firstVar >= 0) {
          const type = parts[0].slice(0, firstVar).map(t => t.value).join('');
          for (const part of parts) { const v = part.find(t => t.kind === 'variable'); if (v) file.declarations.push({ ...common, name: v.value.slice(1), fqName: `${owner.fqName}::${v.value.slice(1)}`, owner: owner.fqName, kind: 'property', nameStart: v.start + 1, end: code[j]?.end ?? text.length, type: doc?.match(/@var\s+(\S+)/)?.[1] ?? type }); }
          i = j + 1; continue;
        }
      }
      i = Math.max(begin + 1, i);
    }
  }
  const root: NamespaceScope = { name: '', start: 0, end: text.length, imports: [], insertOffset: text.match(/<\?php/)?.index !== undefined ? text.indexOf('<?php') + 5 : 0 };
  file.namespaces.push(root);
  scan(0, code.length, root);
  // An import is legal after declare(), and must never precede strict_types.
  for (let i = 0; i < code.length; i++) if (code[i].value === 'declare' && code[i + 1]?.value === '(') {
    const close = file.pairs.get(i + 1); if (close !== undefined && code[close + 1]?.value === ';') {
      const ns = namespaceAt(file, code[i].start); ns.insertOffset = Math.max(ns.insertOffset, code[close + 1].end);
    }
  }
  return file;
}
