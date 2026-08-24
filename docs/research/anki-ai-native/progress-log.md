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

**后续均已交付（Round 5 复核补记）：**
- [x] 子代理 #1：transform **script 模式生产化**（`26307d82`，`chatanki_transform_script.rs`）——
  沙箱 python/node 执行 + `CHATANKI_INPUT/OUTPUT` I/O 合同 + 结构化错误码 + CAS 写回，
  超越原「探索」定位直接落地
- [x] 子代理 #2：原生 Structured Output（`d4c3e296`，路线图 #1，`anki_protocol.rs`）——
  delimiter / json_object / json_schema 三协议 + auto 按供应商能力解析，81 测通过
- [x] 子代理 #5：FSRS 复习数据回流制卡（`283dbd52`，路线图 #14，`anki_fsrs_feedback.rs`）——
  用户复习画像 + 语义干扰预警 + 拆卡建议，默认开启可关
- [x] 子代理 #6：文档分段服务加固 24 测 + 真实边界修复（`b6800b13`）
- [x] 子代理 #7：APKG 媒体完整导入/导出闭环 + 结构化 mediaReport（`8497dcfa`，路线图相关）
- [x] cloze 扫描器 UTF-8 边界修复（`ad2367be`）

---

## Round 3 — 深化与编排（已完成）

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

## Round 4 — 能力扩展（已收尾，状态盘点见 `round4/00-round4-status.md`）

部分子代理因环境中断未回传报告，但代码已入库；Round 5 #8 已逐项复核接线状态。

- [x] 子代理 #2：LLM critic 生成后终审（`anki_critic.rs` + streaming 收尾）——
  opt-in（`enable_critic_pass`，默认关），模型/解析失败一律降级全 keep，
  成功派发 `CriticSummary` 事件；尚未暴露为 chatanki 工具参数
- [x] 子代理 #5：AI 图像遮挡制卡首版（详见 `round4/05-image-occlusion.md`）
  - 新增 `anki_image_occlusion.rs` 纯函数层：`OcclusionSpec{imageRef, boxes}`
    归一化坐标（0-1）校验（越界/重叠 IoU/空盒/零序号 结构化拒绝）、
    Cloze 导出字段约定（`Text` + `extra_fields["_occlusion"]` JSON +
    `image-occlusion` tag，兼容既有 APKG 路径）、`[IMAGE_DESC]` 启发式
    网格盒建议（零 LLM 成本，输出直接可过校验）、像素换算三重保证
  - 前端最小渲染：`utils/imageOcclusion.ts`（解析/换算与 Rust 镜像）+
    `ImageOcclusionOverlay.tsx`（百分比定位、同 clozeIndex 组揭开、受控/非受控）
  - 不动 chatanki_executor 管线与 builtin-templates.json；VlmFull 接线
    与 VLM grounding 升级路径见文档 §7；Rust 测试 ×19 + vitest ×11；
    **接线（VLM 路径 + 预览块渲染）遗留给 Round 5**
- [x] 子代理 #7：Sidekick 模型分层路由（`anki_model_routing.rs`）——
  `plan_routing` 产出 Planner/Generator/Critic/Vlm 四角色计划，
  流式生成路径消费 Generator 槽；三角色真正分槽遗留给 Round 5
- [x] 子代理 #8：transform ops 安全加固（`c9b9e86e`）——regex 增长炸弹逐卡拦截 +
  tag 长度上限
- [x] 子代理 #9：前端预览块展示 `_qa_flags` 摘要与 mediaReport 跳过原因
  （`028b1eb0` + `4bba4688`，详见 `round4/09-preview-ui.md`）——
  卡片级质检徽标（severity 图标 + 展开详情）、块级摘要条、APKG 媒体导入报告，
  28 个前端测试，无障碍不只靠颜色
- [x] 子代理 #10：金标挖掘纯函数（`anki_gold_set.rs`）+ eval lint 契约对照表
  （`d9bb7a83`，详见 `round4/10-gold-set.md`）；critic grounded 接线遗留给 Round 5
- [x] 其余入库项：run/start 生成调优参数 Rust 侧、偏好记忆 retrieve 注入
  （写入侧未接）、FingerprintTracker 接入流式、Phase 2 只读四工具白名单

---

## Round 5 — 接线收口与对齐（当前分支已核验，2026-08-24，PR [#215](https://github.com/helixnow/deep-student/pull/215)）

当前分支已交付（详见 `round5/00-round5-summary.md` 与各专题报告）：

