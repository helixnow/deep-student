# PDF / 教材阅读 / 文档处理 / OCR 质量评审

对照范围：`v0.9.44` → `origin/cursor/0824-cde6 @ 2d41ea8b`。按真实 diff 界定：本区间实际改动为 `src/features/pdf/**`（约 +3300 行，含 8 个新模块与 8 个新测试文件）、`src-tauri/src/pdf_protocol.rs`（+252）、`src-tauri/src/document_processing_service.rs`（+1738/-997，主体是方法抽纯函数与新增测试）。**`pdf_ocr_service.rs` 与 `document_parser.rs` 在该区间零改动**——OCR 与文档解析链路本轮未动，本文不对其历史实现作普查。按要求未运行编译、测试或门禁。

## 总判定

**有保留通过。** 这一块是本轮合流里工程质量最扎实的领域之一：两处后端改动都是「真实 bug 修复 + 把逻辑抽成可测纯函数 + 用测试钉住修复」的标准动作；前端的翻页/搜索/视图持久化改造也大多先抽纯函数再接线，测试投入（前端 5 个纯函数测试 + 组件测试 + 2 个自解释的源码契约测试，后端约 700 行单测）明显高于系列平均。

保留意见集中在一处：**划词能力是两套平行系统同屏上线的**。同一次选区会同时弹出自研划词菜单（选区上方）和共享层 SelectionToolbar（选区下方），5 个动作语义重叠但实现分叉——「做笔记」一条落根目录、一条弹目录选择；「送入聊天」有三条事件通道；两套翻译结果面板；且共享工具条的静态导入把另一套精心设计的懒加载完全抵消。外加一个真实缺陷：共享工具条把 DSTU 资源 ID 当文档标题写进笔记出处。这些不是崩坏级问题，但属于合流前应当收敛的架构性重复。

## 后端一：pdfstream 白名单的 Windows 路径修复（质量高）

这是对 issue #59（Windows 中文路径 PDF 打不开、误判 403）的修复。根因判断准确：`std::fs::canonicalize` 在 Windows 返回 `\\?\C:\...` verbatim 形式，而白名单目录一旦以普通盘符形式参与比较（例如 canonicalize 失败后保留原始路径），`Path::starts_with` 因 Prefix 组件不同恒为 false。修复分三层，层层都有安全考量：

- 字符串级书写形式归一（verbatim 前缀、正反斜杠、尾分隔符、大小写），前缀匹配强制落在组件边界上，`D:\Docs2` 不会匹配 `D:\Docs`（`src-tauri/src/pdf_protocol.rs:111-141`）；
- `path_is_within` 先走所有平台一致的组件级 `starts_with` 快路径，Windows 上才做文本归一比较；含非法 Unicode 的路径保守拒绝（fail-closed），非 Windows 平台语义完全不变（`:144-167`）：

```144:167:src-tauri/src/pdf_protocol.rs
pub(crate) fn path_is_within(path: &Path, dir: &Path) -> bool {
    if path.starts_with(dir) {
        return true;
    }
    #[cfg(windows)]
    {
        // 含非法 Unicode 的路径无法可靠做文本比较，保守拒绝（fail-closed，
        // 上面的组件级比较已经覆盖了完全一致的情况）。
        match (path.to_str(), dir.to_str()) {
            (Some(path), Some(dir)) => windows_path_starts_with(path, dir),
            _ => false,
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}
```

- `resolve_allowed_dirs` 不再把 canonicalize 失败（权限、长路径、网络盘）的授权目录静默丢弃，而是保留原始路径（`:259-290`）。丢弃会让该目录下所有文件误判 403，这个次生 bug 的修复与主修复同样有价值。请求路径仍然 canonicalize，符号链接逃逸防线未被削弱：保留的原始目录若是 junction，canonical 后的请求路径与它字符串不匹配，结果仍是拒绝——失败方向正确。

测试是这个修复的亮点：字符串级实现使归一化逻辑可以在任意平台单测（`:801-856`），另有仅 Windows 编译的实机 verbatim 混合形式测试，以及与前端 `convertFileSrc(encodeURIComponent)` 编码方式一致的端到端回归——授权目录内中文路径必须 200/206、白名单外中文路径必须仍 403（`:874-926`）。「修复不得削弱只允许授权目录」被显式钉住了。

