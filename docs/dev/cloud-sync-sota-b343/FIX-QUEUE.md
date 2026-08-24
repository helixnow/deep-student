# 修复队列

认领规则：一个文件同一轮只给一个修复子代理。父代理不改业务逻辑。

## Round 02（已合入）

十路修复已全部合入 `cursor/cloud-sync-sota-b343`（含 webdav / backup / identity 中断重试），认领表留档：

| 代理 | 模型 | 范围 | 文件面（独占） |
|---|---|---|---|
| R02-cloud-ui | claude-fable-5-thinking-high | 清除配置确认、云恢复重启预告、失败重试、FTP/Android 入口诚实 | `CloudStorageSection.tsx`、`cloudStorage.json`（zh/en）、相关 vitest |
| R02-sync-ui | claude-fable-5-thinking-high | 库级冲突确认、实验徽章、术语 | `SyncTab.tsx`、`sync.json`（zh/en）、Dashboard 冲突调用处、相关 vitest |
| R02-webdav | claude-fable-5-thinking-high | 429/503/423 重试、探活改 PROPFIND、截断启发式去假阳性、目录缓存 | `cloud_storage/webdav.rs` + 其测试 |
| R02-ftp | claude-fable-5-thinking-high | `list_outcome` 诚实截断、not-found 收紧、数据通道超时 | `cloud_storage/ftp.rs` + 其测试 |
| R02-sync | claude-fable-5-thinking-high | 字段合并可达、无 tombstone DELETE LWW、慢钟不静默丢 | `data_governance/sync/mod.rs`、`field_merge.rs`、`conflict_resolver.rs` + sync 测试 |
| R02-e2ee | claude-fable-5-thinking-high | 云 root 加密标记，禁明文降级 | `cloud_storage/mod.rs`、`sync_manager.rs` 标记读写、`decode_payload` 拒明文 |
| R02-backup | claude-fable-5-thinking-high | 便携包诚实标签 + 可恢复闭环（加密全保真或 overlay 命令） | `backup/zip_export.rs`、`commands_zip.rs`、`backup_config.rs`、BackupTab 必要文案 |
| R02-identity | claude-fable-5-thinking-high | device_id 落到 app_data_dir；冲突计数双字段 | `sync_manager.rs` device_id、`commands_sync.rs` count API、前端读组数 |
| R02-tests | claude-fable-5-thinking-high | WebDAV 截断行为测、半配置凭据测、ZIP→导入→恢复暴露/锁定 P0-ZIP | 新测优先放 `src-tauri/tests/` 与 `tests/vitest/data-governance/` |
| R02-docs | claude-fable-5-thinking-high | 用户指南 Android/S3/FTP 事实、本目录进度 | `docs/user-guide/16-数据管理与云同步.md`、本目录 |

## Round 03（已完成）

独立只读复审完成，结论见 [FINDINGS-R03](./FINDINGS-R03.md)：R01 P0/P1 基本关闭，新增 2 P0 / 6 P1 / 2 P2 进入 R04。

## Round 04（已合入）

七路修复分支已合入 `cursor/cloud-sync-sota-b343`。实际合入的分支与计划认领表有出入（部分代理合枝交付），按实际留档：

| 合入分支 | 覆盖项 |
|---|---|
| `r04-sync-del` | P0-DEL-PARSE（DELETE fail-closed）、P1-DEL-LOSE（败方 DELETE 落冲突表）、P1-FOLD-POLICY、P2-FOLD-NOOP、P1-QCOUNT（计数器不回弹 `reset_progress`） |
| `r04-sync-e2ee` | P0-SYNC-E2EE（记录级 sync 尊重 `.encryption-marker`、`decode_payload` 拒明文）+ ACL 注册 |
| `r04-tombstone` | P1-TOMB-DOS（坏时钟 tombstone 单条隔离） |
| `r04-e2ee-clear` | P1-E2EE-CLEAR（显式停用 + 诚实占位符） |
| `r04-zip-ui` | P2-UI-PASS（导出/导入 E2EE ZIP 密码入口接线） |
| `r04-backup-defaults` | 新增范围：分层导出默认 core+important 带资产、`vfs_blobs` 覆盖警示 |
| `r04-tests` | WebDAV 1000 边界、错误密码槽位守卫、设备身份测试 + 测试套件修复 |

**未交付**：R04-android-ftp（P1-ANDROID-FTP-SSOT）未见合入分支，`cloud_config_commands.rs` 保存路径仍不拒 Android FTP，转入 Round 05 补做。

**遗留回写**：P2-UI-PASS 合入后，`docs/user-guide/16-数据管理与云同步.md` 的「密码入口后续版本开放」段已过时，转入 Round 05（R05-guide）。

## Round 05（已合入）

计划认领表见 git 历史。实际合入与计划有出入，按实际留档（详见 [FINDINGS-R05](./FINDINGS-R05.md)）：

| 合入分支 | 覆盖项 |
|---|---|
| `r05-android-ftp` | P1-ANDROID-FTP-SSOT：SSOT 保存/加载在 Android 拒 FTP，错误文案与 `create_storage` 对齐 |
| `r05-ftp-i18n` | 前端将 Android FTP 硬编码英文错误映射为 i18n |
| `r05-webdav-1k` | `check_connection` MKCOL 失败 + PROPFIND 404 不再假报成功；千级截断启发式收窄（与直接提交 `572f61da` 消解合并） |
| `r05-zip-resume` | 加密 ZIP 续传必须带密码；解封失败清理明文半成品 |
| `r05-tests` | 集成回归：慢钟败方 DELETE 落冲突表、不可解析 DELETE 隔离、有标记无密码拒记录级上传（含 fixture/隔离区重放修复直接提交） |

**未交付**：R05-guide（用户指南 16 回写）未见合入，「密码入口将在后续版本开放」段仍过时，转入 Round 06（R06-guide）。计划中的 clock / idempotent / provider / schema / mobile / restore 六路极端测试仅由 `r05-tests` 部分覆盖，剩余场景并入 R06 各测试代理。

## Round 06（已合入部分）

实际合入与计划认领表有出入。已合入：`r06-e2ee-honest` / `r06-del-resolve` / `r06-e2ee-verifier` / `r06-tests` / `r06-e2ee-copy` / `r06-debug-redact` / `r06-guide` / `r06-class-doc` / `r06-docs`。

**未交付转入 R07**：R06-review（无 FINDINGS-R06）、R06-asset-e2ee、R06-autosync、R06-asset-names、R06-android。

## Round 07（部分合入）

已合入远端枝：`r07-class-plans` / `r07-filename-tests` / `r07-autosync` / `r07-record-verifier` / `r07-file-e2ee` / `r07-webdav-409` / `r07-webdav-comment`。`sync.json` 自动同步文案由 `r07-autosync` 改过。

后派出的 R07 十路若回传只收增量。R08 认领见 [ROUND-08](./ROUND-08.md)。

| 代理 | 模型 | 范围 | 文件面（独占） |
|---|---|---|---|
| R08-review-e2ee | xhigh | 只读复审 file-e2ee | 只读，产出 FINDINGS-R08 |
| R08-sota | xhigh | SOTA 对照刷新 | 只读 |
| R08-autosync-review | xhigh | 自动同步复审 | 只读 |
| R08-names | high | 资产文件名净化 | `data_governance/sync/asset_filenames.rs` 新文件 + `sync_asset_directories` key 生成；不改 vfs_blobs / file-e2ee |
| R08-android | high | Android 换机/重启 | `src-tauri/tests/` 新文件 |
| R08-contract | high | Contract Gate | `sync_provider_contract_tests.rs`；改实现先登记 |
| R08-vitest | high | Vitest 4/4 | `tests/vitest/data-governance/**` |
| R08-archive | high | Rust Archive | 诊断文档或最小编译修复 |
| R08-e2ee-tests | high | 文件级 E2EE 极端测 | `src-tauri/tests/sync_r08_*.rs` 新文件 |
| R08-legacy-ux | high | 明文遗留拒收人话 | `SyncTab.tsx` / locale `sync.json`；不改引擎 |

## Round 09（已合入专属枝）

| 代理 | 模型 | 范围 | 文件面（独占） |
|---|---|---|---|
| R09-e2ee | claude-fable-5-thinking | 文件级 E2EE 闭环可运维：集成测试、前端错误人话、上传入口审计、P2-1 运维文档 | `src-tauri/tests/sync_r09_file_e2ee.rs` 新文件、`data-governance/syncE2eeErrorMapping.ts` 新文件、`SyncTab.tsx` 错误展示、`CloudStorageSection.tsx` 的 `localizeCloudError`、`cloudStorage.json`（zh/en）新增 `errors.e2ee*` 三键、`tests/vitest/data-governance/syncE2eeErrorMapping.test.ts` 新文件、`docs/user-guide/16-数据管理与云同步.md`、`RESTORE-MATRIX-R07.md` P2-1 回写 |
| R09-android | claude-fable-5-thinking | Android 换机/重启闭环 + 平台能力测试钩子 + S3 用户级拒绝 | `src-tauri/tests/sync_android_device_switch.rs` 新文件、`cloud_storage/config.rs` / `mod.rs` / `cloud_config_commands.rs` 的 `PlatformStorageCapabilities` 测试钩子 |
| R09-names | claude-fable-5-thinking | 资产文件名跨平台净化 | `asset_filenames.rs` + `sync_asset_directories*` key 接线（不改 vfs_blobs） |
| R09-restore-ops | claude-fable-5-thinking | 云 ZIP 下载续传 / 无密码导入早失败 | 恢复引擎 + WebDAV resume + 指南解锁 |
| R09-ux | claude-fable-5-thinking | SyncTab 人话错误 + UX 契约测 | `SyncTab.tsx` `classifySyncError`、`sync.json` errors.*、`r09-ux-*.test.tsx` |

### R09-e2ee 审计结论：记录级四个上传入口

复审 `commands_sync.rs` 全部会写云端的记录级入口，确认均在任何云端写入前执行
`enforce_record_upload_encryption_policy_for_config`（内部走
`enforce_encryption_policy_before_upload_with_password`，错密码/明文降级在写入前拦截）：

1. `data_governance_run_sync`（`commands_sync.rs:1648`，direction != Download 时）；
2. `data_governance_run_sync_with_progress`（`commands_sync.rs:2820-2825`，同上）；
3. `data_governance_mark_blob_deleted`（`commands_sync.rs:3846`，tombstone 写入前）；
4. `data_governance_mark_asset_deleted`（`commands_sync.rs:3880`，tombstone 写入前）。

其余命令核实为非上传路径：`resolve_conflicts` 已停用（fail-fast）、`import/export_sync_data`
只动本地文件、`detect_conflicts` 对云端只读、quarantine/conflict 系列只写本地库。
**无漏网，无需补丁**；策略助手本身已有单元测试（`commands_sync.rs:4934-5031`），
R09 另在 `sync_r09_file_e2ee.rs` 从公开 API 钉死标记升级/损坏 fail-closed 行为。

另：工作区 `src-tauri/src/data_governance/sync/auto.rs` 为未被任何 `mod` 引用的
未跟踪孤儿文件（疑似前轮代理遗留草稿），R09 不提交、不引用。

### Round 09 实现改动登记

