/**
 * Chat V2 - 会话调试信息导出工具
 *
 * 用于一次性导出会话的完整调试信息，包括：
 * - 思维链（thinking content）
 * - 工具调用（tool calls）
 * - 主内容（content blocks）
 * - 工作区日志（workspace messages）
 *
 * @module debug/exportSessionDebug
 */

import type { StoreApi } from 'zustand';
import type { ChatStore, Block, Message } from '../core/types';
import { useWorkspaceStore } from '../workspace/workspaceStore';
import type { WorkspaceMessage, WorkspaceAgent } from '../workspace/types';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============================================================================
// 类型定义
// ============================================================================

/** 导出的调试信息结构 */
export interface SessionDebugInfo {
  /** 会话 ID */
  sessionId: string;
  /** 导出时间 */
  exportedAt: string;
  /** 🆕 会话状态 */
  sessionState: SessionStateDebugInfo;
  /** 消息列表 */
  messages: MessageDebugInfo[];
  /** 🆕 所有块的详细信息 */
  allBlocks: BlockDebugInfo[];
  /** 工作区信息（如果有） */
  workspace?: WorkspaceDebugInfo;
}

/** 🆕 会话状态调试信息 */
export interface SessionStateDebugInfo {
  /** 会话状态 */
  status: string;
  /** 模式 */
  mode: string;
  /** 是否正在流式 */
  isStreaming: boolean;
  /** 当前流式消息 ID */
  currentStreamingMessageId?: string;
  /** 消息数量 */
  messageCount: number;
  /** 块数量 */
  blockCount: number;
  /** 活跃块 IDs */
  activeBlockIds: string[];
  /** 聊天参数 */
  chatParams?: {
    modelId?: string;
    temperature?: number;
    maxTokens?: number;
  };
  /** 启用的功能 */
  enabledFeatures: string[];
}

/** 🆕 块详细调试信息 */
export interface BlockDebugInfo {
  id: string;
  messageId: string;
  type: string;
  status: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  content?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  firstChunkAt?: number;
  durationMs?: number;
}

/** 单条消息的调试信息 */
export interface MessageDebugInfo {
  /** 消息 ID */
  messageId: string;
  /** 角色 */
  role: 'user' | 'assistant' | 'system';
  /** 时间戳 */
  timestamp?: string;
  /** 模型 ID */
  modelId?: string;
  /** 思维链内容 */
  thinkingChain?: ThinkingDebugInfo[];
  /** 工具调用 */
  toolCalls?: ToolCallDebugInfo[];
  /** 主内容 */
  content?: string;
  /** Token 用量 */
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** 完整请求体（来自 _meta.rawRequest） */
  rawRequest?: unknown;
  /** 调试日志文件路径（完整版可从此文件读取未脱敏请求体） */
  logFilePath?: string;
  /** 用户附件 */
  attachments?: Array<{ id: string; name: string; type: string; mimeType: string; size: number }>;
  /** 上下文快照（上下文注入引用） */
  contextSnapshot?: {
    userRefs: Array<{ type: string; label?: string; resourceId?: string }>;
    retrievalRefs: Array<{ type: string; label?: string; resourceId?: string }>;
  };
}

/** 思维链调试信息 */
export interface ThinkingDebugInfo {
  /** 块 ID */
  blockId: string;
  /** 思考内容 */
  content: string;
  /** 持续时间（毫秒） */
  durationMs?: number;
}

/** 工具调用调试信息 */
export interface ToolCallDebugInfo {
  /** 块 ID */
  blockId: string;
  /** 工具名称 */
  toolName: string;
  /** 输入参数 */
  input?: Record<string, unknown>;
  /** 输出结果 */
  output?: unknown;
  /** 状态 */
  status: string;
  /** 持续时间（毫秒） */
  durationMs?: number;
  /** 错误信息 */
  error?: string;
}

/** 工作区调试信息 */
export interface WorkspaceDebugInfo {
  /** 工作区 ID */
  workspaceId: string;
  /** 工作区名称 */
  workspaceName?: string;
  /** Agent 列表 */
  agents: AgentDebugInfo[];
  /** 消息日志 */
  messages: WorkspaceMessageDebugInfo[];
  /** 🆕 子代理任务列表 */
  subagentTasks?: SubagentTaskDebugInfo[];
  /** 🆕 P20: 子代理预热时间记录 */
  subagentPreheatLogs?: SubagentPreheatLogEntry[];
  /** 🆕 P25: 子代理运行时事件日志 */
  subagentEventLogs?: SubagentEventLogEntry[];
}

