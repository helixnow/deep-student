import React from 'react';

export const LazySwarmCapsuleBar = React.lazy(() =>
  import('./components/SwarmCapsuleBar').then((m) => ({ default: m.SwarmCapsuleBar })),
);

export const LazySessionMeshStreamSection = React.lazy(() =>
  import('./components/SessionMeshStreamSection').then((m) => ({
    default: m.SessionMeshStreamSection,
  })),
);

export {
  resolveAgentDisplayName,
  normalizeAgentHandle,
  formatCompactWorkspacePath,
  formatWorkspaceFolderBasename,
  CURATED_CLI_MODELS_BY_DRIVER,
  CLI_REASONING_EFFORT_LEVELS_BY_DRIVER,
  resolveCliAvailableModels,
  resolveCliReasoningLevels,
  formatCompactCliModelName,
  type CliReasoningEffortLevel,
  type ExternalAgentDriverKind,
  type MeshAgentDriverKind,
  type AdapterCapabilities,
  type DetectedAgentRuntimeStatus,
  type DetectedMeshAgent,
  type CustomCliTemplate,
  type WorkspaceBinding,
  type MeshThreadStatus,
  type MeshChildSubagent,
  type MeshApprovalDecision,
  type MeshPendingApproval,
  type MeshDiffFileEntry,
  type MeshDiffSummary,
  type MeshToolCallItem,
  type MeshThreadState,
  type PeerExchangeMessage,
  type PeerExchangeRecord,
  type MeshCheckpointRecord,
  type MeshFileLease,
  type SwarmMemberStatus,
  type SwarmMemberRecord,
  type SwarmBoardPost,
  type SwarmSessionState,
  type WorkbenchOpenState,
  type AgentMeshSessionSnapshot,
  type SelectedPagesContextSnapshot,
  type StartExternalTurnRequest,
  type SteerExternalTurnRequest,
  type InterruptExternalTurnRequest,
  type RespondApprovalRequest,
  type SetHumanControlledRequest,
  type SetWorkspaceBindingRequest,
  type GetCheckpointDiffRequest,
  type RevertCheckpointRequest,
  type RevertCheckpointResult,
  type SwarmControlAction,
  type SwarmControlRequest,
  type AskPeerRequest,
  type HandoffRequest,
  type AgentMeshHostBridge,
  type AgentMeshBackendEvent,
} from './types';

export {
  useAgentMeshStore,
  isExternalThreadActiveStatus,
  selectInstalledExternalAgents,
  selectActiveExternalThreadForSession,
  selectSelectedCliForSession,
  selectSelectedCliModelForSession,
  selectSelectedCliEffortForSession,
  selectSessionThreads,
  selectHasSessionMeshActivity,
  resetAgentMeshStore,
  type AgentMeshStoreState,
} from './store/useAgentMeshStore';

export {
  registerAgentMeshHostBridge,
  registerAgentMeshHostCaller,
  isAgentMeshHostConnected,
  applyAgentMeshBackendEvent,
  normalizeHostDetectedAgent,
  normalizeHostSwarmState,
  agentMeshHost,
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
  type GenericAgentMeshHostCaller,
} from './hostBridge';

export { WorkspaceFolderPill, type WorkspaceFolderPillProps } from './components/WorkspaceFolderPill';
export type { InlineExternalTurnCardProps } from './components/InlineExternalTurnCard';
export type { PeerExchangeStripProps } from './components/PeerExchangeStrip';
export {
  SessionMeshStreamSection,
  type SessionMeshStreamSectionProps,
} from './components/SessionMeshStreamSection';

export * from './workbenchPublic';
