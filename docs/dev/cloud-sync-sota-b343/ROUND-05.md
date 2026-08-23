# Round 05 — 极端测试、复审与残留补做（10 个 Fable 子代理）

模型约定：只读复审用 `claude-fable-5-thinking-xhigh`（不可用则明示降级 high）；写代码/测试用 `claude-fable-5-thinking-high`。禁止静默降级；每个子代理回复第一行自报实际 slug。

前置事实：R04 七路修复分支已合入 `cursor/cloud-sync-sota-b343`（见 [FIX-QUEUE](./FIX-QUEUE.md) Round 04 留档）。FINDINGS-R03 十项里九项已有对应合入提交，**P1-ANDROID-FTP-SSOT 未交付**（`cloud_config_commands.rs` 保存路径仍无 Android 拒 FTP 逻辑），转入本轮补做。

## 本轮意图

1. **复核 R04**：独立只读复审七路合入是否真正闭环（DELETE fail-closed、记录级 sync E2EE、fold 归一、计数器、tombstone 隔离、ZIP 密码入口、备份分层默认值），产出 FINDINGS-R05。
2. **补做残留**：P1-ANDROID-FTP-SSOT 后端保存校验；用户指南 16 回写（P2-UI-PASS 已合入，「密码入口后续版本开放」段已过时）。
3. **极端测试**（README 既定 R05+ 范围）：跨平台、双向同步、跨版本 schema、供应商差异。

## 子代理与分支

各自从 `cursor/cloud-sync-sota-b343` 开独立分支，文件面独占（见 [FIX-QUEUE](./FIX-QUEUE.md) Round 05），互不 PR，由父代理统一验收合入。

| 代理 | 模型 | 分支 | 任务 |
|---|---|---|---|
| R05-review | xhigh | `cursor/cloud-sync-sota-r05-review-b343` | 只读复审 R04 七路合入结果，产出 FINDINGS-R05（P0/P1/P2） |
| R05-android-ftp | high | `cursor/cloud-sync-sota-r05-android-ftp-b343` | 补做 P1-ANDROID-FTP-SSOT：`save_cloud_config_ssot` 在 Android 拒存 FTP + 其测试 |
| R05-guide | high | `cursor/cloud-sync-sota-r05-guide-b343` | 用户指南 16 回写：密码入口已开放、备份分层默认值（core+important+assets）、`vfs_blobs` 覆盖警示 |
| R05-clock | high | `cursor/cloud-sync-sota-r05-clock-b343` | 极端测试：时钟漂移 / HLC 因果序 / 慢钟败方可见性（含 R04 后 DELETE 门回归） |
| R05-idempotent | high | `cursor/cloud-sync-sota-r05-idempotent-b343` | 极端测试：重复包幂等、上传中断恢复、断点续传语义 |
| R05-provider | high | `cursor/cloud-sync-sota-r05-provider-b343` | 供应商差异测试：WebDAV 429/限速（坚果云）、S3 分页截断、FTP 截断当删除回归 |
| R05-schema | high | `cursor/cloud-sync-sota-r05-schema-b343` | 跨版本测试：旧版本 ZIP/清单导入当前版本、schema 前后向兼容、未知字段容忍 |
| R05-mobile | high | `cursor/cloud-sync-sota-r05-mobile-b343` | Android 能力面测试：`mobile-slim` 无 S3 / 编译期禁 FTP 下的配置、同步、恢复路径 |
| R05-restore | high | `cursor/cloud-sync-sota-r05-restore-b343` | 恢复极端测试：A/B 槽位切换、错误密码不可静默损坏、半配置凭据恢复 |
| R05-docs | high | `cursor/cloud-sync-sota-r05-docs-b343` | 本目录进度文档（本文件、README、FIX-QUEUE）——本枝已推送 |

拆分说明：R05-android-ftp 独占 `cloud_config_commands.rs`；四个测试代理（clock / idempotent / provider / schema / restore）新测试优先放 `src-tauri/tests/` 与 `tests/vitest/data-governance/` 的**各自新文件**，避免同文件热改；若必须改既有测试文件，先在 FIX-QUEUE 登记。

## 遗留提醒（从 R04 带入）

- **P1-ANDROID-FTP-SSOT 未交付**：R04 计划的 `cursor/cloud-sync-sota-r04-android-ftp-b343` 未见合入；运行时 `config.rs::validate()` 已在 Android 拒 FTP，但 SSOT 保存路径不拒，仍可存出僵尸配置。本轮 R05-android-ftp 补做。
- **用户指南 16 过时**：P2-UI-PASS（`r04-zip-ui`）已合入导出/导入密码入口，但指南仍写「后续版本开放」；R04-backup-defaults 引入的分层导出默认值也未写入。本轮 R05-guide 回写。
- 并行枝 `cursor/fix-sync-tombstone-db14` 仍未进本枝；合 main 时 `ftp.rs` 必冲突，需人工消解（R03 起持续记录，本轮不处理）。

## 合入状态（父代理填写）

已收口：五路分支合入本枝（`r05-android-ftp` / `r05-ftp-i18n` / `r05-tests` / `r05-zip-resume` / `r05-webdav-1k`，另含直接提交），实际留档见 [FIX-QUEUE](./FIX-QUEUE.md) Round 05 与 [FINDINGS-R05](./FINDINGS-R05.md)。R05-guide 未交付转 R06；六路极端测试由 `r05-tests` 部分覆盖，剩余并入 R06。
