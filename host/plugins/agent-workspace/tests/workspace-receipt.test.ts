import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createWorkspaceHost } from './host-support.ts';
import { parseMutationReceipt } from '../src/workspace-change-set.ts';
import { parseChangeSet } from '../src/tools/workspace-fs.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const receipt = { change_id: 'change', root_id: 'workspace', op: 'created', relative_path: 'file.txt', bytes: 0 };
// A read-write workspace may not overlap the app data dir.
const writableWorkspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'w02-receipt-'));

it('IPC receipt decoding preserves from_value field order, required/type errors, enum maps and sequence errors', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const cases: Array<[unknown, string]> = [
      [null, 'invalid type: null, expected struct MutationReceipt'],
      [{}, 'missing field `change_id`'],
      [{ before_hash: false }, 'invalid type: boolean `false`, expected a string'],
      [{ bytes: -1, change_id: true }, 'invalid number'],
      [{ change_id: true, bytes: -1 }, 'invalid type: boolean `true`, expected a string'],
      [{ ...receipt, bytes: 1.5 }, 'invalid number'],
      [{ ...receipt, bytes: 18_446_744_073_709_551_616n }, 'invalid number'],
      [{ ...receipt, bytes: '1' }, 'invalid type: string "1", expected u64'],
      [{ ...receipt, op: null }, 'invalid type: null, expected string or map'],
      [{ ...receipt, op: {} }, 'invalid value: map, expected map with a single key'],
      [{ ...receipt, op: { created: 1 } }, 'invalid type: number, expected unit'],
      [{ ...receipt, op: 'renamed' }, 'unknown variant `renamed`, expected one of `created`, `modified`, `moved`, `deleted`'],
      [[true], 'invalid type: boolean `true`, expected a string'],
      [['change'], 'invalid length 1, expected struct MutationReceipt with 9 elements'],
      [['change', 'workspace', 'created', 'file.txt', null, null, null, null, 0, 'extra'],
        'invalid length 10, expected fewer elements in array'],
    ];
    for (const [raw, detail] of cases) {
      await expect(host.invoke('chat_v2_revert_workspace_change', { sessionId: 's', receipt: raw }), detail)
        .rejects.toBe(`Invalid workspace mutation receipt: ${detail}`);
    }
  } finally { storage.dispose(); await host.dispose(); }
});

it('receipt and change-set bytes retain exact u64 values internally and reject out-of-range numbers', () => {
  for (const value of [9_007_199_254_740_993n, 18_446_744_073_709_551_615n]) {
    expect(parseMutationReceipt({ ...receipt, bytes: value }).bytes).toBe(value);
    expect(parseChangeSet({ id: 'set', changes: [{ ...receipt, bytes: value }] }).changes[0]!.bytes).toBe(value);
  }
  expect(parseMutationReceipt({ ...receipt, bytes: Number.MAX_SAFE_INTEGER }).bytes).toBe(Number.MAX_SAFE_INTEGER);
  // Match the decimal value the frontend JSON transport sends, without binary integer conversion.
  expect(parseMutationReceipt({ ...receipt, bytes: 10_000_000_000_000_002_000 }).bytes).toBe(10_000_000_000_000_002_000n);
  for (const value of [-1n, 18_446_744_073_709_551_616n, 1e30, 0.25]) {
    expect(() => parseMutationReceipt({ ...receipt, bytes: value })).toThrow('Invalid workspace mutation receipt: invalid number');
  }
});

it('IPC rollback accepts unit enum maps and struct sequences, omits None fields and converts bigint only on the wire', async () => {
  const { host, storage } = await createWorkspaceHost();
  const root = writableWorkspace();
  try {
    await host.invoke('chat_v2_set_workspace_root', { path: root, access: 'read_write' });
    const u64 = 18_446_744_073_709_551_615n;
    const inputs: unknown[] = [
      { ...receipt, op: { created: null }, after_hash: hash('content'), before_hash: null,
        destination_path: null, backup_ref: null, ignored: true, bytes: u64 },
      ['change', 'workspace', 'created', 'file.txt', null, null, hash('content'), null, u64],
    ];
    for (const input of inputs) {
      fs.writeFileSync(path.join(root, 'file.txt'), 'content');
      const result = await host.invoke('chat_v2_revert_workspace_change', { sessionId: 's', receipt: input });
      expect(result).toEqual({ reverted: true, root_id: 'workspace', change_id: 'change', receipt: {
        ...receipt, after_hash: hash('content'), bytes: Number(u64),
      } });
      expect(fs.existsSync(path.join(root, 'file.txt'))).toBe(false);
    }
  } finally { storage.dispose(); await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('production change-set rollback accepts struct sequences and keeps serde child errors without synthetic index prefixes', async () => {
  const { host, storage } = await createWorkspaceHost();
  const root = writableWorkspace();
  try {
    await host.invoke('chat_v2_set_workspace_root', { path: root, access: 'read_write' });
    const executor = host.ctx.agentWorkspaceTools.createWorkspaceFs();
    const context = { sessionId: 's', dataDir: host.app.dataDir, settings: host.ctx.settings };
    expect(await executor.execute({ id: 'bad', name: 'workspace_change_revert', arguments: {
      change_set: { changes: [{ bytes: -1 }], id: 'set' },
    } }, context)).toMatchObject({ success: false, error: 'Invalid workspace change set: invalid number' });
    expect(await executor.execute({ id: 'bad', name: 'workspace_change_revert', arguments: {
      change_set: { changes: {}, id: 'set' },
    } }, context)).toMatchObject({ success: false, error: 'Invalid workspace change set: invalid type: map, expected a sequence' });
    fs.writeFileSync(path.join(root, 'file.txt'), 'content');
    const result = await executor.execute({ id: 'good', name: 'workspace_change_revert', arguments: {
      change_set: ['set', [['change', 'workspace', { created: null }, 'file.txt', null, null, hash('content'), null, 7]]],
    } }, context);
    expect(result.success, result.error).toBe(true);
    expect(result.output).toMatchObject({ reverted: true, change_set: { id: 'set', changes: [
      { ...receipt, after_hash: hash('content'), bytes: 7 },
    ] }, rollback_result: { complete: true, reverted_count: 1, failed_count: 0 } });
    expect(fs.existsSync(path.join(root, 'file.txt'))).toBe(false);
  } finally { storage.dispose(); await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
