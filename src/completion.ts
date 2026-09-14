import * as vscode from 'vscode';
import { PhpIndex, symbolFor } from './model';
import { activeCall, completionLocation, importEdit, matches, memberContext, SymbolReference } from './intelligence';
import { classAt, functionAt, isType, namespaceAt, parseSource, resolveName } from './phpSyntax';

export interface Builtin { signature: string; description: string }
const docTags = ['@param', '@return', '@throws', '@var', '@property', '@property-read', '@method', '@template', '@extends', '@implements', '@mixin', '@deprecated', '@see'];
const kinds: Record<string, vscode.CompletionItemKind> = { class: vscode.CompletionItemKind.Class, interface: vscode.CompletionItemKind.Interface, trait: vscode.CompletionItemKind.Class, enum: vscode.CompletionItemKind.Enum, function: vscode.CompletionItemKind.Function, method: vscode.CompletionItemKind.Method, property: vscode.CompletionItemKind.Property, constant: vscode.CompletionItemKind.Constant };

function symbolItem(ref: SymbolReference, document: vscode.TextDocument, range: vscode.Range, name = ref.declaration.name): vscode.CompletionItem {
  const d = ref.declaration;
  const item = new vscode.CompletionItem(name, kinds[d.kind]);
  item.detail = `${d.visibility} ${d.isStatic ? 'static ' : ''}${d.signature ?? `${d.type ? `${d.type} ` : ''}${d.fqName}`}`;
  if (d.doc) item.documentation = new vscode.MarkdownString().appendCodeblock(d.doc, 'php');
  item.range = range;
  if (d.doc?.includes('@deprecated')) item.tags = [vscode.CompletionItemTag.Deprecated];
  item.insertText = name;
  if (['method', 'function'].includes(d.kind) && !/^\s*\(/.test(document.getText().slice(document.offsetAt(range.end)))) {
    const snippet = new vscode.SnippetString().appendText(`${name}(`);
    const required = d.parameters.filter(p => !p.optional && !p.variadic);
    required.forEach((p, i) => { if (i) snippet.appendText(', '); snippet.appendPlaceholder(`$${p.name}`); });
    snippet.appendText(')').appendTabstop(0); item.insertText = snippet;
    item.command = { title: 'Parameter hints', command: 'editor.action.triggerParameterHints' };
  }
  return item;
}

export function completePhp(index: PhpIndex, document: vscode.TextDocument, position: vscode.Position, keywords: string[], builtins: Record<string, Builtin>, token?: vscode.CancellationToken): vscode.CompletionList {
  if (token?.isCancellationRequested) return new vscode.CompletionList([]);
  const file = index.current(document), offset = document.offsetAt(position), project = index.project;
  const location = completionLocation(file, offset);
  if (location === 'none') return new vscode.CompletionList([]);
  const before = file.text.slice(0, offset);
  const typed = before.match(/[$@\\\w]*$/)?.[0] ?? '';
  const end = offset + (file.text.slice(offset).match(/^[\w\\]*/)?.[0].length ?? 0);
  const range = new vscode.Range(document.positionAt(offset - typed.length), document.positionAt(end));
  if (location === 'doc') return new vscode.CompletionList(docTags.filter(t => t.startsWith(typed)).map(tag => { const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Keyword); item.range = range; return item; }));
  const member = memberContext(file, offset);
  if (member) {
    const memberRange = new vscode.Range(document.positionAt(member.start), document.positionAt(end));
    const caller = classAt(file, offset)?.fqName;
    const candidates = project.memberCandidates(file, offset, member);
    return new vscode.CompletionList(candidates.slice(0, 300).map(ref => {
      const d = ref.declaration, name = member.operator === '::' && d.kind === 'property' ? `$${d.name}` : d.name;
      const item = symbolItem(ref, document, memberRange, name);
      item.sortText = `${d.owner === caller ? '0' : '1'}_${d.name.toLowerCase()}`;
      return item;
    }), candidates.length > 300);
  }
  const items: vscode.CompletionItem[] = [];
  const query = typed.replace(/^[$\\]/, '');
  const ns = namespaceAt(file, offset);
  const owner = classAt(file, offset);
  const importedNames = new Set(ns.imports.map(i => i.name));
  const typeMatch = before.match(/\b(new|extends|implements|instanceof|use)\s+([\w\\]*)$/);
  const declarationType = /(?:\bfunction\s+\w+\s*\([^)]*|\b(?:public|protected|private|readonly)\s+)[?\w\\|&]*$/.test(before) || /\)\s*:\s*[?\w\\|&]*$/.test(before);
  const typeContext = !!typeMatch || declarationType;
  const extendsKind = before.match(/\b(class|interface)\s+\w+\s+extends\s+[\w\\]*$/)?.[1] ?? 'class';
  const variableOnly = typed.startsWith('$');
  if (!typeContext) for (const name of project.variables(file, offset)) {
    if (!matches(name, query)) continue;
    const item = new vscode.CompletionItem(`$${name}`, vscode.CompletionItemKind.Variable);
    item.range = range; item.insertText = `$${name}`; item.filterText = variableOnly ? `$${name}` : name;
    item.sortText = `0_${name.toLowerCase()}`;
    const types = project.variableTypes(file, name, offset); if (types.length) item.detail = types.join('|');
    items.push(item);
  }
  if (variableOnly) return new vscode.CompletionList(items);
  const aliases = ns.imports.filter(i => matches(i.alias, query)).map(i => i.name);
  const candidates = project.completionCandidates(query, typed.includes('\\') ? resolveName(file, typed, offset) : undefined, aliases).filter(ref => {
    const d = ref.declaration;
    if (d.owner || typeContext && !isType(d)) return false;
    if (typeMatch?.[1] === 'new' && d.kind !== 'class') return false;
    if (typeMatch?.[1] === 'implements' && d.kind !== 'interface') return false;
    if (typeMatch?.[1] === 'use' && owner && d.kind !== 'trait') return false;
    if (typeMatch?.[1] === 'extends' && d.kind !== extendsKind) return false;
    return true;
  }).sort((a, b) => {
    const rank = (r: SymbolReference) => importedNames.has(r.declaration.fqName) ? 0 : r.declaration.namespace === ns.name ? 1 : 2;
    return rank(a) - rank(b) || a.declaration.name.localeCompare(b.declaration.name);
  });
  for (const ref of candidates.slice(0, 300)) {
    const d = ref.declaration;
    const edit = typeMatch?.[1] === 'use' && !owner ? { name: d.fqName } : importEdit(project, file, offset, ref, typed);
    const item = symbolItem(ref, document, range, edit.name);
    item.label = { label: edit.name, description: d.namespace };
    item.filterText = typed.includes('\\') ? typed.slice(0, typed.lastIndexOf('\\') + 1) + d.name : edit.name.startsWith('\\') ? d.name : edit.name;
    item.sortText = `${d.namespace === ns.name || importedNames.has(d.fqName) ? '1' : '2'}_${d.name.toLowerCase()}`;
    if (edit.offset !== undefined && edit.text && edit.offset < offset - typed.length && document.languageId === 'php') {
      item.additionalTextEdits = [vscode.TextEdit.insert(document.positionAt(edit.offset), edit.text)];
      item.detail += ' (auto-import)';
    } else if (edit.text) {
      item.insertText = isType(d) ? `\\${d.fqName}` : new vscode.SnippetString().appendText(`\\${d.fqName}`).appendText(d.kind === 'function' ? '()' : '');
    }
    items.push(item);
  }
  if (!typeContext) {
    const scope = functionAt(file, offset);
    if (owner && scope && !typed.includes('\\')) {
      for (const ref of project.membersOf(owner.fqName, owner.fqName)) {
        const d = ref.declaration;
        if (d.kind !== 'method' || !matches(d.name, query) || scope.isStatic && !d.isStatic || d.name === '__construct') continue;
        const name = `${d.isStatic ? 'self::' : '$this->'}${d.name}`;
        const item = symbolItem(ref, document, range, name); item.filterText = d.name;
        item.sortText = `1_${d.name.toLowerCase()}`; items.push(item);
      }
    }
    const call = activeCall(file, offset);
    const callable = call ? project.callable(file, call.callee, offset) : undefined;
    if (callable && call?.atArgumentStart) for (const parameter of callable.declaration.parameters) {
      if (!matches(parameter.name, query) || call.usedNames.includes(parameter.name)) continue;
      const item = new vscode.CompletionItem(`${parameter.name}:`, vscode.CompletionItemKind.Field);
      item.insertText = `${parameter.name}: `; item.detail = parameter.label; item.range = range; item.sortText = `0_${parameter.name}`; items.push(item);
    }
    for (const [name, info] of Object.entries(builtins)) {
      if (!matches(name, query)) continue;
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
      item.range = range; item.detail = info.signature; item.documentation = new vscode.MarkdownString(info.description);
      item.sortText = `3_${name}`; items.push(item);
    }
    for (const keyword of keywords) {
      if (!matches(keyword, query)) continue;
      const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword); item.range = range; item.sortText = `4_${keyword}`; items.push(item);
    }
  }
  return new vscode.CompletionList(items, candidates.length > 300);
}

