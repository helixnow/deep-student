/**
 * CardForge 2.0 - 主入口
 *
 * 遵循 LLM-First 设计原则的 Anki 制卡系统
 *
 * @module CardForge
 * @version 2.0.0
 *
 * ## 核心设计思想
 *
 * ### LLM 驱动原则
 * 任何需要"理解"或"决策"的工作，都应该交给 LLM 完成，而不是编写硬编码规则。
 *
 * ### Agent 化思维
 * 制卡不再是"用户点击按钮触发的工作流"，而是"AI Agent 可调用的工具"。
 *
 * ### 关注点分离
 * - 表现层 (Presentation): UI 组件渲染、用户交互、进度展示
 * - 编排层 (Orchestration): 任务调度、并发控制、状态管理
 * - 智能层 (Intelligence): LLM 定界分段、模板选择、卡片生成
 * - 基础设施层 (Infrastructure): LLM API 调用、数据持久化、事件通信
 *
 * ## 快速开始
 *
 * ### 基本用法
 *
 * ```typescript
 * import { generateCards, controlTask } from '@/components/anki/cardforge';
 *
 * // 生成卡片
 * const result = await generateCards({
 *   content: '学习材料内容...',
 *   options: { deckName: 'My Deck' }
 * });
 *
 * // 暂停生成
 * await controlTask({
 *   action: 'pause',
 *   documentId: result.documentId
 * });
 * ```
 *
 * ### 与 Chat V2 集成
 *
 * ```typescript
 * import { useChatV2Anki } from '@/components/anki/cardforge';
 *
 * function ChatComponent() {
 *   const { cards, isGenerating, onCardGenerated } = useChatV2Anki();
 *
 *   // 自动监听 Chat V2 的卡片生成事件
 *   // 卡片会实时更新到 cards 数组中
 * }
 * ```
 *
 * ## 迁移指南
 *
 * 从旧版 ResumableTaskService 迁移：
 *
 * ```typescript
 * // 旧代码
 * import { ResumableTaskService } from '@/services/ResumableTaskService';
 * const service = ResumableTaskService.getInstance();
 * await service.startTask(...);
 *
 * // 新代码
 * import { cardAgent } from '@/components/anki/cardforge';
 * await cardAgent.generateCards({ content, templates });
 * ```
 */

// ============================================================================
// 核心引擎导出
// ============================================================================

// CardAgent - 统一入口（MCP 工具接口）
import {
  CardAgent,
  cardAgent,
  generateCards,
  controlTask,
  exportCards,
  listTemplates,
  analyzeContent,
  taskController,
  TaskController,
  createTaskController,
  SegmentEngine,
} from './engines';

export {
  CardAgent,
  cardAgent,
  generateCards,
  controlTask,
  exportCards,
  listTemplates,
  analyzeContent,
};

// SegmentEngine - 智能分段引擎
export { SegmentEngine };
export type { SegmentOptions } from './engines';

// TaskController - 任务控制器
export {
  TaskController,
  createTaskController,
  taskController,
};

// ============================================================================
// 任务状态规范化工具（新增导出：大小写不敏感的状态归一化，供
// ankiCardsBlock / anki-tasks 等调用方统一 'Failed' vs 'failed' 口径）
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
} from './engines';

// ============================================================================
// 导出规整与导出前校验（新增导出）
// ============================================================================

export {
  normalizeToolExportCards,
  validateCardsForExport,
  filterExportableCards,
} from './engines';
export type { ExportableCardLike } from './engines';

// ============================================================================
// PromptKit 导出
// ============================================================================

export {
  PromptKit,
  CARD_JSON_START,
  CARD_JSON_END,
  buildBoundaryPrompt,
  buildCardGenerationSystemPrompt,
  buildCardGenerationUserPrompt,
  buildContentAnalysisPrompt,
  buildErrorRepairPrompt,
  buildQualityAssessmentPrompt,
} from './prompts';

// ============================================================================
// Chat V2 适配器导出
// ============================================================================

export {
  ChatV2AnkiAdapter,
  useChatV2Anki,
  chatV2CardToCardForgeCard,
  cardForgeCardToChatV2Card,
  type ChatV2AnkiCard,
} from './adapters';

// ============================================================================
// 类型导出
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

  // 模板相关
  TemplateSelectionContext,
} from './types';

// 导出配置常量（值导出，非类型导出）
export {
  DEFAULT_SEGMENT_CONFIG,
  DEFAULT_CONCURRENCY_CONFIG,
} from './types';

// ============================================================================
// 便捷工具导出
// ============================================================================

/**
 * CardForge 版本
 */
export const CARDFORGE_VERSION = '2.0.0';

/**
 * 快速创建 CardForge 实例
 *
 * 提供完整配置的 CardForge 系统实例
 */
export function createCardForge() {
  return {
    agent: cardAgent,
    controller: taskController,
    version: CARDFORGE_VERSION,

    // 便捷方法
    generate: generateCards,
    control: controlTask,
    export: exportCards,
    templates: listTemplates,
    analyze: analyzeContent,
  };
}

/**
 * 默认导出 CardForge 系统
 */
const CardForge = createCardForge();
export default CardForge;
