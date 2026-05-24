/**
 * Chat V2 - 事件处理插件导出
 *
 * 导入此文件会自动注册所有内置事件处理器。
 *
 * 内置事件类型：
 * - thinking: 思维链
 * - content: 正文
 * - tool_call: MCP 工具调用
 * - image_gen: 图片生成
 * - rag: 文档知识库检索
 * - memory: 用户记忆检索
 * - web_search: 网络搜索
 * - tool_approval_request: 🆕 工具审批请求（文档 29 P1-3）
 *
 * 使用方式：
 * ```typescript
 * // 在 init.ts 中导入以触发自动注册
 * import './plugins/events';
 * ```
 */

// ============================================================================
// 导入即注册（自执行）
// ============================================================================

// 基础事件
import './thinking';
import './content';

// 工具调用事件
import './toolCall';

// 统一检索事件处理（rag, memory, web_search, multimodal_rag）
import './retrieval';

// 🆕 工具审批事件（文档 29 P1-3）
import './approval';

// 🆕 工具递归限制事件
import './toolLimit';

// ✅ Anki 卡片事件（CardForge 2.0 集成）
import './ankiCards';

// ============================================================================
// 导出 handlers 供测试使用
// ============================================================================

// 基础事件处理器
export { thinkingEventHandler } from './thinking';
export { contentEventHandler } from './content';

// 工具调用事件处理器
export { toolCallEventHandler, imageGenEventHandler, toolCallPreparingEventHandler } from './toolCall';

// 检索事件处理器导出
export {
  retrievalHandlers,
  RETRIEVAL_TYPES,
  ragEventHandler,
  memoryEventHandler,
  webSearchEventHandler,
} from './retrieval';

// 🆕 工具审批事件处理器（文档 29 P1-3）
export { toolApprovalEventHandler } from './approval';

// 🆕 工具递归限制事件处理器
export { toolLimitEventHandler } from './toolLimit';

// ✅ Anki 卡片事件处理器（CardForge 2.0 集成）
export { ankiCardsEventHandler } from './ankiCards';
