/**
 * 命令注册中心 - SOTA 版本
 * 管理命令的注册、注销、查询、执行
 * 支持高级搜索、分类过滤、标签查询
 */

import type {
  Command,
  CommandCategory,
  CommandChangeListener,
  ICommandRegistry,
  DependencyResolver,
} from './types';
import type { CurrentView } from '@/types/navigation';
import { normalizeShortcut as normalizeShortcutUtil } from './shortcutUtils';

// ==================== 搜索算法 ====================

/**
 * 简易拼音首字母映射（常用汉字）
 * 用于支持拼音首字母搜索
 */
const PINYIN_MAP: Record<string, string> = {
  // 导航相关
  '跳': 't', '转': 'z', '到': 'd', '分': 'f', '析': 'x',
  '笔': 'b', '记': 'j', '知': 'z', '识': 's', '库': 'k',
  '设': 's', '置': 'z', '首': 's', '页': 'y',
  // 操作相关
  '新': 'x', '建': 'j', '保': 'b', '存': 'c', '删': 's', '除': 'c',
  '打': 'd', '开': 'k', '关': 'g', '闭': 'b', '切': 'q', '换': 'h',
  '搜': 's', '索': 's', '查': 'c', '找': 'z', '导': 'd', '出': 'c',
  '入': 'r', '复': 'f', '制': 'z', '粘': 'z', '贴': 't',
  // 功能相关
  '聊': 'l', '天': 't', '对': 'd', '话': 'h', '生': 's', '成': 'c',
  '停': 't', '止': 'z', '重': 'c', '试': 's', '清': 'q', '空': 'k',
  '学': 'x', '习': 'x', '内': 'n', '化': 'h', '卡': 'k',
  '模': 'm', '板': 'b', '图': 't', '谱': 'p', '答': 'd', '案': 'a',
};

/**
 * 获取文本的拼音首字母
 */
function getPinyinInitials(text: string): string {
  return text
    .split('')
    .map((char) => PINYIN_MAP[char] || char.toLowerCase())
    .join('');
}

/**
 * 模糊搜索匹配得分计算 - 增强版
 */
function calculateMatchScore(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // 精确匹配
  if (lowerText === lowerQuery) return 100;

  // 前缀匹配
  if (lowerText.startsWith(lowerQuery)) return 85;

  // 单词边界匹配（如 "goto" 匹配 "nav.goto.notes"）
  const parts = lowerText.split(/[.\-_\s]/);
  for (const part of parts) {
    if (part === lowerQuery) return 80;
    if (part.startsWith(lowerQuery)) return 75;
  }

  // 包含匹配
  if (lowerText.includes(lowerQuery)) return 60;

  // 拼音首字母匹配
  const pinyinInitials = getPinyinInitials(text);
  if (pinyinInitials.includes(lowerQuery)) return 55;
  if (pinyinInitials.startsWith(lowerQuery)) return 58;

  // 模糊匹配（字符顺序匹配）- 优化版
  let queryIndex = 0;
  let consecutiveBonus = 0;
  let lastMatchIndex = -2;
  let wordBoundaryBonus = 0;

  for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIndex]) {
      // 连续匹配加分
      if (lastMatchIndex === i - 1) {
        consecutiveBonus += 5;
      }
      // 单词边界匹配加分
      if (i === 0 || /[.\-_\s]/.test(lowerText[i - 1])) {
        wordBoundaryBonus += 3;
      }
      lastMatchIndex = i;
      queryIndex++;
    }
  }

  if (queryIndex === lowerQuery.length) {
    // 根据匹配紧密度给分
    const density = lowerQuery.length / (lastMatchIndex - (lowerText.indexOf(lowerQuery[0])) + 1);
    return 25 + consecutiveBonus + wordBoundaryBonus + Math.round(density * 10);
  }

  return 0;
}

/**
 * 计算命令的综合匹配得分 - 增强版
 */