- **R09-android → `cloud_storage/config.rs` / `cloud_storage/mod.rs` / `cloud_config_commands.rs`**：
  为 Android 换机闭环测试补齐平台能力测试钩子并修复 RESTORE-MATRIX P3-2。
  1. 新增 `PlatformStorageCapabilities`（`ftp_supported` / `s3_supported`，生产入口一律
     `current()` 取编译期真值）；`validate` / `create_storage` / SSOT 保存与加载新增
     `*_with_capabilities` 变体，宿主机测试按 Android 能力矩阵驱动**同一套**拒绝分支
     （serde/IPC 无法构造该值，不构成运行时开关）。FTP 的 Android 拒绝从 `#[cfg]` 双臂
     改为运行时能力判断（行为不变，文案仍为共享常量）。
  2. P3-2：无 S3 构建的拒绝文案由「请在编译时启用 cloud_storage_s3 feature」改为用户级
     常量 `S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE`（"当前安装包不支持 S3 兼容存储，请改用
     WebDAV。"），并对齐 FTP-on-Android 语义：SSOT 保存**与**加载在无 S3 构建上均
     fail-closed，杜绝"保存成功但永远连不上"的僵尸 S3 配置。
  3. 新集成测试 `src-tauri/tests/sync_android_device_switch.rs`：Android 拒 FTP/S3 四路径、
     mobile-slim/android-release feature 清单锚定、仅 WebDAV 换机闭环（进程内假 WebDAV
     服务器 + 加密上传/下载/密码门禁/非活动 B 槽/重启切换/两段式租约）、租约目标未激活
     拒启 guard、device_id 落 `<app_data_dir>/.device_id` 与恢复后 rotate（子进程探针）。

### Round 09 待修登记（locale）

- **P2-LOCALE-PLATFORM-MSG**：平台能力拒绝文案语言不统一且未接 i18n——
  `FTP_UNSUPPORTED_ON_ANDROID_MESSAGE` 为英文（前端 `CloudStorageSection.tsx` 以正则映射
  到 `cloudStorage.json` 的 `ftpDisabledAndroid`），新增的
  `S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE` 为中文且前端**尚无**对应映射/locale 键。
  建议后续代理：为 S3 拒绝补 `cloudStorage.json`（zh/en）键与前端映射，并统一两条常量的
  映射机制（错误码优于字符串正则）。本轮（R09-android）只保证后端文案面向用户且四路径
  字节一致，不动前端与 locale。
  **状态更新（R10 回写）**：前端半边已由 R10-ux 关闭——`localizeCloudError` 新增
  `当前安装包不支持 S3 兼容存储` → `errors.s3DisabledInBuild` 映射，zh/en 键已落
  `cloudStorage.json`，en 用户不再看到裸中文。**机制统一半边仍开**：FTP（英文常量）
  与 S3（中文常量）两条拒绝仍靠字符串正则映射，后端引入稳定错误码后应改为按 code
  匹配（连同 `syncE2eeErrorMapping.ts` 一并迁移），已列入 R11-android2 交付物 ④。

### R09-ux（分支 `cursor/cloud-sync-sota-r09-ux-b343`，设置/数据治理同步面 only）

排查结论（SyncTab / CloudStorageSection / BackupTab / RecordConflictsPanel）：

- 自动同步默认关 ✓（`syncStatusStore` 仅持久化 `enabled`，默认 `false`）；冲突计数走 `total_groups` ✓；危险操作确认（库级冲突解决 / 清除配置 / 停用 E2EE / 恢复 / 删除版本 / 批量解决）均仍接线 ✓；E2EE 文案覆盖 ZIP + 记录级 + 文件级 ✓。
- **缺口**：R08-legacy-ux（明文遗留拒收人话）未交付——`SyncTab` 直接透出引擎中文技术错误（含 DSBK 术语），en 用户不可读、普通用户不可操作。
- `sync.json` / `cloudStorage.json` zh↔en 键已核对完全对齐，无互缺键；缺的是引擎错误的人话键（本轮新增）。

文件面认领（独占）：

| 文件 | 改动 |
|---|---|
| `src/features/settings/components/data-governance/SyncTab.tsx` | 展示层新增 `classifySyncError`：明文遗留拒收 / 加密密码缺失 / 密码错误三类引擎错误映射为人话 i18n，原始错误保留为技术详情；不改引擎 |
| `src/locales/{zh-CN,en-US}/sync.json` | 新增 `errors.legacyPlaintextRejected` / `errors.encryptionPasswordMissing` / `errors.wrongEncryptionPassword` / `errors.technicalDetail` |
| `tests/vitest/data-governance/r09-ux-*.test.tsx` | 四个新测试文件（sync-tab / cloud-storage / backup-tab / record-conflicts），只增不改既有测试 |

## Round 07 原认领表（后派出）

任务定义见 [ROUND-07](./ROUND-07.md)。测试代理各写**独立新测试文件**；若必须改既有文件，先在此登记。

### Round 07 实现改动登记

- **R07-contract → `cloud_storage/ftp.rs`**：Contract Gate（run 32679534026）暴露 FTP `delete` 在目标 key 的父目录不存在时 CWD 550 硬失败，而 S3/WebDAV 对不存在 key 的删除是幂等成功（WebDAV 显式把 404 当成功）。资产 tombstone 应用会对遗留路径 `data_governance/assets/<key>` 做删除，该路径在新格式下从不存在，FTP 因此三家中唯一挂掉。修复：`delete` 中父目录 CWD 失败且可归类 not-found（沿用 R02 收紧后的 550/501 白名单）时按幂等成功返回；无法归类的 550 仍硬抛。同时在 `run_object_semantics_contract` 补「删除位于不存在目录下的 key 幂等成功」断言钉死三家语义。
- **R07-contract → `sync_provider_contract_tests.rs` 混合明文/密文契约**：R04/R06 起 `decode_payload` 对「本端已启用加密但云端 payload 无 DSBK 头」fail-closed（防静默降级），旧测试仍断言带密码客户端能解码混合变更，属测试与新契约脱节，按新契约改写（带密码端必须停在明文变更文件的安全点）。R05/R06 的 `check_connection` 改动（MKCOL 失败 + PROPFIND 404 不假成功）与本次失败无关：失败 run 中所有 `check_connection` 前置断言均通过。

| 代理 | 模型 | 范围 | 文件面（独占） |
|---|---|---|---|
| R07-review | claude-fable-5-thinking-xhigh | 只读复审 R06 合入，产出 FINDINGS-R07 | 只读（产出文档归父代理/本目录） |
| R07-sota | claude-fable-5-thinking-xhigh | 市面 SOTA 对照与剩余缺口 | 只读（产出文档归本目录） |
| R07-restore | claude-fable-5-thinking-xhigh | 跨版本恢复矩阵只读 | 只读（产出文档归本目录） |
| R07-contract | claude-fable-5-thinking-high | Cloud Provider Contract Gate | `src-tauri/tests/sync_provider_contract_tests.rs` + 必要的 `webdav.rs`/`ftp.rs`/`s3.rs` 契约对齐（先登记再动实现） |
| R07-vitest | claude-fable-5-thinking-high | Vitest shard 4 | `tests/vitest/data-governance/**`、相关 locale；不改引擎 |
| R07-archive | claude-fable-5-thinking-high | Rust Tests · Build Archive exit 143 | 编译修复优先；禁止大范围重构 |
| R07-asset-e2ee | claude-fable-5-thinking-high | 文件级对象尊重加密标记 | `data_governance/sync/mod.rs` 的 `sync_vfs_blobs*` / `sync_asset_directories*` / workspace 上传；`cloudStorage.json`（zh/en） |
| R07-autosync | claude-fable-5-thinking-high | 最小自动同步（默认关）+ 状态可见 | `data_governance/sync/` 新文件优先、`SyncSettingsSection.tsx`、`syncStatusStore.ts`；locale 键若需 `sync.json` 先在此登记 |
| R07-asset-names | claude-fable-5-thinking-high | 资产文件名跨平台 | `src-tauri/tests/` 新文件；净化实现落点先在此登记 |
| R07-android | claude-fable-5-thinking-high | Android 换机/重启语义 | `src-tauri/tests/` 新文件 + 必要 cfg 门测试 |
| R07-tests | claude-fable-5-thinking-high | 本轮极端回归 | `src-tauri/tests/` 与 `tests/vitest/data-governance/` **各自新文件** |

## Round 09 回传（增量登记）

### R09-restore-ops（RESTORE-MATRIX-R07 运维缺口一整包）

分支 `cursor/cloud-sync-sota-r09-restore-ops-b343`，模型 claude-fable-5-thinking-high。交付：

- **P2-1**：`docs/user-guide/16-数据管理与云同步.md` 新增「云端目录的加密标记与『密码不一致』解锁」小节 + FAQ——旧 `.encryption-marker`（v1 无校验子）被配错密码设备抢先一次性升级后，正确密码设备的解锁步骤（自证密码 → 删云端标记 → 重新登记 → 纠正错密码设备）。
- **P2-2**：云端 ZIP 下载断点续传最小实现（复用导入续传"失败保留断点"模式）：
  - `cloud_storage/traits.rs`：`supports_resumable_download` + `get_file_resumable`（默认实现 fail-closed，文案常量 `RESUMABLE_DOWNLOAD_UNSUPPORTED`，禁止静默整包重下冒充续传）；
  - `cloud_storage/webdav.rs`：HTTP Range 续传（206 校验 Content-Range 起点、200 诚实从零重写、错位/截断 fail-closed）；
  - `cloud_storage/sync_manager.rs`：`download_with_progress` 断点编排（`.{id}.zip.part` 中断保留、完成后整文件 SHA256 兜底、损坏断点丢弃明确报错）；S3/FTP 不支持续传，走原整文件下载路径（诚实，无断点）。
- **P3**：`backup/zip_export.rs` 非续传导入的无密码早失败——`precheck_sealed_payload_password` 由续传/非续传共用，在解压任何条目之前失败，错误文案与解封阶段保持一致。
- **测试**：`src-tauri/tests/sync_r09_download_resume_tests.rs`（编排契约 6 例）、`src-tauri/tests/webdav_download_resume_tests.rs`（假 WebDAV 服务器 Range 行为 6 例）、`zip_export.rs` 内 P3 单测 3 例、`tests/vitest/data-governance/r09-restore-ops.source.test.ts`（指南/实现锁定）。

**文件面认领**：`cloud_storage/traits.rs`、`cloud_storage/webdav.rs`（仅新增 resumable 方法与 `parse_content_range_start`）、`cloud_storage/sync_manager.rs`（仅 download 路径）、`cloud_storage/mod.rs`（仅导出）、`backup/zip_export.rs`（预检 + 测试）、用户指南 16、上述新测试文件。**与 R10 的交叠**：R10-download（下载续传+无密码早失败+指南）与 R10-verifier 的「错密码抢先升级解锁指南」两项已由本包交付，按"R09 回传只收增量"处理，R10 两路只需补本包未覆盖的部分（如 Argon2 参数钳制、S3/FTP 续传）。

## Round 10 回传（增量登记）

### R10-sota（分支 `cursor/cloud-sync-sota-r10-sota-b343`，只改本目录文档）

