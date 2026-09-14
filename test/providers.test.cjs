const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PhpProject } = require('../dist/intelligence');
const mock = require('./helpers/vscode.cjs');
const { registerLanguageFeatures } = mock.load('../../dist/providers');
const { Diagnostics, registerCommands } = mock.load('../../dist/tooling');
const { formattingEdits } = mock.load('../../dist/formatting');
const output = { appendLine() {} };
function setup(doc) {
  const project = new PhpProject(); project.update(doc.uri.toString(), doc.getText());
  const index = { project, onDidChange: () => ({ dispose() {} }), current: d => project.update(d.uri.toString(), d.getText()), initialize: async () => {} };
  registerLanguageFeatures({ subscriptions: [] }, index);
  return index;
}
afterEach(() => { for (const key of Object.keys(mock.settings)) delete mock.settings[key]; mock.documents.clear(); });

test('editor rename provider returns only semantic edits and supports cancellation', async () => {
  const doc = mock.document('<?php class A { function save() {} } class B { function save() {} } function f(A $a) { $a->save(); }');
  setup(doc);
  const provider = mock.providers.registerRenameProvider, position = doc.positionAt(doc.getText().indexOf('save') + 1);
  const prepared = provider.prepareRename(doc, position); assert.equal(prepared.placeholder, 'save');
  const edit = await provider.provideRenameEdits(doc, position, 'persist', mock.token);
  assert.equal(edit.edits.length, 2);
  assert.match(mock.apply(doc, edit.edits), /class B \{ function save/);
  assert.equal(await provider.provideRenameEdits(doc, position, 'persist', { isCancellationRequested: true }), undefined);
});

test('rename rejects buffers edited while the reference documents are being opened', async () => {
  const doc = mock.document('<?php class A { function save() {} }'), index = setup(doc);
  const open = mock.stub.workspace.openTextDocument;
  mock.stub.workspace.openTextDocument = async uri => {
    doc.setText('<?php class A { function different() {} }');
    index.current(doc);
    return doc;
  };
  try {
    await assert.rejects(mock.providers.registerRenameProvider.provideRenameEdits(doc, doc.positionAt(doc.getText().indexOf('save') + 1), 'persist', mock.token), /document changed/);
  } finally { mock.stub.workspace.openTextDocument = open; }
});

test('diagnostics use the configured PHP target version', async () => {
  mock.settings['phpulse.phpExecutable'] = process.execPath;
  const doc = mock.document('<?php each($items);'), diagnostics = new Diagnostics(output);
  try {
    mock.settings['phpulse.phpVersion'] = '7.4'; await diagnostics.validate(doc);
    assert.equal(mock.diagnostics.get(doc.uri.toString()).filter(d => d.code === 'php-version').length, 0);
    mock.settings['phpulse.phpVersion'] = '8.4'; await diagnostics.validate(doc);
    assert.equal(mock.diagnostics.get(doc.uri.toString()).filter(d => d.code === 'php-version').length, 1);
  } finally { diagnostics.dispose(); }
});

test('diagnostics and quick fixes remove only the unused import; command recomputes stale diagnostics', async () => {
  mock.settings['phpulse.phpExecutable'] = process.execPath; // No PHP installation needed for import diagnostics.
  const doc = mock.document('<?php\n\nuse Foo\\Used, Foo\\Unused;\nnew Used();');
  const index = setup(doc), diagnostics = new Diagnostics(output);
  try {
    await diagnostics.validate(doc);
    const hints = mock.diagnostics.get(doc.uri.toString()).filter(d => d.code === 'unused-import');
    assert.equal(hints.length, 1); assert.equal(hints[0].range.start.line, 2);
    const actions = mock.providers.registerCodeActionsProvider.provideCodeActions(doc, new mock.stub.Range(0, 0, 0, 0), { diagnostics: hints });
    assert.equal(mock.apply(doc, actions[0].edit.edits), '<?php\n\nuse Foo\\Used;\nnew Used();');
    doc.setText('<?php\nuse Foo\\Used, Foo\\Unused, Foo\\Other;\nnew Used();');
    registerCommands({ subscriptions: [] }, index, diagnostics, output);
    mock.stub.window.activeTextEditor = { document: doc };
    await mock.commands['phpulse.removeUnusedImports']();
    assert.equal(doc.getText(), '<?php\nuse Foo\\Used;\nnew Used();');
  } finally { diagnostics.dispose(); }
});

test('constant code action produces a class member and is not offered for dynamic expressions', () => {
  const source = '<?php class A { function f() { return 1 + 2; } }', doc = mock.document(source); setup(doc);
  const start = source.indexOf('1 + 2');
  const actions = mock.providers.registerCodeActionsProvider.provideCodeActions(doc, new mock.stub.Range(doc.positionAt(start), doc.positionAt(start + 5)), { diagnostics: [] });
  const action = actions.find(a => a.title === 'Extract to class constant');
  assert.ok(action);
  assert.ok(mock.apply(doc, action.edit.edits).indexOf('private const') < mock.apply(doc, action.edit.edits).indexOf('function f'));
});

test('formatting provider honors configured style and emits no edits for unchanged documents', async () => {
  const doc = mock.document('<?php\nclass A {\nfunction f() {\nreturn 1;\n}\n}\n'); setup(doc);
  mock.settings['phpulse.format.style'] = 'WordPress';
  const provider = mock.providers.registerDocumentFormattingEditProvider;
  const edits = await provider.provideDocumentFormattingEdits(doc, {}, mock.token);
  assert.match(mock.apply(doc, edits), /\n\tfunction f/);
  doc.setText(mock.apply(doc, edits));
  assert.deepEqual(await provider.provideDocumentFormattingEdits(doc, {}, mock.token), []);
});

test('external formatter receives a temporary buffer copy, settings and cwd; failures leave the file unchanged', { skip: process.platform === 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'phpulse-test-'));
  try {
    const command = path.join(directory, 'php-cs-fixer'), filename = path.join(directory, 'original.php');
    const source = '<?php $x=1;\n'; await fs.writeFile(filename, 'on-disk content');
    await fs.writeFile(command, `#!/usr/bin/env node\nconst fs = require('fs'); const args = process.argv.slice(2); const filename = args.at(-1); fs.writeFileSync('invocation.json', JSON.stringify({ args, cwd: process.cwd() })); if (!args.includes('--rules=@PSR12')) process.exit(2); fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace('$x=1', '$x = 1'));\n`, { mode: 0o700 });
    mock.settings['phpulse.format.command'] = command;
    mock.settings['phpulse.format.style'] = 'PSR-12';
    const doc = mock.document(source, filename);
    const edits = await formattingEdits(doc, mock.token);
    assert.equal(mock.apply(doc, edits), '<?php $x = 1;\n');
    assert.equal(await fs.readFile(filename, 'utf8'), 'on-disk content');
    const invocation = JSON.parse(await fs.readFile(path.join(directory, 'invocation.json'), 'utf8'));
    assert.equal(await fs.realpath(invocation.cwd), await fs.realpath(directory));
    assert.notEqual(invocation.args.at(-1), filename);
    await assert.rejects(fs.stat(invocation.args.at(-1)), { code: 'ENOENT' });
    await fs.writeFile(command, '#!/usr/bin/env node\nprocess.stderr.write("formatter failed"); process.exit(1);\n');
    await assert.rejects(formattingEdits(doc, mock.token), /formatter failed/);
    assert.equal(doc.getText(), source);
    assert.equal(await fs.readFile(filename, 'utf8'), 'on-disk content');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
