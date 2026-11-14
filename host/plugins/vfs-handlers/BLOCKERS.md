# L13b 维护接线阻塞（2026-11-04）

## D29 dstuUpload 生产 provider：需 L13 提供（WP-057，main b55af5d85）

- 消费方：`vfs/index.ts:222-225` inject `dstuUpload`，类型为 `vfs/src/tools/dstu-executor.ts:103-107` 的 `DstuUploadPort`（`isSupportedUploadType/maxUploadSizeBytes/upload(params, context)`）。全仓 `host/` 中 `dstuUpload` 没有 provider，生产 profile `host/profiles/desktop.json` 里 DstuToolExecutor 不注册。
- 真实实现所在：`vfs_upload_file` 由 L13 声明（`vfs/index.ts:145`）并注册（`:270`，`uploadFileCommand(fileUploadDeps(), params)`），主体 `vfs/src/upload-file.ts:138-`，main `b384894f3`。`vfs/tests/upload-file.test.ts` 5/5 通过（作业 20261105152350-26509b）。
- 本 lane 不能 provide 的原因：`vfs/api.ts` 只公开 `upload.createSaga/withSavepoint`（`:133-135`），未公开上传函数；跨插件不能引用实现文件（boundary `cross-plugin-impl`）；kernel `CommandRegistry` 只有 `register/has`（`kernel/api.ts:101-107`），没有进程内派发。用本 lane 的 `src/upload-file.ts` provide 会造成 IPC 命令与 DSTU 工具两套上传实现，违反验收"同一完整生产实现"。
- 需要 L13 做其一：(a) 在 `vfs/index.ts` 用同一 `fileUploadDeps()` provide `dstuUpload = { isSupportedUploadType: (n,m)=>ctx.vfsRepo.attachments.isSupportedUploadType(n,m), maxUploadSizeBytes: m=>ctx.vfsRepo.attachments.maxUploadSizeBytes(m), upload: p=>uploadFileCommand(fileUploadDeps(), p) }`，并在 meta.provides 加 `dstuUpload`；(b) 在 `ctx.vfs` 上公开 `uploadFile(params): Promise<VfsUploadFileResult>`，本 lane 再按 `api.ts:26-30` 声明包装并 provide。
- 顺带发现（L13 实现，非本 lane 可改）：`vfs/src/upload-file.ts:283` 用 `files.updatePdfOcrPages`（会改 `updated_at`），Rust `handlers.rs:2528-2532` 只改 `ocr_pages_json`，应改用 main 已有的 `setUploadOcrPagesWithConn`（`vfs-repos/repository/files.ts:737`）；`:70` 自持一份预览默认值，main 已导出 `DEFAULT_PDF_PREVIEW_CONFIG`。资源创建钩子有两套注册表：L13 `vfs/index.ts:211` 的 `resourceCreatedHooks` 与本 lane `vfsHooks.registerResourceCreatedHook`，上传只通知前者，后者目前无消费者。

## L11 八方法：已集成并接真

main `9c13dfc39` 已包含 `vfsMaintenance` provider、`VfsReposService.maintenance` 及所有者SQL。消费接口直接引用L11 api.ts，必需注入真实服务；已移除 `tests/pending-maintenance-provider.ts` 和交接完成的本地写算法。八个方法为：

- `getResourcePath`、`updatePathCache`
- `createTodoSubtasks`
- `resetDisabledToPending`、`resetIndexedWithoutEmbeddings`、`resetAllIndexStateRows`
- `clearMediaCache`、`clearResourceOcr`

三个路径测试已通过真实invoke验证并改ported；重置/cache/OCR/AI持久化同样经真实provider验证。L17附件根配置不包含在此八方法内。

## L12：已解除

main `7186d3cea` 已提供 `vfsUnitBuilder.syncResourceUnits`、`vfsIndexMaintenance.resetUnitIndex/deleteResourceIndex`、`vfsIndex.multimodal.processPendingBatch`。本 lane 已接这些公开接口，删除 `repository/index-admin.ts` 及测试提供者中的两个方法。四个原子reset测试和单连接测试已改为 ported；不再请求 `vfsMaintenance.resetUnitIndex`。

## R13-02：F3/L11 的跨线程仓储执行入口

Rust `todo_handlers.rs:77-103,1263-1291` 要求连接获取、完整事务及成功事件不占用异步运行线程；`handlers.rs:843-922` 还要求四类搜索通过 blocking 任务并行。当前同步实现不满足这个保证，两个原测试回退 pending，原CRUD和业务错误测试保留但不再冒充原测试。

**C2 06:08候选更新**：L11分支 `f470e5c89/36a41507d` 完整树已提供真实 worker 执行服务；只读核对其 `api.ts:1228-1243,1277` 后确认签名为：

```ts
interface VfsWorkerService {
  runTodoOperation<T = unknown>(method: string, args?: readonly unknown[]): Promise<T>;
  runPomodoroOperation<T = unknown>(method: string, args?: readonly unknown[]): Promise<T>;
  runResourceSearch<T = unknown>(type: 'exam' | 'translation' | 'essay', query: string,
    limit: number, offset?: number): Promise<T>;
  workerThreadId(): Promise<number>;
  pauseAndDrain(timeoutMs?: number): Promise<void>;
  resume(): void;
  dispose(): Promise<void>;
}
```

