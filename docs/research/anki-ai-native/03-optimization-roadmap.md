# 03 — 分阶段优化路线图

> Round 1 制定；Round 5 #8 按当前代码勾选完成状态（2026-08-24）。
> 完成度：P0 **7/7** · P1 **6/6** · P2 **5/7 完成 + 2/7 部分**。

## 第一批（P0 — 质量地基，高 ROI）✅ 全部完成

| # | 优化项 | 改动面 | 状态 |
|---|--------|--------|------|
| 1 | 原生 Structured Output 替换分隔符 | `anki_protocol.rs` + streaming | ✅ 三协议 + auto 能力探测（Round 3 #2） |
| 2 | 括号深度切卡器（阶段 A） | streaming_anki_service.rs | ✅ Round 2 落地 |
| 3 | 确定性质检 lint | `anki_qa_lint.rs` | ✅ 25 规则码 + FingerprintTracker 跨段查重（Round 3 #3 → Round 4 扩展） |
| 4 | VlmFull 文本提取修复 | chatanki_executor.rs | ✅ Round 1 P0 修复 |
| 5 | Prompt 装配层归一 | CardAgent.ts + streaming | ✅ Round 2 修复（占位符删除 + END-only） |
| 6 | 暴露 extraRequirements/temperature 参数 | chatanki run/start args | ✅ extraRequirements（Round 2）+ 全部调优旋钮（Round 5 #1，`d1b827d9`） |
| 7 | 修复测试漂移 | vitest 契约 | ✅ Round 1 修复，后续每轮同步 |

## 第二批（P1 — 架构增强）✅ 全部完成

| # | 优化项 | 状态 |
|---|--------|------|
| 8 | `builtin-chatanki_transform` | ✅ ops（Round 2）+ script 沙箱生产化（Round 3 #1）：快照 → 脚本 → CAS 写回 |
| 9 | LLM routing (plan_route) | ✅ Round 2 #9；Round 3 #7 与 analyze 同源 |
| 10 | Grounded judge 验收 pass | ◐ critic 已接（opt-in，Round 4 #2）；金标对 grounded 接线进行中（Round 5） |
| 11 | fill_missing_llm 策略 | ✅ Round 2 #10 两阶段策略 |
| 12 | 执行 FieldExtractionRule 校验 | ✅ Round 2：违规写 `_qa_flags` 不毙卡 |
| 13 | Multi-agent Phase 0 | ✅ Round 2 #6 档案；Round 3 #7 Phase 1 编排总线 |

## 第三批（P2 — 追平 SOTA）

| # | 优化项 | 状态 |
|---|--------|------|
| 14 | FSRS 复习数据回流制卡 | ✅ Round 3 #5：画像 + 干扰预警 + 拆卡建议，默认开 |
| 15 | 用户制卡偏好记忆 (Mem0 模式) | ◐ 纯逻辑 + retrieve 注入已接（Round 3 #10 / Round 4）；**写入侧持久化未接**（Round 5 进行中） |
| 16 | Sidekick 模型分层 | ◐ 四角色路由计划已算（Round 4 #7）；仅 Generator 槽消费，分槽进行中（Round 5） |
| 17 | 制卡 Playbook 沉淀 | ⬜ 未开始（学科×模板成功配置） |
| 18 | 制卡质量 eval harness | ✅ Round 3 #9：坏输出回放基线 + lint 契约对照；Round 5 扩容中 |
| 19 | 迁移划词制卡到 chatanki 后端 | ✅ Round 3 #4：CardForge 死链路清理完成 |
| 20 | AI 图像遮挡制卡 | ◐ 数据模型/校验/候选字段/草稿预览已接；可复习 Anki 导出、编辑器与完整输入覆盖未接 |

## Multi-Agent 落地路径

```
Phase 0（零代码）：content-curator + card-qa 自定义档案        ✅ Round 2 #6
Phase 1：workspace 文档通道加固 + card-coordinator 编排总线     ✅ Round 3 #7
Phase 2：QAAgent 只读卡面（get_cards/status/analyze/list_templates 豁免） ✅ 白名单已扩，豁免边界测试补全中
Phase 3（可选）：CardWriter 写权限委托                          ⬜ 未开始
```

推荐起步方案 A：**Coordinator 写卡 + 子代理产出内容/质检**，零后端改动——已落地。

## 子代理模型分工约定

| 场景 | 推荐模型 |
|------|----------|
| 调研/规划/复审 | claude-fable-5-thinking-xhigh |
| 修复/落地代码 | claude-fable-5-thinking-high |
| xhigh 不可用时 | 明示降级至同系列 high |
