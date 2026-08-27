# 0824 Wave2-D（cloud/data）台账

> 只追加。不标 Goal complete。第 1–7 轮「已验证」只写静态证据。
> 第 1 轮骨架曾按 MERGE-PLAN 误映射 P1–P12；本节起以任务卡原文为权威编号。

## 0. 缺档与身份

- `docs/0824-quality-review/*` 在 tip `061b4815` **不存在**。本台账以任务卡 P1–P12 + MERGE-PLAN Step 22/23 + `/tmp/0824-wave2-r1-reports/01–09` 代码实证重建。
- 基线：`origin/cursor/0824-cde6` @ `061b4815`（Step 23 文档）。fetch 后远端未前进。
- 独立枝：`cursor/0824-wave2-cloud-data-a875`（空提交 `bfbe1951`）
- Draft PR：https://github.com/helixnow/deep-student/pull/348 （base = `cursor/0824-cde6`）
- 不整支合回官方 0824。禁止反向合 main。禁止 merge 隔离/预演/leftover 枝。

## 1. P1–P12 归组（任务卡原文）

| # | 标题 | 主文件 | Step22 宣称 | R1 代码实证 | 计划轮 | 数据不可逆 |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | 测试连接先发布后测试；失败不回滚 | `CloudStorageSection.tsx` `doTestConnection`；`cloud_config_commands.rs`；`secure_store.rs:2055-2076` | 未修（cross-cutting FAIL） | **确认 FAIL**：saveCredentials→saveCloudConfigSsot→checkConnection，失败只改 UI；写入即发布（07 报告） | R2 | 中（坏配置变正式 SSOT） |
| P2 | auto-sync 只在设置页挂载 | `syncStatusStore.ts:510-512`；`SyncSettingsSection.tsx:124`；`SyncTab.tsx:173` | 未修 | **确认**：全仓仅这两处调用；App 无接线；rehydrate 不 start（07） | R2 | 中（该排程不排程） |
| P3 | E2EE marker 并发认领无 CAS | `sync_manager.rs:566-847` | 未修 | **确认**：盲 PUT+回读；空仓两设备不同口令可同时认领成功；`backup_lease.rs` 零生产接线（01） | R4 | **高**（口令分叉/孤儿密文） |
| P4 | 内存 GET 无字节预算 | `webdav.rs:1219-1254`；`s3.rs:797-832`；`traits.rs` `get()` | 未修 | **确认**：trait 无预算；控制对象走无界 `get()`；数据对象走 `get_file`（02） | R4 | 中（OOM / 坏控制对象） |
| P5 | 复读坏写无恢复协议 | tombstone / per-device manifest / `.tmp` | 未修 | **确认**：三类坏写 fail-closed 且无自动收敛；manifest 回读失败保留 `.tmp` 但无人消费；`get_manifest` 一坏全失败（01） | R4 | **高**（同步永久卡死） |
| P6 | 手动下载防降级不对称 | `cloud_storage/mod.rs:503-557`（`cloud_sync_download`） | 未修 | **确认不拒**：只看头 4 字节，不读 marker；marker 在 + 明文对象仍成功（01） | R4 | **高**（加密链被明文替换） |
| P7 | 持久域未消费（vfs-governance 阻断 #2） | `commands_restore.rs`；`DomainRestorePlan` | Step22 只修密钥事务，**未修本条** | **确认**：主命令接 `restore_crypto_keys_from_manifest_transactional`；`restore_audit_db_from_manifest` 生产零调用；`persistent/` 被跳过；webview_settings/custom_grading_modes 恢复即删除；无未消费断言；assets 下 UntrustedExecutable 被整槽自动落盘（05） | R3 | **高**（域丢失/不可信技能落盘） |
| P8 | 稀疏 VFS init 不补索引/FTS/视图 | `coordinator.rs` `apply_vfs_init_missing_tables`；`migration/vfs.rs:56-223` | 未修（两加法本身必须保留） | **确认**：只抽 `CREATE TABLE IF NOT EXISTS`，不补 `idx_folders_parent` / `questions_fts` / `trash_view`（06） | R3 | **高**（升级后库不可用或绕 verifier） |
| P9 | crypto journal 故障矩阵不足 | `crypto_publication.rs` | Step22 新增，仅正常路径+部分 crash | **部分**：三点 crash 已有单测；审计库在事务外 best-effort；缺非对称部分 rename / `remove_journal` 失败分支（03） | R7 写测试 | **高**（密钥/槽不一致） |
| P10 | notes.props 畸形静默 None | `vfs/repos/note_repo.rs:2164-2194` | 未修 | R1 未深读（越权于 VFS repo；本路只在 coordinator 加法侧相关） | R3 | 低–中 |
| P11 | 口令/导出打磨 | prove 全量、错密码、双实现导出、KDF、弱口令、EncryptedRootMemory | 部分（短口令放行已修） | prove 全量下载+整文件试解、明文落临时盘（03）；导出双实现仍在、加密分支无进度/取消（04）；skip 已修 manifest.json；EncryptedRootMemory 失败已暴露设置页（08） | R1 低风险子集已落；其余 R5 | 中–高 |
| P12 | 迁移与兼容 | V20260824 去重、change_log 传播、明文窗口、code-only 错误、backup-v2 裁决 | 去重+短口令已修 | 去重在 **mistakes** 库 SQL，fixture **确含碰撞对**（06/09）；同步传播契约未做 | R5 | **高**（迁移改库） |

