/**
 * Ports of the data-space cutover/restart assertions in
 * `sync_android_restart.rs` and `sync_android_device_switch.rs`.
 *
 * F3 publishes the production `DataSpaceManager` (`host/platform/storage`), so
 * these rows no longer depend on L11. "Restart" is a fresh manager over the same
 * base directory, exactly like a new process calling `initialize_on_start`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DataSpaceManager } from '../../../platform/storage/data-space.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l23-dataspace-'));
  dirs.push(dir);
  return dir;
}

function manager(base: string): DataSpaceManager {
  return new DataSpaceManager(base, { recover: async () => 'Clean' });
}

function seedSlot(dir: string, payload: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mistakes.db'), payload);
}

function thrown(action: () => unknown): Error {
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

describe('sync_android_restart.rs data-space restart semantics', () => {
  it('restore_writes_inactive_slot_and_switch_happens_only_after_restart', async () => {
    const base = tempDir();
    const backupId = 'backup-20260824-000000';

    const first = manager(base);
    await first.initializeOnStart();
    expect(first.activeSlot()).toBe('slotA');
    expect(first.inactiveSlot()).toBe('slotB');
    seedSlot(first.activeDir(), 'current-device-data');

    // Restore must never clear the slot held by open database connections.
    expect(thrown(() => first.clearSlotForRestore('slotA')).message).toContain('拒绝清空活跃插槽');

    first.clearSlotForRestore('slotB');
    seedSlot(first.inactiveDir(), 'restored-from-webdav-backup');
    first.markRestoreCutoverPending('slotB', backupId);

    // Before restart the process still runs on slot A and the lease is uncommitted.
    expect(first.activeSlot()).toBe('slotA');
    const lease = first.restoreCutoverPending();
    expect(lease?.target_slot).toBe('slotB');
    expect(lease?.backup_id).toBe(backupId);
    expect(lease?.activation_committed).toBe(false);
    expect(thrown(() => first.completeRestoreCutover(first.slotDir('slotB'))).message)
      .toContain('拒绝解除维护租约');

    // Restart: the pending cutover is applied and the restored payload is active.
    const restarted = manager(base);
    await restarted.initializeOnStart();
    expect(restarted.activeSlot()).toBe('slotB');
    expect(fs.readFileSync(path.join(restarted.activeDir(), 'mistakes.db'), 'utf8'))
      .toBe('restored-from-webdav-backup');
    const restartedLease = restarted.restoreCutoverPending();
    expect(restartedLease?.activation_committed).toBe(false);
    expect(thrown(() => restarted.completeRestoreCutover(restarted.activeDir())).message)
      .toContain('拒绝解除维护租约');

    // Activation commit is required before the lease can be released.
    restarted.markRestoreActivationCommitted(restarted.activeDir(), backupId);
    expect(restarted.completeRestoreCutover(restarted.activeDir())).toBe(true);
    expect(restarted.restoreCutoverPending()).toBeNull();

    // A further restart stays on slot B with no residual lease.
    const again = manager(base);
    await again.initializeOnStart();
    expect(again.activeSlot()).toBe('slotB');
    expect(again.restoreCutoverPending()).toBeNull();
  });

  it('startup_fails_closed_when_lease_target_is_not_active', async () => {
    const base = tempDir();
    const first = manager(base);
    await first.initializeOnStart();
    seedSlot(first.slotDir('slotA'), 'slot-a-data');
    seedSlot(first.slotDir('slotB'), 'slot-b-restored');

    first.markRestoreCutoverPending('slotB', 'backup-x');
    // Adversarial rewrite: pending points back to A while the lease still targets B.
    first.markPendingSwitch('slotA');

    const restarted = manager(base);
    await expect(restarted.initializeOnStart()).rejects.toThrow(/恢复维护租约/);
  });

  it('restore_cutover_registration_guards_reject_invalid_input', async () => {
    const base = tempDir();
    const first = manager(base);
    await first.initializeOnStart();

    // Empty target slot: restore would switch the user to a slot with no data.
    expect(thrown(() => first.markRestoreCutoverPending('slotB', 'backup-x')).message)
      .toContain('恢复目标插槽 slotB 不存在或为空');

    seedSlot(first.slotDir('slotB'), 'restored');
    expect(thrown(() => first.markRestoreCutoverPending('slotB', '   ')).message)
      .toContain('恢复维护租约缺少 backup_id');

    first.markRestoreCutoverPending('slotB', 'backup-x');
    expect(thrown(() => first.markRestoreCutoverPending('slotB', 'backup-y')).message)
      .toContain('已有恢复维护租约');
    // Same lease repeated is idempotent (crash retry safety).
    expect(() => first.markRestoreCutoverPending('slotB', 'backup-x')).not.toThrow();
  });
});

describe('sync_android_device_switch.rs restart guard', () => {
  it('restart_guard_refuses_boot_when_lease_target_not_activated', async () => {
    const base = tempDir();
    const first = manager(base);
    await first.initializeOnStart();
    seedSlot(first.slotDir('slotA'), 'new-phone');
    seedSlot(first.slotDir('slotB'), 'old-phone');
    first.markRestoreCutoverPending('slotB', 'backup-guard-test');

    // Simulate slot B being destroyed before restart: pending cannot be applied.
    fs.rmSync(first.slotDir('slotB'), { recursive: true });
    fs.mkdirSync(first.slotDir('slotB'), { recursive: true });

    const restarted = manager(base);
    await expect(restarted.initializeOnStart()).rejects.toThrow(/租约|拒绝/);
    const lease = restarted.restoreCutoverPending();
    expect(lease?.target_slot).toBe('slotB');
    expect(lease?.backup_id).toBe('backup-guard-test');
  });
});
