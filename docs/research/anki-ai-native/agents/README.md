# Multi-agent 制卡自定义档案（Round 2 · Phase 0 → Round 3 · Phase 1 → Round 4 · Phase 2）

> 所属调研：[Anki AI-Native](../README.md) ·分支 `cursor/anki-ai-native-research-bfca`
> 对应路线图条目：`03-optimization-roadmap.md` 的 Multi-agent Phase 0 / Phase 1 / Phase 2

本目录提供**可直接安装**的 workspace custom agent 定义（契约 C6，解析器见
`src-tauri/src/chat_v2/workspace/custom_agents.rs`）和配套技能文档片段，
把「制卡前策展」与「制卡后质检」从主代理长上下文中拆出。Phase 0 交付两份
子代理档案；Phase 1 交付协调者编排技能，把它们固化成
**content-curator → chatanki_run → card-qa → batch_update** 的可复跑闭环；
Phase 2（Round 4 #4，见 [../round4/04-phase2-readonly.md](../round4/04-phase2-readonly.md)）
给 QAAgent 开放 **chatanki 只读卡面**：`card-qa` 直接用
`builtin-chatanki_get_cards` 按 documentId 读回卡片，不再要求 coordinator 把
卡片 JSON 塞进 task。

## 文件清单

| 文件 | 角色 | base | 说明 |
|------|------|------|------|
| [content-curator.md](./content-curator.md) | 制卡内容策展人 | `explorer`（只读沙箱） | 读材料，产出结构化制卡大纲（知识点清单/卡型/粒度/去重/优先级） |
| [card-qa.md](./card-qa.md) | 制卡质检员 | `worker` | **Phase 2**：优先 `chatanki_get_cards(documentId)` 自取卡片；质检重复（D1-D3）、粒度（G1-G4）、Cloze 规范（C1-C6），输出裁决 + 补丁建议 |
| [skills/card-coordinator/SKILL.md](./skills/card-coordinator/SKILL.md) | **Phase 1/2 协调者技能** | —（主代理激活） | 固化五阶段编排总线（策展→生成→质检→修正→复检交付）+ 降级规则 + 能力边界 |
| [skills/card-outline/SKILL.md](./skills/card-outline/SKILL.md) | 技能片段 | — | 制卡大纲方法论（最小知识单元/卡型决策/去重/优先级） |
| [skills/card-qa-checklist/SKILL.md](./skills/card-qa-checklist/SKILL.md) | 技能片段 | — | 质检规则总表 + 确定性 lint 候选标注 |

## 安装方式（三选一）

1. **手动**：把 `content-curator.md`、`card-qa.md` 复制到 `{appData}/workspaces/agents/`。
   加载器现扫目录、无需重启；文件 ≤ 64 KiB，目录最多 64 个定义文件。
2. **设置页**：Settings → 子代理档案（`SubagentProfilesSection`）新建，粘贴文件内容。
3. **对话内**：让主代理走 `custom_agent_propose` → 用户审批 → `custom_agent_apply`
   两段式落盘（High 敏感度，必审批）。

技能片段可通过技能管理页 / skill-installer 安装为用户技能（id 分别为
`card-outline`、`card-qa-checklist`）。**注意**：agent 文件 frontmatter 故意
未声明 `skills:` 字段——`skills:` 引用的技能在子代理创建时找不到会 fail-closed
拒绝创建。安装技能后如需绑定，在对应 agent 文件 frontmatter 追加一行即可：

```yaml
skills: [card-outline]        # content-curator.md
skills: [card-qa-checklist]   # card-qa.md
```

## 编排用法（Phase 1 固化 → Phase 2 只读卡面）

主代理持有 chatanki skill 的全部 `builtin-chatanki_*` 工具；子代理的 `tools:`
只能取「headless 只读白名单 ∪ workspace 协作工具 ∪ **chatanki 只读四工具**
（`get_cards` / `status` / `analyze` / `list_templates`，Phase 2 新增）」的
子集，越界项会被剔除。**全部 chatanki 写工具仍然只属于主代理**：所有卡片
写操作由主代理执行，子代理读卡面 + 产出文本契约。

Phase 1 把下面的流程固化进
[skills/card-coordinator/SKILL.md](./skills/card-coordinator/SKILL.md)：
主代理激活该技能后即按五阶段总线执行，含降级规则（档案未安装 →
`chatanki_analyze` + 决策树内联策展 / 四类自查内联质检）、复检续跑
（`resume_agent_session_id`）与循环上限（3 轮）。Phase 2 改变的是第 3 步的
交接物：**documentId 取代卡片 JSON 原文**。

```text
用户材料
  │ 1. subagent_call { profile: "content-curator", task: "<材料资源ID + 学习目标>" }
  ▼
制卡大纲（知识点清单 + 建议 goal 文本）
  │ 2. 主代理: chatanki_run(goal=大纲建议goal) → chatanki_wait 至终态
  │    （maxCards/route 取 chatanki_analyze 的 recommended.maxCards / recommended.route）
  ▼
documentId（卡片 JSON 不再进 task）
  │ 3. subagent_call { profile: "card-qa", task: "<documentId + 可选源资源ID>" }
  │    card-qa 自己 chatanki_status 确认终态 → chatanki_get_cards 分页读回全部卡片
  ▼
质检报告（PASS/FAIL + 逐卡问题 + 补丁 JSON，cardId/version 来自 qa 自己的 get_cards）
  │ 4. 主代理: chatanki_batch_update_cards / delete_cards / add_cards 套用补丁
  │ 5. FAIL 则回到 3 复检（可传 resume_agent_session_id 续跑同一 qa 会话）
  ▼
chatanki_export / chatanki_sync
```