## 2. Step 22 十一 pick 复核（09 报告）

结论：**11/11 语义在 tip 上仍在**；Step 22 **未跑**定向测试（MERGE-PLAN 已承认）。本会话保留二检权，不把「语义在」写成「已验证绿」。

| # | 落地 SHA | 组 | 内容 | 09 结论 | 本会话动作 |
| --- | --- | --- | --- | --- | --- |
| 1 | `1523c285` | backup #334 | sealed 续传必须输入密码 | 语义在（BackupTab + peek + resume 透传） | 不重做；R5 便携包误输口令前置仍开放 |
| 2 | `3a1b79bb` | backup #334 | 本地 ZIP 文案诚实化 | 语义在 | 不重做 |
| 3 | `87563bd4` | backup #339 | 清加密 ZIP 残留 | 语义在；`sealedBackupPasswordRequired` 故意保留 | 不重做 |
| 4 | `2f4e79e9` | restore #330 | 密钥随槽位切换一并提交 | 语义在（`publish_restore_keys_and_commit_cutover`） | 不重做；P7 域消费仍开放 |
| 5 | `2bc68277` | restore #340 | `crypto_publication.rs` crash-safe | 文件与 journal 路径在 | 不重做实现；R7 补故障矩阵源码 |
| 6 | `5c3cb512` | upgrade #343 | NULL-source 去重 | SQL+fixture 碰撞对在（mistakes 库，非 coordinator） | R5 再核 fixture 与 change_log 传播 |
| 7 | `2c56db91` | upgrade #343 | 存量短口令放行 | 语义在；冲突 2 组合解正确 | 不重做；红线：存量不收紧 |
| 8 | `de56f37f` | upgrade #343 | 云恢复短口令 | 语义在 | 不重做 |
| 9–11 | `31c0ea85` / `800f7121` / `bc2a655b` / `23eb0af6` | 测试收口 | 断言对齐 | 在；`performRestore` 不再要求短口令拒收 | 不重做 |

另核：Step 22 **未触碰** `coordinator.rs`。两加法仍在：

- `apply_vfs_init_missing_tables` 定义 `:2383` 生产 `:2280` 测试 `:5873`
- `pre_repair_vfs_v20260824_note_props` 定义 `:2345` 调用 `:2331` 测试 `:5388`

## 3. 第 1 轮落地（产品）

三件低风险速修（08，worktree → 本枝）：

1. EncryptedRootMemory 上次 remember 失败经 `SyncStatus.encryptionMemoryPersistFailure` + 稳定码 `E_SYNC_E2EE_MEMORY_PERSIST_FAILED` 暴露到 `CloudStorageSection`；失败仍不阻断云操作，也不假装已写入。
2. ZIP 续传 `skip_existing`：`manifest.json`（末段、大小写不敏感）与 `.db` 同级不可跳过；新增测试源码 `test_resumable_import_never_skips_manifest_json`（未执行）。
3. FTP `ensure_directory`：550/already exists 保持 debug，真实 MKDIR 失败升 warn。**函数仍对真实失败返回 `Ok(())`**（本轮只改日志，不改语义）。

