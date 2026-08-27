# Wave2-A 第 9 轮：台账开项分类闭合表（#1 席）

- 作者：0824 Wave2-A 第 9 轮子代理 #1（`claude-fable-5-thinking-xhigh`）
- 日期：2026-08-26
- 基线：`cursor/0824-wave2-agent-cache-a875` @ `dd300cd3`；官方基座
  `origin/cursor/0824-cde6` @ `061b4815`
- 性质：本席独占可写面 = `history.rs`（仅小问题 C）+ 本文档。未 commit/push，
  未执行 cargo/npm/编译/测试（本机 rustc 1.83.0 ≠ 项目要求 1.98，铁律停测）。
- **快照口径**：第 9 轮各席并行写作。本表「已闭合」列中标注「本席快照时点
  已落盘」的项以本席 `git diff --stat` 实际取证为据；标注「任务卡排定、
  快照时点未见 diff」的项以父代理收轮时工作区为最终口径，本表不冒充完成。

---

## 0. 小问题 C 落地记录（本席，本轮已闭合）

`history.rs` 两个兼容入口在**非 test 生产构建**下无调用方（生产 history
重放三个消费点 `:164` / `:333` / `:365` 一律走
`rebuild_anchored_skill_messages_gated_with_signal`；`helpers.rs:2375` 与
`skill_replay_digest_tests.rs` / `skill_replay_edit_delete_tests.rs` /
`history.rs` 文件内测试均为 `#[cfg(test)]` 调用，本席 grep 全量复核）。处置：

- `rebuild_anchored_skill_messages`（现 `:846`）：rustdoc 末尾加一句
  「非 test 构建下本入口仅作兼容薄包装（无生产调用方），生产路径走
  `rebuild_anchored_skill_messages_gated_with_signal`」+
  `#[cfg_attr(not(test), allow(dead_code))]`（现 `:845`）。
- `rebuild_anchored_skill_messages_gated`（现 `:877`）：同款一句 rustdoc +
  同款属性（现 `:876`）。

**未改**：两函数体、门禁判定语义、TOCTOU/锚点逻辑、`helpers.rs`、任何测试。
`cfg_attr(not(test))` 保证 test 构建下属性不生效——若未来测试删光导致真死
代码，test 构建仍会告警，不产生静默豁免面。

---

## 1. 本轮已闭合（第 9 轮收口轮处置）

| 开项 | 处置席位 | 状态与证据 |
|---|---|---|
| 小问题 C：二参兼容入口 dead_code（R4 起顺延） | #1（本席） | **已落盘**。见上节；`git diff` 仅 +6 行（2 句 rustdoc + 2 个属性 × 2 入口） |
| stream_filter_core 文档改口（R4-8 翻案后的头注释挂载表述） | #3 | **本席快照时点已落盘**（`stream_filter_core.rs` 文件头 diff +15/−12 可见） |
| r4-catalog-delta §4 键名过时勘误（delta 换代键名与 R5 落地形态不一致） | #3 | **本席快照时点已落盘**（`r4-catalog-delta.md` 只追加勘误节 +34 可见） |
| tool_loop.rs 文件头「冻/不冻/切代」矩阵按 R3–R6 现状改口 | #4 | **本席快照时点已落盘**（`tool_loop.rs:1-39` 区 diff +21/−若干可见） |
| R5-M2-1 指纹 scope key 注释过满宣称收窄 | #6 | **本席第二次快照已落盘**（`model2_pipeline.rs` 进入 M 列表 + `r9-dead-code.md` 落盘）；内容以父代理收轮为准。定性已在 R6-5 澄清：翻案只打 CACHE_DEBUG 指纹 scope key，usage 行不受影响 |
| 架构文档三处勘误 + B2/B4/B7 状态补记（R6-5 遗留） | #2 | **任务卡排定、本席快照时点未见 diff**——以父代理收轮为准；只追加勘误节，不改写更早节正文 |

---

## 2. 本会话明确不闭合（写清归属或原因）

以下各项在本会话（第 1–9 轮 + 第 10 轮归档）内**不做**，理由分四类：
产品逻辑改动超出收口轮红线（甲）、独占面/域归属不在本会话席位（乙）、
环境阻断（丙）、明令禁修（丁）。

