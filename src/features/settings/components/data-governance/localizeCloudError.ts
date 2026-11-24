/**
 * 云存储 / ZIP 备份错误的展示层映射。
 *
 * 短密码 / 读不到已存密码 / E2EE 三类失败优先按稳定 code 映射；
 * 接线前或旧客户端的中文诊断仍兜底。云设置页与本地 ZIP 导入导出共用这一层。
 */
import i18next from 'i18next';
import { getErrorMessage } from '@/utils/errorUtils';
import * as cloudApi from '@/utils/cloudStorageApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';

type NotificationType = 'success' | 'error' | 'info' | 'warning';
import {
  classifySyncE2eeError,
  classifySyncE2eeErrorCode,
  SYNC_E2EE_ERROR_I18N_KEYS,
} from './syncE2eeErrorMapping';

/** 与后端 `MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS` / ZIP `MIN_ENCRYPTION_PASSWORD_CHARS` 对齐。 */
export const CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS = 8;

/** [Wave2-R5] 与后端 `MIN_CLOUD_ENCRYPTION_PASSWORD_DISTINCT_CHARS` 对齐（弱口令熵下限）。 */
export const CLOUD_ENCRYPTION_PASSWORD_MIN_DISTINCT_CHARS = 4;

type Translate = (key: string, options?: Record<string, unknown>) => string;

function readCloudStorageErrorCode(error: unknown): string | undefined {
  try {
    return cloudApi.getCloudStorageErrorCode(error);
  } catch {
    // 部分 vitest mock 没导出该函数。
    return undefined;
  }
}

function readCloudEncryptionI18nKey(
  error: unknown,
): ReturnType<typeof cloudApi.getCloudEncryptionErrorI18nKey> {
  try {
    const mapped = cloudApi.getCloudEncryptionErrorI18nKey(error);
    if (mapped) return mapped;
  } catch {
    // 部分 vitest mock 没导出该函数；退回 message token。
  }
  const raw = getErrorMessage(error);
  if (raw.includes('E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT')) {
    return 'cloudStorage:encryption.tooShort';
  }
  if (raw.includes('E_CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK')) {
    return 'cloudStorage:encryption.tooWeak';
  }
  if (raw.includes('E_STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED')) {
    return 'cloudStorage:encryption.storedPasswordRequired';
  }
  return undefined;
}

export function isEnglishUiLanguage(language?: string): boolean {
  const candidate = language ?? (typeof i18next?.language === 'string' ? i18next.language : undefined);
  return typeof candidate === 'string' && candidate.toLowerCase().startsWith('en');
}

