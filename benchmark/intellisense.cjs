// Synthetic CPU benchmark. Uses the real index/providers and an in-memory VS Code API.
const { performance } = require('node:perf_hooks');
const Module = require('node:module');
const { strict: assert } = require('node:assert');
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class Uri { constructor(value) { this.value = value; this.path = value; } toString() { return this.value; } static parse(value) { return new Uri(value); } }
class SnippetString { constructor(value = '') { this.value = value; } appendText(s) { this.value += s; return this; } appendPlaceholder(s) { this.value += s; return this; } appendTabstop() { return this; } }
class MarkdownString { appendCodeblock() { return this; } }
const disposable = () => ({ dispose() {} });
const vscode = {
  Position, Range, Uri, SnippetString, MarkdownString,
  SymbolKind: {}, CompletionItemKind: {}, CompletionItemTag: {},
  CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
  CompletionList: class { constructor(items) { this.items = items; } },
  TextEdit: { insert: (position, newText) => ({ range: new Range(position, position), newText }) },
  EventEmitter: class { event = disposable; fire() {} dispose() {} },
  workspace: {
    textDocuments: [], createFileSystemWatcher: () => ({ onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable, dispose() {} }),
    onDidOpenTextDocument: disposable, onDidChangeTextDocument: disposable, onDidSaveTextDocument: disposable, onDidCloseTextDocument: disposable
  }
};
const original = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
const { PhpIndex } = require('../dist/model');
const { completePhp } = require('../dist/completion');
Module._load = original;
function document(text) {
  return { text, uri: Uri.parse('file:///active.php'), fileName: 'active.php', languageId: 'php', getText() { return this.text; },
    positionAt(n) { const lines = this.text.slice(0, n).split('\n'); return new Position(lines.length - 1, lines.at(-1).length); },
    offsetAt(p) { return this.text.split('\n').slice(0, p.line).reduce((n, s) => n + s.length + 1, 0) + p.character; } };
}
function measure(fn, runs = 30) {
  for (let i = 0; i < 5; i++) fn();
  const times = [];
  for (let i = 0; i < runs; i++) { const start = performance.now(); fn(); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  return { medianMs: +times[Math.floor(times.length / 2)].toFixed(3), p95Ms: +times[Math.ceil(times.length * .95) - 1].toFixed(3) };
}
const fileCount = 1500, methodsPerFile = 24;
const index = new PhpIndex();
const startup = performance.now();
for (let i = 0; i < fileCount; i++) index.project.update(`file:///vendor/Entity${i}.php`, `<?php namespace Vendor; class Entity${i} {\n` + Array.from({ length: methodsPerFile }, (_, n) => `public function method${n}(string $value): self { return $this; }`).join('\n') + '\n}');
const small = document('<?php namespace App; use Vendor\\Entity1; function run(Entity1 $entity) { $entity-> }');
index.update(small);
const coldIndexMs = +(performance.now() - startup).toFixed(3);
let edit = 0;
const editUpdate = measure(() => { small.text = `<?php namespace App; use Vendor\\Entity1; function run(Entity1 $entity) { $n = ${edit++}; $entity-> }`; index.update(small); });
const typeDoc = document('<?php namespace App; new Ent'); index.update(typeDoc);
const typePosition = typeDoc.positionAt(typeDoc.text.length);
const globalCompletion = measure(() => { assert.equal(completePhp(index, typeDoc, typePosition, [], {}).items.length, 300); });
const large = document('<?php namespace App; use Vendor\\Entity1; class Controller {\n' + Array.from({ length: 250 }, (_, i) => `function action${i}(Entity1 $entity) { $local${i} = $entity; }`).join('\n') + '\nfunction active(Entity1 $entity) {\n' + Array.from({ length: 40 }, (_, i) => `$value${i} = $entity;`).join('\n') + '\n$value39-> } }');
index.update(large);
const memberPosition = large.positionAt(large.text.lastIndexOf('->') + 2);
const memberCompletion = measure(() => { assert.equal(completePhp(index, large, memberPosition, [], {}).items.length, methodsPerFile); });
large.text = large.text.replace('$value39-> } }', '$val } }'); index.update(large);
const variablePosition = large.positionAt(large.text.lastIndexOf('$val') + 4);
const variableCompletion = measure(() => { assert.ok(completePhp(index, large, variablePosition, [], {}).items.length >= 40); });
index.dispose();
console.log(JSON.stringify({ fixture: { files: fileCount, methodsPerFile, largeFileMethods: 251, activeLocals: 40 }, coldIndexMs, editUpdate, globalCompletion, memberCompletion, variableCompletion }, null, 2));
