/**
 * Decoupled structural contracts and default in-memory/noop ports for `dstu.agent-mesh`.
 *
 * Concrete external CLI adapters (`mesh-adapters`) and git checkpoints / file leases / HTTP MCP
 * bridge (`mesh-safety-bridge`) implement these structural interfaces and plug directly into
 * `createMeshOrchestrator(...)` without tight coupling or circular imports.
 */

export type ExternalAgentDriverKind =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'pi'
  | 'agy'
  | 'dsh'
  | 'custom';

export type MeshAgentKind = ExternalAgentDriverKind | 'deepstudent';

export interface AdapterCapabilities {
  streamingEvents: boolean;
  midTurnSteer: boolean;
  interrupt: boolean;
  approvalCallback: boolean;
  sessionResume: boolean;
  sessionFork: boolean;
  nativeSubagentTree: boolean;
  backgroundTaskEvents: boolean;
  mcpInjection: boolean;
}

export interface DetectedCliAgent {
  id: string;
  kind: MeshAgentKind;
  name: string;
  displayName?: string;
  command: string;
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  executablePath?: string | null;
  authHint?: string | null;
  defaultModel?: string | null;
  availableModels?: readonly string[];
  capabilities: AdapterCapabilities;
}

export interface CustomCliTemplate {
  id: string;
  name: string;
  command: string;
  args: string[];
  resumeArgs: string[];
  env: Record<string, string>;
  updatedAt: string;
}

export interface CustomCliTemplateInput {
  id?: string;
  name: string;
  command: string;
  args?: string[];
  resumeArgs?: string[];
  env?: Record<string, string>;
}

export interface McpInjectionSpec {
  httpUrl: string;
  bearerToken: string;
  shimBinDir: string;
  envVars: Record<string, string>;
}

export type NormalizedRuntimeEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | {
      type: 'tool_call_start';
      callId: string;
      toolName: string;
      args?: unknown;
      targetPath?: string | null;
      command?: string | null;
      parentToolUseId?: string | null;
    }
  | {
      type: 'tool_call_end';
      callId: string;
      toolName?: string;
      output?: unknown;
      isError?: boolean;
    }
  | {
      type: 'subagent_started';
      childId: string;
      parentToolUseId?: string | null;
      title?: string;
    }
  | {
      type: 'subagent_completed';
      childId: string;
      summary?: string;
    }
  | {
      type: 'bg_task_started';
      taskId: string;
      command?: string;
    }
  | {
      type: 'bg_task_completed';
      taskId: string;
      exitCode?: number | null;
    }
  | {
      type: 'approval_requested';
      requestId: string;
      toolName: string;
      targetPath?: string | null;
      command?: string | null;
      reason?: string | null;
    }
  | { type: 'session_bound'; externalSessionId: string }
  | { type: 'turn_settled'; summary?: string }
  | { type: 'quiescent_completed'; summary?: string }
  | { type: 'turn_error'; error: string; recoverable?: boolean }
  | { type: 'turn_interrupted'; reason?: string }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      totalCostUsd?: number;
    };

export interface ExternalTurnStartInput {
  threadId: string;
  cwd: string;
  prompt: string;
  resumeSessionId?: string | null;
  mcp?: McpInjectionSpec;
  env?: Record<string, string>;
  signal?: AbortSignal;
  readOnly?: boolean;
  model?: string;
  reasoningEffort?: string;
  onEvent?: (event: NormalizedRuntimeEvent) => void;
}

export type AdapterTurnStreamResult =
  | AsyncIterable<NormalizedRuntimeEvent>
  | {
      events?: AsyncIterable<NormalizedRuntimeEvent>;
      completion?: Promise<void>;
    }
  | void;

export interface ExternalCodingAdapter {
  readonly kind?: ExternalAgentDriverKind;
  readonly capabilities: AdapterCapabilities;
  startOrResumeTurn(input: ExternalTurnStartInput): Promise<AdapterTurnStreamResult> | AdapterTurnStreamResult;
  steer?(threadId: string, text: string): Promise<boolean> | boolean;
  interrupt(threadId: string, reason?: string): Promise<void> | void;
  respondApproval?(
    threadId: string,
    requestId: string,
    decision: { approved: boolean; reason?: string },
  ): Promise<boolean> | boolean;
  dispose?(): Promise<void> | void;
}

