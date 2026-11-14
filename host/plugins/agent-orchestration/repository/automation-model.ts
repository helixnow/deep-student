/**
 * 自动化定义/运行记录共享模型，以及 repository 内部的 SQL 参数与错误辅助。
 *
 * 定义侧 SQL 在 `automation-definitions.ts`，运行侧 SQL 在 `automation-runs.ts`；
 * 本文件不执行任何业务 SQL，只保留类型、常量和跨两模块复用的纯工具。
 */
import type { SqlValue } from '../../../platform/storage/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import {
  type AutomationSchedule, type CatchUpPolicy, formatTimestampMillis,
} from '../src/automation-schedule.ts';
import type { TrustedAutomationProfile } from '../src/trusted-profile.ts';
import { localNodeRuntime } from '../src/local-node-runtime.ts';

export type ActionType = 'notify' | 'agent_turn';
export type HeadlessSessionMode = 'isolated' | 'named';

export interface AutomationDefinition {
  id: string;
  name: string;
  schedule: AutomationSchedule;
  prompt: string;
  enabled: boolean;
  created_at: string;
  session_id: string;
  last_run_at: string | null;
  next_run_at: string | null;
  action_type: ActionType;
  heartbeat: boolean;
  agent_prompt: string | null;
  session_mode: HeadlessSessionMode | null;
  model_id: string | null;
  agent_session_id: string | null;
  catch_up_policy: CatchUpPolicy;
  max_retries: number;
  retry_backoff_seconds: number;
  timeout_seconds: number;
  trusted_profile: TrustedAutomationProfile | null;
  version: number;
}

export interface AutomationCreateFields {
  name: string;
  schedule: AutomationSchedule;
  prompt: string;
  enabled: boolean;
  action_type: ActionType;
  heartbeat: boolean;
  agent_prompt: string | null;
  session_mode: HeadlessSessionMode | null;
  model_id: string | null;
  catch_up_policy: CatchUpPolicy;
  max_retries: number;
  retry_backoff_seconds: number;
  timeout_seconds: number;
  trusted_profile: TrustedAutomationProfile | null;
  source_session_id: string;
}

export interface OptionalValue<T> { value: T | null }
export interface AutomationUpdateFields {
  name?: string;
  schedule?: AutomationSchedule;
  prompt?: string;
  actionType?: ActionType;
  agentPrompt?: OptionalValue<string>;
  sessionMode?: OptionalValue<HeadlessSessionMode>;
  modelId?: OptionalValue<string>;
  catchUpPolicy?: CatchUpPolicy;
  maxRetries?: number;
  retryBackoffSeconds?: number;
  timeoutSeconds?: number;
  trustedProfile?: OptionalValue<TrustedAutomationProfile>;
}

export interface AutomationRunRecord {
  id: string;
  automation_id: string;
  fired_at: string;
  delivered: string[];
  session_id: string | null;
  status: string | null;
  trigger_type: string;
  scheduled_for: string;
  attempt: number;
  max_attempts: number;
  started_at: string | null;
  finished_at: string | null;
  next_attempt_at: string | null;
  summary: string | null;
  error: string | null;
  duration_ms: number | null;
}

export interface ClaimedAutomationRun {
  run_id: string;
  automation: AutomationDefinition;
  scheduled_for: string;
  trigger_type: string;
  attempt: number;
}

export const HEARTBEAT_AUTOMATION_ID = 'auto_heartbeat_default';
export const AUTOMATION_LEASE_GRACE_SECS = 60;
const AUTOMATION_BOOT_ID = globalThis.crypto.randomUUID();
/** `hostname:pid:boot`：桌面入口注入 `node:os`/`process.pid`；移动端为 `local:0:<boot>`。 */
export const schedulerIdentity =
  () => `${localNodeRuntime().hostname()}:${localNodeRuntime().pid()}:${AUTOMATION_BOOT_ID}`;

export function dbError(context: string, error: unknown): AppError {
  return AppError.database(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

export function nowString(): string {
  return formatTimestampMillis(Date.now());
}

export function num(value: SqlValue | undefined): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

export function text(value: SqlValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** Rust `Option<u64>` -> i64 rejects values above i64::MAX. */
export function versionParam(expectedVersion: number): number {
  if (!Number.isInteger(expectedVersion) || expectedVersion > 9_223_372_036_854_775_807) {
    throw AppError.validation('expected_version must be a positive 64-bit integer');
  }
  if (expectedVersion === 0) throw AppError.validation('expected_version must be at least 1');
  return expectedVersion;
}

export function isAppError(error: unknown): error is AppError {
  return typeof error === 'object' && error !== null && 'error_type' in error && 'message' in error;
}
