import * as vscode from 'vscode';
import { PhpIndex, PhpSymbol, vscodeKind, wordRange } from './model';
import { completePhp, resolvedSymbols, signatureHelp } from './completion';
import { formattingEdits } from './formatting';
import { renameEdits, renameTarget } from './rename';
import { parseSource } from './phpSyntax';
import { removeImports, unusedImports } from './imports';
import { extractConstant } from './refactoring';
export { formatPhp } from './formatting';

const keywords = ['abstract','and','array','as','break','callable','case','catch','class','clone','const','continue','declare','default','do','echo','else','elseif','empty','enddeclare','endfor','endforeach','endif','endswitch','endwhile','enum','eval','exit','extends','final','finally','fn','for','foreach','function','global','goto','if','implements','include','include_once','instanceof','insteadof','interface','isset','list','match','namespace','new','or','print','private','protected','public','readonly','require','require_once','return','static','switch','throw','trait','try','unset','use','var','while','xor','yield'];

const builtins: Record<string, { signature: string; description: string }> = {
  array_map: { signature: 'array_map(?callable $callback, array $array, array ...$arrays): array', description: 'Applies a callback to the elements of the given arrays.' },
  array_filter: { signature: 'array_filter(array $array, ?callable $callback = null, int $mode = 0): array', description: 'Filters elements of an array using a callback.' },
  count: { signature: 'count(Countable|array $value, int $mode = COUNT_NORMAL): int', description: 'Counts elements in an array or Countable object.' },
  json_encode: { signature: 'json_encode(mixed $value, int $flags = 0, int $depth = 512): string|false', description: 'Returns the JSON representation of a value.' },
  json_decode: { signature: 'json_decode(string $json, ?bool $associative = null, int $depth = 512, int $flags = 0): mixed', description: 'Decodes a JSON string.' },
  strlen: { signature: 'strlen(string $string): int', description: 'Returns the length of a string.' },
  strpos: { signature: 'strpos(string $haystack, string $needle, int $offset = 0): int|false', description: 'Finds the position of the first occurrence of a substring.' },
  sprintf: { signature: 'sprintf(string $format, mixed ...$values): string', description: 'Returns a formatted string.' },
  in_array: { signature: 'in_array(mixed $needle, array $haystack, bool $strict = false): bool', description: 'Checks if a value exists in an array.' },
  is_array: { signature: 'is_array(mixed $value): bool', description: 'Checks whether a variable is an array.' },
  preg_match: { signature: 'preg_match(string $pattern, string $subject, ?array &$matches = null, int $flags = 0, int $offset = 0): int|false', description: 'Performs a regular expression match.' },
  var_dump: { signature: 'var_dump(mixed $value, mixed ...$values): void', description: 'Dumps information about a variable.' }
};

