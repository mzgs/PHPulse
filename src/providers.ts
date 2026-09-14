import * as vscode from 'vscode';
import { PhpIndex, PhpSymbol, vscodeKind, wordRange } from './model';

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

const completionRank = {
  variable: '0',
  userFunction: '1',
  userType: '2',
  otherUserSymbol: '3',
  builtinFunction: '4',
  keyword: '5',
  phpDocTag: '6'
} as const;

function rankedSortText(rank: string, label: string): string {
  return `${rank}_${label.toLowerCase()}`;
}

function itemFor(s: PhpSymbol): vscode.CompletionItem {
  const kinds: Record<string, vscode.CompletionItemKind> = { class: vscode.CompletionItemKind.Class, interface: vscode.CompletionItemKind.Interface, trait: vscode.CompletionItemKind.Class, enum: vscode.CompletionItemKind.Enum, function: vscode.CompletionItemKind.Function, method: vscode.CompletionItemKind.Method, property: vscode.CompletionItemKind.Property, constant: vscode.CompletionItemKind.Constant };
  const item = new vscode.CompletionItem(s.name, kinds[s.kind]);
  item.detail = `${s.kind} ${s.fqName}${s.signature ? ` — ${s.signature}` : ''}`;
  item.documentation = s.doc ? new vscode.MarkdownString(`\`\`\`php\n${s.doc}\n\`\`\``) : undefined;
  const rank = s.kind === 'function'
    ? completionRank.userFunction
    : ['class', 'interface', 'trait', 'enum'].includes(s.kind)
      ? completionRank.userType
      : completionRank.otherUserSymbol;
  item.sortText = rankedSortText(rank, s.name);
  if (s.kind === 'function' || s.kind === 'method') item.insertText = new vscode.SnippetString(`${s.name}($0)`);
  return item;
}

