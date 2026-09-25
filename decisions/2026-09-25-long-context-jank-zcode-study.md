# 长上下文会话流式卡顿 — ZCode 源码研究与本地热路径分析

日期：2026-09-25
状态：分析完成，待用户确认实施方向
前置：PR #419（emit 合批 / 120ms chunkBuffer / MessageItem 指纹订阅 / flowtoken 延后）已交付，单条消息流式渲染主因已解决。本篇处理遗留症状：**会话上下文越长（消息多、单条消息长），流式期间仍然卡**。

## 一、ZCode 源码研究（github.com/zai-org/ZCode，浅克隆至 E:\yysls\zcode-study\ZCode）

技术栈：Electron 41 + React 19.2 + Vite 8；UI 在 packages/ui；markdown 用 streamdown@2.5（+ @streamdown/cjk|code|math|mermaid）+ shiki@4；列表用 @tanstack/react-virtual；zustand 只管外围（主题/附件/MCP），**会话状态走自研 external store + useSyncExternalStore**。

关键机制（均为 file:line 实证）：

1. **数据窗口化（最核心的结构优势）**：新订阅只下发最后 60 行快照，历史按 200 行分页、滚动到距顶 2 个视口内才预取（packages/shared/src/zcode-protocol-v4/core.ts:75-76；conversationProjectionStore.ts:987-1029；timelineScrollAnchor.ts:255-260）。渲染器里的数据量天然有上限，"几百条消息"根本不会全部进入前端状态。
2. **delta 结构共享**：流式 append 只新建被改的那一行对象 `{...row, text: row.text+append}`，其余行保持引用相等（apply.ts:39-56）。
3. **回合级虚拟化 + 活动尾拆分**：虚拟单位是 turn（稳定 key），overscan 8；正在运行的 turn 移出虚拟列表走普通文档流（ConversationTimeline.tsx:722-733, 1855-1882；conversationTimelineLiveTail.ts:15-28）；行高缓存持久化、LRU 4000（timelineRowHeightCache.ts，约 60 行可直接搬）。
4. **memo 叶子按行类型拆分**：一行 delta 只重渲染一个叶子组件（ConversationRowView.tsx:279-287；message.tsx:1293-1312 自定义 comparator）。
5. **markdown 静态/流式双模式**：历史消息永远 `mode="static"`；render key 刻意不含流式状态（流开始/结束不重挂载子树）；Shiki 高亮和 mermaid **只在完成后**渲染；token 缓存按 (theme,lang,长度,头100,尾100)（message.tsx:700-706, 857-883, 1565-1571；shikiHighlighter.ts:56-85）。
6. **生产端合批**：CLI 30ms(desktop)/150ms flush 窗口合并 delta；渲染器**不做** rAF/startTransition/useDeferredValue（core.ts:34-46；coalesce.ts:80-161）。
7. **滚动权威状态机**：following 是用户意图而非几何推断，意图捕获带 1200ms TTL；overflowAnchor:none + scrollbar-gutter:stable + 宽度变化 120ms settle 窗（timelineScrollAnchor.ts 全文件，纯函数可直接搬）。
8. **重块 CSS containment**：每个代码块 `content-visibility:auto; contain-intrinsic-size:auto 200px`（code-block.tsx:159-163）；非虚拟化的分享视图整 turn 同样处理（ConversationShareReadonlyTimeline.tsx:1015）。
9. **历史回合默认折叠**：完成回合的 N 个工具调用渲染为一行 "Worked for Ns"，Radix Collapsible 卸载内容（ConversationTurnGroup.tsx:645-660）。

**ZCode 没做的（避免过度设计）**：无 rAF 时间切片；无 markdown/高亮 worker；token/上下文用量计数不在渲染器（CLI 侧算好、值未变不下发，快照 conflated）；活动消息也不做自研增量解析（靠 Streamdown 内部块 memo + 稳定 key 不重挂载）。

## 二、deepstudent 长上下文热路径（每次 ~120ms 冲刷都执行，成本随会话规模线性增长）

按影响排序；P1/P2/P3 已逐行抽查证实：

