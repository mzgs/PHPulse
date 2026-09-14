import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { parseSource, tokenize } from './phpSyntax';
import { run } from './tooling';

/** Only edit whitespace outside tokens. Never rewrite strings, comments or template text. */
export function formatPhp(text: string, style = 'PSR-12'): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const file = parseSource(text);
  const braceEdits: { start: number; end: number; text: string }[] = [];
  const bodies = new Set(file.declarations.filter(d => d.bodyStart !== undefined).map(d => d.bodyStart! - 1));
  for (let i = 1; i < file.tokens.length; i++) {
    const t = file.tokens[i], prev = file.tokens[i - 1];
    if (t.kind !== 'symbol' || t.value !== '{' || prev.kind === 'comment') continue;
    const gap = text.slice(prev.end, t.start);
    if (!/^\s*$/.test(gap)) continue;
    const block = bodies.has(t.start) || [')', 'else', 'try', 'finally', 'do'].includes(prev.value);
    if (!block) continue;
    const ownLine = style === 'Allman' || ['PSR-12', 'PSR-2', 'PER', 'Laravel'].includes(style) && bodies.has(t.start);
    braceEdits.push({ start: prev.end, end: t.start, text: ownLine ? newline : ' ' });
  }
  let source = text;
  for (const edit of braceEdits.reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  const tokens = tokenize(source);
  const indent = style === 'WordPress' ? '\t' : style === 'Drupal' ? '  ' : '    ';
  let offset = 0, cursor = 0, depth = 0;
  const formatted = source.split(/(?<=\n)/).map(line => {
    const end = offset + line.length;
    const start = offset; offset = end;
    const first = start + (line.match(/^[ \t]*/)?.[0].length ?? 0);
    while (cursor < tokens.length && tokens[cursor].end <= start) cursor++;
    const token = tokens[cursor];
    // A continuation of a multiline literal/comment must remain byte-for-byte intact.
    const canIndent = token?.start === first && token.kind !== 'comment' && !token.value.startsWith('<<<');
    const level = Math.max(0, depth - (token?.kind === 'symbol' && ['}', ']', ')'].includes(token.value) ? 1 : 0));
    for (let i = cursor; i < tokens.length && tokens[i].start < end; i++) {
      const t = tokens[i];
      if (t.start < start || t.kind !== 'symbol') continue;
      if (['{', '[', '(' , '#['].includes(t.value)) depth++;
      if (['}', ']', ')'].includes(t.value)) depth = Math.max(0, depth - 1);
    }
    return canIndent ? indent.repeat(level) + line.slice(first - start) : line;
  }).join('');
  // Protect against lexer edge cases, including flexible heredoc boundaries.
  const before = tokenize(text), after = tokenize(formatted);
  return before.length === after.length && before.every((t, i) => t.value === after[i].value && t.kind === after[i].kind) ? formatted : text;
}

export function externalFormatterArgs(command: string, filename: string, style: string): string[] {
  const name = path.basename(command).toLowerCase().replace(/\.(?:phar|bat|exe)$/, '');
  if (name === 'pint') {
    const presets: Record<string, string> = { Laravel: 'laravel', 'PSR-12': 'psr12', PER: 'per' };
    if (!presets[style]) throw new Error(`Pint does not support the '${style}' preset. Choose Laravel, PSR-12 or PER.`);
    return ['--preset', presets[style], filename];
  }
  if (name === 'php-cs-fixer') {
    const rules: Record<string, string> = { 'PSR-12': '@PSR12', 'PSR-2': '@PSR2', PER: '@PER-CS' };
    if (!rules[style]) throw new Error(`PHP CS Fixer does not support the '${style}' preset here. Choose PSR-12, PSR-2 or PER.`);
    return ['fix', '--using-cache=no', '--allow-risky=no', '--path-mode=override', `--rules=${rules[style]}`, filename];
  }
  throw new Error('phpulse.format.command must point to a pint or php-cs-fixer executable.');
}

export async function formattingEdits(document: vscode.TextDocument, token: vscode.CancellationToken, range?: vscode.Range): Promise<vscode.TextEdit[]> {
  // PHP formatters cannot safely format Blade/HTML as PHP source.
  if (document.languageId !== 'php' || token.isCancellationRequested) return [];
  const cfg = vscode.workspace.getConfiguration('phpulse.format', document.uri);
  const command = cfg.get<string>('command', '');
  const style = cfg.get<string>('style', 'PSR-12');
  const source = document.getText(), version = document.version;
  let formatted: string;
  if (command) {
    if (range) return []; // External tools format whole files; never overwrite outside a selection.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'phpulse-format-'));
    try {
      const filename = path.join(directory, path.basename(document.fileName) || 'source.php');
      const args = externalFormatterArgs(command, filename, style);
      await fs.writeFile(filename, source, { mode: 0o600 });
      const cwd = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(document.fileName);
      const executable = command.includes('/') || command.includes('\\') ? path.resolve(cwd, command) : command;
      const result = await run(executable, args, cwd, undefined, token);
      if (token.isCancellationRequested) return [];
      if (result.code !== 0) throw new Error(`PHP formatter failed: ${result.stderr || result.stdout || result.code}`);
      formatted = await fs.readFile(filename, 'utf8');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  } else if (range) {
    // Compute indentation in full-document context, then use only complete selected lines.
    const first = range.start.line, last = range.end.line - (range.end.character === 0 ? 1 : 0);
    const lines = source.split('\n');
    const full = formatPhp(source, style).split('\n');
    if (lines.length !== full.length) return [];
    const edits: vscode.TextEdit[] = [];
    for (let line = first; line <= last; line++) {
      const original = document.lineAt(line);
      if (line === first && range.start.character !== 0 || line === last && range.end.line === line && range.end.character < original.text.length) continue;
      const replacement = full[line].replace(/\r$/, '');
      if (replacement !== original.text) edits.push(vscode.TextEdit.replace(original.range, replacement));
    }
    return edits;
  } else formatted = formatPhp(source, style);
  if (token.isCancellationRequested || document.version !== version || formatted === source) return [];
  return [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(source.length)), formatted)];
}
