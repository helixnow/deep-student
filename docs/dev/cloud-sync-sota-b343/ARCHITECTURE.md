# 当前架构与数据面地图

调研截止：基于 `main` @ 本分支创建时的检出。后续轮次若 rebase，在本文件顶部追加日期。

## 1. 两套“同步”不要混谈

| 名称 | 传输物 | 入口 | 适用 |
|---|---|---|---|
| Cloud backup sync | 加密或明文 ZIP + `CloudManifest` / `BackupVersion` | `cloud_storage/mod.rs` 的 `cloud_sync_*` commands、`CloudSyncManager` | 整机换机、版本化云备份 |
| Record-level data governance sync | `__change_log` 变更包 + tombstone + 冲突行 | `data_governance/commands_sync.rs`、`sync/mod.rs` | 多设备增量合并（实验） |

前端「设置 → 数据治理」把两者放在同一「同步 / 备份」信息架构里。用户心智上容易把“备份到云端”和“双向同步”当成同一件事。这是 UI 审阅重点。

## 2. 被治理的数据库

启动健康组件（`StartupComponentHealth`）：`vfs`、`mistakes`、`chat_v2`、`llm_usage`、`audit`。

`vfs` 阻塞会连带把 `chat_v2`、`mistakes` 标为 dependency blocked。`llm_usage` 不在这条闭包里。

同步字段约定（`sync/mod.rs` 文档）：

```sql
device_id TEXT
local_version INTEGER DEFAULT 0
updated_at TEXT   -- 部分表实际是 INTEGER ms，解析函数已做兼容
deleted_at TEXT   -- tombstone
```

相关迁移散落在：

- `src-tauri/migrations/vfs/`
- `src-tauri/migrations/chat_v2/`
- `src-tauri/migrations/mistakes/`
- `src-tauri/migrations/llm_usage/`

宽表覆盖回归依赖 `dstu-test` 的 wide sync image（`sync-wide-chaos-deep-coverage-seed-0531`），不是单测能单独证明的。

## 3. 云存储抽象

`CloudStorage` trait（`traits.rs`）声明的 SOTA 能力：流式传输、分块、进度、SHA256、list 截断显式化。

实现：

- `webdav.rs`：reqwest + PROPFIND/MKCOL/PUT/GET；有分页上限告警与截断标记
- `s3.rs`：`cloud_storage_s3` feature；默认桌面开启，`mobile-slim` 未开
- `ftp.rs`：非 Android；实验性，UI 已警告数据一致性风险

`create_storage` 在 Android 上直接拒绝 FTP。S3 在未开 feature 时返回 configuration 错误。

## 4. 备份与恢复

- 本地备份：SQLite Backup API，分层 P0–P3，任务可恢复（`backup_job_manager`）
- ZIP 导出/导入：`commands_zip.rs`、`backup/zip_export.rs`
- 云上传：可选先流式加密到 `.dsbk` 再 `upload_with_progress`
- 云下载：读 4 字节魔数判断加密；无密码 / 错密码应失败，不得覆盖成本地明文损坏包
- 恢复：写入非活动 A/B 槽，重启后切换；恢复后应轮换/持久化 `device_id`（`sync_manager.rs` 的 `rotate_device_id_after_restore` 一族）

增量备份已下线，历史增量包只识别、拒恢复。

## 5. 前端面

- `BackupTab.tsx`：本地备份列表、分层、验证、导入导出、自动备份
- `SyncTab.tsx`：记录级同步方向、策略、冲突、隔离区、云存储配置入口
- `CloudStorageSection.tsx`：WebDAV / S3 / FTP 表单、明文协议警告、E2EE 密码
- `SyncQuarantinePanel.tsx` / `RecordConflictsPanel`
- 文案：`src/locales/{zh-CN,en-US}/{sync,cloudStorage,data}.json`
- 用户文档：`docs/user-guide/16-数据管理与云同步.md`

## 6. 已知历史生产教训（来自 E2E skill，本轮必须复核是否仍成立）

- 多等价远端包重复回放会放大 `__change_log`（359 → 718 → 1077）
- `conflicts=N` 必须与 UI 和 `__sync_conflicts` 对齐
- 同机 WebKit / 凭据路径可能串台，必须用隔离实例验证
- restore 依赖重启；只看 pending slot 或只看 active slot 都会误判
- WebDAV 列表截断当删除是数据丢失级风险
- `files -> blobs` 外键与 todo 排序曾在 wide-image 中真实失败

## 7. 测试资产

后端：`src-tauri/tests/sync_{comprehensive,pathological,provider_contract,real_schema,adversarial,scenarios,realistic,chaos,integration_deep,real_flow_smoke,weird,schema_coverage,regression,real_business_tables,proptest}*`

前端：`tests/vitest/data-governance/*`

E2E：`dstu-test/skills/deep-student-cloud-sync-e2e/`

本程序后续极端测试优先复用这些资产，而不是另起炉灶。

## 8. 记录级同步的 sync target 租约（R11）

常规 record-level sync 在远端 `data_governance/locks/sync-target/` 下获取目标租约。
上传、下载与双向同步都必须持有：下载成功后也会发布 cursor/manifest，因此并非
严格只读。租约只保护 record-level sync，不与 Cloud backup ZIP 的版本对象混用。

状态机：

```text
不存在
  │ 写入独立 contender（activation_committed=false, expires_at=now+TTL）
  ▼
pending ── 完整 LIST，以 (created_at, operation_id) 确定唯一赢家
  │ 赢家回写并回验 activation_committed=true
  ├───────────────────────────────┐
  ▼                               ▼
committed（后台续租）          loser（仅删自己的 contender，返回
  │                            E_SYNC_LEASE_HELD）
  │ 正常结束：按 operation_id 核对后删除
  │ 崩溃：对象残留，心跳停止
  ▼
不存在 ◄── expires_at 到期后由下一轮完整 LIST 回收 pending/committed
```

关键约束：

- `CloudStorage` 没有 CAS/conditional PUT，禁止把租约实现成多个设备覆盖同一个 key；
  每次操作用 UUID 独立对象，完整 LIST 后确定性选主。
- LIST 截断、租约读取失败或新鲜但损坏的租约一律 fail-closed；损坏租约只能在
  provider `last_modified + TTL` 后回收，避免既误删活锁又永久锁死。
- `remote format` 门槛先检查，未来格式在**零租约写入**状态下拒绝；通过后才允许
  写 contender。租约持有窗口覆盖 E2EE marker、文件对象、行变更、manifest 与 prune。
- 占用错误必须包含稳定 token `E_SYNC_LEASE_HELD`；自动同步据此静默记为
  `skipped_lease_held`，手动同步使用 `sync.errors.leaseHeld` 给出重试指引。