/** 🆕 P20: 子代理预热时间记录 */
export interface SubagentPreheatLogEntry {
  agentSessionId: string;
  skillId?: string;
  timestamp: string;
  /** 各阶段耗时（毫秒） */
  timing: {
    /** Store 创建耗时 */
    storeCreateMs: number;
    /** Adapter setup 耗时 */
    adapterSetupMs: number;
    /** 监听器就绪等待耗时 */
    listenersWaitMs: number;
    /** runAgent 调用耗时 */
    runAgentMs: number;
    /** 总耗时 */
    totalMs: number;
  };
  /** 是否成功 */
  success: boolean;
  /** 错误信息（如果失败） */
  error?: string;
}

/** 🆕 P25: 子代理运行时事件日志 */
export interface SubagentEventLogEntry {
  timestamp: string;
  eventType: 'worker_ready' | 'worker_ready_dup' | 'worker_ready_retry' | 'coord_wake' | 'preheat_start' | 'preheat_done' | 'run_agent' | 'run_agent_result' | 'inbox_empty' | 'event_received' | 'error';
  agentSessionId?: string;
  workspaceId?: string;
  details?: string;
  error?: string;
}

// ============================================================================
// 🆕 P20: 子代理预热日志存储
// ============================================================================

/** 全局存储子代理预热日志 */
const subagentPreheatLogs: SubagentPreheatLogEntry[] = [];

/** 🆕 P25: 全局存储子代理运行时事件日志 */
const subagentEventLogs: SubagentEventLogEntry[] = [];

/** 添加子代理预热日志 */
export function addSubagentPreheatLog(entry: SubagentPreheatLogEntry): void {
  subagentPreheatLogs.push(entry);
  // 只保留最近 100 条
  if (subagentPreheatLogs.length > 100) {
    subagentPreheatLogs.shift();
  }
}

/** 获取所有子代理预热日志 */
export function getSubagentPreheatLogs(): SubagentPreheatLogEntry[] {
  return [...subagentPreheatLogs];
}

/** 清空子代理预热日志 */
export function clearSubagentPreheatLogs(): void {
  subagentPreheatLogs.length = 0;
}

/** 🆕 P25: 添加子代理运行时事件日志 */
export function addSubagentEventLog(
  eventType: SubagentEventLogEntry['eventType'],
  agentSessionId?: string,
  details?: string,
  error?: string,
  workspaceId?: string
): void {
  const entry: SubagentEventLogEntry = {
    timestamp: new Date().toISOString(),
    eventType,
    agentSessionId,
    workspaceId,
    details,
    error,
  };
  subagentEventLogs.push(entry);
  // 只保留最近 200 条
  if (subagentEventLogs.length > 200) {
    subagentEventLogs.shift();
  }
  // 同时输出到控制台，方便调试
  console.log(`[SubagentEventLog] [${eventType}] agent=${agentSessionId || 'N/A'} ${details || ''} ${error ? `ERROR: ${error}` : ''}`);
}

/** 🆕 P25: 获取所有子代理运行时事件日志 */
export function getSubagentEventLogs(): SubagentEventLogEntry[] {
  return [...subagentEventLogs];
}

/** 🆕 P25: 清空子代理运行时事件日志 */
export function clearSubagentEventLogs(): void {
  subagentEventLogs.length = 0;
}

/** Agent 调试信息 */
export interface AgentDebugInfo {
  sessionId: string;
  role: string;
  skillId?: string;
  status: string;
}

/** 🆕 子代理任务调试信息 */
export interface SubagentTaskDebugInfo {
  taskId: string;
  agentSessionId: string;
  skillId?: string;
  initialTask?: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  resultSummary?: string;
}

/** 工作区消息调试信息 */
export interface WorkspaceMessageDebugInfo {
  id: string;
  senderSessionId: string;
  targetSessionId?: string;
  messageType: string;
  content: string;
  status: string;
  createdAt: string;
}

// ============================================================================
// 导出函数
// ============================================================================

/**
 * 从 Store 导出会话的完整调试信息
 */
