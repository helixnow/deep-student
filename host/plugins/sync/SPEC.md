# L20-sync 行为规格（`host/plugins/sync/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 24 个 · 发出事件 9 种 · 契约：`contracts/ipc/L20-sync.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

### R4-SYNC-04：查询阶段与逐行解码

- 使用正式 F3 StorageError.phase 区分 prepare / bind / execute；query_map 的 execute 是迭代期间 sqlite_step，不按“是否已有行”猜阶段。
- 隔离列表 prepare→“准备隔离区查询失败”、bind→“执行隔离区查询失败”、step/字段解码→“读取隔离记录失败”；逐字段按 Rust row.get 的 i64/String/Option<String> 解码。
- 冲突列表与 retry-all 对坏行/step错误执行 flatten；保留 step 前成功行。准备/绑定错误仍按原前缀拒绝。真实SQLite malformed列、bad typed值、首步/后续abs(i64::MIN)与F3绑定错误验证。

### R4-SYNC-06：缓冲写入（部分修复）

- 导出先create/truncate，再逐JSON token写8KiB缓冲并flush，保留lossless整数/REAL、pretty格式和写入/序列化错误类别，不再同时持有整份JSON字符串。
- 当前worker/虚拟URI生产路径仍pending：F3 worker模块未从api公开且单库自动创建语义不适用跨库导出；已请求正式多库open-existing与文件owner接口。不得将本条缓冲写入等同spawn_blocking完整迁移。

### R4-SYNC-02：内部整数比较/排序/重放

- field_merge.rs:319-323 max用精确i64，非法类型/超i64→0；wasMerged比较原两个i64，不转Number后比较。notes单值数值tag按str.parse<i64>，超JS安全范围仍有效，平局按原BTreeSet最后最大值。
- list隔离/冲突行与retry IDs查询使用safeIntegers；排序/分组分页完成后才在IPC结果转number。retry/自动replay/SQL绑定及错误字符串一直保留bigint，避免相邻ID更新错行。
- mod.rs:7268-7291回声抑制水位同样保留i64：changeLogMaxId与suppressEchoChangeLog参数改bigint，防止MAX(id)=9007199254740993舍入后把原待同步日志误当新回声确认；真实公开apply+SQLite触发器验证旧ID仍pending且仅新ID已同步。
- mod.rs:4205-4255/9821-9841待上传日志同样保持i64：getPendingChanges以safeIntegers读取，ChangeLogEntry.id/sync_version和公开markSynced/executeBidirectional返回ID接受number|bigint；仅安全区间保留既有number断言，不在取ID/过滤/补全/回执前舍入。field_deltas_json使用既有lossless Value解析，真实公开pending→enrich→serialize→只确认高ID验证相邻低ID仍pending（兼X6-UD-0072）。
- JSON值的克隆/比较复用DbJson，保留整数/浮点表示；BooleanOr仅接受bool/as_i64，超i64整数不能误当true。原小整数断言不变，新增真实公开apply与IPC列表/重放反例。

### R4-SYNC-03：维护/日志分支修复

- get_sync_status：debug“获取同步状态”→维护拒绝→逐库只读→info汇总pending/synced/databases→设备ID；对应commands_sync.rs:1029-1034、1169-1184。维护时不得读路径/DB/设备身份。
- resolve_conflicts：任一非空仍直接停用拒绝，不触发日志/维护；双空才info“开始解决冲突，策略: ”→维护检查→未知策略错误（:1434-1457）。用真实kernel命令验证日志与拒绝顺序。

### X4 W13 本地purge消费状态reset（lib.rs:1015-1052、state.rs:523-551）

- F1/C2最新pre-storage裁定覆盖此前“两阶段/晚期finalizer”提案：正式bootstrap必须只inject paths，由官方生成器显式置于kernel之后、platform之前；不得使用registerFinalizer替代。当前dstu.sync中storageStartupSync是晚期业务适配，不能被生成器当作bootstrap（其inject含storage/notes/syncSupport）。在正式bootstrap落地时必须迁出该provide，保持全profile只有一个提供方。
- 实施缺口已逐项核对：main及F3分支公开api.ts没有独立开库/关闭函数（openFile仅在StorageService实例上）；syncStateDatabasePath在F3 a5b6c8a8d候选只是路径，不提供连接。需F3公开可在服务发布前调用的数据库工厂，返回DatabaseHandle与释放方法，profile=plain/busy_timeout5000；同步SQL仍留业务仓储，不向F3搬表算法。
- profile发现缺口：当前generate.ts仅扫描host/plugins/<目录>/index.ts。本lane写入范围仍仅sync/，不能新建sync-startup/index.ts或修改生成器。可在sync/startup.ts交付模块，但F1需明确扫描该模块或协调者授权独立bootstrap目录；不得把现有sync/index.ts改成仅启动插件而丢失19条命令。

- 唯一reset算法由syncSupport.state.resetDefaultAfterLocalPurge提供。L20只发布 `storageStartupSync.resetDefaultAfterLocalPurge()` 与同一sync业务方法，直接委托、异常原样传播，无额外日志/吞错/第二份SQL。
- 一笔事务清consume_cursor/legacy_processed_key/tombstone_watermark/instance_binding/device_history；保留upload_seq及tombstone_event_publish，不能用备份restore的业务change_log baseline替换。
- 原顺序：purge文件→reset消费状态→报告had_errors检查→清purge marker→允许业务库初始化。reset失败必须保留marker并阻止业务库打开；是否记录清理报告/日志由F3 startup cleanup负责。
- 当前F3 main index.ts:71-75在startup.start内调用，:106调用start后:107才发布storage；L20和syncSupport都依赖storage，故本轮提供方只在服务就绪后可用，不宣称已解决pre-storage purge。禁止把storageStartupSync加入F3硬inject形成环；F3须提供在业务库打开前的两阶段调用时点，不能无条件每次启动reset，也不能把仅在全部插件apply后运行的finalizer当等价时序。

### S01/S04 默认生产 hooks 组合

- index 的唯一默认 hooks 组合显式获取 `ctx.syncSupport.noteHistory` 的 available/affectedNotes 只读面，和 `ctx.notes.sync` / revisions 的同事务写面；不在测试中setDefaultNoteHistory替换它。sync侧仅保留整批格式预检及调度顺序，删除最后的平行note只读SQL副本。
- 当前main支撑方JSON参数仍为旧WireJson，不把DbJson/JsonFloat强制cast为旧面；完整payload写入通过notes.sync的unknown入参原样传递，不损失整数/小数。支撑方候选全hooks修复尚未合入时，不绕回其旧重复写实现。
- 保留note_history.rs:264-266、371-373的特性开关顺序：无note_document_revisions.version_id时先返回，不解析support/notes owner；否则正常经真实支撑读取和所有者写。避免把旧库/临时库普通行apply变成“缺history服务”的隔离失败。
- 集成证据：真实安装vfs-repos→notes→sync-support→sync；直接读生产默认hooks用于补充回归，原五项测试仍调用公开ctx.sync.apply/getPending/enrich。新增spy仅观察真实支撑读取与notes所有者，不替换被测算法；断言owner拿到apply事务而非另一个连接。

### L21 SyncPorts 真实装配与错误边界

- 两个run_sync函数在维护检查后从backup.syncCommandPorts()装配limiter/SSOT/audit；tombstones与按需agentWorkspace仍由L20组合，不从L21取application。跨库apply固定await ctx.sync公开方法，durable检查先于ack。
- tryAcquire忙返回null才映射原busy文案；端口抛锁IO时保留message字符串，进度入口发failed，不把异常变成null/closed。导入直接调用正式acquireOperation('sync',60000)，不走会把lock_io改成closed的syncPorts等待哨兵，保留原真实错误。
- 再次核对：Rust等待失败的“获取全局数据治理锁失败”是Semaphore关闭，不代表文件锁IO；因此不得用它覆盖实际文件系统错误。测试使用真实backup服务构造锁文件目录错误，比较命令拒绝与原许可错误message。

### W18：笔记写入委托（D1/D4，note_history.rs:110-317）

- 四个写接缝委托真实 `notes.sync.prepareRelation/retargetNoteRelations/applyRevision/updateInferredFormat`，把apply传来的同一个SqlExecutor原样传入，不重新开连接或拆批次事务。删除sync内关系CAS/重定位/失效、历史INSERT/pin UPDATE、推断格式UPDATE及重复块解析器。
- 批前格式验证、受影响笔记只读查询保留在同步侧；before_sync快照仍经notes.revisions.snapshot后setPinned，remote_sync先所有者updateInferredFormat再snapshot，顺序不变。异常包装为SyncError Database error，交现有隔离/SAVEPOINT处理。
- 保留R4无损props_json与真实CAS回归；L10所有者当前JSON.parse和未safeIntegers读取仍有已上报缺陷，接线测试必须如实红，不允许把失败断言改为接受舍入，也不留本地写副本绕过owner。

### D1/D4 番茄派生计数所有者接线

- 合入 L11 `vfsRepo.pomodoros.recomputeCompletedPomodorosForSyncBatch(conn, changedTables)` 后，删除本 lane 重算/清零/echo SQL 副本。index 注入 vfsRepo，所有 apply 模式仍在原 IMMEDIATE 事务的逐行 SAVEPOINT 后、提交前传递同一个 SqlExecutor。
- 所有者异常包装 SyncError 的 Database error Display；不另开事务、不拆提交；失败回滚本批实际行与派生计数。测试使用真实 vfs-repos 插件，断言所有者能读到本批未提交行、抛错后两者均回滚。
- 驱动 require/构造失败直接使测试模块失败；删除所有根据 sqliteAvailable 选择 describe.skip 的路径。为L22兼容保留的 sqliteAvailable=true 只在真实加载成功后初始化，不能吞掉ABI错误。

