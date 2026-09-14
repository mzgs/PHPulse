import { parseSource } from './phpSyntax';

export interface CompatibilityIssue { start: number; end: number; message: string }

/** Target-version hints supplement (and do not emulate) the installed PHP interpreter. */
export function compatibilityIssues(text: string, version: string): CompatibilityIssue[] {
  const target = Number(version.split('.').slice(0, 2).join('.'));
  const file = parseSource(text), issues: CompatibilityIssue[] = [];
  const add = (start: number, end: number, message: string) => issues.push({ start, end, message });
  file.code.forEach((t, i, ts) => {
    if (t.kind === 'comment' || t.kind === 'string') return;
    const previous = ts[i - 1]?.value;
    const member = ['->', '?->', '::', 'function'].includes(previous);
    if (target >= 8 && /^(?:\\?each)$/i.test(t.value) && ts[i + 1]?.value === '(' && !member && !file.declarations.some(d => d.kind === 'function' && d.name.toLowerCase() === 'each')) {
      add(t.start, t.end, 'each() was removed in PHP 8.0.');
    }
    const feature = t.value === '?->' ? ['Nullsafe access', 8.0] as const
      : t.value === '#[' ? ['Attributes', 8.0] as const
      : t.value === 'match' && ts[i + 1]?.value === '(' && !member ? ['Match expressions', 8.0] as const
      : t.value === 'enum' && file.declarations.some(d => d.kind === 'enum' && d.start === t.start) ? ['Enums', 8.1] as const
      : t.value === 'readonly' && !member && file.declarations.some(d => ['class', 'property'].includes(d.kind) && d.start <= t.start && t.end < d.nameStart) ? [ts[i + 1]?.value === 'class' ? 'Readonly classes' : 'Readonly properties', ts[i + 1]?.value === 'class' ? 8.2 : 8.1] as const
      : undefined;
    if (feature && target < feature[1]) add(t.start, t.end, `${feature[0]} require PHP ${feature[1].toFixed(1)} or newer (target: ${version}).`);
  });
  return issues;
}
