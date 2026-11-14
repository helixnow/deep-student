# L20b sync-support 等价语料（WAVE0 v0，WP-065）

`sync-state.json` 按 `board/WAVE0-EQUIVALENCE.md` §3 v0 编写（domain / commands / scenarios / id / seed / steps / capture / normalize）：7 命令 / 24 场景 / 96 步，全部 `seed: "empty"`、`capture: {events: true, db: ["*"]}`、`normalize: []`。`expect: "error"` 只是注释，比对以 A（Tauri+Rust）实际结果为准。**这些场景尚未在 A 或 B 上运行，不计 C 级。**

本 lane 是服务型，没有自有 IPC（LANE.md）。`sync_state.db`（Rust `state.rs`）与墓碑事件序号只能经 L20 的外层同步命令触达，所以场景全部用前端真实 invoke 的现有正式命令，不新增测试命令，也不测私有函数。

## 命令、owner 与入口

| 命令 | owner | 前端调用点 | Rust 入口（注册 `src-tauri/src/lib.rs`） | 触达的本域状态 |
|---|---|---|---|---|
| `data_governance_mark_blob_deleted` | L20 | `src/api/dataGovernance.ts:1601`（仅开发者工具；VFS 自动入队不经此 IPC） | `src/data_governance/commands_sync.rs:4063-4097`；`dstu-sync/.../sync/mod.rs:12397-12423` | `tombstone.rs:353-407` `publish_events` → `state.rs:224-288` `tombstone_event_publish` |
| `data_governance_mark_asset_deleted` | L20 | `src/api/dataGovernance.ts:1617` | `commands_sync.rs:4105-4135`；`mod.rs:12455-12478` | 同上，`kind="assets"` |
| `data_governance_detect_prune_gap` | L20 | `dataGovernance.ts:1643`，调用方 `DataGovernanceDashboard.tsx:1489`、`SyncSettingsSection.tsx:267`、`syncStatusStore.ts:425` | `commands_sync.rs:5071-5143`；`mod.rs:1572-1620` | 远端有 `instance.json` 时 `state.rs:119-153` `bind_instance` + `cursors` |
| `data_governance_run_sync_with_progress` | L20 | `dataGovernance.ts:995`，调用方 `DataGovernanceDashboard.tsx:1504`、`SyncSettingsSection.tsx:276`、`syncStatusStore.ts:427`、`dataGovernance.ts:1050` | `commands_sync.rs:2859-…`；事件 `data-governance-sync-progress`（`src/types/dataGovernance.ts:792`） | `instance_binding`、`upload_seq`、`consume_cursor`、`tombstone_watermark`、`legacy_processed_key`（`mod.rs:1838-1874,2469-2558,2732-2958,3825-3830,10643`） |
| `data_governance_run_sync` | L20 | `dataGovernance.ts:869`（导出的 `runSync`，`src/` 内未找到 UI 调用方） | `commands_sync.rs:1586-…` | 同上，无进度事件 |
| `cloud_config_ssot_save` | F4（前置） | `src/utils/cloudStorageApi.ts:441`（`:591` 调用） | `src/cloud_config_commands.rs:10`；`dstu-sync/.../cloud_config_commands.rs:487-516` | 不触达；写 `settings` |
| `secure_save_cloud_credentials` | F4（前置） | `cloudStorageApi.ts:1077`（`:589` 调用） | `src/secure_store.rs:27` | 不触达；写安全存储 |

两条 F4 命令只作为前置步骤：`hydrate_cloud_config`（`dstu-sync/src/cloud_credentials.rs:127-150`）会**丢弃 IPC 传入的 `cloudConfig`**，按后端 SSOT 重建配置（无 SSOT 时为 `CloudStorageConfig::default()`），再从安全存储补密码。所以不先保存 SSOT 和凭据，任何命令都到不了 `sync_state.db`。这两条命令自身的分支归 F4 语料，本包不计它们的覆盖。

B 端对应：`host/plugins/sync/index.ts:77-86,213-214` 注册上述 5 条 L20 命令；`sync/src/run-sync.ts:68,133`、`prune-gap.ts:51`、`change-availability.ts:59`、`manifest-upload.ts:100` 经 `ctx.syncSupport.state` / `syncSupport.tombstones` 调用本 lane。

## 运行前提（交 X7 / WP-046 / X3）

