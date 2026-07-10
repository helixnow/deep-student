/**
 * ACR（Agent Collaborator Runtime）冻结契约 — R0.5 协调者脚手架
 *
 * 本文件是三轮改造的接口真相源（docs/dev/acr/DESIGN.md §2）。
 * 【全员只读】：任何 R1/R2 子代理不得修改本文件；需要扩展时在进度报告中提"跨界申请"。
 */

// ---------------- 目标与操作 ----------------

/** 操作目标：typeId = workbench 应用类型；resourceId ≈ 窗口 instanceKey（content 类应用） */
export interface AcrTarget {
  typeId: string;
  resourceId?: string;
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
  | 'revert_run';

export interface AcrBridgeRequest {
  correlationId: string;
  command: AcrCommand;
  args: unknown;
  timeoutMs: number;
  /** = toolCallId，贯穿工具卡 / presence / 账本 */
  runId: string;
  sessionId: string;
}

export interface AcrBridgeResponse {
  correlationId: string;
  /** 桥层是否成功（业务失败也 ok:true，失败语义进 data.status / error 码） */
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface AcrProgressEvent {
  correlationId: string;
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
}

export interface WindowSummary {
  windowId: string;
  typeId: string;
  instanceKey: string | null;
  title: string;
  lifecycle: string;
  focused: boolean;
  dirty: boolean;
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

export interface PresenceState {
  runId: string;
  windowId: string;
  typeId: string;
  status: AcrRunStatus;
  /** 当前步骤的人类可读描述 */
  label: string;
  startedAt: number;
  ttlMs: number;
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
  runId: string;
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
  revertRun(runId: string): Promise<boolean>;
  /** WindowShell / 驱动层的用户输入探测入口（pointerdown/keydown 命中窗口内容区） */
  notifyUserInput(windowId: string): void;
  /** AgentStrip 显式按钮 */
  pauseRun(runId: string): void;
  stopRun(runId: string): void;
  /** 生命周期（WorkbenchDesktop 挂载/卸载） */
  start(): void;
  stop(): void;
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

/** 结构化错误码（与 Rust 侧对齐；R2-01 维护 ERRORS.md） */
export const ACR_ERROR_CODES = {
  WORKBENCH_UNAVAILABLE: 'WORKBENCH_UNAVAILABLE',
  WORKBENCH_DISABLED: 'WORKBENCH_DISABLED',
  WINDOW_BUSY: 'WINDOW_BUSY',
  WINDOW_NOT_FOUND: 'WINDOW_NOT_FOUND',
  DRIVER_NOT_FOUND: 'DRIVER_NOT_FOUND',
  STRICT_MODE: 'STRICT_MODE',
  ANCHOR_NOT_FOUND: 'ANCHOR_NOT_FOUND',
} as const;
