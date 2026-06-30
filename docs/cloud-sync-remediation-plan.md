# 云同步模块完整修复方案（Cloud Sync Remediation Plan）

- 版本：1.0
- 日期：2026-06-10
- 基准：`nightly` 分支 commit `5ae97d875`
- 范围：`src-tauri/src/data_governance/sync/*`、`src-tauri/src/data_governance/commands_sync.rs`、`commands_backup.rs`、`commands_restore.rs`、`src-tauri/src/cloud_storage/*`、相关 migrations、前端同步入口（`SyncSettingsSection.tsx`、`CloudStorageSection.tsx`、`cloudStorageApi.ts`、`dataGovernance.ts`、`DataGovernanceDashboard.tsx`、`SyncConflictDialog.tsx`）
- 结论来源：两轮共 9 个独立审阅/核查代理逐行验证，所有缺陷均有确切 file:line 依据；行号以基准 commit 为准。

---

## 0. 文档使用说明

1. **本文件是唯一权威修复清单**。每个缺陷有唯一编号（C/M/T/F/O 前缀），§2 的追溯矩阵保证"每个缺陷 → 至少一个修复项"，修完本文件所有 Phase 即修完全部已知隐患。
2. 实施顺序必须遵守 §5 的 Phase 划分与依赖关系：Phase 0 可立即独立发布；Phase 2（协议 v3）是后续多数修复的地基，不可跳过。
3. 每个修复项附验收标准（AC）。一个修复项"完成"的定义 = 代码合并 + 对应 AC 的自动化测试通过。
4. 全部完成后必须通过 §7.4 的全局收敛性验收，才能认为"任何复杂情况下稳定有效同步"达标。

---

## 1. 目标与硬性不变量

修复后的系统必须满足以下不变量（INV）。任何实现取舍以不破坏 INV 为底线：

- **INV-1（无静默丢失）**：任何已成功写入云端的变更，最终会被所有设备应用，或显式进入检疫/冲突/错误状态并对用户可见。绝不允许"跳过且不再重试且无记录"。
- **INV-2（收敛性）**：任意设备集合、任意操作序列、任意同步次序与交错，在所有设备完成足够多轮同步后，所有 RowSync 表的业务状态逐字节一致（含软删除状态）。等价表述：单条记录的最终状态只取决于该记录全部变更的集合，与应用顺序无关。
- **INV-3（删除有效性）**：删除（行级软删、blob、资产、工作区）一经同步，在所有设备生效且不复活；重新创建同一身份的数据（同 id / 同 hash / 同路径）不被旧删除记录误杀。
- **INV-4（时钟独立）**：同步正确性不依赖任何两台设备的墙钟相对关系。墙钟仅作为 LWW 的偏好信号（带确定性 tie-break），不作为"是否可见/是否已消费"的判据。
- **INV-5（失败诚实）**：部分失败必须以 `success=false` 或显式 warning 形态贯穿后端返回值、进度事件、前端 UI 三层；进度水位（游标）在对应数据未安全落地前绝不推进。
- **INV-6（传输契约）**：所有存储后端对同一接口契约（递归列举、完整或报错、not-found 与错误区分、写入原子可见）行为一致，并由统一契约测试约束。
- **INV-7（新设备/落后设备可引导）**：任何新设备或离线任意久的设备，都存在一条确定性路径（快照引导 + 增量追赶）达到与集群一致的状态，或得到明确的不可恢复错误提示。

---

## 2. 缺陷追溯矩阵

> 严重度：P0 = 必然丢数据/永不收敛；P1 = 常见场景丢数据/不收敛/安全问题；P2 = 效率、健壮性、可观测性。
> "修复项"指向 §5 中的 Phase 与条目编号。

### 核心版本与水位线（C 组）

| ID | 严重度 | 缺陷 | 关键位置 | 修复项 |
|----|--------|------|----------|--------|
| C1 | P0 | 下载水位线跨设备时钟域比较；并发上传/时钟偏差窗口内变更永久漏下载。纯下载设备水位线也被 echo 抑制推到本地 now | mod.rs:1219-1221, 1907-1914, 3660-3672, 4899-4908 | P2-1 |
| C2 | P1 | 解密/解析失败仅记 warning，success 恒 true，水位线照常推进 → 永久丢失 | mod.rs:1231-1242, 1284-1287, 1609-1616, 1671-1678 | P2-1, P2-4 |
| C3 | P1 | 备份恢复后回声过滤（is_own_change_file）使本机 post-backup 已上传变更永远找不回 | mod.rs:1214-1217, 1361-1371, 1980-2068 | P2-6 |
| C4 | P1 | dedupe_downloaded_changes keep-first，内容巧合相同的"最新变更"被丢弃，终态错误 | mod.rs:1389-1423 | P0-7 |
| C5 | P1 | prune gap 检测三缺陷：since 取各库 min 且任一为 0 即禁用；min_available 全局最小与按设备 prune 口径不符；v2 进度路径（主 UI 路径）完全无强制检查 | commands_sync.rs:994-999, 1045-1050, 2418-2764; mod.rs:4023-4050 | P0-2, P2-2, P2-5 |
| C6 | P2 | download_changes 版本比较未做毫秒归一化，与 prune/min_available 口径不一致 | mod.rs:1219 vs 1481, 4042 | P0-8 |
| C7 | P2 | mark_synced 单条 UPDATE IN(...) 不分批，超 SQLite 变量上限整体失败 → 重传循环（rollback_marked_sync_versions 同病） | mod.rs:1862-1890; commands_sync.rs:50-58 | P0-9 |
| C8 | P2 | 上传无端到端校验（put 后不回验 size/ETag）；v2 进度路径 put_file 无重试而非进度路径有 | mod.rs:1140-1163 | P0-10 |
| C9 | P1 | 新设备 since=0 被显式放行，行级数据无快照机制，changes 按 30/90 天裁剪 → 历史数据静默缺失 | mod.rs:4025, 1458-1512 | P2-3 |

### 变更应用与合并语义（M 组）