export function registerLanguageFeatures(context: vscode.ExtensionContext, index: PhpIndex): void {
  const selector: vscode.DocumentSelector = [{ language: 'php' }, { language: 'blade' }];

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
    provideCompletionItems(document, position, token) { return completePhp(index, document, position, keywords, builtins, token); }
  }, '$', '>', ':', '\\', '@'));

  context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
    provideHover(document, position) {
      const range = wordRange(document, position); if (!range) return;
      const word = document.getText(range).replace(/^\\/, '');
      const found = resolvedSymbols(index, document, position)[0];
      if (found) {
        const md = new vscode.MarkdownString(); md.appendCodeblock(found.signature ?? `${found.kind} ${found.fqName}`, 'php');
        if (found.doc) md.appendMarkdown(`\n${found.doc.replace(/^\s*\/\*\*|\*\/$/g, '')}`);
        return new vscode.Hover(md, range);
      }
      const builtin = builtins[word.toLowerCase()];
      if (builtin) { const md = new vscode.MarkdownString(); md.appendCodeblock(builtin.signature, 'php'); md.appendMarkdown(`\n${builtin.description}\n\n[PHP manual](https://www.php.net/${word})`); md.isTrusted = true; return new vscode.Hover(md, range); }
    }
  }));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
    provideDefinition(document, position) { return resolvedSymbols(index, document, position).map(s => new vscode.Location(s.uri, s.selectionRange)); }
  }));
  context.subscriptions.push(vscode.languages.registerImplementationProvider(selector, {
    provideImplementation(document, position) { const r = wordRange(document, position); if (!r) return []; const name = document.getText(r); return [...index.named(name).filter(s => s.kind === 'method'), ...index.derivedFrom(name)].map(s => new vscode.Location(s.uri, s.selectionRange)); }
  }));
  context.subscriptions.push(vscode.languages.registerReferenceProvider(selector, {
    async provideReferences(document, position, options, token) { const r = wordRange(document, position); return r ? findReferences(document.getText(r), options.includeDeclaration, token) : []; }
  }));
  context.subscriptions.push(vscode.languages.registerRenameProvider(selector, {
    prepareRename(document, position) {
      if (document.languageId !== 'php') throw new Error('Semantic rename is available in PHP documents.');
      const target = renameTarget(index.project, index.current(document), document.offsetAt(position));
      const range = wordRange(document, position);
      if (!range) throw new Error('No PHP symbol at cursor.');
      return { range, placeholder: target.declaration.name };
    },
    async provideRenameEdits(document, position, newName, token) {
      if (token.isCancellationRequested) return;
      const version = document.version;
      // Refresh disk files and dirty buffers before resolving references.
      if (document.languageId !== 'php') throw new Error('Semantic rename is available in PHP documents.');
      await index.initialize(true);
      if (token.isCancellationRequested) return;
      if (document.version !== version) throw new Error('The document changed during rename. Please try again.');
      const target = renameTarget(index.project, index.current(document), document.offsetAt(position));
      const changes = renameEdits(index.project, target, newName);
      const sources = new Map([...changes.keys()].map(uri => [uri, index.project.files.get(uri)!.text]));
      const opened: { document: vscode.TextDocument; version: number }[] = [];
      const edit = new vscode.WorkspaceEdit();
      for (const [uri, edits] of changes) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        if (token.isCancellationRequested) return;
        if (doc.getText() !== sources.get(uri)) throw new Error('A document changed during rename. Please try again.');
        opened.push({ document: doc, version: doc.version });
        for (const e of edits) edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
      }
      if (opened.some(d => d.document.version !== d.version)) throw new Error('A document changed during rename. Please try again.');
      return edit;
    }
  }));

  context.subscriptions.push(vscode.languages.registerDocumentHighlightProvider(selector, {
    provideDocumentHighlights(document, position) { const r = wordRange(document, position); if (!r) return []; const re = new RegExp(`\\b${escapeRegExp(document.getText(r).replace(/^\\/, ''))}\\b`, 'g'); return [...document.getText().matchAll(re)].map(m => new vscode.DocumentHighlight(new vscode.Range(document.positionAt(m.index!), document.positionAt(m.index! + m[0].length)))); }
  }));

  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(selector, {
    provideDocumentSymbols(document) { return index.forDocument(document.uri).map(s => new vscode.DocumentSymbol(s.name, s.signature ?? s.fqName, vscodeKind(s.kind), s.range, s.selectionRange)); }
  }));
  context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider({
    provideWorkspaceSymbols(query) { const q = query.toLowerCase(); return index.all().filter(s => !q || s.fqName.toLowerCase().includes(q)).slice(0, 1000).map(s => new vscode.SymbolInformation(s.name, vscodeKind(s.kind), s.container ?? s.namespace, new vscode.Location(s.uri, s.selectionRange))); }
  }));

  context.subscriptions.push(vscode.languages.registerSignatureHelpProvider(selector, {
    provideSignatureHelp(document, position) { return signatureHelp(index, document, position, builtins); }
  }, '(', ','));

  context.subscriptions.push(vscode.languages.registerFoldingRangeProvider(selector, {
    provideFoldingRanges(document) {
      const ranges: vscode.FoldingRange[] = []; const stack: number[] = [];
      for (let i = 0; i < document.lineCount; i++) { const t = document.lineAt(i).text; for (const c of t) { if (c === '{') stack.push(i); else if (c === '}' && stack.length) { const start = stack.pop()!; if (i > start) ranges.push(new vscode.FoldingRange(start, i)); } } }
      return ranges;
    }
  }));

  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(selector, {
    provideDocumentFormattingEdits(document, _options, token) { return formattingEdits(document, token); }
  }));
  context.subscriptions.push(vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
    provideDocumentRangeFormattingEdits(document, range, _options, token) { return formattingEdits(document, token, range); }
  }));
  context.subscriptions.push(vscode.languages.registerOnTypeFormattingEditProvider(selector, {
    provideOnTypeFormattingEdits(document, position, ch, _options, token) {
      if (ch !== '}') return [];
      return formattingEdits(document, token, document.lineAt(position.line).range);
    }
  }, '}'));

  const codeActions = new PhpCodeActions(index);
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider(selector, codeActions, { providedCodeActionKinds: PhpCodeActions.kinds }));
  const lenses = new PhpCodeLens(index); context.subscriptions.push(lenses, vscode.languages.registerCodeLensProvider(selector, lenses));
  context.subscriptions.push(vscode.languages.registerInlayHintsProvider(selector, new PhpInlayHints(index)));
  context.subscriptions.push(vscode.languages.registerTypeHierarchyProvider(selector, new PhpTypeHierarchy(index)));
  context.subscriptions.push(vscode.languages.registerCallHierarchyProvider(selector, new PhpCallHierarchy(index)));
}