模型：`claude-fable-5-thinking-high`（用户要求 xhigh，slug 当前不可用，明示降级）。交付：

- [SOTA-R10.md](./SOTA-R10.md)：基于 `25519c0c`（R09 五路已合入）对十家逐一按「我们已有 / 诚实差距 / 不该学」重打分；R07 的 GAP-1/3/4/5 确认关闭或收窄，剩余差距收敛为增量去重、时点恢复、仓库巡检、文件名可逆映射、sync target 租约五件事。
- [ROUND-11.md](./ROUND-11.md)：下一轮十路大包任务表（review / check / history / delta / names2 / lease / unsynced-ui / rotate / autosync2 / android2），每路 ≥4 交付物，文件面独占表含 `sync_manager.rs` / `SyncTab.tsx` / `commands_sync.rs` 交叉规则。
- README 索引回写（只加链接）。

**文件面认领（独占，均在 `docs/dev/cloud-sync-sota-b343/`）**：`SOTA-R10.md` 新文件、`ROUND-11.md` 新文件、`README.md` 索引两行、本文件本节。不改任何代码。与 R10-protocol 的 PROTOCOL-R10.md、R10 各实现路无文件交叠。

### R10-ux（分支 `cursor/cloud-sync-sota-r10-ux-b343`，设置/数据治理同步面 only，不碰 RecordConflictsPanel）

复审结论（SyncTab / CloudStorageSection / BackupTab）：

- 自动同步默认关 ✓（`useAutoSyncStore` 默认 `enabled: false`，仅持久化该字段）；SyncTab 库级冲突四策略均先弹确认 ✓；E2EE 覆盖/标记损坏文案（`markerCorrupted` → `e2eeMarkerCorrupted`）接线完好 ✓；`classifySyncError`（sync.json）与 `classifySyncE2eeError`（cloudStorage.json）双轨保留、UX 键优先 ✓。
- **缺口 1（P2-LOCALE-PLATFORM-MSG 前端半边，本包关闭）**：后端 `S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE`（中文）在前端 `localizeCloudError` 无映射、无 locale 键——en 用户在无 S3 构建上加载/保存/测试 S3 配置时看到裸中文。
- **缺口 2**：BackupTab 恢复确认框 `confirmVariant` 为 `primary`，与云端恢复（warning）/库级冲突覆盖（warning/danger）分级不一致——恢复会覆盖当前数据槽。
- **缺口 3**：`doSaveConfig` 的 SSOT 保存失败通知吞掉后端拒绝原因（加载路径带原因，保存路径只报「配置未保存」）。

交付（文件面独占）：

| 文件 | 改动 |
|---|---|
| `src/features/settings/components/CloudStorageSection.tsx` | `localizeCloudError` 只新增 S3 映射片段（`当前安装包不支持\s*S3\s*兼容存储` → `errors.s3DisabledInBuild`，不重写整段）；`doSaveConfig` SSOT catch 补 `localizeCloudError(e)` 原因（对齐加载路径） |
| `src/features/settings/components/data-governance/BackupTab.tsx` | 恢复确认框变体 `primary` → `warning`（删除仍 danger、导出仍 primary） |
| `src/locales/{zh-CN,en-US}/cloudStorage.json` | 新增 `errors.s3DisabledInBuild`（面向用户：改用 WebDAV 或桌面导出 ZIP 导入；不含 feature/编译字样） |
| `tests/vitest/data-governance/r10-ux-cloud-error-mapping.test.tsx` | 跨层契约：从 `cloud_config_commands.rs` 原文提取 S3/FTP 常量钉死前端匹配；加载路径 S3/FTP 映射 + E2EE 分类优先级；SSOT 保存失败带原因源码契约 |
| `tests/vitest/data-governance/r10-ux-backup-restore-confirm.test.tsx` | 恢复 warning / 删除 danger / 导出 primary 变体分级 |

**遗留（未在本包处理）**：P2-LOCALE-PLATFORM-MSG 的机制统一半边——FTP（英文常量）与 S3（中文常量）仍靠字符串正则映射，后端引入稳定错误码后应改为按 code 匹配（两处映射与 `syncE2eeErrorMapping.ts` 一并迁移）。

## Round 11 回传（增量登记）

### R11-rotate（分支 `cursor/cloud-sync-sota-r11-rotate-b343`，只改本目录文档）

模型：`claude-fable-5-thinking-high`（ROUND-11 要求 xhigh，slug 当前不可用，明示降级）。重派（首派因提示词触发安全策略失败）；本路为产品/运维文档，不含攻击步骤/利用/PoC。交付：

- [KEY-ROTATION-R11.md](./KEY-ROTATION-R11.md)：①「换备份密码 = 换云端目录 + 全量重传」现状的用户可照做流程（含双设备过渡共存矩阵、中断恢复），与 Standard Notes 产品行为对照；② 原地轮换协议草案（标记 v3 / 双校验子过渡窗 / 幂等中断恢复），仅供评审不实现；③ 备份对象名（时间戳毫秒+设备短 ID）与 `manifests/<device_id>.json` 等明文元数据的隐私评估（定级 P2），向后兼容的中性命名收敛方案（下载/裁剪全经 manifest 按 id 查找、不解析文件名，已核实兼容根据）；④ **R10-verifier「Argon2 参数钳制」独立复审结论：未交付，缺口仍开**——`derive_key` 对校验子与 DSBK 头携带的参数无应用级上限，产品要求（合法参数必须通过、异常过大参数派生前拒绝）与验收标准（测试名/断言意图七条）已写死；⑤ 下一轮四个可认领任务（R12-kdf-clamp / neutral-names / rotate-wizard / rotate-proto-review），每条含可验证交付物与文件面。

**文件面认领（独占，均在 `docs/dev/cloud-sync-sota-b343/`）**：`KEY-ROTATION-R11.md` 新文件、`README.md` 索引一行、本节。不改任何代码。T1–T3 实现任务的代码文件面（`backup_crypto.rs` / `sync_manager.rs` 命名段等）本轮**未认领**，留待 R12 认领时登记。

### R10-conflict-ui（FINDINGS-R07 P1-1 关闭：cloud-only 冲突「保留本地」前端可达）

分支 `cursor/cloud-sync-sota-r10-conflict-ui-b343`，模型 claude-fable-5-thinking-high。纯前端 + vitest，不动 Rust 后端 / SyncTab 错误映射。交付：

- **P1-1 关闭**：`RecordConflictsPanel.tsx` 单条「保留本地」不再因缺 local 快照禁用（后端 `data_governance_resolve_record_conflict` 自 R06 起缺 local 侧回退当前业务表行）；语义 = 驳回云端败方 DELETE/覆盖、保留本地胜方。cloud-only 组的单条 keep_local 走 `unifiedConfirm` 两击确认，不静默执行；批量 keep_local 不再过滤 `pair.locals.length > 0`，cloud-only 组纳入（批量确认对话框保持不变）。
- **人话空状态**：local 侧「无」时新增说明——这是云端单侧冲突，「保留本地」= 驳回云端变更；同文案挂在单条按钮 `title` 上。
- **文案**：`src/locales/{zh-CN,en-US}/data.json` 新增 `governance.conflict_cloud_only_hint` / `governance.conflict_keep_local_cloud_only_confirm` 两键。
- **测试**：改写 `tests/vitest/data-governance/r07-cloud-only-delete-conflict.test.tsx` 锁定新行为——cloud-only「保留本地」可点、确认拒绝不执行、resolve 的 expectedConflictIds 仅含 cloud 行 id、批量 keep_local 包含 cloud-only 组且仍走确认。

**文件面认领（独占）**：`RecordConflictsPanel.tsx`、`data.json`（zh/en，仅 governance 新增两键）、`r07-cloud-only-delete-conflict.test.tsx`、`FINDINGS-R07.md` P1-1 回写、本节。

### R10-protocol（分支 `cursor/cloud-sync-sota-r10-protocol-b343`，重派；只读调研 + 新文档 + 新锁定测）

模型：`claude-fable-5-thinking-high`（用户要求 xhigh，slug 不可用，明示降级，非静默）。交付：

- [PROTOCOL-R10.md](./PROTOCOL-R10.md)：FINDINGS-R01/03/05/07 与本文件仍开登记项逐条核销（已关/仍开/部分 + 现场核实的证据文件:行）。结论：**P0/P1 清零**；仍开高危收敛为 4 件 P2——P2-2（KDF 参数无上限）、P2-3（resolve 快速路径事务外快照）、P2-1 残余（升级信任边界仅文档缓解）、R01-P2 残余（文件名长度未钳制）；CI 红灯三项无法就地复核（基线 runs 均 cancelled/queued），留待完整 run。
- `src-tauri/tests/sync_r10_protocol_locks.rs` 新文件：6 个锁定测——P2-2 三枚（零值参数 fail-closed / 标记参数原样采用 / 无钳制源码锁）、P2-3 源码锁（事务内仅 generation 重验，业务行重读缺席；顺带钉住既有两道防线）、P2-1 文档锁（解锁指南 + FAQ + 升级日志不被删）、文件名长度未钳制行为锁（幂等 + 长度原样）。缺口被修复时用例失败，逼出本台账回写。
- FINDINGS-R07 顶部状态表回写（不删历史正文）。
- 附带核销：R09 登记的孤儿文件 `data_governance/sync/auto.rs` 在当前基线已不存在，销项。

**文件面认领（独占）**：`PROTOCOL-R10.md` 新文件、`sync_r10_protocol_locks.rs` 新文件、`FINDINGS-R07.md` 顶部状态表、本节。不改任何实现代码。

**仍开项去向（R11 建议，详见 PROTOCOL-R10 文末）**：R11-verifier-clamp（P2-2 双处钳制）、P2-3 并入 sync 面、P2-1 升级事件暴露、错误码替代正则（P2-LOCALE 机制半边）、文件名长度钳制（低优先，需连带迁移设计）。

### R10-android（重派，分支 `cursor/cloud-sync-sota-r10-android-b343`，仅新增测试 + 文档，不改生产代码）

模型 claude-fable-5-thinking（重派轮）。前置：R09-android（S3 用户级拒绝 + 能力矩阵测试钩子）与 R10-ux（`errors.s3DisabledInBuild` 前端映射）已合入，本路只做增量。交付：

- **新集成测试 `src-tauri/tests/sync_r10_android.rs`**（R07/R09 两个 android 测试文件未覆盖的面）：
  1. content URI（SAF）宿主可测半边：`unified_file_manager` 的
     `is_virtual_uri` / `extract_file_name` / `extract_extension` /
     `is_opaque_document_id` / `sanitize_file_name_for_fs` / `sanitize_for_legacy`
     此前零测试——钉死虚拟/本地分类（含大小写、SAF 三前缀、双重编码诚实锚定）、
     SAF document ID 解码取名、不透明 ID 判定、content:// 编码逐字节保留
     （SecurityException 防护）。
  2. 物化路径与重启命令壳源码锚定：`commands_zip.rs` 的 temp_zip_import/export
     物化编排与清理承诺（含失败路径错误文案）、`restart_app` 注册 +
     直达 `app.restart()` + 「清空所有数据」先落盘标记后重启的顺序。
  3. 租约提交阶段身份对账增量：`mark_restore_activation_committed` 错 backup_id /
     错活动槽路径 fail-closed、提交后错路径解除被拒、无租约重复解除幂等 false、
     rollback trash 跨切槽重启生命周期（激活槽自身 trash 回收、旧槽回滚点幸存）。
