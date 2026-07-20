/**
 * A45-2 — taskDashboard 应用 Agent 写能力执行器（docs/dev/acr/ACR-4.5.md）
 *
 * 制卡任务域没有前端 store：面板的真实控制链路是 `@/features/anki/taskControl`
 * 薄门面（内部 invoke Tauri 命令）。本文件全部写路径走同一门面（动态 import
 * 避免打包耦合），与 UI 按钮完全同链：
 * - retryTask（单分段重试）= FailedTasksPanel 逐段重试
 *   → controlDocumentTask({ taskId, action: 'retry' }) → trigger_task_processing；
 * - retryFailedTasks（批量重试）= SessionRow「重试失败」/ FailedTasksPanel「全部重试」
 *   → listFailedDocumentTasks + 逐个 trigger（allSettled，互不阻塞）；
 * - cancelSession（取消会话任务）= SessionRow「取消」
 *   → controlDocumentTask({ documentId, action: 'cancel' }) → cancel_document_processing。
 *
 * 契约要点（ACR-4.5 §2 统一纪律）：
 * - execute 前后通过 getDocumentTasks 重读域权威状态，`changed` 如实；
 *   no-op（重试未失败的任务 / 取消无进行中任务的会话）一律
 *   `changed:false` + 结构化 code/hint；
 * - 三个动作全部不可逆（重试从头生成、取消丢弃在途产出），不注册 undo inverse；
 * - 后端状态流转是异步的（trigger/cancel 返回 ≠ 状态已落库），
 *   写后重读若未见变化在回执 message 里如实告知，不静默。
 */
import type { DocumentTaskSummary } from '@/features/anki/taskControl';
import type { AgentActionResult, AgentJsonValue } from '../../core/types';
import type {
  TaskDashboardAgentItem,
  TaskDashboardAgentSnapshot,
} from './agentSurfaceRegistry';
import type {
  TaskDashboardAgentItemDetailed,
  TaskDashboardAgentSnapshotDetailed,
  TaskDashboardFocusedFailedTasks,
  TaskDashboardSessionStateTokens,
} from '@/features/anki-tasks/agentSurface';
import { stableAgentRef } from '../agentManifestUtils';

/** 与 agentManifests.ts taskDashboard 段保持同一 ref 编码 */
export function taskDashboardSessionRef(id: string): string {
  return stableAgentRef('taskDashboard', 'session', id);
}

/** 失败分段实体 ref（observe 的 task-segment 实体与 retryTask targetRef 共用） */
export function taskDashboardTaskRef(id: string): string {
  return stableAgentRef('taskDashboard', 'task', id);
}

/**
 * cancel_document_processing 实际取消的状态集合
 * （见 src-tauri/src/enhanced_anki_service.rs cancel 过滤条件）。
 */
const CANCELLABLE_TASK_STATUSES = new Set(['Pending', 'Processing', 'Streaming', 'Paused']);

/** 单次回执里最多罗列的重试任务 id 数（防止大会话撑爆回执） */
const MAX_REPORTED_TASK_IDS = 50;

type TaskControlModule = typeof import('@/features/anki/taskControl');

async function loadTaskControl(): Promise<TaskControlModule> {
  return import('@/features/anki/taskControl');
}

// ============================================================================
// 表面扩展字段的防御式 reader（旧形状表面 → 诚实降级，不抛错）
// ============================================================================

const STATE_TOKEN_KEYS = [
  'totalTasks',
  'completedTasks',
  'failedTasks',
  'activeTasks',
  'pausedTasks',
  'totalCards',
] as const;

/** 会话状态令牌；表面未提供扩展字段（legacy 形状）时返回 null，整体降级 */
export function readSessionStateTokens(
  session: TaskDashboardAgentItem,
): TaskDashboardSessionStateTokens | null {
  const candidate = session as Partial<TaskDashboardAgentItemDetailed>;
  const tokens: Record<string, number> = {};
  for (const key of STATE_TOKEN_KEYS) {
    const value = candidate[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    tokens[key] = value;
  }
  return tokens as unknown as TaskDashboardSessionStateTokens;
}

/** 焦点会话失败分段清单；表面未提供或形状不符时返回 null */
export function readFocusedFailedTasks(
  snapshot: TaskDashboardAgentSnapshot,
): TaskDashboardFocusedFailedTasks | null {
  const candidate = (snapshot as Partial<TaskDashboardAgentSnapshotDetailed>).focusedFailedTasks;
  if (!candidate || typeof candidate !== 'object') return null;
  if (typeof candidate.sessionId !== 'string' || !Array.isArray(candidate.tasks)) return null;
  return candidate;
}

// ============================================================================
// 回执辅助
// ============================================================================

function invalidArgs(hint: string): AgentActionResult {
  return { handled: false, changed: false, code: 'INVALID_ARGS', hint };
}

function actionNoop(hint: string): AgentActionResult {
  return { handled: false, changed: false, code: 'ACTION_UNAVAILABLE', hint };
}

/** 域调用异常 → 结构化回执，禁止 "Error: failed" 式裸错误 */
function failureFromError(actionName: string, error: unknown): AgentActionResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    handled: false,
    changed: false,
    code: 'ACTION_FAILED',
    hint: `${actionName} 失败：${message}`,
  };
}

