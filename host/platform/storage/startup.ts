import fs from 'node:fs';
import path from 'node:path';
import type { CryptoPublication } from '../secrets/api.ts';
import { restrictMasterKeyFile, type MasterKeyPermissionOptions } from '../secrets/crypto-service.ts';
import type { DataSpaceService, DataSpaceSlot } from './api.ts';
import { DataSpaceManager } from './data-space.ts';
import { prepareStartupRecovery, StartupRecoveryState } from './startup-recovery.ts';
import { clearPurgeMarker, purgeAllLocalData, shouldPurgeOnStart } from './startup-cleanup.ts';
import { atomicWriteBytesBeforeRename, errorText } from './data-space-files.ts';
import { storageLog } from './logging.ts';
import { decodeBase64Standard, decodeUtf8Strict, rustTrim, utf8ErrorMessage } from '../util/portable.ts';

const LOG_TARGET = 'dstu_storage::startup';
const MASTER_KEY_FILE = '.master_key';

function slotMasterKeyProblem(bytes: Uint8Array): string | null {
  if (utf8ErrorMessage(bytes) !== null) return 'stream did not contain valid UTF-8';
  const decoded = decodeBase64Standard(rustTrim(decodeUtf8Strict(bytes)));
  if ('error' in decoded) return `主密钥Base64解码失败: ${decoded.error}`;
  const length = decoded.bytes.length;
  decoded.bytes.fill(0);
  return length === 32 ? null : `主密钥长度无效，预期32字节，实际${length}`;
}

/** 根目录主密钥副本的权限收紧所用平台、环境与命令执行；缺省同 secrets 服务（`process.platform`、`process.env`）。 */
export type MasterKeyAdoptionOptions = Omit<MasterKeyPermissionOptions, 'log'>;

const masterKeyLog: MasterKeyPermissionOptions['log'] = { warn: (message) => storageLog(LOG_TARGET, 'warn', message) };

/**
 * RUST-FIX(RF-W07-crypto-root-adopts-slot-master-key): Rust 的 LLMManager 把 API Key 主密钥放在活动槽位
 * （lib.rs:3488 → llm_manager/mod.rs:4757），备份与恢复却读写应用根目录的 `.master_key`；TS 统一用根目录。
 * 根目录还没有主密钥时，把活动槽位里可用的那把逐字节复制过去，槽内原文件保留给旧版读取。
 * 副本在 rename 前按新建主密钥的规则收紧（POSIX 0600，Windows icacls），不沿用目录继承的 ACL。
 */
export async function adoptActiveSlotMasterKey(
  baseDir: string,
  activeDir: string,
  options: MasterKeyAdoptionOptions = { platform: process.platform, env: process.env },
): Promise<void> {
  const target = path.join(baseDir, MASTER_KEY_FILE);
  const source = path.join(activeDir, MASTER_KEY_FILE);
  try { fs.lstatSync(target); return; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      storageLog(LOG_TARGET, 'warn', `[startup] 检查应用根目录主密钥失败 ${target}: ${errorText(error)}`);
      return;
    }
  }
  let stat: fs.Stats;
  try { stat = fs.lstatSync(source); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') storageLog(LOG_TARGET, 'warn', `[startup] 读取活动槽位 ${MASTER_KEY_FILE} 失败 ${source}: ${errorText(error)}`);
    return;
  }
  if (!stat.isFile()) {
    storageLog(LOG_TARGET, 'warn', `[startup] 活动槽位 ${MASTER_KEY_FILE} 不是普通文件，未复制到应用根目录: ${source}`);
    return;
  }
  try {
    const bytes = fs.readFileSync(source);
    const problem = slotMasterKeyProblem(bytes);
    if (problem !== null) {
      storageLog(LOG_TARGET, 'warn', `[startup] 活动槽位 ${MASTER_KEY_FILE} 不可用，未复制到应用根目录 ${source}: ${problem}`);
      return;
    }
    try {
      await atomicWriteBytesBeforeRename(target, bytes, (temporary) => restrictMasterKeyFile(temporary, { ...options, log: masterKeyLog }));
    } finally {
      bytes.fill(0);
    }
    storageLog(LOG_TARGET, 'info', `[startup] 已把活动槽位主密钥复制到应用根目录: ${target}`);
  } catch (error) {
    storageLog(LOG_TARGET, 'warn', `[startup] 复制活动槽位 ${MASTER_KEY_FILE} 到应用根目录失败 ${target}: ${errorText(error)}`);
  }
}

