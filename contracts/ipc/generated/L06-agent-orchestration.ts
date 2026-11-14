// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L06-agent-orchestration.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** dstu_agent::chat_v2::automations::AutomationActionType */
export type AutomationActionType = ("notify" | "agent_turn") | {
  notify: null;
} | {
  agent_turn: null;
};
/** dstu_agent::chat_v2::automations::AutomationCreateCommandRequest */
export type AutomationCreateCommandRequest = {
  name: string;
  schedule: AutomationScheduleCommandRequest;
  prompt: string;
  enabled?: boolean;
  actionType?: AutomationActionType;
  agentPrompt?: string | null;
  sessionMode?: HeadlessSessionMode | null;
  modelId?: string | null;
  catchUpPolicy?: CatchUpPolicy;
  maxRetries?: number;
  retryBackoffSeconds?: number;
  timeoutSeconds?: number;
  trustedProfile?: TrustedAutomationProfile | null;
};
/** dstu_agent::chat_v2::automations::AutomationRootAccess */
export type AutomationRootAccess = ("read_only" | "read_write") | {
  read_only: null;
} | {
  read_write: null;
};
/** dstu_agent::chat_v2::automations::AutomationRuntimeRoot */
export type AutomationRuntimeRoot = {
  rootId: string;
  access: AutomationRootAccess;
};
/** dstu_agent::chat_v2::automations::AutomationScheduleCommandRequest */
export type AutomationScheduleCommandRequest = {
  kind: ScheduleKind;
  time?: string;
  weekday?: number | null;
  weekdays?: number[] | null;
  dayOfMonth?: number | null;
  intervalMinutes?: number | null;
  date?: string | null;
  timezone?: string | null;
};
/** dstu_agent::chat_v2::automations::AutomationUpdateCommandRequest */
export type AutomationUpdateCommandRequest = {
  automationId: string;
  expectedVersion: number;
  name?: string | null;
  schedule?: AutomationScheduleCommandRequest | null;
  prompt?: string | null;
  actionType?: AutomationActionType | null;
  agentPrompt?: string | null;
  sessionMode?: HeadlessSessionMode | null;
  modelId?: string | null;
  catchUpPolicy?: CatchUpPolicy | null;
  maxRetries?: number | null;
  retryBackoffSeconds?: number | null;
  timeoutSeconds?: number | null;
  trustedProfile?: TrustedAutomationProfile | null;
};
/** dstu_agent::chat_v2::automations::CatchUpPolicy */
export type CatchUpPolicy = ("skip" | "run_once" | "catch_up_all") | {
  skip: null;
} | {
  run_once: null;
} | {
  catch_up_all: null;
};
/** dstu_agent::chat_v2::super_session::state::ChangedPayload */
export type ChangedPayload = {
  enabled: boolean;
  sessionId: string | null;
};
/** dstu_agent::chat_v2::super_session::inbox::DeliverInboxRequest */
export type DeliverInboxRequest = {
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  options?: Shared.SendOptions;
  force?: boolean;
};
/** dstu_agent::chat_v2::super_session::inbox::DeliverOutcome */
export type DeliverOutcome = {
  status: "started";
  userMessage: DeliveredUserMessage;
  assistantMessageId: string;
} | {
  status: "empty";
} | {
  status: "busy";
} | {
  status: "disabled";
} | {
  status: "paused";
  autoTurns: number;
};
/** dstu_agent::chat_v2::super_session::inbox::DeliveredUserMessage */
export type DeliveredUserMessage = {
  id: string;
  content: string;
  timestampMs: number;
  inboundOrigin: unknown;
};
/** dstu_agent::chat_v2::headless::HeadlessSessionMode */
export type HeadlessSessionMode = ("isolated" | "named") | {
  isolated: null;
} | {
  named: null;
};
/** dstu_agent::chat_v2::super_session::state::InboxChangedPayload */
export type InboxChangedPayload = {
  sessionId: string;
  pendingInbox: number;
};
/** dstu_agent::chat_v2::automations::ScheduleKind */
export type ScheduleKind = ("daily" | "weekly" | "weekdays" | "monthly" | "interval" | "once") | {
  daily: null;
} | {
  weekly: null;
} | {
  weekdays: null;
} | {
  monthly: null;
} | {
  interval: null;
} | {
  once: null;
};
/** dstu_agent::chat_v2::super_session::state::SuperSessionSettings */
export type SuperSessionSettings = {
  instructions: string;
};
/** dstu_agent::chat_v2::super_session::state::SuperSessionSettings */
export type SuperSessionSettings__De = {
  instructions?: string;
};
/** dstu_agent::chat_v2::super_session::state::SuperSessionState */
export type SuperSessionState = {
  enabled: boolean;
  sessionId: string | null;
  workspaceId: string | null;
  pendingInbox: number;
};
/** dstu_agent::chat_v2::automations::TrustedAutomationProfile */
export type TrustedAutomationProfile = {
  schemaVersion: number;
  profileHash: string;
  allowedTools: string[];
  runtimeRoots: AutomationRuntimeRoot[];
  shellCommandPrefixes: string[];
  networkDomains: string[];
  maxToolRounds: number;
  timeoutSeconds: number;
  maxOutputBytes: number;
  rollbackRequired: boolean;
};

