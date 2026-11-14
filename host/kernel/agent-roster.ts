/**
 * `src-tauri/src/agent_wiring/roster.rs` 的双信源：显式执行器顺序。
 *
 * Rust 的 `AppExecutorRoster` 直接构造各 lane 的执行器实例；Host 侧由各领域插件经
 * `agentTools.registerToolExecutors` 发布同名执行器，`orderExecutorsByRoster` 按本文件的
 * 顺序装配（first-wins `canHandle`），缺失条目不补占位实现：其工具 schema 不下发给模型。
 * `EXECUTOR_ROSTER_LEDGER` 记录每个条目的 Rust 源文件、Host 归属插件与当前移植状态。
 */

/** `roster.rs:39-111`：无条件注册的执行器，顺序即分发顺序。 */
export const APP_EXECUTOR_ROSTER = [
  'AttemptCompletionExecutor',
  'CanvasToolExecutor',
  'ChatAnkiToolExecutor',
  'BuiltinRetrievalExecutor',
  'InsightRecallExecutor',
  'BuiltinResourceExecutor',
  'ConnectorToolExecutor',
  'TaskAuditExecutor',
  'DstuToolExecutor',
  'AttachmentToolExecutor',
  'FetchExecutor',
  'BrowserToolExecutor',
  'MediaToolExecutor',
  'OfficeFidelityExecutor',
  'McpProposeExecutor',
  'McpManageExecutor',
  'AutomationExecutor',
  'AcademicSearchExecutor',
  'PaperSaveExecutor',
  'KnowledgeExecutor',
  'TodoListExecutor',
  'GoalExecutor',
  'QBankExecutor',
  'TranslationToolExecutor',
  'SettingsModelsToolExecutor',
  'LlmUsageToolExecutor',
  'LearningOverviewExecutor',
  'FsrsSettingsExecutor',
  'DataGovernanceToolExecutor',
  'MemoryToolExecutor',
  'UserTodoExecutor',
  'SkillsExecutor',
  'TemplateDesignerExecutor',
  'TextbookPdfToolExecutor',
  'IndexWebpageToolExecutor',
  'AskUserExecutor',
  'SessionToolExecutor',
  'DocxToolExecutor',
  'PptxToolExecutor',
  'XlsxToolExecutor',
  'ImageGenerationExecutor',
  'GenerativeUiExecutor',
  'WorkspaceFsExecutor',
  'LspNavigationExecutor',
  'CodeNavigationExecutor',
  'FileManagerExecutor',
  'AttachmentStageExecutor',
  'NotesImportExecutor',
  'SkillInstallExecutor',
  'SkillMarketReadToolExecutor',
  'SkillMarketInstallToolExecutor',
  'SkillWorkshopExecutor',
  'SkillLifecycleExecutor',
  'LocalShellPreflightExecutor',
  'GitToolExecutor',
  'SelfInspectExecutor',
  'RolePackExecutor',
  'RuntimeRootRequestExecutor',
  'LocalShellExecuteExecutor',
  'EssayGradingExecutor',
  'ReviewToolExecutor',
  'DocumentProcessingExecutor',
  'WorkbenchToolExecutor',
] as const;

/** `roster.rs:112-137`：仅在注入了 `WorkspaceCoordinator` 时追加的组。 */
export const WORKSPACE_COORDINATOR_GROUP = [
  'WorkspaceToolExecutor',
  'SubagentExecutor',
  'SuperSessionExecutor',
  'CustomAgentExecutor',
  'CoordinatorSleepExecutor',
] as const;

/** `chat_v2::pipeline::assemble_registry` 的固定尾部（L03 所有，此处仅作顺序 oracle）。 */
export const PIPELINE_EXECUTOR_TAIL = ['ToolPackExecutor', 'PtcExecutor', 'GeneralToolExecutor'] as const;

export type AppExecutorName = (typeof APP_EXECUTOR_ROSTER)[number];
export type WorkspaceExecutorName = (typeof WORKSPACE_COORDINATOR_GROUP)[number];
export type PipelineTailExecutorName = (typeof PIPELINE_EXECUTOR_TAIL)[number];

export interface NamedExecutor {
  name(): string;
}