### C2/R4 无损 JSON 公共边界

- dstu-sync/Cargo.toml:35-38 明确启用 serde_json arbitrary_precision。serde_json 1.0.149 number.rs 的 Number 底层是 String、按表示比较；de.rs scan_exponent 将 E→e、缺正号补 +，保留小数与指数数字。
- 公开 parseJsonLossless/stringifyJsonLossless/dbJsonEquals/JsonFloat/DbJson，SQL 入口公开 sqliteValueToJson；整数超安全范围从原始 JSON source 构造 bigint，SQL 必须 safeIntegers；禁止从已舍入 Number 修复。numeric reviver 无 source 时明确失败。
- enrichChangesWithData 的公开返回类型为 EngineChange[]，与 apply/upload 的无损输入一致；旧 SyncChangeWithData 兼容声明继续保留，但不得用于新内部 JSON 精度链路。
- JsonFloat 保留解析得到的原始十进制表示（仅按 serde 规范化指数），value 只供显式 f64 使用；比较/序列化/clone 不走舍入后的 value。1 与1.0不同；arbitrary_precision 下1.0与1.00也不同。SQL INTEGER 小 bigint 与同值安全整数表示相等；REAL 保持 JsonFloat。
- 测试同时经公开 API 覆盖真实 Node/Electron source、JSON 文本嵌套值、SQL INTEGER/REAL、冲突哈希/去重及不可变历史 props_json 差异。S03 是否关闭仍待 R4 独立复核；不按新增用例数提升原测试映射。

### 公开跨库 apply（commands_backup.rs:113-118、374-617；C2 接口请求）

- `sync.applyDownloadedChangesToDatabases(changes, strategy)` 返回 Promise，设备身份取 paths.deviceId；全部 DB 工作在取得身份后同步执行。连接 profile 显式 busy_timeout=5000，不创建不存在的目标库。
- 未知 legacy 表、未知 database_name、缺目标库分别记录原 error 日志并累积失败；仍处理其他库，最终抛原聚合错误，因此调用方不得 ack 游标。resources legacy 另 warn，其他未知表 debug。
- KeepLocal 仅已存在且没有本地 pending 时过滤；其余全部进入冲突保护；Manual 映射 KeepLocal 冲突策略并保留 local/cloud 两侧快照。每库已提交结果不因另一库失败撤销。
- apply 后按 Rust 顺序统计、日志、mastery 重算，再最多20次隔离重放；mastery/profile 错误保留上下文，隔离重放失败 warn 后继续。该公开面复用本 lane 仓储，L21 不复制实现。

### 本地写命令共享许可（commands_sync.rs:2577-2602、4620-4624、5250-5254）

- import 在开始日志后检查维护模式，再在共享 limiter 等待 60 秒（commands.rs:176 的 SYNC_LOCK_TIMEOUT_SECS）；超时和关闭保留两条 Rust 错误，超时等待者由 L21 从队列移除。许可随完整文件读取/应用/异步后处理存活，finally 释放，不因前端窗口关闭提前释放。
- resolveRecordConflict / rollbackSnapshot 先维护检查再 tryAcquire；busy 分别提示“请刷新冲突后重试”/“请稍后重试”，且先于任何参数/数据库校验。持许可执行既有完整本地函数，异常也释放。
- L21正式接口已合入main：三个本地写命令现已注册并通过公开sync服务调用。导入直接await backup.acquireOperation('sync',60000)；裁决/回滚直接tryAcquireOperation('sync')，busy按稳定reason映射原文案，lock_io不得伪装成忙锁；finally必需release。真实backup+sync插件IPC测试验证与backup/restore互斥及错误后可重取许可。

### 顶层同步入口（commands_sync.rs:1586-2317、2859-3364）

- log→维护检查→方向（大小写不敏感，both=bidirectional）/策略解析→显式配置或 hydrated SSOT→hydrate→device ID→开始审计→全局 try-acquire。busy 不排队。进度入口仅成功取锁后 preparing，并安装 provider status/cancel、全局取消槽与 emitter sink，退出配对清理。
- 创建 storage→format gate→target lease→涉及上传时密码门槛→registry drift→本地 manifest→schema gate→富化本地变更。进度入口的 get_pending_changes 失败按 Rust match `_ => {}` 忽略；无进度入口须报错。缺库跳过，全无库报错。
- 进度执行阶段的失败返回 success=false 响应（取消时改“同步已取消”），先 failed 事件再 error 日志/失败审计；前置失败仍抛字符串。只有 success 且 error_message=None 才 completed，否则 partial；审计 completion 仍按 success 判断。
- 普通路径执行阶段的 `?` 直接传播，不能统一改成失败响应；文件报告失败则返回 success=false。Upload 文件先于行；双向先 apply/filter，再文件上传/行上传/标记发布；Download 后发布游标清单，再补文件。成功上传/双向最后归档。目标租约释放失败 warn 不改结果，全局许可覆盖清理全过程。
- L21 的共享许可/SSOT/审计已在其分支 `BackupService.syncCommandPorts()` 发布，当前分支仍待 main 冲突解决后集成。跨库 apply 已由本 lane `sync.applyDownloadedChangesToDatabases` 提供，两个顶层入口直接消费它，不再向 L21 请求复制实现。

### v2 下载/双向进度编排（commands_sync.rs:3569-4017）

- 两条路径都在下载/应用/文件阶段之前做真实序号断层预检，错误保留检查上下文，gaps 逐个 diagnostic 用 `；` 连接；不调用旧快照 bootstrap。
- 下载后发 downloading/applying 事件，清单级冲突计数被实际应用冲突计数覆盖；单条隔离可确认，但 db_errors 必须先报 durable 错误，不能提交游标；确认后发布当前设备清单。
- 双向先 apply 再过滤已覆盖的 `(table,record_id)` 本地快照，记录剔除数；文件 Upload 60..70 失败立即返回，不上传行。行上传字节回调60..85、100ms节流末块必发；成功后逐库标记，仅标实际上传 IDs；清单失败回滚已标 IDs。
- 快照发布和远端 prune 在 Rust 中被 AUTHORITATIVE_SNAPSHOT_REPLACE_ENABLED=false 硬禁用，保留对应 info 文案；不重建死分支。文件 Download 85..99，失败合并 warning；双向随后仍做日志归档。DELETE 版本先固化，归档失败 warn 后继续。
- 跨库 apply 的 Rust 来源为 commands_backup；按 C2 指派由本 lane 唯一实现并发布，`SyncDatabaseApplication` 接受同步/异步聚合结果，生产调用固定为 ctx.sync.applyDownloadedChangesToDatabases。

### 下载确认与 DELETE 归档保护（mod.rs:3819-3832、8390-8440）

- commitDownloadProgress 先协商/绑定当前远端 instance，再按返回 map 顺序逐个 setCursor，最后逐个 markLegacyProcessed；任何错误立即传播，不跨操作开事务，不额外发日志/事件。调用方必须在 durable apply 后调用。
- prepareDeleteVersionsForCleanup 先确保 DELETE 账本表；缺 change_log 表直接返回；按 id 顺序读全部 DELETE（不限 sync_version），经既有 recordDeleteVersion 的版本比较回填；只保留更新版本。准备/读取/写入失败保留 Rust 步骤上下文；无事务/日志/事件。归档调用方必须在此成功后才清历史日志。

### 直接墓碑命令共享许可（commands_sync.rs:4033-4133）

- 先 hydrate 配置，再 try-acquire 与备份/恢复相同的全局许可；busy 错误固定 `[E_DG_TOMBSTONE_LIMITER_BUSY] 另一个数据治理任务（同步/备份/恢复/删除标记）正在进行中，请稍后再试。`。不增加维护模式检查。
- 持许可期间创建主 storage→设备 ID→另建 policy storage 验密码→创建共享 DSBK 会话→markBlob/AssetDeleted（含 L20b 上传回读）。任何错误均 finally 释放，含策略失败和上传回读失败，不能提前释放。
- 创建传输、策略、标记分别保留步骤错误；blob 参数原样传 hash/path/size，asset 原样传 key/size。没有额外事件/日志或本地 DB 写入。
- 最小共享许可端口 `src/limiter-needs.ts::SyncGlobalLimiter` 待 L21 暴露，不能把测试 semaphore 装成生产服务。

### 记录上传密码门槛（commands_sync.rs:35-80）

- 配置密码只过滤缺省/null/空字符串，不 trim 空白。策略单独创建传输实例；创建错误 `创建云存储失败: ...`，策略错误 `同步加密一致性检查未通过: ...`。
- 复用 L23 `CloudSyncManager.enforceEncryptionPolicyBeforeUploadWithPassword`：明文无 marker 不写；启用时验证/登记带 keyVerifier marker，同密码允许，错密码不得覆盖 marker；加密根记忆沿用平台 app-data 路径。
- 必须处于完整 run_sync 的 target lease 内、所有业务对象写之前。无自有加密算法、无额外事件/事务；外部算法日志由 L23 记录。高层入口仍等待 L21 共享许可与 L20b async codec。

### 文件阶段、删除队列与工作区屏障（commands_sync.rs:391-1013）