export interface Commands {
  /** crates/dstu-agent/src/chat_v2/automations.rs:4657 `chat_v2_automation_cancel_run` */
  chat_v2_automation_cancel_run: {
    args: {
      runId: string;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/automations.rs:4435 `chat_v2_automation_create` */
  chat_v2_automation_create: {
    args: {
      request: AutomationCreateCommandRequest;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/automations.rs:4816 `chat_v2_automation_delete` */
  chat_v2_automation_delete: {
    args: {
      automationId: string;
      expectedVersion: number;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/automations.rs:4424 `chat_v2_automation_list` */
  chat_v2_automation_list: {
    args: Record<string, never>;
    result: unknown;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/automations.rs:4641 `chat_v2_automation_retry_run` */
  chat_v2_automation_retry_run: {
    args: {
      runId: string;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/automations.rs:4959 `chat_v2_automation_run_now` */
  chat_v2_automation_run_now: {
    args: {
      automationId: string;
      expectedVersion: number;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/automations.rs:4553 `chat_v2_automation_runs` */
  chat_v2_automation_runs: {
    args: {
      automationId?: string | null;
      limit?: number | null;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/automations.rs:4794 `chat_v2_automation_set_background_enabled` */
  chat_v2_automation_set_background_enabled: {
    args: {
      enabled: boolean;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/automations.rs:4474 `chat_v2_automation_set_enabled` */
  chat_v2_automation_set_enabled: {
    args: {
      automationId: string;
      expectedVersion: number;
      enabled: boolean;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/automations.rs:4673 `chat_v2_automation_summary` */
  chat_v2_automation_summary: {
    args: Record<string, never>;
    result: unknown;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/automations.rs:4498 `chat_v2_automation_update` */
  chat_v2_automation_update: {
    args: {
      request: AutomationUpdateCommandRequest;
    };
    result: unknown;
    error: string;
  };
  /** host/plugins/agent-orchestration/src/plugin.ts */
  chat_v2_background_subagent: {
    args: {
      sessionId: string;
      blockId: string;
    };
    result: boolean;
    error: never;
  };
  /** crates/dstu-agent/src/chat_v2/super_session/commands.rs:58 `chat_v2_super_deliver_inbox` */
  chat_v2_super_deliver_inbox: {
    args: {
      request: DeliverInboxRequest;
    };
    result: DeliverOutcome;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/super_session/commands.rs:32 `super_session_ensure` */
  super_session_ensure: {
    args: Record<string, never>;
    result: SuperSessionState;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/super_session/commands.rs:42 `super_session_get_settings` */
  super_session_get_settings: {
    args: Record<string, never>;
    result: SuperSessionSettings;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/super_session/commands.rs:17 `super_session_get_state` */
  super_session_get_state: {
    args: Record<string, never>;
    result: SuperSessionState;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/super_session/commands.rs:23 `super_session_set_enabled` */
  super_session_set_enabled: {
    args: {
      enabled: boolean;
    };
    result: SuperSessionState;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/super_session/commands.rs:48 `super_session_set_settings` */
  super_session_set_settings: {
    args: {
      settings: SuperSessionSettings__De;
    };
    result: null;
    error: string;
  };
}

export interface Events {
  "chat_v2://automations_changed": {
    action: string;
    automationId: string;
  };
  "chat_v2_automation_run_completed": {
    automationId: string;
    automationName: string;
    sessionId: string | null;
    runId: string;
    attempt: number;
    status: string;
    summary: string;
    heartbeat: boolean;
    osNotificationDelivered: boolean;
  } | {
    automationId: string;
    automationName: string;
    sessionId: unknown;
    runId: string;
    attempt: number;
    status: string;
    summary: string;
    heartbeat: boolean;
    osNotificationDelivered: boolean;
  };
  [name: `chat_v2_session_${string}`]: ({
    eventType: string;
    messageId: string;
    variantId: string;
    remainingCount: number;
    newActiveVariantId: string | null;
  } | {
    sessionId: string;
    eventType: string;
    messageId: string;
    retryAttempt: number;
    retryMax: number;
    timestamp: number;
  } | unknown);
  "session_management_change": {
    tool: string;
    sessionId: string;
  };
  "super_session_changed": ChangedPayload;
  "super_session_inbox_changed": InboxChangedPayload;
  "todo://changed": {
    source: string;
    action: string;
    entityIds: string[];
    runId: string;
  } | {
    source: string;
    action: string;
    entityIds: string[];
  } | {
    source: string;
    action: string;
  };
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
export type ChatV2AutomationCancelRunCommandArgs = Commands['chat_v2_automation_cancel_run']['args'];
export type ChatV2AutomationCancelRunCommandResult = Commands['chat_v2_automation_cancel_run']['result'];
export type ChatV2AutomationCreateCommandArgs = Commands['chat_v2_automation_create']['args'];
export type ChatV2AutomationCreateCommandResult = Commands['chat_v2_automation_create']['result'];
export type ChatV2AutomationDeleteCommandArgs = Commands['chat_v2_automation_delete']['args'];
export type ChatV2AutomationDeleteCommandResult = Commands['chat_v2_automation_delete']['result'];
export type ChatV2AutomationListCommandArgs = Commands['chat_v2_automation_list']['args'];
export type ChatV2AutomationListCommandResult = Commands['chat_v2_automation_list']['result'];
export type ChatV2AutomationRetryRunCommandArgs = Commands['chat_v2_automation_retry_run']['args'];
export type ChatV2AutomationRetryRunCommandResult = Commands['chat_v2_automation_retry_run']['result'];
export type ChatV2AutomationRunNowCommandArgs = Commands['chat_v2_automation_run_now']['args'];
export type ChatV2AutomationRunNowCommandResult = Commands['chat_v2_automation_run_now']['result'];
export type ChatV2AutomationRunsCommandArgs = Commands['chat_v2_automation_runs']['args'];
export type ChatV2AutomationRunsCommandResult = Commands['chat_v2_automation_runs']['result'];
export type ChatV2AutomationSetBackgroundEnabledCommandArgs = Commands['chat_v2_automation_set_background_enabled']['args'];
export type ChatV2AutomationSetBackgroundEnabledCommandResult = Commands['chat_v2_automation_set_background_enabled']['result'];
export type ChatV2AutomationSetEnabledCommandArgs = Commands['chat_v2_automation_set_enabled']['args'];
export type ChatV2AutomationSetEnabledCommandResult = Commands['chat_v2_automation_set_enabled']['result'];
export type ChatV2AutomationSummaryCommandArgs = Commands['chat_v2_automation_summary']['args'];
export type ChatV2AutomationSummaryCommandResult = Commands['chat_v2_automation_summary']['result'];
export type ChatV2AutomationUpdateCommandArgs = Commands['chat_v2_automation_update']['args'];
export type ChatV2AutomationUpdateCommandResult = Commands['chat_v2_automation_update']['result'];
export type ChatV2BackgroundSubagentCommandArgs = Commands['chat_v2_background_subagent']['args'];
export type ChatV2BackgroundSubagentCommandResult = Commands['chat_v2_background_subagent']['result'];
export type ChatV2SuperDeliverInboxCommandArgs = Commands['chat_v2_super_deliver_inbox']['args'];
export type ChatV2SuperDeliverInboxCommandResult = Commands['chat_v2_super_deliver_inbox']['result'];
export type SuperSessionEnsureCommandArgs = Commands['super_session_ensure']['args'];
export type SuperSessionEnsureCommandResult = Commands['super_session_ensure']['result'];
export type SuperSessionGetSettingsCommandArgs = Commands['super_session_get_settings']['args'];
export type SuperSessionGetSettingsCommandResult = Commands['super_session_get_settings']['result'];
export type SuperSessionGetStateCommandArgs = Commands['super_session_get_state']['args'];
export type SuperSessionGetStateCommandResult = Commands['super_session_get_state']['result'];
export type SuperSessionSetEnabledCommandArgs = Commands['super_session_set_enabled']['args'];
export type SuperSessionSetEnabledCommandResult = Commands['super_session_set_enabled']['result'];
export type SuperSessionSetSettingsCommandArgs = Commands['super_session_set_settings']['args'];
export type SuperSessionSetSettingsCommandResult = Commands['super_session_set_settings']['result'];
