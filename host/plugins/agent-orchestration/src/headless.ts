import type { TrustedAutomationProfile } from './trusted-profile.ts';
import { HEADLESS_TOOL_SCHEMAS, type HeadlessToolSchema } from './headless-schemas.ts';
import {
  BUILTIN_DESCRIPTORS, headlessWireName, isHeadlessReadonly,
} from './tool-descriptors.ts';
import { rustTrim } from '../../../platform/util/portable.ts';

export const MAX_HARD_TIMEOUT_SECS = 3_600;
export const CANCEL_GRACE_SECS = 30;

export type HeadlessSessionMode = 'isolated' | 'named';

/** headless.rs:1177–1188. */
export function parseHeadlessSessionMode(raw: string): HeadlessSessionMode {
  const value = rustTrim(raw).toLowerCase();
  if (value === 'isolated') return 'isolated';
  if (value === 'named') return 'named';
  throw new Error(`Invalid session_mode '${raw}'. Allowed: isolated, named`);
}

/** headless.rs:2105–2111. */
export function truncateChars(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join('')}…`;
}

/** headless.rs:2038–2050. */
export function headlessSystemPromptNote(): string {
  return [
    '<headless_mode>',
    '本次运行为无人值守的后台自动化任务（headless），没有用户在场：',
    '- 不要提问或等待用户输入（ask_user 等交互工具不可用）；',
    '- 仅可使用当前注入的工具；其他工具（含全部 MCP 外部工具、shell、子代理）',
    '  在本模式下被策略禁用，调用会被直接拒绝并提示需人工授权，请勿尝试；',
    '- 任何需要人工授权的操作（安装、删除、外部提案等）请在总结中建议用户手动执行；',
    '- 完成任务后调用 attempt_completion，给出简洁的结果摘要（将用于系统通知正文）。',
    '</headless_mode>',
  ].join('\n');
}

export interface HeadlessBlock {
  blockType: string;
  status: string;
  toolName: string | null;
  content: string | null;
  toolOutput: Record<string, unknown> | null;
}

function isAttemptCompletion(toolName: string): boolean {
  return toolName === 'attempt_completion' || toolName === 'builtin-attempt_completion';
}

/** headless.rs:2073–2103. */
export function summarizeAssistantBlocks(blocks: readonly HeadlessBlock[]): string {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.status !== 'success' || block.toolName === null || !isAttemptCompletion(block.toolName)) continue;
    const raw = block.toolOutput?.result;
    if (typeof raw !== 'string') continue;
    const result = rustTrim(raw);
    if (result !== '') return result;
  }
  return blocks
    .filter((block) => block.blockType === 'content' && block.content !== null)
    .map((block) => block.content!)
    .join('\n')
    .trim();
}

/** headless.rs:1887–1895. */
export function panicMessage(payload: unknown): string {
  return typeof payload === 'string' ? payload : 'non-string panic payload';
}

export type HeadlessTermination =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

/** headless.rs:1898–1924. */
export function concludePipelineResult(result:
  | { ok: true; value: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; message: string }
  | { ok: false; panicked: unknown }): HeadlessTermination {
  if ('value' in result) return { status: 'completed' };
  if ('cancelled' in result && result.cancelled === true) return { status: 'cancelled' };
  if ('panicked' in result) {
    return { status: 'failed', message: `headless pipeline panicked: ${panicMessage(result.panicked)}` };
  }
  return { status: 'failed', message: result.message };
}

/** headless.rs:2011–2025. */
export function clampSessionTurnTimeout(requestedSeconds: number): number {
  return Math.min(MAX_HARD_TIMEOUT_SECS, Math.max(1, Math.trunc(requestedSeconds)));
}

// ---------------------------------------------------------------------------
// Trusted-automation profile policy (headless.rs:74–408)
// ---------------------------------------------------------------------------

const trustedSessions = new Map<string, TrustedAutomationProfile>();

export interface HeadlessPolicyLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
let policyLog: HeadlessPolicyLogger | undefined;

export function setHeadlessPolicyLogger(logger: HeadlessPolicyLogger | undefined): void {
  policyLog = logger;
}

export interface TrustedSessionGuard { release(): void }

export function installTrustedAutomationSession(
  sessionId: string, profile: TrustedAutomationProfile | null,
): TrustedSessionGuard | null {
  if (profile === null) return null;
  const previous = trustedSessions.get(sessionId);
  trustedSessions.set(sessionId, structuredClone(profile));
  if (previous !== undefined) {
    policyLog?.error(`[ChatV2::headless] trusted profile install OVERWROTE existing profile: session=${sessionId}, previous_hash=${previous.profileHash}`);
  }
  return { release: () => { trustedSessions.delete(sessionId); } };
}

/**
 * Tools that must never reach a headless agent (headless.rs:449–532):
 * frontend bridges, human-in-the-loop prompts, frontend-driven workspace
 * bootstraps, write-risk tools and tool_pack (which would bypass the list).
 */
export const HEADLESS_BLOCKED_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ['mcp_*', 'frontend-bridge'],
  ['anki_generate_cards', 'frontend-bridge'],
  ['ask_user', 'human-in-loop'],
  ['subagent_call', 'frontend-driven'],
  ['workspace_create', 'frontend-driven'],
  ['workspace_create_agent', 'frontend-driven'],
  ['workspace_send', 'frontend-driven'],
  ['workspace_query', 'frontend-driven'],
  ['workspace_set_context', 'frontend-driven'],
  ['workspace_get_context', 'frontend-driven'],
  ['workspace_update_document', 'frontend-driven'],
  ['workspace_read_document', 'frontend-driven'],
  ['coordinator_sleep', 'frontend-driven'],
  ['local_shell_execute', 'write-risk'],
  ['runtime_root_request', 'write-risk'],
  ['mcp_server_propose', 'write-risk'],
  ['mcp_server_update', 'write-risk'],
  ['mcp_server_set_enabled', 'write-risk'],
  ['mcp_server_remove', 'write-risk'],
  ['skill_install', 'write-risk'],
  ['skill_workshop_propose', 'write-risk'],
  ['skill_workshop_apply', 'write-risk'],
  ['skill_set_enabled', 'write-risk'],
  ['skill_remove', 'write-risk'],
  ['skill_trust_request', 'write-risk'],
  ['custom_agent_propose', 'write-risk'],
  ['custom_agent_apply', 'write-risk'],
  ['custom_agent_remove', 'write-risk'],
  ['automation_propose', 'write-risk'],
  ['automation_set_enabled', 'write-risk'],
  ['automation_update', 'write-risk'],
  ['automation_delete', 'write-risk'],
  ['automation_run_now', 'write-risk'],
  ['settings_set', 'write-risk'],
  ['model_assignments_set', 'write-risk'],
  ['model_profile_add', 'write-risk'],
  ['backup_create', 'write-risk'],
  ['sync_run', 'write-risk'],
  ['index_rebuild', 'write-risk'],
  ['webpage_save', 'write-risk'],
  ['user_todo_create_item', 'write-risk'],
  ['user_todo_complete_item', 'write-risk'],
  ['user_todo_update_item', 'write-risk'],
  ['user_todo_delete_item', 'write-risk'],
  ['user_todo_create_list', 'write-risk'],
  ['user_todo_update_list', 'write-risk'],
  ['user_todo_delete_list', 'write-risk'],
  ['user_todo_restore', 'write-risk'],
  ['user_todo_reorder', 'write-risk'],
  ['memory_write', 'write-risk'],
  ['memory_write_smart', 'write-risk'],
  ['memory_write_batch', 'write-risk'],
  ['memory_update_by_id', 'write-risk'],
  ['memory_delete', 'write-risk'],
  ['qbank_reset_progress', 'write-risk'],
  ['qbank_export', 'write-risk'],
  ['qbank_delete_questions', 'write-risk'],
  ['attachment_stage', 'write-risk'],
  ['paper_save', 'write-risk'],
  ['mindmap_delete', 'write-risk'],
  ['review_suspend', 'write-risk'],
  ['review_resume', 'write-risk'],
  ['review_delete', 'write-risk'],
  ['dstu_folder_create', 'write-risk'],
  ['dstu_folder_rename', 'write-risk'],
  ['dstu_rename', 'write-risk'],
  ['dstu_move', 'write-risk'],
  ['dstu_delete', 'write-risk'],
  ['dstu_restore', 'write-risk'],
  ['dstu_set_favorite', 'write-risk'],
  ['dstu_purge', 'write-risk'],
  ['dstu_upload_file', 'write-risk'],
  ['tool_pack', 'write-risk'],
];

/**
 * The registry-derived headless surface as locked by
 * `LEGACY_HEADLESS_ALLOWED_TOOLS` (headless.rs:584–637). Kept as the single
 * list until `tool_descriptors` is migrated; the two Rust sources are guarded
 * by a drift test.
 */
export const LEGACY_HEADLESS_ALLOWED_TOOLS: readonly string[] = [
  'attempt_completion',
  'todo_init', 'todo_update', 'todo_add', 'todo_get',
  'builtin-unified_search', 'builtin-rag_search', 'builtin-web_search', 'builtin-web_fetch',
  'builtin-settings_get', 'builtin-model_assignments_get', 'builtin-llm_usage_query',
  'builtin-backup_status', 'builtin-backup_job_status', 'builtin-sync_status',
  'builtin-index_status',
  'builtin-learning_overview', 'builtin-pomodoro_today_stats', 'builtin-pomodoro_daily_stats',
  'builtin-fsrs_get_scheduler_config',
  'builtin-memory_read', 'builtin-memory_list',
  'builtin-resource_list', 'builtin-resource_read', 'builtin-resource_search',
  'builtin-folder_list', 'builtin-dstu_list_trash',
  'builtin-user_todo_list_lists', 'builtin-user_todo_list_items',
  'builtin-user_todo_get_summary', 'builtin-user_todo_search', 'builtin-user_todo_list_trash',
  'builtin-qbank_list', 'builtin-qbank_list_questions', 'builtin-qbank_get_question',
  'builtin-qbank_get_stats', 'builtin-qbank_get_next_question',
  'builtin-review_get_due', 'builtin-review_stats',
];

export function headlessAllowedTools(): string[] {
  return BUILTIN_DESCRIPTORS
    .filter((descriptor) => descriptor.headlessAllowed)
    .map((descriptor) => headlessWireName(descriptor.name));
}

/** headless.rs:570–572: registry-driven admission for prefixed and bare names. */
export function isHeadlessAllowedTool(toolName: string): boolean {
  return isHeadlessReadonly(toolName);
}

export function filterHeadlessToolSchemas<T extends { name: string }>(schemas: readonly T[]): T[] {
  return schemas.filter((schema) => isHeadlessAllowedTool(schema.name));
}

/**
 * headless.rs:664–1133: a fresh, ordered builtin schema subset for each caller.
 * McpToolSchema (types.rs:2128–2142) omits `serverId` when None on the wire.
 */
export function headlessToolSchemas(): HeadlessToolSchema[] {
  return filterHeadlessToolSchemas(HEADLESS_TOOL_SCHEMAS).map(({ name, description, inputSchema }) =>
    ({ name, description, inputSchema: structuredClone(inputSchema) }));
}

// ---------------------------------------------------------------------------
// Execution policy (tool_policy.rs:5–133)
// ---------------------------------------------------------------------------

function isMcpNamespaced(name: string): boolean {
  return name.startsWith('mcp.tools.') || name.startsWith('mcp_');
}

function isBuiltinNamespaced(name: string): boolean {
  return name.startsWith('builtin-') || name.startsWith('builtin:');
}

function canonicalToolShortName(name: string): string {
  for (const prefix of ['builtin-', 'builtin:', 'mcp.tools.', 'mcp_']) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

function serverIdFromArgs(args: unknown): string | null {
  const object = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown> : {};
  const value = object._serverId;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function toolCallIsMcpSourced(toolName: string, args: unknown): boolean {
  if (isMcpNamespaced(toolName)) return true;
  return !isBuiltinNamespaced(toolName) && serverIdFromArgs(args) !== null;
}

export function isControlTool(toolName: string): boolean {
  if (isMcpNamespaced(toolName)) return false;
  const short = canonicalToolShortName(toolName);
  if (short === 'load_skills' || short === 'attempt_completion') return true;
  return toolName === 'coordinator_sleep' || toolName === 'builtin-coordinator_sleep'
    || toolName === 'workspace_coordinator_sleep';
}

export function toolAllowEntryMatches(
  allowedEntry: string, toolName: string, args: unknown,
): boolean {
  if (allowedEntry === toolName
    && toolCallIsMcpSourced(toolName, args) === isMcpNamespaced(allowedEntry)) {
    return true;
  }
  const separator = allowedEntry.indexOf('::');
  if (separator >= 0) {
    const allowedServer = allowedEntry.slice(0, separator);
    const allowedTool = allowedEntry.slice(separator + 2);
    const serverId = serverIdFromArgs(args);
    if (serverId === null || allowedServer !== serverId) return false;
    const toolShort = canonicalToolShortName(toolName);
    const allowedToolShort = canonicalToolShortName(allowedTool);
    return allowedTool === toolName || allowedTool === toolShort
      || allowedToolShort === toolName || allowedToolShort === toolShort;
  }
  if (toolCallIsMcpSourced(toolName, args) !== isMcpNamespaced(allowedEntry)) return false;
  const toolShort = canonicalToolShortName(toolName);
  const allowedShort = canonicalToolShortName(allowedEntry);
  return allowedEntry === toolShort || allowedShort === toolName || allowedShort === toolShort;
}

/** tool_policy.rs:35–54. */
export function isToolAllowedByExecutionPolicy(
  toolName: string, args: unknown, allowedTools: readonly string[] | null,
): boolean {
  if (isControlTool(toolName) && !toolCallIsMcpSourced(toolName, args)) return true;
  if (allowedTools === null) return true;
  return allowedTools.map((entry) => rustTrim(entry)).filter((entry) => entry !== '')
    .some((entry) => toolAllowEntryMatches(entry, toolName, args));
}

/** headless.rs:1563–1570. */
export function sessionAutoMemoryExtraction(metadata: unknown): boolean | null {
  const object = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : {};
  const optedOut = object.auto_memory_extraction === false
    || Object.hasOwn(object, 'superagent');
  return optedOut ? false : null;
}

function canonicalToolName(toolName: string): string {
  return toolName.startsWith('builtin-') ? toolName : `builtin-${toolName}`;
}

function commandMatchesPrefix(command: string, prefix: string): boolean {
  if (command === prefix) return true;
  if (!command.startsWith(prefix)) return false;
  const rest = command.slice(prefix.length);
  return rest !== '' && /^\s/.test(rest);
}

function domainAllowed(host: string, allowed: readonly string[]): boolean {
  const normalized = host.replace(/\.+$/, '').toLowerCase();
  return allowed.some((domain) => {
    if (domain.startsWith('*.')) {
      const suffix = domain.slice(2);
      return normalized !== suffix && normalized.endsWith(`.${suffix}`);
    }
    return normalized === domain;
  });
}

function collectExplicitHosts(value: unknown, hosts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectExplicitHosts(item, hosts);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    if (normalized === 'url' || normalized === 'uri' || normalized === 'host'
      || normalized === 'hostname' || normalized === 'domain') {
      if (typeof entry === 'string') {
        try {
          const host = new URL(entry).hostname;
          if (host !== '') hosts.push(host);
        } catch {
          if (!entry.includes('/') && !/\s/.test(entry)) hosts.push(entry);
        }
      }
    }
    collectExplicitHosts(entry, hosts);
  }
}

function commandNetworkHosts(command: string): string[] {
  const hosts: string[] = [];
  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^['",()]+|['",()]+$/g, '');
    const host = tryUrlHostname(token);
    if (host !== null) hosts.push(host);
  }
  return hosts;
}

function tryUrlHostname(token: string): string | null {
  try { return new URL(token).hostname; }
  catch { return null; }
}

function analyzeShellCommand(command: string): { writeCapable: boolean; networkCapable: boolean } {
  return {
    writeCapable: /^(unzip|tar|cp|mv|rm|mkdir|touch)\b/.test(command),
    networkCapable: /^(curl|wget)\b/.test(command),
  };
}

function profileWriteTool(toolName: string): boolean {
  const short = toolName.startsWith('builtin-') ? toolName.slice('builtin-'.length) : toolName;
  // automations.rs:505–515: preflight and other workspace_* names are not implicitly write tools.
  return short === 'attachment_stage' || short === 'local_shell_execute'
    || short === 'workspace_artifact_write' || short === 'workspace_change_revert'
    || short === 'workspace_file_delete' || short === 'workspace_file_move' || short === 'workspace_file_write';
}

function rootIdOf(argumentsValue: Record<string, unknown>): string | null {
  const root = Object.hasOwn(argumentsValue, 'root_id') ? argumentsValue.root_id : argumentsValue.rootId;
  if (typeof root === 'string') return root;
  const receipt = argumentsValue.receipt;
  if (receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt)) {
    const object = receipt as Record<string, unknown>;
    const receiptRoot = Object.hasOwn(object, 'root_id') ? object.root_id : object.rootId;
    if (typeof receiptRoot === 'string') return receiptRoot;
  }
  return null;
}

/** headless.rs:173–305. Missing profile means the session is not automation-scoped. */
export function validateTrustedAutomationToolCall(
  sessionId: string, toolName: string, args: unknown,
): void {
  const profile = trustedSessions.get(sessionId);
  if (profile === undefined) return;
  const argumentsValue = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown> : {};
  const canonical = canonicalToolName(toolName);
  if (!isHeadlessAllowedTool(canonical) && !profile.allowedTools.includes(canonical)) {
    throw new Error(`Tool '${toolName}' is not allowed by the trusted automation profile`);
  }
  const explicitHosts: string[] = [];
  collectExplicitHosts(args, explicitHosts);
  if (explicitHosts.some((host) => !domainAllowed(host, profile.networkDomains))) {
    throw new Error('Explicit network target is outside trusted-profile domains');
  }
  const short = canonical.slice('builtin-'.length);
  if (short.startsWith('workspace_') || short === 'local_shell_execute' || short === 'local_shell_preflight') {
    const rootId = rootIdOf(argumentsValue);
    if (rootId === null) throw new Error('Trusted automation runtime tools require explicit root_id');
    const root = profile.runtimeRoots.find((entry) => entry.rootId === rootId);
    if (root === undefined) throw new Error(`Runtime root '${rootId}' is not allowed by the trusted profile`);
    if (profileWriteTool(canonical) && root.access !== 'read_write') {
      throw new Error(`Runtime root '${rootId}' is read-only in the trusted profile`);
    }
  }
  if (short === 'local_shell_execute' || short === 'local_shell_preflight') {
    const command = typeof argumentsValue.command === 'string' ? argumentsValue.command : null;
    if (command === null) throw new Error('Trusted automation shell calls require command');
    if (!profile.shellCommandPrefixes.some((prefix) => commandMatchesPrefix(command, prefix))) {
      throw new Error('Shell command does not match an approved trusted-profile prefix');
    }
    if (/[;|&><`]|\$\(/.test(command) || /^(bash|sh|zsh|python|node)\b/.test(command)) {
      throw new Error('Trusted automation shell commands cannot use shell operators or script runners');
    }
    const analysis = analyzeShellCommand(command);
    if (analysis.writeCapable && profile.rollbackRequired && argumentsValue.track_file_changes !== true) {
      throw new Error('Write-capable trusted automation shell calls require track_file_changes=true');
    }
    if (analysis.networkCapable) {
      if (argumentsValue.allow_network !== true) {
        throw new Error('Network-capable shell call requires allow_network=true');
      }
      const hosts = commandNetworkHosts(command);
      if (hosts.length === 0 || hosts.some((host) => !domainAllowed(host, profile.networkDomains))) {
        throw new Error('Shell network target is absent or outside trusted-profile domains');
      }
    }
    const requested = argumentsValue.max_output_bytes;
    if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 0) {
      throw new Error('Trusted automation shell calls require explicit max_output_bytes');
    }
    if (requested > profile.maxOutputBytes) throw new Error('Shell max_output_bytes exceeds trusted-profile limit');
  }
  if (short === 'workspace_file_read') {
    const maxBytes = argumentsValue.max_bytes;
    if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 0) {
      throw new Error('Trusted automation workspace reads require explicit max_bytes');
    }
    if (maxBytes > profile.maxOutputBytes) throw new Error('workspace_file_read max_bytes exceeds trusted-profile limit');
  }
}

