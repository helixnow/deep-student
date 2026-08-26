# 0824 Wave2-B 第 1 轮 锚定员-pdf 工作记录

角色：本轮 PDF 产品文件唯一写手。基线 `cursor/0824-wave2-desktop-subapps-a875 @ 061b4815`。
按约束未运行编译/测试/npm/cargo/npx，未 commit/push。

## 一、Step 22 复核（documentTitle）

**已核实，未重做。** `EnhancedPdfViewer.tsx` 挂载点已是 `documentTitle={fileName}`
（改动后约 3288 行），且带解释性注释：「documentTitle 必须用 fileName——DSTU
resourcePath 的末段是资源 ID（如 /我的教材/tb_xyz789），不是人类可读的文件名」。
Step 22 `a25d56e4` 的一行修复在现码中完好，本轮零改动。

## 二、本轮产品改动清单（最小化）

| 文件 | 改动 | 性质 |
|---|---|---|
| `styles/enhanced-pdf.css` | `.ds-highlight-menu__divider` 双定义合并为一处 | 纯整理，计算样式不变 |
| `components/EnhancedPdfViewer.tsx` | `PdfSelectionActions` 静态 import → `React.lazy` + `Suspense fallback={null}` | 懒加载策略恢复 |
| `components/PdfSelectionActions.tsx` | `ExplainPopover`/`TranslationPopover` → 模块级 `React.lazy`（named export 映射 default）；`generateCardsFromSelection` → 点击时动态 `import()`；结果面板内容包 `Suspense` | 懒加载策略恢复 |
| `selectionStudyActions.ts` | **零改动**——其 `makeCardsFromSelection` 动态 import 包装本来就正确，保持 | 复核确认 |

未删除任何一条划词链路（链路收敛归第 4 轮）。未触碰 TextbookContentView /
FileContentView 保存语义、coordinator.rs、qbank/anki 服务层、移动 chrome。

### CSS 合并说明

合并前两处同名规则（同特异性，后者覆盖前者的冲突属性）：

- 约 739-744 行（划词/高亮菜单区块）：`align-self: stretch; width: 1px; margin: 2px 2px; background`
- 约 1958-1963 行（翻译卡片区块）：`width: 1px; height: 18px; background; flex-shrink: 0`

合并前实际计算样式 = 两者并集（`height: 18px` 来自后者覆盖；`align-self`/`margin`
来自前者、未被覆盖）。合并后单一规则（现约 738-749 行）逐字保留该并集：
`align-self: stretch; width: 1px; height: 18px; margin: 2px 2px; background: hsl(var(--border)); flex-shrink: 0`。
定高 18px 时 `align-self: stretch` 不参与拉伸（定高优先），视觉零变化。原第二处
位置留了一行指路注释。该类名有两个使用点（桌面浮动菜单约 3315 行、高亮操作条约
3446 行），两处均为 flex 行内分隔线，合并对两处等效。

### 懒加载修复：前后 import 图

**修复前**（懒加载被自己抵消）：

```
EnhancedPdfViewer ──静态──> PdfSelectionActions ──静态──> ExplainPopover
     │                            ├──静态──> TranslationPopover        ← 与下面的 lazy 同模块
     │                            └──静态──> selectionCardGeneration ──静态──> cardforge/cardAgent
     ├──lazy──> TranslationPopover        ← 沦为纯开销：同模块已被静态图拉进 PDF chunk
     └──> selectionStudyActions ──动态 import──> selectionCardGeneration  ← 同样被抵消
```

翻译链路 + cardforge 全部随 PDF chunk 打包；两处精心设计的 lazy/动态 import
只剩 Suspense 边界和一次多余的 import 解析开销。

**修复后**：

```
EnhancedPdfViewer ──lazy──> PdfSelectionActions ──lazy──> ExplainPopover（点「解释」才载入）
     │                            ├──lazy──> TranslationPopover（点「翻译」才载入）
     │                            └──点击时动态 import──> selectionCardGeneration ──> cardforge
     ├──lazy──> TranslationPopover（链路 A，点「翻译」才载入，真正生效）
     └──> selectionStudyActions ──动态 import──> selectionCardGeneration（保持原样，真正生效）
```

