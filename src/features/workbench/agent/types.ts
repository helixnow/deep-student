/**
 * ACR（Agent Collaborator Runtime）冻结契约 — ACR 4.0
 *
 * 本文件是历轮改造的接口真相源（docs/dev/acr/DESIGN.md §2 / docs/dev/acr/ACR-4.0.md §1）。
 * 【全员只读】：除 A1 契约代理外不得修改本文件；需要扩展时在进度报告中提"跨界申请"。
 *
 * ACR 4.0 增量：PresenceState.abortDeadline / resumable / placementHint；
 * 'reviewing' 状态正式启用（presenceStore.markSuggestionReviewing）；
 * ACR_ERROR_CODES 与 Rust workbench_executor KNOWN 表对齐补齐。
 */

// ---------------- 目标与操作 ----------------

/** 操作目标：typeId = workbench 应用类型；resourceId ≈ 窗口 instanceKey（content 类应用） */
export interface AcrTarget {
  typeId: string;
  resourceId?: string;
  /** ACR 3.0 exact host window. When present, type/resource must match this window. */
  windowId?: string;
}

/** probe 六态（DESIGN §1.1 路由表） */
export type AcrProbeState = 'closed' | 'clean' | 'dirty' | 'hot' | 'frozen' | 'disabled';

export interface ProbeResult {
  state: AcrProbeState;
  windowId: string | null;
}

/** 语义化操作单元。anchor 为语义锚点（nodeId / {heading,position} / itemId），由前端 Driver resolve */
export interface AgentOp {
  kind: string;
  anchor?: unknown;
  payload?: unknown;
  destructive: boolean;
  /** 人类可读步骤名（进度上报 / done 列表用），中文 */
  label: string;
}

// ---------------- 桥协议（Rust <-> 前端，事件名见 DESIGN §2.1） ----------------

export type AcrCommand =
  | 'probe'
  | 'apply_ops'
  | 'list_windows'
  | 'open_app'
  | 'app_command'
  | 'close_window'
  | 'query_state'
  | 'get_capabilities'
  | 'observe'
  | 'act'
  | 'wait_for'
  | 'revert_run';

export type AcrCommandAccess = 'read-only' | 'mutating' | 'dynamic';

/** `act` is resolved from every selected capability's `mutates` flag at runtime. */
export const ACR_COMMAND_ACCESS: Readonly<Record<AcrCommand, AcrCommandAccess>> = {
  probe: 'read-only',
  list_windows: 'read-only',
  query_state: 'read-only',
  get_capabilities: 'read-only',
  observe: 'read-only',
  wait_for: 'read-only',
  open_app: 'mutating',
  app_command: 'mutating',
  close_window: 'mutating',
  apply_ops: 'mutating',
  revert_run: 'mutating',
  act: 'dynamic',
};

export function getAcrCommandAccess(command: string): AcrCommandAccess | undefined {
  return ACR_COMMAND_ACCESS[command as AcrCommand];
}

export interface AcrBridgeRequest {
  correlationId: string;
  /** ACR 3.0 unguessable per-request echo token. Legacy local callers may omit it. */
  bridgeToken?: string;
  command: AcrCommand;
  args: unknown;
  timeoutMs: number;
  /** = toolCallId，贯穿工具卡 / presence / 账本 */
  runId: string;
  /** Original tool call identity retained for the tool card. */
  toolCallId?: string;
  sessionId: string;
}

/** Must stay byte-for-byte aligned with Rust `session_scoped_run_id`. */
export function makeAcrSessionRunId(sessionId: string, toolCallId: string): string {
  const byteLength = new TextEncoder().encode(sessionId).byteLength;
  return `acr3:${byteLength}:${sessionId}:${toolCallId}`;
}

