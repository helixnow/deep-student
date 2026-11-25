import type { BackupJobPhase } from '../api.ts';

export type BackupLocale = 'zh-CN' | 'en-US';

export interface SettingsReaderLike {
  get?(key: string): string | null;
}

export interface BackupLocaleContextLike {
  settings?: SettingsReaderLike | null;
}

export function normalizeBackupLocale(raw: string | null | undefined): BackupLocale | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (trimmed.startsWith('en')) return 'en-US';
  if (trimmed.startsWith('zh')) return 'zh-CN';
  return null;
}

/**
 * Resolves the UI locale for backup progress / status copy from host settings.
 * Falls back to 'zh-CN' when unset so existing headless/unit tests remain byte-compatible.
 */
export function resolveBackupLocale(
  ctx?: BackupLocaleContextLike | null,
  explicitLocale?: string | null,
): BackupLocale {
  const explicit = normalizeBackupLocale(explicitLocale);
  if (explicit) return explicit;
  try {
    const fromSettings = normalizeBackupLocale(ctx?.settings?.get?.('language'));
    if (fromSettings) return fromSettings;
  } catch {
    // Minimal test fixtures without settings fall back cleanly.
  }
  return 'zh-CN';
}

export type BackupProgressMessageKey =
  | 'backup.waiting_for_operation'
  | 'backup.cancelled_in_queue'
  | 'backup.job_cancelled'
  | 'backup.job_timeout'
  | 'backup.started'
  | 'backup.resumed'
  | 'backup.tiered.started'
  | 'backup.preparing'
  | 'backup.scanning_databases_and_assets'
  | 'backup.checkpointing_databases'
  | 'backup.staging_tiered'
  | 'backup.backing_up_core_databases'
  | 'backup.database_backed_up'
  | 'backup.backing_up_assets'
  | 'backup.backing_up_assets_ellipsis'
  | 'backup.verifying'
  | 'backup.verifying_ellipsis'
  | 'backup.completed_short'
  | 'backup.completed'
  | 'backup.completed_summary'
  | 'backup.tiered.completed'
  | 'backup.tiered.completed_summary'
  | 'backup.cancelled'
  | 'zip.export.started'
  | 'zip.export.scanning_backup_dir'
  | 'zip.export.sealing_full_start'
  | 'zip.export.sealing_full'
  | 'zip.export.sealing_secrets'
  | 'zip.export.precheck_portable'
  | 'zip.export.precheck_done'
  | 'zip.export.compressing_archive'
  | 'zip.export.compressing_entry'
  | 'zip.export.sealed_payload_written'
  | 'zip.export.publishing'
  | 'zip.export.computing_checksum'
  | 'zip.export.finalizing'
  | 'zip.export.completed_files'
  | 'zip.export.completed_path'
  | 'zip.export.completed_encrypted_restorable'
  | 'zip.export.completed_encrypted_partial'
  | 'zip.export.completed_portable'
  | 'zip.export.cancelled'
  | 'zip.backup_and_export.started'
  | 'zip.backup_and_export.completed'
  | 'zip.backup_and_export.completed_summary'
  | 'zip.backup_and_export.cancelled'
  | 'zip.import.started'
  | 'zip.import.resumed'
  | 'zip.import.validating'
  | 'zip.import.resuming_validating'
  | 'zip.import.validated'
  | 'zip.import.skipping_existing'
  | 'zip.import.extracting_entry'
  | 'zip.import.verifying_extracted'
  | 'zip.import.unsealed_verifying'
  | 'zip.import.verification_complete'
  | 'zip.import.cleaning_temp'
  | 'zip.import.completed_extracted'
  | 'zip.import.completed'
  | 'zip.import.completed_summary'
  | 'zip.import.cancelled'
  | 'restore.started'
  | 'restore.verifying_manifest'
  | 'restore.manifest_verified'
  | 'restore.verifying_file'
  | 'restore.restoring_database'
  | 'restore.databases_restored'
  | 'restore.restoring_assets'
  | 'restore.marking_slot_switch'
  | 'restore.creating_safety_snapshot'
  | 'restore.restoring_auxiliary_domains'
  | 'restore.recording_audit_log'
  | 'restore.completed'
  | 'restore.completed_detail'
  | 'restore.cancelled'
  | 'restore.cancelled_verify'
  | 'restore.cancelled_assets'
  | 'auto_backup.building_snapshot'
  | 'auto_backup.verifying_snapshot'
  | 'auto_backup.compressing_and_publishing'
  | 'auto_backup.completed'
  | 'auto_backup.completed_encrypted'
  | 'auto_backup.completed_portable';

