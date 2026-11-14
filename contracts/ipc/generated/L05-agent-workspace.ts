// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L05-agent-workspace.json
/* eslint-disable */

/** dstu_agent::chat_v2::workspace::emitter::AgentPayload */
export type AgentPayload = {
  session_id: string;
  role: string;
  status: string;
  skill_id: string | null;
  joined_at: string;
  last_active_at: string;
};
/** dstu_agent::chat_v2::workspace::emitter::AgentStatusEvent */
export type AgentStatusEvent = {
  workspace_id: string;
  session_id: string;
  status: string;
};
/** dstu_agent::chat_v2::workspace::emitter::CoordinatorAwakenedEvent */
export type CoordinatorAwakenedEvent = {
  workspace_id: string;
  coordinator_session_id: string;
  sleep_id: string;
  awakened_by: string;
  awaken_message: string | null;
  wake_reason: string;
};
/** dstu_agent::chat_v2::workspace::emitter::DocumentPayload */
export type DocumentPayload = {
  id: string;
  doc_type: string;
  title: string;
  version: number;
  updated_by: string;
  updated_at: string;
};
/** dstu_agent::chat_v2::workspace::emitter::MessagePayload */
export type MessagePayload = {
  id: string;
  sender_session_id: string;
  target_session_id: string | null;
  message_type: string;
  content: string;
  status: string;
  created_at: string;
};
/** dstu_agent::chat_v2::runtime_roots::RuntimeDirectoryEntry */
export type RuntimeDirectoryEntry = {
  name: string;
  relativePath: string;
  kind: string;
  sizeBytes: number | null;
};
/** dstu_agent::chat_v2::runtime_roots::RuntimeDirectoryPage */
export type RuntimeDirectoryPage = {
  rootId: string;
  relativePath: string;
  entries: RuntimeDirectoryEntry[];
  nextCursor: string | null;
  truncated: boolean;
  scanned: number;
};
/** dstu_agent::chat_v2::runtime_roots::RuntimeFilePreview */
export type RuntimeFilePreview = {
  content: string;
  truncated: boolean;
};
/** dstu_agent::chat_v2::runtime_roots::RuntimeRoot */
export type RuntimeRoot = {
  id: string;
  kind: RuntimeRootKind;
  path: string;
  access: RuntimeRootAccess;
  label: string;
  description: string;
  session_scoped: boolean;
  configured: boolean;
};
/** dstu_agent::chat_v2::runtime_roots::RuntimeRootAccess */
export type RuntimeRootAccess = "read_only" | "read_write";
/** dstu_agent::chat_v2::runtime_roots::RuntimeRootAccess */
export type RuntimeRootAccess__De = ("read_only" | "read_write") | {
  read_only: null;
} | {
  read_write: null;
};
/** dstu_agent::chat_v2::runtime_roots::RuntimeRootKind */
export type RuntimeRootKind = "workspace" | "authorized" | "skill_package" | "artifact" | "temp" | "host";
/** dstu_agent::chat_v2::runtime_roots::SkillTrustState */
export type SkillTrustState = {
  skill_id: string;
  trusted: boolean;
  package_sha256: string | null;
};
/** dstu_agent::chat_v2::workspace::emitter::WorkspaceAgentEvent */
export type WorkspaceAgentEvent = {
  workspace_id: string;
  agent: AgentPayload;
};
/** dstu_agent::chat_v2::workspace::emitter::WorkspaceClosedEvent */
export type WorkspaceClosedEvent = {
  workspace_id: string;
};
/** dstu_agent::chat_v2::workspace::emitter::WorkspaceDocumentEvent */
export type WorkspaceDocumentEvent = {
  workspace_id: string;
  document: DocumentPayload;
};
/** dstu_agent::chat_v2::workspace::emitter::WorkspaceMessageEvent */
export type WorkspaceMessageEvent = {
  workspace_id: string;
  message: MessagePayload;
};
/** dstu_agent::chat_v2::workspace::emitter::WorkspaceWarningEvent */
export type WorkspaceWarningEvent = {
  workspace_id: string;
  code: string;
  message: string;
  agent_session_id: string | null;
  message_id: string | null;
  retry_count: number | null;
  max_retries: number | null;
};

