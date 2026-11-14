import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DataSpace, resolveLocations } from '../locations.ts';
import { DataSpaceStartup } from '../startup.ts';

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-slot-unreadable-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

/** slotA active with a pending switch and a restore lease; slotB holds newer data, so mtime inference would pick it. */
function seed(): { space: DataSpace; original: string } {
  const space = new DataSpace(base);
  fs.mkdirSync(space.slotDir('slotA'), { recursive: true });
  fs.writeFileSync(path.join(space.slotDir('slotA'), 'mistakes.db'), 'a');
  fs.mkdirSync(space.slotDir('slotB'), { recursive: true });
  fs.writeFileSync(path.join(space.slotDir('slotB'), 'mistakes.db'), 'b');
  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(space.slotDir('slotA'), 'mistakes.db'), past, past);
  space.writeState({
    active: 'slotA',
    pending: 'slotB',
    restore_cutover_pending: { target_slot: 'slotB', backup_id: 'bk-1', created_at: '2026-11-07T00:00:00Z', activation_committed: false },
  });
  return { space, original: fs.readFileSync(space.statePath, 'utf8') };
}

function failReadsOf(file: string, code: string): void {
  const real = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (target === file) throw Object.assign(new Error(`${code}: resource busy or locked, open '${file}'`), { code });
    return (real as (p: fs.PathOrFileDescriptor, o?: unknown) => unknown)(target, options);
  }) as typeof fs.readFileSync);
}

it('RF-W07-slot-state-unreadable-no-infer: a transiently unreadable state.json is an error, never an mtime guess written over it', () => {
  const { space, original } = seed();
  // Rust data_space.rs:1308-1352 falls through to infer_active_slot_from_dirs(), which picks the newer slotB and
  // persists { active: slotB, pending: null }, silently switching data spaces and dropping the restore lease.
  failReadsOf(space.statePath, 'EBUSY');
  expect(() => space.readState()).toThrow(/state\.json.*EBUSY/);
  expect(() => space.activeSlot()).toThrow(/EBUSY/);
  expect(() => resolveLocations(base)).toThrow(/EBUSY/);
  vi.restoreAllMocks();
  expect(fs.readFileSync(space.statePath, 'utf8')).toBe(original);
  expect(space.readState()).toEqual({
    active: 'slotA',
    pending: 'slotB',
    restore_cutover_pending: { target_slot: 'slotB', backup_id: 'bk-1', created_at: '2026-11-07T00:00:00Z', activation_committed: false },
  });
});

it('RF-W07-slot-state-unreadable-no-infer: startup keeps business databases closed and reports data_space_init instead of switching slots', async () => {
  const { space, original } = seed();
  failReadsOf(space.statePath, 'EACCES');
  const startup = new DataSpaceStartup(base, { recover: async () => {} } as never);
  await startup.start();
  vi.restoreAllMocks();
  expect(startup.initialized).toBe(false);
  expect(() => startup.assertReady()).toThrow();
  expect(fs.readFileSync(space.statePath, 'utf8')).toBe(original);
});

it('RF-W07-slot-state-unreadable-no-infer: missing or corrupt state.json still recovers by inference like Rust', () => {
  const { space } = seed();
  fs.writeFileSync(space.statePath, '{not json');
  expect(space.readState().active).toBe('slotB');
  fs.rmSync(space.statePath);
  expect(space.readState().active).toBe('slotB');
  fs.rmSync(space.statePath);
  fs.mkdirSync(space.statePath);
  expect(space.readState().active).toBe('slotB');
});
