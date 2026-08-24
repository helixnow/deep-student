# Multi-agent 制卡自定义档案（Round 2 · Phase 0）

> 所属调研：[Anki AI-Native](../README.md) ·分支 `cursor/anki-ai-native-research-bfca`
> 对应路线图条目：`03-optimization-roadmap.md` 的 Multi-agent Phase 0

本目录提供两份**可直接安装**的 workspace custom agent 定义（契约 C6，解析器见
`src-tauri/src/chat_v2/workspace/custom_agents.rs`）和两份配套技能文档片段，
把「制卡前策展」与「制卡后质检」从主代理长上下文中拆出，形成
**curator → chatanki 生成 → qa → 修正** 的多代理闭环。

## 文件清单

| 文件 | 角色 | base | 说明 |
|------|------|------|------|
| [content-curator.md](./content-curator.md) | 制卡内容策展人 | `explorer`（只读沙箱） | 读材料，产出结构化制卡大纲（知识点清单/卡型/粒度/去重/优先级） |
| [card-qa.md](./card-qa.md) | 制卡质检员 | `worker` | 质检卡片 JSON：重复（D1-D3）、粒度（G1-G4）、Cloze 规范（C1-C6），输出裁决 + 补丁建议 |
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

## 编排用法（主代理视角）

主代理持有 chatanki skill 的全部 `builtin-chatanki_*` 工具，子代理**没有**
（custom agent 的 `tools:` 只能取「headless 只读白名单 ∪ workspace 协作工具」
的子集，越界项会被剔除）。因此所有卡片写操作都由主代理执行，子代理只产出
文本契约。

```text
用户材料
  │ 1. subagent_call { profile: "content-curator", task: "<材料资源ID + 学习目标>" }
  ▼
制卡大纲（知识点清单 + 建议 goal 文本）
  │ 2. 主代理: chatanki_run(goal=大纲建议goal) → chatanki_wait → chatanki_get_cards
  ▼
卡片 JSON
  │ 3. subagent_call { profile: "card-qa", task: "<卡片JSON原文 + 可选源资源ID>" }
  ▼
质检报告（PASS/FAIL + 逐卡问题 + 补丁 JSON）
  │ 4. 主代理: chatanki_batch_update_cards / delete_cards / add_cards 套用补丁
  │ 5. FAIL 则回到 3 复检（可传 resume_agent_session_id 续跑同一 qa 会话）
  ▼
chatanki_export / chatanki_sync
```

调用示例（步骤 1/3 的 `builtin-subagent_call` 入参）：

```json
{ "task": "材料: res_abc123（第3-5章）。学习目标: 记住所有定义与公式。按你的输出契约产出制卡大纲。",
  "profile": "content-curator" }
```

```json
{ "task": "质检以下卡片 JSON，按输出契约给出裁决与补丁：\n<chatanki_get_cards 返回的 cards 数组原文>",
  "profile": "card-qa" }
```

## 设计约束备忘（写档案时踩过的规则）

- frontmatter 为逐行 `key: value` 手写解析：`name` 必填且仅小写字母/数字/连字符，
  不得与内建 `default/worker/explorer` 冲突；`description` 必须单行。
- `base` 只能是内建 profile id；正文非空时**整体替换** base 的 instructions。
- 显式声明 `permissions:` / `context_inheritance:` 会使整个文件失效（fail-closed），
  两者只能沿用 base：explorer=只读沙箱+可联网，worker=workspace-write+不联网。
- `tools:` 覆盖时自动并入 `builtin-workspace_send/query`；`content-curator` 显式
  收窄为本地读取面（去掉了 explorer 默认的 web_search/web_fetch，避免策展跑偏；
  删掉 `tools:` 行即恢复 explorer 全量只读面）；`card-qa` 在 worker 基础上加了
  resource/rag/unified 检索工具用于核对事实与存量重复。
- 质检规则表中标 ✅ 的规则同时是 Round 2「确定性质检 lint」的实现候选，
  见 `skills/card-qa-checklist/SKILL.md`。

## 验证状态

- 两份 agent 文件的 frontmatter 已对照 `custom_agents.rs` 的解析器与其单测用例
  逐字段核验（name 合法、base 内建、tools 均在
  `headless_allowed_tools()` 白名单内、无 unsupported 字段）。
- 尚未在运行中的 app 内做端到端 subagent_call 冒烟（需要桌面环境），列为
  Round 3 待办。
