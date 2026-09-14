const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
class CompletionList { constructor(items, isIncomplete = false) { this.items = items; this.isIncomplete = isIncomplete; } }
class SnippetString {
  constructor(value = '') { this.value = value; this.tab = 1; }
  appendText(text) { this.value += text.replace(/[\\$}]/g, '\\$&'); return this; }
  appendPlaceholder(text) { this.value += '${' + this.tab++ + ':' + text.replace(/[\\$}]/g, '\\$&') + '}'; return this; }
  appendTabstop(n) { this.value += '$' + n; return this; }
}
class MarkdownString { constructor(value = '') { this.value = value; } appendCodeblock(s) { this.value += s; return this; } }
const stub = {
  Position, Range, CompletionItem, CompletionList, SnippetString, MarkdownString,
  CompletionItemKind: { Class: 1, Interface: 2, Enum: 3, Function: 4, Method: 5, Property: 6, Constant: 7, Variable: 8, Keyword: 9, Field: 10 },
  SymbolKind: {}, CompletionItemTag: { Deprecated: 1 },
  TextEdit: { insert: (position, newText) => ({ range: new Range(position, position), newText }) },
  SignatureHelp: class {}, SignatureInformation: class { constructor(label) { this.label = label; } },
  ParameterInformation: class { constructor(label) { this.label = label; } }
};
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? stub : originalLoad.call(this, name, ...args); };
const { completePhp, signatureHelp } = require('../dist/completion');
Module._load = originalLoad;
const { PhpProject } = require('../dist/intelligence');
function setup(source) {
  const offset = source.indexOf('|'); const text = source.replace('|', '');
  const project = new PhpProject();
  project.update('domain', `<?php namespace Domain; class User {
public string $name; public static string $table;
public function save(string $name, array $options = [], ?User $other = null): self {}
public function noArgs(): void {}
} class UserRepository {} class UserResource {}`);
  project.update('other', '<?php namespace Other; class User {}');
  const file = project.update('main', text); project.rebuild();
  const document = { languageId: 'php', getText: () => text,
    positionAt: n => { const lines = text.slice(0, n).split('\n'); return new Position(lines.length - 1, lines.at(-1).length); },
    offsetAt: p => text.split('\n').slice(0, p.line).reduce((n, s) => n + s.length + 1, 0) + p.character };
  const index = { project, current: () => file };
  return { index, document, position: document.positionAt(offset), offset, file };
}
function complete(source) { const x = setup(source); return { ...x, items: completePhp(x.index, x.document, x.position, ['new', 'return'], {}).items }; }
function label(item) { return typeof item.label === 'string' ? item.label : item.label.label; }
function applyItem(x, item) {
  const edits = [...(item.additionalTextEdits ?? []), { range: item.range, newText: typeof item.insertText === 'string' ? item.insertText : item.insertText?.value ?? label(item) }];
  let result = x.document.getText();
  for (const edit of edits.sort((a, b) => x.document.offsetAt(b.range.start) - x.document.offsetAt(a.range.start))) {
    result = result.slice(0, x.document.offsetAt(edit.range.start)) + edit.newText + result.slice(x.document.offsetAt(edit.range.end));
  }
  return result;
}

test('variable replacement consumes the typed dollar and suffix exactly once', () => {
  const x = complete('<?php function f() { $user = 1; $us|er; }');
  const item = x.items.find(i => label(i) === '$user'); assert.ok(item);
  assert.equal(applyItem(x, item), '<?php function f() { $user = 1; $user; }');
  assert.ok(x.items.every(i => i.kind === stub.CompletionItemKind.Variable));
});

test('method completions insert required argument placeholders and trigger hints', () => {
  const x = complete('<?php use Domain\\User; function f(User $u) { $u->sa| }');
  const item = x.items.find(i => label(i) === 'save'); assert.ok(item);
  assert.equal(item.insertText.value, 'save(${1:\\$name})$0');
  assert.equal(item.command.command, 'editor.action.triggerParameterHints');
});

test('existing method parentheses and partial word suffixes are preserved', () => {
  const x = complete('<?php use Domain\\User; function f(User $u) { $u->sa|ve("x"); }');
  const item = x.items.find(i => label(i) === 'save');
  assert.equal(item.insertText, 'save');
  assert.equal(applyItem(x, item), '<?php use Domain\\User; function f(User $u) { $u->save("x"); }');
});

