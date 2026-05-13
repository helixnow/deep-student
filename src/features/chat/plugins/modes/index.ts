/**
 * Chat V2 - 模式插件导出
 *
 * 导入此文件会自动注册所有内置模式插件
 */

// 导入即注册
import './chat';
import './analysis';
// ★ bridge 模式已废弃（2026-01 清理）

// 导出模式名称
export { CHAT_MODE } from './chat';
export { ANALYSIS_MODE } from './analysis';
// ★ Bridge 模式已废弃，保留常量以避免编译错误
export const BRIDGE_MODE = 'bridge';
export const CANVAS_MODE = 'canvas';

// 导出 analysis 模式类型和辅助函数
export type {
  OcrStatus,
  OcrMeta,
  AnalysisModeState,
  AnalysisInitConfig,
} from './analysis';
export {
  createInitialAnalysisModeState,
  canSendInAnalysisMode,
  getAnalysisOcrStatus,
  retryOcr,
} from './analysis';

// textbook 相关类型和函数保留导出，供教材功能使用
// 注意：textbook 不再作为独立模式，而是通过 TextbookContext 控制侧栏
export type {
  TextbookLoadingStatus,
  TextbookPage,
  TextbookModeState,
  TextbookInitConfig,
} from './textbook';
export {
  createInitialTextbookModeState,
  setCurrentPage,
  goToPreviousPage,
  goToNextPage,
  getCurrentPageImageUrl,
  isTextbookLoaded,
  reloadTextbook,
} from './textbook';

// ★ Bridge 模式已废弃（2026-01 清理），保留类型存根以避免编译错误
export type BridgeLinkStatus = 'pending' | 'linking' | 'linked' | 'error';
export type BridgeModeState = Record<string, never>;
export type BridgeInitConfig = Record<string, never>;
export const createInitialBridgeModeState = (): BridgeModeState => ({});
export const getBridgeSourceInfo = (): null => null;
export const getBridgeOcrMeta = (): null => null;
export const isBridgeLinked = (): boolean => false;
export const getBridgeLinkStatus = (): BridgeLinkStatus => 'error';
export const navigateToSourceSession = (): void => {};
export const retryBridgeLink = (): void => {};

// 导出组件
export {
  OcrProgress,
  OcrResultHeader,
} from './components';
// ★ BridgeHeader 已废弃（2026-01 清理）

// Canvas 模式类型和辅助函数（保留接口以避免编译错误）
export type CanvasInitConfig = Record<string, never>;
export const isLongNote = (_content: string): boolean => false;
export const getCanvasState = (): null => null;
