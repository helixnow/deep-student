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

const FILE_SYNC_FALLBACK_LABELS: Record<
  string,
  { zh: string; en: string }
> = {
  'sync:fileSync.workspace': {
    zh: '文件级同步：工作区数据库',
    en: 'File sync: workspace databases',
  },
  'sync:fileSync.blob': {
    zh: '文件级同步：附件文件',
    en: 'File sync: attachments',
  },
  'sync:fileSync.assets': {
    zh: '文件级同步：资产目录',
    en: 'File sync: assets directory',
  },
  'sync:fileSync.complete': {
    zh: '文件级同步完成',
    en: 'File sync completed',
  },
  'sync:fileSync.transfer': {
    zh: '文件级传输',
    en: 'File transfer',
  },
  'sync:fileSync.applyingChanges': {
    zh: '应用变更',
    en: 'Applying changes',
  },
  'sync:fileSync.applyingDownloadedChanges': {
    zh: '应用下载变更',
    en: 'Applying downloaded changes',
  },
};

function localizeFileSyncProgressKey(
  raw: string,
  english: boolean,
  language?: string,
): string | null {
  if (!raw.startsWith('sync:fileSync.')) return null;
  const i18nMatchesLocale =
    typeof i18next?.language === 'string' &&
    i18next.language.toLowerCase().startsWith(english ? 'en' : 'zh');
  const readI18n = (key: string, defaultValue: string, extra?: Record<string, unknown>): string => {
    if (!i18next?.isInitialized) return defaultValue;
    if (!language || i18nMatchesLocale) {
      return i18next.t(key, { ...extra, defaultValue });
    }
    return i18next.t(key, { ...extra, lng: language, defaultValue });
  };
  if (raw.startsWith('sync:fileSync.transfer::')) {
    const item = raw.slice('sync:fileSync.transfer::'.length);
    const fallbackPrefix = english
      ? FILE_SYNC_FALLBACK_LABELS['sync:fileSync.transfer']!.en
      : FILE_SYNC_FALLBACK_LABELS['sync:fileSync.transfer']!.zh;
    const translatedPrefix = i18nMatchesLocale
      ? readI18n('sync:fileSync.transfer', fallbackPrefix)
      : fallbackPrefix;
    return english ? `${translatedPrefix}: ${item}` : `${translatedPrefix}：${item}`;
  }
  if (raw.startsWith('sync:fileSync.uploadBatch::')) {
    const batch = raw.slice('sync:fileSync.uploadBatch::'.length);
    const defaultLabel = english ? `Uploading batch ${batch}` : `上传批次 ${batch}`;
    return i18nMatchesLocale
      ? readI18n('sync:fileSync.uploadBatch', defaultLabel, { batch })
      : defaultLabel;
  }
  const fallback = FILE_SYNC_FALLBACK_LABELS[raw];
  const defaultValue = fallback ? (english ? fallback.en : fallback.zh) : raw;
  return i18nMatchesLocale ? readI18n(raw, defaultValue) : defaultValue;
}