## 4. 18 不变量本路静态自证（R1）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 13 WebDAV decode_path | 仍在 | `webdav.rs:597-601`，守卫 `2146-2153`（02） |
| 14 S3 normalize_endpoint | 仍在 | `s3.rs:85-120` + 行为单测（02） |
| 15 FTP 550/501 白名单 | 仍在 | `ftp.rs:273-287`，门在 `:278`，守卫 `1443-1450`（02） |
| coordinator 两加法 | 仍在 | 见 §2 行号；本轮产品 diff 未改该文件 |

## 5. 已验证 / 未验证

### 已验证（仅静态）

- tip `061b4815` fetch 后未前进；本枝由其拉出
- coordinator 两加法行号级仍在
- 不变量 13/14/15 仍在
- P1–P8 / P11 子集的 FAIL 形态有行号实证
- Step22 11 pick 语义仍在（未跑测试）
- 第 1 轮三件速修源码已落盘

### 未验证

- 未跑 typecheck / vite / cargo check / check-migrations / 任何测试
- 未做真云 / 真机 / 真实旧库
- P3–P8 产品修复未开工
- EncryptedRootMemory 失败态、manifest 不可跳过、FTP warn **未执行**
- 质量评审原文缺档

## 6. 越权只读记录

| 轮 | 文件 | 操作 | 理由 |
| --- | --- | --- | --- |
| R1 | `src-tauri/src/vfs/repos/note_repo.rs` | 未读 | P10 延至 R3；本轮未越权写 |
| R1 | `src/App.tsx` | 只读检索 | 确认 auto-sync 无挂载（07） |

## 7. 第 2 轮预告（配置事务 + auto-sync）

冻结设计（实施任务卡以此为准）：

- **草稿**：表单态，不写 active SSOT / active 凭据。
- **测试**：新命令 `cloud_config_test_connection_draft`，一次性草稿配置+凭据，**不改** active generation。
- **发布**：新命令 `cloud_config_publish`，凭据+配置单逻辑提交；失败保持旧 generation。
- **secure_store**：在既有 `cloud_storage_credentials` 上叠加 staged generation + active pointer；「空=保留」只作用于 publish 合并，不作用于 draft 测试。
- **auto-sync**：hydration 完成后由 App/服务层幂等 `ensureAutoSyncSchedulerStarted`；设置页不再是唯一启动点。
- 红灯测试源码（不跑）：「测试失败 SSOT 未变」「重启不进设置 timer 存在」。

## 8. 关键发现（给后续轮，非本轮修）

- P6 手动下载是**成功降级**而非「有防降级但不对称」——比任务卡描述更严重。
- P7 主编排把 `assets/workspaces/agents/**` 整槽落盘，与 UntrustedExecutable 拦截矛盾。
- EncryptedRootMemory 损坏文件 fail-closed 后下一次 `remember` 会空文件重建，丢掉其他 root 记忆（03；有单测锁住此行为）。
- prove 试解会把明文写到临时盘（03/P11）。
- FTP `ensure_directory` 吞错（02/08）；日志已可见，语义未改。

## 9. 第 2 轮落地（配置事务 + auto-sync）

产品在 worktree 组装后合入本枝。10×`claude-fable-5-thinking-high`。未跑编译/测试。

### 已落地

- 设计稿：`docs/dev/wave2-D-config-state-machine.md`、`docs/dev/wave2-D-config-sync-generation.md`
- `cloud_config_test_connection_draft`：请求凭据直填，不 hydrate、不写 SSOT/凭据、不 bump generation
- `cloud_config_publish`：snapshot SSOT → write_staged → save SSOT → commit_staged；失败 abort + 恢复 SSOT
- `secure_store` staged generation：active 键不变；staged + pointer；缺省 generation=0；短口令 preexisting 未收紧
- `cloud_config_ssot_clear`：先事务删凭据再删 SSOT，失败回滚凭据
- `CloudStorageSection`：测试只走 draft；保存走 publish；三态徽标
- App.tsx hydration 后 `ensureAutoSyncSchedulerStarted`；设置页调用保留为双保险
- 红灯测试源码：`CloudStorageSection.draft-test.test.tsx`、`autoSyncStore.bootstrap.test.ts`（未执行）
- `r09-ux-cloud-storage.test.tsx` / `cloudSyncPhase0.source.test.ts` 源码契约已对齐新路径

### 红线自证（R2 收轮）

- `apply_vfs_init_missing_tables` `:2383/:2280/:5873`
- `pre_repair_vfs_v20260824_note_props` `:2345/:2331/:5388`
- `coordinator.rs` 不在本轮 diff

### R2 欠账（给 R6 二检）

