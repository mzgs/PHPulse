const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { PhpProject } = require('../dist/intelligence');
const { parseSource, tokenize } = require('../dist/phpSyntax');
const { renameTarget, renameEdits } = require('../dist/rename');
const { unusedImports, removeImports } = require('../dist/imports');
const { extractConstant } = require('../dist/refactoring');
const { compatibilityIssues } = require('../dist/compatibility');
const mock = require('./helpers/vscode.cjs');
const { formatPhp, formattingEdits, externalFormatterArgs } = mock.load('../../dist/formatting');
function apply(text, edits) { for (const e of [...edits].sort((a,b) => b.start - a.start)) text = text.slice(0,e.start) + e.text + text.slice(e.end); return text; }
function rename(source, newName, dependencies = {}) {
  const offset = source.indexOf('|'), text = source.replace('|', '');
  const p = new PhpProject(); for (const [uri, source] of Object.entries(dependencies)) p.update(uri, source);
  const file = p.update('main', text), target = renameTarget(p, file, offset);
  return Object.fromEntries([...renameEdits(p, target, newName)].map(([uri, edits]) => [uri, apply(p.files.get(uri).text, edits)]));
}

test('formatting preserves operators, literals, comments, heredocs, HTML and line endings', () => {
  const samples = [
    '<?php if ($a === $b && $a !== $c && $a <= 2) {}',
    '<?php\n$s = "a,b=c";\n$s .= "x"; $a += 1; $b ??= 2;\n',
    '<?php\nclass A {\nfunction f() {\n// a,b=c {\nreturn "first\n  second=third,\nfourth";\n}\n}\n',
    '<?php\nfunction f() {\n$s = <<<TXT\nhello\na,b=c\nTXT;\n}\n',
    '<div>  a,b=c </div>\n<?php\nif (true) {\necho 1;\n}\n?>\n  <p>  literal text  </p>\n',
    '<?php\r\nclass A {\r\nfunction f() {\r\nreturn 1;\r\n}\r\n}\r\n'
  ];
  for (const source of samples) {
    const output = formatPhp(source);
    assert.deepEqual(tokenize(output).map(t => t.value), tokenize(source).map(t => t.value));
    assert.equal(formatPhp(output), output, 'formatting must be idempotent');
    assert.equal(output.endsWith('\n'), source.endsWith('\n'));
    if (source.includes('\r\n')) assert.ok(!/(?<!\r)\n/.test(output));
    if (source.includes('<p>')) assert.ok(output.includes('  <p>  literal text  </p>'));
  }
  assert.equal(formatPhp('<?php echo 1;\n'), '<?php echo 1;\n');
});

