import * as vscode from 'vscode';
import { PhpProject, SymbolReference, matches } from './intelligence';
import { PhpFile, SymbolKind } from './phpSyntax';

export type PhpSymbolKind = SymbolKind;
export interface PhpSymbol {
  name: string; fqName: string; kind: PhpSymbolKind; uri: vscode.Uri;
  range: vscode.Range; selectionRange: vscode.Range; namespace: string;
  container?: string; signature?: string; doc?: string; extends?: string[]; isStatic?: boolean;
  type?: string;
}
const kindMap: Record<PhpSymbolKind, vscode.SymbolKind> = {
  class: vscode.SymbolKind.Class, interface: vscode.SymbolKind.Interface, trait: vscode.SymbolKind.Class,
  enum: vscode.SymbolKind.Enum, function: vscode.SymbolKind.Function, method: vscode.SymbolKind.Method,
  property: vscode.SymbolKind.Property, constant: vscode.SymbolKind.Constant
};
export function vscodeKind(kind: PhpSymbolKind): vscode.SymbolKind { return kindMap[kind]; }
export function wordRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
  return document.getWordRangeAtPosition(position, /[A-Za-z_\\][A-Za-z0-9_\\]*/);
}

const lineOffsets = new WeakMap<PhpFile, number[]>();
const editorSymbols = new WeakMap<SymbolReference, PhpSymbol>();
export function symbolFor(ref: SymbolReference): PhpSymbol {
  const cached = editorSymbols.get(ref); if (cached) return cached;
  const d = ref.declaration;
  let lines = lineOffsets.get(ref.file);
  if (!lines) { lines = [0]; for (let i = 0; i < ref.file.text.length; i++) if (ref.file.text[i] === '\n') lines.push(i + 1); lineOffsets.set(ref.file, lines); }
  const position = (offset: number) => {
    let low = 0, high = lines!.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (lines![mid] <= offset) low = mid; else high = mid; }
    return new vscode.Position(low, offset - lines![low]);
  };
  const symbol = { name: d.name, fqName: d.fqName, kind: d.kind, uri: vscode.Uri.parse(ref.uri),
    range: new vscode.Range(position(d.start), position(d.end)), selectionRange: new vscode.Range(position(d.nameStart), position(d.nameStart + d.name.length)),
    namespace: d.namespace, container: d.owner?.split('\\').pop(), signature: d.signature, doc: d.doc,
    extends: d.parents, isStatic: d.isStatic, type: d.type };
  editorSymbols.set(ref, symbol); return symbol;
}

