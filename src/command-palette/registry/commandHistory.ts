/**
 * 命令历史记录管理
 * 记录最近执行的命令，支持快速访问
 */

const STORAGE_KEY = 'dstu-command-history';
const MAX_HISTORY_SIZE = 20;

export interface CommandHistoryEntry {
  commandId: string;
  timestamp: number;
  count: number; // 执行次数
}

/**
 * 命令历史管理器
 */
class CommandHistoryManager {
  private history: CommandHistoryEntry[] = [];
  private listeners: Set<() => void> = new Set();
  
  constructor() {
    this.load();
  }
  
  /**
   * 从 localStorage 加载历史记录
   */
  private load(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        this.history = JSON.parse(stored);
      }
    } catch (error: unknown) {
      console.warn('[CommandHistory] 加载历史记录失败:', error);
      this.history = [];
    }
  }
  
  /**
   * 保存历史记录到 localStorage
   */
  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.history));
    } catch (error: unknown) {
      console.warn('[CommandHistory] 保存历史记录失败:', error);
    }
  }
  
  /**
   * 记录命令执行
   */
  record(commandId: string): void {
    const existingIndex = this.history.findIndex(
      (entry) => entry.commandId === commandId
    );
    
    if (existingIndex >= 0) {
      // 已存在，更新时间和计数
      const entry = this.history[existingIndex];
      entry.timestamp = Date.now();
      entry.count += 1;
      // 移到最前面
      this.history.splice(existingIndex, 1);
      this.history.unshift(entry);
    } else {
      // 新增
      this.history.unshift({
        commandId,
        timestamp: Date.now(),
        count: 1,
      });
    }
    
    // 限制大小
    if (this.history.length > MAX_HISTORY_SIZE) {
      this.history = this.history.slice(0, MAX_HISTORY_SIZE);
    }
    
    this.save();
    this.notifyListeners();
  }
  
  /**
   * 获取历史记录
   */
  getHistory(): CommandHistoryEntry[] {
    return [...this.history];
  }
  
  /**
   * 获取最近使用的命令 ID 列表
   */
  getRecentCommandIds(limit: number = 10): string[] {
    return this.history.slice(0, limit).map((entry) => entry.commandId);
  }
  
  /**
   * 获取最常用的命令 ID 列表（按执行次数排序）
   */
  getFrequentCommandIds(limit: number = 10): string[] {
    return [...this.history]
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((entry) => entry.commandId);
  }
  
  /**
   * 清空历史记录
   */
  clear(): void {
    this.history = [];
    this.save();
    this.notifyListeners();
  }
  
  /**
   * 移除特定命令的历史记录
   */
  remove(commandId: string): void {
    this.history = this.history.filter(
      (entry) => entry.commandId !== commandId
    );
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
export const commandHistory = new CommandHistoryManager();
