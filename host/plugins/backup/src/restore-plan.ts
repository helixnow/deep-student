/**
 * `backup/restore_plan.rs`：DomainRestorePlan 消费、隔离待信任域与未消费断言。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import {
  archivePathRequiresExplicitTrust, assertNoUnconsumedCompleteDomains, domainRestorePlan,
  persistentDomainRegistry, validateSafeRelativePath,
  type BackupManifest, type CoverageStatus, type DomainRestorePlan,
  type PersistentDomainSpec,
} from './manifest.ts';
import { resolveExistingBackupFile } from './backup-manager.ts';
import { copyVerified, prepareBackupRestoreDestination, sha256FileExactAsync } from './restore-files.ts';
import {
  RESTORE_DOMAIN_FAILED_CODE, RESTORE_DOMAIN_UNCONSUMED_CODE, RESTORE_UNTRUSTED_ISOLATED_CODE,
  taggedMessage,
} from './restore-codes.ts';
import { ioMessage } from './io.ts';

export const RESTORE_PENDING_TRUST_DIR_NAME = '.restore_pending_trust';

export type DomainRestoreOutcomeState =
  | 'restored' | 'merged' | 'isolated_pending_trust' | 'failed' | 'skipped_absent' | 'skipped_excluded';

export interface DomainRestoreReport {
  domain_id: string;
  state: DomainRestoreOutcomeState;
  restored_files: number;
  restored_bytes: number;
  target?: string;
  code?: string;
  detail?: string;
}

function skipped(domainId: string, state: DomainRestoreOutcomeState, detail: string): DomainRestoreReport {
  return { domain_id: domainId, state, restored_files: 0, restored_bytes: 0, detail };
}

function failed(domainId: string, code: string, detail: string): DomainRestoreReport {
  return { domain_id: domainId, state: 'failed', restored_files: 0, restored_bytes: 0, code, detail };
}

function isPrimaryOrchestration(spec: PersistentDomainSpec): boolean {
  return spec.id.startsWith('database:') || spec.id === 'workspaces-root'
    || spec.id.startsWith('asset-root:');
}

function dataDomainSlotRelativePath(spec: PersistentDomainSpec, archivePath: string): string {
  let relative: string;
  if (archivePath === spec.archive_root) relative = spec.restore_target;
  else if (archivePath.startsWith(`${spec.archive_root}/`)) {
    relative = join(spec.restore_target, archivePath.slice(spec.archive_root.length + 1));
  } else {
    throw new Error(`持久域 ${spec.id} 的恢复计划包含越界归档路径: ${archivePath}`);
  }
  validateSafeRelativePath(relative.replace(/\\/g, '/'));
  return relative;
}

function primarySlotRelativePath(
  spec: PersistentDomainSpec,
  manifest: BackupManifest,
  archivePath: string,
): string {
  let relative: string;
  if (spec.id.startsWith('database:')) relative = spec.restore_target;
  else if (spec.id === 'workspaces-root') relative = archivePath;
  else {
    const asset = manifest.assets?.files.find(candidate =>
      candidate.relative_path === archivePath && !candidate.is_directory);
    relative = asset?.original_path
      ?? (archivePath.startsWith('assets/') ? archivePath.slice('assets/'.length) : archivePath);
  }
  validateSafeRelativePath(relative.replace(/\\/g, '/'));
  return relative;
}

function statusText(status: CoverageStatus): string {
  return status;
}

async function restoreDataDomain(
  spec: PersistentDomainSpec,
  plan: DomainRestorePlan,
  backupSubdir: string,
  targetDir: string,
): Promise<DomainRestoreReport> {
  let restoredBytes = 0;
  for (const file of plan.files) {
    if (archivePathRequiresExplicitTrust(file.path)) {
      throw new Error(`Data 域 ${spec.id} 的恢复计划引用需显式信任的可执行路径: ${file.path}`);
    }
    const relative = dataDomainSlotRelativePath(spec, file.path);
    const source = resolveExistingBackupFile(backupSubdir, file.path);
    const destination = prepareBackupRestoreDestination(targetDir, relative);
    await copyVerified(source, destination, spec.id, file);
    restoredBytes += file.size;
  }
  return {
    domain_id: spec.id,
    state: 'restored',
    restored_files: plan.files.length,
    restored_bytes: restoredBytes,
    target: spec.restore_target,
  };
}

/** `restore_audit_db`（mod.rs:4098-4124）：经目标连接的 SQLite Backup API 写入，目标残留的 `-wal` 由目标连接接管。 */
async function restoreAuditDb(
  appDataRoot: string,
  backupSubdir: string,
): Promise<boolean> {
  const source = join(backupSubdir, 'databases', 'audit.db');
  if (!existsSync(source)) return false;
  const destination = join(appDataRoot, 'databases', 'audit.db');
  mkdirSync(join(appDataRoot, 'databases'), { recursive: true });
  const src = new Connection(source, { label: 'restore-audit-source', profile: PROFILES.plain, mustExist: true });
  try {
    await src.backupTo(destination);
  } finally {
    src.close();
  }
  return true;
}