function loadFailed(actionName: string, error: unknown): AgentActionResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    handled: false,
    changed: false,
    code: 'LOAD_FAILED',
    hint: `${actionName} 读取会话任务失败：${message}；请稍后重试或重新 observe`,
  };
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 写后重读（尽力而为）：失败不推翻已确认的写结果，只在回执里如实标注 */
async function reloadTasks(
  control: TaskControlModule,
  sessionId: string,
): Promise<DocumentTaskSummary[] | null> {
  try {
    return await control.getDocumentTasks(sessionId);
  } catch {
    return null;
  }
}

// ============================================================================
// retryTask — 单分段重试（不可逆：从头重新生成，可能产生新卡片）
// ============================================================================

export async function executeRetryTask(
  args: Record<string, unknown>,
): Promise<AgentActionResult> {
  const sessionId = stringArg(args.sessionId);
  const taskId = stringArg(args.taskId);
  if (!sessionId || !taskId) return invalidArgs('retryTask 需要非空 sessionId 和 taskId');
  const control = await loadTaskControl();
  let beforeTasks: DocumentTaskSummary[];
  try {
    beforeTasks = await control.getDocumentTasks(sessionId);
  } catch (error) {
    return loadFailed('retryTask', error);
  }
  const task = beforeTasks.find(item => item.id === taskId);
  if (!task) {
    return {
      handled: false,
      changed: false,
      code: 'ENTITY_NOT_FOUND',
      hint: `任务 ${taskId} 不在会话 ${sessionId} 中（或已被清理），请重新 observe 获取最新失败分段`,
    };
  }
  if (!control.isFailedTaskStatus(task.status)) {
    return actionNoop(
      `任务当前状态为 ${task.status}，不在失败口径（Failed/Truncated/Cancelled）内，retryTask 为 no-op`,
    );
  }
  const beforeStatus = task.status;
  try {
    // 与 FailedTasksPanel 逐段重试同链：后端会拒绝非法状态与重复触发
    await control.controlDocumentTask({ taskId, action: 'retry' });
  } catch (error) {
    return failureFromError('retryTask', error);
  }
  // 写后重读：trigger 已被域权威接受（状态机校验通过），流转本身是异步的
  const afterTasks = await reloadTasks(control, sessionId);
  const afterStatus = afterTasks?.find(item => item.id === taskId)?.status ?? null;
  const sessionRef = taskDashboardSessionRef(sessionId);
  const lagNote = afterStatus === null
    ? '；写后重读失败，请稍后重新 observe 确认进度'
    : control.isFailedTaskStatus(afterStatus)
      ? '；状态流转为异步，稍后重新 observe 查看进度'
      : `；当前状态 ${afterStatus}`;
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [sessionRef, taskDashboardTaskRef(taskId)],
    message: `分段 ${task.segment_index + 1}（任务 ${taskId}）已重新触发处理${lagNote}。重试会从头生成该分段且不可撤销。`,
    details: {
      sessionId,
      taskId,
      segmentIndex: task.segment_index,
      beforeStatus,
      afterStatus,
    },
    postconditions: [{ kind: 'ref_exists', ref: sessionRef }],
    // 不可逆：重试触发真实 LLM 生成，无精确逆操作，不注册 undo
  };
}

// ============================================================================
// retryFailedTasks — 批量重试会话全部失败口径任务（不可逆）
// ============================================================================

