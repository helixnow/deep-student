# Round 08 — 文件级 E2EE 复审、文件名净化、Android 与 CI

模型约定：只读复审用 `claude-fable-5-thinking-xhigh`（不可用则明示降级 high）；写代码/测试用 `claude-fable-5-thinking-high`。禁止静默降级；每个子代理回复第一行自报实际 slug。

前置事实：R07 七路已合入 `cursor/cloud-sync-sota-b343`（file-e2ee / record-verifier / autosync / webdav-409 / filename-tests / class-plans / webdav-comment）。父代理已回写 `cloudStorage.json` 与用户指南 16：文件级对象不再被描述为明文。后派出的 R07 十路若回传增量，只收不重叠部分。

## 本轮意图

1. **独立复审刚合入的文件级 DSBK**：哈希可分离、明文拒收、错密码、清单合并密文优先。
2. **资产文件名净化实现**（测试已合，上传路径尚未净化）。
3. **Android 换机/重启语义测试**（R07-android 未见推送）。
4. **CI**：Contract Gate / Vitest 4/4 / Rust Archive。
5. **自动同步生产复审**：默认关、无配置 fail-close、与手动锁互斥。
6. **SOTA 对照刷新**（文件级 E2EE 之后）。

## 子代理与分支

各自从 `cursor/cloud-sync-sota-b343` 开独立分支。不要切父代理 `/workspace` 检出。

| 代理 | 模型 | 分支 | 任务 |
|---|---|---|---|
| R08-review-e2ee | xhigh | `cursor/cloud-sync-sota-r08-review-e2ee-b343` | 只读复审 file-e2ee，产出 FINDINGS-R08 |
| R08-sota | xhigh | `cursor/cloud-sync-sota-r08-sota-b343` | 文件级 E2EE 之后的 SOTA 对照 |
| R08-autosync-review | xhigh | `cursor/cloud-sync-sota-r08-autosync-review-b343` | 只读复审自动同步 fail-close / 锁 / 退避 |
| R08-names | high | `cursor/cloud-sync-sota-r08-names-b343` | `asset_filenames.rs` 净化接到 `sync_asset_directories` |
| R08-android | high | `cursor/cloud-sync-sota-r08-android-b343` | Android 换机/重启语义测试 |
| R08-contract | high | `cursor/cloud-sync-sota-r08-contract-b343` | Cloud Provider Contract Gate |
| R08-vitest | high | `cursor/cloud-sync-sota-r08-vitest-b343` | Vitest shard 4 |
| R08-archive | high | `cursor/cloud-sync-sota-r08-archive-b343` | Rust Archive exit 143 诊断/修复 |
| R08-e2ee-tests | high | `cursor/cloud-sync-sota-r08-e2ee-tests-b343` | 文件级 E2EE 极端回归（独立新测试文件） |
| R08-legacy-ux | high | `cursor/cloud-sync-sota-r08-legacy-ux-b343` | 明文遗留拒收的前端人话错误 |

## 合入状态

| 项 | 状态 |
|---|---|
| 父代理 i18n/指南回写 | 本轮提交 |
| 十路 | 派出中 |