| 开项 | 类 | 归属 / 不闭合原因 |
|---|---|---|
| retry llm_content 缺口：retry 传全新 `user_message_id`，early persist 与 save_results 双双找不到原 user 行的块，retry 实发包装无处落库，下轮重放字节可漂移（R6-6 遗留 1；V20260806 起既有语义，非本会话引入） | 甲 | 修复位在 retry handler（产品逻辑）。r7 #6 已写好「修复合同」测试 5–6（复用前置 user id），修复落地时测试 1–4 应翻转、5–6 转生产断言——留给具备实测能力的后续会话 |
| multi_variant 扇出不走 `execute_internal`，无发送前 early persist（R3 已记，与 retry 缺口同组）；变体路径 `load_variant_chat_history` 亦无技能锚点还原（r6 #4 观察） | 甲/乙 | multi_variant 席位面 + 产品逻辑；崩溃窗与主对话不对称，修复应与 retry 缺口同轮成组设计 |
| #7 delta 发送路径接线：目录 delta 只有设计与局部原语，未贯通发送 | 甲/乙 | R6-5 认识升级：需 **TS 侧 SendOptions 新字段透传 + Rust 侧注入点**，跨两侧独占面；三轮顺延的根因即单席面不够，建议后续接线轮排成对席位。TauriAdapter 本会话禁改 |
| pending 换代标记只在 loadSession hydrate 检测（TauriAdapter `:194/:218/:233/:3804`）；live 会话中途后端写入的 pending 要等重新加载才被前端拾取 | 甲/乙 | TauriAdapter 本会话禁改；属 #6 换代标记接线（R5-6 #9 已闭环部分）的已知窄口，与 delta 接线同面，宜同轮处理 |
| 删除/停用技能（正文缺失）不进切代信号：有 digest 即证明锚定时正文在，缺失同为确定性漂移，但现行为 warn+skip 不发信号（r6 #4 观察；r7 #4 反例测试已钉死现状，语义扩展时该断言应翻转） | 甲 | 语义扩展候选，需产品裁决（扩展会改变 r3 以来「缺正文=旧行为」的兼容契约）；本会话只钉现状不扩展 |
| G-CC400：CC 严格端点 system 数组 + 块级 `cache_control` 直发，官方 DeepSeek V3.x 回落路径确定性 400 风险（r1 额外发现表） | 甲/丁 | providers 协议逻辑本席禁改区、全轮只收口文档；修复需协议压平+剥离 + 真实端点实测 |
| G3：Anthropic 断点仍打在含 `user_profile` 等易变段的整块 system 尾，未拆稳定/易变块，缓存命中收益无证据 | 甲 | 同上，产品逻辑 + 需真实 provider 请求验证命中率 |
| G-FIFO：FIFO 32K 头删抢在 compaction 前把前缀清零（阈值让位未做） | 甲 | compaction 面产品逻辑，收口轮禁大改 |
| G-compact-hooks：`before_compaction` 不可阻断、无 `after_compaction` 切点 | 甲 | 同上；补切点虽可默认实现零破坏，但涉 hooks 面，本会话 hooks 准入序列红线 |
| V20260826 中断收敛：两条 `ALTER TABLE` 已落盘但 refinery history 未落盘时重跑硬失败；`coordinator.rs` 硬编码清单止于 V20260824，与 `llm_usage/database.rs` 的成对收敛未做 | 乙/丁 | **归 D 域**。`coordinator.rs` 本会话全程红线未碰（R9-2 红线自证 3：相对官方基座零 diff）——本会话明确不碰，交 D 域会话成对处理 |
| qbank_grading 出口挂接：题库批改流式 `qbank_grading/pipeline.rs` 与作文出口暴露面相同，R4-4 发现即越界未改 | 乙 | **归 E 域**（题库/Anki 面独占红线）；挂接方式按 R4 #2 同构即可，但动手权不在本会话 |
| issue #122（流式乱码）仍 OPEN | 丁 | **明令禁修**。本枝只保留 `utf8_stream.rs` 定位探针（warn 只记长度类元数据，不记 chunk 内容，注释明示不声称修复）；禁止任何席位宣称修了 #122 |
| 实测欠账：第 1–8 轮全部 Rust/TS 改动与 3000+ 行测试源码零执行 | 丙 | **环境阻断**：本机 rustc 1.83.0（要求 1.98）、无 node_modules/vitest；铁律禁装工具链/依赖、禁空转编译。R8 六个实测席位全部版本探针后即停。需环境先备齐 1.98 + 前端依赖 |
| hooks fail-closed 测试脱靶（R8-2 评级 C/D，R8-3 补强优先级第 1）：三条 fail-closed 测试只调测试专用 `approval_manager_required`，真实 `ApprovalGateHook::before_tool` 错误放行仍可全绿 | 甲/丙 | 补强 = 改打生产 `before_tool` + counting executor 证零执行，属测试改写（hooks/负例测试本会话禁改）且补强后仍需实测环境跑红绿——整体移交后续会话，R8-3 清单为输入 |