export interface BackupProgressMessageParams {
  id?: string;
  backupId?: string;
  databaseCount?: number;
  backupSize?: string | number | bigint;
  fileCount?: number;
  totalEntries?: number;
  uncompressed?: string | number | bigint;
  entry?: string;
  processed?: number;
  total?: number;
  zipPath?: string;
  zipName?: string;
  ratioPercent?: string;
  compressedSize?: number | bigint;
  restorable?: boolean;
  totalFiles?: number;
  index?: number;
  totalDatabases?: number;
  assetFileCount?: number;
  path?: string;
  dbId?: string;
  restored?: number;
  workspaces?: number;
  databases?: string;
  restoredAssets?: number;
  isolatedDomains?: string;
}

export function formatBackupProgressMessage(
  locale: BackupLocale,
  key: BackupProgressMessageKey,
  params: BackupProgressMessageParams = {},
): string {
  const en = locale === 'en-US';
  switch (key) {
    case 'backup.waiting_for_operation':
      return en
        ? 'Waiting for another backup or restore operation to finish...'
        : '正在等待其他备份/恢复任务完成...';
    case 'backup.cancelled_in_queue':
      return en ? 'Operation cancelled by user' : '用户取消任务';
    case 'backup.job_cancelled':
      return en ? 'Job cancelled' : '任务已取消';
    case 'backup.job_timeout':
      return en ? 'Job timed out' : '任务执行超时';
    case 'backup.started':
      return en
        ? 'Backup job started; progress is reported via backup-job-progress events'
        : '备份任务已启动，请通过 backup-job-progress 事件监听进度';
    case 'backup.resumed':
      return en
        ? 'Backup job resumed and will re-run with the same parameters'
        : '备份任务已恢复，将使用相同参数重新执行';
    case 'backup.tiered.started':
      return en
        ? 'Tiered backup job started; progress is reported via backup-job-progress events'
        : '分层备份任务已启动，请通过 backup-job-progress 事件监听进度';
    case 'backup.preparing':
      return en ? 'Preparing backup...' : '正在准备备份...';
    case 'backup.scanning_databases_and_assets':
      return en ? 'Scanning databases and assets...' : '正在扫描数据库和资产...';
    case 'backup.checkpointing_databases':
      return en ? 'Running database checkpoint...' : '正在执行数据库 checkpoint...';
    case 'backup.staging_tiered':
      return en
        ? 'Staging tiered data and computing checksums inside consistency barrier...'
        : '一致性屏障内：正在 staging 分层数据并计算哈希...';
    case 'backup.backing_up_core_databases':
      return en ? 'Backing up core databases' : '正在备份核心数据库';
    case 'backup.database_backed_up':
      return en ? `Backed up database ${params.id ?? ''}` : `已备份数据库 ${params.id ?? ''}`;
    case 'backup.backing_up_assets':
      return en ? 'Backing up asset files' : '正在备份资产文件';
    case 'backup.backing_up_assets_ellipsis':
      return en ? 'Backing up asset files...' : '正在备份资产文件...';
    case 'backup.verifying':
      return en ? 'Verifying backup' : '正在校验备份';
    case 'backup.verifying_ellipsis':
      return en ? 'Verifying backup...' : '正在验证备份...';
    case 'backup.completed_short':
      return en ? 'Backup complete' : '备份完成';
    case 'backup.completed':
      return en ? `Backup complete: ${params.backupId ?? ''}` : `备份完成: ${params.backupId ?? ''}`;
    case 'backup.completed_summary':
      return en
        ? `Backup complete: ${params.databaseCount ?? 0} databases, ${params.backupSize ?? 0} bytes`
        : `备份完成: ${params.databaseCount ?? 0} 个数据库, ${params.backupSize ?? 0} 字节`;
    case 'backup.tiered.completed':
      return en
        ? `Tiered backup complete: ${params.backupId ?? ''} (${params.fileCount ?? 0} files)`
        : `分层备份完成: ${params.backupId ?? ''}，共 ${params.fileCount ?? 0} 个文件`;
    case 'backup.tiered.completed_summary':
      return en
        ? `Tiered backup complete: ${params.fileCount ?? 0} files, ${params.backupSize ?? 0} bytes`
        : `分层备份完成，共 ${params.fileCount ?? 0} 个文件，大小 ${params.backupSize ?? 0} 字节`;
    case 'backup.cancelled':
      return en ? 'Backup cancelled by user' : '用户取消备份';

    case 'zip.export.started':
      return en
        ? 'ZIP export job started; progress is reported via backup-job-progress events'
        : 'ZIP 导出任务已启动，请通过 backup-job-progress 事件监听进度';
    case 'zip.export.scanning_backup_dir':
      return en ? 'Scanning backup directory...' : '正在扫描备份目录...';
    case 'zip.export.sealing_full_start':
      return en
        ? 'Sealing sensitive data and building encrypted full-fidelity ZIP...'
        : '正在密封敏感数据并生成加密全保真 ZIP...';
    case 'zip.export.sealing_full':
      return en ? 'Encrypting and sealing full backup archive...' : '正在全量加密封存备份内容...';
    case 'zip.export.sealing_secrets':
      return en ? 'Sealing sensitive data into encrypted payload...' : '正在密封敏感数据为加密载荷...';
    case 'zip.export.precheck_portable':
      return en
        ? 'Generating portable manifest and pre-checking export sources...'
        : '正在生成便携清单并预检导出源...';
    case 'zip.export.precheck_done':
      return en
        ? `Export precheck complete: ${params.totalEntries ?? 0} entries, ${params.uncompressed ?? 0} bytes`
        : `导出预检完成: ${params.totalEntries ?? 0} 个条目, ${params.uncompressed ?? 0} 字节`;
    case 'zip.export.compressing_archive':
      return en ? 'Compressing ZIP archive...' : '正在压缩 ZIP 文件...';
    case 'zip.export.compressing_entry':
      return en
        ? `Compressing: ${params.entry ?? ''} (${params.processed ?? 0}/${params.total ?? 0})`
        : `正在压缩: ${params.entry ?? ''} (${params.processed ?? 0}/${params.total ?? 0})`;
    case 'zip.export.sealed_payload_written':
      return en ? 'Encrypted sensitive data payload written' : '已写入加密敏感数据载荷';
    case 'zip.export.publishing':
      return en ? 'Verifying and publishing ZIP archive...' : '正在自检并发布 ZIP 文件...';
    case 'zip.export.computing_checksum':
      return en ? 'Computing ZIP checksum...' : '正在计算 ZIP 校验和...';
    case 'zip.export.finalizing':
      return en ? 'Finalizing export...' : '正在完成导出...';
    case 'zip.export.completed_files':
      return en
        ? `ZIP export complete (${params.fileCount ?? 0} files)`
        : `ZIP 导出完成，共 ${params.fileCount ?? 0} 个文件`;
    case 'zip.export.completed_path':
      return en ? `ZIP export complete: ${params.zipPath ?? ''}` : `ZIP 导出完成: ${params.zipPath ?? ''}`;
    case 'zip.export.completed_encrypted_restorable':
      return en
        ? 'Encrypted full-fidelity ZIP export complete: enter the backup password on import for full-slot restore'
        : '加密全保真 ZIP 导出完成：导入时输入备份密码后可整槽恢复';
    case 'zip.export.completed_encrypted_partial':
      return en
        ? 'Encrypted ZIP export complete: source backup is not a full snapshot, so it remains a partial archive on import'
        : '加密 ZIP 导出完成：源备份不是完整快照，导入后仍为部分归档';
    case 'zip.export.completed_portable':
      return en
        ? `ZIP export complete: ${params.fileCount ?? 0} files, ${params.ratioPercent ?? '0.0'}% compression (portable archive: excludes encryption keys and cannot be full-slot restored)`
        : `ZIP 导出完成: ${params.fileCount ?? 0} 个文件, 压缩率 ${params.ratioPercent ?? '0.0'}%（便携归档：不含密钥等敏感数据，导入后不能整槽恢复）`;
    case 'zip.export.cancelled':
      return en ? 'ZIP export cancelled by user' : '用户取消 ZIP 导出';

    case 'zip.backup_and_export.started':
      return en
        ? 'Backup and ZIP export job started; progress is reported via backup-job-progress events'
        : '备份导出任务已启动，请通过 backup-job-progress 事件监听进度';
    case 'zip.backup_and_export.completed':
      return en ? 'Backup and ZIP export complete' : '备份并导出 ZIP 完成';
    case 'zip.backup_and_export.completed_summary':
      return en
        ? `Backup and export complete: ${params.fileCount ?? 0} files, ${params.compressedSize ?? 0} bytes (${params.restorable ? 'encrypted full-fidelity ZIP: enter backup password on import for full-slot restore' : 'portable archive: excludes encryption keys and cannot be full-slot restored'})`
        : `备份并导出完成: ${params.fileCount ?? 0} 个文件，${params.compressedSize ?? 0} 字节${params.restorable ? '（加密全保真 ZIP：导入时输入备份密码后可整槽恢复）' : '（便携归档：不含密钥等敏感数据，导入后不能整槽恢复）'}`;
    case 'zip.backup_and_export.cancelled':
      return en ? 'Backup export cancelled by user' : '用户取消备份导出';

    case 'zip.import.started':
      return en
        ? 'ZIP import job started; progress is reported via backup-job-progress events'
        : 'ZIP 导入任务已启动，请通过 backup-job-progress 事件监听进度';
    case 'zip.import.resumed':
      return en
        ? 'Import job resumed from checkpoint'
        : '导入任务已恢复，将从断点继续解压';
    case 'zip.import.validating':
      return en ? 'Validating ZIP archive...' : '正在验证 ZIP 文件...';
    case 'zip.import.resuming_validating':
      return en
        ? 'Resuming from checkpoint and validating ZIP archive...'
        : '从检查点恢复，正在验证 ZIP 文件...';
    case 'zip.import.validated':
      return en
        ? `ZIP archive validated (${params.totalFiles ?? 0} files)`
        : `ZIP 文件验证完成，共 ${params.totalFiles ?? 0} 个文件`;
    case 'zip.import.skipping_existing':
      return en
        ? `Skipping existing: ${params.entry ?? ''} (${params.index ?? 0}/${params.total ?? 0})`
        : `跳过已存在: ${params.entry ?? ''} (${params.index ?? 0}/${params.total ?? 0})`;
    case 'zip.import.extracting_entry':
      return en
        ? `Extracting: ${params.entry ?? ''} (${params.index ?? 0}/${params.total ?? 0})`
        : `正在解压: ${params.entry ?? ''} (${params.index ?? 0}/${params.total ?? 0})`;
    case 'zip.import.verifying_extracted':
      return en ? 'Verifying extracted files...' : '正在验证解压的文件...';
    case 'zip.import.unsealed_verifying':
      return en
        ? 'Encrypted sensitive data unsealed; verifying against original manifest...'
        : '已解封加密敏感数据，正在按原始清单验证...';
    case 'zip.import.verification_complete':
      return en ? 'File verification complete' : '文件验证完成';
    case 'zip.import.cleaning_temp':
      return en ? 'Cleaning up temporary files...' : '正在清理临时文件...';
    case 'zip.import.completed_extracted':
      return en
        ? `ZIP import complete (${params.fileCount ?? 0} files extracted)`
        : `ZIP 导入完成，共解压 ${params.fileCount ?? 0} 个文件`;
    case 'zip.import.completed':
      return en
        ? `ZIP import succeeded: ${params.fileCount ?? 0} files`
        : `ZIP 导入成功: ${params.fileCount ?? 0} 个文件`;
    case 'zip.import.completed_summary':
      return en
        ? `ZIP import succeeded: ${params.fileCount ?? 0} files, backup ID: ${params.backupId ?? ''} (${params.restorable ? 'full snapshot, eligible for full-slot restore' : 'partial archive, cannot be full-slot restored'})`
        : `ZIP 导入成功: ${params.fileCount ?? 0} 个文件, 备份 ID: ${params.backupId ?? ''}${params.restorable ? '（完整快照，可整槽恢复）' : '（部分归档，不能整槽恢复）'}`;
    case 'zip.import.cancelled':
      return en ? 'Import cancelled by user' : '用户取消导入';

    case 'restore.started':
      return en
        ? 'Restore job started; progress is reported via backup-job-progress events'
        : '恢复任务已启动，请通过 backup-job-progress 事件监听进度';
    case 'restore.verifying_manifest':
      return en ? 'Verifying backup manifest...' : '正在验证备份清单...';
    case 'restore.manifest_verified':
      return en
        ? `Backup manifest verified: ${params.totalDatabases ?? 0} databases, ${params.assetFileCount ?? 0} asset files`
        : `备份清单验证通过: ${params.totalDatabases ?? 0} 个数据库, ${params.assetFileCount ?? 0} 个资产文件`;
    case 'restore.verifying_file':
      return en
        ? `Verifying: ${params.path ?? ''} (${params.index ?? 0}/${params.total ?? 0})`
        : `正在验证: ${params.path ?? ''} (${params.index ?? 0}/${params.total ?? 0})`;
    case 'restore.restoring_database':
      return en
        ? `Restoring database: ${params.dbId ?? ''} (${params.index ?? 0}/${params.total ?? 0})`
        : `正在恢复数据库: ${params.dbId ?? ''} (${params.index ?? 0}/${params.total ?? 0})`;
    case 'restore.databases_restored':
      return en
        ? `Databases restored: ${params.restored ?? 0}/${params.total ?? 0}, workspace databases: ${params.workspaces ?? 0}`
        : `数据库恢复完成: ${params.restored ?? 0}/${params.total ?? 0}，工作区数据库: ${params.workspaces ?? 0}`;
    case 'restore.restoring_assets':
      return en
        ? `Restoring asset files: ${params.restored ?? 0}/${params.total ?? 0}`
        : `正在恢复资产文件: ${params.restored ?? 0}/${params.total ?? 0}`;
    case 'restore.marking_slot_switch':
      return en ? 'Staging atomic slot switch...' : '正在标记插槽切换...';
    case 'restore.creating_safety_snapshot':
      return en ? 'Creating pre-restore safety snapshot...' : '正在创建恢复前安全快照...';
    case 'restore.restoring_auxiliary_domains':
      return en
        ? 'Restoring auxiliary domains (audit/settings/quarantine)...'
        : '正在恢复辅助域（审计/设置/待信任隔离）...';
    case 'restore.recording_audit_log':
      return en ? 'Recording audit log...' : '正在记录审计日志...';
    case 'restore.completed': {
      const isolated = params.isolatedDomains ? params.isolatedDomains : '';
      return en
        ? `Restore complete: ${params.databaseCount ?? 0} databases, ${params.restoredAssets ?? 0} asset files${isolated ? `; quarantined pending trust: ${isolated}` : ''}`
        : `恢复完成，已恢复 ${params.databaseCount ?? 0} 个数据库，资产文件 ${params.restoredAssets ?? 0} 个${isolated ? `；隔离待信任: ${isolated}` : ''}`;
    }
    case 'restore.completed_detail': {
      const isolated = params.isolatedDomains ? params.isolatedDomains : '';
      return en
        ? `Restored databases: ${params.databases ?? ''}; asset files: ${params.restoredAssets ?? 0}${isolated ? `; quarantined pending trust: ${isolated}` : ''}`
        : `已恢复数据库: ${params.databases ?? ''}；资产文件: ${params.restoredAssets ?? 0}${isolated ? `；隔离待信任: ${isolated}` : ''}`;
    }
    case 'restore.cancelled':
      return en ? 'Restore cancelled by user' : '用户取消恢复';
    case 'restore.cancelled_verify':
      return en ? 'Restore cancelled by user (verification stage)' : '用户取消恢复（验证阶段）';
    case 'restore.cancelled_assets':
      return en ? 'Restore cancelled by user (assets stage)' : '用户取消恢复（资产阶段）';

    case 'auto_backup.building_snapshot':
      return en ? 'Auto backup: creating consistent snapshot' : '自动灾备：正在建立一致性快照';
    case 'auto_backup.verifying_snapshot':
      return en
        ? 'Consistency barrier released; verifying snapshot integrity'
        : '一致性屏障已解除；资产与数据库必须同属一个快照，因此快照阶段无法进一步缩短';
    case 'auto_backup.compressing_and_publishing':
      return en
        ? 'Consistency barrier released; compressing and publishing auto backup'
        : '一致性屏障已解除；正在压缩并发布自动备份';
    case 'auto_backup.completed':
      return en ? `Auto backup complete: ${params.zipName ?? ''}` : `自动备份完成: ${params.zipName ?? ''}`;
    case 'auto_backup.completed_encrypted':
      return en
        ? 'Automatic disaster-recovery snapshot verified and published'
        : '自动灾备恢复点已验证并发布';
    case 'auto_backup.completed_portable':
      return en
        ? 'Automatic portable archive published (unencrypted ZIP excludes encryption keys and cannot be full-slot restored; API credentials must be re-entered after restore)'
        : '自动便携归档已发布（未加密 ZIP 不含密钥材料，导入后不能整槽恢复；恢复后需重新输入 API 凭据）';
  }
}

