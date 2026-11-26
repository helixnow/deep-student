/**
 * Public Cordis service surface for `dstu.agent-mesh` (Multi-Agent Coding Mesh & Heterogeneous Swarm).
 *
 * Runtime-portable (`import type` and pure constants only) so consumers across Host & UI tests
 * can import types cleanly without pulling Node-only drivers into portable bundles.
 */
import type {} from '@deepseek-ai/cordis';
import type {
  AcquireFileLeaseResult,
  ActiveFileLease,
  AdapterCapabilities,
  AdapterRegistryPort,
  AdapterTurnStreamResult,
  AgentMeshEvent,
  BoardMessagePriority,
  BoardSenderKind,
  CheckpointPort,
  CliBinaryOverride,
  CliBinaryOverrideInput,
  CoordinatorWakeNotification,
  CustomCliTemplate,
  CustomCliTemplateInput,
  DetectedCliAgent,
  ExternalAgentDriverKind,
  ExternalCodingAdapter,
  ExternalTurnStartInput,
  FileLeaseConflict,
  FileLeasePort,
  McpInjectionSpec,
  MeshAgentKind,
  MeshBridgeHostCallbacks,
  MeshBridgeServerPort,
  MeshBridgeTokenScope,
  MeshCheckpointRecord,
  MeshDiffFile,
  MeshDiffReport,
  MeshSessionSnapshot,
  MeshThreadRecord,
  MeshThreadSnapshot,
  MeshThreadStatus,
  MeshThreadToolCallView,
  NestedSubagentStatus,
  NormalizedRuntimeEvent,
  PeerExchangeKind,
  PeerExchangeRecord,
  PeerExchangeStatus,
  PendingToolApproval,
  RevertCheckpointResult,
  StudyContextReaderPort,
  SwarmBoardMessage,
  SwarmMemberRecord,
  SwarmMemberStatus,
  SwarmSessionRecord,
  SwarmSessionSnapshot,
  SwarmSessionStatus,
  WorkspaceBindingRecord,
} from './src/contracts.ts';

export type {
  AcquireFileLeaseResult,
  ActiveFileLease,
  AdapterCapabilities,
  AdapterRegistryPort,
  AdapterTurnStreamResult,
  AgentMeshEvent,
  BoardMessagePriority,
  BoardSenderKind,
  CheckpointPort,
  CliBinaryOverride,
  CliBinaryOverrideInput,
  CoordinatorWakeNotification,
  CustomCliTemplate,
  CustomCliTemplateInput,
  DetectedCliAgent,
  ExternalAgentDriverKind,
  ExternalCodingAdapter,
  ExternalTurnStartInput,
  FileLeaseConflict,
  FileLeasePort,
  McpInjectionSpec,
  MeshAgentKind,
  MeshBridgeHostCallbacks,
  MeshBridgeServerPort,
  MeshBridgeTokenScope,
  MeshCheckpointRecord,
  MeshDiffFile,
  MeshDiffReport,
  MeshSessionSnapshot,
  MeshThreadRecord,
  MeshThreadSnapshot,
  MeshThreadStatus,
  MeshThreadToolCallView,
  NestedSubagentStatus,
  NormalizedRuntimeEvent,
  PeerExchangeKind,
  PeerExchangeRecord,
  PeerExchangeStatus,
  PendingToolApproval,
  RevertCheckpointResult,
  StudyContextReaderPort,
  SwarmBoardMessage,
  SwarmMemberRecord,
  SwarmMemberStatus,
  SwarmSessionRecord,
  SwarmSessionSnapshot,
  SwarmSessionStatus,
  WorkspaceBindingRecord,
};

export interface StartMeshTurnInput {
  chatSessionId: string;
  agentId: string;
  rosterName?: string;
  prompt: string;
  userPrompt?: string;
  rootPath?: string;
  threadId?: string;
  resumeSessionId?: string | null;
  contextText?: string | null;
  ownedGlobs?: string[];
  awaitCompletion?: boolean;
  readOnly?: boolean;
  model?: string;
  reasoningEffort?: string;
  timelineMode?: 'native_chat' | 'headless';
  userMessageId?: string;
  assistantMessageId?: string;
  skipUserMessageSave?: boolean;
  signal?: AbortSignal;
}

export interface StartMeshTurnResult {
  threadId: string;
  status: MeshThreadStatus;
  queued: boolean;
  thread: MeshThreadSnapshot;
  nativeTimelineAttached?: boolean;
  assistantText?: string;
  checkpointAfter?: MeshCheckpointRecord | null;
  diff?: MeshDiffReport | null;
}

export interface SteerMeshTurnInput {
  threadId?: string;
  chatSessionId?: string;
  agentId?: string;
  rosterName?: string;
  text: string;
  interruptIfUnsupported?: boolean;
}

export interface SteerMeshTurnResult {
  delivered: boolean;
  mode: 'mid_turn_steer' | 'queued_at_head' | 'interrupt_and_resume' | 'started_turn';
  threadId: string;
  canInterruptAndResume: boolean;
}

export interface InterruptMeshTurnInput {
  threadId?: string;
  chatSessionId?: string;
  reason?: string;
}

export interface RespondMeshApprovalInput {
  threadId?: string;
  requestId: string;
  approved: boolean;
  scope?: 'once' | 'session';
  reason?: string;
}

export interface SetHumanControlledInput {
  chatSessionId: string;
  threadId?: string;
  rosterName?: string;
  agentId?: string;
  humanControlled: boolean;
}

