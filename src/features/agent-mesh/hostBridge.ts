/**
 * DeepStudent Agent Mesh — Host RPC Bridge & Real-Time Event Projector
 *
 * Strictly zero direct Tauri `invoke(...)` calls (passes `migration:frontend-invoke`).
 * Official UI plugin (`dstu.agent-mesh`) injects its `ctx.ui.host.agentMesh` caller via
 * `registerAgentMeshHostBridge` / `registerAgentMeshHostCaller`.
 * Gracefully degrades to safe no-op / local state updates when unmounted (web demo, mobile, unit tests).
 */

import {
  normalizeAgentHandle,
  resolveAgentDisplayName,
  type AgentMeshBackendEvent,
  type AgentMeshHostBridge,
  type AgentMeshSessionSnapshot,
  type AskPeerRequest,
  type CustomCliTemplate,
  type DetectedMeshAgent,
  type GetCheckpointDiffRequest,
  type HandoffRequest,
  type InterruptExternalTurnRequest,
  type MeshAgentDriverKind,
  type MeshCheckpointRecord,
  type MeshChildSubagent,
  type MeshDiffFileEntry,
  type MeshDiffSummary,
  type MeshFileLease,
  type MeshPendingApproval,
  type MeshThreadState,
  type MeshThreadStatus,
  type MeshToolCallItem,
  type PeerExchangeRecord,
  type RespondApprovalRequest,
  type RevertCheckpointRequest,
  type RevertCheckpointResult,
  type SetHumanControlledRequest,
  type SetWorkspaceBindingRequest,
  type StartExternalTurnRequest,
  type SteerExternalTurnRequest,
  type SwarmBoardPost,
  type SwarmControlRequest,
  type SwarmMemberRecord,
  type SwarmSessionState,
  type WorkspaceBinding,
} from './types';
import { useAgentMeshStore } from './store/useAgentMeshStore';

export type GenericAgentMeshHostCaller = (
  method: keyof AgentMeshHostBridge,
  ...args: unknown[]
) => Promise<unknown>;

let activeBridge: AgentMeshHostBridge | null = null;
let optimisticThreadSeq = 0;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toEpochMs(raw: unknown, fallback = Date.now()): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function normalizeHostDetectedAgent(raw: unknown): DetectedMeshAgent | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = String(rec.id ?? rec.agentId ?? '').trim();
  if (!id) return null;
  const rawDriver = String(rec.driverKind ?? rec.kind ?? rec.driver ?? '').trim().toLowerCase();
  const driverKind: MeshAgentDriverKind =
    id === 'deepstudent' || rawDriver === 'deepstudent' || rawDriver === 'builtin'
      ? 'builtin'
      : rawDriver === 'claude' ||
          rawDriver === 'codex' ||
          rawDriver === 'opencode' ||
          rawDriver === 'pi' ||
          rawDriver === 'agy' ||
          rawDriver === 'dsh'
        ? rawDriver
        : 'custom';
  const displayName =
    typeof rec.displayName === 'string' && rec.displayName.trim()
      ? rec.displayName.trim()
      : typeof rec.name === 'string' && rec.name.trim()
        ? rec.name.trim()
        : resolveAgentDisplayName(id);
  const handle = normalizeAgentHandle(
    typeof rec.handle === 'string' && rec.handle.trim() ? rec.handle : id,
  );
  return {
    id,
    name: displayName,
    handle,
    driverKind,
    installed:
      driverKind === 'builtin'
        ? true
        : Boolean(rec.installed ?? rec.available ?? false),
    authenticated: rec.authenticated === undefined ? undefined : Boolean(rec.authenticated),
    version: typeof rec.version === 'string' ? rec.version : undefined,
    command: typeof rec.command === 'string' ? rec.command : undefined,
    executablePath:
      typeof rec.executablePath === 'string'
        ? rec.executablePath
        : typeof rec.binaryPath === 'string'
          ? rec.binaryPath
          : null,
    customExecutablePath:
      typeof rec.customExecutablePath === 'string' && rec.customExecutablePath.trim()
        ? rec.customExecutablePath.trim()
        : null,
    extraArgs: Array.isArray(rec.extraArgs)
      ? rec.extraArgs.map((item) => String(item).trim()).filter(Boolean)
      : undefined,
    probeError:
      typeof rec.probeError === 'string' && rec.probeError.trim()
        ? rec.probeError.trim()
        : null,
    defaultModel:
      typeof rec.defaultModel === 'string' && rec.defaultModel.trim()
        ? rec.defaultModel.trim()
        : null,
    availableModels: Array.isArray(rec.availableModels)
      ? rec.availableModels.map((item) => String(item).trim()).filter(Boolean)
      : undefined,
    status: rec.status as DetectedMeshAgent['status'],
    capabilities: (asRecord(rec.capabilities) ?? {}) as DetectedMeshAgent['capabilities'],
    aliases: Array.isArray(rec.aliases) ? rec.aliases.map(String) : undefined,
  };
}

function normalizeHostDiffSummary(raw: unknown): MeshDiffSummary | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const rawFiles = Array.isArray(rec.files) ? rec.files : undefined;
  const files: MeshDiffFileEntry[] | undefined = rawFiles?.map((item) => {
    const f = asRecord(item) ?? {};
    const statusRaw = String(f.status ?? 'modified');
    return {
      path: String(f.path ?? ''),
      status:
        statusRaw === 'added' || statusRaw === 'deleted' || statusRaw === 'renamed'
          ? statusRaw
          : 'modified',
      additions: Number(f.additions ?? 0) || 0,
      deletions: Number(f.deletions ?? 0) || 0,
      patch: typeof f.patch === 'string' ? f.patch : undefined,
      attributedAgentId: typeof f.attributedAgentId === 'string' ? f.attributedAgentId : undefined,
    };
  });
  return {
    filesChanged: Number(rec.filesChanged ?? files?.length ?? 0) || 0,
    totalAdditions: Number(rec.totalAdditions ?? rec.additions ?? 0) || 0,
    totalDeletions: Number(rec.totalDeletions ?? rec.deletions ?? 0) || 0,
    checkpointId: typeof rec.checkpointId === 'string' ? rec.checkpointId : undefined,
    ...(files ? { files } : {}),
  };
}

