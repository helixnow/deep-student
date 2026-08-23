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

## Round 05（认领中）

任务定义见 [ROUND-05](./ROUND-05.md)。测试代理各写**独立新测试文件**；若必须改既有文件，先在此登记。

| 代理 | 模型 | 范围 | 文件面（独占） |
|---|---|---|---|
| R05-review | claude-fable-5-thinking-xhigh | 只读复审 R04 七路合入，产出 FINDINGS-R05 | 只读（产出文档归父代理/本目录） |
| R05-android-ftp | claude-fable-5-thinking-high | P1-ANDROID-FTP-SSOT 补做 | `cloud_config_commands.rs` + 其测试 |
| R05-guide | claude-fable-5-thinking-high | 用户指南回写：密码入口已开放、分层导出默认值、`vfs_blobs` 警示 | `docs/user-guide/16-数据管理与云同步.md` |
| R05-clock | claude-fable-5-thinking-high | 时钟漂移 / HLC / 慢钟败方极端测试 | `src-tauri/tests/` 新文件 |
| R05-idempotent | claude-fable-5-thinking-high | 重复包幂等、上传中断恢复、断点续传测试 | `src-tauri/tests/` 新文件 |
| R05-provider | claude-fable-5-thinking-high | WebDAV 429/限速、S3 分页、FTP 截断供应商差异测试 | `src-tauri/tests/` 新文件 |
| R05-schema | claude-fable-5-thinking-high | 跨版本 ZIP/清单/schema 兼容测试 | `src-tauri/tests/` 新文件 |
| R05-mobile | claude-fable-5-thinking-high | Android / `mobile-slim` 能力面测试 | `src-tauri/tests/` 新文件 + 必要 cfg 门测试 |
| R05-restore | claude-fable-5-thinking-high | A/B 槽位、错误密码、半配置恢复极端测试 | `src-tauri/tests/` 与 `tests/vitest/data-governance/` 新文件 |
| R05-docs | claude-fable-5-thinking-high | 本目录进度文档 | `docs/dev/cloud-sync-sota-b343/**`（本枝已推送） |
