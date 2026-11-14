/**
 * `src-tauri/src/chat_v2/tools/data_governance_executor.rs` 的可复用面：
 * `can_handle` / `sensitivity_level` / `concurrency_class`、参数校验、
 * 任务摘要映射、同步结果映射与 agent 任务回执。
 *
 * 工具经 L07 `agentTools` 注册，L04 实际 registry 派发；业务调用复用
 * 本owner的backup服务及L20公开sync服务，事件/持久化经L04 ExecutionContext。
 */
import type { BackupJobPhase, BackupJobStatus, BackupJobSummary } from '../api.ts';
import { rustTrim, takeChars } from '../../../platform/util/portable.ts';
import type { ChatExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../chat/api.ts';
import type {} from '../../sync/api.ts';
import {
  BackupConfigError, defaultBackupConfig, normalizeBackupConfig, parseBackupConfig,
  serializeBackupConfig, type BackupConfig,
} from '../../../platform/settings/backup-config.ts';
import {
  CloudConfigSsotError, CLOUD_CONFIG_NOT_CONFIGURED_CODE, CLOUD_CONFIG_INVALID_CODE,
  CLOUD_CREDENTIALS_UNAVAILABLE_CODE, loadCloudConfigSsot,
} from './cloud-config.ts';

export const BACKUP_STATUS_TOOL = 'backup_status';
export const BACKUP_JOB_STATUS_TOOL = 'backup_job_status';
export const BACKUP_CREATE_TOOL = 'backup_create';
export const BACKUP_CONFIG_GET_TOOL = 'backup_config_get';
export const BACKUP_CONFIG_SET_TOOL = 'backup_config_set';
export const SYNC_STATUS_TOOL = 'sync_status';
export const SYNC_RUN_TOOL = 'sync_run';

export const GOVERNANCE_TOOL_NAMES = [
  BACKUP_STATUS_TOOL, BACKUP_JOB_STATUS_TOOL, BACKUP_CREATE_TOOL, BACKUP_CONFIG_GET_TOOL, BACKUP_CONFIG_SET_TOOL,
  SYNC_STATUS_TOOL, SYNC_RUN_TOOL,
] as const;

export const BACKUP_CONFIG_KEY = 'backup.config';
export const SETTINGS_CHANGED_EVENT = 'chat_v2://settings_changed';
export const MIN_AUTO_BACKUP_INTERVAL_HOURS = 1;
export const MAX_AUTO_BACKUP_INTERVAL_HOURS = 168;
export const MIN_MAX_BACKUPS = 1;
export const MAX_MAX_BACKUPS = 100;

export const MAX_PAGE_SIZE = 20;
export const MAX_TOOL_TEXT_CHARS = 2_000;
export const MAX_ASSET_TYPES = 10;
export const JOB_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_JOB_RECEIPTS = 256;

export const ALLOWED_ASSET_TYPES = [
  'images', 'notes_assets', 'documents', 'vfs_blobs', 'subjects', 'workspaces',
  'audio', 'videos', 'textbooks', 'pdf_ocr_sessions',
] as const;

export const ALLOWED_SYNC_DIRECTIONS = ['upload', 'download', 'bidirectional'] as const;
export const ALLOWED_SYNC_STRATEGIES = ['keep_local', 'use_cloud', 'keep_latest'] as const;

export type GovernanceToolSensitivity = 'low' | 'medium' | 'high';
export type GovernanceToolConcurrency = 'read_only' | 'serial';

/** `SyncExecutionResponse` 的结构子集（L20 `commands_sync.rs:2322`）。 */
export interface GovernanceSyncExecution {
  success: boolean;
  direction: string;
  changes_uploaded: number;
  changes_downloaded: number;
  conflicts_detected: number;
  duration_ms: number;
  device_id: string;
  error_message?: string | null;
  skipped_changes?: number;
}

/** `strip_tool_namespace`（`dstu-core/src/tool_names.rs`）。 */
export function stripToolNamespace(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice('builtin-'.length);
  if (toolName.startsWith('mcp_')) return toolName.slice('mcp_'.length);
  return toolName;
}

/** `bounded_text`：按 Unicode 标量截到 2000 字符。 */
export function boundedText(value: string): string {
  return takeChars(value, MAX_TOOL_TEXT_CHARS);
}

/** `governance_error`：稳定错误码 + 有界消息 + message_key + hint + retryable。 */
export function governanceError(
  code: string,
  message: string,
  hint: string,
  retryable: boolean,
): string {
  return JSON.stringify({
    code,
    message: boundedText(message),
    message_key: `chat.tools.data_governance.errors.${code.toLowerCase()}`,
    hint,
    retryable,
  });
}

export function syncTimeoutError(): string {
  return governanceError(
    'SYNC_TIMEOUT',
    'Cloud sync did not return a terminal result within 600 seconds.',
    'Check sync_status before retrying; the backend may have applied partial changes.',
    true,
  );
}

export type CloudConfigToolErrorKind =
  | 'not_configured'
  | 'invalid'
  | 'storage'
  | 'credentials_unavailable';

/** `cloud_config_tool_error`：把 SSOT 错误映射为工具错误。 */
export function cloudConfigToolError(kind: CloudConfigToolErrorKind): string {
  switch (kind) {
    case 'not_configured':
      return governanceError(
        'CLOUD_CONFIG_NOT_CONFIGURED',
        'Cloud sync is not configured in the backend SSOT.',
        'Configure Cloud Storage in Settings; credentials cannot be supplied to this tool.',
        false,
      );
    case 'invalid':
      return governanceError(
        'CLOUD_CONFIG_INVALID',
        'The backend non-secret cloud configuration failed validation.',
        'Open Cloud Storage Settings and save the configuration again.',
        false,
      );
    case 'storage':
      return governanceError(
        'CLOUD_CONFIG_UNAVAILABLE',
        'The backend cloud configuration could not be read.',
        'Retry after application storage becomes available.',
        true,
      );
    case 'credentials_unavailable':
      return governanceError(
        'CLOUD_CREDENTIALS_UNAVAILABLE',
        'The secure credential store does not contain complete credentials for the configured provider.',
        'Re-enter cloud credentials in Settings; credentials cannot be supplied to this tool.',
        false,
      );
  }
}

/** `arguments_object`。 */
export function argumentsObject(argumentsValue: unknown): Record<string, unknown> {
  if (argumentsValue === null || typeof argumentsValue !== 'object'
    || Array.isArray(argumentsValue)) {
    throw new Error(governanceError(
      'INVALID_ARGUMENT',
      'Tool arguments must be a JSON object.',
      'Correct the tool arguments and retry.',
      false,
    ));
  }
  return argumentsValue as Record<string, unknown>;
}

/** `ensure_allowed_keys`：未知字段一律拒绝，避免云凭据经工具参数传入。 */
export function ensureAllowedKeys(
  argumentsValue: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const field = Object.keys(argumentsValue).find(key => !allowed.includes(key));
  if (field !== undefined) {
    throw new Error(governanceError(
      'INVALID_ARGUMENT',
      `Unknown field '${field}'; additional properties are not allowed.`,
      'Remove unsupported fields. Cloud configuration and credentials must be configured in Settings.',
      false,
    ));
  }
}

/** `optional_bool`。 */
export function optionalBool(
  argumentsValue: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = argumentsValue[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error(governanceError(
    'INVALID_ARGUMENT',
    `'${field}' must be a boolean.`,
    'Correct the tool arguments and retry.',
    false,
  ));
}

const U64_MAX = Number(18_446_744_073_709_551_615n);
const USIZE_MAX_TEXT = '18446744073709551615';

/** `positive_integer`：默认值、零值拒绝、可选上限与 u64 范围。 */
export function positiveInteger(
  argumentsValue: Record<string, unknown>,
  field: string,
  defaultValue: number,
  maximum?: number,
): number {
  const raw = argumentsValue[field];
  let value: number;
  if (raw === undefined || raw === null) {
    value = defaultValue;
  } else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= U64_MAX) {
    value = raw;
  } else {
    throw new Error(governanceError(
      'INVALID_ARGUMENT',
      `'${field}' must be a positive integer.`,
      'Correct the pagination arguments and retry.',
      false,
    ));
  }
  if (value === 0 || (maximum !== undefined && value > maximum)) {
    throw new Error(governanceError(
      'INVALID_ARGUMENT',
      `'${field}' must be in 1..=${maximum === undefined ? USIZE_MAX_TEXT : maximum}`,
      'Correct the pagination arguments and retry.',
      false,
    ));
  }
  return value;
}

/** `pagination`：默认 page=1、page_size=20，offset 用 checked 乘法。 */
export function pagination(argumentsValue: Record<string, unknown>): [number, number, number] {
  const page = positiveInteger(argumentsValue, 'page', 1);
  const pageSize = positiveInteger(argumentsValue, 'page_size', MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = (BigInt(page) - 1n) * BigInt(pageSize);
  if (offset > BigInt(U64_MAX)) {
    throw new Error(governanceError(
      'INVALID_ARGUMENT',
      'Pagination offset is out of range.',
      'Use a smaller page number.',
      false,
    ));
  }
  return [page, pageSize, Number(offset)];
}

/** `parse_asset_types`：仅在 include_assets=true 时允许，去重并限制 1..=10 项。 */
export function parseAssetTypes(
  argumentsValue: Record<string, unknown>,
  includeAssets: boolean,
): string[] | undefined {
  const value = argumentsValue.asset_types;
  if (value === undefined || value === null) return undefined;
  if (!includeAssets) {
    throw new Error(governanceError(
      'INVALID_ARGUMENT',
      "'asset_types' requires include_assets=true.",
      'Enable asset backup or omit asset_types.',
      false,
    ));
  }
  if (!Array.isArray(value)) {
    throw new Error(governanceError(
      'INVALID_ARGUMENT',
      "'asset_types' must be an array of strings.",
      'Correct the tool arguments and retry.',
      false,
    ));
  }
  if (value.length === 0 || value.length > MAX_ASSET_TYPES) {
    throw new Error(governanceError(
      'INVALID_ARGUMENT',
      `'asset_types' must contain 1..=${MAX_ASSET_TYPES} entries.`,
      'Omit asset_types to include all supported assets.',
      false,
    ));
  }
  const seen = new Set<string>();
  const parsed: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error(governanceError(
        'INVALID_ARGUMENT',
        'Every asset type must be a string.',
        'Use only documented asset type IDs.',
        false,
      ));
    }
    if (!(ALLOWED_ASSET_TYPES as readonly string[]).includes(entry)) {
      throw new Error(governanceError(
        'INVALID_ARGUMENT',
        `Unsupported asset type '${entry}'.`,
        'Use one of the documented asset type IDs.',
        false,
      ));
    }
    if (seen.has(entry)) {
      throw new Error(governanceError(
        'INVALID_ARGUMENT',
        `Duplicate asset type '${entry}'.`,
        'Remove duplicate entries and retry.',
        false,
      ));
    }
    seen.add(entry);
    parsed.push(entry);
  }
  return parsed;
}

