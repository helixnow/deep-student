---
name: card-coordinator
description: 制卡编排协调者：固化「content-curator 策展 → chatanki_run 生成 → card-qa 质检 → batch_update 修正」多代理闭环，子代理只产出文本契约、全部卡片写操作由主代理执行
version: 0.1.0
author: Deep Student Research
skillType: standalone
tags: [anki, card-making, multi-agent, coordinator, orchestration]
---

# 制卡编排协调者（card-coordinator · Multi-agent Phase 1）

本技能面向**主代理**（同时持有 `builtin-chatanki_*` 工具与子代理委派能力的会话），
把 Phase 0 的两份子代理档案（`content-curator` / `card-qa`）固化成一条可复跑的编排管线。

## 编排总线（必须按序执行）

```text
Phase A 策展   subagent(content-curator) → 制卡大纲（知识点清单 + 建议 goal）
Phase B 生成   chatanki_run(goal=大纲建议goal) → chatanki_wait → chatanki_get_cards
Phase C 质检   subagent(card-qa, 卡片JSON原文) → 裁决报告（PASS/FAIL + 补丁）
Phase D 修正   chatanki_batch_update_cards / delete_cards / add_cards 套用补丁
Phase E 复检   get_cards → 再次 card-qa（resume 同一会话）→ PASS 后交付
```

### Phase A — 策展（content-curator）

1. 委派前先确认材料资源 ID 真实存在（`resource_list` / `resource_search`）。
2. 委派入参固定为：`{ "task": "材料: <资源ID/章节>。学习目标: <用户目标>。按你的输出契约产出制卡大纲。", "profile": "content-curator" }`。
3. 大纲回来后检查三件事：出处锚点是否齐全、`dup_risk: high` 条目是否需要用户裁决、
   建议路由是否与 `chatanki_analyze` 的 `routing.route` 一致（不一致以 analyze 为准并记录差异）。
4. **降级规则**：环境未安装 `content-curator` 档案或没有子代理委派工具时，主代理直接用
   `chatanki_analyze` + chatanki skill 的「策展 → 生成 → 质检 决策树」内联完成策展，不阻塞流程。

### Phase B — 生成（主代理专属）

1. `chatanki_run`：`goal` 用大纲的「建议 goal 文本」；`maxCards` 用
   `chatanki_analyze` 的 `recommended.maxCards`（词汇表 = 条目数 + 余量）；
   需要固定路由时把 `recommended.route` 作为 `route` 传入。
2. 下一轮 `chatanki_wait` → 终态后 `chatanki_get_cards` 分页读回**全部**卡片。
3. 子代理**不得**出现在本阶段：所有 `chatanki_*` 调用只能由主代理发起。

### Phase C — 质检（card-qa）

1. 委派入参固定为：`{ "task": "质检以下卡片 JSON，按输出契约给出裁决与补丁：\n<get_cards 返回的 cards 数组原文>", "profile": "card-qa" }`；
   可附源材料资源 ID 供事实核对。
2. 卡片 JSON 必须是 `get_cards` 原文（含 `cardId/version`），不得摘要转述——
   补丁需要真实 ID 与版本号才能套用。
3. **降级规则**：`card-qa` 档案缺失时，主代理按「重复 / 粒度 / Cloze 规范 / 事实性」四类自查。

### Phase D — 修正（主代理专属）

1. 套用补丁前核对：补丁里的 `cardId` 都来自最近一次 `get_cards`；影响超过 3 张先 `ask_user`。
2. `batch_update_cards`（携带逐卡 `expectedVersion`）→ `delete_cards`（双乐观锁）→ `add_cards`（拆分卡）。
3. 任何 `conflict` 后重新 `get_cards` 重建版本映射，不复用旧 token。

### Phase E — 复检与交付

1. 修正后再次 `get_cards`，把新 JSON 交回**同一个** card-qa 会话复检
   （委派时传 `resume_agent_session_id`，避免质检上下文重建）。
2. 裁决 `PASS` / `PASS_WITH_WARNINGS`（用户接受 warn）后：向用户汇报统计 →
   征得同意再 `enqueue_review` / `export` / `sync`。
3. 复检循环上限 3 轮；仍 FAIL 时向用户如实汇报剩余问题清单，交用户裁决。

## 能力边界（fail-closed，禁止试图绕过）

- 子代理档案的 `tools:` 只能取「headless 只读白名单 ∪ workspace_send/query」子集；
  `builtin-chatanki_*`、`builtin-workspace_read_document`、`builtin-workspace_update_document`
  **不在安全全集内**，声明了也会被加载器剔除（有 fail-closed 单测钉死，
  见 `custom_agents.rs::chatanki_and_workspace_document_tools_are_dropped_fail_closed`）。
- 因此协调者与子代理之间**只通过文本契约交接**：任务入参携带材料/卡片 JSON 原文，
  子代理最终回答由运行时自动交付；不要设计依赖共享 workspace 文档
  （`workspace_read_document` / `workspace_update_document`）的编排——这两个工具
  只在主代理自己的 workspace 工具面里可用，worker 白名单未放宽。
- 子代理产出的一切补丁都是**建议**：套用前主代理必须自行核对 ID/版本与 ask_user 纪律。
