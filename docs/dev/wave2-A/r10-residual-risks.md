# Wave2-A R10 #7：遗留风险清单

## 口径

- 基线：本枝 `659b8c54`，官方基座 `origin/cursor/0824-cde6` @ `061b4815`。
- 输入：`r9-open-items.md`、总台账 R6–R9，以及本席写作时已落盘的
  `r10-cache-hit-static.md`、`r10-pr-body.md`。
- 本文只做静态归档；未执行 npm、cargo、编译、格式化、测试或安装，未改产品/
  测试代码。
- 「是否本 PR 引入」按相对官方基座判断；「否」不表示风险可忽略，只表示本枝
  发现或继承了它。严重度是交付风险，不等同于原 P1–P11 需求编号。
- 处置含义：**吸收前必修** = 吸收对应切片前必须取得修复与运行证据；
  **可后置** = 可保持 Draft 并明确边界后另排；**外会话** = 当前 A 收口会话
  无权或不应处理。

## 一、吸收门禁

| ID | 遗留风险 | 严重度 | 归属 | 是否本 PR 引入 | 建议处置 | 验收要点 |
|---|---|---|---|---|---|---|
| RR-01 | **实测零执行**：第 1–8 轮 Rust/TS/Python/SQL 改动及 3000+ 行测试源码没有一次编译或运行证据；四项硬门禁、六族 cargo test、TauriAdapter Vitest、真实 SQLite 升级和真实 provider 请求均未跑。R8 只确认 rustc 1.83.0 不满足要求的 1.98、且无 `node_modules` 后停测。 | **P0** | A 后续 | **是**（本 PR 的交付状态） | **吸收前必修** | 在具备 Rust 1.98 与已物化前端依赖的环境执行类型/构建/migration 门禁和定向测试；失败必须归因，不能把静态推演记为通过。 |
| RR-02 | **V20260826 coordinator 中断收敛缺口**：两条 `ALTER TABLE` 已落盘、refinery history 未落盘时，重跑可能因 `variant_id` 重复列硬失败；`coordinator.rs` 与 `llm_usage/database.rs` 的硬编码收敛均止于 V20260824。 | **P0** | D | **是**（本 PR 新增 migration） | **吸收前必修** | 由 D 域成对修改两条收敛路径，并覆盖两条 ALTER 的部分落盘排列与重复启动；本会话不得单边补一处。 |
| RR-03 | **hooks fail-closed 测试脱靶**：三条名为缺 ApprovalManager 时 fail-closed 的测试只调用测试专用 `approval_manager_required`；真实 `ApprovalGateHook::before_tool` 即使错误放行仍可全绿。R8 静态评级 C/D，并列为 P0 补强优先级。 | **P0** | A 后续 | **否**（既有测试债；本 PR 未改准入控制流） | **吸收前必修** | 直打生产 `before_tool`，覆盖 Low/Medium/High/unknown + manager=None，并以 counting executor 证明 Block 后零执行；保留现有 hooks 顺序与 TOCTOU 红线。 |
| RR-04 | **fork 测试契约副本假绿**：两组 8 个测试/80 个断言的核心 converge、generation、restart、advance 都由测试内副本完成，未调用生产 `converge_session_tool_face_prefix`、真实 repo 或 SQLite；生产收敛被删除/反排/不 bump 时仍可全绿，且遗漏 R6 新增的 digest 共识采纳。 | **P1** | A 后续 | **是** | **吸收前必修** | 抽出生产纯内核供现有 oracle 调用，并补真实 DB 的 load/converge/advance/restart、digest 共识采纳/分叉不采纳用例。 |
| RR-05 | **llm_content crash 测试假绿**：13 条 crash 测试的持久化、阶段 4.6 与 history override 主要由 fake/手写副本模拟，生产实现大面积回归时仍可能全绿。 | **P1** | A 后续 | **是** | **吸收前必修** | 用测试 DB 贯通真实 early persist → repo → history；至少复现「provider 已收、sidecar 未保存」并验证重启后的发送字节。 |
| RR-06 | **Anthropic `cache_control:null` 未拒绝**：调用方 Null 会成为 `Some(Value::Null)`，被计数为 marker、抑制保险断点并可能原样上线；现有“无 null”测试只覆盖守卫 `take()` 产生的 None。 | **P1** | A 后续 | **是**（R5 tool marker 透传后形成上线暴露） | **吸收前必修** | tools/system 两路补 Null/非法 marker 反例，最终 wire body 不得含 `cache_control:null`；在真实或协议等价端点验证。 |
| RR-07 | **provider prefix 测试证据被高估**：测试直达三家转换器，但只证明选定 JSON 组件的确定性；不等于完整 raw wire 前缀，更不能推出缓存命中，且动态 assistant/tool/user 尾部被转换器误丢时仍可能绿。 | **P1** | A 后续 | **是** | **吸收前必修** | 收窄测试名/PR 宣称，逐路径断言动态尾部存活，并取得真实请求体或等价 wire 捕获；命中率另以 provider 遥测证明。 |

