/**
 * 通用持久化 Set 管理器
 *
 * 封装 Set<string> + localStorage 持久化 + 变更监听模式。
 * 用于 skillDefaults / skillFavorites 等场景，避免重复实现。
 */
export class PersistentSetManager {
  private static readonly MAX_LISTENERS = 100;
  private items: Set<string> = new Set();
  private listeners: Set<() => void> = new Set();
  private storageKey: string;
  private logPrefix: string;

  constructor(storageKey: string, logPrefix: string) {
    this.storageKey = storageKey;
    this.logPrefix = logPrefix;
    this.load();
  }

  // --------------- storage helpers ---------------

  private hasLocalStorage(): boolean {
    return typeof globalThis !== 'undefined' && typeof globalThis.localStorage !== 'undefined';
  }

  /**
   * 从 localStorage 加载数据
   */
  private load(): void {
    if (!this.hasLocalStorage()) return;
    try {
      const stored = globalThis.localStorage.getItem(this.storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        // 🔧 类型校验：确保是字符串数组，防止数据损坏导致异常行为
        if (Array.isArray(parsed)) {
          const validIds = parsed.filter(
            (item): item is string => typeof item === 'string' && item.length > 0,
          );
          this.items = new Set(validIds);
        } else {
          console.warn(`[${this.logPrefix}] Storage data format invalid (not array), reset`);
          this.items = new Set();
        }
      }
    } catch (error: unknown) {
      console.warn(`[${this.logPrefix}] Failed to load data:`, error);
      this.items = new Set();
    }
  }

  /**
   * 保存数据到 localStorage
   */
  private save(): void {
    if (!this.hasLocalStorage()) return;
    try {
      globalThis.localStorage.setItem(this.storageKey, JSON.stringify([...this.items]));
    } catch (error: unknown) {
      console.warn(`[${this.logPrefix}] Failed to save data:`, error);
    }
  }

  // --------------- public API ---------------

  /**
   * 检查是否包含指定 ID
   */
  has(id: string): boolean {
    return this.items.has(id);
  }

  /**
   * 添加 ID
   */
  add(id: string): void {
    if (!this.items.has(id)) {
      this.items.add(id);
      this.save();
      this.notifyListeners();
    }
  }

  /**
   * 移除 ID
   */
  remove(id: string): void {
    if (this.items.has(id)) {
      this.items.delete(id);
      this.save();
      this.notifyListeners();
    }
  }

  /**
   * 切换状态，返回切换后是否存在
   */
  toggle(id: string): boolean {
    if (this.items.has(id)) {
      this.remove(id);
      return false;
    } else {
      this.add(id);
      return true;
    }
  }

  /**
   * 获取所有 ID
   */
  getAll(): string[] {
    return [...this.items];
  }

  /**
   * 清空所有数据
   */
  clear(): void {
    this.items.clear();
    this.save();
    this.notifyListeners();
  }

  /**
   * 订阅变更
   */
  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= PersistentSetManager.MAX_LISTENERS) {
      console.warn(
        `[${this.logPrefix}] Listener count at limit (${PersistentSetManager.MAX_LISTENERS}), possible subscription leak`,
      );
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --------------- internal ---------------

  private notifyListeners(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // 忽略监听器错误
      }
    });
  }
}