function getCommandMatchScore(command: Command, query: string): number {
  if (!query.trim()) return command.priority ?? 0;

  const scores: number[] = [];
  const normalizedQuery = query.toLowerCase().trim();

  // 特殊前缀处理
  let effectiveQuery = normalizedQuery;
  let categoryBonus = 0;

  // 支持分类前缀搜索，如 ">nav" 搜索导航命令
  if (normalizedQuery.startsWith('>')) {
    const prefix = normalizedQuery.slice(1);
    if (command.category.includes(prefix) || command.id.startsWith(prefix)) {
      categoryBonus = 20;
    }
    effectiveQuery = prefix;
  }

  // 名称匹配（最高权重）
  scores.push(calculateMatchScore(command.name, effectiveQuery) * 1.8);

  // ID 匹配
  scores.push(calculateMatchScore(command.id, effectiveQuery) * 1.2);

  // 描述匹配
  if (command.description) {
    scores.push(calculateMatchScore(command.description, effectiveQuery) * 0.9);
  }

  // 关键词匹配
  if (command.keywords) {
    for (const keyword of command.keywords) {
      scores.push(calculateMatchScore(keyword, effectiveQuery) * 1.1);
    }
  }

  // 标签匹配
  if (command.tags) {
    for (const tag of command.tags) {
      scores.push(calculateMatchScore(tag, effectiveQuery) * 0.8);
    }
  }

  // 分类匹配
  scores.push(calculateMatchScore(command.category, effectiveQuery) * 0.5);

  // 取最高分并加上优先级和分类加成
  const maxScore = Math.max(...scores);
  const priorityBonus = (command.priority ?? 0) * 0.1;

  return maxScore + priorityBonus + categoryBonus;
}

// ==================== 命令注册表 ====================

class CommandRegistry implements ICommandRegistry {
  private commands: Map<string, Command> = new Map();
  private listeners: Set<CommandChangeListener> = new Set();
  private shortcutMap: Map<string, string> = new Map(); // shortcut -> 默认命令 id（最高优先级）
  private shortcutIndex: Map<string, Set<string>> = new Map(); // shortcut -> command ids
  private categoryIndex: Map<CommandCategory, Set<string>> = new Map(); // category -> command ids
  private tagIndex: Map<string, Set<string>> = new Map(); // tag -> command ids

  /**
   * 注册单个命令
   */
  register(command: Command): () => void {
    // 检查重复注册
    if (this.commands.has(command.id)) {
      console.warn(`[CommandRegistry] 命令 "${command.id}" 已存在，将被覆盖`);
      // 先注销旧命令
      this.unregister(command.id);
    }

    this.commands.set(command.id, command);

    // 注册快捷键映射
    if (command.shortcut) {
      const normalizedShortcut = this.normalizeShortcut(command.shortcut);
      const existingIds = this.shortcutIndex.get(normalizedShortcut)
        ? Array.from(this.shortcutIndex.get(normalizedShortcut)!)
        : [];
      const existingCommands = existingIds
        .map((id) => this.commands.get(id))
        .filter((cmd): cmd is Command => cmd !== undefined && cmd.id !== command.id);

      if (this.hasMeaningfulShortcutConflict(command, existingCommands)) {
        const preferred = this.pickPreferredCommand([...existingCommands, command]);
        console.warn(
          `[CommandRegistry] 快捷键 "${command.shortcut}" 冲突：` +
          `优先使用 "${preferred.id}"，注册 "${command.id}"`
        );
      }

      if (!this.shortcutIndex.has(normalizedShortcut)) {
        this.shortcutIndex.set(normalizedShortcut, new Set());
      }
      this.shortcutIndex.get(normalizedShortcut)!.add(command.id);

      const fallback = this.pickPreferredCommand(this.getShortcutCandidates(normalizedShortcut));
      this.shortcutMap.set(normalizedShortcut, fallback.id);
    }

    // 更新分类索引
    if (!this.categoryIndex.has(command.category)) {
      this.categoryIndex.set(command.category, new Set());
    }
    this.categoryIndex.get(command.category)!.add(command.id);

    // 更新标签索引
    if (command.tags) {
      for (const tag of command.tags) {
        if (!this.tagIndex.has(tag)) {
          this.tagIndex.set(tag, new Set());
        }
        this.tagIndex.get(tag)!.add(command.id);
      }
    }

    this.notifyListeners();

    // 返回注销函数
    return () => this.unregister(command.id);
  }