服务名为`vfsWorker`，连接和仓储在真实worker线程内创建。当前main已包含F3 `StorageService.registerMaintenanceParticipant`（api.ts:462、service.ts:203）及L11注册/日志转发。**外部接口阻塞已解除，剩余是本lane的真实消费改造和维护/事件顺序验证**，不能再写“等待F3公开面”。

生产接入时须实测C2指出的两项语义：F3维护屏障纳管worker的连接/在途操作（备份冻结不能被独立连接绕过）；worker仓储日志传到主线程统一logger，保留Rust warn/error/info及错误传播。note搜索仍需L10入口；现有三类型search不代表四类并行搜索已完成。

后续消费真实`ctx.vfsWorker`，补原线程ID与错误传播断言、提交后事件、维护暂停/恢复和Host事件循环可推进验证；再更新两项TESTMAP。当前优先三条缺失上传命令，这两条继续pending，不复制提供方实现，也不把接口存在当命令已在worker执行。

## 附件配置所有者

**撤回旧的L17高级方法请求**。L17 `961a15b11`完整树已提供`memoryConfig.get(key): string | null`、`set(key,value): void`；index实际provide，`repository/config.ts`写`datetime('now')`。L13分支核对树`e684609e8`已有公开`AttachmentConfig`及`vfs.attachmentConfig`：`getRootFolderId/getRootFolderTitle/setRootFolderId/createRootFolder/getOrCreateRootFolder`。该业务层以`memoryConfig`存配置、以L11 folders建目录，已覆盖所需高级方法，不需要L17再造一套。

L17 `memoryConfig`现已main，L13 api/index仍无attachmentConfig；附件高级面现在**只等待L13 attachmentConfig集成**，之后本lane命令委托`ctx.vfs.attachmentConfig`。届时删除本lane提议的`vfsAttachmentConfig`接口、测试提供者及attachment-config配置SQL；保留独立的questionImagePaths读取逻辑。当前本地提议接口仅是旧未接线占位，不是对L17的新需求。

Rust `attachment_config.rs:39-125`无跨folder/config事务：连接获取失败传播、配置查询失败/空串→None；有效配置复用，失效warn后建“附件”；先建folder再set配置，set失败保留已创建folder。根层、fld_ ID和默认expanded/favorite取L13已有业务层；不擅自添加事务或在本lane复制memory_config SQL。目前未发现必须新增的高级原子API。

## L12 状态汇总业务入口：已接生产

main（合并`775f28729`）的`vfs-index/api.ts:359`公开`vfsIndex.getStatusSummary?(): VfsIndexStatusSummary`，生产provider `index.ts:227`委托`unit-sync-service.ts:190`（Rust `index_service.rs::get_status_summary`）。`src/index-admin.ts::getStatus`（`vfs_unified_index_status`）已删除命令层统计组装，只调用该入口并按Rust `map_err(to_string)`映射错误；方法缺失时明确拒绝，不返回空统计。`tests/index-admin.test.ts`经真实invoke验证委托、错误映射和缺失拒绝。

## cache vector分支的所有者阶段接缝：已接生产

main `e60e7a771`已包含L11 `d173333a0/af77b9365`祖先，`types/services.ts`（由api.ts公开）的精确接缝已可调用：

```ts
type BeforeVectorClear = (lanceDir: string) => {
  readonly existed: boolean;
  readonly removed: boolean;
  readonly bytesFreed: number;
};
clearMediaCache(params: ClearMediaCacheParams, beforeVectorClear?: BeforeVectorClear): ClearMediaCacheResult;
```

service透传callback，repository在preview/compressed/OCR之后、任何vector DELETE之前调用；removed为真才累加，抛错或existed但未removed都warn后继续，后续`vector_indexed_at`缺列失败保持原行为。本lane的`src/media-cache.ts::clear`已将现有目录原语作为第二参数传入。

`src/vector-cache-files.ts::clearVectorCacheDirectory`直接标注所有者api.ts的`BeforeVectorClear`类型；只操作传入的Lance目录，递归计长（内部bigint）、计长失败按Rust unwrap_or(0)、删除成功才返回removed=true、删除错误交所有者warn分支。Context直接import所有者API的`VfsMaintenanceService`，没有生产签名强转或复制接口。

新增`tests/vector-cache-invoke.test.ts`通过真实`vfs_clear_media_cache`invoke验证中间阶段：底层文件删除时采样OCR已清、Unit/Segment尚存；首个vector DELETE时目录已删；缺列错误发生前目录/units/segments已清；失败warn后继续SQL且不计释放空间；成功/无目录计数准确。断言均在invoke外，避免被所有者best-effort catch吞掉。仅成功分支夹具增加历史vector列，另一个用例保留实际缺列错误；不修改生产schema。此单元不改变两条线程pending或附件高级面阻塞。

LLM模型解析已接 `llmEmbeddingModels`；3项 question_sync obsolete 已获 main 审批并更新本地映射。其余上传/vector/题库上下文依赖见 `QUALITY-REPORT.md`、`native-needs.md` 和 `TESTMAP.md`。
