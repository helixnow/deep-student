# R2 @hello-pangea/dnd → @dnd-kit 迁移·首批（SA-R2-07 / WI-8）

> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 子代理：SA-R2-07
> 模型：`claude-fable-5-thinking-xhigh`

## 0. TL;DR

`@hello-pangea/dnd` 在 `src/` 的**全部 2 个真实使用场景**（设置页供应商排序侧栏 + Chat V2 会话拖入分组侧栏，共 4 个文件）已迁移到 `@dnd-kit`，无跳过项。迁移后 `src/` 内 `@hello-pangea/dnd` 的 import 归零，该库（min 97.3 kB / gzip 29.4 kB，另含 redux、react-redux、css-box-model 等仅为其服务的传递依赖）将从 chat 懒加载 chunk 中被 tree-shake 掉。typecheck 通过、`lint:components` 规则 0 error、相关 vitest 5 个套件 36/36 通过。`package.json` 依赖删除留待后续轮次（见 §5）。

## 1. 使用点盘点（`rg "@hello-pangea/dnd" src`）

| 文件 | 使用方式 | 处置 |
| --- | --- | --- |
| `src/features/settings/components/VendorSidebar.tsx` | `DragDropContext/Droppable/Draggable/DropResult`（垂直排序） | ✅ 迁移 |
| `src/features/chat/pages/SessionSidebarContent.tsx` | `DragDropContext/Droppable/Draggable/DropResult`（会话→分组跨容器拖拽） | ✅ 迁移 |
| `src/features/chat/pages/SessionItemRenderer.tsx` | `DraggableProvided/DraggableStateSnapshot` 类型（`SessionDragState`） | ✅ 迁移 |
| `src/features/chat/pages/useSessionEdit.ts` | `DropResult` 类型（`handleDragEnd`） | ✅ 迁移 |
| `src/lazyComponents.tsx` | 仅注释提及 | ✅ 注释更正 |
| `src/hooks/useTouchFriendlyDndSensors.ts` | 仅注释提及 | ✅ 注释更正 |
| `src/features/chat/pages/ChatV2Page.tsx`（rg 关键词补充命中） | 仅注释提及 | ✅ 注释更正 |

无高风险跳过项：两个场景分别对应项目内已有成熟 dnd-kit 范式（`TodoSidebar` 的垂直 sortable、`FinderFileList` 的 useDraggable/useDroppable + DragOverlay 跨容器拖放），直接对齐即可。

## 2. 迁移方案

统一走项目既有约定：传感器一律 `useTouchFriendlyDndSensors()`（鼠标 8px 起拖保留行点击、触屏长按 250ms/容差 8px 与迁移前 hello-pangea 语义一致、键盘可访问拖放），自动滚动一律 `SHELL_SAFE_AUTO_SCROLL`（防桌面壳整页滚走）。

### 2.1 VendorSidebar（供应商排序，对齐 `TodoSidebar` 范式）

- `DragDropContext/Droppable/Draggable` → `DndContext(closestCenter + restrictToVerticalAxis) > SortableContext(verticalListSortingStrategy) > SortableVendorRow(useSortable)`。
- 原 `renderVendorRow` 渲染函数提为顶层 `SortableVendorRow` 组件（`useSortable` 是 hook，不能在 per-item 渲染函数里调用）；行内容、类名、`data-testid` 逐一保留。
- 行为保持：整行 = 点击目标 + 拖拽 handle；小屏 `isDragDisabled` → `useSortable({ disabled: isSmallScreen })` 且不铺 attributes/listeners；乐观本地排序（`localOrder`）+ 后台 `onReorderVendors` 持久化不变；拖拽中样式沿用 `shadow-lg ring-1 ring-border bg-card z-50`（补 `relative` 使 z-index 生效）。
- 原 `renderClone` 拖拽克隆不再需要：dnd-kit sortable 直接对源行做 transform 位移。

### 2.2 Chat V2 会话侧栏（会话拖入分组，对齐 `FinderFileList` 范式）

语义不变：只做**跨容器移动**（会话 → 分组/未分组），不做组内排序；droppable id 契约保持 `session-group:<id>` / `session-ungrouped`。