export interface AcrBridgeResponse {
  correlationId: string;
  /** Must echo the request token on the Tauri transport. */
  bridgeToken?: string;
  /** 桥层是否成功（业务失败也 ok:true，失败语义进 data.status / error 码） */
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface AcrProgressEvent {
  correlationId: string;
  /** Must echo the request token on the Tauri transport. */
  bridgeToken?: string;
  step: number;
  total?: number;
  message: string;
  entityId?: string;
}

// ---------------- 回执（工具终态，给 LLM 的权威结果） ----------------

export type AcrReceiptStatus = 'completed' | 'partial' | 'cancelled' | 'failed';

export interface AcrReceipt {
  status: AcrReceiptStatus;
  /** 实际执行平面 */
  mode: 'frontend' | 'backend' | 'suggestion';
  applied: number;
  totalOps: number;
  entityIds: string[];
  /** 人类可读的已完成步骤 */
  done: string[];
  /** 未执行 / 已回滚步骤 */
  undone: string[];
  /** 用户接管后其修改摘要（Devin 协议）；partial 时尽量提供 */
  userPatch?: string;
  /** 走建议模式，等待用户 accept/reject */
  suggestionPending?: boolean;
  /** 给 LLM 的补充指引（降级/兜底必须在此说明） */
  message?: string;
  /** ACR 2.0 semantic actions may expose a callable revert_run token. */
  undoToken?: string;
  /** closure ledger = session; serializable inverse journal = persistent. */
  undoDurability?: 'session' | 'persistent';
  /** Observation revision after a verified action. */
  observationRevision?: string;
  /** Bridge terminal state could not be observed; caller must re-read before planning. */
  resultUnknown?: boolean;
  code?: string;
  retryable?: boolean;
}

export interface WindowSummary {
  windowId: string;
  typeId: string;
  instanceKey: string | null;
  title: string;
  lifecycle: string;
  focused: boolean;
  dirty: boolean;
  /** Whether the app exposes a self-describing ACR 2.0 manifest. */
  agentReady?: boolean;
  /** Static discovery hint; observe remains authoritative for current availability. */
  availableActions?: string[];
}

// ---------------- Pacing ----------------

export type PacingProfileName = 'fast' | 'normal' | 'demo';

export interface PacingProfile {
  name: PacingProfileName;
  /** 每 op 之间的最小间隔（导图节点等离散 op），ms */
  opIntervalMs: number;
  /** 打字机：每批字符数区间 */
  typeBatchMin: number;
  typeBatchMax: number;
  /** 打字机：批间隔（rAF 合帧后的目标节拍），ms */
  typeIntervalMs: number;
  /** 是否完全跳过演出（直落终态 + flash） */
  instant: boolean;
}

export interface Pacer {
  profile: PacingProfile;
  /** 等待下一个演出节拍；cost 为相对权重（默认 1） */
  tick(cost?: number): Promise<void>;
  dispose(): void;
}

// ---------------- Run / 仲裁 / 账本 ----------------

export type AcrRunStatus = 'acting' | 'pausedByUser' | 'reviewing' | 'done' | 'aborted';

/** ACR 4.0：presence 直落原因的结构化提示（UI 层 A5 负责 i18n 渲染） */
export type AcrPlacementHint = 'background' | 'stage-full' | 'frozen';

export interface PresenceState {
  /** Session-isolated runtime identity used for control and cleanup. */
  runKey: string;
  /** External tool-call identity retained for UI/tool-card correlation. */
  runId: string;
  sessionId: string;
  windowId: string;
  typeId: string;
  status: AcrRunStatus;
  /** 当前步骤的人类可读描述 */
  label: string;
  startedAt: number;
  ttlMs: number;
  /** ACR 4.0：pausedByUser 时的自动中止时刻（epoch ms），UI 据此渲染倒计时 */
  abortDeadline?: number;
  /** ACR 4.0：显式暂停后是否可由用户续放（AgentStrip 渲染「继续」按钮） */
  resumable?: boolean;
  /** ACR 4.0：直落终态的结构化原因；替代 label 中的中文后缀（UI 接线由 A5 完成） */
  placementHint?: AcrPlacementHint;
}

export interface RunLedger {
  /** 记录一条可逆操作；revert 时逆序执行 */
  record(runId: string, invert: () => Promise<void> | void, label: string): void;
  /** 逆序回滚整个 run；返回是否全部成功 */
  revertRun(runId: string): Promise<boolean>;
  hasRun(runId: string): boolean;
  /** run 结束时冻结（此后仍可 revert，直到被 LRU 淘汰） */
  sealRun(runId: string): void;
}

export interface AcrRunContext {
  /** Session-isolated runtime identity. Drivers must use this for maps/abort/ledger. */
  runId: string;
  /** External tool-call identity for domain events or user-visible correlation only. */
  externalRunId?: string;
  sessionId: string;
  target: AcrTarget;
  windowId: string | null;
  pacing: Pacer;
  /** 进度上报（内部 ≤5Hz 节流并转发到 Rust → 工具卡） */
  reportProgress(step: number, total: number, message: string, entityId?: string): void;
  /** 每个 op 之间必须调用；pausedByUser 时挂起，返回 resume 或 abort */
  checkPaused(): Promise<'resume' | 'abort'>;
  ledger: RunLedger;
}

// ---------------- Driver 与 StageManager ----------------

export interface CollabDriver {
  typeId: string;
  /** 同步探测（不许 await）；windowId 由 probe 模块给出，driver 只补充 dirty/hot 判定 */
  probe(target: AcrTarget): AcrProbeState;
  /** 逐 op 应用（内部走 pacing + checkPaused + reportProgress + ledger） */
  apply(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt>;
  /** 立即停止（由 StageManager 在 abort 路径调用），返回 partial 回执 */
  abort(runId: string): AcrReceipt;
  /** 账本之外的领域级回滚钩子（可选，默认走 ledger） */
  revert?(runId: string): Promise<boolean>;
}

export interface StageManagerApi {
  registerDriver(driver: CollabDriver): void;
  getDriver(typeId: string): CollabDriver | undefined;
  registerQueryProvider(scope: string, fn: (args: unknown) => unknown): void;
  /** AgentBridge 收到桥请求后调用 */
  handleBridgeRequest(req: AcrBridgeRequest): Promise<AcrBridgeResponse>;
  revertRun(runId: string, sessionId?: string): Promise<boolean>;
  /** Session-aware UI lookup; never probe the ledger with a bare toolCallId. */
  hasReversibleRun(runId: string, sessionId?: string): boolean;
  /** Read-only ACR transaction snapshot for DevPanel/tool-card diagnostics. */
  getDiagnostics(): AcrDiagnosticsSnapshot;
  /** WindowShell / 驱动层的用户输入探测入口（pointerdown/keydown 命中窗口内容区） */
  notifyUserInput(windowId: string): void;
  /** AgentStrip 显式按钮 */
  pauseRun(runId: string): void;
  stopRun(runId: string): void;
  /** 生命周期（WorkbenchDesktop 挂载/卸载） */
  start(): void;
  stop(): void;
}

export type AcrTransactionState = 'active' | 'cancelling' | 'orphan-draining';

export interface AcrTransactionDiagnostic {
  runId: string;
  sessionId: string;
  correlationId: string;
  kind:
    | 'apply_ops'
    | 'act'
    | 'wait_for'
    | 'revert_run'
    | 'open_app'
    | 'app_command'
    | 'close_window';
  windowId: string | null;
  state: AcrTransactionState;
  ownsLease: boolean;
}

export interface AcrLeaseDiagnostic {
  windowId: string;
  runId: string;
  sessionId: string;
}

export interface AcrDiagnosticsSnapshot {
  transactions: AcrTransactionDiagnostic[];
  leases: AcrLeaseDiagnostic[];
  cancelling: number;
  orphanDraining: number;
  undoInFlight: number;
}

// ---------------- 域事件（DESIGN §5.6） ----------------

export interface DomainChangePayload {
  source: 'agent' | 'user';
  action: string;
  entityIds?: string[];
  runId?: string;
  [key: string]: unknown;
}

// ---------------- 桥事件名常量 ----------------

export const ACR_EVENT_REQUEST = 'acr:bridge-request';
export const ACR_EVENT_RESPONSE_PREFIX = 'acr:bridge-response:';
export const ACR_EVENT_PROGRESS_PREFIX = 'acr:bridge-progress:';
export const ACR_EVENT_CANCEL = 'acr:bridge-cancel';

/**
 * 结构化错误码（与 Rust 侧对齐；R2-01 维护 ERRORS.md）。
 * ACR 4.0：补齐 workbench_executor.rs `extract_error_code` KNOWN 表已有、
 * 此前冻结子集缺失的码（CONFLICT 家族 / CANCELLED / RESULT_UNKNOWN 等），
 * 并收录前端 StageManager 自产的 UNSUPPORTED_ACTION / RUN_ID_* 码。
 */
export const ACR_ERROR_CODES = {
  WORKBENCH_UNAVAILABLE: 'WORKBENCH_UNAVAILABLE',
  WORKBENCH_DISABLED: 'WORKBENCH_DISABLED',
  WINDOW_BUSY: 'WINDOW_BUSY',
  WINDOW_NOT_FOUND: 'WINDOW_NOT_FOUND',
  DRIVER_NOT_FOUND: 'DRIVER_NOT_FOUND',
  STRICT_MODE: 'STRICT_MODE',
  ANCHOR_NOT_FOUND: 'ANCHOR_NOT_FOUND',
  APP_NOT_REGISTERED: 'APP_NOT_REGISTERED',
  APP_AGENT_UNAVAILABLE: 'APP_AGENT_UNAVAILABLE',
  OBSERVE_FAILED: 'OBSERVE_FAILED',
  CAPABILITY_NOT_FOUND: 'CAPABILITY_NOT_FOUND',
  ACTION_UNAVAILABLE: 'ACTION_UNAVAILABLE',
  INVALID_AGENT_REF: 'INVALID_AGENT_REF',
  TARGET_REF_MISMATCH: 'TARGET_REF_MISMATCH',
  INVALID_ACTION_ARGS: 'INVALID_ACTION_ARGS',
  STALE_OBSERVATION: 'STALE_OBSERVATION',
  FOCUS_REQUIRED: 'FOCUS_REQUIRED',
  RISK_APPROVAL_REQUIRED: 'RISK_APPROVAL_REQUIRED',
  ACTION_FAILED: 'ACTION_FAILED',
  INVALID_CONDITION: 'INVALID_CONDITION',
  POSTCONDITION_FAILED: 'POSTCONDITION_FAILED',
  UNDO_NOT_FOUND: 'UNDO_NOT_FOUND',
  // ---- ACR 4.0 与 Rust KNOWN 表对齐补录 ----
  BRIDGE_AUTH_FAILED: 'BRIDGE_AUTH_FAILED',
  BRIDGE_PROTOCOL_ERROR: 'BRIDGE_PROTOCOL_ERROR',
  STALE_TARGET_WINDOW: 'STALE_TARGET_WINDOW',
  WINDOW_TARGET_MISMATCH: 'WINDOW_TARGET_MISMATCH',
  CONDITION_NOT_MET: 'CONDITION_NOT_MET',
  UNDO_IN_PROGRESS: 'UNDO_IN_PROGRESS',
  UNDO_CONFLICT: 'UNDO_CONFLICT',
  UNDO_PARTIAL: 'UNDO_PARTIAL',
  INVALID_ARGS: 'INVALID_ARGS',
  TODO_CONFLICT: 'TODO_CONFLICT',
  QBANK_CONFLICT: 'QBANK_CONFLICT',
  NOTE_OCC_REQUIRED: 'NOTE_OCC_REQUIRED',
  NOTE_CONFLICT: 'NOTE_CONFLICT',
  NOTE_WRITE_FAILED: 'NOTE_WRITE_FAILED',
  DUPLICATE_RUN_ID: 'DUPLICATE_RUN_ID',
  DUPLICATE_CORRELATION_ID: 'DUPLICATE_CORRELATION_ID',
  RUN_ID_REUSE: 'RUN_ID_REUSE',
  RUN_ID_EXPIRED: 'RUN_ID_EXPIRED',
  CANCELLED: 'CANCELLED',
  RESULT_UNKNOWN: 'RESULT_UNKNOWN',
  // 前端 StageManager 自产（Rust 经桥透传原文）
  UNSUPPORTED_ACTION: 'UNSUPPORTED_ACTION',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
  INTERNAL: 'INTERNAL',
} as const;