| ID | 严重度 | 缺陷 | 关键位置 | 修复项 |
|----|--------|------|----------|--------|
| M1 | P0 | 字段级合并无"是否真并发"判定，对每条下载变更无条件执行 union/max 合并 → 删除型修改（删 tag/删图/SM-2 重置）永不传播且全网复活 | mod.rs:2599-2639, 2805-2887; conflict_resolver.rs:218-232（已有判定但未传入） | P4-1 |
| M2 | P0 | merge_sum_value 把双方全量值相加（非 delta），不幂等不收敛，数值每轮膨胀 | field_merge.rs:235-240, 97-99; mod.rs:2467 | P4-2 |
| M3 | P1 | 同时刻 tie-break 三处互相矛盾（conflict_resolver 本地胜 / should_apply_change_by_strategy 云端胜 / compare_timestamps Equal→本地胜），无全序量 → 分叉或互换振荡 | conflict_resolver.rs:305-321, 381-391; commands_backup.rs:250-256; mod.rs:2104-2118, 2151-2176 | P4-3 |
| M4 | P1 | 手动冲突解决：注释称 force 实为非 force，被 should_skip_stale_update 静默吞掉；字段合并会篡改用户选定值；无论写入与否无条件标记 resolved | commands_sync.rs:2974-3054（尤其 3039-3050） | P4-5 |
| M5 | P1 | 显式置 NULL 无法传播（build_insert_parts 跳过 null + COALESCE 模板），且等价比较按 cloud keys 子集恰好掩盖分叉 | mod.rs:2912-2914, 2714-2737, 4463-4484 | P3-4 |
| M6 | P1 | DELETE 恒重排批尾（同记录"删除→重建"乱序）；无 deleted_at 的表（blobs）DELETE 无任何 LWW 门直接硬删 | mod.rs:3539-3556, 4142, 4236-4243 | P3-3 |
| M7 | P1 | files 主 UPSERT 硬编码 ON CONFLICT(sha256)，id 冲突走 fallback 而 fallback 保护业务键列 → 内容哈希更新永不传播 | mod.rs:2675-2691, 2394-2398 | P3-5 |
| M8 | P1 | ID 别名可成环（insert_alias 无反向检查），build 的不动点循环遇环即 Err → 整库下载永久失败（毒丸形态） | mod.rs:3116-3160, 3203-3216, 3308-3368 | P3-2 |
| M9 | P1 | 同批两条远端记录业务键互撞：别名查找只查本地 DB，fallback 合并后不登记别名 → 子表 FK 悬挂 → 全批回滚死循环 | mod.rs:3245-3306, 2741-2781 | P3-2 |
| M10 | P0 | 毒丸变更 all-or-nothing：单条永久性错误（data=None 带 database_name、payload 主键不一致、合并未命中等）使整库每轮回滚、永久卡死，无检疫机制；ApplyChangesResult.failures 从未被填充 | mod.rs:3690-3711, 4272-4277, 2582-2590, 2879-2884; commands_backup.rs:449-472 | P3-1 |
| M11 | P0 | FK 防线错位：应用路径 foreign_keys 全程 OFF（defer_foreign_keys 是空操作），唯一防线是无作用域的全库 PRAGMA foreign_key_check —— 历史存量违规会让所有下载永久失败 | commands_backup.rs:365; mod.rs:3584-3591, 3006-3036, 3679, 3968 | P3-1 |
| M12 | P2 | 应用路径所有 Connection::open 均未设 busy_timeout，BEGIN IMMEDIATE 遇并发写立即 SQLITE_BUSY | commands_backup.rs:365; commands_sync.rs 共 25 处 | P0-11 |
| M13 | P1 | HLC 全模块死代码（tick/receive/compare_hlc_strings 零生产调用），写路径仍是墙钟；HLC/ISO 混排时三处比较互相矛盾，should_skip_stale_update 在混排时 LWW 完全失效 | hlc.rs 全文; mod.rs:2155, 4146, 4338-4457 | P4-4 |
| M14 | P2 | BooleanOr 对 SQLite INTEGER 0/1 是 no-op（as_bool→None），is_favorite 合并是虚假承诺且会丢值 | field_merge.rs:263-267; mod.rs:4788-4793 | P4-2 |
| M15 | P2 | 类型保真：BLOB→base64 无类型标记；u64>i64::MAX 走 f64 丢精度；TEXT 内 JSON 被 parse-reserialize 改写字节；bool↔0/1 使幂等比较失效 | mod.rs:4788-4815, 2921-2938, 3096-3114 | P3-6 |
| M16 | P2 | calculate_simple_checksum 仅 COUNT+MAX(updated_at)，伪阴性多；混合格式下 SQL MAX 无意义 | mod.rs:4935-5014 | P6-4 |
| M17 | P2 | apply_merge_to_database 文档声称事务化，实际无事务且吞错（pub API 危险接口） | mod.rs:2205-2259 | P3-7 |
| M18 | P2 | llm_usage_daily legacy record_id 按 '_' splitn 切分，字段含下划线时主键错位 | mod.rs:4650-4701 | P3-7 |
| M19 | P2 | applied_keys 两条路径记录的 record_id 不一致（原始 vs remapped），双向同步上传剔除失准 | mod.rs:3636-3639 vs 3826-3829 | P3-7 |
| M20 | P2 | ensure_table_allowed_and_exists 白名单过宽（仅排除 sqlite_*/__*），云端 payload 可写任意本地表 | mod.rs:2973-3004 | P3-8 |
| M21 | P2 | StringConcat（不可交换、编辑放大）、JsonArrayUnion（顺序不收敛，对 block_ids_json 等有序列破坏语义）、JsonDeepMerge（标量 remote-wins 不可交换）、EaseFactorAverage（震荡）均违反收敛性 | field_merge.rs:243-260, 270-285, 294-319, 219-230 | P4-2 |
| M22 | P2 | field_merge 策略注册表与 mod.rs picklist 两处独立维护且互相脱节（blobs.ref_count、essays/translations/todo_lists/mindmaps.is_favorite 等注册了但永不触发）；classification.conflict_policy 与策略表无程序化关联 | field_merge.rs:82-174; mod.rs:2443-2520; classification.rs | P4-2 |
| M23 | P2 | detect_record_conflicts/is_record_conflicting 仅测试可达，语义与生产路径（resolve_one）不一致，易被新代码误用；sync() 内裸字符串比较 updated_at | mod.rs:679-731, 772 | P4-6 |

### 墓碑与文件级同步（T 组）

| ID | 严重度 | 缺陷 | 关键位置 | 修复项 |
|----|--------|------|----------|--------|
| T1 | P0 | blob 墓碑是永久黑名单：entry 有 deleted_at 但 apply 不读、不比较时间；prune_tombstones 零生产调用；store_blob_with_conn 重导入不清队列不撤墓碑 → 重新导入同内容文件被每轮同步反复删除；资产墓碑同病（内联 apply 同样不读 deleted_at） | tombstone.rs:263-314, 339-354; mod.rs:6182-6222, 6237-6250; blob_repo.rs:68-183 | P5-1 |
| T2 | P1 | 墓碑清单与备份层 manifest.json 均为无并发控制的整文件 RMW（无 ETag/条件写）→ 并发删除/上传互相覆盖丢条目；drain 队列逐条全量 RMW（500 条=1000 次请求） | mod.rs:6138-6176; tombstone.rs:218-221; sync_manager.rs:156-183, 325-334; commands_sync.rs:196-220 | P5-1, P1-6 |
| T3 | P1 | workspace 墓碑函数是死代码（mark_workspace_deleted 不存在）；资产/工作区删除无任何捕获路径（业务删除直接 fs::remove_file）→ 删除必复活 | tombstone.rs:179-206, 241-255; chat_v2/workspace/database.rs:350-365; cmd/notes.rs:714-719 | P5-2 |
| T4 | P1 | ws/资产整文件同步是 last-syncer-wins：仅比较 sha，WorkspaceEntry.updated_at 只写不读；PASSIVE checkpoint 后边写边传，云端副本可能撕裂 | mod.rs:5619-5640, 5666-5682, 5944-5996 | P5-3 |
| T5 | P1 | 文件级同步函数无方向参数，纯 Download 仍会把本地 blob/资产/ws 上传覆盖云端 | mod.rs:5591, 6182, 6228; commands_sync.rs:1193-1255, 2465-2511 | P5-4 |
| T6 | P2 | blobs 行级元数据先于 blob 文件到达对端（"有记录无文件"窗口）；上传失败仅 warning | commands_sync.rs:923-1255; mod.rs:3542 | P5-5 |
| T7 | P2 | apply_blob_tombstones 每轮全量重放历史墓碑（O(历史删除数) 次云端 delete）；清单无限增长 | tombstone.rs:263-314 | P5-1 |

### 云存储传输层（F 组）

| ID | 严重度 | 缺陷 | 关键位置 | 修复项 |
|----|--------|------|----------|--------|
| F1 | P0 | FTP list 非递归（目录直接 continue），changes/{device_id}/ 嵌套一层 → FTP 后端增量同步完全失效（下载 0 条、prune/gap 检测全失效），显示"成功" | ftp.rs:490-564（尤其 519-521） | P1-1 |
| F2 | P0 | FTP get/stat 把任意 SIZE 错误吞成 Ok(None)（with_retry 不重试 Ok）→ 弱网下空 manifest 覆盖云端版本列表 | ftp.rs:463-469, 623-629, 180-207 | P1-1 |
| F3 | P1 | FTP STOR 直接写最终名，无 temp+rename（suppaftp 6.0.7 有 rename API 未用），截断文件立即可见 | ftp.rs:410-440, 646-712 | P1-1 |
| F4 | P1 | FTP LIST 手写解析只认 Unix 9 列（DOS/IIS 整目录漏列；连续空格文件名损坏）；每文件单发 MDTM（N+1），失败回退 Utc::now() 伪造时间 | ftp.rs:512-526, 547 | P1-1 |
| F5 | P1 | FTP 整文件入内存（put_file/retr_to_vec），10GB 备份 OOM；suppaftp 流式 API 未用 | ftp.rs:264-313, 695-699 | P1-1 |
| F6 | P2 | FTP 只读操作（get/list/stat）带 MKD 写副作用 | ftp.rs:448, 496-504, 609 | P1-1 |
| F7 | P1 | WebDAV 750 条目上限与 MAX_DIRS=200 截断均静默返回部分列表 → 上层视未列出对象为不存在 | webdav.rs:646-654, 694-707 | P1-2 |
| F8 | P1 | WebDAV Client 300s 整请求总超时杀死大文件传输（reqwest 0.11 无 read_timeout） | webdav.rs:57-62; Cargo.toml:73 | P1-2 |
| F9 | P1 | WebDAV 目录判定依赖 href 尾斜杠（RFC 仅 SHOULD），PROPFIND 未请求 resourcetype → 部分服务器漏列整子树 | webdav.rs:274, 365, 640 | P1-2 |
| F10 | P2 | S3 Config 无 TimeoutConfig，TCP 半开时整个同步流程无限挂起 | s3.rs:48-68 | P1-3 |
| F11 | P2 | root="/" 经 filter→trim 顺序错误变成空串：WebDAV 全部失效（"//" 前缀匹配不命中）；FTP 产生双斜杠路径；S3 不受影响 | config.rs:185-192; webdav.rs:318 | P1-4 |
| F12 | P2 | 换 root/账户/provider 不重置同步基线，本地游标与远端无绑定 → 串库/漏同步 | config.rs 全文（无实例标识） | P1-5 |
| F13 | P2 | 备份下载解密就地非原子覆盖（写一半崩溃则密文明文俱毁） | cloud_storage/mod.rs:374-381 | P1-6 |
| F14 | P2 | 备份加解密整文件双份内存（10GB 上限下峰值 2×） | cloud_storage/mod.rs:217-227, 374-381 | P1-6 |
| F15 | P2 | 契约测试缺口：FTP 完全无契约测试；list 递归性、截断、root 边界、并发 RMW 均未测 | tests/sync_provider_contract_tests.rs | P1-7 |

