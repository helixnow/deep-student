/** 工具分类、敏感度与审批展示/绑定：移植 approval_scope.rs 的分类分支。 */
import type { JsonValue } from '../../api.ts';
import type { RuntimeRootApprovalBinding } from '../runtime-roots.ts';
import {
  asJsonObject, cloneJson, ENV_PLAN_HASH_FIELD, EXPLICIT_ENV_KEYS_FIELD, INHERIT_ENV_FIELD,
  INHERITED_ENV_KEYS_FIELD, jsonField, READABLE_ROOTS_FIELD, ROOT_ACCESS_FIELD,
  ROOT_BINDING_FIELD, ROOT_PATH_FIELD, ROOT_SESSION_SCOPED_FIELD,
} from './core.ts';
import { toolSourceNamespace, ToolSensitivity } from './core.ts';
import { shellCommandToolSensitivity } from './shell-guard.ts';
export { semanticToolShortName };

function semanticToolShortName(toolName: string): string {
  const [, short] = toolSourceNamespace(toolName, null);
  if (short.startsWith('builtin-')) return short.slice('builtin-'.length);
  if (short.startsWith('builtin:')) return short.slice('builtin:'.length);
  return short;
}

const SHELL_RUNTIME_SHORT_NAMES = new Set([
  'execute_command',
  'bash',
  'shell',
  'shell_execute',
  'local_shell_execute',
  'local_shell_preflight',
]);

const HIGH_RISK_EXTERNAL_MCP_SHORT_NAMES = new Set([
  'execute_command',
  'bash',
  'shell',
  'shell_execute',
  'local_shell_execute',
  'file_write',
  'file_delete',
  'file_patch',
  'file_append',
  'file_create',
]);

const FILE_MUTATION_SHORT_NAMES = new Set([
  'file_write',
  'file_delete',
  'file_patch',
  'file_append',
  'file_create',
  'workspace_artifact_write',
  'workspace_file_write',
  'workspace_file_move',
  'workspace_file_delete',
  'workspace_change_revert',
  'file_manager_commit',
  'file_manager_restore',
  'workspace_file_patch',
  'workspace_file_append',
  'workspace_file_create',
]);

const WORKBENCH_PRECISE_SHORT_NAMES = new Set([
  'workbench_act',
  'workbench_act_high',
  'workbench_undo',
  'workbench_open_app',
  'workbench_app_command',
  'workbench_close_window',
]);

const WORKBENCH_ALWAYS_CONFIRM_SHORT_NAMES = new Set([
  'workbench_act_high',
  'workbench_undo',
  'workbench_close_window',
]);

const ACR_DESTRUCTIVE_DOMAIN_SHORT_NAMES = new Set([
  'note_set',
  'note_replace',
  'mindmap_edit_nodes',
  'mindmap_delete',
  'review_delete',
  'qbank_delete_questions',
  'user_todo_delete_list',
  'automation_delete',
]);

const GOVERNANCE_ALWAYS_CONFIRM_SHORT_NAMES = new Set(['backup_create', 'sync_run']);

const PRIVILEGE_ESCALATION_TOOLS = new Set([
  'skill_install',
  'skill_workshop_apply',
  'skill_remove',
  'skill_trust_request',
  'mcp_server_propose',
  'mcp_server_update',
  'mcp_server_remove',
  'runtime_root_request',
  'automation_propose',
  'custom_agent_apply',
  'custom_agent_remove',
  // 自配置：密钥、模型路由、全局设置与备份策略；逐次确认且不可会话记忆。
  'llm_config_vendor_upsert',
  'llm_config_vendor_key_set',
  'llm_config_profile_upsert',
  'llm_config_profile_delete',
  'llm_config_failover_set',
  'llm_config_budget_set',
  'settings_apply',
  'dstu_config_search_set',
  'dstu_config_search_key_set',
  'backup_config_set',
  // 插件工坊：配置/启停/重启会改变进程内可信代码。
  'dstu_plugin_configure',
  'dstu_plugin_set_enabled',
  'dstu_plugin_app_restart',
]);

/** 携带明文 api_key 的凭据写工具：展示与持久化前一律脱敏为 `<redacted>`。 */
const API_KEY_ARGUMENT_SHORT_NAMES = new Set([
  'model_profile_add',
  'llm_config_vendor_upsert',
  'llm_config_vendor_key_set',
  'dstu_config_search_key_set',
]);

function redactsApiKeyArgument(toolName: string): boolean {
  return API_KEY_ARGUMENT_SHORT_NAMES.has(semanticToolShortName(toolName));
}

export function isShellRuntimeTool(toolName: string): boolean {
  return SHELL_RUNTIME_SHORT_NAMES.has(semanticToolShortName(toolName));
}

