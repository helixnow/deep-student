---
name: card-coordinator
description: 制卡编排协调者：固化「content-curator 策展 → chatanki_run 生成 → card-qa 质检 → batch_update 修正」多代理闭环，质检交接 documentId（qa 只读自取卡片）、全部卡片写操作由主代理执行
version: 0.2.0
author: Deep Student Research
skillType: standalone
tags: [anki, card-making, multi-agent, coordinator, orchestration]
---

# 制卡编排协调者（card-coordinator · Multi-agent Phase 1 → Phase 2）

本技能面向**主代理**（同时持有 `builtin-chatanki_*` 工具与子代理委派能力的会话），
把 Phase 0 的两份子代理档案（`content-curator` / `card-qa`）固化成一条可复跑的编排管线。

## 编排总线（必须按序执行）

```text
Phase A 策展   subagent(content-curator) → 制卡大纲（知识点清单 + 建议 goal）
Phase B 生成   chatanki_run(goal=大纲建议goal) → chatanki_wait 至终态 → 得 documentId
Phase C 质检   subagent(card-qa, documentId) → qa 自己 get_cards 读卡 → 裁决报告（PASS/FAIL + 补丁）
Phase D 修正   chatanki_batch_update_cards / delete_cards / add_cards 套用补丁
Phase E 复检   再次 card-qa（resume 同一会话 + 同一 documentId）→ PASS 后交付
```

### Phase A — 策展（content-curator）

1. 委派前先确认材料资源 ID 真实存在（`resource_list` / `resource_search`）。
2. 委派入参固定为：`{ "task": "材料: <资源ID/章节>。学习目标: <用户目标>。按你的输出契约产出制卡大纲。", "profile": "content-curator" }`。
3. 大纲回来后检查三件事：出处锚点是否齐全、`dup_risk: high` 条目是否需要用户裁决、
   建议路由是否与 `chatanki_analyze` 的 `routing.route` 一致（不一致以 analyze 为准并记录差异）。
4. **降级规则**：环境未安装 `content-curator` 档案或没有子代理委派工具时，主代理直接用
   `chatanki_analyze` + chatanki skill 的「策展 → 生成 → 质检 决策树」内联完成策展，不阻塞流程。

### Phase B — 生成（主代理专属写面）

1. `chatanki_run`：`goal` 用大纲的「建议 goal 文本」；`maxCards` 用
   `chatanki_analyze` 的 `recommended.maxCards`（词汇表 = 条目数 + 余量）；
   需要固定路由时把 `recommended.route` 作为 `route` 传入。
2. 下一轮 `chatanki_wait` → 确认终态并记下 `documentId`。
3. 子代理**不得**出现在本阶段：全部生成/写入调用只能由主代理发起。

### Phase C — 质检（card-qa · Phase 2 只读卡面）

1. 委派入参固定为：`{ "task": "质检制卡文档 <documentId>（用 chatanki_get_cards 自行分页读回全部卡片），源材料: <可选资源ID>。按输出契约给出裁决与补丁。", "profile": "card-qa" }`。
2. **不要把卡片 JSON 塞进 task**：`card-qa` 档案自带 chatanki 只读四工具
   （get_cards / status / analyze / list_templates），会按 documentId 自己
   `status` 确认终态、`get_cards` 分页读回全部卡片——补丁所需的
   `cardId` / `version` 由 qa 直读库态，比转录 JSON 更省 token 也不会截断。
   只有在环境未开放只读卡面（qa 回报 `statusNotFound` 或无该工具）时，才
   回退旧编排：把 `get_cards` 原文附进 task。
3. qa 读得到的只有**本 workspace coordinator（你）自己的文档**；跨 workspace
   的 documentId 会被所有权预检拒绝，这是预期边界，不要绕。
4. **降级规则**：`card-qa` 档案缺失时，主代理按「重复 / 粒度 / Cloze 规范 / 事实性」四类自查。

### Phase D — 修正（主代理专属）

1. 套用补丁前核对：补丁里的 `cardId` 都来自最近一次 `get_cards`；影响超过 3 张先 `ask_user`。
2. `batch_update_cards`（携带逐卡 `expectedVersion`）→ `delete_cards`（双乐观锁）→ `add_cards`（拆分卡）。
3. 任何 `conflict` 后重新 `get_cards` 重建版本映射，不复用旧 token。

### Phase E — 复检与交付

1. 修正后把**同一个 documentId** 交回**同一个** card-qa 会话复检
   （委派时传 `resume_agent_session_id`，避免质检上下文重建；qa 重新
   `get_cards` 即得修正后的最新版本号）。
2. 裁决 `PASS` / `PASS_WITH_WARNINGS`（用户接受 warn）后：向用户汇报统计 →
   征得同意再 `enqueue_review` / `export` / `sync`。
3. 复检循环上限 3 轮；仍 FAIL 时向用户如实汇报剩余问题清单，交用户裁决。

## 能力边界（fail-closed，禁止试图绕过）

- 子代理档案的 `tools:` 只能取「headless 只读白名单 ∪ workspace_send/query ∪
  chatanki 只读四工具（get_cards / status / analyze / list_templates，
  Phase 2）」子集；**全部 chatanki 写工具**（run / update / delete / add /
  transform / export / sync 等）与 `builtin-workspace_read_document`、
  `builtin-workspace_update_document` **不在安全全集内**，声明了也会被加载器
  剔除（fail-closed 单测双向钉死，见
  `custom_agents.rs::chatanki_write_and_workspace_document_tools_stay_blocked_fail_closed`
  与 `chatanki_readonly_tools_are_allowed_and_low_sensitivity`）。
- 子代理的只读卡面有所有权预检：只有同 workspace coordinator 的文档可读，
  且作用域随 worker 管线自动撤销（`chatanki_executor.rs` 契约测试钉死）。
  写路径所有权**从未放宽**：qa 对任何文档的写调用都会被拒。
- 协调者与子代理之间通过**documentId + 文本契约**交接：任务入参携带
  documentId（或降级时的卡片 JSON 原文），子代理最终回答由运行时自动交付；
  不要设计依赖共享 workspace 文档
  （`workspace_read_document` / `workspace_update_document`）的编排——这两个工具
  只在主代理自己的 workspace 工具面里可用。
- 子代理产出的一切补丁都是**建议**：套用前主代理必须自行核对 ID/版本与 ask_user 纪律。
