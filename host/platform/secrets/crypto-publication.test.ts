// 移植自 dstu-security/src/crypto_publication.rs::tests
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../log/api.ts';
import type { CryptoPublicationJournal } from './api.ts';
import { createCryptoPublication, CryptoPublicationError, journalPath, rollbackDir } from './crypto-publication.ts';

const silent: Logger = { target: 't', error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const pub = createCryptoPublication(silent);
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'f4-pub-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const read = (p: string) => readFileSync(p, 'utf8');
const cutoverJournal = (hadOld: boolean): CryptoPublicationJournal => ({
  version: 1,
  backupId: 'backup-1',
  targetSlot: 'slotB',
  hadOldMaster: hadOld,
  hadOldSecure: hadOld,
  installsMaster: true,
  installsSecure: true,
  createdAt: '2026-11-03T00:00:00+00:00',
});

async function seedTorn(root: string, hadOld: boolean) {
  const rb = rollbackDir(root);
  mkdirSync(rb, { recursive: true });
  if (hadOld) {
    writeFileSync(join(rb, '.master_key'), 'old-master');
    mkdirSync(join(rb, '.secure'));
    writeFileSync(join(rb, '.secure/.key_seed'), 'old-seed');
    writeFileSync(join(rb, '.secure/old.enc'), 'old-credential');
  }
  writeFileSync(join(root, '.master_key'), 'new-master');
  mkdirSync(join(root, '.secure'), { recursive: true });
  writeFileSync(join(root, '.secure/.key_seed'), 'new-seed');
  await pub.writeJournal(root, cutoverJournal(hadOld));
}

const OLD_STATE = '{"active":"slotA","pending":null}';
const OLD_AUDIT = 'old-audit-generation';
function seedOld(root: string) {
  writeFileSync(join(root, '.master_key'), 'old-master');
  mkdirSync(join(root, '.secure'));
  writeFileSync(join(root, '.secure/.key_seed'), 'old-seed');
  writeFileSync(join(root, '.secure/cred.enc'), 'old-credential');
  mkdirSync(join(root, 'databases'));
  writeFileSync(join(root, 'databases/audit.db'), OLD_AUDIT);
  mkdirSync(join(root, 'slots'));
  writeFileSync(join(root, 'slots/state.json'), OLD_STATE);
}
function assertSlotAndAuditUntouched(root: string) {
  expect(read(join(root, 'slots/state.json'))).toBe(OLD_STATE);
  expect(read(join(root, 'databases/audit.db'))).toBe(OLD_AUDIT);
}
function assertAllOld(root: string) {
  expect(read(join(root, '.master_key'))).toBe('old-master');
  expect(read(join(root, '.secure/.key_seed'))).toBe('old-seed');
  expect(read(join(root, '.secure/cred.enc'))).toBe('old-credential');
  assertSlotAndAuditUntouched(root);
  expect(existsSync(journalPath(root))).toBe(false);
  expect(existsSync(rollbackDir(root))).toBe(false);
}
const assertIdempotent = async (root: string) => expect(await pub.recover(root, null)).toBe('Clean');

describe('crypto_publication::tests', () => {
  it('recover_without_journal_is_clean_and_sweeps_stale_rollback', async () => {
    const root = temp();
    mkdirSync(rollbackDir(root));
    writeFileSync(join(rollbackDir(root), '.master_key'), 'stale');
    expect(await pub.recover(root, null)).toBe('Clean');
    expect(existsSync(rollbackDir(root))).toBe(false);
  });
  it('uncommitted_publication_rolls_back_previous_keys', async () => {
    const root = temp();
    await seedTorn(root, true);
    expect(await pub.recover(root, null)).toBe('RolledBack');
    expect(read(join(root, '.master_key'))).toBe('old-master');
    expect(read(join(root, '.secure/.key_seed'))).toBe('old-seed');
    expect(read(join(root, '.secure/old.enc'))).toBe('old-credential');
    expect(existsSync(journalPath(root))).toBe(false);
    expect(existsSync(rollbackDir(root))).toBe(false);
  });
  it('uncommitted_publication_removes_new_keys_when_no_previous_generation', async () => {
    const root = temp();
    await seedTorn(root, false);
    expect(await pub.recover(root, null)).toBe('RolledBack');
    expect(existsSync(join(root, '.master_key'))).toBe(false);
    expect(existsSync(join(root, '.secure'))).toBe(false);
    expect(existsSync(journalPath(root))).toBe(false);
    expect(existsSync(rollbackDir(root))).toBe(false);
  });
  it('crash_before_moving_old_keys_leaves_target_untouched', async () => {
    const root = temp();
    writeFileSync(join(root, '.master_key'), 'old-master');
    mkdirSync(join(root, '.secure'));
    writeFileSync(join(root, '.secure/.key_seed'), 'old-seed');
    mkdirSync(rollbackDir(root));
    await pub.writeJournal(root, cutoverJournal(true));
    expect(await pub.recover(root, null)).toBe('RolledBack');
    expect(read(join(root, '.master_key'))).toBe('old-master');
    expect(read(join(root, '.secure/.key_seed'))).toBe('old-seed');
    expect(existsSync(journalPath(root))).toBe(false);
  });
  it('committed_publication_rolls_forward_and_keeps_new_keys', async () => {
    const root = temp();
    await seedTorn(root, true);
    expect(await pub.recover(root, ['backup-1', 'slotB'])).toBe('RolledForward');
    expect(read(join(root, '.master_key'))).toBe('new-master');
    expect(read(join(root, '.secure/.key_seed'))).toBe('new-seed');
    expect(existsSync(journalPath(root))).toBe(false);
    expect(existsSync(rollbackDir(root))).toBe(false);
  });
  it('mismatched_lease_fails_closed', async () => {
    const root = temp();
    await seedTorn(root, true);
    await expect(pub.recover(root, ['other-backup', 'slotA'])).rejects.toBeInstanceOf(CryptoPublicationError);
    expect(existsSync(journalPath(root))).toBe(true);
  });
  it('corrupted_journal_fails_closed', async () => {
    const root = temp();
    writeFileSync(journalPath(root), 'not-json');
    await expect(pub.recover(root, null)).rejects.toBeInstanceOf(CryptoPublicationError);
  });
  it('crash_matrix_p1_after_journal_write_keeps_all_domains_old', async () => {
    const root = temp();
    seedOld(root);
    mkdirSync(rollbackDir(root));
    await pub.writeJournal(root, cutoverJournal(true));
    expect(await pub.recover(root, null)).toBe('RolledBack');
    assertAllOld(root);
    await assertIdempotent(root);
  });
  it('crash_matrix_p2_midway_old_master_moved_restores_old_generation', async () => {
    const root = temp();
    seedOld(root);
    mkdirSync(rollbackDir(root));
    await pub.writeJournal(root, cutoverJournal(true));
    renameSync(join(root, '.master_key'), join(rollbackDir(root), '.master_key'));
    expect(await pub.recover(root, null)).toBe('RolledBack');
    assertAllOld(root);
    await assertIdempotent(root);
  });
  it('crash_matrix_p2_new_master_installed_secure_pending_restores_old', async () => {
    const root = temp();
    seedOld(root);
    mkdirSync(rollbackDir(root));
    await pub.writeJournal(root, cutoverJournal(true));
    renameSync(join(root, '.master_key'), join(rollbackDir(root), '.master_key'));
    renameSync(join(root, '.secure'), join(rollbackDir(root), '.secure'));
    writeFileSync(join(root, '.master_key'), 'new-master');
    expect(await pub.recover(root, null)).toBe('RolledBack');
    assertAllOld(root);
    await assertIdempotent(root);
  });
  it('crash_matrix_p2_first_install_midway_removes_partial_new_keys', async () => {
    const root = temp();
    mkdirSync(join(root, 'databases'));
    writeFileSync(join(root, 'databases/audit.db'), OLD_AUDIT);
    mkdirSync(join(root, 'slots'));
    writeFileSync(join(root, 'slots/state.json'), OLD_STATE);
    mkdirSync(rollbackDir(root));
    await pub.writeJournal(root, cutoverJournal(false));
    writeFileSync(join(root, '.master_key'), 'new-master');
    expect(await pub.recover(root, null)).toBe('RolledBack');
    expect(existsSync(join(root, '.master_key'))).toBe(false);
    expect(existsSync(join(root, '.secure'))).toBe(false);
    assertSlotAndAuditUntouched(root);
    expect(existsSync(journalPath(root))).toBe(false);
    expect(existsSync(rollbackDir(root))).toBe(false);
    await assertIdempotent(root);
  });
  it('crash_matrix_p3_before_pending_slot_registration_rolls_back_to_old', async () => {
    const root = temp();
    seedOld(root);
    mkdirSync(rollbackDir(root));
    await pub.writeJournal(root, cutoverJournal(true));
    renameSync(join(root, '.master_key'), join(rollbackDir(root), '.master_key'));
    renameSync(join(root, '.secure'), join(rollbackDir(root), '.secure'));
    writeFileSync(join(root, '.master_key'), 'new-master');
    mkdirSync(join(root, '.secure'));
    writeFileSync(join(root, '.secure/.key_seed'), 'new-seed');
    expect(await pub.recover(root, null)).toBe('RolledBack');
    assertAllOld(root);
    await assertIdempotent(root);
  });
  it('crash_matrix_p3_after_pending_slot_registration_rolls_forward', async () => {
    const root = temp();
    seedOld(root);
    mkdirSync(rollbackDir(root));
    await pub.writeJournal(root, cutoverJournal(true));
    renameSync(join(root, '.master_key'), join(rollbackDir(root), '.master_key'));
    renameSync(join(root, '.secure'), join(rollbackDir(root), '.secure'));
    writeFileSync(join(root, '.master_key'), 'new-master');
    mkdirSync(join(root, '.secure'));
    writeFileSync(join(root, '.secure/.key_seed'), 'new-seed');
    expect(await pub.recover(root, ['backup-1', 'slotB'])).toBe('RolledForward');
    expect(read(join(root, '.master_key'))).toBe('new-master');
    expect(read(join(root, '.secure/.key_seed'))).toBe('new-seed');
    expect(read(join(root, 'databases/audit.db'))).toBe(OLD_AUDIT);
    expect(existsSync(journalPath(root))).toBe(false);
    expect(existsSync(rollbackDir(root))).toBe(false);
    await assertIdempotent(root);
  });
  it('journal 磁盘形状（serde snake_case、pretty）', async () => {
    const root = temp();
    await pub.writeJournal(root, cutoverJournal(true));
    expect(Object.keys(JSON.parse(read(journalPath(root))))).toEqual([
      'version',
      'backup_id',
      'target_slot',
      'had_old_master',
      'had_old_secure',
      'installs_master',
      'installs_secure',
      'created_at',
    ]);
  });
});