1. **模拟 WebDAV 绑定**：场景里的 `${mock.webdav.endpoint}`、`${mock.webdav.endpointAlias}`、`${mock.webdav.username}`、`${mock.webdav.password}` 不是步骤引用，要由运行器替换成 WP-046 的确定性 WebDAV 服务（同一服务、同一份存储）。`endpoint` 用 `http://127.0.0.1:<port>/`，`endpointAlias` 用 `http://localhost:<port>/`：两者都算 loopback，允许 HTTP（`cloud_config_commands.rs:280-286,323-330`），但 `instance_binding_hint` 不同（`cloud_storage/webdav.rs:1065-1072`）。每个场景开始前远端要清空。服务没就绪时不运行这些场景，**不连真实云**。
2. **`sync_state.db` 不在数据空间内**：路径是 `<dataLocalDir>/deep-student/sync/sync_state.db`（`state.rs:22-29`；B 端 `host/platform/storage/api.ts:118`）。`db: ["*"]` 必须包含这个文件；`batch.mjs:21` 的 XDG 隔离要覆盖 `XDG_DATA_HOME`，否则 A 会写到真实用户目录，各场景之间也会串数据。
3. **远端对象**：墓碑事件和清单里的 `size`、`seq`、`relative_path` 存在模拟服务里，不在 SQLite 里。要比较大整数和墓碑顺序，WP-046 需要提供远端对象快照（key 排序 + 字节或 JSON）。没有快照时只能比较本地 `tombstone_event_publish`。
4. **大整数传输**：`18446744073709551615` / `18446744073709551616` / `9007199254740993` 这几个参数要原样传给 invoke。普通 `JSON.parse` 会把它们舍入成 double，那样比较的就是运行器的行为，不是命令的行为。
5. **安全存储**：`secure_save_cloud_credentials` 在 Linux 上走 keyring（`dstu-security/src/secure_store.rs:360-370`）。无头 Xvfb 下如果没有 Secret Service，A 会在前置步骤报错，凭据之后的所有分支都会失真。需要 F4/X7 确认 A 和 B 是同一种可用后端。
6. **规范化候选**（只是候选，没做 A1/A2 双录之前不生效）：`device_id`（每个实例随机，`commands_sync.rs:1197`）、`instance_id`（UUID，`mod.rs:1862`）、`operation_id`（含 `deleted_at` 的哈希）、`created_at` / `bound_at` / `updated_at`、进度事件的 `operation_id`。`seq`、行数、行顺序、`storageClasses`、NULL 都不在规范化之列。动态 ID 在返回值、事件和各表之间必须一致映射。

## 分支覆盖表

场景 id 省略前缀 `sync_support.`，`#n` 是步序号（从 0 起）。

### data_governance_mark_blob_deleted

| 分支 | Rust 位置 | 场景 |
|---|---|---|
| 无 SSOT：IPC 配置（带密码）被丢弃 → `创建云存储失败: 缺少 WebDAV 配置` | cloud_credentials.rs:100-107；cloud_storage/mod.rs:233-244 | `tombstone.blob.no_ssot_ignores_ipc_config`#0,#1 |
| 有 SSOT、无凭据 → `WebDAV 密码不能为空` | config.rs:338-340 | `tombstone.blob.ssot_without_password`#1 |
| 成功：每次调用新 `deleted_at` → 新 `operation_id` → 新 `seq`，同一 hash 重复删除也会新增一行；已有清单条目复用云端序号 | mod.rs:12405-12422；tombstone.rs:389-406；state.rs:240-288 | `tombstone.blob.publish_seq_order`#2-#4 |
| `relativePath` / `size` 为 `null`（Option None） | commands_sync.rs:4066-4067 | `publish_seq_order`#3 |
| `size` 为 0、2^53+1、u64::MAX | 同上 | `tombstone.blob.size_boundaries`#2-#4 |
| `size` 为 2^64、-1 → IPC 反序列化错误（不进入处理函数） | — | `size_boundaries`#5,#6 |
| 空 hash / 空 path（Rust 不做校验） | mod.rs:12405 | `tombstone.blob.empty_hash_and_path`#2,#3 |
| `E_DG_TOMBSTONE_LIMITER_BUSY` | commands_sync.rs:4037-4049 | 阻塞：需要并发；v0 只有串行步骤，不伪造锁冲突 |
| 加密策略 / 格式协商 / 列表截断 / 同一 operation_id 多个 seq / PUT 回读失败 | commands_sync.rs:67-80；mod.rs:1779；tombstone.rs:281-294,383-388 | 阻塞：需要 WP-046 能构造远端坏状态（未来 format.json、截断列表、冲突事件 key、回读不一致） |

### data_governance_mark_asset_deleted

| 分支 | Rust 位置 | 场景 |
|---|---|---|
| 无 SSOT → 缺少 WebDAV 配置 | 同 blob | `tombstone.asset.no_ssot`#0 |
| 有 SSOT、无凭据 | 同 blob | `tombstone.asset.ssot_without_password`#1 |
| 成功；`kind` 不同，序号与 blob 各自独立（`UNIQUE(instance_id, device_id, kind, seq)`） | state.rs:90-99,256-269 | `tombstone.asset.publish_seq_per_kind`#2-#5 |
| `size` 为 `null`、u64::MAX；空 key | commands_sync.rs:4108 | `publish_seq_per_kind`#5-#7 |
| limiter busy / 远端坏状态 | 同 blob | 阻塞（同上） |

### data_governance_detect_prune_gap

