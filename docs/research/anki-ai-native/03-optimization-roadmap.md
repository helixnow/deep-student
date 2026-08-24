# 03 — 分阶段优化路线图

## 第一批（P0 — 质量地基，高 ROI）

| # | 优化项 | 改动面 | 预期收益 |
|---|--------|--------|----------|
| 1 | 原生 Structured Output 替换分隔符 | streaming_anki_service.rs | 消灭截断/解析类错误卡 |
| 2 | 括号深度切卡器（阶段 A） | streaming_anki_service.rs | 不依赖模型配合分隔符 |
| 3 | 确定性质检 lint | streaming_anki_service.rs | 零 LLM 成本拦截 20-30% 低质卡 |
| 4 | VlmFull 文本提取修复 | chatanki_executor.rs | 修复数据丢失 bug |
| 5 | Prompt 装配层归一 | CardAgent.ts + streaming_anki_service.rs | 消除占位符/协议矛盾 |
| 6 | 暴露 extraRequirements/temperature 参数 | chatanki_executor.rs args | Agent 可干预生成策略 |
| 7 | 修复测试漂移 | chatAnkiAgentLoop.test.ts, CardAgent.test.ts | CI 绿灯 |

## 第二批（P1 — 架构增强）

| # | 优化项 | 说明 |
|---|--------|------|
| 8 | `builtin-chatanki_transform` | 快照→脚本→CAS 写回，script-native 核心 |
| 9 | LLM routing (plan_route) | 替代 decide_route 启发式 |
| 10 | Grounded judge 验收 pass | 每模板 5-10 对金标卡 |
| 11 | fill_missing_llm 策略 | retemplate 后 LLM 批量补字段 |
| 12 | 执行 FieldExtractionRule 校验 | 接线已有 validation 元数据 |
| 13 | Multi-agent Phase 0 | content-curator + card-qa 自定义档案 |

## 第三批（P2 — 追平 SOTA）

| # | 优化项 | 说明 |
|---|--------|------|
| 14 | FSRS 复习数据回流制卡 | 高 lapse 卡自动建议拆分 |
| 15 | 用户制卡偏好记忆 (Mem0 模式) | 从编辑/删卡抽取偏好 |
| 16 | Sidekick 模型分层 | frontier 决策 + 廉价模型批量生成 |
| 17 | 制卡 Playbook 沉淀 | 学科×模板成功配置 |
| 18 | 制卡质量 eval harness | 100-300 张标注集 + CI 回归 |
| 19 | 迁移划词制卡到 chatanki 后端 | 删除 CardAgent 死链路 |
| 20 | AI 图像遮挡制卡 | VLM 自动画框 + OCR 背面 |

## Multi-Agent 落地路径

```
Phase 0（零代码）：content-curator + card-qa 自定义档案
Phase 1：workspace 文档通道加固
Phase 2：QAAgent 只读卡面（chatanki_get_cards 豁免）
Phase 3（可选）：CardWriter 写权限委托
```

推荐起步方案 A：**Coordinator 写卡 + 子代理产出内容/质检**，零后端改动。

## 子代理模型分工约定

| 场景 | 推荐模型 |
|------|----------|
| 调研/规划/复审 | claude-fable-5-thinking-xhigh |
| 修复/落地代码 | claude-fable-5-thinking-high |
| xhigh 不可用时 | 明示降级至同系列 high |
