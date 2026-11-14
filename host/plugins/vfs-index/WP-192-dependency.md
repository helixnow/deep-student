# WP-192 · N1 公开错误面阻塞

main 的 `host/plugins/media/api.ts` 已发布 `MediaTranscriberService.transcribe(request): Promise<MediaTranscriptionResult>`，但未重导出 `MediaError`。真实 provider `src/media-transcriber.ts:79-80` 抛该类，`src/errors.ts:19-21` 才有 `toPayloadString(): string`。

请 C1/C2 协调 L18 从 `media/api.ts` 重导出生产同一个 `MediaError`（含 `code`、`message`、`toPayloadString()`），或提供公开 `mediaTranscriptionFailure(error: unknown): { cancelled: boolean; display: string; payload: string }`，按 `src-tauri/crates/dstu-media/src/media/transcriber_hook.rs` 映射。L12 等待该公开面进入 main 后消费，不跨 import 实现或复制 payload serializer。

对应 Rust `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:999-1030`：cancelled 返回 Ok；普通失败 WARN display，以 current_stage + 原 payload set_error/emit_error，返回 Ok。注意 :1017 是 ERROR `Failed to set media error status`，并非 WARN；转写失败本身 :1010 才是 WARN。brief 的二次写失败 warn 需按源码订正。

当前会话继续处理 N2/N3 及真实 PDF 外层错误测试。N1 来源为源码反证，目前未称动态 A 实录。
