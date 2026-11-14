import { rustParser } from '../lib/tree-sitter-rust.mjs';

function attributes(node) {
  const out = [];
  for (let p = node.previousNamedSibling; p && ['attribute_item', 'line_comment', 'block_comment'].includes(p.type); p = p.previousNamedSibling) {
    if (p.type === 'attribute_item') out.unshift(p.text);
  }
  return out.join('\n');
}
const ASSERTS = ['assert', 'assert_eq', 'assert_ne', 'assert_matches'];
function cfgGated(n) {
  for (let p = n; p && p.type !== 'block'; p = p.parent) {
    for (let s = p.previousNamedSibling; s && s.type === 'attribute_item'; s = s.previousNamedSibling) if (/^#\[\s*cfg\b/.test(s.text)) return true;
  }
  return false;
}
function macros(node) {
  const counts = {};
  const visit = n => {
    if (n !== node && n.type === 'function_item') return;
    if (n.type === 'macro_invocation') {
      const name = n.childForFieldName('macro')?.text.split('::').at(-1);
      if (name) counts[name] = (counts[name] ?? 0) + 1;
      if (ASSERTS.includes(name) && cfgGated(n)) counts.__cfgAsserts = (counts.__cfgAsserts ?? 0) + 1;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(node);
  return counts;
}
export async function rustEvidence(text) {
  const parser = await rustParser(), tree = parser.parse(text), functions = [];
  const visit = (n, modules = [], inTest = false) => {
    const attrs = attributes(n);
    const testOnly = inTest || /#\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(attrs);
    if (n.type === 'function_item') {
      const name = n.childForFieldName('name')?.text;
      const counts = macros(n.childForFieldName('body') ?? n);
      const shouldPanic = /#\[should_panic\b/.test(attrs);
      functions.push({ name, qualified: [...modules, name].join('::'), line: n.startPosition.row + 1, endLine: n.endPosition.row + 1, attributes: attrs, macros: counts, assertions: ASSERTS.reduce((sum, k) => sum + (counts[k] ?? 0), 0) + (shouldPanic ? 1 : 0), cfgAssertions: counts.__cfgAsserts ?? 0, panics: counts.panic ?? 0, shouldPanic, testOnly: testOnly || /#\[(?:\w+::)*test\b/.test(attrs), parseError: n.hasError });
      return;
    }
    const next = n.type === 'mod_item' ? [...modules, n.childForFieldName('name')?.text] : modules;
    for (const c of n.namedChildren) visit(c, next, testOnly);
  };
  visit(tree.rootNode); tree.delete(); return functions;
}
export function rustTest(functions, row) {
  const qualified = row.id.split('::').slice(1).join('::');
  const exact = functions.filter(f => f.qualified === qualified);
  if (exact.length === 1) return exact[0];
  const atLine = functions.filter(f => f.name === row.rustName && f.line <= row.rustLine + 5 && f.endLine >= row.rustLine);
  if (atLine.length === 1) return atLine[0];
  const named = functions.filter(f => f.name === row.rustName);
  return named.length === 1 ? named[0] : null;
}