export interface GetCheckpointDiffInput {
  checkpointId?: string;
  fromCheckpointId?: string;
  toCheckpointId?: string;
  chatSessionId?: string;
  threadId?: string;
  rootPath?: string;
  agentId?: string;
}

export interface RevertCheckpointInput {
  checkpointId: string;
  chatSessionId?: string;
  rootPath?: string;
  paths?: string[];
  forceOverwriteUserEdits?: boolean;
}

export interface SwarmMemberInitInput {
  rosterName: string;
  agentId: string;
  roleTitle?: string;
  ownedGlobs?: string[];
}

export type SwarmControlAction =
  | 'start'
  | 'init'
  | 'create'
  | 'add_member'
  | 'addMember'
  | 'remove_member'
  | 'removeMember'
  | 'swap_member_cli'
  | 'swap_agent'
  | 'swapAgent'
  | 'handoff_member'
  | 'post'
  | 'post_board'
  | 'post_message'
  | 'postMessage'
  | 'read_board'
  | 'readBoard'
  | 'pause'
  | 'resume'
  | 'reset_circuit_breaker'
  | 'emergency_stop_all'
  | 'complete'
  | 'close'
  | 'stop'
  | 'set_max_hops'
  | 'setMaxHops'
  | 'status';

export interface SwarmControlInput {
  action: SwarmControlAction;
  chatSessionId: string;
  title?: string;
  goal?: string;
  coordinatorAgent?: string;
  maxAutonomousHops?: number;
  members?: SwarmMemberInitInput[];
  initialBrief?: string;
  rosterName?: string;
  agentId?: string;
  targetAgentId?: string;
  roleTitle?: string;
  ownedGlobs?: string[];
  summary?: string;
  nextTask?: string;
  sender?: string;
  senderKind?: BoardSenderKind;
  priority?: BoardMessagePriority;
  text?: string;
  mentions?: string[];
  channel?: string;
  replyToSeq?: number;
  diffRef?: string;
  sinceSeq?: number;
  limit?: number;
  stopActiveThreads?: boolean;
}

export interface AskPeerInput {
  chatSessionId: string;
  fromAgent: string;
  targetAgent: string;
  question: string;
  contextPaths?: string[];
  rootPath?: string;
  signal?: AbortSignal;
}

export interface HandoffInput {
  chatSessionId: string;
  fromAgent: string;
  fromThreadId?: string;
  targetAgent: string;
  summary: string;
  nextTask: string;
  changedFiles?: string[];
  rootPath?: string;
  awaitCompletion?: boolean;
  signal?: AbortSignal;
}

export interface AgentMeshService {
  probeAgents(options?: { forceRefresh?: boolean }): Promise<DetectedCliAgent[]>;
  getWorkspaceBinding(chatSessionId: string | { chatSessionId?: string; sessionId?: string }): Promise<WorkspaceBindingRecord | null>;
  setWorkspaceBinding(
    input: { chatSessionId?: string; sessionId?: string; rootPath: string | null } | string,
    rootPath?: string | null,
  ): Promise<WorkspaceBindingRecord | null>;
  startTurn(input: StartMeshTurnInput): Promise<StartMeshTurnResult>;
  steerTurn(input: SteerMeshTurnInput | string, text?: string): Promise<SteerMeshTurnResult>;
  interruptTurn(input: InterruptMeshTurnInput | string, reason?: string): Promise<{ interruptedThreadIds: string[] }>;
  respondApproval(input: RespondMeshApprovalInput): Promise<{ delivered: boolean; threadId: string | null }>;
  setHumanControlled(input: SetHumanControlledInput): Promise<{ chatSessionId: string; target: string; humanControlled: boolean }>;
  getSessionSnapshot(chatSessionId: string | { chatSessionId?: string; sessionId?: string }): Promise<MeshSessionSnapshot>;
  getCheckpointDiff(input: GetCheckpointDiffInput | string): Promise<MeshDiffReport>;
  revertCheckpoint(input: RevertCheckpointInput | string, paths?: string[]): Promise<RevertCheckpointResult & { checkpointId: string }>;
  swarmControl(input: SwarmControlInput): Promise<unknown>;
  saveCustomCliTemplate(input: CustomCliTemplateInput): Promise<CustomCliTemplate>;
  deleteCustomCliTemplate(input: { id: string } | string): Promise<{ deleted: boolean; id: string }>;
  saveCliOverride(input: CliBinaryOverrideInput): Promise<CliBinaryOverride | null>;
  deleteCliOverride(input: { agentId: string } | string): Promise<{ deleted: boolean; agentId: string }>;
  askPeer(input: AskPeerInput): Promise<PeerExchangeRecord>;
  handoff(input: HandoffInput): Promise<{ exchange: PeerExchangeRecord; targetTurn: StartMeshTurnResult }>;
}

export const AGENT_MESH_REMOTE_METHODS = [
  'probeAgents',
  'getWorkspaceBinding',
  'setWorkspaceBinding',
  'startTurn',
  'steerTurn',
  'interruptTurn',
  'respondApproval',
  'setHumanControlled',
  'getSessionSnapshot',
  'getCheckpointDiff',
  'revertCheckpoint',
  'swarmControl',
  'saveCustomCliTemplate',
  'deleteCustomCliTemplate',
  'saveCliOverride',
  'deleteCliOverride',
  'askPeer',
  'handoff',
] as const;

export const AGENT_MESH_EVENT_NAME = 'agent-mesh:event' as const;

export const agentMeshService = { name: 'agentMesh', version: '1.0.0' } as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentMesh: AgentMeshService;
  }
}