- 审阅员 08 在 03 落笔前审的是旧文件；03 已落地。staged 密文仍在 `.secure/*.enc`，会被 backup 整目录复制进 `crypto/.secure/`（未发布草稿口令可能进备份）。目录 fsync / 进程锁未做。
- publish 与多 IPC 前端原语的 generation 快照挂钩未落（07 文档建议 `expected_generation`）
- 迁移仍走专用两段写；未改走 publish 原语（09 建议 R6 再议）
- 一切动态验证仍未跑

## 10. 第 3 轮落地（恢复编排 + 稀疏库 + props）

10×`claude-fable-5-thinking-high`。未跑编译/测试。

### 已落地

- `backup/restore_plan.rs`：Complete 域消费 + 未消费断言；audit 走 `restore_audit_db_from_manifest`；webview_settings/custom_grading_modes 落到 restore_target；agents/user-skills → `.restore_pending_trust`（IsolatedPendingTrust）
- `commands_restore.rs`：cutover 后、complete 前消费+断言；资产过滤 UntrustedExecutable（G4）
- 稳定码：`E_RESTORE_DOMAIN_UNCONSUMED` / `E_RESTORE_DOMAIN_FAILED` / `E_RESTORE_UNTRUSTED_ISOLATED` + i18n
- coordinator **加法**：`apply_vfs_init_missing_schema_objects`（:2457），调用在 table backfill 之后（:2286）。两原加法仍在（定义 :2389 / :2351）
- 稀疏库测试源码（只跑 table backfill 应被 verifier 拒；两步回填后应过）未执行
- props：畸形告警+计数；共享键语法向量；设计稿 `wave2-D-note-props.md`
- 恢复矩阵集成测试源码 `restore_domain_plan_tests.rs` 未执行

### 红线自证（R3 收轮，行号已因加法漂移）

- `apply_vfs_init_missing_tables` 定义 `:2389` 生产 `:2280` 测试仍在
- `pre_repair_vfs_v20260824_note_props` 定义 `:2351` 调用 `:2337` 测试仍在
- 新函数是加法，未改两原函数签名
- 未 merge `2bfe7c31`

### R3 欠账

- `assets.rs` 函数级 trust 过滤未改（生产调用点已过滤）
- consume 失败发生在 cutover pending 之后，无撤销路径（挂 R6）
- 越权：`search_helpers.rs` / notes `parseTagQuery.test.ts` 为 P10 共享向量（只读对齐）；Dashboard/localize 为恢复码可见态
- 未跑任何测试

## 11. 第 4 轮落地（云端韧性）

10×`claude-fable-5-thinking-high`。未跑编译/测试。

### 已落地

- `get_bounded` + 三 provider 声明超限/累计超限/无长度 bounded buffer；三类回归源码未执行
- `verified_publish.rs`：PUT tmp → bounded 回读 → 最终键 → 再回读；无条件写不假装 CAS
- manifest 发布接线 + 坏对象 `.quarantine` + `.tmp` 收敛桥
- tombstone 直接命令纳入 `BACKUP_GLOBAL_LIMITER` try_acquire（`E_DG_TOMBSTONE_LIMITER_BUSY`）
- E2EE 认领改租约协议（`.encryption-marker.lease` TTL 60s）；空仓双口令不得双赢
- `cloud_sync_download`：marker 在 + 非 DSBK → `E_SYNC_E2EE_DOWNGRADE_REJECTED`
- 认领竞态 / 防降级测试源码未执行

### 红线自证

- coordinator 本轮零触碰；两加法 + schema_objects 仍在 `:2351/:2389/:2457`

### R4 欠账

- verified_publish 暂存键 `.tmp-<op>` 与 bad_object `.tmp` 后缀不完全统一（有桥）
- tombstone 云对象读写仍在 `tombstone.rs`，bounded GET 未接到该文件
- 防降级可能误伤「启用加密后仍列出的明文历史版本」——任务卡要求拒；R6 可加显式 opt-in
- 控制对象调用方仍有部分走 `get()` 默认 256MiB
- 未跑任何测试

## 12. 第 5 轮落地（文案收敛）

未跑编译/测试。coordinator 零触碰。

### 已落地

