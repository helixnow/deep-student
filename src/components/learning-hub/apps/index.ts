/**
 * Learning Hub 应用面板索引
 *
 * 这些是 Learning Hub 可以启动的"原生应用"。
 * 当用户在 Learning Hub 中点击资源时，会根据资源类型渲染对应的应用面板。
 *
 * 注意：推荐使用统一的 UnifiedAppPanel，它支持所有资源类型。
 */

// 统一应用面板（推荐使用）
export { UnifiedAppPanel, type UnifiedAppPanelProps, type ContentViewProps } from './UnifiedAppPanel';

/**
 * 应用类型枚举
 */
export type AppType = 'note' | 'textbook' | 'exam' | 'translation' | 'essay';

/**
 * 应用打开参数
 */
export interface AppOpenParams {
  /** 应用类型 */
  type: AppType;
  /** 资源 ID */
  id: string;
  /** 文件路径（教材专用） */
  filePath?: string;
  /** 文件名（教材专用） */
  fileName?: string;
}
