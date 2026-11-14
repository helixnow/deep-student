/**
 * qbank_generation/pipeline.rs 的进程内取消登记表。
 *
 * Rust 在 `run_qbank_generation_with_config` 里按 stream_event 注册
 * `CancellationToken`，取消命令同时调用 `request_cancel_stream`（LLM 传输）
 * 与 `cancel_generation_session`（生成任务未来）。
 */
export interface GenerationCancelToken {
  cancel(): void;
}

/** One registry per qbank plugin instance; tokens never outlive the plugin scope. */
export class GenerationSessions {
  private readonly tokens = new Map<string, GenerationCancelToken>();

  register(streamEvent: string, token: GenerationCancelToken): () => void {
    this.tokens.set(streamEvent, token);
    return () => {
      if (this.tokens.get(streamEvent) === token) this.tokens.delete(streamEvent);
    };
  }

  cancel(streamEvent: string): void {
    const token = this.tokens.get(streamEvent);
    if (token === undefined) return;
    this.tokens.delete(streamEvent);
    token.cancel();
  }

  /** Plugin scope disposal: cancel every registered session. */
  cancelAll(): void {
    for (const streamEvent of [...this.tokens.keys()]) this.cancel(streamEvent);
  }
}