function normalizeHostThreadState(raw: unknown): MeshThreadState | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const threadId = String(rec.threadId ?? '').trim();
  const chatSessionId = String(rec.chatSessionId ?? '').trim();
  if (!threadId || !chatSessionId) return null;
  const agentId = String(rec.agentId ?? 'claude').trim();
  const now = Date.now();
  const childSubagents: MeshChildSubagent[] = Array.isArray(rec.childSubagents)
    ? rec.childSubagents.map((item, idx) => {
        const c = asRecord(item) ?? {};
        const childStatus = String(c.status ?? 'running');
        return {
          id: String(c.id ?? c.childId ?? `${threadId}-sub-${idx}`),
          parentToolUseId: typeof c.parentToolUseId === 'string' ? c.parentToolUseId : undefined,
          title: String(c.title ?? c.childId ?? 'Subagent'),
          status:
            childStatus === 'completed' || childStatus === 'failed' ? childStatus : 'running',
          startedAt: toEpochMs(c.startedAt, now),
          completedAt: c.completedAt !== undefined ? toEpochMs(c.completedAt, now) : undefined,
          summary: typeof c.summary === 'string' ? c.summary : undefined,
        };
      })
    : [];
  const toolCalls: MeshToolCallItem[] = Array.isArray(rec.toolCalls)
    ? rec.toolCalls.map((item, idx) => {
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
          summary:
            typeof tc.summary === 'string'
              ? tc.summary
              : typeof tc.targetPath === 'string'
                ? tc.targetPath
                : typeof tc.command === 'string'
                  ? tc.command
                  : undefined,
          startedAt: toEpochMs(tc.startedAt, now),
          completedAt: tc.completedAt !== undefined ? toEpochMs(tc.completedAt, now) : undefined,
        };
      })
    : [];
  const approvalRaw = asRecord(rec.pendingApproval);
  const pendingApproval: MeshPendingApproval | null = approvalRaw
    ? {
        requestId: String(approvalRaw.requestId ?? ''),
        threadId,
        toolName: String(approvalRaw.toolName ?? 'Tool'),
        targetPath: typeof approvalRaw.targetPath === 'string' ? approvalRaw.targetPath : undefined,
        command: typeof approvalRaw.command === 'string' ? approvalRaw.command : undefined,
        reason: typeof approvalRaw.reason === 'string' ? approvalRaw.reason : undefined,
        requestedAt: toEpochMs(approvalRaw.requestedAt, now),
      }
    : null;
  const activeBgTaskCount =
    typeof rec.activeBgTaskCount === 'number'
      ? rec.activeBgTaskCount
      : Array.isArray(rec.activeBgTasks)
        ? rec.activeBgTasks.length
        : 0;
  return {
    threadId,
    chatSessionId,
    agentId,
    agentName: resolveAgentDisplayName(
      agentId,
      typeof rec.agentName === 'string' ? rec.agentName : undefined,
    ),
    rosterName: typeof rec.rosterName === 'string' ? rec.rosterName : undefined,
    rootPath: String(rec.rootPath ?? ''),
    externalSessionId:
      typeof rec.externalSessionId === 'string' ? rec.externalSessionId : undefined,
    status: (rec.status as MeshThreadStatus) ?? 'running',
    prompt: typeof rec.prompt === 'string' ? rec.prompt : undefined,
    assistantText: String(rec.assistantText ?? rec.streamingText ?? ''),
    thinkingText: typeof rec.thinkingText === 'string' ? rec.thinkingText : undefined,
    toolCalls,
    childSubagents,
    activeBgTaskCount,
    pendingApproval,
    diffSummary: normalizeHostDiffSummary(rec.diffSummary),
    lastCheckpointId: typeof rec.lastCheckpointId === 'string' ? rec.lastCheckpointId : undefined,
    revertedAt: typeof rec.revertedAt === 'number' ? rec.revertedAt : undefined,
    humanControlled: Boolean(rec.humanControlled),
    errorMessage: typeof rec.errorMessage === 'string' ? rec.errorMessage : undefined,
    createdAt: toEpochMs(rec.createdAt, now),
    updatedAt: toEpochMs(rec.updatedAt, now),
  };
}

function normalizeHostPeerExchange(raw: unknown): PeerExchangeRecord | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = String(rec.id ?? '').trim();
  const chatSessionId = String(rec.chatSessionId ?? '').trim();
  if (!id || !chatSessionId) return null;
  const fromAgent = String(rec.fromAgent ?? '').trim();
  const toAgent = String(rec.toAgent ?? '').trim();
  const responseText = typeof rec.responseText === 'string' ? rec.responseText : undefined;
  return {
    id,
    chatSessionId,
    fromAgent,
    fromAgentName:
      typeof rec.fromAgentName === 'string'
        ? rec.fromAgentName
        : resolveAgentDisplayName(fromAgent),
    toAgent,
    toAgentName:
      typeof rec.toAgentName === 'string' ? rec.toAgentName : resolveAgentDisplayName(toAgent),
    kind: rec.kind === 'handoff' ? 'handoff' : 'ask_peer',
    topic: typeof rec.topic === 'string' ? rec.topic : undefined,
    questionOrSummary: String(rec.questionOrSummary ?? ''),
    responseText,
    changedFiles: Array.isArray(rec.changedFiles) ? rec.changedFiles.map(String) : [],
    messages: Array.isArray(rec.messages)
      ? (rec.messages as PeerExchangeRecord['messages'])
      : undefined,
    rounds:
      typeof rec.rounds === 'number' && rec.rounds > 0
        ? rec.rounds
        : responseText
          ? 2
          : 1,
    status:
      rec.status === 'completed' || rec.status === 'failed' ? rec.status : 'running',
    createdAt: toEpochMs(rec.createdAt),
    completedAt: rec.completedAt !== undefined && rec.completedAt !== null ? toEpochMs(rec.completedAt) : undefined,
  };
}