/** External MCP servers may alias a command executor; a string `command` marks it shell-capable. */
export function isShellRuntimeToolForArgs(toolName: string, args: JsonValue): boolean {
  if (isShellRuntimeTool(toolName)) return true;
  const [source] = toolSourceNamespace(toolName, args);
  return source.startsWith('mcp') && typeof jsonField(args, 'command') === 'string';
}

export function isLocalShellExecuteTool(toolName: string, args: JsonValue): boolean {
  const [source] = toolSourceNamespace(toolName, args);
  return (source === 'builtin' || source === 'local') && semanticToolShortName(toolName) === 'local_shell_execute';
}

export function isHighRiskExternalMcpTool(toolName: string): boolean {
  const [source] = toolSourceNamespace(toolName, null);
  if (!source.startsWith('mcp')) return false;
  return HIGH_RISK_EXTERNAL_MCP_SHORT_NAMES.has(semanticToolShortName(toolName));
}

function isFileMutationRuntimeTool(toolName: string): boolean {
  return FILE_MUTATION_SHORT_NAMES.has(semanticToolShortName(toolName));
}

function isWorkbenchPreciseActionTool(toolName: string): boolean {
  const [, short] = toolSourceNamespace(toolName, null);
  return WORKBENCH_PRECISE_SHORT_NAMES.has(short);
}

function isWorkbenchAlwaysConfirmTool(toolName: string): boolean {
  const [, short] = toolSourceNamespace(toolName, null);
  return WORKBENCH_ALWAYS_CONFIRM_SHORT_NAMES.has(short);
}

function isAcrDestructiveDomainTool(toolName: string): boolean {
  const [, short] = toolSourceNamespace(toolName, null);
  return ACR_DESTRUCTIVE_DOMAIN_SHORT_NAMES.has(short);
}

function isDstuPurgeTool(toolName: string): boolean {
  const [, short] = toolSourceNamespace(toolName, null);
  return short === 'dstu_purge';
}

function isGovernanceAlwaysConfirmTool(toolName: string): boolean {
  const [, short] = toolSourceNamespace(toolName, null);
  return GOVERNANCE_ALWAYS_CONFIRM_SHORT_NAMES.has(short);
}

function isPrivilegeEscalationTool(toolName: string): boolean {
  // 判定不得依赖 `builtin-` 前缀：裸名 `mcp_server_propose` 会被剥成
  // `server_propose` 而绕过匹配，因此先对完整工具名直接比对（fail-closed）。
  if (PRIVILEGE_ESCALATION_TOOLS.has(toolName)) return true;
  const [, short] = toolSourceNamespace(toolName, null);
  return PRIVILEGE_ESCALATION_TOOLS.has(short);
}

/** Public wrapper for pipeline gates that need privilege-escalation detection. */
export function isPrivilegeEscalationToolName(toolName: string): boolean {
  return isPrivilegeEscalationTool(toolName);
}

/** Argument-aware privilege escalation detection for multiplexed tools. */
export function isPrivilegeEscalationToolForArgs(toolName: string, args: JsonValue): boolean {
  const short = semanticToolShortName(toolName);
  if (short === 'skill_market_download_and_scan') {
    const install = jsonField(args, 'install');
    return typeof install === 'boolean' ? install : false;
  }
  return isPrivilegeEscalationTool(toolName);
}

/** 权限升级与 Workbench High 工具永不进入 remember / 本会话允许 / 始终允许。 */
export function neverRememberApproval(toolName: string): boolean {
  return isPrivilegeEscalationTool(toolName)
    || isWorkbenchAlwaysConfirmTool(toolName)
    || isAcrDestructiveDomainTool(toolName)
    || isDstuPurgeTool(toolName)
    || isGovernanceAlwaysConfirmTool(toolName);
}

/** Argument-aware never-remember policy. */
export function neverRememberApprovalForArgs(toolName: string, args: JsonValue): boolean {
  if (isPrivilegeEscalationToolForArgs(toolName, args)
    || isWorkbenchAlwaysConfirmTool(toolName)
    || isAcrDestructiveDomainTool(toolName)
    || isDstuPurgeTool(toolName)
    || isGovernanceAlwaysConfirmTool(toolName)) {
    return true;
  }
  if (isHighRiskExternalMcpTool(toolName)) return true;
  const short = semanticToolShortName(toolName);
  if (short === 'local_shell_preflight') return false;
  if (!isShellRuntimeToolForArgs(toolName, args)) return false;
  const [source] = toolSourceNamespace(toolName, args);
  if (source.startsWith('mcp')) return true;
  const command = jsonField(args, 'command');
  if (typeof command !== 'string') return true;
  return shellCommandToolSensitivity(command) !== ToolSensitivity.Medium;
}

export function requiresPreciseApprovalScope(toolName: string): boolean {
  return isShellRuntimeTool(toolName)
    || isFileMutationRuntimeTool(toolName)
    || isPrivilegeEscalationTool(toolName)
    || isWorkbenchPreciseActionTool(toolName)
    || isAcrDestructiveDomainTool(toolName)
    || isDstuPurgeTool(toolName)
    || isGovernanceAlwaysConfirmTool(toolName);
}

