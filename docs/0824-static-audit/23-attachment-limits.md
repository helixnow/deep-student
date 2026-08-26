model=claude-fable-5-thinking-xhigh

# 23 — 附件 200MB/图片 50MB 前后端一致性与 Composer 拆分旁路静态审计

- 审计方式：只读检查当前工作树与既有契约测试源码；未执行 Git/GitHub 操作，未改产品代码，未运行测试。
- 审计问题：
  1. 附件通用上限 200MB、图片上限 50MB 是否在前端常量、上传管线、后端 IPC 校验之间保持一致；
  2. InputBar 的 Composer* 拆分（`ComposerTextarea` / `ComposerToolbar` / `ComposerPlusMenu` / `AttachmentPanelBody`）是否引入了绕过大小校验的上传旁路。

## 一、限额常量的分布与一致性

### 1. 前端三处定义，两两锁定

- `src/features/chat/core/constants.ts:180,187`：`ATTACHMENT_MAX_SIZE = 200MB`、`ATTACHMENT_IMAGE_MAX_SIZE = 50MB`；分流函数 `getAttachmentSizeLimit(isImage)`（`:189-191`）与按文件名收紧的 `getAttachmentSizeLimitForFile`（`:362-369`，对图片扩展名取 `Math.min(入口上限, 50MB)`）。`:130-132` 注释确认曾经的 50MB 残留副本已删除。
- `src/features/chat/resources/types.ts:265,271`：资源库层 `IMAGE_SIZE_LIMIT = 50MB`、`FILE_SIZE_LIMIT = 200MB`，由 `resources/utils.ts:154-160` 的 `validateFileSize` 消费。
- `src/hooks/useAttachmentSettings.ts:36-42`：默认设置 `maxFileSize` 直接引用 `ATTACHMENT_MAX_SIZE`，`maxImageSize` 为 50MB（硬编码字面量，见风险 3）；`:66-78` 把旧持久化默认（文件 50MB、图片 10MB）视为遗留值升级到新默认，用户显式设置的其他值不受影响。

契约测试 `tests/vitest/chat-v2/attachmentSizeLimits.test.ts:11-26` 同时锁定：图片 50MB 恒等于 `IMAGE_SIZE_LIMIT`、文件 200MB 恒等于 `FILE_SIZE_LIMIT`、扩展名收紧函数对 `photo.JPG` 返回 50MB。本轮只核对测试源码，未重新执行。

### 2. 后端权威来源与逐层引用

- `src-tauri/src/vfs/repos/attachment_repo.rs:143-144` 定义 `MAX_IMAGE_BYTES = 50MB`、`MAX_FILE_BYTES = 200MB`，`:141-142` 注释声明这是全局附件上限的唯一权威来源；`max_upload_size_bytes`（`:374-380`）按 MIME `image/` 前缀分流。
- 上传主链 `vfs_upload_attachment`（`vfs/handlers.rs:1672` → `upload_with_folder` → `upload_with_conn`，`attachment_repo.rs:691-703`）：先 `decode_base64_bounded(max_upload_bytes)` 在解码前按上限预算（防超限输入触发巨型分配），再 `validate_upload_size` 复核，双重拦截。
- 学习资源导入 `vfs_upload_file`（`vfs/handlers.rs:2365`，校验在 `:2414-2422`）同样引用 `max_upload_size_bytes`。
- 工具链路径上传 `chat_v2/tools/dstu_executor.rs:363-371` 读文件前按 `max_upload_size_bytes` 预检元数据大小。
- 旁侧对齐：`commands.rs:3038-3040` 的 `read_file_bytes` 强制 200MB 硬上限（拖拽读取路径的兜底）；`document_parser.rs:20` 与 `page_rasterizer.rs:22` 的 `MAX_DOCUMENT_SIZE = 200MB`；`file_manager.rs:1181` 直接引用 `MAX_IMAGE_BYTES`；前端 `blobApi.ts:53-55` 缓存单项上限 50MB 与图片上限对齐（缓存策略，非校验）。
- `dstu/handlers.rs:1117-1124` 的 `dstu_create`（images/files）硬编码 50/200MB，并按 4/3 编码开销预算 base64 长度后才解码，数值与权威来源一致（漂移风险见风险 2）。

**判定：前后端数值全部一致，均为图片 50MB / 通用 200MB，且后端在字节解码前后各有一道校验。**

## 二、Composer 拆分旁路审查

### 1. 拆分文件不持有任何上传实现

四个拆分文件均只接收壳层回调，不自带文件输入、读取或 IPC 调用：

- `AttachmentPanelBody.tsx:62-64` 声明 `onPickFiles` / `onOpenCamera` 回调，`:147,212,226` 仅触发回调；壳层接线在 `InputBarUI.tsx:2117-2119`（`handlePickFiles` / `handleCameraClick`）。
- `ComposerPlusMenu.tsx:74-75,315-320,475-479` 的附件/相机菜单项同样只调用注入的回调；壳层接线在 `InputBarUI.tsx:2490-2492`（`handleAddAttachmentAction`→`:1490-1493` 点击 `fileInputRef`；`handleOpenCameraAction`→`:1500-1503` 委托 `handleCameraClick`）。
- `ComposerTextarea.tsx:47-48,297` 的 `onPaste` 由父级传入，粘贴转附件逻辑留在壳层。
- `ComposerToolbar.tsx:260-261,534-535` 只透传 `onOpenResourceLibrary` / `onOpenCamera`。

