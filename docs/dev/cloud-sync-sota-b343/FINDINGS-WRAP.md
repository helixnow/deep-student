# FINDINGS-WRAP — 云同步收尾只读复审

- 复审模型：`gpt-5.6-sol-xhigh-fast`。
- 基线：`origin/cursor/cloud-sync-sota-b343` @ `d746da2044b390f8f2369e9206111fa2a025a842`；独立 worktree `/tmp/wrap-review-wt`。
- 范围：云同步、整包备份、恢复、E2EE 与最近 R10–R12 合入；不改业务代码。
- 方法：逐行静态复核关键写入/下载/恢复路径，核对历史 FINDINGS/FIX-QUEUE 与当前 GitHub 状态。本文行号均以 `d746da20` 为准。
- 验证边界：该 HEAD 的 [CI run 32707422525](https://github.com/helixnow/deep-student/actions/runs/32707422525) 在复审时仍为 `queued`，此前连续 run 多为被后续推送取消；因此本文不把“测试文件存在”冒充“完整 CI 已绿”。

## 0. 结论

1. **仍开 P0：0。** 本轮重点复核的四类事故——丢数据、明文降级、半包当成功、错密码损坏——当前均有 fail-closed 或原子提交防线，未发现可复现的 P0 回归。
2. **仍开 P1 代码缺陷：0。** FINDINGS-R11 的唯一 P1（`repo_check` DSBK v2 头偏移）已由 R12 修正为 SSOT 常量，并改用真实密文 fixture。
3. **仍开 P2/产品差距存在。** 主要是旧 v1 标记升级信任边界、冲突快速路径的事务外预判、文件名有损/长度未钳制，以及本文单列的增量去重、原地轮换、跨设备租约和 Android 真机手册。
4. **总判定：生产放量 `NO-GO`；进入后续集成/CI `GO`。** `NO-GO` 的直接理由是该 HEAD 尚无完整绿灯，且常规记录级同步的跨设备租约与 Android 真机闭环仍未交付。增量去重、原地轮换属于明确未达的 SOTA 能力，不应对外宣称已经具备，但它们本身不是本轮 P0。

## 1. 四类 P0 复核

| 类别 | 判定 | 当前代码证据 |
|---|---|---|
| 丢数据 | **未见仍开 P0** | 清单列表截断直接停同步，不把漏列当删除（`src-tauri/src/data_governance/sync/mod.rs:1700-1707`）；云备份先发布已裁剪 manifest、再删除旧对象，失败最多留孤儿，不会留下“清单可见但对象已删”的恢复点（`src-tauri/src/cloud_storage/sync_manager.rs:798-817`）；策略选择 Cloud 覆盖/删除本地行之前先留可回退快照，快照失败即拒绝覆盖（`src-tauri/src/data_governance/sync/conflict_resolver.rs:359-367`、`:450-458`）。 |
| 明文降级 | **未见仍开 P0** | 两个记录级上传入口都在写任何对象前走带密码校验子的策略门（`src-tauri/src/data_governance/commands_sync.rs:1640-1649`、`:2812-2826`）；标记损坏按存在处理，标记被删时本机“曾加密”记忆仍拒绝明文上传（`src-tauri/src/cloud_storage/sync_manager.rs:470-502`、`:611-632`）；记录 payload 与文件级对象在本端启用 E2EE 后均拒收无 DSBK/无 `cipher_sha256` 的明文（`src-tauri/src/data_governance/sync/mod.rs:865-900`、`:9426-9454`）。 |
| 半包当成功 | **未见仍开 P0** | WebDAV 在临时文件上核对实际字节数与 PROPFIND 声明、校验 SHA256 后才 persist（`src-tauri/src/cloud_storage/webdav.rs:935-1004`）；S3 同样在临时文件上核对字节数/校验和后才 persist（`src-tauri/src/cloud_storage/s3.rs:363-438`）；FTP 数据流 EOF 后强制 `downloaded == SIZE`，再校验并 persist（`src-tauri/src/cloud_storage/ftp.rs:429-470`、`:1182-1207`）；云 ZIP 续传完成后另做整文件 SHA256，失败删除断点，不交给恢复链（`src-tauri/src/cloud_storage/sync_manager.rs:889-936`）。 |
| 错密码损坏 | **未见仍开 P0** | 云 ZIP 上传在加密和写 `backups/` 前校验/登记密码校验子（`src-tauri/src/cloud_storage/mod.rs:282-316`）；错密码、损坏标记、未知 KDF 均上传前失败（`src-tauri/src/cloud_storage/sync_manager.rs:532-608`）；文件级下载只解密到同目录临时文件，AEAD 与明文哈希都通过后才替换目标（`src-tauri/src/data_governance/sync/mod.rs:9476-9509`）；ZIP 错密码只作用于临时明文并返回错误（`src-tauri/src/data_governance/backup/zip_export.rs:1434-1452`），完整恢复还必须过清单兼容、可整槽恢复和资产完整性三道门（`src-tauri/src/data_governance/commands_restore.rs:447-476`）。 |

补充：R12 已把巡检解析与真实容器布局收敛到同一事实源：`DSBK_V2_HEADER_LEN=44`、chunk 偏移 `[40..44)`、GCM tag 16（`src-tauri/src/crypto/backup_crypto.rs:68-91`）。因此 FINDINGS-R11 的 P1 假阳性不再开放。

## 2. 仍开 P1 / P2

### P1

**未发现仍开的 P1 级代码缺陷。** 这不等于可发布：完整 CI 未绿是发布门禁状态，不降格成“已验证”。

### P2

| ID | 仍开项 | 证据与影响 |
|---|---|---|
| P2-1 | 旧 v1 加密标记升级仍信任第一台带密码设备 | v1 无校验子时直接以当前密码生成 v2 校验子并覆盖标记（`src-tauri/src/cloud_storage/sync_manager.rs:583-600`）。已有解锁指南与日志，但未在升级前试解一个既有备份，也未把升级事件暴露到 UI。 |
| P2-2 | 冲突“结果已等于当前值”快速路径仍在事务外判断业务行 | `already_in_desired_state` 在 `BEGIN IMMEDIATE` 前计算（`src-tauri/src/data_governance/commands_sync.rs:4527-4541`），事务内只重验冲突 generation（`:4543-4567`），不重读业务行。影响是竞争窗口下可能把冲突标成已解决，业务数据本身不被该快速路径改写，故维持 P2。普通写回路径已经在事务内重读并快照（`:4624-4661`）。 |
| P2-3 | 文件名仍是有损净化，且段/总路径长度未钳制 | 非法字符统一替换 `_`、尾点/空格被删除，无法从云 key 无损还原原名；函数也没有长度边界（`src-tauri/src/data_governance/sync/asset_filenames.rs:47-95`）。现有冲突提示降低覆盖风险，但 rclone 档可逆映射和旧 key 迁移尚未合入。 |
| P2-4 | 常规同步只有进程内互斥，没有跨设备 sync-target 租约 | 命令侧 `BACKUP_GLOBAL_LIMITER` 只串行本进程任务（`src-tauri/src/data_governance/commands_sync.rs:1621-1627`、`:2774-2785`）；当前生产源码没有 `E_SYNC_LEASE_HELD` 后端实现。`ROUND-11.md:26` 的 R11-lease 任务仍未合入。远端格式兼容租约和恢复切槽租约不是同一件事，不能冒充常规上传窗口互斥。 |
| P2-5 | Android 真机/模拟器操作手册未合入 | `ROUND-11.md:30` 要求 WebDAV 配置→同步→恢复→重启核对单、SAF 审计与 S3 体积评估；当前目录没有 android2 手册，`README.md:83` 仍把 android2 标为在飞。宿主机测试不能替代 ContentResolver、真实 `app.restart()` 与设备存储压力验证。 |
| P2-6 | 平台/加密错误仍依赖字符串正则映射 | FIX-QUEUE 已明确 FTP/S3 与 E2EE 映射尚无统一稳定错误码（`docs/dev/cloud-sync-sota-b343/FIX-QUEUE.md:139-143`）。这主要影响本地化和错误分类稳定性，不改变后端 fail-closed 语义。 |

## 3. 诚实未达

### 3.1 增量去重：未达

整包云备份仍把本地 ZIP 作为单一对象完整上传：`put_file(&remote_key, zip_path, ...)`（`src-tauri/src/cloud_storage/sync_manager.rs:728-755`）。文件级 blob 有内容寻址，但不能等价为整包备份的 CDC/块级增量。当前目录也没有计划中的 `DELTA-R11.md`。结论：**未实现增量链、块复用、增量 GC 与加密去重泄漏取舍。**

### 3.2 原地密钥轮换：未达

生产标记仍为单校验子的 v2；新密码写旧目录会在上传前被拒绝。`KEY-ROTATION-R11.md:8-14` 明确当前方案是“换新目录 + 全量重传”，`:92-124` 的 v3 双校验子/中断恢复仅为草案。结论：**没有同目录原地轮换，也没有轮换向导实现；现状安全但操作成本高。**

### 3.3 常规 sync-target 租约：未合

当前有本机全局操作 guard、恢复 A/B 切槽租约和格式兼容租约，但没有覆盖常规多设备上传窗口的远端 TTL 锁。指定基线未合入 R11-lease，生产源码也无后端 `E_SYNC_LEASE_HELD`。结论：**并发同版本客户端仍依赖 per-device 对象布局、幂等和冲突机制收敛，不具备 Joplin 式 target 写租约。**

### 3.4 Android2 手册：未合

R09/R10 已有宿主机契约与 Android 壳层测试，但当前文档目录没有真机/模拟器逐步核对单。结论：**不能把“有宿主测试”表述成“Android 真机闭环已验收”。**

## 4. Go / No-Go

- **安全 P0 门：GO。** 本轮指定四类 P0 未见重开。
- **合入本收尾文档、继续跑 CI/收剩余分支：GO。**
- **面向生产放量或宣称“云同步 SOTA 收尾完成”：NO-GO。**

解除 `NO-GO` 的最小条件：

1. `d746da20` 或其后继整合 HEAD 跑出一次完整 CI 绿灯，不再用 queued/cancelled 代替验证；
2. 合入并验证常规 sync-target 租约（双设备并发、TTL 回收、崩溃残锁、格式门槛叠加）；
3. 合入 Android2 手册并至少完成一次真实 WebDAV 配置→同步→恢复→重启核对，记录设备/API/结果；
4. 对外文案继续明确“整包备份无块级增量去重、改密码需换目录全量重传”，直到对应能力真正落地。

## 5. 收尾合入后的状态回写（`b0450bdb`，父代理）

本节不改写上面基于 `d746da20` 的原始复审正文，只标注其后继已交付、因而过时的条目：

| 原条目 | 现状态 | 证据 |
|---|---|---|
| §2 P2-4 / §3.3 常规 sync-target 租约未合 | **已合** | `cloud_storage/sync_lease.rs` + 两入口接线；占用码 `E_SYNC_LEASE_HELD`；`sync_r11_lease.rs` 7 例通过 |
| §2 P2-5 / §3.4 Android2 手册未合 | **手册已合，真机未签** | [ANDROID-HANDBOOK-R11.md](./ANDROID-HANDBOOK-R11.md)；8 项 SAF/重启缺口仍开 |
| §2 P2-6 平台错误靠正则 | **机制已关（正则仅兜底）** | 平台：`E_FTP_UNSUPPORTED_ON_ANDROID` / `E_S3_UNSUPPORTED_IN_BUILD`；短密码 / stored：`E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT` / `E_STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED`；E2EE：`E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED` / `E_SYNC_E2EE_WRONG_PASSWORD` / `E_SYNC_E2EE_MARKER_CORRUPTED` / `E_SYNC_E2EE_PASSWORD_REQUIRED`。前端先认 code，旧中文诊断仍兜底。整槽拒绝便携包：`E_BACKUP_PARTIAL_ARCHIVE_NOT_SLOTABLE`；云端/本地 ZIP 导入后先看 `recovery_kind` / `restorable`，部分归档不再启动 `restoreBackup`。云端恢复在切槽前补齐 `checkDiskSpaceForRestore`，与 Dashboard / 本地 ZIP 同一条预检。云端备份/恢复期间进入全局维护模式；切槽成功后 `requireMaintenanceRestart` 防止 finally 撤掉写屏障。上传成功后若导出 stats 标明便携归档，额外警告换机整槽会被拒绝。云端版本清单写入可选 `recoveryKind`；历史列表对便携包禁用整槽恢复，旧清单缺字段仍走导入后门禁。状态卡最新版本同样标种类，「从云端恢复最新版本」走确认框且便携包禁用。确认框写出目标版本号，并按已知/未知 `recoveryKind` 分述。确认框 / 重试 / `performRestore` 对已知便携包在下载前拒绝。`recoveryKind` 上传后经 list/status 回读，新旧清单混排可反序列化。新整包对象名改为 22 位随机 ID，设备清单改短哈希文件名（旧 `manifests/<device_id>.json` 读取合并、写入后迁移），新标记 `createdByDevice` 只登记短哈希。记录级 `changes/` / `v4/shards/` / `data_governance/manifests/` 新写入改短哈希路径，旧明文 `device_id` 目录双读并流；本机短哈希清单/分片不得并进「其他设备」。tombstone 每设备清单与 `tombstone-events` 前缀同样改短哈希并双读旧名，水位按内容完整 `device_id`。文件级 `file_manifests/` 与快照新写入改为 UUID 对象名，不再编码时间或设备；旧明文/短哈希目录仍按整前缀合并 |
| §2 P2-3 文件名有损 | **已合（names2）** | rclone 风格可逆映射 + 旧 `_` key 双查找；段 255 / 整 key 240 fail-closed |
| §3.1 增量去重 | **调研+codec+inventory+lease+upload+restore+GC 已合，生产未接线** | `delta_format.rs` / `delta_inventory.rs` / `backup_lease.rs` / `delta_upload.rs` / `delta_restore.rs` / `delta_gc.rs`；整 ZIP 仍整对象 PUT；不能宣称增量/去重/CDC |
| §2 P2-1 v1 升级信任 | **已关（wrap-v1trust）** | 升级臂先试解最新备份；空仓仍允许第一台带密码设备认领；失败不写标记。验收 `sync_r12_v1_marker_trust.rs` |
| §2 P2-2 冲突快速路径 | **已关（wrap-conflict）** | 快速路径在 `BEGIN IMMEDIATE` 内用 `get_record_data` 重读业务行并重算 already-desired，不匹配即拒绝；锁定测 `sync_r10_protocol_locks.rs` P2-3 用例 + 行为验收 `sync_r12_conflict_fast_path.rs` |
| §4 条件 1 完整 CI 绿灯 | **仍开** | 后继 HEAD CI 多为 pending/queued |
| §4 条件 2 租约 | **已合** | 见上 |
| §4 条件 3 Android 真机核对 | **仍开** | 手册有、真机签字无 |

**生产放量仍 NO-GO。** 当前最短剩余：完整 CI 绿灯、Android 真机签字、整包增量传输接线（integration；积木本身不算实现）。P2-1/P2-2 已合。