唯一的边缘保留：大小写折叠用的是 Rust `to_lowercase()`（Unicode 全量折叠），与 NTFS 的 `$UpCase` 简单折叠不完全一致；在开启了 per-directory case-sensitivity（WSL 场景）的卷上，理论上存在把不同目录判为同一目录的空间。触发条件苛刻（白名单目录本身要位于 case-sensitive 目录树内），且白名单目录来自 OS 标准目录而非用户输入，实际风险可忽略，但值得在注释里补一句已知限制。

## 后端二：文档分段服务重构（四个真实 bug 修复，方法论正确）

`document_processing_service.rs` 的主体改动是把分段逻辑从 `&self` 方法抽成纯函数（不依赖数据库、可直接单测），并在重构中修复了四个可复现的缺陷，每个都有钉住测试：

1. **`max_tokens=0` 死循环**：旧实现 `calculate_max_tokens_per_segment` 可返回 0，`split_by_characters` 中 `max_chars=0` 导致 `start` 永不前进。现在预算钳制 `MIN_TOKENS_PER_SEGMENT=256`（`:41,275-291`），且硬切「即使单字符超预算也至少前进 1」（`:436` 附近的 `best = start + 1`）双重保证终止，测试 `forced_char_split_zero_budget_terminates` 钉住。
2. **CJK 硬切约 2 倍超预算**：旧实现用 `max_chars = max_tokens * 2` 粗换算，对 ≈1 token/字的 CJK 产出翻倍超预算的分段。现在对切点做二分搜索保证 `estimate_tokens(segment) <= max_tokens`（`:425-476`），并单独用 `estimate_tokens_monotonic_over_prefixes` 钉住二分成立的前提（前缀扩展单调不减）——把算法正确性的隐含前提显式化成测试，这个习惯值得推广。
3. **短邻段重叠整段复制**：旧实现邻段长度 ≤ overlap_size 时直接返回整个邻段，两个短分段互相完整包含 → 内容成倍重复 → 重复制卡。现在 `effective_overlap_chars` 把重叠上限约束到邻段一半（`:792-794`），保证重叠只是边界上下文。
4. **`byte_index_to_char_index` 空串下溢 panic**：`count() - 1` 改 `saturating_sub(1)`（`:713-718`）。

两处「诚实化」处理也值得肯定：

- `enable_llm_boundary_detection` 是历史遗留的假开关（后端从未读取）。本轮让它真正生效，但模块注释明确声明生效的是**纯规则的边界吸附**（段落 `\n\n` > 换行 > 句末标点 > 空白，`snap_cut_to_boundary`，`:480-515`），「不是 LLM 定界——没有任何模型调用参与切点选择」。比默默留假开关或悄悄接一个 LLM 调用都好。保留意见：字段名与行为的错位仍然存在，长期看应改名（如 `enable_boundary_snapping`）或在 `AnkiGenerationOptions` 上加别名，但这涉及跨模块序列化契约，本轮不动是合理的。
- 代码库里三套口径不一的 token 估算（本文件、`utils/token_budget.rs`、前端 `tokenUtils.ts`）没有强行统一，而是用模块头部的权威规则表 + `estimate_tokens_pinned_values` / `estimate_tokens_diverges_from_token_budget` 两个钉住测试管理差异（`:944-973`）。以 10k/段预算对 128k 上下文的余量而言，这个务实取舍成立。代价是 `estimate_tokens_diverges_from_token_budget` 把 `token_budget.rs` 的具体输出值（`budget=3`）钉进了本文件的测试——对方模块改公式会在这里炸测试。这是有意设计（强制重新审视权威规则说明），但跨模块测试脆性需要维护者知情。

遗留杂项：`println!("[DOCUMENT_DEBUG] ...")` 调试日志原样保留（约十余处），未迁移到 `log`/`tracing`，生产环境持续打 stdout。旧债非本轮引入，但既然整个文件都重排了，顺手收敛的成本很低。`segment_with_overlap` 的「后缀→前缀→正文」多轮裁剪链条复杂度也未降（纯搬运），好在现在有测试兜底。

## 前端主要问题：划词能力是两套平行系统

本轮给 PDF 阅读器加划词学习动作（翻译/出题/制卡/笔记/引用聊天），方向正确——这是阅读场景的核心闭环。但实现上同时铺了两条链路，并且都上线了：