export interface Commands {
  /** crates/dstu-agent/src/chat_v2/runtime_roots.rs:1871 `chat_v2_authorize_runtime_root` */
  chat_v2_authorize_runtime_root: {
    args: {
      path: string;
      label?: string | null;
      sessionId?: string | null;
    };
    result: RuntimeRoot[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/runtime_roots.rs:1965 `chat_v2_delete_artifact` */
  chat_v2_delete_artifact: {
    args: {
      sessionId: string;
      relativePath: string;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/runtime_roots.rs:1785 `chat_v2_list_runtime_directory` */
  chat_v2_list_runtime_directory: {
    args: {
      sessionId: string;
      rootId?: string | null;
      relativePath?: string | null;
      cursor?: string | null;
      limit?: number | null;
    };
    result: RuntimeDirectoryPage;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/runtime_roots.rs:1673 `chat_v2_list_runtime_roots` */
  chat_v2_list_runtime_roots: {
    args: {
      sessionId?: string | null;
    };
    result: RuntimeRoot[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/runtime_roots.rs:2551 `chat_v2_read_runtime_file` */
  chat_v2_read_runtime_file: {
    args: {
      sessionId: string;
      rootId: string;
      relativePath: string;
      maxBytes?: number | null;
    };
    result: RuntimeFilePreview;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/runtime_roots.rs:1854 `chat_v2_reset_workspace_root` */
  chat_v2_reset_workspace_root: {
    args: {
      sessionId?: string | null;
    };
    result: RuntimeRoot[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/runtime_roots.rs:1941 `chat_v2_resolve_runtime_path` */
  chat_v2_resolve_runtime_path: {
    args: {
      sessionId: string;
      rootId?: string | null;
      relativePath: string;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/runtime_roots.rs:2454 `chat_v2_revert_artifact_write` */
  chat_v2_revert_artifact_write: {
    args: {
      sessionId: string;
      relativePath: string;
      backupRef?: string | null;
      expectedAfterHash: string;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/runtime_roots.rs:2510 `chat_v2_revert_workspace_change` */
  chat_v2_revert_workspace_change: {
    args: {
      sessionId: string;
      receipt: unknown;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/runtime_roots.rs:1884 `chat_v2_revoke_runtime_root` */
  chat_v2_revoke_runtime_root: {
    args: {
      rootId: string;
      sessionId?: string | null;
    };
    result: RuntimeRoot[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/runtime_roots.rs:1601 `chat_v2_set_skill_trust` */
  chat_v2_set_skill_trust: {
    args: {
      skillId: string;
      packageRoot?: string | null;
      trusted: boolean;
    };
    result: SkillTrustState;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/runtime_roots.rs:1813 `chat_v2_set_workspace_root` */
  chat_v2_set_workspace_root: {
    args: {
      path: string;
      label?: string | null;
      access?: RuntimeRootAccess__De | null;
      sessionId?: string | null;
    };
    result: RuntimeRoot[];
    error: string;
  };
}

export interface Events {
  "workspace_agent_joined": WorkspaceAgentEvent;
  "workspace_agent_left": WorkspaceAgentEvent;
  "workspace_agent_status_changed": AgentStatusEvent;
  "workspace_closed": WorkspaceClosedEvent;
  "workspace_coordinator_awakened": CoordinatorAwakenedEvent;
  "workspace_document_updated": WorkspaceDocumentEvent;
  "workspace_message_received": WorkspaceMessageEvent;
  "workspace_warning": WorkspaceWarningEvent;
  "workspace_worker_ready": {
    workspace_id: string;
    agent_session_id: string;
    skill_id: string | null;
    restored: boolean;
    reminder: string | null;
    runtime_managed: boolean;
  } | {
    workspace_id: string;
    agent_session_id: string;
    skill_id: string | null;
    run_id: string;
    runtime_managed: boolean;
  } | {
    workspace_id: string;
    agent_session_id: string;
    skill_id: string | null;
    runtime_managed: boolean;
  } | {
    workspace_id: string;
    agent_session_id: string;
    skill_id: string | null;
  };
}

export type CommandName = keyof Commands;
export type ChatV2AuthorizeRuntimeRootCommandArgs = Commands['chat_v2_authorize_runtime_root']['args'];
export type ChatV2AuthorizeRuntimeRootCommandResult = Commands['chat_v2_authorize_runtime_root']['result'];
export type ChatV2DeleteArtifactCommandArgs = Commands['chat_v2_delete_artifact']['args'];
export type ChatV2DeleteArtifactCommandResult = Commands['chat_v2_delete_artifact']['result'];
export type ChatV2ListRuntimeDirectoryCommandArgs = Commands['chat_v2_list_runtime_directory']['args'];
export type ChatV2ListRuntimeDirectoryCommandResult = Commands['chat_v2_list_runtime_directory']['result'];
export type ChatV2ListRuntimeRootsCommandArgs = Commands['chat_v2_list_runtime_roots']['args'];
export type ChatV2ListRuntimeRootsCommandResult = Commands['chat_v2_list_runtime_roots']['result'];
export type ChatV2ReadRuntimeFileCommandArgs = Commands['chat_v2_read_runtime_file']['args'];
export type ChatV2ReadRuntimeFileCommandResult = Commands['chat_v2_read_runtime_file']['result'];
export type ChatV2ResetWorkspaceRootCommandArgs = Commands['chat_v2_reset_workspace_root']['args'];
export type ChatV2ResetWorkspaceRootCommandResult = Commands['chat_v2_reset_workspace_root']['result'];
export type ChatV2ResolveRuntimePathCommandArgs = Commands['chat_v2_resolve_runtime_path']['args'];
export type ChatV2ResolveRuntimePathCommandResult = Commands['chat_v2_resolve_runtime_path']['result'];
export type ChatV2RevertArtifactWriteCommandArgs = Commands['chat_v2_revert_artifact_write']['args'];
export type ChatV2RevertArtifactWriteCommandResult = Commands['chat_v2_revert_artifact_write']['result'];
export type ChatV2RevertWorkspaceChangeCommandArgs = Commands['chat_v2_revert_workspace_change']['args'];
export type ChatV2RevertWorkspaceChangeCommandResult = Commands['chat_v2_revert_workspace_change']['result'];
export type ChatV2RevokeRuntimeRootCommandArgs = Commands['chat_v2_revoke_runtime_root']['args'];
export type ChatV2RevokeRuntimeRootCommandResult = Commands['chat_v2_revoke_runtime_root']['result'];
export type ChatV2SetSkillTrustCommandArgs = Commands['chat_v2_set_skill_trust']['args'];
export type ChatV2SetSkillTrustCommandResult = Commands['chat_v2_set_skill_trust']['result'];
export type ChatV2SetWorkspaceRootCommandArgs = Commands['chat_v2_set_workspace_root']['args'];
export type ChatV2SetWorkspaceRootCommandResult = Commands['chat_v2_set_workspace_root']['result'];
