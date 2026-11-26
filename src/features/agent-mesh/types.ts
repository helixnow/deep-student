/**
 * DeepStudent Agent Mesh & Swarm — Frontend Domain Contracts
 *
 * Covers:
 * - Detected heterogeneous CLI agents (`claude`, `codex`, `opencode`, `pi`, `agy`, `dsh`, `deepstudent`, custom)
 * - Per-session workspace directory bindings (in-place default + optional shadow isolated branch)
 * - External CLI turn threads with nested `childSubagents` quiescence tracking, inline approvals & diff attribution
 * - Peer-to-peer exchanges (`ask_peer` / `handoff`), checkpoints, file leases, and heterogeneous `/swarm` state
 */

export type ExternalAgentDriverKind =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'pi'
  | 'agy'
  | 'dsh'
  | 'custom';

export type MeshAgentDriverKind = ExternalAgentDriverKind | 'builtin';

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

export type DetectedAgentRuntimeStatus =
  | 'ready'
  | 'working'
  | 'waiting_children'
  | 'waiting_approval'
  | 'parked'
  | 'offline';

export interface CliBinaryOverrideInput {
  agentId: string;
  executablePath?: string | null;
  extraArgs?: string[];
  env?: Record<string, string>;
}

export interface DetectedMeshAgent {
  /** Canonical identifier, e.g. 'claude', 'codex', 'opencode', 'pi', 'agy', 'dsh', 'deepstudent', or custom ID */
  id: string;
  /** Human-readable label, e.g. 'Claude Code', 'Codex CLI' */
  name: string;
  /** Short @mention handle without '@', e.g. 'claude', 'codex', 'deepstudent' */
  handle?: string;
  driverKind: MeshAgentDriverKind;
  installed: boolean;
  authenticated?: boolean;
  version?: string;
  command?: string;
  executablePath?: string | null;
  customExecutablePath?: string | null;
  extraArgs?: string[];
  probeError?: string | null;
  defaultModel?: string | null;
  availableModels?: string[];
  status?: DetectedAgentRuntimeStatus;
  capabilities: Partial<AdapterCapabilities>;
  aliases?: string[];
}

export interface CustomCliTemplate {
  id: string;
  name: string;
  command: string;
  args?: string[];
  resumeArgs?: string[];
  env?: Record<string, string>;
  updatedAt?: number;
}

export interface WorkspaceBinding {
  chatSessionId: string;
  rootPath: string;
  isolatedBranch?: boolean;
  shadowWorktreePath?: string;
  updatedAt: number;
}

export type MeshThreadStatus =
  | 'running'
  | 'waiting_children'
  | 'waiting_approval'
  | 'idle'
  | 'failed'
  | 'stopped';

export interface MeshChildSubagent {
  id: string;
  parentToolUseId?: string;
  title: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
  summary?: string;
}

export type MeshApprovalDecision = 'allow_once' | 'allow_session' | 'deny';

export interface MeshPendingApproval {
  requestId: string;
  threadId: string;
  toolName: string;
  targetPath?: string;
  command?: string;
  reason?: string;
  requestedAt: number;
}

export interface MeshDiffFileEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
  attributedAgentId?: string;
}

export interface MeshDiffSummary {
  filesChanged: number;
  totalAdditions: number;
  totalDeletions: number;
  checkpointId?: string;
  files?: MeshDiffFileEntry[];
}

export interface MeshToolCallItem {
  id: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  summary?: string;
  startedAt: number;
  completedAt?: number;
}

