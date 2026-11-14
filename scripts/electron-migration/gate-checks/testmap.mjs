import fs from 'node:fs';
import path from 'node:path';
import { files, pluginOf, read, source, ts, walk } from './common.mjs';

export function testmaps(root) {
  return files(root, 'host/plugins').filter(f => f.endsWith('/TESTMAP.md')).flatMap(file =>
    read(root, file).split('\n').flatMap((line, i) => {
      const m = line.match(/^\|\s*`([^`]+\.rs::[^`]+)`\s*\|\s*([^|]+)\|\s*L(\d+)\s*\|\s*`?(ported|merged):([^|`]+)`?\s*\|/);
      if (!m) return [];
      const parts = m[1].split('::'), target = m[5].trim().split('::');
      return [{ id: m[1], plugin: pluginOf(file), map: file, line: i + 1, rustFile: `src-tauri/${parts[0].replace(/^src-tauri\//, '')}`, rustName: parts.at(-1), rustLine: +m[3], kind: m[4], testFile: target[0], testName: target[1] ?? parts.at(-1) }];
    }));
}
export function testCases(sf) {
  const out = [];
  walk(sf, n => {
    if (!ts.isCallExpression(n)) return;
    const callee = n.expression.getText(sf);
    if (!/^(?:it|test)(?:\.|\(|$)/.test(callee)) return;
    const title = n.arguments[0];
    const body = n.arguments.find(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    if (!body || !title || !(ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) return;
    out.push({ title: title.text, body, node: n, parameterized: /\.each\b/.test(callee) });
  });
  return out;
}
// Identifier-boundary match: `test_x` must not match the title `test_x_with_variant`.
export function matchingCases(cases, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`);
  return cases.filter(c => re.test(c.title));
}
export function loadTest(root, file, cache) {
  if (!cache.has(file)) {
    if (!fs.existsSync(path.resolve(root, file))) cache.set(file, null);
    else { const sf = source(file, read(root, file)); cache.set(file, { sf, cases: testCases(sf) }); }
  }
  return cache.get(file);
}