- 三个删除队列每轮按 retry_count/deleted_at 正序最多 500；不按失败次数放弃。缺库/缺表/空行返回零，行类型错误跳过；负 size 转 None。上传成功才删除本地行，失败逐行递增 retry_count（写失败按 Rust 忽略）并 warn/报错。
- 工作区必须先取得 L05 维护屏障；缺 coordinator 或进入失败则整个工作区步骤跳过并报告失败，继续 blob/asset。退出屏障最多三次，50/100ms 间隔，最终失败 error 保持只读；限流提前返回也释放屏障。
- Upload/Bidirectional 各文件步骤前 drain 对应删除队列；普通失败汇总后继续，限流立即返回。blob/asset 部分失败分别汇总中文失败数；资产命名冲突有额外 marker 摘要。资产 app_data 映射到 active slot（忽略传入的 app-data 目录）。
- 进度分三段，强制发出每阶段边界；传输回调 100ms 节流，末块必发，所有比例和分步计算保留 f32；无新事务。

### 文件删除传播（mod.rs:12397-12945）

- 单条标记先 format 写门槛→本设备墓碑清单→当前 UTC 删除时间→L20b prune→上传；批量空集直接返回，非空保留调用方 deleted_at。workspace ID 仅在缺 ws_ 前缀时补齐。
- blob：先绑定 instance/读清单，再读取水位后墓碑并整批校验时间。vfs.db 的 ref_count>0 否决删除，记录 warn，复活时间取 max(now,deleted_at+1ms)；缺库/缺表不阻断，打开/查询失败 warn 后退化。否则云清单更新可否决删除。仅应用成功 hash 排除本轮下载并从清单移除；墓碑水位在应用/必要清单发布成功后推进。
- asset：使用尚未 tombstone 过滤的清单解析 object_key；云端或本地较新时不删。先算活跃引用集：内容寻址对象仍有引用则保留，最后引用删除且相同 key 单次删除；删除本地前仅在 SHA 不匹配/不可得时保留冲突副本，匹配基线时直接删，避免副本再次上传复活对象。Download 不删云对象/不发布清单；应用后才推进水位，再以排除集走标准同步。

### 资产目录同步（mod.rs:11600-12364）

- 扫描 active 的 images/notes_assets/documents/subjects/textbooks/audio/videos 与 app-data/pdf_ocr_sessions；按操作系统路径分段可逆编码，超长/坏 UTF-8 在读取内容与远端写前失败。重复 canonical 路径保留字节序较小原路径并报告。
- 全量云清单按 revision，再中性设备 LWW 合并；坏 key 立即拒绝。canonical key 优先于 raw 别名；R09 有损别名只有无 exact 本地拥有者时认领，多候选须唯一内容/大小匹配。
- 上传大小写槽优先已有云端 key，再字典序；上传按本地 key 排序。未变内容只有需要 E2EE 升级才重传；对象 key 为明文内容哈希。PUT/stat 成功才加入清单，改名删除旧 alias。
- 下载槽先由本地 key 占用；已有等价文件落回真实原名，新文件用 canonical key 且拒绝路径父级符号链接。错误保留旧目标；限流立即退出。被遮蔽项仅内容不同且 LWW 更新时报告冲突。
- 发布前刷新并校验 base hash/revision；不匹配保存冲突副本、保留旧 alias 并报告。对端更旧或本端升级加密才接受本端条目；最后 UUID append-only 清单回读验证。普通文件失败返回失败数组，不中断其他文件，无 DB 事务/事件。

### VFS blob 文件同步（mod.rs:11196-11560、12367-12387）

- 本地 blobs 根不存在直接返回全零结果；否则读全量清单并过滤 tombstone，递归扫描文件名 stem 为 hash，`.tmp` 不参与；不新增对 Rust 未验证路径的限制。
- 上传按 hash 去重，已加密设备遇明文旧条目仍重新上传；明文 key/size 保留，cipher hash/size 单独记录。最多三次 PUT/stat，500/1000ms 退避；限流立即返回；加密失败 error 后加入 upload_failures。
- Download 对本地已有 hash 跳过；加密设备遇明文旧条目 error 后记失败且不做网络重试；其余双哈希下载最多三次，并校验非零明文 size；失败删除目标再重试。普通失败以 hash 数组返回，非整体 throw。
- 上传成功后重新拉清单做并集合并，密文替换明文；普通刷新失败 warn 回退，限流立即传播。发布 compact JSON→E2EE→UUID 清单→GET 回验。没有业务 DB 写入/事件。

### 工作区文件同步（mod.rs:10559-11154）

- 下载 legacy 与 append-only 全量清单（拒绝截断/消失/坏 JSON），revision 大者胜、相同 revision 按 sha256 UTF-8 大者胜；先用全量墓碑过滤，再按实例水位读取墓碑。先验证整批 workspace ID 和时间戳，再删除；云端/本地较新者不删；删除前保留冲突副本，去掉 WAL/SHM，Download 不写云清单。成功后才逐个提交墓碑水位。
- 本地只扫描 ws_*.db，尽力 PASSIVE checkpoint，读取源文件 SHA256/size/mtime；上传比较 source_sha256 或快照 sha256，明文→密文迁移即使内容没变也传；否则中性设备分量 LWW 决定方向。
- VACUUM INTO 一致快照后计算快照哈希，文件对象 key 为 workspace ID/明文快照哈希；加密后写 cipher 元数据；PUT/stat 成功才加入待发布清单。逐项失败收集并 warn，限流立即退出；快照/密文临时文件均清理。
- 下载冲突副本失败 warn 后继续；传输成功后先清 WAL/SHM，再 integrity_check；完整性失败删除新库、warn 并计入失败。
- 发布前刷新清单，普通失败 warn 回退旧视图，限流中止；base hash/revision 不匹配保留冲突副本并跳过条目；否则 LWW，密文升级优先。append-only UUID 清单 compact JSON→DSBK→PUT/GET 全字节回验。最终有任何失败返回 `Network error: 工作区数据库同步部分失败: ...`。
- 墓碑异步 codec 端口未发布前，本实现及原测试保持 pending，生产入口不注册。

### 文件对象传输（mod.rs:998-1023、2640-2662、10273-10460）

- 文件与记录 payload 共用同一懒初始化 F4 FileCipherSession；未加密时直接传原文件；启用时流式加密到系统临时目录，返回密文 SHA256/size，临时文件随作用域释放。
- 上传前检查取消；putFile 后必须 stat，缺失/大小不同/非限流 stat 错误均 warn 并拒绝清单发布；限流立即传播。未加密上传必须读取根 `.encryption-marker`，存在即拒绝，读取失败 fail-closed。
- 下载前检查取消。无 cipher_sha256 的旧条目在启用 E2EE 时拒绝；未启用时复用 L23 可续传下载（内容哈希旁路）或 getFile。加密条目缺密码拒绝；先下载到密文哈希旁路，解密到目标同目录临时文件，校验明文 SHA256 后 rename，最后尽力删密文旁路。
- 解密/校验/替换失败不覆盖原目标；Rust TempPath Drop 对应 finally 清理，忽略删除错误；中断的密文旁路保留供下一次续传。没有 DB 事务/业务事件，不增加重试，续传重试使用 L23 原实现。

### 未同步文件清单聚合（commands_sync.rs:5395-5441、5813-5908）

- 维护检查→补全凭据→活动目录/app-data（后者失败回退活动目录）→设备 ID→创建传输；不获取同步许可，不写本地文件/DB/云端，不推进游标，无日志或事件。
- 每类先读 legacy JSON，再完整列举新前缀，只读 `.json`；列表截断、列举后对象消失、解密失败、结构损坏均中止，保留每一步中文错误前缀。未知字段忽略；entries 必填，updated_at 缺省空串，revision 缺省 0，cipher 字段缺省/null 为 None，u64 无损。
- blob 合并后先读取 blob tombstone；资产同理。条目 updated_at 不晚于 deleted_at 才移除；诊断时间解析使用公开的 numeric 时间支持。
- 分类后按 Rust enum 声明顺序（downloadPending、legacyPlaintext、caseConflict、sanitizedNameConflict、invalidKey），再按 key UTF-8 排序；先统计全量，再截断 500。counterpart/size 为 None 时省略；generatedAt 是 chrono UTC serde 的 AutoSi/Z。
- L20b 现有 PayloadCodec 仍同步，生产入口不注册；本 lane 发布所需异步读取端口并以真实聚合逻辑测试等待接线。不能把纯分类测试提前标为 ported。

### 带行数据上传（mod.rs:2456-2705）

- 空数组 debug 后返回；否则 format 协商→instance 绑定→扫描 raw/hash 的 v3/v4 前缀最大 seq→L20b nextUploadSeq。格式 min_reader>=4 用 v4 key，其余 v3；key 的 UUID 保留完整 operation_id。
- compact JSON（完整记录与元数据）→F7 zstd level0→F4 DSBK；有 progress 时先 tempfile+putFile，检查 stat 大小及 GET 全字节。流式失败 warn 后回退；rate-limit 立即传播，不额外重试。
- 无 progress 或流式回验失败：PUT/size/bytes 回验共两次尝试，间隔500ms；错误分别保持上传/size/缺失/回读上下文。只有全部回验通过才 markPublishedSeq；不修改业务 change_log。
- 临时文件必须在成功/失败后释放（Rust NamedTempFile Drop），清理失败按 Drop 忽略，不能覆盖原错误。成功 info 包含 device/count/key/compressed_size/uploaded_size/encrypted；无事件/数据库事务。

### 下载编排（mod.rs:4017-4120）

- 先校验本地 schema 不会降级云端（下载完成后仍会发布本机 manifest），再下载合并云清单。
- 云清单 tx 为空仍下载 changes，不得把缺清单视为无数据；此分支不做冲突判定。否则 detectConflicts 后，真实 schema mismatch 先报错，再判 Manual 冲突数。
- per_db_since=本地库 data_version，since=最小值或0；交给 downloadChanges；返回 Download 统计/耗时及未确认变更。无实际应用、无游标写入、无额外日志/事件，不走不安全快照 bootstrap。

### 双向引擎编排（mod.rs:4139-4169）

