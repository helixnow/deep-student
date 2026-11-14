// Declaration-level slice of the code one process can execute (G3 A fingerprint, g3-inputs/v2).
// A module's top-level statements are pure declarations (functions, literal-valued bindings,
// classes without evaluated parts, types) or effects. Loading a module runs its effects and
// loads its runtime imports; a pure declaration does something only when a name it binds is
// read by code that runs. The slice of a process is the effects of every module it loads plus
// the declarations named (transitively) from included code, with the import/export mappings
// that connect them. Code outside the slice cannot run in that process, so its text is not an
// input. Every approximation errs towards inclusion: a local shadowing a top-level name counts
// as a reference, a namespace import or an undestructured dynamic import requests every
// export. What cannot be analysed throws (computed dynamic import, computed `new URL` without
// a declared file list, `eval`, `require`, other `import.meta` uses) or keeps the whole file
// (parse errors, `import =`, `export =`, non-code files).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { runInThisContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const S = ts.SyntaxKind;
const sha256 = text => createHash('sha256').update(text).digest('hex');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const ALL = '*';
const DEFAULT_LOCAL = '*default*';
const CODE = /\.(?:mjs|js|cjs|ts|mts|cts)$/;

const modifiers = node => (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []);
const hasModifier = (node, kind) => modifiers(node).some(item => item.kind === kind);
const decorated = node => ts.canHaveDecorators(node) && (ts.getDecorators(node) ?? []).length > 0;

/** Values whose evaluation cannot throw or reach other code: literals, functions, regexes, arrays/objects of them. */
export function pureExpression(node) {
  if (!node) return true;
  switch (node.kind) {
    case S.StringLiteral: case S.NumericLiteral: case S.BigIntLiteral: case S.NoSubstitutionTemplateLiteral:
    case S.RegularExpressionLiteral: case S.TrueKeyword: case S.FalseKeyword: case S.NullKeyword:
    case S.ArrowFunction: case S.FunctionExpression:
      return true;
    case S.Identifier: return node.text === 'undefined';
    case S.ParenthesizedExpression: case S.AsExpression: case S.SatisfiesExpression: case S.TypeAssertionExpression: case S.NonNullExpression:
      return pureExpression(node.expression);
    case S.PrefixUnaryExpression:
      return [S.MinusToken, S.PlusToken].includes(node.operator) && node.operand.kind === S.NumericLiteral;
    case S.ArrayLiteralExpression:
      return node.elements.every(item => item.kind === S.OmittedExpression || (item.kind !== S.SpreadElement && pureExpression(item)));
    case S.ObjectLiteralExpression:
      return node.properties.every(item => item.name?.kind !== S.ComputedPropertyName && (
        (item.kind === S.PropertyAssignment && pureExpression(item.initializer))
        || [S.MethodDeclaration, S.GetAccessor, S.SetAccessor].includes(item.kind)));
    case S.ClassExpression: return pureClass(node);
    default: return false;
  }
}

/** A class definition evaluates its heritage, decorators, computed keys and static parts; without them it only binds. */
function pureClass(node) {
  if (node.heritageClauses?.some(clause => clause.token === S.ExtendsKeyword) || decorated(node)) return false;
  return node.members.every(member => member.name?.kind !== S.ComputedPropertyName && member.kind !== S.ClassStaticBlockDeclaration
    && !(member.kind === S.PropertyDeclaration && hasModifier(member, S.StaticKeyword) && member.initializer) && !decorated(member));
}

const bindingNames = (name, out = []) => {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
  return out;
};

const isComparison = node => ts.isBinaryExpression(node) && [S.EqualsEqualsEqualsToken, S.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind);
const mentions = (node, pattern) => pattern.test(node.getText());
/**
 * `if (<conjuncts> && import.meta.url === <process.argv[1]>) { … }` without else: the CLI body of
 * a module, false in any process whose argv[1] is another module. The condition may call only
 * node:url/node:path functions, so evaluating it has no effect either.
 */