export class MissingExecutorError extends Error {
  readonly names: readonly string[];
  constructor(names: readonly string[]) {
    super(`executor roster is missing: ${names.map(name => `\`${name}\``).join(', ')}`);
    this.name = 'MissingExecutorError';
    this.names = names;
  }
}

export interface ExecutorRosterOptions {
  /** Rust `AppExecutorRoster::executors(workspace)`: `Some` 时追加协调器组。 */
  readonly workspace: boolean;
}

/**
 * 按 Rust 顺序从同名实例目录组装花名册。
 *
 * 缺失条目一次性全部报告；`catalog` 中出现未声明的名字不会被打乱顺序（忽略）。
 */
export function composeAppExecutorRoster<E extends NamedExecutor>(
  catalog: ReadonlyMap<string, E>,
  options: ExecutorRosterOptions,
): E[] {
  const order: readonly string[] = options.workspace
    ? [...APP_EXECUTOR_ROSTER, ...WORKSPACE_COORDINATOR_GROUP]
    : APP_EXECUTOR_ROSTER;
  const missing = order.filter(name => !catalog.has(name));
  if (missing.length > 0) throw new MissingExecutorError(missing);
  return order.map(name => catalog.get(name)!);
}

/** `assemble_registry` 之后的完整顺序（App 花名册 + L03 固定尾部）。 */
export function composePipelineExecutorRoster<E extends NamedExecutor>(
  catalog: ReadonlyMap<string, E>,
  options: ExecutorRosterOptions,
): E[] {
  const app = composeAppExecutorRoster(catalog, options);
  const missing = PIPELINE_EXECUTOR_TAIL.filter(name => !catalog.has(name));
  if (missing.length > 0) throw new MissingExecutorError(missing);
  return [...app, ...PIPELINE_EXECUTOR_TAIL.map(name => catalog.get(name)!)];
}

export interface RosterOrdering<E> {
  /** App 花名册 → 协调器组（仅 workspace）→ 花名册外的注册（保持注册顺序）→ 固定尾部。 */
  readonly executors: E[];
  /** 花名册中没有可执行注册的条目（按花名册顺序）；它们的工具不得下发给模型。 */
  readonly missing: string[];
}

/**
 * 运行期装配：把插件实际注册的执行器排成 Rust 分发顺序，缺失条目只报告、不抛错。
 *
 * - 同名多个注册按注册顺序一起占据该槽位（例如 chatanki 拆成的多个执行器各有独立名字，
 *   落在花名册外的段里，但始终位于 `GeneralToolExecutor` 兜底之前）；
 * - `workspace: false` 时与 Rust 一致丢弃协调器组。
 */
export function orderExecutorsByRoster<E extends NamedExecutor>(
  registered: readonly E[],
  options: ExecutorRosterOptions,
): RosterOrdering<E> {
  const byName = new Map<string, E[]>();
  for (const executor of registered) {
    const name = executor.name();
    const group = byName.get(name);
    if (group === undefined) byName.set(name, [executor]);
    else group.push(executor);
  }
  const head: readonly string[] = options.workspace
    ? [...APP_EXECUTOR_ROSTER, ...WORKSPACE_COORDINATOR_GROUP]
    : APP_EXECUTOR_ROSTER;
  const known = new Set<string>([...APP_EXECUTOR_ROSTER, ...WORKSPACE_COORDINATOR_GROUP, ...PIPELINE_EXECUTOR_TAIL]);
  const take = (names: readonly string[]) => names.flatMap(name => byName.get(name) ?? []);
  const unlisted = registered.filter(executor => !known.has(executor.name()));
  return {
    executors: [...take(head), ...unlisted, ...take(PIPELINE_EXECUTOR_TAIL)],
    missing: [...head, ...PIPELINE_EXECUTOR_TAIL].filter(name => !byName.has(name)),
  };
}

/** 本分支移植状态：`executable` 已有执行体并注册；`metadata` 仅注册路由元数据；`missing` Host 无执行器。 */
export type RosterPortStatus = 'executable' | 'metadata' | 'missing';

export interface RosterLedgerEntry {
  /** `src-tauri/` 下的 Rust 源文件。 */
  readonly rust: string;
  /** Host 中实现/应实现该执行器的插件（`host/plugins/<plugin>`）。 */
  readonly plugin: string;
  readonly status: RosterPortStatus;
}

const R_APP = 'src/chat_v2/tools/';
const R_AGENT = 'crates/dstu-agent/src/chat_v2/tools/';

/**
 * 花名册盘点（W02，2026-11-07）。运行期真实状态以 `orderExecutorsByRoster(...).missing` 为准；
 * 这里是可追踪的快照，新增执行器后同步更新对应条目。
 */
export const EXECUTOR_ROSTER_LEDGER: Readonly<Record<AppExecutorName | WorkspaceExecutorName | PipelineTailExecutorName, RosterLedgerEntry>> = {
  AttemptCompletionExecutor: { rust: `${R_AGENT}attempt_completion.rs`, plugin: 'agent-orchestration', status: 'executable' },
  CanvasToolExecutor: { rust: `${R_APP}canvas_executor.rs`, plugin: 'notes', status: 'executable' },
  ChatAnkiToolExecutor: { rust: `${R_APP}chatanki_executor.rs`, plugin: 'chatanki', status: 'executable' },
  BuiltinRetrievalExecutor: { rust: `${R_APP}builtin_retrieval_executor.rs`, plugin: 'vfs', status: 'executable' },
  InsightRecallExecutor: { rust: `${R_APP}insight_recall_executor.rs`, plugin: 'memory', status: 'executable' },
  BuiltinResourceExecutor: { rust: `${R_APP}builtin_resource_executor.rs`, plugin: 'vfs', status: 'executable' },
  ConnectorToolExecutor: { rust: `${R_AGENT}connector_executor.rs`, plugin: 'agent-skills', status: 'executable' },
  TaskAuditExecutor: { rust: `${R_AGENT}task_audit_executor.rs`, plugin: 'agent-orchestration', status: 'executable' },
  DstuToolExecutor: { rust: `${R_APP}dstu_executor.rs`, plugin: 'vfs', status: 'executable' },
  AttachmentToolExecutor: { rust: `${R_APP}attachment_executor.rs`, plugin: 'vfs', status: 'executable' },
  FetchExecutor: { rust: `${R_AGENT}fetch_executor.rs`, plugin: 'agent-skills', status: 'executable' },
  BrowserToolExecutor: { rust: `${R_APP}browser_executor.rs`, plugin: 'browser', status: 'executable' },
  MediaToolExecutor: { rust: `${R_APP}media_executor.rs`, plugin: 'media', status: 'executable' },
  OfficeFidelityExecutor: { rust: `${R_APP}office_fidelity_executor.rs`, plugin: 'media', status: 'executable' },
  McpProposeExecutor: { rust: `${R_AGENT}mcp_propose_executor.rs`, plugin: 'agent-skills', status: 'executable' },
  McpManageExecutor: { rust: `${R_AGENT}mcp_manage_executor.rs`, plugin: 'agent-skills', status: 'executable' },
  AutomationExecutor: { rust: `${R_AGENT}automation_executor.rs`, plugin: 'agent-orchestration', status: 'executable' },
  AcademicSearchExecutor: { rust: `${R_APP}academic_search_executor.rs`, plugin: 'memory', status: 'executable' },
  PaperSaveExecutor: { rust: `${R_APP}paper_save_executor.rs`, plugin: 'memory', status: 'executable' },
  KnowledgeExecutor: { rust: `${R_APP}knowledge_executor.rs`, plugin: 'memory', status: 'executable' },
  TodoListExecutor: { rust: `${R_AGENT}todo_executor.rs`, plugin: 'agent-orchestration', status: 'executable' },
  GoalExecutor: { rust: `${R_AGENT}goal_executor.rs`, plugin: 'agent-orchestration', status: 'executable' },
  QBankExecutor: { rust: `${R_APP}qbank_executor.rs`, plugin: 'qbank', status: 'executable' },
  TranslationToolExecutor: { rust: `${R_APP}translation_executor.rs`, plugin: 'translation', status: 'executable' },
  SettingsModelsToolExecutor: { rust: `${R_APP}settings_models_executor.rs`, plugin: 'llm', status: 'executable' },
  LlmUsageToolExecutor: { rust: `${R_AGENT}llm_usage_executor.rs`, plugin: 'agent-skills', status: 'executable' },
  LearningOverviewExecutor: { rust: `${R_APP}learning_overview_executor.rs`, plugin: 'memory', status: 'executable' },
  FsrsSettingsExecutor: { rust: `${R_APP}fsrs_settings_executor.rs`, plugin: 'chatanki', status: 'executable' },
  DataGovernanceToolExecutor: { rust: `${R_APP}data_governance_executor.rs`, plugin: 'backup', status: 'executable' },
  MemoryToolExecutor: { rust: `${R_APP}memory_executor.rs`, plugin: 'memory', status: 'executable' },
  UserTodoExecutor: { rust: `${R_APP}user_todo_executor.rs`, plugin: 'notes', status: 'executable' },
  SkillsExecutor: { rust: `${R_AGENT}skills_executor.rs`, plugin: 'agent-skills', status: 'executable' },
  TemplateDesignerExecutor: { rust: `${R_APP}template_executor.rs`, plugin: 'chatanki', status: 'executable' },
  TextbookPdfToolExecutor: { rust: `${R_APP}textbook_pdf_executor.rs`, plugin: 'media', status: 'executable' },
  IndexWebpageToolExecutor: { rust: `${R_APP}index_webpage_executor.rs`, plugin: 'browser', status: 'executable' },
  AskUserExecutor: { rust: `${R_AGENT}ask_user_executor.rs`, plugin: 'agent-orchestration', status: 'executable' },
  SessionToolExecutor: { rust: `${R_AGENT}session_executor.rs`, plugin: 'agent-orchestration', status: 'executable' },
  DocxToolExecutor: { rust: `${R_APP}docx_executor.rs`, plugin: 'media', status: 'executable' },
  PptxToolExecutor: { rust: `${R_APP}pptx_executor.rs`, plugin: 'media', status: 'executable' },
  XlsxToolExecutor: { rust: `${R_APP}xlsx_executor.rs`, plugin: 'media', status: 'executable' },
  ImageGenerationExecutor: { rust: `${R_APP}image_generation_executor.rs`, plugin: 'media', status: 'executable' },
  GenerativeUiExecutor: { rust: `${R_APP}generative_ui_executor.rs`, plugin: 'vfs', status: 'executable' },
  WorkspaceFsExecutor: { rust: `${R_AGENT}workspace_fs_executor.rs`, plugin: 'agent-workspace', status: 'executable' },
  LspNavigationExecutor: { rust: `${R_AGENT}lsp_navigation_executor.rs`, plugin: 'agent-workspace', status: 'executable' },
  CodeNavigationExecutor: { rust: `${R_AGENT}code_navigation_executor.rs`, plugin: 'agent-workspace', status: 'executable' },
  FileManagerExecutor: { rust: `${R_AGENT}file_manager_executor.rs`, plugin: 'agent-workspace', status: 'executable' },
  AttachmentStageExecutor: { rust: `${R_AGENT}attachment_stage_executor.rs`, plugin: 'chat', status: 'executable' },
  NotesImportExecutor: { rust: `${R_APP}notes_import_executor.rs`, plugin: 'notes', status: 'executable' },
  SkillInstallExecutor: { rust: `${R_AGENT}skill_install_executor.rs`, plugin: 'agent-skills', status: 'executable' },
  SkillMarketReadToolExecutor: { rust: 'crates/dstu-agent/src/chat_v2/skill_market_client.rs', plugin: 'agent-skills', status: 'executable' },
  SkillMarketInstallToolExecutor: { rust: 'crates/dstu-agent/src/chat_v2/skill_market_client.rs', plugin: 'agent-skills', status: 'executable' },
  SkillWorkshopExecutor: { rust: `${R_AGENT}skill_workshop_executor.rs`, plugin: 'agent-skills', status: 'executable' },
  SkillLifecycleExecutor: { rust: `${R_AGENT}skill_lifecycle_executor.rs`, plugin: 'agent-skills', status: 'executable' },
  LocalShellPreflightExecutor: { rust: `${R_AGENT}local_shell_preflight_executor.rs`, plugin: 'agent-workspace', status: 'executable' },
  GitToolExecutor: { rust: `${R_AGENT}git_executor.rs`, plugin: 'agent-workspace', status: 'executable' },
  SelfInspectExecutor: { rust: `${R_AGENT}self_inspect_executor.rs`, plugin: 'agent-orchestration', status: 'executable' },
  RolePackExecutor: { rust: `${R_AGENT}role_pack_executor.rs`, plugin: 'agent-orchestration', status: 'executable' },
  RuntimeRootRequestExecutor: { rust: `${R_AGENT}runtime_root_request_executor.rs`, plugin: 'agent-workspace', status: 'executable' },
  LocalShellExecuteExecutor: { rust: `${R_AGENT}local_shell_execute_executor.rs`, plugin: 'agent-workspace', status: 'executable' },
  EssayGradingExecutor: { rust: `${R_APP}essay_grading_executor.rs`, plugin: 'review', status: 'executable' },
  ReviewToolExecutor: { rust: `${R_APP}review_executor.rs`, plugin: 'review', status: 'executable' },
  DocumentProcessingExecutor: { rust: `${R_APP}document_processing_executor.rs`, plugin: 'media', status: 'executable' },
  WorkbenchToolExecutor: { rust: `${R_AGENT}workbench_executor.rs`, plugin: 'agent-skills', status: 'executable' },
  WorkspaceToolExecutor: { rust: `${R_AGENT}workspace_executor.rs`, plugin: 'agent-workspace', status: 'executable' },
  SubagentExecutor: { rust: `${R_AGENT}subagent_executor.rs`, plugin: 'agent-orchestration', status: 'executable' },
  SuperSessionExecutor: { rust: `${R_AGENT}super_session_executor.rs`, plugin: 'agent-orchestration', status: 'executable' },
  CustomAgentExecutor: { rust: `${R_AGENT}custom_agent_executor.rs`, plugin: 'agent-orchestration', status: 'executable' },
  CoordinatorSleepExecutor: { rust: `${R_AGENT}sleep_executor.rs`, plugin: 'agent-orchestration', status: 'executable' },
  ToolPackExecutor: { rust: `${R_AGENT}tool_pack_executor.rs`, plugin: 'chat-pipeline', status: 'executable' },
  PtcExecutor: { rust: `${R_AGENT}ptc_executor.rs`, plugin: 'agent-skills', status: 'executable' },
  GeneralToolExecutor: { rust: `${R_AGENT}general_executor.rs`, plugin: 'agent-skills', status: 'executable' },
};