- **P1 AgentTaskPanel 全量订阅 blocks Map**（AgentTaskPanel.tsx:167 `useStore(store, s => s.blocks)`）：Map 身份每次冲刷都变 → 该常驻面板每 120ms 重渲染，并触发 3 个 O(全部已加载块) 扫描：steps memo（:196 全 Map forEach + extractSteps 解析）、hasRuntimeActivity memo（:207 全 Map forEach，注释称"每帧代价可忽略"但实为 O(全会话块)）、useArtifactRegistrySync 的全状态 subscribe 里 countTerminalToolBlocks（useArtifactRegistrySync.ts:59-71，`state.blocks === prev.blocks` 早退在流式期间永不命中）。
- **P2 按消息作用域的订阅仍是"每次冲刷重建整条消息块数组"**：useMessageBlocks（useChatStore.ts:93-129）+ useStableSourceBlocks（useStableSourceBlocks.ts:60-75）+ ActivityTimeline（ActivityTimeline.tsx:1613-1638）。直渲染模式下每个挂载内容块/时间线段每次冲刷都做 map/filter/compare 分配，合计 O(全部块)。指纹订阅（PR #419）只保护了 MessageItem 层，没保护到块层。
- **P3 ≤80 条消息整会话直渲染 + 每冲刷强制 layout**：VIRTUALIZATION_THRESHOLD=80（MessageList.tsx:57, 496）；ResizeObserver→followBottom 读 scrollHeight 写 scrollTop（MessageList.tsx:798-803, 593-606），直渲染模式下该 layout 覆盖整会话 DOM；滚动分类器再读一次 scrollHeight（:765-791）。
- **P4 immer produce 每冲刷 O(N) 构造新 Map**（blockActions.ts:56-99 → immerHelpers.ts:42-77）：值为共享引用但 Map 本身全量重建，且身份变化触发所有 `s.blocks` 订阅者（P1/P2/搜索）。
- **P5 长单条消息**：splitMarkdownBlocks 每冲刷 `content.startsWith(cachedContent)`（全长 memcmp）+ finalizeBlocks 重建**所有**已完成块对象并逐个 hashStr（splitMarkdownBlocks.ts:346-416），O(该消息字节数)/冲刷。
- **P6 流式中开着搜索**：searchBlocks 订阅全 Map，每次冲刷全会话归一化文本扫描（MessageList.tsx:265-286；messageSearch.ts:118-142）。已正确门控（关搜索时为零成本）。

**已排除（不是问题）**：持久化——内容块走 5s 节流单行 UPSERT（chat_v2_upsert_streaming_block），无全量会话序列化；autoSave 500ms 节流且不挂内容 chunk；无 zustand persist 中间件。token 估算只在请求构建期（contextHelper.ts:702）。后端每 100ms 窗口每块一次合并 emit，无逐 chunk DB 写。

## 三、方案（分批，每批独立可测；映射 ZCode 模式）

**批次 A — 消灭每冲刷 O(N) 扫描（纯前端小改，预期收益最大、风险最低）**
- A1 AgentTaskPanel 改指纹化：在 block 写入动作里 O(1) 维护 `todoBlockIds` / `runtimeActivity` 派生标量（或 selector 只比较标量指纹），steps 仅在 todo 集变化时重提取；useArtifactRegistrySync 改 selector 订阅 + 指纹早退。（对应 ZCode #2/#4："delta 只使真正相关的东西失效"）
- A2 useMessageBlocks / useStableSourceBlocks / ActivityTimeline 改按消息作用域指纹订阅（复用 useBlocksSegmentMeta 模式：块 id 集稳定 ref + 逐块标量指纹），历史消息在流式期间零分配。
- A3 splitMarkdownBlocks：已完成块对象冻结复用，finalize 只处理尾块，hashStr 结果随块缓存（P5）。
- A4 流式期间搜索匹配重算节流至 ≥500ms 或仅在冲刷暂停时计算。

**批次 B — 列表层（中风险，需实机验证）**
- B1 直渲染模式下给历史消息的重子树（代码块/工具输出/KaTeX 容器）加 `content-visibility:auto + contain-intrinsic-size`（ZCode 成熟做法 #8）；必须实测 followBottom 的 scrollHeight 语义与吸底兼容性。
- B2 followBottom 合并到 rAF、每次冲刷单次 scrollHeight 读（P3 减半）。
- B3 直渲染准入从"消息数 ≤80"改为同时计块数/估算行数；活动消息移出虚拟列表走普通文档流（ZCode live-tail 模式 #3），配合搬入持久化行高缓存（timelineRowHeightCache.ts 直接可用）。

**批次 C — 结构性（可选，待 A/B 后实测再定）**
- C1 blocks 内存窗口化：加载超阈值时丢弃远端离屏块，DB 为源、回滚时重取（对齐 ZCode 数据窗口化 #1，改动最大，对 P2/P4 是釜底抽薪）。
- C2 历史回合默认折叠工具调用（对齐 ZCode #9，涉及交互预期，需产品确认）。

## 四、非目标

- 不引入 Streamdown（PR #419 已定 120ms 合批 + flowtoken 延后路线；上一轮已决策维持现状）。
- 不做 rAF 时间切片 / useDeferredValue / markdown worker（ZCode 也没有；合批已在 Rust emit + chunkBuffer 两级完成）。
- 不动后端 emit 协议与 DB 写入路径（已验证不是瓶颈）。

## 五、测试与验证

- 每批：目标 vitest 套件 + 全量 chat 套件（基线 1410 通过）+ `npx tsc --noEmit`；A1/A2 新增指纹 hook 单测（内容增长 0 重渲染断言，沿用 useBlocksSegmentMeta 测试范式）。
- B1/B2 需桌面端长会话（200+ 消息、单条 50KB+）滚动 + 流式实机观察：吸底、搜索定位、锚点跳转不回归。
- 量化：dev 面板性能追踪（sessionSwitchPerf 已有基础设施）记录冲刷间隔内的长任务数前后对比。
