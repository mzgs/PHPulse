import { PhpProject, SymbolReference, memberContext } from './intelligence';
import { importStatements, SourceEdit } from './imports';
import { classAt, functionAt, isType, namespaceAt, PhpFile, Token } from './phpSyntax';

function same(a: SymbolReference, b: SymbolReference): boolean {
  return a.uri === b.uri && a.declaration.nameStart === b.declaration.nameStart;
}
function tokenAt(file: PhpFile, offset: number): Token | undefined {
  return file.tokens.find(t => t.start <= offset && offset < t.end)
    ?? file.tokens.find(t => t.end === offset);
}
function resolve(project: PhpProject, file: PhpFile, token: Token, statements = importStatements(file), declarations?: Map<number, SymbolReference>): SymbolReference[] {
  if (!['word', 'variable'].includes(token.kind)) return [];
  const cached = declarations?.get(token.start) ?? (token.kind === 'variable' ? declarations?.get(token.start + 1) : undefined);
  if (cached) return [cached];
  const declared = file.declarations.find(d => d.nameStart === token.start || token.kind === 'variable' && d.nameStart === token.start + 1);
  if (declared) return project.named(declared.name).filter(r => r.file === file && r.declaration === declared);
  const statement = statements.find(s => s.start <= token.start && token.start < s.end);
  if (statement) {
    const item = statement.items.find(i => i.nameStart <= token.start && token.end <= i.nameEnd);
    return item ? project.globalNamed(item.imported.name).filter(r => item.imported.kind === 'type' ? isType(r.declaration) : r.declaration.kind === item.imported.kind.replace('const', 'constant')) : [];
  }
  const context = memberContext(file, token.end);
  if (context) {
    const caller = classAt(file, token.start)?.fqName;
    const parentAccess = context.operator === '::' && ['parent', 'self', 'static'].includes(context.receiver.at(-1)?.value ?? '') && !functionAt(file, token.start)?.isStatic;
    const refs = project.expressionTypes(file, context.receiver, token.start).flatMap(type => project.membersOf(type, caller,
      context.operator === '::' ? parentAccess ? 'parent' : 'static' : 'instance'));
    const name = token.value.replace(/^\$/, '');
    return refs.filter((r, i) => (r.declaration.kind === 'method' ? r.declaration.name.toLowerCase() === name.toLowerCase() : r.declaration.name === name) && !refs.slice(0, i).some(other => same(r, other)));
  }
  if (token.kind === 'variable') return [];
  const previous = file.code[file.code.indexOf(token) - 1]?.value;
  if (previous === 'namespace' || previous === 'as') return [];
  return project.symbolAt(file, token.start + 1);
}

export function renameTarget(project: PhpProject, file: PhpFile, offset: number): SymbolReference {
  if (!file.text.includes('<?')) throw new Error('Add a PHP opening tag before renaming symbols.');
  const token = tokenAt(file, offset);
  const refs = token ? resolve(project, file, token) : [];
  if (refs.length !== 1) throw new Error('Rename requires an unambiguous PHP declaration or resolved reference.');
  const target = refs[0];
  const imported = namespaceAt(file, offset).imports.find(i => i.alias.toLowerCase() === token!.value.split('\\')[0].toLowerCase());
  if (imported && imported.alias !== imported.name.split('\\').pop() && token!.value === imported.alias) {
    throw new Error('Rename the original declaration; explicit import aliases are preserved.');
  }
  if (target.declaration.name.startsWith('__')) throw new Error('Renaming PHP magic members is not supported.');
  if (target.declaration.owner && project.type(target.declaration.owner)?.declaration.kind === 'trait') {
    throw new Error('Renaming trait members requires trait-adaptation analysis and is not supported yet.');
  }
  if (target.declaration.kind === 'property' && target.file.functions.some(s => s.start <= target.declaration.nameStart && target.declaration.nameStart < s.bodyStart)) {
    throw new Error('Renaming constructor-promoted properties requires named-argument analysis and is not supported yet.');
  }
  return target;
}

/** Methods that implement/override each other must retain the same name. */
function family(project: PhpProject, target: SymbolReference): SymbolReference[] {
  const result = [target];
  if (target.declaration.kind !== 'method') return result;
  const candidates = project.named(target.declaration.name).filter(r => r.declaration.kind === 'method');
  for (let i = 0; i < result.length; i++) for (const ref of candidates) {
    if (result.some(r => same(r, ref)) || ref.declaration.visibility === 'private' || result[i].declaration.visibility === 'private') continue;
    const a = ref.declaration.owner!, b = result[i].declaration.owner!;
    if (project.isSubclass(a, b) || project.isSubclass(b, a)) result.push(ref);
  }
  return result;
}

