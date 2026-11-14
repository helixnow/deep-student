/**
 * 流式任务取消通道（Rust `static CANCEL_SENDERS`）。
 */
import type { NativeRegex } from '../../../platform/native/api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { AnkiLogger } from './logger.ts';

export interface StreamingAnkiDeps {
  db: DatabaseHandle | SqlExecutor;
  regex: Pick<NativeRegex, 'compile' | 'isMatch'>;
  logger: Pick<AnkiLogger, 'debug' | 'info' | 'warn' | 'error'>;
}

/**
 * 全局取消信号寄存（Rust `CANCEL_SENDERS`）。同 task 的再次订阅替换旧控制器。
 */
const CANCEL_CONTROLLERS = new Map<string, AbortController>();

/**
 * `cancel_streaming`（`streaming_anki_service.rs:3469-3478`）：
 * 先移除通道再发取消信号；未注册时返回 `任务 {id} 未在运行状态`。
 *
 * 该错误是删除/暂停路径的 abort 兜底触发条件，不能静默成功。
 */
export async function cancelStreaming(taskId: string): Promise<void> {
  const controller = CANCEL_CONTROLLERS.get(taskId);
  if (controller === undefined) {
    throw new Error(`任务 ${taskId} 未在运行状态`);
  }
  CANCEL_CONTROLLERS.delete(taskId);
  controller.abort();
}

/** `clear_cancel_sender`。 */
export async function clearCancelSender(taskId: string): Promise<void> {
  CANCEL_CONTROLLERS.delete(taskId);
}

/** `is_streaming`：任务是否仍注册了取消通道。 */
export async function isStreaming(taskId: string): Promise<boolean> {
  return CANCEL_CONTROLLERS.has(taskId);
}

/**
 * 注册任务取消通道（流式编排在开始处理前调用）。
 *
 * 传入 `runSignal` 时与调度层运行句柄联动：运行句柄被 abort 会同时中止流式请求，
 * 覆盖“配置读取仍在 await、取消通道尚未注册”的删除/暂停窗口。
 */
export function registerCancellation(
  taskId: string,
  runSignal?: AbortSignal,
): AbortSignal {
  CANCEL_CONTROLLERS.get(taskId)?.abort();
  const controller = new AbortController();
  CANCEL_CONTROLLERS.set(taskId, controller);
  if (runSignal !== undefined) {
    if (runSignal.aborted) {
      controller.abort();
    } else {
      runSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  return controller.signal;
}
