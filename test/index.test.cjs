const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
class EventEmitter {
  listeners = [];
  event = fn => { this.listeners.push(fn); return { dispose: () => { this.listeners = this.listeners.filter(f => f !== fn); } }; };
  fire = value => { for (const fn of this.listeners) fn(value); };
  dispose() { this.listeners = []; }
}
class Uri {
  constructor(value) { this.value = value; this.path = value.replace('file://', ''); }
  toString() { return this.value; }
  static parse(s) { return new Uri(s); }
  static joinPath(uri, ...segments) { return new Uri('file://' + path.posix.join(uri.path, ...segments)); }
}
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
const events = Object.fromEntries(['open', 'change', 'save', 'close', 'create', 'diskChange', 'delete'].map(k => [k, new EventEmitter()]));
const disk = new Map();
const workspace = {
  textDocuments: [], getConfiguration: () => ({ get: (_, fallback) => fallback }),
  createFileSystemWatcher: () => ({ onDidCreate: events.create.event, onDidChange: events.diskChange.event, onDidDelete: events.delete.event, dispose() {} }),
  onDidOpenTextDocument: events.open.event, onDidChangeTextDocument: events.change.event,
  onDidSaveTextDocument: events.save.event, onDidCloseTextDocument: events.close.event,
  findFiles: async () => [...disk.keys()].map(Uri.parse),
  fs: { readFile: async uri => { const source = disk.get(uri.toString()); if (source === undefined) throw new Error('Missing file'); return Uint8Array.from(Buffer.from(source)); } }
};
const stub = { workspace, EventEmitter, Uri, Position, Range, SymbolKind: {}, RelativePattern: class {} };
const original = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? stub : original.call(this, name, ...args); };
const { PhpIndex } = require('../dist/model'); Module._load = original;
function doc(name, text) { return { uri: Uri.parse('file:///' + name + '.php'), languageId: 'php', fileName: name + '.php', text, getText() { return this.text; } }; }

test('index uses UTF-8 disk contents, preserves dirty buffers, and removes stale files on reindex', async () => {
  const index = new PhpIndex();
  try {
    const dirty = doc('dirty', '<?php class Unsaved {}');
    disk.set(dirty.uri.toString(), '<?php class Old {}'); workspace.textDocuments = [dirty];
    disk.set('file:///unicode.php', '<?php /** café */ class Café {}');
    await index.initialize();
    assert.equal(index.named('Unsaved').length, 1); assert.equal(index.named('Old').length, 0);
    assert.equal(index.named('Café')[0].doc, '/** café */');
    disk.delete('file:///unicode.php'); await index.initialize(); assert.equal(index.named('Café').length, 0);
    events.delete.fire(dirty.uri); assert.equal(index.named('Unsaved').length, 0);
  } finally { index.dispose(); disk.clear(); workspace.textDocuments = []; }
});

test('edits to separate buffers debounce independently and completion refresh is immediate', async () => {
  const index = new PhpIndex();
  try {
    const a = doc('a', '<?php class First {}'), b = doc('b', '<?php class Second {}');
    index.update(a); index.update(b);
    a.text = '<?php class FirstChanged {}'; b.text = '<?php class SecondChanged {}';
    events.change.fire({ document: a }); events.change.fire({ document: b });
    await new Promise(resolve => setTimeout(resolve, 190));
    assert.equal(index.named('FirstChanged').length, 1); assert.equal(index.named('SecondChanged').length, 1);
    a.text = '<?php class Latest {}'; index.current(a);
    assert.equal(index.named('Latest').length, 1); assert.equal(index.named('FirstChanged').length, 0);
  } finally { index.dispose(); }
});

test('external disk changes refresh indexed declarations', async () => {
  const index = new PhpIndex();
  try {
    disk.set('file:///disk.php', '<?php class Before {}'); await index.initialize();
    disk.set('file:///disk.php', '<?php class After {}'); events.diskChange.fire(Uri.parse('file:///disk.php'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(index.named('After').length, 1); assert.equal(index.named('Before').length, 0);
  } finally { index.dispose(); disk.clear(); }
});

test('single-file updates avoid full rebuilds and preserve cached symbols in other files', () => {
  const index = new PhpIndex();
  try {
    const a = doc('a', '<?php class First {}'), b = doc('b', '<?php class Second {}');
    index.update(a); index.update(b);
    const stable = index.forDocument(b.uri)[0];
    index.project.rebuild = () => { throw new Error('Unexpected full rebuild'); };
    index.project.all = () => { throw new Error('Unexpected workspace scan'); };
    a.text = '<?php class Changed {}'; index.current(a);
    assert.equal(index.named('First').length, 0); assert.equal(index.named('Changed').length, 1);
    assert.equal(index.forDocument(b.uri)[0], stable);
  } finally { index.dispose(); }
});

test('unchanged document versions skip text extraction, while a new version refreshes symbols', () => {
  const index = new PhpIndex();
  try {
    const a = doc('versioned', '<?php class First {}'); a.version = 1;
    let reads = 0; a.getText = function() { reads++; return this.text; };
    index.current(a); index.current(a); index.current(a); assert.equal(reads, 1);
    a.text = '<?php class Next {}'; a.version++;
    index.current(a); assert.equal(reads, 2); assert.equal(index.named('Next').length, 1);
    events.delete.fire(a.uri); index.current(a); assert.equal(reads, 3);
    assert.equal(index.named('Next').length, 1);
  } finally { index.dispose(); }
});

test('unchanged disk notifications do not invalidate symbols or fire change events', async () => {
  const index = new PhpIndex();
  try {
    disk.set('file:///same.php', '<?php class Same {}'); await index.initialize();
    let changes = 0; index.onDidChange(() => changes++);
    const stable = index.named('Same')[0];
    events.diskChange.fire(Uri.parse('file:///same.php'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(changes, 0); assert.equal(index.named('Same')[0], stable);
  } finally { index.dispose(); disk.clear(); }
});