test('static property completion replaces a single dollar prefix', () => {
  const x = complete('<?php use Domain\\User; User::$ta|');
  assert.equal(applyItem(x, x.items[0]), '<?php use Domain\\User; User::$table');
});

test('type completion imports after strict_types, and returns only instantiable kinds', () => {
  const x = complete('<?php\ndeclare(strict_types=1);\nnamespace App;\nnew UserR|');
  assert.equal(x.items.length, 2);
  const item = x.items.find(i => label(i) === 'UserRepository');
  assert.equal(applyItem(x, item), '<?php\ndeclare(strict_types=1);\nnamespace App;\nuse Domain\\UserRepository;\n\nnew UserRepository');
});

test('aliased imports are offered under their local name with no duplicate import', () => {
  const x = complete('<?php use Domain\\User as Person; new Per|');
  assert.deepEqual(x.items.map(label), ['Person']);
  assert.equal(x.items[0].additionalTextEdits, undefined);
});

test('name collisions insert a fully qualified type', () => {
  const x = complete('<?php use Other\\User; new Us|');
  const item = x.items.find(i => label(i) === '\\Domain\\User'); assert.ok(item);
  assert.equal(item.additionalTextEdits, undefined);
  assert.equal(applyItem(x, item), '<?php use Other\\User; new \\Domain\\User');
});

test('camel-case abbreviations find relevant workspace types', () => {
  const x = complete('<?php new UR|'); assert.equal(x.items.length, 2);
});

test('PHPDoc tags do not pollute ordinary code completion', () => {
  assert.ok(!complete('<?php |').items.some(i => label(i).startsWith('@')));
  assert.deepEqual(complete('<?php /** @par|').items.map(label), ['@param']);
  assert.equal(complete('<?php // User|').items.length, 0);
});

test('signature help resolves receiver, nested arguments, named arguments and zero parameters', () => {
  for (const [source, parameter, count] of [
    ['<?php use Domain\\User; function f(User $u) { $u->save(trim("x,y"), [1,2], |); }', 2, 3],
    ['<?php use Domain\\User; function f(User $u) { $u->save(other: |); }', 2, 3],
    ['<?php use Domain\\User; function f(User $u) { $u->noArgs(|); }', 0, 0]
  ]) {
    const x = setup(source); const help = signatureHelp(x.index, x.document, x.position, {});
    assert.ok(help); assert.equal(help.activeParameter, parameter); assert.equal(help.signatures[0].parameters.length, count);
  }
});

test('cancellation returns no completion items', () => {
  const x = setup('<?php new Us|'); assert.equal(completePhp(x.index, x.document, x.position, [], {}, { isCancellationRequested: true }).items.length, 0);
});

test('unqualified method suggestions insert this or self receivers', () => {
  const x = complete('<?php class Service { function save() {} static function start() {} function run() { sa| } }');
  assert.equal(x.items.find(i => label(i) === '$this->save').insertText.value, '\\$this->save()$0');
  const y = complete('<?php class Service { static function start() {} static function run() { st| } }');
  assert.equal(y.items.find(i => label(i) === 'self::start').insertText.value, 'self::start()$0');
});

test('named-argument suggestions omit used names and are limited to argument starts', () => {
  const x = complete('<?php use Domain\\User; function f(User $u) { $u->save(name: "x", na|); }');
  assert.ok(!x.items.some(i => label(i) === 'name:'));
  const y = complete('<?php use Domain\\User; function f(User $u) { $u->save("x" . na|); }');
  assert.ok(!y.items.some(i => label(i) === 'name:'));
});

test('global completion and import collision checks avoid scanning all workspace symbols', () => {
  const x = setup('<?php use Other\\User; new Us|');
  x.index.project.all = () => { throw new Error('Unexpected full symbol scan'); };
  const items = completePhp(x.index, x.document, x.position, [], {}).items;
  assert.ok(items.some(i => label(i) === '\\Domain\\User'));
  assert.ok(items.some(i => label(i) === 'UserRepository'));
});

test('arrow function completion includes captures without recursing into its own scope', () => {
  const x = complete('<?php $outer = 1; $f = fn($value) => $ou|;');
  assert.ok(x.items.some(i => label(i) === '$outer'));
  const y = complete('<?php $outer = 1; $f = fn($first) => fn($second) => $fi|;');
  assert.ok(y.items.some(i => label(i) === '$first'));
  const z = complete('<?php $outer = 1; $f = fn($first) => fn($second) => $ou|;');
  assert.ok(z.items.some(i => label(i) === '$outer'));
});