  /**
   * 批量注册命令
   */
  registerAll(commands: Command[]): () => void {
    // 批量注册时暂时禁用通知
    const originalNotify = this.notifyListeners.bind(this);
    this.notifyListeners = () => {};

    const unregisters = commands.map((cmd) => this.register(cmd));

    // 恢复通知并触发一次
    this.notifyListeners = originalNotify;
    this.notifyListeners();

    return () => unregisters.forEach((fn) => fn());
  }

  /**
   * 注销命令
   */
  unregister(id: string): void {
    const command = this.commands.get(id);
    if (command) {
      // 移除快捷键映射
      if (command.shortcut) {
        const normalizedShortcut = this.normalizeShortcut(command.shortcut);
        const ids = this.shortcutIndex.get(normalizedShortcut);
        if (ids) {
          ids.delete(id);
          if (ids.size === 0) {
            this.shortcutIndex.delete(normalizedShortcut);
            this.shortcutMap.delete(normalizedShortcut);
          } else {
            const fallback = this.pickPreferredCommand(this.getShortcutCandidates(normalizedShortcut));
            this.shortcutMap.set(normalizedShortcut, fallback.id);
          }
        }
      }

      // 移除分类索引
      this.categoryIndex.get(command.category)?.delete(id);

      // 移除标签索引
      if (command.tags) {
        for (const tag of command.tags) {
          this.tagIndex.get(tag)?.delete(id);
        }
      }

      this.commands.delete(id);
      this.notifyListeners();
    }
  }

  /**
   * 获取所有命令
   */
  getAll(): Command[] {
    return Array.from(this.commands.values());
  }

  /**
   * 根据当前视图获取可用命令
   */
  getAvailable(currentView: CurrentView, deps: DependencyResolver): Command[] {
    return this.getAll().filter((cmd) => {
      // 视图限制检查
      if (cmd.visibleInViews && cmd.visibleInViews.length > 0) {
        if (!cmd.visibleInViews.includes(currentView)) {
          return false;
        }
      }

      // 启用状态检查
      if (cmd.isEnabled && !cmd.isEnabled(deps)) {
        return false;
      }

      return true;
    });
  }

  /**
   * 根据 ID 获取命令
   */
  getById(id: string): Command | undefined {
    return this.commands.get(id);
  }

  /**
   * 根据快捷键获取命令
   */
  getByShortcut(shortcut: string): Command | undefined {
    const normalizedShortcut = this.normalizeShortcut(shortcut);
    const id = this.shortcutMap.get(normalizedShortcut);
    return id ? this.commands.get(id) : undefined;
  }

  /**
   * 根据快捷键解析当前视图下的命令
   */
  resolveShortcut(shortcut: string, currentView: CurrentView, deps: DependencyResolver): Command | undefined {
    const normalizedShortcut = this.normalizeShortcut(shortcut);
    const candidates = this.getShortcutCandidates(normalizedShortcut).filter((cmd) => {
      if (!this.isCommandVisibleInView(cmd, currentView)) {
        return false;
      }
      if (cmd.isEnabled && !cmd.isEnabled(deps)) {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      return undefined;
    }

    return this.pickPreferredCommand(candidates);
  }

  /**
   * 根据分类获取命令
   */
  getByCategory(category: CommandCategory): Command[] {
    const ids = this.categoryIndex.get(category);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.commands.get(id))
      .filter((cmd): cmd is Command => cmd !== undefined);
  }

  /**
   * 根据标签获取命令
   */
  getByTag(tag: string): Command[] {
    const ids = this.tagIndex.get(tag);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.commands.get(id))
      .filter((cmd): cmd is Command => cmd !== undefined);
  }

