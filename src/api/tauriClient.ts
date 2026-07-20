/**
 * 统一 Tauri IPC 客户端（基建，零业务耦合）
 *
 * 提供 typed invoke 包装：泛型返回、统一错误分类、可选超时、可观测日志。
 * 现有约 200 处散落的裸 `invoke(...)` 调用不强制迁移；新代码（尤其是移动端
 * 相关模块）建议通过本模块调用后端命令。
 *
 * ## 接入示例
 *
 * ```ts
 * import { tauriInvoke, TauriIpcError } from '@/api/tauriClient';
 *
 * // 1. 基本调用（与裸 invoke 等价，但错误统一为 TauriIpcError）
 * const items = await tauriInvoke<TodoItem[]>('todo_list_items', {
 *   listId, includeCompleted: false, limit: 50, offset: 0,
 * });
 *
 * // 2. 带超时（弱网/移动端建议对非流式命令设置超时）
 * const probe = await tauriInvoke<NetworkProbeResult>('network_probe', {
 *   url: apiBase, timeoutMs: 3000,
 * }, { timeoutMs: 5000 });
 *
 * // 3. 错误分类处理
 * try {
 *   await tauriInvoke('todo_toggle_item', { itemId, expectedUpdatedAt });
 * } catch (e) {
 *   if (e instanceof TauriIpcError && e.kind === 'business') {
 *     // 后端命令返回的业务错误（如 TODO_CONFLICT 乐观锁冲突）
 *   }
 * }
 * ```
 */

import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// 错误分类
// ============================================================================

/**
 * IPC 错误分类：
 * - `business`: 命令正常送达后端、后端返回 Err（业务语义错误，通常可向用户展示）
 * - `ipc`: 调用未能送达/序列化失败/命令未注册/非 Tauri 环境（基础设施错误）
 * - `timeout`: 调用超出调用方指定的 timeoutMs（后端可能仍在执行，注意幂等性）
 */
export type TauriIpcErrorKind = 'business' | 'ipc' | 'timeout';

export class TauriIpcError extends Error {
  /** 错误分类 */
  readonly kind: TauriIpcErrorKind;
  /** 触发错误的命令名 */
  readonly command: string;
  /** 原始错误（后端 Err 载荷或底层异常） */
  readonly rawCause: unknown;

  constructor(kind: TauriIpcErrorKind, command: string, message: string, rawCause: unknown) {
    super(message);
    this.name = 'TauriIpcError';
    this.kind = kind;
    this.command = command;
    this.rawCause = rawCause;
  }
}

// ============================================================================
// 环境与错误归类辅助
// ============================================================================

/** 当前是否运行在 Tauri WebView 中（浏览器纯前端调试时为 false） */
export function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    (Boolean((window as Record<string, unknown>).__TAURI_INTERNALS__) ||
      Boolean((window as Record<string, unknown>).__TAURI_IPC__))
  );
}

function toMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * 归类原始 invoke 异常。
 *
 * Tauri 的 `invoke` 对"命令返回 Err(String)"与"IPC 层失败"都以 reject 表达，
 * 这里用保守启发式区分：命令未注册/环境缺失等固定文案归为 `ipc`，
 * 其余（后端命令主动返回的错误字符串/对象）归为 `business`。
 */
function classifyInvokeError(command: string, err: unknown): TauriIpcError {
  const message = toMessage(err);
  const lower = message.toLowerCase();
  const isInfra =
    lower.includes('unknown command') ||
    lower.includes('command not found') ||
    lower.includes('not allowed') || // capability/ACL 拒绝
    lower.includes('__tauri') ||
    lower.includes('window.__tauri_ipc__');
  return new TauriIpcError(
    isInfra ? 'ipc' : 'business',
    command,
    `[${command}] ${message}`,
    err,
  );
}

// ============================================================================
// 核心 API
// ============================================================================

export interface TauriInvokeOptions {
  /**
   * 可选超时（ms）。超时后 Promise 以 kind='timeout' 的 TauriIpcError reject；
   * 注意后端命令可能仍在执行（Tauri IPC 无取消语义），调用方需保证幂等或自行对账。
   */
  timeoutMs?: number;
  /** 静默模式：不输出 console 日志（高频轮询类调用建议开启） */
  silent?: boolean;
}

/** 慢调用告警阈值（ms） */
const SLOW_INVOKE_WARN_MS = 2_000;
const LOG_PREFIX = '[tauriClient]';

/**
 * typed invoke 包装：泛型返回 + 统一错误分类 + 可选超时 + 可观测。
 *
 * @param command Tauri 命令名（snake_case，与 generate_handler 注册名一致）
 * @param args 命令参数（camelCase key，由 Tauri 自动映射到 Rust snake_case 参数）
 * @param options 超时/日志选项
 */
export async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
  options?: TauriInvokeOptions,
): Promise<T> {
  if (!isTauriRuntime()) {
    throw new TauriIpcError(
      'ipc',
      command,
      `[${command}] Tauri runtime unavailable (running in plain browser?)`,
      null,
    );
  }

  const t0 = performance.now();
  const invocation = invoke<T>(command, args).then(
    (result) => {
      const elapsed = Math.round(performance.now() - t0);
      if (!options?.silent && elapsed >= SLOW_INVOKE_WARN_MS) {
        console.warn(LOG_PREFIX, `slow invoke: ${command} took ${elapsed}ms`);
      }
      return result;
    },
    (err: unknown) => {
      const classified = classifyInvokeError(command, err);
      if (!options?.silent) {
        console.warn(
          LOG_PREFIX,
          `invoke failed (${classified.kind}): ${command}`,
          toMessage(err),
        );
      }
      throw classified;
    },
  );

  const timeoutMs = options?.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) {
    return invocation;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (!options?.silent) {
        console.warn(LOG_PREFIX, `invoke timeout after ${timeoutMs}ms: ${command}`);
      }
      reject(
        new TauriIpcError(
          'timeout',
          command,
          `[${command}] invoke timed out after ${timeoutMs}ms (backend may still be running)`,
          null,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([invocation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // 超时后吞掉 invocation 的后续 rejection，避免 unhandledrejection 噪声
    invocation.catch(() => {});
  }
}

/**
 * 便捷变体：失败时返回 fallback 而非抛错（适合非关键读路径，如统计/预取）。
 */
export async function tauriInvokeOr<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  fallback: T,
  options?: TauriInvokeOptions,
): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args, options);
  } catch {
    return fallback;
  }
}
