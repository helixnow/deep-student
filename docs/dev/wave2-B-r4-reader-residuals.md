# Wave2-B 第 4 轮 · 阅读器残项（pdfViewState / pdfSearch）

> 独占可写：`src/features/pdf/pdfViewState.ts`、`src/features/pdf/pdfSearch.ts`、
> 对应测试文件的断言源码（未执行）。**未改 `EnhancedPdfViewer.tsx`**——
> viewer 侧接线点在下文逐条标注，留给审阅员或后续轮次。
> 禁令沿用：未跑 npm/vitest/编译；未 commit/push。
> 残项来源：`wave2-B-r1-anchor-pdf.md` 第六节（viewstate GC）与第七节插入点表
> （搜索进度节流、切文档继承语义注明）。

## 一、切文档 zoom/viewMode 继承语义（注明「有意延续」+ 导出 helper）

**现行为（未改）**：`EnhancedPdfViewer.tsx` 约 693-710 行，同一挂载实例
resourcePath 变化时只应用新文档持久化状态中**存在**的字段——新文档从未保存过
zoomMode/viewMode 时，沿用上一文档当前的缩放与单双页；仅 `coverOffset`
经 `?? false` 无条件重置。

**本轮处理**：

1. `pdfViewState.ts` 头注新增「切文档时的继承语义」段，声明延续为**有意行为**
   （连续阅读多份文档时用户调好的可读性缩放应延续，不应每次切换弹回默认；
   新文档一旦被调整即拥有自己的持久化状态，互不影响）。现码不是 bug，未改行为。
2. 导出 `resolvePdfViewStateOnSwitch(defaults, persisted)`：以 defaults 兜底、
   persisted 覆盖，返回全字段确定的 `PdfViewState`（`coverOffset` 兜底 `false`）。
   若产品侧改为「切文档回默认」，viewer 在 resourcePath 变化 effect 中用它一次性
   解析后无条件 set 全部字段即可，两种语义的差异收敛在这一个纯函数上。

**viewer 接线点（本卡不做）**：`EnhancedPdfViewer.tsx` 693-710 行的逐字段
`if (next.zoomMode) …` 替换为对本 helper 结果的无条件应用。

## 二、搜索进度节流 helper（`pdfSearch.ts`）

**现状（未改）**：viewer `handleSearch` 按 2 页一个分块扫描，`publishPartial`
每个分块都 `setSearchProgress`（约 1087-1088 行），大文档一次搜索触发数百次
仅为进度数字的重渲染。

**本轮新增** `createSearchProgressThrottle(publish, everyNChunks = 5)`（纯函数、
无 React 依赖），语义：

- 首个分块立即发布（进度条不空窗）；
- 之后每 `everyNChunks` 个分块发布一次（默认 5，即 2 页/块 × 5 ≈ 每 10 页刷新）；
- 末个分块（`scanned >= total`）无条件发布（终值不丢）；
- `flush()` 补发最近一次被抑制的进度（一次性），供出错/取消等提前退出路径使用；
- 区间参数钳制到 ≥ 1（=1 时等价于不节流）。

只节流**进度数字**：命中结果的增量发布（`setSearchResults`/首个命中跳转）
不经过本 helper，不受影响。

**viewer 接线点（本卡不做）**：`handleSearch` 建立 task 处
`const progressThrottle = createSearchProgressThrottle((p) => setSearchProgress(p))`；
`publishPartial` 首行的 `setSearchProgress({...})` 换成 `progressThrottle.report({...})`；
catch 分支 `setIsSearching(false)` 前调 `progressThrottle.flush()`。

## 三、`pdf-viewstate:` 轻量 GC（`sweepPdfViewStates`）

**现状**（r1-anchor-pdf 第六节记录）：key 按 resourcePath 落 localStorage，
文档删除/重命名/移动后旧 key 永久遗留，无任何清理机制。

**本轮新增**：

1. `savePdfViewState` 载荷追加 `savedAt`（写入时间戳，签名末尾新增可选
   `now = Date.now()` 供测试注入）。它是存储层元数据：`normalizePdfViewState`
   读取时丢弃，不泄漏进 viewer 可见的视图状态，旧调用方零改动。
2. `sweepPdfViewStates({ maxEntries = 200, keepResourcePath?, storage? })`：
   遍历 `pdf-viewstate:` 前缀条目，超出上限时按 `savedAt` 淘汰最旧（近似 LRU——
   `savedAt` 是最后一次**写入**时间，纯只读打开不刷新；损坏/缺 `savedAt` 的
   旧版载荷按最旧优先淘汰）。`keepResourcePath` 保护当前打开文档的条目永不淘汰。
   先收集后删除（避免遍历中 `storage.key(i)` 索引失效）；单条删除失败不阻断；
   返回实际删除条数。
3. **不在模块 import 时自动扫全库**（头注已声明）：全库遍历 O(storage.length)，
   由调用方在低频时机显式触发。

**接线建议（本卡不做，任选其一即可）**：

- 打开 PDF 阅读器时（如 viewer 挂载 effect 或 PdfReader 入口）调一次
  `sweepPdfViewStates({ keepResourcePath: resourcePath })`；
- 或 DSTU 删除/移动完成回调处调用（可配合精确 `removeItem(pdfViewStateKey(path))`）。

同持久层的 `epub-reader:<id>`、`pdf:darkReading` 不在本卡范围，sweep 只认
`pdf-viewstate:` 前缀、跳过异前缀 key（有测试断言）。

## 四、测试源码（已添加，未执行）

- `__tests__/pdfViewState.test.ts`：fake storage 扩展 `removeItem/key/length`；
  新增 `savedAt` 元数据不可见性、`resolvePdfViewStateOnSwitch` 逐字段兜底、
  sweep 的上限内 no-op / 按 savedAt 淘汰 / 损坏与旧版载荷最旧优先 /
  keepResourcePath 保护与异前缀 key 免疫共 7 条断言组。
- `__tests__/pdfSearch.test.ts`：节流 helper 的首块立即发布、每 N 块发布、
  终块必发、flush 单次补发、区间钳制共 4 条断言组。

均为纯函数测试，无 DOM/timer mock 依赖；本轮禁跑 vitest，留待后续轮次执行核对。

## 五、行为影响面

- 运行时行为唯一变化：`savePdfViewState` 写入的 JSON 多一个 `savedAt` 字段
  （读取路径丢弃，viewer 无感知；旧载荷无 `savedAt` 仅影响未来 sweep 的淘汰
  顺序——按最旧处理）。
- 其余全部为新增导出（`resolvePdfViewStateOnSwitch` / `sweepPdfViewStates` /
  `DEFAULT_PDF_VIEW_STATE_CAP` / `createSearchProgressThrottle` 及配套类型），
  无现有调用方,不接线不生效。