/** `required_enum`：trim 后必须命中白名单。 */
export function requiredEnum(
  argumentsValue: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
): string {
  const raw = argumentsValue[field];
  const value = typeof raw === 'string' ? rustTrim(raw) : '';
  if (value === '') {
    throw new Error(governanceError(
      'INVALID_ARGUMENT',
      `'${field}' is required and must be a string.`,
      'Correct the tool arguments and retry.',
      false,
    ));
  }
  if (!allowed.includes(value)) {
    throw new Error(governanceError(
      'INVALID_ARGUMENT',
      `Unsupported ${field} '${value}'.`,
      'Use one of the documented enum values.',
      false,
    ));
  }
  return value;
}

/** `optional_enum`。 */
export function optionalEnum(
  argumentsValue: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
): string | undefined {
  const value = argumentsValue[field];
  if (value === undefined || value === null) return undefined;
  return requiredEnum(argumentsValue, field, allowed);
}

/** Optional integer in an inclusive range; absent/null keeps the caller's fallback. */
export function optionalInteger(
  argumentsValue: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = argumentsValue[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(governanceError(
      'INVALID_ARGUMENT',
      `'${field}' must be an integer in ${minimum}..=${maximum}.`,
      'Correct the tool arguments and retry.',
      false,
    ));
  }
  return value;
}

