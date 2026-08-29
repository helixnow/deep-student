# 思维导图 / 大纲 / 导入与背诵质量评审

对照范围：`v0.9.44` → `origin/cursor/0824-cde6 @ 2d41ea8b`。结论只基于 `src/features/mindmap/**` 的真实差异及这些新增字段直接经过的既有模块；按要求未运行编译、测试或门禁。

## 总判定

整体判定为 **FAIL：方向和局部工程质量明显优于旧版，但三项核心新增能力都还不能按完整闭环验收。**

这轮确实有净改善：导入端新增 `.mmap`、XMind 小图保留、未知 XML 的明确报错和解析忙碌态；多 sheet 从“只合成虚拟根”进化到有显式元数据与切换入口；大纲开始真正减少 React 挂载量；画布快捷键查询也从全局 DOM 收敛到实例容器。触屏命中、返回键和错误反馈的改动大多是扎实的。

但问题也不是边角瑕疵：

1. 图片解包只限制“解压后再判断的单图大小”，没有解压前和累计预算，旧版原本不解压图片，本轮由此新增了可被压缩包放大的内存风险。
2. 背诵统计没有“实际作答/访问”事件，既会把未看过的空算作答对，又无法记录全对会话；`lastReviewedAt` 也不参与调度，所以当前是错误率排序，不是 SRS。
3. 大纲窗口化明知行高可变，仍用全局固定 36px 反推索引和 spacer；备注、图片和多行文本越多，定位与拖拽切换越不可靠。

## 图片导入把数据保留下来了，也引入了本轮最高风险

### P0 — 单图上限在完整解压之后检查，且没有全局图片预算

压缩包本身限制为 16 MiB，`content.json/content.xml` 也使用流式 32 MiB 上限，这是旧实现中保留得很好的防线（`src/features/mindmap/utils/importers.ts:490-550`）。新图片路径却绕开了同等级保护：

- `tryEmbedImage` 先执行 `entry.async('uint8array')`，把资源完整解压进内存，之后才检查是否超过 256 KiB（`importers.ts:215-239`）。单张超大压缩图片仍可先制造峰值内存占用。
- `resolvePendingImages` 对所有引用逐个解压并把 base64 永久累积进文档，没有图片数量、累计原始字节或累计 data URL 大小限制（`:248-265`）。
- 节点上限是 10000；即使每个节点只有一张刚好 256 KiB 的图，理论原始数据已约 2.44 GiB，base64 还会再膨胀约三分之一。高度可压缩的重复内容仍可能装进 16 MiB 压缩包。

这不是旧债：v0.9.44 只统计并丢弃图片，不会读取图片 entry。本轮应把图片读取改成与正文相同的流式硬中断，同时增加整次导入的图片数、总解压字节和总内联字节预算；JSZip 可见的 advertised uncompressed size 只能作为前置拒绝，不能替代流式累计。

### P1 — 图片只接通了“导入后显示”，复制和 XMind 回导仍会静默丢失

画布通过 `WeakMap<root, index>` 查询图片，避免把大 data URL 复制进每个 ReactFlow `node.data`，并由既有 `ResizeObserver` 回写真实节点高度；这个接法侵入小、引用稳定，是正确的（`src/features/mindmap/utils/nodeImages.ts:18-41`；`components/mindmap/nodes/BranchNode.tsx:76-83,222-225`）。画布和大纲也都实际渲染了缩略图（`components/mindmap/nodes/NodeContent.tsx:278-299`；`views/outline/SortableOutlineNode.tsx:1381-1395`）。

数据生命周期却没有同步升级：

- 结构化剪贴板声称保留文档字段，但白名单重建节点时只接到 `refs`，没有复制 `images`；应用内复制/粘贴一个含图节点，图片会无提示消失（`src/features/mindmap/utils/clipboardCodec.ts:178-214`）。
- XMind 导出仍只生成标题、备注、任务、背景色和关联线，固定输出一个 sheet；既不写图片资源，也不消费 `meta.sheets`（`utils/exporters.ts:235-290`）。因此“XMind 导入 → 编辑 → XMind 导出”会丢图片并把多 sheet 压成单 sheet。
- `importFromJson` 用对象展开保留任意 `images` 值，两个渲染器又直接把 `image.src` 交给 `<img>`，没有 data URL MIME/体积校验，也没有 http(s) allowlist（`utils/importers.ts:1089-1120`；`NodeContent.tsx:281-297`）。本地 JSON 可借远程图片产生非预期网络请求，类型注释中的“安全的 http(s) 地址”没有运行时实现。

