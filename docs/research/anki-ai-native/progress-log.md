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

## Round 2 — P0/P1 实现（2026-08-24 完成）

**完成项：**
- [x] extraRequirements 参数暴露（run/start args → build_chatanki_requirements 追加；skill schema + 系统提示文档 + Rust 测试）
- [x] decide_route / looks_like_glossary_content 边界表驱动测试 + execute_analyze simple_text 行为 pin
- [x] 子代理 #6：Multi-agent 制卡自定义档案（content-curator / card-qa）+ 配套技能片段（路线图 #13 Phase 0）
- [x] 子代理 #8：streaming_anki_service 解析内环单测包
- [x] CardForge Prompt 装配层 P0 修复（删除 `{{DOCUMENT_CONTENT}}` 占位符、统一 END-only 输出协议，路线图 #5）
- [x] 子代理 #10：retemplate 新增 `fill_missing_llm` 两阶段策略（路线图 #11，修复 Round 1 #9 "fill_missing 名不副实" gap）
  - Phase 1 复用既有单事务换模板；Phase 2 按批（≤8 卡）`call_model2_raw_prompt` 补缺失字段并以 Phase 1 后版本逐卡 CAS 写回，失败不回滚 Phase 1
  - payload 逐卡扩展 `fillStatus/filledFields(/fillError)`，顶层 `fill` 汇总；`fill_missing` 语义保持不变
  - schema enum、skill 系统提示、`docs/anki-agent-tools.md` 同步；新增 Rust 单测 ×5 + vitest 契约更新
- [x] 子代理 #9：`plan_route` LLM 导入路由规划（路线图 #9）——goal + 引用元数据 + 文本采样一次轻量 LLM 调用产出路由计划；forced_route 优先，置信度不足/调用失败回退 decide_route 启发式，管线不因规划失败中断
- [x] `chatanki_transform` ops 模式落地（路线图 #8）+ brace-depth 切卡器（路线图 #2 阶段 A）+ 字段校验 QA flags（路线图 #12，违规不毙卡、写 `_qa_flags` 留痕）
  - chatanki 工具数 28 → **29**（新增 `builtin-chatanki_transform`：dry_run 逐卡 diff → apply 逐卡乐观锁写回；`regex_replace`/`tag_add`/`tag_remove` ≤20 个按序应用；script 沙箱模式预留）

---

## Round 3 — 打磨到可合并质量（2026-08-24，PR [#215](https://github.com/helixnow/deep-student/pull/215)）

**已提交：**
- [x] 子代理 #3：确定性卡片质检 lint 引擎（路线图 #3）——12 类规则、零 LLM 成本、默认 flag 不毙卡，48 单测（`anki_qa_lint.rs`）
- [x] 子代理 #4：CardForge 死链路清理 + 划词制卡迁向生产路径（路线图 #19）
- [x] 子代理 #9：制卡质量 eval harness + 坏输出回放基线（路线图 #18）+ 金标集挖掘方案
- [x] 子代理 #10：用户制卡偏好记忆（路线图 #15，Mem0 风格 ADD-only）+ 文档/i18n 收口
  - `anki_preference_memory.rs`：extract（语言/卡密度/禁翻译/模板四类，显式要求 > 重复行为 > 统计信号）→ consolidate（ADD-only：重复强化、矛盾共存、绝不改写删除）→ retrieve（每 kind 择一 + 不可用模板过滤 + token 预算装箱），19 单测；本轮不接线，API 供后续 `chatanki_run` 调用
  - i18n：`anki.json` 新增 `agent.*` 块（transform / retemplate fillStatus / qaFlags / analyze routeSource / preferenceMemory），中英 key 全量对称（1005 = 1005）
  - 用户指南 12 章对齐现码：29 工具、transform 试运行→确认→应用、fill_missing_llm 自动补字段、plan_route 智能路由、质检标记；无 CardForge 主路径残留描述
  - `round3/00-round3-summary.md` + `round3/10-preference-memory.md`

**进行中（以各子代理最终 commit 为准）：**
- [ ] 子代理 #1：chatanki_transform 打磨 + `docs/anki-agent-tools.md` transform 专节
- [ ] 子代理 #2：原生 Structured Output（路线图 #1，`anki_protocol.rs`）
- [ ] 子代理 #5：FSRS 复习数据回流制卡（路线图 #14，`anki_fsrs_feedback.rs`）
- [ ] 子代理 #6：Multi-agent card-coordinator 档案深化
- [ ] 子代理 #7：APKG 导入/导出加固
- [ ] 子代理 #8：transform 沙箱脚本模式探索（`chatanki_transform_script.rs`）

---

## Round 3 — 深化与编排（进行中）

- [x] 子代理 #7：`chatanki_analyze` 与管线路由同源 + Multi-agent Phase 1
  （详见 `round3/07-analyze-and-multiagent.md`）
  - 新增 `RouteSource`/`RouteDecision`/`resolve_route_decision` 唯一路由决策入口，
    管线与 analyze 共用；analyze 支持 resourceIds/route/goal 真参与，输出
    `routing.routeSource=forced|llm|heuristic + confidence + glossaryMode + reason`，
    消灭「永远推荐 simple_text」
  - 词汇表启发式收敛：`count_entry_like_lines` / `glossary_generation_knobs` /
    `default_max_cards_for_content` 共享函数，analyze recommended 与
    `build_generation_options` 逐字段同源（测试双保险）
  - Phase 1：`agents/skills/card-coordinator/SKILL.md` 固化五阶段编排总线
    （content-curator → chatanki_run → card-qa → batch_update → 复检交付），
    含降级规则；`workspace_read/update_document` 不放宽进 worker 白名单，
    补 fail-closed 测试双向钉死能力边界
  - chatanki skill 新增「策展 → 生成 → 质检 决策树」章节 + analyze schema 更新；
    Rust 契约测试 ×11（含 8+ analyze 输出契约）

---

## 变更记录

| 日期 | 轮次 | 变更 | PR |
|------|------|------|-----|
| 2026-08-24 | 0 | 初版调研文档 | [#215](https://github.com/helixnow/deep-student/pull/215) |
| 2026-08-24 | 1 | Round 1 汇总 + P0 bugfix | [#215](https://github.com/helixnow/deep-student/pull/215) |
| 2026-08-24 | 2 | extraRequirements / fill_missing_llm / plan_route / transform ops + 切卡器 + QA flags / Multi-agent 档案 | [#215](https://github.com/helixnow/deep-student/pull/215) |
| 2026-08-24 | 3 | qa lint / eval harness / CardForge 清理 / 偏好记忆 + 文档 i18n 收口 | [#215](https://github.com/helixnow/deep-student/pull/215) |
