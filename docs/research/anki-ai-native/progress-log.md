# 多轮优化进度日志

## 目标

- 深度调研 Anki 卡片生成 AI-Native 符合度
- 多轮持久优化（≥20 轮 × 10 子代理/轮）
- 各模块打磨至 SOTA 级别
- 成果提交 PR 至 `cursor/anki-ai-native-research-bfca`

---

## Round 0 — 初探（2026-08-24）

**完成项：**
- [x] 项目整体架构探索
- [x] Anki 相关 58+ 文件定位
- [x] 完整流程梳理（Agent 编排 + Rust Pipeline）
- [x] AI-Native 初评 6.5/10
- [x] 创建 Goal + 专属分支 + 调研文档骨架

**核心发现：**
- 混合架构：Agent 决定「何时做什么」，Rust 决定「怎么做」
- `local_shell_execute` 存在但未接入 chatanki
- CardForge 2.0 设计 vs 生产路径 divergence

---

## Round 1 — 深度子系统分析（2026-08-24 完成）

**10 个子代理任务：全部完成**

**核心产出：**
- `02-ai-native-gap-analysis.md` — 差距矩阵
- `03-optimization-roadmap.md` — 20 项优化路线图
- `round1/00-round1-summary.md` — 汇总
- `round1/04-shell-script-integration.md` — transform 工具草案
- `round1/08-sota-agent-benchmark.md` — SOTA 对标

**P0 代码修复（Round 1 末）：**
- [x] VlmFull 分支先 extract_text 再 VLM（修复数据丢失 bug）
- [x] chatAnkiAgentLoop 工具数 26→28 + 显式清单 diff
- [x] CardAgent 空闲超时契约对齐 `ok:false, timedOut:true`

---

## Round 2 — P0 实现（进行中）

**计划：**
- Structured Output / 括号深度切卡器
- 确定性质检 lint
- [x] extraRequirements 参数暴露（run/start args → build_chatanki_requirements 追加；skill schema + 系统提示文档 + Rust 测试）
- chatanki_transform 工具落地
- Multi-agent Phase 0 档案
- [x] 子代理 #10：retemplate 新增 `fill_missing_llm` 两阶段策略（路线图 #11，修复 Round 1 #9 "fill_missing 名不副实" gap）
  - Phase 1 复用既有单事务换模板；Phase 2 按批（≤8 卡）`call_model2_raw_prompt` 补缺失字段并以 Phase 1 后版本逐卡 CAS 写回，失败不回滚 Phase 1
  - payload 逐卡扩展 `fillStatus/filledFields(/fillError)`，顶层 `fill` 汇总；`fill_missing` 语义保持不变
  - schema enum、skill 系统提示、`docs/anki-agent-tools.md` 同步；新增 Rust 单测 ×5 + vitest 契约更新

---

## 变更记录

| 日期 | 轮次 | 变更 | PR |
|------|------|------|-----|
| 2026-08-24 | 0 | 初版调研文档 | 待创建 |
| 2026-08-24 | 1 | Round 1 汇总 + P0 bugfix | 待创建 |