**链路 A（自研扩展）**：既有高亮菜单 `ds-highlight-menu` 扩展为「4 色高亮 + 复制 + 引用到对话 + 做笔记 + 翻译 + 生成题目 + 制卡」，由 document 级 `mouseup/touchend/selectionchange` 驱动（`EnhancedPdfViewer.tsx:1651-1684`），弹在选区上方。

**链路 B（共享层接入）**：新组件 `PdfSelectionActions` 把 `@/shared/selection` 的 SelectionToolbar 挂到同一个容器上（`EnhancedPdfViewer.tsx:3277-3282`），提供「复制 + 解释 + 翻译 + 保存为笔记 + 制卡 + 添加到聊天」，弹在选区下方。

同一次划词，两条工具条同时出现（组件注释自述「挂在选区下方，与上方的高亮选色菜单错开」——重叠被当作布局问题解决了，而不是当作重复问题解决）。后果具体到每个动作：

- **翻译 ×2**：链路 A 走 `ds-pdf__translation-panel` + `React.lazy(TranslationPopover)`；链路 B 走 `ds-pdf__selection-panel` + 静态导入的同一个 TranslationPopover。两个面板类、两份 CSS 定位规则（`styles/enhanced-pdf.css:1965-1993` 与 `:2000-2030`），渲染同一个组件。
- **制卡 ×2**：链路 A 经 `selectionStudyActions.makeCardsFromSelection` 动态 `import('@/features/chat/services/selectionCardGeneration')`（`selectionStudyActions.ts:117-126`）；链路 B 静态导入同一服务（`PdfSelectionActions.tsx:30`）。
- **笔记 ×2 且行为分叉**：链路 A 经 `onCreateNote` 回调，上层 `FileContentView.handleCreateNote` 直接 `dstu.create('/')` 落根目录（`FileContentView.tsx:278-296`）；链路 B 走 `useSaveAsNoteFlow` 先弹目录选择器。同一个「做笔记」按钮，位置差 40px，落点语义不同。
- **送聊天 ×3 条通道**：链路 A 引用走 `onQuoteToChat`（`referenceToChat` 带 `page:N` locator）、出题走 `APP_EVENTS.PREFILL_CHAT_INPUT`；链路 B 走裸 `CHAT_V2_SET_INPUT` CustomEvent（`PdfSelectionActions.tsx:107-111`）。三条都真实生效（分别由 App.tsx 与 workbench 桥监听），但没有任何一处解释为什么要三条。

**懒加载策略被自己抵消（P2，实际性能影响）**：`EnhancedPdfViewer.tsx:89` 的 `React.lazy` 注释写明「懒加载避免把翻译链路打进 PDF chunk」，`selectionStudyActions.ts` 头注写明「为避免把 cardforge 打进 PDF chunk，调用方应通过本模块的懒加载包装进入」。但 `EnhancedPdfViewer.tsx:83` 静态导入 `PdfSelectionActions`，后者又静态导入 `ExplainPopover` / `TranslationPopover` / `generateCardsFromSelection`（`PdfSelectionActions.tsx:28-30`），而 `selectionCardGeneration` 顶层静态导入 cardforge 的 `cardAgent`。翻译链路和 cardforge 全部随 PDF chunk 打包，两处懒加载沦为纯开销（多一个 Suspense 边界、多一次动态 import 解析）。

**documentTitle 用的是资源 ID 而非文件名（P1，真实缺陷）**：

```3277:3282:src/features/pdf/components/EnhancedPdfViewer.tsx
      <PdfSelectionActions
        containerRef={containerRef}
        enabled={resolvedEnableTextSelection}
        isMobileLike={isMobileLike}
        documentTitle={resourcePath ? resourcePath.split('/').pop() : undefined}
      />
```

DSTU 路径的末段是资源 ID，不是名字——`src-tauri/src/dstu/types.rs:15` 的示例即 `/我的教材/tb_xyz789`。链路 B 的「保存为笔记」会把 `> tb_xyz789` 当出处引用行写进笔记正文。组件本身就有 `fileName` prop（`EnhancedPdfViewer.tsx:171`，链路 A 的出题 prompt 用它做来源标注，`:1394`），这里应传 `fileName`。一行修复。

**收敛建议**：两链路各有对方没有的东西——A 有高亮色板、页码 locator、来源标注；B 有「解释」、目录选择式笔记、与聊天划词一致的组件复用。合理终态是保留一条工具条，把缺的动作补进去：要么给共享 SelectionToolbar 增加可扩展动作槽（色板、出题）并让笔记/引用走带 locator 的回调，要么承认 PDF 场景的特殊性、让链路 A 吸收「解释」和目录选择笔记后删除 `PdfSelectionActions`。当前状态每多活一天，两边的行为分叉（文案、阈值、面板样式、事件通道）就多累积一点。