- 调用与单向相同的 executeDownload；不在这里上传、应用或确认游标。返回 Bidirectional 统计，changes_uploaded 是传入 pending.total_count（由上层实际上传后修正），change_ids 保持原 pending 顺序；下载数、冲突数、警告沿用下载结果，duration 独立计时。错误直接传播，无额外日志/事件/数据库写入。

### 变更下载（mod.rs:2725-3075）

- ensure_remote_instance_id 先协商格式并绑定实例；先读设备 manifest 发布水位再 listing（v3+v4）；缺序号直接 Network error，不应用/不确认游标。
- 按设备 raw/hash 别名归一；每设备按 seq/version/key 排序，重复 seq 对应多个对象一律拒绝；从 raw/hash 消费游标最大值+1开始连续读取。丢失对象/解密/JSON 失败中止；zstd 解压失败按原字节尝试 JSON。
- 非零 payload source_seq 必须等于路径 seq；非空 source_device_id 必须与 uploader 或 path hash 匹配；v4 的 format=4 且 operation_id 必须完整匹配路径。返回 raw/hash 双游标建议值，不持久化。
- legacy 按规范化秒版本与 per-db since 过滤，跳过已处理 key；兼容 SyncChangesPayload 和 PendingChanges（后者生成 data=null 的变更）；legacy 缺失对象按 Rust跳过，无法解析/解密则中止。
- 全批按 device/seq/version/内部文本时间/database/table/change_log_id/record/operation 排序；相同内容 keep-last 去重。info 包含 since/total/deduped/v3_devices/legacy。无业务事务或事件，apply 后才能提交返回的游标和 legacy keys。
- zstd 复用 F7 nativeCompression，DSBK 复用 F4；无私有编解码实现。所有 seq/source metadata 保持 bigint。

### 变更元数据整数（mod.rs:6589-6595、9790-9797）

- change_log_id 为 Option<i64>，source_seq 为 Option<u64>，解析与序列化不能经过不安全 Number；超出 JS 安全范围用 bigint。
- 检疫来源序号优先 source_seq；只有可转 i64 时采用，否则退回 change_log_id，再默认 0，不能饱和截断或直接给 SQLite 超范围整数。
- 可选字段缺失/null 保持 None；非法整数类型/范围要拒绝，不能把非法类型当 null。无日志或事务副作用。

### 同步 registry 预检（commands_sync.rs:183-323）

- 逐库按 vfs/llm_usage/chat_v2/mistakes，跳过不存在文件；打不开必须报 `同步预检无法打开数据库 <db>:`，不是跳过。
- 读取 sqlite_master 现存业务表，expected=registry RowSync∩现存表；expected 非空但无 __change_log 时记录缺表后跳过该库触发器扫描。
- 仅扫描 SQL 包含 __change_log 的触发器；挂在非 RowSync 表上记漂移；事件只解析 BEGIN 前的 BEFORE/AFTER/INSTEAD OF 头，按 Rust Unicode whitespace 切词、ASCII 大写；识别失败才按 trigger 名 _insert/_update/_delete 后缀回退。
- required 三事件扣除 classification 的明确豁免；UPDATE OF 同样覆盖 update。所有 issues 用 `；` 连接，以 `同步预检失败：检测到 registry/触发器漂移。` 开头。
- 无日志、无写入、无事件、无事务。SQL 仅放 repository；准备/遍历读取错误分别保留上下文（F3 同步 all 统一执行点见实现）。
- 两个 run-sync 顶层函数均已接入；因 L21/L20b 端口缺失尚未注册命令，六个测试保持 pending，不能通过无调用方导出提升覆盖。

### 行同步的笔记历史依赖（note_history.rs:583-677）

- enrich 必须携带 note_document_formats/revisions；revision 的本地 seq 不发送，pinned 必须发送。未来格式或未来 serializer capability 必须在业务写入前整批拒绝。
- 两设备传播 before→after 后，目标当前内容为 after，历史含 pinned before 与 after；调用 L10 revisions.restoreCopy 能恢复独立 before 副本。保留此完整集成断言，不能只验证字面量或单库快照。

### 未同步文件分类（commands_sync.rs:5377-5805）

- blob 合并：cipher_sha256 有值永远优于无值；同类按 updated_at（双方可解析按时间，否则 UTF-8 字符串）比较。资产合并：revision 优先，平局按 updated_at。清单 updated_at 自身按字符串最大值。
- blob 分类先验证普通相对路径，再探测文件存在；存在则忽略；缺失且本机加密而条目无 cipher → legacyPlaintext，否则 downloadPending。
- 资产分类：UTF-8 排序 key；按 sanitizeAssetKey 建 canonical 代表（本身是 canonical 者优先），内容不同的被遮蔽条目报 sanitizedNameConflict；本地存在性同时检查 canonical/raw，并逐段精确匹配大小写；casefold 槽位先由本地已存在者占用，再按 canonical 排序补齐；缺席条目按 invalidKey → caseConflict → legacyPlaintext → downloadPending 分类。
- 无文件写入、无事务、无事件、无日志。read_dir 失败按 Rust unwrap_or(false) 视为不存在。size 使用 bigint 保持 u64，IPC 转换由最终命令边界负责。
- 待接线：聚合命令必须先消费 L20b `syncSupport.tombstones.downloadBlobTombstones/downloadAssetTombstones`；其 codec 当前同步，需提供与 F4 异步 DSBK 兼容的版本后方可注册。分类模块测试继续 pending，不能仅导出以规避接线检查。

### 内容漂移校验和（mod.rs:9469、9540；Rust test:14029）

- `getDatabaseSyncState` 调用 `calculate_drift_checksum_v2`，按 checksum 分类表和主键排序读取完整行；排除派生字段后计算内容校验和。修改正文而不改行数/updated_at 必须改变 checksum。
- 返回 schema/data 版本、checksum、last_updated_at；辅助元数据查询失败的默认行为保持 Rust；无写入、无事件、无额外日志或事务。

### 设备清单发布（mod.rs:1838-2103）

- 设备路径为 16 位十六进制短哈希；匹配同时接受 raw ID 与 hashed ID。legacy key 保留 raw ID，仅用于旧清单读取/删除迁移；对应 `record_path_id_is_short_hash_and_matches_raw_or_hashed` 全部断言。

- 顺序固定：读取全部 raw/hashed/legacy 清单做 schema gate → format gate → 远端实例绑定 → 设备轮换 superseded 标记 → 注入本端已发布 seq 和 cursors → pretty JSON → E2EE → PUT 后 GET 逐字节验证 → 尽力删除旧 raw key。
- schema gate 不先去重设备别名；忽略 superseded 清单；云 schema 高于本地（缺失视为 0）才拒绝。错误条目按数据库 UTF-8 顺序、cloud 版本排序并去重；Display 保留升级本机/其他设备两种指引。
- instance.json 已存在且 instance_id 为非空字符串时 trim 后绑定；缺失/损坏/空 ID 按 Rust 建新 UUID（写入前仍过 format）。本地绑定由 L20b state 负责。
- 设备轮换：空 old 或 old==new 立即返回；否则 format gate 后优先 hashed 再 raw；已有 superseded_by==new 时不写。轮换写失败 warn 后继续当前设备发布。
- 读取可选轮换记录失败无日志继续；读取 published seq 失败用 0，cursors 失败用空 map；打开可选状态失败保留输入清单对应字段。必需 instance 绑定错误仍传播。
- 上传外层总共 2 次尝试，间隔 500ms；遇 L23 rate-limit 稳定码直接返回，不再次尝试。重试前 warn 包含步骤、次数、错误和等待时长；保持同一 payload/key。
- 旧 key 的 stat 或 delete 失败分别 warn，不推翻已验证成功的发布；成功 info 包含 device/tx/databases/key/encrypted。无业务数据库事务、无 IPC 事件。

### 手动同步 JSON 读写（commands_sync.rs:2509-2543）

- `SyncExportData` 三个必填字段：manifest、pending_changes、exported_at；记录数据不裁剪，整数经无损 JSON 保留。
- 写入先 File::create，再 pretty JSON，再 flush；打开/写入/flush IO 错误前缀 `写入文件失败:`，编码错误前缀 `序列化导出数据失败:`。读取先打开再解析，IO 前缀 `读取文件失败:`，解码/结构前缀 `解析导入数据失败:`。
- BufReader/BufWriter 不改变内容；字段默认与 SyncManifest 的 serde 一致。未知字段忽略；不是 number 的 schema 不转换接受。
- helpers 无日志、无事件、无数据库事务；文件关闭对应 Drop（忽略关闭失败）。命令调用 helper 后才继续比对/应用，测试必须走同一 helper。
- 命令日志：导出前 info `导出同步数据`，写完后 info `同步数据已导出: path=..., changes=...`（2386/2493）；导入前 info path（2577）、应用失败 error（2711）、应用完成 info applied/failed/skipped（2705）、最终 info applied/failed/conflicts（2721）。全部走注入 logger。

### 服务生命周期与依赖接线（工作协议 v2）

