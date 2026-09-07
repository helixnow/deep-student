# Insight Recall v2 实施规格

> 灵感回归：情境触发的个人历史灵感召回，作为元认知脚手架促进自我调节学习。
> 理论框架：arXiv 2506.20156（Irec，2025-06）；2026-09-07 经外部深审（文献核查 + 架构审阅），本规格已吸收全部审阅修正。

## 0. 根本定位（根抉择）

- 系统是**记忆的训练器**，不是记忆的替代品。北极星指标 = **延迟后无提示变式迁移**（不看卡片能否独立选对并应用方法）；有提示回忆只是分层诊断信号。
- 值得保留的核心：**可追溯理解 + 受控帮助 + 独立应用证据**。灵感卡库不是资产，证据图（学习事件 + 溯源）才是资产。
- 双环价值：录入环独立成立（说一遍理清思路），召回环随密度激活。
- 集成原则：**一个规范实体 + 四处投影**（笔记合集/待办决策/SRS 练习/对话召回），不另开平行体系。

## 1. 关键架构决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 灵感卡 = 第 10 种 VFS 资源类型 `insight_card` + 独立业务表（mindmap/exam 同款 house pattern），`ic_` 前缀 | 自动获得 DSTU 寻址/索引/引用/备份；避开记忆系统 notes+tags 的 `_type` 回落污染与自动改写语义 |
| D2 | 召回 = 被动注入（存在级）+ 工具调用（升级级）双通道；**披露控制器**是新建层，落在执行器出口 + 块持久化两处 | 持久化的块只存当前披露级内容——历史回放从块重建 LLM 上下文，块存什么未来 LLM 就看到什么 |
| D3 | 记忆边界 = 存储隔离（不进记忆根文件夹子树）；记忆系统只持授权摘要 | 记忆注入/member 摘要/memory_search 全部摸不到灵感内容，防绕过披露阶梯 |
| D4 | 所有投影一律物化 + 回链（`source_type='inspiration'`），源卡修订时重新生成 | anki_cards front/back NOT NULL 且复习不回源；避开引用不复制的 schema 缺口 |
| D5 | 向量：桌面复用 Lance profile 体系（text modality，表征种类记 metadata_json）；移动端 FTS(trigram) + 小规模精确扫描；检索后端抽象 trait | mobile-slim 无 Lance；profile/代际/孤儿回收免费复用 |
| D6 | 永不自动不可逆删除；用户明确删除走墓碑 + 派生传播 | 数据自主权（审阅 10.6） |
| D7 | 测量三本账：内容质量 / 学习需求 / 干预收益分开记账，不合成单一效用分 | 审阅 5.3 |

## 2. 数据模型（vfs.db）

```
insights                 主表：id=ic_*, current_revision_id, title, ownership(self_reported|guided|ai_draft),
                         verification_state(unverified|verified|contradicted), status(active|cold|archived),
                         recall_count, useful_count, last_recalled_at, 同步四列, deleted_at
insight_revisions        不可变修订：id=icr_*, insight_id, resource_id(→resources 正文快照),
                         situation/stuck_point/turning_point/rule/validity_conditions,
                         hypothetical_queries JSON, edit_note, created_at
insight_evidence         多源证据：id=ice_*, insight_id, revision_id, kind(chat_message|resource|note|manual),
                         session_id, message_id, variant_id, block_id, text_range, speaker,
                         quote_snapshot, resource_id, created_at
insight_relations        有向类型边：id=icx_*, from_id, to_id,
                         type(same_method|same_trap|counterexample|abstract_of|supersede|contradict|example_of),
                         scope, evidence, status(active|withdrawn), created_at
insight_events           学习事件（append-only 三本账）：id=iev_*, insight_id 可空(沉默事件), session_id,
                         event_type(recall_candidate|shown_existence|recall_attempt|shown_hint|shown_full|
                         skipped|silence_no_match|silence_low_confidence|silence_budget|silence_user_disabled|
                         feedback_useful|feedback_not_useful|feedback_not_applicable|confirmed|corrected),
                         help_level(none|existence|recall_prompt|hint|full|direct_answer),
                         quality_*, need_*, benefit_* 字段分账, payload_json, created_at, 同步四列
insight_jobs             持久任务队列（阶段三）：仿 automation_runs（lease+dedupe_key+next_attempt_at+启动恢复）
```