  /**
   * 执行命令
   */
  async execute(id: string, deps: DependencyResolver): Promise<void> {
    const command = this.commands.get(id);
    if (!command) {
      throw new Error(`[CommandRegistry] 命令 "${id}" 不存在`);
    }

    // 检查是否启用
    if (command.isEnabled && !command.isEnabled(deps)) {
      console.warn(`[CommandRegistry] 命令 "${id}" 当前不可用`);
      deps.showNotification('warning', '该命令当前不可用');
      return;
    }

    // 危险操作确认
    if (command.requireConfirm) {
      // TODO: 实现确认对话框
      console.warn(`[CommandRegistry] 命令 "${id}" 需要确认`);
    }

    try {
      const result = await command.execute(deps);
      console.log(`[CommandRegistry] 执行命令: ${id}`);

      // 处理执行结果
      if (result && typeof result === 'object' && 'success' in result) {
        if (!result.success && result.message) {
          deps.showNotification('error', result.message);
        } else if (result.success && result.message) {
          deps.showNotification('success', result.message);
        }
      }
    } catch (error: unknown) {
      console.error(`[CommandRegistry] 命令 "${id}" 执行失败:`, error);
      deps.showNotification('error', `命令执行失败: ${error instanceof Error ? error.message : '未知错误'}`);
      throw error;
    }
  }

  /**
   * 订阅命令变更
   */
  subscribe(listener: CommandChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 搜索命令（模糊匹配） - 增强版
   */
  search(query: string, currentView: CurrentView, deps: DependencyResolver): Command[] {
    const available = this.getAvailable(currentView, deps);

    if (!query.trim()) {
      // 无搜索词时按优先级排序
      return available.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    }

    // 计算匹配得分并过滤
    const scored = available
      .map((cmd) => ({
        command: cmd,
        score: getCommandMatchScore(cmd, query),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.map((item) => item.command);
  }

  /**
   * 获取命令数量
   */
  count(): number {
    return this.commands.size;
  }

  /**
   * 获取所有分类
   */
  getCategories(): CommandCategory[] {
    return Array.from(this.categoryIndex.keys());
  }

  /**
   * 获取所有标签
   */
  getTags(): string[] {
    return Array.from(this.tagIndex.keys());
  }


  private getShortcutCandidates(normalizedShortcut: string): Command[] {
    const ids = this.shortcutIndex.get(normalizedShortcut);
    if (!ids) {
      return [];
    }
    return Array.from(ids)
      .map((id) => this.commands.get(id))
      .filter((cmd): cmd is Command => cmd !== undefined);
  }

  private pickPreferredCommand(commands: Command[]): Command {
    return commands.slice().sort((a, b) => {
      const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return a.id.localeCompare(b.id);
    })[0];
  }

  private isCommandVisibleInView(command: Command, view: CurrentView): boolean {
    if (!command.visibleInViews || command.visibleInViews.length === 0) {
      return true;
    }
    return command.visibleInViews.includes(view);
  }

  private hasMeaningfulShortcutConflict(command: Command, existingCommands: Command[]): boolean {
    return existingCommands.some((existing) => this.haveViewOverlap(existing, command));
  }

  private haveViewOverlap(a: Command, b: Command): boolean {
    const aViews = a.visibleInViews;
    const bViews = b.visibleInViews;

    if (!aViews || aViews.length === 0 || !bViews || bViews.length === 0) {
      return true;
    }

    return aViews.some((view) => bViews.includes(view));
  }

  /**
   * 标准化快捷键格式
   */
  normalizeShortcut(shortcut: string): string {
    return normalizeShortcutUtil(shortcut);
  }

  /**
   * 通知所有监听器
   */
  private notifyListeners(): void {
    const commands = this.getAll();
    this.listeners.forEach((listener) => {
      try {
        listener(commands);
      } catch (error: unknown) {
        console.error('[CommandRegistry] 监听器执行失败:', error);
      }
    });
  }

  /**
   * 清空所有命令（用于测试）
   */
  clear(): void {
    this.commands.clear();
    this.shortcutMap.clear();
    this.shortcutIndex.clear();
    this.categoryIndex.clear();
    this.tagIndex.clear();
    this.notifyListeners();
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    total: number;
    byCategory: Record<string, number>;
    withShortcuts: number;
  } {
    const byCategory: Record<string, number> = {};
    this.categoryIndex.forEach((ids, category) => {
      byCategory[category] = ids.size;
    });

    return {
      total: this.commands.size,
      byCategory,
      withShortcuts: this.shortcutIndex.size,
    };
  }
}

// 导出单例实例
export const commandRegistry = new CommandRegistry();

// 导出类型供测试使用
export { CommandRegistry };