export class PhpIndex implements vscode.Disposable {
  readonly project = new PhpProject();
  private symbols?: PhpSymbol[];
  private readonly documentVersions = new WeakMap<vscode.TextDocument, number>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private disposed = false;
  readonly onDidChange = this.changedEmitter.event;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{php,phtml,inc}');
    const refresh = async (uri: vscode.Uri) => {
      // Open buffers are authoritative, including unsaved edits.
      const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
      if (open) { this.update(open); return; }
      if (!this.project.files.has(uri.toString())) {
        const exclude = vscode.workspace.getConfiguration('phpulse.index').get<string[]>('exclude', []);
        const included = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), uri.path.split('/').pop()!), exclude.length ? `{${exclude.join(',')}}` : undefined, 1);
        if (!included.length) return;
      }
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        if (!this.disposed && !vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString())) this.updateSource(uri.toString(), text);
      } catch { /* Deleted or unreadable file. */ }
    };
    this.disposables.push(watcher,
      watcher.onDidCreate(refresh), watcher.onDidChange(refresh),
      watcher.onDidDelete(uri => { if (this.project.remove(uri.toString())) this.changed(); }),
      vscode.workspace.onDidOpenTextDocument(d => this.update(d)),
      vscode.workspace.onDidChangeTextDocument(e => this.schedule(e.document)),
      vscode.workspace.onDidSaveTextDocument(d => this.update(d)),
      vscode.workspace.onDidCloseTextDocument(d => { const timer = this.refreshTimers.get(d.uri.toString()); if (timer) clearTimeout(timer); this.refreshTimers.delete(d.uri.toString()); void refresh(d.uri); })
    );
  }
  async initialize(): Promise<void> {
    const exclude = vscode.workspace.getConfiguration('phpulse.index').get<string[]>('exclude', []);
    const files = await vscode.workspace.findFiles('**/*.{php,phtml,inc}', exclude.length ? `{${exclude.join(',')}}` : undefined, 15000);
    const retained = new Set([...files.map(u => u.toString()), ...vscode.workspace.textDocuments.map(d => d.uri.toString())]);
    for (const uri of this.project.files.keys()) if (!retained.has(uri)) this.project.remove(uri);
    for (let i = 0; i < files.length && !this.disposed; i += 100) {
      await Promise.all(files.slice(i, i + 100).map(async uri => {
        try {
          const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
          const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
          if (!this.disposed) this.project.update(uri.toString(), open?.getText() ?? text);
        } catch { /* Unreadable file. */ }
      }));
    }
    for (const d of vscode.workspace.textDocuments) if (this.accepts(d)) this.project.update(d.uri.toString(), d.getText());
    this.changed();
  }
  private accepts(d: vscode.TextDocument): boolean { return ['php', 'blade'].includes(d.languageId) || /\.(php|phtml|inc)$/.test(d.fileName); }
  update(document: vscode.TextDocument): void {
    if (this.disposed || !this.accepts(document)) return;
    const uri = document.uri.toString();
    if (document.version !== undefined && this.documentVersions.get(document) === document.version && this.project.files.has(uri)) return;
    this.updateSource(uri, document.getText());
    if (document.version !== undefined) this.documentVersions.set(document, document.version);
  }
  private updateSource(uri: string, text: string): void {
    if (this.project.files.get(uri)?.text === text) return;
    this.project.update(uri, text); this.changed();
  }
  current(document: vscode.TextDocument): PhpFile { this.update(document); return this.project.files.get(document.uri.toString())!; }
  private schedule(document: vscode.TextDocument): void {
    if (!this.accepts(document)) return;
    const key = document.uri.toString(), timer = this.refreshTimers.get(key);
    if (timer) clearTimeout(timer);
    this.refreshTimers.set(key, setTimeout(() => { this.refreshTimers.delete(key); this.update(document); }, 150));
  }
  all(): PhpSymbol[] { return this.symbols ??= this.project.all().map(symbolFor); }
  forDocument(uri: vscode.Uri): PhpSymbol[] { return this.project.forDocument(uri.toString()).map(symbolFor); }
  named(name: string): PhpSymbol[] {
    return this.project.named(name).map(symbolFor);
  }
  completionCandidates(query: string, kinds?: ReadonlySet<PhpSymbolKind>, limit = 300): PhpSymbol[] {
    return this.project.all().filter(r => (!kinds || kinds.has(r.declaration.kind)) && (matches(r.declaration.name, query) || r.declaration.fqName.toLowerCase().startsWith(query.replace(/^\\/, '').toLowerCase()))).slice(0, limit).map(symbolFor);
  }
  membersOf(typeName: string, query = '', limit = 300): PhpSymbol[] {
    return this.project.membersOf(typeName, typeName).filter(r => matches(r.declaration.name, query)).slice(0, limit).map(symbolFor);
  }
  derivedFrom(name: string): PhpSymbol[] {
    const targets = this.named(name).filter(s => ['class', 'interface', 'trait'].includes(s.kind)).map(s => s.fqName);
    return this.project.all().filter(r => r.declaration.parents.some(p => targets.some(t => t.toLowerCase() === p.toLowerCase()))).map(symbolFor);
  }
  private changed(): void {
    if (this.disposed) return;
    this.symbols = undefined;
    this.changedEmitter.fire();
  }
  dispose(): void { this.disposed = true; this.refreshTimers.forEach(clearTimeout); this.refreshTimers.clear(); this.changedEmitter.dispose(); this.disposables.forEach(d => d.dispose()); }
}

export function parsePhp(uri: vscode.Uri, text: string): PhpSymbol[] {
  const project = new PhpProject(); project.update(uri.toString(), text); return project.all().map(symbolFor);
}