/** lib.rs:929-1065: the recovery shell survives initialization errors, business databases stay closed. */
export class DataSpaceStartup implements DataSpaceService {
  readonly baseDir: string;
  readonly manager: DataSpaceManager;
  readonly recovery: StartupRecoveryState;
  initialized = false;
  private startPromise?: Promise<void>;
  private readonly resetSyncBaseline?: () => void | Promise<void>;
  private readonly masterKeyAdoption?: MasterKeyAdoptionOptions;
  constructor(
    baseDir: string,
    publication: Pick<CryptoPublication, 'recover'>,
    resetSyncBaseline?: () => void | Promise<void>,
    masterKeyAdoption?: MasterKeyAdoptionOptions,
  ) {
    this.baseDir = baseDir; this.manager = new DataSpaceManager(baseDir, publication); this.resetSyncBaseline = resetSyncBaseline;
    this.masterKeyAdoption = masterKeyAdoption;
    try { this.recovery = new StartupRecoveryState(baseDir, prepareStartupRecovery(baseDir)); }
    catch (error) { this.recovery = StartupRecoveryState.failed(baseDir, 'startup_preflight', error); }
  }
  start(): Promise<void> { return this.startPromise ??= this.initialize(); }
  private async initialize(): Promise<void> {
    if (this.status().recovery_required) return;
    try { await this.manager.initializeOnStart(); this.initialized = true; }
    catch (error) { this.recovery.setFailure('data_space_init', error); return; }
    const active = this.manager.activeDir();
    try { fs.mkdirSync(active, { recursive: true }); } catch (error) { this.recovery.setFailure('active_data_directory', error); return; }
    const stale = path.join(active, 'temp_zip_export');
    if (fs.existsSync(stale)) {
      try { fs.rmSync(stale, { recursive: true }); }
      catch (error) { storageLog(LOG_TARGET, 'warn', `[startup] 清理遗留 ZIP 临时导出目录失败 ${stale}: ${errorText(error)}`); }
    }
    if (shouldPurgeOnStart(this.baseDir)) {
      try {
        const report = await purgeAllLocalData(this.baseDir, active, this.resetSyncBaseline);
        if (report.had_errors) { this.recovery.setFailure('startup_cleanup', '启动阶段数据清理不完整，已保留清理标记并拒绝打开业务库'); return; }
      } catch (error) { this.recovery.setFailure('startup_cleanup', error); return; }
      try { clearPurgeMarker(this.baseDir); } catch (error) { this.recovery.setFailure('startup_cleanup_marker', error); return; }
    }
    await adoptActiveSlotMasterKey(this.baseDir, active, this.masterKeyAdoption);
  }
  assertReady(): void {
    if (!this.initialized || this.status().recovery_required) throw new Error('启动恢复尚未完成，业务数据库保持关闭');
  }
  status() { return this.recovery.status(); }
  incidents() { return this.recovery.incidents(); }
  retryPreflight() { return this.recovery.retryPreflight(); }
  resolve(candidateId: string) { return this.recovery.resolve(candidateId); }
  slotDir(slot: DataSpaceSlot) { return this.manager.slotDir(slot); }
  activeDir() { return this.manager.activeDir(); }
  inactiveDir() { return this.manager.inactiveDir(); }
  markPendingSwitch(target: DataSpaceSlot) { this.manager.markPendingSwitch(target); }
  markRestoreCutoverPending(target: DataSpaceSlot, backupId: string) { this.manager.markRestoreCutoverPending(target, backupId); }
  restoreCutoverPending() { return this.manager.restoreCutoverPending(); }
  markRestoreActivationCommitted(activeDir: string, backupId: string) { this.manager.markRestoreActivationCommitted(activeDir, backupId); }
  completeRestoreCutover(activeDir: string) { return this.manager.completeRestoreCutover(activeDir); }
  clearSlotForRestore(target: DataSpaceSlot) { return this.manager.clearSlotForRestore(target); }
  cleanupRestoreTrash(target: DataSpaceSlot) { return this.manager.cleanupRestoreTrash(target); }
}