/** hooks.rs consumes Rust Result<(), String> as the original error message or null. */
export function trustedAutomationError(sessionId: string, toolName: string, args: unknown): string | null {
  try {
    validateTrustedAutomationToolCall(sessionId, toolName, args);
    return null;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
}

/** headless.rs:318–330. */
export function trustedWriteToolRollbackAvailable(shortName: string, args: unknown): boolean {
  const argumentsValue = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown> : {};
  if (shortName === 'workspace_file_write' || shortName === 'workspace_file_move'
    || shortName === 'workspace_file_delete' || shortName === 'workspace_artifact_write'
    || shortName === 'workspace_change_revert') return true;
  if (shortName === 'local_shell_execute') return argumentsValue.track_file_changes === true;
  return false;
}

/** headless.rs:351–408. */
export function isTrustedAutomationPreauthorized(
  sessionId: string, toolName: string, args: unknown,
): boolean {
  const profile = trustedSessions.get(sessionId);
  if (profile === undefined) return false;
  const canonical = canonicalToolName(toolName);
  if (!profile.allowedTools.includes(canonical)) return false;
  try {
    validateTrustedAutomationToolCall(sessionId, toolName, args);
  } catch (error) {
    policyLog?.warn(`[ChatV2::headless] trusted automation preauthorization denied: session=${sessionId}, tool=${toolName}, reason=${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (profile.rollbackRequired && profileWriteTool(canonical)) {
    const short = canonical.slice('builtin-'.length);
    if (!trustedWriteToolRollbackAvailable(short, args)) {
      policyLog?.warn(`[ChatV2::headless] trusted automation write tool '${toolName}' has no verified rollback path; falling back to manual approval (session=${sessionId}, rollback_required=true)`);
      return false;
    }
  }
  policyLog?.info(`[ChatV2::headless] trusted_automation_preauthorized: session=${sessionId}, tool=${toolName}, profile_hash=${profile.profileHash}`);
  return true;
}
