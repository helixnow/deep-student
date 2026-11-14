# X2 第二批定向核查移交（main 4c6cd1ba8，X2 提交 ef1a789a5）

证据：`scripts/electron-migration/frontend-audit/batch2.test.ts`（真实插件 apply + 内核 invoke，队列作业 20261104112829-229ee4 9 passed / exit 0），分类表见同目录 `REVIEW.md`「第二批定向核查」。

## L18-media-docs（新差异，抄送 C1）

- **X2-R22 media_transcribe_cancel**：Rust `dstu-media/src/media/commands.rs:375-377` 把 `cancel_media` 错误映射为 `MediaError::Database` → `{"code":"database-failed","message":...}` 字符串。Host `host/plugins/media/index.ts:528` 调 `pdf?.cancelMedia(...)`，抛出的普通 Error 经 `mediaFailure` 原样重抛，成为 HandlerPanic（生产中前端 Promise 不 settle）。复现：batch2 `X2-R22`（vfsIndex.pdf.cancelMedia 抛 Error）。仅 L12 cancelMedia 出错时可达。候选分支 ds-mig/L18-media-docs 同样。
- X2-R20 textbooks_add 仍未注册，与 LANE.md:225,404 自列阻塞一致，无新任务。
- X2-R19 media_transcribe_start、X2-R05b HEIC 桌面拒绝路径已在 main 真实验证通过；HEIC 跨进程 binary 与 Android 仍 unproven（不要求桌面伪造成功）。

## L04-chat-session / L03-chat-pipeline（已知待办，抄送 C1）

X2-R07–R12：chat_v2_send_message / retry_message / edit_and_resend / continue_message / compact_session / stage_context_attachments 在当前 main 真实 apply 后均为 commandNotFound；与 `host/plugins/chat/SPEC.md:14` 自列的 20 条未注册一致，不是新增任务。前端调用点见 REVIEW.md 表。

## 无需动作

- L17：quick_assistant_show/hide/apply_enabled 与 `quick-assistant://shown`（R14–R17）已真实调用通过；历史"不在 meta"作废。
- L04：`chat_v2://kill_switch_changed`（R13）发射已经真实调用证明。
- F5/C2：本批无契约问题。
- 既有前端问题（不改）：R18 get_image_as_base64 snake 回退冗余；R21 textbook-import-progress Option 字段前端标为非空。