export interface AdapterRegistryPort {
  probeAgents(options?: {
    forceRefresh?: boolean;
    customTemplates?: readonly CustomCliTemplate[];
  }): Promise<DetectedCliAgent[]>;
  getAdapter(
    agentId: string,
    customTemplates?: readonly CustomCliTemplate[],
  ): ExternalCodingAdapter | null;
  dispose?(): Promise<void> | void;
}

export interface MeshCheckpointRecord {
  checkpointId: string;
  chatSessionId: string;
  threadId: string;
  agentId: string;
  rosterName?: string | null;
  rootPath: string;
  turnSeq: number;
  kind: 'before' | 'after';
  ref: string;
  isGit: boolean;
  postTurnHashes?: Record<string, string>;
  createdAt: string;
}

export interface MeshDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
  attributedAgentId?: string;
}

export interface MeshDiffReport {
  files: MeshDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  fromRef?: string;
  toRef?: string;
}

export interface RevertCheckpointResult {
  revertedPaths: string[];
  skippedUserModifiedPaths: string[];
}

export interface CheckpointPort {
  captureCheckpoint(input: {
    chatSessionId: string;
    threadId: string;
    agentId: string;
    rosterName?: string | null;
    rootPath: string;
    turnSeq: number;
    kind: 'before' | 'after';
  }): Promise<MeshCheckpointRecord>;
  diffCheckpoints(
    rootPath: string,
    fromRef: string,
    toRef: string,
    attributedAgentId?: string,
  ): Promise<MeshDiffReport>;
  diffWorkingTreeFromCheckpoint?(
    rootPath: string,
    fromRef: string,
    attributedAgentId?: string,
  ): Promise<MeshDiffReport>;
  revertToCheckpoint(
    rootPath: string,
    targetCheckpoint: MeshCheckpointRecord | string,
    options?: {
      paths?: string[];
      postTurnHashes?: Record<string, string>;
      forceOverwriteUserEdits?: boolean;
    },
  ): Promise<RevertCheckpointResult>;
}

export interface ActiveFileLease {
  leaseId: string;
  rootPath: string;
  pattern: string;
  holderAgentId: string;
  holderThreadId: string;
  heldSince: string;
  expiresAtMs: number;
}

export interface FileLeaseConflict {
  holderAgentId: string;
  holderThreadId: string;
  conflictingPattern: string;
  heldSince: string;
}

export interface AcquireFileLeaseResult {
  granted: boolean;
  leases?: ActiveFileLease[];
  conflict?: FileLeaseConflict;
}

export interface FileLeasePort {
  acquireLease(input: {
    rootPath: string;
    patterns: string[];
    holderAgentId: string;
    threadId: string;
    ttlMs?: number;
    waitMs?: number;
  }): Promise<AcquireFileLeaseResult>;
  releaseAgentLeases(
    holderAgentId: string,
    threadId?: string,
    paths?: string[],
  ): Promise<number> | number;
  listActiveLeases(rootPath?: string): ActiveFileLease[];
  dispose?(): void;
}

export interface MeshBridgeTokenScope {
  chatSessionId: string;
  agentId: string;
  rosterName: string;
  threadId: string;
  rootPath: string;
}

export interface MeshBridgeHostCallbacks {
  meshPostBoard(
    scope: MeshBridgeTokenScope,
    args: {
      text: string;
      mentions?: string[];
      channel?: string;
      replyToSeq?: number;
      priority?: BoardMessagePriority;
      diffRef?: string;
    },
  ): Promise<unknown>;
  meshReadBoard(
    scope: MeshBridgeTokenScope,
    args: { sinceSeq?: number; limit?: number },
  ): Promise<unknown>;
  meshAskPeer(
    scope: MeshBridgeTokenScope,
    args: { targetAgent: string; question: string; contextPaths?: string[] },
  ): Promise<unknown>;
  meshHandoff(
    scope: MeshBridgeTokenScope,
    args: {
      targetAgent: string;
      summary: string;
      nextTask: string;
      changedFiles?: string[];
    },
  ): Promise<unknown>;
  meshClaimFiles(
    scope: MeshBridgeTokenScope,
    args: { paths: string[]; waitMs?: number },
  ): Promise<unknown>;
  meshReleaseFiles(
    scope: MeshBridgeTokenScope,
    args: { paths?: string[] },
  ): Promise<unknown>;
  meshPark(
    scope: MeshBridgeTokenScope,
    args: { summary?: string },
  ): Promise<unknown>;
  studyReadContext(
    scope: MeshBridgeTokenScope,
    args: { query: string; resourceId?: string; maxChars?: number },
  ): Promise<unknown>;
}