export function localizeBackendErrorText(raw: string, language?: string): string {
  if (!raw || !isEnglishUiLanguage(language)) return raw;
  let text = raw;

  // Progress & retry status messages
  text = text
    .replace(
      /云端请求暂不可用，(\d+)\s*秒后自动重试（第\s*(\d+\/\d+)\s*次）…?/g,
      'Cloud request temporarily unavailable, retrying in $1s (attempt $2)...',
    )
    .replace(
      /云端目录查询暂不可用，(\d+)\s*秒后自动重试（第\s*(\d+\/\d+)\s*次）…?/g,
      'Cloud directory check temporarily unavailable, retrying in $1s (attempt $2)...',
    )
    .replace(
      /云端上传暂不可用，(\d+)\s*秒后自动重试（第\s*(\d+\/\d+)\s*次）…?/g,
      'Cloud upload temporarily unavailable, retrying in $1s (attempt $2)...',
    )
    .replace(
      /云端限流保护，约\s*(\d+)\s*秒后自动继续…?/g,
      'Cloud rate-limit protection active, resuming in ~$1s...',
    )
    .replace(/上传批次\s*(\d+\/\d+)/g, 'Uploading batch $1');

  // Common WebDAV / Sync / Cloud Storage prefixes & error details
  const replacements: ReadonlyArray<[RegExp, string]> = [
    [/缺少 WebDAV 配置/g, 'Missing WebDAV configuration'],
    [/缺少 S3 配置/g, 'Missing S3 configuration'],
    [/缺少 FTP 配置/g, 'Missing FTP configuration'],
    [/WebDAV 密码不能为空/g, 'WebDAV password cannot be empty'],
    [/WebDAV 用户名不能为空/g, 'WebDAV username cannot be empty'],
    [/WebDAV endpoint 不能为空/g, 'WebDAV endpoint cannot be empty'],
    [/无效的 WebDAV endpoint/g, 'Invalid WebDAV endpoint'],
    [/S3 Secret Access Key 不能为空/g, 'S3 Secret Access Key cannot be empty'],
    [/FTP 密码不能为空/g, 'FTP password cannot be empty'],
    [/WebDAV\s+PROPFIND\s+([^\s:：]+)\s*失败（已重试\s*(\d+)\s*次）\s*[:：]\s*/g, 'WebDAV PROPFIND $1 failed (retried $2 times): '],
    [/WebDAV\s+PROPFIND\s*失败（已重试\s*(\d+)\s*次）\s*[:：]\s*/g, 'WebDAV PROPFIND failed (retried $1 times): '],
    [/WebDAV\s+PROPFIND\s+([^\s:：]+)\s*失败\s*[:：]?\s*/g, 'WebDAV PROPFIND $1 failed: '],
    [/WebDAV\s+PROPFIND\s*失败/g, 'WebDAV PROPFIND failed'],
    [/WebDAV\s+([A-Z]+)\s+请求失败（已重试\s*(\d+)\s*次）\s*[:：]\s*/g, 'WebDAV $1 request failed (retried $2 times): '],
    [/WebDAV\s+上传(?:\s+([^\s:：]+))?\s*失败（已重试\s*(\d+)\s*次）\s*[:：]?\s*/g, 'WebDAV upload $1 failed (retried $2 times): '],
    [/WebDAV\s+下载失败\s*[:：]?\s*/g, 'WebDAV download failed: '],
    [/WebDAV\s+服务暂不可用（([^）]+)），请稍后重试/g, 'WebDAV service temporarily unavailable ($1). Please try again later.'],
    [/WebDAV\s+同步目录不存在，且服务器暂时锁定资源（([^）]+)）：[^。.\n]*/g, 'WebDAV sync directory missing and locked ($1). Please try again later.'],
    [/WebDAV\s+同步目录不存在，且服务器正在限流（([^）]+)）：[^。.\n]*/g, 'WebDAV sync directory missing and rate-limited ($1). Please try again later.'],
    [/WebDAV\s+同步目录不存在且无法创建/g, 'WebDAV sync directory does not exist and could not be created'],
    [/服务端限流（未重试）/g, 'Rate limited by cloud server (not retried)'],
    [/服务端限流/g, 'Rate limited by cloud server'],
    [/检查云端变更断层失败\s*[:：]\s*/g, 'Failed to check cloud change log gaps: '],
    [/读取远端同步格式失败\s*[:：]\s*/g, 'Failed to read remote sync format: '],
    [/创建云存储失败\s*[:：]\s*/g, 'Failed to create cloud storage: '],
    [/上传文件失败\s*[:：]\s*/g, 'Failed to upload file: '],
    [/下载备份失败\s*[:：]\s*/g, 'Failed to download backup: '],
    [/备份数据库失败\s*[:：]\s*/g, 'Database backup failed: '],
    [/打包 ZIP 失败\s*[:：]\s*/g, 'Failed to package ZIP: '],
    [/导入 ZIP 失败\s*[:：]\s*/g, 'Failed to import ZIP: '],
    [/恢复数据库失败\s*[:：]\s*/g, 'Database restore failed: '],
    [/同步\s*schema\s*预检失败\s*[:：]\s*/g, 'Sync schema preflight failed: '],
    [/双向同步失败\s*[:：]\s*/g, 'Bidirectional sync failed: '],
    [/下载同步失败\s*[:：]\s*/g, 'Download sync failed: '],
    [/上传同步失败(?:（批次\s*(\d+\/\d+)）)?\s*[:：]\s*/g, 'Upload sync failed ($1): '],
    [/上传变更失败\s*[:：]\s*/g, 'Failed to upload changes: '],
    [/上传刷新清单失败\s*[:：]\s*/g, 'Failed to upload refreshed manifest: '],
    [/上传清单失败\s*[:：]\s*/g, 'Failed to upload manifest: '],
    [/同步未完全成功：部分步骤失败或有变更被跳过，请检查同步详情。?/g, 'Sync completed with partial errors or skipped changes. Please inspect sync details.'],
    [/同步已取消/g, 'Sync cancelled'],
    [/另一个数据治理任务（[^）]*）正在进行中，请稍后再试。?/g, 'Another data-governance operation is currently in progress. Please try again later.'],
    [/数据治理操作正在进行（维护模式），请稍后再试。?/g, 'A data-governance operation is in progress (maintenance mode). Please try again later.'],
    [/读取\s*PROPFIND\s*响应失败\s*[:：]\s*/g, 'Failed to read PROPFIND response: '],
    [/读取响应体失败\s*[:：]\s*/g, 'Failed to read response body: '],
    [/云端文件不存在/g, 'Cloud file not found'],
  ];

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\(\s*\)/g, '').replace(/:\s*$/, '').trim();
  if (/(?:HTTP\s*401|\b401\s*Unauthorized\b)/i.test(text) && !/app-specific password/i.test(text)) {
    text = `${text} (Check username and app-specific password)`;
  }
  return text;
}

