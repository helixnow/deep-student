/**
 * 多 Agent 调试面板激活期间（且在 Tauri 环境里）订阅工作区事件，以及每个会话 chat_v2_event_<sessionId> 上的
 * workspace_* / subagent_call 工具调用，记入多 Agent 日志；会话创建 / 销毁 / 淘汰时增减订阅，停用时全部退订。
 */

import { useEffect, useRef } from 'react';
import { WORKSPACE_EVENTS } from '../../../features/chat/workspace/events';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { sessionManager } from '../../../features/chat/core/session/sessionManager';
import type { BackendEvent } from '../../../features/chat/core/middleware/eventBridge';
import { logMultiAgent } from './log';

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

export function useMultiAgentWorkspaceListeners(isActive: boolean): void {
  const toolCallMapRef = useRef(new Map<string, { toolName: string; messageId?: string }>());
  const toolEventUnlistenMapRef = useRef(new Map<string, UnlistenFn>());

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
}
