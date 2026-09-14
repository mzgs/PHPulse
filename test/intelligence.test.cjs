const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PhpProject, memberContext, activeCall, completionLocation, importEdit } = require('../dist/intelligence');
const { parseSource, namespaceAt, resolveName, classAt } = require('../dist/phpSyntax');

const domain = `<?php
namespace Domain;
trait HasLabel { public function label(): string {} private function hiddenTrait(): void {} }
class Address { public string $city; public function format(string $separator = ','): string {} }
class BaseUser {
    public function inherited(): Address {}
    protected function protectedMethod(): void {}
    private function privateMethod(): void {}
    public static function create(): static {}
    public static string $table;
    public const ACTIVE = 1;
}
class User extends BaseUser {
    use HasLabel;
    public function __construct(public Address $address, private string $secret = '') {}
    public function address(): Address { $notAProperty = '{'; }
    /** @return Address[] */
    public function addresses(): array {}
    public function fluent(): self {}
    public function save(string $name, array $options = [], ?Address $address = null): self {}
}
function user(): User {}
`;
function projectWith(text) {
  const project = new PhpProject(); project.update('domain.php', domain);
  project.update('other.php', '<?php namespace Other; class User { public function unrelated(): void {} }');
  const offset = text.indexOf('|'); assert.ok(offset >= 0); text = text.replace('|', '');
  const file = project.update('main.php', text); project.rebuild();
  return { project, file, offset };
}
function members(text) {
  const { project, file, offset } = projectWith(text);
  const ctx = memberContext(file, offset); assert.ok(ctx, 'member context');
  return project.memberCandidates(file, offset, ctx).map(r => r.declaration.name).sort();
}
const prefix = '<?php namespace App; use Domain\\User; use Domain\\Address; ';

test('multiline declarations, promotion, real properties, and complete ranges', () => {
  const file = parseSource(domain);
  const user = file.declarations.find(d => d.fqName === 'Domain\\User');
  assert.deepEqual(user.parents, ['Domain\\BaseUser']);
  assert.deepEqual(user.traits, ['Domain\\HasLabel']);
  const properties = file.declarations.filter(d => d.owner === user.fqName && d.kind === 'property');
  assert.deepEqual(properties.map(p => p.name), ['address', 'secret']);
  assert.equal(properties[0].type, 'Address');
  assert.ok(user.end > user.bodyStart + 100);
  const multiline = parseSource(`<?php class A\n{\n/** hello */\npublic function call(\n string $name,\n array $options = ['x' => [1, 2]]\n): \\Domain\\User { return new \\Domain\\User(); }\n}`);
  assert.equal(multiline.declarations[1].parameters.length, 2);
  assert.equal(multiline.declarations[1].type, '\\Domain\\User');
  assert.match(multiline.declarations[1].doc, /hello/);
});

test('strings, comments, heredocs and HTML do not create symbols or affect braces', () => {
  const file = parseSource(`outside class Fake {} <?php
class Real { public string $s = "} class Nope {";
// function fake() { }
/* class Nope2 {} */
public function real() { $x = <<<'TEXT'
class Nope3 { function fake() {} }
TEXT;
} }
?> class AlsoFake {}`);
  assert.deepEqual(file.declarations.map(d => d.name), ['Real', 's', 'real']);
});

test('namespace aliases, grouped imports, function imports, and bracketed scopes', () => {
  const file = parseSource(`<?php namespace A { use Domain\\{User as Person, Address}; use function Domain\\user as make; class X {} }
namespace B { use Other\\User; class X {} }`);
  const a = file.text.indexOf('class X'); const b = file.text.lastIndexOf('class X');
  assert.equal(resolveName(file, 'Person', a), 'Domain\\User');
  assert.equal(resolveName(file, 'Address', a), 'Domain\\Address');
  assert.equal(resolveName(file, 'make', a, 'function'), 'Domain\\user');
  assert.equal(resolveName(file, 'User', b), 'Other\\User');
  assert.equal(namespaceAt(file, b).name, 'B');
});

