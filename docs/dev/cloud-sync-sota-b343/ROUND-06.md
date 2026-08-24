# Round 06 — E2EE 闭环、单侧冲突可解与跨平台资产（10 个 Fable 子代理）

模型约定：只读复审用 `claude-fable-5-thinking-xhigh`（不可用则明示降级 high）；写代码/测试用 `claude-fable-5-thinking-high`。禁止静默降级；每个子代理回复第一行自报实际 slug。

前置事实：R05 五路分支已合入 `cursor/cloud-sync-sota-b343`（android-ftp / ftp-i18n / tests / zip-resume / webdav-1k，另含若干直接提交，见 [FIX-QUEUE](./FIX-QUEUE.md) Round 05 留档与 [FINDINGS-R05](./FINDINGS-R05.md)）。**R05-guide 未交付**：用户指南 16 仍写「密码入口将在后续版本开放」，与已合入的 `r04-zip-ui` 事实不符，转入本轮。

## 本轮意图

按 FINDINGS-R05 复审残留收口：

1. **单侧冲突可解**：败方 DELETE 只落 cloud 侧，resolve 命令要求双侧记录 → 冲突徽章永久占位、用户无法清除。
2. **E2EE 覆盖面闭环**：附件/工作区库仍明文上传，与「E2EE 已启用」预期不符；加密标记无密钥校验子，错密码可污染同一 root。
3. **自动同步与 Android 语义**：目前无任何自动同步触发；Android 换机/重启路径未实测。
4. **跨平台资产文件名**：Win 非法字符、大小写冲突、NFC/NFD 归一未覆盖。
5. **文档回写**：用户指南 16 密码入口段过时（R05 未交付）+ 本轮新事实。

## 子代理与分支

各自从 `cursor/cloud-sync-sota-b343` 开独立分支，文件面独占（见 [FIX-QUEUE](./FIX-QUEUE.md) Round 06），互不 PR，由父代理统一验收合入。

| 代理 | 模型 | 分支 | 任务 |
|---|---|---|---|
| R06-review | xhigh | `cursor/cloud-sync-sota-r06-review-b343` | 只读复审 R05 五路合入与直接提交是否真正闭环，产出 FINDINGS-R06（P0/P1/P2） |
| R06-del-badge | high | `cursor/cloud-sync-sota-r06-del-badge-b343` | 单侧（cloud-only）冲突可解决：resolve 命令放宽双侧要求，败方 DELETE 冲突徽章不再永久占位 |
| R06-asset-e2ee | high | `cursor/cloud-sync-sota-r06-asset-e2ee-b343` | 附件/工作区库上传尊重 `.encryption-marker`：资产加密上传，做不到则拒绝上传并给诚实文案 |
| R06-key-verify | high | `cursor/cloud-sync-sota-r06-key-verify-b343` | 加密标记加入密钥校验子：错密码 fail-fast，不得污染同一 root 已有密文 |
| R06-autosync | high | `cursor/cloud-sync-sota-r06-autosync-b343` | 最小自动同步：启动后/定时触发可选项（默认关）+ 状态可见；不做实时协作 |
| R06-asset-names | high | `cursor/cloud-sync-sota-r06-asset-names-b343` | 资产文件名跨平台：Win 非法字符、大小写冲突、NFC/NFD 归一测试与必要净化 |
| R06-android | high | `cursor/cloud-sync-sota-r06-android-b343` | Android 换机/重启语义测试：`mobile-slim` 下配置→同步→恢复→重启闭环 |
| R06-tests | high | `cursor/cloud-sync-sota-r06-tests-b343` | 本轮修复的极端回归：错密码污染、单侧冲突解决、自动同步幂等 |
| R06-guide | high | `cursor/cloud-sync-sota-r06-guide-b343` | 用户指南 16 回写（R05 未交付接续）：密码入口已开放、分层导出默认值、E2EE 覆盖面（资产明文）诚实说明 |
| R06-docs | high | `cursor/cloud-sync-sota-r06-docs-b343` | 本目录进度文档（本文件、README、FIX-QUEUE）——本枝已推送 |

拆分说明：R06-key-verify 独占 `.encryption-marker` 格式与读写实现，R06-asset-e2ee 独占资产/工作区库上传路径；两者若需对齐标记新格式接口，先在 FIX-QUEUE 登记再动。测试代理新测试优先放 `src-tauri/tests/` 与 `tests/vitest/data-governance/` 的**各自新文件**；若必须改既有文件，先在 FIX-QUEUE 登记。

## 遗留提醒（从 R05 带入）

- **R05-guide 未交付**：用户指南 16「密码入口将在后续版本开放」段与 `r04-zip-ui` 已合入事实不符，R04-backup-defaults 分层导出默认值也仍未写入。本轮 R06-guide 补做。
- **加密标记向后兼容**：R06-key-verify 引入校验子后，已有云端 root 上的旧格式标记必须可读（视为「无校验子、跳过校验」），不得逼用户重建 root。
- 并行枝 `cursor/fix-sync-tombstone-db14` 仍未进本枝；合 main 时 `ftp.rs` 必冲突，需人工消解（R03 起持续记录，本轮不处理）。

## 合入状态（父代理填写）

| 代理 | 状态 | 说明 |
|---|---|---|
| R06-docs | 已合入 | 仅本目录文档 |
| R06-guide | 已合入 | `r06-guide-b343` |
| R06-del-badge / del-resolve | 已合入 | `b31ee744` 单侧 DELETE 冲突可解决 |
| R06-key-verify | 已合入 | `7e090429` `.encryption-marker` 不可逆校验子 |
| R06-e2ee-copy / honest | 已合入 | UI 诚实披露文件级仍明文 |
| R06-tests | 已合入 | `r06-tests-b343` |
| R06-debug-redact | 已合入 | 凭据 Debug 脱敏 |
| R06-class-doc | 已合入 | questions 计数合并注释 |
| R06-review | 未交付 | 无 FINDINGS-R06，转入 R07-review |
| R06-asset-e2ee | 未交付 | `sync_vfs_blobs` 仍 `put_file` 明文，转入 R07 |
| R06-autosync | 未交付 | 转入 R07 |
| R06-asset-names | 未交付 | 转入 R07 |
| R06-android | 未交付 | 转入 R07 |
