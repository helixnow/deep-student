# Round 03 复审（合入 R02 全量后）

复审模型：`claude-fable-5-thinking-xhigh`。R02 十路修复已全部合入 `cursor/cloud-sync-sota-b343`（含中断重试）。

## R01 P0 关闭状态（更新）

| ID | 状态 |
|---|---|
| P0-MERGE / P0-DEL / P0-CLOCK | 已关，但 R03 发现残留口子（见下） |
| P0-CLEAR / P0-RESOLVE | 已关 |
| P0-WEBDAV | 已关（429/5xx 重试、PROPFIND 探活、100 文件假阳性已修） |
| P0-FTP-LIST | 已关 |
| P0-ANDROID-DOC | 已关（文档 + 移动端 FTP 禁用卡片） |
| P0-ZIP | 引擎已打通加密全保真 ZIP；Dashboard/API 层密码入口尚未接线，未加密便携包仍拒绝整槽恢复（诚实） |

R01 P1 已关：E2EE 备份 ZIP 明文降级、device_id 落数据目录、冲突计数 groups/rows、半配置测试、云恢复重启预告。

## R03 新发现（须进 R04）

| ID | 级别 | 问题 |
|---|---|---|
| P0-DEL-PARSE | P0 | `changed_at` 不可解析时 DELETE LWW 门整体跳过，无条件硬删 |
| P0-SYNC-E2EE | P0 | `.encryption-marker` 只护 `cloud_sync_upload`；记录级 sync 仍可明文写同一 root；`decode_payload` 仍接受无 DSBK 明文 |
| P1-QCOUNT | P1 | `questions.attempt_count/correct_count` 仍 MaxValue，`reset_progress` 会被回弹 |
| P1-DEL-LOSE | P1 | 败方 DELETE 仍不落冲突表 |
| P1-FOLD-POLICY | P1 | Manual/KeepLocal 仍折叠云端 tag |
| P1-ANDROID-FTP-SSOT | P1 | 后端 SSOT 保存 FTP 在 Android 上不拒 |
| P1-E2EE-CLEAR | P1 | 加密密码「留空」不能停用，只保留旧值 |
| P1-TOMB-DOS | P1 | 文件级坏时钟 tombstone 仍整轮硬失败 |
| P2-FOLD-NOOP | P2 | fold 类型不归一导致空转写 + changelog |
| P2-UI-PASS | P2 | 加密全保真 ZIP 缺 Dashboard 密码入口 |

并行枝 `cursor/fix-sync-tombstone-db14` 仍未进本枝；合 main 时 `ftp.rs` 必冲突，需人工消解。