test('instance completion is exact, inherited, visibility-aware, and excludes static members', () => {
  const names = members(prefix + '$user = new User(); $user->|');
  assert.ok(names.includes('address')); assert.ok(names.includes('inherited')); assert.ok(names.includes('label'));
  for (const invalid of ['unrelated', 'privateMethod', 'protectedMethod', 'hiddenTrait', 'secret', 'create', 'ACTIVE', 'table', 'notAProperty']) assert.ok(!names.includes(invalid), invalid);
});

test('parameter, property, chained method, factory and nullsafe inference', () => {
  for (const expression of ['$user->address()->', '$user?->address?->', 'User::create()->address()->', '$user->fluent()->address()->', '(new User())->address()->']) {
    assert.deepEqual(members(prefix + `function run(User $user) { ${expression}| }`), ['city', 'format'], expression);
  }
  assert.deepEqual(members(prefix + 'use function Domain\\user as make; make()->address()->|'), ['city', 'format']);
});

test('static properties and constants are offered only in static access', () => {
  assert.deepEqual(members(prefix + 'User::|'), ['ACTIVE', 'create', 'table']);
  assert.deepEqual(members(prefix + 'User::$ta|'), ['table']);
});

test('unknown receivers never fall back to members from unrelated classes', () => {
  assert.deepEqual(members(prefix + '$unknown->|'), []);
  assert.deepEqual(members(prefix + '$u = new User(); $u = unknown(); $u->|'), []);
});

test('latest assignments and function boundaries govern inference', () => {
  assert.deepEqual(members(prefix + '$u = new User(); $u = new Address(); $u->|'), ['city', 'format']);
  assert.deepEqual(members(prefix + 'function one() { $u = new User(); } function two() { $u->| }'), []);
  const { project, file, offset } = projectWith(prefix + 'function one() { $leaked = 1; } function two(User $user) { $local = 1; $l| }');
  assert.deepEqual(project.variables(file, offset).sort(), ['l', 'local', 'user']);
});

test('PHPDoc parameters, locals, collections and foreach preserve element types', () => {
  assert.deepEqual(members(prefix + '/** @param User $user */ function f($user) { $user->address()->| }'), ['city', 'format']);
  assert.deepEqual(members(prefix + '/** @var Address $item */ $item->|'), ['city', 'format']);
  assert.deepEqual(members(prefix + '$u = new User(); $items = $u->addresses(); $items[0]->|'), ['city', 'format']);
  assert.deepEqual(members(prefix + '$u = new User(); foreach ($u->addresses() as $item) { $item->| }'), ['city', 'format']);
});

test('protected members, parent calls, and this are resolved within the actual class', () => {
  const text = prefix + 'class Admin extends User { function test() { $this->| } }';
  const names = members(text); assert.ok(names.includes('protectedMethod')); assert.ok(!names.includes('privateMethod'));
  assert.ok(members(prefix + 'class Admin extends User { function test() { parent::| } }').includes('protectedMethod'));
  assert.deepEqual(members(prefix + 'class Admin extends User { static function test() { $this->| } }'), []);
});

test('unfinished code at EOF retains class and function scope', () => {
  assert.ok(members(prefix + 'class Admin extends User { function test() { $this->|').includes('inherited'));
});

test('closures see captures, but do not leak their locals to outer functions', () => {
  assert.deepEqual(members(prefix + 'function f(User $u) { $fn = function () use ($u) { $u->address()->| }; }'), ['city', 'format']);
  assert.deepEqual(members(prefix + 'function f(User $u) { $fn = function () { $u->| }; }'), []);
  assert.deepEqual(members(prefix + 'function f(User $u) { $fn = fn () => $u->address()->|; }'), ['city', 'format']);
});

test('active calls ignore nested commas, strings and arrays, and recognize named arguments', () => {
  const { project, file, offset } = projectWith(prefix + 'function f(User $u) { $u->save(trim("a,b"), [1, 2], address: |); }');
  const call = activeCall(file, offset); assert.equal(call.argument, 2); assert.equal(call.name, 'address');
  assert.equal(project.callable(file, call.callee, offset).declaration.fqName, 'Domain\\User::save');
});

test('navigation disambiguates methods and imported types using the receiver', () => {
  const { project, file, offset } = projectWith(prefix + '$u = new User(); $u->add|ress();');
  assert.equal(project.symbolAt(file, offset)[0].declaration.fqName, 'Domain\\User::address');
});