要点：

- `PdfSelectionActions` 无条件渲染（内部 `enabled` 短路），所以其自身 chunk 仍会在
  viewer 挂载后即拉取——但 shared/selection、shared/notes、聊天弹层、cardforge 已
  全部移出 PDF 主 chunk 的同步解析路径，且弹层/制卡进一步推迟到用户点击。
- 两个聊天弹层组件既有 named export 也有 default export；`PdfSelectionActions`
  内的 lazy 用 `.then((m) => ({ default: m.ExplainPopover }))` 映射 named export，
  与既有测试对这两个模块的 named-export mock 形状兼容。
- `PdfSelectionActions.tsx` 自身有 `export default`，`React.lazy(() => import('./PdfSelectionActions'))`
  直接可用。

## 三、双链路事件通道地图（3 条聊天通道）

同一次划词有两条工具条（链路 A 自研高亮菜单在选区上方；链路 B 共享层
SelectionToolbar 在选区下方），送聊天共 3 条通道，各自监听方如下：

| # | 发起方（动作） | 通道 | 监听方 / 消费链 |
|---|---|---|---|
| 1 | 链路 A「引用到对话」（`EnhancedPdfViewer` 约 1477-1481 行 → `onQuoteToChat` prop） | **回调 prop，非事件** | `FileContentView.handleQuoteToChat`（265 行）与 `TextbookContentView.handleQuoteToChat`（514 行）→ `useReferenceToChat().referenceToChat`（learning-hub）→ `vfsRefApi` 取引用 + `resourceStoreApi` 写 `pendingContextRefs`，带 `page:N` locator，走资源引用而非文本注入 |
| 2 | 链路 A「生成题目」（`selectionStudyActions.sendSelectionToQuestionGeneration` 100 行） | `APP_EVENTS.PREFILL_CHAT_INPUT`（window CustomEvent） | 唯一监听方 `App.tsx:1785`（`handlePrefillChatInput`）→ `setCurrentView('chat-v2')` 后延时 150ms **转发为 `CHAT_V2_SET_INPUT`**（`App.tsx:1772-1775`）——即通道 2 是通道 3 的「先切视图再转发」包装 |
| 3 | 链路 B「添加到聊天」（`PdfSelectionActions.handleAddToChat`，裸 `window.dispatchEvent`） | `CHAT_V2_SET_INPUT`（window CustomEvent） | 两个监听方并存：`useChatPageEvents.ts:713`（legacy ChatV2Page，经 `currentSessionId` 中转写输入框）与 `WorkbenchEventBridge.tsx:232`（workbench 模式，activate 最近聚焦 chat 窗 setInput，无窗则先建会话）。另有 `legacyNavigationMap.ts:98` 是**转发者**（dispatchDeferred）而非监听方；聊天内部 `MessageItem.tsx:351` 也用同一裸事件（先例） |

通道差异的语义后果：通道 1 注入的是**资源引用 + 页码 locator**（Agent 可回读原文）；
通道 2/3 注入的是**纯文本到输入框**（autoSend=false）。三条通道均真实生效，
收敛方向见第六节插入点表。

## 四、pdfViewState 切文档继承语义（现状记录）

`EnhancedPdfViewer.tsx` 约 693-710 行（同实例 `resourcePath` 变化时）：

- `zoomMode`/`scale`：仅当新文档**有**持久化值时 set；无则**继承上一文档的当前值**；
- `viewMode`：同上，仅有值时 set；
- `coverOffset`：唯一显式重置的字段（`setCoverOffset(next.coverOffset ?? false)`）。

与「新挂载实例」的行为不一致（新挂载走 props/默认值）。评审判定为「可辩护的
延续当前视图，但最好注明是有意的」。本轮**未改**——这不在授权改动清单内，且行为
变更需要产品裁决；留给后续轮补一条注释或统一重置。落盘侧（712-732 行）有基线
守卫：首次运行只建基线不写入，避免打开即污染 localStorage；双页偏好在窄屏自动
降级时不被覆盖（`viewModeForPersistRef` 只跟随双页入口可用时的选择）。

