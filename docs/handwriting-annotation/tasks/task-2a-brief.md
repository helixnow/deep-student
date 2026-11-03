# Task2a — 存储首批create/get/save测试与API

Read this first. Repo `/home/xutao/deepstudent/deep-student`, branch feat/handwriting-annotation-chat。分离Task2核心存储首批，不在本轮实现copy/sync/API。主agent已裁决复用files行canonical manifest，见 task-2-brief.md 的状态/身份细化与reviews/storage-sync-findings.md，仅读相关段。

## 范围和门禁

只修改 `src-tauri/crates/dstu-vfs/src/vfs/repos/ink_repo.rs` + repos/mod.rs注册，及 `docs/handwriting-annotation/tasks/task-2a-report.md`。**不修改vfs/ink或TS types**，校验agent正在写这些。先编译接口scaffold+真实DB测试→NEEDS_RED_VERIFICATION停止。不得跑测试/build/install、再派agent、commit/push。不广泛探索整个存储。

## 最小API

`VfsInkRepo` 静态_with_conn方法，接Connection+blobs_dir Path，与其他repos一致。错误暂用VfsResult/VfsError（结构化ink映射后续API层做，不改全局error）。

- `create_blank_with_conn(conn, blobs_dir, title, ruling:InkRuling, width:f64,height:f64, operation_id:&str, folder_id:Option<&str>) -> VfsResult<InkManifest>`；至少1页。
- `get_manifest_with_conn(conn,blobs_dir,document_id) -> VfsResult<InkManifest>`。
- `get_page_with_conn(conn,blobs_dir,document_id,page_id) -> VfsResult<InkPage>`。
- `save_page_with_conn(conn,blobs_dir,document_id,expected_revision,operation_id,page:&InkPage) -> VfsResult<InkManifest>`。

如因大量参数触发lint可用一个简单request struct，仅repo内定义，不新增通用框架。未知格式/伪装普通file不得走ink保存。document_id就是提前确定的files.id；创建基于operation_id确定稳定ID（SHA256派生ID，避免重试又创建，input_hash绑定title/ruling/size/folder）。operation_id验证128上限不路径。revision服务nanoid不透明值。input_hash由服务按规范输入计算，不信任调用者提供。last_operation持久化同事务；重试相同operation/input返回原manifest，冲突同ID不同输入拒绝；后续提交之后不能证明旧操作返回OPERATION_STATE_UNKNOWN（以VfsError::Conflict key暂存）。

canonical files行：blob_hash=sha256=manifest字节hash，file_name=title.dsink，mime特定，page_count，preview_json.ink={schema_version:1,document_id,revision,manifest_blob_hash,blob_refs}，blob_refs排序去重page/background hash，不含manifest（单独files.blob_hash计）。resources.hash作为镜像同事务更新，data空不塞JSON正文。

save_page必须按page_id匹配现有ref，validate_page，生成新页blob与manifest，CAS `WHERE id=? AND blob_hash=旧hash`，切换与引用增减同savepoint。禁止file.updated_at作版本。不要物理覆盖blob，更新后旧版本没引用可GC但冲突pin另Task2后续补。事务内不await，不再次获取db锁，遵循blob_repo mutex→DB lock已有约定；不要BEGIN IMMEDIATE在blob mutex之前反向加锁。失败不把未完成file pointer发布。复用 VfsBlobRepo/with_savepoint；暂存失败回滚ref不能双减。

## 首次测试（只成功路径）

用仓库实际VfsDatabase::new或已有测试fixture初始化**真实迁移DB**，不自建简化schema。自建temp目录，blobs真实写读。正向三项：
1. 两个不同operation_id、相同标题/空白参数，两个document_id/files/resource/manifest独立、每个manifest字节包含各自document_id，真实get重开一致。
2. 同一operation_id+同输入重复create返回同document/revision，不增加files/资源/引用。
3. save一条page stroke（坐标12.5/pressure.4等真实类型），get_page重开相同samples，revision变化，files.sha256等新manifest hash、resources镜像一致。

scaffold返回小结构化VfsError，确保测试真实编译再红。不实现存储前不得新增否定case冒充红。主agent正向红灯后允许实现，然后第二批negative old revision/rollback/idempotency/refcounts。报告选择器 `vfs::repos::ink_repo::tests`、文件与接口，别运行。