export function ignoresBroadApprovalBypassForArgs(toolName: string, args: JsonValue): boolean {
  return isShellRuntimeToolForArgs(toolName, args) || requiresPreciseApprovalScope(toolName);
}

export function ignoresBroadApprovalBypass(toolName: string): boolean {
  return requiresPreciseApprovalScope(toolName);
}

// ============================================================================
// 脱敏 / 边界附加字段
// ============================================================================

/** Redact all explicit shell environment values before arguments cross a boundary. */
export function redactToolArgumentsForDisplay(toolName: string, args: JsonValue): JsonValue {
  if (redactsApiKeyArgument(toolName)) {
    const redacted = cloneJson(args);
    const object = asJsonObject(redacted);
    if (object !== null) {
      const apiKey = object['api_key'];
      if (typeof apiKey === 'string' && apiKey !== '') object['api_key'] = '<redacted>';
    }
    return redacted;
  }
  if (!isShellRuntimeToolForArgs(toolName, args)) return cloneJson(args);
  const redacted = cloneJson(args);
  const object = asJsonObject(redacted);
  if (object === null) return redacted;
  const command = object['command'];
  if (typeof command === 'string') {
    const [display] = redactShellCommandForDisplay(command);
    object['command'] = display;
  }
  if (Object.hasOwn(object, 'env')) {
    const env = object['env'];
    const envObject = asJsonObject(env);
    if (envObject !== null) {
      for (const key of Object.keys(envObject)) envObject[key] = '[REDACTED]';
    } else {
      object['env'] = '[REDACTED]';
    }
  }
  delete object[ROOT_BINDING_FIELD];
  delete object[ROOT_PATH_FIELD];
  delete object[ROOT_ACCESS_FIELD];
  delete object[ROOT_SESSION_SCOPED_FIELD];
  delete object[READABLE_ROOTS_FIELD];
  delete object[ENV_PLAN_HASH_FIELD];
  delete object[INHERIT_ENV_FIELD];
  delete object[INHERITED_ENV_KEYS_FIELD];
  delete object[EXPLICIT_ENV_KEYS_FIELD];
  return redacted;
}

export function redactShellCommandForDisplay(command: string): [string, boolean] {
  const urlCredentials = /\b(https?:\/\/)[^/\s:@]+:[^@\s\/]+@/gi;
  const secretFlag = /(--(?:token|password|api[-_]?key)(?:\s*=\s*|\s+))((?:"[^"]*")|(?:'[^']*')|[^\s;&|]+)/gi;
  const querySecret = /([?&](?:token|api[-_]?key|password)=)[^&#\s]+/gi;
  const envSecret = /\b((?:export\s+)?(?:TOKEN|PASSWORD|PASSWD|API_KEY|SECRET|AUTHORIZATION|[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|PASSWORD|PASSWD|API_KEY|SECRET|AUTHORIZATION)[A-Za-z0-9_]*)\s*=\s*)((?:"[^"]*")|(?:'[^']*')|[^\s;&|]+)/gi;
  const curlUser = /(\s(?:-u|--user)(?:\s*=\s*|\s+))((?:"[^"]*")|(?:'[^']*')|[^\s;&|]+)/gi;
  const quotedSecretHeader = /(["'](?:Authorization|X-Api-Key)\s*:\s*)[^"']+/gi;
  const bareSecretHeader = /((?:Authorization|X-Api-Key)\s*:\s*)[^\s;&|]+/gi;

  const urlRedacted = command.replace(urlCredentials, '$1[REDACTED]@');
  const queryRedacted = urlRedacted.replace(querySecret, '$1[REDACTED]');
  const flagRedacted = queryRedacted.replace(secretFlag, '$1[REDACTED]');
  const envRedacted = flagRedacted.replace(envSecret, '$1[REDACTED]');
  const userRedacted = envRedacted.replace(curlUser, '$1[REDACTED]');
  const quotedHeaderRedacted = userRedacted.replace(quotedSecretHeader, '$1[REDACTED]');
  const display = quotedHeaderRedacted.replace(bareSecretHeader, '$1[REDACTED]');
  return [display, display !== command];
}

export function attachRuntimeRootApprovalBinding(
  args: JsonValue,
  binding: RuntimeRootApprovalBinding,
): JsonValue {
  const scoped = cloneJson(args);
  const object = asJsonObject(scoped);
  if (object === null) throw new Error('Shell arguments must be a JSON object');
  object[ROOT_PATH_FIELD] = binding.rootPath;
  object[ROOT_ACCESS_FIELD] = binding.rootAccess;
  object[ROOT_SESSION_SCOPED_FIELD] = binding.rootSessionScoped;
  object[ROOT_BINDING_FIELD] = binding.rootBinding;
  object[READABLE_ROOTS_FIELD] = [...binding.readableRoots];
  return scoped;
}