async function findReferences(name: string, includeDeclaration: boolean, token: vscode.CancellationToken): Promise<vscode.Location[]> {
  const exclude = vscode.workspace.getConfiguration('phpulse.index').get<string[]>('exclude', []);
  const files = await vscode.workspace.findFiles('**/*.{php,phtml,inc}', `{${exclude.join(',')}}`, 15000); const result: vscode.Location[] = [];
  const re = new RegExp(`\\b${escapeRegExp(name.replace(/^\\/, '').split('\\').pop()!)}\\b`, 'g');
  for (const uri of files) { if (token.isCancellationRequested) break; const doc = await vscode.workspace.openTextDocument(uri); for (const m of doc.getText().matchAll(re)) { const range = new vscode.Range(doc.positionAt(m.index!), doc.positionAt(m.index! + m[0].length)); if (includeDeclaration || !/\b(class|interface|trait|enum|function)\s*$/.test(doc.getText(new vscode.Range(new vscode.Position(range.start.line, 0), range.start)))) result.push(new vscode.Location(uri, range)); } }
  return result;
}

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

class PhpCodeActions implements vscode.CodeActionProvider {
  constructor(private index: PhpIndex) {}
  static readonly kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite, vscode.CodeActionKind.RefactorExtract, vscode.CodeActionKind.SourceOrganizeImports];
  provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const file = parseSource(document.getText());
    const unused = unusedImports(file);
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code !== 'unused-import') continue;
      // Recompute against the current buffer; diagnostic positions may be stale.
      const item = unused.find(i => i.nameStart === document.offsetAt(diagnostic.range.start));
      if (!item) continue;
      const changes = removeImports(file, [item]);
      if (!changes.length) continue;
      const action = new vscode.CodeAction('Remove unused import', vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      for (const e of changes) action.edit.replace(document.uri, new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.text);
      action.diagnostics = [diagnostic]; action.isPreferred = true; actions.push(action);
    }
    const selected = document.getText(range);
    if (selected && !range.isEmpty) { const a = new vscode.CodeAction('Extract to local variable', vscode.CodeActionKind.RefactorExtract); const edit = new vscode.WorkspaceEdit(); const indent = document.lineAt(range.start.line).text.match(/^\s*/)?.[0] ?? ''; edit.insert(document.uri, new vscode.Position(range.start.line, 0), `${indent}$extracted = ${selected};\n`); edit.replace(document.uri, range, '$extracted'); a.edit = edit; actions.push(a); }
    if (selected && !range.isEmpty) {
      this.index.current(document);
      const changes = extractConstant(document.getText(), document.offsetAt(range.start), document.offsetAt(range.end), this.index.project);
      if (changes) {
        const action = new vscode.CodeAction('Extract to class constant', vscode.CodeActionKind.RefactorExtract);
        action.edit = new vscode.WorkspaceEdit();
        for (const e of changes) action.edit.replace(document.uri, new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.text);
        actions.push(action);
      }
    }
    const property = document.lineAt(range.start.line).text.match(/(?:(\??[\\A-Za-z_]\w*(?:[|&][\\A-Za-z_]\w*)*)\s+)?\$([A-Za-z_]\w*)/);
    if (property) {
      const type = property[1] ?? 'mixed'; const name = property[2]; const pascal = name[0].toUpperCase() + name.slice(1); const lastBrace = document.getText().lastIndexOf('}');
      if (lastBrace >= 0) { const a = new vscode.CodeAction(`Generate getter and setter for $${name}`, vscode.CodeActionKind.RefactorRewrite); const edit = new vscode.WorkspaceEdit(); edit.insert(document.uri, document.positionAt(lastBrace), `    public function get${pascal}(): ${type}\n    {\n        return $this->${name};\n    }\n\n    public function set${pascal}(${type} $${name}): self\n    {\n        $this->${name} = $${name};\n        return $this;\n    }\n\n`); a.edit = edit; actions.push(a); }
    }
    return actions;
  }
}