/** Model-facing projection of `backup.config` (no filesystem paths beyond the configured directory). */
export function backupConfigJson(config: BackupConfig): Record<string, unknown> {
  return {
    auto_backup_enabled: config.autoBackupEnabled,
    interval_hours: config.autoBackupIntervalHours,
    max_backups: config.maxBackupCount,
    include_assets: !config.slimBackup,
    slim_backup: config.slimBackup,
    backup_directory: config.backupDirectory,
    backup_tiers: config.backupTiers ?? null,
  };
}

const UUID_RE = /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|urn:uuid:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\})$/;

/** `required_job_id`：trim 后必须是 UUID（支持 simple/hyphenated/urn/braced）。 */
export function requiredJobId(argumentsValue: Record<string, unknown>): string {
  const raw = argumentsValue.job_id;
  const value = typeof raw === 'string' ? rustTrim(raw) : '';
  if (value === '') {
    throw new Error(governanceError(
      'INVALID_ARGUMENT',
      "'job_id' is required and must be a UUID string.",
      'Use the job_id returned by backup_create.',
      false,
    ));
  }
  if (!UUID_RE.test(value)) {
    throw new Error(governanceError(
      'INVALID_ARGUMENT',
      "'job_id' must be a valid UUID.",
      'Use the job_id returned by backup_create.',
      false,
    ));
  }
  return value;
}