function normalizeHostCheckpoint(raw: unknown): MeshCheckpointRecord | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const checkpointId = String(rec.checkpointId ?? '').trim();
  const chatSessionId = String(rec.chatSessionId ?? '').trim();
  if (!checkpointId || !chatSessionId) return null;
  return {
    checkpointId,
    chatSessionId,
    threadId: String(rec.threadId ?? ''),
    agentId: String(rec.agentId ?? ''),
    turnSeq: Number(rec.turnSeq ?? 1) || 1,
    kind: rec.kind === 'before' ? 'before' : 'after',
    refName:
      typeof rec.refName === 'string'
        ? rec.refName
        : typeof rec.ref === 'string'
          ? rec.ref
          : undefined,
    diffSummary: normalizeHostDiffSummary(rec.diffSummary) ?? undefined,
    createdAt: toEpochMs(rec.createdAt),
    reverted: Boolean(rec.reverted),
  };
}

function normalizeHostLease(raw: unknown): MeshFileLease | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const holderAgentId = String(rec.holderAgentId ?? '').trim();
  if (!holderAgentId) return null;
  return {
    id: typeof rec.id === 'string' ? rec.id : typeof rec.leaseId === 'string' ? rec.leaseId : undefined,
    rootPath: String(rec.rootPath ?? ''),
    pattern: String(rec.pattern ?? (Array.isArray(rec.patterns) ? rec.patterns[0] ?? '' : '')),
    holderAgentId,
    holderThreadId:
      typeof rec.holderThreadId === 'string'
        ? rec.holderThreadId
        : typeof rec.threadId === 'string'
          ? rec.threadId
          : undefined,
    heldSince: toEpochMs(rec.heldSince),
    expiresAt:
      typeof rec.expiresAt === 'number'
        ? rec.expiresAt
        : typeof rec.expiresAtMs === 'number'
          ? rec.expiresAtMs
          : undefined,
  };
}

function normalizeHostBoardPost(raw: unknown, fallbackSessionId: string): SwarmBoardPost | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const seq = Number(rec.seq);
  const chatSessionId = String(rec.chatSessionId ?? fallbackSessionId).trim();
  if (!chatSessionId || !Number.isFinite(seq)) return null;
  return {
    seq,
    chatSessionId,
    sender: String(rec.sender ?? 'system').replace(/^@/, ''),
    senderKind: (rec.senderKind as SwarmBoardPost['senderKind']) ?? 'worker',
    priority: (rec.priority as SwarmBoardPost['priority']) ?? 'progress',
    text: String(rec.text ?? ''),
    mentions: Array.isArray(rec.mentions) ? rec.mentions.map((m) => String(m).replace(/^@/, '')) : [],
    channel: typeof rec.channel === 'string' ? rec.channel : undefined,
    replyToSeq: typeof rec.replyToSeq === 'number' ? rec.replyToSeq : undefined,
    diffRef: typeof rec.diffRef === 'string' ? rec.diffRef : undefined,
    createdAt: toEpochMs(rec.createdAt),
  };
}

export function normalizeHostSwarmState(
  raw: unknown,
  fallbackSessionId = '',
): SwarmSessionState | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const sessionRec = asRecord(rec.session) ?? rec;
  const chatSessionId = String(sessionRec.chatSessionId ?? fallbackSessionId).trim();
  if (!chatSessionId) return null;
  const membersRaw = Array.isArray(rec.members) ? rec.members : [];
  const members: SwarmMemberRecord[] = membersRaw.map((m) => {
    const mr = asRecord(m) ?? {};
    return {
      chatSessionId: String(mr.chatSessionId ?? chatSessionId),
      rosterName: String(mr.rosterName ?? mr.agentId ?? '').replace(/^@/, ''),
      agentId: String(mr.agentId ?? mr.rosterName ?? '').replace(/^@/, ''),
      roleTitle: typeof mr.roleTitle === 'string' ? mr.roleTitle : undefined,
      status: (mr.status as SwarmMemberRecord['status']) ?? 'parked',
      threadId: typeof mr.threadId === 'string' ? mr.threadId : undefined,
      externalSessionId: typeof mr.externalSessionId === 'string' ? mr.externalSessionId : undefined,
      lastSeenSeq: Number(mr.lastSeenSeq ?? 0) || 0,
      ownedGlobs: Array.isArray(mr.ownedGlobs) ? mr.ownedGlobs.map(String) : [],
      humanControlled: Boolean(mr.humanControlled),
      activeSubagentCount:
        typeof mr.activeSubagentCount === 'number'
          ? mr.activeSubagentCount
          : typeof mr.activeChildCount === 'number'
            ? mr.activeChildCount
            : undefined,
    };
  });
  const boardRaw = Array.isArray(rec.board) ? rec.board : [];
  const board: SwarmBoardPost[] = boardRaw
    .map((b) => normalizeHostBoardPost(b, chatSessionId))
    .filter((b): b is SwarmBoardPost => b !== null);
  const autonomousHops = Number(sessionRec.autonomousHops ?? 0) || 0;
  const maxAutonomousHops = Number(sessionRec.maxAutonomousHops ?? 12) || 12;
  const status =
    sessionRec.status === 'paused' || sessionRec.status === 'completed'
      ? sessionRec.status
      : 'active';
  return {
    chatSessionId,
    title: String(sessionRec.title ?? '异构蜂群协作'),
    goal: typeof sessionRec.goal === 'string' ? sessionRec.goal : undefined,
    status,
    coordinatorAgent: String(sessionRec.coordinatorAgent ?? 'deepstudent'),
    autonomousHops,
    maxAutonomousHops,
    headSeq: Number(sessionRec.headSeq ?? board.at(-1)?.seq ?? 0) || 0,
    circuitBreakerTripped: Boolean(
      sessionRec.circuitBreakerTripped ?? (status === 'paused' && autonomousHops >= maxAutonomousHops),
    ),
    members,
    board,
    createdAt: toEpochMs(sessionRec.createdAt),
    updatedAt: toEpochMs(sessionRec.updatedAt),
  };
}

