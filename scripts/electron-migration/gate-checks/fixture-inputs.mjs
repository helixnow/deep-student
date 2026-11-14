import fs from 'node:fs';
import path from 'node:path';
import { production, ts, walk } from './common.mjs';

// Recognize one launch-input expression, not a class of helper modules/functions.
// The result must be consumed *only* as command/env for a statically local test
// script. An assertion, alias/escape, extra property read, or nonliteral script
// keeps the original subject attribution. In particular f(dead()) is not evidence
// that dead is a fixture. This does not change the production reachability graph.
export function fixtureInputUses(g, sf, symbols) {
  const nodes = new Map(), references = new Map();
  const symbol = n => ts.isShorthandPropertyAssignment(n.parent)
    ? g.checker.getShorthandAssignmentValueSymbol(n.parent) : g.checker.getSymbolAtLocation(n);
  walk(sf, n => {
    if (!ts.isIdentifier(n)) return;
    nodes.set(n.getStart(sf), n);
    const s = symbol(n);
    if (s) { if (!references.has(s)) references.set(s, []); references.get(s).push(n); }
  });
  const constant = n => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)
    && ts.isVariableDeclarationList(n.parent) && !!(n.parent.flags & ts.NodeFlags.Const);
  const property = (object, name) => object.properties.find(p => ts.isPropertyAssignment(p)
    && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name)?.initializer;
  function localScript(expr) {
    if (ts.isIdentifier(expr)) {
      const d = symbol(expr)?.valueDeclaration;
      if (!d || !constant(d) || !d.initializer) return null;
      expr = d.initializer;
    }
    if (!ts.isCallExpression(expr) || expr.arguments.length !== 1 || !ts.isIdentifier(expr.expression)) return null;
    const binding = symbol(expr.expression)?.declarations?.[0];
    if (!binding || !ts.isImportSpecifier(binding) || (binding.propertyName ?? binding.name).text !== 'fileURLToPath'
      || binding.parent.parent.parent.moduleSpecifier.text !== 'node:url') return null;
    const url = expr.arguments[0];
    if (!ts.isNewExpression(url) || !ts.isIdentifier(url.expression) || url.expression.text !== 'URL'
      || symbol(url.expression) || url.arguments?.length !== 2) return null;
    const [relative, base] = url.arguments;
    if (!ts.isStringLiteral(relative) || !/^\.\.?\//.test(relative.text)
      || !ts.isPropertyAccessExpression(base) || base.name.text !== 'url'
      || !ts.isMetaProperty(base.expression) || base.expression.keywordToken !== ts.SyntaxKind.ImportKeyword) return null;
    const file = path.resolve(path.dirname(sf.fileName), relative.text);
    // This is the launched resource, not an exemption for symbols in tests/.
    if (!/\.[cm]?[jt]s$/.test(file) || production(file) || !fs.existsSync(file)) return null;
    return file;
  }
  const out = new Map();
  for (const s of symbols) for (const pos of s.uses) {
    const use = nodes.get(pos), call = use?.parent, declaration = call?.parent;
    if (!call || !ts.isCallExpression(call) || call.expression !== use || call.arguments.length
      || !declaration || !constant(declaration) || declaration.initializer !== call) continue;
    const refs = (references.get(symbol(declaration.name)) ?? []).filter(n => n !== declaration.name);
    if (refs.length !== 2) continue;
    let object = null;
    const fields = new Set();
    for (const ref of refs) {
      const access = ref.parent, assignment = access.parent;
      if (!ts.isPropertyAccessExpression(access) || access.expression !== ref
        || !['command', 'env'].includes(access.name.text) || !ts.isPropertyAssignment(assignment)
        || assignment.initializer !== access || assignment.name.getText(sf) !== access.name.text
        || !ts.isObjectLiteralExpression(assignment.parent) || object && object !== assignment.parent) break;
      object = assignment.parent;
      fields.add(access.name.text);
    }
    if (!object || fields.size !== 2 || object.properties.some(p => !ts.isPropertyAssignment(p))) continue;
    const names = object.properties.map(p => p.name.getText(sf));
    if (new Set(names).size !== names.length) continue;
    const type = property(object, 'type'), args = property(object, 'args'), consumer = object.parent;
    if (!type || !ts.isStringLiteral(type) || type.text !== 'stdio' || !args
      || !ts.isArrayLiteralExpression(args) || args.elements.length !== 1
      || !(ts.isCallExpression(consumer) || ts.isNewExpression(consumer)) || !consumer.arguments?.includes(object)) continue;
    const result = ts.isAwaitExpression(consumer.parent) ? consumer.parent : consumer;
    if (!constant(result.parent) || result.parent.initializer !== result
      || !g.checker.getResolvedSignature(consumer)?.declaration?.body) continue;
    const script = localScript(args.elements[0]);
    if (script) out.set(pos, { script, reason: 'result used only as command/env in a stdio descriptor for a statically local test script' });
  }
  return out;
}
