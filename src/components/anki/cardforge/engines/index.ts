/**
 * CardForge 2.0 - Engines 引擎模块统一导出
 *
 * 提供所有引擎的统一导出接口
 *
 * ## 核心引擎
 *
 * ### CardAgent
 * 统一入口，提供 MCP 工具接口：
 * - `generateCards`: 生成 Anki 卡片
 * - `controlTask`: 控制任务（暂停/恢复/取消/重试）
 * - `exportCards`: 导出卡片
 * - `listTemplates`: 列出可用模板
 * - `analyzeContent`: 分析内容
 *
 * ### SegmentEngine
 * 智能分段引擎，负责将大文档分割成适合 LLM 上下文的语义完整片段：
 * - 阶段一：硬分割（纯数学计算，按固定 token 数）
 * - 阶段二：LLM 定界（可选，当文档较大时启用，并行执行）
 * - 阶段三：构建最终分段
 *
 * ### TaskController
 * 任务控制器，提供任务级别的控制接口：
 * - `pause`: 暂停任务
 * - `resume`: 恢复任务
 * - `cancel`: 取消任务
 * - `retry`: 重试任务
 * - `getStatus`: 获取任务状态
 *
 * @module CardForge/Engines
 */

// ============================================================================
// CardAgent - 统一入口（MCP 工具接口）
// ============================================================================

export {
  CardAgent,
  cardAgent,
  generateCards,
  controlTask,
  exportCards,
  listTemplates,
  analyzeContent,
} from './CardAgent';

// ============================================================================
// SegmentEngine - 智能分段引擎
// ============================================================================

export { SegmentEngine } from './SegmentEngine';
export type { SegmentOptions } from './SegmentEngine';

// ============================================================================
// TaskController - 任务控制器
// ============================================================================

export { TaskController, createTaskController } from './TaskController';
export { default as taskController } from './TaskController';

// ============================================================================
// 任务状态规范化工具（大小写不敏感，前后端状态统一入口）
// ============================================================================

export {
  normalizeTaskStatus,
  taskStatusEquals,
  isFailedLikeTaskStatus,
  isTerminalTaskStatus,
  isActiveTaskStatus,
  ALL_TASK_STATUSES,
  FAILED_LIKE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  ACTIVE_TASK_STATUSES,
} from './taskStatus';

// ============================================================================
// 导出规整与导出前校验
// ============================================================================

export {
  normalizeToolExportCards,
  validateCardsForExport,
  filterExportableCards,
} from './exportNormalize';
export type { ExportableCardLike } from './exportNormalize';

// ============================================================================
// 类型导出（从 types 模块重新导出，方便使用）
// ============================================================================

export type {
  // 基础类型
  TaskStatus,
  TaskAction,
  ExportFormat,
  // CardAgent 工具接口
  GenerateCardsInput,
  GenerateCardsOutput,
  ControlTaskInput,
  ControlTaskOutput,
  ExportCardsInput,
  ExportCardsOutput,
  ListTemplatesInput,
  ListTemplatesOutput,
  AnalyzeContentInput,
  AnalyzeContentOutput,
  // 分段相关
  SegmentConfig,
  DocumentSegment,
  HardSplitPoint,
  BoundaryDetectionRequest,
  BoundaryDetectionResult,
  // 制卡相关
  CardGenerationTask,
  ConcurrencyConfig,
  AnkiCardResult,
  TaskInfo,
  TemplateInfo,
  GenerationStats,
  // 事件相关
  CardForgeEvent,
  CardForgeEventType,
  CardForgeEventListener,
  CardGeneratedPayload,
  TaskProgressPayload,
  DocumentCompletePayload,
  RateLimitWarningPayload,
  // 导出前校验
  ExportCardIssueCode,
  ExportCardIssueLevel,
  ExportCardValidationIssue,
  ExportCardsValidationResult,
  // 错误相关
  CardForgeError,
  CardForgeErrorCode,
  ProgressCallback,
} from '../types';
