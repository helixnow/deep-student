# Round 02 — 修复落地（10 个 Fable high）

模型约定：修复子代理使用 `claude-fable-5-thinking-high`。禁止静默降级；每个子代理回复第一行自报实际 slug。

本轮按 [FINDINGS-R01](./FINDINGS-R01.md) 的 P0 队列派 10 个修复子代理，各自从 `cursor/cloud-sync-sota-b343` 开独立分支，文件面独占（见 [FIX-QUEUE](./FIX-QUEUE.md)），互不 PR，由父代理统一验收合入。

## 修复意图

- 把「协议防损层已达标、但闭环断裂」的四个终点接通：便携/云 ZIP 可恢复（P0-ZIP）、字段合并生产可达（P0-MERGE）、无 tombstone DELETE 走 LWW（P0-DEL）、慢钟不静默丢写（P0-CLOCK）。
- 把危险操作前置确认补齐：清除云配置（P0-CLEAR）、库级冲突一键覆盖（P0-RESOLVE）。
- 把供应商可用性拉到生产水位：WebDAV 限流重试与探活（P0-WEBDAV）、FTP list 诚实截断（P0-FTP-LIST）、E2EE 禁明文降级（R01 P1 提升）。
- 把文档与发行版事实对齐：Android 只有 WebDAV，删除「请使用 WebDAV 或 S3」误导（P0-ANDROID-DOC）。
- 设备身份与冲突计数口径统一（R01 P1），并为 P0-ZIP 等补暴露/锁定测试。

## 子代理与分支

| 代理 | 分支 | 认领项 |
|---|---|---|
| R02-cloud-ui | `cursor/cloud-sync-sota-r02-cloud-ui-b343` | P0-CLEAR、云恢复重启预告、FTP/Android 入口诚实 |
| R02-sync-ui | `cursor/cloud-sync-sota-r02-sync-ui-b343` | P0-RESOLVE、实验徽章、术语统一 |
| R02-webdav | `cursor/cloud-sync-sota-r02-webdav-b343` | P0-WEBDAV（429/503/423 重试、PROPFIND 探活、截断启发式） |
| R02-ftp | `cursor/cloud-sync-sota-r02-ftp-b343` | P0-FTP-LIST（`list_outcome` 诚实截断等） |
| R02-sync | `cursor/cloud-sync-sota-r02-sync-b343` | P0-MERGE、P0-DEL、P0-CLOCK |
| R02-e2ee | `cursor/cloud-sync-sota-r02-e2ee-b343` | 云 root 加密标记，禁明文降级 |
| R02-backup | `cursor/cloud-sync-sota-r02-backup-b343` | P0-ZIP（便携包诚实标签 + 可恢复闭环） |
| R02-identity | `cursor/cloud-sync-sota-r02-identity-b343` | device_id 落 app_data_dir、冲突计数双字段 |
| R02-tests | `cursor/cloud-sync-sota-r02-tests-b343` | WebDAV 截断测、半配置凭据测、P0-ZIP 暴露/锁定测 |
| R02-docs | `cursor/cloud-sync-sota-r02-docs-b343` | P0-ANDROID-DOC、用户指南三机制区分、本文件 |

## R02-docs 本枝改动（已落地）

只改文档，不碰代码：

1. `docs/user-guide/16-数据管理与云同步.md`
   - 删除「Android 上不可用，请使用 WebDAV 或 S3」类表述。改为事实：**Android 发行版目前只有 WebDAV；S3 与 FTP 不可用**；桌面 S3 备份用户换手机时改走 WebDAV，或导出 ZIP 传到手机导入。
   - 明确区分三套机制并统一措辞：**本地备份**（A/B 槽完整恢复）、**云端整包备份（实验性）**、**记录级双向同步（实验性）**；对应小节标题同步改名。
   - 按 FINDINGS-R01 P0-ZIP 现状（R02-backup 尚未合入）诚实写明限制：便携 ZIP 与云端整包被标记为部分覆盖格式，`validate_for_slot_restore` 会拒绝整槽恢复，换机链路可能在最后一步失败；建议以本地备份为主、迁移前先验证链路。修复合入后需回写本节。
2. `README_CN.md` 云同步一句：桌面 WebDAV / S3（FTP 实验性），Android 目前仅 WebDAV。
3. 本文件（ROUND-02.md）。

## 合入状态（父代理已合并进 `cursor/cloud-sync-sota-b343`）

| 代理 | 状态 | 说明 |
|---|---|---|
| R02-docs / tests / ftp / e2ee / sync-engine / cloud-ui / sync-ui | 已合入 | 冲突 0 |
| R02-webdav / backup / identity | 云环境中断，重试中 | 仍为 P0/P1 缺口 |

已合入要点：清除配置确认、库级冲突确认、FTP list 截断与超时、E2EE 上传标记、字段合并生产可达、无 tombstone 迟到 DELETE LWW、慢钟败方进冲突表、半配置/截断/ZIP 契约测试、Android 文档事实。

## 合入后待办

- [ ] R02-backup 合入后回写用户指南「当前版本限制」块（若整槽恢复已打通则删除该块）。
- [x] R02-cloud-ui 已合入：移动端 FTP 禁用卡片 + 清除确认。
- [ ] R02-webdav / identity 重试合入。
- [ ] R03 复审时核对文档与代码事实无漂移。
