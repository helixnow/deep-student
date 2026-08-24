# Round 10 — 大包收口（每路 ≥4 个可验证交付物）

模型：复审 `claude-fable-5-thinking-xhigh`（不可用明示降级 high）；落地 `claude-fable-5-thinking-high`。禁止静默降级。每路必须做完一整包再推，禁止只交单测或单注释。

前置：R07 已合文件级 DSBK、记录级校验子、自动同步、WebDAV 409、Android 语义测、极端回归测、FINDINGS/SOTA/RESTORE。**仍开 P1-1**：cloud-only 冲突面板「保留本地」禁用。R09 十路若回传只收增量。

## 十路大包

| 代理 | 模型 | 分支 | 一整包必须交付 |
|---|---|---|---|
| R10-conflict-ui | high | `r10-conflict-ui-b343` | 放开 cloud-only「保留本地」；批量 keep_local 不再跳过；人话空状态；vitest（含 r07-cloud-only 锁定测更新）；zh+en |
| R10-names | high | `r10-names-b343` | asset_filenames 实现+接线+全边界测+失败人话；不改 vfs_blobs/file-e2ee |
| R10-verifier | high | `r10-verifier-b343` | Argon2 参数上限钳制；错密码抢先升级的解锁指南；标记删除后本地「曾加密」位或等价双源；测试 |
| R10-download | high | `r10-download-b343` | 云 ZIP 下载续传或诚实未实现+锁定测；无密码导入早失败；测试+指南 |
| R10-ux | high | `r10-ux-b343` | SyncTab/CloudStorage/Backup 全路径确认、自动同步状态、E2EE 文案、错误映射；多文件 vitest |
| R10-providers | high | `r10-providers-b343` | WebDAV/S3/FTP 残留假阳性+契约测；改 ftp.rs 先登记 FIX-QUEUE |
| R10-protocol | xhigh | `r10-protocol-b343` | FINDINGS-R01/03/05/07 逐条核销 PROTOCOL-R10.md + 仍开项锁定测 |
| R10-chaos | high | `r10-chaos-b343` | 大套混沌测（钟、幂等、混布、截断、槽位）新文件 |
| R10-sota | xhigh | `r10-sota-b343` | SOTA-R10.md + ROUND-11 大包任务表 |
| R10-android | high | `r10-android-b343` | 在已合 android 测试上补缺口：S3 用户文案、content URI、指南；能修的修 |

文件面独占见 FIX-QUEUE。避开 notes/chat/workbench/移动全局规范/协议缓存。

## 派出状态

R09 五路已合入。R10 已收 **conflict-ui（P1-1 关闭）** / sota / ux。verifier / protocol / names / download / providers / chaos / android 未推回（子代理 IDLE 且无枝），本轮重派。R11 先开 check / delta / rotate（与未回收 R10 文件面不撞）。不合并过时的 `r07-docs`。xhigh 仍不可用，明示用 high。