export interface MeshBridgeServerPort {
  bindCallbacks?(callbacks: MeshBridgeHostCallbacks): void;
  start?(): Promise<unknown>;
  issueAgentSession(scope: MeshBridgeTokenScope): Promise<McpInjectionSpec>;
  revokeAgentSession(threadId: string): Promise<void> | void;
  dispose(): Promise<void> | void;
}

export interface StudyContextReaderPort {
  readStudyContext(input: {
    chatSessionId: string;
    query: string;
    resourceId?: string;
    maxChars?: number;
  }): Promise<{ content: string; sources: Array<{ id: string; title: string }> }>;
}

export interface CoordinatorWakeNotification {
  chatSessionId: string;
  reason: 'mention' | 'stall' | 'handoff' | 'ask_peer';
  messages: SwarmBoardMessage[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Domain State & Persistence Models
// ---------------------------------------------------------------------------

export interface WorkspaceBindingRecord {
  chatSessionId: string;
  rootPath: string;
  updatedAt: string;
}

export type MeshThreadStatus =
  | 'running'
  | 'waiting_children'
  | 'waiting_approval'
  | 'idle'
  | 'stopped'
  | 'failed';

export interface MeshThreadRecord {
  threadId: string;
  chatSessionId: string;
  agentId: string;
  rosterName: string;
  rootPath: string;
  externalSessionId: string | null;
  status: MeshThreadStatus;
  humanControlled: boolean;
  lastCheckpointId: string | null;
  createdAt: string;
  updatedAt: string;
  meta: Record<string, unknown>;
}

export interface NestedSubagentStatus {
  childId: string;
  parentToolUseId: string | null;
  title: string;
  status: 'running' | 'completed';
  startedAt: string;
  completedAt?: string;
  summary?: string;
}

export interface PendingToolApproval {
  requestId: string;
  threadId: string;
  toolName: string;
  targetPath: string | null;
  command: string | null;
  reason: string | null;
  requestedAt: string;
}

export interface MeshThreadToolCallView {
  callId: string;
  toolName: string;
  args?: unknown;
  targetPath?: string | null;
  command?: string | null;
  status: 'running' | 'completed' | 'error';
  output?: unknown;
}

export interface MeshThreadSnapshot extends MeshThreadRecord {
  assistantText: string;
  thinkingText: string;
  toolCalls: MeshThreadToolCallView[];
  childSubagents: NestedSubagentStatus[];
  activeBgTasks: string[];
  pendingApproval: PendingToolApproval | null;
  queuedCount: number;
  diffSummary: { filesChanged: number; additions: number; deletions: number } | null;
}

export type PeerExchangeKind = 'ask_peer' | 'handoff';
export type PeerExchangeStatus = 'running' | 'completed' | 'failed';

export interface PeerExchangeRecord {
  id: string;
  chatSessionId: string;
  fromAgent: string;
  toAgent: string;
  kind: PeerExchangeKind;
  questionOrSummary: string;
  responseText: string | null;
  changedFiles: string[];
  status: PeerExchangeStatus;
  createdAt: string;
  completedAt: string | null;
}

export type SwarmSessionStatus = 'active' | 'paused' | 'completed';

export interface SwarmSessionRecord {
  chatSessionId: string;
  title: string;
  goal: string;
  status: SwarmSessionStatus;
  coordinatorAgent: string;
  autonomousHops: number;
  maxAutonomousHops: number;
  headSeq: number;
  createdAt: string;
  updatedAt: string;
}

export type SwarmMemberStatus =
  | 'working'
  | 'waiting_children'
  | 'waiting_approval'
  | 'parked'
  | 'stopped'
  | 'failed';

export interface SwarmMemberRecord {
  chatSessionId: string;
  rosterName: string;
  agentId: string;
  roleTitle: string;
  status: SwarmMemberStatus;
  threadId: string | null;
  externalSessionId: string | null;
  lastSeenSeq: number;
  ownedGlobs: string[];
  humanControlled: boolean;
}

export type BoardSenderKind = 'human' | 'coordinator' | 'worker' | 'system';
export type BoardMessagePriority = 'correction' | 'task' | 'query' | 'result' | 'progress';

export interface SwarmBoardMessage {
  chatSessionId: string;
  seq: number;
  sender: string;
  senderKind: BoardSenderKind;
  priority: BoardMessagePriority;
  text: string;
  mentions: string[];
  channel: string;
  replyToSeq: number | null;
  diffRef: string | null;
  createdAt: string;
}

export interface SwarmSessionSnapshot {
  session: SwarmSessionRecord;
  members: SwarmMemberRecord[];
  board: SwarmBoardMessage[];
}

export interface MeshSessionSnapshot {
  chatSessionId: string;
  workspaceBinding: WorkspaceBindingRecord | null;
  agents: DetectedCliAgent[];
  threads: MeshThreadSnapshot[];
  peerExchanges: PeerExchangeRecord[];
  checkpoints: MeshCheckpointRecord[];
  fileLeases: ActiveFileLease[];
  swarm: SwarmSessionSnapshot | null;
  customTemplates: CustomCliTemplate[];
}

export type AgentMeshEvent =
  | { type: 'agents_probed'; agents: DetectedCliAgent[] }
  | { type: 'workspace_bound'; chatSessionId: string; binding: WorkspaceBindingRecord | null }
  | { type: 'thread_updated'; chatSessionId: string; thread: MeshThreadSnapshot }
  | {
      type: 'thread_delta';
      chatSessionId: string;
      threadId: string;
      deltaKind: 'assistant' | 'thinking';
      text: string;
    }
  | {
      type: 'approval_requested';
      chatSessionId: string;
      threadId: string;
      approval: PendingToolApproval;
    }
  | {
      type: 'approval_resolved';
      chatSessionId: string;
      threadId: string;
      requestId: string;
      approved: boolean;
    }
  | {
      type: 'turn_steered';
      chatSessionId: string;
      threadId: string;
      mode: 'mid_turn_steer' | 'queued_at_head' | 'interrupt_and_resume' | 'started_turn';
      text: string;
    }
  | { type: 'peer_exchange_updated'; chatSessionId: string; exchange: PeerExchangeRecord }
  | { type: 'checkpoint_captured'; chatSessionId: string; checkpoint: MeshCheckpointRecord }
  | {
      type: 'checkpoint_reverted';
      chatSessionId: string;
      checkpointId: string;
      revertedPaths: string[];
      skippedUserModifiedPaths: string[];
    }
  | { type: 'file_leases_updated'; rootPath: string; leases: ActiveFileLease[] }
  | { type: 'swarm_updated'; chatSessionId: string; swarm: SwarmSessionSnapshot }
  | { type: 'swarm_board_post'; chatSessionId: string; message: SwarmBoardMessage }
  | {
      type: 'swarm_circuit_breaker';
      chatSessionId: string;
      autonomousHops: number;
      maxAutonomousHops: number;
      reason: string;
    }
  | {
      type: 'coordinator_wakeup';
      chatSessionId: string;
      notification: CoordinatorWakeNotification;
    }
  | {
      type: 'human_controlled_changed';
      chatSessionId: string;
      target: string;
      humanControlled: boolean;
    }
  | { type: 'templates_updated'; templates: CustomCliTemplate[] };

// ---------------------------------------------------------------------------
// Default Standalone Port Implementations (Zero-Conflict Fallbacks)
// ---------------------------------------------------------------------------

export const DEFAULT_BUILTIN_COORDINATOR_AGENT: DetectedCliAgent = Object.freeze({
  id: 'deepstudent',
  kind: 'deepstudent',
  name: 'deepstudent',
  displayName: 'DeepStudent',
  command: 'builtin',
  installed: true,
  authenticated: true,
  version: '1.0.0',
  executablePath: null,
  authHint: null,
  capabilities: Object.freeze({
    streamingEvents: true,
    midTurnSteer: true,
    interrupt: true,
    approvalCallback: true,
    sessionResume: true,
    sessionFork: true,
    nativeSubagentTree: true,
    backgroundTaskEvents: true,
    mcpInjection: true,
  }),
});

export const DEFAULT_GENERIC_CAPABILITIES: AdapterCapabilities = Object.freeze({
  streamingEvents: true,
  midTurnSteer: false,
  interrupt: true,
  approvalCallback: false,
  sessionResume: false,
  sessionFork: false,
  nativeSubagentTree: false,
  backgroundTaskEvents: false,
  mcpInjection: false,
});

export class DefaultNoopAdapterRegistry implements AdapterRegistryPort {
  async probeAgents(options?: {
    forceRefresh?: boolean;
    customTemplates?: readonly CustomCliTemplate[];
  }): Promise<DetectedCliAgent[]> {
    const customAgents: DetectedCliAgent[] = (options?.customTemplates ?? []).map((tpl) => ({
      id: `custom:${tpl.id}`,
      kind: 'custom',
      name: tpl.name,
      displayName: tpl.name,
      command: tpl.command,
      installed: Boolean(tpl.command.trim()),
      authenticated: true,
      version: null,
      executablePath: tpl.command,
      authHint: null,
      capabilities: {
        ...DEFAULT_GENERIC_CAPABILITIES,
        sessionResume: tpl.resumeArgs.length > 0,
      },
    }));
    return [DEFAULT_BUILTIN_COORDINATOR_AGENT, ...customAgents];
  }

  getAdapter(_agentId: string, _customTemplates?: readonly CustomCliTemplate[]): ExternalCodingAdapter | null {
    return null;
  }
}

export class DefaultInMemoryCheckpointPort implements CheckpointPort {
  private seq = 1;
  private readonly records = new Map<string, MeshCheckpointRecord>();

  async captureCheckpoint(input: {
    chatSessionId: string;
    threadId: string;
    agentId: string;
    rosterName?: string | null;
    rootPath: string;
    turnSeq: number;
    kind: 'before' | 'after';
  }): Promise<MeshCheckpointRecord> {
    const checkpointId = `chk_${this.seq++}_${input.turnSeq}_${input.kind}`;
    const ref = `refs/dstu-checkpoints/${encodeURIComponent(input.chatSessionId)}/${input.turnSeq}-${input.kind}`;
    const record: MeshCheckpointRecord = {
      checkpointId,
      chatSessionId: input.chatSessionId,
      threadId: input.threadId,
      agentId: input.agentId,
      rosterName: input.rosterName ?? null,
      rootPath: input.rootPath,
      turnSeq: input.turnSeq,
      kind: input.kind,
      ref,
      isGit: false,
      postTurnHashes: {},
      createdAt: new Date().toISOString(),
    };
    this.records.set(checkpointId, record);
    return record;
  }

  async diffCheckpoints(
    _rootPath: string,
    fromRef: string,
    toRef: string,
    _attributedAgentId?: string,
  ): Promise<MeshDiffReport> {
    return {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      fromRef,
      toRef,
    };
  }

  async diffWorkingTreeFromCheckpoint(
    _rootPath: string,
    fromRef: string,
    _attributedAgentId?: string,
  ): Promise<MeshDiffReport> {
    return {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      fromRef,
      toRef: 'WORKTREE',
    };
  }

  async revertToCheckpoint(
    _rootPath: string,
    _targetCheckpoint: MeshCheckpointRecord | string,
  ): Promise<RevertCheckpointResult> {
    return {
      revertedPaths: [],
      skippedUserModifiedPaths: [],
    };
  }
}

function normalizeLeasePattern(raw: string): string {
  const clean = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return clean || '.';
}

function patternsOverlap(aRaw: string, bRaw: string): boolean {
  const a = normalizeLeasePattern(aRaw);
  const b = normalizeLeasePattern(bRaw);
  if (a === '.' || b === '.' || a === '**' || b === '**' || a === '*' || b === '*') return true;
  if (a === b) return true;
  const stripWildcard = (p: string) => p.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
  const aBase = stripWildcard(a);
  const bBase = stripWildcard(b);
  if (aBase === bBase) return true;
  const aIsPrefix = a !== aBase || !aBase.includes('.');
  const bIsPrefix = b !== bBase || !bBase.includes('.');
  if (aIsPrefix && b.startsWith(`${aBase}/`)) return true;
  if (bIsPrefix && a.startsWith(`${bBase}/`)) return true;
  if (bBase.startsWith(`${aBase}/`) || aBase.startsWith(`${bBase}/`)) return true;
  return false;
}

export class DefaultInMemoryFileLeasePort implements FileLeasePort {
  private nextId = 1;
  private readonly leases = new Map<string, ActiveFileLease>();
  private readonly waiters = new Set<() => void>();

  private pruneExpired(): void {
    const now = Date.now();
    let removed = false;
    for (const [id, lease] of this.leases) {
      if (lease.expiresAtMs <= now) {
        this.leases.delete(id);
        removed = true;
      }
    }
    if (removed) this.notifyWaiters();
  }

  private notifyWaiters(): void {
    for (const wake of [...this.waiters]) {
      wake();
    }
  }

  private findConflict(
    rootPath: string,
    patterns: readonly string[],
    holderAgentId: string,
  ): FileLeaseConflict | null {
    for (const existing of this.leases.values()) {
      if (existing.rootPath !== rootPath) continue;
      if (existing.holderAgentId === holderAgentId) continue;
      for (const candidate of patterns) {
        if (patternsOverlap(existing.pattern, candidate)) {
          return {
            holderAgentId: existing.holderAgentId,
            holderThreadId: existing.holderThreadId,
            conflictingPattern: existing.pattern,
            heldSince: existing.heldSince,
          };
        }
      }
    }
    return null;
  }

  async acquireLease(input: {
    rootPath: string;
    patterns: string[];
    holderAgentId: string;
    threadId: string;
    ttlMs?: number;
    waitMs?: number;
  }): Promise<AcquireFileLeaseResult> {
    const ttlMs = Math.max(100, input.ttlMs ?? 300_000);
    const waitMs = Math.max(0, Math.min(15_000, input.waitMs ?? 0));
    const normalizedPatterns = [...new Set(input.patterns.map(normalizeLeasePattern))];
    const deadline = Date.now() + waitMs;

    while (true) {
      this.pruneExpired();
      const conflict = this.findConflict(input.rootPath, normalizedPatterns, input.holderAgentId);
      if (!conflict) {
        const nowIso = new Date().toISOString();
        const expiresAtMs = Date.now() + ttlMs;
        const grantedLeases: ActiveFileLease[] = [];
        for (const pattern of normalizedPatterns) {
          let existingMatch: ActiveFileLease | undefined;
          for (const existing of this.leases.values()) {
            if (
              existing.rootPath === input.rootPath &&
              existing.holderAgentId === input.holderAgentId &&
              existing.pattern === pattern
            ) {
              existingMatch = existing;
              break;
            }
          }
          if (existingMatch) {
            const refreshed: ActiveFileLease = {
              ...existingMatch,
              holderThreadId: input.threadId,
              expiresAtMs,
            };
            this.leases.set(refreshed.leaseId, refreshed);
            grantedLeases.push(refreshed);
          } else {
            const leaseId = `lease_${this.nextId++}`;
            const created: ActiveFileLease = {
              leaseId,
              rootPath: input.rootPath,
              pattern,
              holderAgentId: input.holderAgentId,
              holderThreadId: input.threadId,
              heldSince: nowIso,
              expiresAtMs,
            };
            this.leases.set(leaseId, created);
            grantedLeases.push(created);
          }
        }
        return { granted: true, leases: grantedLeases };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { granted: false, conflict };
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, Math.min(remaining, 100));
        this.waiters.add(wake);
      });
    }
  }