- **真机缺口声明**（测试文件模块文档如实记录）：content:// 实际读写需
  `Window<Wry>` + ContentResolver，mock runtime 类型不兼容无法宿主驱动；
  `app.restart()` 结束进程不可宿主测；双重编码 content URI 在 `is_virtual_uri`
  层按本地路径 fail-closed。三者均转 R11-android2 真机核对单。
- **用户指南 16 移动端增量**：Android 导入/导出 ZIP 的 content:// 临时中转
  （空间约两倍、完成后自动清理）、不透明文件名自动类型识别、自动重启失败的
  手动重开指引（切槽固定下次启动生效）。
- **P2-LOCALE-PLATFORM-MSG 回写**：见上文 Round 09 待修登记的状态更新
  （前端半边已关，机制统一半边仍开、归 R11-android2）。

**文件面认领（独占）**：`src-tauri/tests/sync_r10_android.rs` 新文件、用户指南 16 移动端段增量、本文件两处回写。不改 RecordConflictsPanel / file-e2ee / notes / chat / workbench，不动任何生产代码。

### R10-download（重派，分支 `cursor/cloud-sync-sota-r10-download-b343`，R09-restore-ops 之上的增量复审）

模型 claude-fable-5-thinking-high。R09-restore-ops 已交付 WebDAV Range 续传 + 无密码导入早失败，本包只收增量。复审结论与修复：

- **S3/FTP 半包当成功（确认存在，已修）**：`s3.rs::get_file` 与 `ftp.rs::stream_to_file`（`get` / `get_file` 共用）都以"流读到 EOF"为完成信号，从不核对实际字节数与云端声明大小。备份下载路径因带 `version.checksum` 有第二道防线，但存在 `expected=None` 调 `get_file` 的调用方（当时论证引用的 `data_governance/sync/mod.rs::get_file_decoded` 后经 FINDINGS-R11 P2-1 认定为死代码、已由 R12-decoded-dead 删除；真实的 `expected=None` 调用方是 `repo_check.rs` 的巡检下载——修复的受益结论不变），FTP 数据通道被中间设备掐断（EOF 与正常结束不可区分）时半包会被 persist 成成功产物。修复：三处（含 `traits.rs` 默认实现）在 EOF 后校验 `downloaded == total_size`，不一致即 fail-closed，同时覆盖"对象在 stat 与 GET 之间被并发替换"的错版本形态；`ftp.rs::get_file` 对 `stat=None` 提前返回 not-found（原实现按 `total_size=0` 继续 RETR）。
- **WebDAV 损坏/对象变更 SHA256 拒绝（确认已闭环，只补锁定测）**：`sync_manager.rs::download_with_progress` 续传路径完成后整文件 SHA256 与 `version.checksum` 比对、失败即丢断点报错（R09 已实现且有损坏断点测试）；本包补"对象被同大小换包"锁定测。
- **无密码导入所有入口早失败（确认已闭环，补入口枚举锁定测）**：四个公开导入函数（`import_backup_from_zip` / `_with_password` / `_with_progress` / `_resumable`）全部经 `precheck_sealed_payload_password` 在触碰目标目录之前失败；命令层 `data_governance_import_zip`、任务恢复续传、`cloud_sync_download` 的 DSBK 无密码路径均复核无旁路。

**实现改动登记（独占）**：`cloud_storage/ftp.rs`（`stream_to_file` 字节数校验 + `get_file` stat=None 早退 + 单元测试；与 R10-providers 若回传按增量消解）、`cloud_storage/s3.rs`（仅 `get_file` 字节数校验）、`cloud_storage/traits.rs`（仅默认 `get_file` 字节数校验）、新测试 `src-tauri/tests/sync_r10_download.rs`、用户指南 16 补一句、本节。不改 `webdav.rs` / `sync_manager.rs` / RecordConflictsPanel。

## Round 11 回传（增量登记）

### R11-check（分支 `cursor/cloud-sync-sota-r11-check-b343`，云端仓库巡检一整包）

模型 claude-fable-5-thinking-high。restic `check` 档的云端仓库巡检，**只读不修**。交付：

- **实现**：新文件 `cloud_storage/repo_check.rs`——遍历所有 manifest（per-device + 旧版 `manifest.json`/`.bak`）引用的 `backups/<id>.zip` 对象，核对存在性 / 整对象 SHA256 / DSBK 加密头可解（v1/v2 头结构、Argon2 参数、分块大小、按对象总长判截断），报孤儿对象与 `manifests/` 下 `.tmp` 残留、损坏 manifest、清单条目冲突、加密标记损坏、加密仓库明文混布、密文对象缺标记。诚实性契约：任一列表截断或对象读取失败 → 结论 `incomplete`，**绝不给全绿**；manifests 列表截断时跳过孤儿判定（防误报）。**不改 `sync_manager.rs`**（R11-lease 独占），布局/DSBK 常量按稳定存储格式在新文件内复制并注明。
- **命令**：`commands_sync.rs` 末尾新增独立命令 `data_governance_repo_check`（只读，不加 DataGovernanceOperationGuard），未改任何既有函数签名；注册于 `lib.rs` invoke handler、`data_governance/mod.rs` re-export、`permissions/application-commands.toml`。
- **UI**：`CloudStorageSection.tsx` 新增独立「云端仓库巡检」区域（连接成功后可见）：只读说明与流量预告、三态结论徽标（全绿 / 发现 N 个问题 / 巡检不完整）、问题清单（类别 i18n + 版本 ID + 对象 key + 细节）、「发现坏对象后该做什么」人话指引（坏对象→先出新完整版本再删坏版本；孤儿→网盘工具手动删、巡检绝不代删；清单类→最近上传设备重传；不完整→重试且不当灾备）。
- **locale**：`cloudStorage.json`（zh/en）新增 `repoCheck.*`（含 `problemKind.*` 11 键与 `guidance.*`）。
- **测试**：新文件 `src-tauri/tests/sync_r11_repo_check.rs`——好库全绿（明文/加密各一）、缺对象（指明版本 ID、不波及健康版本）、坏密文（SHA256 不匹配 + DSBK 头不可解）、明文混布、孤儿 + tmp 残留 + **只读快照断言**（巡检前后云端逐字节一致）、损坏 manifest 不中断巡检、截断列表拒绝全绿、截断时孤儿判定被抑制；`repo_check.rs` 内另有 DSBK 头解析单测 4 例。
- **文档**：用户指南 16 新增「云端仓库巡检（只读体检）」小节。

**文件面认领（独占）**：`cloud_storage/repo_check.rs` 新文件、`cloud_storage/mod.rs`（仅 `pub mod repo_check;` 一行）、`commands_sync.rs` 巡检命令段（只加不改）、`lib.rs` 注册一行、`data_governance/mod.rs` re-export 一行、`permissions/application-commands.toml` 一行、`CloudStorageSection.tsx` 巡检区、`cloudStorage.json`（zh/en）`repoCheck.*`、`sync_r11_repo_check.rs` 新文件、用户指南 16 巡检小节、本节。与 R11-lease 的 `sync_manager.rs`、R11-unsynced-ui 的 `commands_sync.rs` 查询段无交叠（各自只加新段，推前 rebase 消解）。

**状态更新（R11-review 复审）**：接线与只读/诚实性契约核实到位，但 DSBK v2 头核查存在 **P1 缺陷**（头长 48 应为 44、chunk 读 `[44..48)` 应为 `[40..44)`，加密仓库约 98.4% 误报「头不可解」），且 `dsbk_v2_header_roundtrip_is_decodable` 与 `healthy_encrypted_repo_reports_all_green` 两例按现实现必红——上表「测试」行的绿灯声明不成立。详见 [FINDINGS-R11](./FINDINGS-R11.md) §2 P1-1，修复归 R12-repocheck-fix。

### R11-review（分支 `cursor/cloud-sync-sota-r11-review-b343`，只读复审，只改本目录文档）

模型 `claude-fable-5-thinking-high`（ROUND-11 要求 xhigh，slug 不可用，明示降级）。交付：

- [FINDINGS-R11.md](./FINDINGS-R11.md)：R10 七路（conflict-ui / sota / ux / protocol / android / download / chaos）+ R11 两路（rotate / check）逐条核销（九路合入项实质到位）；新发现 1 P1 + 3 P2（均带文件:行证据，P1 附独立最小复现输出）；仍开项锁定测清单（已有测写文件名、缺的列应补断言）；SOTA-R10 §3 矩阵改判建议（多设备冲突行可翻「已达」、仓库巡检行建议「部分达」）。
- 环境不可编译（缺 webkit2gtk），Rust/vitest 均未运行——核销为逐行源码核对 + 关键项独立复现，诚实声明见 FINDINGS-R11 §0。

**新发现修复认领建议（文件面待认领时登记）**：

| 项 | 级别 | 修复文件面 |
|---|---|---|
| repo_check DSBK v2 头偏移（FINDINGS-R11 P1-1） | P1 | `cloud_storage/repo_check.rs`、`sync_r11_repo_check.rs`（改真实密文 fixture）→ R12-repocheck-fix |
| `get_file_decoded` 死代码且语义与 `download_file_object` 相悖（P2-1） | P2 | ~~`data_governance/sync/mod.rs`（删除）；本文件 R10-download 节论据引用同步更正~~ **已关 → R12-decoded-dead（Round 12 回传）** |
| WebDAV 非续传 `get_file` 无字节数核对（P2-2） | P2 | `cloud_storage/webdav.rs` + 新测；指南 16 `:80` 表述在此之前对 WebDAV 超前 |
| 绿灯声明未经运行（P2-3，过程项） | P2 | 下一次完整 CI run（含 P1-1 修复）前，「测试 N 例」类声明一律视为「已交付未验证」 |

**文件面认领（独占，均在 `docs/dev/cloud-sync-sota-b343/`）**：`FINDINGS-R11.md` 新文件、`README.md` 索引一行、本节与 R11-check 节状态更新一段。不改任何代码。

### R11-autosync2（分支 `cursor/cloud-sync-sota-r11-autosync2-b343`，自动同步档位 + fail-close 加固一整包）

模型 claude-fable-5-thinking-high。在 R07-autosync 前端调度器（`syncStatusStore.ts`，固定 15min 间隔）之上做增量，**默认关不变、不接 workbench 壳层、不改 Rust 引擎**。交付：