const EXACT_MESSAGE_KEY_MAP: ReadonlyMap<string, BackupProgressMessageKey> = new Map<string, BackupProgressMessageKey>([
  ['正在等待其他备份/恢复任务完成...', 'backup.waiting_for_operation'],
  ['Waiting for another backup or restore operation to finish...', 'backup.waiting_for_operation'],
  ['用户取消任务', 'backup.cancelled_in_queue'],
  ['Operation cancelled by user', 'backup.cancelled_in_queue'],
  ['正在准备备份...', 'backup.preparing'],
  ['Preparing backup...', 'backup.preparing'],
  ['正在扫描数据库和资产...', 'backup.scanning_databases_and_assets'],
  ['Scanning databases and assets...', 'backup.scanning_databases_and_assets'],
  ['正在执行数据库 checkpoint...', 'backup.checkpointing_databases'],
  ['Running database checkpoint...', 'backup.checkpointing_databases'],
  ['一致性屏障内：正在 staging 分层数据并计算哈希...', 'backup.staging_tiered'],
  ['Staging tiered data and computing checksums inside consistency barrier...', 'backup.staging_tiered'],
  ['正在备份核心数据库', 'backup.backing_up_core_databases'],
  ['Backing up core databases', 'backup.backing_up_core_databases'],
  ['正在备份资产文件', 'backup.backing_up_assets'],
  ['Backing up asset files', 'backup.backing_up_assets'],
  ['正在备份资产文件...', 'backup.backing_up_assets_ellipsis'],
  ['Backing up asset files...', 'backup.backing_up_assets_ellipsis'],
  ['正在校验备份', 'backup.verifying'],
  ['Verifying backup', 'backup.verifying'],
  ['正在验证备份...', 'backup.verifying_ellipsis'],
  ['Verifying backup...', 'backup.verifying_ellipsis'],
  ['备份完成', 'backup.completed_short'],
  ['Backup complete', 'backup.completed_short'],
  ['正在扫描备份目录...', 'zip.export.scanning_backup_dir'],
  ['Scanning backup directory...', 'zip.export.scanning_backup_dir'],
  ['正在密封敏感数据并生成加密全保真 ZIP...', 'zip.export.sealing_full_start'],
  ['Sealing sensitive data and building encrypted full-fidelity ZIP...', 'zip.export.sealing_full_start'],
  ['正在全量加密封存备份内容...', 'zip.export.sealing_full'],
  ['Encrypting and sealing full backup archive...', 'zip.export.sealing_full'],
  ['正在密封敏感数据为加密载荷...', 'zip.export.sealing_secrets'],
  ['Sealing sensitive data into encrypted payload...', 'zip.export.sealing_secrets'],
  ['正在生成便携清单并预检导出源...', 'zip.export.precheck_portable'],
  ['Generating portable manifest and pre-checking export sources...', 'zip.export.precheck_portable'],
  ['正在压缩 ZIP 文件...', 'zip.export.compressing_archive'],
  ['Compressing ZIP archive...', 'zip.export.compressing_archive'],
  ['已写入加密敏感数据载荷', 'zip.export.sealed_payload_written'],
  ['Encrypted sensitive data payload written', 'zip.export.sealed_payload_written'],
  ['正在自检并发布 ZIP 文件...', 'zip.export.publishing'],
  ['Verifying and publishing ZIP archive...', 'zip.export.publishing'],
  ['正在计算 ZIP 校验和...', 'zip.export.computing_checksum'],
  ['Computing ZIP checksum...', 'zip.export.computing_checksum'],
  ['正在完成导出...', 'zip.export.finalizing'],
  ['Finalizing export...', 'zip.export.finalizing'],
  ['备份并导出 ZIP 完成', 'zip.backup_and_export.completed'],
  ['Backup and ZIP export complete', 'zip.backup_and_export.completed'],
  ['正在验证 ZIP 文件...', 'zip.import.validating'],
  ['Validating ZIP archive...', 'zip.import.validating'],
  ['从检查点恢复，正在验证 ZIP 文件...', 'zip.import.resuming_validating'],
  ['Resuming from checkpoint and validating ZIP archive...', 'zip.import.resuming_validating'],
  ['正在验证解压的文件...', 'zip.import.verifying_extracted'],
  ['Verifying extracted files...', 'zip.import.verifying_extracted'],
  ['已解封加密敏感数据，正在按原始清单验证...', 'zip.import.unsealed_verifying'],
  ['Encrypted sensitive data unsealed; verifying against original manifest...', 'zip.import.unsealed_verifying'],
  ['文件验证完成', 'zip.import.verification_complete'],
  ['File verification complete', 'zip.import.verification_complete'],
  ['正在清理临时文件...', 'zip.import.cleaning_temp'],
  ['Cleaning up temporary files...', 'zip.import.cleaning_temp'],
  ['正在验证备份清单...', 'restore.verifying_manifest'],
  ['Verifying backup manifest...', 'restore.verifying_manifest'],
  ['正在标记插槽切换...', 'restore.marking_slot_switch'],
  ['Staging atomic slot switch...', 'restore.marking_slot_switch'],
  ['正在创建恢复前安全快照...', 'restore.creating_safety_snapshot'],
  ['Creating pre-restore safety snapshot...', 'restore.creating_safety_snapshot'],
  ['正在恢复辅助域（审计/设置/待信任隔离）...', 'restore.restoring_auxiliary_domains'],
  ['Restoring auxiliary domains (audit/settings/quarantine)...', 'restore.restoring_auxiliary_domains'],
  ['正在记录审计日志...', 'restore.recording_audit_log'],
  ['Recording audit log...', 'restore.recording_audit_log'],
  ['自动灾备：正在建立一致性快照', 'auto_backup.building_snapshot'],
  ['Auto backup: creating consistent snapshot', 'auto_backup.building_snapshot'],
  ['一致性屏障已解除；资产与数据库必须同属一个快照，因此快照阶段无法进一步缩短', 'auto_backup.verifying_snapshot'],
  ['Consistency barrier released; verifying snapshot integrity', 'auto_backup.verifying_snapshot'],
  ['一致性屏障已解除；正在压缩并发布自动备份', 'auto_backup.compressing_and_publishing'],
  ['Consistency barrier released; compressing and publishing auto backup', 'auto_backup.compressing_and_publishing'],
]);

