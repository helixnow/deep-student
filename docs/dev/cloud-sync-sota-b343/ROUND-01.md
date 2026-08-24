# Round 01 — 只读调研（10 个 Fable xhigh）

模型约定：调研子代理使用 `claude-fable-5-thinking-xhigh`。禁止静默降级。

本轮只读，不改业务代码。每个子代理必须返回：

1. 第一行自报实际模型 slug
2. 现状（结合真实文件与数据结构，禁止空泛）
3. 与 SOTA 的差距（可点名对照产品/协议）
4. P0 / P1 / P2 问题清单（含路径 + 函数/表名）
5. 建议修复顺序（不在本轮落地）
6. 建议的极端测试用例

## 子代理分工

| ID | 主题 | 重点入口 |
|---|---|---|
| A | 记录级同步引擎 | `src-tauri/src/data_governance/sync/mod.rs`、`hlc.rs`、`conflict_resolver.rs`、`field_merge.rs`、`state.rs` |
| B | Tombstone / 隔离区 / 幂等回放 | `sync/tombstone.rs`、`classification.rs`、`commands_sync.rs`、既有 `fix-sync-tombstone` 枝只对照不改 |
| C | 备份 / 恢复 / A-B 槽 / ZIP | `data_governance/backup/**`、`commands_backup.rs`、`commands_restore.rs`、`commands_zip.rs`、`backup_job_manager.rs` |
| D | 端到端加密与凭据 | `crypto/backup_crypto.rs`、`secure_store.rs` 云凭据、`cloud_config_commands.rs` |
| E | WebDAV 供应商完备性 | `cloud_storage/webdav.rs`、`traits.rs`、坚果云 / Nextcloud / 自建 |
| F | S3 / R2 / OSS / MinIO | `cloud_storage/s3.rs`、feature gate、`mobile-slim` 无 S3 |
| G | FTP 实验风险与 Android 缺口 | `cloud_storage/ftp.rs`、Android cfg、UI 实验警告 |
| H | 前端数据治理 UI/UX | `SyncTab.tsx`、`BackupTab.tsx`、`CloudStorageSection.tsx`、`SyncQuarantinePanel.tsx`、i18n |
| I | 跨平台 / 跨版本 / 设备身份 | device_id 轮换、migration、`mobile-slim`、Windows/macOS/Linux/Android |
| J | 测试矩阵与生产混沌缺口 | `src-tauri/tests/sync_*.rs`、`tests/vitest/data-governance/**`、`dstu-test` E2E skill |

## 必须回答的跨切问题

- 半配置状态（safe config 在、secure credential 不在）是否会被 UI 画成健康？
- 远端 list 截断是否可能被当成删除？
- 多包重复下载会不会放大 `__change_log`？
- 加密备份在“上传端加密、下载端未填密码 / 填错密码”时是否安全失败？
- 恢复后 device_id / 凭据 / 后续同步是否仍正确？
- Android 用户能否完成“桌面 S3 备份 → 手机恢复”？
- 冲突计数：后端 `conflicts=N`、UI、SQLite `__sync_conflicts` 三者是否一致？
- 跨 schema 版本恢复：旧备份进新客户端、新备份进旧客户端分别怎样？

## 产出落点

子代理结果由父代理汇总到：

- `FINDINGS-R01.md`（本轮发现）
- `FIX-QUEUE.md`（按优先级排队，供 R02 修复子代理认领）