### 编排与前端（O 组）

| ID | 严重度 | 缺陷 | 关键位置 | 修复项 |
|----|--------|------|----------|--------|
| O1 | P1 | emit_completed 不看 exec_result.success；SyncSettingsSection 丢弃 runSyncWithProgress 返回值、凭 completed 事件弹"同步成功"（Dashboard 是正确实现，两入口不一致） | commands_sync.rs:2096-2099; SyncSettingsSection.tsx:224-246 | P0-3 |
| O2 | P1 | FTP 凭据链路断裂：ftp.password 明文进 localStorage（safeConfig 未剥离）；后端 CloudStorageCredentials 结构根本没有 ftpPassword 字段（serde 静默丢弃）；加载器无 ftp 分支 | CloudStorageSection.tsx:263-269; cloudStorageApi.ts:99-130; secure_store.rs:453-465 | P0-4 |
| O3 | P2 | data_governance_import_sync_data 不取 BACKUP_GLOBAL_LIMITER、不查维护模式 | commands_sync.rs:1580-1745 | P0-5 |
| O4 | P2 | 双向同步进度条 98%→10% 回退（阶段区间写死且执行顺序与区间顺序不符） | progress.rs:103-156; commands_sync.rs:2531-2644 | P6-1 |
| O5 | P2 | 文件级阶段（可能 GB 级）无任何进度事件；大文件无断点续传 | commands_sync.rs:2350-2401 等; mod.rs:5720-5891 | P6-2 |
| O6 | P2 | registry/触发器无漂移校验（新表漏注册=双重静默）；review_stats 声称由不同步的 review_history 重建（自相矛盾）；mindmap_versions/settings 等仅 BackupOnly 需产品确认 | classification.rs:244-253, 325-334; mod.rs:1822-1840 | P6-3 |
| O7 | P2 | SyncConflictDialog 失败仅 console.error，单条解决不触发 onResolved | SyncConflictDialog.tsx:379-419 | P6-5 |
| O8 | P2 | 备份层 last_sync_time 实为"任意设备最后上传时间"，UI 误导 | sync_manager.rs:194-200 | P6-5 |

---

## 3. 核心设计决策

以下决策是本方案的骨架。每条含：决策、理由、否决的替代方案。

### D1：以"按设备单调序号 + 按设备消费游标"替代单一时间水位线（修 C1/C2/C4/C5/C6、部分 C3/C9）

**决策**：
1. 变更文件 key 升级为 `data_governance/changes/{device_id}/{seq:012}-{version_ts}-{nonce}.json.zst`，其中 `seq` 是该设备在该远端实例上的**单调递增上传序号**；`version_ts` 保留秒级时间戳仅用于展示与 prune 的时间参考。
2. seq 的分配自愈式确定：上传前对自己的 `changes/{device_id}/` 目录取已存在的最大 seq（同步流程本来就要 list changes），`seq = max(cloud_max_seq, local_cached_seq) + 1`。该目录只有本设备写入，无并发问题；若 list 截断导致重复 seq，key 中的 nonce 保证不覆盖，消费端把同 seq 的多个文件全部应用（幂等回放保证安全）。
3. 每台设备本地维护 `consume_cursor(instance_id, uploader_device_id) -> last_applied_seq`，并在自己的设备 manifest 中发布两个向量：`published_max_seq`（自己已发布的最大序号）与 `cursors`（对每个其他设备已消费到的序号）。
4. 下载逻辑改为：对每个远端设备目录，下载并按 seq 顺序应用 `seq > cursor` 的文件；**游标只在该 seq 文件的全部变更在所有目标库事务提交（或永久性失败已检疫，见 D5）后才推进，且必须连续推进**（缺号即停在缺口前）。
5. 缺号仲裁：若缺失的 seq ≤ 该设备 manifest 的 `published_max_seq`，且不在快照覆盖范围（D3）内 → 判定为 prune 断层或文件丢失，报错并引导走快照引导流程；若 > published_max_seq → 视为尚未发布，正常等待。解密/解析失败的文件等同缺号：**游标停在它之前**，错误对用户可见（INV-1、INV-5），其他设备的目录互不影响。
6. `is_own_change_file` 回声过滤保留（自己目录不消费），但见 D6 恢复流程的设备轮换。

**理由**：根因是把两个不可比的时钟域（上传方墙钟、本机墙钟）当作同一版本空间。任何"安全回看窗口"式补丁都只能缩小而不能消除丢失窗口，且无法解决解密失败/列表截断后的永久跳过。按设备 seq + 连续游标使"哪些变更已消费"成为精确事实而非时钟推断，同时让缺口检测变成精确的逐设备判定（修 C5 的三个缺陷），dedupe 退化为防御措施（重复 seq 幂等吸收，修 C4），毫秒归一化问题消失（修 C6）。

**否决的替代方案**：(a) 水位线减安全窗口 + 幂等重放——窗口外仍丢失，解密失败仍永久跳过，每轮重复下载窗口内全部文件；(b) 持久化"已处理文件 key 集合"——集合无限增长，且无法检测"该存在但看不见"的文件（截断/最终一致），缺口语义仍缺失。

### D2：sync_version 语义拆分

**决策**：`__change_log.sync_version` 仅保留"本条变更是否已上传"的语义（0=pending，非 0=已上传批次标记，仍写本机时间仅作诊断）。**下载消费进度完全由 D1 的游标承载**，`get_database_sync_state().data_version` 不再参与下载过滤，仅用于 manifest 展示与分叉检测。echo 抑制写 sync_version 的行为保留（它的作用是防止回放被再次上传，与消费进度解耦后无害）。

**理由**：现状一个字段混了"已上传水位"“已消费水位”“echo 标记"三种语义，是 C1 的放大器。拆分后各自语义单一，restore 基线重置也只需处理上传侧。

### D3：按库全量快照 + 引导流程（修 C9、C3、为 prune 提供安全下界）

**决策**：
1. 新增云端对象 `data_governance/snapshots/{db}/{snapshot_ts}-{device_id}-{nonce}.json.zst`：内容为该库全部 RowSync 表的完整行导出（含软删行与 deleted_at）、schema_version、以及**生成时刻的游标向量**（对每个设备目录已包含到的 seq）。经 DSBK 加密通道。
2. 生成时机：双向/上传同步成功收尾时，若云端最新快照早于 7 天（或不存在），且本设备的游标向量不落后于所有设备 manifest 中的 published_max_seq 超过阈值，则生成并上传。多设备竞争生成无害（保留最新 2 份，旧的 prune）。
3. 新设备/断层设备引导：下载最新快照 → 在单事务内按 LWW 应用为基线 → 游标向量直接采用快照内嵌值 → 之后走增量。`since=0 且无快照且 changes 已裁剪` → 返回明确错误（不再静默放行，修 C9）。
4. prune 规则改为：设备只删除**自己目录**中 `seq ≤ min(所有活跃设备 manifest 对本设备的 cursor)` 且已被最新快照覆盖的文件。"活跃"= manifest 更新时间在 30 天内；不活跃设备被排除，但它回归后会因缺口仲裁（D1.5）走快照引导，不会静默缺数据。

