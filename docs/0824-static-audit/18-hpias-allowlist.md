model=gpt-5.6-sol-xhigh-fast

# 18 — HPIAS `session_id` 与 18-block allowlist 静态审计

审计范围仅限当前树中的 HPIAS 事件链、Generative UI Rust ingress、前端注册表及既有契约；对照 `leftovers-safe` 的处置记录做静态复核，未改产品代码。

## 结论

- **18-block allowlist：PASS。** Rust `ALLOWED_GENERATIVE_UI_BLOCK_TYPES` 当前恰为 18 个不同类型；`parse_intent` 在发射任何成功块事件前逐块校验，未知类型、缺失/非字符串 `type`、非对象块均拒绝。18 是“允许的类型数”，单份 intent 的块实例上限另为 32，不应混为一谈。
- **前端注册集合：PASS，但需按运行态而非全文调用点计数。** `blocks/index.ts` 有恰 18 次生产内置注册，键集合与 Rust 相同。全 `src` 静态共有 21 个 `generativeUIRegistry.register(...)` 调用点；多出的 3 个是 chart/steps/table 的测试/按需辅助函数，只覆盖既有同名 Map 键，不增加第 19 种类型，且当前产品调用方为零。
- **未知 block 类型：Rust 入口 fail-closed；前端渲染层是安全降级，不是第二道硬拒绝。** 正常模型工具路径会在 Rust 失败并发出 error；直接传给前端或流式恢复出的未知类型会保留到 renderer，以 warning Alert 跳过组件执行。该差异不等于 Rust allowlist 放宽。
- **HPIAS 会话隔离：正常 Rust payload 路径 PASS；“任意 payload 全链路 fail-closed”只能判 PARTIAL。** Rust 当前所有 pipeline payload builder 都写入同一个 `session_id`，前端共享 listener 再由 store 分片路由，正常路径不会把外会话覆盖到活跃顶层。但生产 Chat hook 实际使用的是“不按 session 过滤”的共享 listener；缺失/非字符串 `session_id` 的运行时 payload 可落入活跃顶层处理，未知 HPIAS `type` 也未在 normalize 层拒绝。因而不能把定向 handler 的 fail-closed 测试外推成整个生产链均 fail-closed。
- **对照 `leftovers-safe`：未见 allowlist 或 session 校验被放宽。** 当前树保留其 Rust 入口白名单、未知型 e2e、双端 session-id sanitizer、多会话 slices、单 listener 与外来 `session_started` 隔离；后续 Step 20 反而把定向桥对缺失/非字符串 id 的行为进一步收紧，并把 `hpias_event` 改为精确通道白名单。上述 PARTIAL 是现有共享路由边界，不是发现了白名单扩容。
- **本轮不改代码。**

## 1. HPIAS `session_id` 数据链

### 1.1 会话 ID 入口与后端启动门

前后端 sanitizer 语义一致：

- 前端 `src/features/generative-ui/utils/extractResearchSessionId.ts:5-12`：长度 `1..128`，首字符必须为 ASCII 字母或数字，其余仅允许字母、数字、`.`、`_`、`-`；读取优先级为 toolInput → toolOutput → intent.meta（`:28-37`）。
- Rust `src-tauri/src/chat_v2/tools/generative_ui_executor.rs:143-167`：trim 后采用同样的 128 字节上限和字符集合；参数不合法时才回退 intent.meta。
- Chat 块仅在 sanitizer 返回非空 ID 时启用桥和研究面板（`src/features/chat/plugins/blocks/generativeUI.tsx:44-65`）；缺 ID 的研究块不订阅，契约见 `tests/vitest/generative-ui/generativeUIChatBlock.test.tsx:243-264`。
- Rust 仅在“合法 `researchSessionId` + intent 含 research-plan/research-report/paper-digest”双门同时满足时启动 HPIAS（`generative_ui_executor.rs:396,427-435`）。ID 仍会随正常 Generative UI 输出返回，但没有 Research 块就不会启动 pipeline。

### 1.2 Rust payload 一致盖章

`src-tauri/src/hpias/payloads.rs:108-233` 的 session_started、round_started、plan_generated、retrieval_completed、selection_completed、subagent_started/completed、synthesis_updated、subagents_done、session_completed builder 均要求 `session_id: &str` 并写入 `"session_id"`。真实 retrieval pipeline 只把捕获的同一 `session_id` 传给这些 builder（`src-tauri/src/hpias/retrieval_backend.rs:69-82,108-198`）。

启动事件也强制盖章：`src-tauri/src/hpias/events.rs:31-41` 构建并 emit session_started；单测 `:55-60` 断言 ID 存在。Tauri e2e 进一步断言传入 `e2e-hpias-session-1` 后收到相同 ID（`src-tauri/tests/generative_ui_executor_e2e.rs:95-159`）。

因此，在当前 Rust 自产事件范围内，没有“合法 pipeline 事件无 session_id”的生成路径。

### 1.3 两种前端桥不能混称

