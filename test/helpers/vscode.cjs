const Module = require('node:module');
class Position {
  constructor(line, character) { Object.assign(this, { line, character }); }
  translate(line, character) { return new Position(this.line + line, this.character + character); }
}
class Range {
  constructor(a, b, c, d) { this.start = typeof a === 'number' ? new Position(a, b) : a; this.end = typeof a === 'number' ? new Position(c, d) : b; }
  get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
}
class WorkspaceEdit {
  edits = [];
  replace(uri, range, newText) { this.edits.push({ uri, range, newText }); }
  insert(uri, position, newText) { this.replace(uri, new Range(position, position), newText); }
  delete(uri, range) { this.replace(uri, range, ''); }
  set(uri, edits) { this.edits.push(...edits.map(e => ({ uri, ...e }))); }
}
const disposable = () => ({ dispose() {} });
const providers = {}, settings = {}, commands = {}, diagnostics = new Map(), documents = new Map();
const Uri = { parse: value => ({ toString: () => value, fsPath: value.replace(/^file:\/\//, ''), path: value.replace(/^file:\/\//, '') }) };
const stub = {
  Position, Range, WorkspaceEdit, Uri, SymbolKind: {}, CompletionItemKind: {},
  TextEdit: { replace: (range, newText) => ({ range, newText }), insert: (position, newText) => ({ range: new Range(position, position), newText }) },
  CodeActionKind: { QuickFix: 'quickfix', RefactorRewrite: 'refactor.rewrite', RefactorExtract: 'refactor.extract', SourceOrganizeImports: 'source.organizeImports' },
  CodeAction: class { constructor(title, kind) { Object.assign(this, { title, kind }); } },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  DiagnosticTag: { Unnecessary: 1 }, DiagnosticSeverity: { Error: 0, Warning: 1, Hint: 3 },
  EventEmitter: class { event = disposable; fire() {} dispose() {} },
  Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } },
  languages: new Proxy({}, { get: (_, name) => name === 'createDiagnosticCollection' ? () => ({
    set: (uri, items) => diagnostics.set(uri.toString(), items), get: uri => diagnostics.get(uri.toString()), delete: uri => diagnostics.delete(uri.toString()), dispose() {}
  }) : (...args) => { providers[name] = args[1] ?? args[0]; return disposable(); } }),
  commands: { registerCommand: (name, callback) => { commands[name] = callback; return disposable(); } },
  window: { onDidCloseTerminal: disposable },
  workspace: {
    getConfiguration: section => ({ get: (name, fallback) => settings[`${section}.${name}`] ?? fallback }),
    textDocuments: [], getWorkspaceFolder: () => undefined,
    openTextDocument: async uri => documents.get(uri.toString()),
    onDidOpenTextDocument: disposable, onDidSaveTextDocument: disposable, onDidChangeTextDocument: disposable,
    onDidCloseTextDocument: disposable, onDidChangeConfiguration: disposable,
    applyEdit: async edit => { for (const [uri, doc] of documents) doc.setText(apply(doc, edit.edits.filter(e => e.uri.toString() === uri))); return true; }
  }
};
function load(name) {
  const original = Module._load;
  Module._load = function (n, ...args) { return n === 'vscode' ? stub : original.call(this, n, ...args); };
  try { return require(name); } finally { Module._load = original; }
}
function document(text, filename = `${process.cwd()}/review.php`, languageId = 'php') {
  const doc = {
    uri: Uri.parse(`file://${filename}`), fileName: filename, languageId, version: 1, isClosed: false,
    get lineCount() { return text.split('\n').length; },
    getText(range) { return range ? text.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : text; },
    setText(value) { text = value; this.version++; },
    offsetAt(p) { return text.split('\n').slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.character; },
    positionAt(n) { const lines = text.slice(0, n).split('\n'); return new Position(lines.length - 1, lines.at(-1).length); },
    lineAt(n) { const line = text.split('\n')[n].replace(/\r$/, ''); return { text: line, range: new Range(n, 0, n, line.length), rangeIncludingLineBreak: new Range(n, 0, n + 1, 0) }; },
    getWordRangeAtPosition(p, re) { const line = this.lineAt(p.line).text; for (const m of line.matchAll(new RegExp(re.source, 'g'))) if (m.index <= p.character && p.character <= m.index + m[0].length) return new Range(p.line, m.index, p.line, m.index + m[0].length); }
  };
  documents.set(doc.uri.toString(), doc); return doc;
}
function apply(doc, edits) {
  let text = doc.getText();
  for (const e of [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start))) text = text.slice(0, doc.offsetAt(e.range.start)) + e.newText + text.slice(doc.offsetAt(e.range.end));
  return text;
}
const token = { isCancellationRequested: false, onCancellationRequested: disposable };
module.exports = { stub, providers, settings, commands, diagnostics, documents, document, apply, token, load };