export function exportSessionDebugInfo(store: StoreApi<ChatStore>): SessionDebugInfo {
  const state = store.getState();
  const { sessionId, messageOrder, messageMap, blocks, sessionStatus, mode, currentStreamingMessageId, activeBlockIds, chatParams, features } = state;

  // 🆕 收集会话状态信息
  const enabledFeatures: string[] = [];
  if (features) {
    features.forEach((enabled, name) => {
      if (enabled) enabledFeatures.push(name);
    });
  }

  const sessionState: SessionStateDebugInfo = {
    status: sessionStatus,
    mode: mode || 'chat',
    isStreaming: sessionStatus === 'streaming',
    currentStreamingMessageId: currentStreamingMessageId || undefined,
    messageCount: messageOrder.length,
    blockCount: blocks.size,
    activeBlockIds: Array.from(activeBlockIds || []),
    chatParams: chatParams ? {
      modelId: chatParams.modelId,
      temperature: chatParams.temperature,
      maxTokens: chatParams.maxTokens,
    } : undefined,
    enabledFeatures,
  };

  // 收集消息调试信息
  const messageDebugInfos: MessageDebugInfo[] = [];

  for (const msgId of messageOrder) {
    const message = messageMap.get(msgId);
    if (!message) continue;

    const debugInfo = extractMessageDebugInfo(message, blocks);
    messageDebugInfos.push(debugInfo);
  }

  // 收集所有块的详细信息（完整内容，不截断）
  const allBlocks: BlockDebugInfo[] = [];
  blocks.forEach((block) => {
    allBlocks.push({
      id: block.id,
      messageId: block.messageId,
      type: block.type,
      status: block.status,
      toolName: block.toolName,
      toolInput: block.toolInput,
      toolOutput: block.toolOutput,
      content: block.content || undefined,
      error: block.error,
      startedAt: block.startedAt,
      endedAt: block.endedAt,
      firstChunkAt: block.firstChunkAt,
      durationMs: block.endedAt && block.startedAt ? block.endedAt - block.startedAt : undefined,
    });
  });

  // 收集工作区信息
  const workspaceDebugInfo = extractWorkspaceDebugInfo();

  return {
    sessionId,
    exportedAt: new Date().toISOString(),
    sessionState,
    messages: messageDebugInfos,
    allBlocks,
    workspace: workspaceDebugInfo,
  };
}

/**
 * 从单条消息提取调试信息（完整版，包含所有有效信息）
 */
function extractMessageDebugInfo(
  message: Message,
  blocks: Map<string, Block>
): MessageDebugInfo {
  const thinkingChain: ThinkingDebugInfo[] = [];
  const toolCalls: ToolCallDebugInfo[] = [];
  let mainContent = '';

  for (const blockId of message.blockIds) {
    const block = blocks.get(blockId);
    if (!block) continue;

    switch (block.type) {
      case 'thinking':
        if (block.content) {
          thinkingChain.push({
            blockId: block.id,
            content: block.content,
            durationMs: block.endedAt && block.startedAt
              ? block.endedAt - block.startedAt
              : undefined,
          });
        }
        break;

      case 'content':
        if (block.content) {
          mainContent += block.content;
        }
        break;

      default:
        // 所有非 thinking/content 块统一记录（覆盖 rag、image_gen、workspace_status 等）
        {
          toolCalls.push({
            blockId: block.id,
            toolName: block.toolName || block.type,
            input: block.toolInput,
            output: block.toolOutput,
            status: block.status,
            durationMs: block.endedAt && block.startedAt
              ? block.endedAt - block.startedAt
              : undefined,
            error: block.error,
          });
        }
        break;
    }
  }

  // 提取 rawRequest 和 logFilePath
  const raw = message._meta?.rawRequest as
    | { _source?: string; model?: string; url?: string; body?: unknown; logFilePath?: string }
    | undefined;

  // 提取上下文快照
  const ctxSnap = message._meta?.contextSnapshot as unknown as
    | { userRefs?: Array<{ type: string; label?: string; resourceId?: string }>; retrievalRefs?: Array<{ type: string; label?: string; resourceId?: string }> }
    | undefined;

  return {
    messageId: message.id,
    role: message.role,
    timestamp: message.timestamp ? new Date(message.timestamp).toISOString() : undefined,
    modelId: message._meta?.modelId,
    thinkingChain: thinkingChain.length > 0 ? thinkingChain : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    content: mainContent || undefined,
    tokenUsage: message._meta?.usage ? {
      promptTokens: message._meta.usage.promptTokens,
      completionTokens: message._meta.usage.completionTokens,
      totalTokens: message._meta.usage.totalTokens,
    } : undefined,
    rawRequest: raw ?? message._meta?.rawRequest,
    logFilePath: raw?.logFilePath,
    attachments: message.attachments?.map(a => ({
      id: a.id, name: a.name, type: a.type, mimeType: a.mimeType, size: a.size,
    })),
    contextSnapshot: ctxSnap ? {
      userRefs: ctxSnap.userRefs ?? [],
      retrievalRefs: ctxSnap.retrievalRefs ?? [],
    } : undefined,
  };
}