function mainGuard(statement, imports) {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const conjuncts = [];
  const split = node => {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === S.AmpersandAmpersandToken) { split(node.left); split(node.right); } else conjuncts.push(node);
  };
  split(statement.expression);
  const guard = conjuncts.some(node => isComparison(node) && node.operatorToken.kind === S.EqualsEqualsEqualsToken
    && ((mentions(node.left, /\bimport\.meta\.url\b/) && mentions(node.right, /\bprocess\.argv\[1\]/))
      || (mentions(node.right, /\bimport\.meta\.url\b/) && mentions(node.left, /\bprocess\.argv\[1\]/))));
  if (!guard) return false;
  let calls = true;
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const binding = ts.isIdentifier(node.expression) ? imports.get(node.expression.text) : null;
      if (!binding || !['node:url', 'node:path'].includes(binding.specifier)) calls = false;
    }
    if (ts.isNewExpression(node) || ts.isAwaitExpression(node) || ts.isTaggedTemplateExpression(node)) calls = false;
    ts.forEachChild(node, visit);
  };
  visit(statement.expression);
  return calls;
}

/** One top-level statement: erased, import, export-from, export-names, a pure declaration, an effect, or unsupported. */
function classify(statement) {
  const declared = hasModifier(statement, S.DeclareKeyword), isDefault = hasModifier(statement, S.DefaultKeyword);
  const exported = hasModifier(statement, S.ExportKeyword);
  const own = (names, defaultName) => ({ names, exports: exported ? (isDefault ? [['default', defaultName]] : names.map(name => [name, name])) : [] });
  switch (statement.kind) {
    case S.ImportDeclaration: return { kind: statement.importClause?.isTypeOnly ? 'erased' : 'import' };
    case S.ExportDeclaration: return { kind: statement.isTypeOnly ? 'erased' : statement.moduleSpecifier ? 'export-from' : 'export-names' };
    case S.InterfaceDeclaration: case S.TypeAliasDeclaration: case S.EmptyStatement: return { kind: 'erased' };
    case S.FunctionDeclaration: {
      if (!statement.body || declared) return { kind: 'erased' };
      const local = statement.name?.text ?? DEFAULT_LOCAL;
      return { kind: 'declaration', ...own(isDefault && local !== DEFAULT_LOCAL ? [local, DEFAULT_LOCAL] : [local], local) };
    }
    case S.ClassDeclaration: {
      if (declared) return { kind: 'erased' };
      const local = statement.name?.text ?? DEFAULT_LOCAL;
      return { kind: pureClass(statement) ? 'declaration' : 'effect', ...own(isDefault && local !== DEFAULT_LOCAL ? [local, DEFAULT_LOCAL] : [local], local) };
    }
    case S.VariableStatement: {
      if (declared) return { kind: 'erased' };
      const declarations = statement.declarationList.declarations;
      const pure = declarations.every(item => ts.isIdentifier(item.name) && pureExpression(item.initializer));
      return { kind: pure ? 'declaration' : 'effect', ...own(declarations.flatMap(item => bindingNames(item.name))) };
    }
    case S.ExportAssignment:
      if (statement.isExportEquals) return { kind: 'unsupported', reason: 'export =' };
      return { kind: pureExpression(statement.expression) ? 'declaration' : 'effect', names: [DEFAULT_LOCAL], exports: [['default', DEFAULT_LOCAL]] };
    case S.ModuleDeclaration: case S.EnumDeclaration: {
      if (declared) return { kind: 'erased' };
      return { kind: 'effect', ...own(ts.isIdentifier(statement.name) ? [statement.name.text] : []) };
    }
    case S.ImportEqualsDeclaration: return statement.isTypeOnly ? { kind: 'erased' } : { kind: 'unsupported', reason: 'import =' };
    default: return { kind: 'effect', names: [], exports: [] };
  }
}

