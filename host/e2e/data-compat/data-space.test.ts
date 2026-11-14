import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DataSpaceStartup } from '../../platform/storage/startup.ts';
import { DATABASES, buildDatabase, buildSlot, cleanup, rawSnapshot, setTimelineMarker, snapshot, tempDir } from './__fixtures__/fixtures.ts';
import { services } from './__tests__/host.ts';

// Each case replays the full Rust SQL history for multiple slots/boots; under the shared job queue this exceeded the 30s default.
const HEAVY = 120_000;
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });
function setup() {
  const base = tempDir(); disposers.push(() => cleanup(base));
  const real = services(base); disposers.push(() => real.storage.dispose());
  return { base, ...real };
}

it('F3 persisted slotB and pending→slotA select the correct old databases without touching the inactive slot', async () => {
  const { base, secrets, storage } = setup();
  const a = buildSlot(base, 'slotA'), b = buildSlot(base, 'slotB');
  setTimelineMarker(b, 'slotB独立时间线📚');
  const beforeA = DATABASES.map(db => rawSnapshot(a, db)), beforeB = DATABASES.map(db => rawSnapshot(b, db));
  writeFileSync(join(base, 'slots/state.json'), '{"active":"slotB","pending":null}');
  const start = new DataSpaceStartup(base, secrets.publication);
  await start.start(); start.assertReady();
  expect(storage.locations.activeSlot).toBe('slotB');
  expect(storage.locations.activeDir).toBe(b);
  for (const [i, db] of DATABASES.entries()) expect(snapshot(storage.database(db), db)).toEqual(beforeB[i]);
  storage.dispose();
  start.markPendingSwitch('slotA');
  // A fresh process/service must resolve the pending target; no application restart is performed.
  const next = new DataSpaceStartup(base, secrets.publication);
  await next.start(); next.assertReady();
  const second = services(base); disposers.push(() => second.storage.dispose());
  expect(second.storage.locations.activeSlot).toBe('slotA');
  for (const [i, db] of DATABASES.entries()) {
    expect(snapshot(second.storage.database(db), db)).toEqual(beforeA[i]);
    expect(rawSnapshot(b, db), `inactive ${db}`).toEqual(beforeB[i]);
  }
  expect(next.manager.readState()).toEqual({ active: 'slotA', pending: null });
}, HEAVY);

it('F3 legacy root data is moved to slotA once, and every seeded column survives repeated startup', async () => {
  const { base, secrets } = setup();
  for (const db of DATABASES) buildDatabase(base, db);
  const before = DATABASES.map(db => rawSnapshot(base, db));
  for (let boot = 0; boot < 2; boot++) {
    const start = new DataSpaceStartup(base, secrets.publication);
    await start.start(); start.assertReady();
    const next = services(base); disposers.push(() => next.storage.dispose());
    expect(next.storage.locations.activeSlot).toBe('slotA');
    for (const [i, db] of DATABASES.entries()) expect(snapshot(next.storage.database(db), db)).toEqual(before[i]);
    expect(existsSync(join(base, 'mistakes.db'))).toBe(false);
    next.storage.dispose();
  }
}, HEAVY);

it.each(['slotC', 'slotD'] as const)('F3 existing %s is read via explicit file handles (not a production active slot)', slot => {
  const { base, storage, secrets } = setup();
  const active = buildSlot(base, slot);
  const start = new DataSpaceStartup(base, secrets.publication);
  expect(start.slotDir(slot)).toBe(active);
  // Rust active_slot() only selects A/B; C/D are diagnostic migration-test targets.
  for (const db of DATABASES) {
    const path = db === 'vfs' ? join(active, 'databases/vfs.db') : join(active, `${db}.db`);
    const handle = storage.openFile(path, { mustExist: true, profile: { readonly: true } });
    try { expect(snapshot(handle, db)).toEqual(rawSnapshot(active, db)); }
    finally { storage.close(handle); }
  }
});
