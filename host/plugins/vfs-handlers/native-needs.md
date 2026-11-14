# L13b 上传命令的剩余平台/所有者接口（2026-11-04 复核 main 74de269dd 之后）

> WP-057 更正（main b55af5d85）：三条命令已由 L13 在 `vfs/index.ts:145,270-271` 注册（`b384894f3`），下文"仍缺的所有者公开面"第 1–3 项均已在 main。`dstuUpload` provider 现由 L13 负责，见 BLOCKERS「D29」。下文保留为历史核对记录。

`vfs_upload_attachment`、`vfs_upload_file`、`vfs_download_paper` 本 lane 未注册。本 lane 曾准备`src/upload-file.ts`的文件上传主体及`createDstuUploadService`，不提供生产`dstuUpload`，不计命令完成。下面按 Rust `handlers.rs:1328-1639`（附件）、`2108-2713`（文件）、`7341-7527`（论文下载）逐项核对依赖。

## 已在 main 可用（不再是阻塞）

| Rust 依赖 | main 公开面 |
|---|---|
| `staged_upload::take_staged_upload` / `StagedFile` | `host/platform/storage/staged-upload.ts`（L13 `dstu-create.ts:34` 已同样直接引用） |
| `VfsAttachmentRepo::upload_*_with_folder` / `upload_media_stream_with_folder` | L11 `AttachmentRepository.uploadWithFolderConn / uploadBytesWithFolderConn / uploadMediaStreamFinalized`（异步，内部已接 `NativeAttachmentProcessing`） |
| `max_upload_size_bytes` / `is_supported_upload_type` | L11 `AttachmentRepository` |
| `VfsFileRepo::get_by_sha256` / `create_file_with_doc_data_in_folder_outcome` | L11 `FileRepository` |
| `VfsBlobRepo::store_blob` / `decrement_ref` / `cleanup_blob` / `remove_unregistered_blob_file` / `get_blob_path` | L11 `BlobRepository` |
| `with_savepoint` | F3 `SqlExecutor.exec`支持命名SAVEPOINT；本lane `repository/upload-savepoint.ts`移植upload_saga.rs:43-94，仅执行事务控制SQL。`savepoint()`只属于F3 TransactionScope，不是DatabaseHandle方法，不能误用。 |
| `VfsIndexStateRepo::mark_failed` | L11 `IndexStateRepository.markFailed` |
| `sync_resource_units` | L12 `vfsUnitBuilder.syncResourceUnits` |
| `pdf_processing_service.get_status / start_pipeline`、`has_retriable_failure` | L12 `vfsIndex.pdf`、`vfs-index/api.ts` 导出的 `hasRetriableFailure` |
| `hooks::notify_resource_created` | 本lane `vfsHooks`已新增`registerResourceCreatedHook/notifyResourceCreated`，生产provider可调用；L18仍需注册实际转写钩子，上传主体未接线。 |

## 仍缺的所有者公开面

1. **L11：附件处理适配器公开**（`vfs_upload_file`、`vfs_download_paper` 需要）。Rust 在命令层直接调用 `render_pdf_preview`、`DocumentParser::extract_paged_text_from_bytes / extract_text_from_bytes`、`build_zip_manifest_text`。L11 已实现 `NativeAttachmentProcessing`（`src/attachment-processing.ts`），但 `VfsReposService` 只在 `attachments` 内部使用它，没有公开。请求在 `VfsReposService` 上暴露同一实例：

   ```ts
   readonly attachmentProcessing: AttachmentProcessingAdapter; // types/content.ts:147 已声明的接口
   ```

   L11候选`0a3d703ad`已正式发布该成员；尚未main。本lane按`AttachmentProcessingAdapter`原类型准备调用，不复制路由逻辑（PDF→pdfium、epub→L18 docs、纯文本→nativeOfficeText）。还请求从api.ts导出同源`DEFAULT_PDF_PREVIEW_CONFIG`，以及`setUploadOcrPagesWithConn(conn,id,json)`：上传`handlers.rs:2528-2532`只更新ocr_pages_json，现`updatePdfOcrPages`同时改updated_at，不能代用。

2. **L11：`media_types::media_kind`**。候选`0a3d703ad`已从api.ts公开`mediaKind(mimeType,fileName): VfsMediaKind|null`（Audio/Video）；尚未main。本lane不复制第二套扩展名表。

3. **L13：`ctx.vfs.attachmentConfig.getOrCreateRootFolder()`**。没有传`folderId`时，文件/附件上传调用Rust `AttachmentConfig::get_or_create_root_folder`。候选在`ds-mig/L13-vfs-api`，未进main。论文下载不是这一分支：handlers.rs:7471直接把空folder过滤成None，不创建默认附件目录。

4. **F7：`nativeImage` RGB 编码**（`pdf_preview.rs:305-332`）。没有它，L11 `renderPdfPreview` 会报错。Rust 上传对预览失败只记 warn 并继续，所以不阻止注册，但生产 PDF 将没有预览页。需要 `encodeRgb({rgb,width,height,format:'jpeg'|'png',quality?}): Promise<Uint8Array>`。

5. **`vfs_download_paper` HTTPS（自有待实现，不要求新HTTP服务）**：已核Rust handlers.rs:7352-7377：初始URL大小写敏感`starts_with("https://")`；reqwest 0.11默认redirect上限10；总timeout90秒覆盖body；UA=`DeepStudent/1.0 (Academic Paper Save)`；非2xx→`HTTP <status>`，发送错误→`Download failed: ...`，body读取错误→`Read failed: ...`。没有显式body大小上限、缓存或独立cancel token。Node fetch可作为基底，但默认redirect20不等价，需要精确保10跳和跨跳共用90秒deadline；Rust workspace未启用gzip等压缩features，不能默认假设Node自动解压同义。F4 `fetchBinaryWithCache`是10秒、manual redirect、缓存且错误返回null，不可代用。后续只针对这些差异实现/提问，不把“缺独立HTTP服务”当阻塞。

## 线程语义

Rust 三条命令都在 `spawn_blocking` 中执行解码、解析、文件 I/O 和 SQLite。这和 R13-02 是同类问题：TS 版在主事件循环执行时，不能宣称线程隔离等价。正式实现会说明这一差异，并等 `vfsWorker` 维护纳管进 main 后再迁移。

## 本 lane 业务面准备（L13 `DstuUploadPort` 对齐，尚未生产provide）

上面第 1、3 项进 main 后，本 lane 发布服务 `dstuUpload`，`upload` 就是 `vfs_upload_file` 的完整流程（去重复用、预览、文本提取、savepoint 写入与补偿、页级文本、单元同步、失败置可重试、钩子、流水线启动）：

```ts
// 已声明于本lane api.ts，主体在src/upload-file.ts；无生产provider前不算可消费。
interface DstuUploadService {
  isSupportedUploadType(name: string, mimeType: string): boolean; // 委托 L11
  maxUploadSizeBytes(mimeType: string): number;                    // 委托 L11
  upload(params: VfsUploadFileParams, context?: unknown): Promise<VfsUploadFileResult>;
}
```

`vfs_upload_file` 命令和 `dstuUpload.upload` 共用同一函数，不使用 `dstu_create` 简化流程。

当前验证分层：`tests/upload-save.test.ts`直接调用准备的保存/补偿核心，经真实迁移库、L11文件/blob仓储和真实SQLite触发器验证rollback/共享引用/去重；不是完整上传invoke证据，不加入TESTMAP。`tests/resource-created-hooks.test.ts`经真实`ctx.vfsHooks`生产provider验证快照/注册序/注销。三命令和两条线程pending均不提前勾完成。
