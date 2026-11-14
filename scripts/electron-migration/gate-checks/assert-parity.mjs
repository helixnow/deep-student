import fs from 'node:fs';
import path from 'node:path';
import { cli, read, report, selected, ts, walk } from './common.mjs';
import { loadTest, matchingCases, testmaps } from './testmap.mjs';
import { rustEvidence, rustTest } from './rust-evidence.mjs';

export function expects(sf, body) {
  const helpers = new Map(), expectNames = new Set(['expect']);
  walk(sf, n => {
    if (ts.isImportSpecifier(n) && n.propertyName?.text === 'expect') expectNames.add(n.name.text);
    if (ts.isFunctionDeclaration(n) && n.name && n.body) helpers.set(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) helpers.set(n.name.text, n.initializer);
  });
  function count(node, stack = new Set()) {
    let total = 0;
    const visit = n => {
      if (n !== node && ts.isFunctionDeclaration(n)) return;
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        const plain = ts.isIdentifier(e) && expectNames.has(e.text);
        const modifier = ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && expectNames.has(e.expression.text) && ['soft', 'poll'].includes(e.name.text);
        if (plain || modifier) total++;
        if (ts.isIdentifier(e) && helpers.has(e.text) && !stack.has(e.text)) total += count(helpers.get(e.text).body, new Set([...stack, e.text]));
      }
      ts.forEachChild(n, visit);
    };
    visit(node); return total;
  }
  return count(body);
}
export async function run(opts) {
  const rows = testmaps(opts.root).filter(r => selected(opts, r.map) || selected(opts, r.testFile) || selected(opts, r.rustFile));
  const rust = new Map(), tests = new Map(), findings = [], details = [], unknown = [];
  for (const row of rows) {
    if (!rust.has(row.rustFile)) rust.set(row.rustFile, fs.existsSync(path.join(opts.root, row.rustFile)) ? await rustEvidence(read(opts.root, row.rustFile)) : []);
    const original = rustTest(rust.get(row.rustFile), row), target = loadTest(opts.root, row.testFile, tests);
    const cases = target ? matchingCases(target.cases, row.testName) : [];
    if (!original || original.parseError || !cases.length) {
      unknown.push({ ...row, reason: !original ? 'Rust function absent/ambiguous (including macro-generated tests)' : original.parseError ? 'Rust parse error' : 'TS case title absent/nonliteral' }); continue;
    }
    // Each matched TS case independently retains the Rust assertions. Summing unrelated
    // cases in one file would hide weaker parameterized/cfg variants.
    for (const c of cases) {
      const count = expects(target.sf, c.body.body);
      const detail = { id: row.id, plugin: row.plugin, file: row.testFile, line: target.sf.getLineAndCharacterOfPosition(c.node.getStart()).line + 1, test: c.title, rust: `${row.rustFile}:${original.line}`, rustAttributes: original.attributes, rustAssertions: original.assertions, rustCfgAssertions: original.cfgAssertions, rustPanics: original.panics, tsExpects: count };
      details.push(detail);
      if (count < original.assertions) {
        // A deficit fully explained by #[cfg(...)]-gated Rust assertions needs a human cfg check.
        const cfgOnly = count >= original.assertions - original.cfgAssertions;
        findings.push({ ...detail, rule: cfgOnly ? 'assertion-deficit-cfg' : 'assertion-deficit', ...(cfgOnly ? { severity: 'info' } : {}), message: `${c.title}: Rust ${original.assertions} assertions (${original.cfgAssertions} cfg-gated) > TS ${count} expects` });
      }
    }
  }
  return report('assert-parity', findings, { details, unknown, policy: 'Static assertion sites, not loop iterations or semantic equivalence. #[should_panic] adds one expected-panic assertion; panic! branches are shown separately, not counted as assertions. Same-file TS assertion helpers are expanded; imported helpers require review.' });
}
await cli(import.meta.url, run);