/**
 * 提取工作区调试信息
 */
function extractWorkspaceDebugInfo(): WorkspaceDebugInfo | undefined {
  const workspaceState = useWorkspaceStore.getState();
  const { workspace, agents, messages } = workspaceState;

  if (!workspace) return undefined;

  // 🔧 P21 修复：按 workspaceId 过滤 agents 和 messages
  const filteredAgents = agents.filter((a: WorkspaceAgent) => a.workspaceId === workspace.id);
  const filteredMessages = messages.filter((m: WorkspaceMessage) => m.workspaceId === workspace.id);

  // 🆕 提取子代理任务信息（从 agents 中过滤 subagent_*）
  const subagentTasks: SubagentTaskDebugInfo[] = filteredAgents
    .filter((agent: WorkspaceAgent) => agent.sessionId.startsWith('subagent_'))
    .map((agent: WorkspaceAgent) => ({
      taskId: `task_${agent.sessionId}`,
      agentSessionId: agent.sessionId,
      skillId: agent.skillId,
      status: agent.status,
      createdAt: agent.joinedAt || new Date().toISOString(),
    }));

  // 🆕 P20: 获取子代理预热日志
  const preheatLogs = getSubagentPreheatLogs();
  // 🆕 P25: 获取子代理运行时事件日志
  const eventLogs = getSubagentEventLogs();

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    agents: filteredAgents.map((agent: WorkspaceAgent) => ({
      sessionId: agent.sessionId,
      role: agent.role,
      skillId: agent.skillId,
      status: agent.status,
    })),
    messages: filteredMessages.map((msg: WorkspaceMessage) => ({
      id: msg.id,
      senderSessionId: msg.senderSessionId,
      targetSessionId: msg.targetSessionId,
      messageType: msg.messageType,
      content: msg.content,
      status: msg.status,
      createdAt: msg.createdAt,
    })),
    subagentTasks: subagentTasks.length > 0 ? subagentTasks : undefined,
    subagentPreheatLogs: preheatLogs.length > 0 ? preheatLogs : undefined,
    subagentEventLogs: eventLogs.length > 0 ? eventLogs : undefined,
  };
}

// ============================================================================
// 格式化输出
// ============================================================================

/**
 * 将调试信息格式化为可读的文本
 */
