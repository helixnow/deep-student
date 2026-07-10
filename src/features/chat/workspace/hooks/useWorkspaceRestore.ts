/**
 * 🆕 2026-01-20: useWorkspaceRestore
 * 
 * 工作区状态恢复 Hook
 * 在页面加载时检查是否有活跃的工作区，并恢复状态
 */

import { useEffect, useCallback, useRef } from 'react';
import { useWorkspaceStore, isWorkerSessionId, parseAgentStatus } from '../workspaceStore';
import { listAllWorkspaces, listAgents, listAgentSessions, listMessages, listDocuments, restoreExecutions } from '../api';
import type { WorkspaceAgent, WorkspaceMessage, WorkspaceDocument } from '../types';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// 🔧 P1 修复：模块级"进行中的恢复"锁。
// restoredRef 是 per-hook-instance 的，多个 ChatContainer 并发挂载同一会话时会交叉恢复；
// 用模块级 Map<sessionId, Promise> 保证同一会话并发只跑一次。
const inflightRestores = new Map<string, Promise<void>>();

interface UseWorkspaceRestoreOptions {
  /** 当前会话 ID（用于判断是否是 Coordinator） */
  currentSessionId?: string;
  /** 是否启用自动恢复 */
  enabled?: boolean;
}

/**
 * 工作区状态恢复 Hook
 * 
 * 功能：
 * 1. 页面加载时检查是否有活跃的工作区
 * 2. 如果当前会话是某个工作区的 Coordinator，恢复该工作区状态
 * 3. 加载工作区的 Agent 列表
 */
