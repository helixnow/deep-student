/**
 * Agent Mesh & Heterogeneous Swarm — Workbench UI types & state contracts.
 *
 * Designed to normalize both camelCase RPC DTOs and snake_case SQLite rows
 * emitted by `dstu.agent-mesh` Host orchestrator / swarm engine.
 */

export type MeshDriverKind =
  | 'builtin'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'pi'
  | 'agy'
  | 'dsh'
  | 'custom';

export interface MeshAdapterCapabilities {
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

export interface MeshAgentInfo {
  id: string;
  driver: MeshDriverKind;
  name: string;
  handle: string;
  available: boolean;
  authenticated?: boolean;
  version?: string | null;
  binaryPath?: string | null;
  authHint?: string | null;
  roleHint?: string | null;
  capabilities: MeshAdapterCapabilities;
}

export type MeshMemberStatus =
  | 'working'
  | 'waiting_children'
  | 'waiting_approval'
  | 'parked'
  | 'stopped'
  | 'failed';

export type MeshThreadStatus =
  | 'running'
  | 'waiting_children'
  | 'waiting_approval'
  | 'idle'
  | 'stopped'
  | 'failed';

export interface MeshSubagentNode {
  id: string;
  parentToolUseId?: string | null;
  title: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number | null;
  summary?: string | null;
}

export interface MeshToolCallItem {
  id: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  targetPath?: string | null;
  command?: string | null;
  outputPreview?: string | null;
  startedAt: number;
  completedAt?: number | null;
}

export type MeshApprovalDecision = 'allow_once' | 'allow_session' | 'deny';

export interface MeshPendingApproval {
  requestId: string;
  threadId: string;
  agentId: string;
  rosterName?: string | null;
  toolName: string;
  targetPath?: string | null;
  command?: string | null;
  reason?: string | null;
  requestedAt: number;
}

export interface MeshDiffSummary {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface MeshExternalThread {
  threadId: string;
  chatSessionId: string;
  agentId: string;
  rosterName?: string | null;
  rootPath: string;
  externalSessionId?: string | null;
  status: MeshThreadStatus;
  humanControlled: boolean;
  streamingText: string;
  thinkingText?: string;
  currentActivity?: string | null;
  childSubagents: MeshSubagentNode[];
  activeBgTasks: string[];
  toolCalls: MeshToolCallItem[];
  pendingApproval?: MeshPendingApproval | null;
  diffSummary?: MeshDiffSummary | null;
  lastCheckpointId?: string | null;
  errorMessage?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MeshSwarmMember {
  chatSessionId: string;
  rosterName: string;
  agentId: string;
  roleTitle: string;
  status: MeshMemberStatus;
  currentActivity?: string | null;
  threadId?: string | null;
  externalSessionId?: string | null;
  lastSeenSeq: number;
  ownedGlobs: string[];
  humanControlled: boolean;
  activeChildCount: number;
  activeBgTaskCount: number;
}

export interface MeshSwarmSession {
  chatSessionId: string;
  title: string;
  goal: string;
  status: 'active' | 'paused' | 'completed';
  coordinatorAgent: string;
  autonomousHops: number;
  maxAutonomousHops: number;
  headSeq: number;
  circuitBreakerTripped: boolean;
  circuitBreakerReason?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type MeshSenderKind = 'human' | 'coordinator' | 'worker' | 'system';
export type MeshMessagePriority = 'correction' | 'task' | 'query' | 'result' | 'progress';

export interface MeshBoardMessage {
  seq: number;
  chatSessionId: string;
  sender: string;
  senderKind: MeshSenderKind;
  priority: MeshMessagePriority;
  text: string;
  mentions: string[];
  channel?: string | null;
  replyToSeq?: number | null;
  diffRef?: string | null;
  createdAt: number;
}

export interface MeshFileLease {
  id: string;
  rootPath: string;
  patterns: string[];
  holderAgentId: string;
  rosterName?: string | null;
  threadId?: string | null;
  heldSince: number;
  expiresAt?: number | null;
}

export interface MeshFileDiffEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
  attributedAgentId?: string | null;
  attributedRosterName?: string | null;
  checkpointId?: string | null;
  turnSeq?: number | null;
}

export interface MeshCheckpointRecord {
  checkpointId: string;
  chatSessionId: string;
  threadId?: string | null;
  agentId: string;
  rosterName?: string | null;
  turnSeq: number;
  kind: 'before' | 'after';
  refName?: string | null;
  rootPath: string;
  summary?: string | null;
  filesChanged: number;
  additions: number;
  deletions: number;
  files: MeshFileDiffEntry[];
  createdAt: number;
}

export interface MeshRevertResult {
  revertedPaths: string[];
  skippedUserModifiedPaths: string[];
}

export interface MeshPeerExchange {
  id: string;
  chatSessionId: string;
  fromAgent: string;
  toAgent: string;
  kind: 'ask_peer' | 'handoff';
  questionOrSummary: string;
  responseText?: string | null;
  changedFiles: string[];
  status: 'pending' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number | null;
}

export interface MeshCustomCliTemplate {
  id: string;
  name: string;
  handle?: string;
  command: string;
  args: string[];
  resumeArgs?: string[];
  env?: Record<string, string>;
  updatedAt?: number;
}

export interface MeshSafetyPreferences {
  maxAutonomousHops: number;
  defaultInPlaceMode: boolean;
  autoAcquireFileLeases: boolean;
  allowStudyContextMcp: boolean;
}

export type MeshSwarmControlAction =
  | 'init'
  | 'start'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'post_message'
  | 'add_member'
  | 'remove_member'
  | 'handoff_member'
  | 'reset_circuit_breaker'
  | 'emergency_stop_all';

export interface MeshSwarmControlInput {
  action: MeshSwarmControlAction;
  chatSessionId: string;
  title?: string;
  goal?: string;
  coordinatorAgent?: string;
  maxAutonomousHops?: number;
  sender?: string;
  senderKind?: MeshSenderKind;
  priority?: MeshMessagePriority;
  text?: string;
  mentions?: string[];
  rosterName?: string;
  agentId?: string;
  targetAgentId?: string;
  roleTitle?: string;
  ownedGlobs?: string[];
  summary?: string;
  nextTask?: string;
}

export interface MeshWorkbenchHostAdapter {
  probeAgents?(options?: { forceRefresh?: boolean }): Promise<unknown>;
  getWorkspaceBinding?(input: { chatSessionId: string }): Promise<unknown>;
  setWorkspaceBinding?(input: { chatSessionId: string; rootPath: string }): Promise<unknown>;
  startTurn?(input: {
    chatSessionId: string;
    agentId: string;
    prompt: string;
    rosterName?: string;
    cwd?: string;
    resumeSessionId?: string;
  }): Promise<unknown>;
  steerTurn?(input: {
    chatSessionId?: string;
    threadId: string;
    prompt: string;
    priority?: 'correction' | 'normal';
  }): Promise<unknown>;
  interruptTurn?(input: {
    chatSessionId?: string;
    threadId: string;
    reason?: string;
  }): Promise<unknown>;
  respondApproval?(input: {
    chatSessionId?: string;
    threadId: string;
    requestId: string;
    decision: MeshApprovalDecision;
    note?: string;
  }): Promise<unknown>;
  setHumanControlled?(input: {
    chatSessionId: string;
    rosterName?: string;
    threadId?: string;
    humanControlled: boolean;
  }): Promise<unknown>;
  getSessionSnapshot?(input: { chatSessionId: string }): Promise<unknown>;
  getCheckpointDiff?(input: {
    chatSessionId: string;
    checkpointId?: string;
    fromCheckpointId?: string;
    toCheckpointId?: string;
    rootPath?: string;
  }): Promise<unknown>;
  revertCheckpoint?(input: {
    chatSessionId: string;
    checkpointId: string;
    paths?: string[];
    forceOverwriteUserEdits?: boolean;
    rootPath?: string;
  }): Promise<unknown>;
  swarmControl?(input: MeshSwarmControlInput): Promise<unknown>;
  saveCustomCliTemplate?(template: MeshCustomCliTemplate): Promise<unknown>;
  deleteCustomCliTemplate?(input: { id: string }): Promise<unknown>;
}

export type MeshCenterViewMode = 'board' | 'stream';

export interface MeshWorkbenchOpenState {
  open: boolean;
  sessionId: string | null;
  selectedRosterName: string | null;
  selectedThreadId: string | null;
  centerView: MeshCenterViewMode;
  rightPaneCollapsed: boolean;
  pendingDispatchPrompt?: string | null;
}
