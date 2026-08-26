# 0824 静态分区审计（防中断进度仓）

基座：`origin/cursor/0824-cde6` @ `2d41ea8b`。
对照：`origin/main`、`v0.9.44`。
本枝只收**只读静态审计 markdown**，不改产品代码，不整支 merge 任何隔离/预演枝。

## 写手约定

- 官方产品统一枝仍是 `cursor/0824-cde6`（PR #269）。本枝是文档进度仓。
- 每个子代理只写下面表里**自己的一份** md，互不改别人的文件。
- 主代理是唯一 git 写手：某份 md 出现完整结论段后立刻 commit + push + 更新本 PR。
- 不做 Tauri 实机编译。测不到的真机/私人库/真实云口令继续只记录。

## 报告清单

| 文件 | 大区域 | 状态 |
| --- | --- | --- |
| `01-chat-composer.md` | Chat V2 / pipeline / Composer / 流式 | PASS |
| `02-cloud-sync.md` | 云同步 / WebDAV / S3 / FTP / E2EE / #177 | PASS |
| `03-vfs-governance.md` | VFS / 迁移 / coordinator / 数据治理 | PASS |
| `04-anki-flashcards.md` | 制卡任务 / 闪卡只读 / Anki | WARN（QA 开关语义 / 恢复阈值文案 / 死 key） |
| `05-genui-hpias.md` | GenUI / HPIAS / 技能 | PASS |
| `06-finder-hub.md` | Finder 分桶 / Learning Hub / 笔记 / F | PASS |
| `07-mobile-i18n.md` | 移动端 G / InputBar 拆分 / i18n | PASS（记录 v0.9.44 抽屉缺键） |
| `08-settings-legal.md` | 设置 / vendor / MCP / NOTICES | FAIL（MCP 存储面分叉 + 空策略全放行） |
| `09-invariants-leftover.md` | 18 不变量 / leftover PR 吸收 | PASS |
| `10-upgrade-path.md` | 相对 v0.9.44 / main 的升级路径 | PASS |

完整稿必须含：`## 结论`（PASS / WARN / FAIL）、证据路径+行号、是否需要产品修复、明确「本轮不改代码」。

## 第二波（回归归因 / 互审 / 深挖）

| 文件 | 大区域 | 状态 |
| --- | --- | --- |
| `11-mcp-regression.md` | 08 FAIL 对照 v0.9.44 | 既有，非 0824 回归；不纳入本轮隔离枝 |
| `12-anki-regression.md` | 04 WARN 对照 v0.9.44 | `enableQaPass=false` 仍写 `_qa_flags` 为 0824 引入；另两项既有 |
| `13-review-chat-cloud-vfs.md` | 互审 01–03 | 已写 |
| `14-review-anki-genui-finder.md` | 互审 04–06 | 维持 04 WARN / 05 PASS / 06 PASS |
| `15-review-mobile-settings-upgrade.md` | 互审 07–10 | 维持 08 FAIL；09 的 18/18 方向对，个别数字需校正 |
| `16-leftover-refetch.md` | 再 fetch leftover | A：无新增量 |
| `17-e2ee-zip.md` | ZIP / 旧加密口令 / E2EE | PASS |
| `18-hpias-allowlist.md` | HPIAS 18-block | 已写 |
| `19-llm-usage-null.md` | `cache_write_tokens` NULL≠0 | PASS |
| `20-composer-g-overlay.md` | F 拆分 × G 热区 × ABG | PASS |

## 第三波（写完一份立刻单独提交）

| 文件 | 大区域 | 状态 |
| --- | --- | --- |
| `21-leftover-pass3.md` | leftover 第三轮 | A：无新增量 |
| `22-chat-genui-boundary.md` | Chat/GenUI 升级边界 | 已写 |
| `23-attachment-limits.md` | 附件 200/50 | PASS |
| `24-tombstone.md` | tombstone 复读 | 已写 |
| `25-i18n-autosync.md` | i18n / auto-sync | PASS |
| `26-webdav-s3-ftp.md` | WebDAV / S3 / FTP | PASS |
| `27-invariants-number-errata.md` | 09 数字勘误 | 不翻案 PASS |
| `28-pr269-coverage.md` | #269 覆盖 | 无缺失产品增量 |
| `29-step22-candidate.md` | Step 22 候选 | 仅 QA 开关不落盘 |

## 第四波（一份一提交）

| 文件 | 大区域 | 状态 |
| --- | --- | --- |
| `30-qbank-tools.md` | qbank 压缩 + daily_target | 已写 |
| `31-model-registry.md` | 无 mythos-5/haiku-5 真条目 | 已写 |
| `32-android-back-44px.md` | G 44px / safe-area / Android back | PASS |
| `33-governance-abg.md` | 数据治理 A+B+G | 已写 |
| `34-finder-persist.md` | Step 18 finder persist | PASS |
| `35-anki-nullable-metadata.md` | Anki 可空 metadata | 已写 |
| `36-cardagent-start.md` | cardAgent.startGeneration | 已写 |
| `37-pipeline-hooks.md` | pipeline hooks 四切点 | 已写 |
| `38-utf8-special-tokens.md` | utf8_stream + special tokens | PASS |
| `39-leftover-pass4.md` | leftover 第四轮 | A：无新增量 |

## 第五波（一份一提交）

| 文件 | 大区域 | 状态 |
| --- | --- | --- |
| `40-h-cache.md` | H cache 冻结 | 已写 |
| `41-genui-executor.md` | GenerativeUiExecutor 注册 | 已写 |
| `42-notes-selection.md` | 划词保存笔记 | PASS |
| `43-todo-surface.md` | Todo 主路径 | 已写 |
| `44-templates.md` | 模板管理 | 已写 |
| `45-vendor-keys.md` | vendor key 存储 | 已写 |
| `46-notices-legal.md` | NOTICES 在 legal/ | PASS |
| `47-coordinator-additive.md` | VFS coordinator 加法式 | 已写 |
| `48-isolation-327.md` | #327 未进官方、勿 merge | 已写 |
| `49-leftover-pass5.md` | leftover 第五轮 | 已写 |

## 第六波（Step 22 tip 复验）

| 文件 | 大区域 | 状态 |
| --- | --- | --- |
| `50-leftover-pass6.md` | leftover 第六轮（对照 `f83e541b`） | A：无新增量 |