**理由**：被动对象存储上 changes 是唯一数据载体却按时间裁剪，是结构性矛盾；快照是唯一能同时解决新设备引导、prune 安全下界、深度落后设备追赶的机制。成本可控：快照按库生成、压缩加密，频率低。

### D4：LWW 统一比较器与确定性 tie-break；HLC 退役（修 M3/M13/M23）

**决策**：
1. 新建唯一比较函数 `canonical_lww_key(updated_at_value, device_id) -> (millis: i64, counter: u32, device_id: &str)`：支持 RFC3339、`YYYY-MM-DD HH:MM:SS`（空格分隔）、整数秒/毫秒；HLC 串若遇到则取其 millis+counter。比较顺序：millis → counter → device_id 字典序 → 内容哈希（终极平局裁决）。**所有** LWW 判定点（should_skip_stale_update、conflict_resolver 的 INSERT/UPDATE/DELETE 分支、should_apply_change_by_strategy、compare_timestamps、DELETE 漂移门）一律改用此函数，删除三套自相矛盾的本地实现；2 秒"容差"语义删除（tie-break 已确定性）。
2. **HLC 不接入写路径，hlc.rs 退役**：保留 `MAX_DRIFT_MS` 漂移防御常量与 HLC 串解析（迁移进比较器，用于防御性兼容），删除 HlcClock/tick/receive/compare_hlc_strings 及 mod.rs 中三处 HLC fast-path 分支；模块文档中删除虚假防护声明。
3. 变更应用顺序不再依赖时间戳正确性（D1 已按 seq 排序），墙钟仅作 LWW 偏好信号 + device_id 兜底，满足 INV-4。

**理由**：两轮核查证实生产数据中不存在 HLC 串（从未有写入方），混排风险当前是理论性的，但三处矛盾分支是真实雷区。真正接入 HLC 需改造全部业务写路径与触发器（触发器用 `datetime('now')`），改造面与回归风险远大于收益；统一比较器 + device_id tie-break 即可满足 INV-2 的确定性要求。

**否决的替代方案**：全面接入 HLC——需要在每个业务写入点（数百处 SQL）替换时间戳生成，且 HLC 状态持久化、重启恢复、多连接并发都要新建基础设施；在 LWW 偏好信号这个用途上，墙钟+tie-break 的行为差异仅出现在时钟偏差期间的并发写，且结果仍收敛（只是赢家选择略不同），不值得该成本。

### D5：检疫机制 + 作用域 FK 校验（修 M10/M11/M8 毒丸形态）

**决策**：
1. 每库新增表：
   ```sql
   CREATE TABLE IF NOT EXISTS __sync_quarantine (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       source_device_id TEXT NOT NULL,
       source_seq INTEGER NOT NULL,
       table_name TEXT NOT NULL,
       record_id TEXT NOT NULL,
       operation TEXT NOT NULL,
       payload_json TEXT,            -- 原始变更全文
       error TEXT NOT NULL,
       attempts INTEGER NOT NULL DEFAULT 1,
       first_seen TEXT NOT NULL DEFAULT (datetime('now')),
       last_attempt TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE(source_device_id, source_seq, table_name, record_id, operation)
   );
   ```
2. 应用循环改为逐条 SAVEPOINT：错误分类为 **永久性**（payload 结构错误、主键不一致、别名环、合并未命中、FK 父缺失且父已检疫）→ 写入检疫表 + ROLLBACK TO 该条 SAVEPOINT + 继续；**暂时性**（SQLITE_BUSY、IO、磁盘满）→ 整批回滚、游标不推进、下轮重试。游标推进规则：该 seq 的全部变更"已提交 ∪ 已检疫"即可推进（检疫即"显式可见的未应用"，满足 INV-1）。
3. FK 校验改为作用域化：事务开始前对**本批将触碰的表**执行 `PRAGMA foreign_key_check(<table>)` 记录存量违规集合；提交前再次执行并求差集，仅对**新增违规**处理——定位到引入违规的变更（按违规行 rowid/表回查本批 applied 列表），将这些变更 ROLLBACK TO 各自 SAVEPOINT 并检疫，其余正常提交。存量违规只告警一次（计入诊断），不阻塞同步。
4. 应用连接保持 `foreign_keys=OFF` 不变（避免改变既有写行为），删除无效的 `defer_foreign_keys` 调用；防线即上述作用域校验。
5. 别名防环（M8）：`insert_alias` 写入前对 canonical 端执行路径压缩（解析到最终 canonical 再落表），插入后做一次环检测，检出则放弃该别名并把关联变更检疫而非整批 Err；`resolve_alias` 遇存量环（旧数据）降级为返回原 record_id + 检疫告警。
6. UI/命令：新增 `data_governance_list_quarantine` / `retry_quarantine` / `discard_quarantine` 命令与设置页入口；同步结果中报告检疫计数（INV-5）。

**理由**：被动存储上坏数据不会自愈，all-or-nothing 必然演化为永久卡死；检疫是把"毒丸"从流程阻断器降级为显式待办。SAVEPOINT 粒度回滚保留了单库事务的崩溃原子性（外层事务仍在），同时允许逐条隔离。

### D6：恢复（restore）后设备身份轮换（修 C3）

**决策**：从备份 ZIP 恢复成功后：(1) 生成新 device_id（旧 id 归档进本地状态，旧 `.device_id` 文件重写）；(2) 重置上传序号与全部消费游标为 0；(3) 在旧 device 的 manifest 写入 `superseded_by: <new_id>` 标记后不再更新它。效果：本机以新身份重新消费云端**包括旧自己目录在内**的全部变更（配合快照引导避免全量重扫），备份点之后本机上传的变更经由"旧设备目录"自然找回；旧目录按 D3.4 的不活跃策略最终被 prune。`reset_sync_baseline_after_restore` 的业务表 sync_version 重置逻辑保留。

**理由**：恢复后的设备在逻辑上就是一台"内容回到过去的新设备"，身份轮换让所有既有机制（游标、快照、prune）自然覆盖该场景，无需为"include_own_changes_once"开特例分支。

### D7：合并语义收敛化改造（修 M1/M2/M14/M21/M22）

**决策**：
1. **合并门控**：字段级合并仅在"本地该记录存在未同步修改"（`__change_log WHERE table=? AND record_id=? AND sync_version=0` 非空，批前一次性查成 HashSet）时执行；否则远端值直写（经 LWW 门）。门控判定从 conflict guard 的 resolve_one 结果直接传入 apply_single_record（新增参数），非 guard 路径同样查询该 HashSet。
2. **策略表 v2**（唯一数据源原则：picklist 由策略表派生，删除 mod.rs 手工 picklist；classification.conflict_policy 与策略表用同一注册数据生成，加 CI 一致性断言）：
   - 保留且修正：`TagSetUnion`（真集合语义，BTreeSet 排序输出，可交换 ✓）；`BooleanOr` 修复数值布尔（`as_bool().or_else(|| as_i64().map(|v| v != 0))`）。
   - `CounterMax`（ref_count）：**改为本地派生**。`blobs.ref_count`/`resources.ref_count` 等引用计数从引用方表重算（应用批结束后对受影响 hash 执行 `UPDATE blobs SET ref_count = (SELECT COUNT(*) FROM ...)`），退出合并体系。
   - `SumValue` 删除：`todo_items.estimated_pomodoros/completed_pomodoros` 改 `MaxValue`。
   - `StringConcat`、`EaseFactorAverage`、`JsonDeepMerge`、`JsonArrayUnion`（用于有序列 block_ids_json/attachments_json/variants_json/options_json/images_json 等）一律改 **行级 LWW + 冲突留痕**（败方进 `__sync_conflicts`，用户可在冲突面板找回）。仅对确证为无序集合语义的列（如 mistake_ids、tags 类）保留 Union。