/** Parsed module: statements, local bindings (name → statement indexes), import bindings, exports, star re-exports, runtime imports. */
function parseModule(file, text) {
  const kind = /\.[mc]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  if (source.parseDiagnostics.length) return { file, whole: `parse error: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, ' ')}` };
  const statements = [], locals = new Map(), imports = new Map(), exports = new Map(), stars = [], loads = [];
  for (const [index, node] of source.statements.entries()) {
    const info = classify(node);
    if (info.kind === 'unsupported') return { file, whole: info.reason };
    statements.push({ index, node, text: node.getText(source), ...info });
    for (const name of info.names ?? []) {
      if (!locals.has(name)) locals.set(name, []);
      locals.get(name).push(index);
    }
    for (const [name, local] of info.exports ?? []) exports.set(name, { local });
    if (info.kind === 'import') {
      const specifier = node.moduleSpecifier.text;
      loads.push(specifier);
      const clause = node.importClause;
      if (clause?.name) imports.set(clause.name.text, { specifier, name: 'default' });
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, { specifier, name: ALL });
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) if (!element.isTypeOnly) imports.set(element.name.text, { specifier, name: (element.propertyName ?? element.name).text });
      }
    }
    if (info.kind === 'export-from') {
      const specifier = node.moduleSpecifier.text;
      loads.push(specifier);
      if (!node.exportClause) stars.push(specifier);
      else if (ts.isNamespaceExport(node.exportClause)) exports.set(node.exportClause.name.text, { specifier, name: ALL });
      else for (const element of node.exportClause.elements) {
        if (!element.isTypeOnly) exports.set(element.name.text, { specifier, name: (element.propertyName ?? element.name).text });
      }
    }
    if (info.kind === 'export-names') {
      for (const element of node.exportClause.elements) if (!element.isTypeOnly) exports.set(element.name.text, { local: (element.propertyName ?? element.name).text });
    }
  }
  for (const statement of statements) statement.mainGuard = statement.kind === 'effect' && mainGuard(statement.node, imports);
  return { file, statements, locals, imports, exports, stars, loads };
}

const isImportMetaUrl = node => ts.isPropertyAccessExpression(node) && node.name.text === 'url' && ts.isMetaProperty(node.expression);
const urlResource = node => ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
  && node.arguments?.length === 2 && isImportMetaUrl(node.arguments[1]);

/** `import.meta` is allowed as `new URL(…, import.meta.url)` (a resource) or inside a `===`/`!==` against process.argv (a main guard). */
function allowedMeta(meta) {
  const access = meta.parent;
  if (!isImportMetaUrl(access)) return false;
  if (urlResource(access.parent) && access.parent.arguments[1] === access) return true;
  for (let node = access.parent; node && !ts.isSourceFile(node); node = node.parent) {
    if (isComparison(node) && mentions(node, /\bprocess\.argv\b/)) return true;
    if (ts.isStatement(node)) break;
  }
  return false;
}