- **① 定时档位**：`AutoSyncIntervalPreset`（15m/1h/6h）+ `AUTO_SYNC_INTERVAL_PRESETS` 常量表，默认 15m（与 R07 行为一致）；调度器 `intervalMs` 支持函数式求值（每次排程按当前档位取值），新增 `reschedule()`（档位切换即时重排挂起的定时器）；长档位下失败退避封顶取 `max(maxBackoffMs, intervalMs)`——6h 档失败重试不得比常规轮询更频繁。
- **② 触发前置检查加固（fail-close，静默跳过绝不弹错）**：新增 `classifyAutoSyncSkip`——租约被占 → 新结果 `skipped_lease_held`；后端全局互斥「另一个数据治理任务…」「已有数据治理操作正在运行」→ `skipped_busy`；引擎「未配置加密密码」（云端要求 E2EE 但本机无密码）→ `skipped_unconfigured`。三类均不计失败退避；未知错误照旧 failure。既有防线（无配置/缺 provider 凭据/断层预检/前端全局锁）复审无改动需求，全部保留。
- **③ 状态可见**：`useAutoSyncStore` 持久化面从仅 `enabled` 扩为 `enabled + intervalPreset + lastOutcome + lastRunAtMs`（persist version 1→2，v1 旧值靠默认值兜底迁移）；`SyncSettingsSection.tsx` 自动同步区新增档位选择（关闭时禁用不隐藏）与「上次自动同步: 时间 · 结果（· 连续失败 N 次）」状态行。
- **④ 测试**：新文件 `src-tauri/tests/sync_r11_autosync.rs`（全局互斥锁完整生命周期行为测：手动持锁时 try_acquire 立即失败/释放后恢复/账本 holder 可见；busy·无密码·租约三组标记的跨层源码契约；档位常量与默认关源码锁；zh/en locale 键形对齐）+ 新文件 `tests/vitest/data-governance/r11-autosync-intervals-failclose.test.tsx`（档位常量/动态间隔/reschedule/6h 档退避下限；classifyAutoSyncSkip 全分支含「错密码不得静默吞」；performAutoSyncOnce 五类 outcome 与锁释放；与手动互斥不窃锁；UI/locale 契约）。既有 `src/stores/__tests__/autoSyncStore.test.ts` 仅更新持久化断言（partialize 字段扩展），其余 R07 基线用例不动。
- **⑤ locale**：`sync.json`（zh/en）`autoSync.*` 新增 `intervalLabel` / `interval.{15m,1h,6h}` / `lastRun` / `neverRan` / `outcome.{success,failure,skippedUnconfigured,skippedBusy,skippedLeaseHeld}` / `consecutiveFailures`，并更新 `description` 提及档位与静默跳过。

**跨代理契约（→ R11-lease）**：自动同步以稳定错误码 **`E_SYNC_LEASE_HELD`** 识别「租约被占」——R11-lease 落地 sync target 租约时，其「租约被占」错误文案**必须包含该 token**（建议格式 `[E_SYNC_LEASE_HELD] 同步租约被其他设备持有…`），否则自动同步会把租约冲突误计为失败进入退避。`sync_r11_autosync.rs` 与 vitest 均已钉死前端半边；R11-lease 合入后请在其集成测试中补后端半边（错误文案含 token）断言。

**文件面认领（独占）**：`src/stores/syncStatusStore.ts`、`src/stores/__tests__/autoSyncStore.test.ts`（仅持久化断言一处）、`SyncSettingsSection.tsx` 自动同步区、`sync.json`（zh/en）`autoSync.*`、`src-tauri/tests/sync_r11_autosync.rs` 新文件、`tests/vitest/data-governance/r11-autosync-intervals-failclose.test.tsx` 新文件、本节。不改 RecordConflictsPanel / repo_check / notes / chat / workbench，不动任何 Rust 生产代码。

### R10-verifier（第三次派出，分支 `cursor/cloud-sync-sota-r10-verifier-b343`）

模型 claude-fable-5-thinking-high。关闭 FINDINGS-R07 P2-2 / R01-P2 同根项（KDF 参数无上限，FINDINGS-R07 · PROTOCOL-R10 · KEY-ROTATION-R11 §6 三方共同确认），并补「云端标记被删后不得默许明文上传」的本机第二道门禁。交付：

- **KDF 参数应用级上限（P2-2 关闭）**：`crypto/backup_crypto.rs` 新增 `KDF_MAX_M_COST_KIB = 1 GiB` / `KDF_MAX_T_COST = 16` / `KDF_MAX_P_COST = 8`（取值依据注释在常量处：默认写入面 64 MiB/3/4 的 16×/5×/2×，只许向上放宽），`ensure_kdf_params_within_app_limits` 作为 `derive_key` 第一步——校验子复算、DSBK v1/v2 解密头、`FileCipherSession` 全部经此单一入口，超限在派生开始前 `Err`（fail-closed，与未知 KDF 同路），错误为用户级文案 `KDF_PARAMS_REJECTED_MESSAGE`（不含内部参数值、不提内部实现）。
- **本机「云端目录曾经加密」记忆**：`backup_crypto.rs` 新增 `EncryptedRootMemory`——按 `instance_binding_hint` 的域分隔 SHA-256 指纹（本地不落明文 endpoint/用户名）记录该云 root 曾加密，默认落 `<app_data_dir>/.cloud-encrypted-roots.json`；`sync_manager.rs` 最小接线（两处策略入口成功后登记 + `ensure_plaintext_upload_allowed` 在云端标记缺失时查询本机记忆，命中即拒明文并给出可操作文案）。语义边界：只影响本机明文上传判定，不影响加密上传（标记缺失时照常用本机密码重新登记）与其他设备。记忆文件损坏按「曾加密」处理（fail-closed）。
- **测试**：新文件 `src-tauri/tests/sync_r10_verifier.rs`（合法默认/历史参数照常、三参数超限派生前亚秒 Err、DSBK v1/v2 头超限拒且不建输出文件、标记内超限校验子上传前失败且云端零写入、删标记后本机明文被拒/重启仍拒/加密照常/按 root 隔离/明文拦截补写记忆）；`backup_crypto.rs` 内联单测 6 例；`sync_r10_protocol_locks.rs` 3 号用例按其自述改写为断言钳制边界（2 号用例语义不变）。
- **台账**：FINDINGS-R07 顶部状态表与 P2-2 正文回写、PROTOCOL-R10 结论摘要处补回写块（历史行留档不改）、用户指南 16 解锁小节补一句本机记忆说明。

**文件面认领（独占）**：`crypto/backup_crypto.rs`（上限 + 记忆存储 + 单测）、`cloud_storage/sync_manager.rs` 最小接线（结构体字段/默认构造/两处策略入口/明文门禁；不动 R11-lease 关注的上传/下载/manifest 段）、`src-tauri/tests/sync_r10_verifier.rs` 新文件、`sync_r10_protocol_locks.rs` 2/3 号用例、FINDINGS-R07 / PROTOCOL-R10 回写、用户指南 16 一句、本节。不改 RecordConflictsPanel / ftp.rs / notes / chat / workbench。KEY-ROTATION-R11 §7 的 T1（R12-kdf-clamp）中「前端错误映射 + locale 新键」半边未做（后端错误文案已直接面向用户），错误码机制统一仍归 R11-android2 交付物 ④。

**顺带发现的基线遗留红灯（非本包引入，已在基线 `d46eff78` 上复现确认）**：① `sync_file_level_e2ee.rs::r07_legacy_plaintext_blob_downloads_but_substitution_is_rejected` 失败（`downloaded=0`，历史明文 blob 未被下载——疑与近期合入改动了明文遗留下载语义有关，待认领排查）；② `sync_r11_repo_check.rs` 编译失败（E0117 孤儿规则：`impl CloudStorage for Arc<MemoryStorage>`，需按其他测试文件的 newtype 模式修复，归 R11-check 文件面）。

### R11-history（分支 `cursor/cloud-sync-sota-r11-history-b343`，记录级时点恢复最小版）

模型 claude-fable-5-thinking-high。GAP-8 最小闭环：快照只在本地表 `__sync_record_history`（`__` 前缀不进变更采集、不上云），批量覆盖类危险操作执行前自动快照、事后单批回退。交付：

- **实现**：新文件 `data_governance/sync/history.rs`——快照表（批次 id + reason + existed + data_json + rolled_back_at，批内 (table, record) 去重保首次）、`snapshot_record[_with_data]`、`list_batches`、`rollback_batch`（恢复/复活/删除三形态；`suppress_change_log=false` + 刷新 `updated_at`，回退结果进 change_log 待上传且旧云端值输掉 LWW 门；回退前自动建 `rollback_undo` 撤销点批次；同批只回退一次）、保留策略 `prune_batches_to_cap`（每库 50 批上限，新批落地自动清最旧）。
- **命令**（`commands_sync.rs` 末尾只加新命令，未改任何既有签名）：`data_governance_list_sync_snapshot_batches`（只读）、`data_governance_rollback_sync_snapshot_batch`（维护模式检查 + 全局锁）。注册于 `lib.rs` / `data_governance/mod.rs` / `permissions/application-commands.toml`。
- **UI**：`RecordConflictsPanel.tsx` 只加撤销入口——头部「可撤销」人话提示 + 底部「自动快照」区（批次列表 / 两击确认单批回退），未改已合入的 cloud-only keep_local 行为与任何既有回调。
- **locale**：`data.json`（zh/en）`governance.snapshot_*` 13 键、`sync.json`（zh/en）`record_conflict_panel.undoable_hint`。
- **测试**：新文件 `src-tauri/tests/sync_r11_history.rs` 8 例——策略覆盖前快照 / Local 胜不产噪音批次 / 批内去重保首态 / 回退恢复 + 留待上传 + 拒重复回退 / **回退不被普通 LWW 重放与 KeepLatest 重放再覆盖、回声抑制不吞回退的待上传条目** / DELETE 覆盖→复活→回退撤销点再删除全链 / 保留策略钳制 + 显式收紧 / 命令端到端（resolve 快照 → 列表可见 → 回退命令恢复）。

#### Round 11 实现改动登记（R11-history）

- **R11-history → `conflict_resolver.rs` 快照挂钩段**：`ConflictResolver` 新增 `history_batch_id` 字段（`new()` 生成，一次 conflict guard 调用 = 一个批次），`resolve_one` 在裁决 **Cloud 胜**（本地行将被覆盖/删除）的两个分支（DELETE / UPSERT）返回 outcome 之前调用 `snapshot_local_before_overwrite` 落快照；快照失败即该条变更失败（fail-closed：没有可回退的快照就不允许覆盖）。Local 胜不快照（本地行未被改动，避免噪音批次）。未改 `resolve_one` / `save_conflict_record` 的既有签名与裁决语义。
- **R11-history → `commands_sync.rs` 的 `data_governance_resolve_record_conflict`**（签名未动，preflight 闭包内加一段）：写回业务表的事务内、generation 校验通过后，把被覆盖记录当前状态快照为 `conflict_resolve` 批次。`already_in_desired_state` 早退路径（业务行不变、只标记冲突已解决）不快照——没有可回退的改动。前端批量解决是 N 次顺序调用，即 N 个可独立回退的批次。

**文件面认领（独占）**：`data_governance/sync/history.rs` 新文件、`sync/mod.rs`（仅 `pub mod history;` 一行）、`conflict_resolver.rs` 快照挂钩段（上文已登记）、`commands_sync.rs` 时点恢复命令段 + resolve preflight 快照段（上文已登记）、`lib.rs` 注册两行、`data_governance/mod.rs` re-export 两行、`permissions/application-commands.toml` 两行、`RecordConflictsPanel.tsx` 撤销入口、`data.json` / `sync.json`（zh/en）上述新键、`api/dataGovernance.ts` 两个包装、`sync_r11_history.rs` 新文件、本节。与 R11-unsynced-ui / R11-check 的 `commands_sync.rs` 各自新段无交叠（推前 rebase 消解）。

