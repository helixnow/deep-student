/**
 * Agent Mesh & Swarm — Reactive Workbench Store & Host RPC Bridge.
 *
 * Zero direct Tauri `invoke` calls: Host RPC methods are supplied exclusively
 * by `src/ui-plugins/official/agent-mesh/mount.tsx` via `ctx.ui.host`!
 */

import { create } from 'zustand';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import type {
  MeshAdapterCapabilities,
  MeshAgentInfo,
  MeshApprovalDecision,
  MeshBoardMessage,
  MeshCenterViewMode,
  MeshCheckpointRecord,
  MeshCliBinaryOverrideInput,
  MeshCustomCliTemplate,
  MeshDriverKind,
  MeshExternalThread,
  MeshFileDiffEntry,
  MeshFileLease,
  MeshMemberStatus,
  MeshMessagePriority,
  MeshPeerExchange,
  MeshPendingApproval,
  MeshRevertResult,
  MeshSafetyPreferences,
  MeshSenderKind,
  MeshSwarmControlInput,
  MeshSwarmMember,
  MeshSwarmSession,
  MeshThreadStatus,
  MeshWorkbenchHostAdapter,
  MeshWorkbenchOpenState,
} from './workbench-types';

const FULL_CAPABILITIES: MeshAdapterCapabilities = {
  streamingEvents: true,
  midTurnSteer: true,
  interrupt: true,
  approvalCallback: true,
  sessionResume: true,
  sessionFork: true,
  nativeSubagentTree: true,
  backgroundTaskEvents: true,
  mcpInjection: true,
};

const BASIC_CLI_CAPABILITIES: MeshAdapterCapabilities = {
  streamingEvents: true,
  midTurnSteer: false,
  interrupt: true,
  approvalCallback: false,
  sessionResume: true,
  sessionFork: false,
  nativeSubagentTree: false,
  backgroundTaskEvents: false,
  mcpInjection: false,
};

export const DEFAULT_HETEROGENEOUS_AGENTS: readonly MeshAgentInfo[] = [
  {
    id: 'deepstudent',
    driver: 'builtin',
    name: 'DeepStudent',
    handle: '@deepstudent',
    available: true,
    authenticated: true,
    roleHint: '学习主代理 · 协调验收',
    capabilities: FULL_CAPABILITIES,
  },
  {
    id: 'claude',
    driver: 'claude',
    name: 'Claude Code',
    handle: '@claude',
    available: false,
    roleHint: '架构设计 · 深度重构',
    capabilities: FULL_CAPABILITIES,
  },
  {
    id: 'codex',
    driver: 'codex',
    name: 'Codex CLI',
    handle: '@codex',
    available: false,
    roleHint: '并发实现 · 测试修复',
    capabilities: FULL_CAPABILITIES,
  },
  {
    id: 'opencode',
    driver: 'opencode',
    name: 'OpenCode',
    handle: '@opencode',
    available: false,
    roleHint: 'ACP 会话 · 多文件编辑',
    capabilities: { ...FULL_CAPABILITIES, sessionFork: false },
  },
  {
    id: 'pi',
    driver: 'pi',
    name: 'Pi Agent',
    handle: '@pi',
    available: false,
    roleHint: 'RPC 极速执行',
    capabilities: { ...FULL_CAPABILITIES, sessionFork: false },
  },
  {
    id: 'agy',
    driver: 'agy',
    name: 'Antigravity CLI',
    handle: '@agy',
    available: false,
    roleHint: '全栈工程代理',
    capabilities: BASIC_CLI_CAPABILITIES,
  },
  {
    id: 'dsh',
    driver: 'dsh',
    name: 'DSH CLI',
    handle: '@dsh',
    available: false,
    roleHint: '终端脚本代理',
    capabilities: BASIC_CLI_CAPABILITIES,
  },
];

const SAFETY_PREFS_STORAGE_KEY = 'ds:agent-mesh:safety-prefs:v1';

function loadInitialSafetyPreferences(): MeshSafetyPreferences {
  const fallback: MeshSafetyPreferences = {
    maxAutonomousHops: 12,
    defaultInPlaceMode: true,
    autoAcquireFileLeases: true,
    allowStudyContextMcp: true,
  };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(SAFETY_PREFS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<MeshSafetyPreferences>;
    return {
      maxAutonomousHops:
        typeof parsed.maxAutonomousHops === 'number' && parsed.maxAutonomousHops >= 2
          ? Math.min(64, Math.round(parsed.maxAutonomousHops))
          : fallback.maxAutonomousHops,
      defaultInPlaceMode:
        typeof parsed.defaultInPlaceMode === 'boolean'
          ? parsed.defaultInPlaceMode
          : fallback.defaultInPlaceMode,
      autoAcquireFileLeases:
        typeof parsed.autoAcquireFileLeases === 'boolean'
          ? parsed.autoAcquireFileLeases
          : fallback.autoAcquireFileLeases,
      allowStudyContextMcp:
        typeof parsed.allowStudyContextMcp === 'boolean'
          ? parsed.allowStudyContextMcp
          : fallback.allowStudyContextMcp,
    };
  } catch {
    return fallback;
  }
}

function saveSafetyPreferencesToStorage(prefs: MeshSafetyPreferences): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SAFETY_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota/sandbox errors in tests.
  }
}

let activeHostAdapter: MeshWorkbenchHostAdapter | null = null;

export function setMeshWorkbenchHostAdapter(adapter: MeshWorkbenchHostAdapter | null): () => void {
  activeHostAdapter = adapter;
  return () => {
    if (activeHostAdapter === adapter) {
      activeHostAdapter = null;
    }
  };
}

export function getMeshWorkbenchHostAdapter(): MeshWorkbenchHostAdapter | null {
  return activeHostAdapter;
}

// ------------------------------------------------------------------ Normalizers

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonArray<T = string>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as T[];
    } catch {
      return [];
    }
  }
  return [];
}

function toTimestampMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function normalizeAgentInfo(raw: unknown): MeshAgentInfo | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = String(r.id ?? r.agentId ?? r.driver ?? '').trim();
  if (!id) return null;
  const preset = DEFAULT_HETEROGENEOUS_AGENTS.find((a) => a.id === id);
  const rawKind = typeof r.kind === 'string' ? (r.kind === 'deepstudent' ? 'builtin' : r.kind) : undefined;
  const driver = (r.driver ?? rawKind ?? preset?.driver ?? 'custom') as MeshDriverKind;
  const rawCaps = asRecord(r.capabilities);
  const capabilities: MeshAdapterCapabilities = rawCaps
    ? {
        streamingEvents: Boolean(rawCaps.streamingEvents ?? true),
        midTurnSteer: Boolean(rawCaps.midTurnSteer ?? false),
        interrupt: Boolean(rawCaps.interrupt ?? true),
        approvalCallback: Boolean(rawCaps.approvalCallback ?? false),
        sessionResume: Boolean(rawCaps.sessionResume ?? false),
        sessionFork: Boolean(rawCaps.sessionFork ?? false),
        nativeSubagentTree: Boolean(rawCaps.nativeSubagentTree ?? false),
        backgroundTaskEvents: Boolean(rawCaps.backgroundTaskEvents ?? false),
        mcpInjection: Boolean(rawCaps.mcpInjection ?? false),
      }
    : (preset?.capabilities ?? BASIC_CLI_CAPABILITIES);
  const name =
    typeof r.displayName === 'string' && r.displayName.trim()
      ? r.displayName.trim()
      : typeof r.name === 'string' && r.name.trim()
        ? r.name.trim()
        : (preset?.name ?? id);
  const rawHandle = typeof r.handle === 'string' && r.handle.trim() ? r.handle.trim() : `@${id}`;
  const handle = rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`;
  return {
    id,
    driver,
    name,
    handle,
    available: id === 'deepstudent' ? true : Boolean(r.available ?? r.installed ?? r.detected ?? false),
    authenticated: r.authenticated === undefined ? preset?.authenticated : Boolean(r.authenticated),
    version: typeof r.version === 'string' ? r.version : null,
    binaryPath:
      typeof r.binaryPath === 'string'
        ? r.binaryPath
        : typeof r.executablePath === 'string'
          ? r.executablePath
          : typeof r.command === 'string'
            ? r.command
            : null,
    customExecutablePath:
      typeof r.customExecutablePath === 'string' && r.customExecutablePath.trim()
        ? r.customExecutablePath.trim()
        : null,
    extraArgs: Array.isArray(r.extraArgs)
      ? r.extraArgs.map((item) => String(item).trim()).filter(Boolean)
      : [],
    probeError:
      typeof r.probeError === 'string' && r.probeError.trim()
        ? r.probeError.trim()
        : null,
    authHint: typeof r.authHint === 'string' ? r.authHint : null,
    roleHint: typeof r.roleHint === 'string' ? r.roleHint : (preset?.roleHint ?? null),
    capabilities,
  };
}

function mergeAgentCatalog(detected: readonly MeshAgentInfo[]): MeshAgentInfo[] {
  const byId = new Map<string, MeshAgentInfo>();
  for (const preset of DEFAULT_HETEROGENEOUS_AGENTS) {
    byId.set(preset.id, { ...preset });
  }
  for (const item of detected) {
    const existing = byId.get(item.id);
    byId.set(item.id, existing ? { ...existing, ...item, available: item.id === 'deepstudent' ? true : item.available } : item);
  }
  return Array.from(byId.values());
}

function normalizeSwarmSession(raw: unknown, fallbackSessionId?: string): MeshSwarmSession | null {
  const r = asRecord(raw);
  if (!r) return null;
  const chatSessionId = String(r.chatSessionId ?? r.chat_session_id ?? fallbackSessionId ?? '').trim();
  if (!chatSessionId) return null;
  const statusRaw = String(r.status ?? 'active');
  const status: MeshSwarmSession['status'] =
    statusRaw === 'paused' || statusRaw === 'completed' ? statusRaw : 'active';
  const autonomousHops = Number(r.autonomousHops ?? r.autonomous_hops ?? 0) || 0;
  const maxAutonomousHops = Number(r.maxAutonomousHops ?? r.max_autonomous_hops ?? 12) || 12;
  return {
    chatSessionId,
    title: typeof r.title === 'string' && r.title.trim() ? r.title : '异构蜂群协作',
    goal: typeof r.goal === 'string' ? r.goal : '',
    status,
    coordinatorAgent: String(r.coordinatorAgent ?? r.coordinator_agent ?? 'deepstudent'),
    autonomousHops,
    maxAutonomousHops,
    headSeq: Number(r.headSeq ?? r.head_seq ?? 0) || 0,
    circuitBreakerTripped: Boolean(
      r.circuitBreakerTripped ?? r.circuit_breaker_tripped ?? (status === 'paused' && autonomousHops >= maxAutonomousHops),
    ),
    circuitBreakerReason:
      typeof r.circuitBreakerReason === 'string'
        ? r.circuitBreakerReason
        : typeof r.circuit_breaker_reason === 'string'
          ? r.circuit_breaker_reason
          : null,
    createdAt: toTimestampMs(r.createdAt ?? r.created_at),
    updatedAt: toTimestampMs(r.updatedAt ?? r.updated_at),
  };
}

function normalizeSwarmMember(raw: unknown, fallbackSessionId?: string): MeshSwarmMember | null {
  const r = asRecord(raw);
  if (!r) return null;
  const chatSessionId = String(r.chatSessionId ?? r.chat_session_id ?? fallbackSessionId ?? '').trim();
  const rosterName = String(r.rosterName ?? r.roster_name ?? r.agentId ?? r.agent_id ?? '').trim().replace(/^@/, '');
  if (!chatSessionId || !rosterName) return null;
  const agentId = String(r.agentId ?? r.agent_id ?? rosterName).trim().replace(/^@/, '');
  const statusRaw = String(r.status ?? 'parked');
  const status: MeshMemberStatus =
    statusRaw === 'working' ||
    statusRaw === 'waiting_children' ||
    statusRaw === 'waiting_approval' ||
    statusRaw === 'stopped' ||
    statusRaw === 'failed'
      ? statusRaw
      : statusRaw === 'running'
        ? 'working'
        : 'parked';
  return {
    chatSessionId,
    rosterName,
    agentId,
    roleTitle: typeof r.roleTitle === 'string'
      ? r.roleTitle
      : typeof r.role_title === 'string'
        ? r.role_title
        : agentId === 'deepstudent'
          ? '协调者'
          : '协作代理',
    status,
    currentActivity:
      typeof r.currentActivity === 'string'
        ? r.currentActivity
        : typeof r.current_activity === 'string'
          ? r.current_activity
          : null,
    threadId: typeof r.threadId === 'string' ? r.threadId : typeof r.thread_id === 'string' ? r.thread_id : null,
    externalSessionId:
      typeof r.externalSessionId === 'string'
        ? r.externalSessionId
        : typeof r.external_session_id === 'string'
          ? r.external_session_id
          : null,
    lastSeenSeq: Number(r.lastSeenSeq ?? r.last_seen_seq ?? 0) || 0,
    ownedGlobs: parseJsonArray<string>(r.ownedGlobs ?? r.owned_globs_json),
    humanControlled: Boolean(r.humanControlled ?? r.human_controlled ?? false),
    activeChildCount: Number(r.activeChildCount ?? r.active_child_count ?? 0) || 0,
    activeBgTaskCount: Number(r.activeBgTaskCount ?? r.active_bg_task_count ?? 0) || 0,
  };
}

function normalizeBoardMessage(raw: unknown, fallbackSessionId?: string): MeshBoardMessage | null {
  const r = asRecord(raw);
  if (!r) return null;
  const chatSessionId = String(r.chatSessionId ?? r.chat_session_id ?? fallbackSessionId ?? '').trim();
  const seq = Number(r.seq);
  if (!chatSessionId || !Number.isFinite(seq)) return null;
  const senderKindRaw = String(r.senderKind ?? r.sender_kind ?? 'worker');
  const senderKind: MeshSenderKind =
    senderKindRaw === 'human' || senderKindRaw === 'coordinator' || senderKindRaw === 'system'
      ? senderKindRaw
      : 'worker';
  const priorityRaw = String(r.priority ?? 'progress');
  const priority: MeshMessagePriority =
    priorityRaw === 'correction' ||
    priorityRaw === 'task' ||
    priorityRaw === 'query' ||
    priorityRaw === 'result'
      ? priorityRaw
      : 'progress';
  return {
    seq,
    chatSessionId,
    sender: String(r.sender ?? 'system').replace(/^@/, ''),
    senderKind,
    priority,
    text: String(r.text ?? ''),
    mentions: parseJsonArray<string>(r.mentions ?? r.mentions_json).map((m) => String(m).replace(/^@/, '')),
    channel: typeof r.channel === 'string' ? r.channel : null,
    replyToSeq: typeof r.replyToSeq === 'number' ? r.replyToSeq : typeof r.reply_to_seq === 'number' ? r.reply_to_seq : null,
    diffRef: typeof r.diffRef === 'string' ? r.diffRef : typeof r.diff_ref === 'string' ? r.diff_ref : null,
    createdAt: toTimestampMs(r.createdAt ?? r.created_at),
  };
}

function normalizeThread(raw: unknown, fallbackSessionId?: string): MeshExternalThread | null {
  const r = asRecord(raw);
  if (!r) return null;
  const threadId = String(r.threadId ?? r.thread_id ?? '').trim();
  const chatSessionId = String(r.chatSessionId ?? r.chat_session_id ?? fallbackSessionId ?? '').trim();
  if (!threadId || !chatSessionId) return null;
  const statusRaw = String(r.status ?? 'idle');
  const status: MeshThreadStatus =
    statusRaw === 'running' ||
    statusRaw === 'waiting_children' ||
    statusRaw === 'waiting_approval' ||
    statusRaw === 'stopped' ||
    statusRaw === 'failed'
      ? statusRaw
      : statusRaw === 'working'
        ? 'running'
        : 'idle';
  const approvalRaw = asRecord(r.pendingApproval ?? r.pending_approval);
  const pendingApproval: MeshPendingApproval | null = approvalRaw
    ? {
        requestId: String(approvalRaw.requestId ?? approvalRaw.request_id ?? `${threadId}-req`),
        threadId,
        agentId: String(approvalRaw.agentId ?? r.agentId ?? r.agent_id ?? ''),
        rosterName: typeof approvalRaw.rosterName === 'string' ? approvalRaw.rosterName : null,
        toolName: String(approvalRaw.toolName ?? approvalRaw.tool_name ?? 'Tool'),
        targetPath: typeof approvalRaw.targetPath === 'string' ? approvalRaw.targetPath : null,
        command: typeof approvalRaw.command === 'string' ? approvalRaw.command : null,
        reason: typeof approvalRaw.reason === 'string' ? approvalRaw.reason : null,
        requestedAt: toTimestampMs(approvalRaw.requestedAt),
      }
    : null;
  const diffRaw = asRecord(r.diffSummary ?? r.diff_summary);
  const childSubagents: MeshExternalThread['childSubagents'] = Array.isArray(r.childSubagents)
    ? r.childSubagents.map((item, idx) => {
        const c = asRecord(item) ?? {};
        const childStatus = String(c.status ?? 'running');
        return {
          id: String(c.id ?? c.childId ?? `${threadId}-sub-${idx}`),
          parentToolUseId: typeof c.parentToolUseId === 'string' ? c.parentToolUseId : null,
          title: String(c.title ?? c.childId ?? 'Subagent'),
          status:
            childStatus === 'completed' || childStatus === 'failed' ? childStatus : 'running',
          startedAt: toTimestampMs(c.startedAt),
          completedAt: c.completedAt !== undefined && c.completedAt !== null ? toTimestampMs(c.completedAt) : null,
          summary: typeof c.summary === 'string' ? c.summary : null,
        };
      })
    : [];
  const toolCalls: MeshExternalThread['toolCalls'] = Array.isArray(r.toolCalls)
    ? r.toolCalls.map((item, idx) => {
        const tc = asRecord(item) ?? {};
        const tcStatus = String(tc.status ?? 'running');
        return {
          id: String(tc.id ?? tc.callId ?? `${threadId}-tc-${idx}`),
          toolName: String(tc.toolName ?? 'Tool'),
          status:
            tcStatus === 'completed'
              ? 'completed'
              : tcStatus === 'failed' || tcStatus === 'error'
                ? 'failed'
                : 'running',
          targetPath: typeof tc.targetPath === 'string' ? tc.targetPath : null,
          command: typeof tc.command === 'string' ? tc.command : null,
          outputPreview:
            typeof tc.outputPreview === 'string'
              ? tc.outputPreview
              : typeof tc.output === 'string'
                ? tc.output.slice(0, 240)
                : null,
          startedAt: toTimestampMs(tc.startedAt),
          completedAt: tc.completedAt !== undefined && tc.completedAt !== null ? toTimestampMs(tc.completedAt) : null,
        };
      })
    : [];
  return {
    threadId,
    chatSessionId,
    agentId: String(r.agentId ?? r.agent_id ?? 'claude').replace(/^@/, ''),
    rosterName:
      typeof r.rosterName === 'string'
        ? r.rosterName.replace(/^@/, '')
        : typeof r.roster_name === 'string'
          ? r.roster_name.replace(/^@/, '')
          : null,
    rootPath: String(r.rootPath ?? r.root_path ?? ''),
    externalSessionId:
      typeof r.externalSessionId === 'string'
        ? r.externalSessionId
        : typeof r.external_session_id === 'string'
          ? r.external_session_id
          : null,
    status,
    humanControlled: Boolean(r.humanControlled ?? r.human_controlled ?? false),
    streamingText: String(r.streamingText ?? r.streaming_text ?? r.assistantText ?? r.outputText ?? ''),
    thinkingText: typeof r.thinkingText === 'string' ? r.thinkingText : undefined,
    currentActivity:
      typeof r.currentActivity === 'string'
        ? r.currentActivity
        : typeof r.current_activity === 'string'
          ? r.current_activity
          : null,
    childSubagents,
    activeBgTasks: Array.isArray(r.activeBgTasks) ? (r.activeBgTasks as string[]) : [],
    toolCalls,
    pendingApproval,
    diffSummary: diffRaw
      ? {
          filesChanged: Number(diffRaw.filesChanged ?? diffRaw.files_changed ?? 0) || 0,
          additions: Number(diffRaw.additions ?? diffRaw.totalAdditions ?? 0) || 0,
          deletions: Number(diffRaw.deletions ?? diffRaw.totalDeletions ?? 0) || 0,
        }
      : null,
    lastCheckpointId:
      typeof r.lastCheckpointId === 'string'
        ? r.lastCheckpointId
        : typeof r.last_checkpoint_id === 'string'
          ? r.last_checkpoint_id
          : null,
    errorMessage: typeof r.errorMessage === 'string' ? r.errorMessage : null,
    createdAt: toTimestampMs(r.createdAt ?? r.created_at),
    updatedAt: toTimestampMs(r.updatedAt ?? r.updated_at),
  };
}

function normalizeFileDiff(raw: unknown, fallbackAgentId?: string, checkpointId?: string, turnSeq?: number): MeshFileDiffEntry | null {
  const r = asRecord(raw);
  if (!r || typeof r.path !== 'string') return null;
  const statusRaw = String(r.status ?? 'modified');
  const status: MeshFileDiffEntry['status'] =
    statusRaw === 'added' || statusRaw === 'deleted' || statusRaw === 'renamed' ? statusRaw : 'modified';
  return {
    path: r.path,
    status,
    additions: Number(r.additions ?? 0) || 0,
    deletions: Number(r.deletions ?? 0) || 0,
    patch: typeof r.patch === 'string' ? r.patch : '',
    attributedAgentId:
      typeof r.attributedAgentId === 'string'
        ? r.attributedAgentId.replace(/^@/, '')
        : fallbackAgentId ?? null,
    attributedRosterName:
      typeof r.attributedRosterName === 'string'
        ? r.attributedRosterName.replace(/^@/, '')
        : null,
    checkpointId: typeof r.checkpointId === 'string' ? r.checkpointId : (checkpointId ?? null),
    turnSeq: typeof r.turnSeq === 'number' ? r.turnSeq : (turnSeq ?? null),
  };
}

function normalizeCheckpoint(raw: unknown, fallbackSessionId?: string): MeshCheckpointRecord | null {
  const r = asRecord(raw);
  if (!r) return null;
  const checkpointId = String(r.checkpointId ?? r.checkpoint_id ?? r.id ?? '').trim();
  const chatSessionId = String(r.chatSessionId ?? r.chat_session_id ?? fallbackSessionId ?? '').trim();
  if (!checkpointId || !chatSessionId) return null;
  const agentId = String(r.agentId ?? r.agent_id ?? 'claude').replace(/^@/, '');
  const turnSeq = Number(r.turnSeq ?? r.turn_seq ?? 1) || 1;
  const files = Array.isArray(r.files)
    ? r.files
        .map((f) => normalizeFileDiff(f, agentId, checkpointId, turnSeq))
        .filter((f): f is MeshFileDiffEntry => f !== null)
    : [];
  const computedAdditions = files.reduce((acc, f) => acc + f.additions, 0);
  const computedDeletions = files.reduce((acc, f) => acc + f.deletions, 0);
  return {
    checkpointId,
    chatSessionId,
    threadId: typeof r.threadId === 'string' ? r.threadId : typeof r.thread_id === 'string' ? r.thread_id : null,
    agentId,
    rosterName:
      typeof r.rosterName === 'string'
        ? r.rosterName.replace(/^@/, '')
        : typeof r.roster_name === 'string'
          ? r.roster_name.replace(/^@/, '')
          : null,
    turnSeq,
    kind: r.kind === 'before' ? 'before' : 'after',
    refName: typeof r.refName === 'string' ? r.refName : typeof r.ref === 'string' ? r.ref : null,
    rootPath: String(r.rootPath ?? r.root_path ?? ''),
    summary: typeof r.summary === 'string' ? r.summary : null,
    filesChanged: Number(r.filesChanged ?? r.files_changed ?? files.length) || files.length,
    additions: Number(r.additions ?? r.totalAdditions ?? computedAdditions) || computedAdditions,
    deletions: Number(r.deletions ?? r.totalDeletions ?? computedDeletions) || computedDeletions,
    files,
    createdAt: toTimestampMs(r.createdAt ?? r.created_at),
  };
}

function normalizeFileLease(raw: unknown, idx = 0): MeshFileLease | null {
  const r = asRecord(raw);
  if (!r) return null;
  const holderAgentId = String(r.holderAgentId ?? r.holder_agent_id ?? r.agentId ?? '').trim().replace(/^@/, '');
  if (!holderAgentId) return null;
  const patterns = Array.isArray(r.patterns)
    ? r.patterns.map(String)
    : typeof r.pattern === 'string'
      ? [r.pattern]
      : [];
  return {
    id: String(r.id ?? r.leaseId ?? `${holderAgentId}:${patterns.join(',')}:${idx}`),
    rootPath: String(r.rootPath ?? r.root_path ?? ''),
    patterns,
    holderAgentId,
    rosterName: typeof r.rosterName === 'string' ? r.rosterName.replace(/^@/, '') : null,
    threadId: typeof r.threadId === 'string' ? r.threadId : typeof r.holderThreadId === 'string' ? r.holderThreadId : null,
    heldSince: toTimestampMs(r.heldSince ?? r.held_since),
    expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : typeof r.expiresAtMs === 'number' ? r.expiresAtMs : null,
  };
}

function normalizeCustomTemplate(raw: unknown): MeshCustomCliTemplate | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = String(r.id ?? '').trim();
  const name = String(r.name ?? id).trim();
  const command = String(r.command ?? '').trim();
  if (!id || !command) return null;
  return {
    id,
    name,
    handle: typeof r.handle === 'string' ? r.handle : `@${id}`,
    command,
    args: parseJsonArray<string>(r.args ?? r.args_json),
    resumeArgs: parseJsonArray<string>(r.resumeArgs ?? r.resume_args_json),
    env: (asRecord(r.env) as Record<string, string> | null) ?? undefined,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : undefined,
  };
}

function parseMentionsFromText(text: string): string[] {
  const matches = text.matchAll(/(?:^|\s)@([A-Za-z0-9_-]+)/g);
  const set = new Set<string>();
  for (const m of matches) {
    if (m[1]) set.add(m[1]);
  }
  return Array.from(set);
}

// ------------------------------------------------------------------ Zustand Store

export interface AgentMeshWorkbenchState {
  agents: MeshAgentInfo[];
  customTemplates: MeshCustomCliTemplate[];
  probing: boolean;
  lastProbedAt: number | null;
  safetyPreferences: MeshSafetyPreferences;
  workspaceBindings: Record<string, string>;
  swarmBySession: Record<string, MeshSwarmSession>;
  membersBySession: Record<string, MeshSwarmMember[]>;
  boardBySession: Record<string, MeshBoardMessage[]>;
  threadsBySession: Record<string, MeshExternalThread[]>;
  checkpointsBySession: Record<string, MeshCheckpointRecord[]>;
  leasesBySession: Record<string, MeshFileLease[]>;
  peerExchangesBySession: Record<string, MeshPeerExchange[]>;
  activeSessionId: string | null;
  workbench: MeshWorkbenchOpenState;

  // UI Actions
  setActiveSessionId: (sessionId: string | null) => void;
  openWorkbench: (options?: {
    sessionId?: string | null;
    selectedRosterName?: string | null;
    selectedThreadId?: string | null;
    centerView?: MeshCenterViewMode;
    pendingDispatchPrompt?: string | null;
  }) => void;
  closeWorkbench: () => void;
  selectMember: (rosterName: string | null, centerView?: MeshCenterViewMode) => void;
  setCenterView: (view: MeshCenterViewMode) => void;
  toggleRightPane: () => void;
  updateSafetyPreferences: (patch: Partial<MeshSafetyPreferences>) => void;

  // Hydrators / Snapshot Appliers
  applySessionSnapshot: (sessionId: string, snapshot: unknown) => void;

  // Async Host-backed Actions (with optimistic local continuity)
  probeDetectedAgents: (forceRefresh?: boolean) => Promise<MeshAgentInfo[]>;
  bindWorkspacePath: (chatSessionId: string, rootPath: string) => Promise<void>;
  refreshSessionSnapshot: (chatSessionId: string) => Promise<void>;
  initializeSwarm: (input: {
    chatSessionId: string;
    goal?: string;
    title?: string;
    initialMembers?: string[];
  }) => Promise<void>;
  toggleSwarmPause: (chatSessionId: string) => Promise<void>;
  resumeCircuitBreaker: (chatSessionId: string, extraHops?: number) => Promise<void>;
  addSwarmMember: (input: {
    chatSessionId: string;
    agentId: string;
    rosterName?: string;
    roleTitle?: string;
    ownedGlobs?: string[];
  }) => Promise<void>;
  postBoardMessage: (input: {
    chatSessionId: string;
    text: string;
    priority?: MeshMessagePriority;
    mentions?: string[];
  }) => Promise<void>;
  steerMember: (input: {
    chatSessionId: string;
    rosterName: string;
    threadId?: string | null;
    prompt: string;
  }) => Promise<void>;
  interruptMember: (input: {
    chatSessionId: string;
    rosterName: string;
    threadId?: string | null;
    reason?: string;
  }) => Promise<void>;
  toggleHumanTakeover: (input: {
    chatSessionId: string;
    rosterName: string;
    threadId?: string | null;
    humanControlled: boolean;
  }) => Promise<void>;
  handoffMemberToCli: (input: {
    chatSessionId: string;
    fromRosterName: string;
    targetAgentId: string;
    summary?: string;
    nextTask?: string;
  }) => Promise<void>;
  respondThreadApproval: (input: {
    chatSessionId: string;
    threadId: string;
    requestId: string;
    decision: MeshApprovalDecision;
    note?: string;
  }) => Promise<void>;
  loadCheckpointDiff: (input: {
    chatSessionId: string;
    checkpointId: string;
    rootPath?: string;
  }) => Promise<MeshFileDiffEntry[]>;
  revertCheckpointInPlace: (input: {
    chatSessionId: string;
    checkpointId: string;
    paths?: string[];
    forceOverwriteUserEdits?: boolean;
    rootPath?: string;
  }) => Promise<MeshRevertResult>;
  dispatchSummaryToDeepStudent: (input: {
    chatSessionId?: string | null;
    mode: 'explain_and_notes' | 'flashcards';
    files: string[];
    agents: string[];
  }) => void;
  emergencyStopAllExternal: (reason?: string) => Promise<number>;
  saveCustomTemplate: (template: MeshCustomCliTemplate) => Promise<void>;
  removeCustomTemplate: (id: string) => Promise<void>;
  saveCliOverride: (input: MeshCliBinaryOverrideInput) => Promise<void>;
  resetCliOverride: (agentId: string) => Promise<void>;
  resetStoreForTests: () => void;
}

const INITIAL_WORKBENCH_STATE: MeshWorkbenchOpenState = {
  open: false,
  sessionId: null,
  selectedRosterName: null,
  selectedThreadId: null,
  centerView: 'board',
  rightPaneCollapsed: false,
  pendingDispatchPrompt: null,
};

export const useAgentMeshWorkbenchStore = create<AgentMeshWorkbenchState>((set, get) => ({
  agents: mergeAgentCatalog([]),
  customTemplates: [],
  probing: false,
  lastProbedAt: null,
  safetyPreferences: loadInitialSafetyPreferences(),
  workspaceBindings: {},
  swarmBySession: {},
  membersBySession: {},
  boardBySession: {},
  threadsBySession: {},
  checkpointsBySession: {},
  leasesBySession: {},
  peerExchangesBySession: {},
  activeSessionId: null,
  workbench: { ...INITIAL_WORKBENCH_STATE },

  setActiveSessionId: (sessionId) => {
    set({ activeSessionId: sessionId });
  },

  openWorkbench: (options) => {
    const state = get();
    const resolvedSessionId =
      options?.sessionId !== undefined
        ? options.sessionId
        : (state.workbench.sessionId ?? state.activeSessionId ?? 'default-session');
    set({
      workbench: {
        ...state.workbench,
        open: true,
        sessionId: resolvedSessionId,
        selectedRosterName:
          options?.selectedRosterName !== undefined
            ? options.selectedRosterName
            : state.workbench.selectedRosterName,
        selectedThreadId:
          options?.selectedThreadId !== undefined
            ? options.selectedThreadId
            : state.workbench.selectedThreadId,
        centerView: options?.centerView ?? state.workbench.centerView,
        pendingDispatchPrompt:
          options?.pendingDispatchPrompt !== undefined
            ? options.pendingDispatchPrompt
            : state.workbench.pendingDispatchPrompt,
      },
    });
    if (resolvedSessionId) {
      void get().refreshSessionSnapshot(resolvedSessionId);
    }
  },

  closeWorkbench: () => {
    set((state) => ({
      workbench: {
        ...state.workbench,
        open: false,
        pendingDispatchPrompt: null,
      },
    }));
  },

  selectMember: (rosterName, centerView) => {
    set((state) => {
      const sid = state.workbench.sessionId ?? state.activeSessionId ?? '';
      const member = (state.membersBySession[sid] ?? []).find((m) => m.rosterName === rosterName);
      const thread = (state.threadsBySession[sid] ?? []).find(
        (t) => t.rosterName === rosterName || t.agentId === rosterName,
      );
      return {
        workbench: {
          ...state.workbench,
          selectedRosterName: rosterName,
          selectedThreadId: member?.threadId ?? thread?.threadId ?? null,
          centerView: centerView ?? (rosterName ? 'stream' : 'board'),
        },
      };
    });
  },

  setCenterView: (view) => {
    set((state) => ({
      workbench: { ...state.workbench, centerView: view },
    }));
  },

  toggleRightPane: () => {
    set((state) => ({
      workbench: {
        ...state.workbench,
        rightPaneCollapsed: !state.workbench.rightPaneCollapsed,
      },
    }));
  },

  updateSafetyPreferences: (patch) => {
    const next: MeshSafetyPreferences = {
      ...get().safetyPreferences,
      ...patch,
    };
    saveSafetyPreferencesToStorage(next);
    set({ safetyPreferences: next });
  },

  applySessionSnapshot: (sessionId, rawSnapshot) => {
    const snap = asRecord(rawSnapshot);
    if (!snap || !sessionId) return;
    set((state) => {
      const nestedSwarm = asRecord(snap.swarm);
      const rawSwarmRecord = asRecord(nestedSwarm?.session) ?? nestedSwarm ?? (snap.session ? asRecord(snap.session) : null);
      const nextSwarm = rawSwarmRecord ? normalizeSwarmSession(rawSwarmRecord, sessionId) : undefined;
      const membersSource = Array.isArray(snap.members)
        ? snap.members
        : Array.isArray(nestedSwarm?.members)
          ? nestedSwarm.members
          : undefined;
      const nextMembers = membersSource
        ? membersSource
            .map((m) => normalizeSwarmMember(m, sessionId))
            .filter((m): m is MeshSwarmMember => m !== null)
        : undefined;
      const boardSource = Array.isArray(snap.board ?? snap.messages)
        ? ((snap.board ?? snap.messages) as unknown[])
        : Array.isArray(nestedSwarm?.board)
          ? (nestedSwarm.board as unknown[])
          : undefined;
      const nextBoard = boardSource
        ? boardSource
            .map((m) => normalizeBoardMessage(m, sessionId))
            .filter((m): m is MeshBoardMessage => m !== null)
            .sort((a, b) => a.seq - b.seq)
        : undefined;
      const nextThreads = Array.isArray(snap.threads)
        ? snap.threads
            .map((t) => normalizeThread(t, sessionId))
            .filter((t): t is MeshExternalThread => t !== null)
        : undefined;
      const nextCheckpoints = Array.isArray(snap.checkpoints)
        ? snap.checkpoints
            .map((c) => normalizeCheckpoint(c, sessionId))
            .filter((c): c is MeshCheckpointRecord => c !== null)
            .sort((a, b) => b.turnSeq - a.turnSeq || b.createdAt - a.createdAt)
        : undefined;
      const nextLeases = Array.isArray(snap.fileLeases ?? snap.leases)
        ? ((snap.fileLeases ?? snap.leases) as unknown[])
            .map((l, idx) => normalizeFileLease(l, idx))
            .filter((l): l is MeshFileLease => l !== null)
        : undefined;
      const nextAgents = Array.isArray(snap.agents)
        ? mergeAgentCatalog(
            snap.agents
              .map(normalizeAgentInfo)
              .filter((a): a is MeshAgentInfo => a !== null),
          )
        : undefined;
      const nextTemplates = Array.isArray(snap.customTemplates)
        ? snap.customTemplates
            .map(normalizeCustomTemplate)
            .filter((t): t is MeshCustomCliTemplate => t !== null)
        : undefined;
      const rootPath =
        typeof snap.rootPath === 'string'
          ? snap.rootPath
          : asRecord(snap.workspaceBinding)?.rootPath
            ? String(asRecord(snap.workspaceBinding)!.rootPath)
            : undefined;

      return {
        ...(nextAgents ? { agents: nextAgents } : {}),
        ...(nextTemplates ? { customTemplates: nextTemplates } : {}),
        workspaceBindings:
          rootPath !== undefined
            ? { ...state.workspaceBindings, [sessionId]: rootPath }
            : state.workspaceBindings,
        swarmBySession: nextSwarm
          ? { ...state.swarmBySession, [sessionId]: nextSwarm }
          : state.swarmBySession,
        membersBySession: nextMembers
          ? { ...state.membersBySession, [sessionId]: nextMembers }
          : state.membersBySession,
        boardBySession: nextBoard
          ? { ...state.boardBySession, [sessionId]: nextBoard }
          : state.boardBySession,
        threadsBySession: nextThreads
          ? { ...state.threadsBySession, [sessionId]: nextThreads }
          : state.threadsBySession,
        checkpointsBySession: nextCheckpoints
          ? { ...state.checkpointsBySession, [sessionId]: nextCheckpoints }
          : state.checkpointsBySession,
        leasesBySession: nextLeases
          ? { ...state.leasesBySession, [sessionId]: nextLeases }
          : state.leasesBySession,
      };
    });
  },

  probeDetectedAgents: async (forceRefresh = false) => {
    set({ probing: true });
    try {
      const raw = await activeHostAdapter?.probeAgents?.({ forceRefresh });
      const listRaw = Array.isArray(raw)
        ? raw
        : Array.isArray(asRecord(raw)?.agents)
          ? (asRecord(raw)!.agents as unknown[])
          : null;
      const templatesRaw = Array.isArray(asRecord(raw)?.customTemplates)
        ? (asRecord(raw)!.customTemplates as unknown[])
        : null;
      if (listRaw) {
        const normalized = listRaw
          .map(normalizeAgentInfo)
          .filter((a): a is MeshAgentInfo => a !== null);
        const merged = mergeAgentCatalog(normalized);
        set((state) => ({
          agents: merged,
          customTemplates: templatesRaw
            ? templatesRaw
                .map(normalizeCustomTemplate)
                .filter((t): t is MeshCustomCliTemplate => t !== null)
            : state.customTemplates,
          probing: false,
          lastProbedAt: Date.now(),
        }));
        return merged;
      }
      set({ probing: false, lastProbedAt: Date.now() });
      return get().agents;
    } catch {
      set({ probing: false });
      return get().agents;
    }
  },

  bindWorkspacePath: async (chatSessionId, rootPath) => {
    const trimmed = rootPath.trim();
    const prevBindings = get().workspaceBindings;
    set((state) => ({
      workspaceBindings: { ...state.workspaceBindings, [chatSessionId]: trimmed },
    }));
    try {
      await activeHostAdapter?.setWorkspaceBinding?.({ chatSessionId, rootPath: trimmed });
    } catch (err) {
      set({ workspaceBindings: prevBindings });
      throw err;
    }
  },

  refreshSessionSnapshot: async (chatSessionId) => {
    if (!chatSessionId || !activeHostAdapter?.getSessionSnapshot) return;
    try {
      const snap = await activeHostAdapter.getSessionSnapshot({ chatSessionId });
      if (snap) {
        get().applySessionSnapshot(chatSessionId, snap);
      }
    } catch {
      // Non-fatal in disconnected / test environments.
    }
  },

  initializeSwarm: async ({ chatSessionId, goal = '', title, initialMembers }) => {
    const state = get();
    const now = Date.now();
    const maxHops = state.safetyPreferences.maxAutonomousHops;
    const readyExternal = state.agents
      .filter((a) => a.id !== 'deepstudent' && a.available)
      .map((a) => a.id);
    const chosenIds =
      initialMembers && initialMembers.length > 0
        ? initialMembers
        : ['deepstudent', ...(readyExternal.length > 0 ? readyExternal.slice(0, 2) : ['claude', 'codex'])];
    const uniqueIds = Array.from(new Set(['deepstudent', ...chosenIds]));

    const optimisticSession: MeshSwarmSession = {
      chatSessionId,
      title: title?.trim() || (goal.trim() ? goal.trim().slice(0, 36) : '异构蜂群协作'),
      goal: goal.trim(),
      status: 'active',
      coordinatorAgent: 'deepstudent',
      autonomousHops: 0,
      maxAutonomousHops: maxHops,
      headSeq: goal.trim() ? 1 : 0,
      circuitBreakerTripped: false,
      createdAt: now,
      updatedAt: now,
    };

    const optimisticMembers: MeshSwarmMember[] = uniqueIds.map((id) => {
      const agent = state.agents.find((a) => a.id === id);
      return {
        chatSessionId,
        rosterName: id,
        agentId: id,
        roleTitle: id === 'deepstudent' ? '协调者' : (agent?.roleHint ?? '协作代理'),
        status: goal.trim() && id === 'deepstudent' ? 'working' : 'parked',
        currentActivity: goal.trim() && id === 'deepstudent' ? '拆解蜂群任务' : null,
        lastSeenSeq: 0,
        ownedGlobs: [],
        humanControlled: false,
        activeChildCount: 0,
        activeBgTaskCount: 0,
      };
    });

    const initialMessages: MeshBoardMessage[] = goal.trim()
      ? [
          {
            seq: 1,
            chatSessionId,
            sender: 'human',
            senderKind: 'human',
            priority: 'task',
            text: goal.trim(),
            mentions: parseMentionsFromText(goal.trim()),
            createdAt: now,
          },
        ]
      : [];

    const prevSnapshot = {
      activeSessionId: state.activeSessionId,
      swarmBySession: state.swarmBySession,
      membersBySession: state.membersBySession,
      boardBySession: state.boardBySession,
    };

    set((prev) => ({
      activeSessionId: chatSessionId,
      swarmBySession: { ...prev.swarmBySession, [chatSessionId]: optimisticSession },
      membersBySession: {
        ...prev.membersBySession,
        [chatSessionId]: prev.membersBySession[chatSessionId]?.length
          ? prev.membersBySession[chatSessionId]!
          : optimisticMembers,
      },
      boardBySession: {
        ...prev.boardBySession,
        [chatSessionId]: prev.boardBySession[chatSessionId]?.length
          ? prev.boardBySession[chatSessionId]!
          : initialMessages,
      },
    }));

    const req: MeshSwarmControlInput = {
      action: 'init',
      chatSessionId,
      title: optimisticSession.title,
      goal: optimisticSession.goal,
      coordinatorAgent: 'deepstudent',
      maxAutonomousHops: maxHops,
    };
    try {
      const resp = await activeHostAdapter?.swarmControl?.(req);
      if (resp) {
        get().applySessionSnapshot(chatSessionId, resp);
      }
    } catch (err) {
      set(prevSnapshot);
      throw err;
    }
  },

  toggleSwarmPause: async (chatSessionId) => {
    const current = get().swarmBySession[chatSessionId];
    if (!current) return;
    const prevSwarms = get().swarmBySession;
    const nextAction = current.status === 'paused' ? 'resume' : 'pause';
    const nextStatus = nextAction === 'pause' ? 'paused' : 'active';
    set((state) => ({
      swarmBySession: {
        ...state.swarmBySession,
        [chatSessionId]: {
          ...current,
          status: nextStatus,
          circuitBreakerTripped: nextAction === 'resume' ? false : current.circuitBreakerTripped,
          updatedAt: Date.now(),
        },
      },
    }));
    try {
      const resp = await activeHostAdapter?.swarmControl?.({
        action: nextAction,
        chatSessionId,
      });
      if (resp) get().applySessionSnapshot(chatSessionId, resp);
    } catch (err) {
      set({ swarmBySession: prevSwarms });
      throw err;
    }
  },

  resumeCircuitBreaker: async (chatSessionId, extraHops = 12) => {
    const current = get().swarmBySession[chatSessionId];
    if (!current) return;
    const prevSwarms = get().swarmBySession;
    const nextMax = Math.max(current.maxAutonomousHops, current.autonomousHops + extraHops);
    set((state) => ({
      swarmBySession: {
        ...state.swarmBySession,
        [chatSessionId]: {
          ...current,
          status: 'active',
          autonomousHops: 0,
          maxAutonomousHops: nextMax,
          circuitBreakerTripped: false,
          circuitBreakerReason: null,
          updatedAt: Date.now(),
        },
      },
    }));
    try {
      const resp = await activeHostAdapter?.swarmControl?.({
        action: 'reset_circuit_breaker',
        chatSessionId,
        maxAutonomousHops: nextMax,
      });
      if (resp) get().applySessionSnapshot(chatSessionId, resp);
    } catch (err) {
      set({ swarmBySession: prevSwarms });
      throw err;
    }
  },

  addSwarmMember: async ({ chatSessionId, agentId, rosterName, roleTitle, ownedGlobs = [] }) => {
    const cleanRoster = (rosterName?.trim() || agentId).replace(/^@/, '');
    const cleanAgent = agentId.replace(/^@/, '');
    const agentMeta = get().agents.find((a) => a.id === cleanAgent);
    const prevMembers = get().membersBySession;
    const newMember: MeshSwarmMember = {
      chatSessionId,
      rosterName: cleanRoster,
      agentId: cleanAgent,
      roleTitle: roleTitle?.trim() || agentMeta?.roleHint || '协作代理',
      status: 'parked',
      lastSeenSeq: get().swarmBySession[chatSessionId]?.headSeq ?? 0,
      ownedGlobs,
      humanControlled: false,
      activeChildCount: 0,
      activeBgTaskCount: 0,
    };
    set((state) => {
      const existing = state.membersBySession[chatSessionId] ?? [];
      const filtered = existing.filter((m) => m.rosterName !== cleanRoster);
      return {
        membersBySession: {
          ...state.membersBySession,
          [chatSessionId]: [...filtered, newMember],
        },
      };
    });
    try {
      const resp = await activeHostAdapter?.swarmControl?.({
        action: 'add_member',
        chatSessionId,
        rosterName: cleanRoster,
        agentId: cleanAgent,
        roleTitle: newMember.roleTitle,
        ownedGlobs,
      });
      if (resp) get().applySessionSnapshot(chatSessionId, resp);
    } catch (err) {
      set({ membersBySession: prevMembers });
      throw err;
    }
  },

  postBoardMessage: async ({ chatSessionId, text, priority = 'correction', mentions }) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const prevBoard = get().boardBySession;
    const prevSwarms = get().swarmBySession;
    const parsedMentions = mentions ?? parseMentionsFromText(trimmed);
    const currentBoard = get().boardBySession[chatSessionId] ?? [];
    const nextSeq = (currentBoard[currentBoard.length - 1]?.seq ?? get().swarmBySession[chatSessionId]?.headSeq ?? 0) + 1;
    const optimisticMsg: MeshBoardMessage = {
      seq: nextSeq,
      chatSessionId,
      sender: 'human',
      senderKind: 'human',
      priority,
      text: trimmed,
      mentions: parsedMentions,
      createdAt: Date.now(),
    };
    set((state) => {
      const swarm = state.swarmBySession[chatSessionId];
      return {
        boardBySession: {
          ...state.boardBySession,
          [chatSessionId]: [...(state.boardBySession[chatSessionId] ?? []), optimisticMsg],
        },
        swarmBySession: swarm
          ? {
              ...state.swarmBySession,
              [chatSessionId]: {
                ...swarm,
                headSeq: Math.max(swarm.headSeq, nextSeq),
                autonomousHops: 0,
                circuitBreakerTripped: false,
                status: swarm.circuitBreakerTripped ? 'active' : swarm.status,
                updatedAt: Date.now(),
              },
            }
          : state.swarmBySession,
      };
    });
    try {
      const resp = await activeHostAdapter?.swarmControl?.({
        action: 'post_message',
        chatSessionId,
        sender: 'human',
        senderKind: 'human',
        priority,
        text: trimmed,
        mentions: parsedMentions,
      });
      if (resp) get().applySessionSnapshot(chatSessionId, resp);
    } catch (err) {
      set({ boardBySession: prevBoard, swarmBySession: prevSwarms });
      throw err;
    }
  },

  steerMember: async ({ chatSessionId, rosterName, threadId, prompt }) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const cleanRoster = rosterName.replace(/^@/, '');
    const state = get();
    const resolvedThread =
      (state.threadsBySession[chatSessionId] ?? []).find(
        (t) => (threadId && t.threadId === threadId) || t.rosterName === cleanRoster || t.agentId === cleanRoster,
      ) ?? null;

    if (resolvedThread && activeHostAdapter?.steerTurn) {
      await activeHostAdapter.steerTurn({
        chatSessionId,
        threadId: resolvedThread.threadId,
        prompt: trimmed,
        priority: 'correction',
      });
    } else if (activeHostAdapter?.startTurn) {
      const member = (state.membersBySession[chatSessionId] ?? []).find((m) => m.rosterName === cleanRoster);
      await activeHostAdapter.startTurn({
        chatSessionId,
        agentId: member?.agentId ?? cleanRoster,
        rosterName: cleanRoster,
        prompt: trimmed,
        cwd: state.workspaceBindings[chatSessionId],
      });
    }

    await get().postBoardMessage({
      chatSessionId,
      text: trimmed.startsWith(`@${cleanRoster}`) ? trimmed : `@${cleanRoster} ${trimmed}`,
      priority: 'correction',
      mentions: [cleanRoster],
    });
  },

  interruptMember: async ({ chatSessionId, rosterName, threadId, reason = 'user_interrupt' }) => {
    const cleanRoster = rosterName.replace(/^@/, '');
    const state = get();
    const prevMembers = state.membersBySession;
    const prevThreads = state.threadsBySession;
    const resolvedThread = (state.threadsBySession[chatSessionId] ?? []).find(
      (t) => (threadId && t.threadId === threadId) || t.rosterName === cleanRoster || t.agentId === cleanRoster,
    );
    set((prev) => ({
      membersBySession: {
        ...prev.membersBySession,
        [chatSessionId]: (prev.membersBySession[chatSessionId] ?? []).map((m) =>
          m.rosterName === cleanRoster
            ? { ...m, status: 'stopped', activeChildCount: 0, activeBgTaskCount: 0, currentActivity: null }
            : m,
        ),
      },
      threadsBySession: {
        ...prev.threadsBySession,
        [chatSessionId]: (prev.threadsBySession[chatSessionId] ?? []).map((t) =>
          t.threadId === resolvedThread?.threadId || t.rosterName === cleanRoster
            ? { ...t, status: 'stopped', childSubagents: [], activeBgTasks: [] }
            : t,
        ),
      },
    }));
    if (resolvedThread?.threadId) {
      try {
        await activeHostAdapter?.interruptTurn?.({
          chatSessionId,
          threadId: resolvedThread.threadId,
          reason,
        });
      } catch (err) {
        set({ membersBySession: prevMembers, threadsBySession: prevThreads });
        throw err;
      }
    }
  },

  toggleHumanTakeover: async ({ chatSessionId, rosterName, threadId, humanControlled }) => {
    const cleanRoster = rosterName.replace(/^@/, '');
    const prevMembers = get().membersBySession;
    const prevThreads = get().threadsBySession;
    set((prev) => ({
      membersBySession: {
        ...prev.membersBySession,
        [chatSessionId]: (prev.membersBySession[chatSessionId] ?? []).map((m) =>
          m.rosterName === cleanRoster ? { ...m, humanControlled } : m,
        ),
      },
      threadsBySession: {
        ...prev.threadsBySession,
        [chatSessionId]: (prev.threadsBySession[chatSessionId] ?? []).map((t) =>
          (threadId && t.threadId === threadId) || t.rosterName === cleanRoster
            ? { ...t, humanControlled }
            : t,
        ),
      },
    }));
    try {
      await activeHostAdapter?.setHumanControlled?.({
        chatSessionId,
        rosterName: cleanRoster,
        threadId: threadId ?? undefined,
        humanControlled,
      });
    } catch (err) {
      set({ membersBySession: prevMembers, threadsBySession: prevThreads });
      throw err;
    }
  },

  handoffMemberToCli: async ({ chatSessionId, fromRosterName, targetAgentId, summary, nextTask }) => {
    const cleanFrom = fromRosterName.replace(/^@/, '');
    const cleanTarget = targetAgentId.replace(/^@/, '');
    const handoffSummary = summary?.trim() || `承接 @${cleanFrom} 的上下文与最近文件改动继续推进`;
    const prevMembers = get().membersBySession;
    set((prev) => {
      const existing = prev.membersBySession[chatSessionId] ?? [];
      const hasTarget = existing.some((m) => m.rosterName === cleanTarget || m.agentId === cleanTarget);
      const updated = existing.map((m) =>
        m.rosterName === cleanFrom ? { ...m, status: 'parked' as const, humanControlled: false, ownedGlobs: [] } : m,
      );
      if (!hasTarget) {
        updated.push({
          chatSessionId,
          rosterName: cleanTarget,
          agentId: cleanTarget,
          roleTitle: `接替 @${cleanFrom}`,
          status: 'working',
          currentActivity: nextTask?.trim() || '接棒处理中',
          lastSeenSeq: prev.swarmBySession[chatSessionId]?.headSeq ?? 0,
          ownedGlobs: [],
          humanControlled: false,
          activeChildCount: 0,
          activeBgTaskCount: 0,
        });
      }
      return {
        membersBySession: { ...prev.membersBySession, [chatSessionId]: updated },
      };
    });

    try {
      const resp = await activeHostAdapter?.swarmControl?.({
        action: 'handoff_member',
        chatSessionId,
        rosterName: cleanFrom,
        targetAgentId: cleanTarget,
        summary: handoffSummary,
        nextTask: nextTask?.trim() || handoffSummary,
      });
      if (resp) get().applySessionSnapshot(chatSessionId, resp);
    } catch (err) {
      set({ membersBySession: prevMembers });
      throw err;
    }
  },

  respondThreadApproval: async ({ chatSessionId, threadId, requestId, decision, note }) => {
    const prevThreads = get().threadsBySession;
    const prevMembers = get().membersBySession;
    set((prev) => ({
      threadsBySession: {
        ...prev.threadsBySession,
        [chatSessionId]: (prev.threadsBySession[chatSessionId] ?? []).map((t) =>
          t.threadId === threadId
            ? {
                ...t,
                pendingApproval: null,
                status: decision === 'deny' ? 'stopped' : 'running',
              }
            : t,
        ),
      },
      membersBySession: {
        ...prev.membersBySession,
        [chatSessionId]: (prev.membersBySession[chatSessionId] ?? []).map((m) =>
          m.threadId === threadId && m.status === 'waiting_approval'
            ? { ...m, status: decision === 'deny' ? 'stopped' : 'working' }
            : m,
        ),
      },
    }));
    try {
      await activeHostAdapter?.respondApproval?.({
        chatSessionId,
        threadId,
        requestId,
        decision,
        note,
      });
    } catch (err) {
      set({ threadsBySession: prevThreads, membersBySession: prevMembers });
      throw err;
    }
  },

  loadCheckpointDiff: async ({ chatSessionId, checkpointId, rootPath }) => {
    const raw = await activeHostAdapter?.getCheckpointDiff?.({
      chatSessionId,
      checkpointId,
      rootPath: rootPath ?? get().workspaceBindings[chatSessionId],
    });
    const r = asRecord(raw);
    const filesRaw = Array.isArray(r?.files) ? r!.files : Array.isArray(raw) ? raw : [];
    const existingCp = (get().checkpointsBySession[chatSessionId] ?? []).find(
      (c) => c.checkpointId === checkpointId,
    );
    const files = filesRaw
      .map((f) => normalizeFileDiff(f, existingCp?.agentId, checkpointId, existingCp?.turnSeq))
      .filter((f): f is MeshFileDiffEntry => f !== null);
    if (files.length > 0) {
      set((prev) => ({
        checkpointsBySession: {
          ...prev.checkpointsBySession,
          [chatSessionId]: (prev.checkpointsBySession[chatSessionId] ?? []).map((c) =>
            c.checkpointId === checkpointId ? { ...c, files, filesChanged: files.length } : c,
          ),
        },
      }));
    }
    return files;
  },

  revertCheckpointInPlace: async ({
    chatSessionId,
    checkpointId,
    paths,
    forceOverwriteUserEdits = false,
    rootPath,
  }) => {
    const raw = await activeHostAdapter?.revertCheckpoint?.({
      chatSessionId,
      checkpointId,
      paths,
      forceOverwriteUserEdits,
      rootPath: rootPath ?? get().workspaceBindings[chatSessionId],
    });
    const r = asRecord(raw);
    const revertedPaths = Array.isArray(r?.revertedPaths)
      ? r!.revertedPaths.map(String)
      : paths ?? [];
    const skippedUserModifiedPaths = Array.isArray(r?.skippedUserModifiedPaths)
      ? r!.skippedUserModifiedPaths.map(String)
      : [];

    if (skippedUserModifiedPaths.length === 0) {
      set((prev) => ({
        checkpointsBySession: {
          ...prev.checkpointsBySession,
          [chatSessionId]: (prev.checkpointsBySession[chatSessionId] ?? []).map((cp) => {
            if (cp.checkpointId !== checkpointId) return cp;
            if (!paths || paths.length === 0) {
              return { ...cp, files: [], filesChanged: 0, additions: 0, deletions: 0 };
            }
            const remaining = cp.files.filter((f) => !paths.includes(f.path));
            return {
              ...cp,
              files: remaining,
              filesChanged: remaining.length,
              additions: remaining.reduce((acc, f) => acc + f.additions, 0),
              deletions: remaining.reduce((acc, f) => acc + f.deletions, 0),
            };
          }),
        },
      }));
    }

    return { revertedPaths, skippedUserModifiedPaths };
  },

  dispatchSummaryToDeepStudent: ({ chatSessionId, mode, files, agents }) => {
    const agentLabels = agents.length > 0 ? agents.map((a) => `@${a.replace(/^@/, '')}`).join('、') : '外部编程 CLI';
    const filePreview = files.slice(0, 6).join('、') + (files.length > 6 ? ` 等 ${files.length} 个文件` : '');
    const prompt =
      mode === 'flashcards'
        ? `请结合刚才 ${agentLabels} 在当前会话修改的代码（${filePreview || '最近 Checkpoint 变更'}），提炼核心设计原理、易错边界与知识点，整理进我的学习笔记并生成 3-5 张高质量复习闪卡。`
        : `请帮我深入讲透刚才 ${agentLabels} 完成的代码改动（${filePreview || '最近 Checkpoint 变更'}）：梳理核心架构思路、关键实现细节与潜在边界情况，并总结成结构化学习笔记。`;

    if (chatSessionId) {
      dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_SESSION, { sessionId: chatSessionId });
    }
    dispatchAppEvent(APP_EVENTS.CHAT_V2_SET_INPUT, { content: prompt, autoSend: false });
    dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, { content: prompt, autoSend: false });
    get().closeWorkbench();
  },

  emergencyStopAllExternal: async (reason = 'user_emergency_stop') => {
    const state = get();
    const activeThreads: MeshExternalThread[] = [];
    for (const list of Object.values(state.threadsBySession)) {
      for (const t of list) {
        if (t.status === 'running' || t.status === 'waiting_children' || t.status === 'waiting_approval') {
          activeThreads.push(t);
        }
      }
    }

    // Optimistically mark all active external threads & active swarms stopped/paused
    set((prev) => {
      const nextThreads: Record<string, MeshExternalThread[]> = {};
      for (const [sid, list] of Object.entries(prev.threadsBySession)) {
        nextThreads[sid] = list.map((t) =>
          t.status === 'running' || t.status === 'waiting_children' || t.status === 'waiting_approval'
            ? { ...t, status: 'stopped', childSubagents: [], activeBgTasks: [], pendingApproval: null }
            : t,
        );
      }
      const nextMembers: Record<string, MeshSwarmMember[]> = {};
      for (const [sid, list] of Object.entries(prev.membersBySession)) {
        nextMembers[sid] = list.map((m) =>
          m.status === 'working' || m.status === 'waiting_children' || m.status === 'waiting_approval'
            ? { ...m, status: 'stopped', activeChildCount: 0, activeBgTaskCount: 0, currentActivity: null }
            : m,
        );
      }
      const nextSwarms: Record<string, MeshSwarmSession> = {};
      for (const [sid, sw] of Object.entries(prev.swarmBySession)) {
        nextSwarms[sid] = sw.status === 'active' ? { ...sw, status: 'paused', updatedAt: Date.now() } : sw;
      }
      return {
        threadsBySession: nextThreads,
        membersBySession: nextMembers,
        swarmBySession: nextSwarms,
      };
    });

    await Promise.allSettled([
      ...activeThreads.map((t) =>
        activeHostAdapter?.interruptTurn?.({
          chatSessionId: t.chatSessionId,
          threadId: t.threadId,
          reason,
        }),
      ),
      ...Object.keys(state.swarmBySession).map((chatSessionId) =>
        activeHostAdapter?.swarmControl?.({
          action: 'emergency_stop_all',
          chatSessionId,
        }),
      ),
    ]);

    return activeThreads.length;
  },

  saveCustomTemplate: async (template) => {
    const cleanId = template.id.trim().replace(/^@/, '');
    const prevTemplates = get().customTemplates;
    const prevAgents = get().agents;
    const normalized: MeshCustomCliTemplate = {
      ...template,
      id: cleanId,
      handle: template.handle?.startsWith('@') ? template.handle : `@${cleanId}`,
      updatedAt: Date.now(),
    };
    set((prev) => {
      const others = prev.customTemplates.filter((t) => t.id !== cleanId);
      const customAgent: MeshAgentInfo = {
        id: cleanId,
        driver: 'custom',
        name: normalized.name,
        handle: normalized.handle!,
        available: true,
        binaryPath: normalized.command,
        roleHint: '自定义外部 CLI',
        capabilities: BASIC_CLI_CAPABILITIES,
      };
      return {
        customTemplates: [...others, normalized],
        agents: mergeAgentCatalog([...prev.agents, customAgent]),
      };
    });
    try {
      await activeHostAdapter?.saveCustomCliTemplate?.(normalized);
    } catch (err) {
      set({ customTemplates: prevTemplates, agents: prevAgents });
      throw err;
    }
  },

  removeCustomTemplate: async (id) => {
    const cleanId = id.trim().replace(/^@/, '');
    const prevTemplates = get().customTemplates;
    const prevAgents = get().agents;
    set((prev) => ({
      customTemplates: prev.customTemplates.filter((t) => t.id !== cleanId),
      agents: prev.agents.filter((a) => !(a.driver === 'custom' && a.id === cleanId)),
    }));
    try {
      await activeHostAdapter?.deleteCustomCliTemplate?.({ id: cleanId });
    } catch (err) {
      set({ customTemplates: prevTemplates, agents: prevAgents });
      throw err;
    }
  },

  saveCliOverride: async (input) => {
    const cleanId = input.agentId.trim().replace(/^@/, '').toLowerCase();
    if (!cleanId) return;
    const prevAgents = get().agents;
    const cleanPath = typeof input.executablePath === 'string' ? input.executablePath.trim() : '';
    const cleanArgs = (input.extraArgs ?? []).map((arg) => arg.trim()).filter(Boolean);
    set((prev) => ({
      agents: prev.agents.map((agent) =>
        agent.id === cleanId
          ? {
              ...agent,
              customExecutablePath: cleanPath || null,
              extraArgs: cleanArgs,
              ...(cleanPath ? { binaryPath: cleanPath } : {}),
            }
          : agent,
      ),
    }));
    if (activeHostAdapter?.saveCliOverride) {
      try {
        await activeHostAdapter.saveCliOverride({
          agentId: cleanId,
          executablePath: cleanPath || null,
          extraArgs: cleanArgs,
          ...(input.env ? { env: input.env } : {}),
        });
      } catch (err) {
        set({ agents: prevAgents });
        throw err;
      }
      await get().probeDetectedAgents(true);
    }
  },

  resetCliOverride: async (agentId) => {
    const cleanId = agentId.trim().replace(/^@/, '').toLowerCase();
    if (!cleanId) return;
    const prevAgents = get().agents;
    set((prev) => ({
      agents: prev.agents.map((agent) =>
        agent.id === cleanId
          ? {
              ...agent,
              customExecutablePath: null,
              extraArgs: [],
              probeError: null,
            }
          : agent,
      ),
    }));
    if (activeHostAdapter?.deleteCliOverride) {
      try {
        await activeHostAdapter.deleteCliOverride({ agentId: cleanId });
      } catch (err) {
        set({ agents: prevAgents });
        throw err;
      }
      await get().probeDetectedAgents(true);
    }
  },

  resetStoreForTests: () => {
    set({
      agents: mergeAgentCatalog([]),
      customTemplates: [],
      probing: false,
      lastProbedAt: null,
      safetyPreferences: loadInitialSafetyPreferences(),
      workspaceBindings: {},
      swarmBySession: {},
      membersBySession: {},
      boardBySession: {},
      threadsBySession: {},
      checkpointsBySession: {},
      leasesBySession: {},
      peerExchangesBySession: {},
      activeSessionId: null,
      workbench: { ...INITIAL_WORKBENCH_STATE },
    });
  },
}));

// ------------------------------------------------------------------ Backend Push Event Sink

export function pushMeshWorkbenchEvent(rawEvent: unknown): void {
  const evt = asRecord(rawEvent);
  if (!evt) return;
  const kind = String(evt.type ?? evt.kind ?? evt.event ?? '');
  const sessionId = String(
    evt.chatSessionId ?? evt.chat_session_id ?? evt.sessionId ?? useAgentMeshWorkbenchStore.getState().activeSessionId ?? '',
  ).trim();

  if (kind === 'agents_probed' && Array.isArray(evt.agents)) {
    const normalized = evt.agents.map(normalizeAgentInfo).filter((a): a is MeshAgentInfo => a !== null);
    useAgentMeshWorkbenchStore.setState({
      agents: mergeAgentCatalog(normalized),
      lastProbedAt: Date.now(),
    });
    return;
  }

  if (kind === 'templates_updated' && Array.isArray(evt.templates)) {
    const templates = evt.templates
      .map(normalizeCustomTemplate)
      .filter((t): t is MeshCustomCliTemplate => t !== null);
    useAgentMeshWorkbenchStore.setState({ customTemplates: templates });
    return;
  }

  if ((kind === 'leases_updated' || kind === 'file_leases_updated') && Array.isArray(evt.leases ?? evt.fileLeases)) {
    const rawLeases = (evt.leases ?? evt.fileLeases) as unknown[];
    const leases = rawLeases
      .map((l, idx) => normalizeFileLease(l, idx))
      .filter((l): l is MeshFileLease => l !== null);
    const rootPath = typeof evt.rootPath === 'string' ? evt.rootPath : '';
    useAgentMeshWorkbenchStore.setState((state) => {
      const targetSessions = new Set<string>();
      if (sessionId) targetSessions.add(sessionId);
      if (rootPath) {
        for (const [sid, boundRoot] of Object.entries(state.workspaceBindings)) {
          if (boundRoot === rootPath) targetSessions.add(sid);
        }
      }
      if (targetSessions.size === 0) return state;
      const nextLeases = { ...state.leasesBySession };
      for (const sid of targetSessions) {
        nextLeases[sid] = leases;
      }
      return { leasesBySession: nextLeases };
    });
    return;
  }

  if (kind === 'session_snapshot' && sessionId) {
    useAgentMeshWorkbenchStore.getState().applySessionSnapshot(sessionId, evt.snapshot ?? evt);
    return;
  }

  if (!sessionId) return;

  if (kind === 'workspace_bound') {
    const bindingRec = asRecord(evt.binding);
    const rootPath = typeof bindingRec?.rootPath === 'string' ? bindingRec.rootPath : '';
    useAgentMeshWorkbenchStore.setState((state) => {
      const next = { ...state.workspaceBindings };
      if (rootPath) next[sessionId] = rootPath;
      else delete next[sessionId];
      return { workspaceBindings: next };
    });
    return;
  }

  if (kind === 'swarm_circuit_breaker') {
    useAgentMeshWorkbenchStore.setState((state) => {
      const existing = state.swarmBySession[sessionId];
      const autonomousHops = Number(evt.autonomousHops ?? evt.autonomous_hops ?? existing?.autonomousHops ?? 12);
      const maxAutonomousHops = Number(evt.maxAutonomousHops ?? evt.max_autonomous_hops ?? existing?.maxAutonomousHops ?? 12);
      return {
        swarmBySession: {
          ...state.swarmBySession,
          [sessionId]: {
            chatSessionId: sessionId,
            title: existing?.title ?? '异构蜂群协作',
            goal: existing?.goal ?? '',
            status: 'paused',
            coordinatorAgent: existing?.coordinatorAgent ?? 'deepstudent',
            autonomousHops,
            maxAutonomousHops,
            headSeq: existing?.headSeq ?? 0,
            circuitBreakerTripped: true,
            circuitBreakerReason:
              typeof evt.reason === 'string'
                ? evt.reason
                : `连续自治唤醒已达上限 (${autonomousHops}/${maxAutonomousHops})，等待人类确认`,
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          },
        },
      };
    });
    return;
  }

  if (kind === 'swarm_updated' || evt.swarm) {
    const swarmObj = asRecord(evt.swarm);
    const rawSession = asRecord(swarmObj?.session) ?? swarmObj ?? evt;
    const sw = normalizeSwarmSession(rawSession, sessionId);
    if (sw) {
      useAgentMeshWorkbenchStore.setState((state) => ({
        swarmBySession: { ...state.swarmBySession, [sessionId]: sw },
      }));
    }
    const membersSource = Array.isArray(evt.members)
      ? evt.members
      : Array.isArray(swarmObj?.members)
        ? swarmObj.members
        : null;
    if (membersSource) {
      const members = membersSource
        .map((m) => normalizeSwarmMember(m, sessionId))
        .filter((m): m is MeshSwarmMember => m !== null);
      useAgentMeshWorkbenchStore.setState((state) => ({
        membersBySession: { ...state.membersBySession, [sessionId]: members },
      }));
    }
    const boardSource = Array.isArray(swarmObj?.board) ? swarmObj.board : null;
    if (boardSource) {
      const board = boardSource
        .map((b) => normalizeBoardMessage(b, sessionId))
        .filter((b): b is MeshBoardMessage => b !== null)
        .sort((a, b) => a.seq - b.seq);
      useAgentMeshWorkbenchStore.setState((state) => ({
        boardBySession: { ...state.boardBySession, [sessionId]: board },
      }));
    }
    return;
  }

  if (kind === 'member_updated' || evt.member) {
    const member = normalizeSwarmMember(evt.member ?? evt, sessionId);
    if (member) {
      useAgentMeshWorkbenchStore.setState((state) => {
        const list = state.membersBySession[sessionId] ?? [];
        const idx = list.findIndex((m) => m.rosterName === member.rosterName);
        const next = idx >= 0 ? list.map((m, i) => (i === idx ? member : m)) : [...list, member];
        return {
          membersBySession: { ...state.membersBySession, [sessionId]: next },
        };
      });
    }
    return;
  }

  if (kind === 'board_message' || kind === 'swarm_board_post' || evt.message) {
    const msg = normalizeBoardMessage(evt.message ?? evt, sessionId);
    if (msg) {
      useAgentMeshWorkbenchStore.setState((state) => {
        const list = state.boardBySession[sessionId] ?? [];
        const exists = list.some((m) => m.seq === msg.seq);
        const next = exists ? list.map((m) => (m.seq === msg.seq ? msg : m)) : [...list, msg].sort((a, b) => a.seq - b.seq);
        const sw = state.swarmBySession[sessionId];
        return {
          boardBySession: { ...state.boardBySession, [sessionId]: next },
          swarmBySession: sw
            ? { ...state.swarmBySession, [sessionId]: { ...sw, headSeq: Math.max(sw.headSeq, msg.seq) } }
            : state.swarmBySession,
        };
      });
    }
    return;
  }

  if (kind === 'thread_delta' && typeof evt.threadId === 'string' && typeof evt.text === 'string') {
    const targetThreadId = evt.threadId;
    const deltaText = evt.text;
    const isThinking = evt.deltaKind === 'thinking';
    useAgentMeshWorkbenchStore.setState((state) => {
      const list = state.threadsBySession[sessionId] ?? [];
      if (!list.some((t) => t.threadId === targetThreadId)) return state;
      return {
        threadsBySession: {
          ...state.threadsBySession,
          [sessionId]: list.map((t) =>
            t.threadId === targetThreadId
              ? {
                  ...t,
                  streamingText: isThinking ? t.streamingText : t.streamingText + deltaText,
                  thinkingText: isThinking ? (t.thinkingText ?? '') + deltaText : t.thinkingText,
                  updatedAt: Date.now(),
                }
              : t,
          ),
        },
      };
    });
    return;
  }

  if (kind === 'thread_updated' || kind === 'thread_upserted' || kind === 'turn_started' || evt.thread) {
    const thread = normalizeThread(evt.thread ?? evt, sessionId);
    if (thread) {
      useAgentMeshWorkbenchStore.setState((state) => {
        const list = state.threadsBySession[sessionId] ?? [];
        const idx = list.findIndex((t) => t.threadId === thread.threadId);
        const next = idx >= 0 ? list.map((t, i) => (i === idx ? thread : t)) : [...list, thread];
        return {
          threadsBySession: { ...state.threadsBySession, [sessionId]: next },
        };
      });
    }
    return;
  }

  if (kind === 'checkpoint_created' || kind === 'checkpoint_captured' || evt.checkpoint) {
    const cp = normalizeCheckpoint(evt.checkpoint ?? evt, sessionId);
    if (cp) {
      useAgentMeshWorkbenchStore.setState((state) => {
        const list = state.checkpointsBySession[sessionId] ?? [];
        const filtered = list.filter((c) => c.checkpointId !== cp.checkpointId);
        return {
          checkpointsBySession: {
            ...state.checkpointsBySession,
            [sessionId]: [cp, ...filtered].sort((a, b) => b.turnSeq - a.turnSeq || b.createdAt - a.createdAt),
          },
        };
      });
    }
    return;
  }
}

// ------------------------------------------------------------------ Selectors

export function selectActiveExternalThreadCount(state: AgentMeshWorkbenchState): number {
  let count = 0;
  for (const list of Object.values(state.threadsBySession)) {
    for (const t of list) {
      if (t.status === 'running' || t.status === 'waiting_children' || t.status === 'waiting_approval') {
        count += 1;
      }
    }
  }
  return count;
}

export function selectPendingApprovalCount(state: AgentMeshWorkbenchState): number {
  let count = 0;
  for (const list of Object.values(state.threadsBySession)) {
    for (const t of list) {
      if (t.status === 'waiting_approval' || t.pendingApproval) {
        count += 1;
      }
    }
  }
  return count;
}
