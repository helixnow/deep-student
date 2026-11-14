import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { snapshot, databaseChanges } from './database.mjs';
import { firstDifference, normalize } from './json.mjs';

// Factories start a real headless Rust command host / real TS kernel in a fixture copy.
// Adapter: {invoke(command,args), events:[], settle(), close()}; settle is explicit,
// not an arbitrary delay, so asynchronously emitted terminal events cannot be missed.
export async function replaySide(scenario, createHost, side) {
  const base = resolve('fixtures/differential/runs');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, `${side}-`));
  let host;
  try {
    const seed = resolve('fixtures/db', scenario.snapshot);
    if (!seed.startsWith(resolve('fixtures/db') + '/')) throw new Error('snapshot must be inside fixtures/db');
    await cp(seed, root, { recursive: true });
    for (const file of scenario.databases) {
      if (resolve(root, file).startsWith(root + '/') === false) throw new Error('database must be inside isolated snapshot');
    }
    const read = () => Object.fromEntries(scenario.databases.map(file => [file, snapshot(join(root, file), scenario.dbContracts?.[file])]));
    const before = read();
    let previous = before;
    host = await createHost({ dataDir: root, scenario });
    const calls = [];
    for (const call of scenario.calls) {
      const eventStart = host.events.length;
      let outcome;
      try { outcome = { ok: true, value: await host.invoke(call.command, call.args) }; }
      catch (error) {
        // Host transport errors must be propagated by the adapter, not translated to application errors.
        if (error instanceof Error) throw error;
        outcome = { ok: false, error };
      }
      await host.settle();
      const current = read();
      const changes = Object.fromEntries(scenario.databases.map(file => [file, databaseChanges(previous[file], current[file])]));
      calls.push({ command: call.command, outcome: normalize(outcome, call.volatile ?? []),
        events: normalize(host.events.slice(eventStart), call.eventVolatile ?? []), changes });
      previous = current;
    }
    await host.close();
    const events = normalize(host.events, scenario.eventVolatile ?? []);
    host = null;
    const after = read();
    const changes = Object.fromEntries(scenario.databases.map(file => [file, databaseChanges(before[file], after[file])]));
    return { before, calls, events, after, changes };
  } finally {
    try { if (host) await host.close(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}

export async function replay(scenario, rustFactory, tsFactory) {
  const rust = await replaySide(scenario, rustFactory, 'rust');
  const ts = await replaySide(scenario, tsFactory, 'ts');
  const difference = firstDifference(rust, ts);
  return { kind: 'command-replay', scenario: scenario.id, lane: scenario.lane,
    commands: scenario.calls.map(call => call.command), status: difference ? 'fail' : 'pass', difference, rust, ts };
}

// Compatible with ledger.mjs --golden. Pure/static/unit results cannot enter here.
export function goldenResults(reports) {
  const commands = {};
  for (const report of reports) {
    if (report.kind !== 'command-replay' || !report.reference?.buildJob || !report.reference?.rustRevision
      || !report.tsRevision || !report.rust || !report.ts || !['pass', 'fail'].includes(report.status)) {
      throw new Error('only provenance-backed, completed command replays can promote C');
    }
    for (const observation of [report.rust, report.ts]) {
      if (!Array.isArray(observation.events) || ['before', 'after', 'changes'].some(key =>
        observation[key] === null || typeof observation[key] !== 'object' || Array.isArray(observation[key]))) {
        throw new Error('missing replay evidence: before/after databases, database changes and events are required');
      }
      if (!Array.isArray(observation.calls) || observation.calls.some(call =>
        !call || typeof call.outcome?.ok !== 'boolean'
        || !Object.hasOwn(call.outcome, call.outcome.ok ? 'value' : 'error')
        || !Array.isArray(call.events) || call.changes === null
        || typeof call.changes !== 'object' || Array.isArray(call.changes))) {
        throw new Error('missing command evidence: return/error, per-call events and database changes are required');
      }
    }
    const status = firstDifference(report.rust, report.ts) ? 'fail' : 'pass';
    if (!report.commands.length || !report.rust.calls.length || !report.ts.calls.length
      || firstDifference(report.commands, report.rust.calls.map(call => call.command))
      || firstDifference(report.commands, report.ts.calls.map(call => call.command))) {
      throw new Error('command evidence must match the nonempty executed call sequence');
    }
    for (const command of report.commands) commands[command] = commands[command] === 'fail' ? 'fail' : status;
  }
  return { commands };
}