披露状态机：`hidden → existence → recall_prompt → hint → full`（另有 direct_answer 旁路）。
披露级别持久化在检索块上；升级 = 新事件 + 块内容更新。

## 3. 模块地图

```
src-tauri/src/insight/
  mod.rs            模块出口
  types.rs          InsightCard/Revision/Evidence/Relation/Event、DisclosureLevel、枚举
  repo.rs           纯 SQL CRUD（全部 *with_conn，事务由调用方控制）
  service.rs        InsightService：capture_draft/confirm/correct/delete(tombstone)/list/get/feedback
  recall.rs         混合召回（FTS trigram + Lance text profile + 标签/关系扩展）+ 级联升级
  disclosure.rs     披露控制器：策略门控（模式/预算/置信）→ DisclosureDecision
  handlers.rs       Tauri 命令（insight_*）
src-tauri/src/chat_v2/tools/insight_recall_executor.rs   工具执行器（升级级披露）
前端：
src/features/insights/
  api.ts            invoke 封装
  types.ts          镜像类型
  components/InsightConfirmDialog.tsx   确认两问（所有权 + 成立条件）
  components/InsightsCollection.tsx     笔记工作区合集区块
src/features/chat/plugins/blocks/insightRecall.tsx      检索块渲染（含阶梯交互）
```

## 4. 分阶段清单与验收

### 阶段一：可信记录
- [ ] 迁移 `V20260907__insight_cards.sql`（5 表 + 同步列 + change_log 触发器）+ MigrationDef 注册
- [ ] VfsResourceType::InsightCard + `ic_` 前缀路由 + indexing 分派
- [ ] insight repo/service/handlers：create_draft / confirm / correct（新 revision）/ delete（墓碑+派生传播）/ list / get / record_feedback
- [ ] 前端 api.ts + InsightConfirmDialog + 笔记工作区"灵感"合集区块
- [ ] cargo test insight；check-migrations 门禁通过
- 验收：备份恢复后证据链完整；删除不复活；纠正产生新 revision 且旧 revision 可查

### 阶段二：安全回忆
- [ ] recall.rs：FTS+向量候选生成 → 级联升级（LLM 改写）→ 批量类比核验（先唱反调）
- [ ] disclosure.rs：五态状态机；沉默四态（no_match/low_confidence/budget/user_disabled）分开记账
- [ ] InsightRecallExecutor + 两处工具→块映射 + is_retrieval_source_tool 脱敏 + [灵感-N] 引用前缀
- [ ] 被动注入：存在级最小披露对象经 turn-volatile 块进 LLM 上下文
- [ ] mastery_events CHECK 重建加 'insight' 源；record_insight_* 幂等写入
- [ ] 前端 insightRecall.tsx + RetrievalSourceType 加 'insight' + sourceAdapter 五处 + citationParser + i18n
- 验收：存在级阶段任何通道不泄露方法；无匹配完整走沉默分支；重试/变体/回放披露状态一致

### 阶段三：受控演化
- [ ] insight_jobs 队列 + 巩固 worker（闲时，可中断，幂等）
- [ ] 合并提案（linked-merge 保差异）/ 标签 canonicalize → 待办决策任务（专用 list + attachments 回链）
- [ ] SRS 投影：物化卡 + source 回链；源卡修订 → 投影重生成
- [ ] 原则卡：abstract_of 边 + ≥2 案例 + 1 反例 + 条件化表述；源卡更正 → 派生原则复审待办
- 验收：合并零静默错误；diff-approve 只覆盖语义变更；任务跨重启恢复

### 阶段四：自适应（纯策略层，零 schema 变更）
- [ ] 效用门控路由器（三本账数据校准，替代确定性阈值）
- [ ] 跨簇类比挖掘（间接查询找近邻外候选，CABLE 正确姿势，固定预算）
- [ ] 内化退场降权（保留维护性复习，不永久消失）

## 5. 命名纪律

- 避开已废弃的 irec/灵感图谱 残留；统一 `insight_card` / `ic_` / `[灵感-N]`。
- 机器管理标签用 `_` 前缀惯例；系统文件夹用 `__*__` 惯例。

## 6. 不做清单（v1 边界）

不训练模型；不做 BKT/DKT（复用 mastery EMA）；不做完整 GraphRAG；不做多主实时同步（单写设备+备份恢复，冲突留分支）；不做主动状态感知；非理工科题型不做特化。
