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
  Trash,
  Play,
  Users,
  Chat,
  Folder,
  CheckCircle,
  WarningCircle,
  Clock,
  CircleNotch,
  PaperPlaneRight,
  Robot,
  User,
  FileText,
  Plus,
} from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { useWorkspaceStore } from '../../features/chat/workspace/workspaceStore';
import type {
  WorkspaceMessage,
  WorkspaceAgent,
} from '../../features/chat/workspace/types';
import { sessionManager } from '../../features/chat/core/session/sessionManager';
import { debugLog } from '../debugMasterSwitch';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { clearMultiAgentLogs, getMultiAgentLogs, logAdded, logMultiAgent, logsCleared, type MultiAgentLogEntry } from './multiAgent/log';
import { PRESET_PROMPTS } from './multiAgent/presets';
import { useMultiAgentWorkspaceListeners } from './multiAgent/useWorkspaceListeners';

export { clearMultiAgentLogs, getMultiAgentLogs, logMultiAgent } from './multiAgent/log';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

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

    const handleLogAdded = (entry: MultiAgentLogEntry) => {
      setLogs((prev) => [...prev, entry]);
    };

    const handleLogsCleared = () => {
      setLogs([]);
    };

    // 初始加载
    setLogs(getMultiAgentLogs());

    const unsubscribeAdded = logAdded.subscribe(handleLogAdded);
    const unsubscribeCleared = logsCleared.subscribe(handleLogsCleared);

    return () => {
      unsubscribeAdded();
      unsubscribeCleared();
    };
  }, [isActive]);

  useMultiAgentWorkspaceListeners(isActive);

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

    copyTextToClipboard(JSON.stringify(report, null, 2));
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
  useEffect(() => {
    if (!visible || !isActive || !currentWorkspaceId) return;
    const currentSessionId = sessionManager.getCurrentSessionId();
    if (!currentSessionId) return;

    let cancelled = false;
    const refresh = async () => {
      try {
        const { listAgents, listMessages } = await import('../../features/chat/workspace/api');
        const [agentsData, messagesData] = await Promise.all([
          listAgents(currentSessionId, currentWorkspaceId),
          listMessages(currentSessionId, currentWorkspaceId),
        ]);

        if (cancelled || useWorkspaceStore.getState().currentWorkspaceId !== currentWorkspaceId) return;

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
        if (!cancelled) logMultiAgent('system', 'REFRESH_ERROR', { error: String(err) }, 'error');
      }
    };
    void refresh();
    return () => { cancelled = true; };
  }, [visible, isActive, currentWorkspaceId]);

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
        return <WarningCircle size={16} className="text-red-500" />;
      case 'warning':
        return <WarningCircle size={16} className="text-yellow-500" />;
      case 'success':
        return <CheckCircle size={16} className="text-green-500" />;
      default:
        return <Clock size={16} className="text-blue-500" />;
    }
  };

  return (
    <div className="flex flex-col h-full p-4 space-y-4 overflow-hidden">
      {/* 标题和工具栏 */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <Users size={20} className="text-primary" />
          <h3 className="text-lg font-semibold">多 Agent 调试</h3>
          {currentWorkspaceId && (
            <Badge variant="outline" className="text-xs">
              {currentWorkspaceId.slice(0, 8)}...
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="[@media(pointer:coarse)]:min-h-11" onClick={handleCopyLogs}>
            <Copy size={16} className="mr-1" />
            复制日志
          </Button>
          <Button size="sm" variant="destructive" className="[@media(pointer:coarse)]:min-h-11" onClick={handleClearLogs}>
            <Trash size={16} />
          </Button>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-1 flex-shrink-0">
        <Button
          size="sm"
          variant={activeTab === 'monitor' ? 'default' : 'ghost'}
          className="[@media(pointer:coarse)]:min-h-11"
          onClick={() => setActiveTab('monitor')}
        >
          <Folder size={16} className="mr-1" />
          监控
        </Button>
        <Button
          size="sm"
          variant={activeTab === 'prompts' ? 'default' : 'ghost'}
          className="[@media(pointer:coarse)]:min-h-11"
          onClick={() => setActiveTab('prompts')}
        >
          <Play size={16} className="mr-1" />
          调试
        </Button>
        <Button
          size="sm"
          variant={activeTab === 'logs' ? 'default' : 'ghost'}
          className="[@media(pointer:coarse)]:min-h-11"
          onClick={() => setActiveTab('logs')}
        >
          <FileText size={16} className="mr-1" />
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
                <Folder size={16} />
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
                  <Folder size={32} className="mx-auto mb-2 opacity-50" />
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
                <Robot size={16} />
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
                          <User size={16} className="text-purple-500" />
                        ) : (
                          <Robot size={16} className="text-blue-500" />
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
                  <Robot size={32} className="mx-auto mb-2 opacity-50" />
                  <p>暂无 Agent</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 最近消息 */}
          <Card>
            <CardHeader className="py-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Chat size={16} />
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
                  <Chat size={32} className="mx-auto mb-2 opacity-50" />
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
                    className="[@media(pointer:coarse)]:min-h-11"
                    onClick={() => handleExecutePrompt(preset.prompt)}
                    disabled={isExecuting}
                  >
                    {isExecuting ? (
                      <CircleNotch size={16} className="animate-spin" />
                    ) : (
                      <Play size={16} />
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
                className="w-full [@media(pointer:coarse)]:min-h-11"
                onClick={() => handleExecutePrompt(customPrompt)}
                disabled={isExecuting || !customPrompt.trim()}
              >
                {isExecuting ? (
                  <CircleNotch size={16} className="mr-2 animate-spin" />
                ) : (
                  <PaperPlaneRight size={16} className="mr-2" />
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
              <FileText size={48} className="mx-auto mb-2 opacity-50" />
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
