import fs from 'node:fs';
import path from 'node:path';
import { cli, pluginOf, report } from './common.mjs';
import { matchingCases, testCases, testmaps } from './testmap.mjs';
import { graph } from './reachability-graph.mjs';
import { fixtureInputUses } from './fixture-inputs.mjs';

export function run(opts) {
  const rows = testmaps(opts.root).filter(r => r.kind === 'ported');
  // A production/index edit can change every TESTMAP assertion in its plugin. A test
  // edit is restricted to that test; changed TESTMAP selects its own ported rows.
  const selectedRows = rows.filter(r => opts.changed === null || opts.changed.some(f =>
    f === r.testFile || f === r.map || (pluginOf(f) === r.plugin && !/(^|\/)tests?\//.test(f) && /\.ts$/.test(f))));
  if (!selectedRows.length) return report('prod-reachable', [], { unknown: [], impact: { commands: 0, portedTests: 0, unreachableTests: 0, unknownTests: 0 } });
  const g = graph(opts.root), states = new Map(), findings = [], unknown = [], results = [], fixtureInputs = [];
  const stateOf = p => { if (!states.has(p)) states.set(p, g.plugin(p)); return states.get(p); };
  // A symbol published via api.ts may be called by another plugin's production code.
  let others = null;
  const reachedElsewhere = d => {
    others ??= [...new Set(fs.readdirSync(path.join(opts.root, 'host/plugins')).filter(p => fs.existsSync(path.join(opts.root, 'host/plugins', p, 'index.ts'))))].map(stateOf);
    return others.some(s => s.reachable.has(d));
  };
  const groups = Map.groupBy(selectedRows, r => `${r.plugin}:${r.testFile}`);
  for (const group of groups.values()) {
    const { plugin, testFile } = group[0];
    const state = stateOf(plugin);
    reachedElsewhere(null);
    // Symbols of other plugins are harness (installing a real provider), not the subject;
    // the plugin's own entry module is reachable by definition.
    const symbols = g.testedSymbols(testFile).filter(s => s.file.startsWith(`host/plugins/${plugin}/`) && s.file !== `host/plugins/${plugin}/index.ts`);
    for (const s of symbols) {
      if (s.targets.some(d => state.reachable.has(d) || reachedElsewhere(d))) s.state = 'reachable';
      else if (!state.roots) { s.state = 'unknown'; s.reason = 'no resolved register/provide root'; }
      else if ([state, ...others].some(o => o.dynamic && o.loadedFiles?.has(s.file))) { s.state = 'unknown'; s.reason = 'dynamic dispatch in reachable module; not certified unreachable'; }
      else s.state = 'unreachable';
    }
    // Attribute each symbol only to the TESTMAP rows whose own test case body uses it.
    const sf = g.program.getSourceFile(path.join(opts.root, testFile));
    const cases = testCases(sf);
    const inputs = fixtureInputUses(g, sf, symbols);
    const inside = (pos, list) => list.some(c => pos >= c.node.getStart(sf) && pos < c.node.getEnd());
    const shared = symbols.filter(s => !s.uses.some(p => inside(p, cases)));
    const attributed = new Map();
    for (const row of group) {
      const own = matchingCases(cases, row.testName);
      const used = own.length ? symbols.filter(s => s.uses.some(p => inside(p, own) && !inputs.has(p))) : [];
      const fixtures = symbols.flatMap(s => s.uses.filter(p => inside(p, own) && inputs.has(p)).map(p => ({
        id: row.id, file: testFile, plugin, symbol: s.name, declaration: `${s.file}:${s.line}`,
        line: sf.getLineAndCharacterOfPosition(p).line + 1,
        script: path.relative(opts.root, inputs.get(p).script), reason: inputs.get(p).reason,
      })));
      fixtureInputs.push(...fixtures);
      let state = 'reachable', reason = null;
      if (!own.length) { state = 'unknown'; reason = 'TS case for this row not found (title absent/nonliteral)'; }
      else if (used.some(s => s.state === 'unreachable')) state = 'unreachable';
      else if (used.some(s => s.state === 'unknown')) { state = 'unknown'; reason = used.find(s => s.state === 'unknown').reason; }
      else if (shared.some(s => s.state !== 'reachable')) { state = 'unknown'; reason = 'non-reachable symbol used only in shared setup/helper; not attributed to this case'; }
      else if (!used.length && (!shared.length || fixtures.length)) { state = 'unknown'; reason = 'no statically resolved production symbol used by this case (source-lock, namespace import, or harness-only)'; }
      for (const s of used.filter(s => s.state === 'unreachable')) attributed.set(s, [...(attributed.get(s) ?? []), row.id]);
      if (state === 'unknown') unknown.push({ file: testFile, plugin, id: row.id, reason });
      results.push({ id: row.id, plugin, file: testFile, state });
    }
    for (const [s, testIds] of attributed) {
      findings.push({ file: testFile, line: 1, plugin, rule: 'production-unreachable', symbol: s.name, declaration: `${s.file}:${s.line}`, testIds, message: `${s.name} (${s.file}:${s.line}) has no register/provide call/value path from any plugin index.ts${[state, ...others].some(o => o.loadedFiles?.has(s.file)) ? '' : ' (module not imported by any production entry)'}; used by ${testIds.length} TESTMAP row(s)` });
    }
  }
  return report('prod-reachable', findings, { unknown, tests: results, fixtureInputs, impact: { commands: 0, portedTests: results.length, unreachableTests: results.filter(r => r.state === 'unreachable').length, unknownTests: results.filter(r => r.state === 'unknown').length }, policy: 'Only ported TESTMAP rows (obsolete/pending excluded). A symbol is charged only to rows whose own case body uses it, excluding proven local-script command/env input-only expressions recorded in fixtureInputs. Only statically proven disconnected symbols block. Unknown is not proof of production reachability and must not earn a new A-grade certificate. Existing command grades are not changed by this test-only proposal.' });
}
await cli(import.meta.url, run);