export function renameEdits(project: PhpProject, target: SymbolReference, newName: string): Map<string, SourceEdit[]> {
  if (target.declaration.kind === 'method' && newName.startsWith('__')) throw new Error('Renaming to a PHP magic member is not supported.');
  if (!/^[A-Za-z_]\w*$/.test(newName) || /^(?:class|trait|interface|enum|function|namespace|use|new|self|parent|static|const|public|private|protected|return|true|false|null|int|string|bool|float|mixed|void|never|object|array|callable|iterable|match|fn|readonly|abstract|final|if|else|while|for|foreach|switch|case|default|try|catch|finally|throw|yield|echo|print|isset|empty|unset|list|exit|die|include|require|global|clone|instanceof|extends|implements|insteadof|as|break|continue|declare|goto|and|or|xor)$/i.test(newName)) {
    throw new Error('Choose a valid, non-reserved PHP identifier.');
  }
  const targets = family(project, target);
  for (const ref of targets) {
    const d = ref.declaration;
    const collisions = d.owner ? project.membersOf(d.owner, d.owner) : project.globalNamed([d.namespace, newName].filter(Boolean).join('\\'));
    if (collisions.some(r => r.declaration.name.toLowerCase() === newName.toLowerCase() && !targets.some(t => same(t, r)) &&
      (d.owner ? r.declaration.kind === d.kind : isType(d) ? isType(r.declaration) : r.declaration.kind === d.kind))) {
      throw new Error(`A PHP symbol named '${newName}' already exists in this scope.`);
    }
  }
  const result = new Map<string, SourceEdit[]>();
  for (const [uri, file] of project.files) {
    if (!file.text.includes('<?')) continue;
    const edits: SourceEdit[] = [];
    const statements = importStatements(file);
    const declarations = new Map(project.forDocument(uri).map(r => [r.declaration.nameStart, r]));
    for (const t of file.code) {
      if (!['word', 'variable'].includes(t.kind)) continue;
      // Avoid semantic resolution for the vast majority of unrelated tokens.
      const localName = t.value.replace(/^\$/, '').split('\\').pop()!;
      const aliases = namespaceAt(file, t.start).imports;
      if (localName.toLowerCase() !== target.declaration.name.toLowerCase() && !aliases.some(i => i.alias.toLowerCase() === localName.toLowerCase() && i.name.toLowerCase() === target.declaration.fqName.toLowerCase())) continue;
      const refs = resolve(project, file, t, statements, declarations);
      const matches = refs.filter(r => targets.some(target => same(target, r)));
      if (matches.length && matches.length !== refs.length || !refs.length && target.declaration.owner && memberContext(file, t.end)) {
        throw new Error(`Cannot safely resolve '${localName}' in ${uri}. Add a receiver type before renaming.`);
      }
      if (!matches.length) continue;
      const statement = statements.find(s => s.start <= t.start && t.start < s.end);
      if (!statement) {
        const imp = namespaceAt(file, t.start).imports.find(i => i.alias.toLowerCase() === t.value.toLowerCase());
        if (imp && statements.some(s => s.items.some(i => i.imported === imp && i.aliased))) continue;
      }
      const oldName = t.value.replace(/^\$/, '').split('\\').pop()!;
      const start = t.end - oldName.length;
      // Alias collisions would change the meaning of existing references.
      if (isType(target.declaration) && namespaceAt(file, t.start).imports.some(i => i.alias.toLowerCase() === newName.toLowerCase() && i.name.toLowerCase() !== target.declaration.fqName.toLowerCase())) {
        throw new Error(`The name '${newName}' conflicts with an import in ${uri}.`);
      }
      if (isType(target.declaration) && !t.value.includes('\\') && project.globalNamed([namespaceAt(file, t.start).name, newName].filter(Boolean).join('\\')).some(r => isType(r.declaration) && !targets.some(target => same(target, r)))) {
        throw new Error(`The name '${newName}' conflicts with a type in ${uri}.`);
      }
      edits.push({ start, end: t.end, text: newName });
    }
    if (edits.length) result.set(uri, edits);
  }
  return result;
}
