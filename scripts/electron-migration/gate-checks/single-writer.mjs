import { ROOT, cli, files, pluginOf, production, read, report, selected, source, ts, walk, location } from './common.mjs';
import { sqlTables } from './sql.mjs';

const EXECUTORS = new Set(['run', 'exec', 'prepare', 'get', 'all', 'iterate', 'query']);

/**
 * `executed`: the literal is a direct argument of an executor call (`db.run("...")`).
 * `sql-text`: SQL text elsewhere (a constant, a builder fragment). Usually executed via a
 * variable, but this checker does not trace data flow, so it is labelled separately.
 */
function context(n) {
  const p = n.parent;
  if (p && ts.isCallExpression(p) && p.arguments.includes(n) && ts.isPropertyAccessExpression(p.expression) && EXECUTORS.has(p.expression.name.text)) return 'executed';
  return 'sql-text';
}

export function writesIn(file, text) {
  const sf = source(file, text), writes = [];
  walk(sf, n => {
    let sql;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) sql = n.text;
    else if (ts.isTemplateExpression(n)) sql = n.head.text + n.templateSpans.map(s => ` __dynamic__ ${s.literal.text}`).join('');
    if (sql === undefined) return;
    for (const hit of sqlTables(sql)) if (hit.table !== '__dynamic__') writes.push({ ...location(n), ...hit, context: context(n) });
  });
  return writes;
}
export function run(opts) {
  const registry = JSON.parse(read(ROOT, 'scripts/electron-migration/gate-checks/table-owners.json'));
  const all = files(opts.root, 'host/plugins').filter(production).flatMap(file => writesIn(file, read(opts.root, file)).map(w => ({ ...w, plugin: pluginOf(file) })));
  const findings = [], unknown = [];
  // A namespace is either one exact file (APKG export DB) or one plugin's own database.
  const namespaced = w => registry.namespaces?.find(n => n.tables.includes(w.table) && (n.file ? n.file === w.file : n.plugin === w.plugin));
  for (const w of all.filter(w => selected(opts, w.file))) {
    const ns = namespaced(w), entry = registry.tables[w.table];
    const owner = ns?.owner ?? entry?.owner;
    if (!owner) { unknown.push(w); continue; }
    if (owner === w.plugin) continue;
    // Blocking tier (C1 2026-11-04T12:14Z): owner fixed by an explicit ruling (D1/C1/C2 decision
    // or exact namespace) AND the SQL literal is passed directly to an executor. Derived owners
    // and plain SQL text stay report-only.
    const explicit = Boolean(ns || entry?.decision);
    const blocking = explicit && w.context === 'executed';
    findings.push({ ...w, rule: 'foreign-table-write', owner, ownerBasis: ns ? 'namespace' : explicit ? entry.decision : 'derived', ...(blocking ? {} : { severity: 'info' }),
      message: `${w.operation} ${w.table} (${w.context}, owner ${explicit ? 'ruled' : 'derived'}): owner=${owner}, writer=${w.plugin}${blocking ? '' : ' [report-only]'}` });
  }
  const byTable = Map.groupBy(all.filter(w => w.file.includes('/repository/') && !namespaced(w)), w => w.table);
  for (const [table, rows] of byTable) {
    const plugins = [...new Set(rows.map(w => w.plugin))];
    if (plugins.length < 2) continue;
    for (const plugin of plugins) {
      const w = rows.find(w => w.plugin === plugin && selected(opts, w.file));
      if (w) findings.push({ ...w, rule: 'duplicate-repository', severity: 'info', message: `${table} has repository writers in ${plugins.join(', ')}`, writers: plugins });
    }
  }
  const byContext = {}, tiers = { blocking: 0, reportOnly: 0 };
  for (const f of findings.filter(f => f.rule === 'foreign-table-write')) {
    byContext[f.context] = (byContext[f.context] ?? 0) + 1;
    tiers[f.severity === 'info' ? 'reportOnly' : 'blocking']++;
  }
  return report('single-writer', findings, { byContext, tiers, unknown, ambiguous: registry.ambiguous, limits: [
    'Matches SQL text in TS string/template literals; dynamic table names (${...}) are skipped, not guessed.',
    'Same table name in a separate database (e.g. APKG collection.anki2) is only exempt via an exact file+table namespace entry in table-owners.json.',
    'Production directory scope only: a writer in a production path used solely by tests is still reported (path violation), reachability is not judged here.',
  ] });
}
await cli(import.meta.url, run);
