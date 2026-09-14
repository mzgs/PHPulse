import { classAt, functionAt, parseSource, tokenize } from './phpSyntax';
import { SourceEdit } from './imports';
import { PhpProject } from './intelligence';

/** Intentionally limited to literal expressions whose evaluation does not depend on scope. */
function constantExpression(text: string): boolean {
  const tokens = tokenize(text);
  let i = 0;
  const atom = (): boolean => {
    const t = tokens[i++];
    if (!t) return false;
    if (t.value === '+' || t.value === '-') return atom();
    if (t.value === '(') return expression() && tokens[i++]?.value === ')';
    if (t.kind === 'string') return t.value.startsWith("'") && t.value.endsWith("'") || t.value.startsWith('"') && t.value.endsWith('"') && !t.value.includes('$');
    if (/^(?:true|false|null)$/i.test(t.value)) return true;
    if (/^\d$/.test(t.value)) { while (/^\d$/.test(tokens[i]?.value ?? '') && tokens[i - 1].end === tokens[i].start) i++; return true; }
    return false;
  };
  const expression = (): boolean => {
    if (!atom()) return false;
    while (['+', '-', '*', '.'].includes(tokens[i]?.value)) { i++; if (!atom()) return false; }
    return true;
  };
  return expression() && i === tokens.length;
}

export function extractConstant(text: string, start: number, end: number, project?: PhpProject): SourceEdit[] | undefined {
  const file = parseSource(text), owner = classAt(file, start), scope = functionAt(file, start);
  if (!owner || !['class', 'trait'].includes(owner.kind) || owner.bodyStart === undefined || !scope || end >= scope.end || scope.owner !== owner.fqName) return;
  const selected = text.slice(start, end);
  if (!selected.trim() || !constantExpression(selected)) return;
  // Reject partial identifiers, strings and selections crossing token boundaries.
  if (file.tokens.some(t => t.start < start && start < t.end || t.start < end && end < t.end)) return;
  if (/\w/.test(text[start - 1] ?? '') && /\w/.test(text[start] ?? '') || /\w/.test(text[end - 1] ?? '') && /\w/.test(text[end] ?? '')) return;
  const first = file.code.findIndex(t => t.start >= start);
  const after = file.code.findIndex(t => t.start >= end);
  // Extracting only part of an unparenthesized expression can change precedence.
  if (!['return', '=', '=>', '(', '[', ','].includes(file.code[first - 1]?.value) || ![';', ')', ']', ','].includes(file.code[after]?.value)) return;
  let name = 'EXTRACTED_VALUE', n = 2;
  const names = new Set(file.declarations.filter(d => d.owner === owner.fqName).map(d => d.name));
  for (const ref of project?.membersOf(owner.fqName, owner.fqName) ?? []) names.add(ref.declaration.name);
  // Include names used through self/parent in the file to avoid accidentally shadowing them.
  for (const t of file.code) names.add(t.value);
  while (names.has(name)) name = `EXTRACTED_VALUE_${n++}`;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = text.lastIndexOf('\n', owner.start) + 1;
  const indent = text.slice(lineStart, owner.start).match(/^[ \t]*/)?.[0] ?? '';
  return [
    { start: owner.bodyStart, end: owner.bodyStart, text: `${newline}${indent}    private const ${name} = ${selected.trim()};${newline}` },
    { start, end, text: `self::${name}` }
  ];
}