## 前端其余改造：大多扎实

**翻页导航（`pdfPageNavigation.ts`，新增）**：修复了真实缺陷——旧版双页模式 `±1` 步进会落进同一 spread，页码变了视图不动。新逻辑按 spread ±2 并对齐行首，`canNavigatePrev/Next` 让工具栏禁用态与 spread 语义一致；`coverOffset` 封面偏移（`[1] [2,3] [4,5]…`）是书籍类 PDF 的真实需求，虚拟行映射 `pageRowCount/getRowPages/getRowIndexForPage` 三处同步改动且互为逆映射（`EnhancedPdfViewer.tsx:2656-2683`）。PageUp/PageDown 的「放大时滚一屏、页面完整可见时翻页」裁决（`resolvePageScrollKeyAction`）对退化输入（NaN/Infinity/0）显式回退 navigate。145 行测试覆盖了尾部 spread 不塌缩、封面行、空文档等边界。挑不出实质问题。

**搜索增量发布（`pdfSearch.ts` 抽取 + `handleSearch` 改造）**：页内匹配抽成纯函数（保留 item 边界拼接语义——`join(' ')` 会让跨 item 的词永远搜不到，这是上一轮已修的 bug，本轮抽取时语义未漂移，有测试钉住）。增量发布让大文档首命中立即跳转，浅克隆发布的正确性论证直接写在注释里（「每页只在自己所属分块内被写入一次，已发布页的内层 Map 之后不会再被修改」，`EnhancedPdfViewer.tsx:1076-1087`）——这种把并发/别名安全论证留在现场的做法很好。小瑕疵：`publishPartial` 每个 chunk（2 页）都 `setSearchProgress` 触发一次 re-render，千页文档约 500 次；由于扫描本身走 `scheduleIdle` 分片、页面渲染有虚拟化，实际可感知开销有限，但进度展示按 5-10 chunk 节流会更省。

**每文档视图状态持久化（`pdfViewState.ts`，新增）**：字段级校验回退（非法字段独立丢弃不整体作废）、scale 钳制到 viewer 范围、损坏 JSON 静默回退，均有测试。模块头注解释了为什么选 localStorage 而不是 DSTU metadata（`dstu_set_metadata` 白名单落库，自定义字段写了也不回读）——选型论证落在代码里，之后的人不会踩坑。两个遗留：(1) 每文档一个 key 且无清理机制，文档删除/改路径后 key 遗留（体量极小，可接受）；(2) 同实例切换文档时，若新文档无持久化状态，只重置 `coverOffset`，`zoomMode/scale/viewMode` 继承上一文档的值而非回到默认（`EnhancedPdfViewer.tsx:689-706` 只在 `next` 有值时 set）——与新挂载时的行为不一致，属可辩护的「延续当前视图」，但最好是有意为之并注明。

**浮动菜单视口钳位（`resolveSelectionMenuFrame` + `useClampedMenuFrame`）**：修复旧版 `translate(-50%, -100%)` 在选区贴顶/贴边时菜单溢出视口的问题；frame 未就绪期间 `visibility: hidden` 防止未钳位坐标闪现，ResizeObserver 跟随菜单自身尺寸变化。测试覆盖翻转、双向钳位、过期锚点。扎实。

**批注保存的可见性（数据安全改善）**：旧版 OCC 冲突回滚、保存失败、远端版本覆盖本地修改全部只 `console.warn`，用户的高亮静默消失。本轮全部补了通知（`save_failed`/`remote_updated`，`EnhancedPdfViewer.tsx:1885-1975` 区间），「本地修改被服务端版本覆盖——必须让用户知道，而不是静默回滚」。正确。

**旋转语义放宽**：旧版旋转状态下整个划词菜单禁用并弹提示；现在只禁「创建高亮」（rects 依赖未旋转坐标系），复制/翻译/出题等文本动作照常可用（`:1343-1358`）。禁用面从「整个功能」缩小到「真正受坐标系影响的那一个动作」，是对上一轮保守修复的精化。

