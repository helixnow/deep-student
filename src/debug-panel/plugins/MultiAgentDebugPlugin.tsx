/**
 * MultiAgentDebugPlugin - 多 Agent 协作调试插件
 *
 * 功能：
 * 1. 监控工作区状态、Agent 列表、消息流
 * 2. 使用预定 Prompt 一键启动多 Agent 调试
 * 3. 复制运行日志以便排查问题
 *
 * @since 2026-01-18
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { Separator } from '../../components/ui/shad/Separator';
import { Input } from '../../components/ui/shad/Input';
import { Textarea } from '../../components/ui/shad/Textarea';
import { ScrollArea } from '../../components/ui/shad/ScrollArea';
import {
  Copy,
  Trash2,
  Play,
  Users,
  MessageSquare,
  Folder,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  Send,
  Bot,
  User,
  FileText,
  Plus,
} from 'lucide-react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { useWorkspaceStore } from '../../chat-v2/workspace/workspaceStore';
import { WORKSPACE_EVENTS } from '../../chat-v2/workspace/events';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import type {
  WorkspaceMessage,
  WorkspaceAgent,
} from '../../chat-v2/workspace/types';
import { sessionManager } from '../../chat-v2/core/session/sessionManager';
import type { BackendEvent } from '../../chat-v2/core/middleware/eventBridge';
import { debugLog } from '../debugMasterSwitch';

function isTauriEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as any).__TAURI_INTERNALS__)
  );
}

function normalizeToolName(name: string): string {
  return name
    .replace('builtin-', '')
    .replace('mcp.tools.', '')
    .replace(/^.*\./, '');
}

// =============================================================================
// 类型定义
// =============================================================================

interface MultiAgentLogEntry {
  id: string;
  timestamp: string;
  type: 'workspace' | 'agent' | 'message' | 'error' | 'system' | 'block';
  action: string;
  data: Record<string, unknown>;
  severity: 'info' | 'success' | 'warning' | 'error';
}

interface PresetPrompt {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

// =============================================================================
// 预设调试 Prompt
// =============================================================================

const PRESET_PROMPTS: PresetPrompt[] = [
  {
    id: 'create-workspace',
    name: '创建工作区',
    description: '创建一个新的多 Agent 工作区',
    prompt: '请创建一个工作区，用于协作完成任务。',
  },
  {
    id: 'create-research-agent',
    name: '创建研究 Agent',
    description: '创建一个负责调研的 Worker Agent',
    prompt: '请在当前工作区中创建一个研究员 Agent（skill_id: research），让它帮我调研"人工智能在教育领域的应用"这个主题。',
  },
  {
    id: 'create-writer-agent',
    name: '创建写作 Agent',
    description: '创建一个负责写作的 Worker Agent',
    prompt: '请在当前工作区中创建一个写作 Agent（skill_id: writer），让它根据调研结果撰写一篇文章。',
  },
  {
    id: 'full-workflow',
    name: '完整工作流测试',
    description: '创建工作区并启动完整的多 Agent 协作流程',
    prompt: `请帮我完成以下任务：
1. 创建一个名为"AI教育研究"的工作区
2. 创建一个研究员 Agent，让它调研"人工智能在教育领域的最新应用"
3. 等待研究完成后，创建一个写作 Agent 来整理研究结果
请开始执行。`,
  },
  {
    id: 'query-workspace',
    name: '查询工作区状态',
    description: '查询当前工作区的 Agent 和消息',
    prompt: '请查询当前工作区的状态，包括所有 Agent 和最近的消息。',
  },
];

// =============================================================================
// 日志存储
// =============================================================================

const MAX_LOGS = 500;
let multiAgentLogs: MultiAgentLogEntry[] = [];

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export function logMultiAgent(
  type: MultiAgentLogEntry['type'],
  action: string,
  data: Record<string, unknown>,
  severity: MultiAgentLogEntry['severity'] = 'info'
): void {
  const entry: MultiAgentLogEntry = {
    id: `ma-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    type,
    action,
    data,
    severity,
  };

  multiAgentLogs.push(entry);
  if (multiAgentLogs.length > MAX_LOGS) {
    multiAgentLogs = multiAgentLogs.slice(-MAX_LOGS);
  }

  // 派发自定义事件
  window.dispatchEvent(
    new CustomEvent('multi_agent_log', { detail: entry })
  );

  // 控制台输出
  const prefix = `[MultiAgent:${type}]`;
  const logFn = severity === 'error' ? console.error : severity === 'warning' ? console.warn : console.log;
  logFn(prefix, action, data);
}

export function clearMultiAgentLogs(): void {
  multiAgentLogs = [];
  window.dispatchEvent(new CustomEvent('multi_agent_logs_cleared'));
}

export function getMultiAgentLogs(): MultiAgentLogEntry[] {
  return [...multiAgentLogs];
}

// 全局注入
(window as any).__multiAgentDebug = {
  log: logMultiAgent,
  clear: clearMultiAgentLogs,
  getLogs: getMultiAgentLogs,
};

// =============================================================================
// 组件
// =============================================================================

const MultiAgentDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
}) => {
  const [logs, setLogs] = useState<MultiAgentLogEntry[]>([]);
  const [customPrompt, setCustomPrompt] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [activeTab, setActiveTab] = useState<'monitor' | 'prompts' | 'logs'>('monitor');
  const logsEndRef = useRef<HTMLDivElement>(null);
  const toolCallMapRef = useRef(new Map<string, { toolName: string; messageId?: string }>());
  const toolEventUnlistenMapRef = useRef(new Map<string, UnlistenFn>());

  // 从 Store 获取工作区状态
  const {
    currentWorkspaceId,
    workspace,
    agents,
    messages,
    isLoading,
    error,
  } = useWorkspaceStore();

  // 监听日志事件
  useEffect(() => {
    if (!isActive) return;

    const handleLogAdded = (e: Event) => {
      const entry = (e as CustomEvent<MultiAgentLogEntry>).detail;
      setLogs((prev) => [...prev, entry]);
    };

    const handleLogsCleared = () => {
      setLogs([]);
    };

    // 初始加载
    setLogs(getMultiAgentLogs());

    window.addEventListener('multi_agent_log', handleLogAdded);
    window.addEventListener('multi_agent_logs_cleared', handleLogsCleared);

    return () => {
      window.removeEventListener('multi_agent_log', handleLogAdded);
      window.removeEventListener('multi_agent_logs_cleared', handleLogsCleared);
    };
  }, [isActive]);

  // 监听工作区事件并记录日志
  useEffect(() => {
    if (!isActive) return;
    if (!isTauriEnvironment()) return;

    const unlistenFns: UnlistenFn[] = [];
    let unsubscribeSessionEvents: (() => void) | null = null;

    const buildToolCallKey = (sessionId: string, blockId: string) => `${sessionId}:${blockId}`;

    const unregisterToolEventListener = (sessionId: string) => {
      const existing = toolEventUnlistenMapRef.current.get(sessionId);
      if (existing) {
        existing();
        toolEventUnlistenMapRef.current.delete(sessionId);
      }
    };

    const registerToolEventListener = async (sessionId: string) => {
      if (!sessionId || toolEventUnlistenMapRef.current.has(sessionId)) return;

      const toolEventChannel = `chat_v2_event_${sessionId}`;
      const unlistenToolEvents = await listen(
        toolEventChannel,
        (event) => {
          const backendEvent = event.payload as BackendEvent;
          if (backendEvent.type !== 'tool_call') return;

          const toolPayload = backendEvent.payload as { toolName?: string; toolInput?: unknown } | undefined;
          const blockId = backendEvent.blockId ?? '';

          if (backendEvent.phase === 'start') {
            const toolName = toolPayload?.toolName ?? '';
            const normalizedToolName = normalizeToolName(toolName);
            if (!normalizedToolName.startsWith('workspace_') && normalizedToolName !== 'subagent_call') return;

            if (blockId) {
              toolCallMapRef.current.set(buildToolCallKey(sessionId, blockId), {
                toolName: normalizedToolName,
                messageId: backendEvent.messageId,
              });
            }

            logMultiAgent('workspace', 'TOOL_CALL_START', {
              toolName: normalizedToolName,
              blockId,
              messageId: backendEvent.messageId,
              toolInput: toolPayload?.toolInput,
              sessionId,
            }, 'info');
            return;
          }

          const cached = blockId ? toolCallMapRef.current.get(buildToolCallKey(sessionId, blockId)) : undefined;
          const toolName = cached?.toolName ?? normalizeToolName(toolPayload?.toolName ?? '');
          if (!toolName.startsWith('workspace_') && toolName !== 'subagent_call') return;

          if (backendEvent.phase === 'end') {
            logMultiAgent('workspace', 'TOOL_CALL_END', {
              toolName,
              blockId,
              result: backendEvent.result,
              sessionId,
            }, 'success');
            if (blockId) toolCallMapRef.current.delete(buildToolCallKey(sessionId, blockId));
          } else if (backendEvent.phase === 'error') {
            logMultiAgent('error', 'TOOL_CALL_ERROR', {
              toolName,
              blockId,
              error: backendEvent.error,
              sessionId,
            }, 'error');
            if (blockId) toolCallMapRef.current.delete(buildToolCallKey(sessionId, blockId));
          }
        }
      );

      toolEventUnlistenMapRef.current.set(sessionId, unlistenToolEvents);
    };

    const setupListeners = async () => {
      // 消息事件
      const unlistenMessage = await listen(
        WORKSPACE_EVENTS.MESSAGE_RECEIVED,
        (event) => {
          logMultiAgent('message', 'MESSAGE_RECEIVED', event.payload as Record<string, unknown>, 'info');
        }
      );
      unlistenFns.push(unlistenMessage);

      // Agent 加入
      const unlistenAgentJoined = await listen(
        WORKSPACE_EVENTS.AGENT_JOINED,
        (event) => {
          logMultiAgent('agent', 'AGENT_JOINED', event.payload as Record<string, unknown>, 'success');
        }
      );
      unlistenFns.push(unlistenAgentJoined);

      // Agent 状态变更
      const unlistenAgentStatus = await listen(
        WORKSPACE_EVENTS.AGENT_STATUS_CHANGED,
        (event) => {
          logMultiAgent('agent', 'AGENT_STATUS_CHANGED', event.payload as Record<string, unknown>, 'info');
        }
      );
      unlistenFns.push(unlistenAgentStatus);

      // Worker 准备启动
      const unlistenWorkerReady = await listen(
        WORKSPACE_EVENTS.WORKER_READY,
        (event) => {
          logMultiAgent('agent', 'WORKER_READY', event.payload as Record<string, unknown>, 'success');
        }
      );
      unlistenFns.push(unlistenWorkerReady);

      // 工作区关闭
      const unlistenClosed = await listen(
        WORKSPACE_EVENTS.WORKSPACE_CLOSED,
        (event) => {
          logMultiAgent('workspace', 'WORKSPACE_CLOSED', event.payload as Record<string, unknown>, 'warning');
        }
      );
      unlistenFns.push(unlistenClosed);

      // 🆕 监听工具调用事件（捕获 workspace_* 工具调用）
      const sessionIds = sessionManager.getAllSessionIds();
      await Promise.all(sessionIds.map(registerToolEventListener));

      unsubscribeSessionEvents = sessionManager.subscribe((event) => {
        if (event.type === 'session-created') {
          registerToolEventListener(event.sessionId);
        } else if (event.type === 'session-destroyed' || event.type === 'session-evicted') {
          unregisterToolEventListener(event.sessionId);
          toolCallMapRef.current.forEach((_value, key) => {
            if (key.startsWith(`${event.sessionId}:`)) {
              toolCallMapRef.current.delete(key);
            }
          });
        }
      });
    };

    setupListeners();

    return () => {
      unlistenFns.forEach((fn) => fn());
      if (unsubscribeSessionEvents) {
        unsubscribeSessionEvents();
      }
      toolEventUnlistenMapRef.current.forEach((fn) => fn());
      toolEventUnlistenMapRef.current.clear();
      toolCallMapRef.current.clear();
    };
  }, [isActive]);

  // 🆕 P37: workspace_status 块持久化日志已直接注入到源代码中
  // - toolCall.ts: FRONTEND_CREATE_WORKSPACE_STATUS_BLOCK, UPSERT_WORKSPACE_STATUS_BLOCK, UPSERT_WORKSPACE_STATUS_BLOCK_SUCCESS/ERROR
  // - TauriAdapter.ts: LOAD_SESSION_RESULT
  // 无需在此处拦截 invoke

  // 自动滚动到底部
  useEffect(() => {
    if (activeTab === 'logs' && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, activeTab]);

  // 清空日志
  const handleClearLogs = useCallback(() => {
    clearMultiAgentLogs();
  }, []);

  // 复制日志
  const handleCopyLogs = useCallback(() => {
    const report = {
      title: '多 Agent 调试报告',
      generatedAt: new Date().toISOString(),
      workspace: {
        id: currentWorkspaceId,
        name: workspace?.name,
        status: workspace?.status,
      },
      agents: agents.map((a) => ({
        sessionId: a.sessionId,
        role: a.role,
        status: a.status,
        skillId: a.skillId,
      })),
      messagesCount: messages.length,
      logsCount: logs.length,
      logs: logs.map((l) => ({
        timestamp: l.timestamp,
        type: l.type,
        action: l.action,
        severity: l.severity,
        data: l.data,
      })),
    };

    navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    logMultiAgent('system', 'LOGS_COPIED', { logsCount: logs.length }, 'success');
  }, [logs, currentWorkspaceId, workspace, agents, messages]);

  // 执行预设 Prompt
  const handleExecutePrompt = useCallback(async (prompt: string) => {
    if (!prompt.trim()) return;

    setIsExecuting(true);
    logMultiAgent('system', 'PROMPT_EXECUTE_START', { prompt: prompt.slice(0, 100) + '...' }, 'info');

    try {
      // 🔧 修复：直接使用 sessionManager 发送消息到当前活跃会话
      const currentSessionId = sessionManager.getCurrentSessionId();
      if (!currentSessionId) {
        throw new Error('没有活跃的聊天会话，请先打开一个聊天会话');
      }

      const store = sessionManager.get(currentSessionId);
      if (!store) {
        throw new Error(`无法获取会话 Store: ${currentSessionId}`);
      }

      // 检查会话状态
      const sessionStatus = store.getState().sessionStatus;
      if (sessionStatus === 'streaming') {
        throw new Error('当前会话正在响应中，请等待完成后再试');
      }

      // 发送消息
      await store.getState().sendMessage(prompt.trim());

      logMultiAgent('system', 'PROMPT_SENT', { 
        promptLength: prompt.length,
        sessionId: currentSessionId,
      }, 'success');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logMultiAgent('system', 'PROMPT_EXECUTE_ERROR', { error: errorMsg }, 'error');
      // 显示错误提示
      console.error('[MultiAgentDebug] 发送失败:', errorMsg);
    } finally {
      setIsExecuting(false);
    }
  }, []);

  // 刷新工作区状态
  const handleRefresh = useCallback(async () => {
    if (!currentWorkspaceId) return;
    const currentSessionId = sessionManager.getCurrentSessionId();
    if (!currentSessionId) return;

    logMultiAgent('system', 'REFRESH_START', { workspaceId: currentWorkspaceId }, 'info');

    try {
      const { listAgents, listMessages } = await import('../../chat-v2/workspace/api');
      const [agentsData, messagesData] = await Promise.all([
        listAgents(currentSessionId, currentWorkspaceId),
        listMessages(currentSessionId, currentWorkspaceId),
      ]);

      // 转换 AgentInfo[] -> WorkspaceAgent[]
      const convertedAgents: WorkspaceAgent[] = agentsData.map((a) => ({
        sessionId: a.session_id,
        workspaceId: currentWorkspaceId,
        role: a.role as WorkspaceAgent['role'],
        skillId: a.skill_id,
        status: a.status as WorkspaceAgent['status'],
        joinedAt: a.joined_at,
        lastActiveAt: a.last_active_at,
      }));

      // 转换 MessageInfo[] -> WorkspaceMessage[]
      const convertedMessages: WorkspaceMessage[] = messagesData.map((m) => ({
        id: m.id,
        workspaceId: currentWorkspaceId,
        senderSessionId: m.sender_session_id,
        targetSessionId: m.target_session_id,
        messageType: m.message_type as WorkspaceMessage['messageType'],
        content: m.content,
        status: m.status as WorkspaceMessage['status'],
        createdAt: m.created_at,
      }));

      useWorkspaceStore.getState().setAgents(convertedAgents);
      useWorkspaceStore.getState().setMessages(convertedMessages);

      logMultiAgent('system', 'REFRESH_SUCCESS', {
        agentsCount: convertedAgents.length,
        messagesCount: convertedMessages.length,
      }, 'success');
    } catch (err) {
      logMultiAgent('system', 'REFRESH_ERROR', { error: String(err) }, 'error');
    }
  }, [currentWorkspaceId]);

  if (!visible || !isActive) return null;

  // 状态徽章颜色
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
      case 'idle':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      case 'failed':
        return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200';
    }
  };

  // 日志类型颜色
  const getLogTypeColor = (type: MultiAgentLogEntry['type']) => {
    switch (type) {
      case 'workspace':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
      case 'agent':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
      case 'message':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      case 'error':
        return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
      case 'system':
        return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200';
      case 'block':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  // 日志严重性图标
  const getSeverityIcon = (severity: MultiAgentLogEntry['severity']) => {
    switch (severity) {
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-500" />;
      case 'warning':
        return <AlertCircle className="w-4 h-4 text-yellow-500" />;
      case 'success':
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      default:
        return <Clock className="w-4 h-4 text-blue-500" />;
    }
  };

  return (
    <div className="flex flex-col h-full p-4 space-y-4 overflow-hidden">
      {/* 标题和工具栏 */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-primary" />
          <h3 className="text-lg font-semibold">多 Agent 调试</h3>
          {currentWorkspaceId && (
            <Badge variant="outline" className="text-xs">
              {currentWorkspaceId.slice(0, 8)}...
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleRefresh} disabled={!currentWorkspaceId}>
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={handleCopyLogs}>
            <Copy className="w-4 h-4 mr-1" />
            复制日志
          </Button>
          <Button size="sm" variant="destructive" onClick={handleClearLogs}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-1 flex-shrink-0">
        <Button
          size="sm"
          variant={activeTab === 'monitor' ? 'default' : 'ghost'}
          onClick={() => setActiveTab('monitor')}
        >
          <Folder className="w-4 h-4 mr-1" />
          监控
        </Button>
        <Button
          size="sm"
          variant={activeTab === 'prompts' ? 'default' : 'ghost'}
          onClick={() => setActiveTab('prompts')}
        >
          <Play className="w-4 h-4 mr-1" />
          调试
        </Button>
        <Button
          size="sm"
          variant={activeTab === 'logs' ? 'default' : 'ghost'}
          onClick={() => setActiveTab('logs')}
        >
          <FileText className="w-4 h-4 mr-1" />
          日志 ({logs.length})
        </Button>
      </div>

      <Separator />

      {/* 监控面板 */}
      {activeTab === 'monitor' && (
        <div className="flex-1 overflow-auto space-y-4">
          {/* 工作区状态 */}
          <Card>
            <CardHeader className="py-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Folder className="w-4 h-4" />
                工作区状态
              </CardTitle>
            </CardHeader>
            <CardContent className="py-2">
              {currentWorkspaceId ? (
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">ID</span>
                    <code className="text-xs bg-muted px-1 rounded">{currentWorkspaceId}</code>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">名称</span>
                    <span>{workspace?.name || '未命名'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">状态</span>
                    <Badge className={getStatusColor(workspace?.status || 'unknown')}>
                      {workspace?.status || 'unknown'}
                    </Badge>
                  </div>
                </div>
              ) : (
                <div className="text-center text-muted-foreground py-4">
                  <Folder className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>暂无活跃工作区</p>
                  <p className="text-xs">使用"调试"面板创建工作区</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Agent 列表 */}
          <Card>
            <CardHeader className="py-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Bot className="w-4 h-4" />
                Agent 列表 ({agents.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="py-2">
              {agents.length > 0 ? (
                <div className="space-y-2">
                  {agents.map((agent) => (
                    <div
                      key={agent.sessionId}
                      className="flex items-center justify-between p-2 bg-muted/50 rounded text-sm"
                    >
                      <div className="flex items-center gap-2">
                        {agent.role === 'coordinator' ? (
                          <User className="w-4 h-4 text-purple-500" />
                        ) : (
                          <Bot className="w-4 h-4 text-blue-500" />
                        )}
                        <div>
                          <div className="font-medium">
                            {agent.skillId || agent.role}
                          </div>
                          <code className="text-[10px] text-muted-foreground">
                            {agent.sessionId.slice(0, 16)}...
                          </code>
                        </div>
                      </div>
                      <Badge className={getStatusColor(agent.status)}>
                        {agent.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center text-muted-foreground py-4">
                  <Bot className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>暂无 Agent</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 最近消息 */}
          <Card>
            <CardHeader className="py-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <MessageSquare className="w-4 h-4" />
                最近消息 ({messages.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="py-2">
              {messages.length > 0 ? (
                <ScrollArea className="h-48">
                  <div className="space-y-2">
                    {messages.slice(-10).map((msg) => (
                      <div
                        key={msg.id}
                        className="p-2 bg-muted/50 rounded text-xs"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <Badge variant="outline" className="text-[10px]">
                            {msg.messageType}
                          </Badge>
                          <span className="text-muted-foreground text-[10px]">
                            {new Date(msg.createdAt).toLocaleTimeString()}
                          </span>
                        </div>
                        <div className="text-muted-foreground">
                          <span className="font-medium">{msg.senderSessionId.slice(0, 8)}...</span>
                          {msg.targetSessionId && (
                            <span> → {msg.targetSessionId.slice(0, 8)}...</span>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2">{msg.content}</p>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <div className="text-center text-muted-foreground py-4">
                  <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>暂无消息</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* 调试面板 */}
      {activeTab === 'prompts' && (
        <div className="flex-1 overflow-auto space-y-4">
          {/* 预设 Prompt */}
          <Card>
            <CardHeader className="py-2">
              <CardTitle className="text-sm">预设调试 Prompt</CardTitle>
            </CardHeader>
            <CardContent className="py-2 space-y-2">
              {PRESET_PROMPTS.map((preset) => (
                <div
                  key={preset.id}
                  className="flex items-center justify-between p-2 bg-muted/50 rounded hover:bg-muted transition-colors"
                >
                  <div className="flex-1 min-w-0 mr-2">
                    <div className="font-medium text-sm">{preset.name}</div>
                    <p className="text-xs text-muted-foreground truncate">
                      {preset.description}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleExecutePrompt(preset.prompt)}
                    disabled={isExecuting}
                  >
                    {isExecuting ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Play className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* 自定义 Prompt */}
          <Card>
            <CardHeader className="py-2">
              <CardTitle className="text-sm">自定义 Prompt</CardTitle>
            </CardHeader>
            <CardContent className="py-2 space-y-2">
              <Textarea
                placeholder="输入自定义调试 Prompt..."
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                className="min-h-[100px] text-sm"
              />
              <Button
                className="w-full"
                onClick={() => handleExecutePrompt(customPrompt)}
                disabled={isExecuting || !customPrompt.trim()}
              >
                {isExecuting ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Send className="w-4 h-4 mr-2" />
                )}
                发送到聊天
              </Button>
            </CardContent>
          </Card>

          {/* 使用说明 */}
          <Card className="bg-muted/30">
            <CardContent className="py-3 text-xs text-muted-foreground">
              <p className="font-medium mb-2">💡 调试流程</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>点击"创建工作区"启动多 Agent 环境</li>
                <li>使用"创建研究 Agent"添加专业 Worker</li>
                <li>在"监控"面板观察 Agent 状态变化</li>
                <li>查看"日志"面板追踪完整执行流程</li>
                <li>发现问题时点击"复制日志"导出</li>
              </ol>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 日志面板 */}
      {activeTab === 'logs' && (
        <div className="flex-1 overflow-auto border rounded-md p-2 space-y-2 bg-muted/30">
          {logs.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              <FileText className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p>暂无日志</p>
              <p className="text-xs">执行调试操作后日志将显示在这里</p>
            </div>
          ) : (
            logs.map((log) => (
              <div
                key={log.id}
                className="flex items-start gap-2 p-2 bg-background rounded border text-xs"
              >
                {getSeverityIcon(log.severity)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <Badge className={`text-[10px] px-1.5 py-0 ${getLogTypeColor(log.type)}`}>
                      {log.type}
                    </Badge>
                    <span className="font-medium">{log.action}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <pre className="text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(log.data, null, 2)}
                  </pre>
                </div>
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      )}
    </div>
  );
};

export default MultiAgentDebugPlugin;
