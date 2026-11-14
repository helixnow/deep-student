// Differential check for the prod-reachable A veto: compare two ledger.json files (before/after)
// and a prod-reachable report. Passes only if every test whose A changed went true -> false and is
// `unreachable` in the report, no `unknown` test changed, and commands are identical.
//   node ledger-diff.mjs <before/ledger.json> <after/ledger.json> <prod-reachable.json>
import fs from 'node:fs';

const [beforeFile, afterFile, reportFile] = process.argv.slice(2);
const load = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const before = load(beforeFile), after = load(afterFile), report = load(reportFile);
const state = new Map(report.tests.map(t => [t.id, t.state]));
const A0 = new Map(before.tests.map(t => [t.id, t]));
const changed = after.tests.filter(t => A0.get(t.id)?.A !== t.A || A0.get(t.id)?.B !== t.B).map(t => ({ id: t.id, lane: t.lane, before: { A: A0.get(t.id)?.A, B: A0.get(t.id)?.B }, after: { A: t.A, B: t.B }, reach: state.get(t.id) ?? 'n/a' }));
const bad = changed.filter(c => !(c.before.A === true && c.after.A === false && c.reach === 'unreachable'));
const unreachableStillA = after.tests.filter(t => state.get(t.id) === 'unreachable' && t.A);
const cmdKey = c => `${c.lane}\u0000${c.name}`;
const C0 = new Map(before.commands.map(c => [cmdKey(c), JSON.stringify([c.A, c.B, c.C])]));
const cmdChanged = after.commands.filter(c => C0.get(cmdKey(c)) !== JSON.stringify([c.A, c.B, c.C])).map(c => `${c.lane}/${c.name}`);
const byLane = {};
for (const c of changed) byLane[c.lane] = (byLane[c.lane] ?? 0) + 1;
const out = {
  ok: bad.length === 0 && unreachableStillA.length === 0 && cmdChanged.length === 0 && before.tests.length === after.tests.length,
  tests: after.tests.length, aChanged: changed.length, byLane,
  unreachableInReport: [...state.values()].filter(s => s === 'unreachable').length,
  unreachableAlreadyNotA: [...state].filter(([id, s]) => s === 'unreachable' && A0.get(id) && !A0.get(id).A).length,
  unexpectedChanges: bad, unreachableStillA: unreachableStillA.map(t => t.id), commandsChanged: cmdChanged,
  summaryBefore: before.summary.global, summaryAfter: after.summary.global,
};
console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exitCode = 1;
