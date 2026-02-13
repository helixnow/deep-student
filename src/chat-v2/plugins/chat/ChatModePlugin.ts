/**
 * Chat V2 - Chat 模式插件
 *
 * 通用聊天模式，提供：
 * - RAG 知识库检索
 * - 模型选择
 * - 高级设置
 */

import type { ModePlugin, ModeConfig } from '../../registry/modeRegistry';
import { RagPanel } from './RagPanel';
import { ModelPanel } from './ModelPanel';

// ============================================================================
// 模式配置
// ============================================================================

const chatModeConfig: ModeConfig = {
  requiresOcr: false,
  autoStartFirstMessage: false,
  systemPromptTemplate: `你是一个智能助手，能够帮助用户回答问题、解释概念、提供建议。

请遵循以下原则：
1. 提供准确、有帮助的回答
2. 如果不确定，请诚实说明
3. 保持友好和专业的语气
4. 适当使用 Markdown 格式化输出`,
  enabledTools: ['rag', 'memory', 'web_search'],
};

// ============================================================================
// 模式插件
// ============================================================================

export const chatModePlugin: ModePlugin = {
  name: 'chat',
  config: chatModeConfig,

  // 初始化回调
  onInit: async (store, initConfig) => {
    console.log('[ChatModePlugin] Initializing chat mode', initConfig);
    // 可以在这里设置初始状态
  },

  // 构建系统提示
  buildSystemPrompt: (context) => {
    return chatModeConfig.systemPromptTemplate || '';
  },

  // 获取启用的工具
  getEnabledTools: (store) => {
    return chatModeConfig.enabledTools || [];
  },

  // RAG 面板
  renderRagPanel: RagPanel,

  // 模型选择面板
  renderModelPanel: ModelPanel,

};

export default chatModePlugin;
