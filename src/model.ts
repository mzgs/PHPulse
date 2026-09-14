import * as vscode from 'vscode';

export type PhpSymbolKind = 'class' | 'interface' | 'trait' | 'enum' | 'function' | 'method' | 'property' | 'constant';

export interface PhpSymbol {
  name: string;
  fqName: string;
  kind: PhpSymbolKind;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;
  namespace: string;
  container?: string;
  signature?: string;
  doc?: string;
  extends?: string[];
}

const kindMap: Record<PhpSymbolKind, vscode.SymbolKind> = {
  class: vscode.SymbolKind.Class,
  interface: vscode.SymbolKind.Interface,
  trait: vscode.SymbolKind.Class,
  enum: vscode.SymbolKind.Enum,
  function: vscode.SymbolKind.Function,
  method: vscode.SymbolKind.Method,
  property: vscode.SymbolKind.Property,
  constant: vscode.SymbolKind.Constant
};

export function vscodeKind(kind: PhpSymbolKind): vscode.SymbolKind { return kindMap[kind]; }

export function wordRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
  return document.getWordRangeAtPosition(position, /[A-Za-z_\\][A-Za-z0-9_\\]*/);
}

export class PhpIndex implements vscode.Disposable {
  private readonly byUri = new Map<string, PhpSymbol[]>();
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer?: NodeJS.Timeout;
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changedEmitter.event;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(d => this.update(d)),
      vscode.workspace.onDidChangeTextDocument(e => this.schedule(e.document)),
      vscode.workspace.onDidSaveTextDocument(d => this.update(d)),
      vscode.workspace.onDidDeleteFiles(e => { for (const uri of e.files) this.byUri.delete(uri.toString()); this.changedEmitter.fire(); })
    );
  }

  async initialize(): Promise<void> {
    const exclude = vscode.workspace.getConfiguration('phpulse.index').get<string[]>('exclude', []);
    const files = await vscode.workspace.findFiles('**/*.{php,phtml,inc}', `{${exclude.join(',')}}`, 15000);
    const batch = 100;
    for (let i = 0; i < files.length; i += batch) {
      await Promise.all(files.slice(i, i + batch).map(async uri => {
        try { this.byUri.set(uri.toString(), parsePhp(uri, (await vscode.workspace.fs.readFile(uri)).toString())); } catch { /* unreadable */ }
      }));
    }
    this.changedEmitter.fire();
  }

  update(document: vscode.TextDocument): void {
    if (!['php', 'blade'].includes(document.languageId) && !document.fileName.endsWith('.php')) return;
    this.byUri.set(document.uri.toString(), parsePhp(document.uri, document.getText()));
    this.changedEmitter.fire();
  }

  private schedule(document: vscode.TextDocument): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.update(document), 250);
  }

  all(): PhpSymbol[] { return [...this.byUri.values()].flat(); }
  forDocument(uri: vscode.Uri): PhpSymbol[] { return this.byUri.get(uri.toString()) ?? []; }
  named(name: string): PhpSymbol[] {
    const simple = name.replace(/^\\/, '').split('\\').pop()?.toLowerCase();
    return this.all().filter(s => s.name.toLowerCase() === simple || s.fqName.toLowerCase() === name.replace(/^\\/, '').toLowerCase());
  }
  derivedFrom(name: string): PhpSymbol[] {
    const needle = name.replace(/^\\/, '').toLowerCase();
    return this.all().filter(s => s.extends?.some(e => e.replace(/^\\/, '').toLowerCase() === needle || e.split('\\').pop()?.toLowerCase() === needle.split('\\').pop()));
  }
  dispose(): void { if (this.refreshTimer) clearTimeout(this.refreshTimer); this.changedEmitter.dispose(); this.disposables.forEach(d => d.dispose()); }
}

export function parsePhp(uri: vscode.Uri, text: string): PhpSymbol[] {
  const symbols: PhpSymbol[] = [];
  const lines = text.split(/\r?\n/);
  let namespace = '';
  let currentType: { name: string; depth: number } | undefined;
  let depth = 0;
  let pendingDoc = '';
  let inDoc = false;

  const add = (name: string, kind: PhpSymbolKind, line: number, start: number, signature?: string, ext?: string[]) => {
    const container = currentType?.name;
    const fqName = kind === 'method' || kind === 'property' || kind === 'constant'
      ? `${namespace ? namespace + '\\' : ''}${container ?? ''}::${name}`
      : `${namespace ? namespace + '\\' : ''}${name}`;
    const selectionRange = new vscode.Range(line, start, line, start + name.length);
    symbols.push({ name, fqName, kind, uri, range: new vscode.Range(line, 0, line, lines[line].length), selectionRange, namespace, container, signature, doc: pendingDoc, extends: ext });
    pendingDoc = '';
  };

  lines.forEach((line, lineNo) => {
    if (/^\s*\/\*\*/.test(line)) { inDoc = true; pendingDoc = line.trim(); }
    else if (inDoc) pendingDoc += `\n${line.trim()}`;
    if (inDoc && /\*\//.test(line)) inDoc = false;
    if (inDoc) return;

    const ns = line.match(/^\s*namespace\s+([^;{]+)/);
    if (ns) namespace = ns[1].trim();

    const type = line.match(/\b(class|interface|trait|enum)\s+([A-Za-z_]\w*)([^\{]*)/);
    if (type && !/::class\b/.test(line)) {
      const kind = type[1] as PhpSymbolKind;
      const parents = [...type[3].matchAll(/(?:extends|implements|,)\s*([\\A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*)/g)].map(m => m[1]);
      add(type[2], kind, lineNo, line.indexOf(type[2]), line.trim(), parents);
      currentType = { name: type[2], depth: depth + (line.includes('{') ? 1 : 0) };
    }

    const fn = line.match(/\bfunction\s+&?\s*([A-Za-z_]\w*)\s*(\([^)]*\)(?:\s*:\s*[^\s{;]+)?)/);
    if (fn) add(fn[1], currentType ? 'method' : 'function', lineNo, line.indexOf(fn[1]), `${fn[1]}${fn[2]}`);

    if (currentType) {
      for (const m of line.matchAll(/(?:public|protected|private|static|readonly|var|\s)+\s*(?:[?\\A-Za-z_|&][\\A-Za-z0-9_|&?]*\s+)?\$([A-Za-z_]\w*)/g)) {
        add(m[1], 'property', lineNo, line.indexOf(m[1], m.index));
      }
      const c = line.match(/\bconst\s+(?:[A-Za-z_|?]+\s+)?([A-Za-z_]\w*)/);
      if (c) add(c[1], 'constant', lineNo, line.indexOf(c[1]));
    }

    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (currentType && depth < currentType.depth) currentType = undefined;
    if (!line.trim().startsWith('*') && !/^\s*(?:#\[|\/\/|#)/.test(line) && line.trim() && !type && !fn) pendingDoc = '';
  });
  return symbols;
}