此外，`MindMapImage` 已成为节点公共字段，却没有从 `types/index.ts` 或模块主入口导出；本轮只补了 `MindMapSheetMeta` 的局部 barrel 导出（`src/features/mindmap/types/index.ts:7-27`；`src/features/mindmap/index.ts:22-62`）。这虽不阻断当前内部渲染，但说明模型扩展没有完整走过公共 API 边界。

## “难点优先”可用作原型，不能称为可靠 SRS

### P1 — 会话统计的正负样本定义自相矛盾

`commitReciteSession` 只要发现任意一个已揭示空，就遍历当前整个 scope，把其中每个空都 `attempts + 1`；只有当前仍在 `revealed` 中的空增加 miss（`src/features/mindmap/utils/reciteSrs.ts:73-107`）。这会产生三个确定性错误：

1. 用户只看了第一个节点并翻开一个答案，随后退出；同一导图中所有从未滚到、从未作答的空都会被记成“答对一次”。
2. 用户所有答案都背出、一次也未翻开时，`revealedAny` 为 false，整个会话被忽略，系统永远收不到纯成功样本（`:84-87`）。
3. “重新遮盖”直接清空 `revealedBlanks`（`src/features/mindmap/store/mindmapStore.ts:3194-3197`）。用户翻开答案后再重置，退出时该 miss 消失；这里记录的是退出瞬间 UI 状态，不是会话事件。

退出背诵时加载旧统计、提交并写回 localStorage 的事务边界本身很清楚（`mindmapStore.ts:3082-3105`），问题在于没有 `visited/graded` 真源。应按每个空记录本会话是否呈现、是否揭示以及最终评分，只提交实际作答项；“显示全部”也不应不加区分地变成全量 miss。

### P1 — 统计键会漂移，而且算法没有任何“间隔”调度

统计使用 `nodeId + merge 后区间索引` 作为身份（`reciteSrs.ts:29-30,67-70`）。删除一个挖空时，store 只迁移当前会话的 `revealedBlanks` 索引，不迁移 localStorage 中的历史统计（`mindmapStore.ts:3209-3239`）；清空后重建、区间合并或替换导入文档也会让旧统计落到另一段文本上。

同时，`ReciteBlankStat` 虽保存 `lastReviewedAt`，队列只按 `(misses+1)/(attempts+2)` 的最大值降序排列，时间字段完全未使用（`reciteSrs.ts:20-45,110-132`）。没有 due date、间隔、熟练度状态或复习后间隔更新，所以准确口径应是“历史错误率优先”，不是 spaced repetition。若产品确实要 SRS，需要稳定的 blank id/fingerprint、显式评分和调度状态；若只要难点排序，应改名并删去 SRS 承诺。

UI 层也有一个多实例回退：新导航用全局 `document.querySelector([data-node-id=...])` 且未做 `CSS.escape`（`components/shared/ReciteStatusBar.tsx:8-16`）。导入 ID 含引号时会形成非法 selector；分屏或保活实例有相同 `root` ID 时还可能滚动另一棵大纲。画布空间导航本轮已经正确按 `containerRef` 限域，这里应复用同一原则（`hooks/useMindMapKeyboard.ts:246-260`）。

## 固定 36px 的窗口化不适合当前大纲

### P1 — spacer 与索引计算没有任何实测高度模型

窗口化在 500 行起启用，直接用 `floor(scrollTop / 36)` 求首行，并用“行数 × 36”生成所有 spacer；目标定位同样是 `index × 36`（`src/features/mindmap/views/outline/outlineVirtual.ts:18-25,57-76,90-129`）。文件注释承认行高可变，却把固定估值称为“自洽、误差内可用”（`:8-13`）。

当前行实际可包含多行正文、任意行备注、自动高度 textarea、refs，以及本轮新增的 48px 图片缩略图（`SortableOutlineNode.tsx:1348-1405`）。这不是少量随机误差，而是系统性偏差：

- 滚动到深处或恢复 scrollTop 时，固定估值可能定位到错误节点；高备注/多图行越多，误差越大。
- 窗口中的真实高行挂载、离开窗口后又被 36px spacer 替换，滚动总高度会随窗口移动而变化；调用方还显式关闭了浏览器 scroll anchoring（`views/OutlineView.tsx:1078-1099`）。
- 开始拖拽后窗口化突然关闭并全量挂载，以便 dnd-kit 测量（`OutlineView.tsx:366-408`）。此时所有估算 spacer 一次替换为真实高度，正是最容易让拖拽起点和滚动位置跳变的时刻。

