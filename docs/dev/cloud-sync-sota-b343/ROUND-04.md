# Round 04 — 修复落地（10 个 Fable high）

模型约定：修复子代理使用 `claude-fable-5-thinking-high`。禁止静默降级；每个子代理回复第一行自报实际 slug。

本轮按 [FINDINGS-R03](./FINDINGS-R03.md) 派 10 个修复子代理，各自从 `cursor/cloud-sync-sota-b343` 开独立分支，文件面独占（见 [FIX-QUEUE](./FIX-QUEUE.md)），互不 PR，由父代理统一验收合入。

## 修复意图

- 关掉 R03 发现的两个 P0 残留口子：`changed_at` 不可解析时 DELETE 无条件硬删（P0-DEL-PARSE）、记录级 sync 绕过 `.encryption-marker` 明文写加密 root（P0-SYNC-E2EE）。
- 把冲突语义补完整：败方 DELETE 落冲突表（P1-DEL-LOSE）、Manual/KeepLocal 不再折叠云端 tag、fold 类型归一消除空转写（P1-FOLD-POLICY + P2-FOLD-NOOP）、`questions` 计数器不再被 MaxValue 回弹 `reset_progress`（P1-QCOUNT）。
- 平台与配置诚实：后端 SSOT 在 Android 上拒存 FTP（P1-ANDROID-FTP-SSOT）、加密密码留空可停用（P1-E2EE-CLEAR）。
- 稳健性：文件级坏时钟 tombstone 从整轮硬失败降级为单条隔离（P1-TOMB-DOS）。
- 闭环收尾：给加密全保真 ZIP 接上 Dashboard/导入密码入口（P2-UI-PASS），合入后回写用户指南「当前版本限制」块。

## 子代理与分支

| 代理 | 分支 | 认领项 |
|---|---|---|
| R04-delete | `cursor/cloud-sync-sota-r04-delete-b343` | P0-DEL-PARSE（解析失败 fail-safe，不得无条件硬删）+ P1-DEL-LOSE（败方 DELETE 落冲突表） |
| R04-sync-e2ee | `cursor/cloud-sync-sota-r04-sync-e2ee-b343` | P0-SYNC-E2EE（记录级 sync 尊重 `.encryption-marker`；`decode_payload` 拒无 DSBK 明文） |
| R04-qcount | `cursor/cloud-sync-sota-r04-qcount-b343` | P1-QCOUNT（`attempt_count/correct_count` 合并策略，`reset_progress` 不被回弹） |
| R04-fold | `cursor/cloud-sync-sota-r04-fold-b343` | P1-FOLD-POLICY（Manual/KeepLocal 不折叠云端 tag）+ P2-FOLD-NOOP（fold 类型归一，消空转写） |
| R04-android-ftp | `cursor/cloud-sync-sota-r04-android-ftp-b343` | P1-ANDROID-FTP-SSOT（后端保存校验在 Android 拒 FTP） |
| R04-e2ee-clear | `cursor/cloud-sync-sota-r04-e2ee-clear-b343` | P1-E2EE-CLEAR（密码留空 = 停用的显式语义，不静默保留旧值） |
| R04-tomb-dos | `cursor/cloud-sync-sota-r04-tomb-dos-b343` | P1-TOMB-DOS（坏时钟 tombstone 单条隔离，不整轮硬失败） |
| R04-ui-pass | `cursor/cloud-sync-sota-r04-ui-pass-b343` | P2-UI-PASS（Dashboard/导入的备份密码入口 + 文案） |
| R04-tests | `cursor/cloud-sync-sota-r04-tests-b343` | 上述修复的回归与极端测试（坏 `changed_at`、明文拒收、tombstone 隔离、Android FTP 拒存） |
| R04-docs | `cursor/cloud-sync-sota-r04-docs-b343` | 本目录进度文档（本文件、README、FIX-QUEUE） |

拆分说明：P0-DEL-PARSE 与 P1-DEL-LOSE 都改 DELETE 应用路径，为守住「一个文件同一轮只给一个代理」归入 R04-delete 一枝；P1-FOLD-POLICY 与 P2-FOLD-NOOP 同理归入 R04-fold。

## 遗留提醒

- 并行枝 `cursor/fix-sync-tombstone-db14` 仍未进本枝；合 main 时 `ftp.rs` 必冲突，需人工消解（R03 已记录，本轮不处理）。
- P2-UI-PASS 合入后，R04-docs 或后续轮需回写 `docs/user-guide/16-数据管理与云同步.md` 的「当前版本限制」块（密码入口从「后续版本开放」改为已开放）。

## 合入状态（父代理填写）

| 代理 | 状态 | 说明 |
|---|---|---|
| R04-docs | 分支已推送 | 仅本目录文档 |
| 其余九路 | 进行中 | — |
