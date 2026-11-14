// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L01-llm-providers.json
/* eslint-disable */

/** dstu_llm::openai_codex::error::CodexAuthErrorDto */
export type CodexAuthErrorDto = {
  code: string;
  message: string;
  class: CodexErrorClass;
};
/** dstu_llm::openai_codex::types::CodexAuthPhase */
export type CodexAuthPhase = "signed_out" | "authorizing" | "authenticated" | "refreshing" | "reauthentication_required" | "error";
/** dstu_llm::openai_codex::types::CodexAuthStatus */
export type CodexAuthStatus = {
  phase: CodexAuthPhase;
  hasUsableSession: boolean;
  accountHint: string | null;
  email: string | null;
  planType: string | null;
  isFedramp: boolean;
  expiresAtUnixMs: number | null;
  generation: number;
  activeLoginKind: CodexLoginKind | null;
  activeAttemptId: string | null;
  authorizationUrl: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  pollIntervalSeconds: number | null;
  lastError: CodexAuthErrorDto | null;
};
/** dstu_llm::openai_codex::error::CodexErrorClass */
export type CodexErrorClass = "cancelled" | "transient" | "permanent" | "reauthentication_required" | "security";
/** dstu_llm::openai_codex::types::CodexLoginKind */
export type CodexLoginKind = "browser" | "device";
/** dstu_llm::openai_codex::types::CodexRateLimitWindow */
export type CodexRateLimitWindow = {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
};
/** dstu_llm::openai_codex::types::CodexRateLimits */
export type CodexRateLimits = {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
};
/** dstu_llm::openai_codex::types::CodexUsageSnapshot */
export type CodexUsageSnapshot = {
  rateLimits?: CodexRateLimits | null;
  rateLimitsByLimitId?: { [key: string]: CodexRateLimits };
  fetchedAt: number;
};

export interface Commands {
  /** src/cmd/openai_codex.rs:12 `openai_codex_auth_status` */
  openai_codex_auth_status: {
    args: Record<string, never>;
    result: CodexAuthStatus;
    error: string;
  };
  /** src/cmd/openai_codex.rs:36 `openai_codex_login_cancel` */
  openai_codex_login_cancel: {
    args: {
      attemptId: string;
    };
    result: null;
    error: string;
  };
  /** src/cmd/openai_codex.rs:19 `openai_codex_login_start` */
  openai_codex_login_start: {
    args: {
      flow: string;
    };
    result: unknown;
    error: string;
  };
  /** src/cmd/openai_codex.rs:48 `openai_codex_logout` */
  openai_codex_logout: {
    args: Record<string, never>;
    result: null;
    error: string;
  };
  /** src/cmd/openai_codex.rs:57 `openai_codex_usage` */
  openai_codex_usage: {
    args: Record<string, never>;
    result: CodexUsageSnapshot;
    error: string;
  };
}

export interface Events {
}

export type CommandName = keyof Commands;
export type OpenaiCodexAuthStatusCommandArgs = Commands['openai_codex_auth_status']['args'];
export type OpenaiCodexAuthStatusCommandResult = Commands['openai_codex_auth_status']['result'];
export type OpenaiCodexLoginCancelCommandArgs = Commands['openai_codex_login_cancel']['args'];
export type OpenaiCodexLoginCancelCommandResult = Commands['openai_codex_login_cancel']['result'];
export type OpenaiCodexLoginStartCommandArgs = Commands['openai_codex_login_start']['args'];
export type OpenaiCodexLoginStartCommandResult = Commands['openai_codex_login_start']['result'];
export type OpenaiCodexLogoutCommandArgs = Commands['openai_codex_logout']['args'];
export type OpenaiCodexLogoutCommandResult = Commands['openai_codex_logout']['result'];
export type OpenaiCodexUsageCommandArgs = Commands['openai_codex_usage']['args'];
export type OpenaiCodexUsageCommandResult = Commands['openai_codex_usage']['result'];