/** `backup_status_name`。 */
export function backupStatusName(status: BackupJobStatus): string {
  return status;
}

/** `backup_phase_name`。 */
export function backupPhaseName(phase: BackupJobPhase): string {
  return phase;
}

/** `backup_job_summary_json`。 */
export function backupJobSummaryJson(summary: BackupJobSummary): Record<string, unknown> {
  const terminal = summary.status === 'completed'
    || summary.status === 'failed'
    || summary.status === 'cancelled';
  const result: Record<string, unknown> | null = summary.result == null ? null : {
    success: summary.result.success,
    message: summary.result.message == null ? null : boundedText(summary.result.message),
    error: summary.result.error == null ? null : boundedText(summary.result.error),
    duration_ms: summary.result.duration_ms ?? null,
  };
  return {
    job_id: summary.job_id,
    status: backupStatusName(summary.status),
    phase: backupPhaseName(summary.phase),
    progress: summary.progress,
    terminal,
    message: summary.message == null ? null : boundedText(summary.message),
    created_at: summary.created_at,
    started_at: summary.started_at ?? null,
    finished_at: summary.finished_at ?? null,
    result,
    terminal_result_available: terminal && result !== null,
  };
}

interface BackupJobReceipt {
  jobId: string;
  createdAt: number;
}

const BACKUP_JOB_RECEIPTS: BackupJobReceipt[] = [];

function retainLiveReceipts(nowMs: number): void {
  for (let index = BACKUP_JOB_RECEIPTS.length - 1; index >= 0; index -= 1) {
    const receipt = BACKUP_JOB_RECEIPTS[index]!;
    // `Instant::saturating_duration_since`：created_at 在未来时按 0 处理，仍在 TTL 内。
    if (nowMs - receipt.createdAt >= JOB_RECEIPT_TTL_MS) BACKUP_JOB_RECEIPTS.splice(index, 1);
  }
}