3. 合并结果**不回写 change log 放大**：门控后合并只发生在真并发场景，合并写入使用 suppress 通道（与 echo 抑制相同机制），合并结果作为本地未同步修改的一部分随下轮上传一次，不产生回声循环。

**理由**：INV-2 要求每个合并策略满足交换律与幂等性；现有 9 个策略中仅 TagSetUnion 达标。"自动保留一切"的设计哲学与"删除必须能传播"（INV-3）直接冲突，必须收敛为"默认 LWW + 少数确证可交换的集合/布尔合并 + 冲突留痕兜底"。

### D8：传输层契约 v2（修 F 组全部 + INV-6）

**决策**：
1. `CloudStorage` trait 契约显式化（文档 + 契约测试双重约束）：
   - `list(prefix)` **必须递归**返回前缀下全部对象；返回类型改为 `ListOutcome { files: Vec<FileInfo>, truncated: bool }`；实现无法保证完整时必须置 truncated 或返回 Err，禁止静默部分列表。调用方规则：下载/缺口检测路径遇 truncated → 报错中止（游标不动）；prune 路径遇 truncated → 跳过本轮 prune。
   - `get/stat` 仅在**确证不存在**（HTTP 404、FTP 550、S3 NoSuchKey）时返回 `Ok(None)`，其余一律 Err（使重试生效）。
   - `put/put_file` 要求"完整可见或不可见"：FTP 改为 STOR 到 `{name}.tmp-{nonce}` 后 RNFR/RNTO；WebDAV/S3 维持现状（PUT 原子）。put 后以 `stat()` 回验 size（S3 可用 ETag），不符则报错重传。
   - 读路径（get/list/stat）禁止任何写副作用（FTP 移除 ensure_directory，目录不存在按 not-found 语义处理）。
2. **FTP 后端重写**：优先 MLSD（一次取回类型+mtime，消除 N+1 MDTM 与手写解析），不支持时回退 LIST + `suppaftp::list::File::from_str`（POSIX/DOS 双格式）；list 递归下钻子目录；流式上传下载（`retr_as_stream` 直写文件 / `put_with_stream`）；错误映射区分 550；移除读路径 MKD。在重写合并前，**发布渠道临时隐藏 FTP 选项或标注"实验性，勿用于生产数据"**。
3. WebDAV：PROPFIND 增加 `<d:resourcetype/>`，目录判定以 collection 为准、尾斜杠为回退；750 上限与 MAX_DIRS 命中→置 truncated；reqwest 升级到 0.12（workspace 已有 0.12.28 传递依赖）以使用 `read_timeout(60s)` + `connect_timeout(30s)` 替代 300s 总超时（升级受阻则回退方案：按已知 content-length 动态计算 per-request timeout）。
4. S3：`TimeoutConfig`（connect 30s / operation_attempt 120s，put_file 大对象按 multipart 分块各自计时）。
5. root 归一化：`config.rs` 先 `trim_matches('/')` 再判空回退默认；`extract_relative_key` 对空 root 特判；增加单测覆盖 `"/"`、`""`、`"a/b/"`。
6. **远端实例绑定**（F12）：首次同步向远端写 `data_governance/instance.json`（uuid，不加密）；本地所有同步状态（游标、上传 seq、快照记录）按 instance_id 命名空间存储；同步时 instance 不匹配本地记录 → 提示用户"远端已更换"，引导选择"绑定新远端（走快照引导）"或取消，绝不静默续用旧游标。
7. 重试策略归一：传输层后端各自保留 3 次内建重试，上层 `retry_async` 仅保留在无后端重试的路径；v2 进度路径 put_file 补齐与非进度路径一致的重试（C8）。

### D9：共享云端对象全部去 RMW（修 T2、备份层 manifest）

**决策**：所有"多设备读-改-写同一文件"的对象改为**按设备分文件、读取时合并**：
- 墓碑：`data_governance/tombstones/{blobs|assets|workspaces}/{device_id}.json`（append-only，含 deleted_at/device_id），读取 = list 目录 + 合并全部设备文件。drain 队列一次性批量合并后单次上传（修 500 条=1000 次请求）。
- 备份层 `manifest.json`：改为 `manifests/{device_id}.json`（沿用 data_governance 已验证的模式），`list_versions` 读取时合并；保留旧 manifest.json 只读兼容一个过渡版本。
- 设备 manifest（已按设备）不变。
**理由**：被动存储无 CAS，条件写仅 S3 部分支持；按设备分文件让"单写者"成为结构性事实，从根上消灭 lost update，且与 D1/D3 的 per-device 模型同构。

### D10：文件级同步 v2（修 T3/T4/T5/T6/T7、INV-3）

**决策**：
1. **方向参数**：`sync_workspace_databases/sync_vfs_blobs*/sync_asset_directories*` 全部增加 `direction: SyncDirection`；Download 跳过上传分支，Upload 跳过下载分支。
2. **删除捕获**：新增 `__asset_deletion_queue`（vfs 库，schema 同 blob 队列，key=资产相对 key）与 `__workspace_deletion_queue`（chat_v2 库，key=ws_id）；业务删除路径接线：`WorkspaceDatabase::delete_database`（chat_v2/workspace/database.rs:350）、`notes_delete_asset` 等资产删除命令（盘点 `file_manager` 全部 delete_* 调用点）删除成功后入队。drain 时写 per-device 墓碑（D9）。
3. **墓碑生命周期**（T1 一并在此落地）：apply 时按 `deleted_at` 与本地状态比较——blob：本地 blobs 行的 `updated_at/created_at` 晚于 deleted_at（即删除后重建）则**不删**，并写"复活墓碑撤销"条目到本设备墓碑文件；资产/ws 同理用文件 mtime 或重建记录。每设备记录"已应用到各墓碑文件的水位"（本地状态），避免每轮全量重放（T7）。墓碑保留期 90 天，prune 接线（生成快照时一并清理过期墓碑）；离线超过保留期的设备回归时强制走快照引导（D3），杜绝过期复活。`store_blob_with_conn` 重新入库时 `DELETE FROM __blob_deletion_queue WHERE hash=?`。
4. **ws 库 LWW 与一致快照**：上传判定改为 `local_sha != cloud_sha && local_mtime/updated_at > cloud_entry.updated_at`（WorkspaceEntry.updated_at 终于被读取）；不满足则下载云端版本（本地有未同步修改时下载前先把本地版本另存 `ws_{id}.conflict-{device}-{ts}.db` 并在 UI 提示）。上传前用 `VACUUM INTO` 生成只读一致快照再算 sha/上传，消除 PASSIVE checkpoint 撕裂。资产文件加 mtime 比较同理。
5. **顺序修正**（T6）：上传方向编排改为 blob/资产文件先、行级变更包与 manifest 后（引用先于被引用方可见的窗口消除）；下载方向维持行级先、文件后（缺文件状态由 blob 下载循环自愈，UI 显示"附件同步中"）。文件级失败时对应方向 `success=false`（不再仅 warning，INV-5）。

### D11：应用层 SQL 与类型保真（修 M5/M6/M7/M9/M15/M20）

**决策**：
1. **NULL 传播**（M5）：enrich 阶段产出的 payload 本就是全行快照，`build_insert_parts` 不再跳过 null（UPDATE/INSERT 均带 null 列）；UPSERT 模板对 payload 中**出现的列**改为 `SET col = excluded.col`（去 COALESCE），payload 中不存在的列继续保留本地值。`records_semantically_equal_for_sync` 同步修正（null 列参与比较）。`deleted_at` 复活特例保留。
2. **顺序保持**（M6）：排序键改为"依赖 rank 仅在**不同记录间**生效；同 (table, record_id) 的多条变更严格按源顺序（uploader seq, change_log_id）"。给 `blobs` 表补 `deleted_at` 列（migration）转软删；为所有无 deleted_at 的表（迁移后应为零）的硬删路径加 changed_at vs updated_at 的 LWW 门作为防御。
3. **files 冲突目标**（M7）：apply 前先按主键 id 探测本地行：id 已存在 → `ON CONFLICT(id)`（允许更新 sha256 等业务键）；id 不存在但业务键命中另一行 → 走别名/合并路径。fallback 的 protected_cols 仅保护主键，不再保护业务键。
4. **同批业务键碰撞**（M9）：`build_download_id_aliases` 维护"本批待插入行的业务键内存索引"，与 DB 查询合并查找；fallback 合并成功后调用 `insert_alias(remote_id → 存活行 id)`。applied_keys 统一记录 remapped id（M19）。
5. **类型保真**（M15）：BLOB 列编码为 `{"$dsblob": "<base64>"}` 包装对象（应用端识别还原）；u64 超 i64::MAX 报错检疫而非 f64 降级；TEXT 列禁止 parse-reserialize（canonicalize 仅用于比较，写回用原串）；等价比较前做 bool/0-1 归一化。
6. **表白名单收紧**（M20）：`ensure_table_allowed_and_exists` 校验 `(database, table)` 必须在 classification registry 中且 category==RowSync，否则检疫。

