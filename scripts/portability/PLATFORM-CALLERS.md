# `util/path.ts` 与 `crypto/sync.ts` 的调用方清单

由 `node scripts/portability/platform-callers.mjs --out scripts/portability/PLATFORM-CALLERS.md` 生成（插件生产代码，不含测试与 `equivalence/`）。

## `node:path` → `host/platform/util/path.ts`

同名函数、语义与 `node:path` 一致，替换只改 import。`resolve` 在移动端需要绝对路径段（没有工作目录）。
共 183 个文件；其中 17 个换掉后不再有任何 Node 依赖（“其余 Node 依赖”一栏为空）。

| 文件 | 用到的名字 | 其余 Node 依赖 |
|---|---|---|
| `agent-orchestration/index.ts` | join | `node:fs` |
| `agent-orchestration/src/custom-agent.ts` | dirname, join | `node:crypto` `node:buffer` `node:fs` `Buffer` |
| `agent-orchestration/src/task-audit-executor.ts` | path（整体导入） | `node:crypto` `node:fs` |
| `agent-skills/src/files.ts` | path（整体导入） | `node:fs` `node:fs/promises` `node:util` `Buffer` `process` |
| `agent-skills/src/requires.ts` | path（整体导入） | `node:child_process` `node:fs/promises` `Buffer` `process` |
| `agent-skills/src/skill-market.ts` | path（整体导入） | `node:crypto` `node:fs` `node:os` `Buffer` `process` |
| `agent-skills/src/skill-package.ts` | path（整体导入） | `node:crypto` `node:fs` `node:fs/promises` `Buffer` `process` |
| `agent-skills/src/skill-replay.ts` | path（整体导入） | `node:crypto` `node:fs` `Buffer` |
| `agent-skills/src/skill-taps.ts` | path（整体导入） | `node:crypto` `node:fs` `node:fs/promises` `Buffer` `process` |
| `agent-skills/src/tools/fetch-chat-executor.ts` | path（整体导入） | `node:crypto` `node:dns/promises` `node:fs` `node:http` `node:https` `node:net` |
| `agent-skills/src/tools/fetch-executor.ts` | path（整体导入） | `Buffer` |
| `agent-skills/src/tools/mcp-content-materializer.ts` | path（整体导入） | `node:fs` `node:crypto` `Buffer` |
| `agent-skills/src/tools/object-pages.ts` | path（整体导入） | `node:fs` `node:crypto` `Buffer` |
| `agent-skills/src/tools/ptc-executor.ts` | path（整体导入） | `node:crypto` `node:fs` `Buffer` |
| `agent-skills/src/tools/skill-workshop-executor.ts` | path（整体导入） | `node:fs` `Buffer` |
| `agent-skills/src/tools/skill-workshop-package.ts` | path（整体导入） | `node:fs` `node:crypto` `Buffer` |
| `agent-skills/src/tools/skill-workshop-proposals.ts` | path（整体导入） | `node:fs` `node:crypto` |
| `agent-skills/src/tools/skill-workshop-tool-executor.ts` | path（整体导入） |  |
| `agent-workspace/index.ts` | path（整体导入） | `node:fs` |
| `agent-workspace/src/approval-scope/env.ts` | path（整体导入） | `node:fs` `node:child_process` `node:crypto` `process` `Buffer` |
| `agent-workspace/src/approval-scope/scope.ts` | * as path（整体导入） |  |
| `agent-workspace/src/approval-scope/shell-guard.ts` | * as path（整体导入） | `node:fs` `process` `Buffer` |
| `agent-workspace/src/runtime-paths.ts` | path（整体导入） | `node:fs` `node:os` `node:crypto` `process` `Buffer` |
| `agent-workspace/src/runtime-root-approval.ts` | path（整体导入） | `node:fs` `node:crypto` `Buffer` |
| `agent-workspace/src/runtime-roots.ts` | path（整体导入） | `node:fs` `node:crypto` `process` `Buffer` |
| `agent-workspace/src/skill-packages.ts` | path（整体导入） | `node:fs` `node:os` `node:crypto` `process` `Buffer` |
| `agent-workspace/src/tool-approval-gate.ts` | path（整体导入） | `node:os` |
| `agent-workspace/src/tools/code-navigation.ts` | path（整体导入） | `node:fs` |
| `agent-workspace/src/tools/file-manager.ts` | path（整体导入） | `node:fs` `node:crypto` |
| `agent-workspace/src/tools/file-manager/files.ts` | path（整体导入） | `node:fs` `node:crypto` `Buffer` |
| `agent-workspace/src/tools/lsp-navigation.ts` | path（整体导入） | `node:child_process` `node:fs` `node:os` `Buffer` `process` |
| `agent-workspace/src/tools/shell-env.ts` | path（整体导入） | `node:crypto` `node:child_process` `node:fs` `process` `Buffer` |
| `agent-workspace/src/tools/shell-execute.ts` | path（整体导入） | `node:fs` `Buffer` |
| `agent-workspace/src/tools/shell-execute/context.ts` | path（整体导入） | `node:fs` `node:os` `node:child_process` `process` |
| `agent-workspace/src/tools/shell-execute/snapshots.ts` | path（整体导入） | `node:fs` `Buffer` |
| `agent-workspace/src/tools/shell-policy.ts` | path（整体导入） | `Buffer` `process` |
| `agent-workspace/src/tools/shell-preflight.ts` | path（整体导入） | `node:fs` `Buffer` `process` |
| `agent-workspace/src/tools/shell-sandbox-windows.ts` | path（整体导入） | `node:fs` `node:crypto` `Buffer` `process` |
| `agent-workspace/src/tools/shell-sandbox.ts` | path（整体导入） | `node:fs` `node:os` `node:crypto` `process` |
| `agent-workspace/src/tools/workspace-fs.ts` | path（整体导入） | `node:fs` `node:crypto` `process` `Buffer` |
| `agent-workspace/src/vfs-resolver/exam.ts` | path（整体导入） | `node:fs` |
| `agent-workspace/src/vfs-resolver/pdf.ts` | path（整体导入） | `node:fs` |
| `agent-workspace/src/workspace-change-set.ts` | path（整体导入） | `node:fs` `node:crypto` `Buffer` `process` |
| `agent-workspace/src/workspace/coordinator.ts` | path（整体导入） |  |
| `agent-workspace/src/workspace/custom-agents.ts` | path（整体导入） | `node:fs` |
| `agent-workspace/src/workspace/database.ts` | path（整体导入） | `node:fs` `Buffer` |
| `agent-workspace/src/write-backups.ts` | path（整体导入） | `node:fs` `node:crypto` `Buffer` `process` |
| `anki/src/anki-sync.ts` | path（整体导入） | `node:fs` |
| `anki/src/apkg-export-model.ts` | path（整体导入） | `node:crypto` `Buffer` |
| `anki/src/apkg-exporter.ts` | path（整体导入） | `node:fs` `node:crypto` `Buffer` |
| `anki/src/apkg-import-archive.ts` | path（整体导入） | `node:fs` `node:crypto` |
| `anki/src/files.ts` | path（整体导入） | `node:fs` `node:fs/promises` |
| `anki/src/plugin-handlers-export.ts` | path（整体导入） | `node:fs` `node:fs/promises` `node:crypto` |
| `anki/src/plugin-handlers-media.ts` | path（整体导入） | `node:fs/promises` |
| `anki/src/plugin.ts` | path（整体导入） | `node:fs` |
| `backup/src/assets.ts` | basename, join | `node:fs/promises` `node:crypto` `node:fs` `Buffer` |
| `backup/src/backup-commands.ts` | dirname, join | `node:fs` |
| `backup/src/backup-manager.ts` | basename, dirname, join | `node:fs` `node:fs/promises` `node:os` `Buffer` |
| `backup/src/crypto-restore.ts` | basename, join | `node:crypto` `node:fs` `process` `Buffer` |
| `backup/src/governance.ts` | dirname, join | `node:fs` `process` |
| `backup/src/initialization.ts` | dirname, join | `node:fs` |
| `backup/src/io.ts` | isAbsolute, relative, sep | `node:util` |
| `backup/src/jobs.ts` | join, extname | `node:crypto` `node:fs` |
| `backup/src/manifest.ts` | isAbsolute, join | `node:crypto` `node:fs` `node:fs/promises` `process` `Buffer` |
| `backup/src/operations.ts` | join | `node:crypto` `process` |
| `backup/src/paths.ts` | basename, dirname, join, sep | `node:fs` |
| `backup/src/restore-commands.ts` | join | `node:fs` `Buffer` |
| `backup/src/restore-files.ts` | dirname, join | `node:crypto` `node:fs` |
| `backup/src/restore-plan.ts` | join | `node:fs` |
| `backup/src/zip-commands.ts` | dirname, join | `node:crypto` `node:fs` `node:fs/promises` |
| `backup/src/zip.ts` | basename, dirname, join, resolve | `node:crypto` `node:fs/promises` `Buffer` |
| `browser/src/browser-tool-executor.ts` | basename, isAbsolute, join, relative, sep | `node:crypto` `node:fs` `node:fs/promises` `Buffer` |
| `browser/src/database.ts` | dirname |  |
| `chat-pipeline/repository/budget.ts` | dirname | `node:fs` |
| `chat-pipeline/src/context-compiler-owner.ts` | path（整体导入） | `node:fs/promises` |
| `chat-pipeline/src/finalizer.ts` | path（整体导入） | `node:crypto` `node:fs` `process` `Buffer` |
| `chat/src/agents-md.ts` | basename, isAbsolute, join, relative, sep | `node:buffer` `node:fs` `node:os` |
| `chat/src/attachment-stage.ts` | * as path（整体导入） | `node:crypto` `node:fs` `Buffer` `process` |
| `chat/src/completion-dispatcher.ts` | dirname, join | `node:fs` `process` |
| `chat/src/group-actions.ts` | isAbsolute | `node:crypto` |
| `chatanki/src/executor-args.ts` | isAbsolute |  |
| `chatanki/src/transform-script-sandbox.ts` | join, delimiter, isAbsolute, dirname, basename, resolve | `node:fs` `process` `Buffer` |
| `chatanki/src/transform-script.ts` | join, delimiter, dirname, resolve | `node:fs` |
| `llm/index.ts` | join |  |
| `llm/src/audit_log.ts` | join | `node:fs` `node:fs/promises` `Buffer` |
| `llm/src/essay_grading/custom_modes.ts` | dirname, join | `node:crypto` `node:fs` |
| `llm/src/model2_streaming_service.ts` | join | `node:crypto` `process` |
| `llm/src/ocr_pages_service.ts` | extname, isAbsolute, join, sep | `node:fs/promises` `node:fs` `Buffer` |
| `mcp/src/stdio-validation.ts` | delimiter, extname, isAbsolute, join, resolve | `node:fs` `process` |
| `media/index.ts` | join |  |
| `media/src/compress-image.ts` | join | `node:crypto` `node:fs/promises` `node:os` `Buffer` |
| `media/src/document-parser.ts` | basename | `node:fs` `node:fs/promises` `Buffer` |
| `media/src/exam-sheet-service.ts` | path（整体导入） | `node:fs` `node:crypto` `node:fs/promises` |
| `media/src/image-base64.ts` | path（整体导入） | `node:fs` `node:fs/promises` `Buffer` |
| `media/src/media-transcriber.ts` | join | `node:fs` |
| `media/src/ocr-engine-test.ts` | join | `node:crypto` `node:fs` |
| `media/src/pdf-ocr-service.ts` | isAbsolute, join, relative | `node:crypto` `node:fs` |
| `media/src/pdf-ocr-sessions.ts` | join | `node:crypto` `node:fs/promises` |
| `media/src/pdfium-status.ts` | dirname | `Buffer` |
| `media/src/pdfium-utils.ts` | join | `node:fs` |
| `media/src/pipeline.ts` | join | `node:crypto` `node:fs` `node:os` |
| `media/src/register-ocr.ts` | join |  |
| `media/src/textbooks.ts` | dirname | `node:crypto` `node:fs/promises` `Buffer` |
| `media/src/tools/media-tool-executor.ts` | join, sep | `node:crypto` `node:fs` `node:fs/promises` `Buffer` |
| `media/src/tools/office-fidelity-executor.ts` | join, sep | `node:crypto` `node:fs` `node:fs/promises` |
| `media/src/vfs-blob-path.ts` | join | `node:fs` |
| `media/src/wav.ts` | join | `node:fs` `node:crypto` `node:os` `Buffer` |
| `notes/repository/assets.ts` | isAbsolute, join, relative, resolve, sep | `node:crypto` `node:fs` `Buffer` |
| `notes/repository/export-archive.ts` | dirname, join, resolve, sep | `node:crypto` `node:fs` `Buffer` |
| `notes/repository/export-common.ts` | dirname, join, resolve, sep | `node:crypto` `node:fs` |
| `notes/repository/import-archive.ts` | dirname | `node:crypto` `node:fs` `Buffer` |
| `notes/repository/stats.ts` | join | `node:fs` |
| `notes/src/import-markdown.ts` | path（整体导入） | `node:fs` |
| `notes/src/notes-import-tool.ts` | isAbsolute, join, normalize, relative, sep | `node:fs` |
| `notes/src/transfer-commands.ts` | join | `node:crypto` `node:fs` |
| `qbank/index.ts` | path（整体导入） |  |
| `qbank/repository/export.ts` | path（整体导入） | `node:crypto` `node:fs` `node:zlib` `Buffer` |
| `qbank/src/csv-commands.ts` | path（整体导入） | `node:crypto` `node:fs` |
| `qbank/src/csv-import.ts` | path（整体导入） | `node:crypto` `node:fs` `setImmediate` |
| `qbank/src/enhanced-statistics.ts` | path（整体导入） | `node:fs` |
| `qbank/src/paper-export-bridge.ts` | path（整体导入） | `node:fs/promises` `Buffer` |
| `qbank/src/practice-runtime.ts` | path（整体导入） |  |
| `qbank/src/question-import-wiring.ts` | path（整体导入） |  |
| `sync-providers/index.ts` | join |  |
| `sync-providers/src/cloud_transfer.ts` | dirname, join | `node:fs/promises` `Buffer` |
| `sync-providers/src/delta_restore.ts` | dirname, join | `node:fs` `node:fs/promises` `Buffer` |
| `sync-providers/src/delta_upload.ts` | dirname, join | `node:fs` `node:fs/promises` `Buffer` |
| `sync-providers/src/fsutil.ts` | dirname, join | `node:fs` `node:fs/promises` |
| `sync-providers/src/ftp.ts` | join | `node:events` `node:fs/promises` `node:os` `node:net` `node:tls` `Buffer` |
| `sync-providers/src/password_proof.ts` | join | `node:fs/promises` `node:os` |
| `sync-providers/src/repo_check.ts` | join | `node:fs` `node:fs/promises` `node:os` `Buffer` |
| `sync-providers/src/resume.ts` | basename, dirname, join | `node:fs/promises` `Buffer` |
| `sync-providers/src/sync_manager.ts` | join | `node:fs/promises` `Buffer` |
| `sync-providers/src/traits.ts` | dirname | `node:fs/promises` `node:timers/promises` `Buffer` |
| `sync-support/src/tombstone-files.ts` | path（整体导入） | `node:fs` |
| `sync/repository/blob-file-refs.ts` | dirname, join | `node:fs` |
| `sync/repository/tombstone.ts` | path（整体导入） | `node:crypto` `node:fs` `Buffer` |
| `sync/repository/workspace-files.ts` | dirname, join | `node:fs` |
| `sync/src/asset-paths.ts` | join, relative, sep, parse | `node:fs` `Buffer` |
| `sync/src/asset-sync.ts` | dirname | `node:fs` |
| `sync/src/blob-sync.ts` | basename, dirname, extname, join, relative | `node:fs` `node:crypto` `node:timers/promises` `Buffer` |
| `sync/src/conflict-commands.ts` | dirname | `node:fs` |
| `sync/src/file-level-sync.ts` | join | `node:timers/promises` |
| `sync/src/file-transfer.ts` | dirname, join | `node:fs/promises` `node:os` `node:crypto` |
| `sync/src/history-commands.ts` | dirname | `node:fs` `Buffer` |
| `sync/src/list-commands.ts` | dirname | `node:fs` `Buffer` |
| `sync/src/local-commands.ts` | dirname | `node:fs` |
| `sync/src/quarantine-commands.ts` | dirname | `node:fs` |
| `sync/src/run-sync.ts` | join |  |
| `sync/src/status.ts` | dirname | `node:fs` `Buffer` |
| `sync/src/tombstone-commands.ts` | join |  |
| `sync/src/transfer-commands.ts` | dirname, join | `node:fs` `Buffer` |
| `sync/src/unsynced-classification.ts` | join, parse, sep | `node:fs` `Buffer` |
| `sync/src/unsynced-items.ts` | join | `Buffer` |
| `sync/src/upload-changes.ts` | join | `node:fs/promises` `node:os` `Buffer` |
| `sync/src/workspace-sync.ts` | basename, dirname, join | `node:fs` |
| `translation/src/ocr_extract.ts` | join | `node:fs` `node:os` `node:crypto` |
| `vfs-handlers/repository/media-cache.ts` | dirname, join | `node:fs` |
| `vfs-handlers/src/attachments.ts` | join | `node:fs` |
| `vfs-handlers/src/filestream.ts` | path（整体导入） | `node:fs` |
| `vfs-handlers/src/upload-file.ts` | basename | `node:crypto` `Buffer` `setImmediate` |
| `vfs-handlers/src/vector-cache-files.ts` | join | `node:fs` |
| `vfs-index/index.ts` | path（整体导入） |  |
| `vfs-index/src/chat-embeddings.ts` | path（整体导入） | `node:fs` `process` |
| `vfs-index/src/legacy-kb-store.ts` | path（整体导入） | `node:fs` `process` |
| `vfs-index/src/pdf-runtime.ts` | path（整体导入） | `node:crypto` `node:fs/promises` `node:os` `Buffer` |
| `vfs-index/src/pdf-service.ts` | path（整体导入） | `node:fs` |
| `vfs-index/src/runtime-adapter.ts` | path（整体导入） | `node:fs` `Buffer` |
| `vfs-index/src/unified-retriever.ts` | path（整体导入） |  |
| `vfs-repos/repository/attachment-utils.ts` | PlatformPath | `node:fs` `Buffer` |
| `vfs-repos/repository/attachments.ts` | posix, win32 | `node:crypto` `node:fs` `Buffer` |
| `vfs-repos/repository/blobs.ts` | basename, dirname, isAbsolute, join | `node:crypto` `node:fs` |
| `vfs-repos/repository/maintenance.ts` | dirname, join |  |
| `vfs-repos/src/maintenance-service.ts` | join | `node:fs` |
| `vfs/repository/create.ts` | dirname, join | `node:crypto` `node:fs` `process` |
| `vfs/repository/resources.ts` | join | `node:fs` |
| `vfs/src/database.ts` | path（整体导入） | `node:fs` |
| `vfs/src/dstu-trash.ts` | path（整体导入） | `node:fs` |
| `vfs/src/export.ts` | path（整体导入） | `node:fs` `node:os` `Buffer` |
| `vfs/src/protocols.ts` | path（整体导入） | `node:fs` `node:os` `process` `Buffer` |
| `vfs/src/tools/dstu-executor.ts` | path（整体导入） | `node:fs` `Buffer` |
| `vfs/src/tools/mindmap-import.ts` | path（整体导入） | `node:fs` `Buffer` |
| `vfs/src/tools/retrieval-rerank.ts` | path（整体导入） | `node:fs` |

