/**
 * 流式 hook 注册表（`dstu-llm/src/llm_manager/mod.rs` 4935–4991）。
 *
 * 注销采用「比较后删除」：`Drop` 触发的延迟清理可能晚于同一逻辑键上的替代
 * 请求完成注册；按对象身份比较才能保证旧 owner 不会把 replacement hook 一起
 * 摘掉。
 */

/** Rust `Arc<dyn LLMStreamHooks>` 的 JS 等价物：任意引用类型，按身份比较。 */
export type StreamHookOwner = object;

export class StreamHookRegistry {
  private readonly hooks = new Map<string, StreamHookOwner>();

  /** `register_stream_hooks`：同名事件总是以最新注册的 hook 为准。 */
  registerStreamHooks(streamEvent: string, hooks: StreamHookOwner): void {
    this.hooks.set(streamEvent, hooks);
  }

  /** `get_hook`：未注册时返回 null。 */
  getHook(streamEvent: string): StreamHookOwner | null {
    return this.hooks.get(streamEvent) ?? null;
  }

  /** `unregister_stream_hooks`：无条件注销（显式清理路径）。 */
  unregisterStreamHooks(streamEvent: string): void {
    this.hooks.delete(streamEvent);
  }

  /**
   * `unregister_stream_hooks_if_owner`：仅当注册表仍指向调用方的同一个对象时
   * 才删除并返回 true；旧 owner 的延后清理返回 false 且保留 replacement。
   */
  unregisterStreamHooksIfOwner(streamEvent: string, owner: StreamHookOwner): boolean {
    const current = this.hooks.get(streamEvent);
    if (current === undefined) return false;
    if (current !== owner) return false;
    this.hooks.delete(streamEvent);
    return true;
  }

  /** 已注册事件数（诊断用）。 */
  size(): number {
    return this.hooks.size;
  }
}

/** 进程级默认注册表，对应 `LLMManager::hooks_registry`。 */
export const defaultStreamHookRegistry = new StreamHookRegistry();

export function registerStreamHooks(streamEvent: string, hooks: StreamHookOwner): void {
  defaultStreamHookRegistry.registerStreamHooks(streamEvent, hooks);
}

export function getHook(streamEvent: string): StreamHookOwner | null {
  return defaultStreamHookRegistry.getHook(streamEvent);
}

export function unregisterStreamHooks(streamEvent: string): void {
  defaultStreamHookRegistry.unregisterStreamHooks(streamEvent);
}

export function unregisterStreamHooksIfOwner(
  streamEvent: string,
  owner: StreamHookOwner,
): boolean {
  return defaultStreamHookRegistry.unregisterStreamHooksIfOwner(streamEvent, owner);
}