test('auto-import honors aliases, collisions, declare and the active namespace', () => {
  const { project, file, offset } = projectWith('<?php declare(strict_types=1); namespace App { use Other\\User; new Us| }');
  const user = project.type('Domain\\User');
  assert.deepEqual(importEdit(project, file, offset, user, 'Us'), { name: '\\Domain\\User' });
  const address = project.type('Domain\\Address');
  const edit = importEdit(project, file, offset, address, 'Add');
  assert.ok(edit.offset > file.text.indexOf('namespace App')); assert.match(edit.text, /use Domain\\Address;/);
  const aliasFile = parseSource('<?php namespace App; use Domain\\User as Person; new Per');
  assert.deepEqual(importEdit(project, aliasFile, aliasFile.text.length, user, 'Per'), { name: 'Person' });
  const strictFile = parseSource('<?php declare(strict_types=1); new Add');
  assert.equal(importEdit(project, strictFile, strictFile.text.length, address, 'Add').offset, strictFile.text.indexOf(';') + 1);
});

test('completion is suppressed in prose, strings and comments, with dedicated PHPDoc context', () => {
  for (const [source, expected] of [['<?php // text', 'none'], ['<?php "text', 'none'], ['<?php /** @par', 'doc'], ['<html><?php echo 1; ?>text', 'none'], ['<?php $a->', 'code']]) {
    assert.equal(completionLocation(parseSource(source), source.length), expected, source);
  }
});

test('cyclic inheritance terminates and overrides are deduplicated', () => {
  const project = new PhpProject(); project.update('cycle', '<?php class A extends B { function same() {} } class B extends A { function same() {} function other() {} }'); project.rebuild();
  assert.deepEqual(project.membersOf('A').map(r => r.declaration.name), ['same', 'other']);
});

test('native intersection and nullable union parameters preserve every declared type', () => {
  const project = new PhpProject(); project.update('domain', domain);
  const file = project.update('main', '<?php use Domain\\User; use Domain\\Address; function f(User&Address $both, User|Address|null $either) { $both-> }');
  project.rebuild(); const offset = file.text.indexOf('$both->') + 7;
  assert.deepEqual(project.variableTypes(file, 'both', offset), ['Domain\\User', 'Domain\\Address']);
  assert.deepEqual(project.variableTypes(file, 'either', offset), ['Domain\\User', 'Domain\\Address']);
});

test('instanceof narrows inside the positive branch and respects reassignment and else', () => {
  assert.deepEqual(members(prefix + 'function f($u) { if ($u instanceof Address) { $u->| } }'), ['city', 'format']);
  assert.deepEqual(members(prefix + 'function f($u) { if ($u instanceof Address) {} else { $u->| } }'), []);
  assert.deepEqual(members(prefix + 'function f($u) { if ($u instanceof Address) { $u = unknown(); $u->| } }'), []);
  assert.deepEqual(members(prefix + 'function f($u) { if (!($u instanceof Address)) { $u->| } }'), []);
});

test('incremental updates replace names and members without changing unrelated references', () => {
  const project = new PhpProject();
  project.update('stable', '<?php namespace App; class Stable {}');
  const stable = project.type('App\\Stable');
  project.update('editing', '<?php namespace App; class Before { function oldMethod() {} }');
  const previous = project.all();
  project.update('editing', '<?php namespace App; class After { function newMethod() {} }');
  assert.equal(project.type('App\\Before'), undefined);
  assert.equal(project.named('oldMethod').length, 0);
  assert.equal(project.membersOf('App\\Before').length, 0);
  assert.equal(project.completionCandidates('Be').length, 0);
  assert.deepEqual(project.completionCandidates('Af').map(r => r.declaration.name), ['After']);
  assert.equal(project.type('App\\Stable'), stable);
  assert.notEqual(project.all(), previous);
  assert.equal(project.all().length, 3);
});