**已知基线红灯（非本包引入）**：`sync_scenarios_tests.rs` 5 个 blob tombstone 场景（scenario_35/37/57/58/59）因基线 `c006f457` 收紧 tombstone hash 校验（拒绝非 64 位 hex 的 `"ab123"`）而失败，`a5333474` 只修了单测未跟进场景测；本分支文件面不含 `tombstone.rs`，留待专路修复。本分支已验证通过：`--lib data_governance::sync::` 191 例、`sync_r05_regression` / `sync_r06_delete_resolve` / `sync_r07_delete_resolve_lock` / `sync_r10_protocol_locks` / `sync_integration_deep` / `sync_r11_history` 全绿。

## Round 12 回传（增量登记）

### R12-repocheck-fix（分支 `cursor/cloud-sync-sota-r12-repocheck-fix-b343`，FINDINGS-R11 P1-1 修复）

模型 claude-fable-5-thinking-high。修复 R11-check 的 DSBK v2 头解析偏移错误（加密仓库约 98.4% 误报「头不可解」）。交付：

- **① 偏移修正 + SSOT 化**：`cloud_storage/repo_check.rs` 的 DSBK 布局常量不再本地复制——v2 头长 48→**44**、chunk 读取 `head[44..48]`→**`head[40..44)`**、v2 最小体积 64→**60**，全部改为引用 `crypto/backup_crypto.rs` 新导出的容器布局 SSOT 常量（`DSBK_MAGIC` / `DSBK_V1_HEADER_LEN` / `DSBK_V2_HEADER_LEN` / `DSBK_V2_CHUNK_OFFSET` / `DSBK_GCM_TAG_LEN` / `DSBK_MAX_PLAINTEXT_CHUNK`），杜绝再次复制错偏移。
- **② 测试改真实 fixture**：`sync_r11_repo_check.rs` 的加密对象 fixture 从手写 48 字节错偏移假头改为**真实 `encrypt_backup_file` 产物**；`repo_check.rs` 单测段补真实产物头核查与 60–63 字节不误报截断边界（FINDINGS-R11 §3.2 三断言全落）。
- **③ E0117 顺带修**：`sync_r11_repo_check.rs` 的 `impl CloudStorage for Arc<MemoryStorage>`（孤儿规则，基线编译红灯，R10-verifier 曾登记）按其他测试文件先例改 newtype `SharedStorage(Arc<MemoryStorage>)`。
- **④ 台账回写**：FINDINGS-R11 P1-1 置已关、本文件 R11-check 节状态更新、R10-verifier 节红灯 ② 销项。用户指南 16 巡检小节复核无「头长 48」类字节数表述，无需改。

**实现改动登记（backup_crypto.rs，按规则先登记）**：`crypto/backup_crypto.rs` **只新增 DSBK 容器布局 pub 常量导出与布局锁定单测**（常量值锚定真实 `encrypt_backup` / `encrypt_backup_file` 产物长度），不改 KDF 钳制、加解密与记忆存储的任何逻辑。

**文件面认领（独占）**：`cloud_storage/repo_check.rs`、`src-tauri/tests/sync_r11_repo_check.rs`、`crypto/backup_crypto.rs`（仅上述常量段 + 单测）、FINDINGS-R11 回写、本节。不改 `sync_manager.rs` / notes / chat / workbench。

### R11-unsynced-ui（分支 `cursor/cloud-sync-sota-r11-unsynced-ui-b343`，未同步文件清单常驻面板）

模型 claude-fable-5-thinking-high。Dropbox 档「未同步文件清单」一整包。交付：

- **后端只读命令（新增，不改既有签名）**：`commands_sync.rs` 末尾新增独立段 `data_governance_list_unsynced_items`——对照云端 blob / 资产清单与本地文件，把「云端有、本地没有」的对象按原因分类：`downloadPending`（download_failures 对应对象：下载失败或尚未下载）、`legacyPlaintext`（本端启用 E2EE 后防降级拒收的明文遗留对象）、`caseConflict`（大小写槽位被占跳过下载）、`sanitizedNameConflict`（净化后重名且内容不同）、`invalidKey`（key 结构非法/越界）。**只读契约**：对云端只 GET/LIST、对本地只探测存在性；tombstone 已删除条目不计入；清单列表截断时如实报错拒绝出报告。清单解码复用 `SyncManager` 公开实现的 `tombstone::PayloadCodec`（不复制加密逻辑）；清单 key 布局常量与分类语义按 `repo_check.rs` 先例在新段内镜像 `sync/mod.rs`（净化等价视图 / casefold 槽位 / 密文优先合并），并注明来源——**未改 `sync/mod.rs`**（本轮其他代理文件面）。条目上限 500，超出置 `items_truncated` 并保留全量计数。段尾新增 `unsynced_items_tests` 单测 4 例（blob 三态分类+非法路径、资产大小写/净化/非法 key 分类、密文条目合并不被明文降级、资产 revision 合并）。
- **前端**：新文件 `data-governance/UnsyncedItemsPanel.tsx` 常驻面板——自取云配置（`resolveCloudStorageConfig`，未配置不发查询）、按类别分组展示，每组人话原因 + 可执行建议（重试下载 / 源设备重传加密 / 改名），冲突类条目展示冲突对方 key，技术细节折叠保留；downloadPending 组带「重试下载同步」按钮。`SyncTab.tsx` **仅加挂载行**（import + 挂载两行，`onRetrySync` 接 `onRunSync("download", syncStrategy)`），classifySyncError / classifySyncE2eeError 双轨未动。
- **locale**：`sync.json`（zh/en）新增 `unsynced.*`（含五类 `kind.*.{label,reason,suggestion}`）。
- **测试**：新文件 `tests/vitest/data-governance/r11-unsynced-items-panel.test.tsx`（空态/未配置/多类目/截断/重试动作/失败重试/locale 契约，10 例）与 `r11-unsynced-mount.test.tsx`（SyncTab 挂载行锁定 3 例）。

**文件面认领（独占）**：`UnsyncedItemsPanel.tsx` 新文件、`SyncTab.tsx` 挂载行（import + 挂载）、`sync.json`（zh/en）`unsynced.*`、`commands_sync.rs` 未同步查询段（只加不改，含段尾新测试模块）、`lib.rs` 注册一行、`data_governance/mod.rs` re-export 一行、`permissions/application-commands.toml` 一行、`r11-unsynced-*.test.tsx` 两个新文件、本节。与 R11-check 的 `commands_sync.rs` 巡检段各自只加新段无交叠；未动 RecordConflictsPanel / repo_check / notes / chat / workbench。

### R10-providers（分支 `cursor/cloud-sync-sota-r10-providers-b343`，WebDAV 非续传下载字节数核对）

模型 claude-fable-5-thinking-high。关闭 FINDINGS-R11 §2 P2-2：WebDAV 非续传 `get_file` 是四条 provider 下载路径中唯一无字节数核对的（S3/FTP/默认实现自 R10-download 起均有）。交付：

- **实现**：`cloud_storage/webdav.rs::get_file` 在流 EOF 后（flush/sync 之后、checksum 比对之前）校验 `downloaded == total_size`，不一致即 fail-closed，错误文案与 S3 同形态（「WebDAV 下载不完整或对象已变更：声明 N 字节，实际收到 M 字节，已拒绝保存（请重试）」）。同时覆盖「对象在 stat（PROPFIND）与 GET 之间被并发替换成不同大小错版本」形态——该形态传输层不报错，只有此核对能拦下；temp 文件随错误返回自动清理，不落盘。续传路径 `get_file_resumable` 原有 `written != total_size` 拒绝未动。
- **测试**：新文件 `src-tauri/tests/sync_r10_provider_contract.rs` 4 例（进程内假 WebDAV 服务器，与 `webdav_download_resume_tests.rs` 同型）：换小包（传输层完整、Content-Length 一致，仅字节核对可拦）/ 换大包 / 截断流（传输层报错或字节核对拦截皆可，唯一不许当成功）三形态均断言 `Err` + 目标路径与 `.download-*` 临时文件零残留；一致对照例断言内容与返回 SHA256 逐字节正确（不误伤正常下载）。全部以 `expected_checksum=None` 调用（真实调用方 `repo_check.rs` 的形态，无第二道防线）。
- **文档**：用户指南 16 溯源注释补一条——`:80`「所有云端下载都会核对字节数」自此对 WebDAV 非续传路径也成立（此前为超前表述，正文无需改动）；FINDINGS-R11 §2 P2-2 / §3.2 状态回写。

**范围外（明示不做）**：`ftp.rs` 未动——FINDINGS-R11 未对 FTP 提出新增量（上传核对/死代码均无强证据），且 `ftp.rs` 与枝 `cursor/fix-sync-tombstone-db14` 合 main 必冲突，无必要不扩大冲突面；`get_file_decoded` 死代码删除（FINDINGS-R11 P2-1）属 `data_governance/sync/mod.rs`，不在本包文件面，留待认领。

**文件面认领（独占）**：`cloud_storage/webdav.rs`（仅 `get_file` 字节数校验一段）、`src-tauri/tests/sync_r10_provider_contract.rs` 新文件、用户指南 16 溯源注释一条、FINDINGS-R11 P2-2/§3.2 状态回写、本节。不改 `sync_manager.rs` / `repo_check` / `ftp.rs` / RecordConflictsPanel / notes / chat / workbench。
## Round 12 回传（增量登记）

### R12-decoded-dead（分支 `cursor/cloud-sync-sota-r12-decoded-dead-b343`，关 FINDINGS-R11 P2-1）

模型 claude-fable-5-thinking-high。删除文件级下载死代码，堵「启用加密时接受明文」旁路被接回的可能。交付：

- **删除**：`data_governance/sync/mod.rs` 的 `get_file_decoded`（全仓零调用；本端启用加密时接受明文对象，与真实下载路径 `download_file_object` 的防降级门禁语义相悖）连同其唯一消费者 `file_has_dsbk_magic` 一并删除，原位置留墓碑注释（指向 `download_file_object` 与本锁定测）。不改 `download_file_object` / vfs_blobs 加密门禁本身（FileCipherSession 已合入，未动）。
- **锁定测**：新文件 `src-tauri/tests/sync_r12_decoded_dead.rs` 3 例——① `src/` 全树无 `get_file_decoded` / `file_has_dsbk_magic` 的定义或调用（只匹配代码形态，允许注释提名）；② 墓碑注释存活；③ `download_file_object` 明文遗留分支（`cipher_sha256=None`）的 `encryption_enabled()` 拒收门禁与错误文案存活。全部只读源码，不触网不建库。
- **论据更正**：`sync_r10_download.rs` 模块文档与「半包必须失败」用例注释中「`expected=None` 调用方」由死函数改为真实调用方 `repo_check.rs`（巡检下载）；本文件 R10-download 节同句更正；PROTOCOL-R10 R07-file-e2ee 段 b) 的下载侧引用由 `get_file_decoded` 改指 `download_file_object`。
- **台账回写**：FINDINGS-R11 §2 P2-1 状态更新（已关）、§3.2 表 P2-1 行、§5 去向 5 号划线；本文件 Round 11 待修表 P2-1 行标已关。

