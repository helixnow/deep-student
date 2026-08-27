# Wave2-B 第 5 轮 · SOTA-笔记：快速切换器 / 命令面板深度（静态子集）

- **身份**：0824 Wave2-B 第 5 轮「SOTA-笔记」。
- **范围声明**：纯静态改码（TS/TSX/CSS + 测试文本），**未运行任何 npm/编译/测试**（环境无 node_modules）。未提交/推送由本 agent 负责（见任务约束）。
- **选题依据**：`docs/dev/wave2-B-r1-notes-gap.md` 第 2 节，按「低风险 → 高价值」取第 1 项（G3）与第 5 项（S5）。两项均纯前端、复用现有数据链，不碰禁改区（NotesCrepeEditor OCC 主体、移动 44px、anki 全部未动）。

## 落地项 1：G3 图谱边类型分色（RemNote 分色边对位）

数据源 `notes_get_outgoing_links` 的 `linkType`（wikilink / noteref）本就到手，此前在 `localGraph.ts` 被丢弃。

- `graph/localGraph.ts`：
  - 新增 `LocalGraphEdgeKind = 'wikilink' | 'noteref' | 'unknown'`，`LocalGraphEdgeDatum` 增加必填 `kind`。
  - `unknown` 的语义：入链行（`NoteBacklinkDto`）不携带 `linkType`，仅从入链可见且反向信息不可得的边如实标注未知，**不猜类型**。两条补全通道：
    1. 双向链接：`collectNeighbors` 先按出链行建 `outgoingKindById`，入链行入队时借用反向类型；
    2. 深度 2 展开：`addEdge` 对已存在的 unknown 边做「见到出链行即升级」。
- `graph/NotesGraphTab.tsx`：客户端降级图（只解析 `[[..]]` 正文）边恒为 `wikilink`；工具栏新增图例（双链实线 / 引用虚线），**仅当图中真的存在 noteref 边时渲染**，纯双链库零噪声。
- `graph/NotesLocalGraphView.tsx`：边 className 按 kind 派生（`notes-graph-edge-<kind>`）。
- `graph/NotesLocalGraph.css`：noteref 边 `hsl(var(--info)/78%)` + `stroke-dasharray`（颜色+虚线双通道，非仅色觉）；wikilink 与 unknown 共用原中性实线。图例样式同款 token。

## 落地项 2：S5 快速切换结果拖拽（Obsidian 1.12「Quick switcher: dragging results」对位）

- `NotesSearchOverlay.tsx`：结果行（quick-open 与 full-text 两模式共用同一行组件）加 `draggable`，dragstart 经 `setWorkbenchDragData` 写入 `WB_RESOURCE_MIME` 负载（`resourceId/resourceType/title`）——与 files 列表拖源、`desktopDragBridge` 桌面落点桥、`NotesCrepeEditor` 的拖放解析完全同构，拖到桌面即按 O17 兜底 launch 开窗，零新协议。
- dragend 语义：`dropEffect !== 'none'`（落点已接收、资源已在别处打开）时自动关面板；拖拽取消（Esc/拖回）保持面板打开可继续检索。异常负载（如空标题）在 dragstart 捕获并 `preventDefault`，点击打开路径不受影响。

## 测试（静态新增/修订，未运行）

- `__tests__/localGraph.test.ts`：`outgoing()` 夹具支持 linkType 参数；新增两用例——① 四类边定型（入链-only=unknown、双向借用、wikilink/noteref/幽灵 noteref）；② 深度 2 展开对 unknown 边的类型升级。布局用例夹具补 `kind` 字段（类型必填后的编译一致性）。
- `__tests__/NotesSearchOverlay.test.tsx`：新增用例——结果行 draggable、MIME 负载 JSON 断言、text/plain 兜底、取消拖拽不关面板 / 接收后自动关面板。

## 边界与遗留

- **i18n**：图例 3 个新键（`notesWorkspace.graph.legendLabel/legendWikilink/legendNoteref`）以 `defaultValue` 内联（与 graph 页签既有键的落地方式一致）；`src/locales/*/workbench.json` 不在本轮可写区，**待后续轮把键补进双语文件**（zh：边类型图例/双链/引用；en 建议：Edge types / Wiki link / Reference）。
- 拖拽落点仅覆盖已有 O19 消费方（桌面开窗等）；「拖到树节点归档 / 拖到分屏」需要树侧 drop 语义扩展，不在本轮。
- 未做（按任务与 r1 结论明确排除）：L9 块引用、G2 全库图谱、A4/A5 可写 AI 侧栏；P6 日记入口因命令表在 `src/command-palette/**`（本轮不可写）而搁置。