/** Names a statement reads (value positions), its dynamic imports, `new URL(…, import.meta.url)` resources, and what cannot be analysed. */
function references(statement) {
  const names = new Set(), dynamic = [], resources = [], problems = [];
  const visit = node => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isTypeParameterDeclaration(node)) return;
    if (ts.isHeritageClause(node)) {
      if (node.token === S.ExtendsKeyword) for (const type of node.types) visit(type.expression);
      return;
    }
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node)) {
      names.add(node.text);
      if (['eval', 'require'].includes(node.text)) problems.push(`uses ${node.text}`);
      return;
    }
    if (ts.isMetaProperty(node)) {
      if (node.keywordToken === S.ImportKeyword && !allowedMeta(node)) problems.push(`uses ${node.parent.getText()}`);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) { visit(node.expression); return; }
    if ((ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node))
      && !ts.isComputedPropertyName(node.name)) {
      ts.forEachChild(node, child => { if (child !== node.name) visit(child); });
      return;
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') problems.push('uses Function()');
    if (ts.isCallExpression(node) && node.expression.kind === S.ImportKeyword) {
      const [argument] = node.arguments;
      let requested = [ALL];
      const declaration = ts.isAwaitExpression(node.parent) && ts.isVariableDeclaration(node.parent.parent) && node.parent.parent.initializer === node.parent ? node.parent.parent : null;
      if (declaration && ts.isObjectBindingPattern(declaration.name)
        && declaration.name.elements.every(element => !element.dotDotDotToken && (!element.propertyName || ts.isIdentifier(element.propertyName)))) {
        requested = declaration.name.elements.map(element => (element.propertyName ?? element.name).text);
      }
      if (argument && ts.isStringLiteralLike(argument)) dynamic.push({ specifier: argument.text, names: requested });
      else if (argument && urlResource(argument) && ts.isStringLiteralLike(argument.arguments[0])) {
        const path = argument.arguments[0].text;
        dynamic.push({ specifier: path.startsWith('.') ? path : `./${path}`, names: requested });
        return;
      } else problems.push(`computed dynamic import ${node.getText()}`);
    }
    if (urlResource(node)) {
      const [path] = node.arguments;
      resources.push({ literal: ts.isStringLiteralLike(path) ? path.text : null, text: node.getText() });
    }
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return { names, dynamic, resources, problems };
}

const relativeTarget = (from, specifier) => (specifier.startsWith('./') || specifier.startsWith('../')
  ? posix.normalize(posix.join(posix.dirname(from), specifier)) : null);

/**
 * Slice of one process.
 *  - `entries`: `{ file, names?, program? }`. The module is loaded and `names` requested;
 *    `program` marks the process entry (its CLI main guard is live; elsewhere it is false).
 *  - `boundaries`: file → unit. Reaching one records the requested exports (`<load>` for a
 *    load) instead of following it; the unit is fingerprinted separately.
 *  - `contained`: modules whose own runtime imports are not followed and whose effects are not
 *    included (their content is fingerprinted elsewhere and their load-time behaviour checked
 *    elsewhere). Included code of theirs that reaches one of those imports throws, unless
 *    `followContained`: then the binding is taken from the target, which is contained in turn
 *    (dynamic imports still throw). With it, an effect of a contained module that can reach,
 *    through that module's own declarations, a binding included code reads is included too.
 *  - `stop`: file → names left out (their effect on a scenario is fingerprinted per scenario).
 *  - `resources`: file → files (or a function giving them) a computed `new URL(…, import.meta.url)` there may name.
 * Returns the included files (statements in source order, used import bindings, requested
 * export mappings, externals), boundary requests and `new URL` resources. `read(file)` gives
 * bytes or null.
 */
