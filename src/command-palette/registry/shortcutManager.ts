/**
 * 快捷键管理器
 * 支持自定义快捷键、冲突检测
 */

import { commandRegistry } from './commandRegistry';
import { normalizeShortcut, formatShortcut } from './shortcutUtils';
import type { Command } from './types';

const STORAGE_KEY = 'dstu-custom-shortcuts';

export interface ShortcutBinding {
  commandId: string;
  shortcut: string;
  isCustom: boolean; // 是否为用户自定义
}

export interface ShortcutConflict {
  shortcut: string;
  commands: string[]; // 冲突的命令 ID 列表
}

/**
 * 快捷键管理器
 */
class ShortcutManager {
  private customShortcuts: Map<string, string> = new Map(); // commandId -> shortcut
  private listeners: Set<() => void> = new Set();
  
  constructor() {
    this.load();
  }
  
  /**
   * 加载自定义快捷键
   */
  private load(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const entries = JSON.parse(stored);
        this.customShortcuts = new Map(entries);
      }
    } catch (error: unknown) {
      console.warn('[ShortcutManager] 加载自定义快捷键失败:', error);
    }
  }
  
  /**
   * 保存自定义快捷键
   */
  private save(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([...this.customShortcuts.entries()])
      );
    } catch (error: unknown) {
      console.warn('[ShortcutManager] 保存自定义快捷键失败:', error);
    }
  }
  
  /**
   * 获取命令的有效快捷键（自定义优先）
   */
  getShortcut(commandId: string): string | undefined {
    // 自定义快捷键优先
    if (this.customShortcuts.has(commandId)) {
      const custom = this.customShortcuts.get(commandId);
      // 空字符串表示禁用快捷键
      return custom === '' ? undefined : custom;
    }
    // 使用默认快捷键
    const command = commandRegistry.getById(commandId);
    return command?.shortcut;
  }
  
  /**
   * 设置自定义快捷键
   */
  setShortcut(commandId: string, shortcut: string): ShortcutConflict | null {
    // 检查冲突（考虑视图范围）
    if (shortcut) {
      const conflict = this.checkConflict(shortcut, commandId);
      if (conflict) {
        return conflict;
      }
    }
    
    // 保存原始可读格式（如 "mod+shift+k"），比较时再 normalizeShortcut
    // 不保存归一化格式，否则 formatShortcut 显示顺序会乱
    this.customShortcuts.set(commandId, shortcut);
    this.save();
    this.notifyListeners();
    return null;
  }
  
  /**
   * 移除自定义快捷键（恢复默认）
   */
  resetShortcut(commandId: string): void {
    if (this.customShortcuts.has(commandId)) {
      this.customShortcuts.delete(commandId);
      this.save();
      this.notifyListeners();
    }
  }
  
  /**
   * 禁用命令的快捷键
   */
  disableShortcut(commandId: string): void {
    this.customShortcuts.set(commandId, '');
    this.save();
    this.notifyListeners();
  }
  
  /**
   * 检查快捷键冲突（考虑视图范围）
   *
   * 两个命令只有在视图范围存在交集时才算冲突。
   * 例如 chat.save (chat-v2) 与 notes.save (learning-hub) 即使快捷键相同也不冲突。
   */
  checkConflict(shortcut: string, excludeCommandId?: string): ShortcutConflict | null {
    const normalized = normalizeShortcut(shortcut);
    const conflictingCommands: string[] = [];

    const excludeCommand = excludeCommandId ? commandRegistry.getById(excludeCommandId) : undefined;
    const excludeViews = excludeCommand?.visibleInViews;
    
    // 检查所有命令
    const allCommands = commandRegistry.getAll();
    for (const command of allCommands) {
      if (excludeCommandId && command.id === excludeCommandId) {
        continue;
      }
      
      const effectiveShortcut = this.getShortcut(command.id);
      if (effectiveShortcut && normalizeShortcut(effectiveShortcut) === normalized) {
        // 视图范围检查：只有视图交集非空才算冲突
        if (this.haveViewOverlap(excludeViews, command.visibleInViews)) {
          conflictingCommands.push(command.id);
        }
      }
    }
    
    if (conflictingCommands.length > 0) {
      return {
        shortcut,
        commands: conflictingCommands,
      };
    }
    
    return null;
  }

  /**
   * 判断两组视图是否有交集
   */
  private haveViewOverlap(aViews?: string[], bViews?: string[]): boolean {
    // 如果任一方无限制（全局命令），必然有交集
    if (!aViews || aViews.length === 0 || !bViews || bViews.length === 0) {
      return true;
    }
    return aViews.some((v) => bViews.includes(v));
  }
  
  /**
   * 获取所有快捷键绑定
   */
  getAllBindings(): ShortcutBinding[] {
    const bindings: ShortcutBinding[] = [];
    const allCommands = commandRegistry.getAll();
    
    for (const command of allCommands) {
      const hasCustom = this.customShortcuts.has(command.id);
      const effectiveShortcut = this.getShortcut(command.id);
      
      if (effectiveShortcut || hasCustom) {
        bindings.push({
          commandId: command.id,
          shortcut: effectiveShortcut || '',
          isCustom: hasCustom,
        });
      }
    }
    
    return bindings;
  }
  
  /**
   * 获取有快捷键的命令
   */
  getCommandsWithShortcuts(): Array<Command & { effectiveShortcut: string }> {
    const allCommands = commandRegistry.getAll();
    const result: Array<Command & { effectiveShortcut: string }> = [];
    
    for (const command of allCommands) {
      const effectiveShortcut = this.getShortcut(command.id);
      if (effectiveShortcut) {
        result.push({
          ...command,
          effectiveShortcut,
        });
      }
    }
    
    return result;
  }
  
  /**
   * 检查是否有自定义快捷键
   */
  hasCustomShortcut(commandId: string): boolean {
    return this.customShortcuts.has(commandId);
  }
  
  /**
   * 重置所有自定义快捷键
   */
  resetAll(): void {
    this.customShortcuts.clear();
    this.save();
    this.notifyListeners();
  }
  
  /**
   * 导出自定义快捷键配置
   */
  exportConfig(): Record<string, string> {
    return Object.fromEntries(this.customShortcuts);
  }
  
  /**
   * 导入自定义快捷键配置（带校验）
   */
  importConfig(config: Record<string, string>): { imported: number; skipped: string[] } {
    const skipped: string[] = [];
    const validEntries: [string, string][] = [];

    for (const [commandId, shortcut] of Object.entries(config)) {
      // 校验 commandId 是否存在
      if (!commandRegistry.getById(commandId)) {
        skipped.push(commandId);
        continue;
      }
      // 保存原始格式（比较时再 normalizeShortcut）
      validEntries.push([commandId, shortcut]);
    }

    this.customShortcuts = new Map(validEntries);
    this.save();
    this.notifyListeners();
    return { imported: validEntries.length, skipped };
  }
  
  // normalizeShortcut / formatShortcut 已统一到 shortcutUtils.ts
  // 为保持 API 向后兼容，暴露委托方法
  /** @deprecated 使用 import { normalizeShortcut } from './shortcutUtils' */
  normalizeShortcut(shortcut: string): string {
    return normalizeShortcut(shortcut);
  }
  /** @deprecated 使用 import { formatShortcut } from './shortcutUtils' */
  formatShortcut(shortcut: string): string {
    return formatShortcut(shortcut);
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
export const shortcutManager = new ShortcutManager();
