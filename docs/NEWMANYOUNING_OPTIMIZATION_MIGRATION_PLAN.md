# Newmanyouning 优化吸收方案

## 目标

以当前 `main` 为唯一集成基线，充分吸收 `newmanyouning/main` 中仍对应现实问题的优化，同时保持当前主线已有功能、协议和安全边界。目标不是机械 cherry-pick，而是使对方想解决的问题在新架构中得到等价或更完整的解决。

## 基线与原则

- 当前主线基线：`d22e345b2`（已先提交原工作区改动）。
- 对方分支：`newmanyouning/main`，远端快照 `3c134a71c`。
- 不整体合并个人发行版、旧架构重构或大规模删除提交。
- 每项改造先核对当前代码是否仍存在对应问题；已有修复只补测试，不重复实现。
- 保留当前主线最近的 Chat、工具、附件、Windows shell 和数据治理修复。
- 子代理不得编译、测试、切换分支、stash、reset 或修改无关文件。

## 工作域

### A. Chat 流式与消息列表

吸收目标：chunk buffer、批量 store 更新、complete/cancel/error flush、迟到事件隔离、恢复代际保护、稳定 session key、程序化滚动锁、测量节流、代码块原生滚动兜底。

重点文件：`src/features/chat/core/middleware/eventBridge.ts`、`src/features/chat/core/store/streamActions.ts`、`src/features/chat/core/store/restoreActions.ts`、`src/features/chat/components/MessageList.tsx`、`src/features/chat/components/renderers/StreamingBlockRenderer.tsx`、聊天样式。

验收：多变体、乱序、取消、错误、快速切换会话、长 Markdown、公式/代码块/Anki block 不串内容、不回弹、不明显增加渲染压力。

### B. Chat 会话分页与快照

吸收目标：staged restore、宽松旧数据校验、单 block 损坏隔离、历史消息向上懒加载、scroll anchoring、对话快照导入导出及全量 ID 重映射。

重点文件：`src-tauri/src/chat_v2/handlers/load_session.rs`、`src-tauri/src/chat_v2/repo.rs`、Chat store session/restore 文件、必要的新 snapshot handler 和前端导出 API。

验收：旧数据、缺失 block、未知 block、tail/full 一致；长会话初始只取尾部；导入事务失败可回滚，所有内部 ID 和资源引用不冲突。

### C. 同步、备份与移动构建

吸收目标：Android 本地备份导入的 `spawn_blocking` 边界和进度节流、`shasum` 回退、WebDAV 主动滑窗限流、字节级单调进度及退避状态透传。

重点文件：`src-tauri/src/data_governance/commands_restore.rs`、`src-tauri/src/backup_job_manager.rs`、`src-tauri/src/cloud_storage/webdav.rs`、`src-tauri/src/data_governance/sync/*`、`scripts/build_android.sh`。

不得重复移植当前已有的 PROPFIND、Retry-After、基础重试、密钥槽位路径和 Android 工具探测实现。

### D. PDF/OCR、设置与清理

吸收目标：OCR 卡住任务启动恢复、旧 PDF 预览后台回填、必要时 PaddleOCR 分层接入、settings API 统一、vendor/profile/config 统一刷新、经依赖审计确认后的死代码和 CSS 清理。

重点文件：PDF/OCR 初始化和服务、`src/api/settingsApi.ts` 及 settings 组件、归档清理清单。

PaddleOCR 先实现边界清晰的客户端/协议，不在没有安全、大小、超时、取消和回退策略时直接接入生产流程。

## 不纳入整体迁移

- 对方旧版 Chat/VFS/DSTU/LLM 全量重构。
- 包名、图标、签名、个人发布渠道。
- 未经动态 import、移动端、demo、command registry 审计的批量删除。
- 全局替换滚动条或完全取消流式自动追底。

## 集成顺序

1. A、B、C、D 分域改造，避免多个代理编辑同一文件。
2. 主代理审查 diff，解决协议和命名冲突。
3. 补齐跨域测试，优先覆盖流式竞态、恢复竞态、同步进度和 Android 恢复。
4. 执行 `cargo check --lib`、相关 Rust 测试、前端类型检查和定向 Vitest。
5. 执行构建与 demo/桌面关键路径验证。
6. 最后进行死代码和 CSS 清理，逐批提交并保留 manifest。

## 交付要求

每个工作域必须返回：修改文件、吸收的对方提交/问题、未吸收项目及原因、与当前主线融合点。不得以“代码已复制”替代行为验收。所有实现最终必须在当前 `main` 上可编译、可测试、可运行。

## 当前进度

- 已完成并验证：Android ZIP 导入移出 async runtime，Android 构建摘要工具回退，Chat 终态前 flush，历史 block 单项隔离，代码块原生滚动兜底，PDF 状态完整覆盖基础 API，vendor/profile 刷新入口，宽松历史 session ID 校验。
- 当前主线已有：Chat chunkBuffer 主接入与采样、OCR stuck task 自动续跑、WebDAV PROPFIND/Retry-After/基础重试、备份密钥槽位修复、Windows shell fallback、Android 构建工具探测。
- 本轮已吸收：迟到流事件会话隔离、终态前 chunk flush、损坏历史 message/block 单项隔离、旧 session ID 兼容、WebDAV provider-aware 主动滑窗限流、Android ZIP blocking/工具回退格式修复。
- 当前主线已有等价实现：Chat FIFO 多变体与采样 buffer、历史 scroll anchoring 基础、OCR stuck task 自动续跑、WebDAV Retry-After/重试/真实字节进度、Android spawn_blocking 与 sha256sum 回退、单实例聚焦恢复、settings 批量 API 基础。
- 已吸收：用户迁移级对话快照导入/导出后端协议、事务化 ID remap、50MiB 限制、前端文件导入导出入口；Settings 业务直接 IPC 已迁移为统一 API；历史 PDF 缺失 `preview_json` 的启动后台分批回填（每批 5 个、路径安全校验、`spawn_blocking` 渲染）；WebDAV 同一 provider（endpoint host + 用户名）跨 storage 实例共享主动滑窗限流。
- 未吸收：历史分页 UI 的完整 loading/retry/exhausted 交互；WebDAV 限流等待的取消、provider/session 全链路并发控制、前端 retrying/backoff/failed/completed 状态闭环；死代码/CSS 依赖审计清理。

### 本轮验证证据

- `cargo check --lib --manifest-path src-tauri/Cargo.toml`：通过（共享 WebDAV 限流与 PDF 回填接线）。
- `cargo test --lib cloud_storage::webdav::tests::provider_rate_limit_window_is_shared_across_storage_instances --manifest-path src-tauri/Cargo.toml`：1 passed。
- `cargo test --lib vfs::repos::pdf_preview --manifest-path src-tauri/Cargo.toml`：1 passed。
- `npm exec vitest run src/features/chat/core/middleware/__tests__/eventBridge.test.ts src/features/chat/core/store/__tests__/restoreActions.historyMerge.test.ts`：16 passed。
- 本轮 `npm run typecheck`：通过，无 TypeScript 错误。
- `npm run build:demo`：通过（Vite 构建完成；存在既有 chunk size/circular chunk 警告，未导致构建失败）。
- `npm run typecheck`、`cargo fmt`、`git diff --check`：通过。