**Android 返回键可见性守卫**：keep-alive 隐藏层/后台标签页的阅读器实例不再吞掉其他页面的返回键，且注释点破了坑——`visibility:hidden` 不清除布局盒，`getClientRects()` 仍有返回值，必须单独查 computed visibility（`:1256-1262`）。真实缺陷的正确修复。

**侧栏合并与 a11y**：书签/批注两个独立浮动面板并入侧栏 4-tab（目录/缩略图/书签/批注），删除了约 240 行重复面板 JSX 与两段 fixed 定位 CSS，浮层互相遮挡的问题随之消失。进度条补齐 slider 键盘操作（`tabIndex`、方向键/翻页键/Home/End、`aria-valuetext`），并在容器级快捷键监听中对 slider 焦点豁免翻页键防双跳（`:2496-2501`）——豁免的原因（原生监听先于 React 合成事件）写清楚了。触控 44px 大面积补齐，且用源码契约测试钉住（`pdfMobilePanelTabs.source.test.ts` 解释了为什么只能钉源码：44px 靠 Tailwind 任意变体扛住双类名 CSS，jsdom 测不了媒体查询）。源码字符串断言本质脆弱，但测试头注把「为什么用这个手段」讲透了，作为回归护栏可接受。

**教材阅读进度跨文档串页修复**：`TextbookPdfViewer` 的页码上报去重基线在 `resourcePath/filePath` 变化时重置（`TextbookPdfViewer.tsx:92-97`），修复了新文档第一次跳到「恰好等于旧文档末页」的页码时不落进度的缺陷。小而准。

## 杂项

- `styles/enhanced-pdf.css` 中 `.ds-highlight-menu__divider` 定义了两次（`:739-744` 的 `align-self: stretch; margin: 2px` 与 `:1958-1963` 的 `height: 18px; flex-shrink: 0`），属性打架，后者的 `height` 实际生效、前者的 `align-self/margin` 残留。应合并为一处。
- `PdfReader.tsx` 顶栏返回箭头硬编码回 `chat-v2`。PdfReader 是顶级视图，多数入口确实来自聊天，可接受；若未来有其他入口需要改成记录来源视图。
- 出题接线的调研结论直接写在 `selectionStudyActions.ts` 头注里（为什么不能复用 `import_question_bank_stream(format='txt')`——那是「解析已有题目」的抽取流，对散文材料得到空结果；真正能出题的是聊天 Agent 的 qbank-tools）。把「排除了哪条错路、为什么」留档，避免了后人重走弯路，这是本轮注释文化的正面样本。

## 结论

后端两个文件的改造可以直接作为该仓库「怎么安全地重构遗留代码」的范例：先抽纯函数、把隐含前提（token 估算单调性、白名单不放宽）显式化成测试、修复与重构在同一次 diff 里可分辨。前端的功能扩张幅度大但多数子系统（导航、搜索、持久化、钳位）遵循了同样的方法论。需要在合流前处理的是：`documentTitle` 传 `fileName`（一行）、划词双链路收敛为一条（含笔记落点统一、聊天通道归一、删除失效的懒加载或删除抵消它的静态导入）、CSS 分隔线重复定义合并。OCR 与文档解析（`pdf_ocr_service.rs`、`document_parser.rs`）本轮零改动，不存在需要评审的变更。

## r6-review（划词）

> 0824 Wave2-B 第 6 轮复核，范围：EnhancedPdfViewer 划词菜单、PdfSelectionActions、
> onQuoteToChat 转发、聊天通道归一（无裸 CHAT_V2_SET_INPUT）、笔记条唯一性、
> documentTitle=fileName。口径：静态读码 + grep；环境无 node_modules 且本轮禁 npm，
> 测试未执行。

### 逐项核验

1. **EnhancedPdfViewer 菜单收敛 ✅**。viewer 内建面只剩三块且均不含学习动作：
   桌面划词浮动菜单 `ds-highlight-menu`（4 色高亮 + 复制 + 关闭，
   `EnhancedPdfViewer.tsx:3208-3265`）、移动底部条 `ds-pdf__highlight-bar`
   （同能力集，`:3236-3264`）、高亮块操作层（改色 + 删除，`:3268-3349`）。
   学习动作（解释/翻译/笔记/制卡/添加到聊天）统一由懒加载的
   `PdfSelectionActions` 承载（`:82` React.lazy，`:3193-3201` 挂载，
   Suspense 包裹、`enabled={resolvedEnableTextSelection}` 门控）。
   本文件上方「划词能力是两套平行系统」一节所述双链路已不存在：链路 A 的
   `onCreateNote`/翻译面板/出题入口在 pdf feature 内 grep 零命中，
   `.ds-pdf__translation-panel` CSS 已标废弃删除（`enhanced-pdf.css:2067`）。
   **无第二套笔记条 ✅**——「保存为笔记」仅 SelectionToolbar 一处入口，走
   `useSaveAsNoteFlow` 目录选择器，旧的 `dstu.create('/')` 落根目录路径已删。