**文件面认领（独占）**：`data_governance/sync/mod.rs`（仅删两函数 + 墓碑注释）、`sync_r10_download.rs`（仅两处注释）、`sync_r12_decoded_dead.rs` 新文件、FINDINGS-R11 三处回写、PROTOCOL-R10 一句、本文件 R10-download 节一句 + 待修表一行 + 本节。不改 vfs_blobs / repo_check / webdav / notes / chat / workbench。

### R11-android2（分支 `cursor/cloud-sync-sota-wrap-android2-b343`，Android 收尾一整包）

模型：`gpt-5.6-sol-xhigh-fast`。交付：

- **Android 手册 + SAF 审计**：新增
  [ANDROID-HANDBOOK-R11.md](./ANDROID-HANDBOOK-R11.md)，覆盖 WebDAV 配置与
  A→B→A 记录同步、云端部分归档的诚实恢复边界、SAF 加密全保真 ZIP
  导出→导入→A/B 槽恢复→重启、强杀/断网/ENOSPC 矩阵及真机签字模板。
  如实登记 8 项 SAF/重启缺口：真机 ContentResolver 自动化、persistable URI grant、
  目标回读 SHA256、空间预检、OpenableColumns 元数据、双重编码 URI、真实 restart、
  受控 MainActivity 与生成工程同步门禁。宿主测不能冒充真机绿灯。
- **mobile-slim + S3 依赖评估**：对 lockfile 的
  `aarch64-linux-android` resolve 图实测，`mobile-slim` 705 节点，
  加 `cloud_storage_s3` 后 732，增 **27（3.8%）**，其中 AWS/Smithy 20。
  没有同工具链 paired APK，故不伪造 APK MB 数；保留 WebDAV-only，列出后续 APK /
  `.so` / RSS / 真机 provider 契约门槛。
- **P2-LOCALE-PLATFORM-MSG 机制半边关闭**：后端新增稳定 code
  `E_FTP_UNSUPPORTED_ON_ANDROID` / `E_S3_UNSUPPORTED_IN_BUILD`。
  `CloudStorageConfigError` 在 validate 路径携码，`create_storage` 的 AppError
  在 `details.code` 携码，SSOT save/get 改发标准 `CommandError {code,message}`。
  `cloudStorageApi` 在 legacy 包装时保留 code，`CloudStorageSection` 只按 code
  选择 R10 已落的 zh/en locale 键，删除 FTP/S3 message 正则；message 可任意改写。
- **测试**：更新 `sync_android_device_switch.rs`，锁定 validate/create/SSOT
  save+load 的 code；更新 R10 UI 映射测为 code 契约；新增
  `r11-android-platform-error-codes.test.ts`，覆盖 Rust↔TS 常量、对象/JSON envelope、
  legacy AppError.details、message 改写与未知 code 不误映射。

**文件面增量登记**：除 ROUND-11 原列的手册、`CloudStorageSection.tsx`、
`sync_android_device_switch.rs` 与 vitest 外，为让四条后端路径真正携码，本包最小改动
`cloud_config_commands.rs`、`cloud_storage/config.rs`、`cloud_storage/mod.rs`；
为防既有 API wrapper 丢码，改 `src/utils/cloudStorageApi.ts`。R10 已有 zh/en
`ftpDisabledAndroid` / `s3DisabledInBuild` 键，无需重复改 locale。未改 notes / chat /
workbench。

### R11-lease（分支 `cursor/cloud-sync-sota-wrap-lease-b343`，sync target 租约收尾）

模型 `gpt-5.6-sol-xhigh-fast`。完成常规记录级同步的云端目标互斥：

- **实现**：新文件 `cloud_storage/sync_lease.rs`。因 `CloudStorage` 无 CAS，采用
  每操作独立 contender + 完整 LIST 确定性选主，不覆盖单一锁文件；pending →
  committed 两阶段回验，复用换机租约的 target / operation / created_at /
  `activation_committed` 形态。默认 TTL 10 分钟，持有期间后台续租；正常退出按
  operation ID 核对删除，崩溃留下的 pending/committed 均由下一轮陈旧回收。
  LIST 截断、读取失败、新鲜损坏锁全部 fail-closed。
- **接线**：`commands_sync.rs` 两个常规同步入口均先校验 `remote format`、再获取
  target 租约；上传/下载/双向全覆盖（下载成功后也会写 cursor/manifest）。
  租约窗口覆盖 E2EE marker、文件/行变更、manifest 与 prune；未改
  `sync_manager.rs`。占用错误稳定包含 `E_SYNC_LEASE_HELD`，满足
  R11-autosync2 的静默跳过契约。
- **UX/文档**：`sync.json`（zh/en）新增 `errors.leaseHeld`；ARCHITECTURE
  新增状态机、TTL 回收、损坏/截断 fail-close 与 format 门槛顺序。
- **测试**：新文件 `src-tauri/tests/sync_r11_lease.rs` 覆盖双设备并发唯一赢家、
  活锁错误码、陈旧锁回收、崩溃 pending 残锁、截断拒绝，以及未来
  `remote_format_version` 在零租约写入状态下拒绝。

**文件面认领（独占）**：`cloud_storage/sync_lease.rs` 新文件、
`cloud_storage/mod.rs` 仅导出一行、`data_governance/commands_sync.rs` 两个入口的
租约窗口接线、`sync.json`（zh/en）`errors.leaseHeld`、`sync_r11_lease.rs`
新文件、ARCHITECTURE 本节、本文件本节。不改 `sync_manager.rs` / notes / chat /
`ftp.rs`。

### 基线遗留红灯收口（tombstone / R07 文件级 E2EE）

- **blob tombstone 场景夹具**：生产 `apply_blob_tombstones` 对 hash 保持
  `len == 64 && ASCII hex` 的整批前置校验，未放宽。复核当前基线后，
  scenario 37/57/58/59 已经通过 `write_content_addressed_blob` 生成真实 SHA-256；
  scenario 35 是最后一处 `"ab123"` 短 hash。现将 scenario 35 也改用同一 helper，
  并在 helper 内显式断言 64-hex，使五个场景继续验证 tombstone 同时删除本地文件与
  云端 blob，而不会用生产已拒绝的非法夹具提前退出。
- **R07 历史明文对象**：生产语义已明确选择防降级拒收，而非兼容下载：
  `sync_vfs_blobs` 在网络下载前拒绝 `encryption_enabled &&
  cipher_sha256.is_none()`，`download_file_object` 对其他文件级调用方保留同一
  fail-closed 门禁。因此把过时的“`downloaded=1`”测试改为真实旧格式夹具
  （AEAD 加密清单 + `cipher_sha256=None` + 明文对象），锁定内容正确的历史明文与
  hash 不符的替换明文均为 `downloaded=0`、进入 `download_failures` 且不落盘。
  未改生产下载路径，也没有恢复任何明文旁路。

### R11-delta（分支 `cursor/cloud-sync-sota-delta-b343`，只做调研与手动合成基准）

交付：

- [DELTA-R11.md](./DELTA-R11.md)：核实当前全量 staging → DEFLATE ZIP → 可选整包
  DSBK → 单个 `backups/<version>.zip` `put_file` 路径；明确当前**不能**宣称增量传输、
  内容去重或 CDC；
- 对内容寻址 objects、manifest 级未变对象跳过、CDC 三条路线逐一分析
  dumb-storage 无 CAS 与 DSBK 随机加密下的可行性、泄露面和恢复语义；
- 推荐先做「完整 snapshot descriptor + 未变逻辑文件 direct ref 复用」，不建
  parent/delta 恢复链；给出 v1/v2 双 namespace、每设备 10 版过渡与
  manifest-first + 两遍候选 GC 顺序；
- 新增手动脚本 `src-tauri/tests/cloud_sync_delta_benchmark.py`：只用临时合成数据、
  不读用户目录、不联网、不进入 Cargo/Vitest 门禁。实跑的 161.824 MiB profile
  在零用户数据变化和 SQLite 一行变化时都仍产生约 144.953 MiB ZIP，证明当前整包
  PUT 没有网络增量性；耗时与外推边界见文档；
- 下一轮拆成 format / inventory / backup lease / upload / restore / GC /
  integration 七个文件面独占任务，CDC 仅保留离线实验路。

**文件面认领（独占）**：`DELTA-R11.md` 新文件、
`src-tauri/tests/cloud_sync_delta_benchmark.py` 新手动脚本、README 索引一行、本节。
不改任何生产代码，不改 `version.ts` / pdfium，不碰 notes / chat / workbench /
`ftp.rs`。

### R11-names2（分支 `cursor/cloud-sync-sota-names2-b343`，资产 key 可逆映射）

- **编码协议**：`asset_filenames.rs` 从 `_` 替换升级为带版本标记的 rclone 风格
  映射。Windows 非法字符使用全角安全码点、C0/DEL 使用 Control Pictures，原本
  就存在的替代字符用 `‛` 引用；Windows 保留名和尾点/空格也进入带标记形态。
  非 NFC 原名使用 `‛eh<utf8-hex>`，所以云 key 自身为 NFC，decoder 仍逐字节还原
  NFD。公开不变量为 `decode_segment(encode_segment(x)) == x`。
- **fail-closed 长度门**：编码前后均核对 UTF-8 字节数与 UTF-16 code unit；
  单段上限 255，完整 `root/top/rel` 资产 key 上限 240。结构异常、损坏标记、
  非规范编码、段/总长越界均在内容读取和云端写入前终止，不截断、不哈希改名。
  `sync_r10_protocol_locks.rs` 的“长度仍未钳制”缺口锁已改为关闭断言。
- **旧 `_` key 兼容策略**：旧 key 无法可靠反推原名，因此不猜测。同步器按
  “新可逆 key exact → 旧未编码原名 → R09 `_` key”双代际查找；若 `_` key
  同时是另一份本地文件的 exact key，exact 优先；多个候选仅允许唯一内容匹配者
  认领。内容未变保留旧 key 且不旁落副本，内容更新时新清单写可逆 key 并移除旧
  别名。新旧 key 云端同时存在时保留为两个条目，避免把真实下划线误判成旧映射。
- **测试与人话**：更新 `sync_r09_filenames.rs`、两份 R07 names/filename 回归与
  长度协议锁，覆盖非法字符/替代字符碰撞、保留名、尾点空格、大小写、NFC/NFD、
  旧 key 双查找迁移、新旧共存、恶意/超长 key 零落盘。zh/en `sync.json` 将
  “净化后重名”改为“旧版文件名映射冲突”，明确新版可逆、旧版原名不可猜。

**最小接线登记**：为让长度错误可传播且防 Unix 反斜杠文件名被误拆段，
`data_governance/sync/mod.rs` 仅改资产扫描 key 生成、云 key fail-close 和旧 key
双查找/迁移段；未改 `cloud_storage/sync_manager.rs`，未触碰 notes / chat /
workbench / `ftp.rs` / 增量备份 / 租约。

## Round 13（收口 P2 + 增量 codec，2026-08-24）

父代理不改业务逻辑。三路文件面独占，禁止互相改对方文件。