export async function executeRetryFailedTasks(
  args: Record<string, unknown>,
): Promise<AgentActionResult> {
  const sessionId = stringArg(args.sessionId);
  if (!sessionId) return invalidArgs('retryFailedTasks 需要非空 sessionId');
  const control = await loadTaskControl();
  let failedBefore: DocumentTaskSummary[];
  try {
    failedBefore = await control.listFailedDocumentTasks(sessionId);
  } catch (error) {
    return loadFailed('retryFailedTasks', error);
  }
  if (failedBefore.length === 0) {
    return actionNoop(
      '该会话当前没有失败口径任务（Failed/Truncated/Cancelled），retryFailedTasks 为 no-op',
    );
  }
  // 与 SessionRow「重试失败」/ FailedTasksPanel「全部重试」同链：
  // allSettled 逐个触发，个别失败不阻塞其余任务
  const results = await Promise.allSettled(
    failedBefore.map(task => control.controlDocumentTask({ taskId: task.id, action: 'retry' })),
  );
  const failures = results
    .map((result, index) => ({ result, task: failedBefore[index] }))
    .filter((entry): entry is { result: PromiseRejectedResult; task: DocumentTaskSummary } =>
      entry.result.status === 'rejected');
  const succeeded = results.length - failures.length;
  const firstFailureReason = failures.length > 0
    ? (failures[0].result.reason instanceof Error
      ? failures[0].result.reason.message
      : String(failures[0].result.reason))
    : null;
  if (succeeded === 0) {
    return {
      handled: false,
      changed: false,
      code: 'ACTION_FAILED',
      hint: `全部 ${results.length} 个失败任务的重试触发均失败（首个原因：${firstFailureReason}）`,
    };
  }
  // 写后重读剩余失败数（尽力而为；状态流转异步，数值可能滞后）
  let remainingFailedAfter: number | null = null;
  try {
    remainingFailedAfter = (await control.listFailedDocumentTasks(sessionId)).length;
  } catch {
    remainingFailedAfter = null;
  }
  const sessionRef = taskDashboardSessionRef(sessionId);
  const retriedTaskIds = failedBefore
    .filter((_, index) => results[index].status === 'fulfilled')
    .map(task => task.id);
  const details: Record<string, AgentJsonValue> = {
    sessionId,
    total: results.length,
    succeeded,
    failedToTrigger: failures.length,
    retriedTaskIds: retriedTaskIds.slice(0, MAX_REPORTED_TASK_IDS),
    retriedTaskIdsTruncated: retriedTaskIds.length > MAX_REPORTED_TASK_IDS,
    remainingFailedAfter,
  };
  const partialNote = failures.length > 0
    ? `，另有 ${failures.length} 个触发失败（首个原因：${firstFailureReason}），可稍后重新 observe 后对剩余分段单独 retryTask`
    : '';
  const lagNote = remainingFailedAfter === null
    ? '；写后重读失败，请稍后重新 observe 确认'
    : `；重读后失败口径任务剩余 ${remainingFailedAfter} 个（状态流转异步，数值可能滞后）`;
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [sessionRef],
    message: `已重新触发 ${succeeded}/${results.length} 个失败任务${partialNote}${lagNote}。重试会从头生成对应分段且不可撤销。`,
    details,
    postconditions: [{ kind: 'ref_exists', ref: sessionRef }],
    // 不可逆：同 retryTask，不注册 undo
  };
}

// ============================================================================
// cancelSession — 取消会话全部进行中/待处理/暂停任务（不可逆，High 确认）
// ============================================================================

export async function executeCancelSession(
  args: Record<string, unknown>,
): Promise<AgentActionResult> {
  const sessionId = stringArg(args.sessionId);
  if (!sessionId) return invalidArgs('cancelSession 需要非空 sessionId');
  const control = await loadTaskControl();
  let beforeTasks: DocumentTaskSummary[];
  try {
    beforeTasks = await control.getDocumentTasks(sessionId);
  } catch (error) {
    return loadFailed('cancelSession', error);
  }
  if (beforeTasks.length === 0) {
    return {
      handled: false,
      changed: false,
      code: 'ENTITY_NOT_FOUND',
      hint: `会话 ${sessionId} 不存在或没有任何任务，请重新 observe 核对`,
    };
  }
  const cancellableBefore = beforeTasks.filter(task => CANCELLABLE_TASK_STATUSES.has(task.status));
  if (cancellableBefore.length === 0) {
    return actionNoop(
      '该会话没有待处理/进行中/已暂停的任务可取消，cancelSession 为 no-op（已完成或已失败的任务不受取消影响）',
    );
  }
  try {
    // 与 SessionRow「取消」同链：停止调度并中断在途生成
    await control.controlDocumentTask({ documentId: sessionId, action: 'cancel' });
  } catch (error) {
    return failureFromError('cancelSession', error);
  }
  // 写后重读：统计仍处于可取消状态的任务数（异步中断可能尚未落库）
  const afterTasks = await reloadTasks(control, sessionId);
  const cancellableAfter = afterTasks === null
    ? null
    : afterTasks.filter(task => CANCELLABLE_TASK_STATUSES.has(task.status)).length;
  const sessionRef = taskDashboardSessionRef(sessionId);
  const lagNote = cancellableAfter === null
    ? '；写后重读失败，请稍后重新 observe 确认'
    : cancellableAfter > 0
      ? `；仍有 ${cancellableAfter} 个任务状态在流转中，请稍后重新 observe 确认`
      : '';
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [sessionRef],
    message: `已请求取消会话 ${cancellableBefore.length} 个待处理/进行中/暂停任务${lagNote}。`
      + '取消不可逆：进行中的生成会被中断丢弃；被取消任务计入失败口径，'
      + '之后可用 retryFailedTasks 从头重试，但已丢弃的在途产出无法恢复。',
    details: {
      sessionId,
      cancellableBefore: cancellableBefore.length,
      cancellableAfter,
    },
    postconditions: [{ kind: 'ref_exists', ref: sessionRef }],
    // 不可逆：不注册 undo inverse（诚实原则）
  };
}