class PhpCodeLens implements vscode.CodeLensProvider, vscode.Disposable {
  private emitter = new vscode.EventEmitter<void>(); readonly onDidChangeCodeLenses = this.emitter.event;
  constructor(private index: PhpIndex) { index.onDidChange(() => this.emitter.fire()); }
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('phpulse.codeLens').get('enable', true)) return [];
    return this.index.forDocument(document.uri).filter(s => ['class','interface','trait','function','method'].includes(s.kind)).map(s => new vscode.CodeLens(s.selectionRange, { title: 'Find references', command: 'editor.action.showReferences', arguments: [s.uri, s.selectionRange.start, this.index.named(s.name).map(x => new vscode.Location(x.uri, x.selectionRange))] }));
  }
  dispose(): void { this.emitter.dispose(); }
}

class PhpInlayHints implements vscode.InlayHintsProvider {
  constructor(private index: PhpIndex) {}
  provideInlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
    if (!vscode.workspace.getConfiguration('phpulse.inlayHints').get('enable', true)) return [];
    const hints: vscode.InlayHint[] = []; const text = document.getText(range); const offset = document.offsetAt(range.start);
    for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s*\(([^()\n]*)\)/g)) {
      const sym = this.index.named(m[1]).find(s => s.signature); if (!sym?.signature) continue;
      const params = sym.signature.slice(sym.signature.indexOf('(') + 1, sym.signature.lastIndexOf(')')).split(','); const args = m[2].split(',');
      let cursor = m.index! + m[0].indexOf('(') + 1;
      args.forEach((arg, i) => { const name = params[i]?.match(/\$([A-Za-z_]\w*)/)?.[1]; if (name && arg.trim() && !arg.includes(':')) hints.push(new vscode.InlayHint(document.positionAt(offset + cursor + arg.search(/\S/)), `${name}:`, vscode.InlayHintKind.Parameter)); cursor += arg.length + 1; });
    } return hints;
  }
}