- 提供 `sync`，版本描述 `syncService = { name: 'sync', version: '1.0.0' }`。旧名不另注册，消费方按 ARCHITECTURE 附录 A 更新。
- 显式注入 `storage`、`paths`、`notes`、`backup`、`syncProvider`、`secrets`、`vfsDatabase`、`syncSupport`；依赖未提供时由 Cordis 等待，不注册半功能命令。
- 生产调用：`ctx.notes` 构造笔记历史钩子；`ctx.syncSupport.state` 供预检与清单发布；`ctx.backup.hydrateCloudConfig` 必须先于 `ctx.syncProvider.createStorage`；`ctx.secrets.backup` 提供 DSBK；`ctx.vfsDatabase.isInMaintenanceMode` 用于维护检查。导入已消费真实 backup 共享许可并注册；`index.ts:88` 显式 inject mastery，review 仅 inject storage。
- Rust 对应：commands_sync.rs:1281-1379（检测）、5151-5167（巡检）；commands_backup.rs:500-605（apply 后 mastery 与隔离重放）。错误/日志沿用原命令的各步骤文案，注入不新增业务事件、事务或远端写入。
- 新名 notes/syncProvider/syncSupport 均已发布。main 的 notes↔vfs-repos 去环修正因 apply.ts/note-history.test.ts 合并冲突尚未进入分支；按协议 abort，待协调者处理，生产不加旧名 fallback。
- 锁完整性复核：import_sync_data、resolve_record_conflict、rollback_sync_snapshot_batch 的 IPC 和高层服务方法撤下；Rust 分别要求 acquire_owned 超时和 try_acquire_owned，L21 api 尚无共享许可。不能以本 lane 自建 mutex 替代。
- 回归测试须验证新名提供、旧名不提供、缺依赖不启动，以及凭据补全先于真实传输工厂的调用顺序。

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：serde 默认把 `Option::None` 序列化为 `null`；仅显式 `skip_serializing_if` 的字段（如清单 `superseded_by`、变更条目 `field_deltas_json`）缺省。
- [x] u64/i64 超过 2^53 的表示：按D3，内部HLC/manifest/seq/cursor/size用bigint，持久化与比较不经Number；只在IPC边界输出JSON number，行为与Rust→前端JSON.parse一致，不拒绝安全范围外合法输入。引擎JSON文本仍无损。
- [x] 字段顺序（serde_json preserve_order）：Rust 开启 `preserve_order`；TS 依赖 JSON.parse 的插入顺序，纯数字键的顺序差异只在 LWW 内容 tiebreaker 中可能可见。
- [x] f32 精度：进度百分比按 f32 语义用 `Math.fround` 分步计算（progress.ts）。
- [ ] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：CommandError 保留外层步骤文案；JSON parser 内层 Display 尚不等价 serde_json，需完成验收。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：本 lane 已注册的本地命令无取消点；云端进度命令未注册。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：本地读取用 storage 的 plain 连接（busy_timeout 5000），不持全局同步锁；写入事务使用 `db.transaction`。
- [x] 时间与 ID：F4 chrono AutoSi，UTC `+00:00`，按精度输出小数；明确要求 Millis/Z 的历史字段使用 toRfc3339Opts；operation_id/uuid 用 `crypto.randomUUID()`；设备 ID 由 `paths.deviceId()` 统一生成并持久化。
- [x] 不对含 HashMap 的结构做序列化后比对：冲突/清单比较按排序后的键集合进行（`detectConflicts` 对数据库名排序）。

## 命令 `data_governance_cancel_sync`

<!-- BEGIN GENERATED:cmd:data_governance_cancel_sync -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:2810` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1013`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：（无）
  - 结果：boolean · 错误：string
<!-- END GENERATED:cmd:data_governance_cancel_sync -->

- [x] 输入：无参数（commands_sync.rs:2810-2812）。
- [x] 输出：有活动同步令牌时 cancel 并返回 true；否则 false（2812-2823）。
- [x] 错误：读取令牌锁失败按无令牌处理（`read().ok()`），命令本身不返回错误（2812-2815）。
- [x] 事件：无。
- [x] DB 读写：无数据库访问（2801-2824）。
- [x] 取消/并发：模块级取消槽（RwLock<Option<CancellationToken>>）；协作式取消，限流等待/退避立即中断，文件传输在当前文件结束后的检查点停止（2806-2823）。
- [x] 时间/ID：无生成（2810-2824）。

## 命令 `data_governance_count_record_conflicts`

<!-- BEGIN GENERATED:cmd:data_governance_count_record_conflicts -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:4550` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1427`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：（无）
  - 结果：RecordConflictCounts · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_count_record_conflicts -->

- [x] 输入：无参数，commands_sync.rs:4551。
- [x] 输出：per_database 只含 groups > 0 的库；total_groups/total_rows 汇总（4555-4583）。
- [x] 错误：不存在/打不开的库跳过，计数 SQL 失败回退零（4562-4569）。
- [x] 事件：无（4551-4584）。
- [x] DB 读写：按 vfs/llm_usage/chat_v2/mistakes 顺序，plain 连接 busy_timeout=5000；COUNT 使用原 U+001F 连接键、resolved_at IS NULL（4530-4546）。
- [x] 取消/并发：不持全局锁，无取消点，逐库只读（4551-4584）。
- [x] 时间/ID：无生成（4551-4584）。

## 命令 `data_governance_detect_conflicts`

<!-- BEGIN GENERATED:cmd:data_governance_detect_conflicts -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:1280` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:837`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：cloudManifestJson?: string | null, cloudConfig?: CloudStorageConfig | null
  - 结果：ConflictDetectionResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_detect_conflicts -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `data_governance_detect_prune_gap`

<!-- BEGIN GENERATED:cmd:data_governance_detect_prune_gap -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:5070` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1643`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：cloudConfig: CloudStorageConfig
  - 结果：PruneGapResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_detect_prune_gap -->

- [x] 输入：cloudConfig 必填；维护检查先于 hydrate；补全凭据后读取 deviceId 和本地四库状态（commands_sync.rs:5071-5104）。
- [x] 输出：since_version 是已存在库 data_version 的最小值，空集 0；has_gap 仅由序号 gaps 决定，uses_device_cursors 固定 true；gap_details 非空时按 device_id 排序后用 `；` 连接诊断（5105-5141）。
- [x] 错误：不存在/打不开/状态读取失败的库按 `if let Ok` 跳过且无日志；创建传输失败包装 `创建云存储失败: `；预检失败包装 `检查云端变更断层失败: `，内部 Network/Database Display 保留。
- [x] 日志：预检 `info!` 包含 instance、format、cursors、min_available、gaps（mod.rs:1620）；命令 `info!` 包含 format、instance、since、min_available、has_gap（commands_sync.rs:5123）；走插件 logger。
- [x] 事件：无。
- [x] DB 读写：业务库只读，逐个 openFile/close；有远端 instance 时调用 L20b `syncSupport.state.bindInstance` 后 `cursors`，无 instance 时不访问状态服务，不写 consume_cursor（mod.rs:1572-1633）。
- [x] 取消/并发：不取目标租约、不写云对象；清单发布水位读取必须先于分片 listing，避免并发发布误报尾部缺失；没有重试或额外取消点。
- [x] 时间/ID：不生成 ID；版本 >1e11 才按毫秒除 1000；Rust u64 seq/cursor 用 bigint。IPC number 边界限制见报告。

## 命令 `data_governance_discard_all_quarantine`

<!-- BEGIN GENERATED:cmd:data_governance_discard_all_quarantine -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:4351` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1584`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：（无）
  - 结果：BatchQuarantineResult · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_discard_all_quarantine -->

- [x] 输入：无参数（commands_sync.rs:4352）。
- [x] 输出：success 为已删行数；failed=0、errors=[]（4376-4383）。
- [x] 错误：缺库/打开失败/缺表跳过；DELETE 失败返回“批量清除失败: …”（4358-4374）。
- [x] 事件：无（4352-4384）。
- [x] DB 读写：各治理库 DELETE FROM __sync_quarantine，不改业务表（4372-4374）。
- [x] 取消/并发：不持全局锁，无跨库事务；前面库已删除时后面库失败不回滚（4358-4376）。
- [x] 时间/ID：无生成（4352-4384）。

## 命令 `data_governance_discard_quarantine`

<!-- BEGIN GENERATED:cmd:data_governance_discard_quarantine -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:4256` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1567`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：databaseName: string, quarantineId: integer(i64)
  - 结果：boolean · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_discard_quarantine -->

- [x] 输入：databaseName 字符串、quarantineId i64，数据库名按 all_ordered 精确匹配（commands_sync.rs:4257-4266）。
- [x] 输出：缺表 false，DELETE changes > 0（4271-4281）。
- [x] 错误：“未知数据库: …”“打开数据库 … 失败: …”“丢弃隔离记录失败: …”（4266-4280）。
- [x] 事件：无（4257-4282）。
- [x] DB 读写：plain 连接，缺文件可新建，DELETE WHERE id=?1，不改业务表（4267-4279）。
- [x] 取消/并发：无全局锁，无取消点，单 DELETE 自动提交（4257-4282）。
- [x] 时间/ID：无生成（4257-4282）。

## 命令 `data_governance_export_sync_data`

<!-- BEGIN GENERATED:cmd:data_governance_export_sync_data -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:2368` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:883`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：outputPath?: string | null
  - 结果：SyncExportResponse · 错误：string · 注入：app-handle, window
<!-- END GENERATED:cmd:data_governance_export_sync_data -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `data_governance_get_sync_status`

<!-- BEGIN GENERATED:cmd:data_governance_get_sync_status -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:1025` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:826`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：（无）
  - 结果：SyncStatusResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_get_sync_status -->

- [x] 输入：无参数，commands_sync.rs:1026-1034。
- [x] 输出：`SyncStatusResponse`；按 `DatabaseId::all_ordered()`（vfs、llm_usage、chat_v2、mistakes）只输出存在的库；缺少 `__change_log` 时 has_change_log=false 且计数 0（1042-1140）；`partial=errors 非空`，`last_sync_at` 取各库已同步时间最大字符串（1161-1185）。
- [x] 错误：单库打开/检查/统计/最后时间失败都记入 `errors` 并把该库标 unknown，不中断其他库（1047-1154）。
- [x] 事件：无。
- [x] DB 读写：plain 连接（busy_timeout=5000）只读查询 `__change_log`；不存在的库文件跳过；每库用后关闭（1042-1157）。
- [x] 取消/并发：不持全局锁，无取消点，逐库读取；设备 ID 通过 `paths.deviceId()` 解析（1188-1220）。
- [x] 时间/ID：`last_sync_at` 为库内既有 `changed_at` 字符串；`device_id` 由 paths 服务生成/持久化，不在此命令内生成新 ID（1184）。