test('format style changes indentation and brace layout', () => {
  const source = '<?php\nclass A {\nfunction f() {\nreturn 1;\n}\n}\n';
  assert.match(formatPhp(source, 'Allman'), /class A\n\{/);
  assert.match(formatPhp(source, 'K&R'), /class A \{/);
  assert.match(formatPhp(source, 'Drupal'), /\n  function f/);
  assert.match(formatPhp(source, 'WordPress'), /\n\tfunction f/);
});

test('range formatting respects full document nesting and selection boundaries', async () => {
  const doc = mock.document('<?php\nclass A\n{\nfunction f()\n{\nreturn 1;\n}\n}\n');
  const range = new mock.stub.Range(5, 0, 5, 9);
  const edits = await formattingEdits(doc, mock.token, range);
  assert.equal(mock.apply(doc, edits), doc.getText().replace('return 1;', '        return 1;'));
  assert.deepEqual(await formattingEdits(doc, mock.token, new mock.stub.Range(5, 1, 5, 6)), []);
  assert.deepEqual(await formattingEdits(mock.document('<p>{{ "a,b=c" }}</p>', undefined, 'blade'), mock.token), []);
});

test('rename resolves method receivers and leaves unrelated symbols and prose intact', () => {
  const source = '<?php class A { function sa|ve() {} } class B { function save() {} } function f(A $a, B $b) { $a->save(); $b->save(); } $save = "save"; // save';
  assert.equal(rename(source, 'persist').main, source.replace('|','').replace('function save()', 'function persist()').replace('$a->save()', '$a->persist()'));
});

test('rename preserves explicit aliases and changes qualified/imported type names', () => {
  const source = '<?php namespace App; use Domain\\User as Person; use Domain\\{Other, User}; function f(Person $p, User $u): \\Domain\\User { return new \\Domain\\Us|er; }';
  const result = rename(source, 'Account', { domain: '<?php namespace Domain; class User {} class Other {}' });
  assert.equal(result.domain, '<?php namespace Domain; class Account {} class Other {}');
  assert.equal(result.main, source.replace('|','').replace(/Domain\\User/g,'Domain\\Account').replace('{Other, User}', '{Other, Account}').replace('User $u', 'Account $u'));
});

test('rename changes an inherited method family and rejects collisions and unresolved locals', () => {
  const result = rename('<?php interface A { function sa|ve(); } class B implements A { function save() {} } function f(B $b) { $b->save(); }', 'persist');
  assert.equal((result.main.match(/persist/g) ?? []).length, 3);
  assert.throws(() => rename('<?php class A { function sa|ve() {} function persist() {} }', 'persist'), /already exists/);
  assert.throws(() => rename('<?php $va|lue = 1;', 'other'), /unambiguous/);
  assert.throws(() => rename('<?php class Us|er {}', 'class'), /non-reserved/);
  assert.throws(() => rename('<?php class A { function sa|ve() {} } function f($unknown) { $unknown->save(); }', 'persist'), /Cannot safely resolve/);
  assert.throws(() => rename('<?php class A { function sa|ve() {} } class B { function save() {} } function f(A|B $value) { $value->save(); }', 'persist'), /Cannot safely resolve/);
});

test('unused imports are removed individually and batch edits do not overlap', () => {
  for (const [source, expected] of [
    ['<?php\nuse Foo\\Used, Foo\\Unused;\nnew Used();', '<?php\nuse Foo\\Used;\nnew Used();'],
    ['<?php\nuse Foo\\{A, B, C, D};\nnew B();', '<?php\nuse Foo\\{B};\nnew B();'],
    ['<?php\n\nuse Foo\\Unused;\n', '<?php\n\n'],
    ['<?php\r\nuse Foo\\A, Foo\\B;\r\n', '<?php\r\n'],
    ['<?php use Foo\\Unused; echo 1;', '<?php  echo 1;'],
    ['<?php\nuse Foo\\{function a, function b, const C};\nb();', '<?php\nuse Foo\\{function b};\nb();']
  ]) { const file = parseSource(source); const edits = removeImports(file, unusedImports(file)); assert.equal(apply(source, edits), expected); }
});

test('import cleanup preserves aliases, PHPDoc, trait uses, closure captures and other namespaces', () => {
  const source = '<?php namespace A { use Foo\\User as Person; /** @var Person */ $p = null; class C { use TraitName; } $f = function () use ($p) {}; } namespace B { use Foo\\User; }';
  const file = parseSource(source), unused = unusedImports(file);
  assert.deepEqual(unused.map(i => i.imported.alias), ['User']);
  assert.ok(apply(source, removeImports(file, unused)).includes('use TraitName;'));
});

test('constant extraction inserts into the owning class, chooses a fresh name and preserves CRLF', () => {
  const source = '<?php\r\nclass A {\r\nprivate const EXTRACTED_VALUE = 0;\r\nfunction f() {\r\nreturn 1 + 2;\r\n}\r\n}\r\nclass B {}';
  const start = source.indexOf('1 + 2'), edits = extractConstant(source, start, start + 5);
  const output = apply(source, edits);
  assert.match(output, /class A \{\r\n    private const EXTRACTED_VALUE_2 = 1 \+ 2;/);
  assert.match(output, /return self::EXTRACTED_VALUE_2;/);
  assert.equal(parseSource(output).declarations.find(d => d.name === 'EXTRACTED_VALUE_2').owner, 'A');
  assert.ok(!/(?<!\r)\n/.test(output));
});

test('constant extraction avoids inherited final constants', () => {
  const source = '<?php class A extends Base { function f() { return 1 + 2; } }';
  const project = new PhpProject();
  project.update('base', '<?php class Base { final protected const EXTRACTED_VALUE = 7; }');
  project.update('main', source);
  const start = source.indexOf('1 + 2');
  const result = apply(source, extractConstant(source, start, start + 5, project));
  assert.match(result, /private const EXTRACTED_VALUE_2 =/);
});

test('constant extraction refuses dynamic expressions and selections outside a class method', () => {
  for (const selected of ['$value + 2', 'time()', '"hello $name"', 'new Foo()', '1; echo 2']) {
    const source = `<?php class A { function f() { return ${selected}; } }`, start = source.indexOf(selected);
    assert.equal(extractConstant(source, start, start + selected.length), undefined);
  }
  const source = '<?php function f() { return 1 + 2; }', start = source.indexOf('1 + 2');
  assert.equal(extractConstant(source, start, start + 5), undefined);
  const partial = '<?php class A { function f() { return 1 + 2 * 3; } }', partialStart = partial.indexOf('1 + 2');
  assert.equal(extractConstant(partial, partialStart, partialStart + 5), undefined);
});

test('target PHP version controls compatibility hints without matching strings and member calls', () => {
  const source = '<?php $x?->f(); $x = match (1) { 1 => true }; enum State {} readonly class Value {} each($x); $obj->each(); $s = "each($x)"; // each($x)';
  const old = compatibilityIssues(source, '7.4'), current = compatibilityIssues(source, '8.4');
  assert.equal(old.length, 4);
  assert.equal(current.length, 1);
  assert.match(current[0].message, /removed/);
  assert.deepEqual(compatibilityIssues('<?php function each($x) {} each([]);', '8.4'), []);
});

test('external formatter options use the selected preset and reject unsupported combinations', () => {
  assert.deepEqual(externalFormatterArgs('/bin/pint', '/tmp/test.php', 'Laravel'), ['--preset', 'laravel', '/tmp/test.php']);
  assert.ok(externalFormatterArgs('php-cs-fixer', '/tmp/test.php', 'PSR-12').includes('--rules=@PSR12'));
  assert.throws(() => externalFormatterArgs('pint', '/tmp/test.php', 'Allman'), /does not support/);
});

const phpAvailable = spawnSync('php', ['-n', '-v']).status === 0;
test('formatted and extracted regression fixtures remain valid PHP', { skip: !phpAvailable }, () => {
  const source = '<?php class A { function f() { return 1 + 2; } }', start = source.indexOf('1 + 2');
  for (const text of [formatPhp('<?php $a = 1; $b = 1; if ($a === $b) {}'), apply(source, extractConstant(source, start, start + 5))]) {
    const result = spawnSync('php', ['-n', '-l'], { input: text, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
