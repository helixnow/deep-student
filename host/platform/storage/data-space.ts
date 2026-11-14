/** DataSpaceManager, ported from dstu-storage/src/data_space.rs. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CryptoPublication } from '../secrets/api.ts';
import { DataSpace, dirHasData, isLegacyRootEntry, slotFromName, type SlotName, type RestoreCutoverLease } from './locations.ts';
import { atomicWriteJson, copyPathDurable, errorText, isDirectory, isFile, pathsEqual, readJson, removePath, renameSyncWithRetry, syncDirectory, timestampCompact, utcNow } from './data-space-files.ts';
// `data_space.rs:1` imports `copy_directory_safe` from `backup_common`; keep the same module edge
// so the backup helpers are reachable from the plugin entry (the wrapper delegates to data-space-files).
import { copyDirectorySafe } from './backup-common.ts';
import { storageLog } from './logging.ts';
import { rustTrim } from '../util/portable.ts';

const LOG_TARGET = 'dstu_storage::data_space';

export interface SlotIntegrityReport {
  slot: string; dir_path: string; exists: boolean; has_data: boolean; has_database: boolean;
  database_files: string[]; subdirectories: string[]; total_size_bytes: number; file_count: number; issues: string[];
}
export function isTestSlot(slot: SlotName): boolean { return slot === 'slotC' || slot === 'slotD'; }
export function isHealthy(report: Pick<SlotIntegrityReport, 'issues'>): boolean { return report.issues.length === 0; }
export function integritySummary(report: SlotIntegrityReport): string {
  return isHealthy(report) ? `插槽 ${report.slot} 完整: ${report.database_files.length} 个数据库文件, ${report.subdirectories.length} 个子目录, ${(report.total_size_bytes / 1024 / 1024).toFixed(2)} MB`
    : `插槽 ${report.slot} 异常: ${report.issues.join('; ')}`;
}
export function calculateDirSize(dir: string): number {
  if (!isDirectory(dir)) return 0;
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name), meta = fs.lstatSync(file);
    if (meta.isDirectory()) total += calculateDirSize(file); else if (meta.isFile()) total += meta.size;
  }
  return total;
}
function lstatOrNull(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); } catch { return null; }
}

export class DataSpaceManager extends DataSpace {
  readonly publication: Pick<CryptoPublication, 'recover'>;
  constructor(baseDir: string, publication: Pick<CryptoPublication, 'recover'>) { super(baseDir); this.publication = publication; }
  get legacyPendingPath(): string { return path.join(this.slotsDir, '.legacy_migration_pending'); }
  get legacyCompletePath(): string { return path.join(this.slotsDir, '.legacy_migration_complete'); }
  get recoveryBackupsDir(): string { return path.join(this.baseDir, 'recovery/backups'); }
  ensureLayout(): void {
    for (const slot of ['slotA', 'slotB', 'slotC', 'slotD'] as const) fs.mkdirSync(this.slotDir(slot), { recursive: true });
    if (!fs.existsSync(this.statePath)) this.writeState({ active: 'slotA', pending: null });
    if (!fs.existsSync(this.legacyCompletePath)) {
      const retry = fs.existsSync(this.legacyPendingPath);
      const entries = fs.readdirSync(this.baseDir).filter(isLegacyRootEntry);
      if (entries.length === 0) {
        fs.writeFileSync(this.legacyCompletePath, '1'); if (retry) fs.unlinkSync(this.legacyPendingPath);
        this.migrateLegacySlotBackups(); return;
      }
      if (dirHasData(this.slotDir('slotB')) && !retry) throw new Error(`检测到旧版根目录仍有 ${entries.length} 个数据条目，但 slotB 已包含数据；为避免把不同时间线静默合并，已停止启动，请先备份并人工确认`);
      fs.writeFileSync(this.legacyPendingPath, '1'); const errors: string[] = [];
      for (const name of entries) {
        const source = path.join(this.baseDir, name), destination = path.join(this.slotDir('slotA'), name);
        if (fs.existsSync(destination)) {
          if (retry) {
            try { removePath(destination); } catch (error) { errors.push(`[DataSpace] 清理上次未完成迁移的目标失败 ${JSON.stringify(destination)}: ${errorText(error)}`); continue; }
          } else { errors.push(`[DataSpace] 旧版部分迁移存在源/目标冲突 ${JSON.stringify(source)} -> ${JSON.stringify(destination)}，拒绝覆盖可能已更新的数据`); continue; }
        }
        try { renameSyncWithRetry(source, destination); continue; }
        catch (error) { storageLog(LOG_TARGET, 'warn', `[DataSpace] rename 失败，尝试复制: ${errorText(error)}`); }
        if (isDirectory(source)) {
          try { copyDirectorySafe(source, this.slotDir('slotA')); } catch (error) { errors.push(`[DataSpace] 复制目录失败 ${JSON.stringify(source)}: ${errorText(error)}`); continue; }
          try { fs.rmSync(source, { recursive: true }); } catch (error) { errors.push(`[DataSpace] 迁移后清理源目录失败 ${JSON.stringify(source)}: ${errorText(error)}`); }
        } else {
          try { fs.mkdirSync(this.slotDir('slotA'), { recursive: true }); } catch (error) { errors.push(`[DataSpace] 创建目标目录失败 ${JSON.stringify(this.slotDir('slotA'))}: ${errorText(error)}`); continue; }
          try { fs.copyFileSync(source, destination); } catch (error) { errors.push(`[DataSpace] 复制文件失败 ${JSON.stringify(source)} -> ${JSON.stringify(destination)}: ${errorText(error)}`); continue; }
          try { fs.unlinkSync(source); } catch (error) { errors.push(`[DataSpace] 迁移后清理源文件失败 ${JSON.stringify(source)}: ${errorText(error)}`); }
        }
      }
      this.copyLegacySecurityEntries(retry, errors);
      if (errors.length) throw new Error(`数据迁移失败 (${errors.length} 个错误): ${errors.join('; ')}`);
      fs.writeFileSync(this.legacyCompletePath, '1'); fs.unlinkSync(this.legacyPendingPath);
    }
    this.migrateLegacySlotBackups();
  }
  /**
   * RUST-FIX(RF-W07-legacy-root-security-entries-copy): Rust 把根目录的 `.master_key`、`.secure` 当数据整体搬进 slotA，
   * 根目录的云凭据 SecureStore（`get_secure_store`）随之丢了种子。TS 把两者留在根目录（llm 主密钥、云凭据读根目录），
   * 另给 slotA 一份副本（主库 SecureStore 读 `db_path.parent()`；回退旧版时 LLMManager 读槽内主密钥）。
   */
  private copyLegacySecurityEntries(retry: boolean, errors: string[]): void {
    const slotA = this.slotDir('slotA');
    for (const [name, evidence] of [['.master_key', '.master_key'], ['.secure', path.join('.secure', '.key_seed')]] as const) {
      if (lstatOrNull(path.join(this.baseDir, evidence))?.isFile() !== true) continue;
      const source = path.join(this.baseDir, name), destination = path.join(slotA, name);
      if (lstatOrNull(destination) !== null) {
        if (!retry) continue;
        try { removePath(destination); } catch (error) { errors.push(`[DataSpace] 清理上次未完成迁移的目标失败 ${JSON.stringify(destination)}: ${errorText(error)}`); continue; }
      }
      try {
        copyPathDurable(source, destination);
        if (process.platform !== 'win32') fs.chmodSync(destination, fs.statSync(source).mode & 0o777);
      } catch (error) { errors.push(`[DataSpace] 复制安全文件失败 ${JSON.stringify(source)} -> ${JSON.stringify(destination)}: ${errorText(error)}`); }
    }
  }
  migrateLegacySlotBackups(): void {
    const recovery = path.join(this.baseDir, 'recovery'), root = this.recoveryBackupsDir;
    fs.mkdirSync(root, { recursive: true }); syncDirectory(recovery);
    const journalPath = path.join(recovery, '.slot_backup_migration.json');
    const journal = new Set(fs.existsSync(journalPath) ? readJson<string[]>(journalPath, '槽内备份迁移日志') : []);
    for (const slot of ['slotA', 'slotB'] as const) {
      const sourceRoot = path.join(this.slotDir(slot), 'backups'); if (!isDirectory(sourceRoot)) continue;
      for (const name of fs.readdirSync(sourceRoot)) {
        const source = path.join(sourceRoot, name), destination = path.join(root, name), key = `${slot}/${name}`;
        if (fs.existsSync(destination)) {
          if (!pathsEqual(source, destination)) throw new Error(`槽内备份迁移发现同名异内容产物，拒绝覆盖: ${source} -> ${destination}`);
        } else {
          const temporary = path.join(root, `.migrating-${slot}-${name}`); if (fs.existsSync(temporary)) removePath(temporary);
          copyPathDurable(source, temporary);
          if (!pathsEqual(source, temporary)) { removePath(temporary); throw new Error(`槽内备份复制校验失败: ${source}`); }
          renameSyncWithRetry(temporary, destination); syncDirectory(root);
        }
        if (!journal.has(key)) { journal.add(key); atomicWriteJson(journalPath, [...journal].sort()); syncDirectory(recovery); }
        removePath(source); syncDirectory(sourceRoot);
      }
      if (fs.readdirSync(sourceRoot).length === 0) { fs.rmdirSync(sourceRoot); syncDirectory(this.slotDir(slot)); }
    }
  }
  async initializeOnStart(): Promise<void> {
    this.ensureLayout(); const state = this.readState();
    if (state.pending !== null) {
      const pending = state.pending; state.pending = null; const target = slotFromName(pending);
      if (target && dirHasData(this.slotDir(target))) state.active = pending;
      this.writeState(state);
    }
    const lease = state.restore_cutover_pending;
    if (lease && state.active !== lease.target_slot) throw new Error(`恢复维护租约目标 ${lease.target_slot} 未激活（当前 ${state.active}），拒绝在不确定数据槽上启动`);
    await this.publication.recover(this.baseDir, lease ? [lease.backup_id, lease.target_slot] : null);
    const active = slotFromName(state.active); if (active) this.cleanupRestoreTrash(active);
  }
  inactiveSlot(): SlotName { return this.activeSlot() === 'slotA' ? 'slotB' : 'slotA'; }
  inactiveDir(): string { return this.slotDir(this.inactiveSlot()); }
  slotSize(slot: SlotName): number { return calculateDirSize(this.slotDir(slot)); }
  verifySlotIntegrity(slot: SlotName): SlotIntegrityReport {
    const dir = this.slotDir(slot);
    const r: SlotIntegrityReport = { slot, dir_path: dir, exists: false, has_data: false, has_database: false, database_files: [], subdirectories: [], total_size_bytes: 0, file_count: 0, issues: [] };
    if (!isDirectory(dir)) { r.issues.push('插槽目录不存在'); return r; }
    r.exists = true; r.has_data = dirHasData(dir);
    if (!r.has_data) { r.issues.push('插槽目录为空'); return r; }
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    for (const name of names) {
      const file = path.join(dir, name);
      if (isDirectory(file)) r.subdirectories.push(name);
      else if (isFile(file)) {
        r.file_count++;
        try { r.total_size_bytes += fs.lstatSync(file).size; }
        catch (error) { storageLog(LOG_TARGET, 'warn', `[DataSpace] 读取插槽条目大小失败 ${file}: ${errorText(error)}`); }
        if (/\.(db|sqlite|sqlite3)$/.test(name.toLowerCase())) r.database_files.push(name);
      }
    }
    for (const name of r.subdirectories) {
      try { r.total_size_bytes += calculateDirSize(path.join(dir, name)); }
      catch (error) { storageLog(LOG_TARGET, 'warn', `[DataSpace] 计算子目录大小失败 ${path.join(dir, name)}: ${errorText(error)}`); }
    }
    r.has_database = r.database_files.length > 0;
    if (!r.has_database) r.issues.push('未找到数据库文件 (*.db / *.sqlite / *.sqlite3)');
    return r;
  }
  cleanupRestoreTrash(target: SlotName): number {
    if (isTestSlot(target)) return 0;
    let removed = 0;
    for (const name of fs.readdirSync(this.slotsDir)) if (name.startsWith(`${target}.trash-`)) { removePath(path.join(this.slotsDir, name)); removed++; }
    return removed;
  }
  clearSlotForRestore(target: SlotName): string | null {
    if (!isTestSlot(target) && target === this.activeSlot()) throw new Error(`拒绝清空活跃插槽 ${target}：恢复必须写入非活跃插槽`);
    const dir = this.slotDir(target);
    if (!dirHasData(dir)) { fs.mkdirSync(dir, { recursive: true }); return null; }
    const trash = path.join(this.slotsDir, `${target}.trash-${timestampCompact()}-${randomUUID()}`);
    let renamed = false;
    try { renameSyncWithRetry(dir, trash); renamed = true; }
    catch (error) { storageLog(LOG_TARGET, 'warn', `[DataSpace] 移动插槽 ${target} 残留数据到 trash 失败（回退为逐条删除）: ${errorText(error)}`); }
    if (renamed) { fs.mkdirSync(dir, { recursive: true }); return trash; }
    const errors: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name); try { removePath(file); } catch (error) { errors.push(`${JSON.stringify(file)}: ${errorText(error)}`); }
    }
    if (errors.length) throw new Error(`清空插槽 ${target} 失败（${errors.length} 个条目无法删除，禁止在脏插槽上恢复）: ${errors.join('; ')}`);
    return null;
  }
  markPendingSwitch(target: SlotName): void {
    const dir = this.slotDir(target);
    if (!isDirectory(dir)) throw new Error(`目标插槽目录不存在: ${dir}，无法切换`);
    if (!dirHasData(dir)) throw new Error(`目标插槽 ${target} 目录为空，没有可用数据，无法切换`);
    const state = this.readState(); state.pending = target; this.writeState(state);
  }
  markRestoreCutoverPending(target: SlotName, backupId: string): void {
    if (!dirHasData(this.slotDir(target))) throw new Error(`恢复目标插槽 ${target} 不存在或为空`);
    if (!rustTrim(backupId)) throw new Error('恢复维护租约缺少 backup_id');
    const state = this.readState(), lease = state.restore_cutover_pending;
    if (lease && (lease.target_slot !== target || lease.backup_id !== backupId)) throw new Error(`已有恢复维护租约: backup=${lease.backup_id}, target=${lease.target_slot}`);
    state.pending = target; state.restore_cutover_pending = { target_slot: target, backup_id: backupId, created_at: utcNow(), activation_committed: false }; this.writeState(state);
  }
  restoreCutoverPending(): RestoreCutoverLease | null { return this.readState().restore_cutover_pending ?? null; }
  markRestoreActivationCommitted(activeDir: string, backupId: string): void {
    const state = this.readState(), slot = slotFromName(state.active);
    if (!slot) throw new Error('活动槽名称无效');
    if (this.slotDir(slot) !== activeDir) throw new Error('恢复维护租约的活动槽路径不匹配');
    const lease = state.restore_cutover_pending; if (!lease) throw new Error('恢复维护租约不存在');
    if (lease.target_slot !== state.active || lease.backup_id !== backupId) throw new Error('恢复维护租约与已激活槽不匹配');
    lease.activation_committed = true; this.writeState(state);
  }
  completeRestoreCutover(activeDir: string): boolean {
    const state = this.readState(), lease = state.restore_cutover_pending; if (!lease) return false;
    const slot = slotFromName(state.active); if (!slot) throw new Error('活动槽名称无效');
    if (lease.target_slot !== state.active || this.slotDir(slot) !== activeDir || !lease.activation_committed) throw new Error('恢复槽尚未完成激活、迁移与校验，拒绝解除维护租约');
    delete state.restore_cutover_pending; this.writeState(state); return true;
  }
  clearTestSlots(): void {
    for (const slot of ['slotC', 'slotD'] as const) { const dir = this.slotDir(slot); if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true }); fs.mkdirSync(dir, { recursive: true }); }
  }
}
