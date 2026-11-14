import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import secrets from '../../secrets/index.ts';
import { DataSpaceManager, isTestSlot, integritySummary, isHealthy } from '../data-space.ts';
import { slotFromName } from '../locations.ts';
import type { DataSpaceSlot } from '../api.ts';

let base: string;
let manager: DataSpaceManager;
let host: Awaited<ReturnType<typeof createTestHost>>;
beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-start-'));
  host = await createTestHost({ plugins: [secrets], provide: {
    paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } },
    log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
  } });
  manager = new DataSpaceManager(base, host.ctx.secrets.publication);
});
afterEach(async () => { await host.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
function populate(slot: DataSpaceSlot, file = 'placeholder.txt', content = 'data') {
  fs.mkdirSync(manager.slotDir(slot), { recursive: true });
  fs.writeFileSync(path.join(manager.slotDir(slot), file), content);
}

it('test_ensure_layout_creates_directories', () => {
  manager.ensureLayout();
  for (const slot of ['slotA', 'slotB', 'slotC', 'slotD'] as const) expect(fs.statSync(manager.slotDir(slot)).isDirectory()).toBe(true);
  expect(fs.existsSync(manager.statePath)).toBe(true);
});
it('test_mark_pending_switch', () => {
  manager.ensureLayout(); populate('slotB'); manager.markPendingSwitch('slotB');
  expect(manager.readState().pending).toBe('slotB');
});
it('test_mark_pending_switch_empty_target_fails', () => {
  manager.ensureLayout(); expect(() => manager.markPendingSwitch('slotB')).toThrow();
});
it('test_initialize_on_start_valid_pending', async () => {
  manager.ensureLayout(); populate('slotB'); manager.writeState({ active: 'slotA', pending: 'slotB' });
  await manager.initializeOnStart(); expect(manager.readState()).toEqual({ active: 'slotB', pending: null });
});
it('test_initialize_on_start_invalid_pending', async () => {
  manager.ensureLayout(); manager.writeState({ active: 'slotA', pending: 'slotZ_nonexistent' });
  await manager.initializeOnStart(); expect(manager.readState()).toEqual({ active: 'slotA', pending: null });
});
it('test_initialize_on_start_pending_empty_slot', async () => {
  manager.ensureLayout(); manager.writeState({ active: 'slotA', pending: 'slotB' });
  await manager.initializeOnStart(); expect(manager.readState()).toEqual({ active: 'slotA', pending: null });
});
for (const committed of [false, true]) it(committed
  ? 'test_initialize_on_start_rolls_forward_committed_crypto_publication'
  : 'test_initialize_on_start_rolls_back_uncommitted_crypto_publication', async () => {
  manager.ensureLayout();
  if (committed) { populate('slotB'); manager.markRestoreCutoverPending('slotB', 'backup-1'); }
  const rollback = path.join(base, '.crypto_restore_rollback'); fs.mkdirSync(rollback);
  fs.writeFileSync(path.join(rollback, '.master_key'), 'old-master'); fs.writeFileSync(path.join(base, '.master_key'), 'new-master');
  await host.ctx.secrets.publication.writeJournal(base, {
    version: 1, backupId: 'backup-1', targetSlot: 'slotB', hadOldMaster: true, hadOldSecure: false,
    installsMaster: true, installsSecure: false, createdAt: new Date().toISOString(),
  });
  await manager.initializeOnStart();
  expect(fs.readFileSync(path.join(base, '.master_key'), 'utf8')).toBe(committed ? 'new-master' : 'old-master');
  expect(fs.existsSync(path.join(base, '.crypto_restore_journal.json'))).toBe(false);
  expect(fs.existsSync(rollback)).toBe(false);
  if (committed) expect(manager.readState().active).toBe('slotB');
});
it('test_verify_slot_integrity_healthy', () => {
  manager.ensureLayout(); populate('slotA', 'main.db', 'sqlite-fake-content');
  fs.mkdirSync(path.join(manager.slotDir('slotA'), 'images'));
  fs.writeFileSync(path.join(manager.slotDir('slotA'), 'images/photo.jpg'), 'fake-image-bytes');
  const report = manager.verifySlotIntegrity('slotA');
  expect(report.exists).toBe(true); expect(report.has_data).toBe(true); expect(report.has_database).toBe(true);
  expect(report.database_files).toContain('main.db'); expect(report.subdirectories).toContain('images');
  expect(isHealthy(report)).toBe(true); expect(report.total_size_bytes).toBeGreaterThan(0);
});
it('test_verify_slot_integrity_empty_slot', () => {
  manager.ensureLayout(); const report = manager.verifySlotIntegrity('slotB');
  expect(report.exists).toBe(true); expect(report.has_data).toBe(false); expect(isHealthy(report)).toBe(false);
  expect(report.issues.some(x => x.includes('为空'))).toBe(true);
});
it('test_verify_slot_integrity_missing_dir', () => {
  const report = new DataSpaceManager(path.join(base, 'nonexistent_base'), host.ctx.secrets.publication).verifySlotIntegrity('slotA');
  expect(report.exists).toBe(false); expect(isHealthy(report)).toBe(false);
  expect(report.issues.some(x => x.includes('不存在'))).toBe(true);
});
it('test_slot_integrity_report_is_healthy', () => {
  expect(isHealthy({ issues: [] })).toBe(true); expect(isHealthy({ issues: ['未找到数据库文件'] })).toBe(false);
});
it('test_slot_size_calculation', () => {
  manager.ensureLayout(); expect(manager.slotSize('slotA')).toBe(0);
  populate('slotA', 'file1.txt', 'hello world 1234567890');
  expect(manager.slotSize('slotA')).toBe(22);
  fs.mkdirSync(path.join(manager.slotDir('slotA'), 'nested'));
  fs.writeFileSync(path.join(manager.slotDir('slotA'), 'nested/file2.txt'), 'abcdefgh');
  expect(manager.slotSize('slotA')).toBe(30);
});
it('test_slot_basic_methods', () => {
  for (const name of ['A', 'B', 'C', 'D']) expect(slotFromName(name)).toBe(`slot${name}`);
  expect(slotFromName('slotA')).toBe('slotA'); expect(slotFromName('slotB')).toBe('slotB'); expect(slotFromName('invalid')).toBeUndefined();
  expect(isTestSlot('slotA')).toBe(false); expect(isTestSlot('slotB')).toBe(false);
  expect(isTestSlot('slotC')).toBe(true); expect(isTestSlot('slotD')).toBe(true);
});
it('test_ensure_layout_idempotent', () => {
  manager.ensureLayout(); const first = fs.readFileSync(manager.statePath, 'utf8');
  manager.ensureLayout(); expect(fs.readFileSync(manager.statePath, 'utf8')).toBe(first);
});
it('test_active_inactive_slot', () => {
  manager.ensureLayout(); expect(manager.activeSlot()).toBe('slotA'); expect(manager.inactiveSlot()).toBe('slotB');
  manager.writeState({ active: 'slotB', pending: null }); expect(manager.activeSlot()).toBe('slotB'); expect(manager.inactiveSlot()).toBe('slotA');
});
it('test_clear_slot_for_restore_moves_residual_to_trash', () => {
  manager.ensureLayout(); populate('slotB', 'main.db', 'sqlite-fake-content');
  fs.mkdirSync(path.join(manager.slotDir('slotB'), 'images')); fs.writeFileSync(path.join(manager.slotDir('slotB'), 'images/old.jpg'), 'stale');
  const trash = manager.clearSlotForRestore('slotB');
  expect(fs.statSync(manager.slotDir('slotB')).isDirectory()).toBe(true); expect(fs.readdirSync(manager.slotDir('slotB'))).toEqual([]);
  expect(trash).not.toBeNull(); expect(fs.statSync(trash!).isDirectory()).toBe(true);
  expect(fs.existsSync(path.join(trash!, 'main.db'))).toBe(true); expect(fs.existsSync(path.join(trash!, 'images/old.jpg'))).toBe(true);
});
it('test_clear_slot_for_restore_rejects_active_slot', () => {
  manager.ensureLayout(); populate('slotA'); expect(() => manager.clearSlotForRestore('slotA')).toThrow();
  expect(fs.existsSync(path.join(manager.slotDir('slotA'), 'placeholder.txt'))).toBe(true);
});
it('test_clear_slot_for_restore_empty_slot_is_noop', () => {
  manager.ensureLayout(); expect(manager.clearSlotForRestore('slotB')).toBeNull(); expect(fs.statSync(manager.slotDir('slotB')).isDirectory()).toBe(true);
});
it('restore_cutover_lease_survives_restart_until_activation_commit', async () => {
  manager.ensureLayout(); populate('slotB', 'main.db'); manager.markRestoreCutoverPending('slotB', 'backup-1');
  expect(manager.restoreCutoverPending()?.target_slot).toBe('slotB'); expect(manager.restoreCutoverPending()?.activation_committed).toBe(false);
  await manager.initializeOnStart(); expect(manager.activeSlot()).toBe('slotB'); expect(() => manager.completeRestoreCutover(manager.activeDir())).toThrow();
  manager.markRestoreActivationCommitted(manager.activeDir(), 'backup-1'); expect(manager.completeRestoreCutover(manager.activeDir())).toBe(true);
  expect(manager.restoreCutoverPending()).toBeNull();
});
it('legacy_slot_backups_are_durably_migrated_and_idempotent', () => {
  manager.ensureLayout(); const source = path.join(manager.slotDir('slotA'), 'backups/backup-1'); fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'manifest.json'), '{"backup_id":"backup-1"}'); manager.migrateLegacySlotBackups();
  const destination = path.join(manager.recoveryBackupsDir, 'backup-1/manifest.json');
  expect(fs.statSync(destination).isFile()).toBe(true); expect(fs.existsSync(source)).toBe(false);
  manager.migrateLegacySlotBackups(); expect(fs.statSync(destination).isFile()).toBe(true);
});
it('test_slot_integrity_report_summary', () => {
  manager.ensureLayout(); populate('slotA', 'main.db'); const healthy = manager.verifySlotIntegrity('slotA');
  expect(integritySummary(healthy)).toContain('完整'); expect(integritySummary(healthy)).toContain('1 个数据库文件');
  fs.rmdirSync(manager.slotDir('slotB')); const unhealthy = manager.verifySlotIntegrity('slotB');
  expect(integritySummary(unhealthy)).toContain('异常'); expect(integritySummary(unhealthy)).toContain('不存在');
});
