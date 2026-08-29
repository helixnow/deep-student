# 0824 改造质量评审

> Wave2-B 只读输入副本。源枝 `origin/cursor/0824-static-audit-cde6`（文档隔离枝，**未整支 merge**）。
> 对照 `v0.9.44` 与当时的 `origin/cursor/0824-cde6` @ `2d41ea8b`。官方产品枝仍是 `cursor/0824-cde6`（PR #269）。
> 本目录是判断稿，不是普查清单。当前产品 tip 已前进到 `061b4815`（Step 23）；引用行号以 0824 tip 现码为准复核。

编译、门禁、Tauri 实机按当前要求未做。Goal 不因此标完成。

## 对 0824 该不该收的判断

主题仓大部分已经在 0824 上。开放 leftover PR 没有未吸收的产品增量。`origin/main` 的 VFS change_log backfill 已被 0824 语义超集吸收，不要整支 merge main。

还没收、且属于 **0824 引入** 的产品修复只有一件：Anki `enableQaPass=false` 仍落盘 `_qa_flags`，隔离枝 `cursor/0824-fix-anki-qa-cde6`（#327，`d9a341ee`）。不要整支 merge 隔离枝；若收，只应 cherry-pick 修复提交。

下面按「会不会让用户或发布口径说假话」收口，不按文件数。

## 发布前应先处理（0824 引入或本轮新宣称）

| 问题 | 出处 | 为何挡 |
| --- | --- | --- |
| QA 开关关闭仍写 `_qa_flags` | `anki.md` | 0824 引入；修复已在 #327 |
| 默认 FSRS 画像外送，文案写「不上传」 | `anki-tasks.md` | 隐私回归 + 宣称相反 |
| CardAgent 与 Structured Output 协议互斥 | `anki-tasks.md` | 生产请求同时下发两套协议 |
| 「端到端加密 ZIP」外层仍明文 | `backup-restore.md` | 宣称超过实现 |
| 加密 ZIP 续传不传口令 | `backup-restore.md` | fail-closed 做成死路 |
| 短口令换机/重装锁死 | `upgrade-path.md` | v0.9.44 无长度下限 |
| 恢复时密钥在候选槽验证前改全局 | `vfs-governance.md` | A/B 原子边界被打破 |
| HPIAS 默认 stub 无演示标注 | `genui-hpias.md` | 把演戏当检索 |
| GPT-5.6+ `prompt_cache_breakpoint` 类型错 | `provider-adapters.md` | 官方端点会拒典型请求 |
| 误删真实 `claude-mythos-5` | `model-registry.md` | 相对 v0.9.44 的真实回归 |
| APKG 导入成功数恒为 0 | `flashcards-fsrs.md` | 用户可见；测试把错误契约钉绿 |
| 思维导图解压图片无累计预算 | `mindmap.md` | 本轮新增内存放大面 |

## 工程上变好、可以随版本走

聊天/Composer（hooks 还修了旧版 Plan 误杀）、GenUI 协议与技能接入、文件管理 fail-closed、闪卡撤销与用时上报、PDF Windows 路径与文档切分、LLM 用量 `NULL≠0`、升级夹具与迁移中间态、备份机制本身（不含上述宣称）。

## 存量，不是 0824 回归

MCP 存储分叉 + 空策略全放行、测连接先改配置失败不回滚、auto-sync 只在设置页挂载、「恢复卡住」文案与后端阈值不一致。本轮不走隔离枝重做。

## 流水线深评对总评的修正

`pipeline-streaming.md` 确认 hooks 迁移等价，并指出两处「提交声称已修、代码实际没覆盖」：issue #122 乱码修错了层（issue 仍 OPEN）；special-token 过滤器对 `<|im_start|>assistant` 续写头仍半截。不要把这两条记成已修复。

## 稿件

| 文件 | 域 |
| --- | --- |
| `chat-composer.md` | Chat / Composer |
| `pipeline-streaming.md` | pipeline hooks / 流式 / special tokens |
| `prompt-cache.md` | H cache |
| `provider-adapters.md` | 供应商协议 |
| `model-registry.md` | 型号目录 |
| `llm-usage.md` | 用量记账 |
| `genui-hpias.md` | GenUI / HPIAS / 技能 |
| `anki.md` | 制卡 / 遮挡 / QA |
| `anki-tasks.md` | cardAgent / streaming Anki |
| `anki-connect-apkg.md` | Anki Connect / APKG |
| `flashcards-fsrs.md` | 闪卡复习 |
| `question-bank.md` | 题库 / 练习会话 |
| `mindmap.md` | 导图 / 大纲 / 背诵 |
| `pdf-documents.md` | PDF / 文档处理 |
| `learning-notes.md` | 学习 Hub / 笔记 |
| `finder-hub.md` | Finder |
| `workbench-fg.md` | Workbench F×G |
| `todo-templates.md` | 待办 / 模板 |
| `translation.md` | 翻译 |
| `file-manager.md` | 文件 / 附件 |
| `vfs-governance.md` | VFS / 迁移 / 恢复编排 |
| `backup-restore.md` | 备份 / ZIP / 口令 |
| `cloud-sync.md` | 云同步 |
| `upgrade-path.md` | 升级路径 |
| `settings.md` | 设置 / MCP |
| `mobile-i18n.md` | 移动 / i18n |
| `cross-cutting.md` | 横切接缝 |