保留聚焦/编辑行、拖拽时关闭窗口化、scroll/resize 用 rAF 合并，这些保护思路是对的（`outlineVirtual.ts:78-117`；`OutlineView.tsx:370-408`）。但实现必须至少维护已测量行高缓存与前缀和，未测量项再用估值；或者采用成熟的 variable-size virtualizer。只调大 overscan 不能修复深层位置映射。

## 导入与 sheet：兼容面扩大了，产品语义仍应收敛

本轮 importer 的主体质量总体是正向的：

- Markdown 文件继续复用粘贴解析真源；`.mm`、OPML、XMind 的深度/节点数限制仍在。
- `.mmap` 读取 `Document.xml` 并复用内容体积限制，至少把 MindManager 标题拓扑接进来（`importers.ts:653-712`）。
- 未知 XML 不再误报成 OPML，导入 UI 有忙碌态、内联错误与未保存确认（`importers.ts:1147-1205`；`MindMapContentView.tsx:764-840,1403-1433`）。
- XMind 图片失败会写备注占位并汇总报告，比旧版纯静默丢弃更诚实（`importers.ts:243-265`）。

需要约束发布口径的有两点：

1. `.mmap` 目前只取 `Text@PlainText` 和 `SubTopics`，注释明确把备注、图标、样式等静默丢弃；UI 却只给通用“导入 N 个节点”成功提示，丢失报告仍只覆盖 XMind（`importers.ts:657-712`；`MindMapContentView.tsx:780-804`）。这是“基础拓扑导入”，不是高保真 MindManager 导入。
2. 多 sheet 的旧版本来就会合成虚拟根；本轮真正新增的是 `meta.sheets` 映射和通过 `viewRootId` 切换子树（`importers.ts:453-479`；`utils/sheetTabs.ts:17-41`；`MindMapContentView.tsx:1089-1132`）。这个最小侵入方案做得合理，删除 sheet 根后标签自动消失也符合单树模型，但它仍是“sheet 导航器”，不是独立画布：所有 sheet 共用一棵树、同一历史与同一导出，XMind 导出仍固定单 sheet。

触控和实例隔离也是净改善。44px 目标覆盖了工具栏、菜单、面包屑与背诵条；画布空间导航已把 DOM 查询限定到本实例（`MindMapCanvas.tsx:271-273`；`useMindMapKeyboard.ts:246-260`）。不过密集色板使用 24px 视觉尺寸、12px 间距，再向四周外扩 10px，邻近命中盒会重叠约 8px（`components/toolbar/FormatBar.tsx:56-82`）；边缘点按由绘制/命中顺序决定。触控目标应通过真实布局尺寸或至少 20px 间距实现，不能只叠加透明伪元素。

## 验证缺口与收口顺序

本区间的 39 个 mindmap 改动文件没有新增或修改测试。尤其 `reciteSrs.ts`、`outlineVirtual.ts`、`sheetTabs.ts`、`nodeImages.ts` 都是新纯逻辑模块，却没有同区间回归；`.mmap`、累计图片预算、图片复制/导出、多 sheet 回导也没有在本模块 diff 中形成证据。

建议按风险排序收口：

1. 先给压缩图片增加解压前拒绝、流式单图中断和整次导入累计预算；JSON 图片源做严格运行时清洗。
2. 重做背诵事件模型，只统计实际呈现并评分的 blank；为 blank 提供稳定身份。随后明确选择“错误率排序”还是实现真正的 due/interval SRS。
3. 用实测高度缓存重写大纲窗口位置模型，覆盖长备注、多图、深滚动、搜索跳转、scroll restore 与拖拽启停。
4. 补齐图片在剪贴板、复制、XMind 导出和公共类型入口中的生命周期；多 sheet 若暂不回导，应在导出前明确提示降级。
5. 最后补 `.mmap` 丢弃报告、sheet 数据校验和触控命中重叠，并为上述纯函数和端到端往返建立回归。

相对 v0.9.44，这轮让导入范围、可见反馈、触控和大图性能方向都向前走了一步；但图片从“丢弃”升级为“持有”、大纲从“全挂载”升级为“窗口化”、背诵从“揭示状态”升级为“历史排序”后，相应的数据预算、位置模型和学习事件模型没有同步升级。当前更准确的评价是：**可用原型明显增强，核心新能力仍需结构性收口。**