---

## 4. 数据结构与格式变更汇总

### 4.1 本地新增/变更

| 对象 | 位置 | 内容 |
|---|---|---|
| `sync_state.db`（新） | app_data/deep-student/sync/ | 表 `upload_seq(instance_id, last_seq)`、`consume_cursor(instance_id, uploader_device_id, last_seq, updated_at)`、`tombstone_watermark(instance_id, source_device_id, kind, last_applied_offset)`、`instance_binding(instance_id, provider, endpoint_hint, bound_at)`、`device_history(old_device_id, rotated_at, reason)` |
| `__sync_quarantine`（新，每业务库） | 4 库 migration | 见 D5 |
| `__asset_deletion_queue`（新） | vfs migration | hash→key 版的删除队列 |
| `__workspace_deletion_queue`（新） | chat_v2 migration | ws_id 删除队列 |
| `blobs.deleted_at`（新列） | vfs migration | blobs 转软删 |
| `__change_log` | 不变 | sync_version 语义收窄（D2），schema 不动 |

### 4.2 云端布局（格式 v3）

```
data_governance/
  format.json                      # 新：{"format_version": 3, "min_client": "..."}（明文）
  instance.json                    # 新：{"instance_id": "<uuid>"}（明文）
  manifests/{device_id}.json       # 扩展字段：published_max_seq, cursors{device→seq},
                                   #          format_version, superseded_by?
  changes/{device_id}/{seq:012}-{ts}-{nonce}.json.zst   # key 升级（含 seq）
  snapshots/{db}/{ts}-{device}-{nonce}.json.zst         # 新：全量快照（D3）
  tombstones/{blobs|assets|workspaces}/{device_id}.json # 改：按设备分文件（D9）
  blobs/... assets/... workspaces/...                   # 不变
manifests/{device_id}.json         # 备份层：manifest.json → 按设备分文件（D9）
backups/{version_id}.zip           # 不变
```

`SyncChangesPayload.format_version` 升至 3，新增字段 `source_seq: u64`、`source_device_id`（顶层已有 device_id，保留）。

### 4.3 设备 manifest 扩展（示意）

```json
{
  "device_id": "mac-a1b2c3d4",
  "format_version": 3,
  "published_max_seq": 1042,
  "cursors": { "win-9f8e7d6c": 877, "mac-old0001": 1290 },
  "databases": { "vfs": { "schema_version": 26, "data_version": ..., "checksum": "..." } },
  "snapshot_seen": { "vfs": "2026-06-08T...-mac-a1b2..." },
  "superseded_by": null,
  "created_at": "..."
}
```

---

## 5. 分阶段实施计划

> 依赖关系：P0 独立可先发 → P1（传输契约）→ P2（协议 v3，依赖 P1 的 ListOutcome/truncated）→ P3（应用层，依赖 P2 的检疫-游标联动）→ P4（合并语义，依赖 P3 的门控参数通道）→ P5（墓碑/文件级，依赖 P1、P2 的 per-device 模式与 instance 绑定）→ P6（可观测性收尾）→ P7（全局验收）。
> P3 与 P4、P5 之间可部分并行；矩阵中每个缺陷的修复项编号见 §2。

### Phase 0 —— 止血（低风险点修，可立即单独发布）

| # | 修复项 | 内容与位置 | 验收标准（AC） |
|---|--------|-----------|----------------|
| P0-1 | FTP 临时降级 | 设置页 FTP 选项标注"实验性，存在已知数据风险"，新建同步配置默认隐藏（feature flag），存量 FTP 用户启动时弹一次告警 | 告警可见；flag 可控 |
| P0-2 | v2 路径补 prune gap 强检 | `execute_download_with_progress_v2` / `execute_bidirectional_with_progress_v2` 入口复制 commands_sync.rs:989-1007 的强制检查 | 单测：v2 路径在 gap 场景拒绝同步 |
| P0-3 | 同步结果诚实化（O1） | commands_sync.rs:2096-2099 仅 `exec_result.success && error_message.is_none()` 才 emit_completed，否则 emit 带 warning 的终态；SyncSettingsSection.tsx 消费 `runSyncWithProgress` 返回值，对齐 Dashboard 逻辑 | 集成测试：文件级失败时 UI 显示警告而非成功 |
| P0-4 | FTP 凭据链路（O2） | secure_store.rs `CloudStorageCredentials` 增加 `ftp_password` 字段；cloudStorageApi.ts 加载器加 ftp 分支；CloudStorageSection.tsx safeConfig 剥离 `ftp.password`；启动迁移：检测 localStorage 中存量明文 ftp 密码 → 写入安全存储 → 擦除 localStorage | localStorage 中无任何密码字段；FTP 保存/加载往返成功 |
| P0-5 | import 加锁（O3） | data_governance_import_sync_data 增加 check_maintenance_mode + BACKUP_GLOBAL_LIMITER（复用 806-818 模式） | 并发 import+sync 串行化测试 |
| P0-6 | S3 超时（F10） | s3.rs 增加 TimeoutConfig（connect 30s / attempt 120s） | 配置生效断言 |
| P0-7 | dedupe keep-last（C4） | mod.rs:1389-1403 改倒序去重再恢复顺序 | 单测："x=1→x=2→x=1" 序列终态 x=1 |
| P0-8 | 版本归一化（C6） | mod.rs:1219 比较与 1308 排序前统一 normalize_version_to_seconds | 单测：毫秒命名文件不重复下载、排序正确 |
| P0-9 | mark_synced 分批（C7） | mod.rs:1862-1890 与 commands_sync.rs:50-58 按 500 id/批，单事务包裹 | 单测：50k 条 pending 标记成功 |
| P0-10 | 上传回验与重试（C8） | v2 put_file 包 retry_async（与 1153-1163 一致）；put 后 stat 回验 size，不符报错不 mark | 注入截断上传的 mock 测试 |
| P0-11 | busy_timeout（M12） | 新建 `open_sync_connection(path)` helper（busy_timeout 5s），替换 commands_backup.rs / commands_sync.rs 全部 25 处 Connection::open | 并发写场景下应用不再立即 BUSY 失败 |
| P0-12 | root 归一化（F11） | config.rs:185-192 先 trim 再判空；webdav extract_relative_key 空 root 特判 | 单测：root 为 "/"、""、"a/" 时三后端 key 往返正确 |

### Phase 1 —— 传输层契约 v2（D8、D9 备份层）

| # | 修复项 | 内容 | AC |
|---|--------|------|----|
| P1-1 | FTP 重写（F1-F6） | 按 D8.2：MLSD 优先 + suppaftp 解析器回退、递归 list、temp+RNTO、流式传输、550 区分、移除读路径 MKD | FTP 契约测试全绿（见 P1-7） |
| P1-2 | WebDAV 整改（F7-F9） | resourcetype 目录判定；truncated 标志（750/MAX_DIRS）；reqwest 0.12 + read_timeout（或动态 per-request 超时回退方案） | 截断场景下载路径报错而非静默；2GB 文件慢速传输不被掐断（mock 限速测试） |
| P1-3 | S3 收尾 | （P0-6 已做超时）list 排序契约断言、multipart 路径回归 | 契约测试 |
| P1-4 | trait 契约 v2 | `list → ListOutcome{files, truncated}`；get/stat not-found 语义收紧；trait 文档写明递归/排序/原子契约；调用方按 D8.1 规则处理 truncated | 三后端契约测试统一断言 |
| P1-5 | 实例绑定（F12） | instance.json 写入/校验；本地状态按 instance 命名空间；不匹配时阻断 + 引导 | 换 root 后同步被阻断并提示；绑定新实例走引导 |
| P1-6 | 备份层去 RMW + 原子解密（T2 备份侧、F13、F14） | CloudSyncManager manifest 改 `manifests/{device_id}.json` 合并读取（旧文件只读兼容）；下载解密改临时文件+rename；加解密改 8MB 分块流式（DSBK2 容器，分块 AES-GCM，保留 DSBK 读取兼容） | 双设备并发上传备份互不丢版本条目；解密中断不损坏已下载密文；1GB 文件加解密峰值内存 < 64MB |
| P1-7 | 契约测试补全（F15） | docker compose 增加 FTP 服务（pure-ftpd/vsftpd）；FTP 全套契约测试；新增：list 递归性、truncated、root 边界、嵌套前缀、并发写分文件模型；CI 启用（去 #[ignore]，按 env 门控） | CI 中三后端契约测试全部运行并通过 |