export function formatDebugInfoAsText(info: SessionDebugInfo): string {
  const lines: string[] = [];

  // 头部信息
  lines.push('═'.repeat(60));
  lines.push('📋 会话调试信息导出');
  lines.push('═'.repeat(60));
  lines.push(`会话 ID: ${info.sessionId}`);
  lines.push(`导出时间: ${info.exportedAt}`);
  lines.push('');

  // 🆕 会话状态
  lines.push('─'.repeat(60));
  lines.push('⚙️ 会话状态');
  lines.push('─'.repeat(60));
  lines.push(`状态: ${info.sessionState.status}`);
  lines.push(`模式: ${info.sessionState.mode}`);
  lines.push(`消息数: ${info.sessionState.messageCount}`);
  lines.push(`块数: ${info.sessionState.blockCount}`);
  if (info.sessionState.isStreaming) {
    lines.push(`🔄 正在流式，消息 ID: ${info.sessionState.currentStreamingMessageId || 'N/A'}`);
  }
  if (info.sessionState.activeBlockIds.length > 0) {
    lines.push(`活跃块: ${info.sessionState.activeBlockIds.map(id => id.slice(-8)).join(', ')}`);
  }
  if (info.sessionState.chatParams) {
    lines.push(`模型: ${info.sessionState.chatParams.modelId || 'N/A'}`);
    if (info.sessionState.chatParams.temperature !== undefined) {
      lines.push(`温度: ${info.sessionState.chatParams.temperature}`);
    }
  }
  if (info.sessionState.enabledFeatures.length > 0) {
    lines.push(`启用功能: ${info.sessionState.enabledFeatures.join(', ')}`);
  }
  lines.push('');

  // 消息列表
  for (const msg of info.messages) {
    lines.push('─'.repeat(60));
    const roleIcon = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '⚙️';
    lines.push(`${roleIcon} ${msg.role.toUpperCase()} (${msg.messageId.slice(-8)})`);
    if (msg.timestamp) lines.push(`   时间: ${msg.timestamp}`);
    if (msg.modelId) lines.push(`   模型: ${msg.modelId}`);
    lines.push('');

    // 思维链
    if (msg.thinkingChain && msg.thinkingChain.length > 0) {
      lines.push('   💭 思维链:');
      for (const thinking of msg.thinkingChain) {
        const duration = thinking.durationMs ? ` (${thinking.durationMs}ms)` : '';
        lines.push(`   ┌─ 块 ${thinking.blockId.slice(-8)}${duration}`);
        // 缩进思考内容
        const thinkingLines = thinking.content.split('\n');
        for (const tLine of thinkingLines.slice(0, 20)) { // 限制显示行数
          lines.push(`   │ ${tLine}`);
        }
        if (thinkingLines.length > 20) {
          lines.push(`   │ ... (${thinkingLines.length - 20} 行省略)`);
        }
        lines.push('   └─');
      }
      lines.push('');
    }

    // 工具调用
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      lines.push('   🔧 工具调用:');
      for (const tool of msg.toolCalls) {
        const duration = tool.durationMs ? ` (${tool.durationMs}ms)` : '';
        const statusIcon = tool.status === 'success' ? '✅' : tool.status === 'error' ? '❌' : '⏳';
        lines.push(`   ┌─ ${statusIcon} ${tool.toolName}${duration}`);
        if (tool.input) {
          lines.push(`   │ 输入: ${JSON.stringify(tool.input, null, 2).split('\n').join('\n   │       ')}`);
        }
        if (tool.output !== undefined) {
          const outputStr = typeof tool.output === 'string' 
            ? tool.output 
            : JSON.stringify(tool.output, null, 2);
          const outputLines = outputStr.split('\n');
          lines.push(`   │ 输出:`);
          for (const oLine of outputLines.slice(0, 10)) {
            lines.push(`   │   ${oLine}`);
          }
          if (outputLines.length > 10) {
            lines.push(`   │   ... (${outputLines.length - 10} 行省略)`);
          }
        }
        if (tool.error) {
          lines.push(`   │ ❌ 错误: ${tool.error}`);
        }
        lines.push('   └─');
      }
      lines.push('');
    }

    // 主内容
    if (msg.content) {
      lines.push('   📝 内容:');
      const contentLines = msg.content.split('\n');
      for (const cLine of contentLines.slice(0, 30)) {
        lines.push(`   ${cLine}`);
      }
      if (contentLines.length > 30) {
        lines.push(`   ... (${contentLines.length - 30} 行省略)`);
      }
      lines.push('');
    }

    // Token 用量
    if (msg.tokenUsage) {
      lines.push(`   📊 Token: prompt=${msg.tokenUsage.promptTokens || 0}, completion=${msg.tokenUsage.completionTokens || 0}, total=${msg.tokenUsage.totalTokens || 0}`);
      lines.push('');
    }

    // 附件
    if (msg.attachments && msg.attachments.length > 0) {
      lines.push('   📎 附件:');
      for (const att of msg.attachments) {
        lines.push(`   - ${att.name} (${att.type}, ${att.mimeType}, ${(att.size / 1024).toFixed(1)}KB)`);
      }
      lines.push('');
    }

    // 上下文快照
    if (msg.contextSnapshot) {
      const { userRefs, retrievalRefs } = msg.contextSnapshot;
      if (userRefs.length > 0 || retrievalRefs.length > 0) {
        lines.push('   📌 上下文注入:');
        if (userRefs.length > 0) {
          lines.push(`   用户引用 (${userRefs.length}):`);
          for (const r of userRefs) {
            lines.push(`     - [${r.type}] ${r.label || r.resourceId || 'N/A'}`);
          }
        }
        if (retrievalRefs.length > 0) {
          lines.push(`   检索引用 (${retrievalRefs.length}):`);
          for (const r of retrievalRefs) {
            lines.push(`     - [${r.type}] ${r.label || r.resourceId || 'N/A'}`);
          }
        }
        lines.push('');
      }
    }

    // 请求体摘要
    if (msg.rawRequest) {
      const raw = msg.rawRequest as { _source?: string; model?: string; url?: string; body?: unknown };
      lines.push('   🌐 请求体:');
      if (raw._source === 'backend_llm') {
        lines.push(`   来源: 后端 LLM | 模型: ${raw.model || 'N/A'}`);
        lines.push(`   URL: ${raw.url || 'N/A'}`);
      }
      if (msg.logFilePath) {
        lines.push(`   📁 完整日志: ${msg.logFilePath}`);
      }
      lines.push('');
    }
  }

  // 工作区信息
  if (info.workspace) {
    lines.push('');
    lines.push('═'.repeat(60));
    lines.push('🏢 工作区信息');
    lines.push('═'.repeat(60));
    lines.push(`工作区 ID: ${info.workspace.workspaceId}`);
    if (info.workspace.workspaceName) {
      lines.push(`名称: ${info.workspace.workspaceName}`);
    }
    lines.push('');

    // Agent 列表
    if (info.workspace.agents.length > 0) {
      lines.push('👥 Agent 列表:');
      for (const agent of info.workspace.agents) {
        const statusIcon = agent.status === 'completed' ? '✅' : 
                          agent.status === 'running' ? '🔄' : 
                          agent.status === 'failed' ? '❌' : '⏸️';
        lines.push(`   ${statusIcon} ${agent.role} (${agent.sessionId.slice(-8)})${agent.skillId ? ` - ${agent.skillId}` : ''}`);
      }
      lines.push('');
    }

    // 🆕 子代理任务列表
    if (info.workspace.subagentTasks && info.workspace.subagentTasks.length > 0) {
      lines.push('💾 子代理任务（持久化）:');
      for (const task of info.workspace.subagentTasks) {
        const statusIcon = task.status === 'completed' ? '✅' : 
                          task.status === 'running' ? '🔄' : 
                          task.status === 'failed' ? '❌' : '⏸️';
        lines.push(`   ${statusIcon} ${task.agentSessionId.slice(-12)}`);
        lines.push(`      状态: ${task.status}`);
        if (task.skillId) lines.push(`      技能: ${task.skillId}`);
        if (task.initialTask) {
          const taskPreview = task.initialTask.length > 50 
            ? task.initialTask.slice(0, 50) + '...' 
            : task.initialTask;
          lines.push(`      任务: ${taskPreview}`);
        }
        lines.push(`      创建: ${new Date(task.createdAt).toLocaleTimeString()}`);
        if (task.startedAt) lines.push(`      启动: ${new Date(task.startedAt).toLocaleTimeString()}`);
        if (task.completedAt) lines.push(`      完成: ${new Date(task.completedAt).toLocaleTimeString()}`);
        if (task.resultSummary) lines.push(`      结果: ${task.resultSummary}`);
      }
      lines.push('');
    }

    // 工作区消息日志
    if (info.workspace.messages.length > 0) {
      lines.push('📨 工作区消息日志:');
      for (const wsMsg of info.workspace.messages) {
        const time = new Date(wsMsg.createdAt).toLocaleTimeString();
        const target = wsMsg.targetSessionId ? ` → ${wsMsg.targetSessionId.slice(-6)}` : ' (广播)';
        lines.push(`   [${time}] [${wsMsg.messageType}] ${wsMsg.senderSessionId.slice(-6)}${target}`);
        // 缩进消息内容
        const msgLines = wsMsg.content.split('\n');
        for (const mLine of msgLines.slice(0, 5)) {
          lines.push(`      ${mLine}`);
        }
        if (msgLines.length > 5) {
          lines.push(`      ... (${msgLines.length - 5} 行省略)`);
        }
      }
      lines.push('');
    }

    // 🆕 子代理预热日志
    if (info.workspace.subagentPreheatLogs && info.workspace.subagentPreheatLogs.length > 0) {
      lines.push('⏱️ 子代理预热时间日志:');
      for (const log of info.workspace.subagentPreheatLogs) {
        const statusIcon = log.success ? '✅' : '❌';
        lines.push(`   ${statusIcon} ${log.agentSessionId.slice(-12)}${log.skillId ? ` (${log.skillId})` : ''}`);
        lines.push(`      时间: ${log.timestamp}`);
        lines.push(`      Store创建: ${log.timing.storeCreateMs}ms`);
        lines.push(`      Adapter设置: ${log.timing.adapterSetupMs}ms`);
        lines.push(`      监听器等待: ${log.timing.listenersWaitMs}ms`);
        lines.push(`      runAgent: ${log.timing.runAgentMs}ms`);
        lines.push(`      总计: ${log.timing.totalMs}ms`);
        if (log.error) {
          lines.push(`      ❌ 错误: ${log.error}`);
        }
      }
      lines.push('');
    }

    // 🆕 P25: 子代理运行时事件日志
    if (info.workspace.subagentEventLogs && info.workspace.subagentEventLogs.length > 0) {
      lines.push('📋 子代理运行时事件日志:');
      for (const log of info.workspace.subagentEventLogs) {
        const eventIcons: Record<string, string> = {
          worker_ready: '🚀',
          worker_ready_dup: '⚠️',
          coord_wake: '⏰',
          preheat_start: '🔥',
          preheat_done: '✅',
          run_agent: '▶️',
          run_agent_result: '📤',
          inbox_empty: '📭',
          event_received: '📨',
          error: '❌',
        };
        const icon = eventIcons[log.eventType] || '📋';
        const time = new Date(log.timestamp).toLocaleTimeString();
        const agent = log.agentSessionId ? log.agentSessionId.slice(-12) : 'N/A';
        lines.push(`   ${icon} [${time}] [${log.eventType}] agent=${agent}`);
        if (log.details) {
          lines.push(`      详情: ${log.details}`);
        }
        if (log.error) {
          lines.push(`      ❌ 错误: ${log.error}`);
        }
      }
      lines.push('');
    }
  }

  // 🆕 所有块详情
  if (info.allBlocks.length > 0) {
    lines.push('');
    lines.push('═'.repeat(60));
    lines.push('🧱 所有块详情');
    lines.push('═'.repeat(60));
    for (const block of info.allBlocks) {
      const statusIcon = block.status === 'success' ? '✅' : 
                        block.status === 'running' ? '🔄' : 
                        block.status === 'error' ? '❌' : '⏸️';
      const duration = block.durationMs ? ` (${block.durationMs}ms)` : '';
      lines.push(`${statusIcon} [${block.type}] ${block.id.slice(-8)} → msg:${block.messageId.slice(-8)}${duration}`);
      if (block.toolName) lines.push(`   工具: ${block.toolName}`);
      if (block.error) lines.push(`   ❌ 错误: ${block.error}`);
      if (block.toolInput) {
        const inputStr = JSON.stringify(block.toolInput);
        lines.push(`   输入: ${inputStr.length > 100 ? inputStr.slice(0, 100) + '...' : inputStr}`);
      }
      if (block.toolOutput) {
        const outputStr = JSON.stringify(block.toolOutput);
        lines.push(`   输出: ${outputStr.length > 100 ? outputStr.slice(0, 100) + '...' : outputStr}`);
      }
    }
  }

  lines.push('');
  lines.push('═'.repeat(60));
  lines.push('导出完成');
  lines.push('═'.repeat(60));

  return lines.join('\n');
}

/**
 * 将调试信息格式化为 JSON
 */
export function formatDebugInfoAsJson(info: SessionDebugInfo): string {
  return JSON.stringify(info, null, 2);
}

/**
 * 复制调试信息到剪贴板
 */
export async function copyDebugInfoToClipboard(
  store: StoreApi<ChatStore>,
  format: 'text' | 'json' = 'text'
): Promise<void> {
  const info = exportSessionDebugInfo(store);
  const text = format === 'json' 
    ? formatDebugInfoAsJson(info) 
    : formatDebugInfoAsText(info);
  
  await copyTextToClipboard(text);
}