  releaseAgentLeases(holderAgentId: string, threadId?: string, paths?: string[]): number {
    this.pruneExpired();
    const filterPatterns = paths && paths.length > 0 ? new Set(paths.map(normalizeLeasePattern)) : null;
    let released = 0;
    for (const [id, lease] of this.leases) {
      if (lease.holderAgentId !== holderAgentId) continue;
      if (threadId !== undefined && lease.holderThreadId !== threadId) continue;
      if (filterPatterns && !filterPatterns.has(lease.pattern)) continue;
      this.leases.delete(id);
      released += 1;
    }
    if (released > 0) this.notifyWaiters();
    return released;
  }

  listActiveLeases(rootPath?: string): ActiveFileLease[] {
    this.pruneExpired();
    const result: ActiveFileLease[] = [];
    for (const lease of this.leases.values()) {
      if (rootPath === undefined || lease.rootPath === rootPath) {
        result.push({ ...lease });
      }
    }
    return result;
  }

  dispose(): void {
    this.leases.clear();
    this.notifyWaiters();
  }
}

export class DefaultNoopMeshBridgeServer implements MeshBridgeServerPort {
  private callbacks: MeshBridgeHostCallbacks | null = null;

  bindCallbacks(callbacks: MeshBridgeHostCallbacks): void {
    this.callbacks = callbacks;
  }

  getBoundCallbacks(): MeshBridgeHostCallbacks | null {
    return this.callbacks;
  }

  async issueAgentSession(scope: MeshBridgeTokenScope): Promise<McpInjectionSpec> {
    const token = `local_${scope.threadId}`;
    return {
      httpUrl: 'http://127.0.0.1:0/mcp',
      bearerToken: token,
      shimBinDir: '',
      envVars: {
        DSTU_MESH_TOKEN: token,
        DSTU_MESH_AGENT: scope.rosterName,
        DSTU_MESH_SESSION: scope.chatSessionId,
      },
    };
  }

  revokeAgentSession(_threadId: string): void {
    // No loopback socket held in standalone fallback mode.
  }

  dispose(): void {
    this.callbacks = null;
  }
}
