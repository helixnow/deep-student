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

- **S3/FTP 半包当成功（确认存在，已修）**：`s3.rs::get_file` 与 `ftp.rs::stream_to_file`（`get` / `get_file` 共用）都以"流读到 EOF"为完成信号，从不核对实际字节数与云端声明大小。备份下载路径因带 `version.checksum` 有第二道防线，但 `data_governance/sync/mod.rs` 的 `get_file_decoded` 以 `expected=None` 调 `get_file`，FTP 数据通道被中间设备掐断（EOF 与正常结束不可区分）时半包会被 persist 成成功产物。修复：三处（含 `traits.rs` 默认实现）在 EOF 后校验 `downloaded == total_size`，不一致即 fail-closed，同时覆盖"对象在 stat 与 GET 之间被并发替换"的错版本形态；`ftp.rs::get_file` 对 `stat=None` 提前返回 not-found（原实现按 `total_size=0` 继续 RETR）。
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