2. **PdfSelectionActions ✅**。复用共享层 `SelectionToolbar`/`useTextSelection`；
   解释/翻译弹层 React.lazy、制卡动态 import（拆包契约由
   `pdfSelectionToolbar.source.test.ts` 钉住）；页码解析
   `resolveSelectionPage`（`PdfSelectionActions.tsx:132-142`）取
   `data-page-number`，失败按无页码降级不阻断动作；笔记正文带
   「摘自《fileName》第 N 页」来源行，与链路 A 摘录格式一致。

3. **onQuoteToChat 转发 ✅**。全链贯通：`EnhancedPdfViewer.tsx:3199` →
   `TextbookPdfViewer.tsx:270` → 两个上层视图均接 `useReferenceToChat`，
   metadata 带 `selectedText` + `buildSelectionLocator(page)`（`page:N`）：
   `TextbookContentView.tsx:512-522`（sourceType textbook）、
   `FileContentView.tsx:263-273`（sourceType file）。工具条侧优先级正确：
   有回调且页码可得走 locator 回调，否则 PREFILL 兜底
   （`PdfSelectionActions.tsx:183-190`）。`PdfReader.tsx` 未传
   onQuoteToChat 属预期——独立阅读器无 DSTU 资源身份，落 PREFILL 兜底且
   `fileName` 取自 `file.name`（`PdfReader.tsx:302`）。

4. **无裸 CHAT_V2_SET_INPUT ✅（运行时）/ ❌（测试已过期，本轮已修）**。
   运行时 pdf feature 内对 `CHAT_V2_SET_INPUT` 仅存注释引用，唯一派发通道是
   `sendSelectionToChatInput` 的 `PREFILL_CHAT_INPUT` 包装
   （`selectionStudyActions.ts:51-62`，detail 带 page/sourceName，
   autoSend=false）。**但行为测试 `PdfSelectionActions.test.tsx` 仍锁旧契约**：
   头注写「添加到聊天 → 走既有 CHAT_V2_SET_INPUT 全局事件」，用例监听
   `CHAT_V2_SET_INPUT` 且断言 detail 无 sourceName——按现实现该用例收到
   0 个事件、`toHaveLength(1)` 必失败，属第 4/5 轮通道收敛后漏更新的红测试。

5. **documentTitle=fileName ✅**。`EnhancedPdfViewer.tsx:3198`
   `documentTitle={fileName}`，本文件上方 P1（resourcePath 末段资源 ID
   泄入笔记来源行）已修，挂载处注释明确写了「必须用 fileName」的原因。

### 本轮补丁（仅测试，运行时零改动）

- `PdfSelectionActions.test.tsx`：改写「添加到聊天」用例组——
  ① onQuoteToChat + 页面选区（jsdom 内建 `data-page-number="3"` 包裹层 +
  真实 DOM Range）→ 断言回调收到 `{ text, page: 3 }` 且无 PREFILL 派发；
  ② 无回调 → PREFILL detail `{ content, autoSend: false, sourceName }`；
  ③ 有回调但页码不可得 → 回调不触发、落 PREFILL；
  ④ 任何情况不派发裸 `CHAT_V2_SET_INPUT`。头注同步更新。
- `pdfSelectionToolbar.source.test.ts`：新增 r6 契约组——
  `documentTitle={fileName}`（并显式禁止退回 `documentTitle={resourcePath`）、
  `onQuoteToChat={onQuoteToChat}` 转发、actionsSource 不得出现
  `APP_EVENTS.CHAT_V2_SET_INPUT`。

### 未验证声明

环境无 node_modules 且本轮禁 npm，上述测试补丁未执行，jsdom Selection API
（`createRange`/`addRange`）行为为静态推演（jsdom ≥16 支持，vitest.config.ts
environment='jsdom'）。第 8 轮前的执行轮次应跑
`src/features/pdf/components/__tests__/` 两个文件确认绿。