export function useWorkspaceRestore(options: UseWorkspaceRestoreOptions = {}) {
  const { currentSessionId, enabled = true } = options;
  const { 
    setCurrentWorkspace,
    setWorkspace,
    setAgents,
    setMessages,
    setDocuments,
    setLoading,
    setError,
  } = useWorkspaceStore();

  // 防止同一 hook 实例重复恢复
  const restoredRef = useRef(false);
  // 🔧 竞态防护：快速切换会话时，旧的恢复流程完成后不得覆盖新会话的工作区状态
  const restoreRunIdRef = useRef(0);

  const restoreWorkspace = useCallback(async () => {
    if (!enabled || !currentSessionId || restoredRef.current) return;

    // 🔧 P1 修复：同一会话已有恢复在进行中时，直接复用该 Promise
    const inflight = inflightRestores.get(currentSessionId);
    if (inflight) {
      restoredRef.current = true;
      return inflight;
    }

    restoredRef.current = true;
    const runId = ++restoreRunIdRef.current;
    const isStale = () => runId !== restoreRunIdRef.current;

    const doRestore = async (): Promise<void> => {
      setLoading(true);
      setError(null);

      try {
        // 1. 获取所有活跃工作区
        const workspaces = await listAllWorkspaces(currentSessionId);
        if (isStale()) return;

        if (workspaces.length === 0) {
          console.log('[useWorkspaceRestore] No active workspaces found');
          return;
        }

        // 2. 查找当前会话所属的工作区
        // 2.1 优先：当前会话是某个工作区的 creator
        let targetWorkspace = workspaces.find((ws) => ws.creator_session_id === currentSessionId) || null;

        // 2.2 兜底：当前会话本身可能是 worker（agent_... / subagent_...），
        // 通过 AgentSession.metadata.workspace_id 找到
        if (!targetWorkspace && isWorkerSessionId(currentSessionId)) {
          try {
            const agentSessions = await listAgentSessions(undefined, 200);
            if (isStale()) return;
            const matched = agentSessions.find((s) => s.id === currentSessionId);
            const wid = (matched?.metadata as any)?.workspace_id as string | undefined;
            if (wid) {
              targetWorkspace = workspaces.find((ws) => ws.id === wid) || null;
            }
          } catch (e: unknown) {
            console.warn('[useWorkspaceRestore] Failed to locate workspace via agent sessions', e);
          }
        }

        if (!targetWorkspace) {
          console.log('[useWorkspaceRestore] Current session is not part of any workspace');
          return;
        }

        // 🔧 P1 修复：不再因"已有活跃工作区"而无条件跳过。
        // 只有当目标工作区就是当前活跃工作区时才跳过；
        // 若当前会话属于另一个工作区，仍执行恢复并切换过去。
        const activeWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
        if (activeWorkspaceId === targetWorkspace.id) {
          console.log('[useWorkspaceRestore] Workspace already active, skip restore:', targetWorkspace.id);
          return;
        }

        // 3. 恢复工作区状态
        console.log('[useWorkspaceRestore] Restoring workspace:', targetWorkspace.id);
        
        setCurrentWorkspace(targetWorkspace.id);
        setWorkspace({
          id: targetWorkspace.id,
          name: targetWorkspace.name,
          status: targetWorkspace.status as 'active' | 'completed' | 'archived',
          creatorSessionId: targetWorkspace.creator_session_id,
          createdAt: targetWorkspace.created_at,
          updatedAt: targetWorkspace.updated_at,
        });

        // 4. 加载 Agent 列表（workspace db 里的 agent 表）
        let loadedAgents: WorkspaceAgent[] = [];
        try {
          const agents = await listAgents(currentSessionId, targetWorkspace.id);
          if (isStale()) return;
          loadedAgents = agents.map((a) => ({
            sessionId: a.session_id,
            workspaceId: targetWorkspace!.id,
            role: a.role as WorkspaceAgent['role'],
            skillId: a.skill_id,
            status: parseAgentStatus(a.status),
            joinedAt: a.joined_at,
            lastActiveAt: a.last_active_at,
          }));
        } catch (e: unknown) {
          console.warn('[useWorkspaceRestore] Failed to load agents:', e);
        }

        // 4.1 兜底：从 chat_v2_sessions(mode=agent) 补全 Worker（防止 agent 表缺失/不一致）
        try {
          const agentSessions = await listAgentSessions(targetWorkspace.id, 200);
          if (isStale()) return;
          const fallbackWorkers: WorkspaceAgent[] = agentSessions.reduce<WorkspaceAgent[]>((acc, s) => {
            const md = (s.metadata || {}) as any;
            const role = (md.role || md.agent_role || 'worker') as WorkspaceAgent['role'];
            if (role !== 'worker') return acc;

            const skillId = (md.skill_id || md.skillId) as string | undefined;
            acc.push({
              sessionId: s.id,
              workspaceId: targetWorkspace!.id,
              role: 'worker',
              skillId,
              status: 'idle',
              joinedAt: s.createdAt,
              lastActiveAt: s.updatedAt,
            });
            return acc;
          }, []);

          const merged = new Map<string, WorkspaceAgent>();
          for (const a of loadedAgents) merged.set(a.sessionId, a);
          for (const w of fallbackWorkers) {
            if (!merged.has(w.sessionId)) merged.set(w.sessionId, w);
          }
          loadedAgents = Array.from(merged.values());
        } catch (e: unknown) {
          console.warn('[useWorkspaceRestore] Failed to load agent sessions for fallback:', e);
        }

        setAgents(loadedAgents);

        // 5. 恢复 messages（用于 WorkspaceTimeline）
        try {
          const msgs = await listMessages(currentSessionId, targetWorkspace.id, 50);
          if (isStale()) return;
          const converted: WorkspaceMessage[] = msgs.map((m) => ({
            id: m.id,
            workspaceId: targetWorkspace!.id,
            senderSessionId: m.sender_session_id,
            targetSessionId: m.target_session_id,
            messageType: m.message_type as WorkspaceMessage['messageType'],
            content: m.content,
            status: m.status as WorkspaceMessage['status'],
            createdAt: m.created_at,
          }));
          setMessages(converted);
        } catch (e: unknown) {
          console.warn('[useWorkspaceRestore] Failed to load messages:', e);
        }

        // 6. 恢复 documents（内容仍需按需 getDocument 拉取）
        try {
          const docs = await listDocuments(currentSessionId, targetWorkspace.id);
          if (isStale()) return;
          const converted: WorkspaceDocument[] = docs.map((d) => ({
            id: d.id,
            workspaceId: targetWorkspace!.id,
            docType: d.doc_type as WorkspaceDocument['docType'],
            title: d.title,
            content: '',
            version: d.version,
            updatedBy: d.updated_by,
            updatedAt: d.updated_at,
          }));
          setDocuments(converted);
        } catch (e: unknown) {
          console.warn('[useWorkspaceRestore] Failed to load documents:', e);
        }

        console.log('[useWorkspaceRestore] Restored workspace with', loadedAgents.length, 'agents');

        // 7. 🆕 恢复被中断的执行（子代理任务和睡眠块）
        // 注意：这是唯一应该触发 restoreExecutions 的"冷启动恢复"路径
        try {
          const restoreResult = await restoreExecutions(targetWorkspace.id, currentSessionId);
          console.log('[useWorkspaceRestore] Execution restore result:', {
            subagentTasksRestored: restoreResult.subagent_tasks_restored,
            restoredAgentIds: restoreResult.restored_agent_ids,
            hasActiveSleeps: restoreResult.has_active_sleeps,
            activeSleepIds: restoreResult.active_sleep_ids,
          });
          
          if (restoreResult.subagent_tasks_restored > 0) {
            console.log(
              '[useWorkspaceRestore] Restored',
              restoreResult.subagent_tasks_restored,
              'subagent tasks:',
              restoreResult.restored_agent_ids
            );
          }
          
          if (restoreResult.has_active_sleeps) {
            console.log(
              '[useWorkspaceRestore] Found',
              restoreResult.active_sleep_ids.length,
              'active sleeps, coordinator is waiting'
            );
          }
        } catch (restoreErr: unknown) {
          console.warn('[useWorkspaceRestore] Failed to restore executions:', restoreErr);
        }

      } catch (e: unknown) {
        console.error('[useWorkspaceRestore] Failed to restore workspace:', e);
        if (!isStale()) {
          setError(String(e));
        }
      } finally {
        // 过时的恢复流程不能清除新流程正在显示的 loading 状态
        if (!isStale()) {
          setLoading(false);
        }
      }
    };

    const promise = doRestore().finally(() => {
      inflightRestores.delete(currentSessionId);
    });
    inflightRestores.set(currentSessionId, promise);
    return promise;
  }, [
    enabled,
    currentSessionId,
    setCurrentWorkspace,
    setWorkspace,
    setAgents,
    setMessages,
    setDocuments,
    setLoading,
    setError,
  ]);

  // 当 currentSessionId 变化时触发恢复
  useEffect(() => {
    if (currentSessionId) {
      restoredRef.current = false; // 重置恢复状态
      restoreWorkspace();
    }
  }, [currentSessionId, restoreWorkspace]);

  return { restoreWorkspace };
}

export default useWorkspaceRestore;