### Phase 2 —— 同步协议 v3：seq + 游标 + 快照（D1/D2/D3/D6）

| # | 修复项 | 内容 | AC |
|---|--------|------|----|
| P2-1 | seq 与游标核心（C1/C2） | 实现 sync_state.db；build_change_key 带 seq；download_changes 重写为按设备按 seq 连续消费；游标推进与事务提交/检疫联动；manifest 扩展 published_max_seq/cursors；解析失败=缺号=游标停止+错误上浮 | 多设备模拟：时钟偏差 ±10min、上传与 list 并发交错、解密失败注入，零丢失（INV-1 断言）；解密失败后修正密码可恢复 |
| P2-2 | prune v2（C5） | prune 只删自己目录中 `seq ≤ min(活跃设备 cursors)` 且快照覆盖的文件；删除全局 30/90 天时间裁剪 | 模拟：设备离线 60 天回归，要么无损追赶要么显式要求快照引导，绝无静默缺失 |
| P2-3 | 快照机制（C9） | snapshots/{db} 生成（7 天周期、竞争无害、保留 2 份）、快照引导流程（新设备/断层/实例换绑共用）；since=0 无快照且有裁剪 → 显式错误 | 新设备从含 1 年历史（changes 已裁剪）的云端引导出完整数据 |
| P2-4 | 缺口仲裁与错误面（C2/C5） | published_max_seq 对照缺号判定；前后端错误码与文案（"云端文件缺失/无法解密，已停在安全点"） | 缺号场景 UI 呈现明确状态 |
| P2-5 | v1/v2 兼容消费 | 过渡期同时消费旧格式文件（无 seq 的 key 按 legacy 通道、以"一次性导入+记录已处理 key 集合（仅 legacy 文件，有限集）"处理）；format.json 写入与版本协商（见 §6） | 混合新旧客户端集群的迁移演练通过 |
| P2-6 | restore 设备轮换（C3） | 按 D6 实现；commands_restore.rs:671-686 处接入 | 演练：恢复一周前备份后，期间上传的 100 条记录全部找回 |

### Phase 3 —— 应用层一致性（D5/D11）

| # | 修复项 | 内容 | AC |
|---|--------|------|----|
| P3-1 | 检疫 + 作用域 FK（M10/M11） | 按 D5.1-D5.4：__sync_quarantine、逐条 SAVEPOINT、错误分类、FK 差集校验、检疫管理命令与 UI；填充 ApplyChangesResult.failures | 毒丸注入测试：单条坏变更不阻塞同批其余变更与游标；存量 FK 违规不阻塞同步；检疫面板可重试/丢弃 |
| P3-2 | 别名修复（M8/M9/M19） | 防环（路径压缩+检测+降级检疫）；同批业务键内存索引；fallback 后登记别名；applied_keys 用 remapped id | 单测：A→B→A 环、同批同业务键双 INSERT + 子表 FK，全部正确收敛 |
| P3-3 | 顺序与 DELETE（M6） | 同记录源顺序保持；blobs 加 deleted_at（migration + 触发器照常）；硬删路径 LWW 防御门 | 单测：同批"删除→重建"终态为重建；blobs 软删跨设备收敛 |
| P3-4 | NULL 传播（M5） | 按 D11.1 改 build_insert_parts 与 UPSERT 模板、等价比较 | 单测：置 NULL 跨设备传播；缺列 payload 不误清本地值 |
| P3-5 | files/业务键（M7） | 按 D11.3：id 优先探测、ON CONFLICT 目标动态化、fallback 不保护业务键 | 单测：同 id 换 sha256 传播；跨设备同 sha256 不同 id 合并 |
| P3-6 | 类型保真（M15） | $dsblob 包装、u64 检疫、TEXT 不重排、bool 归一化 | 全类型往返 proptest（snapshot→change→apply 逐字节一致） |
| P3-7 | 杂项（M17/M18） | apply_merge_to_database 加 SAVEPOINT 事务+错误返回（或删除+迁移调用方）；llm_usage legacy record_id 改 JSON-only + 模糊串检疫 | 对应单测 |
| P3-8 | 白名单收紧（M20） | 按 D11.6 对照 registry 校验 | 未注册表 payload 进检疫 |

### Phase 4 —— 合并与冲突语义（D4/D7）

| # | 修复项 | 内容 | AC |
|---|--------|------|----|
| P4-1 | 合并门控（M1） | 按 D7.1：pending HashSet 批前构建，传入 apply_single_record；非并发场景纯 LWW 直写 | 回归测试：单边删 tag/删图/SM-2 重置全网生效不复活 |
| P4-2 | 策略表 v2（M2/M14/M21/M22） | 按 D7.2：SumValue→Max、ref_count→本地派生、Concat/Average/DeepMerge/有序 Union→LWW+冲突留痕、BooleanOr 修 0/1、picklist 由策略表派生、classification 联动 + CI 一致性断言 | 每个保留策略的交换律/幂等性 proptest；删除策略的留痕断言 |
| P4-3 | 统一比较器与 tie-break（M3） | 按 D4.1：canonical_lww_key 替换全部 5 处判定点；删除 2s 容差分支 | 收敛性测试：同秒并发写在任意应用顺序下全设备同值 |
| P4-4 | HLC 退役（M13） | 按 D4.2：删除死代码与三处 fast-path，MAX_DRIFT_MS 迁入比较器，模块文档更新 | grep 无 HlcClock/tick/receive 残留；漂移防御回归测试 |
| P4-5 | 手动冲突解决（M4） | 走 force 通道 + 刷新 updated_at 为 now + 该条禁用字段合并 + 仅写入成功才标 resolved；决策经 change log 传播（suppress=false 保留） | 集成测试：keep_cloud 后 UI 立即反映且其他设备收敛到同值 |
| P4-6 | 死 API 清理（M23） | detect_record_conflicts/is_record_conflicting/sync() 标记 #[deprecated] 并对齐语义或删除（仅测试使用则迁移测试） | 编译期无生产引用 |

### Phase 5 —— 墓碑与文件级同步 v2（D9/D10）

| # | 修复项 | 内容 | AC |
|---|--------|------|----|
| P5-1 | 墓碑 v2（T1/T2/T7） | per-device 墓碑文件 + deleted_at 比较 + 复活撤销 + 应用水位 + 90 天 prune 接线 + 重导入清队列（blob_repo） | 回归：删除→重导入同 PDF 不被误删；并发双删不互吞；千条历史墓碑每轮仅增量应用 |
| P5-2 | 删除捕获（T3） | __asset_deletion_queue / __workspace_deletion_queue + 业务路径接线（database.rs:350、全部资产删除命令盘点）+ drain 批量化 | 删除图片/工作区跨设备生效不复活 |
| P5-3 | ws/资产 LWW（T4） | updated_at/mtime 比较 + 冲突另存提示 + VACUUM INTO 一致快照上传 | 双设备先后编辑 ws：新者胜、败方留 conflict 副本；上传中并发写不产生撕裂副本（校验下载后 integrity_check） |
| P5-4 | 方向参数（T5) | 三个文件级函数 + 编排调用点传 direction | 纯 Download 不产生任何 PUT（mock storage 断言） |
| P5-5 | 编排顺序（T6） | 上传方向：文件先、行级后；失败置 success=false | 模拟 blob 上传失败：对端不出现悬空行级记录（行级包未上传） |

