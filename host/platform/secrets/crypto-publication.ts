/**
 * 恢复流程全局密钥发布 journal 与启动侧前滚/回滚（`dstu-security/src/crypto_publication.rs`）。
 * 路径：`<root>/.crypto_restore_journal.json`、`<root>/.crypto_restore_rollback/`。
 */
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../log/api.ts';
import { errnoCode } from '../paths/compat.ts';
import { atomicWriteFile, renameWithRetry } from '../util/durable-fs.ts';
import { decodeUtf8Strict, JsonReader } from '../util/portable.ts';
import type { CryptoPublication, CryptoPublicationJournal, CryptoPublicationRecovery } from './api.ts';
import { restrictPermissions } from './secure-store.ts';

export const CRYPTO_PUBLICATION_JOURNAL_FILE = '.crypto_restore_journal.json';
export const CRYPTO_PUBLICATION_ROLLBACK_DIR = '.crypto_restore_rollback';

/** `std::io::Error` 的 `ErrorKind::InvalidData`。 */
export class CryptoPublicationError extends Error {
  readonly kind = 'InvalidData' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CryptoPublicationError';
  }
}

export const journalPath = (root: string) => join(root, CRYPTO_PUBLICATION_JOURNAL_FILE);
export const rollbackDir = (root: string) => join(root, CRYPTO_PUBLICATION_ROLLBACK_DIR);

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const fh = await open(path, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function removePathIfExists(path: string): Promise<void> {
  let meta;
  try {
    meta = await lstat(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return;
    throw error;
  }
  await rm(path, { recursive: meta.isDirectory(), force: false });
}

function serializeJournal(j: CryptoPublicationJournal): string {
  return JSON.stringify(
    {
      version: j.version,
      backup_id: j.backupId,
      target_slot: j.targetSlot,
      had_old_master: j.hadOldMaster,
      had_old_secure: j.hadOldSecure,
      installs_master: j.installsMaster,
      installs_secure: j.installsSecure,
      created_at: j.createdAt,
    },
    null,
    2,
  );
}

function parseJournal(bytes: Buffer): CryptoPublicationJournal {
  const r = new JsonReader(decodeUtf8Strict(bytes));
  const journal: CryptoPublicationJournal = {
    version: 0, backupId: null, targetSlot: null, hadOldMaster: false, hadOldSecure: false,
    installsMaster: false, installsSecure: false, createdAt: '',
  };
  const fields = ['version', 'backup_id', 'target_slot', 'had_old_master', 'had_old_secure', 'installs_master', 'installs_secure', 'created_at'];
  const readField = (key: string): void => {
    switch (key) {
      case 'version': journal.version = Number(r.readUnsigned('u32', 0xffff_ffffn)); break;
      case 'backup_id': journal.backupId = r.readOptionNone() ? null : r.readString(); break;
      case 'target_slot': journal.targetSlot = r.readOptionNone() ? null : r.readString(); break;
      case 'had_old_master': journal.hadOldMaster = r.readBool(); break;
      case 'had_old_secure': journal.hadOldSecure = r.readBool(); break;
      case 'installs_master': journal.installsMaster = r.readBool(); break;
      case 'installs_secure': journal.installsSecure = r.readBool(); break;
      case 'created_at': journal.createdAt = r.readString(); break;
    }
  };
  if (r.peekKind() === 'array') {
    // serde derive's visit_seq: even Option fields need their explicit positions
    // (there is no #[serde(default)] on these fields).
    r.beginArray();
    for (const [index, key] of fields.entries()) {
      if (!r.nextItem()) throw r.error(`invalid length ${index}, expected struct CryptoPublicationJournal with 8 elements`);
      readField(key);
    }
    r.endArray();
  } else {
    r.beginObject('struct CryptoPublicationJournal');
    const seen = new Set<string>();
    for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
      if (!fields.includes(key)) { r.skipIgnoredValue(); continue; }
      if (seen.has(key)) throw r.fieldError(`duplicate field \`${key}\``);
      seen.add(key);
      readField(key);
    }
    // Map form fills omitted Option fields with None; other fields are required,
    // in declaration order, before Deserializer::end checks trailing characters.
    for (const key of fields) {
      if (key !== 'backup_id' && key !== 'target_slot' && !seen.has(key)) throw r.error(`missing field \`${key}\``);
    }
  }
  r.end();
  return journal;
}

export function createCryptoPublication(log: Logger): CryptoPublication {
  const perm = { platform: process.platform, env: process.env, log };

  async function restorePermissions(path: string, isDir: boolean): Promise<void> {
    await restrictPermissions(path, isDir, perm);
    if (!isDir) return;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      // Rust `if let Ok(entries) = read_dir(path)`：权限收紧是尽力而为。
      return;
    }
    for (const e of entries) if (e.isFile()) await restrictPermissions(join(path, e.name), false, perm);
  }

  async function rollbackEntry(root: string, rollback: string, name: string, hadOld: boolean, installs: boolean, isDir: boolean): Promise<void> {
    const target = join(root, name);
    const saved = join(rollback, name);
    let savedExists = true;
    try {
      await lstat(saved);
    } catch {
      // `symlink_metadata(&saved).is_ok()`。
      savedExists = false;
    }
    if (savedExists) {
      await removePathIfExists(target);
      await renameWithRetry(saved, target);
      await restorePermissions(target, isDir);
      return;
    }
    if (!hadOld && installs) await removePathIfExists(target);
  }

  const api: CryptoPublication = {
    journalPath,
    rollbackDir,
    async writeJournal(root, journal) {
      await mkdir(root, { recursive: true });
      await atomicWriteFile(journalPath(root), serializeJournal(journal));
      await syncDirectory(root);
    },
    async removeJournal(root) {
      try {
        await rm(journalPath(root));
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') return;
        throw error;
      }
      await syncDirectory(root);
    },
    async recover(root, activeLease): Promise<CryptoPublicationRecovery> {
      const rollback = rollbackDir(root);
      let bytes: Buffer;
      try {
        bytes = await readFile(journalPath(root));
      } catch (error) {
        if (errnoCode(error) !== 'ENOENT') throw error;
        await removePathIfExists(rollback);
        return 'Clean';
      }
      let journal: CryptoPublicationJournal;
      try {
        journal = parseJournal(bytes);
      } catch (error) {
        throw new CryptoPublicationError(`密钥发布 journal 损坏，拒绝在不确定密钥状态上启动: ${error instanceof Error ? error.message : String(error)}`);
      }
      const cutover = journal.backupId !== null && journal.targetSlot !== null ? ([journal.backupId, journal.targetSlot] as const) : null;
      if (activeLease !== null) {
        const [leaseBackup, leaseSlot] = activeLease;
        if (cutover !== null && cutover[0] === leaseBackup && cutover[1] === leaseSlot) {
          await removePathIfExists(rollback);
          await api.removeJournal(root);
          log.info('[CryptoPublication] 检测到已提交的密钥发布 journal，已前滚清理');
          return 'RolledForward';
        }
        throw new CryptoPublicationError(`密钥发布 journal 与恢复维护租约不匹配（lease backup=${leaseBackup}, target=${leaseSlot}），拒绝自动修复`);
      }
      await rollbackEntry(root, rollback, '.master_key', journal.hadOldMaster, journal.installsMaster, false);
      await rollbackEntry(root, rollback, '.secure', journal.hadOldSecure, journal.installsSecure, true);
      await removePathIfExists(rollback);
      await syncDirectory(root);
      await api.removeJournal(root);
      log.warn('[CryptoPublication] 检测到未提交的密钥发布 journal，已回滚到发布前的全局密钥');
      return 'RolledBack';
    },
  };
  return api;
}
