# Round 3 汇总 — P1/P2 落地 + 打磨到可合并质量

> 日期：2026-08-24 | 分支：cursor/anki-ai-native-research-bfca | PR：[#215](https://github.com/helixnow/deep-student/pull/215)

## 子代理产出索引

| # | 主题 | 交付物 | 状态 |
|---|------|--------|------|
| 1 | chatanki_transform 打磨（ops 模式收口 + 文档专节） | `chatanki_transform.rs`、`docs/anki-agent-tools.md` transform 专节 | 🔄 进行中 |
| 2 | 原生 Structured Output（路线图 #1） | `anki_protocol.rs`、`round3/02-structured-output.md` | 🔄 进行中 |
| 3 | 确定性卡片质检 lint（路线图 #3） | `anki_qa_lint.rs`（48 测试）、`round3/03-qa-lint.md` | ✅ 已提交 |
| 4 | CardForge 死链路清理 + 划词制卡迁移（路线图 #19） | cardforge 清理 commit、`round3/04-cardforge-cleanup.md` | ✅ 已提交 |
| 5 | FSRS 复习数据回流制卡（路线图 #14） | `anki_fsrs_feedback.rs` | 🔄 进行中 |
| 6 | Multi-agent 档案深化（card-coordinator） | `agents/skills/card-coordinator/` | 🔄 进行中 |
| 7 | APKG 导入/导出加固 | `apkg_importer_service.rs` / `apkg_exporter_service.rs` | 🔄 进行中 |
| 8 | transform 沙箱脚本模式探索 | `chatanki_transform_script.rs` | 🔄 进行中 |
| 9 | 制卡质量 eval harness（路线图 #18） | eval harness + 坏输出回放基线、`round3/09-eval-harness.md` | ✅ 已提交 |
| 10 | 用户制卡偏好记忆（路线图 #15）+ 文档/i18n/进度 | `anki_preference_memory.rs`（19 测试）、`agent.*` i18n 块、用户指南修订、`round3/10-preference-memory.md` | ✅ 已提交 |

> "进行中"条目以该子代理的最终 commit 为准；本表由 #10 在其提交时点快照。

## 本轮核心成果

1. **质量地基收口**：确定性 lint（12 类规则、零 LLM 成本）+ eval harness（坏输出
   回放基线）形成"生成时拦截 + 回归时度量"闭环，路线图 #3/#18 落地。
2. **死代码清障**：CardForge 死链路移除，划词制卡迁向 chatanki 生产路径（#19），
   消除 Round 1 识别的"设计文档 vs 生产路径 divergence"。
3. **个性化起步**：偏好记忆（Mem0 风格 ADD-only）纯逻辑就绪（#15），四类偏好
   （语言/密度/禁翻译/模板）可从真实行为抽取并按 token 预算注入，待接线。
4. **面向用户收口**：用户指南对齐 29 工具现状（transform / fill_missing_llm /
   plan_route / 质检标记），i18n 中英 key 全量对称。

## Round 2 → Round 3 的承接

Round 2 交付的 transform ops、fill_missing_llm、plan_route、QA flags 在本轮完成
「文档 + i18n + 用户指南」侧收口；Round 2 尚未覆盖的 P2 项（FSRS 回流 #14、
偏好记忆 #15、eval harness #18、CardForge 清理 #19）在本轮启动或完成。

## Round 4 候选

- 偏好记忆接线：`chatanki_executor` 会话收尾收集观察 + `chatanki_run` 注入检索结果
- Structured Output 灰度：与 brace-depth 切卡器并行对照
- transform 沙箱脚本模式（script-native 终局）
- eval harness 进 CI：PR 级回归门禁
