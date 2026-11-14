/**
 * `read_state`（data_space.rs:1289-1356）用 `fs::read_to_string`：内容不是合法 UTF-8 时读取失败
 * （`stream did not contain valid UTF-8`），按损坏处理，依次回退到 state.json.tmp 与目录推断。
 * 有损解码会把 `"slotB\xff"` 读成 `slotB\uFFFD` 并当作有效状态返回。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DataSpace } from '../locations.ts';

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-slot-state-decode-'));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function seedSlots(space: DataSpace): void {
  for (const slot of ['slotA', 'slotB'] as const) {
    fs.mkdirSync(space.slotDir(slot), { recursive: true });
    fs.writeFileSync(path.join(space.slotDir(slot), 'mistakes.db'), slot);
  }
  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(space.slotDir('slotA'), 'mistakes.db'), past, past);
}

const invalidUtf8State = (active: string) => Buffer.concat([
  Buffer.from(`{\n  "active": "${active}",\n  "pending": "slotB`), Buffer.from([0xff]), Buffer.from('"\n}'),
]);

it('state.json that is not valid UTF-8 is corrupt: recovered from state.json.tmp like Rust', () => {
  const space = new DataSpace(base);
  seedSlots(space);
  fs.writeFileSync(space.statePath, invalidUtf8State('slotA'));
  fs.writeFileSync(path.join(space.slotsDir, 'state.json.tmp'), JSON.stringify({ active: 'slotA', pending: null }));
  expect(space.readState()).toEqual({ active: 'slotA', pending: null });
  expect(JSON.parse(fs.readFileSync(space.statePath, 'utf8'))).toEqual({ active: 'slotA', pending: null });
  expect(fs.existsSync(path.join(space.slotsDir, 'state.json.tmp'))).toBe(false);
});

it('state.json and state.json.tmp that are not valid UTF-8 fall through to directory inference like Rust', () => {
  const space = new DataSpace(base);
  seedSlots(space);
  fs.writeFileSync(space.statePath, invalidUtf8State('slotA'));
  fs.writeFileSync(path.join(space.slotsDir, 'state.json.tmp'), invalidUtf8State('slotA'));
  // slotB 的条目更新，推断为 slotB 并写回（Rust infer_active_slot_from_dirs + write_state）。
  expect(space.readState()).toEqual({ active: 'slotB', pending: null });
  expect(JSON.parse(fs.readFileSync(space.statePath, 'utf8'))).toEqual({ active: 'slotB', pending: null });
});
