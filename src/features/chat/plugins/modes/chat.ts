/**
 * Chat V2 - 普通聊天模式插件
 *
 * 功能：
 * - RAG 知识库检索
 * - 模型选择
 * - 用户记忆
 * - 网络搜索
 *
 * 自执行注册：import 即注册
 */

import { modeRegistry, type SystemPromptContext, type ModeInitConfig } from '../../registry';
import type { ChatStore } from '../../core/types';
import { RagPanel } from '../chat/RagPanel';
import { ModelPanel } from '../chat/ModelPanel';
import { AdvancedPanel } from '../chat/AdvancedPanel';
import { McpPanel } from '../chat/McpPanel';

// ============================================================================
// 模式配置
// ============================================================================

/**
 * 普通聊天模式
 *
 * 特点：
 * - 不需要 OCR
 * - 不自动发起首轮消息
 * - 用户主导对话
 * - 支持 RAG/模型选择等高级功能
 */
modeRegistry.register('chat', {
  name: 'chat',
  config: {
    requiresOcr: false,
    autoStartFirstMessage: false,
    // 启用所有工具
    enabledTools: ['rag', 'web_search', 'memory'],
  },
  onInit: async (store: ChatStore, _initConfig?: ModeInitConfig) => {
    // chat 模式无特殊状态
    store.setModeState(null);
  },

  /**
   * 构建系统提示
   * 普通聊天模式使用通用助手提示
   */
  buildSystemPrompt: (_context: SystemPromptContext): string => {
    return `你是一个智能学习助手，可以帮助用户解答各种学习相关的问题。

特点：
1. 善于分析和解答各学科的问题
2. 能够提供清晰的解题思路和步骤
3. 会根据用户的理解程度调整回答的深度
4. 鼓励用户独立思考，适时给予引导

请用简洁清晰的语言回答用户的问题。`;
  },

  /**
   * 获取启用的工具列表
   * 聊天模式启用所有工具
   */
  getEnabledTools: (_store: ChatStore): string[] => {
    return ['rag', 'web_search', 'memory'];
  },

  // ========== 输入栏扩展 ==========

  /** RAG 知识库面板 */
  renderRagPanel: RagPanel,

  /** 模型选择面板 */
  renderModelPanel: ModelPanel,

  /** 对话控制（高级设置）面板 */
  renderAdvancedPanel: AdvancedPanel,

  /** MCP 工具面板 */
  renderMcpPanel: McpPanel,

});

// 导出模式名称（可选，用于类型检查）
export const CHAT_MODE = 'chat';