隐藏的 `<input type="file">` 与相机 input 只存在于壳层顶层（`InputBarUI.tsx:2572-2573`）。

### 2. 全部入口汇入唯一校验管线

`processFilesToAttachments`（`InputBarUI.tsx:417`）是唯一落点，其中 `:454-455` 用 `getAttachmentMediaType`（MIME OR 扩展名）判定图片，`:466-483` 按 `getAttachmentSizeLimit(isImage)` 拦截超限文件并生成 error 附件。汇入的入口：

- 文件选择器 `handleFileSelect`（`:1364-1375`）；
- 相机 `handleCameraChange`（`:817-826`）；
- 粘贴 `handlePasteAsAttachment`（`:840-903`）与就绪前的早期粘贴缓冲（`:1643-1645`）；
- 长粘贴文本转 `.txt` 附件（`:939-941`）；
- Tauri 拖拽 `useTauriDragAndDrop`（`:831-837`，`onDropFiles: processFilesToAttachments`）。

拖拽原生路径在读盘前另有预检：`useTauriDragAndDrop.ts:244-260` 先 `get_file_size`，再用 `getAttachmentSizeLimitForFile` 把图片按 50MB 拦截（即使入口传的是 200MB），避免超大文件读入内存；web fallback（`:557-600`）只做扩展名过滤，大小校验由回调进入同一管线完成，且底层 `read_file_bytes` 还有 200MB 命令级硬上限。

### 3. 三个旁路候选逐一排除

1. **`onFilesUpload` 外部回调**：`processFilesToAttachments:426-430` 在有该回调时提前 return（跳过内部大小/类型校验）。但生产入口 `ChatContainer.tsx:327-334` 渲染 `InputBarV2` 时未传此 prop（唯一其他调用方是 dev playground，同样未传），该分支在生产中不可达；即使未来被启用，后端 `upload_with_conn` 仍会拦截超限字节。
2. **资源库入口**：`handleOpenResourceLibrary`（`InputBarUI.tsx:1495-1498`）只发事件打开面板、引用已在 VFS 中的资源，不引入新字节；这些资源的导入口（`vfs_upload_file` / `dstu_create`）各自有 200/50MB 校验。
3. **遗留 `AttachmentUploader.tsx`**：仅被 `@deprecated` 的 `InputBar.tsx:21,185` 使用，生产不渲染（`InputBarUI.mobileSplitContract.source.test.ts:31-35` 锁定活跃表面为 `InputBarV2` 且不得渲染 legacy `<InputBar>`）；且其校验（`AttachmentUploader.tsx:196-199`）同样按 `Math.min(maxSize, ATTACHMENT_IMAGE_MAX_SIZE)` 收紧图片，即便复活也不构成放宽。

**判定：Composer 拆分只搬走了渲染所有权，文件输入与校验管线仍集中在壳层，未发现拆分产生的旁路。**

## 三、风险与是否需要产品修复

1. 【低，无需产品修复】图片判定口径不完全对称：前端按 MIME OR 扩展名判图片（50MB），后端 `max_upload_size_bytes` 仅按 MIME `image/` 前缀。空 MIME 的 `.png` 前端按 50MB 拦截后以 `application/octet-stream` 上送，后端落在 200MB 档——前端更严，用户可达路径无放宽；只有绕过前端直调 IPC 的调用方可以用非图片 MIME 上送 >50MB 的图片字节（仍受 200MB 兜底，且不进图片管线）。属防御纵深不对称，非旁路。
2. 【低，无需产品修复】`dstu/handlers.rs:1117-1118`、`commands.rs:3040`、`document_parser.rs:20`、`page_rasterizer.rs:22` 为镜像硬编码而非引用 `attachment_repo` 常量，与 `attachment_repo.rs:141-142`「禁止再散落硬编码」的约定存在张力；当前数值全部一致，但未来调档需人工同步，建议后续收敛为常量引用。
3. 【低，无需产品修复】`useAttachmentSettings` 的默认 `maxImageSize` 为字面量 50MB（未引用 `ATTACHMENT_IMAGE_MAX_SIZE`）；且该 Hook 在 `SystemSettingsSection.tsx:131-136` 仅解构未消费，上传管线不读用户设置，持久化的 `attachment.settings` 无法放宽实际上限——不构成旁路，但属于死引用与轻微 SSOT 漂移。
4. 【低，无需产品修复】`resources/api.ts:127-129` 的 `validateFileSize` 在 VFS 引用模式下校验的是小体积 refData JSON，真正的附件字节校验在 `vfs_upload_attachment` 后端；语义一致，只需注意勿把该检查误当作文件字节校验。

## 结论

**总判定：PASS。** 附件通用 200MB / 图片 50MB 上限在前端常量（`constants.ts`、`resources/types.ts`、`useAttachmentSettings`）与后端权威来源（`attachment_repo.rs` 及其引用方）之间数值一致，并由 `attachmentSizeLimits.test.ts` 契约锁定；后端在 base64 解码前后双重拦截，`read_file_bytes` 另有 200MB 命令级硬上限。Composer 拆分文件均不持有上传实现，文件选择、相机、粘贴、拖拽全部汇入壳层唯一校验管线 `processFilesToAttachments`；`onFilesUpload` 旁路分支在生产不可达，资源库与遗留组件亦不构成放宽。发现的四项均为低风险 SSOT 漂移/死引用，留待后续收敛。无需产品修复，**本轮不改代码**。
