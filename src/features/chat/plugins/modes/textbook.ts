/**
 * Chat V2 - 教材功能类型和工具函数
 *
 * ⚠️ textbook 不再作为独立模式，而是作为 chat 模式的功能按钮。
 * 
 * 新架构：
 * - 在 InputBarUI 中添加教材按钮（BookOpen 图标）
 * - 点击按钮调用 TextbookContext.toggleSidebar() 打开教材侧栏
 * - 教材侧栏通过 TextbookSidePanel 组件渲染
 * 
 * 此文件保留类型定义和辅助函数供教材功能使用。
 */

import i18n from 'i18next';
// 以下导入保留供未来使用，当前不再注册模式
import { getErrorMessage } from '@/utils/errorUtils';
import type { ChatStore } from '../../core/types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 加载状态
 */
export type TextbookLoadingStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * 教材页面
 */
export interface TextbookPage {
  /** 页码（1-indexed） */
  pageNum: number;
  /** 页面图片 URL 或 base64 */
  imageUrl: string;
  /** 缩略图（可选） */
  thumbnail?: string;
}

/**
 * 教材模式状态（存储在 store.modeState）
 */
export interface TextbookModeState {
  /** 教材路径 */
  textbookPath: string;
  /** 页面列表 */
  pages: TextbookPage[];
  /** 当前页码（1-indexed） */
  currentPage: number;
  /** 总页数 */
  totalPages: number;
  /** 加载状态 */
  loadingStatus: TextbookLoadingStatus;
  /** 加载错误信息 */
  loadingError: string | null;
}

/**
 * 教材模式初始化配置
 */
export interface TextbookInitConfig {
  /** 教材文件路径 */
  textbookPath: string;
  /** 初始页码（可选，默认 1） */
  initialPage?: number;
}

// ============================================================================
// 模式配置
// ============================================================================

/**
 * 教材模式配置（保留供参考，当前未使用）
 * 
 * @deprecated textbook 不再作为独立模式
 */
const _TEXTBOOK_MODE_CONFIG = {
  requiresOcr: false,
  hasPageNavigation: true,
  injectCurrentPage: true, // 发消息时自动注入当前页
  autoStartFirstMessage: false,
  // 启用知识库检索工具
  enabledTools: ['rag', 'memory'],
};
void _TEXTBOOK_MODE_CONFIG; // 避免未使用警告

// ============================================================================
// 初始化状态工厂
// ============================================================================

/**
 * 创建初始教材模式状态
 */
export function createInitialTextbookModeState(
  textbookPath: string,
  initialPage: number = 1
): TextbookModeState {
  return {
    textbookPath,
    pages: [],
    currentPage: initialPage,
    totalPages: 0,
    loadingStatus: 'idle',
    loadingError: null,
  };
}

// ============================================================================
// 教材页面加载（模拟实现）
// ============================================================================

/**
 * 加载教材页面列表
 *
 * 当前为模拟实现，返回占位数据供开发调试使用。
 * 后端 API 对接请参考：TauriAPI.loadTextbookPages
 */
async function loadTextbookPages(textbookPath: string): Promise<TextbookPage[]> {
  // 模拟加载延迟
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 返回模拟的页面列表（开发调试用）
  const mockPages: TextbookPage[] = Array.from({ length: 10 }, (_, i) => ({
    pageNum: i + 1,
    imageUrl: `mock://textbook/${textbookPath}/page-${i + 1}.png`,
    thumbnail: `mock://textbook/${textbookPath}/thumb-${i + 1}.png`,
  }));

  return mockPages;
}

// ============================================================================
// 模式插件注册（已禁用）
// ============================================================================

/**
 * 教材导学功能说明
 *
 * ⚠️ textbook 不再作为独立模式，而是作为 chat 模式的功能按钮。
 * 
 * 新架构：
 * - 在 InputBarUI 中添加教材按钮（BookOpen 图标）
 * - 点击按钮调用 TextbookContext.toggleSidebar() 打开教材侧栏
 * - 教材侧栏通过 TextbookSidePanel 组件渲染（在 AnalysisViewWithTextbook 中）
 * - 选中的教材页面通过 TextbookContext.getTextbookPagesForNextSend() 获取并注入到消息中
 * 
 * 保留以下类型和函数供教材功能使用：
 * - TextbookModeState / TextbookPage / TextbookInitConfig
 * - createInitialTextbookModeState / setCurrentPage / goToPreviousPage / goToNextPage
 * - getCurrentPageImageUrl / isTextbookLoaded / reloadTextbook
 */

