# 02 — AI-Native 差距矩阵

> Round 1 初版（评分 6.5）；Round 5 #8 按当前代码全面重算（2026-08-24）。
> 历史版本结论保留在文末「初评存档」，正文一律为当前状态。

## 核心问题回答

> 如果是 Agent 来做的话，可以现写脚本进行处理——当前实现做到了吗？

**结论：已做到。`chatanki_transform` 的 script 模式让 Agent 现写 python/node 脚本，
在硬沙箱（网络恒禁、I/O 合同、只挂载 job 目录）内处理无截断卡片快照，
经 dry_run 预览 + High 审批 + 逐卡乐观锁写回。声明式 ops 子集覆盖移动端。**

| 维度 | 基础设施 | Anki 制卡使用 | Gap |
|------|----------|---------------|-----|
| Agent 工具编排 | ✅ 29 个 chatanki 工具 | ✅ 完整闭环 | 无 |
| LLM 内容生成 | ✅ StreamingAnkiService | ✅ 核心路径 | 无 |
| 动态脚本 transform | ✅ `chatanki_transform` ops + script | ✅ 生产路径（沙箱 + CAS） | 无 |
| LLM 路由/规划 | ✅ `plan_route` + analyze 同源 | ✅ forced > LLM > 启发式回退 | 无 |
| 生成内质检 | ✅ 25 规则 lint + FingerprintTracker + opt-in critic | ✅ `_qa_flags` 留痕 + 预览块展示 | **低**（critic 未 grounded、未暴露参数） |
| Structured Output | ✅ `anki_protocol.rs` 三协议 | ✅ auto 自适应，已接流式 | 无 |
| 生成调优参数面 | ✅ run/start schema 全暴露 | ✅ outputProtocol/contentFormat/visualHint/maxImages/QA/FSRS/偏好 | 无 |
| 复习数据回流 | ✅ `anki_fsrs_feedback.rs` | ✅ 默认注入（画像/干扰/拆卡） | 无 |
| 用户偏好记忆 | ✅ `anki_preference_memory.rs` 纯逻辑 | ⚠️ retrieve 已接；**写入侧未接，store 恒空** | **中** |
| Multi-agent 专业化 | ✅ 档案 + Phase 2 只读白名单 | ✅ card-coordinator 五阶段编排 | **低**（豁免测试补全中） |
| 成本/模型分层 | ✅ `anki_model_routing.rs` 四角色计划 | ⚠️ Generator 已接；Critic 调用点不完整；Planner/Vlm 未接 | **中** |
| 图像遮挡制卡 | ✅ 纯函数 + overlay 组件 | ⚠️ VlmFull 直接图片仅接启发式草稿；grounding/预览未接 | **中** |
| LLM 分段定界 | ⚠️ brace-depth 切卡器（确定性） | ✅ 不再依赖模型配合分隔符 | 低 |

## 架构分层评分（Round 5 复核）

```
Agent 编排层     █████████░  9/10  — 29 工具 + CAS + 验收闭环 + 调优参数面
内容理解层       ████████░░  8/10  — LLM 生成 + VLM 多模态（遮挡 grounding 未接）
流程决策层       ████████░░  8/10  — plan_route LLM 规划 + analyze 同源 + 启发式仅回退
Script-native    █████████░  9/10  — ops + 沙箱 script 双路径生产化
质量保障层       ████████░░  8/10  — 25 规则 lint + 跨段查重 + opt-in critic + eval 回放
输出协议层       █████████░  9/10  — Structured Output 三协议自适应
个性化层         ██████░░░░  6/10  — FSRS 回流默认开；偏好记忆只读不写
```

**综合 AI-Native 评分：8.0 / 10**（6.5 → 7.4 → 8.0）

评分说明：script-native、Structured Output、LLM 路由、质检、FSRS 回流、参数面
六大主线已从"无/硬编码"推进为生产能力，是上调主因。未到 9 的原因：
偏好记忆写入侧未接（个性化闭环断在写侧）、遮挡卡只有启发式元数据草稿
（grounding/预览缺口）、critic grounded 数据仍有限、Sidekick 未完整分槽。

## 与 SOTA 对标（更新）

| 维度 | DeepStudent | 行业最佳 | Gap |
|------|------------|----------|-----|
| Agent 工具闭环 | ● 第一梯队 | — | — |
| 任务持久化/断点续传 | ● 已达 SOTA | — | — |
| Script-native | ● 沙箱脚本 + 声明式 ops 双路径 | Programmatic Tool Calling | — |
| 结构化输出 | ● json_schema strict + 能力探测回退 | JSON Schema strict | — |
| 生成内质检 | ◐ 确定性 lint + opt-in critic | Grounded judge (Memory Machines) | **低→中**（金标对未接 critic） |
| 复习数据回流 | ● FSRS-aware 生成默认开 | FSRS-aware 生成 | — |
| 用户偏好记忆 | ◐ retrieve 接线、extract 未持久化 | Mem0 extract→retrieve 闭环 | **中** |
| 成本/模型分层 | ◐ Generator 已接，Critic 调用点不完整，Planner/Vlm 未消费 | Frontier 决策 + sidekick 执行 | **中** |
| 图像遮挡制卡 | ◐ VlmFull 直接图片有启发式草稿，grounding/预览未接 | VLM grounding 自动画框 | **中** |
| CardForge vs 生产 | ● 已统一（死链路清理完成） | 统一路径 | — |

## 剩余 P0/P1 缺口清单（Round 5 收口目标）

1. **偏好记忆写入侧**：会话收尾从 update_card/delete/extraRequirements 抽取 →
   consolidate → 写 `chatanki_preference_memory_store`（读取侧已就绪等数据）
2. **遮挡接线**：VlmFull 路径产出 OcclusionSpec + 预览块渲染 overlay
3. **critic grounded**：`anki_gold_set.rs` 金标对作为 judge few-shot 参照
4. **Sidekick 分槽**：Planner/Critic/Vlm 按 plan_routing 计划实际调用
5. Phase 2 所有权豁免边界测试补全
6. 跨模块集成测试（transform script × QA lint × critic 组合路径）

---

## 初评存档（Round 1，历史结论，仅供对照）

- 初评综合评分 6.5/10；当时 28 工具、无 transform、分隔符协议、
  启发式路由、无内置 QA、FSRS 数据在库未回流。
- 初评 P0 问题清单（已全部修复）：`{{DOCUMENT_CONTENT}}` 占位符、
  START/END 协议矛盾、VlmFull 丢文本、analyze 永远 simple_text、
  fill_missing 名不副实、FieldExtractionRule 校验未执行、测试漂移。
- CardForge 2.0 divergence：引擎已"卒"，生产复用其下服务——Round 3
  完成死链路清理与划词制卡迁移后此项关闭。
