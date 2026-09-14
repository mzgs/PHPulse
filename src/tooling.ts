import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { PhpIndex } from './model';
import { parseSource } from './phpSyntax';
import { removeImports, unusedImports } from './imports';
import { compatibilityIssues } from './compatibility';

interface RunResult { code: number; stdout: string; stderr: string }

export function run(command: string, args: string[], cwd?: string, input?: string, token?: vscode.CancellationToken): Promise<RunResult> {
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(command, args, { cwd, env: process.env, shell: false }); } catch (e) { resolve({ code: -1, stdout: '', stderr: String(e) }); return; }
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString()); child.stderr.on('data', d => stderr += d.toString());
    child.on('error', e => resolve({ code: -1, stdout, stderr: `${stderr}${e.message}` }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    token?.onCancellationRequested(() => child.kill());
  });
}

export class Diagnostics implements vscode.Disposable {
  readonly collection = vscode.languages.createDiagnosticCollection('phpulse');
  private timers = new Map<string, NodeJS.Timeout>();
  private disposables: vscode.Disposable[];
  private disposed = false;
  constructor(private output: vscode.OutputChannel) {
    this.disposables = [
      vscode.workspace.onDidOpenTextDocument(d => this.schedule(d)),
      vscode.workspace.onDidSaveTextDocument(d => this.schedule(d)),
      vscode.workspace.onDidChangeTextDocument(e => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument(d => {
        const key = d.uri.toString(); clearTimeout(this.timers.get(key)); this.timers.delete(key); this.collection.delete(d.uri);
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('phpulse')) for (const doc of vscode.workspace.textDocuments) this.schedule(doc);
      })
    ];
    vscode.workspace.textDocuments.forEach(d => this.schedule(d));
  }
  schedule(doc: vscode.TextDocument): void {
    if (this.disposed || doc.languageId !== 'php') return;
    const key = doc.uri.toString(); const prior = this.timers.get(key); if (prior) clearTimeout(prior);
    if (!vscode.workspace.getConfiguration('phpulse.diagnostics', doc.uri).get('enable', true)) { this.collection.delete(doc.uri); this.timers.delete(key); return; }
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); void this.validate(doc); }, 450));
  }
  async validate(doc: vscode.TextDocument): Promise<void> {
    const diagnostics: vscode.Diagnostic[] = [];
    const text = doc.getText(), version = doc.version;
    const php = vscode.workspace.getConfiguration('phpulse', doc.uri).get('phpExecutable', 'php');
    const syntax = await run(php, ['-d', 'display_errors=1', '-l'], path.dirname(doc.fileName), text);
    if (this.disposed || doc.isClosed || doc.version !== version || !vscode.workspace.getConfiguration('phpulse.diagnostics', doc.uri).get('enable', true)) return;
    const syntaxText = `${syntax.stdout}\n${syntax.stderr}`;
    const error = syntaxText.match(/(?:Parse error|Fatal error):\s*(.+?)\s+in (?:Standard input code|.+?) on line (\d+)/s);
    if (error) diagnostics.push(new vscode.Diagnostic(new vscode.Range(Math.max(0, +error[2] - 1), 0, Math.max(0, +error[2] - 1), Number.MAX_SAFE_INTEGER), error[1].replace(/\s+/g, ' ').trim(), vscode.DiagnosticSeverity.Error));

    for (const item of unusedImports(parseSource(text))) {
      const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(item.nameStart), doc.positionAt(item.nameEnd)), `Unused import '${item.imported.alias}'.`, vscode.DiagnosticSeverity.Hint);
      d.tags = [vscode.DiagnosticTag.Unnecessary]; d.code = 'unused-import'; diagnostics.push(d);
    }
    for (const m of text.matchAll(/\b(TODO|FIXME|HACK|XXX)\b:?\s*([^\r\n]*)/g)) { const start = doc.positionAt(m.index!); const d = new vscode.Diagnostic(new vscode.Range(start, start.translate(0, m[1].length)), `${m[1]}: ${m[2].trim() || 'task marker'}`, vscode.DiagnosticSeverity.Information); d.code = 'todo'; diagnostics.push(d); }
    const target = vscode.workspace.getConfiguration('phpulse', doc.uri).get('phpVersion', '8.4');
    for (const issue of compatibilityIssues(text, target)) {
      const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(issue.start), doc.positionAt(issue.end)), issue.message, vscode.DiagnosticSeverity.Warning);
      d.code = 'php-version'; diagnostics.push(d);
    }
    this.collection.set(doc.uri, diagnostics); this.output.appendLine(`Validated ${doc.uri.fsPath}: ${diagnostics.length} issue(s)`);
  }
  async analyzeWorkspace(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!root) return;
    const cfg = vscode.workspace.getConfiguration('phpulse.diagnostics'); const selected = cfg.get('tool', 'auto');
    const candidates = selected === 'auto' ? [path.join(root, 'vendor/bin/phpstan'), path.join(root, 'vendor/bin/psalm')] : selected === 'none' ? [] : [path.join(root, `vendor/bin/${selected}`)];
    const tool = candidates.find(fs.existsSync);
    if (!tool) { await Promise.all(vscode.workspace.textDocuments.filter(d => d.languageId === 'php').map(d => this.validate(d))); void vscode.window.showInformationMessage('PHP lint analysis completed. Install PHPStan or Psalm for deeper workspace analysis.'); return; }
    this.output.show(true); const args = tool.endsWith('phpstan') ? ['analyse', '--error-format=raw', '--no-progress'] : ['--output-format=console']; const result = await run(tool, args, root); this.output.append(`${result.stdout}${result.stderr}`); void vscode.window.showInformationMessage(result.code === 0 ? 'PHP static analysis passed.' : 'PHP analysis found issues; see PHPulse output.');
  }
  dispose(): void { this.disposed = true; this.timers.forEach(clearTimeout); this.disposables.forEach(d => d.dispose()); this.collection.dispose(); }
}