## 二、产品与协议开放项

| ID | 遗留风险 | 严重度 | 归属 | 是否本 PR 引入 | 建议处置 | 建议与边界 |
|---|---|---|---|---|---|---|
| RR-08 | **retry 崩溃窗 / `llm_content` 落库缺口**：retry 使用新 `user_message_id`，early persist 与 `save_results` 都找不到原 user CONTENT 块；retry 实发包装不落库，下轮重放可从该历史 user 消息开始漂移。 | **P1** | A 后续 | **否**（V20260806 起既有） | **可后置** | 与 RR-09 同轮设计；复用前置 user id 或建立显式映射。R7 retry 测试 5–6 只是修复合同副本，落地后须转生产断言。 |
| RR-09 | **multi_variant 崩溃窗**：fan-out 不走 `execute_internal` 的发送前 early persist，provider 已收但 sidecar 未落库时，当轮 live 包装丢失；崩溃语义与主对话不对称。 | **P1** | A 后续 | **否** | **可后置** | 与 retry 一起补发送前持久化和真实崩溃恢复测试，避免再造一套只在测试内成立的时序。 |
| RR-10 | **multi_variant 技能重放缺口**：`load_variant_chat_history` 不重建技能锚点，也没有 digest 门禁/换代信号，变体 history 与单变体路径存在前缀和语义差异。 | **P1** | A 后续 | **否** | **可后置** | 复用生产 history 门禁并补变体端到端用例；不得仅复制门禁算法。 |
| RR-11 | **catalog delta 未接线**：`generateAvailableSkillsDeltaPrompt` 等局部原语已存在，但没有贯通 TauriAdapter/`SendOptions` 到 Rust 当前 user 注入点；“尾部零前缀成本”收益当前不存在，返回值中的 `baseSkillIds` 也是真只写字段。 | **P2** | A 后续 | **是**（新增局部原语但未形成生产能力） | **可后置** | 后续以 TS/Rust 成对席位接线，接在瞬态技能指令之后；未接线前不得把 delta 写成已交付能力，可顺手删返回对象冗余字段。 |
| RR-12 | **pending 仅在 loadSession hydrate 消费**：live 会话中途由 compaction/digest 写入的 pending，要等重新加载才被前端拾取；没有 compaction 成功事件驱动即时收敛。 | **P1** | A 后续 | **是** | **可后置** | 与 delta 同轮补 live 通知/刷新；在此之前只能声称“重载后兑现”，不能声称端到端即时闭环。 |
| RR-13 | **删除/停用技能不发切代信号**：有 digest 的锚点遇正文缺失时只 warn+skip；虽同样是确定性漂移，却不声明 catalog pending。R7 测试当前刻意锁住此兼容行为。 | **P2** | A 后续 | **否**（继承旧兼容语义） | **可后置** | 先做产品裁决；若扩展语义，应把“锚点有 digest、正文缺失”计入信号，并翻转对应现状断言。 |
| RR-14 | **G-CC400**：Chat Completions 严格端点可能收到 system content 数组和块级 `cache_control`；官方 DeepSeek V3.x 回落 CC 路径存在确定性 400 风险，请求会在产生可计量缓存命中前失败。 | **P1** | A 后续 | **否** | **外会话** | 做协议压平与字段剥离，并以真实 DeepSeek/严格兼容端点验证；不能用 OpenAI/Anthropic 快照替代。 |
| RR-15 | **G3**：Anthropic 断点仍打在含 `user_profile` 等易变段的整块 system 尾，稳定/易变块未拆；profile 任一字节变化都会使 system 及其后 history miss，实际命中收益无证据。 | **P2** | A 后续 | **否** | **外会话** | 上游拆稳定块（尾部打点）与易变块（不打点），再以真实 provider 命中遥测验收。 |
| RR-16 | **G-FIFO**：32K FIFO 头删可能抢在 compaction 前清掉前缀，阈值让位尚未实现。 | **P2** | A 后续 | **否** | **外会话** | 在 compaction 产品面单独设计阈值/优先级并做长会话恢复测试。 |
| RR-17 | **G-compact-hooks**：`before_compaction` 不可阻断且没有 `after_compaction` 切点，外部治理无法围绕压缩建立完整生命周期。 | **P2** | A 后续 | **否** | **外会话** | 另开 hooks/compaction 会话增加默认零破坏切点；不得顺手改十五段准入或 TOCTOU。 |
| RR-18 | **issue #122 仍 OPEN**：本枝只加入记录长度/计数的 UTF-8/SSE 定位探针，未改变 U+FFFD 替换语义，探针也不覆盖前端渲染等其他链路。 | **P1** | A 后续 | **否** | **外会话** | 用探针数据先定位非法字节、跨 chunk 或其他链路，再单独修复；本 PR 不得宣称已修。 |
| RR-19 | **qbank_grading 流式出口未挂特殊 token 过滤**：与作文出口暴露面相同，但 R4 因 E 域边界未改。 | **P2** | E | **否** | **外会话** | 由 E 域按已落地的翻译/作文挂接模式处理，并保留 E 域算法契约。 |
| RR-20 | **TauriAdapter 冻结失败通知泄露技术细节**：用户通知仍含英文 `available_skills`、`fail-closed` 与底层错误；消息未发送这一事实正确，但呈现不符合 i18n/错误分层。 | **P2** | B | **是** | **外会话** | B/i18n 所有者提供中英文 key；用户只见“目录暂无法保存、消息未发送、请重试”，详细原因仅入内部日志。 |

