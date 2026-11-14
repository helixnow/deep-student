// 内建工具清单（agent profile / 自定义 subagent 的安全全集）。
//
// Rust 依据：`chat_v2/tool_descriptors.rs` 的 `BUILTIN_DESCRIPTORS` 注册表是
// headless 白名单与 grants scope 分类的权威来源；`headless.rs`
// `LEGACY_HEADLESS_ALLOWED_TOOLS` 是与注册表逐名锁定的第二信源。工具注册表
// 与 executor 花名册属于其它 lane（不在本 lane 的移植范围），此处只固化本 lane
// 需要的两张表：headless 只读白名单（用于自定义 subagent 的安全全集）与
// grants scope 分类需要识别的 shell 族。

/** 裸名（无 `builtin-` 前缀），顺序与 `LEGACY_HEADLESS_ALLOWED_TOOLS` 一致。 */
const HEADLESS_BARE_NAMES: readonly string[] = [
  'attempt_completion',
  'todo_init',
  'todo_update',
  'todo_add',
  'todo_get',
  'unified_search',
  'rag_search',
  'web_search',
  'web_fetch',
  'settings_get',
  'model_assignments_get',
  'llm_usage_query',
  'backup_status',
  'backup_job_status',
  'sync_status',
  'index_status',
  'learning_overview',
  'pomodoro_today_stats',
  'pomodoro_daily_stats',
  'fsrs_get_scheduler_config',
  'memory_read',
  'memory_list',
  'resource_list',
  'resource_read',
  'resource_search',
  'folder_list',
  'dstu_list_trash',
  'user_todo_list_lists',
  'user_todo_list_items',
  'user_todo_get_summary',
  'user_todo_search',
  'user_todo_list_trash',
  'qbank_list',
  'qbank_list_questions',
  'qbank_get_question',
  'qbank_get_stats',
  'qbank_get_next_question',
  'review_get_due',
  'review_stats',
];

/** `headless_wire_name`：元工具保留裸名，其余加 `builtin-` 命名空间。 */
export function headlessWireName(bareName: string): string {
  return bareName === 'attempt_completion' || bareName.startsWith('todo_')
    ? bareName
    : `builtin-${bareName}`;
}

/** `headless::headless_allowed_tools()` 的线上调用名清单。 */
export const HEADLESS_ALLOWED_TOOLS: readonly string[] = HEADLESS_BARE_NAMES.map(headlessWireName);

/** Legacy workspace collaboration tools are retired; kept empty for Task-style subagent mode. */
export const COLLABORATION_TOOLS: readonly string[] = [];

/** Multi-agent Phase 2：自定义档案可声明的 chatanki 只读四工具。 */
export const CHATANKI_READONLY_TOOLS: readonly string[] = [
  'builtin-chatanki_get_cards',
  'builtin-chatanki_status',
  'builtin-chatanki_analyze',
  'builtin-chatanki_list_templates',
];

/** `GrantsScopeHint::Shell` 的注册表成员（`tool_descriptors.rs` 中 `.shell_scoped()`）。 */
const SHELL_BARE_NAMES: ReadonlySet<string> = new Set(['local_shell_preflight', 'local_shell_execute']);

const HEADLESS_BARE_SET: ReadonlySet<string> = new Set(HEADLESS_BARE_NAMES);

/** 本 lane 使用到的内建工具裸名（其余注册表成员不在本 lane 的移植范围）。 */
const KNOWN_BUILTIN_BARE_NAMES: ReadonlySet<string> = new Set([
  ...HEADLESS_BARE_NAMES,
  ...COLLABORATION_TOOLS.map(stripBuiltinPrefix),
  ...CHATANKI_READONLY_TOOLS.map(stripBuiltinPrefix),
  ...SHELL_BARE_NAMES,
]);

export function stripBuiltinPrefix(name: string): string {
  return name.startsWith('builtin-') ? name.slice('builtin-'.length) : name;
}

/** `tool_descriptors::is_headless_readonly`（接受 `builtin-` 前缀或裸名）。 */
export function isHeadlessAllowedTool(toolName: string): boolean {
  return HEADLESS_BARE_SET.has(stripBuiltinPrefix(toolName));
}

/** 该名字是否在本 lane 固化的注册表成员集中。 */
export function hasBuiltinDescriptor(toolName: string): boolean {
  return KNOWN_BUILTIN_BARE_NAMES.has(stripBuiltinPrefix(toolName));
}

export type GrantsScopeHint = 'builtin' | 'shell';

/** `tool_descriptors::grants_scope_hint`（未登记名字返回 null，由调用方兜底 Builtin）。 */
export function grantsScopeHint(toolName: string): GrantsScopeHint | null {
  const bare = stripBuiltinPrefix(toolName);
  if (SHELL_BARE_NAMES.has(bare)) return 'shell';
  if (KNOWN_BUILTIN_BARE_NAMES.has(bare)) return 'builtin';
  return null;
}