export class PhpTests implements vscode.Disposable {
  readonly controller = vscode.tests.createTestController('phpulse.tests', 'PHP Tests');
  private watcher?: vscode.FileSystemWatcher;
  private runProfile: vscode.TestRunProfile;
  private debugProfile: vscode.TestRunProfile;
  constructor(private output: vscode.OutputChannel) {
    this.runProfile = this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (req, token) => this.runTests(req, token, false), true);
    this.debugProfile = this.controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, (req, token) => this.runTests(req, token, true), true);
    this.controller.resolveHandler = async item => item ? this.discoverFile(item) : this.discoverAll();
    this.watcher = vscode.workspace.createFileSystemWatcher('**/{test,tests}/**/*.{php,pest.php}');
    this.watcher.onDidCreate(uri => this.addFile(uri)); this.watcher.onDidChange(uri => this.refreshFile(uri)); this.watcher.onDidDelete(uri => this.controller.items.delete(uri.toString()));
    void this.discoverAll();
  }
  private async discoverAll(): Promise<void> { const files = await vscode.workspace.findFiles('**/{test,tests}/**/*.php', '**/vendor/**', 5000); for (const uri of files) this.addFile(uri); }
  private addFile(uri: vscode.Uri): void { if (this.controller.items.get(uri.toString())) return; const item = this.controller.createTestItem(uri.toString(), vscode.workspace.asRelativePath(uri), uri); item.canResolveChildren = true; this.controller.items.add(item); void this.discoverFile(item); }
  private async refreshFile(uri: vscode.Uri): Promise<void> { this.controller.items.delete(uri.toString()); this.addFile(uri); if (vscode.workspace.getConfiguration('phpulse.tests').get('continuous', false)) { const item = this.controller.items.get(uri.toString()); if (item) await this.runTests(new vscode.TestRunRequest([item]), new vscode.CancellationTokenSource().token, false); } }
  private async discoverFile(file: vscode.TestItem): Promise<void> {
    if (!file.uri) return; const doc = await vscode.workspace.openTextDocument(file.uri); file.children.replace([]);
    const text = doc.getText(); const patterns = [/\b(?:public\s+)?function\s+(test\w+)\s*\(/g, /\b(?:it|test)\s*\(\s*['"]([^'"]+)['"]/g];
    for (const re of patterns) for (const m of text.matchAll(re)) { const pos = doc.positionAt(m.index!); const id = `${file.uri.toString()}#${m[1]}`; const test = this.controller.createTestItem(id, m[1], file.uri); test.range = new vscode.Range(pos, pos.translate(0, m[0].length)); file.children.add(test); }
  }
  private async runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken, debug: boolean): Promise<void> {
    const testRun = this.controller.createTestRun(request); const queue: vscode.TestItem[] = [];
    const add = (i: vscode.TestItem) => { if (!request.exclude?.includes(i)) { if (i.children.size) i.children.forEach(add); else queue.push(i); } };
    if (request.include) request.include.forEach(add); else this.controller.items.forEach(add);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(); const configured = vscode.workspace.getConfiguration('phpulse.tests').get('command', '');
    const command = configured || [path.join(root, 'vendor/bin/pest'), path.join(root, 'vendor/bin/phpunit')].find(fs.existsSync);
    if (!command) { queue.forEach(t => { testRun.started(t); testRun.errored(t, new vscode.TestMessage('No Pest or PHPUnit binary found. Run Composer install or configure phpulse.tests.command.')); }); testRun.end(); return; }
    for (const test of queue) {
      if (token.isCancellationRequested) { testRun.skipped(test); continue; } testRun.started(test); const filter = test.id.split('#')[1];
      if (debug && test.uri) { await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(test.uri), { type: 'php', name: `Debug ${test.label}`, request: 'launch', program: command, args: ['--filter', filter, test.uri.fsPath], cwd: root }); testRun.skipped(test); continue; }
      const started = Date.now(); const result = await run(command, ['--colors=never', '--filter', filter, test.uri!.fsPath], root, undefined, token); testRun.appendOutput(`${result.stdout}${result.stderr}`.replace(/\n/g, '\r\n'), undefined, test);
      if (result.code === 0) testRun.passed(test, Date.now() - started); else testRun.failed(test, new vscode.TestMessage((result.stdout + result.stderr).slice(-4000)), Date.now() - started);
    }
    testRun.end(); this.output.appendLine(`Test run completed (${queue.length} tests).`);
  }
  dispose(): void { this.watcher?.dispose(); this.runProfile.dispose(); this.debugProfile.dispose(); this.controller.dispose(); }
}

