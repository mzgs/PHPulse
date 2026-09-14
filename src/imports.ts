import { classAt, functionAt, Import, namespaceAt, PhpFile, splitTopLevel } from './phpSyntax';

export interface SourceEdit { start: number; end: number; text: string }
export interface ImportItem { imported: Import; start: number; end: number; nameStart: number; nameEnd: number; aliased: boolean }
export interface ImportStatement { start: number; end: number; items: ImportItem[] }

/** Namespace imports only: trait uses and closure captures are not imports. */
export function importStatements(file: PhpFile): ImportStatement[] {
  const result: ImportStatement[] = [];
  const ts = file.code;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].value !== 'use' || classAt(file, ts[i].start) || functionAt(file, ts[i].start)) continue;
    const start = i;
    while (i < ts.length && ts[i].value !== ';') i++;
    if (!ts[i]) break;
    const end = ts[i].end;
    const imports = namespaceAt(file, ts[start].start).imports.filter(imp => imp.end === end);
    let list = ts.slice(start + 1, i);
    if (['function', 'const'].includes(list[0]?.value)) list = list.slice(1);
    const group = list.findIndex(t => t.value === '{');
    if (group >= 0) list = list.slice(group + 1, -1);
    const parts = splitTopLevel(list);
    if (parts.length !== imports.length) continue;
    const items = parts.map((part, n) => {
      const names = part.filter(t => !['function', 'const'].includes(t.value));
      const as = names.findIndex(t => t.value.toLowerCase() === 'as');
      const name = names.slice(0, as < 0 ? undefined : as);
      return { imported: imports[n], start: part[0].start, end: part.at(-1)!.end,
        nameStart: name[0].start, nameEnd: name.at(-1)!.end, aliased: as >= 0 };
    });
    result.push({ start: ts[start].start, end, items });
  }
  return result;
}

export function unusedImports(file: PhpFile): ImportItem[] {
  const statements = importStatements(file);
  return statements.flatMap(statement => statement.items.filter(item => {
    const ns = namespaceAt(file, statement.start);
    return !file.tokens.some(t => {
      if (t.start < ns.start || t.start > ns.end || statements.some(s => s.start <= t.start && t.start < s.end)) return false;
      // Keep imports mentioned in PHPDoc; removing them can change analyzer types.
      if (t.kind === 'comment') return t.value.startsWith('/**') && new RegExp(`\\b${item.imported.alias}\\b`, 'i').test(t.value);
      if (t.kind !== 'word' || t.value.startsWith('\\')) return false;
      const name = t.value.split('\\')[0];
      return item.imported.kind === 'const' ? name === item.imported.alias : name.toLowerCase() === item.imported.alias.toLowerCase();
    });
  }));
}

/** Coalesce adjacent removals so a batch cleanup never produces overlapping edits. */
export function removeImports(file: PhpFile, selected: ImportItem[]): SourceEdit[] {
  const starts = new Set(selected.map(i => i.start));
  const edits: SourceEdit[] = [];
  for (const statement of importStatements(file)) {
    const items = statement.items;
    if (!items.some(i => starts.has(i.start))) continue;
    // Preserve comments rather than guess how to attach them to remaining imports.
    if (file.tokens.some(t => t.kind === 'comment' && t.start > statement.start && t.start < statement.end)) continue;
    if (items.every(i => starts.has(i.start))) {
      let { start, end } = statement;
      const lineStart = file.text.lastIndexOf('\n', start - 1) + 1;
      const trailing = file.text.slice(end).match(/^[ \t]*(?:\r?\n|$)/);
      if (/^[ \t]*$/.test(file.text.slice(lineStart, start)) && trailing) { start = lineStart; end += trailing[0].length; }
      edits.push({ start, end, text: '' });
      continue;
    }
    for (let i = 0; i < items.length; i++) {
      if (!starts.has(items[i].start)) continue;
      const first = i;
      while (i + 1 < items.length && starts.has(items[i + 1].start)) i++;
      edits.push(i + 1 < items.length
        ? { start: items[first].start, end: items[i + 1].start, text: '' }
        : { start: items[first - 1].end, end: items[i].end, text: '' });
    }
  }
  return edits;
}
