import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databasePath, dataLocalDir, DataSpace, resolveLocations, serializeSlotState } from '../locations.ts';
import { resolveOsDirs, SHELL_OS_DIRS_ENV } from '../../paths/os-dirs.ts';

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-space-'));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('data_space.rs slot state (ported tests)', () => {
  it('test_read_write_state_roundtrip', () => {
    const space = new DataSpace(base);
    space.writeState({ active: 'slotB', pending: 'slotA' });
    const back = space.readState();
    expect(back.active).toBe('slotB');
    expect(back.pending).toBe('slotA');
  });

  it('test_atomic_write_state_file_content', () => {
    const space = new DataSpace(base);
    space.writeState({ active: 'slotA', pending: null });
    const raw = fs.readFileSync(space.statePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.active).toBe('slotA');
    expect(parsed.pending).toBeNull();
    expect(fs.existsSync(path.join(space.slotsDir, 'state.json.tmp'))).toBe(false);
    // serde_json::to_string_pretty 格式，None 的 restore_cutover_pending 省略
    expect(raw).toBe('{\n  "active": "slotA",\n  "pending": null\n}');
    expect(fs.readdirSync(space.slotsDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('test_corruption_recovery_from_tmp', () => {
    const space = new DataSpace(base);
    fs.mkdirSync(space.slotsDir, { recursive: true });
    fs.writeFileSync(path.join(space.slotsDir, 'state.json.tmp'), serializeSlotState({ active: 'slotB', pending: null }));
    fs.writeFileSync(space.statePath, 'THIS IS NOT JSON!!!');
    expect(space.readState().active).toBe('slotB');
    // 恢复后回写 state.json 并清理 .tmp
    expect(JSON.parse(fs.readFileSync(space.statePath, 'utf8')).active).toBe('slotB');
    expect(fs.existsSync(path.join(space.slotsDir, 'state.json.tmp'))).toBe(false);
  });

  it('test_corruption_recovery_infer_from_dirs', () => {
    const space = new DataSpace(base);
    fs.mkdirSync(space.slotDir('slotA'), { recursive: true });
    fs.mkdirSync(space.slotDir('slotB'), { recursive: true });
    fs.writeFileSync(path.join(space.slotDir('slotB'), 'data.db'), 'content');
    expect(fs.existsSync(space.statePath)).toBe(false);
    expect(space.readState().active).toBe('slotB');
    expect(fs.existsSync(space.statePath)).toBe(true);
  });

  it('infers slotA when both slots are empty and prefers the newer slot when both have data', () => {
    const space = new DataSpace(base);
    expect(space.inferActiveSlotFromDirs().active).toBe('slotA');
    fs.mkdirSync(space.slotDir('slotA'), { recursive: true });
    fs.mkdirSync(space.slotDir('slotB'), { recursive: true });
    const a = path.join(space.slotDir('slotA'), 'a');
    const b = path.join(space.slotDir('slotB'), 'b');
    fs.writeFileSync(a, 'x');
    fs.writeFileSync(b, 'x');
    fs.utimesSync(a, 1_000, 1_000);
    fs.utimesSync(b, 2_000, 2_000);
    expect(space.inferActiveSlotFromDirs().active).toBe('slotB');
    fs.utimesSync(b, 1_000, 1_000);
    expect(space.inferActiveSlotFromDirs().active).toBe('slotA');
  });

  it('active_slot maps only "slotB" to B (anything else is A)', () => {
    const space = new DataSpace(base);
    space.writeState({ active: 'slotC', pending: null });
    expect(space.activeSlot()).toBe('slotA');
    space.writeState({ active: 'slotB', pending: null });
    expect(space.activeSlot()).toBe('slotB');
  });

  it('round-trips restore_cutover_pending with serde field order', () => {
    const space = new DataSpace(base);
    space.writeState({
      active: 'slotB',
      pending: null,
      restore_cutover_pending: { target_slot: 'slotB', backup_id: 'b1', created_at: 't', activation_committed: false },
    });
    expect(fs.readFileSync(space.statePath, 'utf8')).toBe(
      '{\n  "active": "slotB",\n  "pending": null,\n  "restore_cutover_pending": {\n    "target_slot": "slotB",\n    "backup_id": "b1",\n    "created_at": "t",\n    "activation_committed": false\n  }\n}',
    );
    expect(space.readState().restore_cutover_pending?.backup_id).toBe('b1');
  });
});

describe('database locations', () => {
  it('resolves every registered database relative to the active slot like Rust', () => {
    const space = new DataSpace(base);
    space.writeState({ active: 'slotB', pending: null });
    const loc = resolveLocations(base, { dataLocalDir: '/local' });
    const active = path.join(base, 'slots', 'slotB');
    expect(loc.activeDir).toBe(active);
    expect(databasePath(loc, 'mistakes')).toBe(path.join(active, 'mistakes.db'));
    expect(databasePath(loc, 'vfs')).toBe(path.join(active, 'databases', 'vfs.db'));
    expect(databasePath(loc, 'chat_v2')).toBe(path.join(active, 'chat_v2.db'));
    expect(databasePath(loc, 'llm_usage')).toBe(path.join(active, 'llm_usage.db'));
    expect(databasePath(loc, 'audit')).toBe(path.join(active, 'databases', 'audit.db'));
    expect(databasePath(loc, 'browser')).toBe(path.join(active, 'browser.db'));
    expect(databasePath(loc, 'sync_state')).toBe(path.join('/local', 'deep-student', 'sync', 'sync_state.db'));
  });

  it('dataLocalDir follows dirs::data_local_dir per platform', () => {
    const home = os.homedir();
    expect(dataLocalDir('darwin', {})).toBe(path.join(home, 'Library', 'Application Support'));
    expect(dataLocalDir('linux', { XDG_DATA_HOME: '/xdg' })).toBe('/xdg');
    expect(dataLocalDir('linux', { XDG_DATA_HOME: 'relative' })).toBe(path.join(home, '.local', 'share'));
    expect(dataLocalDir('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })).toBe('C:\\Users\\u\\AppData\\Local');
  });

  it('dataLocalDir is the paths service value, so the shell Known Folder reaches sync_state.db', () => {
    const shellEnv = {
      LOCALAPPDATA: 'C:\\stale\\Local',
      [SHELL_OS_DIRS_ENV]: JSON.stringify({ dataLocal: 'D:\\Profiles\\u\\AppData\\Local' }),
    };
    expect(dataLocalDir('win32', shellEnv)).toBe('D:\\Profiles\\u\\AppData\\Local');
    expect(dataLocalDir('win32', shellEnv)).toBe(resolveOsDirs('win32', shellEnv).dataLocal);
    expect(dataLocalDir('freebsd', { HOME: '/h' })).toBe(resolveOsDirs('linux', { HOME: '/h' }).dataLocal);

    const previous = process.env[SHELL_OS_DIRS_ENV];
    const shellLocal = path.join(base, 'shell-local');
    process.env[SHELL_OS_DIRS_ENV] = JSON.stringify({ dataLocal: shellLocal });
    try {
      const loc = resolveLocations(base);
      expect(loc.dataLocalDir).toBe(shellLocal);
      expect(databasePath(loc, 'sync_state')).toBe(path.join(shellLocal, 'deep-student', 'sync', 'sync_state.db'));
    } finally {
      if (previous === undefined) delete process.env[SHELL_OS_DIRS_ENV];
      else process.env[SHELL_OS_DIRS_ENV] = previous;
    }
  });
});
