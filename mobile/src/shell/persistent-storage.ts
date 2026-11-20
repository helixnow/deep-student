/**
 * OPFS 数据默认是 best-effort：存储压力下浏览器可以整体回收。启动时申请持久存储（DESIGN.md §2「持久化」、S5）。
 * `StorageManager.persist()` 只在主线程（Window）上有，Worker 里的 Host 不能自己申请。
 */
export interface PersistentStorageManager {
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
}

export type PersistentStorageStatus = 'granted' | 'denied' | 'unavailable';

export const PERSISTENT_STORAGE_STATUS_EVENT = 'deepstudent:persistent-storage-status';
export const PERSISTENT_STORAGE_WARNING_DISMISSED_KEY = 'dstu-persistent-storage-warning-dismissed';

const PERSISTENT_STORAGE_WARNING_BANNER_ID = 'dstu-persistent-storage-warning';

declare global {
  // eslint-disable-next-line no-var
  var __DEEP_STUDENT_PERSISTENT_STORAGE_STATUS__: PersistentStorageStatus | undefined;
}

export interface PersistentStorageStatusTarget {
  __DEEP_STUDENT_PERSISTENT_STORAGE_STATUS__?: PersistentStorageStatus;
  dispatchEvent?: (event: Event) => boolean;
}

export interface PersistentStorageBannerOptions {
  document?: Document;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  language?: string;
}

/** 已持久或本次获准时为 true；被拒为 false；平台没有该 API 或调用失败时为 null。原因都经 `log` 记录。 */
export async function requestPersistentStorage(storage: PersistentStorageManager | undefined, log: (message: string) => void): Promise<boolean | null> {
  if (typeof storage?.persist !== 'function') {
    log('[storage] navigator.storage.persist() is unavailable; OPFS data may be evicted under storage pressure');
    return null;
  }
  try {
    if (typeof storage.persisted === 'function' && await storage.persisted()) return true;
    const granted = await storage.persist();
    if (!granted) log('[storage] persistent storage was not granted; OPFS data may be evicted under storage pressure');
    return granted;
  } catch (error) {
    log(`[storage] persistent storage request failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function toPersistentStorageStatus(granted: boolean | null): PersistentStorageStatus {
  if (granted === true) return 'granted';
  if (granted === false) return 'denied';
  return 'unavailable';
}

export function reportPersistentStorageStatus(
  grantedOrStatus: boolean | null | PersistentStorageStatus,
  target: PersistentStorageStatusTarget = globalThis as PersistentStorageStatusTarget,
): PersistentStorageStatus {
  const status: PersistentStorageStatus =
    typeof grantedOrStatus === 'string' ? grantedOrStatus : toPersistentStorageStatus(grantedOrStatus);
  target.__DEEP_STUDENT_PERSISTENT_STORAGE_STATUS__ = status;
  if (typeof CustomEvent === 'function') {
    try {
      const event = new CustomEvent(PERSISTENT_STORAGE_STATUS_EVENT, { detail: { status } });
      if (typeof target.dispatchEvent === 'function') {
        target.dispatchEvent(event);
      } else if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
        document.dispatchEvent(event);
      }
    } catch {
      // Ignore environments without a DOM EventTarget implementation.
    }
  }
  return status;
}

export function mountPersistentStorageWarningBanner(
  options?: PersistentStorageBannerOptions,
): HTMLElement | null {
  const doc = options?.document ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc?.body) return null;

  if (typeof doc.getElementById === 'function') {
    const existing = doc.getElementById(PERSISTENT_STORAGE_WARNING_BANNER_ID);
    if (existing) return existing;
  }

  const storage =
    options && 'storage' in options
      ? options.storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  try {
    if (storage?.getItem(PERSISTENT_STORAGE_WARNING_DISMISSED_KEY) === '1') {
      return null;
    }
  } catch {
    // Ignore storage read errors in restricted WebViews.
  }

  const rawLang = (
    options?.language?.trim() ||
    doc.documentElement?.lang?.trim() ||
    (typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language.trim() : '')
  ).toLowerCase();
  const isEnglish = rawLang !== '' && !rawLang.startsWith('zh');

  const banner = doc.createElement('div');
  banner.id = PERSISTENT_STORAGE_WARNING_BANNER_ID;
  banner.setAttribute('role', 'status');
  banner.setAttribute('data-testid', 'persistent-storage-warning-banner');
  banner.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: 0',
    'right: 0',
    'z-index: 9999',
    'display: flex',
    'align-items: center',
    'justify-content: space-between',
    'gap: 8px',
    'padding: calc(8px + var(--android-safe-area-top, env(safe-area-inset-top, 0px))) 12px 8px 16px',
    'background: rgba(120, 53, 15, 0.96)',
    'color: #fef3c7',
    'border-bottom: 1px solid rgba(245, 158, 11, 0.4)',
    'font-size: 13px',
    'line-height: 1.45',
    'box-sizing: border-box',
    'box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18)',
  ].join('; ');

  const message = doc.createElement('span');
  message.textContent = isEnglish
    ? 'Persistent storage permission was not granted. Local study data may be reclaimed when storage is low — please enable cloud sync or back up regularly.'
    : '系统未授予持久化存储权限，清理空间时本地学习数据可能被回收，建议开启云端同步或定期备份';

  const closeButton = doc.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '×';
  closeButton.setAttribute(
    'aria-label',
    isEnglish ? 'Dismiss persistent storage warning' : '关闭持久化存储提醒',
  );
  closeButton.style.cssText = [
    'min-width: 44px',
    'min-height: 44px',
    'display: inline-flex',
    'align-items: center',
    'justify-content: center',
    'flex-shrink: 0',
    'padding: 0 8px',
    'border: none',
    'border-radius: 8px',
    'background: transparent',
    'color: inherit',
    'font-size: 18px',
    'line-height: 1',
    'cursor: pointer',
  ].join('; ');

  closeButton.addEventListener('click', () => {
    try {
      storage?.setItem(PERSISTENT_STORAGE_WARNING_DISMISSED_KEY, '1');
    } catch {
      // Ignore storage write errors.
    }
    banner.remove();
  });

  banner.appendChild(message);
  banner.appendChild(closeButton);
  doc.body.appendChild(banner);
  return banner;
}
