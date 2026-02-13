/**
 * 命令收藏管理
 * 用户可以收藏常用命令
 */

const STORAGE_KEY = 'dstu-command-favorites';

/**
 * 命令收藏管理器
 */
class CommandFavoritesManager {
  private favorites: Set<string> = new Set();
  private listeners: Set<() => void> = new Set();
  
  constructor() {
    this.load();
  }
  
  /**
   * 从 localStorage 加载收藏
   */
  private load(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const ids = JSON.parse(stored);
        this.favorites = new Set(ids);
      }
    } catch (error: unknown) {
      console.warn('[CommandFavorites] 加载收藏失败:', error);
      this.favorites = new Set();
    }
  }
  
  /**
   * 保存收藏到 localStorage
   */
  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.favorites]));
    } catch (error: unknown) {
      console.warn('[CommandFavorites] 保存收藏失败:', error);
    }
  }
  
  /**
   * 添加收藏
   */
  add(commandId: string): void {
    if (!this.favorites.has(commandId)) {
      this.favorites.add(commandId);
      this.save();
      this.notifyListeners();
    }
  }
  
  /**
   * 移除收藏
   */
  remove(commandId: string): void {
    if (this.favorites.has(commandId)) {
      this.favorites.delete(commandId);
      this.save();
      this.notifyListeners();
    }
  }
  
  /**
   * 切换收藏状态
   */
  toggle(commandId: string): boolean {
    if (this.favorites.has(commandId)) {
      this.remove(commandId);
      return false;
    } else {
      this.add(commandId);
      return true;
    }
  }
  
  /**
   * 检查是否已收藏
   */
  isFavorite(commandId: string): boolean {
    return this.favorites.has(commandId);
  }
  
  /**
   * 获取所有收藏的命令 ID
   */
  getAll(): string[] {
    return [...this.favorites];
  }
  
  /**
   * 清空收藏
   */
  clear(): void {
    this.favorites.clear();
    this.save();
    this.notifyListeners();
  }
  
  /**
   * 订阅变更
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  
  private notifyListeners(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {}
    });
  }
}

// 导出单例
export const commandFavorites = new CommandFavoritesManager();