定向桥 `createHpiasEventBridgeHandler({ sessionId })` 确实 fail-closed：

- `src/features/generative-ui/bridge/hpiasEventBridge.ts:102-120` 对无法 normalize、缺 `session_id`、非字符串 ID、ID 不等四类输入直接 return；
- `tests/vitest/generative-ui/hpiasEventBridge.test.ts:36-62` 覆盖异会话、缺 ID、数字 ID；
- 条件写成 `if (options.sessionId)`，所以公共 API 若显式传空字符串会变成不定向；产品 ID 先经 sanitizer，正常调用不会产生空字符串。

但生产 Chat hook 并不把该 `sessionId` 交给 handler：

- `src/features/generative-ui/hooks/useHpiasEventBridge.ts:8-16` 声明 `sessionId` 只保留调用方语义；
- `:18-36` 只依赖 `enabled`，调用 `retainSharedHpiasEventBridge()`；
- `hpiasEventBridge.ts:134-159` 共享一条 `startHpiasEventBridge({})`，明确不按 session 过滤。

共享 listener 的收益是多个 Chat 研究块只注册一次，避免 synthesis 重复折叠；运行时契约 `tests/vitest/generative-ui/generativeUIChatBlockHpiasRuntime.integration.test.tsx:142-176` 锁定两个块只有一个 listener 且 synthesis 只追加一次。代价是生产隔离的最终责任落在 store，而非定向 handler。

### 1.4 Store 路由的有效边界

`src/stores/researchStore.ts:241-269` 仅在以下条件都成立时走外会话 slice：

1. 已有活跃 `s.sessionId`；
2. 事件含非空字符串 `session_id`；
3. 事件 ID 与活跃 ID 不同。

命中后只更新 `sessions[eventSessionId]` 并 return，不改活跃顶层。活跃事件处理完后由 `:566-575` 回写对应 slice。`src/stores/hpiasSessionSlice.ts:95-195` 再做一次 slice-ID 比对，`:198-219` 将 slices 上限收在 8，并保护活跃及当前事件 ID。测试覆盖异会话 plan/synthesis、外来 session_started、reset 保留其它 slice（`tests/vitest/generative-ui/hpiasStoreSessionIsolation.test.ts:18-83`）及 LRU 式淘汰（`hpiasSessionSlice.test.ts:54-70`）。

边界必须如实记录：

- `normalizeHpiasEventPayload` 只验证对象和 `type` 为字符串，随后直接断言为 `HpiasEvent`（`hpiasEventBridge.ts:75-87`），没有运行时判别联合校验。
- 共享桥收到缺失、空值或非字符串 `session_id` 时，store 的 `eventSessionId` 为 undefined，事件会进入活跃顶层 switch，而不是 fail-closed。对 malformed plan/session_started 等事件存在污染活跃状态的理论路径；当前 Rust builder 不产生这种输入。
- 未知 HPIAS `type` 也不拒绝：活跃路径会写事件日志后落入 `default`；外会话路径会创建/触碰对应 slice，而 `applyHpiasEventToSessionSlice` 的 `default` 会刷新 `updatedAt`（`hpiasSessionSlice.ts:193-195`）。它通常不改 plan/synthesis，但不能称为“未知事件类型已拒收”。
- 合法的 ingestion_progress，以及类型定义中允许无 ID 的 session_failed/error，本来就可能按活跃会话处理；若要把 HPIAS 通道提升为严格不可信边界，需要先为这些全局事件定义明确路由语义。

所以准确表述应是：**定向 handler fail-closed；生产共享桥依赖“Rust payload 必带 ID + store 对有效外会话 ID 分片”实现隔离。**

## 2. 恰 18-block allowlist

### 2.1 Rust 是模型工具入口的权威硬门

`src-tauri/src/chat_v2/tools/generative_ui_executor.rs:23-42` 的完整集合为：

1. stat-card
2. alert
3. list
4. progress
5. action-bar
6. text
7. key-value-grid
8. flashcard-preview
9. review-calendar
10. mistake-analysis
11. mindmap-embed
12. paper-digest
13. research-plan
14. research-report
15. markdown
16. chart
17. steps
18. table

`parse_intent` 在 `:79-100` 依次完成版本、blocks 数组、非空、32 实例上限及 block type 校验；`validate_block_types`（`:105-119`）逐块拒绝非对象、缺失/非字符串 type 和集合外 type。失败会走 executor error 分支并在成功 chunk/end 之前返回（`:360-375`）。

计数和负向行为均有可执行钉点：

- Rust 单测 `:645-679` 拒绝 unknown-widget、缺 type、非对象；
- `:682-700` 从常量本身构造全部类型并断言长度 `Some(18)`，增删常量都会显式改变断言；
- Tauri e2e `src-tauri/tests/generative_ui_executor_e2e.rs:420-466` 断言 unknown-widget 令 result 失败并发出 generative_ui error，而非成功渲染。

### 2.2 前端注册次数与集合

