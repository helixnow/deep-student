# Round 07 — CI 收口、文件级 E2EE、自动同步与跨平台资产（11 个 Fable 子代理）

模型约定：只读复审用 `claude-fable-5-thinking-xhigh`（不可用则明示降级 high）；写代码/测试用 `claude-fable-5-thinking-high`。禁止静默降级；每个子代理回复第一行自报实际 slug。

前置事实：R06 已合入 `cursor/cloud-sync-sota-b343` 的是 e2ee-honest / del-resolve / e2ee-verifier / tests / e2ee-copy / debug-redact / guide / class-doc / docs。**未交付**：资产/工作区库文件级加密、自动同步、跨平台文件名、Android 换机/重启语义测试、FINDINGS-R06。当前 HEAD `47893150` 的 CI 失败：Backend rustfmt、Cloud Provider Contract Gate、Frontend Tests (Vitest 4/4)、Rust Tests · Build Archive（exit 143 / SIGTERM）。父代理已在本轮对所属 Rust 面做纯 rustfmt（无业务逻辑改动）。

## 本轮意图

1. **CI 红灯收口**：供应商契约、Vitest shard 4、Rust 测试归档（编译/OOM/超时）定位并修。
2. **文件级 E2EE**：`sync_vfs_blobs` / `sync_asset_directories` / workspace db 仍 `put_file` 明文；有 `.encryption-marker` 时必须加密包装或拒传+诚实文案。
3. **自动同步**：最小生产路径（默认关）+ 状态可见 + 幂等。
4. **跨平台资产文件名**：Win 非法字符、大小写冲突、NFC/NFD。
5. **Android 换机/重启**：`mobile-slim` 下配置→同步→恢复→`app.restart()` 语义测试。
6. **独立复审 + 新一轮 SOTA 对照**：产出 FINDINGS-R07，决定 R08。

## 子代理与分支

各自从 `cursor/cloud-sync-sota-b343` 开独立分支，文件面独占（见 [FIX-QUEUE](./FIX-QUEUE.md) Round 07），互不 PR，由父代理统一验收合入。

| 代理 | 模型 | 分支 | 任务 |
|---|---|---|---|
| R07-review | xhigh | `cursor/cloud-sync-sota-r07-review-b343` | 只读复审 R06 合入是否真正闭环，产出 FINDINGS-R07（P0/P1/P2） |
| R07-sota | xhigh | `cursor/cloud-sync-sota-r07-sota-b343` | 对照 Joplin/AnkiWeb/Syncthing/restic/rclone/Nextcloud/Seafile/Dropbox/OneDrive，写本轮剩余缺口 |
| R07-restore | xhigh | `cursor/cloud-sync-sota-r07-restore-b343` | 跨版本恢复矩阵只读：加密 ZIP / 分层 / A/B 槽 / 旧标记无校验子 |
| R07-contract | high | `cursor/cloud-sync-sota-r07-contract-b343` | 修 Cloud Provider Contract Gate（`sync_provider_contract_tests` ignored） |
| R07-vitest | high | `cursor/cloud-sync-sota-r07-vitest-b343` | 修 Frontend Tests Vitest 4/4（优先 data-governance / sync / cloudStorage） |
| R07-archive | high | `cursor/cloud-sync-sota-r07-archive-b343` | 查 Rust Tests · Build Archive exit 143：编译错误 vs OOM；能修则修 |
| R07-asset-e2ee | high | `cursor/cloud-sync-sota-r07-asset-e2ee-b343` | 文件级对象（vfs_blobs / assets / workspace db）尊重加密标记 |
| R07-autosync | high | `cursor/cloud-sync-sota-r07-autosync-b343` | 最小自动同步（默认关）+ 状态可见 |
| R07-asset-names | high | `cursor/cloud-sync-sota-r07-asset-names-b343` | 资产文件名跨平台净化 + 测试 |
| R07-android | high | `cursor/cloud-sync-sota-r07-android-b343` | Android 换机/重启语义测试（`mobile-slim`） |
| R07-tests | high | `cursor/cloud-sync-sota-r07-tests-b343` | 本轮修复的极端回归：错密码文件级、自动同步幂等、跨平台文件名 |

拆分说明：R07-asset-e2ee 独占 `sync_vfs_blobs*` / `sync_asset_directories*` / workspace 上传路径；R07-asset-names 优先新测试文件，净化实现若必须改同一上传路径，先在 FIX-QUEUE 登记。测试代理新测试优先放 `src-tauri/tests/` 与 `tests/vitest/data-governance/` 的**各自新文件**。

## 遗留提醒

- 并行枝 `cursor/fix-sync-tombstone-db14` 仍未进本枝；合 main 时 `ftp.rs` 必冲突。
- 文件级对象加密不得破坏 content-addressed blob hash：包装层与明文 hash 必须可分离。
- 自动同步默认关，不得在未配置云端时后台打供应商。
- 加密标记旧格式无 `key_verifier` 必须继续可读（R06-e2ee-verifier 已落地，勿回退）。

## 合入状态（父代理填写）

先合入本轮更早完成、已推远端的七路（与后派出的 10 路并行，不互相 PR）：

| 已合入分支 | 覆盖 |
|---|---|
| `r07-class-plans` | `review_plans` merge_notes 过时注释 |
| `r07-filename-tests` | Win 非法字符 / 大小写 / NFC-NFD 资产 key 回归测 |
| `r07-autosync` | 默认关自动同步 + 失败退避 + SyncTab/设置开关 |
| `r07-record-verifier` | 记录级上传走带校验子的加密一致性策略 |
| `r07-file-e2ee` | workspace db / VFS blob / 资产 DSBK 文件级加密 |
| `r07-webdav-409` | 整链 MKCOL 409 探活漏报、423/429 文案 |
| `r07-webdav-comment` | 截断启发式重复注释合并 |

后派出的 10 路（云端 VM 上限 3 + 隔离 worktree）仍在跑，回传后再验：

| 代理 | 状态 | 说明 |
|---|---|---|
| 父代理 rustfmt | 已推 | Backend Format check |
| R07-asset-e2ee（后派） | 云端运行中 | 可能与已合入 `r07-file-e2ee` 重叠，回传后只收增量 |
| R07-android | 云端运行中 | `bc-4eab10ff-d120-500e-8864-daa7a06c4c69` |
| R07-tests | 云端运行中 | `bc-77087866-213f-59db-80e5-5501b91eb272` |
| R07-review / sota / restore | worktree 运行中 | 只读文档 |
| R07-contract / vitest / archive | worktree 运行中 | CI 红灯 |
| R07-autosync（后派） | worktree 运行中 | 已合入远端枝，回传后只收增量 |
| R07-asset-names | 待补派 | 文件名测试枝已合入；净化实现仍缺 |