export function registerLanguageFeatures(context: vscode.ExtensionContext, index: PhpIndex): void {
  const selector: vscode.DocumentSelector = [{ language: 'php' }, { language: 'blade' }];

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
    provideCompletionItems(document, position) {
      const line = document.lineAt(position).text.slice(0, position.character);
      const member = line.match(/(?:\$([A-Za-z_]\w*)|([\\A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*))\s*(->|::)\s*([A-Za-z_]\w*)?$/);
      if (member) {
        const typeName = member[2] || inferVariableType(document, position, member[1]);
        const staticAccess = member[3] === '::';
        const memberKinds = new Set<PhpSymbol['kind']>(staticAccess ? ['method', 'constant'] : ['method', 'property']);
        const candidates = (typeName
          ? index.membersOf(resolveTypeName(document, typeName, position), member[4] ?? '')
          : index.completionCandidates(member[4] ?? '', memberKinds))
          .filter(s => staticAccess ? s.kind === 'constant' || s.isStatic : s.kind !== 'constant');
        return new vscode.CompletionList(candidates.map(itemFor), candidates.length >= 300);
      }

      const word = line.match(/[\\A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*$/)?.[0] ?? '';
      const typeContext = /\b(new|extends|implements|instanceof|use)\s+[\\\w]*$/.test(line);
      const globalKinds = new Set<PhpSymbol['kind']>(typeContext
        ? ['class', 'interface', 'trait', 'enum']
        : ['class', 'interface', 'trait', 'enum', 'function', 'constant']);
      const symbols = index.completionCandidates(word, globalKinds);
      const source = document.getText();
      const items: vscode.CompletionItem[] = symbols.map(s => {
        const item = itemFor(s);
        if (document.languageId === 'php' && ['class', 'interface', 'trait', 'enum'].includes(s.kind) && s.uri.toString() !== document.uri.toString()) {
          const ns = source.match(/^\s*namespace\s+([^;{]+)/m)?.[1].trim() ?? '';
          if (s.namespace && s.namespace !== ns && !new RegExp(`^\\s*use\\s+${escapeRegExp(s.fqName)}\\s*;`, 'm').test(source)) {
            const insert = importPosition(document);
            const prefix = insert.line === 0 && insert.character === 0
              ? (source.includes('<?php') ? '' : '<?php\n\n')
              : '\n';
            item.additionalTextEdits = [vscode.TextEdit.insert(insert, `${prefix}use ${s.fqName};\n`)];
            item.detail = `${item.detail} (auto-import)`;
          }
        }
        return item;
      });
      const enclosingType = !typeContext ? enclosingTypeName(document, position) : undefined;
      if (enclosingType) {
        const typeName = resolveTypeName(document, enclosingType, position);
        for (const method of index.membersOf(typeName, word).filter(s => s.kind === 'method' && s.isStatic)) {
          const owner = method.container ?? enclosingType;
          const item = itemFor(method);
          item.label = `${owner}::${method.name}()`;
          item.filterText = word || method.name;
          item.insertText = new vscode.SnippetString(`${owner}::${method.name}($0)`);
          item.sortText = rankedSortText(completionRank.userFunction, method.name);
          items.push(item);
        }
      }
      const localText = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
      for (const variable of new Set([...localText.matchAll(/\$([A-Za-z_]\w*)/g)].map(m => m[1]))) {
        const item = new vscode.CompletionItem(`$${variable}`, vscode.CompletionItemKind.Variable);
        // Match against the identifier itself so typing "fil" gives "$filters"
        // the same prefix-match score as functions and keywords without a "$".
        item.filterText = variable;
        item.sortText = rankedSortText(completionRank.variable, variable);
        items.push(item);
      }
      for (const keyword of keywords) {
        if (word && !keyword.startsWith(word.toLowerCase())) continue;
        const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
        item.sortText = rankedSortText(completionRank.keyword, keyword);
        items.push(item);
      }
      for (const [name, info] of Object.entries(builtins)) {
        if (word && !name.startsWith(word.toLowerCase())) continue;
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
        item.detail = info.signature; item.documentation = new vscode.MarkdownString(`${info.description}\n\n[PHP manual](https://www.php.net/${name})`);
        item.sortText = rankedSortText(completionRank.builtinFunction, name);
        items.push(item);
      }
      for (const tag of ['@param','@return','@throws','@var','@property','@property-read','@method','@template','@extends','@implements','@mixin','@deprecated','@see']) {
        const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Keyword);
        item.sortText = rankedSortText(completionRank.phpDocTag, tag);
        items.push(item);
      }
      if (typeContext) return new vscode.CompletionList(items.filter(i => [vscode.CompletionItemKind.Class, vscode.CompletionItemKind.Interface, vscode.CompletionItemKind.Enum].includes(i.kind!)), symbols.length >= 300);
      return new vscode.CompletionList(items, symbols.length >= 300);
    }
  }, '$', '>', ':', '\\', '@'));

  context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
    provideHover(document, position) {
      const range = wordRange(document, position); if (!range) return;
      const word = document.getText(range).replace(/^\\/, '');
      const found = index.named(word)[0];
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
    provideDefinition(document, position) { const r = wordRange(document, position); return r ? index.named(document.getText(r)).map(s => new vscode.Location(s.uri, s.selectionRange)) : []; }
  }));
  context.subscriptions.push(vscode.languages.registerImplementationProvider(selector, {
    provideImplementation(document, position) { const r = wordRange(document, position); if (!r) return []; const name = document.getText(r); return [...index.named(name).filter(s => s.kind === 'method'), ...index.derivedFrom(name)].map(s => new vscode.Location(s.uri, s.selectionRange)); }
  }));
  context.subscriptions.push(vscode.languages.registerReferenceProvider(selector, {
    async provideReferences(document, position, options, token) { const r = wordRange(document, position); return r ? findReferences(document.getText(r), options.includeDeclaration, token) : []; }
  }));
  context.subscriptions.push(vscode.languages.registerRenameProvider(selector, {
    prepareRename(document, position) { const r = wordRange(document, position); if (!r) throw new Error('No PHP symbol at cursor.'); return { range: r, placeholder: document.getText(r) }; },
    async provideRenameEdits(document, position, newName, token) {
      const r = wordRange(document, position); if (!r || !/^[A-Za-z_]\w*$/.test(newName)) return;
      const edit = new vscode.WorkspaceEdit();
      for (const loc of await findReferences(document.getText(r), true, token)) edit.replace(loc.uri, loc.range, newName);
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
    provideSignatureHelp(document, position) {
      const prefix = document.getText(new vscode.Range(new vscode.Position(Math.max(0, position.line - 20), 0), position));
      const match = prefix.match(/([A-Za-z_]\w*)\s*\(([^()]*)$/); if (!match) return;
      const sig = index.named(match[1]).find(s => s.signature)?.signature ?? builtins[match[1].toLowerCase()]?.signature; if (!sig) return;
      const help = new vscode.SignatureHelp(); const label = sig;
      const si = new vscode.SignatureInformation(label); const params = label.slice(label.indexOf('(') + 1, label.lastIndexOf(')')).split(',').filter(Boolean);
      si.parameters = params.map(p => new vscode.ParameterInformation(p.trim())); help.signatures = [si]; help.activeSignature = 0; help.activeParameter = Math.min(params.length - 1, (match[2].match(/,/g) ?? []).length); return help;
    }
  }, '(', ','));

  context.subscriptions.push(vscode.languages.registerFoldingRangeProvider(selector, {
    provideFoldingRanges(document) {
      const ranges: vscode.FoldingRange[] = []; const stack: number[] = [];
      for (let i = 0; i < document.lineCount; i++) { const t = document.lineAt(i).text; for (const c of t) { if (c === '{') stack.push(i); else if (c === '}' && stack.length) { const start = stack.pop()!; if (i > start) ranges.push(new vscode.FoldingRange(start, i)); } } }
      return ranges;
    }
  }));

  const formatter = { provideDocumentFormattingEdits(document: vscode.TextDocument) { return [vscode.TextEdit.replace(new vscode.Range(0, 0, document.lineCount, 0), formatPhp(document.getText()))]; } };
  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(selector, formatter));
  context.subscriptions.push(vscode.languages.registerDocumentRangeFormattingEditProvider(selector, { provideDocumentRangeFormattingEdits(document, range) { return [vscode.TextEdit.replace(range, formatPhp(document.getText(range)))]; } }));
  context.subscriptions.push(vscode.languages.registerOnTypeFormattingEditProvider(selector, { provideOnTypeFormattingEdits(document, position, ch) { if (ch !== '}') return []; const line = document.lineAt(position.line); const desired = Math.max(0, indentationAt(document, position.line) - 1) * 4; return [vscode.TextEdit.replace(new vscode.Range(position.line, 0, position.line, line.firstNonWhitespaceCharacterIndex), ' '.repeat(desired))]; } }, '}'));

  const codeActions = new PhpCodeActions();
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider(selector, codeActions, { providedCodeActionKinds: PhpCodeActions.kinds }));
  const lenses = new PhpCodeLens(index); context.subscriptions.push(lenses, vscode.languages.registerCodeLensProvider(selector, lenses));
  context.subscriptions.push(vscode.languages.registerInlayHintsProvider(selector, new PhpInlayHints(index)));
  context.subscriptions.push(vscode.languages.registerTypeHierarchyProvider(selector, new PhpTypeHierarchy(index)));
  context.subscriptions.push(vscode.languages.registerCallHierarchyProvider(selector, new PhpCallHierarchy(index)));
}

