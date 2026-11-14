# L13b vfs-handlers lane 状态

## 上传命令与 dstuUpload（WP-057 复核 main b55af5d85）

三条上传命令的生产实现已在 L13：main `b384894f3`（及 H1 合流 `c4c395118`）在 `host/plugins/vfs/index.ts:145` 声明、`:270` 注册 `vfs_upload_file`，主体 `host/plugins/vfs/src/upload-file.ts:138`。本 lane 的 `src/upload-file.ts`/`createDstuUploadService` 是未注册的第二份实现，不能拿来 provide `dstuUpload`（否则 DSTU 工具与 IPC 命令走两套上传）。kernel `CommandRegistry` 只有 `register/has`，没有进程内派发；跨插件只能引用 `api.ts`，而 `vfs/api.ts` 未导出上传函数。因此 `dstuUpload` 必须由 L13 在 `vfs/index.ts` 用同一 `fileUploadDeps()`+`uploadFileCommand` provide，或经 `vfs/api.ts`/`ctx.vfs` 公开该函数后再由本 lane 包装。详见 BLOCKERS「D29」。

旧依赖已全部到 main：L11 `vfsRepo.attachmentProcessing`（`vfs-repos/types/services.ts:107`）、`mediaKind`、`DEFAULT_PDF_PREVIEW_CONFIG`（`vfs-repos/api.ts:17,21`）、`files.setUploadOcrPagesWithConn`（`types/files.ts:72`）；L13 `ctx.vfs.attachmentConfig`（`vfs/api.ts:130`）。

已独立发布生产`vfsHooks.registerResourceCreatedHook/notifyResourceCreated`（hooks.rs:118-136）快照注册表；L18消费/上传通知接入尚待闭环。原两条线程测试继续pending；F3维护注册已经main，尚需改造todo/pomodoro真实执行后才能转ported。

## v2排雷清单（X6报告 011914371，源码基线 2ee9a9cbe）

编号按原报告固定，不重排复用。main 上对应 R 复验前都不算完成。

| Finding | 基线位置 | 内容 | 当前状态 | 修复 SHA / 证据 |
|---|---|---|---|---|
| X6-SW-0140 | host/plugins/vfs-handlers/repository/attachment-config.ts:14 | INSERT memory_config；owner报告=memory；executed | 已按 D1 改（W04 V01-04），待 R 复验 | 见下文 |
| X6-SW-0141 | host/plugins/vfs-handlers/repository/attachment-config.ts:14 | REPLACE memory_config；owner报告=memory；executed | 已按 D1 改（同 SW-0140），待 R 复验 | 见下文 |
| X6-UD-0088 | host/plugins/vfs-handlers/src/pdf-preview.ts:50 | value；JSON.parse(tokens[i++]![0]) as string | 数据流核实：不是不可信解码，申请精确例外 | 见下文 |

### X6-SW-0140 / X6-SW-0141（memory_config 写入）

这两条是同一条语句：`setRootFolderId` 里的 `INSERT OR REPLACE INTO memory_config`。

- 生产可达性：命令 `vfs_set_attachment_root_folder`、`vfs_create_attachment_root_folder`、`vfs_get_or_create_attachment_root_folder` 都经 `requireAttachmentConfig(deps.config)` 调用（`src/attachments.ts`）。生产环境没有 `vfsAttachmentConfig` provider，所以这三个命令在生产中直接拒绝，不会执行这条 SQL。目前只有 `tests/pending-attachment-config-provider.ts` 会调用它。报告里的 "executed" 指的是测试路径。
- `vfs_get_attachment_config` 在生产中会经 `rootFolderId` 读取 memory_config（只读，不在 SW 计数内，但同样属于 owner 越界）。
- 所有者：L17 `memoryConfig.get/set` 已在 main（`host/plugins/memory/api.ts:45-49`）。高层的 getOrCreate/createRoot 语义（Rust `attachment_config.rs:39-125`）由 L13 `ctx.vfs.attachmentConfig` 承担，候选在 `ds-mig/L13-vfs-api`（`host/plugins/vfs/src/attachment-config.ts`），尚未进 main。
- 修法（D1）：L13 attachmentConfig 进 main 后，四个附件配置命令委托 `ctx.vfs.attachmentConfig`，并删除本 lane 的 `rootFolderId/setRootFolderId/createRootFolder/getOrCreateRootFolder`、`attachment-config-needs.ts` 和测试 provider。只保留 `questionImagePaths`（只读 questions/blobs）。不在本 lane 复制 memory_config SQL，也不在本 lane 重写 L13 的高层逻辑。
- 现状（W04，审计 V01-04）：D1 已落地。`index.ts` 注入 `vfs`，四个命令经 `src/attachments.ts` 调 `ctx.vfs.attachmentConfig`（存储走 L17 `memoryConfig`）；上面列出的函数、`attachment-config-needs.ts`、测试 provider 和 `vfsAttachmentConfig` 声明均已删除。`tests/attachments.test.ts` 改为装真实 memory 插件；`tests/paths.test.ts` 断言缺 `memoryConfig` 时由 L13 明确拒绝。

### X6-UD-0088（pdf-preview tokenEnds 键解码）

- 数据流：`tokenEnds(raw)` 只在 `src/pdf-preview.ts:155` 调用。此前 `JSON.parse(raw)` 已成功，而且 schema 校验失败，所以 `raw` 一定是合法 JSON。
- 在合法 JSON 的对象键位置，词法正则只能匹配字符串字面量分支 `"(?:[^"\\]|\\.)*"`。`JSON.parse` 一个合法的 JSON 字符串字面量，结果必然是 string，所以 `as string` 由数据流保证。
- 这个函数只用于计算 serde 风格的错误行列号（对应 Rust serde_json 的报错位置），不产出业务数据，也不出站。
- 结论：不修改实现（加 typeof 分支只是为不可能情况做防御）。请按 X6 例外流程精确批准本条；未批准前状态为"待审批"。