export function signatureHelp(index: PhpIndex, document: vscode.TextDocument, position: vscode.Position, builtins: Record<string, Builtin>): vscode.SignatureHelp | undefined {
  const file = index.current(document), offset = document.offsetAt(position);
  if (completionLocation(file, offset) !== 'code') return;
  const call = activeCall(file, offset); if (!call) return;
  const ref = index.project.callable(file, call.callee, offset);
  const name = call.callee.at(-1)?.value ?? '';
  const builtin = !['->', '?->', '::'].includes(call.callee.at(-2)?.value ?? '') ? builtins[name.toLowerCase()] : undefined;
  const declaration = ref?.declaration ?? (builtin ? parseSource(`<?php function ${builtin.signature};`).declarations[0] : undefined);
  if (!declaration?.signature) return;
  const info = new vscode.SignatureInformation(declaration.signature, declaration.doc ?? builtin?.description);
  info.parameters = declaration.parameters.map(p => new vscode.ParameterInformation(p.label));
  const named = declaration.parameters.findIndex(p => p.name === call.name);
  const help = new vscode.SignatureHelp(); help.signatures = [info]; help.activeSignature = 0;
  help.activeParameter = Math.max(0, Math.min(declaration.parameters.length - 1, named >= 0 ? named : call.argument));
  return help;
}

export function resolvedSymbols(index: PhpIndex, document: vscode.TextDocument, position: vscode.Position) {
  const file = index.current(document); return index.project.symbolAt(file, document.offsetAt(position)).map(symbolFor);
}
