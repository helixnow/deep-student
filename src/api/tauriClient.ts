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
import { reportFrontendError } from '@/logging/errorReporter';

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

// ============================================================================
// 结构化 CommandError envelope（TD-11）
// ============================================================================

/**
 * 后端稳定错误 envelope（与 src-tauri `error_details::CommandError` 序列化对齐）。
 *
 * 契约：
 * - `code`：SCREAMING_SNAKE_CASE 稳定错误码，程序逻辑只允许依赖该字段；
 * - `message`：人类可读文案，随时可能改动，禁止字符串匹配；
 * - `data`：可选结构化上下文；`traceId`：可选后端日志关联 ID。
 */
export interface CommandErrorEnvelope {
  code: string;
  message: string;
  data?: unknown;
  traceId?: string;
}

/**
 * 从任意 invoke 拒因中解析结构化 envelope。
 * 支持两种传输形态：对象载荷（Result<T, CommandError>）与 JSON 字符串载荷；
 * 无法解析（legacy 纯文本错误等）返回 null，由调用方走 legacy fallback。
 */
export function parseCommandErrorEnvelope(raw: unknown): CommandErrorEnvelope | null {
  let candidate: unknown = raw;
  if (typeof candidate === 'string') {
    const text = candidate.trim();
    if (!text.startsWith('{')) return null;
    try {
      candidate = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  if (typeof record.code !== 'string' || record.code.length === 0) return null;
  if (typeof record.message !== 'string') return null;
  return {
    code: record.code,
    message: record.message,
    data: record.data,
    traceId: typeof record.traceId === 'string' ? record.traceId : undefined,
  };
}

export class TauriIpcError extends Error {
  /** 错误分类 */
  readonly kind: TauriIpcErrorKind;
  /** 触发错误的命令名 */
  readonly command: string;
  /** 原始错误（后端 Err 载荷或底层异常） */
  readonly rawCause: unknown;
  /** 结构化错误 envelope（TD-11）；legacy 字符串错误为 null */
  readonly envelope: CommandErrorEnvelope | null;
  /** 稳定错误码快捷访问（等价 envelope?.code） */
  readonly code?: string;

  constructor(
    kind: TauriIpcErrorKind,
    command: string,
    message: string,
    rawCause: unknown,
    envelope: CommandErrorEnvelope | null = null,
  ) {
    super(message);
    this.name = 'TauriIpcError';
    this.kind = kind;
    this.command = command;
    this.rawCause = rawCause;
    this.envelope = envelope;
    this.code = envelope?.code;
  }
}

// ============================================================================
// 环境与错误归类辅助
// ============================================================================

/** Tauri 注入到 WebView window 上的全局标记（仅用于运行时探测） */
type TauriGlobals = Window & {
  __TAURI_INTERNALS__?: unknown;
  __TAURI_IPC__?: unknown;
};

/** 当前是否运行在 Tauri WebView 中（浏览器纯前端调试时为 false） */
export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as TauriGlobals;
  return Boolean(w.__TAURI_INTERNALS__) || Boolean(w.__TAURI_IPC__);
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

/** legacy（非结构化）业务错误的可观测告警：每命令每会话只告警一次，避免刷屏 */
const legacyErrorShapeWarned = new Set<string>();

function warnLegacyErrorShape(command: string): void {
  if (legacyErrorShapeWarned.has(command)) return;
  legacyErrorShapeWarned.add(command);
  console.warn(
    LOG_PREFIX,
    `legacy string error payload from "${command}"; ` +
      'classification falls back to Display-text heuristics — migrate the backend command to CommandError envelope (TD-11)',
  );
}

/**
 * 归类原始 invoke 异常。
 *
 * TD-11：优先解析结构化 CommandError envelope（{ code, message, ... }），
 * 命中即为 `business` 且携带稳定 code。未命中时走 legacy 启发式（保守区分
 * ipc/business），并对 business 路径发出一次性可观测告警——该 fallback 属
 * 迁移期兜底，后端命令应逐步切到 envelope。
 */
export function classifyInvokeError(command: string, err: unknown): TauriIpcError {
  const envelope = parseCommandErrorEnvelope(err);
  if (envelope) {
    return new TauriIpcError(
      'business',
      command,
      `[${command}] ${envelope.message}`,
      err,
      envelope,
    );
  }
  const message = toMessage(err);
  const lower = message.toLowerCase();
  const isInfra =
    lower.includes('unknown command') ||
    lower.includes('command not found') ||
    lower.includes('not allowed') || // capability/ACL 拒绝
    lower.includes('__tauri') ||
    lower.includes('window.__tauri_ipc__');
  if (!isInfra) {
    warnLegacyErrorShape(command);
  }
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
  let invocationTimedOut = false;
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
      if (!options?.silent && !invocationTimedOut) {
        console.warn(
          LOG_PREFIX,
          `invoke failed (${classified.kind}): ${command}`,
          toMessage(err),
        );
        void reportFrontendError(classified, {
          kind: 'PLUGIN_ERROR',
          component: 'tauri-client',
          level: classified.kind === 'business' ? 'WARN' : 'ERROR',
          extra: {
            command,
            errorKind: classified.kind,
            // TD-11：结构化 code/traceId 随上报走，便于后端日志关联
            errorCode: classified.code,
            traceId: classified.envelope?.traceId,
          },
        }).catch(() => undefined);
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
      invocationTimedOut = true;
      if (!options?.silent) {
        console.warn(LOG_PREFIX, `invoke timeout after ${timeoutMs}ms: ${command}`);
        void reportFrontendError(`IPC timeout after ${timeoutMs}ms`, {
          kind: 'PLUGIN_ERROR',
          component: 'tauri-client',
          extra: { command, timeoutMs },
        }).catch(() => undefined);
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