function normalizeHostBinding(raw: unknown, fallbackSessionId = ''): WorkspaceBinding | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const rootPath = typeof rec.rootPath === 'string' ? rec.rootPath.trim() : '';
  const chatSessionId = String(rec.chatSessionId ?? fallbackSessionId).trim();
  if (!rootPath || !chatSessionId) return null;
  return {
    chatSessionId,
    rootPath,
    isolatedBranch: typeof rec.isolatedBranch === 'boolean' ? rec.isolatedBranch : undefined,
    shadowWorktreePath: typeof rec.shadowWorktreePath === 'string' ? rec.shadowWorktreePath : undefined,
    updatedAt: toEpochMs(rec.updatedAt),
  };
}

function normalizeHostSessionSnapshot(
  raw: unknown,
  fallbackSessionId = '',
): AgentMeshSessionSnapshot | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const chatSessionId = String(rec.chatSessionId ?? fallbackSessionId).trim();
  if (!chatSessionId) return null;
  if (Array.isArray(rec.agents)) {
    const normalizedAgents = rec.agents
      .map(normalizeHostDetectedAgent)
      .filter((a): a is DetectedMeshAgent => a !== null);
    if (normalizedAgents.length > 0) {
      useAgentMeshStore.getState().setAgents(normalizedAgents);
    }
  }
  return {
    chatSessionId,
    workspaceBinding:
      rec.workspaceBinding !== undefined
        ? normalizeHostBinding(rec.workspaceBinding, chatSessionId)
        : undefined,
    threads: Array.isArray(rec.threads)
      ? rec.threads
          .map(normalizeHostThreadState)
          .filter((t): t is MeshThreadState => t !== null)
      : undefined,
    peerExchanges: Array.isArray(rec.peerExchanges)
      ? rec.peerExchanges
          .map(normalizeHostPeerExchange)
          .filter((p): p is PeerExchangeRecord => p !== null)
      : undefined,
    checkpoints: Array.isArray(rec.checkpoints)
      ? rec.checkpoints
          .map(normalizeHostCheckpoint)
          .filter((c): c is MeshCheckpointRecord => c !== null)
      : undefined,
    fileLeases: Array.isArray(rec.fileLeases)
      ? rec.fileLeases
          .map(normalizeHostLease)
          .filter((l): l is MeshFileLease => l !== null)
      : undefined,
    swarm:
      rec.swarm !== undefined
        ? normalizeHostSwarmState(rec.swarm, chatSessionId)
        : undefined,
  };
}

function adaptHostCallerToBridge(
  callerOrBridge: AgentMeshHostBridge | GenericAgentMeshHostCaller | null,
): AgentMeshHostBridge | null {
  if (!callerOrBridge) return null;
  if (typeof callerOrBridge === 'function') {
    const call = callerOrBridge;
    return {
      probeAgents: (opts) => call('probeAgents', opts) as Promise<DetectedMeshAgent[]>,
      getWorkspaceBinding: (sid) => call('getWorkspaceBinding', sid) as Promise<WorkspaceBinding | null>,
      setWorkspaceBinding: (input) => call('setWorkspaceBinding', input) as Promise<WorkspaceBinding | null>,
      startTurn: (input) => call('startTurn', input) as ReturnType<NonNullable<AgentMeshHostBridge['startTurn']>>,
      steerTurn: (input) => call('steerTurn', input) as Promise<{ ok?: boolean } | void>,
      interruptTurn: (input) => call('interruptTurn', input) as Promise<{ ok?: boolean } | void>,
      respondApproval: (input) => call('respondApproval', input) as Promise<{ ok?: boolean } | void>,
      setHumanControlled: (input) => call('setHumanControlled', input) as Promise<{ ok?: boolean } | void>,
      getSessionSnapshot: (sid) => call('getSessionSnapshot', sid) as Promise<AgentMeshSessionSnapshot | null>,
      getCheckpointDiff: (input) => call('getCheckpointDiff', input) as Promise<MeshDiffSummary | null>,
      revertCheckpoint: (input) => call('revertCheckpoint', input) as Promise<RevertCheckpointResult | null>,
      swarmControl: (input) => call('swarmControl', input) as Promise<SwarmSessionState | null>,
      saveCustomCliTemplate: (tpl) => call('saveCustomCliTemplate', tpl) as Promise<CustomCliTemplate | void>,
      deleteCustomCliTemplate: (id) => call('deleteCustomCliTemplate', id) as Promise<{ ok?: boolean } | void>,
      saveCliOverride: (input) => call('saveCliOverride', input),
      deleteCliOverride: (input) => call('deleteCliOverride', input) as Promise<{ deleted?: boolean; agentId?: string } | void>,
      askPeer: (input) => call('askPeer', input) as Promise<PeerExchangeRecord | null>,
      handoff: (input) => call('handoff', input) as Promise<{ exchange: PeerExchangeRecord; targetTurn?: unknown } | null>,
    };
  }
  return callerOrBridge;
}

/**
 * Registers the Host RPC bridge (from `ctx.ui.host.agentMesh` or test mock).
 * Returns a disposer that unregisters only if this bridge instance is still active.
 */
export function registerAgentMeshHostBridge(
  bridge: AgentMeshHostBridge | GenericAgentMeshHostCaller | null,
): () => void {
  const adapted = adaptHostCallerToBridge(bridge);
  activeBridge = adapted;
  useAgentMeshStore.getState().setHostBridgeConnected(Boolean(adapted));

  return () => {
    if (activeBridge === adapted) {
      activeBridge = null;
      useAgentMeshStore.getState().setHostBridgeConnected(false);
    }
  };
}

/** Alias supporting official UI plugin mount signature */
export const registerAgentMeshHostCaller = registerAgentMeshHostBridge;

