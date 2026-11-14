/**
 * OPFS 数据默认是 best-effort：存储压力下浏览器可以整体回收。启动时申请持久存储（DESIGN.md §2「持久化」、S5）。
 * `StorageManager.persist()` 只在主线程（Window）上有，Worker 里的 Host 不能自己申请。
 */
export interface PersistentStorageManager {
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
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