export function sliceProgram({ read, entries, boundaries = {}, contained = [], stop = {}, resources = {}, followContained = false }) {
  const modules = new Map(), included = new Map(), requested = new Map(), externals = new Map();
  const boundaryRequests = new Map(), foundResources = new Map(), programs = new Set(entries.filter(item => item.program).map(item => item.file));
  const queue = [];
  const fail = (file, message) => { throw new Error(`g3-slice: ${file}: ${message}`); };
  // Reached only through a contained module's import (followContained): contained until something loads it.
  const reachedContained = new Set();
  const isContained = file => contained.includes(file) || reachedContained.has(file);
  const moduleOf = file => {
    if (!modules.has(file)) {
      const bytes = read(file);
      modules.set(file, bytes === null ? { file, missing: true } : !CODE.test(file) ? { file, whole: 'not code' } : parseModule(file, bytes.toString('utf8')));
    }
    return modules.get(file);
  };
  const add = (map, file, value) => { if (!map.has(file)) map.set(file, new Set()); map.get(file).add(value); };
  const load = (file, fromContained = false) => {
    if (Object.hasOwn(boundaries, file)) { add(boundaryRequests, file, '<load>'); return; }
    if (included.has(file)) {
      if (fromContained || !reachedContained.has(file)) return;
      reachedContained.delete(file);
    } else {
      included.set(file, new Set());
      requested.set(file, new Set());
      if (fromContained) { reachedContained.add(file); return; }
    }
    const module = moduleOf(file);
    if (module.missing || module.whole || isContained(file)) return;
    const stopped = new Set(stop[file] ?? []);
    for (const statement of module.statements) {
      if (statement.kind !== 'effect' || statement.names.some(name => stopped.has(name))) continue;
      if (statement.mainGuard && !programs.has(file)) continue;
      queue.push([file, statement.index]);
    }
    for (const specifier of module.loads) {
      const target = relativeTarget(file, specifier);
      if (target) load(target);
    }
  };
  const request = (file, name, fromContained = false) => {
    if (Object.hasOwn(boundaries, file)) { add(boundaryRequests, file, name); return; }
    load(file, fromContained);
    const module = moduleOf(file);
    if (module.missing || module.whole || requested.get(file).has(name)) return;
    requested.get(file).add(name);
    if (name === ALL) {
      for (const exported of module.exports.keys()) request(file, exported, isContained(file));
      for (const specifier of module.stars) follow(file, specifier, ALL);
      return;
    }
    const exported = module.exports.get(name);
    if (exported?.local !== undefined) useName(file, exported.local);
    else if (exported) follow(file, exported.specifier, exported.name);
    else for (const specifier of module.stars) follow(file, specifier, name);
  };
  const follow = (file, specifier, name) => {
    const target = relativeTarget(file, specifier);
    if (!target) { add(externals, file, `${specifier}#${name}`); return; }
    if (isContained(file) && !followContained) fail(file, `included code uses ${name} of ${specifier}, which is not followed from this module`);
    request(target, name, isContained(file));
  };
  const useName = (file, name) => {
    if ((stop[file] ?? []).includes(name)) return;
    const module = moduleOf(file);
    for (const index of module.locals.get(name) ?? []) queue.push([file, index]);
    const binding = module.imports.get(name);
    if (binding) follow(file, binding.specifier, binding.name);
  };
  for (const entry of entries) {
    load(entry.file);
    for (const name of entry.names ?? []) request(entry.file, name);
  }
  const referenced = new Map();
  const referencesOf = (file, index) => {
    const key = `${file}\n${index}`;
    if (!referenced.has(key)) referenced.set(key, references(moduleOf(file).statements[index].node));
    return referenced.get(key);
  };
  const drain = () => {
    while (queue.length) {
      const [file, index] = queue.shift();
      if (included.get(file).has(index)) continue;
      included.get(file).add(index);
      const module = moduleOf(file);
      const { names, dynamic, resources: urls, problems } = referencesOf(file, index);
      if (problems.length) fail(file, problems.join('; '));
      for (const name of names) if (module.locals.has(name) || module.imports.has(name)) useName(file, name);
      for (const item of dynamic) {
        const target = relativeTarget(file, item.specifier);
        for (const name of item.names) {
          if (!target) add(externals, file, `${item.specifier}#${name}`);
          else if (isContained(file)) fail(file, `included code imports ${item.specifier}, which is not followed from this module`);
          else request(target, name);
        }
      }
      for (const item of urls) {
        const declared = resources[file];
        const targets = item.literal !== null ? [posix.normalize(posix.join(posix.dirname(file), item.literal))] : typeof declared === 'function' ? declared() : declared;
        if (!targets) fail(file, `computed resource ${item.text} without a declared file list`);
        for (const target of targets) foundResources.set(target, file);
      }
    }
  };
  drain();
  // The names a top-level statement can read: its own references and, transitively, those of the module's declarations it names.
  const reach = (file, index) => {
    const module = moduleOf(file), seen = new Set(), pending = [index];
    while (pending.length) {
      for (const name of referencesOf(file, pending.pop()).names) {
        if (seen.has(name)) continue;
        seen.add(name);
        pending.push(...(module.locals.get(name) ?? []));
      }
    }
    return seen;
  };
  for (let grown = followContained; grown;) {
    grown = false;
    for (const [file, indexes] of included) {
      const module = moduleOf(file);
      if (!isContained(file) || module.missing || module.whole) continue;
      const bound = new Set([...indexes].flatMap(index => module.statements[index].names ?? []));
      const stopped = new Set(stop[file] ?? []);
      for (const statement of module.statements) {
        if (statement.kind !== 'effect' || indexes.has(statement.index) || statement.names.some(name => stopped.has(name))) continue;
        if ([...reach(file, statement.index)].some(name => bound.has(name))) { queue.push([file, statement.index]); grown = true; }
      }
    }
    drain();
  }
  // An import stays in the slice when its target runs code here (or cannot be analysed) or provides a used binding.
  const runs = new Map();
  const runsCode = file => {
    if (Object.hasOwn(boundaries, file)) return true;
    if (runs.has(file)) return runs.get(file);
    runs.set(file, false);
    const module = moduleOf(file);
    let value = Boolean(module.missing || module.whole || isContained(file)) || module.statements.some(item => item.kind === 'effect' && included.get(file)?.has(item.index));
    if (!value) value = module.loads.some(specifier => { const target = relativeTarget(file, specifier); return target ? runsCode(target) : false; });
    runs.set(file, value);
    return value;
  };
  const files = [];
  for (const file of [...included.keys()].sort(byName)) {
    const module = moduleOf(file);
    if (module.missing) { files.push({ file, missing: true }); continue; }
    if (module.whole) { files.push({ file, whole: module.whole, sha256: sha256(read(file)) }); continue; }
    const used = new Map();
    for (const index of included.get(file)) for (const name of referencesOf(file, index).names) {
      const binding = module.imports.get(name);
      if (binding) add(used, binding.specifier, `${name}=${binding.name}`);
    }
    const imports = module.loads.filter(specifier => {
      const target = relativeTarget(file, specifier);
      return used.has(specifier) || (!isContained(file) && target ? runsCode(target) : false);
    }).map(specifier => ({ specifier, bindings: [...(used.get(specifier) ?? [])].sort(byName) }));
    const exports = [...requested.get(file)].filter(name => name !== ALL).sort(byName).map(name => {
      const exported = module.exports.get(name);
      return [name, exported ? (exported.local !== undefined ? exported.local : `${exported.specifier}#${exported.name}`) : `*${module.stars.join(',')}`];
    });
    const statements = [...included.get(file)].sort((a, b) => a - b).map(index => module.statements[index].text);
    if (!statements.length && !imports.length && !externals.has(file)) continue;
    files.push({ file, statements, imports, exports, externals: [...(externals.get(file) ?? [])].sort(byName) });
  }
  return {
    files,
    boundaries: Object.fromEntries([...boundaryRequests].sort(([a], [b]) => byName(a, b)).map(([file, names]) => [file, [...names].sort(byName)])),
    resources: [...foundResources.keys()].sort(byName),
  };
}