export function isAgentMeshHostConnected(): boolean {
  return activeBridge !== null;
}

function buildDefaultThreadRecord(
  threadId: string,
  input: StartExternalTurnRequest,
  partial?: Partial<MeshThreadState>,
): MeshThreadState {
  const now = Date.now();
  const storeAgents = useAgentMeshStore.getState().agents;
  const matchedAgent = storeAgents.find(
    (a) => a.id === input.agentId || a.handle === input.agentId,
  );
  return {
    threadId,
    chatSessionId: input.chatSessionId,
    agentId: input.agentId,
    agentName: partial?.agentName ?? resolveAgentDisplayName(input.agentId, matchedAgent?.name),
    rosterName: input.rosterName ?? partial?.rosterName,
    rootPath: partial?.rootPath ?? input.cwd,
    externalSessionId: partial?.externalSessionId ?? input.resumeSessionId,
    status: partial?.status ?? 'running',
    prompt: input.userPrompt ?? input.prompt,
    assistantText: partial?.assistantText ?? '',
    thinkingText: partial?.thinkingText ?? '',
    toolCalls: partial?.toolCalls ?? [],
    childSubagents: partial?.childSubagents ?? [],
    activeBgTaskCount: partial?.activeBgTaskCount ?? 0,
    pendingApproval: partial?.pendingApproval ?? null,
    diffSummary: partial?.diffSummary ?? null,
    lastCheckpointId: partial?.lastCheckpointId,
    humanControlled: partial?.humanControlled ?? false,
    timelineMode: input.timelineMode ?? partial?.timelineMode,
    userMessageId: input.userMessageId ?? partial?.userMessageId,
    assistantMessageId: input.assistantMessageId ?? partial?.assistantMessageId,
    nativeTimelineAttached: partial?.nativeTimelineAttached,
    errorMessage: partial?.errorMessage,
    createdAt: partial?.createdAt ?? now,
    updatedAt: partial?.updatedAt ?? now,
  };
}

// ============================================================================
// Typed Async Host Wrappers
// ============================================================================

export async function probeAgents(options?: { forceRefresh?: boolean }): Promise<DetectedMeshAgent[]> {
  if (!activeBridge?.probeAgents) {
    return useAgentMeshStore.getState().agents;
  }
  const agents = await activeBridge.probeAgents(options);
  if (Array.isArray(agents)) {
    const normalized = agents
      .map(normalizeHostDetectedAgent)
      .filter((a): a is DetectedMeshAgent => a !== null);
    useAgentMeshStore.getState().setAgents(normalized);
    return normalized;
  }
  return useAgentMeshStore.getState().agents;
}

export async function getWorkspaceBinding(chatSessionId: string): Promise<WorkspaceBinding | null> {
  if (!chatSessionId) return null;
  if (activeBridge?.getWorkspaceBinding) {
    const raw = await activeBridge.getWorkspaceBinding(chatSessionId);
    const binding = normalizeHostBinding(raw, chatSessionId);
    useAgentMeshStore.getState().setWorkspaceBindingState(chatSessionId, binding);
    return binding;
  }
  return useAgentMeshStore.getState().workspaceBindings[chatSessionId] ?? null;
}

export async function setWorkspaceBinding(
  input: SetWorkspaceBindingRequest,
): Promise<WorkspaceBinding | null> {
  const trimmedRoot = input.rootPath.trim();
  const optimistic: WorkspaceBinding | null = trimmedRoot
    ? {
        chatSessionId: input.chatSessionId,
        rootPath: trimmedRoot,
        isolatedBranch: input.isolatedBranch,
        updatedAt: Date.now(),
      }
    : null;

  useAgentMeshStore.getState().setWorkspaceBindingState(input.chatSessionId, optimistic);

  if (!activeBridge?.setWorkspaceBinding) {
    return optimistic;
  }
  const confirmedRaw = await activeBridge.setWorkspaceBinding({
    ...input,
    rootPath: trimmedRoot,
  });
  if (confirmedRaw !== undefined) {
    const confirmed = normalizeHostBinding(confirmedRaw, input.chatSessionId);
    useAgentMeshStore.getState().setWorkspaceBindingState(input.chatSessionId, confirmed);
    return confirmed;
  }
  return optimistic;
}

export async function startTurn(input: StartExternalTurnRequest): Promise<MeshThreadState | null> {
  if (!activeBridge?.startTurn) {
    return null;
  }
  const response = await activeBridge.startTurn(input);
  if (!response) {
    optimisticThreadSeq += 1;
    const fallbackId = `ext-thread-${Date.now()}-${optimisticThreadSeq}`;
    const created = buildDefaultThreadRecord(fallbackId, input);
    useAgentMeshStore.getState().upsertThread(created);
    return created;
  }
  if ('chatSessionId' in response && 'status' in response) {
    const normalizedPartial = normalizeHostThreadState(response) ?? response;
    const full = buildDefaultThreadRecord(response.threadId, input, normalizedPartial);
    useAgentMeshStore.getState().upsertThread(full);
    return full;
  }
  const rawThread = 'thread' in response ? response.thread : undefined;
  const nativeTimelineAttached =
    typeof response === 'object' &&
    response !== null &&
    'nativeTimelineAttached' in response
      ? Boolean((response as { nativeTimelineAttached?: boolean }).nativeTimelineAttached)
      : undefined;
  const normalizedPartial =
    (rawThread ? normalizeHostThreadState(rawThread) : null) ?? rawThread;
  const normalized = buildDefaultThreadRecord(response.threadId, input, {
    ...normalizedPartial,
    ...(nativeTimelineAttached !== undefined ? { nativeTimelineAttached } : {}),
  });
  useAgentMeshStore.getState().upsertThread(normalized);
  return normalized;
}

export async function steerTurn(input: SteerExternalTurnRequest): Promise<boolean> {
  if (!activeBridge?.steerTurn) {
    return false;
  }
  await activeBridge.steerTurn(input);
  return true;
}