test('removing files clears all lookup paths, including collision checks and functions', () => {
  const project = new PhpProject();
  project.update('a', '<?php namespace App; class UserRepository { function save() {} } function make(): UserRepository {} const VALUE = 1;');
  assert.ok(project.completionCandidates('UR').length);
  assert.equal(project.remove('a'), true);
  for (const name of ['UserRepository', 'save', 'make', 'VALUE']) assert.equal(project.named(name).length, 0);
  assert.equal(project.completionCandidates('UR').length, 0);
  assert.equal(project.completionCandidates('', 'App\\').length, 0);
  assert.equal(project.globalNamed('App\\UserRepository').length, 0);
  assert.equal(project.all().length, 0);
  assert.equal(project.remove('a'), false);
});

test('duplicate declarations retain source order after edits and recover after deletion', () => {
  const project = new PhpProject();
  project.update('first', '<?php class Shared { function value(): int {} }');
  project.update('second', '<?php class Shared { function value(): string {} }');
  assert.equal(project.type('Shared').uri, 'second');
  project.update('first', '<?php class Shared { function value(): bool {} }');
  assert.equal(project.type('Shared').uri, 'second');
  assert.deepEqual(project.named('Shared').map(r => r.uri), ['first', 'second']);
  assert.equal(project.membersOf('Shared')[0].declaration.type, 'bool');
  project.remove('second');
  assert.equal(project.type('Shared').uri, 'first');
});

test('prefix lookup matches full-scan results for abbreviations, aliases and qualified names', () => {
  const { matches } = require('../dist/intelligence');
  const project = new PhpProject();
  project.update('names', '<?php namespace Domain; class UserRepository {} class UserResource {} class Url {} class Under_score {} function user_function() {}');
  for (const query of ['', 'u', 'UR', 'UserR', 'us', 'not_found']) {
    const expected = project.all().filter(r => !r.declaration.owner && matches(r.declaration.name, query)).map(r => r.declaration.fqName).sort();
    assert.deepEqual(project.completionCandidates(query).map(r => r.declaration.fqName).sort(), expected, query);
  }
  assert.deepEqual(project.completionCandidates('Person', undefined, ['Domain\\UserRepository']).map(r => r.declaration.name), ['UserRepository']);
  assert.deepEqual(project.completionCandidates('Domain\\Url', 'Domain\\Url').map(r => r.declaration.name), ['Url']);
});

test('repeated edits do not accumulate stale declarations', () => {
  const project = new PhpProject();
  for (let i = 0; i < 50; i++) {
    project.update('one', `<?php class Version${i} { function method${i}() {} }`);
    assert.equal(project.all().length, 2);
    assert.equal(project.completionCandidates('Version').length, 1);
    if (i) assert.equal(project.named(`method${i - 1}`).length, 0);
  }
});

test('scope lookup exits closures correctly and caches are isolated between document revisions', () => {
  const { functionAt } = require('../dist/phpSyntax');
  const project = new PhpProject(); project.update('domain', domain);
  const source = '<?php use Domain\\User; use Domain\\Address; function outer(User $u) { $fn = function (Address $u) { $u->city; }; $u->address(); }';
  const first = project.update('main', source);
  const inside = source.indexOf('$u->city'), after = source.indexOf('$u->address');
  assert.notEqual(functionAt(first, inside), functionAt(first, after));
  assert.deepEqual(project.variableTypes(first, 'u', inside), ['Domain\\Address']);
  assert.deepEqual(project.variableTypes(first, 'u', after), ['Domain\\User']);
  const second = project.update('main', source.replace('outer(User', 'outer(Address'));
  assert.deepEqual(project.variableTypes(second, 'u', second.text.indexOf('$u->address')), ['Domain\\Address']);
  assert.deepEqual(project.variableTypes(first, 'u', after), ['Domain\\User']);
});

test('editing a dependency refreshes inferred return types in an unchanged caller', () => {
  const project = new PhpProject(); project.update('domain', domain);
  const file = project.update('caller', '<?php $u = new \\Domain\\User(); $u->address()->');
  const offset = file.text.length, ctx = memberContext(file, offset);
  assert.deepEqual(project.memberCandidates(file, offset, ctx).map(r => r.declaration.name), ['city', 'format']);
  project.update('domain', domain.replace('public function address(): Address', 'public function address(): User'));
  const changed = project.memberCandidates(file, offset, ctx).map(r => r.declaration.name);
  assert.ok(changed.includes('save')); assert.ok(!changed.includes('city'));
});