/** Strip raw JS/Node stack traces, HTML error pages, and duplicate Error class wrappers. */
function stripRawErrorNoise(raw: string): string {
  let text = raw
    // Drop multi-line JS/Node stack traces (`\n    at fn (file:line:col)`)
    .replace(/\r?\n\s*at\s+[\s\S]*$/, '')
    // Drop raw HTML responses appended as server detail
    .replace(/[；;]\s*服务器详情\s*[:：]\s*<(?:!doctype|html|head|body)[\s\S]*$/i, '')
    .replace(/<(?:!doctype|html|head|body)[\s\S]*$/i, '')
    .replace(/^(?:(?:Command|CloudStorage|Sync|Type|Range|Network)?Error\s*:\s*)+/i, '')
    .trim();
  // Collapse multi-line whitespace noise into a clean single line
  text = text.replace(/\s*\r?\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return text;
}

export function localizeBackendErrorText(raw: string, language?: string): string {
  if (!raw) return raw;
  const english = isEnglishUiLanguage(language);
  const fileSyncLabel = localizeFileSyncProgressKey(raw, english, language);
  if (fileSyncLabel !== null) return fileSyncLabel;

  let text = stripRawErrorNoise(raw);
  if (!english) {
    return text
      .replace(/\[E_CLOUD_RATE_LIMITED\]\s*/g, '')
      .replace(/socket hang up/gi, '网络连接中断，请检查服务器或网络后重试')
      .replace(/(?<!\()\bECONNRESET\b(?!\))|(?<!\()connection reset by peer(?!\))/gi, '网络连接被重置，请检查服务器或网络后重试')
      .replace(/\bECONNREFUSED\b|connection refused/gi, '无法连接到服务器，请检查地址和端口')
      .replace(/\b(?:ETIMEDOUT|HeadersTimeoutError|BodyTimeoutError|UND_ERR_CONNECT_TIMEOUT)\b|operation timed out|request timeout/gi, '网络连接超时，请检查网络或稍后重试')
      .replace(/\b(?:ENOTFOUND|EAI_AGAIN)\b/gi, '无法解析服务器域名，请检查服务器地址和网络')
      .replace(/\b(?:EHOSTUNREACH|ENETUNREACH|ERR_NETWORK)\b|fetch failed|Failed to fetch|\bNetworkError\b/gi, '网络连接不可用，请检查网络设置后重试')
      .replace(/\b(?:EPIPE|ERR_SOCKET_CLOSED|UND_ERR_SOCKET)\b/gi, '网络连接意外断开，请稍后重试')
      .replace(/(?<!（)\bHTTP\s*503(?:\s+Service Unavailable)?\b(?!）)/gi, '云端服务暂时不可用（HTTP 503），请稍后重试')
      .replace(/(?<!（)\bHTTP\s*502(?:\s+Bad Gateway)?\b(?!）)/gi, '云端网关异常（HTTP 502），请稍后重试')
      .replace(/(?<!（)\bHTTP\s*504(?:\s+Gateway Timeout)?\b(?!）)/gi, '云端服务响应超时（HTTP 504），请稍后重试')
      .replace(/(?<!（)\bHTTP\s*500(?:\s+Internal Server Error)?\b(?!）)/gi, '云端服务器内部错误（HTTP 500），请稍后重试')
      .replace(/(?<!（)\bHTTP\s*429(?:\s+Too Many Requests)?\b(?!）)/gi, '请求过于频繁，云端已临时限流（HTTP 429），请稍后重试')
      .replace(/(?<!（)\bHTTP\s*403(?:\s+Forbidden)?\b(?!）)/gi, '云端拒绝访问（HTTP 403），请检查账号权限或同步目录设置')
      .replace(/(?<!（)\bHTTP\s*404(?:\s+Not Found)?\b(?!）)/gi, '云端目录或文件不存在（HTTP 404），请检查服务器地址与同步根目录')
      .trim();
  }

  // Progress & retry status messages
  text = text
    .replace(/\[E_CLOUD_RATE_LIMITED\]\s*/g, '')
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
    .replace(/文件级同步：工作区数据库/g, 'File sync: workspace databases')
    .replace(/文件级同步：VFS blob/g, 'File sync: attachments')
    .replace(/文件级同步：资产目录/g, 'File sync: assets directory')
    .replace(/文件级同步完成/g, 'File sync completed')
    .replace(/文件级传输：/g, 'File transfer: ')
    .replace(/应用下载变更/g, 'Applying downloaded changes')
    .replace(/应用变更/g, 'Applying changes')
    .replace(/上传批次\s*(\d+\/\d+)/g, 'Uploading batch $1')
    .replace(/socket hang up/gi, 'Network connection interrupted. Please check the server or network and try again')
    .replace(/\bECONNRESET\b|connection reset by peer/gi, 'Network connection reset. Please check the server or network and try again')
    .replace(/\bECONNREFUSED\b|connection refused/gi, 'Connection refused by server. Please check the endpoint URL and port')
    .replace(/\b(?:ETIMEDOUT|HeadersTimeoutError|BodyTimeoutError|UND_ERR_CONNECT_TIMEOUT)\b|operation timed out|request timeout/gi, 'Network connection timed out. Please try again later')
    .replace(/\b(?:ENOTFOUND|EAI_AGAIN)\b/gi, 'Could not resolve server host name. Please check the URL and network')
    .replace(/\b(?:EHOSTUNREACH|ENETUNREACH|ERR_NETWORK)\b|fetch failed|Failed to fetch|\bNetworkError\b/gi, 'Network unavailable. Please check your connection and try again')
    .replace(/\b(?:EPIPE|ERR_SOCKET_CLOSED|UND_ERR_SOCKET)\b/gi, 'Network connection closed unexpectedly. Please try again later');

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
    [/WebDAV\s*服务端限流，未重试[；;]\s*/g, 'Rate limited by cloud server: '],
    [/服务端限流/g, 'Rate limited by cloud server'],
    [/同步格式协商失败\s*[:：]\s*/g, 'Failed to negotiate remote sync format: '],
    [/列举同步租约失败\s*[:：]\s*/g, 'Failed to inspect cloud sync lock: '],
    [/写入同步租约失败\s*[:：]\s*/g, 'Failed to acquire cloud sync lock: '],
    [/读取同步租约失败(?:\s+[^\s:：]+)?\s*[:：]\s*/g, 'Failed to read cloud sync lock: '],
    [/回验同步租约失败\s*[:：]\s*/g, 'Failed to verify cloud sync lock: '],
    [/同步租约心跳已失效[^:：]*[:：]\s*/g, 'Sync lock expired while paused: '],
    [/提交下载游标失败\s*[:：]\s*/g, 'Failed to commit download progress: '],
    [/上传当前设备清单失败\s*[:：]\s*/g, 'Failed to upload device manifest: '],
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

export function extractLeaseExpiryDate(raw: string): Date | null {
  const match = /预计\s*(\S+?)\s*到期/.exec(raw)
    ?? /expires?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T\S+?)(?:[)\s.,;]|$)/i.exec(raw);
  if (!match) return null;
  const expiry = new Date(match[1].replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(expiry.getTime()) ? null : expiry;
}

export function extractLeaseHolderDevice(raw: string): string | null {
  const foreignMatch = /被其他设备持有\s*[:：]\s*([^\s（(）)）;；，,]+)/.exec(raw);
  if (foreignMatch?.[1]) return foreignMatch[1].trim();
  const selfMatch = /本机[（(]([^）)]+)[）)]/.exec(raw);
  if (selfMatch?.[1]) return selfMatch[1].trim();
  const enMatch = /held by\s+(?:device\s+)?([^\s(,;)）]+)/i.exec(raw);
  if (enMatch?.[1]) return enMatch[1].trim();
  return null;
}