/** `remember_backup_job`：24h TTL、去重、最多256条；nowMs为同一单调时钟毫秒（Rust Instant）。 */
export function rememberBackupJob(jobId: string, nowMs = performance.now()): void {
  retainLiveReceipts(nowMs);
  if (BACKUP_JOB_RECEIPTS.some(receipt => receipt.jobId === jobId)) return;
  while (BACKUP_JOB_RECEIPTS.length >= MAX_JOB_RECEIPTS) BACKUP_JOB_RECEIPTS.shift();
  BACKUP_JOB_RECEIPTS.push({ jobId, createdAt: nowMs });
}

/** `was_agent_backup_job`：与创建回执使用同一单调时钟，不受墙钟校准影响。 */
export function wasAgentBackupJob(jobId: string, nowMs = performance.now()): boolean {
  retainLiveReceipts(nowMs);
  return BACKUP_JOB_RECEIPTS.some(receipt => receipt.jobId === jobId);
}

/** `sync_execution_json`：skipped 或警告一律降级为 partial，绝不伪装成功。 */
export function syncExecutionJson(
  response: GovernanceSyncExecution,
  strategy: string,
): Record<string, unknown> {
  const warningText = response.error_message == null ? null : boundedText(response.error_message);
  const warning = warningText !== null && rustTrim(warningText) !== '' ? warningText : null;
  const hasWarning = warning !== null;
  const affected = response.changes_uploaded + response.changes_downloaded;
  const partial = (response.skipped_changes ?? 0) > 0
    || (!response.success && affected > 0)
    || (response.success && hasWarning);

  if (!response.success && !partial) {
    throw new Error(governanceError(
      'SYNC_FAILED',
      warning ?? 'Cloud sync returned an unsuccessful result.',
      'Inspect sync_status and cloud settings before retrying.',
      true,
    ));
  }

  return {
    success: response.success && !partial,
    status: partial ? 'partial' : 'success',
    partial,
    direction: response.direction,
    strategy,
    changes_uploaded: response.changes_uploaded,
    changes_downloaded: response.changes_downloaded,
    conflicts_detected: response.conflicts_detected,
    skipped_changes: response.skipped_changes ?? 0,
    duration_ms: response.duration_ms,
    warnings: warning === null ? [] : [warning],
  };
}

