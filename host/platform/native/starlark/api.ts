/**
 * Engine boundary for dstu-agent/chat_v2/tools/ptc_runtime.rs.
 *
 * The evaluator is the Rust `starlark 0.14.2` crate compiled to WASI, so the
 * dialect, globals, numeric semantics and interpreter limits are identical.
 * `call` / `object_read` / `object_write` are host functions: the engine asks
 * this side to execute them and replays the script with the recorded answers
 * (Starlark is deterministic, so the prefix runs identically).
 */
export type StarlarkJson = null | boolean | number | string | StarlarkJson[] | { [key: string]: StarlarkJson };

export interface StarlarkLimits {
  max_callstack_size: number;
  max_heap_bytes: number;
  max_tick_count: number;
}

export interface StarlarkEvaluateOptions {
  limits: StarlarkLimits;
  signal: AbortSignal;
  /** Absolute deadline as Unix epoch milliseconds (`Date.now() + timeout`). */
  deadlineMs: number;
  /**
   * Execute one admitted tool call and return its output (wrapped by the engine
   * into `{"ok": true, "output": …}`).  Throw {@link StarlarkToolFailure} for a
   * tool-level failure; any other exception is a script-level error and aborts
   * evaluation (matching the Rust policy/budget failures).
   */
  call(tool: string, args: StarlarkJson): Promise<StarlarkJson>;
  objectRead(object: StarlarkJson, options: StarlarkJson): Promise<StarlarkJson>;
  objectWrite(object: StarlarkJson, options: StarlarkJson): Promise<StarlarkJson>;
}

export interface NativeStarlark {
  evaluate(script: string, options: StarlarkEvaluateOptions): Promise<StarlarkJson>;
}

/**
 * A tool execution failure that the script observes as
 * `{"ok": false, "error": message}` instead of aborting (Rust
 * `PtcCallRequest.resp_tx = Err(message)`).
 */
export class StarlarkToolFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StarlarkToolFailure';
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { nativeStarlark: NativeStarlark }
}