- code-only 第一批：`cloudStorageApi.codeFromDiagnosticText` 通用提取 `[E_...]` 前缀；
  `localizeCloudError` 新映射 `E_SYNC_E2EE_DOWNGRADE_REJECTED` / `E_SYNC_E2EE_CLAIM_CONFLICT`
  （经 `syncE2eeErrorMapping` 两个新 kind）/ `E_SYNC_BAD_OBJECT_FAIL_CLOSED` /
  `E_DG_TOMBSTONE_LIMITER_BUSY` + zh/en 8 个新 key
- 后端补码：`commands_backup.rs` `E_BACKUP_DIR_MISSING`（4 处）、
  `E_RESTORE_DISK_BUDGET_OVERFLOW`（3 处）、恢复目标卷不可用复用
  `E_BACKUP_ATOMIC_RESTORE_UNAVAILABLE`；`commands_zip.rs`
  `E_ZIP_EXPORT_TEMP_MISSING` / `E_ZIP_EXPORT_COPY_TARGET_FAILED`
- `syncE2eeErrorMapping.test.ts` 契约测试源码同步（新 kind / 新码 / e2ee_claim.rs 跨层），未执行
- 升级窗口文档 `wave2-D-upgrade-plaintext-window.md`（明文混布 T0–T4、防降级默认拒、opt-in 未做）

### R5 欠账

- 全仓仍有大量裸中文错误（commands_backup 同步/校验路径等），只收敛了第一批
- 历史版本列表无加密标识，明文版本恢复前无法预警（文档 §3.1）
- 未跑任何测试

## 13. 第 5 轮落地（prove 降本）

未跑编译/测试。zip_export / commands_zip / coordinator 零触碰。

### 已落地

- `backup_crypto.rs` 只加不改：`FirstChunkPlan` / `plan_first_chunk_trial` /
  `trial_decrypt_first_chunk` / `dsbk_first_chunk_speculative_prefix_len`——
  v2「头 + 首个密文块」内存试解（明文 zeroize 不落盘），KDF 上限仍统一走
  `derive_key` 第一步拦截；默认 Argon2 参数与上限常量一字未动
- `traits.rs` 新能力位 `supports_prefix_read` + `get_prefix`（默认 fail-closed，
  绝不整包冒充前缀）；WebDAV / S3 以 Range `bytes=0-N` 实现（起点错位
  fail-closed，服务端忽略 Range 时收满即断流）；FTP 保持默认 → 整文件回退
- `sync_manager.rs` `prove_password_against_existing_backups` 重构：
  首块快路径（错密码秒级失败）→ 失败回退次新版本再试一块 → v1 单块容器 /
  无前缀读取后端走整文件回退（错误码/文案与历史逐字一致）；明文 ZIP 判别
  只读 4 字节魔数
- 测试只写不跑：backup_crypto 8 件（计划/试解/final 判定/篡改/超限 KDF/
  截断前缀/投机长度）、sync_manager 6 件（计数存储断言零整包 get、次新回退、
  v1 整文件回退、非默认分块补读）、traits/s3 源码锁

### R5-prove 欠账

- FTP 无前缀读取（REST 只能给后缀）：仍整包下载 prove
- 次新回退语义：口令只需解开最新或次新之一即视为证明（换口令恰在一版前的
  混口令仓可能被旧口令认领；已在 doc 注释声明）
- 整文件回退路径的试解产物仍明文落临时盘（仅 v1 / 无能力后端）
- 未跑任何测试

## 13. 第 6 轮二检翻案落地

10×`claude-fable-5-thinking-high`。未跑编译/测试。

### 当轮补丁

- publish 空凭据护栏（generation 不得指向空）
- restore 切槽后失败诚实审计（不假装成功，不撤销 cutover）
- bad_object 认两代 tmp 名；控制对象 get_bounded
- 下载防降级：本机 EncryptedRootMemory 双门 + `allow_plaintext_history` 休眠 opt-in（默认拒）
- 弱口令稳定码不再降级为 SECURE_STORE_INTERNAL
- 租约过期回收 `delete_if_unchanged=false` fail-closed
- auto-sync start 防重测试源码

### 红线自证

- coordinator 两加法 `:2351/:2389` 未改
- KDF_MAX / DEFAULT_M_COST / DSBK 未收紧
- backup-v2 仍零生产接线

### R7 首位

- `restore_assets_with_progress` 函数本体无 trust 过滤（调用方已滤；钉函数本体的测试将红）
- P9 crypto journal 三点注入矩阵（写源码不跑）
- E2EE 租约 60s vs 90s 停滞倒挂（文档化未修）