function resolveTypeName(document: vscode.TextDocument, name: string, position?: vscode.Position): string {
  const clean = name.replace(/^\?/, '').replace(/^\\/, '');
  if (name.startsWith('\\')) return clean;
  if (/^(?:self|static)$/i.test(clean) && position) {
    const enclosing = enclosingTypeName(document, position);
    if (enclosing) return resolveTypeName(document, enclosing);
  }
  const imports = [...document.getText().matchAll(/^\s*use\s+(?!function\s|const\s)([^;]+);/gm)];
  for (const match of imports) {
    const imported = match[1].trim();
    const alias = imported.match(/\s+as\s+([A-Za-z_]\w*)$/i)?.[1] ?? imported.split('\\').pop();
    if (alias?.toLowerCase() === clean.toLowerCase()) return imported.replace(/\s+as\s+\w+$/i, '');
  }
  const namespace = document.getText().match(/^\s*namespace\s+([^;{]+)/m)?.[1].trim();
  return namespace ? `${namespace}\\${clean}` : clean;
}

function enclosingTypeName(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const before = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
  const declarations = [...before.matchAll(/\b(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)[^\{]*/g)];
  for (let i = declarations.length - 1; i >= 0; i--) {
    const declaration = declarations[i];
    const openBrace = before.indexOf('{', declaration.index! + declaration[0].length);
    if (openBrace < 0) continue;
    const body = before.slice(openBrace);
    const depth = (body.match(/\{/g) ?? []).length - (body.match(/\}/g) ?? []).length;
    if (depth > 0) return declaration[1];
  }
  return undefined;
}

function inferVariableType(document: vscode.TextDocument, position: vscode.Position, variable: string): string | undefined {
  const before = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
  if (variable === 'this') {
    const classes = [...before.matchAll(/\b(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/g)];
    return classes.at(-1)?.[1];
  }
  const escaped = escapeRegExp(variable);
  const patterns = [
    new RegExp(`\\$${escaped}\\s*=\\s*new\\s+([\\\\A-Za-z_]\\w*(?:\\\\[A-Za-z_]\\w*)*)`, 'g'),
    new RegExp(`([?\\\\A-Za-z_]\\w*(?:\\\\[A-Za-z_]\\w*)*)\\s+\\$${escaped}\\b`, 'g'),
    new RegExp(`@var\\s+([\\\\A-Za-z_]\\w*(?:\\\\[A-Za-z_]\\w*)*)\\s+\\$${escaped}\\b`, 'g'),
    new RegExp(`@var\\s+\\$${escaped}\\s+([\\\\A-Za-z_]\\w*(?:\\\\[A-Za-z_]\\w*)*)`, 'g')
  ];
  for (const pattern of patterns) {
    const matches = [...before.matchAll(pattern)];
    const found = matches.at(-1)?.[1];
    if (found) return found.replace(/^\?/, '');
  }
  return undefined;
}

function importPosition(document: vscode.TextDocument): vscode.Position {
  const text = document.getText();
  const patterns = [
    /^\s*use\s+(?:function\s+|const\s+)?[^;]+;[^\S\r\n]*$/gm,
    /^\s*namespace\s+[^;{]+;[^\S\r\n]*$/gm,
    /^\s*declare\s*\([^;]+;[^\S\r\n]*$/gm,
    /<\?php[^\S\r\n]*$/gm
  ];
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    const match = matches.at(-1);
    if (match?.index !== undefined) return document.positionAt(match.index + match[0].length);
  }
  return new vscode.Position(0, 0);
}

async function findReferences(name: string, includeDeclaration: boolean, token: vscode.CancellationToken): Promise<vscode.Location[]> {
  const exclude = vscode.workspace.getConfiguration('phpulse.index').get<string[]>('exclude', []);
  const files = await vscode.workspace.findFiles('**/*.{php,phtml,inc}', `{${exclude.join(',')}}`, 15000); const result: vscode.Location[] = [];
  const re = new RegExp(`\\b${escapeRegExp(name.replace(/^\\/, '').split('\\').pop()!)}\\b`, 'g');
  for (const uri of files) { if (token.isCancellationRequested) break; const doc = await vscode.workspace.openTextDocument(uri); for (const m of doc.getText().matchAll(re)) { const range = new vscode.Range(doc.positionAt(m.index!), doc.positionAt(m.index! + m[0].length)); if (includeDeclaration || !/\b(class|interface|trait|enum|function)\s*$/.test(doc.getText(new vscode.Range(new vscode.Position(range.start.line, 0), range.start)))) result.push(new vscode.Location(uri, range)); } }
  return result;
}

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function indentationAt(doc: vscode.TextDocument, line: number): number {
  let level = 0; for (let i = 0; i < line; i++) { const text = doc.lineAt(i).text.replace(/(['"]).*?\1/g, ''); level += (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length; } return level;
}

export function formatPhp(text: string): string {
  let depth = 0; let inHeredoc = false;
  return text.split(/\r?\n/).map(raw => {
    const trimmed = raw.trim();
    if (/<<<['"]?\w+/.test(trimmed)) inHeredoc = true;
    if (inHeredoc) { if (/^\w+;?$/.test(trimmed) && !trimmed.includes('<<<')) inHeredoc = false; return raw; }
    if (!trimmed) return '';
    if (/^[}\])]/.test(trimmed) || /^@(end|else|elseif|case|default)/.test(trimmed)) depth = Math.max(0, depth - 1);
    let line = '    '.repeat(depth) + trimmed
      .replace(/\s*=>\s*/g, ' => ').replace(/\s*=\s*(?!=|>)/g, ' = ').replace(/,\s*/g, ', ')
      .replace(/\b(if|for|foreach|while|switch|catch)\s*\(/g, '$1 (');
    if (/[{[]\s*(?:\/\/.*)?$/.test(trimmed) || /^@(if|foreach|for|while|switch|section|php)\b/.test(trimmed)) depth++;
    if (/^}\s*(else|elseif|catch|finally)\b/.test(trimmed) || /^@(else|elseif|case|default)\b/.test(trimmed)) depth++;
    return line;
  }).join('\n').replace(/\n{3,}/g, '\n\n') + (text.endsWith('\n') ? '\n' : '');
}

class PhpCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite, vscode.CodeActionKind.SourceOrganizeImports];
  provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code === 'unused-import') { const a = new vscode.CodeAction('Remove unused import', vscode.CodeActionKind.QuickFix); a.edit = new vscode.WorkspaceEdit(); a.edit.delete(document.uri, document.lineAt(diagnostic.range.start.line).rangeIncludingLineBreak); a.diagnostics = [diagnostic]; a.isPreferred = true; actions.push(a); }
    }
    const selected = document.getText(range);
    if (selected && !range.isEmpty) { const a = new vscode.CodeAction('Extract to local variable', vscode.CodeActionKind.RefactorExtract); const edit = new vscode.WorkspaceEdit(); const indent = document.lineAt(range.start.line).text.match(/^\s*/)?.[0] ?? ''; edit.insert(document.uri, new vscode.Position(range.start.line, 0), `${indent}$extracted = ${selected};\n`); edit.replace(document.uri, range, '$extracted'); a.edit = edit; actions.push(a); }
    if (selected && !range.isEmpty) { const a = new vscode.CodeAction('Extract to class constant', vscode.CodeActionKind.RefactorExtract); const edit = new vscode.WorkspaceEdit(); const constant = 'EXTRACTED_VALUE'; const classLine = document.getText().slice(0, document.offsetAt(range.start)).lastIndexOf('{'); if (classLine >= 0) { const insert = document.positionAt(classLine + 1); edit.insert(document.uri, insert, `\n    private const ${constant} = ${selected};`); edit.replace(document.uri, range, `self::${constant}`); a.edit = edit; actions.push(a); } }
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