| 分支 | Rust 位置 | 场景 |
|---|---|---|
| 无 SSOT → `创建云存储失败: …` | commands_sync.rs:5079,5106-5108 | `prune_gap.no_ssot`#0 |
| 有 SSOT、无凭据 | 同上 | `prune_gap.ssot_without_password`#1 |
| 远端无 `instance.json`：不写 `instance_binding`，`instance_id: null` | mod.rs:1576-1606 | `prune_gap.empty_remote_no_binding`#2,#3 |
| 远端已有实例：首次绑定 / 重复调用不改写 `bound_at` | state.rs:126-151 | `prune_gap.binds_after_upload`#3,#4 |
| 绑定不匹配 `云同步实例绑定不匹配…`（同一远端，换 endpoint 别名） | state.rs:135-141 | `prune_gap.instance_binding_mismatch`#4；换回原 endpoint 后恢复 #6 |
| 维护模式 | commands.rs:106-113 | 阻塞：空种子下不可达，需要 X3 种子或进行中的备份 |
| `instance.json` 损坏 / 缺 `instance_id`、format 不兼容 | mod.rs:1581-1592 | 阻塞：WP-046 远端坏状态 |

### data_governance_run_sync / data_governance_run_sync_with_progress

两条命令的场景成对设置（`run_sync.*` / `run_sync_progress.*`）。progress 版本在每个提前返回点都会先发 `failed` 事件（`commands_sync.rs:2880-2905,2914-2930`），所以 `capture.events` 必须开着。

| 分支 | Rust 位置 | 场景 |
|---|---|---|
| 无效方向（`sideways`、空串） | 1603-1608 / 2879-2889 | `*.invalid_direction`#0,#1 |
| 方向不区分大小写、`both` 是别名（之后走到下一个分支：未配置） | mod.rs:10117-10123 | `*.invalid_direction`#2,#3 |
| 无效策略（区分大小写、空串） | 1611-1622 / 2892-2905 | `*.invalid_strategy`#0,#1 |
| `strategy: null` 默认 `keep_latest`；`manual` 合法 | 同上 | `*.invalid_strategy`#2,#3 |
| `cloudConfig` 缺省 / `null` → `Cloud storage is not configured…`，不写审计 | 1624-1643 / 2908-2930 | `*.not_configured`#0,#1 |
| 传入 `cloudConfig` 但无 SSOT → 写审计后 `创建云存储失败`（progress 版会先发 preparing / detecting） | 1650-1684 / 2938-2995 | `*.not_configured`#2 |
| SSOT 无凭据：`cloudConfig` 缺省 → `CredentialsUnavailable`；传入 → 创建存储失败 | cloud_config_commands.rs:547-556 | `*.ssot_without_password`#1,#2 |
| 成功 upload / download / bidirectional：`instance_binding`、`upload_seq`，单设备下的 cursor 与水位 | mod.rs:1838-1874,2469-2558,3825-3830 | `*.upload_download_bidirectional`#2-#4 |
| 墓碑之后再做双向同步，再查 gap | mod.rs:10643；commands_sync.rs:928,980 | `run_sync_progress.after_tombstones`#4-#6 |
| 绑定不匹配阻止上传 | state.rs:135-141 | `prune_gap.instance_binding_mismatch`#5（run_sync） |
| 全局 limiter busy | 1680-1683 / 2965-2974 | 阻塞：需要并发 |
| 维护模式、SSOT 损坏 | commands.rs:106；cloud_config_commands.rs:536-543 | 阻塞：X3 种子（设置表里的坏 SSOT、进行中的维护租约） |

## 剩余与阻塞

- **跨设备的恢复游标推进**（`consume_cursor` 大于 0、`legacy_processed_key`、`tombstone_watermark` 对他设备事件推进、序号缺口检测 `has_gap: true`）：需要远端已有另一台设备发布的变更和墓碑。X3/WP-046 需要提供"第二设备远端种子"（A 端产生，再导入模拟服务）。本包不伪造远端事件。
- **`record_device_rotation`**（恢复激活，`commands_restore.rs:144-196`）和 **`reset_default_after_local_purge`**（启动清理，`src/lib.rs:1015-1024`；标记由 `data_governance_purge_all_data` 写入，`commands_backup.rs:3054`）：两者都只在应用启动时执行，v0 没有"重启"步骤。需要 X3 的历史种子（带恢复激活标记或清理标记的数据目录）加上运行器支持启动，才能比较 `device_history` 和各表被清空的结果。
- **S06**（`tombstone_sequence_waits_for_writer_before_reading`，`state.rs:597-664`）继续 pending。同一次 `sqlite3_step` 的 busy 回调无法用串行 invoke 观察，任何 timeout 或 JS 重试都不当作等价证据。
- 本域其余服务（note_history、pomodoro_counts、conflict_resolver、墓碑 GC 合并）走 `run_sync` 下载/应用链路，要靠业务种子和第二设备远端，留给后续包；X2 去重时这 5 条 L20 命令以本文件为准，WP-077 的本地配置/导入导出命令不在此列。