/**
 * Evaluates `names` of one JavaScript module from its slice alone: the tree's own code, read
 * through `read` (e.g. from a git commit), run as a strict function. Only `node:` imports may
 * be reached, and not `import.meta`. Returns the requested values a module exports.
 */
export function evaluateSlice(read, file, names) {
  if (!/\.m?js$/.test(file)) throw new Error(`g3-slice: evaluateSlice runs JavaScript only (${file})`);
  const slice = sliceProgram({ read, entries: [{ file, names }], contained: [file] });
  const entry = slice.files.find(item => item.file === file);
  if (!entry || entry.missing) return {};
  if (entry.whole) throw new Error(`g3-slice: ${file}: ${entry.whole}`);
  const module = parseModule(file, read(file).toString('utf8'));
  const kept = new Set(entry.statements);
  const body = module.statements.filter(item => kept.has(item.text)).map(item => {
    const exported = modifiers(item.node).filter(mod => [S.ExportKeyword, S.DefaultKeyword].includes(mod.kind));
    if (exported.some(mod => mod.kind === S.DefaultKeyword) || item.kind === 'export-names') throw new Error(`g3-slice: evaluateSlice ${file}: default exports are not supported`);
    return exported.length ? item.text.slice(exported.at(-1).end - item.node.getStart()).trimStart() : item.text;
  });
  if (body.some(text => /\bimport\.meta\b/.test(text))) throw new Error(`g3-slice: evaluateSlice ${file}: the slice reads import.meta`);
  const requires = entry.imports.flatMap(({ specifier, bindings }) => {
    if (!specifier.startsWith('node:')) throw new Error(`g3-slice: evaluateSlice ${file} reaches ${specifier}`);
    return bindings.map(item => {
      const [local, name] = item.split('=');
      return [ALL, 'default'].includes(name) ? `const ${local} = require(${JSON.stringify(specifier)});`
        : `const { ${name}: ${local} } = require(${JSON.stringify(specifier)});`;
    });
  });
  const values = entry.exports.filter(([name, local]) => names.includes(name) && /^[A-Za-z_$][\w$]*$/.test(local));
  const source = ['(function (require) {', "'use strict';", ...requires, ...body,
    `return { ${values.map(([name, local]) => `${JSON.stringify(name)}: ${local}`).join(', ')} };`, '})'].join('\n');
  return runInThisContext(source, { filename: `g3-slice:${file}` })(require);
}