### Phase 6 —— 可观测性与收尾

| # | 修复项 | 内容 | AC |
|---|--------|------|----|
| P6-1 | 进度单调化（O4） | 双向流程阶段区间重排（下载 10-40、应用 40-60、上传 60-85、文件级 85-99）；emitter 增加单调保护（percent 只增不减，阶段切换除外） | UI 进度无回退 |
| P6-2 | 文件级进度（O5） | blob/资产/ws 循环按文件数+字节发事件；>100MB 对象启用分块（S3 multipart 已有 / WebDAV 临时名+MOVE / FTP REST 续传，后两者作为增强项可后置） | GB 级首次同步进度连续可见 |
| P6-3 | 漂移防护（O6） | 启动/同步前校验：各库 sqlite_master 中 trg__change_log_* 覆盖表集 vs registry RowSync 集双向 diff，不一致→拒绝同步+告警；CI 测试对照 migrations；产品决策落地：review_history 改 RowSync 或 review_stats 改 LocalRuntime（二选一，消除矛盾）；settings/mindmap_versions 等 BackupOnly 分类经产品确认后在 classification.rs 注释中写明决策依据 | 新增未注册表时同步拒绝运行且提示明确 |
| P6-4 | checksum v2（M16） | 改为每表 `sha256(sorted (id, updated_at, deleted_at) 流)` 的分桶摘要；明确定位为漂移信号；比较口径用 canonical_lww_key | 注入单行内容篡改可被检出 |
| P6-5 | UI 杂项（O7/O8） | SyncConflictDialog 失败 toast + 单条 onResolved；备份层 last_sync_time 改本设备维度（本地记录） | 对应交互测试 |

### Phase 7 —— 全局验收与发布（见 §6、§7）

---

## 6. 兼容性与迁移

### 6.1 版本协商

- v3 客户端首次同步：读 `format.json`。不存在 → 写入 `{"format_version":3}` 并进入迁移模式；存在且 =3 → 正常；存在且 >3 → 拒绝同步提示升级客户端。
- **迁移模式**（每实例一次）：v3 客户端同时消费 legacy 格式文件（无 seq 的旧 key、旧 tombstones/*.json、旧 manifest.json），用"legacy 已处理 key 集合"（存 sync_state.db，有限集）保证不重复；消费完成后生成首份快照，此后 legacy 文件仅保留供未升级设备读取，90 天后由任一 v3 客户端归档删除。
- **旧客户端共存策略**：旧客户端看不懂新前缀（snapshots/、changes 内新 key 仍在原目录但旧客户端按时间水位线仍可读取——key 解析 `split('-')` 取首段会把 seq 当 version，数值远小于时间戳，旧客户端会**全部重复下载**，幂等回放吸收，不丢数据但低效）。因此：**发布说明明确要求所有设备在窗口期内升级**；v3 客户端检测到云端存在 30 天内活跃的 v2 manifest（无 format_version 字段）时，在 UI 持续提示"存在未升级设备"。
- 升级不可回滚到 v2 客户端（v2 看不见 v3 的 cursors/快照语义）。回滚预案见 §8。

### 6.2 本地迁移

- 新 migrations（每库）：__sync_quarantine、blobs.deleted_at、__asset_deletion_queue（vfs）、__workspace_deletion_queue（chat_v2）。全部 additive，可安全前滚。
- sync_state.db 初始化：首次 v3 同步时从现状推导——上传 seq 从云端自身目录 max+1 起；消费游标初始化为"对每设备目录当前可见的最大 seq"前提是先完成一次 legacy 全量消费（迁移模式保证）。
- localStorage FTP 密码迁移见 P0-4。

---

## 7. 测试计划

### 7.1 单元/回归（随各 Phase 落地）

§2 矩阵中每个缺陷 ID 至少一个针对性测试，命名 `regression_<id>_*`（如 `regression_c1_clock_skew_no_loss`）。现有 13 个 sync 测试文件继续全绿。

### 7.2 契约测试（P1-7）

三后端 × 统一断言集：递归 list、truncated 行为、not-found vs error、put 原子可见、put 回验、读路径无写副作用、中文/特殊字符 key、root 边界、排序契约。CI docker 化常态运行。

### 7.3 多设备模拟矩阵（新增 `sync_convergence_tests.rs`）

虚拟 N 设备（N∈{2,3,5}）共享 mock 存储，随机化：操作类型（增删改/置 NULL/删 tag/blob 增删/重导入/ws 编辑）、同步方向与次序、时钟偏差（±0/±2s/±10min）、注入故障（上传中断、列表截断、解密失败、毒丸 payload、进程杀死后恢复）。每轮结束做"全设备静默轮"后断言：

- **INV-1**：mock 存储中每个变更文件要么被全部设备消费，要么对应检疫/错误记录存在；
- **INV-2**：全部 RowSync 表逐行逐列一致（含 deleted_at）；
- **INV-3**：删除集合一致且重导入项存活。

用 proptest 跑收缩，固定种子回归。

### 7.4 全局验收（发布门槛）

1. 模拟矩阵 10k 轮零失败；
2. 迁移演练：v2 数据集（含历史毫秒文件、legacy v1 变更文件、旧墓碑、旧备份 manifest）→ v3 升级 → 双设备继续同步 7 个模拟天 → 收敛断言；
3. 三后端真实服务（含坚果云 750 上限复现环境、Windows IIS FTP）端到端各一轮；
4. restore 轮换、新设备快照引导、60 天离线回归三个剧本人工验收。

---

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 协议 v3 改动面大（download/upload/manifest/prune 全链路） | Phase 2 整体置于 feature flag `sync_protocol_v3` 后；flag 关闭时走旧路径（含 Phase 0 修复）；迁移模式幂等可重入 |
| reqwest 0.11→0.12 升级牵连其他模块 | 独立 PR；受阻则启用动态 per-request 超时回退方案（已在 P1-2 写明） |
| 检疫错误分类误判（把暂时性当永久性） | 分类保守化：仅白名单错误类型入检疫，未知错误一律按暂时性整批重试；检疫面板支持一键重试 |
| 合并策略收紧改变用户感知（原"自动合并"变冲突留痕） | 冲突面板入口前置 + 发布说明；TagSetUnion/BooleanOr 等高价值合并保留 |
| 旧客户端长期不升级 | format.json + UI 持续告警；文档明确共存语义（低效但不丢数据） |
| VACUUM INTO 对大 ws 库的耗时 | 仅在 sha 可能变化（文件 mtime 变动）时执行；后台执行带进度 |
| 回滚 | Phase 0/1 可独立回滚；Phase 2+ 发布后云端已是 v3 布局，回滚需指引用户"导出 ZIP → 清空远端 data_governance/ → 旧版本重新上传"，写入发布说明 |

---

## 附录 A：现状关键事实速查（两轮核查确认）

- 变更捕获：4 库全部 RowSync 表有无条件 INSERT/UPDATE/DELETE 触发器，仅写 (table, record_id, operation)，**不含列清单/old/new**；field_deltas_json 列存在但生产恒空（V20260524 加列，无写入方）。
- 当前无自动同步定时器，同步均为手动触发；前端两个入口（SyncSettingsSection 直连、Dashboard 带维护模式+gap 预检）。
- 应用路径 foreign_keys 全程 OFF；defer_foreign_keys 是空操作；foreign_key_check 是唯一且全库作用域的防线。
- ws_*.db（chat_v2 工作区）无 __change_log/触发器，故走整文件同步；8 张内表。
- blobs 是唯一无 deleted_at 的 RowSync 表。
- HLC（hlc.rs）零生产调用；生产数据中不存在 HLC 格式时间戳。
- 契约测试齐全但全部 #[ignore]，FTP 无任何契约测试。
- device_id：`{hostname}-{uuid8}`，存 `deep-student/.device_id`，与远端配置无绑定。
- 加密：DSBK 魔数容器，先压缩（zstd）后加密，明文/密文自动识别，密码错误显式报错。
- 两套 SyncManager 职责不同且均在用：cloud_storage::CloudSyncManager（ZIP 备份版本管理，manifest.json）与 data_governance::SyncManager（增量同步，data_governance/ 前缀），key 空间不重叠。