const PREFIX_MESSAGE_KEY_RULES: ReadonlyArray<readonly [string, BackupProgressMessageKey]> = [
  ['已备份数据库 ', 'backup.database_backed_up'],
  ['Backed up database ', 'backup.database_backed_up'],
  ['导出预检完成:', 'zip.export.precheck_done'],
  ['Export precheck complete:', 'zip.export.precheck_done'],
  ['正在压缩:', 'zip.export.compressing_entry'],
  ['Compressing:', 'zip.export.compressing_entry'],
  ['ZIP 导出完成，共', 'zip.export.completed_files'],
  ['ZIP export complete (', 'zip.export.completed_files'],
  ['ZIP 导出完成:', 'zip.export.completed_path'],
  ['ZIP export complete:', 'zip.export.completed_path'],
  ['ZIP 文件验证完成', 'zip.import.validated'],
  ['ZIP archive validated', 'zip.import.validated'],
  ['跳过已存在:', 'zip.import.skipping_existing'],
  ['Skipping existing:', 'zip.import.skipping_existing'],
  ['正在解压:', 'zip.import.extracting_entry'],
  ['Extracting:', 'zip.import.extracting_entry'],
  ['ZIP 导入完成，共解压', 'zip.import.completed_extracted'],
  ['ZIP import complete (', 'zip.import.completed_extracted'],
  ['ZIP 导入成功:', 'zip.import.completed'],
  ['ZIP import succeeded:', 'zip.import.completed'],
  ['备份清单验证通过:', 'restore.manifest_verified'],
  ['Backup manifest verified:', 'restore.manifest_verified'],
  ['正在验证:', 'restore.verifying_file'],
  ['Verifying:', 'restore.verifying_file'],
  ['正在恢复数据库:', 'restore.restoring_database'],
  ['Restoring database:', 'restore.restoring_database'],
  ['数据库恢复完成:', 'restore.databases_restored'],
  ['Databases restored:', 'restore.databases_restored'],
  ['正在恢复资产文件:', 'restore.restoring_assets'],
  ['Restoring asset files:', 'restore.restoring_assets'],
  ['恢复完成，已恢复', 'restore.completed'],
  ['Restore complete:', 'restore.completed'],
  ['分层备份完成:', 'backup.tiered.completed'],
  ['Tiered backup complete:', 'backup.tiered.completed'],
  ['备份完成:', 'backup.completed'],
  ['Backup complete:', 'backup.completed'],
  ['自动备份完成:', 'auto_backup.completed'],
  ['Auto backup complete:', 'auto_backup.completed'],
];

/**
 * Infers a stable structured message key for a backup progress event so frontends can
 * also localize or classify progress updates cleanly without brittle substring matching.
 */
export function inferBackupProgressMessageKey(
  phase: BackupJobPhase,
  message: string | null | undefined,
): BackupProgressMessageKey | null {
  if (!message) {
    if (phase === 'queued') return 'backup.waiting_for_operation';
    if (phase === 'completed') return 'backup.completed_short';
    if (phase === 'cancelled') return 'backup.job_cancelled';
    return null;
  }
  const exact = EXACT_MESSAGE_KEY_MAP.get(message);
  if (exact) return exact;
  for (const [prefix, key] of PREFIX_MESSAGE_KEY_RULES) {
    if (message.startsWith(prefix)) return key;
  }
  return null;
}

export function backupPhaseStageCode(phase: BackupJobPhase): BackupJobPhase {
  return phase;
}
