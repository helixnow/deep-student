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

## Round 06（认领中）

任务定义见 [ROUND-06](./ROUND-06.md)。测试代理各写**独立新测试文件**；若必须改既有文件，先在此登记。R06-key-verify 与 R06-asset-e2ee 若需对齐 `.encryption-marker` 新格式接口，先在此登记再动。

| 代理 | 模型 | 范围 | 文件面（独占） |
|---|---|---|---|
| R06-review | claude-fable-5-thinking-xhigh | 只读复审 R05 合入结果，产出 FINDINGS-R06 | 只读（产出文档归父代理/本目录） |
| R06-del-badge | claude-fable-5-thinking-high | 单侧（cloud-only）冲突可解决，败方 DELETE 徽章不永久占位 | `commands_sync.rs` resolve 路径、`conflict_resolver.rs`、`SyncTab.tsx`/Dashboard 徽章调用处、`sync.json`（zh/en）+ 相关测试 |
| R06-asset-e2ee | claude-fable-5-thinking-high | 附件/工作区库上传尊重加密标记（加密或拒传+诚实文案） | `sync_manager.rs` 资产/工作区库上传路径、`cloudStorage.json`（zh/en）+ 相关测试 |
| R06-key-verify | claude-fable-5-thinking-high | 加密标记密钥校验子，错密码 fail-fast 不污染 root（旧标记向后兼容） | `cloud_storage/mod.rs` 标记格式与读写、`crypto/backup_crypto.rs` + 相关测试 |
| R06-autosync | claude-fable-5-thinking-high | 最小自动同步触发（默认关）+ 状态可见 | `data_governance/sync/` 新文件优先、`SyncSettingsSection.tsx`、`syncStatusStore.ts`；locale 键若需 `sync.json` 先在此登记 |
| R06-asset-names | claude-fable-5-thinking-high | 资产文件名跨平台（Win 非法字符、大小写、NFC/NFD）测试与必要净化 | `src-tauri/tests/` 新文件；净化实现落点先在此登记 |
| R06-android | claude-fable-5-thinking-high | Android 换机/重启语义测试（`mobile-slim`） | `src-tauri/tests/` 新文件 + 必要 cfg 门测试 |
| R06-tests | claude-fable-5-thinking-high | 错密码污染、单侧冲突解决、自动同步幂等回归 | `src-tauri/tests/` 与 `tests/vitest/data-governance/` 新文件 |
| R06-guide | claude-fable-5-thinking-high | 用户指南 16 回写（R05 未交付接续 + E2EE 覆盖面诚实说明） | `docs/user-guide/16-数据管理与云同步.md` |
| R06-docs | claude-fable-5-thinking-high | 本目录进度文档 | `docs/dev/cloud-sync-sota-b343/**`（本枝已推送） |