export async function interruptTurn(input: InterruptExternalTurnRequest): Promise<boolean> {
  if (!activeBridge?.interruptTurn) {
    useAgentMeshStore.getState().patchThread(input.threadId, {
      status: 'stopped',
      pendingApproval: null,
    });
    return false;
  }
  await activeBridge.interruptTurn(input);
  useAgentMeshStore.getState().patchThread(input.threadId, {
    status: 'stopped',
    pendingApproval: null,
  });
  return true;
}

export async function respondApproval(input: RespondApprovalRequest): Promise<boolean> {
  const store = useAgentMeshStore.getState();
  const thread = store.threads[input.threadId];
  if (thread && thread.pendingApproval?.requestId === input.requestId) {
    const nextStatus: MeshThreadStatus =
      input.decision === 'deny'
        ? 'running'
        : thread.childSubagents.some((c) => c.status === 'running') || thread.activeBgTaskCount > 0
          ? 'waiting_children'
          : 'running';
    store.patchThread(input.threadId, {
      pendingApproval: null,
      status: nextStatus,
    });
  }

  if (!activeBridge?.respondApproval) {
    return false;
  }
  await activeBridge.respondApproval(input);
  return true;
}

export async function setHumanControlled(input: SetHumanControlledRequest): Promise<boolean> {
  useAgentMeshStore.getState().patchThread(input.threadId, {
    humanControlled: input.humanControlled,
  });
  if (!activeBridge?.setHumanControlled) {
    return false;
  }
  await activeBridge.setHumanControlled(input);
  return true;
}

export async function getSessionSnapshot(
  chatSessionId: string,
): Promise<AgentMeshSessionSnapshot | null> {
  if (!chatSessionId || !activeBridge?.getSessionSnapshot) {
    return null;
  }
  const raw = await activeBridge.getSessionSnapshot(chatSessionId);
  const snapshot = normalizeHostSessionSnapshot(raw, chatSessionId);
  if (snapshot) {
    useAgentMeshStore.getState().hydrateSessionSnapshot(snapshot);
  }
  return snapshot;
}

export async function getCheckpointDiff(
  input: GetCheckpointDiffRequest,
): Promise<MeshDiffSummary | null> {
  if (!activeBridge?.getCheckpointDiff) {
    return null;
  }
  const raw = await activeBridge.getCheckpointDiff(input);
  return normalizeHostDiffSummary(raw);
}

export async function revertCheckpoint(
  input: RevertCheckpointRequest,
): Promise<RevertCheckpointResult | null> {
  if (!activeBridge?.revertCheckpoint) {
    useAgentMeshStore
      .getState()
      .markCheckpointReverted(input.chatSessionId, input.checkpointId, input.threadId);
    return { revertedPaths: [], skippedUserModifiedPaths: [] };
  }
  const result = await activeBridge.revertCheckpoint(input);
  useAgentMeshStore
    .getState()
    .markCheckpointReverted(input.chatSessionId, input.checkpointId, input.threadId);
  return result;
}

export async function swarmControl(input: SwarmControlRequest): Promise<SwarmSessionState | null> {
  if (!activeBridge?.swarmControl) {
    return null;
  }
  const rawSwarm = await activeBridge.swarmControl(input);
  const nextSwarm = normalizeHostSwarmState(rawSwarm, input.chatSessionId);
  if (nextSwarm) {
    useAgentMeshStore.getState().setSwarmState(input.chatSessionId, nextSwarm);
  }
  return nextSwarm;
}

export async function saveCustomCliTemplate(
  template: CustomCliTemplate,
): Promise<CustomCliTemplate> {
  useAgentMeshStore.getState().upsertCustomTemplate(template);
  if (activeBridge?.saveCustomCliTemplate) {
    const saved = await activeBridge.saveCustomCliTemplate(template);
    if (saved) {
      const normalizedSaved: CustomCliTemplate = {
        ...saved,
        updatedAt: toEpochMs(saved.updatedAt),
      };
      useAgentMeshStore.getState().upsertCustomTemplate(normalizedSaved);
      return normalizedSaved;
    }
  }
  return template;
}

export async function deleteCustomCliTemplate(templateId: string): Promise<void> {
  useAgentMeshStore.getState().removeCustomTemplate(templateId);
  if (activeBridge?.deleteCustomCliTemplate) {
    await activeBridge.deleteCustomCliTemplate(templateId);
  }
}

export async function askPeer(input: AskPeerRequest): Promise<PeerExchangeRecord | null> {
  if (!activeBridge?.askPeer) return null;
  const raw = await activeBridge.askPeer(input);
  const normalized = normalizeHostPeerExchange(raw);
  if (normalized) {
    useAgentMeshStore.getState().upsertPeerExchange(normalized);
  }
  return normalized;
}

export async function handoff(
  input: HandoffRequest,
): Promise<{ exchange: PeerExchangeRecord; targetTurn?: unknown } | null> {
  if (!activeBridge?.handoff) return null;
  const raw = await activeBridge.handoff(input);
  const rec = asRecord(raw);
  const exchange = normalizeHostPeerExchange(rec?.exchange ?? raw);
  if (exchange) {
    useAgentMeshStore.getState().upsertPeerExchange(exchange);
    return { exchange, targetTurn: rec?.targetTurn };
  }
  return null;
}

export const agentMeshHost = {
  probeAgents,
  getWorkspaceBinding,
  setWorkspaceBinding,
  startTurn,
  steerTurn,
  interruptTurn,
  respondApproval,
  setHumanControlled,
  getSessionSnapshot,
  getCheckpointDiff,
  revertCheckpoint,
  swarmControl,
  saveCustomCliTemplate,
  deleteCustomCliTemplate,
  askPeer,
  handoff,
};

// ============================================================================
// Reactive Backend Event Reducer
// ============================================================================

