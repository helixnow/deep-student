import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DataSpaceManager } from '../../../platform/storage/data-space.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l22-dataspace-'));
  dirs.push(dir);
  return dir;
}
function seedSlot(dir: string, payload: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mistakes.db'), payload);
}
function manager(base: string): DataSpaceManager {
  return new DataSpaceManager(base, { recover: async () => 'Clean' });
}
function thrown(action: () => void): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the action to throw');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const CHAOS_BACKUP_ID = 'backup-r10-chaos';

// sync_r10_chaos_lease.rs::r10_chaos_lease_pointing_at_inactive_slot_refuses_boot_and_keeps_lease
it('r10_chaos_lease_pointing_at_inactive_slot_refuses_boot_and_keeps_lease', async () => {
  const base = tempDir();
  const slots = path.join(base, 'slots');
  seedSlot(path.join(slots, 'slotA'), 'slot-a-data');
  seedSlot(path.join(slots, 'slotB'), 'slot-b-data');
  fs.writeFileSync(path.join(slots, 'state.json'), JSON.stringify({
    active: 'slotA',
    pending: null,
    restore_cutover_pending: {
      target_slot: 'slotB',
      backup_id: CHAOS_BACKUP_ID,
      created_at: '2026-07-10T12:00:00Z',
      activation_committed: false,
    },
  }));

  const dsm = manager(base);
  await expect(dsm.initializeOnStart()).rejects.toThrow(/租约|拒绝/);

  const lease = dsm.restoreCutoverPending();
  expect(lease).not.toBeNull();
  expect(lease?.target_slot).toBe('slotB');
  expect(lease?.backup_id).toBe(CHAOS_BACKUP_ID);
  expect(lease?.activation_committed).toBe(false);

  // 拒启是稳定态：损坏状态未修复前每次启动都必须拒绝。
  await expect(dsm.initializeOnStart()).rejects.toThrow();
});

// sync_r10_chaos_lease.rs::r10_chaos_tampered_lease_backup_id_blocks_commit_and_release
it('r10_chaos_tampered_lease_backup_id_blocks_commit_and_release', async () => {
  const base = tempDir();
  const dsm = manager(base);
  await dsm.initializeOnStart();
  seedSlot(dsm.slotDir('slotA'), 'old-data');
  seedSlot(dsm.slotDir('slotB'), 'restored-data');
  dsm.markRestoreCutoverPending('slotB', CHAOS_BACKUP_ID);

  const restarted = manager(base);
  await restarted.initializeOnStart();
  expect(restarted.activeSlot()).toBe('slotB');

  // 混沌注入：state.json 里的租约 backup_id 被篡改。
  const statePath = path.join(base, 'slots', 'state.json');
  const original = fs.readFileSync(statePath, 'utf8');
  expect(original).toContain(CHAOS_BACKUP_ID);
  fs.writeFileSync(statePath, original.replace(CHAOS_BACKUP_ID, 'backup-tampered'));

  expect(() => restarted.markRestoreActivationCommitted(restarted.slotDir('slotB'), CHAOS_BACKUP_ID))
    .toThrow(/不匹配/);
  expect(() => restarted.completeRestoreCutover(restarted.slotDir('slotB')))
    .toThrow(/拒绝/);

  const lease = restarted.restoreCutoverPending();
  expect(lease?.backup_id).toBe('backup-tampered');
  expect(lease?.activation_committed).toBe(false);

  // 系统停留在可修复的维护态：活动槽与租约目标一致，重启不砖机。
  const rebooted = manager(base);
  await rebooted.initializeOnStart();
  expect(rebooted.activeSlot()).toBe('slotB');
});

// sync_r10_android.rs::lease_activation_commit_requires_matching_backup_id_and_active_dir
it('lease_activation_commit_requires_matching_backup_id_and_active_dir', async () => {
  const base = tempDir();
  const backupId = 'backup-r10-android';

  const first = manager(base);
  await first.initializeOnStart();
  seedSlot(first.slotDir('slotA'), 'device-current');
  seedSlot(first.slotDir('slotB'), 'restored-backup');
  first.markRestoreCutoverPending('slotB', backupId);

  const restarted = manager(base);
  await restarted.initializeOnStart();
  expect(restarted.activeSlot()).toBe('slotB');
  const activeDir = restarted.activeDir();

  const wrongBackup = thrown(() => restarted.markRestoreActivationCommitted(activeDir, 'backup-someone-else'));
  expect(wrongBackup.message).toBe('恢复维护租约与已激活槽不匹配');

  const wrongDir = thrown(() => restarted.markRestoreActivationCommitted(restarted.slotDir('slotA'), backupId));
  expect(wrongDir.message).toBe('恢复维护租约的活动槽路径不匹配');

  const lease = restarted.restoreCutoverPending();
  expect(lease?.activation_committed).toBe(false);

  restarted.markRestoreActivationCommitted(activeDir, backupId);
  expect(thrown(() => restarted.completeRestoreCutover(restarted.slotDir('slotA'))).message)
    .toBe('恢复槽尚未完成激活、迁移与校验，拒绝解除维护租约');
  expect(restarted.completeRestoreCutover(activeDir)).toBe(true);
  expect(restarted.completeRestoreCutover(activeDir)).toBe(false);
});

// sync_r10_android.rs::rollback_trash_of_old_slot_survives_cutover_restart
it('rollback_trash_of_old_slot_survives_cutover_restart', async () => {
  const base = tempDir();

  const first = manager(base);
  await first.initializeOnStart();
  seedSlot(first.slotDir('slotA'), 'device-current');
  seedSlot(first.slotDir('slotB'), 'stale-residual');

  const slotBTrash = first.clearSlotForRestore('slotB');
  expect(slotBTrash).not.toBeNull();
  expect(fs.statSync(slotBTrash!).isDirectory()).toBe(true);
  const slotsDir = path.dirname(slotBTrash!);

  const slotATrash = path.join(slotsDir, 'slotA.trash-20260824000000-manual');
  seedSlot(slotATrash, 'previous-rollback');

  seedSlot(first.slotDir('slotB'), 'restored-backup');
  first.markRestoreCutoverPending('slotB', 'backup-r10-trash');
  expect(fs.existsSync(slotBTrash!)).toBe(true);

  const restarted = manager(base);
  await restarted.initializeOnStart();
  expect(restarted.activeSlot()).toBe('slotB');
  expect(fs.existsSync(slotBTrash!)).toBe(false);
  expect(fs.statSync(slotATrash).isDirectory()).toBe(true);
  expect(fs.readFileSync(path.join(slotATrash, 'mistakes.db'), 'utf8')).toBe('previous-rollback');
});