## `createHash('sha256')` → `host/platform/crypto/sync.ts` / `ctx.crypto`

“输入”一栏按 `update()` 的实参名粗分（启发式，owner 以实际数据大小为准）。性能边界见 `crypto/sync.ts` 文件头：纯 JS 约 100–190 MB/s，1 MB ≈ 5 ms 阻塞。
共 121 处 sha256；sha1 等其他算法 3 处（`digestSync('SHA-1', …)`，WebSocket 握手这类仅桌面的保留）。

| 位置 | 算法 | 输入 | 替换 |
|---|---|---|---|
| `agent-orchestration/src/custom-agent.ts:169` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-orchestration/src/custom-agent.ts:209` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `agent-orchestration/src/role-packs.ts:325` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-orchestration/src/self-inspect.ts:60` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-orchestration/src/task-audit-executor.ts:123` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `agent-orchestration/src/trusted-profile.ts:67` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-skills/repository/connector-ledger.ts:57` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-skills/repository/skill-usage.ts:227` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-skills/repository/skill-usage.ts:233` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-skills/src/skill-market.ts:181` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-skills/src/skill-package.ts:306` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-skills/src/skill-package.ts:643` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-skills/src/skill-package.ts:660` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-skills/src/skill-replay.ts:284` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `agent-skills/src/skill-replay.ts:551` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-skills/src/skill-updates.ts:267` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-skills/src/tools/connector-executor.ts:198` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-skills/src/tools/fetch-chat-executor.ts:397` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-skills/src/tools/fetch-chat-executor.ts:408` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-skills/src/tools/mcp-content-materializer.ts:336` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-skills/src/tools/mcp-manage-executor.ts:55` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `agent-skills/src/tools/object-pages.ts:48` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-skills/src/tools/ptc-executor.ts:174` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-skills/src/tools/ptc-runtime.ts:174` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-skills/src/tools/ptc-runtime.ts:614` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-skills/src/tools/ptc-runtime.ts:642` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-skills/src/tools/skill-install-executor.ts:60` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-skills/src/tools/skill-workshop-package.ts:53` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-skills/src/tools/skill-workshop-package.ts:83` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `agent-skills/src/tools/skill-workshop-proposals.ts:61` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `agent-skills/src/tools/task-objects.ts:368` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-workspace/src/approval-scope/env.ts:194` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `agent-workspace/src/runtime-paths.ts:31` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-workspace/src/runtime-root-approval.ts:59` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-workspace/src/runtime-roots.ts:438` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-workspace/src/runtime-roots.ts:453` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-workspace/src/skill-packages.ts:264` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `agent-workspace/src/tools/file-manager/files.ts:105` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `agent-workspace/src/tools/shell-env.ts:345` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `agent-workspace/src/tools/workspace-fs.ts:525` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `agent-workspace/src/workspace-change-set.ts:150` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-workspace/src/workspace-change-set.ts:420` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `agent-workspace/src/workspace/util.ts:45` | sha256 | small | `sha256HexSync`（小输入） |
| `agent-workspace/src/write-backups.ts:106` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `agent-workspace/src/write-backups.ts:182` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `anki/src/apkg-export-model.ts:196` | sha1 | small | `digestSync('SHA-1', …)` / `createHasherSync` |
| `anki/src/apkg-export-model.ts:516` | sha1 | incremental | `digestSync('SHA-1', …)` / `createHasherSync` |
| `backup/repository/schema-registry.ts:151` | sha256 | small | `sha256HexSync`（小输入） |
| `backup/src/assets.ts:196` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `backup/src/crypto-restore.ts:120` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `backup/src/manifest.ts:874` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `backup/src/manifest.ts:892` | sha256 | small | `sha256HexSync`（小输入） |
| `backup/src/manifest.ts:901` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `backup/src/manifest.ts:922` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `backup/src/restore-files.ts:48` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `backup/src/zip.ts:119` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `backup/src/zip.ts:452` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `browser/src/download-hash.ts:18` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `browser/src/index-webpage-executor.ts:159` | sha256 | small | `sha256HexSync`（小输入） |
| `chat-pipeline/src/authority-mode.ts:65` | sha256 | small | `sha256HexSync`（小输入） |
| `chat-pipeline/src/finalizer.ts:133` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `chat-pipeline/src/memory-flush.ts:12` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `chat-pipeline/src/skill-injection.ts:199` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `chat-pipeline/src/summary.ts:71` | sha256 | small | `sha256HexSync`（小输入） |
| `chat-pipeline/src/tool-face.ts:94` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `chat/src/attachment-stage.ts:222` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `chat/src/attachment-stage.ts:291` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `chat/src/attachment-stage.ts:330` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `chatanki/src/apkg-import.ts:61` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `llm-providers/src/openai-codex/manager-values.ts:30` | sha256 | small | `sha256HexSync`（小输入） |
| `llm/src/cache_debug.ts:67` | sha256 | small | `sha256HexSync`（小输入） |
| `llm/src/model2_streaming_service.ts:82` | sha256 | small | `sha256HexSync`（小输入） |
| `mcp/src/oauth-manager.ts:110` | sha256 | small | `sha256HexSync`（小输入） |
| `media/src/bilibili-bridge-server.ts:523` | sha1 | small | `digestSync('SHA-1', …)` / `createHasherSync` |
| `media/src/office-fidelity.ts:45` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `media/src/office-fidelity.ts:101` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `media/src/office-fidelity.ts:154` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `media/src/office-output.ts:90` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `media/src/pdf-ocr-service.ts:374` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `media/src/pdf-ocr-service.ts:559` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `media/src/pdf-ocr-sessions.ts:80` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `media/src/task-objects.ts:22` | sha256 | small | `sha256HexSync`（小输入） |
| `media/src/textbooks.ts:70` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `media/src/tools/media-tool-executor.ts:95` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `media/src/tools/office-delivery.ts:64` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `media/src/tools/office-fidelity-executor.ts:120` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `memory/repository/vfs.ts:412` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `memory/repository/vfs.ts:416` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `qbank/repository/authoring.ts:227` | sha256 | small | `sha256HexSync`（小输入） |
| `qbank/repository/export.ts:254` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `qbank/repository/legacy.ts:53` | sha256 | small | `sha256HexSync`（小输入） |
| `qbank/src/csv-import.ts:187` | sha256 | small | `sha256HexSync`（小输入） |
| `qbank/src/generation-references.ts:80` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `qbank/src/question-import-service.ts:276` | sha256 | small | `sha256HexSync`（小输入） |
| `sync/repository/apply-quarantine.ts:111` | sha256 | small | `sha256HexSync`（小输入） |
| `sync/repository/apply-quarantine.ts:115` | sha256 | small | `sha256HexSync`（小输入） |
| `sync/repository/conflict-resolver.ts:106` | sha256 | small | `sha256HexSync`（小输入） |
| `sync/repository/quarantine.ts:21` | sha256 | small | `sha256HexSync`（小输入） |
| `sync/repository/quarantine.ts:27` | sha256 | small | `sha256HexSync`（小输入） |
| `sync/repository/record-data.ts:300` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `sync/repository/record-data.ts:388` | sha256 | small | `sha256HexSync`（小输入） |
| `sync/repository/tombstone.ts:75` | sha256 | small | `sha256HexSync`（小输入） |
| `sync/repository/tombstone.ts:97` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `sync/repository/tombstone.ts:109` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `sync/src/asset-filenames.ts:182` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `translation/repository/translations.ts:58` | sha256 | small | `sha256HexSync`（小输入） |
| `vfs-handlers/src/upload-file.ts:272` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `vfs-index/repository/embedding-dim.ts:168` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `vfs-index/repository/embedding-dim.ts:219` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `vfs-index/src/pdf-runtime.ts:509` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `vfs-index/src/pdf-runtime.ts:719` | sha256 | small | `sha256HexSync`（小输入） |
| `vfs-repos/repository/attachments.ts:288` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `vfs-repos/repository/blobs.ts:72` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `vfs-repos/repository/blobs.ts:143` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `vfs-repos/repository/embedding-dims.ts:29` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `vfs-repos/repository/index-units.ts:114` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `vfs-repos/repository/questions.ts:89` | sha256 | incremental | 增量：`createHasherSync`（每段小）或 `ctx.crypto.createHasher`（文件流） |
| `vfs-repos/repository/resources.ts:148` | sha256 | small | `sha256HexSync`（小输入） |
| `vfs-repos/repository/resources.ts:151` | sha256 | small | `sha256HexSync`（小输入） |
| `vfs/repository/create.ts:59` | sha256 | small | `sha256HexSync`（小输入） |
| `vfs/repository/create.ts:64` | sha256 | small | `sha256HexSync`（小输入） |
| `vfs/repository/create.ts:446` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `vfs/src/download-paper.ts:67` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
| `vfs/src/upload-file.ts:168` | sha256 | data | 用户数据：异步 `ctx.crypto.sha256Hex`；确定 ≤ 64 KB 才用 `sha256HexSync` |
