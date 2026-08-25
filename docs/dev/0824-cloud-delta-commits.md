# 0824 / cloud-sync-sota 提交级差量审计

审计日期：2026-08-25（UTC）

- 0824：`origin/cursor/0824-cde6` @ `e88340c6`
- Cloud：`origin/cursor/cloud-sync-sota-b343` @ `100c118d`
- 审计范围：`origin/cursor/0824-cde6..origin/cursor/cloud-sync-sota-b343`
- 共同基线：`fb77f0af`
- 范围提交数：39

判定口径：

- “等价吸收”不只看 ancestry；同时用 `git cherry`、`git range-diff`、提交补丁及 0824 在共同基线后的同域改动核对。39 个提交均无 patch-equivalent；只有 `9e84c8df` 的一部分行为在 0824 另有实现，尚不足以判为等价吸收。
- “风险”指遗漏该提交的产品/数据/兼容性风险，不是 cherry-pick 冲突概率。
- “必须合入”指完成本轮 cloud delta 产品闭环是否需要；纯审计/说明文档不阻断运行时合入，标为“否（建议随实现）”。

| SHA | 标题 | 文件数 | 是否已被 0824 等价吸收 | 风险 | 必须合入? |
|---|---|---:|---|---|---|
| `b85a7cf14319` | fix(cloud): reject short stored E2EE passwords before they look configured | 5 | 否 | 高：短密码会被误报为“已配置”，却无法生成可整槽恢复包 | 是 |
| `3c0d04a5d420` | fix(cloud): check E2EE password length on every save path | 3 | 否 | 高：不安全传输确认路径可绕过最短密码校验 | 是 |
| `308c97ae863b` | fix(cloud): reject short E2EE passwords on test, export, and restore | 5 | 否 | 高：测试、上传、恢复路径可能把短密码误分类，甚至静默退化为便携包 | 是 |
| `f2e01804656f` | fix(cloud): classify test-connection errors and align ZIP restore tests | 4 | 否 | 中：凭据/SSOT 错误会被误报为连接故障，恢复契约测试失真 | 是 |
| `9e84c8df295f` | fix(cloud): localize stored-password and missing-config export errors | 5 | 否（部分：0824 已另行本地化 WebDAV/S3 缺配置；stored-password 与 FTP 未吸收） | 中：关键 fail-closed 原因仍会泄露原始诊断或英文 | 是 |
| `b4cc566f2ae7` | fix(backup): count ZIP E2EE passwords in Unicode scalars | 3 | 否 | 高：UTF-16 长度与 Rust 字符计数不一致，emoji 密码前端通过、后端拒绝 | 是 |
| `5b96f521a6d2` | fix(cloud): share ZIP/cloud error localization with local backup | 13 | 否 | 中：云备份与本地 ZIP 对同一错误给出不一致或未本地化反馈 | 是 |
| `53add336f6de` | docs(cloud): count E2EE password length as Unicode code points | 9 | 否 | 中：该提交还统一 BackupTab 错误映射；缺失会让文案、前后端计数与 UI 行为不一致 | 是 |
| `ff7eb9058e76` | fix(cloud): give short and stored E2EE passwords stable error codes | 8 | 否 | 中：错误只能靠易漂移文本分类，短密码还会伪装成 keyring 内部错误 | 是 |
| `7bd2a7a817e0` | fix(sync): give E2EE plaintext/password/marker failures stable codes | 8 | 否 | 高：UI 无法稳定区分明文降级、密码错误和损坏 marker | 是 |
| `63d29cce1979` | fix(sync): give missing E2EE password refusals a stable code | 13 | 否 | 高：手动同步与 autosync 无法稳定识别半配置 E2EE 的 fail-closed 拒绝 | 是 |
| `8b0e746c79cb` | docs(android): align handbook with configured-E2EE full-fidelity cloud ZIP | 3 | 否 | 低：Android 手册继续错误宣称云备份总是便携包 | 否（建议随实现） |
| `9851029e6ffe` | fix(restore): give portable/partial slot-restore refusals a stable code | 10 | 否 | 中：UI 无法可靠说明“当前数据未改动”的整槽恢复拒绝 | 是 |
| `97583e77db5e` | fix(cloud): refuse portable ZIP before slot restore | 7 | 否 | 高：已知便携包仍进入不可能成功的整槽恢复流程 | 是 |
| `27e0ba2871b4` | fix(cloud): check disk space before cloud slot restore | 7 | 否 | 高：云恢复缺少磁盘预检，可能下载后才失败并耗尽空间 | 是 |
| `f48652c9e7e0` | fix(cloud): enter maintenance mode during cloud backup/restore | 4 | 否 | 高：备份/恢复时其余应用仍可写，产生不一致快照或恢复竞态 | 是 |
| `16cdded8887c` | docs(cloud): record cloud restore preflight and maintenance mode | 1 | 否 | 低：内部收尾文档不反映预检与写屏障现状 | 否（建议随实现） |
| `1c50f4066bec` | fix(cloud): warn when a cloud upload is only a portable archive | 4 | 否 | 中：用户会把不可整槽恢复的上传误当完整灾备 | 是 |
| `28eb4c9e5991` | docs(cloud): note portable-upload warning after cloud backup | 1 | 否 | 低：内部文档漏记便携包告警 | 否（建议随实现） |
| `57cd704d16b9` | feat(cloud): persist recoveryKind on cloud backup versions | 8 | 否 | 高：版本历史无法预先区分便携包与全保真包，是后续恢复门禁的基础 | 是 |
| `7483c9dfd19f` | fix(cloud): restore latest only via confirm, skip portable | 2 | 否 | 高：Download Latest 可绕过确认，且可能选择已知便携包 | 是 |
| `6fac1eda438f` | docs(cloud): note latest-version restore confirm and portable skip | 1 | 否 | 低：内部文档漏记 latest 恢复门禁 | 否（建议随实现） |
| `ddc1bf57c2b5` | fix(cloud): name the restore target and its recovery kind | 7 | 否 | 中：确认框不显示目标版本及恢复种类，用户无法作知情确认 | 是 |
| `2ccfe633124d` | fix(cloud): refuse known portable archives before restore confirm | 6 | 否 | 高：确认、重试或直接恢复路径仍可能下载已知不可整槽恢复包 | 是 |
| `674ee036a960` | docs(cloud): record restore-kind gates and close stale SOTA gaps | 3 | 否 | 低：SOTA/收尾台账保留过期未完成项；不影响运行时 | 否（建议随实现） |
| `e883e70b031b` | test(cloud): persist and mix recoveryKind across cloud manifests | 1 | 否 | 中：新旧 manifest 混用、无 kind 上传及状态回读缺少回归保护 | 是 |
| `017bb297c457` | fix(cloud): use neutral backup object and manifest names | 11 | 否 | 高：对象键暴露时间/设备标识；同时缺少旧 manifest 迁移兼容 | 是 |
| `a4378a203f39` | fix(sync): hash record-level change and manifest paths | 11 | 否 | 高：记录级对象路径泄露原始 device id；混合新旧 shard 兼容也缺失 | 是 |
| `4b2afeeec372` | fix(sync): hash tombstone paths without drifting watermarks | 7 | 否 | 高：删除路径泄露 device id；错误迁移还可能重放或漏掉删除事件 | 是 |
| `79192a9533ce` | fix(sync): hash file-manifest and snapshot device path segments | 8 | 否 | 高：文件 manifest/snapshot 路径继续暴露原始 device id | 是 |
| `0b702221392d` | fix(sync): drop time and device from file-manifest names | 8 | 否 | 高：对象名继续泄露活动时间与设备信息，且缺少 UUID 新旧双读 | 是 |
| `7b16481e520c` | fix(fs): verify SAF export copies by size and sha256 | 4 | 否 | 高：Android SAF copy+flush 后未校验，静默截断仍会报告成功 | 是 |
| `4e28168ce33a` | fix(fs): fail-closed when temp materialization lacks 2x space | 4 | 否 | 高：虚拟 URI 临时落盘可能写出半包并耗尽私有卷 | 是 |
| `bb391a59d6fd` | fix(fs): reject double-encoded content URIs with a readable error | 6 | 否 | 高：双编码 URI 可能被误当本地路径或把错误 document ID 交给 ContentResolver | 是 |
| `aeafb9f001bc` | fix(android): persist SAF content URIs via MainActivity queue | 7 | 否 | 高：授权未持久化，进程重启后 ZIP/同步 URI 可能失效 | 是 |
| `8e1ad9cd9b91` | docs(android): record Tauri save/open persistable grant split | 3 | 否 | 低：手册不说明 save/open 的授权能力边界；运行时不受影响 | 否（建议随实现） |
| `aeb98c61d1dd` | fix(android): queue persistable SAF URIs as atomic files | 6 | 否 | 高：单文件队列会被并发任务覆盖，非原子写还会留下破损任务 | 是 |
| `2bad7261b484` | fix(cloud): reread published backup manifests before success | 2 | 否 | 高：最终 manifest 未回读验证，远端损坏仍可能被报告为备份成功 | 是 |
| `100c118d4d28` | fix(cloud): reject backup ZIP uploads when remote size mismatches | 2 | 否 | 高：静默短写的 ZIP 仍会被发布进 catalog，形成不可恢复版本 | 是 |

## 合入建议

不要逐条在 0824 上手工重造这些行为。运行时代码与兼容测试存在明显顺序依赖，按当前 Cloud tip 整体合入更安全；纯文档提交可随实现一起带入，但不应单独阻断产品合入。此前对同一 tip 的合并预演已证明该增量可在隔离分支组合，正式合入仍需重跑 cloud/SAF 定向门禁，且不得直接推写 `cursor/0824-cde6`。