## 命令 `data_governance_import_sync_data`

<!-- BEGIN GENERATED:cmd:data_governance_import_sync_data -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:2570` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:897`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：inputPath: string, strategy?: string | null
  - 结果：SyncImportResponse · 错误：string · 注入：app-handle, window
<!-- END GENERATED:cmd:data_governance_import_sync_data -->

- [x] 输入：inputPath必填，strategy缺省keep_latest；keep_local/use_cloud/keep_latest/manual四值，先读导入文件/本地manifest再校验策略（commands_sync.rs:2605-2699）。
- [x] 输出：success按failed==0；imported_changes实际应用成功数，conflicts_detected取记录/清单最大值；Manual真冲突才needs_manual_resolution；错误/不完整警告优先级与Rust一致（2700-2753）。
- [x] 错误：维护/60秒共享锁→路径→读取/解析→策略→跨库apply分阶段字符串CommandError；文件helper保留分类，JSON内部文案差异仍列全局歧义，未宣称逐字验收（2577-2602、2614-2715）。
- [x] 事件：无业务事件；导入开始/应用成功/最终info，应用失败error与Rust一致（2577、2705、2711、2721）。
- [x] DB 读写：由applyDownloadedChangesToDatabases按目标库路由、冲突保护/隔离重放/mastery钩子处理；每库自身事务，部分成功不跨库回滚（2686-2715，commands_backup.rs:374-617）。
- [x] 取消/并发：backup.acquireOperation('sync',60000)等待同一全局许可；finally随实际工作释放，不监听前端abandon提前释放（2583-2602）。
- [x] 时间/ID：设备由paths.deviceId；清单/实际落库时间由既有引擎生成；导入保留payload原changed_at（2635-2753）。

### WP-004 mastery 集成证据

| Rust 分支 | TS 接线与断言 |
|---|---|
| commands_backup.rs:512-555：vfs mastery_events 批次成功后重建 | index.ts:111-115 / mutation-commands.ts:26 → apply-databases.ts → review 公共 mastery；`mastery-integration.test.ts` 从 IPC 导入3条事件，核全部响应字段及真实掌握度 total/wrongCount/streak/lastSignalAt |
| commands_backup.rs:552-554：重建错误；models.rs:1038-1041 Display | `masteryMessage` 只在两个 mastery 错误分支抽取 CommandError.value.message；真实 SQLite trigger 失败，IPC 保留完整 Rust 前后缀，事件已提交、状态未写入 |
| commands_backup.rs:594-601：关闭原连接后画像回流、错误上抛 | 真实 review.syncAllLearnerProfiles 使用其 storage；扩展 sink 观察已提交事件/非事务连接，故障测试保留源事件及聚合状态；公开 apply 的 Delete 分支验证归零与 remove 回调 |
| commands_sync.rs:2583-2602、2672-2683、2710-2715 | 真实 backup 许可在成功、策略错误、重建错误和画像错误后均可重新获取；没有提前回滚已提交的 apply，也未吞掉后置错误 |

这些是本包新增集成回归，不占用其他 lane 的 Rust TESTMAP 行、不改变本 lane 两条 pending 的去向。sink 仅是 memory 扩展点测试替身，review/mastery、sync/apply、backup 许可与 SQLite 均为真实实现。

## 命令 `data_governance_list_quarantine`

<!-- BEGIN GENERATED:cmd:data_governance_list_quarantine -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:4167` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1547`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：SyncQuarantineRow[] · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_list_quarantine -->

- [x] 输入：`limit?` 缺省 200、上限 2000；`offset?` 缺省 0（commands_sync.rs:4173-4175）。
- [x] 输出：跨库聚合 `SyncQuarantineRow[]`，按 last_attempt 倒序、同值按 id 倒序，再 offset/limit 切片（4223-4228）。
- [x] 错误：缺库/打不开的库跳过；缺表跳过；SQL 失败返回“准备隔离区查询失败: …”“执行隔离区查询失败: …”“读取隔离记录失败: …”（4182-4220）。
- [x] 事件：无。
- [x] DB 读写：按 all_ordered 顺序 plain 连接只读 `__sync_quarantine`；每库用后关闭（4178-4221）。
- [x] 取消/并发：不持全局锁、无取消点（4166-4229）。
- [x] 时间/ID：输出既有时间字段，不生成新值（4223-4228）。

## 命令 `data_governance_list_record_conflicts`

<!-- BEGIN GENERATED:cmd:data_governance_list_record_conflicts -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:4406` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1398`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：RecordConflictRow[] · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_list_record_conflicts -->

- [x] 输入：`limit?` 缺省 200、上限 2000；`offset?` 缺省 0（commands_sync.rs:4413-4414）。
- [x] 输出：未解决冲突行按 detected_at 倒序、同值按 id 倒序；分页按 `(database_name, table_name, record_id)` 分组，选中组的所有行都返回（4471-4501）。
- [x] 错误：缺库/打不开的库跳过；缺表跳过；SQL 失败返回“准备冲突查询失败: …”“执行冲突查询失败: …”；行解析失败被 `flatten()` 静默跳过（4423-4469）。
- [x] 事件：无。
- [x] DB 读写：按 all_ordered 顺序 plain 连接只读 `__sync_conflicts WHERE resolved_at IS NULL`；每库用后关闭（4417-4470）。
- [x] 取消/并发：不持全局锁、无取消点（4402-4501）。
- [x] 时间/ID：输出既有 detected_at，不生成新值（4471-4475）。

## 命令 `data_governance_list_sync_snapshot_batches`

<!-- BEGIN GENERATED:cmd:data_governance_list_sync_snapshot_batches -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:5186` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1494`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：limit?: integer(u32) | null
  - 结果：SyncSnapshotBatchRow[] · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_list_sync_snapshot_batches -->

- [x] 输入：`limit?: u32`，缺省 50，按 `min(500)` 截断为每库上限（commands_sync.rs:5190-5192）。
- [x] 输出：跨库 `SyncSnapshotBatchRow[]`；每库 `list_batches` 新的在前，合并后按 batch_id 倒序并全局截断到 per_db_limit（5194-5221）。
- [x] 错误：单库读取批次失败返回“读取 {db} 的快照批次失败: …”；缺库/打不开的库跳过（5194-5207）。
- [x] 事件：无。
- [x] DB 读写：plain 连接只读 `__sync_record_history`；表不存在时该库返回空；每库用后关闭（5194-5217）。
- [x] 取消/并发：不持全局锁、无取消点（5182-5185）。
- [x] 时间/ID：输出既有 `created_at`/`batch_id`，不生成新值；batch_id 倒序使用字节序（5218-5220）。

## 命令 `data_governance_list_unsynced_items`

