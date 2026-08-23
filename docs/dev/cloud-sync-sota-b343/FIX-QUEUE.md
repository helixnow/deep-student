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

## Round 04（认领中）

| 代理 | 模型 | 范围 | 文件面（独占） |
|---|---|---|---|
| R04-delete | claude-fable-5-thinking-high | P0-DEL-PARSE、P1-DEL-LOSE | sync DELETE 应用路径（`sync/mod.rs` DELETE 门 + 冲突表写入）+ 其测试 |
| R04-sync-e2ee | claude-fable-5-thinking-high | P0-SYNC-E2EE | `sync_manager.rs` 标记检查、`decode_payload` 拒明文 + 其测试 |
| R04-qcount | claude-fable-5-thinking-high | P1-QCOUNT | `field_merge.rs` 计数器策略 + 其测试 |
| R04-fold | claude-fable-5-thinking-high | P1-FOLD-POLICY、P2-FOLD-NOOP | `conflict_resolver.rs` fold 归一 + 其测试 |
| R04-android-ftp | claude-fable-5-thinking-high | P1-ANDROID-FTP-SSOT | `cloud_config_commands.rs` 保存校验 + 其测试 |
| R04-e2ee-clear | claude-fable-5-thinking-high | P1-E2EE-CLEAR | 加密密码留空停用语义（后端命令 + 设置面板文案）|
| R04-tomb-dos | claude-fable-5-thinking-high | P1-TOMB-DOS | tombstone 应用路径坏时钟单条隔离 + 其测试 |
| R04-ui-pass | claude-fable-5-thinking-high | P2-UI-PASS | Dashboard/BackupTab 密码入口、`cloudStorage.json`（zh/en）+ 相关 vitest |
| R04-tests | claude-fable-5-thinking-high | 回归与极端测试 | 新测优先放 `src-tauri/tests/` 与 `tests/vitest/data-governance/` |
| R04-docs | claude-fable-5-thinking-high | 本目录进度文档 | `docs/dev/cloud-sync-sota-b343/**`（本枝已推送） |
