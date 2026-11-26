// Core protocol types, capabilities, and normalized runtime events for external coding CLIs.

export const EXTERNAL_AGENT_DRIVER_KINDS = [
  'claude',
  'codex',
  'opencode',
  'pi',
  'agy',
  'dsh',
  'custom',
] as const;

export type ExternalAgentDriverKind = (typeof EXTERNAL_AGENT_DRIVER_KINDS)[number];

export interface AdapterCapabilities {
  readonly streamingEvents: boolean;
  readonly midTurnSteer: boolean;
  readonly interrupt: boolean;
  readonly approvalCallback: boolean;
  readonly sessionResume: boolean;
  readonly sessionFork: boolean;
  readonly nativeSubagentTree: boolean;
  readonly backgroundTaskEvents: boolean;
  readonly mcpInjection: boolean;
}

export type CliAuthStatus = 'authenticated' | 'unauthenticated' | 'unknown';

export interface DetectedCliAgent {
  readonly id: string;
  readonly driver: ExternalAgentDriverKind;
  readonly displayName: string;
  readonly command: string;
  readonly resolvedPath: string | null;
  readonly installed: boolean;
  readonly version: string | null;
  readonly authStatus: CliAuthStatus;
  readonly authHint?: string;
  readonly defaultModel?: string | null;
  readonly availableModels?: readonly string[];
  readonly capabilities: AdapterCapabilities;
  readonly probedAt: number;
  readonly templateId?: string;
}

export interface CustomCliTemplate {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly argsTemplate: readonly string[];
  readonly resumeArgsTemplate?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly promptMode?: 'arg' | 'stdin';
  readonly outputFormat?: 'auto' | 'jsonl' | 'text';
  readonly capabilitiesOverride?: Partial<AdapterCapabilities>;
}

export interface McpInjectionSpec {
  readonly httpUrl: string;
  readonly bearerToken: string;
  readonly shimBinDir?: string;
  readonly envVars?: Readonly<Record<string, string>>;
}

export interface ExternalTurnStartInput {
  readonly threadId: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly resumeSessionId?: string;
  readonly forkSession?: boolean;
  readonly mcp?: McpInjectionSpec;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly onEvent?: (event: NormalizedRuntimeEvent) => void;
}

export interface ActiveChildSubagentSummary {
  readonly id: string;
  readonly title: string;
  readonly parentToolUseId?: string | null;
  readonly startedAt: number;
}

export type NormalizedRuntimeEvent =
  | {
      readonly type: 'session_bound';
      readonly threadId: string;
      readonly externalSessionId: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'assistant_delta';
      readonly threadId: string;
      readonly text: string;
      readonly messageId?: string;
      readonly parentToolUseId?: string | null;
      readonly timestamp: number;
    }
  | {
      readonly type: 'thinking_delta';
      readonly threadId: string;
      readonly text: string;
      readonly parentToolUseId?: string | null;
      readonly timestamp: number;
    }
  | {
      readonly type: 'tool_call_start';
      readonly threadId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: Readonly<Record<string, unknown>>;
      readonly parentToolUseId?: string | null;
      readonly timestamp: number;
    }
  | {
      readonly type: 'tool_call_end';
      readonly threadId: string;
      readonly toolCallId: string;
      readonly toolName?: string;
      readonly output?: string;
      readonly isError?: boolean;
      readonly parentToolUseId?: string | null;
      readonly timestamp: number;
    }
  | {
      readonly type: 'subagent_started';
      readonly threadId: string;
      readonly parentToolUseId: string | null;
      readonly childId: string;
      readonly title: string;
      readonly agentType?: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'subagent_completed';
      readonly threadId: string;
      readonly childId: string;
      readonly parentToolUseId?: string | null;
      readonly status?: 'completed' | 'failed' | 'stopped';
      readonly summary?: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'bg_task_started';
      readonly threadId: string;
      readonly taskId: string;
      readonly title?: string;
      readonly command?: string;
      readonly pid?: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'bg_task_completed';
      readonly threadId: string;
      readonly taskId: string;
      readonly exitCode?: number | null;
      readonly summary?: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'approval_requested';
      readonly threadId: string;
      readonly requestId: string;
      readonly toolName: string;
      readonly targetPath?: string;
      readonly command?: string;
      readonly reason?: string;
      readonly rawInput?: Readonly<Record<string, unknown>>;
      readonly timestamp: number;
    }
  | {
      readonly type: 'waiting_children';
      readonly threadId: string;
      readonly activeSubagents: readonly ActiveChildSubagentSummary[];
      readonly activeBgTasks: readonly string[];
      readonly timestamp: number;
    }
  | {
      readonly type: 'turn_settled';
      readonly threadId: string;
      readonly externalSessionId?: string;
      readonly stopReason?: string;
      readonly waitingForChildren: boolean;
      readonly timestamp: number;
    }
  | {
      readonly type: 'quiescent_completed';
      readonly threadId: string;
      readonly externalSessionId?: string;
      readonly timedOut?: boolean;
      readonly timestamp: number;
    }
  | {
      readonly type: 'turn_error';
      readonly threadId: string;
      readonly message: string;
      readonly code?: string;
      readonly recoverable?: boolean;
      readonly timestamp: number;
    }
  | {
      readonly type: 'turn_interrupted';
      readonly threadId: string;
      readonly reason?: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'usage';
      readonly threadId: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedInputTokens?: number;
      readonly totalCostUsd?: number;
      readonly timestamp: number;
    };

export type ApprovalDecisionKind = 'allow_once' | 'allow_for_session' | 'allow' | 'deny';

export interface ApprovalResponseInput {
  readonly decision: ApprovalDecisionKind;
  readonly reason?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
}

export interface SteerResult {
  readonly accepted: boolean;
  readonly mode: 'native_steer' | 'stdin_frame' | 'unsupported' | 'not_running';
  readonly reason?: string;
}

export interface ExternalCodingAdapter {
  readonly driver: ExternalAgentDriverKind;
  readonly capabilities: AdapterCapabilities;
  startOrResumeTurn(input: ExternalTurnStartInput): AsyncIterable<NormalizedRuntimeEvent>;
  steer(threadId: string, message: string): Promise<SteerResult>;
  interrupt(threadId: string): Promise<void>;
  respondApproval(
    threadId: string,
    requestId: string,
    response: ApprovalResponseInput | ApprovalDecisionKind,
  ): Promise<boolean>;
  dispose(): Promise<void>;
}

export function normalizeApprovalResponse(
  response: ApprovalResponseInput | ApprovalDecisionKind,
): ApprovalResponseInput {
  if (typeof response === 'string') {
    return { decision: response };
  }
  return response;
}

export function isApprovalAllowed(decision: ApprovalDecisionKind): boolean {
  return decision === 'allow_once' || decision === 'allow_for_session' || decision === 'allow';
}