## 三、潜伏项、覆盖债与观测盲区

| ID | 遗留风险 | 严重度 | 归属 | 是否本 PR 引入 | 建议处置 | 触发条件 / 后续动作 |
|---|---|---|---|---|---|---|
| RR-21 | **保险断点误剥向量**：Anthropic system/tools 尾部保险断点在预算守卫前追加；若调用方已有 3 个显式 tools marker，自动 system 保险断点会制造超载，守卫可能剥掉调用方最靠前的合法 marker 而保留自己追加的保险断点。 | **观测** | A 后续 | **是**（四槽守卫与透传组合后的潜伏面） | **可后置** | 当前唯一生产打点方只有 1 个 system marker，真实块级合计 2 ≤ 3，暂不可达。未来任何新增块级 marker 必须重算 4 槽预算；修法是让保险打点预算感知。 |
| RR-22 | **变体早退漏收敛**：部分 `?`/早退路径在 join 后 meta 写回或 converge 前退出；低频错误路径可能不推进本轮快照。 | **P2** | A 后续 | **是**（方案 A 收敛覆盖未包住所有既有早退） | **可后置** | 用 guard/finally 式收尾或在各错误出口显式写回；必须补错误注入测试。 |
| RR-23 | **同 session 跨路径并发分叉依赖 UI 串行假设**：现有 fork 判定未比较收敛结果与共享 entry 的并发现值；若未来允许同会话并发发送，可能漏判分叉。 | **观测** | A 后续 | **是** | **可后置** | 维持 UI 串行化前提并写入合同；放开并发前扩展 fork 判定并做竞态测试。 |
| RR-24 | **Rust `--days` 同形时间戳陷阱**：`llm_usage/repo.rs` 两条查询仍以 SQLite 空格时间格式与 RFC3339 `T` 格式做 TEXT 比较；报告脚本已修，同类 Rust 查询未修，时间窗可能多算边界数据。 | **P2** | A 后续 | **否** | **可后置** | 统一时间戳形状并用边界日期数据库用例对拍。 |
| RR-25 | **Chat 省略 `[DONE]` 的 EOF 成功面无 pipeline 集成测试**：现有终止门测试偏失败面，不能锁住 `finish_stream → terminal_success`。 | **P2** | A 后续 | **否** | **可后置** | 增加 pipeline 级成功用例，并在具备环境后执行。 |
| RR-26 | **`stream_filter_core` 仍是已挂 mod、未被两适配器调用的骨架**：实际 reasoning/content 过滤仍由适配器内联实例完成，核心与生产逻辑可能继续漂移。 | **P2** | A 后续 | **是** | **可后置** | 要么完成单一生产 seam 迁移并删除 dead-code 豁免，要么删骨架；迁移不得放宽保守过滤负例。 |
| RR-27 | **CACHE_DEBUG 单变体跨 turn 观测盲区**：四段指纹虽取自 post-adapter body，但 scope key 的 variant 通常是每 turn 新 assistant message id，常只记录 `baseline`，不能证明跨 turn 稳态。 | **观测** | A 后续 | **是** | **可后置** | 若要用于命中诊断，另增稳定会话维度对比；不得改写 usage 行的真实 session/variant/run 三列。 |
| RR-28 | **catalog 边缘潜伏项**：`clearSessionAvailableSkillsSnapshot` 若未来进入生产，不清 persisted 集合会打穿重新冻结；generation 双键字面量分散在 Rust/TS，存在漂移风险。 | **观测** | A 后续 | **是** | **可后置** | 当前 clear 仅测试调用；启用前同步清内存表，并把跨端键名以契约测试或单源生成锁住。 |

## 四、不应误报为风险的归档结论

- 技能 digest mismatch 走 `availableSkillsSnapshotPendingGeneration`，而不是 bump
  tool-face generation，是已裁决的分段代际设计；不要重开为 bug。
- Responses 面 `push_message_parts` 剥掉调用方块级断点，是适配器单一作者制与
  写槽预算下的有意不对称，不等同于 Anthropic tool marker 透传缺陷。
- R7 五个新测试文件当前均已挂 `#[cfg(test)] mod`（pipeline ×3、providers ×2）；
  遗留是 **RR-01 零执行**和测试 seam 质量，不是“文件未注册”。
- C 域 Composer 移动热区本会话未触碰；本轮没有证据支持凭空登记 C 域新增风险。
- 当前应继续保持 Draft，并按切片选择性吸收；本文不提供完成性声明。