async function restoreAuditDomain(
  spec: PersistentDomainSpec,
  plan: DomainRestorePlan,
  manifest: BackupManifest,
  backupSubdir: string,
  appDataRoot: string,
): Promise<DomainRestoreReport> {
  if (plan.status !== 'complete') {
    throw new Error(`audit restore plan 不可执行: ${statusText(plan.status)}`);
  }
  if (plan.archive_paths.length !== 1 || plan.archive_paths[0] !== 'databases/audit.db'
    || plan.files.length !== 1) {
    throw new Error(`audit restore plan 不可执行: ${statusText(plan.status)}`);
  }
  const file = plan.files[0]!;
  if (file.sha256 === null) throw new Error('audit restore plan 缺少 SHA-256');
  const source = resolveExistingBackupFile(backupSubdir, file.path);
  const size = statSync(source).size;
  const hash = await sha256FileExactAsync(source, file.size);
  if (size !== file.size || hash.toLowerCase() !== file.sha256.toLowerCase()) {
    throw new Error('audit restore plan 的文件大小或 SHA-256 不匹配');
  }
  if (!await restoreAuditDb(appDataRoot, backupSubdir)) {
    throw new Error('audit 域声明 Complete 但恢复入口未落盘任何文件');
  }
  return {
    domain_id: spec.id,
    state: 'restored',
    restored_files: plan.files.length,
    restored_bytes: plan.total_size,
    target: spec.restore_target,
    detail: '经 restore_audit_db_from_manifest 恢复到应用数据目录',
  };
}

async function isolateUntrustedDomain(
  spec: PersistentDomainSpec,
  plan: DomainRestorePlan,
  backupSubdir: string,
  targetDir: string,
): Promise<DomainRestoreReport> {
  const quarantineRelative = join(RESTORE_PENDING_TRUST_DIR_NAME, spec.id);
  let restoredBytes = 0;
  for (const file of plan.files) {
    const source = resolveExistingBackupFile(backupSubdir, file.path);
    const destinationRelative = join(quarantineRelative, file.path);
    const destination = prepareBackupRestoreDestination(targetDir, destinationRelative);
    await copyVerified(source, destination, spec.id, file);
    restoredBytes += file.size;
  }
  return {
    domain_id: spec.id,
    state: 'isolated_pending_trust',
    restored_files: plan.files.length,
    restored_bytes: restoredBytes,
    target: quarantineRelative.replace(/\\/g, '/'),
    code: RESTORE_UNTRUSTED_ISOLATED_CODE,
    detail: `可执行内容已完整隔离，等待显式信任决定后才可落地到 ${spec.restore_target}`,
  };
}

function verifyPrimaryOrchestrationDomain(
  spec: PersistentDomainSpec,
  plan: DomainRestorePlan,
  manifest: BackupManifest,
  targetDir: string,
): DomainRestoreReport {
  let verifiedFiles = 0;
  let verifiedBytes = 0;
  let isolatedOverlap = 0;
  const missing: string[] = [];
  for (const file of plan.files) {
    if (archivePathRequiresExplicitTrust(file.path)) {
      isolatedOverlap += 1;
      continue;
    }
    const relative = primarySlotRelativePath(spec, manifest, file.path);
    try {
      const metadata = lstatSync(join(targetDir, relative));
      if (!metadata.isFile()) throw new Error('not a file');
      verifiedFiles += 1;
      verifiedBytes += file.size;
    } catch {
      missing.push(relative.replace(/\\/g, '/'));
    }
  }
  if (missing.length > 0) {
    return failed(
      spec.id,
      RESTORE_DOMAIN_UNCONSUMED_CODE,
      taggedMessage(
        RESTORE_DOMAIN_UNCONSUMED_CODE,
        `域 ${spec.id} 声明 Complete，但候选槽缺少 ${missing.length} 个文件（如 ${missing[0]}）`,
      ),
    );
  }
  return {
    domain_id: spec.id,
    state: 'restored',
    restored_files: verifiedFiles,
    restored_bytes: verifiedBytes,
    target: spec.restore_target,
    detail: isolatedOverlap > 0
      ? `由主编排恢复并已验证存在性；${isolatedOverlap} 个待信任可执行文件由隔离路径处置`
      : '由主编排恢复并已验证存在性',
  };
}