export function registerBladeFeatures(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: 'blade' }, {
    async provideCompletionItems(document, position) {
      const directives = ['@if','@elseif','@else','@endif','@unless','@endunless','@foreach','@endforeach','@forelse','@empty','@endforelse','@for','@endfor','@while','@endwhile','@switch','@case','@break','@default','@endswitch','@section','@endsection','@yield','@extends','@include','@includeIf','@includeWhen','@component','@slot','@endslot','@csrf','@method','@auth','@guest','@can','@cannot','@php','@endphp','@once','@push','@stack','@vite','@livewire'];
      const items = directives.map(d => new vscode.CompletionItem(d, vscode.CompletionItemKind.Keyword));
      const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri; if (!root) return items;
      const prefix = document.lineAt(position).text.slice(0, position.character);
      if (/(?:view|include|extends|component|yield|section)\s*\(?'[^']*$|@(?:include|extends|component|yield|section)\s*\(?'[^']*$/.test(prefix)) {
        const views = await vscode.workspace.findFiles(new vscode.RelativePattern(root, 'resources/views/**/*.blade.php'), '**/vendor/**', 3000);
        for (const uri of views) { const id = path.relative(path.join(root.fsPath, 'resources/views'), uri.fsPath).replace(/\.blade\.php$/, '').split(path.sep).join('.'); const item = new vscode.CompletionItem(id, vscode.CompletionItemKind.File); item.detail = 'Laravel view'; items.push(item); }
      }
      if (/<x-[\w.:-]*$/.test(prefix)) {
        const comps = await vscode.workspace.findFiles(new vscode.RelativePattern(root, 'resources/views/components/**/*.blade.php'), undefined, 1000);
        for (const uri of comps) { const id = path.relative(path.join(root.fsPath, 'resources/views/components'), uri.fsPath).replace(/\.blade\.php$/, '').split(path.sep).join('.'); items.push(new vscode.CompletionItem(`x-${id}`, vscode.CompletionItemKind.Class)); }
      }
      if (/\broute\s*\(\s*['"][^'"]*$/.test(prefix)) {
        const routes = await vscode.workspace.findFiles(new vscode.RelativePattern(root, 'routes/**/*.php'), '**/vendor/**', 100);
        for (const uri of routes) { const source = (await vscode.workspace.fs.readFile(uri)).toString(); for (const match of source.matchAll(/->name\(\s*['"]([^'"]+)['"]\s*\)/g)) { const item = new vscode.CompletionItem(match[1], vscode.CompletionItemKind.Reference); item.detail = 'Laravel named route'; items.push(item); } }
      }
      if (/\bconfig\s*\(\s*['"][^'"]*$/.test(prefix)) {
        const configs = await vscode.workspace.findFiles(new vscode.RelativePattern(root, 'config/*.php'), undefined, 200);
        for (const uri of configs) { const base = path.basename(uri.fsPath, '.php'); const source = (await vscode.workspace.fs.readFile(uri)).toString(); for (const match of source.matchAll(/['"]([A-Za-z0-9_.-]+)['"]\s*=>/g)) { const item = new vscode.CompletionItem(`${base}.${match[1]}`, vscode.CompletionItemKind.Value); item.detail = 'Laravel config key'; items.push(item); } }
      }
      if (/->(?:where|orderBy|select|value|pluck)?\s*\(?\s*['"]?\w*$|wire:(?:click|model|change)=["'][\w]*$/.test(prefix)) {
        const migrations = await vscode.workspace.findFiles(new vscode.RelativePattern(root, 'database/migrations/*.php'), undefined, 1000);
        const names = new Set<string>();
        for (const uri of migrations) { const source = (await vscode.workspace.fs.readFile(uri)).toString(); for (const match of source.matchAll(/\$table->\w+\(\s*['"]([^'"]+)['"]/g)) names.add(match[1]); }
        for (const name of names) { const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field); item.detail = 'Eloquent model column'; items.push(item); }
      }
      return items;
    }
  }, '@', "'", '-', ':'));
}

export function registerCommands(context: vscode.ExtensionContext, index: PhpIndex, diagnostics: Diagnostics, output: vscode.OutputChannel): void {
  let server: vscode.Terminal | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand('phpulse.reindex', async () => { await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'PHPulse: indexing workspace…' }, () => index.initialize()); void vscode.window.showInformationMessage(`PHPulse indexed ${index.all().length} symbols.`); }),
    vscode.commands.registerCommand('phpulse.runAnalysis', () => diagnostics.analyzeWorkspace()),
    vscode.commands.registerCommand('phpulse.composerInstall', () => { const terminal = vscode.window.createTerminal('Composer'); terminal.show(); terminal.sendText('composer install'); }),
    vscode.commands.registerCommand('phpulse.startServer', () => { if (server) { server.show(); return; } const cfg = vscode.workspace.getConfiguration('phpulse.server'); const php = vscode.workspace.getConfiguration('phpulse').get('phpExecutable', 'php'); const root = cfg.get('documentRoot', '') || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.'; server = vscode.window.createTerminal({ name: 'PHP Development Server', cwd: root }); server.sendText(`${shellQuote(php)} -S ${cfg.get('host', '127.0.0.1')}:${cfg.get('port', 8000)} -t ${shellQuote(root)}`); server.show(); }),
    vscode.commands.registerCommand('phpulse.stopServer', () => { server?.dispose(); server = undefined; }),
    vscode.commands.registerCommand('phpulse.openManual', async () => { const editor = vscode.window.activeTextEditor; if (!editor) return; const range = editor.document.getWordRangeAtPosition(editor.selection.active); const name = range ? editor.document.getText(range) : ''; if (name) await vscode.env.openExternal(vscode.Uri.parse(`https://www.php.net/${encodeURIComponent(name)}`)); }),
    vscode.commands.registerCommand('phpulse.formatWorkspace', async () => { const files = await vscode.workspace.findFiles('**/*.{php,phtml,inc,blade.php}', '**/{vendor,node_modules}/**'); await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'PHPulse: formatting PHP files', cancellable: true }, async (progress, token) => { let done = 0; for (const uri of files) { if (token.isCancellationRequested) break; const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', uri); if (edits?.length) { const edit = new vscode.WorkspaceEdit(); edit.set(uri, edits); await vscode.workspace.applyEdit(edit); const doc = await vscode.workspace.openTextDocument(uri); await doc.save(); } progress.report({ increment: 100 / files.length, message: `${++done}/${files.length}` }); } }); }),
    vscode.commands.registerCommand('phpulse.removeUnusedImports', async () => {
      const editor = vscode.window.activeTextEditor; if (!editor || editor.document.languageId !== 'php') return;
      const doc = editor.document, file = parseSource(doc.getText());
      const ws = new vscode.WorkspaceEdit();
      for (const e of removeImports(file, unusedImports(file))) ws.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
      await vscode.workspace.applyEdit(ws);
    }),
    vscode.commands.registerCommand('phpulse.generateDocblock', async () => generateDocblock()),
    vscode.commands.registerCommand('phpulse.createLaunchConfig', async () => createLaunchConfig()),
    vscode.window.onDidCloseTerminal(t => { if (t === server) server = undefined; })
  );
  context.subscriptions.push({ dispose: () => server?.dispose() }); output.appendLine('Commands registered.');
}

async function generateDocblock(): Promise<void> {
  const editor = vscode.window.activeTextEditor; if (!editor) return; const lineNo = editor.selection.active.line; const text = editor.document.lineAt(lineNo).text; const fn = text.match(/function\s+\w+\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/); const indent = text.match(/^\s*/)?.[0] ?? '';
  const lines = [`${indent}/**`, `${indent} * ${fn ? 'Describe the function.' : 'Description.'}`];
  if (fn) { for (const p of fn[1].split(',').filter(Boolean)) { const m = p.trim().match(/(?:(\??[\\\w|&]+)\s+)?(?:&\s*)?(\.\.\.\s*)?(\$\w+)/); if (m) lines.push(`${indent} * @param ${m[1] ?? 'mixed'} ${m[3]}`); } if (fn[2] && fn[2] !== 'void') lines.push(`${indent} * @return ${fn[2]}`); }
  lines.push(`${indent} */`); await editor.edit(b => b.insert(new vscode.Position(lineNo, 0), `${lines.join('\n')}\n`));
}

async function createLaunchConfig(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]; if (!folder) return; const cfg = vscode.workspace.getConfiguration('launch', folder.uri); const current = cfg.get<any[]>('configurations', []); const entry = { name: 'Listen for Xdebug', type: 'php', request: 'launch', port: 9003, pathMappings: {} }; if (!current.some(c => c.name === entry.name)) await cfg.update('configurations', [...current, entry], vscode.ConfigurationTarget.WorkspaceFolder); void vscode.window.showInformationMessage('Created an Xdebug launch configuration.');
}
function shellQuote(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }
function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
