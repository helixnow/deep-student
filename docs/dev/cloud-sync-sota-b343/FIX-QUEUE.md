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

## Round 09 登记

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