- [x] 子代理 #1：run/start skill schema 补齐生成调优参数（`d1b827d9`，
  详见 `round5/01-skill-params.md`）——outputProtocol / visualHint / contentFormat /
  enableQaPass / enableFsrsFeedback / enablePreferenceMemory / maxImages 全暴露 +
  选用指南 + Round 5 契约测试；关闭 Round 4 状态盘点的第一优先缺口
- [x] 子代理 #10：eval lint 与 anki_qa_lint 完全对齐（`9da66ebd`，
  详见 `round5/10-eval-align.md`）——`anki_qa_lint::codes` 稳定常量导出 +
  JS 三分区表名值双对齐 + 6 边界 fixture，good 集 0 误伤
- [x] 子代理 #4：金标集接通 LLM critic（`c48140a4`，
  详见 `round5/04-grounded-critic.md`）——同文档用户修正对作为 grounded judge
  参照；独立金标预算；不可用时回退规则 rubric；critic 仍默认关闭
- [x] 子代理 #8：文档/进度/i18n/用户指南对齐当时代码基线（`5a58a2c8`）
  - `round4/00-round4-status.md` 逐项复核修订；`round5/00-round5-summary.md` 创建
  - `02-ai-native-gap-analysis.md` 评分重算 6.5 → **8.0/10**；
    `03-optimization-roadmap.md` 勾选完成项（P0 7/7、P1 6/6、P2 5/7）
  - 用户指南 12 章补：脚本级批量变换、质检标记徽标、APKG 媒体报告、
    FSRS 复习画像回流、生成调优参数（critic/遮挡未接线不写入，避免文档先行）
  - i18n：修复 `AnkiQaFlagBadge` 文案 key 引用不一致（`qaFlags` 提升为
    anki.json 顶层块）；script 模式文案替换过时的 `scriptModeUnimplemented`；
    新增 generation/critic/fsrsFeedback/occlusion 文案；中英 key 对称
- [x] 子代理 #6：最终文档/i18n 收口检查——复核 ChatAnki skill 为 **29 个**
  专用工具；`anki.json` 中英各 1019 个叶子 key 且集合完全对称；预览块混用的
  `anki` / `chatV2` key 均存在且两语言对称；用户指南只描述现行 ChatAnki 主路径；
  README 与本日志补记 grounded critic 真实接线状态

**尚未完成，继续按真实代码状态记录：**

- [ ] 偏好记忆写入侧（extract / consolidate 持久化）；当前仅 retrieve 接线，store 恒空
- [ ] 图像遮挡接入 VLM 生成路径与卡片预览块；当前仅纯函数与独立 overlay
- [ ] Sidekick Planner / Critic / Vlm 按角色真正分槽；当前生产路径只消费 Generator 槽
- [ ] `_original_generation` 稳定生成埋点；缺少快照时 grounded critic 会回退规则 rubric

---

## 变更记录

| 日期 | 轮次 | 变更 | PR |
|------|------|------|-----|
| 2026-08-24 | 0 | 初版调研文档 | [#215](https://github.com/helixnow/deep-student/pull/215) |
| 2026-08-24 | 1 | Round 1 汇总 + P0 bugfix | [#215](https://github.com/helixnow/deep-student/pull/215) |
| 2026-08-24 | 2 | extraRequirements / fill_missing_llm / plan_route / transform ops + 切卡器 + QA flags / Multi-agent 档案 | [#215](https://github.com/helixnow/deep-student/pull/215) |
| 2026-08-24 | 3 | qa lint / eval harness / CardForge 清理 / 偏好记忆 + 文档 i18n 收口 | [#215](https://github.com/helixnow/deep-student/pull/215) |
| 2026-08-24 | 3 后半 | transform script 生产化 / Structured Output / FSRS 回流 / 分段加固 / APKG 媒体闭环 / analyze 同源 + Multi-agent Phase 1 | [#215](https://github.com/helixnow/deep-student/pull/215) |
| 2026-08-24 | 4 | LLM critic / 图像遮挡首版 / Sidekick 路由 / transform 加固 / 预览块 QA+媒体 UI / 金标纯函数 | [#215](https://github.com/helixnow/deep-student/pull/215) |
| 2026-08-24 | 5 | run/start 调优参数 schema 全暴露；grounded critic 接线；eval lint 对齐；文档/i18n/用户指南最终复核（未完成项继续显式列出） | [#215](https://github.com/helixnow/deep-student/pull/215) |