### chatanki 工具边界（Phase 2 口径）

- **只读四工具进白名单**：`builtin-chatanki_get_cards` / `builtin-chatanki_status` /
  `builtin-chatanki_analyze` / `builtin-chatanki_list_templates` 进入子代理安全
  全集（`custom_agents.rs::CHATANKI_READONLY_TOOLS`），worker 后端按档案声明
  注入 schema（`workspace_handlers.rs::chatanki_readonly_worker_tool_schemas`）。
- **跨会话读取有所有权预检**：worker 只有被后端运行时安装了「同 workspace
  coordinator 只读作用域」（`chatanki_executor::install_workspace_card_read_scope`，
  随 worker 管线 RAII 撤销）才能读到 coordinator 拥有的文档；跨 workspace /
  混合归属文档一律 `statusNotFound`。契约测试见
  `chatanki_executor.rs::test_workspace_card_read_scope_*`。
- **写工具仍全部拦截**：run / start / update / delete / add / enqueue /
  transform / retemplate / control / export / sync / import 与
  `builtin-workspace_read_document` / `builtin-workspace_update_document`
  都不在安全全集内，声明即被 sanitize 剔除。双向 fail-closed 单测钉死：
  `custom_agents.rs::chatanki_write_and_workspace_document_tools_stay_blocked_fail_closed`
  （拦截向）+ `chatanki_readonly_tools_are_allowed_and_low_sensitivity`（放行向）；
  写路径所有权不放宽由
  `chatanki_executor.rs::test_workspace_card_read_scope_never_relaxes_write_paths`
  钉死。若未来要放宽 worker 写工具，必须先让这些测试失效并同步评审本目录
  全部档案与审批语义。

调用示例（步骤 1/3 的 `builtin-subagent_call` 入参）：

```json
{ "task": "材料: res_abc123（第3-5章）。学习目标: 记住所有定义与公式。按你的输出契约产出制卡大纲。",
  "profile": "content-curator" }
```

```json
{ "task": "质检制卡文档 doc_xyz789（用 chatanki_get_cards 自行分页读回全部卡片），源材料: res_abc123。按输出契约给出裁决与补丁。",
  "profile": "card-qa" }
```

旧编排（把 `chatanki_get_cards` 返回的 cards 数组原文塞进 task）仍然兼容：
`card-qa` 档案保留了「任务直接附卡片 JSON 时照常质检」的回退分支，但新编排
应一律传 documentId——长材料下卡片 JSON 动辄数万 token，塞 task 既贵又容易
被截断，而 documentId 交接让 qa 拿到的 `cardId` / `version` 永远是最新库态。

## 设计约束备忘（写档案时踩过的规则）

- frontmatter 为逐行 `key: value` 手写解析：`name` 必填且仅小写字母/数字/连字符，
  不得与内建 `default/worker/explorer` 冲突；`description` 必须单行。
- `base` 只能是内建 profile id；正文非空时**整体替换** base 的 instructions。
- 显式声明 `permissions:` / `context_inheritance:` 会使整个文件失效（fail-closed），
  两者只能沿用 base：explorer=只读沙箱+可联网，worker=workspace-write+不联网。
- `tools:` 覆盖时自动并入 `builtin-workspace_send/query`；`content-curator` 显式
  收窄为本地读取面（去掉了 explorer 默认的 web_search/web_fetch，避免策展跑偏；
  删掉 `tools:` 行即恢复 explorer 全量只读面）；`card-qa` 在 worker 基础上加了
  chatanki 只读四工具（Phase 2 取数面）+ resource/rag/unified 检索工具
  （核对事实与存量重复）。
- 质检规则表中标 ✅ 的规则同时是 Round 2「确定性质检 lint」的实现候选，
  见 `skills/card-qa-checklist/SKILL.md`。

## 验证状态

- 两份 agent 文件的 frontmatter 已对照 `custom_agents.rs` 的解析器与其单测用例
  逐字段核验（name 合法、base 内建、tools 均在安全全集
  「`headless_allowed_tools()` ∪ `CHATANKI_READONLY_TOOLS`」内、无
  unsupported 字段）。
- Phase 1（Round 3 #7）：fail-closed 单测钉死「chatanki 写工具 / workspace
  文档读写工具不进子代理工具面」的编排前提；coordinator 编排提示词落地为
  `skills/card-coordinator/SKILL.md`。
- Phase 2（Round 4 #4）：chatanki 只读四工具进安全全集 + worker schema 源；
  executor 侧只读所有权预检（同 workspace coordinator 文档可读，跨
  workspace / 混合归属 / 写路径全部拒绝）由
  `custom_agents.rs` 3 项 + `workspace_handlers.rs` 4 项 +
  `chatanki_executor.rs` 5 项契约测试双向钉死，详见
  [../round4/04-phase2-readonly.md](../round4/04-phase2-readonly.md)。
- 尚未在运行中的 app 内做端到端 subagent_call 冒烟（需要桌面环境），仍列为
  后续待办。