function ensureThreadForStreamingDelta(
  threadId: string,
  meta: { chatSessionId?: string; agentId?: string; agentName?: string; rootPath?: string },
): void {
  const store = useAgentMeshStore.getState();
  if (store.threads[threadId] || !meta.chatSessionId) return;
  const agentId = meta.agentId ?? 'claude';
  const now = Date.now();
  store.upsertThread({
    threadId,
    chatSessionId: meta.chatSessionId,
    agentId,
    agentName: resolveAgentDisplayName(agentId, meta.agentName),
    rootPath: meta.rootPath ?? store.workspaceBindings[meta.chatSessionId]?.rootPath ?? '',
    status: 'running',
    assistantText: '',
    thinkingText: '',
    toolCalls: [],
    childSubagents: [],
    activeBgTaskCount: 0,
    pendingApproval: null,
    diffSummary: null,
    humanControlled: false,
    createdAt: now,
    updatedAt: now,
  });
}

export function applyAgentMeshBackendEvent(event: AgentMeshBackendEvent): void {
  if (!event || typeof event !== 'object') return;
  const store = useAgentMeshStore.getState();
  const now = Date.now();

  switch (event.type) {
    case 'agents_probed': {
      const normalized = event.agents
        .map(normalizeHostDetectedAgent)
        .filter((a): a is DetectedMeshAgent => a !== null);
      store.setAgents(normalized);
      break;
    }
    case 'workspace_bound': {
      store.setWorkspaceBindingState(
        event.chatSessionId,
        normalizeHostBinding(event.binding, event.chatSessionId),
      );
      break;
    }
    case 'thread_updated':
    case 'thread_upserted':
    case 'turn_started': {
      const existing = store.threads[event.thread?.threadId];
      const normalized = normalizeHostThreadState(event.thread) ?? event.thread;
      if (normalized) {
        store.upsertThread({
          ...normalized,
          prompt: normalized.prompt ?? existing?.prompt,
        });
      }
      break;
    }
    case 'thread_delta': {
      ensureThreadForStreamingDelta(event.threadId, { chatSessionId: event.chatSessionId });
      if (event.deltaKind === 'thinking') {
        store.patchThread(event.threadId, (prev) => ({
          ...prev,
          thinkingText: (prev.thinkingText ?? '') + event.text,
          updatedAt: now,
        }));
      } else {
        store.patchThread(event.threadId, (prev) => ({
          ...prev,
          assistantText: prev.assistantText + event.text,
          updatedAt: now,
        }));
      }
      break;
    }
    case 'assistant_delta': {
      ensureThreadForStreamingDelta(event.threadId, event);
      store.patchThread(event.threadId, (prev) => ({
        ...prev,
        assistantText: prev.assistantText + event.delta,
        updatedAt: now,
      }));
      break;
    }
    case 'thinking_delta': {
      ensureThreadForStreamingDelta(event.threadId, event);
      store.patchThread(event.threadId, (prev) => ({
        ...prev,
        thinkingText: (prev.thinkingText ?? '') + event.delta,
        updatedAt: now,
      }));
      break;
    }
    case 'tool_call_start': {
      store.patchThread(event.threadId, (prev) => {
        const exists = prev.toolCalls.some((tc) => tc.id === event.toolCallId);
        const nextCalls = exists
          ? prev.toolCalls.map((tc) =>
              tc.id === event.toolCallId
                ? { ...tc, status: 'running' as const, summary: event.summary ?? tc.summary }
                : tc,
            )
          : [
              ...prev.toolCalls,
              {
                id: event.toolCallId,
                toolName: event.toolName,
                status: 'running' as const,
                summary: event.summary,
                startedAt: event.startedAt ?? now,
              },
            ];
        return { ...prev, toolCalls: nextCalls, updatedAt: now };
      });
      break;
    }
    case 'tool_call_end': {
      store.patchThread(event.threadId, (prev) => ({
        ...prev,
        toolCalls: prev.toolCalls.map((tc) =>
          tc.id === event.toolCallId
            ? {
                ...tc,
                status: event.status ?? 'completed',
                summary: event.summary ?? tc.summary,
                completedAt: event.completedAt ?? now,
              }
            : tc,
        ),
        updatedAt: now,
      }));
      break;
    }
    case 'subagent_started': {
      store.patchThread(event.threadId, (prev) => {
        const exists = prev.childSubagents.some((child) => child.id === event.childId);
        const nextChildren = exists
          ? prev.childSubagents.map((child) =>
              child.id === event.childId
                ? { ...child, title: event.title || child.title, status: 'running' as const }
                : child,
            )
          : [
              ...prev.childSubagents,
              {
                id: event.childId,
                parentToolUseId: event.parentToolUseId,
                title: event.title,
                status: 'running' as const,
                startedAt: event.startedAt ?? now,
              },
            ];
        return {
          ...prev,
          childSubagents: nextChildren,
          updatedAt: now,
        };
      });
      break;
    }
    case 'subagent_completed': {
      store.patchThread(event.threadId, (prev) => {
        const nextChildren = prev.childSubagents.map((child) =>
          child.id === event.childId
            ? {
                ...child,
                status: event.status ?? 'completed',
                summary: event.summary ?? child.summary,
                completedAt: event.completedAt ?? now,
              }
            : child,
        );
        const anyRunningChild = nextChildren.some((c) => c.status === 'running');
        const nextStatus: MeshThreadStatus =
          prev.status === 'waiting_children' && !anyRunningChild && prev.activeBgTaskCount === 0
            ? 'idle'
            : prev.status;
        return {
          ...prev,
          childSubagents: nextChildren,
          status: nextStatus,
          updatedAt: now,
        };
      });
      break;
    }
    case 'bg_task_started': {
      store.patchThread(event.threadId, (prev) => ({
        ...prev,
        activeBgTaskCount: prev.activeBgTaskCount + 1,
        updatedAt: now,
      }));
      break;
    }
    case 'bg_task_completed': {
      store.patchThread(event.threadId, (prev) => {
        const nextBgCount = Math.max(0, prev.activeBgTaskCount - 1);
        const anyRunningChild = prev.childSubagents.some((c) => c.status === 'running');
        const nextStatus: MeshThreadStatus =
          prev.status === 'waiting_children' && !anyRunningChild && nextBgCount === 0
            ? 'idle'
            : prev.status;
        return {
          ...prev,
          activeBgTaskCount: nextBgCount,
          status: nextStatus,
          updatedAt: now,
        };
      });
      break;
    }
    case 'approval_requested': {
      const nested = event.approval;
      const requestId = nested?.requestId ?? event.requestId ?? '';
      const toolName = nested?.toolName ?? event.toolName ?? 'Tool';
      if (!requestId) break;
      store.patchThread(event.threadId, (prev) => ({
        ...prev,
        status: 'waiting_approval',
        pendingApproval: {
          requestId,
          threadId: event.threadId,
          toolName,
          targetPath: (nested?.targetPath ?? event.targetPath) || undefined,
          command: (nested?.command ?? event.command) || undefined,
          reason: (nested?.reason ?? event.reason) || undefined,
          requestedAt: toEpochMs(nested?.requestedAt ?? event.requestedAt, now),
        },
        updatedAt: now,
      }));
      break;
    }
    case 'approval_resolved': {
      store.patchThread(event.threadId, (prev) => {
        if (prev.pendingApproval?.requestId !== event.requestId) return prev;
        const hasActiveSubtree =
          prev.childSubagents.some((c) => c.status === 'running') || prev.activeBgTaskCount > 0;
        return {
          ...prev,
          pendingApproval: null,
          status: hasActiveSubtree ? 'waiting_children' : 'running',
          updatedAt: now,
        };
      });
      break;
    }
    case 'thread_status_changed':
    case 'turn_settled':
    case 'quiescent_completed':
    case 'turn_error':
    case 'turn_interrupted': {
      store.patchThread(event.threadId, (prev) => {
        const hasActiveSubtree =
          prev.childSubagents.some((c) => c.status === 'running') || prev.activeBgTaskCount > 0;
        let resolvedStatus: MeshThreadStatus = prev.status;
        if (event.status) {
          resolvedStatus = event.status;
        } else if (event.type === 'turn_settled') {
          resolvedStatus = hasActiveSubtree ? 'waiting_children' : 'idle';
        } else if (event.type === 'quiescent_completed') {
          resolvedStatus = 'idle';
        } else if (event.type === 'turn_error') {
          resolvedStatus = 'failed';
        } else if (event.type === 'turn_interrupted') {
          resolvedStatus = 'stopped';
        }
        return {
          ...prev,
          status: resolvedStatus,
          errorMessage: event.errorMessage ?? prev.errorMessage,
          diffSummary: event.diffSummary !== undefined ? event.diffSummary : prev.diffSummary,
          lastCheckpointId: event.lastCheckpointId ?? prev.lastCheckpointId,
          externalSessionId: event.externalSessionId ?? prev.externalSessionId,
          pendingApproval:
            resolvedStatus === 'idle' || resolvedStatus === 'failed' || resolvedStatus === 'stopped'
              ? null
              : prev.pendingApproval,
          updatedAt: now,
        };
      });
      break;
    }
    case 'human_controlled_changed': {
      if (event.threadId) {
        store.patchThread(event.threadId, {
          humanControlled: event.humanControlled,
          updatedAt: now,
        });
      } else if (event.chatSessionId && event.target) {
        const cleanTarget = normalizeAgentHandle(event.target);
        const sessionIds = store.sessionThreadOrder[event.chatSessionId] ?? [];
        for (const tid of sessionIds) {
          const th = store.threads[tid];
          if (
            th &&
            (normalizeAgentHandle(th.rosterName ?? '') === cleanTarget ||
              normalizeAgentHandle(th.agentId) === cleanTarget)
          ) {
            store.patchThread(tid, {
              humanControlled: event.humanControlled,
              updatedAt: now,
            });
          }
        }
      }
      break;
    }
    case 'peer_exchange_updated':
    case 'peer_exchange_upserted': {
      const normalized = normalizeHostPeerExchange(event.exchange) ?? event.exchange;
      if (normalized) {
        store.upsertPeerExchange(normalized);
      }
      break;
    }
    case 'checkpoint_captured':
    case 'checkpoint_created': {
      const normalized = normalizeHostCheckpoint(event.checkpoint) ?? event.checkpoint;
      if (normalized) {
        store.upsertCheckpoint(normalized);
      }
      break;
    }
    case 'checkpoint_reverted': {
      store.markCheckpointReverted(event.chatSessionId, event.checkpointId, event.threadId);
      break;
    }
    case 'file_leases_updated': {
      const normalized = event.leases
        .map(normalizeHostLease)
        .filter((l): l is MeshFileLease => l !== null);
      store.setFileLeases(normalized, event.rootPath);
      break;
    }
    case 'swarm_updated': {
      const normalized = normalizeHostSwarmState(event.swarm, event.chatSessionId);
      store.setSwarmState(event.chatSessionId, normalized);
      break;
    }
    case 'swarm_board_posted': {
      store.appendSwarmBoardPost(event.chatSessionId, event.post);
      break;
    }
    case 'swarm_board_post': {
      const post = normalizeHostBoardPost(event.message, event.chatSessionId);
      if (post) {
        store.appendSwarmBoardPost(event.chatSessionId, post);
      }
      break;
    }
    case 'swarm_circuit_breaker': {
      store.markSwarmCircuitBreaker(
        event.chatSessionId,
        event.autonomousHops,
        event.maxAutonomousHops,
      );
      break;
    }
    case 'templates_updated': {
      for (const tpl of event.templates) {
        store.upsertCustomTemplate({
          ...tpl,
          updatedAt: toEpochMs(tpl.updatedAt),
        });
      }
      break;
    }
    case 'session_snapshot': {
      const normalized = normalizeHostSessionSnapshot(
        event.snapshot,
        event.snapshot?.chatSessionId,
      );
      if (normalized) {
        store.hydrateSessionSnapshot(normalized);
      }
      break;
    }
    default:
      break;
  }
}