`src/features/generative-ui/blocks/index.ts:37-172` 有恰 18 次直接 `generativeUIRegistry.register(...)`，每个键各一次，与 Rust 清单逐项相等。Registry 使用 `Map`；重复键只告警后覆盖（`src/features/generative-ui/registry.ts:10-18`）。

需要区分两个计数：

| 口径 | 数量 | 解释 |
|---|---:|---|
| `blocks/index.ts` 生产内置注册调用 | 18 | 形成默认注册集合 |
| 全 `src` 的 register 调用点 | 21 | 另 3 个位于 Chart/Steps/Table 的测试/按需 helper |
| 默认 registry 唯一键 | 18 | 三个 helper 即使调用也覆盖同名键，不新增类型 |

三个 helper 分别位于 `ChartBlock.tsx:252-260`、`StepsBlock.tsx:159-167`、`TableBlock.tsx:139-147`；静态调用方仅在对应测试中，产品代码没有调用。`tests/vitest/generative-ui/generativeUIModuleIntegration.contract.test.ts:23-42,111-115` 对默认 registry 做 18 项集合精确相等断言，而非仅检查包含关系。

此外：

- JSON Schema exporter 从当前 registry 生成 `type.enum`（`exportGenerativeUIJsonSchema.ts:16-22,51-61`）；
- 18-block fixture 和 Tauri 契约分别锁定长度与运行时可渲染集合（`allBlocksFixture.ts:6-44`；`generativeUITauriE2E.contract.test.ts:58-69`）；
- Registry 本身公开 register/unregister/clear，并非不可变安全边界；当前树没有额外产品调用，但未来若动态注册第 19 种，前端 schema 会随 registry 扩大，Rust 仍会拒绝该类型，直到 Rust allowlist 同步显式修改。

### 2.3 “未知类型拒绝”分层判定

| 边界 | 当前行为 | 判定 |
|---|---|---|
| Rust render_generative_ui ingress | 未知 block type 返回失败，不 emit 成功 intent | fail-closed |
| 前端公开 linter | unknown-type 为 error，`ok=false`（`lintGenerativeUIIntent.ts:110-124,190-193`） | 拒绝性诊断 |
| 前端基础 Zod schema / 流恢复 | type 只要求 1..64 字符；恢复测试明确保留 unknown-widget（`schema.ts:43-49`；`coercePartialIntent.test.ts:80-87`） | 不做 allowlist 拒绝 |
| Renderer | registry miss 时渲染 warning Alert，不实例化未知组件（`GenerativeUIRenderer.tsx:389-402`） | 安全跳过 |
| HPIAS event type | normalize 仅要求字符串；store default 不拒收 | 非 fail-closed |

因此，“未知类型已拒绝”只应无歧义地用于 **Rust block ingress**。前端的宽松解析用于流式恢复和兼容展示，最终不会执行未注册 React 组件，但它不是与 Rust 等价的白名单门。

## 3. 与 `leftovers-safe` 对照及放宽检查

处置记录 `docs/dev/0824-leftover-audit.md:31-49` 将相关增量全部列为 INCLUDE：

- `eae6f682` / `fa6fb8cd`：双端 researchSessionId 清洗与契约；
- `2fb56ffb` / `ead3276c` / `16e4b3d4` / `2ded044a` / `db410150` / `7632e922`：HPIAS session 隔离、并发 slices、单 listener、reset 保留 slices、外来 session_started 隔离；
- `7529230d`：Rust ingress block allowlist；
- `413b2514`：Tauri e2e 拒绝未知 block type。

`docs/0824-MERGE-PLAN.md:415-426` 记录这些加固经 Step 7 merge `362dd2df` 进入基座。之后 Step 20 的 `249df98a` 又把定向桥对缺失/非字符串 session_id 从可穿透改成拒收，并将 hpias_event 保持为精确通道名；`71a51913` 增加 allowlist 行为测试（`:925-929`）。当前 `guardedListen.ts:27-46` 仅以精确集合放行 hpias_event，测试明确拒绝 hpias_event_private、hpias-event、prefix_hpias_event（`tests/vitest/guardedListenAllowlist.test.ts:9-18`）。

当前源码逐项仍能定位到上述能力，18 项 Rust 集合没有第 19 项，前端默认 Map 没有额外键，session sanitizer 字符集/长度没有扩大，外会话 slice return 仍在，定向桥缺失/非字符串 ID 的拒收仍在。基于源码与处置记录，**未发现相对 `leftovers-safe` 的放宽**。

保留意见有两项，均不改变上述历史结论：

1. `guardedListen` 的通道阻断仅在 dev + 非 legacy 生效（`guardedListen.ts:50-67`）；生产安全性不能依赖它。
2. 共享桥的实际生产路径不使用定向 handler 的 sessionId 过滤，且 HPIAS payload 无完整运行时 schema。现有 Rust 自产事件满足前置不变量，所以正常链路隔离成立；若审计标准要求通道输入本身不可信，则应把这部分单列为后续加固，而不能宣称已全链 fail-closed。
