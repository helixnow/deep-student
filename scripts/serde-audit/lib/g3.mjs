// Aggregates serde-class findings over a G3 DIFF-TRIAGE document.
import { databasePairs } from '../g3-goldens.mjs';
import { classifyJsonText, classifyOutcome, SERDE_TAGS } from './classify.mjs';

const dbName = (db) => String(db ?? '').split('/').pop();
/** `/a/0/b` and `$.a[0].b` → `$.a[].b` (array indices and id-like keys collapsed). */
export const normalizePath = (path) => String(path)
  .replace(/\[\d+\]/g, '[]')
  .replace(/\.\d+(?=\.|$)/g, '[]')
  .replace(/\.(?:sess|msg|blk|res|note|card|q|tag|grp|ws)_[\w-]+/g, '.<id>');

/**
 * @returns {{columns: Map<string, Site>, commands: Map<string, Site>}}
 * Site = {key, kind:'db'|'ipc', db?, table?, column?, command?, occurrences, groups:Set, findings: Map<tag+path, Finding>, scenarios:Set}
 */
export function aggregateTriage(triage) {
  const columns = new Map();
  const commands = new Map();
  const add = (map, key, base, group, evidence, result) => {
    const serde = result.findings.filter((f) => SERDE_TAGS.includes(f.tag));
    if (serde.length === 0) return;
    let site = map.get(key);
    if (!site) map.set(key, site = { key, ...base, occurrences: 0, groups: new Set(), findings: new Map(), scenarios: new Set(), commands: new Set() });
    if (!site.groups.has(group.key)) { site.groups.add(group.key); site.occurrences += Number(group.occurrences ?? 1); }
    if (evidence?.scenario?.id) site.scenarios.add(evidence.scenario.id);
    if (evidence?.command) site.commands.add(evidence.command);
    for (const f of serde) {
      const fk = `${f.tag}|${normalizePath(f.path)}|${f.direction ?? ''}`;
      const prev = site.findings.get(fk);
      if (prev) prev.count++;
      else site.findings.set(fk, { ...f, path: normalizePath(f.path), count: 1 });
    }
  };

  for (const { group, row, evidence } of databasePairs(triage)) {
    if (row.kind !== 'value' || row.before?.storageClass !== 'text' || row.after?.storageClass !== 'text') continue;
    const result = classifyJsonText(row.before.value, row.after.value);
    if (!result) continue;
    const db = dbName(row.db);
    add(columns, `${db}:${row.table}.${row.column}`, { kind: 'db', db, table: row.table, column: row.column }, group, evidence, result);
  }
  for (const group of triage.groups ?? []) {
    const d = group.evidence?.difference;
    if (!d || !['outcome', 'events', 'args'].includes(d.kind) || !d.difference) continue;
    if (d.kind === 'args') continue;
    const result = classifyOutcome(d.difference);
    const command = d.command ?? group.evidence?.command ?? '?';
    add(commands, `${d.kind}:${command}`, { kind: 'ipc', channel: d.kind, command }, group, group.evidence, result);
  }
  return { columns, commands };
}

/** Plain-JSON form for the report generator / snapshot tests. */
export function siteSummary(site) {
  return {
    key: site.key, kind: site.kind, occurrences: site.occurrences, groups: site.groups.size,
    scenarios: [...site.scenarios].sort().slice(0, 3),
    findings: [...site.findings.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
  };
}