<!-- BEGIN GENERATED:cmd:data_governance_list_unsynced_items -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:5812` · async
- 前端：app（1 处，例 `src/features/settings/components/data-governance/UnsyncedItemsPanel.tsx:104`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：cloudConfig: CloudStorageConfig
  - 结果：UnsyncedItemsReport · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_list_unsynced_items -->

### §2完成清单（已注册，正常main已含L20b async codec）

生产入口：index.ts注册→sync.listUnsyncedItems→listUnsyncedItemsCommand；直接使用ctx.syncSupport.tombstones。`tombstone-ipc.test.ts`经真实L21/L23/L20b与HTTP WebDAV验证报告字段/只读无PUT；不把注册等同完整独立签收。

- [x] Rust入口:5813-5908 → `src/unsynced-command.ts:listUnsyncedItemsCommand`；聚合`src/unsynced-items.ts:collectUnsyncedItems`。
- [x] 分支表：见下；不执行上传/apply/游标确认。
- [ ] 数据边界：cloudConfig采用既有契约；清单经parseBlobManifest/parseAssetManifest；size内部bigint、只在命令结果转number；待真实IPC验证report camelCase字段及Option字段省略。
- [x] 日志：该入口无warn/error/info，不补造日志；下游owner日志由owner保持。
- [x] 错误：维护先于hydrate；provider“创建云存储失败”；旧/分设备清单fetch/decrypt/parse、truncated、listed missing和两类tombstone分别前缀，fail-fast。
- [x] 所有权：只读L23云清单和本地文件、L20b墓碑；不写业务数据库/云对象/state。
- [ ] 运行时：codec finally dispose；generatedAt墙钟UTC；分类有本地stat，阻塞语义需正式入口检查；无全局写permit/无额外取消点。
- [x] 测试：原`unsynced-items.test.ts`/`unsynced-classification.test.ts`断言保留；新增真实index invoke空云报告/只读查询，见tombstone-ipc.test.ts；原各分类分支仍需按TESTMAP逐项复核。
- [x] 证据等级：审读+生产入口测试；不是Rust差分或R4整体签收。

| commands_sync.rs分支 | TS落点 |
|---|---|
| 5819-5833 维护/凭据/路径/codec/provider | unsynced-command.ts:10-20 |
| 5836-5858 blob清单合并/墓碑按时间剔除 | unsynced-items.ts:66-74 |
| 5860-5883 asset清单合并/墓碑按时间剔除 | unsynced-items.ts:75-83 |
| 5885-5908 本地分类/kind+key排序/500截断/总数 | unsynced-items.ts:84-97；unsynced-classification.ts |

## 命令 `data_governance_mark_asset_deleted`

<!-- BEGIN GENERATED:cmd:data_governance_mark_asset_deleted -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:4104` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1617`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：key: string, size?: integer(u64) | null, cloudConfig: CloudStorageConfig
  - 结果：null · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_mark_asset_deleted -->

### §2完成清单（已注册，正常main已含L20b async codec）

生产入口：index.ts注册→sync.markAssetDeleted→markAssetDeletedCommand；L21 syncCommandPorts.limiter与L20b tombstones均直接消费正式对象。tombstone-ipc.test.ts经过真实WebDAV发布后检查墓碑字节与许可释放。

- [x] Rust入口:4105-4133 → `src/tombstone-commands.ts:markAssetDeletedCommand`/markDeletedCommand。
- [x] 分支表：:4112 hydrate→markDeletedCommand:22；:4116共享try permit→:23；:4118 provider→:25-27；:4122-4128 device/加密一致性/codec→:28-33；:4130 publish→file-deletions.ts:32-41。
- [ ] 数据边界：key/string、size/Option<u64>、cloudConfig；内部size bigint/null，结果unit→IPC null；注册时验证真实kernel入参解码，不强转owner codec。
- [x] 日志：命令没有独立业务日志；下游格式/墓碑owner保留原日志，不重复。
- [x] 错误：hydrate→busy稳定码→provider前缀→加密策略原错误→“标记资产删除失败”；各步不得调换。
- [x] 所有权：L21唯一共享permit；L23云存储/加密一致性；L20b本设备墓碑download→merge→prune→upload与回读；不直接写业务DB。
- [x] 运行时：permit覆盖加密预检到PUT后回读，所有出口finally release；codec finally dispose；deleted_at在预检后生成UTC墙钟；不新增维护检查/target lease。
- [x] 测试：file-deletions/mutation-commands原断言保留；tombstone-ipc经正式index与真实L21/L23/L20b验证发布/回读/同一permit；全部原边界签收仍按TESTMAP推进。
- [ ] 证据等级：已有生产入口测试，最终lane-gate及独立复核待本轮结果。

## 命令 `data_governance_mark_blob_deleted`

<!-- BEGIN GENERATED:cmd:data_governance_mark_blob_deleted -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:4062` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1601`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：hash: string, relativePath?: string | null, size?: integer(u64) | null, cloudConfig: CloudStorageConfig
  - 结果：null · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_mark_blob_deleted -->

### §2完成清单（已注册，正常main已含L20b async codec）

生产入口：index.ts注册→sync.markBlobDeleted→markBlobDeletedCommand；IPC size转bigint后保持内部精确。tombstone-ipc.test.ts以真实backup持锁拒绝、释放后真实WebDAV+L20b发布，未替换owner算法。

- [x] Rust入口:4063-4094 → `src/tombstone-commands.ts:markBlobDeletedCommand`/markDeletedCommand。
- [x] 分支表：:4071 hydrate→markDeletedCommand:22；:4077共享try permit→:23；:4079 provider→:25-27；:4083-4089 device/加密一致性/codec→:28-33；:4091-4094 publish→file-deletions.ts:17-26。
- [ ] 数据边界：hash/string、relativePath/Option<String>、size/Option<u64>、cloudConfig；内部size bigint/null；IPC unit→null。待正式kernel契约测试。
- [x] 日志：入口无独立info/warn/error；owner事件发布日志保留原级别/字段。
- [x] 错误：共享permit busy保留E_DG_TOMBSTONE_LIMITER_BUSY与原中文；provider“创建云存储失败”；policy原样；业务“标记 blob 删除失败”。
- [x] 所有权：同asset命令；L20b拥有墓碑状态和清单编解码，L20只编排，不复制其SQL/算法。
- [x] 运行时：持共享许可到read-back结束，finally释放/codec dispose；无额外维护检查/取消点；timestamp在实际publish时生成。
- [x] 测试：已有正式index invoke发布/同设备互斥/释放证据；新增DSBK异步墓碑原样回读测试，实际结果见REPORT。
- [ ] 证据等级：已有生产入口测试，最终lane-gate及独立复核待本轮结果。

## 命令 `data_governance_purge_resolved_conflicts`

<!-- BEGIN GENERATED:cmd:data_governance_purge_resolved_conflicts -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:5010` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1468`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：olderThanDays?: integer(u32) | null
  - 结果：integer(u64) · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_purge_resolved_conflicts -->

- [x] 输入：`olderThanDays?: u32`，缺省 30 天（commands_sync.rs:5013-5017）。
- [x] 输出：所有库删除的已解决冲突行数之和（u64）（5019-5048）。
- [x] 错误：单库打开失败、缺表、DELETE 失败均按 0 跳过，不中断汇总（5023-5046）。
- [x] 事件：无。
- [x] DB 读写：按 all_ordered 顺序 plain 连接，DELETE `resolved_at IS NOT NULL AND resolved_at < cutoff`；不改业务表（5020-5047）。
- [x] 取消/并发：不持全局锁、无取消点、无跨库事务（5015-5048）。
- [x] 时间/ID：cutoff = 当前 UTC 时间减 cutoffDays 天，chrono `to_rfc3339()` 格式（5017）。

## 命令 `data_governance_repo_check`

<!-- BEGIN GENERATED:cmd:data_governance_repo_check -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:5150` · async
- 前端：app（1 处，例 `src/features/settings/components/CloudStorageSection.tsx:100`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：cloudConfig: CloudStorageConfig
  - 结果：RepoCheckReport · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_repo_check -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `data_governance_resolve_conflicts`

<!-- BEGIN GENERATED:cmd:data_governance_resolve_conflicts -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:1428` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:852`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：strategy: string, cloudManifestJson: string
  - 结果：SyncResultResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_resolve_conflicts -->

- [x] 输入：strategy、cloudManifestJson 两个必填字符串（commands_sync.rs:1429-1433）。
- [x] 输出：正常路径已停用；仅当两参数都为空时才可能继续，但随后立即因空策略报错（1434-1459）。
- [x] 错误：任一参数非空 → “批量清单级冲突接口已停用，因为它只生成记录 ID、不会提交数据库或云端变更。请使用 data_governance_list_record_conflicts 和 data_governance_resolve_record_conflict 逐条裁决。”；两者皆空 → “未知的合并策略: 。可选值: keep_local, use_cloud, keep_latest, manual”（1434-1458）。
- [x] 事件：无。
- [x] DB 读写：停用判断先于任何数据库/云端访问（1434-1439）。
- [x] 取消/并发：无取消点；不获取锁（1434-1459）。
- [x] 时间/ID：停用路径不生成时间/ID（1434-1459）。

## 命令 `data_governance_resolve_record_conflict`

<!-- BEGIN GENERATED:cmd:data_governance_resolve_record_conflict -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:4610` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1452`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：databaseName: string, tableName: string, recordId: string, resolution: string, mergedDataJson?: string | null, expectedConflictIds: integer(i64)[]
  - 结果：null · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_resolve_record_conflict -->

- [x] 输入：共享try-acquire先于expectedConflictIds非空校验；IDs排序去重，库名all_ordered匹配；keep_local/keep_cloud/merged，merged需JSON（commands_sync.rs:4620-4791）。
- [x] 输出：成功unit→null；已达期望状态走只标记resolved快路径，不重写业务行或制造历史快照（4793-4887）。
- [x] 错误：busy保持“请刷新冲突后重试”；旧generation、本地变化、缺cloud side、JSON/未知resolution与写回错误分别保留原文；CommandError不走panic（4624-5009）。
- [x] 事件：无事件/日志；快路径和实际写路径均无额外前端推送（4611-5009）。
- [x] DB 读写：快路径IMMEDIATE事务重读IDs/业务行再标记；写路径force-exact事务preflight重读+历史快照、finalize重核generation+逐行resolved，全部同一连接提交（4793-5009）。
- [x] 取消/并发：直接backup.tryAcquireOperation('sync')，busy立即失败、不排队；finally释放且不拆原事务（4621-4624）。
- [x] 时间/ID：resolved_at/changed_at使用UTC RFC3339；updated_at原数字保持毫秒数、文本保持RFC3339；history batch按原newBatchId（4889-5009）。

## 命令 `data_governance_retry_all_quarantine`

<!-- BEGIN GENERATED:cmd:data_governance_retry_all_quarantine -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:4293` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1580`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：（无）
  - 结果：BatchQuarantineResult · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_retry_all_quarantine -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `data_governance_retry_quarantine`

<!-- BEGIN GENERATED:cmd:data_governance_retry_quarantine -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:4232` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1557`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：databaseName: string, quarantineId: integer(i64)
  - 结果：boolean · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_retry_quarantine -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `data_governance_rollback_sync_snapshot_batch`

<!-- BEGIN GENERATED:cmd:data_governance_rollback_sync_snapshot_batch -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:5244` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1520`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：databaseName: string, batchId: string
  - 结果：RollbackSnapshotResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_rollback_sync_snapshot_batch -->

- [x] 输入：databaseName/batchId；维护/共享try-acquire先于库名查找，未知库拒绝（commands_sync.rs:5250-5264）。
- [x] 输出：batch_id/restored/deleted/skipped/undo_batch_id五字段（5287-5295）。
- [x] 错误：busy保持“请稍后重试”；未知库/打开库/回退快照批次三步字符串文案（5254-5285）。
- [x] 事件：无命令级日志/事件（5245-5296）。
- [x] DB 读写：rollbackBatch在同库IMMEDIATE事务恢复/删除业务记录并创建undo快照；缺批次等错误由history引擎保留（history.rs:351-541）。
- [x] 取消/并发：backup.tryAcquireOperation('sync')与备份/恢复共享；持有到回退函数结束，finally释放（5251-5254）。
- [x] 时间/ID：原batchId保持；新undo batch由history.newBatchId生成，未改变原时间/ID布局（history.rs:63、351-541）。