/** Rust DataGovernanceToolExecutor，实际由L07注册→L04 registry调用。 */
export class DataGovernanceToolExecutor implements ToolExecutor {
  async execute(call: ToolCall, context: ChatExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    context.emitToolCallStart(call.name, call.arguments, call.id);
    let output: unknown;
    let error: string | undefined;
    try { output = await this.executeTool(stripToolNamespace(call.name), call.arguments, context); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    const durationMs = Math.trunc(performance.now() - started);
    let result: ToolResultInfo;
    if (error === undefined) {
      context.emitToolCallEnd({ result: output, durationMs });
      result = { toolCallId: call.id, blockId: context.block_id, toolName: call.name,
        input: call.arguments, output, success: true, durationMs };
    } else {
      context.emitToolCallError(error);
      result = { toolCallId: call.id, blockId: context.block_id, toolName: call.name,
        input: call.arguments, output: null, success: false, error, durationMs };
    }
    try { context.saveToolBlock(result); }
    catch (cause) {
      context.services.logger('backup').warn(`[DataGovernanceToolExecutor] failed to persist tool block: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return result;
  }

  private async executeTool(name: string, input: unknown, context: ChatExecutionContext): Promise<unknown> {
    const services = context.services;
    switch (name) {
      case BACKUP_STATUS_TOOL: {
        const args = argumentsObject(input);
        ensureAllowedKeys(args, ['page', 'page_size']);
        const [page, pageSize, offset] = pagination(args);
        const backup = services.get('backup');
        if (backup === undefined) throw new Error(this.backupUnavailable());
        let backups;
        try { backups = backup.getBackupList(); }
        catch (cause) {
          throw new Error(governanceError('BACKUP_STATUS_FAILED', this.message(cause),
            'Open Settings > Data Governance to inspect the backup catalog.', true));
        }
        backups.sort((left, right) => left.created_at < right.created_at ? 1 : left.created_at > right.created_at ? -1 : 0);
        const total = backups.length;
        const items = backups.slice(offset, offset + pageSize).map(backup => ({
          backup_id: boundedText(backup.path), created_at: boundedText(backup.created_at), size_bytes: backup.size,
          backup_type: boundedText(backup.backup_type), databases: backup.databases.map(boundedText),
        }));
        return { success: true, scope: 'local_backup_catalog', backups: items, count: items.length,
          total, page, page_size: pageSize, has_more: offset + items.length < total };
      }
      case BACKUP_CREATE_TOOL: {
        const args = argumentsObject(input);
        ensureAllowedKeys(args, ['include_assets', 'asset_types']);
        const includeAssets = optionalBool(args, 'include_assets') ?? false;
        const assetTypes = parseAssetTypes(args, includeAssets);
        const backup = services.get('backup');
        if (backup === undefined) throw new Error(this.backupUnavailable());
        let response;
        try { response = backup.runBackup({ backupType: 'full', baseVersion: null, includeAssets, assetTypes }); }
        catch (cause) {
          throw new Error(governanceError('BACKUP_CREATE_FAILED', this.message(cause),
            'Check Data Governance maintenance state and retry.', true));
        }
        rememberBackupJob(response.job_id);
        return { status: 'queued', job_id: response.job_id };
      }
      case BACKUP_JOB_STATUS_TOOL: {
        const args = argumentsObject(input);
        ensureAllowedKeys(args, ['job_id']);
        const jobId = requiredJobId(args);
        const backup = services.get('backup');
        if (backup === undefined) throw new Error(this.backupUnavailable());
        const summary = backup.jobs.getJob(jobId);
        return summary !== null ? { success: true, lookup: 'found', job: backupJobSummaryJson(summary) }
          : { success: true, lookup: wasAgentBackupJob(jobId) ? 'expired' : 'not_found', job_id: jobId, terminal_result_retention_seconds: 60 };
      }
      case BACKUP_CONFIG_GET_TOOL: {
        const args = argumentsObject(input);
        ensureAllowedKeys(args, []);
        const config = this.loadBackupConfig(context);
        return { success: true, scope: 'local_backup_config', config: backupConfigJson(config) };
      }
      case BACKUP_CONFIG_SET_TOOL: {
        const args = argumentsObject(input);
        ensureAllowedKeys(args, ['auto_backup_enabled', 'interval_hours', 'max_backups', 'include_assets']);
        const current = this.loadBackupConfig(context);
        const autoBackupEnabled = optionalBool(args, 'auto_backup_enabled');
        const intervalHours = optionalInteger(args, 'interval_hours',
          MIN_AUTO_BACKUP_INTERVAL_HOURS, MAX_AUTO_BACKUP_INTERVAL_HOURS);
        const maxBackups = optionalInteger(args, 'max_backups', MIN_MAX_BACKUPS, MAX_MAX_BACKUPS);
        const includeAssets = optionalBool(args, 'include_assets');
        const next: BackupConfig = { ...current };
        if (autoBackupEnabled !== undefined) next.autoBackupEnabled = autoBackupEnabled;
        if (intervalHours !== undefined) next.autoBackupIntervalHours = intervalHours;
        if ('max_backups' in args) next.maxBackupCount = args['max_backups'] === null ? null : maxBackups ?? null;
        if (includeAssets !== undefined) next.slimBackup = !includeAssets;
        let normalized: BackupConfig;
        let serialized: string;
        try {
          normalized = normalizeBackupConfig(next);
          serialized = serializeBackupConfig(normalized);
        } catch (cause) {
          throw new Error(governanceError('BACKUP_CONFIG_INVALID', this.message(cause),
            'Correct the backup configuration values and retry.', false));
        }
        const settings = context.services.settings;
        let previousRaw: string | null = null;
        try { previousRaw = settings.get(BACKUP_CONFIG_KEY); }
        catch { previousRaw = null; } // boundary-allow empty-catch: a read failure must not block a validated write
        try { settings.save(BACKUP_CONFIG_KEY, serialized); }
        catch (cause) {
          throw new Error(governanceError('BACKUP_CONFIG_WRITE_FAILED', this.message(cause),
            'Retry after checking local storage availability.', true));
        }
        let eventEmitted = false;
        try {
          context.services.backendEvents.emit(SETTINGS_CHANGED_EVENT, { action: 'backup_config_set' });
          eventEmitted = true;
        } catch { eventEmitted = false; } // boundary-allow empty-catch: persistence already succeeded
        return {
          success: true,
          scope: 'local_backup_config',
          changed: previousRaw !== serialized,
          config: backupConfigJson(normalized),
          event: SETTINGS_CHANGED_EVENT,
          event_emitted: eventEmitted,
        };
      }
      case SYNC_STATUS_TOOL: {
        const args = argumentsObject(input);
        ensureAllowedKeys(args, []);
        const syncService = services.get('sync');
        if (syncService === undefined) throw new Error(this.syncUnavailable());
        let status;
        try { status = await syncService.getSyncStatus(); }
        catch (cause) {
          throw new Error(governanceError('SYNC_STATUS_FAILED', this.message(cause),
            'Wait for maintenance or migration work to finish and retry.', true));
        }
        let cloudConfigured = false;
        let configWarning: string | null = null;
        if (context.main_db === null) configWarning = 'The settings database is unavailable; cloud configuration cannot be observed.';
        else {
          try { loadCloudConfigSsot(services.settings); cloudConfigured = true; }
          catch (cause) {
            configWarning = cause instanceof CloudConfigSsotError && cause.code === CLOUD_CONFIG_NOT_CONFIGURED_CODE
              ? 'Cloud sync is not configured in the backend SSOT; configure it in Settings.'
              : 'The backend cloud configuration could not be validated; sync_run will fail closed.';
          }
        }
        const warnings = [
          'This status reads local change logs only; it does not probe the cloud endpoint or prove cross-device consistency.',
          'A global last-sync timestamp is not currently available; per-database timestamps are best-effort local observations.',
        ];
        if (configWarning !== null) warnings.push(configWarning);
        const missing = status.databases.filter(database => !database.has_change_log).length;
        if (missing > 0) warnings.push(`${missing} local database(s) do not expose a change log and are not represented in pending counts.`);
        return { success: true, observation_scope: 'local_change_logs_only', cloud_probed: false,
          cloud_configured: cloudConfigured, has_pending_changes: status.has_pending_changes,
          total_pending_changes: status.total_pending_changes, total_synced_changes: status.total_synced_changes,
          last_sync_at: status.last_sync_at, databases: status.databases.map(database => ({
            id: boundedText(database.id), has_change_log: database.has_change_log,
            pending_changes: database.pending_changes, synced_changes: database.synced_changes, last_sync_at: database.last_sync_at,
          })), warnings };
      }
      case SYNC_RUN_TOOL: {
        const args = argumentsObject(input);
        ensureAllowedKeys(args, ['direction', 'strategy']);
        const direction = requiredEnum(args, 'direction', ALLOWED_SYNC_DIRECTIONS);
        const strategy = optionalEnum(args, 'strategy', ALLOWED_SYNC_STRATEGIES) ?? 'keep_latest';
        if (context.main_db === null) throw new Error(governanceError('CLOUD_CONFIG_UNAVAILABLE',
          'The settings database is unavailable.', 'Retry after application startup completes.', true));
        const backup = services.get('backup');
        if (backup === undefined) throw new Error(this.backupUnavailable());
        let config;
        try { config = await backup.syncCommandPorts().loadHydratedCloudConfig(); }
        catch (cause) {
          // Rust 的 load_hydrated_cloud_config_ssot 只产生 CloudConfigSsotError；其余异常不能伪装成存储不可用。
          if (!(cause instanceof CloudConfigSsotError)) throw cause;
          const kind = cause.code === CLOUD_CONFIG_NOT_CONFIGURED_CODE ? 'not_configured'
            : cause.code === CLOUD_CONFIG_INVALID_CODE ? 'invalid'
              : cause.code === CLOUD_CREDENTIALS_UNAVAILABLE_CODE ? 'credentials_unavailable' : 'storage';
          throw new Error(cloudConfigToolError(kind));
        }
        if (config === null) throw new Error(cloudConfigToolError('not_configured'));
        const syncService = services.get('sync');
        if (syncService === undefined) throw new Error(this.syncUnavailable());
        // 取消和超时都先中止这趟同步本身，再给出 SYNC_CANCELLED / SYNC_TIMEOUT；否则同步继续跑并占着 permit。
        const stop = new AbortController();
        const sync = syncService.runSync(direction, config, strategy, stop.signal).catch(cause => {
          throw new Error(governanceError('SYNC_FAILED', this.message(cause),
            'Check cloud configuration and Data Governance status, then retry deliberately.', true));
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onCancel: (() => void) | undefined;
        const cancelled = new Promise<never>((_resolve, reject) => {
          onCancel = () => {
            stop.abort();
            reject(new Error(governanceError('SYNC_CANCELLED',
              'Cloud sync was cancelled before a terminal result was returned.',
              'Check sync_status before deciding whether to retry; partial side effects may exist.', false)));
          };
          context.cancellation_token?.addEventListener('abort', onCancel, { once: true });
          if (context.isCancelled()) onCancel();
        });
        try {
          const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { stop.abort(); reject(new Error(syncTimeoutError())); }, 600_000);
          });
          return syncExecutionJson(await Promise.race([sync, timeout, cancelled]), strategy);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          if (onCancel !== undefined) context.cancellation_token?.removeEventListener('abort', onCancel);
        }
      }
      default: throw new Error(governanceError('UNKNOWN_TOOL', `Unsupported data-governance tool: ${name}`,
        'Use a registered backup_* or sync_* tool.', false));
    }
  }

  private message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private loadBackupConfig(context: ChatExecutionContext): BackupConfig {
    let raw: string | null;
    try { raw = context.services.settings.get(BACKUP_CONFIG_KEY); }
    catch (cause) {
      throw new Error(governanceError('BACKUP_CONFIG_READ_FAILED', this.message(cause),
        'Retry after checking the local database.', true));
    }
    if (raw === null) return defaultBackupConfig();
    try { return parseBackupConfig(raw); }
    catch (cause) {
      const message = cause instanceof BackupConfigError ? cause.appError.message : this.message(cause);
      throw new Error(governanceError('BACKUP_CONFIG_INVALID', message,
        'Open Settings > Data Governance and save the backup configuration again.', false));
    }
  }
  private backupUnavailable(): string {
    return governanceError('BACKUP_SERVICE_UNAVAILABLE', 'The backup job manager is not initialized.',
      'Wait for application startup to finish and retry.', true);
  }
  private syncUnavailable(): string {
    return governanceError('SYNC_SERVICE_UNAVAILABLE', 'The sync service is not initialized.',
      'Wait for application startup to finish and retry.', true);
  }

  canHandle(toolName: string): boolean {
    return (GOVERNANCE_TOOL_NAMES as readonly string[]).includes(stripToolNamespace(toolName));
  }

  sensitivityLevel(toolName: string): GovernanceToolSensitivity {
    const name = stripToolNamespace(toolName);
    return name === BACKUP_CREATE_TOOL || name === SYNC_RUN_TOOL || name === BACKUP_CONFIG_SET_TOOL ? 'high' : 'low';
  }

  concurrencyClass(toolName: string): GovernanceToolConcurrency {
    const name = stripToolNamespace(toolName);
    return name === BACKUP_STATUS_TOOL || name === BACKUP_JOB_STATUS_TOOL || name === SYNC_STATUS_TOOL
      || name === BACKUP_CONFIG_GET_TOOL ? 'read_only' : 'serial';
  }

  name(): string {
    return 'DataGovernanceToolExecutor';
  }
}
