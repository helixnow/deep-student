# Round 01 调研结论

模型：10 个只读子代理均回报 `claude-fable-5-thinking-xhigh`。未静默降级。

总判断：本地 A/B 槽恢复、隔离区 fail-close、凭据 SSOT、S3 list 截断硬失败，协议防损层达到或超过 Joplin/AnkiWeb；冲突语义、云 ZIP 闭环、供应商可用性、前端危险确认仍有真实 P0。

并行枝 `cursor/fix-sync-tombstone-db14` 已修 asset tombstone key 解析。本枝不重复改那条，合入时 rebase。

## P0（本枝应修）

| ID | 主题 | 证据要点 | 认领 |
|---|---|---|---|
| P0-ZIP | 便携 ZIP / 云备份无法槽恢复 | `portable_manifest_bytes` 强制 `PartialOverlay` + `ExcludedPortable`；`validate_for_slot_restore` 同时拒绝二者。换机云灾备终点断裂。自动备份还标 `disaster_recovery`。 | R02-backup |
| P0-MERGE | 字段级合并生产不可达 | 真实入口是 `apply_downloaded_changes_with_conflict_guard`；`FIELD_MERGE_REGISTRY` 只在裸 `apply_downloaded_changes`（测试）生效。 | R02-sync |
| P0-DEL | 无 tombstone 表的 DELETE 绕过 LWW | junction 表物理删无门槛，过期 DELETE 可删更新本地行。 | R02-sync |
| P0-CLOCK | 慢钟 SkipStale 静默丢写 | 只防超前 60s，落后时钟写入被静默跳过，违反 INV-1。 | R02-sync |
| P0-CLEAR | 清除云配置零确认 | 连带删 E2EE 密码；误触永久失去解密能力。 | R02-cloud-ui |
| P0-RESOLVE | 库级冲突一键覆盖 | `sync.json` 已有确认文案未接线。 | R02-sync-ui |
| P0-WEBDAV | 坚果云限流生态缺失 | 429/503/423 不重试；每次 PUT 全链 MKCOL；免费 600/30min 易被打满。探活用集合 GET，Nextcloud 可能 501。 | R02-webdav |
| P0-FTP-LIST | FTP 永远宣称 list 完整 | 无 `list_outcome` 覆盖，漏列 manifest 可导致恢复到过期备份。 | R02-ftp |
| P0-ANDROID-DOC | 文档让 Android 用 S3 | `mobile-slim`/`android-release` 无 S3；FTP Android 编译禁用但 UI 仍展示。 | R02-android-honesty |

## P1（本枝排队）

- E2EE 静默明文降级：B 设备无加密密码可向同一 root 上传明文。
- `.device_id` 全局路径，同机多实例 / Android 写盘失败会身份漂移。
- WebDAV 整百截断启发式假阳性（99/100 条目录同步硬失败）。
- 冲突计数：后端行数 vs UI 组数 vs 表行数三口径。
- 文件级坏时钟 tombstone 整轮硬失败（DoS）。
- 分层备份前端默认只勾 core、不含资产。
- 云恢复成功无预告自动重启。
- 半配置凭据无自动化测试。
- WebDAV 截断保护只有源码字符串假绿。

## P2（择机）

- DSBK 头 Argon2 参数无上限；`CloudStorageCredentials` 明文 Debug。
- S3 100MB PUT × 120s 超时；multipart 崩溃残留。
- 记录级冲突面板对非工程师是 raw JSON。
- 进度条缺 a11y；硬编码中文未 i18n。
- Windows 超长路径、资产大小写碰撞。

## 明确不在本枝做

- asset tombstone object_key 解析（并行枝已修）。
- notes / chat / mindmap / workbench 壳层 / 移动全局视觉规范。
- 把记录级同步改成实时 CRDT 协作（超出产品定位）。