export interface MeshThreadState {
  threadId: string;
  chatSessionId: string;
  agentId: string;
  agentName: string;
  rosterName?: string;
  rootPath: string;
  externalSessionId?: string;
  status: MeshThreadStatus;
  prompt?: string;
  assistantText: string;
  thinkingText?: string;
  toolCalls: MeshToolCallItem[];
  childSubagents: MeshChildSubagent[];
  activeBgTaskCount: number;
  pendingApproval: MeshPendingApproval | null;
  diffSummary: MeshDiffSummary | null;
  lastCheckpointId?: string;
  revertedAt?: number;
  humanControlled: boolean;
  timelineMode?: 'native_chat' | 'headless';
  userMessageId?: string;
  assistantMessageId?: string;
  nativeTimelineAttached?: boolean;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PeerExchangeMessage {
  id: string;
  sender: string;
  senderName?: string;
  role: 'question' | 'answer' | 'handoff';
  text: string;
  createdAt: number;
}

export interface PeerExchangeRecord {
  id: string;
  chatSessionId: string;
  fromAgent: string;
  fromAgentName?: string;
  toAgent: string;
  toAgentName?: string;
  kind: 'ask_peer' | 'handoff';
  topic?: string;
  questionOrSummary: string;
  responseText?: string;
  changedFiles: string[];
  messages?: PeerExchangeMessage[];
  rounds: number;
  status: 'running' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
}

export interface MeshCheckpointRecord {
  checkpointId: string;
  chatSessionId: string;
  threadId: string;
  agentId: string;
  turnSeq: number;
  kind: 'before' | 'after';
  refName?: string;
  diffSummary?: MeshDiffSummary;
  createdAt: number;
  reverted?: boolean;
}

export interface MeshFileLease {
  id?: string;
  rootPath: string;
  pattern: string;
  holderAgentId: string;
  holderThreadId?: string;
  heldSince: number;
  expiresAt?: number;
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
  roleTitle?: string;
  status: SwarmMemberStatus;
  threadId?: string;
  externalSessionId?: string;
  lastSeenSeq: number;
  ownedGlobs: string[];
  humanControlled: boolean;
  activeSubagentCount?: number;
}

export interface SwarmBoardPost {
  seq: number;
  chatSessionId: string;
  sender: string;
  senderKind: 'human' | 'coordinator' | 'worker' | 'system';
  priority: 'correction' | 'task' | 'query' | 'result' | 'progress';
  text: string;
  mentions: string[];
  channel?: string;
  replyToSeq?: number;
  diffRef?: string;
  createdAt: number;
}

export interface SwarmSessionState {
  chatSessionId: string;
  title: string;
  goal?: string;
  status: 'active' | 'paused' | 'completed';
  coordinatorAgent: string;
  autonomousHops: number;
  maxAutonomousHops: number;
  headSeq: number;
  circuitBreakerTripped?: boolean;
  members: SwarmMemberRecord[];
  board: SwarmBoardPost[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkbenchOpenState {
  open: boolean;
  sessionId: string | null;
  focusThreadId?: string | null;
}

export interface AgentMeshSessionSnapshot {
  chatSessionId: string;
  workspaceBinding?: WorkspaceBinding | null;
  threads?: MeshThreadState[];
  peerExchanges?: PeerExchangeRecord[];
  checkpoints?: MeshCheckpointRecord[];
  fileLeases?: MeshFileLease[];
  swarm?: SwarmSessionState | null;
}

// ============================================================================
// Host RPC Request & Response Payloads
// ============================================================================

export interface SelectedPagesContextSnapshot {
  sourceId: string;
  sourceName: string;
  locator: string;
  text: string;
}

export interface StartExternalTurnRequest {
  chatSessionId: string;
  agentId: string;
  rosterName?: string;
  cwd: string;
  prompt: string;
  userPrompt?: string;
  model?: string;
  reasoningEffort?: string;
  timelineMode?: 'native_chat' | 'headless';
  userMessageId?: string;
  assistantMessageId?: string;
  skipUserMessageSave?: boolean;
  isolatedBranch?: boolean;
  resumeSessionId?: string;
  pdfRefTags?: string;
  pdfContext?: SelectedPagesContextSnapshot | null;
  contextRefs?: ReadonlyArray<{ resourceId: string; hash?: string; typeId?: string }>;
}

export interface SteerExternalTurnRequest {
  threadId: string;
  chatSessionId?: string;
  text: string;
  priority?: 'correction' | 'normal';
}

export interface InterruptExternalTurnRequest {
  threadId: string;
  chatSessionId?: string;
}

export interface RespondApprovalRequest {
  threadId: string;
  requestId: string;
  decision: MeshApprovalDecision;
  note?: string;
}

export interface SetHumanControlledRequest {
  threadId: string;
  chatSessionId?: string;
  humanControlled: boolean;
}

export interface SetWorkspaceBindingRequest {
  chatSessionId: string;
  rootPath: string;
  isolatedBranch?: boolean;
}

export interface GetCheckpointDiffRequest {
  chatSessionId: string;
  checkpointId: string;
  rootPath?: string;
}

export interface RevertCheckpointRequest {
  chatSessionId: string;
  checkpointId: string;
  threadId?: string;
  rootPath?: string;
  paths?: string[];
  forceOverwriteUserEdits?: boolean;
}

export interface RevertCheckpointResult {
  revertedPaths: string[];
  skippedUserModifiedPaths: string[];
}

export type SwarmControlAction =
  | 'start'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'add_member'
  | 'remove_member'
  | 'post_board'
  | 'swap_agent';

export interface SwarmControlRequest {
  action: SwarmControlAction;
  chatSessionId: string;
  title?: string;
  goal?: string;
  rosterName?: string;
  agentId?: string;
  roleTitle?: string;
  ownedGlobs?: string[];
  text?: string;
  priority?: SwarmBoardPost['priority'];
  mentions?: string[];
}

export interface AskPeerRequest {
  chatSessionId: string;
  fromAgent: string;
  targetAgent: string;
  question: string;
  contextPaths?: string[];
  rootPath?: string;
}

export interface HandoffRequest {
  chatSessionId: string;
  fromAgent: string;
  fromThreadId?: string;
  targetAgent: string;
  summary: string;
  nextTask: string;
  changedFiles?: string[];
  rootPath?: string;
  awaitCompletion?: boolean;
}

export interface AgentMeshHostBridge {
  probeAgents?: (options?: { forceRefresh?: boolean }) => Promise<DetectedMeshAgent[]>;
  getWorkspaceBinding?: (chatSessionId: string) => Promise<WorkspaceBinding | null>;
  setWorkspaceBinding?: (input: SetWorkspaceBindingRequest) => Promise<WorkspaceBinding | null>;
  startTurn?: (input: StartExternalTurnRequest) => Promise<MeshThreadState | { threadId: string; thread?: Partial<MeshThreadState> } | null>;
  steerTurn?: (input: SteerExternalTurnRequest) => Promise<{ ok?: boolean } | void>;
  interruptTurn?: (input: InterruptExternalTurnRequest) => Promise<{ ok?: boolean } | void>;
  respondApproval?: (input: RespondApprovalRequest) => Promise<{ ok?: boolean } | void>;
  setHumanControlled?: (input: SetHumanControlledRequest) => Promise<{ ok?: boolean } | void>;
  getSessionSnapshot?: (chatSessionId: string) => Promise<AgentMeshSessionSnapshot | null>;
  getCheckpointDiff?: (input: GetCheckpointDiffRequest) => Promise<MeshDiffSummary | null>;
  revertCheckpoint?: (input: RevertCheckpointRequest) => Promise<RevertCheckpointResult | null>;
  swarmControl?: (input: SwarmControlRequest) => Promise<SwarmSessionState | null>;
  saveCustomCliTemplate?: (template: CustomCliTemplate) => Promise<CustomCliTemplate | void>;
  deleteCustomCliTemplate?: (templateId: string) => Promise<{ ok?: boolean } | void>;
  saveCliOverride?: (input: CliBinaryOverrideInput) => Promise<unknown>;
  deleteCliOverride?: (input: { agentId: string } | string) => Promise<{ deleted?: boolean; agentId?: string } | void>;
  askPeer?: (input: AskPeerRequest) => Promise<PeerExchangeRecord | null>;
  handoff?: (input: HandoffRequest) => Promise<{ exchange: PeerExchangeRecord; targetTurn?: unknown } | null>;
}

// ============================================================================
// Real-time Backend Event Stream (`dstu/agent-mesh:event`)
// ============================================================================

export type AgentMeshBackendEvent =
  | { type: 'agents_probed'; agents: DetectedMeshAgent[] }
  | { type: 'workspace_bound'; chatSessionId: string; binding: WorkspaceBinding | null }
  | { type: 'thread_upserted' | 'turn_started' | 'thread_updated'; chatSessionId?: string; thread: MeshThreadState }
  | {
      type: 'thread_delta';
      chatSessionId: string;
      threadId: string;
      deltaKind: 'assistant' | 'thinking';
      text: string;
    }
  | {
      type: 'assistant_delta';
      threadId: string;
      chatSessionId?: string;
      agentId?: string;
      agentName?: string;
      rootPath?: string;
      delta: string;
    }
  | {
      type: 'thinking_delta';
      threadId: string;
      chatSessionId?: string;
      delta: string;
    }
  | {
      type: 'tool_call_start';
      threadId: string;
      toolCallId: string;
      toolName: string;
      summary?: string;
      startedAt?: number;
    }
  | {
      type: 'tool_call_end';
      threadId: string;
      toolCallId: string;
      status?: 'completed' | 'failed';
      summary?: string;
      completedAt?: number;
    }
  | {
      type: 'subagent_started';
      threadId: string;
      childId: string;
      parentToolUseId?: string;
      title: string;
      startedAt?: number;
    }
  | {
      type: 'subagent_completed';
      threadId: string;
      childId: string;
      status?: 'completed' | 'failed';
      summary?: string;
      completedAt?: number;
    }
  | { type: 'bg_task_started'; threadId: string; taskId: string }
  | { type: 'bg_task_completed'; threadId: string; taskId: string }
  | {
      type: 'approval_requested';
      chatSessionId?: string;
      threadId: string;
      requestId?: string;
      toolName?: string;
      targetPath?: string;
      command?: string;
      reason?: string;
      requestedAt?: number;
      approval?: {
        requestId: string;
        threadId?: string;
        toolName: string;
        targetPath?: string | null;
        command?: string | null;
        reason?: string | null;
        requestedAt?: number | string;
      };
    }
  | {
      type: 'approval_resolved';
      chatSessionId?: string;
      threadId: string;
      requestId: string;
      decision?: MeshApprovalDecision;
      approved?: boolean;
    }
  | {
      type: 'thread_status_changed' | 'turn_settled' | 'quiescent_completed' | 'turn_error' | 'turn_interrupted';
      threadId: string;
      status?: MeshThreadStatus;
      errorMessage?: string;
      diffSummary?: MeshDiffSummary | null;
      lastCheckpointId?: string;
      externalSessionId?: string;
    }
  | {
      type: 'human_controlled_changed';
      chatSessionId?: string;
      threadId?: string;
      target?: string;
      humanControlled: boolean;
    }
  | { type: 'peer_exchange_upserted' | 'peer_exchange_updated'; chatSessionId?: string; exchange: PeerExchangeRecord }
  | { type: 'checkpoint_created' | 'checkpoint_captured'; chatSessionId?: string; checkpoint: MeshCheckpointRecord }
  | { type: 'checkpoint_reverted'; chatSessionId: string; checkpointId: string; threadId?: string }
  | { type: 'file_leases_updated'; rootPath?: string; leases: MeshFileLease[] }
  | { type: 'swarm_updated'; chatSessionId: string; swarm: SwarmSessionState | Record<string, unknown> | null }
  | { type: 'swarm_board_posted'; chatSessionId: string; post: SwarmBoardPost }
  | { type: 'swarm_board_post'; chatSessionId: string; message: SwarmBoardPost }
  | { type: 'templates_updated'; templates: CustomCliTemplate[] }
  | {
      type: 'turn_steered' | 'coordinator_wakeup';
      chatSessionId: string;
      [key: string]: unknown;
    }
  | {
      type: 'swarm_circuit_breaker';
      chatSessionId: string;
      autonomousHops: number;
      maxAutonomousHops: number;
    }
  | { type: 'session_snapshot'; snapshot: AgentMeshSessionSnapshot };

// ============================================================================
// Agent Display Helpers
// ============================================================================

const KNOWN_AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
  pi: 'Pi Agent',
  agy: 'Antigravity CLI',
  dsh: 'DeepStudent Harness',
  deepstudent: 'DeepStudent',
};

export function resolveAgentDisplayName(agentId: string, fallbackName?: string): string {
  if (fallbackName && fallbackName.trim().length > 0) return fallbackName.trim();
  const normalized = agentId.replace(/^@/, '').trim().toLowerCase();
  return KNOWN_AGENT_LABELS[normalized] ?? agentId;
}

export function normalizeAgentHandle(agentIdOrHandle: string): string {
  return agentIdOrHandle.replace(/^mesh-agent:/i, '').replace(/^@/, '').trim().toLowerCase();
}

export function formatCompactWorkspacePath(rootPath: string | undefined | null): string {
  if (!rootPath || !rootPath.trim()) return '';
  const trimmed = rootPath.trim().replace(/[\\/]+$/, '');
  const homeNormalized = trimmed.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  const segments = homeNormalized.split(/[\\/]/).filter(Boolean);
  if (segments.length <= 2) return homeNormalized;
  if (homeNormalized.startsWith('~')) {
    return `~/${segments[segments.length - 1]}`;
  }
  return segments[segments.length - 1] ?? homeNormalized;
}

export function formatWorkspaceFolderBasename(rootPath: string | undefined | null): string {
  if (!rootPath || !rootPath.trim()) return '';
  const trimmed = rootPath.trim().replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? trimmed;
}

export type CliReasoningEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const CURATED_CLI_MODELS_BY_DRIVER: Readonly<Record<string, readonly string[]>> = {
  claude: [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-fable-5-2',
    'claude-haiku-5-5',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'fable',
    'opus',
    'sonnet',
    'haiku',
  ],
  codex: [
    'gpt-6.2-sol',
    'gpt-6.2-astra',
    'gpt-6.1-terra',
    'gpt-6.1-sol',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ],
  opencode: [
    'opencode-go/gpt-6-luna',
    'opencode-go/gemini-4-argon',
    'opencode-go/deepseek-v4-pro',
    'opencode-go/claude-haiku-5-5',
    'opencode-go/glm-5.3',
    'opencode-go/kimi-k3.1-pro',
  ],
  pi: [
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'gpt-6.2-sol',
    'gemini-4-neon-high',
    'deepseek-v4-pro',
  ],
  agy: [
    'gemini-4-neon-high',
    'gemini-4-neon-medium',
    'gemini-4-carbon-high',
    'gemini-4-argon-medium',
    'gemini-4-hydrogen-high',
    'gemini-3.8-flash-high',
    'claude-opus-5-5-high',
    'claude-sonnet-5-5-high',
  ],
  dsh: [
    'deepseek-v4-pro',
    'deepseek-v4.1-flash',
    'deepseek-v4-flash',
    'deepseek-reasoner',
    'deepseek-chat',
  ],
};

export const CLI_REASONING_EFFORT_LEVELS_BY_DRIVER: Readonly<
  Record<string, readonly CliReasoningEffortLevel[]>
> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max'],
  agy: ['low', 'medium', 'high', 'xhigh', 'max'],
  pi: ['low', 'medium', 'high', 'xhigh', 'max'],
};

export function resolveCliAvailableModels(
  agent: Pick<DetectedMeshAgent, 'id' | 'driverKind' | 'defaultModel' | 'availableModels'>,
): string[] {
  const driverKey =
    agent.driverKind !== 'custom' && agent.driverKind !== 'builtin'
      ? agent.driverKind
      : normalizeAgentHandle(agent.id);
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (raw: string | null | undefined) => {
    const trimmed = raw?.trim();
    if (!trimmed) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    result.push(trimmed);
  };
  push(agent.defaultModel);
  const hasProbedCatalog = Boolean(agent.availableModels && agent.availableModels.length > 0);
  if (hasProbedCatalog) {
    for (const item of agent.availableModels!) {
      push(item);
    }
    return result;
  }
  for (const item of CURATED_CLI_MODELS_BY_DRIVER[driverKey] ?? []) {
    push(item);
  }
  return result;
}

export function resolveCliReasoningLevels(
  agentIdOrDriver: string | undefined | null,
): readonly CliReasoningEffortLevel[] {
  if (!agentIdOrDriver) return [];
  const normalized = normalizeAgentHandle(agentIdOrDriver);
  if (normalized === 'claude' || normalized.includes('claude')) {
    return CLI_REASONING_EFFORT_LEVELS_BY_DRIVER.claude;
  }
  if (normalized === 'codex' || normalized.includes('codex')) {
    return CLI_REASONING_EFFORT_LEVELS_BY_DRIVER.codex;
  }
  if (normalized === 'agy' || normalized.includes('antigravity')) {
    return CLI_REASONING_EFFORT_LEVELS_BY_DRIVER.agy;
  }
  if (normalized === 'pi') {
    return CLI_REASONING_EFFORT_LEVELS_BY_DRIVER.pi;
  }
  return CLI_REASONING_EFFORT_LEVELS_BY_DRIVER[normalized] ?? [];
}

export function formatCompactCliModelName(rawModel: string | undefined | null): string {
  const trimmed = rawModel?.trim() ?? '';
  if (!trimmed) return '';
  const slashIdx = trimmed.lastIndexOf('/');
  return slashIdx >= 0 && slashIdx < trimmed.length - 1 ? trimmed.slice(slashIdx + 1) : trimmed;
}
