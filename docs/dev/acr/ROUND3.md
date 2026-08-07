# ACR 第三轮 — 5 个总体调试/优化任务卡

> 输入：R2 产物 + 协调者第二次验收报告（含运行时冒烟发现的问题清单）。
> R3 是收敛轮：目标是 SCENARIOS.md 全绿 + DESIGN §7 性能预算达标 + SOTA 清单逐条可勾。写权全库开放但**修复优先、重构禁止**；每处修改必须在报告中给出"问题→根因→修法"三段。

### R3-01 全场景回归与修复
- 逐条执行 SCENARIOS.md（代码走查 + 单测复现；运行时项列为"待协调者执行"并给出精确操作步骤与预期）。
- 每条场景标记 PASS / FAIL(修复 commit 范围) / BLOCKED(原因)；FAIL 的当场修。
- 交叉场景补充：连续多工具编排（agent 一次回复驱动 3+ 应用）、同窗口连续两个 run、会话切换中 run 存活。

### R3-02 性能压测与调优
- 构造压测场景：双窗并发演出 + 焦点窗拖拽；200 节点导图逐 op 生长；5k 字笔记打字机 + 用户同时输入；50 条 todo 批量创建 flash。
- 用 DevPanel/perfMonitor 采样填写 `docs/dev/acr/PERF-REPORT.md`：fps、droppedFrames、longTasks、INP 估算，对照 DESIGN §7 逐项判定。
- 超预算项调优：批量粒度、节流参数、动画属性、订阅粒度（禁架构级改动，参数级与实现级优化为主）。

### R3-03 交互与文案打磨
- 动画时序统一审（光环呼吸周期、flash 时长、打字机节奏三档体感）；reduced-motion 全路径复核。
- 全部 agent 相关文案双语终审（工具描述、错误 hint、AgentStrip、工具卡、设置项）；`check:i18n` + 人工读一遍。
- a11y：AgentStrip 按钮可键盘操作、aria-live 通告"AI 开始/暂停/完成操作"、光环不依赖纯颜色区分。
- HAX 对照（G1/G2/G7/G8/G9/G10/G11）逐条给出实现证据，写入验收报告。

### R3-04 稳健性混沌
- 编写混沌单测/脚本：取消与完成竞态 ×1000（无双写/无泄漏 presence/无悬挂 Promise）；桥超时注入；driver 抛异常（run 必须收敛为 failed 回执且 presence 清理）；连续 partial 后 LLM 重试路径（doom-loop 计数不误杀）。
- 幂等审计：同一 AgentOp 重放不产生重复实体（todo/闪卡重点）；revert 两次调用安全。
- 注入防御抽查：笔记/网页内容中的指令文本不会被拼进高危工具参数（走查 prompt 组装点）。

### R3-05 文档同步与终验报告
- DESIGN.md 按最终实现勘误（标注"实现偏差"小节，不重写历史）；ERRORS.md、SCENARIOS.md 终版。
- 汇总 `docs/dev/acr/ACCEPTANCE.md`：SOTA 清单（功能完备/交互质量/性能/稳健性/安全 五组，来自 STANDARDS 引用的调研清单）逐条勾验 + 证据链接（测试文件/报告/场景编号）。
- 盘点全部遗留项分级（P0 必修 / P1 可后补 / P2 建议），给协调者最终验收用。
- 各 progress 报告索引与三轮变更文件总清单（供人工 review 与后续 commit 切分）。

---

## 终验（协调者）
1. cargo check + clippy（若配置）全绿；typecheck / lint / vitest 全量 / check:i18n 全绿。
2. `npm run tauri dev` 运行时冒烟：SCENARIOS 抽 10 条（覆盖 8 应用 + 打断 + 撤销 + 降级）。
3. DevPanel 实测性能对照 PERF-REPORT 抽验。
4. ACCEPTANCE.md 逐条确认后宣布落地完成。