let lastNotifiedKey = '';
let lastNotifiedAt = 0;

export function shouldNotifyDeduped(
  type: NotificationType,
  message: string,
  title?: string,
  windowMs = 300,
): boolean {
  const now = Date.now();
  const key = `${type}:${title ?? ''}:${message}`;
  if (key === lastNotifiedKey && now - lastNotifiedAt < windowMs) {
    return false;
  }
  lastNotifiedKey = key;
  lastNotifiedAt = now;
  return true;
}

export function notifyErrorDeduped(
  type: NotificationType,
  message: string,
  title?: string,
  windowMs = 300,
): void {
  if (!shouldNotifyDeduped(type, message, title, windowMs)) {
    return;
  }
  if (title !== undefined) {
    showGlobalNotification(type, message, title);
  } else {
    showGlobalNotification(type, message);
  }
}

export function localizeCloudStorageError(
  error: unknown,
  t: Translate,
  language?: string,
): string {
  const raw = getErrorMessage(error);
  const encryptionKey = readCloudEncryptionI18nKey(error);
  if (encryptionKey === 'cloudStorage:encryption.tooShort') {
    return t(encryptionKey, { min: CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS });
  }
  if (encryptionKey === 'cloudStorage:encryption.tooWeak') {
    return t(encryptionKey, {
      minDistinct: CLOUD_ENCRYPTION_PASSWORD_MIN_DISTINCT_CHARS,
    });
  }
  if (encryptionKey === 'cloudStorage:encryption.storedPasswordRequired') {
    return t(encryptionKey);
  }
  const e2eeKind =
    classifySyncE2eeErrorCode(readCloudStorageErrorCode(error)) ??
    classifySyncE2eeError(raw);
  if (e2eeKind) {
    return `${t(SYNC_E2EE_ERROR_I18N_KEYS[e2eeKind])}\n(${raw})`;
  }
  // 接线前/旧诊断仍可能没有稳定 code，保留中文片段兜底。
  if (/云端端到端加密密码至少需要|备份密码至少需要/.test(raw)) {
    return t('cloudStorage:encryption.tooShort', {
      min: CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS,
    });
  }
  if (/无法整槽恢复的便携归档当成加密全保真/.test(raw)) {
    return t('cloudStorage:encryption.storedPasswordRequired');
  }
  if (
    readCloudStorageErrorCode(error) === 'E_BACKUP_PARTIAL_ARCHIVE_NOT_SLOTABLE' ||
    /备份不能用于完整恢复|不是可替换数据槽的完整快照|partial archive 不能替换数据槽/.test(raw)
  ) {
    return t('cloudStorage:errors.partialArchiveNotSlotable');
  }
  switch (readCloudStorageErrorCode(error)) {
    case 'E_BACKUP_SEALED_PASSWORD_REQUIRED':
      return t('cloudStorage:errors.sealedBackupPasswordRequired');
    case 'E_BACKUP_SEALED_DECRYPT_FAILED':
      return t('cloudStorage:errors.sealedBackupDecryptFailed');
    case 'E_BACKUP_ATOMIC_RESTORE_UNAVAILABLE':
      return t('cloudStorage:errors.atomicRestoreUnavailable');
    // [R5-i18n] R4 新稳定码 + commands_backup / commands_zip 第一批 code-only。
    // 云端目录/对象状态类附上原文（排查需要对象 key 等细节）；
    // 本机配置/资源类只给人话，原文进日志即可。
    case 'E_SYNC_BAD_OBJECT_FAIL_CLOSED':
      return `${t('cloudStorage:errors.syncBadObjectFailClosed')}\n(${raw})`;
    case 'E_DG_TOMBSTONE_LIMITER_BUSY':
      return t('cloudStorage:errors.governanceBusy');
    case 'E_BACKUP_DIR_MISSING':
      return t('cloudStorage:errors.backupDirMissing');
    case 'E_RESTORE_DISK_BUDGET_OVERFLOW':
      return t('cloudStorage:errors.restoreDiskBudgetOverflow');
    case 'E_ZIP_EXPORT_TEMP_MISSING':
      return t('cloudStorage:errors.zipExportTempMissing');
    case 'E_ZIP_EXPORT_COPY_TARGET_FAILED':
      return `${t('cloudStorage:errors.zipExportCopyTargetFailed')}\n(${raw})`;
    // [R6-i18n] R4 verified_publish.rs 稳定码：发布前/后校验 fail-closed。
    // 云端对象状态类，附原文（排查需要对象 key、字节数等细节）。
    case 'E_VERIFIED_PUBLISH_MISMATCH':
      return `${t('cloudStorage:errors.verifiedPublishMismatch')}\n(${raw})`;
    case 'E_VERIFIED_PUBLISH_OVERSIZE':
      return `${t('cloudStorage:errors.verifiedPublishOversize')}\n(${raw})`;
    case 'E_VERIFIED_PUBLISH_UNCONDITIONAL_WRITE':
      return `${t('cloudStorage:errors.verifiedPublishUnconditionalWrite')}\n(${raw})`;
  }
  // 恢复域账本稳定码（src-tauri/src/data_governance/restore_codes.rs）。
  // 后台任务失败消息以 `[E_...] 说明` 形式携带稳定码，没有 CommandError
  // envelope，因此除 code 外还需子串兜底。
  const restoreLedgerCode = readCloudStorageErrorCode(error);
  if (
    restoreLedgerCode === 'E_RESTORE_DOMAIN_UNCONSUMED' ||
    raw.includes('E_RESTORE_DOMAIN_UNCONSUMED')
  ) {
    return t('cloudStorage:errors.restoreDomainUnconsumed');
  }
  if (
    restoreLedgerCode === 'E_RESTORE_DOMAIN_FAILED' ||
    raw.includes('E_RESTORE_DOMAIN_FAILED')
  ) {
    return t('cloudStorage:errors.restoreDomainFailed');
  }
  if (
    restoreLedgerCode === 'E_RESTORE_UNTRUSTED_ISOLATED' ||
    raw.includes('E_RESTORE_UNTRUSTED_ISOLATED')
  ) {
    return t('cloudStorage:errors.restoreUntrustedIsolated');
  }
  if (/Missing WebDAV configuration/.test(raw)) {
    return t('cloudStorage:errors.missingWebdavConfig');
  }
  if (/Missing S3 configuration/.test(raw)) {
    return t('cloudStorage:errors.missingS3Config');
  }
  if (/Missing FTP configuration/.test(raw)) {
    return t('cloudStorage:errors.missingFtpConfig');
  }
  const platformErrorKey = cloudApi.getCloudPlatformErrorI18nKey(error);
  if (platformErrorKey) return t(platformErrorKey);
  return localizeBackendErrorText(raw, language);
}
