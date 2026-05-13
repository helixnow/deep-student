/**
 * WorkspaceOrchestrationTestPlugin - 多 Agent / 子代理编排自动化测试核心
 *
 * 目标：
 * 1) 通过真实 sendMessage 路径触发 workspace_* / subagent_call 编排
 * 2) 捕获事件、工具调用、Store 快照、持久化快照
 * 3) 生成可复盘报告（步骤日志 + 断言结果 + 关键样本）
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { WORKSPACE_EVENTS } from '../workspace/events';
import { useWorkspaceStore } from '../workspace/workspaceStore';
import {
  listAgents,
  listMessages,
  listDocuments,
  listAllWorkspaces,
  closeWorkspace,
  deleteWorkspace,
  type WorkspaceInfo,
  type MessageInfo,
} from '../workspace/api';
import { sessionManager } from '../core/session/sessionManager';
import type { BackendEvent } from '../core/middleware/eventBridge';
import { getLogs as getSubagentLogs } from './subagentTestPlugin';

export type ScenarioName =
  | 'orchestrate_single_worker'
  | 'orchestrate_two_workers'
  | 'orchestrate_handoff';

export const ALL_SCENARIOS: ScenarioName[] = [
  'orchestrate_single_worker',
  'orchestrate_two_workers',
  'orchestrate_handoff',
];

export const SCENARIO_LABELS: Record<ScenarioName, string> = {
  orchestrate_single_worker: 'S1 单 Worker 编排',
  orchestrate_two_workers: 'S2 双 Worker 并行',
  orchestrate_handoff: 'S3 研究→写作交接',
};

export const SCENARIO_DESCRIPTIONS: Record<ScenarioName, string> = {
  orchestrate_single_worker: '创建工作区 + 创建 1 个 worker + 返回结果摘要',
  orchestrate_two_workers: '创建工作区 + 创建 2 个 worker 并行执行 + 汇总结果',
  orchestrate_handoff: '研究 worker 产出后，写作 worker 基于结果再产出',
};

interface ScenarioDefinition {
  workspaceNameBase: string;
  buildPrompt: (workspaceName: string) => string;
  minWorkers: number;
  minMessages: number;
  requireSubagentCall: boolean;
}

function collectUiLogsSince(startIndex: number): CapturedUiLog[] {
  return getSubagentLogs()
    .slice(Math.max(0, startIndex))
    .map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      type: entry.type,
      action: entry.action,
      subagentSessionId: entry.subagentSessionId,
      data: entry.data,
    }));
}

const SCENARIO_DEFS: Record<ScenarioName, ScenarioDefinition> = {
  orchestrate_single_worker: {
    workspaceNameBase: '[OrchTest] single worker',
    buildPrompt: (workspaceName: string) => [
      '请严格按步骤执行：',
      `1) 创建一个名为 "${workspaceName}" 的工作区。`,
      '2) 创建 1 个研究 worker。',
      '3) 让该 worker 给出 "AI 学习计划" 三条建议。',
      '4) 输出最终摘要。',
    ].join('\n'),
    minWorkers: 1,
    minMessages: 1,
    requireSubagentCall: true,
  },
  orchestrate_two_workers: {
    workspaceNameBase: '[OrchTest] two workers',
    buildPrompt: (workspaceName: string) => [
      '请严格按步骤执行：',
      `1) 创建一个名为 "${workspaceName}" 的工作区。`,
      '2) 创建 2 个 worker（一个调研、一个整理）。',
      '3) 并行完成 "AI 在教育中的应用" 的要点提炼。',
      '4) 输出汇总。',
    ].join('\n'),
    minWorkers: 2,
    minMessages: 2,
    requireSubagentCall: true,
  },
  orchestrate_handoff: {
    workspaceNameBase: '[OrchTest] handoff',
    buildPrompt: (workspaceName: string) => [
      '请严格按以下顺序逐步执行，不要跳步、不要并行创建 worker：',
      `1) 创建一个名为 "${workspaceName}" 的工作区。`,
      '2) 仅创建研究 worker，给它的初始任务是"列出关于人工智能发展的 5 条关键要点"。',
      '3) 使用 coordinator_sleep 等待研究 worker 完成（wake_condition=result_message 或 all_completed）。',
      '4) 研究 worker 完成后，再创建写作 worker，给它的初始任务是"基于刚才研究 worker 给出的 5 条要点，写一段不超过 200 字的中文总结"。',
      '5) 使用 coordinator_sleep 等待写作 worker 完成。',
      '6) 输出最终总结结果。',
    ].join('\n'),
    minWorkers: 2,
    minMessages: 2,
    requireSubagentCall: true,
  },
};

export interface WorkspaceOrchestrationTestConfig {
  timeoutMs: number;
  pollMs: number;
  snapshotIntervalMs: number;
  settleMs: number;
  skipScenarios: ScenarioName[];
  promptSuffix?: string;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  phase: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface CapturedWorkspaceEvent {
  id: number;
  timestamp: string;
  eventName: string;
  payload: Record<string, unknown>;
}

export interface CapturedToolCall {
  id: number;
  timestamp: string;
  sessionId: string;
  toolName: string;
  phase: 'start' | 'end' | 'error';
  blockId?: string;
  messageId?: string;
  error?: string;
  targetWorkspaceId?: string;
  rawPayload?: Record<string, unknown>;
}

interface CapturedUiLog {
  id: number;
  timestamp: string;
  type: string;
  action: string;
  subagentSessionId?: string;
  data?: Record<string, unknown>;
}

export interface WorkspaceSnapshot {
  id: number;
  timestamp: string;
  workspaceId: string | null;
  workspaceStatus: string | null;
  agents: Array<{ sessionId: string; role: string; status: string; skillId?: string }>;
  messageCount: number;
  documentCount: number;
}

export interface PersistenceSummary {
  agentsCount: number;
  messagesCount: number;
  documentsCount: number;
  workspaceName?: string;
  workerSessionIds: string[];
  workerSkillHints: Record<string, string | undefined>;
  distinctSenderSessionIds: string[];
  messageSamples: Array<{
    id: string;
    senderSessionId: string;
    messageType: string;
    createdAt: string;
  }>;
}

export interface ScenarioResult {
  scenario: ScenarioName;
  status: 'passed' | 'failed' | 'skipped';
  startTime: string;
  endTime: string;
  durationMs: number;
  sessionId: string;
  workspaceId?: string;
  verification: VerificationResult;
  logs: LogEntry[];
  workspaceEvents: CapturedWorkspaceEvent[];
  toolCalls: CapturedToolCall[];
  snapshots: WorkspaceSnapshot[];
  persistence?: PersistenceSummary;
  error?: string;
}

export type OverallStatus = 'idle' | 'running' | 'completed' | 'aborted';
export const WORKSPACE_ORCHESTRATION_TEST_EVENT = 'WORKSPACE_ORCHESTRATION_TEST_LOG';

let _abortRequested = false;
let _logId = 0;
let _eventId = 0;
let _toolId = 0;
let _snapshotId = 0;
const MAX_LOGS = 800;

export function requestAbort() { _abortRequested = true; }
export function resetAbort() { _abortRequested = false; }
export function isAbortRequested() { return _abortRequested; }

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function sleepWithAbort(totalMs: number, stepMs: number): Promise<'ok' | 'aborted'> {
  const ms = Math.max(10, stepMs);
  let elapsed = 0;
  while (elapsed < totalMs) {
    if (_abortRequested) return 'aborted';
    const waitMs = Math.min(ms, totalMs - elapsed);
    await sleep(waitMs);
    elapsed += waitMs;
  }
  return _abortRequested ? 'aborted' : 'ok';
}

async function waitFor(cond: () => boolean, timeoutMs: number, pollMs: number): Promise<'matched' | 'timeout' | 'aborted'> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (_abortRequested) return 'aborted';
    if (cond()) return 'matched';
    const sleepResult = await sleepWithAbort(Math.max(50, pollMs), Math.min(250, pollMs));
    if (sleepResult === 'aborted') return 'aborted';
  }
  return _abortRequested ? 'aborted' : 'timeout';
}

function normalizeToolName(raw?: string): string {
  if (!raw) return '';
  return raw
    .replace('builtin-', '')
    .replace('mcp.tools.', '')
    .replace(/^.*\./, '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractWorkspaceIdFromObject(input: unknown): string | undefined {
  const obj = asRecord(input);
  if (!obj) return undefined;
  const direct = obj.workspace_id;
  if (typeof direct === 'string' && direct) return direct;
  const camel = obj.workspaceId;
  if (typeof camel === 'string' && camel) return camel;
  const nestedRequest = extractWorkspaceIdFromObject(obj.request);
  if (nestedRequest) return nestedRequest;
  const nestedPayload = extractWorkspaceIdFromObject(obj.payload);
  if (nestedPayload) return nestedPayload;
  const nestedResult = extractWorkspaceIdFromObject(obj.result);
  if (nestedResult) return nestedResult;
  return undefined;
}

function extractAgentSessionIdFromEventPayload(payload: Record<string, unknown>): string | undefined {
  const agent = asRecord(payload.agent);
  const byAgent = agent?.session_id;
  if (typeof byAgent === 'string' && byAgent) return byAgent;
  const bySessionField = payload.session_id;
  if (typeof bySessionField === 'string' && bySessionField) return bySessionField;
  const bySessionCamel = payload.sessionId;
  if (typeof bySessionCamel === 'string' && bySessionCamel) return bySessionCamel;
  const byField = payload.agent_session_id;
  if (typeof byField === 'string' && byField) return byField;
  return undefined;
}

function extractAgentRoleFromEventPayload(payload: Record<string, unknown>): string | undefined {
  const agent = asRecord(payload.agent);
  const byAgent = agent?.role;
  if (typeof byAgent === 'string' && byAgent) return byAgent;
  return undefined;
}

function parseIsoMs(ts?: string): number {
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : 0;
}

function isRelevantToolForWorkspace(tool: CapturedToolCall, workspaceId: string | undefined): boolean {
  if (!workspaceId) return true;
  if (!tool.targetWorkspaceId) return true;
  return tool.targetWorkspaceId === workspaceId;
}

function resolveScenarioWorkspace(
  baseline: WorkspaceInfo[],
  current: WorkspaceInfo[],
  expectedName: string,
  scenarioStartTime: string,
  fallbackWorkspaceId?: string,
): WorkspaceInfo | undefined {
  const byExactName = current.find((w) => w.name === expectedName);
  if (byExactName) return byExactName;

  const beforeIds = new Set(baseline.map((w) => w.id));
  const newlyCreated = current.filter((w) => !beforeIds.has(w.id));
  const byNewAndPrefix = newlyCreated.find((w) => (w.name || '').startsWith('[OrchTest]'));
  if (byNewAndPrefix) return byNewAndPrefix;

  if (fallbackWorkspaceId) {
    const byFallbackId = current.find((w) => w.id === fallbackWorkspaceId);
    if (byFallbackId && (byFallbackId.name || '').startsWith('[OrchTest]')) {
      return byFallbackId;
    }
  }

  const startMs = parseIsoMs(scenarioStartTime);
  const recent = current
    .filter((w) => (w.name || '').startsWith('[OrchTest]') && parseIsoMs(w.updated_at) >= startMs - 1000)
    .sort((a, b) => parseIsoMs(b.updated_at) - parseIsoMs(a.updated_at));
  return recent[0];
}

function containsAnyKeyword(source: string | undefined, keywords: string[]): boolean {
  if (!source) return false;
  const s = source.toLowerCase();
  return keywords.some((k) => s.includes(k));
}

function createLogger(scenario: ScenarioName, onLog?: (entry: LogEntry) => void) {
  const logs: LogEntry[] = [];
  const log = (level: LogLevel, phase: string, message: string, data?: Record<string, unknown>) => {
    const entry: LogEntry = {
      id: ++_logId,
      timestamp: new Date().toISOString(),
      level,
      phase,
      message,
      data,
    };
    if (logs.length < MAX_LOGS) logs.push(entry);
    onLog?.(entry);
    window.dispatchEvent(new CustomEvent(WORKSPACE_ORCHESTRATION_TEST_EVENT, { detail: entry }));
    const emoji = { debug: '🔍', info: '🔷', warn: '⚠️', error: '❌', success: '✅' }[level];
    console.log(`${emoji} [WorkspaceOrchTest][${scenario}][${phase}] ${message}`, data ?? '');
  };
  return { logs, log };
}

function extractEventLogFields(
  eventName: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const p = payload;
  const agentObj = asRecord(p.agent);
  const msgObj = asRecord(p.message);

  switch (eventName) {
    case WORKSPACE_EVENTS.COORDINATOR_AWAKENED:
      return {
        workspace_id: p.workspace_id ?? p.workspaceId,
        coordinator_session_id: p.coordinator_session_id ?? p.coordinatorSessionId,
        sleep_id: p.sleep_id ?? p.sleepId,
        awakened_by: p.awakened_by ?? p.awakenedBy,
        wake_reason: p.wake_reason ?? p.wakeReason,
        awaken_message: p.awaken_message ?? p.awakenMessage,
      };
    case WORKSPACE_EVENTS.AGENT_JOINED:
      return {
        workspace_id: p.workspace_id ?? p.workspaceId,
        session_id: agentObj?.session_id ?? p.session_id,
        role: agentObj?.role ?? p.role,
        status: agentObj?.status ?? p.status,
        skill_id: agentObj?.skill_id ?? p.skill_id,
      };
    case WORKSPACE_EVENTS.AGENT_LEFT:
      return {
        workspace_id: p.workspace_id ?? p.workspaceId,
        session_id: agentObj?.session_id ?? p.session_id,
      };
    case WORKSPACE_EVENTS.AGENT_STATUS_CHANGED:
      return {
        workspace_id: p.workspace_id ?? p.workspaceId,
        session_id: p.session_id ?? p.sessionId,
        status: p.status,
      };
    case WORKSPACE_EVENTS.WORKER_READY:
      return {
        workspace_id: p.workspace_id ?? p.workspaceId,
        session_id:
          agentObj?.session_id ?? p.session_id ?? p.agent_session_id ?? p.agentSessionId,
      };
    case WORKSPACE_EVENTS.MESSAGE_RECEIVED: {
      const rawMsg = msgObj ?? p;
      const content = typeof rawMsg.content === 'string' ? rawMsg.content : undefined;
      return {
        workspace_id: p.workspace_id ?? p.workspaceId,
        sender_session_id: rawMsg.sender_session_id ?? rawMsg.senderSessionId,
        target_session_id: rawMsg.target_session_id ?? rawMsg.targetSessionId,
        message_type: rawMsg.message_type ?? rawMsg.messageType,
        status: rawMsg.status,
        content_preview: content ? content.slice(0, 120) : undefined,
      };
    }
    case WORKSPACE_EVENTS.WORKSPACE_WARNING:
      return {
        workspace_id: p.workspace_id ?? p.workspaceId,
        code: p.code,
        message: p.message,
        agent_session_id: p.agent_session_id ?? p.agentSessionId,
        retry_count: p.retry_count ?? p.retryCount,
        max_retries: p.max_retries ?? p.maxRetries,
      };
    case WORKSPACE_EVENTS.WORKSPACE_CLOSED:
      return { workspace_id: p.workspace_id ?? p.workspaceId };
    case WORKSPACE_EVENTS.SUBAGENT_RETRY:
      return {
        workspace_id: p.workspace_id ?? p.workspaceId,
        agent_session_id: p.agent_session_id ?? p.agentSessionId,
        reason: p.reason,
        message: p.message,
        retry_count: p.retry_count ?? p.retryCount,
        max_retries: p.max_retries ?? p.maxRetries,
      };
    case WORKSPACE_EVENTS.DOCUMENT_UPDATED: {
      const docObj = asRecord(p.document);
      return {
        workspace_id: p.workspace_id ?? p.workspaceId,
        doc_id: docObj?.id ?? p.document_id,
        doc_title: docObj?.title ?? p.title,
        doc_status: docObj?.status ?? p.status,
      };
    }
    default:
      return p;
  }
}

async function createWorkspaceEventCapture(
  log: (level: LogLevel, phase: string, msg: string, data?: Record<string, unknown>) => void,
  onEvent?: (item: CapturedWorkspaceEvent) => void,
) {
  const events: CapturedWorkspaceEvent[] = [];
  const unlistenFns: UnlistenFn[] = [];
  const names = Object.values(WORKSPACE_EVENTS);
  for (const eventName of names) {
    const unlisten = await listen<Record<string, unknown>>(eventName, (event) => {
      const item: CapturedWorkspaceEvent = {
        id: ++_eventId,
        timestamp: new Date().toISOString(),
        eventName,
        payload: event.payload,
      };
      events.push(item);
      onEvent?.(item);
      const fields = extractEventLogFields(eventName, event.payload);
      const level: LogLevel =
        eventName === WORKSPACE_EVENTS.WORKSPACE_WARNING ? 'warn'
        : eventName === WORKSPACE_EVENTS.COORDINATOR_AWAKENED ? 'success'
        : 'info';
      log(level, 'workspace_event', eventName, fields);
    });
    unlistenFns.push(unlisten);
  }
  return {
    events,
    stop: () => { unlistenFns.forEach((u) => u()); },
  };
}

async function createToolCallCapture(
  initialSessionIds: string[],
  log: (level: LogLevel, phase: string, msg: string, data?: Record<string, unknown>) => void,
) {
  const toolCalls: CapturedToolCall[] = [];
  const unlistenFns: UnlistenFn[] = [];
  const watchedSessionIds = new Set<string>();
  const blockIdToToolName = new Map<string, string>();

  const attachSession = async (sessionId: string): Promise<void> => {
    if (!sessionId || watchedSessionIds.has(sessionId)) return;
    watchedSessionIds.add(sessionId);

    const channel = `chat_v2_event_${sessionId}`;
    const unlisten = await listen<BackendEvent>(channel, (event) => {
      const backendEvent = event.payload;
      if (backendEvent.type !== 'tool_call') return;
      const phase = backendEvent.phase;
      if (phase !== 'start' && phase !== 'end' && phase !== 'error') return;

      const payload = asRecord(backendEvent.payload) ?? {};
      let toolName = normalizeToolName(typeof payload.toolName === 'string' ? payload.toolName : undefined);

      // tool_call:end/error 事件 payload 只含结果，无 toolName；从 blockId 查表还原
      if (!toolName && backendEvent.blockId) {
        toolName = blockIdToToolName.get(backendEvent.blockId) ?? '';
      }

      if (!toolName.startsWith('workspace_') && toolName !== 'subagent_call') return;

      // start 阶段建立 blockId → toolName 映射
      if (phase === 'start' && toolName && backendEvent.blockId) {
        blockIdToToolName.set(backendEvent.blockId, toolName);
      }

      const item: CapturedToolCall = {
        id: ++_toolId,
        timestamp: new Date().toISOString(),
        sessionId,
        toolName,
        phase,
        blockId: backendEvent.blockId,
        messageId: backendEvent.messageId,
        error: phase === 'error' ? backendEvent.error : undefined,
        targetWorkspaceId: extractWorkspaceIdFromObject(payload),
        rawPayload: payload,
      };
      toolCalls.push(item);

      // 根据 toolName + phase 提取有价值的诊断字段
      const toolLogData = buildToolLogData(toolName, phase, payload, item);
      log(phase === 'error' ? 'error' : 'info', 'tool_call', `${toolName}:${phase}`, toolLogData);
    });

    unlistenFns.push(unlisten);
    log('debug', 'tool_capture', '已监听 tool_call 通道', { sessionId, channel });
  };

  for (const sessionId of initialSessionIds) {
    await attachSession(sessionId);
  }

  return {
    toolCalls,
    watchedSessionIds,
    attachSession,
    stop: () => {
      unlistenFns.forEach((u) => u());
    },
  };
}

function buildToolLogData(
  toolName: string,
  phase: string,
  payload: Record<string, unknown>,
  item: CapturedToolCall,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    sessionId: item.sessionId,
    workspaceId: item.targetWorkspaceId,
    blockId: item.blockId,
    messageId: item.messageId,
  };
  if (item.error) base.error = item.error;

  if (phase === 'start') {
    // 对每类工具提取关键入参
    switch (toolName) {
      case 'coordinator_sleep':
        return {
          ...base,
          wake_condition: payload.wake_condition ?? payload.wakeCondition,
          timeout_ms: payload.timeout_ms ?? payload.timeoutMs,
          awaiting_agents: payload.awaiting_agents ?? payload.awaitingAgents,
        };
      case 'workspace_create':
        return {
          ...base,
          name: payload.name,
          description: payload.description,
        };
      case 'workspace_create_agent':
        return {
          ...base,
          role: payload.role,
          skill_id: payload.skill_id ?? payload.skillId,
          prompt: typeof payload.prompt === 'string' ? payload.prompt.slice(0, 120) : undefined,
          initial_task: typeof payload.initial_task === 'string' ? payload.initial_task.slice(0, 120) : undefined,
        };
      case 'workspace_send':
        return {
          ...base,
          target_session_id: payload.target_session_id ?? payload.targetSessionId,
          message_type: payload.message_type ?? payload.messageType,
          content_preview: typeof payload.content === 'string' ? payload.content.slice(0, 120) : undefined,
        };
      case 'workspace_query':
        return {
          ...base,
          target_session_id: payload.target_session_id ?? payload.targetSessionId,
          query_type: payload.query_type ?? payload.queryType,
        };
      default:
        return { ...base, args_preview: JSON.stringify(payload).slice(0, 200) };
    }
  }

  if (phase === 'end') {
    // 对每类工具提取关键返回值
    switch (toolName) {
      case 'coordinator_sleep': {
        const durationMs = payload.duration_ms ?? payload.durationMs;
        const timeoutMs = typeof payload.timeout_ms === 'number' ? payload.timeout_ms : undefined;
        return {
          ...base,
          status: payload.status,
          wake_reason: payload.reason,
          awakened_by: payload.awakened_by ?? payload.awakenedBy,
          duration_ms: durationMs,
          timeout_ms: timeoutMs,
          time_budget_used_pct:
            typeof durationMs === 'number' && typeof timeoutMs === 'number' && timeoutMs > 0
              ? `${((durationMs / timeoutMs) * 100).toFixed(1)}%`
              : undefined,
          awaken_message_preview:
            typeof payload.awaken_message === 'string'
              ? payload.awaken_message.slice(0, 80)
              : undefined,
        };
      }
      case 'workspace_create':
        return {
          ...base,
          workspace_id: payload.workspace_id ?? payload.workspaceId ?? payload.id,
          name: payload.name,
        };
      case 'workspace_create_agent':
        return {
          ...base,
          agent_session_id:
            payload.agent_session_id ?? payload.agentSessionId ?? payload.session_id ?? payload.sessionId,
          role: payload.role,
          skill_id: payload.skill_id ?? payload.skillId,
        };
      default:
        return { ...base, result_preview: JSON.stringify(payload).slice(0, 200) };
    }
  }

  return base;
}

function createSnapshotCapture(intervalMs: number) {
  const snapshots: WorkspaceSnapshot[] = [];
  const timer = window.setInterval(() => {
    const ws = useWorkspaceStore.getState();
    snapshots.push({
      id: ++_snapshotId,
      timestamp: new Date().toISOString(),
      workspaceId: ws.currentWorkspaceId,
      workspaceStatus: ws.workspace?.status ?? null,
      agents: ws.agents.map((a) => ({
        sessionId: a.sessionId,
        role: a.role,
        status: a.status,
        skillId: a.skillId,
      })),
      messageCount: ws.messages.length,
      documentCount: ws.documents.length,
    });
  }, Math.max(500, intervalMs));

  return {
    snapshots,
    stop: () => window.clearInterval(timer),
  };
}

function evaluateChecks(
  scenario: ScenarioName,
  def: ScenarioDefinition,
  workspaceId: string | null,
  events: CapturedWorkspaceEvent[],
  tools: CapturedToolCall[],
  snapshots: WorkspaceSnapshot[],
  uiLogs: CapturedUiLog[],
  mainSessionId: string,
  persistence: PersistenceSummary | undefined,
): VerificationResult {
  const checks: VerificationCheck[] = [];
  const workerJoinCount = events.filter((e) => e.eventName === WORKSPACE_EVENTS.AGENT_JOINED).length;
  const workerJoinedIds = new Set(
    events
      .filter((e) => e.eventName === WORKSPACE_EVENTS.AGENT_JOINED)
      .map((e) => extractAgentSessionIdFromEventPayload(e.payload))
      .filter((id): id is string => !!id)
  );
  const msgCount = events.filter((e) => e.eventName === WORKSPACE_EVENTS.MESSAGE_RECEIVED).length;
  const workerReadyEvents = events.filter((e) => e.eventName === WORKSPACE_EVENTS.WORKER_READY);
  const workerReadyCount = workerReadyEvents.length;
  const agentStatusChangedEvents = events.filter((e) => e.eventName === WORKSPACE_EVENTS.AGENT_STATUS_CHANGED);
  const agentStatusChangedCount = agentStatusChangedEvents.length;
  const hasWorkspaceCreate = tools.some((t) => t.sessionId === mainSessionId && t.toolName === 'workspace_create' && t.phase === 'end');
  const hasSubagentCall = tools.some((t) => t.toolName === 'subagent_call' && t.phase === 'start');
  const hasCreateAgentCall = tools.some((t) => t.sessionId === mainSessionId && t.toolName === 'workspace_create_agent' && t.phase === 'start');
  const hasWorkerReady = events.some((e) => e.eventName === WORKSPACE_EVENTS.WORKER_READY);
  const hasCoordinatorAwake = events.some((e) => e.eventName === WORKSPACE_EVENTS.COORDINATOR_AWAKENED);
  const warningCount = events.filter((e) => e.eventName === WORKSPACE_EVENTS.WORKSPACE_WARNING).length;
  const snapshotInWorkspace = workspaceId
    ? snapshots.filter((s) => s.workspaceId === workspaceId)
    : snapshots;
  const maxSnapshotWorkers = snapshotInWorkspace.reduce((max, s) => {
    const count = s.agents.filter((a) => a.role === 'worker').length;
    return Math.max(max, count);
  }, 0);
  const maxSnapshotMessages = snapshotInWorkspace.reduce((max, s) => Math.max(max, s.messageCount), 0);
  const workspaceCreateStarts = tools.filter((t) => t.sessionId === mainSessionId && t.toolName === 'workspace_create' && t.phase === 'start').length;
  const workspaceCreateEnds = tools.filter((t) => t.sessionId === mainSessionId && t.toolName === 'workspace_create' && t.phase === 'end').length;
  const createAgentStarts = tools.filter((t) => t.sessionId === mainSessionId && t.toolName === 'workspace_create_agent' && t.phase === 'start').length;
  const createAgentEnds = tools.filter((t) => t.sessionId === mainSessionId && t.toolName === 'workspace_create_agent' && t.phase === 'end').length;

  const toolLifecycleStats = ['workspace_create', 'workspace_create_agent', 'workspace_query', 'workspace_send'].map((toolName) => {
    const starts = tools.filter((t) => t.sessionId === mainSessionId && t.toolName === toolName && t.phase === 'start').length;
    const ends = tools.filter((t) => t.sessionId === mainSessionId && t.toolName === toolName && t.phase === 'end').length;
    const errors = tools.filter((t) => t.sessionId === mainSessionId && t.toolName === toolName && t.phase === 'error').length;
    return { toolName, starts, ends, errors };
  });

  const strictLifecycleOk = toolLifecycleStats
    .filter((x) => x.toolName === 'workspace_create' || x.toolName === 'workspace_create_agent')
    .every((x) => x.starts > 0 && x.ends === x.starts && x.errors === 0)
    && toolLifecycleStats
      .filter((x) => x.toolName === 'workspace_query' || x.toolName === 'workspace_send')
      .every((x) => x.errors === 0 && (x.starts === 0 || x.ends >= x.starts));

  const readyWorkerIds = new Set(
    workerReadyEvents
      .map((e) => extractAgentSessionIdFromEventPayload(e.payload))
      .filter((id): id is string => !!id)
  );
  const statusChangedWorkerIds = new Set(
    agentStatusChangedEvents
      .map((e) => extractAgentSessionIdFromEventPayload(e.payload))
      .filter((id): id is string => !!id)
  );
  const readyWithStatusCount = Array.from(readyWorkerIds).filter((id) => statusChangedWorkerIds.has(id)).length;
  const joinedWithReadyCount = Array.from(workerJoinedIds).filter((id) => readyWorkerIds.has(id)).length;

  const workerSnapshotStatusMap = new Map<string, Set<string>>();
  for (const snap of snapshotInWorkspace) {
    for (const agent of snap.agents) {
      if (agent.role !== 'worker') continue;
      const set = workerSnapshotStatusMap.get(agent.sessionId) ?? new Set<string>();
      set.add(agent.status || 'unknown');
      workerSnapshotStatusMap.set(agent.sessionId, set);
    }
  }
  const workersSeenInSnapshot = workerSnapshotStatusMap.size;
  const workersWithStatusTransition = Array.from(workerSnapshotStatusMap.values()).filter((set) => set.size >= 2).length;

  const uiRenderLogs = uiLogs.filter((l) => l.type === 'ui_render');
  const uiDataLoadLogs = uiLogs.filter((l) => l.type === 'data_load');
  const uiRenderedWorkerSet = new Set(
    uiRenderLogs
      .filter((l) => l.action === 'container_mount' || l.action === 'chat_container_embed')
      .map((l) => l.subagentSessionId)
      .filter((id): id is string => !!id)
  );
  const uiDataLoadedWorkerSet = new Set(
    uiDataLoadLogs
      .filter((l) => l.action === 'messages_load_complete' || l.action === 'auto_refresh')
      .map((l) => l.subagentSessionId)
      .filter((id): id is string => !!id)
  );
  const uiRenderGatePassed =
    uiRenderedWorkerSet.size >= def.minWorkers
    || workersSeenInSnapshot >= def.minWorkers
    || uiRenderLogs.length === 0;
  const uiDataGatePassed =
    uiDataLoadedWorkerSet.size >= Math.min(def.minWorkers, Math.max(1, uiRenderedWorkerSet.size))
    || maxSnapshotMessages >= def.minMessages
    || uiDataLoadLogs.length === 0;

  checks.push({ name: '工作区已创建', passed: !!workspaceId, detail: workspaceId ?? '无' });
  checks.push({ name: 'workspace_create 已完成', passed: hasWorkspaceCreate, detail: hasWorkspaceCreate ? '✓' : '未捕获' });
  checks.push({
    name: 'workspace_create 生命周期完整',
    passed: workspaceCreateStarts > 0 && workspaceCreateEnds === workspaceCreateStarts,
    detail: `start=${workspaceCreateStarts}, end=${workspaceCreateEnds}`,
  });
  checks.push({ name: `worker_joined >= ${def.minWorkers}`, passed: workerJoinCount >= def.minWorkers, detail: `${workerJoinCount}` });
  checks.push({ name: `workspace_message_received >= ${def.minMessages}`, passed: msgCount >= def.minMessages, detail: `${msgCount}` });
  checks.push({ name: `worker_ready >= ${def.minWorkers}`, passed: workerReadyCount >= def.minWorkers, detail: `${workerReadyCount}` });
  checks.push({
    name: 'worker_joined → worker_ready 对齐',
    passed: joinedWithReadyCount >= Math.min(def.minWorkers, workerJoinedIds.size),
    detail: `joined=${workerJoinedIds.size}, ready=${readyWorkerIds.size}, matched=${joinedWithReadyCount}`,
  });
  checks.push({ name: '至少一次 worker_ready', passed: hasWorkerReady, detail: hasWorkerReady ? '✓' : '未捕获' });
  checks.push({
    name: 'worker_ready → status_changed 可观测',
    passed: readyWithStatusCount >= Math.min(def.minWorkers, Math.max(1, readyWorkerIds.size)),
    detail: `readyWorkers=${readyWorkerIds.size}, statusChangedWorkers=${statusChangedWorkerIds.size}, matched=${readyWithStatusCount}, statusEvents=${agentStatusChangedCount}`,
  });
  checks.push({
    name: '快照覆盖目标工作区',
    passed: snapshotInWorkspace.length > 0,
    detail: `${snapshotInWorkspace.length} 条`,
  });
  checks.push({
    name: '快照显示 worker 增长',
    passed: maxSnapshotWorkers >= def.minWorkers,
    detail: `${maxSnapshotWorkers}`,
  });
  checks.push({
    name: '快照显示消息增长',
    passed: maxSnapshotMessages >= def.minMessages,
    detail: `${maxSnapshotMessages}`,
  });
  checks.push({
    name: '渲染快照覆盖 worker 状态',
    passed: workersSeenInSnapshot >= def.minWorkers,
    detail: `workersSeen=${workersSeenInSnapshot}, transitions=${workersWithStatusTransition}`,
  });
  checks.push({
    name: '渲染快照状态变化（诊断）',
    passed: true,
    detail: `workersWithTransition=${workersWithStatusTransition}`,
  });
  checks.push({
    name: 'UI 渲染可见（container/embed）',
    passed: uiRenderGatePassed,
    detail: `uiRenderedWorkers=${uiRenderedWorkerSet.size}, snapshotWorkers=${workersSeenInSnapshot}, uiRenderLogs=${uiRenderLogs.length}`,
  });
  checks.push({
    name: 'UI 数据加载可见（messages/refresh）',
    passed: uiDataGatePassed,
    detail: `uiDataLoadedWorkers=${uiDataLoadedWorkerSet.size}, snapshotMessages=${maxSnapshotMessages}, uiDataLogs=${uiDataLoadLogs.length}`,
  });

  if (def.requireSubagentCall) {
    const agentCallOk = hasSubagentCall || hasCreateAgentCall;
    checks.push({
      name: '触发子代理创建',
      passed: agentCallOk,
      detail: agentCallOk
        ? (hasSubagentCall ? 'subagent_call:start' : 'workspace_create_agent:start')
        : '未捕获（subagent_call / workspace_create_agent）',
    });
  }

  checks.push({
    name: '无工具调用错误',
    passed: tools.every((t) => t.phase !== 'error'),
    detail: `${tools.filter((t) => t.phase === 'error').length} 个 error`,
  });
  checks.push({
    name: '关键工具生命周期闭合',
    passed: strictLifecycleOk,
    detail: toolLifecycleStats
      .map((x) => `${x.toolName}(s=${x.starts},e=${x.ends},err=${x.errors})`)
      .join('; '),
  });

  checks.push({
    name: '无 workspace_warning',
    passed: warningCount === 0,
    detail: `${warningCount} 个 warning`,
  });

  checks.push({
    name: '唤醒链路可观测（可选）',
    passed: hasCoordinatorAwake || workerReadyCount > 0,
    detail: hasCoordinatorAwake ? '检测到 coordinator_awakened' : '未触发（可接受）',
  });

  if (persistence) {
    const distinctWorkerSenders = persistence.distinctSenderSessionIds.filter((id) => persistence.workerSessionIds.includes(id));

    checks.push({
      name: '持久化 agents>0',
      passed: persistence.agentsCount > 0,
      detail: `${persistence.agentsCount}`,
    });
    checks.push({
      name: '持久化 messages>0',
      passed: persistence.messagesCount > 0,
      detail: `${persistence.messagesCount}`,
    });
    checks.push({
      name: `持久化 worker>=${def.minWorkers}`,
      passed: persistence.workerSessionIds.length >= def.minWorkers,
      detail: `${persistence.workerSessionIds.length}`,
    });
    checks.push({
      name: '持久化工作区命名有效',
      passed: !!persistence.workspaceName && persistence.workspaceName.startsWith('[OrchTest]'),
      detail: persistence.workspaceName ?? '无',
    });
    checks.push({
      name: '持久化消息发送者含 worker（诊断）',
      passed: true,
      detail: distinctWorkerSenders.length > 0
        ? `✓ ${distinctWorkerSenders.length} 个 worker 有发送记录`
        : `0（worker 可能通过 attempt_completion 返回，未写入 workspace board）`,
    });
    checks.push({
      name: '持久化/事件消息一致性（诊断）',
      passed: true,
      detail: `events.message_received=${msgCount}, persistence.messages=${persistence.messagesCount}`,
    });

    if (scenario === 'orchestrate_handoff') {
      const handoffCreateAgentStarts = tools.filter(
        (t) => t.sessionId === mainSessionId && t.toolName === 'workspace_create_agent' && t.phase === 'start'
      ).length;
      const hasHandoffToolChain =
        handoffCreateAgentStarts >= 2
        && tools.some(
          (t) => t.sessionId === mainSessionId
            && (t.toolName === 'workspace_send' || t.toolName === 'workspace_query')
            && t.phase === 'start'
        );

      checks.push({
        name: 'handoff 至少两个 worker 参与发送',
        passed: distinctWorkerSenders.length >= 2 || hasHandoffToolChain,
        detail:
          distinctWorkerSenders.length >= 2
            ? `worker-senders=${distinctWorkerSenders.length}`
            : `worker-senders=${distinctWorkerSenders.length}, create_agent:start=${handoffCreateAgentStarts}, handoffToolChain=${hasHandoffToolChain ? 'yes' : 'no'}`,
      });

      checks.push({
        name: 'handoff create_agent 生命周期完整',
        passed: createAgentEnds >= createAgentStarts && createAgentStarts >= 2,
        detail: `create_agent start=${createAgentStarts}, end=${createAgentEnds}`,
      });

      const skillHints = persistence.workerSkillHints;
      const researchWorkers = persistence.workerSessionIds.filter((id) => containsAnyKeyword(skillHints[id], ['research', '调研', '研究']));
      const writingWorkers = persistence.workerSessionIds.filter((id) => containsAnyKeyword(skillHints[id], ['write', 'writer', '写作', '整理']));

      if (researchWorkers.length > 0 && writingWorkers.length > 0) {
        const firstMsgOf = (sessionIds: string[]) => {
          const msg = persistence.messageSamples.find((m) => sessionIds.includes(m.senderSessionId));
          return msg ? parseIsoMs(msg.createdAt) : 0;
        };
        const researchFirst = firstMsgOf(researchWorkers);
        const writingFirst = firstMsgOf(writingWorkers);
        checks.push({
          name: 'handoff 顺序（研究先于写作）',
          passed: researchFirst > 0 && writingFirst > 0 && researchFirst <= writingFirst,
          detail: `research=${researchFirst || 'none'}, writing=${writingFirst || 'none'}`,
        });
      } else {
        checks.push({
          name: 'handoff 顺序（按 skill 推断）',
          passed: true,
          detail: '未识别 research/write skill，跳过顺序强校验',
        });
      }
    }
  } else {
    checks.push({ name: '持久化快照', passed: false, detail: '未获取' });
  }

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

async function runSingleScenario(
  scenario: ScenarioName,
  config: WorkspaceOrchestrationTestConfig,
  onLog?: (entry: LogEntry) => void,
): Promise<ScenarioResult> {
  const startTime = new Date().toISOString();
  const t0 = Date.now();
  const { logs, log } = createLogger(scenario, onLog);

  let status: ScenarioResult['status'] = 'passed';
  let error: string | undefined;
  let workspaceId: string | undefined;
  let sessionId = '';
  let verification: VerificationResult = { passed: false, checks: [] };
  let persistence: PersistenceSummary | undefined;
  let workspaceCapture: Awaited<ReturnType<typeof createWorkspaceEventCapture>> | null = null;
  let snapshotCapture: ReturnType<typeof createSnapshotCapture> | null = null;
  let toolCapture: Awaited<ReturnType<typeof createToolCallCapture>> | null = null;
  let uiLogStartIndex = 0;

  try {
    const currentSessionId = sessionManager.getCurrentSessionId();
    if (!currentSessionId) throw new Error('无活跃会话');
    sessionId = currentSessionId;

    const store = sessionManager.get(currentSessionId);
    if (!store) throw new Error(`无法获取会话 store: ${currentSessionId}`);

    // 若前一场景的 LLM 输出还未结束，等待至多 120s 再启动
    if (store.getState().sessionStatus === 'streaming') {
      log('warn', 'pre_start_wait', '会话仍在 streaming，等待结束后启动场景', {});
      const preWait = await waitFor(
        () => sessionManager.get(currentSessionId)?.getState().sessionStatus !== 'streaming',
        120_000,
        500,
      );
      if (preWait === 'aborted') {
        status = 'skipped';
        error = '用户中止测试';
        log('warn', 'abort', error);
        throw new Error(error);
      }
      if (preWait === 'timeout') {
        throw new Error('等待前置会话 streaming 结束超时（120s），无法启动场景');
      }
      log('info', 'pre_start_wait', '会话 streaming 已结束，继续启动', {});
    }

    const baselineStore = useWorkspaceStore.getState();
    const baselineWorkspaceId = baselineStore.currentWorkspaceId;
    const baselineWorkerCount = baselineStore.agents.filter((a) => a.role === 'worker').length;
    const baselineMessageCount = baselineStore.messages.length;
    const baselineWorkspaces = await listAllWorkspaces(currentSessionId);

    toolCapture = await createToolCallCapture([currentSessionId], log);
    uiLogStartIndex = getSubagentLogs().length;
    workspaceCapture = await createWorkspaceEventCapture(log, (item) => {
      if (item.eventName !== WORKSPACE_EVENTS.AGENT_JOINED) return;
      const agentSessionId = extractAgentSessionIdFromEventPayload(item.payload);
      const role = extractAgentRoleFromEventPayload(item.payload);
      if (!agentSessionId || role !== 'worker') return;
      void toolCapture?.attachSession(agentSessionId);
    });
    snapshotCapture = createSnapshotCapture(config.snapshotIntervalMs);

    const def = SCENARIO_DEFS[scenario];
    const runTag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const workspaceName = `${def.workspaceNameBase} ${runTag}`;
    const basePrompt = def.buildPrompt(workspaceName);
    const prompt = config.promptSuffix ? `${basePrompt}\n\n${config.promptSuffix}` : basePrompt;

    log('info', 'scenario', '场景启动', {
      scenario,
      workspaceName,
      minWorkers: def.minWorkers,
      minMessages: def.minMessages,
      requireSubagentCall: def.requireSubagentCall,
      timeoutMs: config.timeoutMs,
      mainSessionId: currentSessionId,
      baselineWorkspaceId,
      baselineWorkerCount,
      baselineMessageCount,
      baselineWorkspaceCount: baselineWorkspaces.length,
    });
    log('debug', 'scenario', 'prompt 全文', { prompt });
    await store.getState().sendMessage(prompt);

    // 先校验「关键里程碑」：主会话需触发足够次数的 workspace_create_agent:start。
    // 否则像 S3 这类交接场景会长时间卡住在单 worker 状态，直到总超时才结束。
    if (def.minWorkers > 0) {
      const createAgentMilestone = await waitFor(() => {
        const starts = (toolCapture?.toolCalls ?? []).filter(
          (t) => t.sessionId === currentSessionId && t.toolName === 'workspace_create_agent' && t.phase === 'start'
        ).length;
        return starts >= def.minWorkers;
      }, Math.min(config.timeoutMs, 90_000), config.pollMs);

      if (createAgentMilestone === 'aborted') {
        status = 'skipped';
        error = '用户中止测试';
        log('warn', 'abort', error);
        throw new Error(error);
      }

      if (createAgentMilestone === 'timeout') {
        const allTools = toolCapture?.toolCalls ?? [];
        const allEvents = workspaceCapture?.events ?? [];
        const starts = allTools.filter(
          (t) => t.sessionId === currentSessionId && t.toolName === 'workspace_create_agent' && t.phase === 'start'
        ).length;
        const ws = useWorkspaceStore.getState();
        log('error', 'milestone_timeout', 'worker 创建里程碑超时', {
          create_agent_starts: starts,
          required: def.minWorkers,
          store_workerCount: ws.agents.filter((a) => a.role === 'worker').length,
          store_workspaceId: ws.currentWorkspaceId,
          events_total: allEvents.length,
          coordinator_sleep_starts: allTools.filter((t) => t.toolName === 'coordinator_sleep' && t.phase === 'start').length,
          coordinator_sleep_ends:   allTools.filter((t) => t.toolName === 'coordinator_sleep' && t.phase === 'end').length,
          workspace_create_ends: allTools.filter((t) => t.toolName === 'workspace_create' && t.phase === 'end').length,
          tool_errors: allTools.filter((t) => t.phase === 'error').map((t) => ({ tool: t.toolName, err: t.error })),
        });
        throw new Error(`worker 创建里程碑未达成: workspace_create_agent:start=${starts}/${def.minWorkers}`);
      }
    }

    const finished = await waitFor(() => {
      const ws = useWorkspaceStore.getState();
      if (!ws.currentWorkspaceId) return false;

      const workerCount = ws.agents.filter((a) => a.role === 'worker').length;
      const messageCount = ws.messages.length;

      if (ws.currentWorkspaceId !== baselineWorkspaceId) {
        return workerCount >= def.minWorkers && messageCount >= def.minMessages;
      }

      return (workerCount - baselineWorkerCount) >= def.minWorkers
        && (messageCount - baselineMessageCount) >= def.minMessages;
    }, config.timeoutMs, config.pollMs);

    if (finished === 'aborted') {
      status = 'skipped';
      error = '用户中止测试';
      log('warn', 'abort', error);
      throw new Error(error);
    }

    if (finished === 'timeout') {
      const allTools = toolCapture?.toolCalls ?? [];
      const allEvents = workspaceCapture?.events ?? [];
      const ws = useWorkspaceStore.getState();
      const workerCount = ws.agents.filter((a) => a.role === 'worker').length;
      const messageCount = ws.messages.length;
      log('error', 'finish_timeout', '场景等待超时', {
        timeoutMs: config.timeoutMs,
        store_workspaceId: ws.currentWorkspaceId,
        store_workerCount: workerCount,
        store_messageCount: messageCount,
        required_workers: def.minWorkers,
        required_messages: def.minMessages,
        baseline_workerCount: baselineWorkerCount,
        baseline_messageCount: baselineMessageCount,
        delta_workers: workerCount - baselineWorkerCount,
        delta_messages: messageCount - baselineMessageCount,
        events_total: allEvents.length,
        agent_status_changed_events: allEvents
          .filter((e) => e.eventName === WORKSPACE_EVENTS.AGENT_STATUS_CHANGED)
          .map((e) => ({ session_id: e.payload.session_id ?? e.payload.sessionId, status: e.payload.status })),
        coordinator_sleep_results: allTools
          .filter((t) => t.toolName === 'coordinator_sleep' && t.phase === 'end')
          .map((t) => ({ reason: t.rawPayload?.reason, duration_ms: t.rawPayload?.duration_ms ?? t.rawPayload?.durationMs })),
        tool_errors: allTools.filter((t) => t.phase === 'error').map((t) => ({ tool: t.toolName, err: t.error })),
      });
      throw new Error(`场景超时: ${config.timeoutMs}ms`);
    }

    const settleResult = await sleepWithAbort(config.settleMs, 200);
    if (settleResult === 'aborted') {
      status = 'skipped';
      error = '用户中止测试';
      log('warn', 'abort', error);
      throw new Error(error);
    }

    // ── 等待结束后打印捕获快照，供后续诊断对比 ──
    {
      const capturedEvents = workspaceCapture?.events ?? [];
      const capturedTools = toolCapture?.toolCalls ?? [];
      const coordinatorAwakenEvents = capturedEvents.filter(
        (e) => e.eventName === WORKSPACE_EVENTS.COORDINATOR_AWAKENED,
      );
      const coordinatorSleepStarts = capturedTools.filter(
        (t) => t.toolName === 'coordinator_sleep' && t.phase === 'start',
      );
      const coordinatorSleepEnds = capturedTools.filter(
        (t) => t.toolName === 'coordinator_sleep' && t.phase === 'end',
      );

      log('info', 'settle_summary', '等待完成，捕获全量摘要', {
        events_total: capturedEvents.length,
        events_by_type: Object.fromEntries(
          Object.values(WORKSPACE_EVENTS).map((name) => [
            name.replace('workspace_', ''),
            capturedEvents.filter((e) => e.eventName === name).length,
          ])
        ),
        tool_calls_total: capturedTools.length,
        tool_calls_by_name: Object.fromEntries(
          ['workspace_create', 'workspace_create_agent', 'workspace_send',
           'workspace_query', 'coordinator_sleep', 'subagent_call'].map((n) => [
            n,
            {
              start: capturedTools.filter((t) => t.toolName === n && t.phase === 'start').length,
              end:   capturedTools.filter((t) => t.toolName === n && t.phase === 'end').length,
              error: capturedTools.filter((t) => t.toolName === n && t.phase === 'error').length,
            },
          ])
        ),
        coordinator_sleep_params: coordinatorSleepStarts.map((t) => ({
          wake_condition: t.rawPayload?.wake_condition ?? t.rawPayload?.wakeCondition,
          timeout_ms:     t.rawPayload?.timeout_ms     ?? t.rawPayload?.timeoutMs,
          awaiting_agents: t.rawPayload?.awaiting_agents ?? t.rawPayload?.awaitingAgents,
        })),
        coordinator_sleep_results: coordinatorSleepEnds.map((t) => ({
          status:      t.rawPayload?.status,
          reason:      t.rawPayload?.reason,
          awakened_by: t.rawPayload?.awakened_by ?? t.rawPayload?.awakenedBy,
          duration_ms: t.rawPayload?.duration_ms ?? t.rawPayload?.durationMs,
        })),
        coordinator_awakened_events: coordinatorAwakenEvents.map((e) => ({
          sleep_id:    e.payload.sleep_id    ?? e.payload.sleepId,
          awakened_by: e.payload.awakened_by ?? e.payload.awakenedBy,
          wake_reason: e.payload.wake_reason ?? e.payload.wakeReason,
        })),
        snapshots_count: (snapshotCapture?.snapshots ?? []).length,
        store_now: (() => {
          const ws = useWorkspaceStore.getState();
          return {
            workspaceId: ws.currentWorkspaceId,
            workerCount: ws.agents.filter((a) => a.role === 'worker').length,
            messageCount: ws.messages.length,
            documentCount: ws.documents.length,
          };
        })(),
      });
    }

    const ws = useWorkspaceStore.getState();
    const currentWorkspaces = await listAllWorkspaces(currentSessionId);
    const targetWorkspace = resolveScenarioWorkspace(
      baselineWorkspaces,
      currentWorkspaces,
      workspaceName,
      startTime,
      ws.currentWorkspaceId ?? undefined,
    );
    workspaceId = targetWorkspace?.id;
    log(workspaceId ? 'info' : 'warn', 'workspace_resolve', workspaceId ? '工作区已定位' : '工作区未找到', {
      resolved_id: workspaceId,
      resolved_name: targetWorkspace?.name,
      expected_name: workspaceName,
      all_workspaces_count: currentWorkspaces.length,
      new_workspaces: currentWorkspaces
        .filter((w) => !baselineWorkspaces.some((b) => b.id === w.id))
        .map((w) => ({ id: w.id, name: w.name })),
    });

    if (workspaceId) {
      const [agents, messages, documents] = await Promise.all([
        listAgents(currentSessionId, workspaceId),
        listMessages(currentSessionId, workspaceId, 200),
        listDocuments(currentSessionId, workspaceId),
      ]);

      const workerSessionIds = agents
        .filter((a) => a.role === 'worker')
        .map((a) => a.session_id);

      const workerSkillHints: Record<string, string | undefined> = {};
      for (const a of agents) {
        if (a.role === 'worker') {
          workerSkillHints[a.session_id] = a.skill_id;
        }
      }

      const distinctSenderSessionIds = Array.from(new Set(messages.map((m) => m.sender_session_id)));

      persistence = {
        agentsCount: agents.length,
        messagesCount: messages.length,
        documentsCount: documents.length,
        workspaceName: targetWorkspace?.name,
        workerSessionIds,
        workerSkillHints,
        distinctSenderSessionIds,
        messageSamples: messages
          .slice()
          .sort((a: MessageInfo, b: MessageInfo) => parseIsoMs(a.created_at) - parseIsoMs(b.created_at))
          .slice(0, 80)
          .map((m) => ({
            id: m.id,
            senderSessionId: m.sender_session_id,
            messageType: m.message_type,
            createdAt: m.created_at,
          })),
      };

      for (const workerSessionId of workerSessionIds) {
        await toolCapture.attachSession(workerSessionId);
      }

      log('success', 'persistence', '持久化快照已获取', {
        workspaceName: persistence.workspaceName,
        agentsCount: persistence.agentsCount,
        messagesCount: persistence.messagesCount,
        documentsCount: persistence.documentsCount,
        workerSessionIds: persistence.workerSessionIds,
      });
    }

    const scenarioWorkspaceEvents = workspaceCapture.events.filter((e) => {
      const eventWorkspaceId = extractWorkspaceIdFromObject(e.payload);
      if (!workspaceId) return true;
      if (!eventWorkspaceId) return false;
      return eventWorkspaceId === workspaceId;
    });

    const relevantSessionIds = new Set<string>([currentSessionId, ...(persistence?.workerSessionIds ?? [])]);
    const scenarioToolCalls = (toolCapture?.toolCalls ?? []).filter((t) => {
      if (!relevantSessionIds.has(t.sessionId)) return false;
      return isRelevantToolForWorkspace(t, workspaceId);
    });

    const scenarioSnapshots = (snapshotCapture?.snapshots ?? []).filter((s) => {
      if (!workspaceId) return true;
      return s.workspaceId === workspaceId;
    });

    log('info', 'eval_input', '进入校验，过滤后数据范围', {
      workspace_id: workspaceId,
      events_total: workspaceCapture.events.length,
      events_in_scope: scenarioWorkspaceEvents.length,
      events_out_of_scope: workspaceCapture.events.length - scenarioWorkspaceEvents.length,
      tool_calls_total: (toolCapture?.toolCalls ?? []).length,
      tool_calls_in_scope: scenarioToolCalls.length,
      tool_calls_out_of_scope: (toolCapture?.toolCalls ?? []).length - scenarioToolCalls.length,
      snapshots_in_scope: scenarioSnapshots.length,
      relevant_session_ids: Array.from(relevantSessionIds),
      events_by_type_in_scope: Object.fromEntries(
        Object.values(WORKSPACE_EVENTS).map((name) => [
          name.replace('workspace_', ''),
          scenarioWorkspaceEvents.filter((e) => e.eventName === name).length,
        ])
      ),
    });

    verification = evaluateChecks(
      scenario,
      def,
      workspaceId ?? null,
      scenarioWorkspaceEvents,
      scenarioToolCalls,
      scenarioSnapshots,
      collectUiLogsSince(uiLogStartIndex).filter((l) => {
        if ((l.timestamp && parseIsoMs(l.timestamp) < parseIsoMs(startTime))) return false;
        if (!persistence?.workerSessionIds?.length) return true;
        if (!l.subagentSessionId) return false;
        return persistence.workerSessionIds.includes(l.subagentSessionId);
      }),
      currentSessionId,
      persistence,
    );

    if (!verification.passed) {
      status = 'failed';
      const failedChecks = verification.checks.filter((c) => !c.passed);
      error = '验证未通过: ' + failedChecks.map((c) => c.name).join(', ');
      log('error', 'verify', error, {
        failed_checks: failedChecks.map((c) => ({ name: c.name, detail: c.detail })),
        all_checks: verification.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
      });
    } else {
      log('success', 'verify', '场景验证通过', {
        checks_count: verification.checks.length,
        all_checks: verification.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
      });
    }
  } catch (e) {
    if (status !== 'skipped') {
      status = 'failed';
    }
    error = e instanceof Error ? e.message : String(e);
    log(status === 'skipped' ? 'warn' : 'error', 'fatal', error);
  } finally {
    workspaceCapture?.stop();
    snapshotCapture?.stop();
    toolCapture?.stop();
  }

  const finalWorkspaceEvents = workspaceCapture?.events ?? [];
  const finalToolCalls = toolCapture?.toolCalls ?? [];
  const finalSnapshots = snapshotCapture?.snapshots ?? [];

  const filteredWorkspaceEvents = finalWorkspaceEvents.filter((e) => {
    if (parseIsoMs(e.timestamp) < parseIsoMs(startTime)) return false;
    if (!workspaceId) return true;
    return extractWorkspaceIdFromObject(e.payload) === workspaceId;
  });

  const filteredToolCalls = finalToolCalls.filter((t) => {
    if (parseIsoMs(t.timestamp) < parseIsoMs(startTime)) return false;
    return isRelevantToolForWorkspace(t, workspaceId);
  });

  const filteredSnapshots = finalSnapshots.filter((s) => {
    if (parseIsoMs(s.timestamp) < parseIsoMs(startTime)) return false;
    if (!workspaceId) return true;
    return s.workspaceId === workspaceId;
  });

  return {
    scenario,
    status,
    startTime,
    endTime: new Date().toISOString(),
    durationMs: Date.now() - t0,
    sessionId,
    workspaceId,
    verification,
    logs,
    workspaceEvents: filteredWorkspaceEvents,
    toolCalls: filteredToolCalls,
    snapshots: filteredSnapshots,
    persistence,
    error,
  };
}

export async function runAllWorkspaceOrchestrationTests(
  config: WorkspaceOrchestrationTestConfig,
  onScenarioComplete?: (result: ScenarioResult, index: number, total: number) => void,
  onLog?: (entry: LogEntry) => void,
): Promise<ScenarioResult[]> {
  _abortRequested = false;
  _logId = 0;
  _eventId = 0;
  _toolId = 0;
  _snapshotId = 0;

  const skip = new Set(config.skipScenarios || []);
  const active = ALL_SCENARIOS.filter((s) => !skip.has(s));
  const total = active.length;
  const results: ScenarioResult[] = [];
  let index = 0;

  for (const scenario of ALL_SCENARIOS) {
    if (_abortRequested || skip.has(scenario)) {
      const skipped: ScenarioResult = {
        scenario,
        status: 'skipped',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        durationMs: 0,
        sessionId: '',
        verification: { passed: true, checks: [] },
        logs: [],
        workspaceEvents: [],
        toolCalls: [],
        snapshots: [],
      };
      results.push(skipped);
      onScenarioComplete?.(skipped, index++, total);
      continue;
    }

    const result = await runSingleScenario(scenario, config, onLog);
    results.push(result);
    onScenarioComplete?.(result, index++, total);

    if (!_abortRequested) {
      const waitResult = await sleepWithAbort(Math.max(600, config.pollMs), 200);
      if (waitResult === 'aborted') {
        continue;
      }
    }

    // 等待协调者会话结束 streaming，再启动下一个场景
    if (!_abortRequested) {
      const sessId = sessionManager.getCurrentSessionId();
      if (sessId) {
        const streamDrainTimeoutMs = Math.min(config.timeoutMs, 120_000);
        const streamEndResult = await waitFor(() => {
          const s = sessionManager.get(sessId);
          if (!s) return true;
          return s.getState().sessionStatus !== 'streaming';
        }, streamDrainTimeoutMs, 300);
        if (streamEndResult === 'aborted') continue;
        if (streamEndResult === 'timeout') {
          onLog?.({
            id: ++_logId,
            timestamp: new Date().toISOString(),
            level: 'warn',
            phase: 'stream_wait',
            message: '等待会话 streaming 结束超时，继续执行下一个场景',
            data: { timeoutMs: streamDrainTimeoutMs, scenario },
          });
        }
      }
    }
  }

  return results;
}

export async function cleanupWorkspaceOrchestrationTestData(
  onProgress?: (msg: string) => void,
): Promise<{ deleted: number; errors: string[] }> {
  const errors: string[] = [];
  let deleted = 0;

  try {
    const currentSessionId = sessionManager.getCurrentSessionId();
    if (!currentSessionId) {
      return { deleted, errors: ['无活跃会话，无法清理 workspace'] };
    }

    const workspaces = await listAllWorkspaces(currentSessionId);
    const targets = workspaces.filter((w) => (w.name || '').startsWith('[OrchTest]'));

    for (const ws of targets) {
      try {
        await closeWorkspace(currentSessionId, ws.id);
      } catch {
        // ignore close failure, continue delete
      }
      try {
        await deleteWorkspace(currentSessionId, ws.id);
        deleted++;
        onProgress?.(`删除 workspace: ${ws.id} (${ws.name ?? '未命名'})`);
      } catch (e) {
        errors.push(`${ws.id}: ${String(e)}`);
      }
    }
  } catch (e) {
    errors.push(`清理失败: ${String(e)}`);
  }

  onProgress?.(`清理完成：删除 ${deleted} 个，错误 ${errors.length} 个`);
  return { deleted, errors };
}
