/**
 * agent-task/types — AgentTaskPanel 拆分后的共享类型
 *
 * 面板只读取 store 的一个窄切片（blocks / sessionId / activeBlockIds），
 * 用结构化的 readonly store 类型替代历史上的 `store: any`：
 * `StoreApi<ChatStore>` 可协变赋给 `AgentTaskStoreApi`（只含读取面）。
 */

import type { Block } from '../../core/types/block';

// ============================================================================
// Store 切片
// ============================================================================

export interface AgentTaskStoreState {
  blocks: Map<string, Block>;
  activeBlockIds: Set<string>;
  sessionId?: string;
}

/** zustand ReadonlyStoreApi 的结构化窄类型（仅面板需要的读取面） */
export interface AgentTaskStoreApi {
  getState: () => AgentTaskStoreState;
  getInitialState: () => AgentTaskStoreState;
  subscribe: (
    listener: (state: AgentTaskStoreState, prevState: AgentTaskStoreState) => void,
  ) => () => void;
}

// ============================================================================
// 计划步骤
// ============================================================================

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface Step {
  id: string;
  description: string;
  status: StepStatus;
  result?: string;
  createdAt: number;
  updatedAt?: number;
}

export interface TodoOutput {
  success: boolean;
  todoListId?: string;
  title?: string;
  steps?: Step[];
  isAllDone?: boolean;
  message?: string;
}

export interface TodoPlanSnapshot {
  steps: Step[];
  title?: string;
  isAllDone?: boolean;
  message?: string;
}

// ============================================================================
// 来源 / 产物
// ============================================================================

export interface SourceItem {
  id: string;
  title: string;
  url?: string;
  resourceId?: string;
  origin: string;
}

export interface ArtifactItem {
  id: string;
  kind: 'note' | 'file';
  label: string;
  toolName: string;
}

// ============================================================================
// Changes（写入/修改摘要）
// ============================================================================

export type ChangeAction = 'create' | 'update' | 'delete' | 'append' | 'write';
export type ChangeKind = 'note' | 'file' | 'document';

export interface ChangeItem {
  id: string;
  kind: ChangeKind;
  action: ChangeAction;
  label: string;
  target?: string;
  toolName: string;
  openId?: string;
  /** runtime root id（来自 file_change_summary，可用于 reveal/撤销） */
  rootId?: string;
  /** root 内相对路径（来自 file_change_summary） */
  relativePath?: string;
  /** 覆盖写时旧内容在 temp 根备份区的相对引用（撤销时恢复、预览时做 diff） */
  backupRef?: string;
  /** 写入完成后的内容哈希；撤销时用于阻止覆盖用户的后续修改 */
  afterHash?: string;
  /** workspace_file_* 返回的完整、hash-bound mutation receipt */
  receipt?: Record<string, unknown>;
}

export interface ChangeCoverageIssue {
  id: string;
  label: string;
  detail?: string;
}

/** Changes 内联预览的加载态（当前内容 + 可选备份旧内容） */
export interface ChangePreviewState {
  loading: boolean;
  error?: string;
  content?: string;
  truncated?: boolean;
  backupContent?: string;
}

export interface RuntimeFilePreview {
  content: string;
  truncated: boolean;
}

// ============================================================================
// Runtime（本地环境活动）
// ============================================================================

export type RuntimeAction = 'list' | 'read' | 'write' | 'check' | 'blocked';

export interface RuntimeItem {
  id: string;
  action: RuntimeAction;
  rootId: string;
  label: string;
  detail?: string;
  error?: string;
  toolName: string;
  /** shell 工具的完整命令（供可折叠命令全文展示） */
  command?: string;
  /** 危险信号：net = 放开网络；ops = 含 shell 操作符；delete = 删除类操作 */
  dangerFlags?: string[];
}

export interface RuntimeEnvironment {
  rootId?: string;
  rootLabel?: string;
  cwd?: string;
  sandboxBackend?: string;
  platform?: string;
  networkAllowed?: boolean;
}

// ============================================================================
// 完成态
// ============================================================================

export interface TaskCompletionSummary {
  /** attempt_completion 的结果叙述（优先），否则 todo message */
  result?: string;
  /** attempt_completion 建议命令（可选） */
  command?: string;
}