async function consumeOneCompleteDomain(
  spec: PersistentDomainSpec,
  plan: DomainRestorePlan,
  manifest: BackupManifest,
  backupSubdir: string,
  targetDir: string,
  appDataRoot: string,
): Promise<DomainRestoreReport> {
  if (plan.files.length !== plan.archive_paths.length) {
    throw new Error(
      `域 ${spec.id} 的恢复计划文件元数据不完整: files=${plan.files.length}, archive_paths=${plan.archive_paths.length}`,
    );
  }
  if (spec.restore_trust === 'untrusted_executable') {
    return isolateUntrustedDomain(spec, plan, backupSubdir, targetDir);
  }
  if (spec.id === 'crypto') {
    return {
      domain_id: spec.id,
      state: 'restored',
      restored_files: plan.file_count,
      restored_bytes: plan.total_size,
      detail: '已由事务性密钥发布路径消费（密钥发布与切槽登记原子提交），本路径不重复写入',
    };
  }
  if (spec.id === 'audit') {
    return restoreAuditDomain(spec, plan, manifest, backupSubdir, appDataRoot);
  }
  if (isPrimaryOrchestration(spec)) {
    return verifyPrimaryOrchestrationDomain(spec, plan, manifest, targetDir);
  }
  if (spec.restore_trust === 'data' && spec.restore_scope === 'active_data_space') {
    return restoreDataDomain(spec, plan, backupSubdir, targetDir);
  }
  return failed(
    spec.id,
    RESTORE_DOMAIN_UNCONSUMED_CODE,
    taggedMessage(
      RESTORE_DOMAIN_UNCONSUMED_CODE,
      `Complete 域 ${spec.id} 没有已注册的消费路径（scope=${spec.restore_scope}, trust=${spec.restore_trust}）`,
    ),
  );
}

/** `BackupManager::consume_complete_domains`。 */
export async function consumeCompleteDomains(
  _ctx: Context,
  manifest: BackupManifest,
  backupSubdir: string,
  targetDir: string,
  appDataRoot: string,
): Promise<DomainRestoreReport[]> {
  const reports: DomainRestoreReport[] = [];
  for (const spec of persistentDomainRegistry()) {
    const plan = domainRestorePlan(manifest, spec.id);
    if (!plan) continue;
    let report: DomainRestoreReport;
    if (plan.status === 'absent' || plan.status === 'empty') {
      report = skipped(spec.id, 'skipped_absent', `备份声明该域为 ${plan.status}，无内容可恢复`);
    } else if (plan.status === 'excluded') {
      report = skipped(spec.id, 'skipped_excluded', '备份显式排除该域（Excluded）');
    } else if (plan.status === 'failed') {
      report = failed(
        spec.id,
        RESTORE_DOMAIN_FAILED_CODE,
        taggedMessage(RESTORE_DOMAIN_FAILED_CODE, `域 ${spec.id} 的备份侧覆盖证据为 Failed，不可恢复`),
      );
    } else {
      try {
        report = await consumeOneCompleteDomain(spec, plan, manifest, backupSubdir, targetDir, appDataRoot);
      } catch (error) {
        report = failed(
          spec.id,
          RESTORE_DOMAIN_FAILED_CODE,
          taggedMessage(
            RESTORE_DOMAIN_FAILED_CODE,
            `域 ${spec.id} 消费失败: ${ioMessage(error)}`,
          ),
        );
      }
    }
    reports.push(report);
  }
  return reports;
}

export { assertNoUnconsumedCompleteDomains };

/** 清理恢复目标中的陈旧可重建索引目录（`reset_rebuildable_vfs_index` 的目录部分）。 */
export function removeStaleVfsLanceDir(targetDir: string): void {
  const lanceDir = join(targetDir, 'databases', 'lance', 'vfs');
  if (existsSync(lanceDir)) rmSync(lanceDir, { recursive: true, force: true });
}

export function readFileText(path: string): string {
  return readFileSync(path, 'utf8');
}