## 五、搜索节流现状（记录，未改）

- 输入侧：300ms debounce（`EnhancedPdfViewer.tsx` 约 1163-1166 行），查询清空立即
  abort + 清结果。
- 扫描侧：`chunkSize = 2` 页/分块，分块间 `scheduleIdle`（requestIdleCallback，
  超时 300ms 兜底 setTimeout），任务级 `cancelled` 标志 + idle handle 取消。
- 发布侧：`publishPartial()` 每分块必调 `setSearchProgress`（约 1088 行），命中有
  增量时再浅克隆发布 `results`/`rangesByPage`（浅克隆安全性论证在 1059-1060 行注释：
  每页只在所属分块内写入一次，已发布页的内层 Map 不再被改）。
- 已知残留：千页文档约 500 次进度 re-render。评审建议按 5-10 分块节流进度更新；
  因扫描走 idle 分片 + 页面虚拟化，实际可感知开销有限。**本轮未改**（不在授权
  清单，属第 4 轮可顺手项，见插入点表）。

## 六、pdf-viewstate 无清理 key 的 GC 现状（记录，未改）

`pdfViewState.ts` 以 `pdf-viewstate:<resourcePath>` 为 key 写 localStorage：

- **无任何清理机制**：文档删除、重命名、移动（resourcePath 变化）后旧 key 永久遗留；
- 同一持久层的同类先例同样无 GC：`epub-reader:<id>`（EPUB 排版状态）、
  `pdf:darkReading`（全局单 key，无遗留问题）；
- 单条 payload 约 80 字节（4 字段 JSON），千文档量级约 80KB，远低于 5MB 配额；
- 写入侧有钳制/校验（`normalizePdfViewState` 字段级回退），读损坏 JSON 静默回退，
  不存在坏 key 导致崩溃的路径。

结论：体量与安全性上可接受，但属「只增不减」的存储。若要做 GC，唯一可靠的挂点
是 DSTU 删除/移动操作的完成回调（前端无法枚举「still-alive resourcePath 集合」做
mark-sweep——localStorage key 可枚举但资源全集需要遍历 DSTU 树）。列入插入点表。

## 七、给第 4 轮（划词双链路收敛）的插入点表

