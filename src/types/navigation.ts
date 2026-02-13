/**
 * 导航历史类型定义
 * 支持参数化历史、状态恢复、中转页过滤
 *
 * 清理说明（2026-02）：
 * - 已彻底移除废弃视图类型：analysis、chat、notes、markdown-editor、
 *   textbook-library、exam-sheet、batch、review
 * - 历史兼容入口统一在 canonicalizeView(string) 做字符串级重定向
 */

export type CurrentView =
  | 'chat-v2'           // Chat V2 正式入口（主入口）
  | 'settings'
  | 'dashboard'
  | 'data-management'
  | 'task-dashboard'     // 制卡任务管理页面
  | 'template-management'
  | 'template-json-preview'
  | 'crepe-demo'
  | 'pdf-reader'
  | 'learning-hub'      // Learning Hub 学习资源全屏模式
  | 'skills-management' // 技能管理页面
  | 'chat-v2-test'      // Chat V2 集成测试页面（开发用）
  | 'tree-test';          // 树形拖拽测试（开发用）

/**
 * 导航历史项：包含视图、参数和状态恢复函数
 */
export interface NavigationHistoryEntry {
  /** 视图标识 */
  view: CurrentView;
  /** 可选参数：如 cardId 等 */
  params?: Record<string, any>;
  /** 状态恢复函数（滚动位置、筛选条件等） */
  restore?: () => void | Promise<void>;
  /** 创建时间戳（用于去重和调试） */
  timestamp: number;
}

/**
 * 中转视图：不应进入历史栈的临时页面
 */
export const SKIP_IN_HISTORY: Set<CurrentView> = new Set([]);

/**
 * 历史栈最大长度
 */
export const MAX_HISTORY_LENGTH = 200;
