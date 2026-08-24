# 02 — AI-Native 差距矩阵

## 核心问题回答

> 如果是 Agent 来做的话，可以现写脚本进行处理——当前实现做到了吗？

**结论：项目具备 AI-native 基础设施，但 Anki 制卡路径未接入 script-native 能力。**

| 维度 | 基础设施 | Anki 制卡使用 | Gap |
|------|----------|---------------|-----|
| Agent 工具编排 | ✅ 28 个 chatanki 工具 | ✅ 完整闭环 | 无 |
| LLM 内容生成 | ✅ StreamingAnkiService | ✅ 核心路径 | 无 |
| Shell 沙箱执行 | ✅ local_shell_execute | ❌ 未暴露给 chatanki | **高** |
| 动态脚本 transform | ❌ 无 chatanki_transform | ❌ | **高** |
| LLM 路由/规划 | ⚠️ decide_route 启发式 | 半硬编码 | **中** |
| 生成内质检 | ❌ 无 Critic/lint | ❌ 依赖 Agent 外环 | **高** |
| Structured Output | ✅ provider 层已支持 | ❌ 仍用分隔符协议 | **中** |
| LLM 分段定界 | ⚠️ SegmentEngine 前端有 | ❌ 后端死配置 | **中** |
| Multi-agent 专业化 | ✅ subagent_call | ❌ 未用于制卡 | **低**（可配置落地） |
| 复习数据回流 | ✅ FSRS 数据在库 | ❌ 未回流生成 | **中** |

## 架构分层评分

```
Agent 编排层     ████████░░  8/10  — 28 工具 + CAS + 验收闭环
内容理解层       ████████░░  8/10  — LLM 生成 + VLM 多模态
流程决策层       ███░░░░░░░  3/10  — 启发式路由/analyze/分段
Script-native    █░░░░░░░░░  1/10  — 沙箱存在但未接入
质量保障层       ████░░░░░░  4/10  — 无内置 QA，依赖外环
输出协议层       ███░░░░░░░  3/10  — 分隔符 vs Structured Output
```

**综合 AI-Native 评分：6.5 / 10**

## 与 SOTA 对标（14 维）

| 维度 | DeepStudent | 行业最佳 | Gap |
|------|------------|----------|-----|
| Agent 工具闭环 | ● 第一梯队 | — | — |
| 任务持久化/断点续传 | ● 已达 SOTA | — | — |
| 生成内质检 | ○ 无 judge/lint | Grounded judge (Memory Machines) | **高** |
| 结构化输出 | ○ 分隔符协议 | JSON Schema strict | **中** |
| Script-native | ○ 沙箱未接入 | Programmatic Tool Calling | **高** |
| 复习数据回流 | ○ 数据在库未接线 | FSRS-aware 生成 | **中** |
| 用户偏好记忆 | ○ | Mem0 extract→retrieve | **中** |
| 成本/模型分层 | ◐ 仅内容路由 | Frontier 决策 + sidekick 执行 | **低** |
| CardForge vs 生产 | ◐ divergence | 统一路径 | **中** |

## CardForge 2.0 vs 生产路径 Divergence

| 维度 | CardForge（前端） | 生产（chatanki_executor） |
|------|-------------------|---------------------------|
| 工具桥 | ❌ 已从 pipeline 注销 | ✅ 唯一入口 |
| 模板选择 | 全模板 + LLM 自选 | templateMode 由外层 Agent 决定 |
| 内容分析 | LLM analyzeContent | 纯启发式 analyze |
| LLM 分段 | SegmentEngine（但未启用） | enable_llm_boundary 死配置 |
| 活跃消费者 | 仅划词制卡 | Chat 全路径 |

**关键发现**：CardForge 作为引擎已"卒"，生产复用其下的 EnhancedAnkiService/StreamingAnkiService。

## P0 问题清单（跨子系统）

1. **Prompt 装配层错误**：`{{DOCUMENT_CONTENT}}` 占位符从未替换；system/user 层级颠倒
2. **输出协议矛盾**：PromptKit 要求 START/END 成对，解析器只认 END
3. **VlmFull 丢弃文件文本**：图片非空时不 extract_text，数据丢失级 bug
4. **analyze 永远推荐 simple_text**：系统性误导 Agent
5. **fill_missing 名不副实**：只回显 source，不调用 LLM
6. **FieldExtractionRule 校验元数据未执行**：validation_pattern 等形同虚设
7. **测试漂移**：工具数 26→28 未更新，CardAgent 超时契约已变