## 命令 `data_governance_run_sync`

<!-- BEGIN GENERATED:cmd:data_governance_run_sync -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:1585` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:869`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：direction: string, cloudConfig?: CloudStorageConfig | null, strategy?: string | null
  - 结果：SyncExecutionResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_run_sync -->

### §2完成清单（已注册，正常main已含L20b async codec）

生产入口：index.ts→sync.runSync→runSync；workspaceCoordinator通过ctx.reflect.get按需读取真实L05 owner，对应Rust可选状态，不引入硬注入环。真实storage迁移、L21许可/SSOT、L23 WebDAV、L20b tombstones、L05维护屏障组合已执行空云download成功路径。

- [x] Rust入口:1586-2317 → `src/run-sync.ts:runSync` → `record-plain.ts:executePlainSync`；D7跨库apply已公开且await。
- [ ] 分支表：下表覆盖主分流，正式入口接线时继续逐子分支核对，不以三种direction代替所有异常/文件分支。
- [ ] 数据边界：direction大小写及both别名；strategy缺省keep_latest；可选cloudConfig从L21 SSOT补全；SyncExecutionResponse保持原字段；真实IPC解码/明密文持久化往返待入口测试。
- [x] 日志：runSync:43开始、:81汇总、:91租约释放warn；started/complete/failed审计委托L21，不自建审计SQL。
- [ ] 错误：维护→参数→配置→审计→permit→provider→format→lease→policy→registry→schema；engine异常返回CommandError，普通版不能套用progress版success=false转换；待IPC反例核实。
- [ ] 所有权：L21许可/SSOT/audit，L23云/lease，L20b state/tombstone，D7 apply由L20同库事务调owner；generic row/refcount剩余R4-SYNC-01独立缺口不据本命令统签。
- [ ] 运行时：performance.now时长；lease/codec/permit全finally；文件workspace维护有真实owner；同步查库/哈希worker等运行时义务仍须核；无progress版token/hook副作用。
- [x] 测试：run-sync.test.ts已改真实index invoke保留错误/事件/释放断言；tombstone-ipc.test.ts真实owner组合download成功；shared-permit-ipc真实L21 busy/SSOT错误。带数据cursor/apply原向量保持既有测试，继续逐项复核。
- [ ] 证据等级：已有生产入口测试；最终lane-gate与完整§2/独立复核尚pending。

| Rust阶段（commands_sync.rs:1586-2317） | TS落点 |
|---|---|
| 维护/参数/SSOT/started审计/共享许可 | run-sync.ts:41-61 |
| provider/codec/格式协商/target lease/加密策略/registry/schema | run-sync.ts:64-78 |
| 收集变更与Upload/Download/Bidirectional分流 | run-sync.ts:79-80；record-plain.ts:executePlainSync |
| records应用成功后才确认cursor；workspace/blob/asset与队列 | record-plain.ts、record-progress.ts、file-level-sync.ts；application固定ctx.sync.applyDownloadedChangesToDatabases |
| 结果/审计/租约释放warn/Drop | run-sync.ts:81-94 |

## 命令 `data_governance_run_sync_with_progress`

<!-- BEGIN GENERATED:cmd:data_governance_run_sync_with_progress -->
- Rust：`src-tauri/src/data_governance/commands_sync.rs:2858` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:994`）
- 契约：`contracts/ipc/L20-sync.json`
  - 参数：direction: string, cloudConfig?: CloudStorageConfig | null, strategy?: string | null
  - 结果：SyncExecutionResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_run_sync_with_progress -->

### §2完成清单（已注册，正常main已含L20b async codec）

生产入口：index.ts→sync.runSyncWithProgress→runSyncWithProgress；正式owner组合成功返回且最终completed/succeeded/100%，结束后cancel=false。早期失败的failed事件/无ghost preparing/许可与hook清理均由真实invoke验证。

- [x] Rust入口:2859-3364 → `src/run-sync.ts:runSyncWithProgress`；事件owner为kernel.backendEvents。
- [ ] 分支表：下表主分支已有函数实现，待正式index接线逐条生产验证。
- [ ] 数据边界：与普通run_sync参数/结果同契约；事件operation_id/outcome/phase/percent/current/total等按progress.ts规范；不以测试手装token代替真实注册。
- [x] 日志：:100开始、:162执行失败error、:170汇总、:179释放lease失败warn；emitter失败走logger.error回调；审计使用L21。
- [ ] 错误：早期错误emitter.failed后CommandError；实际execute失败记录failed审计并返回success=false，cancel改原“同步已取消”；partial不发completed。待真实invoke原分支断言。
- [ ] 所有权：同普通run_sync；progress不自行写业务DB；跨库应用及文件owner必须await成功再ack。
- [ ] 运行时：permit后安装AbortController/status hook；finally清hook/token/status sink并释放lease/codec/permit；D7 apply await；monotonic duration；worker义务/平台文件边界待完整检查。
- [x] 测试：run-sync/shared-permit-ipc已改真实index invoke，真实owner组合成功和清理新增tombstone-ipc；完整取消进行中/带数据cursor/E2EE分支仍按原测试与后续入口复验，不能用空云覆盖统签。
- [ ] 证据等级：生产可达候选已修（X6-PR-0117/0118），有生产入口测试；完整语义及正常main后R复核未签收。

| Rust阶段（commands_sync.rs:2859-3364） | TS落点 |
|---|---|
| 维护/参数失败发failed/SSOT/started审计/permit | run-sync.ts:96-122 |
| preparing→token/statusHook→detecting；provider/format/lease/policy/schema失败 | run-sync.ts:123-152 |
| Upload / Download / Bidirectional | run-sync.ts:155-159；record-upload-progress.ts / record-progress.ts |
| execute失败/取消→success=false、失败事件/审计 | run-sync.ts:160-166 |
| completed vs partial；汇总审计 | run-sync.ts:168-175 |
| lease失败warn、清理token/hook与permit | run-sync.ts:176-183 |

## 事件 `data-governance-sync-progress`

<!-- BEGIN GENERATED:event:data-governance-sync-progress -->
- 事件名 `data-governance-sync-progress`，常量 `EVENT_NAME`
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:236`（emit）
<!-- END GENERATED:event:data-governance-sync-progress -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `direction`

<!-- BEGIN GENERATED:event:expr:direction -->
- 动态事件名（表达式）
- 发送点：`src-tauri/src/data_governance/commands_sync.rs:857`（emit）
- 发送点：`src-tauri/src/data_governance/commands_sync.rs:910`（emit）
- 发送点：`src-tauri/src/data_governance/commands_sync.rs:962`（emit）
- 发送点：`src-tauri/src/data_governance/commands_sync.rs:1010`（emit）
<!-- END GENERATED:event:expr:direction -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `progress`

<!-- BEGIN GENERATED:event:expr:progress -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:164`（emit）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:178`（emit）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:192`（emit）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:227`（emit）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:323`（emit）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:360`（emit）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:380`（emit）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:389`（emit）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:398`（emit）
<!-- END GENERATED:event:expr:progress -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `SyncProgress { operation_id: None, outcome: None, phase: SyncPhase::DetectingChanges, percent: 5.0, current: db_index as u64 + 1, total: total_dbs, current_item: Some(db_id.as_str().to_string()), speed_bytes_per_sec: None, eta_seconds: None, error: None, }`

<!-- BEGIN GENERATED:event:expr:SyncProgress{operation_id:None,outcome:None,phase:SyncPhase::DetectingChanges,percent:5.0,current:db_indexasu64+1,total:total_dbs,current_item:Some(db_id.as_str().to_string()),speed_bytes_per_sec:None,eta_seconds:None,error:None,} -->
- 动态事件名（表达式）
- 发送点：`src-tauri/src/data_governance/commands_sync.rs:3092`（emit）
<!-- END GENERATED:event:expr:SyncProgress{operation_id:None,outcome:None,phase:SyncPhase::DetectingChanges,percent:5.0,current:db_indexasu64+1,total:total_dbs,current_item:Some(db_id.as_str().to_string()),speed_bytes_per_sec:None,eta_seconds:None,error:None,} -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `SyncProgress::completed()`

<!-- BEGIN GENERATED:event:expr:SyncProgress::completed() -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:197`（emit）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:403`（emit）
<!-- END GENERATED:event:expr:SyncProgress::completed() -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `SyncProgress::detecting_changes()`

<!-- BEGIN GENERATED:event:expr:SyncProgress::detecting_changes() -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:150`（emit）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:371`（emit）
<!-- END GENERATED:event:expr:SyncProgress::detecting_changes() -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `SyncProgress::failed(error.into())`

<!-- BEGIN GENERATED:event:expr:SyncProgress::failed(error.into()) -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:205`（emit）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:408`（emit）
<!-- END GENERATED:event:expr:SyncProgress::failed(error.into()) -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `SyncProgress::failed(error.into()).with_outcome(SyncOutcome::Partial)`

<!-- BEGIN GENERATED:event:expr:SyncProgress::failed(error.into()).with_outcome(SyncOutcome::Partial) -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:210`（emit）
<!-- END GENERATED:event:expr:SyncProgress::failed(error.into()).with_outcome(SyncOutcome::Partial) -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `SyncProgress::preparing()`

<!-- BEGIN GENERATED:event:expr:SyncProgress::preparing() -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:145`（emit）
- 发送点：`src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs:366`（emit）
<!-- END GENERATED:event:expr:SyncProgress::preparing() -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：