// 🔧 已禁用：textbook 不再作为独立模式注册
// modeRegistry.register('textbook', { ... });

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 设置当前页码
 *
 * @param store - ChatStore 实例
 * @param pageNum - 目标页码（1-indexed）
 */
export function setCurrentPage(store: ChatStore, pageNum: number): void {
  if (store.mode !== 'textbook') {
    console.warn('[Textbook Mode] setCurrentPage can only be called in textbook mode');
    return;
  }

  const modeState = store.modeState as unknown as TextbookModeState | null;
  if (!modeState) {
    return;
  }

  // 确保页码在有效范围内
  const validPage = Math.min(Math.max(pageNum, 1), modeState.totalPages || 1);

  store.updateModeState({ currentPage: validPage });
}

/**
 * 跳转到上一页
 *
 * @param store - ChatStore 实例
 */
export function goToPreviousPage(store: ChatStore): void {
  const modeState = store.modeState as unknown as TextbookModeState | null;
  if (modeState && modeState.currentPage > 1) {
    setCurrentPage(store, modeState.currentPage - 1);
  }
}

/**
 * 跳转到下一页
 *
 * @param store - ChatStore 实例
 */
export function goToNextPage(store: ChatStore): void {
  const modeState = store.modeState as unknown as TextbookModeState | null;
  if (modeState && modeState.currentPage < modeState.totalPages) {
    setCurrentPage(store, modeState.currentPage + 1);
  }
}

/**
 * 获取当前页图片 URL
 *
 * @param store - ChatStore 实例
 * @returns 当前页图片 URL 或 undefined
 */
export function getCurrentPageImageUrl(store: ChatStore): string | undefined {
  if (store.mode !== 'textbook') {
    return undefined;
  }

  const modeState = store.modeState as unknown as TextbookModeState | null;
  if (!modeState) {
    return undefined;
  }

  const currentPageData = modeState.pages.find(
    (p) => p.pageNum === modeState.currentPage
  );

  return currentPageData?.imageUrl;
}

/**
 * 检查 textbook 模式是否加载完成
 *
 * @param store - ChatStore 实例
 * @returns 是否加载完成
 */
export function isTextbookLoaded(store: ChatStore): boolean {
  if (store.mode !== 'textbook') {
    return false;
  }

  const modeState = store.modeState as unknown as TextbookModeState | null;
  return modeState?.loadingStatus === 'success';
}

/**
 * 重新加载教材
 *
 * @param store - ChatStore 实例
 * @param textbookPath - 可选的新教材路径
 */
export async function reloadTextbook(
  store: ChatStore,
  textbookPath?: string
): Promise<void> {
  if (store.mode !== 'textbook') {
    throw new Error(i18n.t('chatV2:mode.textbook.reloadOnlyInTextbook'));
  }

  const modeState = store.modeState as unknown as TextbookModeState | null;
  const targetPath = textbookPath || modeState?.textbookPath || '';

  if (!targetPath) {
    throw new Error(i18n.t('chatV2:mode.textbook.noPathToLoad'));
  }

  // 重置状态并重新加载
  store.updateModeState({
    textbookPath: targetPath,
    loadingStatus: 'loading',
    loadingError: null,
    pages: [],
  });

  // 直接重新加载页面（不再依赖 modeRegistry）
  try {
    const pages = await loadTextbookPages(targetPath);
    store.updateModeState({
      pages,
      totalPages: pages.length,
      loadingStatus: 'success',
      currentPage: Math.min(Math.max(1, 1), pages.length),
    });
  } catch (error: unknown) {
    store.updateModeState({
      loadingStatus: 'error',
      loadingError: getErrorMessage(error),
    });
  }
}

// ============================================================================
// 导出
// ============================================================================

export const TEXTBOOK_MODE = 'textbook';