---

## 3. 第 10 轮仅文档归档（无代码行动项，归档即闭合）

| 开项 | 归档口径 |
|---|---|
| 守卫外误剥向量（Anthropic 尾部保险断点在预算守卫**前**追加，参与预算核算；理论上调用方 marker 增多时可致误剥） | R6-5 #10 已重验代码顺序与可达性：生产打点面仅 `model2_pipeline.rs:4046` 1 个 system marker，块级合计 2 ≤ 3 预算内，**维持潜伏级**。无代码行动项；归档时注明「未来任何席位新增块级 marker 须重新核算 4 槽预算」即可 |
| digest 冲突走 catalog pending 而非 tool-face generation | R5 #6 设计裁决（非缺陷）：技能正文漂移是 history 段事件，逼 `converge_session_tool_face_prefix` 切代会破坏「唯一切代点 = 真分叉」的冻结矩阵不变量且切错段；走 `availableSkillsSnapshotPendingGeneration` 与 compaction 同构、增量损失最小。归档统一口径，防后续会话误当 bug 重开 |
| Responses 面调用方块级断点被 `push_message_parts` 静默剥掉 | R6-6 #8 已定性为**设计决策非缺陷**（适配器单一作者制，守 S13 陷阱与 4 写槽预算），与 Anthropic 侧 tools 透传开口是有意不对称。归档定性即可 |
| 台账历史勘误残留 | R6-6 §8 已在台账内更正（r1 行号漂移 `:5011→:5382` / `:6118→:6404`；r1「Anthropic 顶层 cache_control 非标」定性已按官方文档纠正为标准 automatic caching 参数）。第 10 轮归档时确认引用 r1 者均以 R5-7/R6 口径为准，不再改写 r1 正文 |
| r7 五个新建测试文件的 `#[cfg(test)] mod` 接线（pipeline × 3 + providers × 2） | 父代理收轮事项（R7-3 已列清单）；未挂 mod 前不参与编译。归档时记录最终挂/不挂决定即可，本会话不由席位代挂 |
| R8-3 五条测试补强优先级清单 | 本身即文档产物；归档为后续「具备 rustc 1.98 + 依赖」会话的开工输入（顺序：hooks fail-closed 改打生产路径 → fork/crash 迁生产 seam → Anthropic null 反例 → provider prefix 宣称收窄 → skill 贯通/token trace） |
| PR #345 描述定稿 | #9 已出初稿（`r9-pr-body.md`，Draft 定性 + 静态/运行时证据边界诚实声明）；第 10 轮/父代理据收轮实况定稿，**保持 Draft、不标 Goal complete** |

---

## 4. 自证与边界

- 本席改动面：`history.rs` +6（属性/注释，函数体零改动）+ 本文档新建。
- 红线复核（本席 grep/status）：未碰 coordinator.rs、hooks、负例测试、
  providers 协议逻辑、TauriAdapter、Composer、helpers.rs；未改门禁语义/
  TOCTOU/锚点逻辑。
- 本表全部结论为静态取证（读码 / grep / git diff / 台账通读），不构成
  编译或运行时证据；「已闭合」仅指源码/文档层面收口，与 r9-pr-body.md
  的 Draft 口径一致。
