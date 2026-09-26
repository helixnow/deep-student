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

## 六、实施记录（2026-09-25，commit 84901286 + 后续合并批次）

批次 A/B 已随 commit 84901286 落地（A1-A4、B1-B3 原样实施；B2 最终采用"精确状态去重"而非 rAF 合并——时间启发式会误杀 ResizeObserver 的正常跟随）。

### 补充批次（同日，用户要求合并为一次构建验证）

**层级 1 — 块级渲染跳过**：`.stream-block` wrapper 对 `isComplete` 块加 `content-visibility: auto + contain-intrinsic-size: auto 96px`（StreamingBlockRenderer.tsx）。流式中的活动块不启用（必须参与吸底 layout）。这是"单条消息巨长"场景的主解：每冲刷的强制排版只覆盖可视区附近的块。

**层级 2 — 内容总量准入**：`selectBlocksContentLength`（useChatStore.ts，WeakMap 按 Map 身份缓存，每 flush 求和一次）；直渲染准入抽为纯函数 `shouldDirectRender(messageCount, blocksCount, contentLength)`（MessageList.tsx 导出），三条件：消息数 ≤16（由 80 收紧）、块数 ≤600、总正文字节 ≤200_000。

**层级 3 — 阈值收紧**：VIRTUALIZATION_THRESHOLD 80→16。排在层级 1/2 之后：先压两种模式的长消息排版成本，再收窄直渲染边界。

**C1 — 长会话内存窗口化（回填上限 + 反向窗口）**：
- 关键前置发现：滚动补页路径被 `fullHistoryLoadComplete` 门控且 offset 按"已加载数"计算，隐含"加载集 = 自最老端连续前缀"不变量；`mergeHistoryMessageOrder` 按 timestamp 重排 + 锚点合并，**与页面到达顺序无关**。
- 设计：回填从尾窗起点**倒序**向更老历史推进（页 offset = max(0, W - 100)），合并后窗口起点推进；上限 HISTORY_BACKFILL_MAX_PAGES 100→5（500 条）。触顶返回 `'capped'`，`fullHistoryLoadComplete` 不置位，滚动补页（loadEarlierMessages）按窗口起点续拉——窗口始终连续，无中间空洞。
- 竞态防御：空页 → 按抵达最老端收尾；非最老端短页 → 返回 `'unsupported'` 退回全量加载 fallback（保证窗口连续性）。
- 行为兼容：≤500 条消息的会话与原全量回填完全一致；>500 条的会话更早历史滚动按需加载。**代价：全量会话内搜索只覆盖已加载窗口（≤500 条会话无感知）**。

**C2（历史回合默认折叠）暂缓**：产品可见的交互变更（Worked for Ns 折叠），且其性能收益（减少挂载 DOM）大部分已被层级 1 的块级渲染跳过覆盖；应单独一版做并配交互测试。

### 新增/修改测试
- blocksDigest 7 例、useBlocksByIds 4 例、useBlocksSegmentMeta 多冲刷 1 例、splitter 对象身份 2 例（批次 A/B，commit 84901286）
- shouldDirectRender 5 例、selectBlocksContentLength 3 例、StreamingBlockRenderer 完成块渲染跳过 2 例
- MessageList.scrollToBottom.source.test.ts 契约断言更新（followBottom 新实现）；MessageList.scrollToBottomControl.test.tsx 的 useChatStore mock 补 selectBlocksContentLength 导出
- chat 全量 1434/1434；tsc 干净

### 实机验证清单（单次构建覆盖）
1. 长会话（200+ 条）流式：打字流畅度、吸底跟随、滚动向上再回底。
2. 单条 50KB+ 超长回复：流式期间滚动回看前缀块、完成后流式→flowtoken 切换无闪烁。
3. >500 条消息会话：打开会话 → 滚动到顶 → 历史续拉正确（无空洞/乱序）、重复滚动不重复拉取。
4. 会话内搜索（流式中开/关、非流式）：结果即时性、定位跳转。
5. agent 任务会话（大量工具块）：任务面板/产物架出现时机正确。
6. 代码块：滚动经过已完成消息的长代码块，展开/复制/sticky 头正常（content-visibility 影响）。

## 七、审查与修正（2026-09-25，相对 PR #419 复审 84901286+238be79a）

复审发现并已修：

- **P0 搜索静默漏查未加载窗口**：>500 条会话 capped 后 `fullHistoryLoadComplete` 恒 false、窗口只留 ≤500 条，会话内搜索只查内存 blocks——搜早期内容静默 0 结果。修复：MessageSearchBar 新增 `hasUnloadedHistory`（由 MessageList 传 `hasMoreHistory`），无结果且仍有未加载历史时提示"仅搜索已加载消息，加载更早消息可搜索全部"（zh-CN/en-US）。
- **P1 反向窗口零测试**：`historyWindowStartOffset` 追踪 / 倒序拉页 / capped / unsupported / 空页竞态是新引入最复杂的路径，此前无任何适配层测试。补 `TauriAdapter.historyWindow.test.ts` 9 例：窗口推进、offset 截断到 0、最老端短路、空页不推进（手动路径）vs 收尾（自动路径）、倒序逐页 done、5 页上限 capped、capped 后 loadEarlierMessages 无缝续拉（offset 序列 [900..400] 连续无重叠无空洞）、非最老端短页退 unsupported。

可接受项（不阻塞）：15→17 条边界 `useDirectRender` 随流式字节翻转引起一次性路径切换（虚拟化兜底不闪空白）；capped 后首次手动补页重复拉尾窗重叠 ≤99 条（prepend 幂等，仅一次 IPC）；无后端补齐搜索命令（超范围，留后续）。

测试：chat 全量 1443/1443（基线 1434 + 新增 9）；tsc 干净。
