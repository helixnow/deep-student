/**
 * Chat V2 - 块渲染插件导出
 *
 * 导入此文件会自动注册所有内置块渲染插件
 *
 * 内置块类型：
 * - thinking: 思维链
 * - content: 正文内容
 * - rag: 文档知识库
 * - memory: 用户记忆
 * - web_search: 网络搜索
 * - multimodal_rag: 多模态检索
 * - generic: 通用块（fallback）
 * - mcpTool: MCP 工具块
 * - imageGen: 图像生成块
 */

// ============================================================================
// 导入即注册
// ============================================================================

// 基础块
import './thinking';
import './content';
import './generic';

// 工具块
import './mcpTool';
import './imageGen';

// 系统提示块
import './toolLimit';

// 🆕 TodoList 任务列表块
import './todoList';

// 🆕 工作区状态块（多 Agent 协作）
import './workspaceStatus';

// 🆕 睡眠块和子代理嵌入块（主代理睡眠/唤醒机制）
import './sleepBlock';
import './subagentEmbed';

// 🆕 P38: 子代理重试块
import './subagentRetry';

// Anki 卡片块
import './ankiCardsBlock';

// 模板预览块（模板工具可视化直接显示在聊天流中）
import './templatePreview';

// 🆕 用户提问块（轻量级问答交互）
import './askUserBlock';

// 🆕 P1: 上下文压缩摘要块（长会话锚定摘要 + 尾部保真）
import './compactionSummary';

// 知识检索块
import './rag';
import './memory';
import './webSearch';
import './academicSearch';

// ============================================================================
// 导出组件（可选，用于测试）
// ============================================================================

// 基础块组件
export { ThinkingBlock } from './thinking';
export { ContentBlock } from './content';
export { GenericBlock } from './generic';

// 工具块组件
export { McpToolBlockComponent } from './mcpTool';
export { ImageGenBlockComponent } from './imageGen';

// 系统提示块组件
export { ToolLimitBlock } from './toolLimit';

// 🆕 TodoList 任务列表块组件
export { TodoListBlock } from './todoList';

// 🆕 PaperSave 论文下载进度块组件
export { PaperSaveBlock } from './paperSave';

// 🆕 工作区状态块组件
export { WorkspaceStatusBlockComponent } from './workspaceStatus';

// 🆕 睡眠块和子代理嵌入块组件
export { default as SleepBlockComponent } from './sleepBlock';
export { default as SubagentEmbedBlockComponent } from './subagentEmbed';

// 🆕 用户提问块组件
export { AskUserBlockComponent } from './askUserBlock';

// 🆕 P1: 压缩摘要块组件
export { CompactionSummaryBlock } from './compactionSummary';

// Anki 卡片块组件
export { AnkiCardsBlock } from './ankiCardsBlock';

// 模板预览块组件
export { TemplatePreviewBlock } from './templatePreview';

// 知识检索块组件
export { RagBlock } from './rag';
export { MemoryBlock } from './memory';
export { WebSearchBlock } from './webSearch';
export { AcademicSearchBlock } from './academicSearch';

// 通用组件
export * from './components';