class PhpTypeHierarchy implements vscode.TypeHierarchyProvider {
  constructor(private index: PhpIndex) {}
  prepareTypeHierarchy(document: vscode.TextDocument, position: vscode.Position): vscode.TypeHierarchyItem[] { const r = wordRange(document, position); if (!r) return []; return this.index.named(document.getText(r)).filter(s => ['class','interface','trait','enum'].includes(s.kind)).map(toTypeItem); }
  provideTypeHierarchySupertypes(item: vscode.TypeHierarchyItem): vscode.TypeHierarchyItem[] { const s = this.index.all().find(x => x.uri.toString() === item.uri.toString() && x.name === item.name); return (s?.extends ?? []).flatMap(n => this.index.named(n)).map(toTypeItem); }
  provideTypeHierarchySubtypes(item: vscode.TypeHierarchyItem): vscode.TypeHierarchyItem[] { return this.index.derivedFrom(item.name).map(toTypeItem); }
}
function toTypeItem(s: PhpSymbol): vscode.TypeHierarchyItem { return new vscode.TypeHierarchyItem(vscodeKind(s.kind), s.name, s.fqName, s.uri, s.range, s.selectionRange); }

class PhpCallHierarchy implements vscode.CallHierarchyProvider {
  constructor(private index: PhpIndex) {}
  prepareCallHierarchy(document: vscode.TextDocument, position: vscode.Position): vscode.CallHierarchyItem[] {
    const r = wordRange(document, position); if (!r) return [];
    return this.index.named(document.getText(r)).filter(s => ['function', 'method'].includes(s.kind)).map(toCallItem);
  }
  async provideCallHierarchyIncomingCalls(item: vscode.CallHierarchyItem, token: vscode.CancellationToken): Promise<vscode.CallHierarchyIncomingCall[]> {
    const refs = await findReferences(item.name, false, token); const grouped = new Map<string, vscode.CallHierarchyIncomingCall>();
    for (const ref of refs) {
      const doc = await vscode.workspace.openTextDocument(ref.uri); const owner = this.index.forDocument(ref.uri).filter(s => ['function', 'method'].includes(s.kind) && s.selectionRange.start.line <= ref.range.start.line).sort((a, b) => b.selectionRange.start.line - a.selectionRange.start.line)[0];
      if (!owner || (owner.uri.toString() === item.uri.toString() && owner.name === item.name)) continue;
      const key = `${owner.uri}:${owner.fqName}`; const existing = grouped.get(key);
      if (existing) existing.fromRanges.push(ref.range); else grouped.set(key, new vscode.CallHierarchyIncomingCall(toCallItem(owner), [ref.range]));
    }
    return [...grouped.values()];
  }
  async provideCallHierarchyOutgoingCalls(item: vscode.CallHierarchyItem): Promise<vscode.CallHierarchyOutgoingCall[]> {
    const doc = await vscode.workspace.openTextDocument(item.uri); const start = item.range.start.line; let end = Math.min(doc.lineCount - 1, start + 300); let depth = 0, opened = false;
    for (let i = start; i <= end; i++) { const line = doc.lineAt(i).text; depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length; if (line.includes('{')) opened = true; if (opened && depth <= 0) { end = i; break; } }
    const text = doc.getText(new vscode.Range(start, 0, end, doc.lineAt(end).text.length)); const grouped = new Map<string, vscode.CallHierarchyOutgoingCall>();
    for (const m of text.matchAll(/(?:->|::)?\b([A-Za-z_]\w*)\s*\(/g)) {
      const target = this.index.named(m[1]).find(s => ['function', 'method'].includes(s.kind)); if (!target || target.name === item.name) continue;
      const offset = doc.offsetAt(new vscode.Position(start, 0)) + m.index! + m[0].lastIndexOf(m[1]); const range = new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + m[1].length)); const key = `${target.uri}:${target.fqName}`; const existing = grouped.get(key);
      if (existing) existing.fromRanges.push(range); else grouped.set(key, new vscode.CallHierarchyOutgoingCall(toCallItem(target), [range]));
    }
    return [...grouped.values()];
  }
}
function toCallItem(s: PhpSymbol): vscode.CallHierarchyItem { return new vscode.CallHierarchyItem(vscodeKind(s.kind), s.name, s.fqName, s.uri, s.range, s.selectionRange); }
