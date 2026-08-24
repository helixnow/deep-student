# 收尾状态（父代理）

用户要求停止前交付「可用高质量版本」。本文件记录**已合入可交付面**与**诚实未关项**。本地完整 `cargo test` 受 GTK/WebKit 与 CI 排队限制，以 CI + 源码核销为准。

## 已合入、可作交付基线

| 项 | 状态 | 证据 |
|---|---|---|
| KDF 应用级上限 | 已合 | `backup_crypto.rs`：`KDF_MAX_*` + `derive_key` 第一步 `ensure_kdf_params_within_app_limits` |
| 本机加密目录记忆 | 已合 | `EncryptedRootMemory`；删标记后拒明文 |
| 记录级时点恢复 | 已合 | `history.rs`：回退时间戳严格晚于当前行/DELETE 版本，未来合法漂移也不会再被旧云端胜方覆盖 |
| 未同步清单 | 已合 | `UnsyncedItemsPanel` 只读；`SyncTab` 仅挂载，无面板内同步写入口 |
| WebDAV 非续传字节核对 | 已合 | `webdav.rs` `downloaded != total_size` fail-closed |
| `get_file_decoded` 死代码 | 已删 | P2-1 关；`sync_r12_decoded_dead.rs` |
| repo_check DSBK v2 头 | 已修 | SSOT `DSBK_V2_HEADER_LEN=44`，chunk `[40..44)` |
| Android 平台错误码 | 已合 | `E_FTP_UNSUPPORTED_ON_ANDROID` / `E_S3_UNSUPPORTED_IN_BUILD`；前端只按 code 映射 |
| Android 手册 | 已合 | [ANDROID-HANDBOOK-R11.md](./ANDROID-HANDBOOK-R11.md)；真机缺口未签字 |
| sync target 租约 | 已合 | `sync_lease.rs` + 两入口接线；占用码 `E_SYNC_LEASE_HELD` |
| locale / 用户指南 16 | 已合 | [WRAP-DOCS.md](./WRAP-DOCS.md) |
| 收尾复审 | 已合 | [FINDINGS-WRAP.md](./FINDINGS-WRAP.md)：P0=0、P1=0；生产放量仍 NO-GO |
| E2EE 收尾核对 | 已合 | [WRAP-E2EE.md](./WRAP-E2EE.md)：KDF 上限 / 删标记拒明文 / FileCipherSession 无旁路 |

## 诚实未关（不阻塞「备份/换机可用」，但是差距）

- **增量备份**：`DELTA-R11.md` 已合；codec + inventory + backup-v2 租约 + upload + restore + 两遍 GC 积木已落。**未接线**：生产仍整 ZIP 单对象 PUT。用户指南 16 与设置页 `actions.fullZipHint` 已写明没有增量传输/去重/CDC。云端整包在**已配置** E2EE 密码时走加密全保真导出（外层 DSBK 与内层备份密码用同一已存密码）；开关打开却读不到密码时 **fail-closed 拒绝导出**，不会默默打成便携包。导入只对带 `portable_secrets.dsbk` 的密封 ZIP 套用已存密码；便携包忽略 stored。**未配置**仍是便携归档，整槽校验会拒绝。短于 8 字符的云端 E2EE 密码：新写入一律拒绝；保存 / 测试连接 / 上传 / 恢复入口先拦；ZIP 解析对显式或已存短密码 fail-closed（不把「已配置」改成未配置，以免静默便携导出）。接线前已写入的短密码导出仍会在解析层拒绝，需重新输入至少 8 个字符。积木仍未接线。
- **可逆文件名**：R11-names2 已合（rclone 风格可逆映射 + 旧 `_` key 双查找；超长/损坏 fail-closed）。
- **FINDINGS-WRAP P2-1**：已关——v1 升级前试解既有备份；空仓仍可认领；失败不写标记。
- **FINDINGS-WRAP P2-2**：已关——冲突快速路径在 `BEGIN IMMEDIATE` 内重读业务行，不匹配即拒绝。
- **Android 真机签字**：手册已列 8 项 SAF/重启缺口；宿主测不能冒充真机绿灯。用户指南 17、隐私数据流向、隐私政策与根 README 已改成 Android 仅 WebDAV（不再写「手机也可用 S3」）。
- **基线遗留红灯**：已合入测试对齐——tombstone 场景改用 64-hex；明文遗留在加密设备上锁定为 `downloaded=0` 拒收。资产 tombstone 现从**未过滤**清单解析 `object_key`，对 `data_governance/asset_objects/` 显式 skip delete（共享对象交给 GC），不再靠 miss 碰巧不删。未带原 `fix-sync-tombstone-db14` 的 `ftp.rs`。未放松 fail-closed。
- **licenses:check**：`THIRD_PARTY_NOTICES.txt` 已按现有 `Cargo.lock`（R09-names 的 `unicode-normalization@0.1.25`）重生成 SHA；**未改 lockfile**。
- **SOTA 不做**：实时协作、原地密钥轮换（换密码=换目录重传）。
- **CI / Rust 门禁**：`c06a7959` 的 Frontend（licenses + tsc）、Backend、Migration Gate、Cloud Provider Contract Gate 已过。Vitest 分片曾把单个 worker 顶死在 `max-old-space-size=4096`（日志约 4001MB，无断言失败）。CI 现为 6144MB + `maxForks: 2`，不放宽 autosync/StatusBar 用例。Dashboard 本地 ZIP 导入测已对齐「先确认可选密码对话框」；导出断言含第 5 个 `encryptionPassword` 参数。CLAAssistant 忽略。完整 CI 未宣称全绿。
- **供应商兼容**：已移植 #174——WebDAV href/base 统一解码（坚果云中文/空格路径不再静默列空）；S3 `normalize_endpoint` 剥离控制台 bucket 前缀域名/路径后缀。未带更松的 `ftp.rs` 550 白名单。前端 `localizeCloudError` 将「已开启 E2EE 但读不到已存密码」与 `Missing WebDAV/S3/FTP configuration` 映射为 zh/en 人话，不改 `toSafeCloudStorageConfig` 的英文抛错契约。
- **未合枝**：`fix-sync-tombstone-db14` 仅剩更松的 `ftp.rs` 550 白名单与 Docker 契约测，不合；`r07-docs` 不合；`redlights` / `delta-b343` 相对专属枝无增量。不合并 0824 主题排练整枝。

## go/no-go

**有条件 go**：桌面 WebDAV 整包备份 + 记录级同步 + E2EE 门禁 + 巡检 + 冲突可撤销 + 目标租约 + 可逆资产文件名，可作为本枝高质量可用版本。Android 换机仍几乎只能 WebDAV；整包备份无增量去重，不宣称 SOTA 齐。**生产放量 NO-GO**（CI 未齐、真机未签、整包增量传输未实现）。

收尾子代理（`gpt-5.6-sol-xhigh-fast`）回传后只合修复/文档增量，不再开新功能面。
