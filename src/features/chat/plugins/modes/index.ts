/**
 * Chat V2 - 模式插件导出
 *
 * 导入此文件会自动注册所有内置模式插件
 */

// 导入即注册
import './chat';
import './analysis';

// 导出模式名称
export { CHAT_MODE } from './chat';
export { ANALYSIS_MODE } from './analysis';

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

// 导出组件
export {
  OcrProgress,
  OcrResultHeader,
} from './components';