- `SessionSidebarContent.tsx`：新增顶层 `DraggableSessionRow`（`useDraggable`，`data.sourceDroppableId` 携带源容器 id）与 `SessionDropZone`（`useDroppable`，`isOver` 高亮样式与原 `isDraggingOver` 完全一致）；`DragDropContext` → `DndContext(pointerWithin)`。
- 拖拽预览改为 `DragOverlay` 且 `createPortal` 到 `document.body`：源行拖拽中降透明度占位（`opacity: 0.4`）。这同时解决了两个旧问题——折叠容器 `overflow-hidden` 对位移行的裁剪，以及移动抽屉 transform 祖先导致 fixed 定位错位（原代码需 `resolveDragStyle` 把 `left/top` 改 `auto` 来 hack，现已整体删除）。
- `SessionItemRenderer.tsx`：`SessionDragState` 从 `{ provided, snapshot }` 改为 dnd-kit 形状 `{ setNodeRef, attributes, listeners, isDragging, style }`；两处行渲染（正常行 + 删除二次确认行）与 `SwipeableSessionRow` 的 `gestureEnabled`（拖拽中禁左滑手势）同步替换。
- `useSessionEdit.ts`：`handleDragEnd(DropResult)` → `handleDragEnd(DragEndEvent)`；源容器判断从 `source.droppableId` 改为读 `active.data.current.sourceDroppableId`，目标识别逻辑逐行等价。
- 拖拽结束仍先 `clearArchiveConfirm()` 再回调（与迁移前顺序一致）。

### 2.3 a11y / UX 对照

| 维度 | 迁移前（hello-pangea） | 迁移后（dnd-kit） |
| --- | --- | --- |
| 键盘拖放 | 行有 `tabIndex=0/role=button`，Space 抬起 | `attributes` 同样铺 `tabIndex/role/aria-roledescription/aria-describedby`，`KeyboardSensor + sortableKeyboardCoordinates` Enter/Space 抬起、方向键移动 |
| 屏读播报 | 内置英文播报 | `DndContext` 内置默认播报（与库内其余 dnd-kit 表面一致） |
| 触屏 | 长按拖动 | `TouchSensor` 长按 250ms/容差 8px（同一语义，DND-1 统一传感器） |
| 行点击 vs 拖拽 | 库内置区分 | `MouseSensor` 8px 激活距离，短按仍是点击 |
| 小屏禁拖 | `isDragDisabled` | `disabled` + 不铺 listeners（供应商行）；会话行拖拽入口不变 |

## 3. 验证

```text
npm run typecheck                     # 通过（exit 0）
npx eslint --rule 'no-restricted-imports: error' \
  --rule 'ds-components/no-native-button: warn' <7 个改动文件>
                                      # 0 error / 5 warning（均为本次未触碰的存量代码：
                                      #   原生 button ×2、裸 addEventListener ×3）
npx vitest run …SessionSidebarContent …sessionSidebarTypography \
  …SessionItemRenderer.contextMenu    # 3 files / 14 tests 全过
npx vitest run …ApisTab.vendorIcons …VendorDetailPanel.responsiveEditor
                                      # 2 files / 22 tests 全过（vendorIcons 实渲染迁移后的供应商列表）
rg "@hello-pangea/dnd" src            # 仅剩 useTouchFriendlyDndSensors.ts 一条历史语义注释，无 import
```

局限：远程 VM 未做真机拖拽手测；建议桌面端回归两条路径——设置页供应商拖拽排序（含小屏禁拖）、Chat 侧栏会话拖入分组（含移动抽屉内长按拖拽）。

## 4. 体积影响

`src/` 内 import 归零后，`@hello-pangea/dnd`（min 97.3 kB / gzip 29.4 kB）及其独占传递依赖（redux、react-redux、css-box-model、raf-schd、use-memo-one、memoize-one——`src/` 无任何直接引用）不再进入任何 chunk；主要受益者是 chat 懒加载 chunk（`lazyComponents.tsx` 原注释即标注该依赖链）。dnd-kit 已被 todo/notes/learning-hub 等共享，无新增成本。

## 5. 后续（不在本批范围）

- `package.json` 删除 `@hello-pangea/dnd` 依赖 + `npm install` 刷 lockfile + 重新生成 THIRD_PARTY 清单。本批不动：THIRD_PARTY_NOTICES/生成脚本正被并行子代理（SA-R2-05）修改，规避 R1 已知的混合提交竞态。
- 依赖删除后可顺带清理 `docs/THIRD_PARTY_LICENSES.md` 中的 Apache-2.0 行内提及。

## 6. 变更清单（本次提交仅含以下文件）

- `src/features/settings/components/VendorSidebar.tsx`：sortable 迁移。
- `src/features/chat/pages/SessionSidebarContent.tsx`：DndContext/useDraggable/useDroppable/DragOverlay 迁移。
- `src/features/chat/pages/SessionItemRenderer.tsx`：`SessionDragState` 改 dnd-kit 形状，删 `resolveDragStyle` hack。
- `src/features/chat/pages/useSessionEdit.ts`：`handleDragEnd` 改 `DragEndEvent`。
- `src/features/chat/pages/ChatV2Page.tsx`、`src/lazyComponents.tsx`、`src/hooks/useTouchFriendlyDndSensors.ts`：注释更正（各 1-2 行）。
- `docs/dev/optimization0824/progress/R2-dnd-migration.md`：本报告。
- 工作树中另有并行子代理改动（THIRD_PARTY_NOTICES、qbank-tools、vite.config、release.yml、pdfium 等），本次提交未包含。