| 代理 | 分支 | 范围 | 文件面（独占） |
|---|---|---|---|
| wrap-conflict | `cursor/cloud-sync-sota-wrap-conflict-b343` | FINDINGS-WRAP P2-2：`already_in_desired_state` 快速路径在 `BEGIN IMMEDIATE` 内重读业务行；不再匹配则 fail-closed 拒绝标 resolved | `commands_sync.rs` 仅 resolve 快速路径段；`sync_r10_protocol_locks.rs` 的 P2-3 源码锁改写为「已关」断言；新 `src-tauri/tests/sync_r12_conflict_fast_path.rs` |
| wrap-v1trust | `cursor/cloud-sync-sota-wrap-v1trust-b343` | FINDINGS-WRAP P2-1：v1 无校验子标记升级前试解一份既有备份；列表截断/下载失败 fail-closed；空仓仍允许第一台带密码设备认领 | `sync_manager.rs` 仅 `verify_encryption_password_before_upload` 的 v1 升级臂；新 `src-tauri/tests/sync_r12_v1_marker_trust.rs`。**禁止**改 `sync_r10_protocol_locks.rs` / `sync_r09_file_e2ee.rs`（空仓升级既有用例必须继续通过） |
| delta-format | `cursor/cloud-sync-sota-delta-format-b343` | DELTA-R11 R12-delta-format：`SnapshotDescriptorV2` / object ref / repo config codec + 上限 + 未来版本 fail-closed；**不接上传/恢复/UI** | 新 `cloud_storage/delta_format.rs`；`cloud_storage/mod.rs` 仅 `pub mod delta_format;` 一行；新 `src-tauri/tests/sync_r12_delta_format.rs` |

不碰 `ftp.rs` / notes / chat / workbench / `version.ts` / pdfium。不放松 fail-closed。

### wrap-conflict 回传（分支 `cursor/cloud-sync-sota-wrap-conflict-b343`，关 FINDINGS-WRAP P2-2 / PROTOCOL-R10 P2-3）

首轮同名任务因环境不可达失败，本轮从 `origin/cursor/cloud-sync-sota-b343` @ `5440d582` 重做。交付：

- **实现**：`commands_sync.rs` resolve 快速路径在 `BEGIN IMMEDIATE` 后、标记 resolved 前用 `SyncManager::get_record_data` 事务内重读业务行，按同一套 `(operation, data)` 重算 already-desired；不再匹配即拒绝（「本地记录在冲突确认期间已变化，请刷新后重新确认」），不用旧快照标 resolved。generation 重验保留，慢速路径语义未动。
- **测试**：`sync_r10_protocol_locks.rs` P2-3 源码锁按其自述改写为「已关」断言（重读存在、位于标记之前、fail-closed 文案在），P2-1 / KDF 用例未动；新 `sync_r12_conflict_fast_path.rs` 两例——业务行未变时快速路径照常标 resolved（重读不误伤）、并发写锁窗口内的本地编辑被事务内重读拦下（冲突保持未解决、新编辑保留）。

### wrap-v1trust 回传（分支 `cursor/cloud-sync-sota-wrap-v1trust-b343`，关 FINDINGS-WRAP P2-1）

- **实现**：`verify_encryption_password_before_upload` 的 v1 升级臂先经 manifest 取最新备份，走现有 `decrypt_backup_file` 完整试解；成功才写 v2 校验子（保留 created_by/created_at）。空仓无备份保持第一台带密码设备认领。列表/下载/半包/非 DSBK/解密失败均不改标记。
- **测试**：新 `sync_r12_v1_marker_trust.rs`。未改 `sync_r10_protocol_locks.rs` / `sync_r09_file_e2ee.rs`。

### delta-format 回传（分支 `cursor/cloud-sync-sota-delta-format-b343`，codec only）

前两轮环境不可达。第三轮从 `b2716f21` 交付：`delta_format.rs` + `sync_r12_delta_format.rs` 15 例；`mod.rs` 仅 `pub mod delta_format;`。**未接线**，不能宣称增量备份已实现。

## Round 14（增量下一刀，codec 之后，仍不接上传）

| 代理 | 分支 | 范围 | 文件面（独占） |
|---|---|---|---|
| delta-inventory | `cursor/cloud-sync-sota-delta-inventory-b343` | 从已验证 staging 生成规范文件表；volatile manifest 字段不进复用比较；输出可喂给 `SnapshotFileRefV2` 的 path/size/hash | 新 `data_governance/backup/delta_inventory.rs`；`backup/mod.rs` 仅 `pub mod delta_inventory;`；新 `src-tauri/tests/sync_r12_delta_inventory.rs` |
| delta-lease | `cursor/cloud-sync-sota-delta-lease-b343` | backup-v2/GC 独立租约（contender、TTL、截断/损坏 fail-closed）；**不**复用记录级 `sync-target` namespace | 新 `cloud_storage/backup_lease.rs`；`cloud_storage/mod.rs` 仅 `pub mod backup_lease;`；新 `src-tauri/tests/sync_r12_backup_lease.rs` |

两路都禁止改 `sync_manager.rs` / `delta_format.rs` / `ftp.rs` / notes / chat / workbench。写完立刻 push，不要开 PR。不能宣称增量备份已实现。

### delta-inventory 回传（`cursor/cloud-sync-sota-delta-inventory-b343`）

`delta_inventory.rs`：磁盘 hash 为准、manifest 交叉核对、volatile 字段不进 reuse_candidates、`diff` 产出 reuse/upload-new/deleted。未分配 object_key，未接线。

### delta-lease 回传（`cursor/cloud-sync-sota-delta-lease-b343`）

`backup_lease.rs`：`backup-v2/locks/` + `E_BACKUP_LEASE_HELD`；不复用 sync-target。零生产接线。

## Round 15（增量 upload 积木，仍不接命令/UI）

| 代理 | 分支 | 范围 | 文件面（独占） |
|---|---|---|---|
| delta-upload | `cursor/cloud-sync-sota-delta-upload-b343` | DELTA-R11 R12-delta-upload：随机不可变对象、同设备上一 descriptor 未变复用、objects→descriptor→manifest commit、失败留孤儿；不做 GC；**不接命令/UI** | 新 `cloud_storage/delta_upload.rs`；`cloud_storage/mod.rs` 仅 `pub mod delta_upload;`；新 `src-tauri/tests/sync_r12_delta_upload.rs` |

禁止改 `sync_manager.rs` / `delta_format.rs` / `delta_inventory.rs` / `backup_lease.rs` / `ftp.rs` / notes / chat / workbench。写完立刻 push，不要开 PR。不能宣称增量备份已实现。

### delta-upload 回传（`cursor/cloud-sync-sota-delta-upload-b343` @ `f65b8ecc`）

`delta_upload.rs`：`publish_verified_staging` 持 backup-v2 租约，随机不可变对象、同设备 `reuse_candidates` 复用、objects→descriptor→index commit，失败留孤儿。`mod.rs` 仅 `pub mod delta_upload;`。测试 `sync_r12_delta_upload.rs` 11 例。**未接线**，不能宣称增量备份已实现。

父代理合入后将 inventory / lease 源码锁放行 `delta_upload.rs`（仍禁止 `sync_manager` / 命令 / UI）。

## Round 16（增量 restore 积木，仍不接命令/UI）

| 代理 | 分支 | 范围 | 文件面（独占） |
|---|---|---|---|
| delta-restore | `cursor/cloud-sync-sota-delta-restore-b343` | DELTA-R11 R12-delta-restore：v2 下载、三层校验、完整 staging/兼容 ZIP 物化、缺对象不触活动槽；不做 GC；**不接命令/UI** | 新 `cloud_storage/delta_restore.rs`；`cloud_storage/mod.rs` 仅 `pub mod delta_restore;`；新 `src-tauri/tests/sync_r12_delta_restore.rs` |

禁止改 `sync_manager.rs` / `delta_format.rs` / `delta_inventory.rs` / `delta_upload.rs` / `backup_lease.rs` / `ftp.rs` / notes / chat / workbench。写完立刻 push，不要开 PR。不能宣称增量备份已实现。

### delta-restore 回传（`cursor/cloud-sync-sota-delta-restore-b343` @ `a58e70f3`）

`delta_restore.rs`：`restore_snapshot_to_staging` 持 backup-v2 租约；三层校验（传输 SHA / AEAD / 明文 hash+size）后原子改名进空 dest；缺/坏对象 dest 为空；可选兼容 ZIP 先临时再 persist。上游 API 经钉死的 `delta_restore_upstream.rs.in` `include!` 复用（避免复制租约协议，同时不改既有 sibling 源码锁）。测试 `sync_r12_delta_restore.rs`（明文/复用/E2EE/缺对象/换包/损坏/租约/ZIP/源码锁）。**未接线**，不碰 A/B 槽，不能宣称增量备份已实现。

## Round 17（增量 GC 积木，仍不接命令/UI）

| 代理 | 分支 | 范围 | 文件面（独占） |
|---|---|---|---|
| delta-gc | `cursor/cloud-sync-sota-delta-gc-b343` | DELTA-R11 R12-delta-gc：合并所有 v2 device manifests、两遍 candidate/grace GC、截断/并发/崩溃注入；共享对象绝不误删；**不接命令/UI** | 新 `cloud_storage/delta_gc.rs`；`cloud_storage/mod.rs` 仅 `pub mod delta_gc;`；新 `src-tauri/tests/sync_r12_delta_gc.rs` |

禁止改 `sync_manager.rs` / `delta_format.rs` / `delta_inventory.rs` / `delta_upload.rs` / `delta_restore.rs` / `backup_lease.rs` / `ftp.rs` / notes / chat / workbench。写完立刻 push，不要开 PR。不能宣称增量备份已实现。宁留垃圾，不删仍被引用的对象。

### delta-gc 回传（`cursor/cloud-sync-sota-delta-gc-b343` @ `07655585`）

`delta_gc.rs`：`collect_gc_candidates` 与 `sweep_gc_candidates` 必须分两次独立全扫描；LIST 截断 / descriptor 失败 → 零删除零写 candidate；`config.dsbk` 永不删；共享对象按全仓 live set 保留；grace 未满不删。上游 API 经 `delta_gc_upstream.rs.in`。测试 `sync_r12_delta_gc.rs` 9 例。**未接线**，不能宣称增量备份 / 增量 GC 已实现。

## Round 18（只审合修复/文档，不接 integration）

### tombstone-port（分支 `cursor/cloud-sync-sota-tombstone-port-b343` @ `06e82848`）

对照并行枝 `fix-sync-tombstone-db14` 审过：产品语义是 fail-closed（共享内容对象不得随 tombstone 物理删除）。专属枝 FTP 父目录 550 已幂等，**不**合原枝 `ftp.rs`（会放松 550 白名单）。

移植到 `5aab188a`：`download_assets_manifest_before_tombstones` 仅供 tombstone 应用；内容寻址对象显式 skip delete；legacy `data_governance/assets/` 仍删。锁定测 `asset_tombstone_resolves_object_key_and_keeps_shared_content_object`（本机 1 绿）。

### licenses notices（不改 lockfile）

Frontend `licenses:check` 红是 `Cargo.lock` SHA 与 `THIRD_PARTY_NOTICES.txt` 不同步（R09-names 加入 `unicode-normalization@0.1.25`）。按现有锁文件重生成声明；**未改** `Cargo.lock` / `package-lock.json`。