| 插入点 | 位置 | 现状与收敛动作 |
|---|---|---|
| 链路 B 挂载点 | `EnhancedPdfViewer.tsx` 约 3283-3290 行（`Suspense` + `<PdfSelectionActions>`） | 若判收敛为删 B：整块删除 + 删 95 行 lazy 声明即可，无其他引用点（全仓仅此一处挂载 + 测试） |
| 链路 A 菜单 | `EnhancedPdfViewer.tsx` 约 3292 行起（桌面浮动菜单）与 3436 行起（移动底部色板条），事件驱动在 1651-1690 区间（document 级 mouseup/touchend/selectionchange） | 若判收敛为留 A：需从 B 吸收「解释」动作与目录选择式笔记（`useSaveAsNoteFlow`） |
| 笔记落点分叉 | A：`onCreateNote` → `FileContentView.handleCreateNote` / `TextbookContentView.handleCreateNote` 直接 `dstu.create('/')` 落根目录；B：`useSaveAsNoteFlow` 先弹目录选择器 | 收敛必须统一落点语义；注意 TextbookContentView/FileContentView 保存语义是第 3 轮辖区，第 4 轮动它前先对齐 |
| 聊天通道归一 | 见第三节地图 | 建议：文本注入统一走 `APP_EVENTS.CHAT_V2_SET_INPUT`（`dispatchAppEvent` 类型化封装，`events/app.ts:39` 已有常量）替换裸 CustomEvent；引用保留通道 1（有 locator，语义更强） |
| 翻译面板 ×2 | A：`ds-pdf__translation-panel`（CSS 约 1965 行起）+ viewer 内 lazy 弹层（3505-3519 行）；B：`ds-pdf__selection-panel`（CSS 约 2005 行起）+ 组件内 lazy 弹层 | 删掉哪条链路就删对应 CSS 区块与 lazy 声明；两边现在都是 lazy，删除无打包副作用 |
| 制卡入口 ×2 | A：`selectionStudyActions.makeCardsFromSelection`（动态 import + `getFixedT`）；B：`PdfSelectionActions.handleMakeCards`（本轮改为点击时动态 import，传组件 `t`） | 收敛后二选一；若留 B 建议改走 A 的包装以复用校验/文案逻辑 |
| **测试跟进** | ~~`pdfSelectionToolbar.source.test.ts` 静态 import 字符串断言~~ **已在本轮续段对齐**（见第八节）；剩余：`PdfSelectionActions.test.tsx` 解释/翻译面板与制卡断言为同步写法（`act` + 立即 `getByTestId`/`toHaveBeenCalled`），lazy/动态 import 引入微任务延迟后会跑红 | 第 7 轮改 `findBy*`/`waitFor`；本轮不动行为测试 |
| 搜索进度节流（可顺手） | `EnhancedPdfViewer.tsx` `publishPartial`（约 1086-1088 行） | `setSearchProgress` 按每 5-10 分块或 rAF 节流 |
| pdf-viewstate GC（可选） | DSTU 删除/移动完成回调处 `removeItem(pdfViewStateKey(path))` | 体量小，优先级低 |
| 切文档继承语义注明 | `EnhancedPdfViewer.tsx` 693-710 行 | 补注释声明「延续当前视图」是有意行为，或统一重置为默认 |

## 八、测试源码已对齐 / 未执行（第 1 轮续）

`pdfSelectionToolbar.source.test.ts` 的字符串断言已按本轮懒加载改动更新,不再把
「静态导入」重新钉死:

- viewer 侧:改为断言 `React.lazy(() => import('./PdfSelectionActions'))` 且仍挂载
  `<PdfSelectionActions`,并新增反向断言 `not.toContain("import { PdfSelectionActions } from")`
  防止退回静态导入;
- 制卡:改为断言动态 `import('@/features/chat/services/selectionCardGeneration')`,
  反向钉住静态 `import { generateCardsFromSelection } from` 不得回归;
- 解释/翻译弹层:改为断言 `React.lazy` + `import('@/features/chat/components/ExplainPopover')`
  / `import('@/features/chat/components/TranslationPopover')`,反向钉住两条
  `from '@/features/chat/components/...'` 静态导入不得回归;
- 原有守护全部保留:共享层 `SelectionToolbar`/`useTextSelection`、`hideUnavailableActions`、
  不出现 `ChatV2AnkiAdapter`/`saveAnkiCards`、笔记走 `useSaveAsNoteFlow`、
  不直接 `notesDstuAdapter`、结果面板非 Dialog、Android 返回键等断言未动。

对齐方式为 grep 干跑逐条核对(正向断言各命中 1 次以上、反向断言均 0 命中),
**未执行 vitest**(按第 1 轮约束)。

`PdfSelectionActions.test.tsx` 复核确认:该文件没有源码字符串断言(只有 `vi.mock`
路径与行为断言),本轮未改。已知其解释/翻译面板与制卡断言是同步写法
(`act` + 立即 `getByTestId`/`toHaveBeenCalled`),lazy/动态 import 引入微任务延迟后
会跑红——**第 7 轮需改 `findBy*`/`waitFor`**,本轮不动行为测试。

## 九、自检

- 产品改动共 3 文件、+60/-38 行，全部落在授权清单内；`selectionStudyActions.ts`
  确认保持动态 import，零改动。
- 语法自查：`React` 已在两文件顶部导入；lazy 目标模块均有可用导出
  （`PdfSelectionActions` 有 default，两弹层 named→default 映射）；JSX 配对完整。
- 未运行任何编译/测试命令（按约束）；已知两个测试文件需要后续轮跟进（上表）。