/** The tokens of the one array literal in `file` that holds the string `literal` (a command line built there), space-joined; throws unless exactly one. */
export function arrayText(read, file, literal) {
  const bytes = read(file);
  if (!bytes) throw new Error(`g3-slice: ${file} is missing (looking for the array holding ${literal})`);
  const source = ts.createSourceFile(file, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, /\.[mc]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const found = [];
  const visit = node => {
    if (ts.isArrayLiteralExpression(node) && node.elements.some(item => ts.isStringLiteralLike(item) && item.text === literal)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found.length !== 1) throw new Error(`g3-slice: ${file} has ${found.length} arrays holding ${literal}, expected 1`);
  const tokens = [];
  const leaves = node => {
    const children = node.getChildren(source);
    if (children.length) children.forEach(leaves); else if (node.kind !== S.EndOfFileToken) tokens.push(node.getText(source));
  };
  leaves(found[0]);
  return tokens.filter(Boolean).join(' ');
}

/** Per-file digests of a slice (what `code:<file>` stale reasons compare). */
export function sliceFiles(slice) {
  return Object.fromEntries(slice.files.map(entry => [entry.file, entry.missing ? null : sha256(JSON.stringify(entry))]));
}

/** Top-level bindings of `file` left out of `slice` (free to change without touching the slice). */
export function excludedBindings(slice, read, file) {
  const bytes = read(file);
  if (!bytes) return [];
  const module = parseModule(file, bytes.toString('utf8'));
  if (module.whole) return [];
  const kept = new Set(slice.files.find(item => item.file === file)?.statements ?? []);
  return module.statements.filter(item => ['declaration', 'effect'].includes(item.kind) && !kept.has(item.text))
    .flatMap(item => item.names.filter(name => name !== DEFAULT_LOCAL)).sort(byName);
}

/** The string literals of a top-level `const NAME = ['…', …]` in `file` (declared resource lists); throws if it is not that. */
export function literalStrings(read, file, name) {
  const bytes = read(file);
  if (!bytes) throw new Error(`g3-slice: ${file} is missing (looking for ${name})`);
  const source = ts.createSourceFile(file, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, /\.[mc]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      let value = declaration.initializer;
      while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
      if (value && ts.isArrayLiteralExpression(value) && value.elements.every(ts.isStringLiteralLike)) return value.elements.map(item => item.text);
      throw new Error(`g3-slice: ${file} ${name} is not an array of string literals`);
    }
  }
  throw new Error(`g3-slice: ${file} has no top-level ${name}`);
}