export function formatRemainingLeaseDuration(
  expiry: Date,
  language?: string,
  nowMs: number = Date.now(),
): { expired: boolean; remainingMs: number; label: string } {
  const english = isEnglishUiLanguage(language);
  const remainingMs = Math.max(0, expiry.getTime() - nowMs);
  if (remainingMs <= 0) {
    return {
      expired: true,
      remainingMs: 0,
      label: english ? '0s' : '0 秒',
    };
  }
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return {
      expired: false,
      remainingMs,
      label: english
        ? (minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`)
        : (minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`),
    };
  }
  if (minutes > 0) {
    return {
      expired: false,
      remainingMs,
      label: english
        ? (seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`)
        : (seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`),
    };
  }
  return {
    expired: false,
    remainingMs,
    label: english ? `${seconds}s` : `${seconds} 秒`,
  };
}

/**
 * Formats a sync error into a concise, learner-friendly localized string suitable for
 * toasts and error banners — stripping internal `[E_*]` codes, nested transport chains,
 * HTML responses, and raw JS/Node stack traces.
 */
export function formatFriendlySyncError(
  raw: string,
  t: Translate,
  language?: string,
): string {
  if (!raw) return raw;
  const english = isEnglishUiLanguage(language);
  const cleaned = stripRawErrorNoise(raw);

  if (
    /command\s+[a-z0-9_.-]+\s+not\s+allowed(?:\s+by\s+ACL|\s+on\b[^\n]*)?/i.test(cleaned) ||
    /not\s+allowed\s+by\s+ACL/i.test(cleaned)
  ) {
    return t('data:governance.acl_permission_denied', {
      defaultValue: english
        ? 'Permission denied for this sync operation in the current environment.'
        : '当前环境暂无权执行该同步操作，请检查应用权限或版本配置后重试。',
    });
  }

  if (cleaned.includes('E_SYNC_LEASE_HELD_SELF')) {
    const expires = extractLeaseExpiryDate(cleaned)?.toLocaleString() ?? '';
    return expires
      ? t('sync:errors.leaseHeldSelf', {
          expiresAt: expires,
          defaultValue: english
            ? `The previous sync on this device was interrupted. Retry shortly (auto-clears by ${expires}).`
            : `本机上一次同步未正常结束，云端占用保护最晚将在 ${expires} 自动解除，请稍后重试。`,
        })
      : t('sync:errors.leaseHeld', {
          defaultValue: english
            ? 'Another sync session is currently active on this cloud folder. Please retry shortly.'
            : '当前云端目录存在进行中的同步保护，请稍后重试。',
        });
  }

  if (cleaned.includes('E_SYNC_LEASE_HELD')) {
    const expiry = extractLeaseExpiryDate(cleaned);
    if (expiry) {
      const expiresAt = expiry.toLocaleString();
      const rawHolder = extractLeaseHolderDevice(cleaned);
      const holder = rawHolder
        ? (rawHolder.length > 12 ? `${rawHolder.slice(0, 8)}...` : rawHolder)
        : (english ? 'another device' : '另一台设备');
      return t('data:governance.lease_held_foreign_guidance', {
        holder,
        expiresAt,
        defaultValue: english
          ? `Another device (${holder}) holds the cloud sync lock (expected to expire at ${expiresAt}). Wait for that device to finish or retry once the lock expires—do not overwrite cloud files manually.`
          : `另一台设备（${holder}）当前持有同步保护锁（预计 ${expiresAt} 过期）。请等待对方完成同步或倒计时结束后再重试，切勿手动覆盖云端文件。`,
      });
    }
    return t('sync:errors.leaseHeld', {
      defaultValue: english
        ? 'Another device is currently syncing to this cloud folder. Please wait and try again.'
        : '另一台设备正在同步同一云端目录，请等待对方完成后重试。',
    });
  }

  if (/同步租约心跳已失效/.test(cleaned)) {
    return english
      ? 'Sync paused too long and stopped safely to protect cloud data. Please retry.'
      : '同步连接中断时间过长，本轮同步已安全停止，请点击重试。';
  }

  const e2eeKind = classifySyncE2eeError(cleaned);
  if (e2eeKind) {
    return t(SYNC_E2EE_ERROR_I18N_KEYS[e2eeKind]);
  }
  if (/缺少\s*DSBK\s*加密头/.test(cleaned)) {
    return t('sync:errors.legacyPlaintextRejected');
  }
  if (/未配置加密密码/.test(cleaned)) {
    return t('sync:errors.encryptionPasswordMissing');
  }
  if (/密码错误或数据损坏|请检查加密密码|无法解密/.test(cleaned)) {
    return t('sync:errors.wrongEncryptionPassword');
  }

  if (cleaned.includes('E_CLOUD_RATE_LIMITED') || /\b(?:HTTP\s*)?429\b/i.test(cleaned)) {
    return english
      ? 'Cloud server is temporarily rate-limiting requests (HTTP 429). Please wait a moment and retry.'
      : '云端请求过于频繁，已触发临时限流（HTTP 429），请稍等片刻后重试同步。';
  }

  // Collapse verbose nested weak-network / transient server errors into one clear message.
  const isNestedTransportChain =
    /(?:双向同步失败|上传同步失败|下载同步失败|同步格式协商失败|同步\s*schema\s*预检失败|检查云端变更断层失败|列举同步租约失败|写入同步租约失败|读取同步租约失败|回验同步租约失败|上传变更失败|上传清单失败|提交下载游标失败|WebDAV\s+(?:PUT|GET|PROPFIND|MKCOL|DELETE)\b|Network\s+error\s*:)/i.test(
      cleaned,
    );
  const hasExplicitHttpAuthOrNotFound = /\b(?:HTTP\s*)?(?:401|403|404)\b/i.test(cleaned);
  if (isNestedTransportChain && !hasExplicitHttpAuthOrNotFound) {
    if (/\b(?:HTTP\s*)?503\b|Service Unavailable/i.test(cleaned)) {
      return english
        ? 'Cloud server is temporarily unavailable (HTTP 503). Your local changes are safe—please retry once the network recovers.'
        : '云端服务暂时不可用（HTTP 503），本地更改已安全保留，网络恢复后点击重试即可。';
    }
    if (/\b(?:HTTP\s*)?502\b|Bad Gateway/i.test(cleaned)) {
      return english
        ? 'Cloud gateway error (HTTP 502). Your local changes are safe—please retry later.'
        : '云端网关暂时异常（HTTP 502），本地更改已安全保留，请稍后重试。';
    }
    if (/\b(?:HTTP\s*)?504\b|Gateway Timeout/i.test(cleaned)) {
      return english
        ? 'Cloud server timed out (HTTP 504). Please check your connection and retry.'
        : '云端服务响应超时（HTTP 504），请检查网络后重试。';
    }
    if (/\b(?:HTTP\s*)?500\b|Internal Server Error/i.test(cleaned)) {
      return english
        ? 'Cloud server encountered an internal error (HTTP 500). Your local changes are safe—please retry later.'
        : '云端服务器内部异常（HTTP 500），本地更改已安全保留，请稍后重试。';
    }
    if (/socket hang up|\bECONNRESET\b|connection reset|broken pipe|\bEPIPE\b|ERR_SOCKET_CLOSED|UND_ERR_SOCKET|ERR_CONNECTION_RESET|ERR_CONNECTION_ABORTED|connection closed|网络连接中断|网络连接被重置|网络连接意外断开/i.test(cleaned)) {
      return english
        ? 'Network connection was interrupted mid-sync. Your local changes are safe—please retry.'
        : '同步途中网络连接中断，本地更改已安全保留，网络恢复后重试即可。';
    }
    if (/\b(?:ETIMEDOUT|HeadersTimeoutError|BodyTimeoutError|UND_ERR_CONNECT_TIMEOUT|ERR_CONNECTION_TIMED_OUT)\b|operation timed out|request timeout|timed out|网络连接超时/i.test(cleaned)) {
      return english
        ? 'Sync request timed out. Please check your network and retry.'
        : '同步请求超时，本地更改已安全保留，请检查网络后重试。';
    }
    if (/\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ERR_NETWORK|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE)\b|connection refused|fetch failed|Failed to fetch|\bNetworkError\b|Network\s+error|error sending request|client error \(Connect\)|\boffline\b|网络连接不可用|无法连接到服务器|无法解析服务器域名/i.test(cleaned)) {
      return english
        ? 'Cannot reach the cloud server. Please check your network connection and server URL, then retry.'
        : '暂时无法连接到云端服务器，请检查网络连接和服务器地址后重试。';
    }
  }

  // Strip residual internal `[E_*]` error codes, `Database error:` wrappers, and internal `[path]/<hash>.json` paths before general localization.
  const withoutInternalTokens = cleaned
    .replace(/\[E_[A-Z0-9_]+\]\s*/g, '')
    .replace(/\bDatabase\s+error\s*:\s*/gi, '')
    .replace(/(?:[:：]\s*|\s*\()?(?:\[path\]|sync\/v\d+)\/[^\s)）]+\.json\)?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[:：]\s*$/, '')
    .trim();
  return localizeBackendErrorText(withoutInternalTokens || cleaned, language);
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
    return t(SYNC_E2EE_ERROR_I18N_KEYS[e2eeKind]);
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
    // 用户可见 toast 仅输出干净人话；原始技术诊断（对象路径/错误码等）收进 SyncTab 折叠详情。
    case 'E_SYNC_BAD_OBJECT_FAIL_CLOSED':
      return t('cloudStorage:errors.syncBadObjectFailClosed');
    case 'E_DG_TOMBSTONE_LIMITER_BUSY':
      return t('cloudStorage:errors.governanceBusy');
    case 'E_BACKUP_DIR_MISSING':
      return t('cloudStorage:errors.backupDirMissing');
    case 'E_RESTORE_DISK_BUDGET_OVERFLOW':
      return t('cloudStorage:errors.restoreDiskBudgetOverflow');
    case 'E_ZIP_EXPORT_TEMP_MISSING':
      return t('cloudStorage:errors.zipExportTempMissing');
    case 'E_ZIP_EXPORT_COPY_TARGET_FAILED':
      return t('cloudStorage:errors.zipExportCopyTargetFailed');
    case 'E_VERIFIED_PUBLISH_MISMATCH':
      return t('cloudStorage:errors.verifiedPublishMismatch');
    case 'E_VERIFIED_PUBLISH_OVERSIZE':
      return t('cloudStorage:errors.verifiedPublishOversize');
    case 'E_VERIFIED_PUBLISH_UNCONDITIONAL_WRITE':
      return t('cloudStorage:errors.verifiedPublishUnconditionalWrite');
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
  return formatFriendlySyncError(raw, t, language);
}
