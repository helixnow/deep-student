# 0824 Wave2-B 第 4 轮 — EPUB/教材（返回键守卫复核 + 教材进度残项复核)

- 角色：实现员-EPUB/教材（第 4 轮），独占可写 `EpubPreview.tsx` 与 `TextbookPdfViewer.tsx`（或教材进度小残项）
- 未触碰：EnhancedPdfViewer、finder 分桶、移动 chrome、Exam 判分；本轮为纯复核，**零代码改动**

## 1. EpubPreview 返回键守卫复核 — 已正确，无需补洞

复核项：隐藏保活 tab 不得注册 Android back。

`EpubPreview.tsx` 第 150-156 行的注册 effect 守卫链完整：

```150:156:src/features/learning-hub/apps/views/EpubPreview.tsx
  useEffect(() => {
    if (!isActive || !isNarrow || !sidebarOpen) return;
    return registerBackHandler(() => {
      setSidebarOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isActive, isNarrow, sidebarOpen]);
```

逐条确认：

| 检查点 | 结论 |
|--------|------|
| 三重门控 `isActive && isNarrow && sidebarOpen` | 隐藏 tab（`isActive=false`）不注册；桌面宽度不注册；侧栏关闭不注册 |
| 失活语义 | 仅注销 handler（effect cleanup），不改 `sidebarOpen` —— 隐藏 tab 不关侧栏，重新激活时若侧栏仍开会按 deps 重新注册，行为对照 NoteContentView |
| `isActive` 供给链 | 保活宿主 `TabPanelContainer` 传 `isActive={visible}`（第 99 行）→ `UnifiedAppPanel` memo 进 `commonProps` → `ContentViewProps.isActive` → 两个 EPUB 宿主均显式透传（`FileContentView` 第 775 行、`TextbookContentView` 第 778 行） |
| `isActive` 缺省 | `EpubPreview` 默认 `true`，仅影响不传该 prop 的非保活宿主（quickLook / ChatV2Page 面板均为单实例常活跃，显式传 `isActive`），无隐藏保活路径漏进默认值 |
| 组件内其他 back 注册点 | 无。设置浮层走 `Popover` 组件自带的 back 处理；`epub-preview-open-search` 只在自身 root 上监听，不涉及 back 协调器 |

结论：守卫已按第 3 轮约定实现且供给链闭合，本轮不改代码。

## 2. TextbookPdfViewer 跨文档串页 — 已修，注释复核通过

第 92-96 行的去重基线重置已在位：

```92:96:src/features/pdf/components/TextbookPdfViewer.tsx
  // 同一组件实例可切换资源；页码去重基线不能跨文档沿用，否则新文档
  // 第一次跳到“恰好等于旧文档末页”的页码时会被误判为重复而不落进度。
  useEffect(() => {
    lastReportedPageRef.current = null;
  }, [resourcePath, filePath]);
```

复核确认：

- 重置键 `[resourcePath, filePath]` 同时覆盖 file/blob 路线与 pdfstream 路线的资源切换；注释准确描述了误判场景（新文档首页码撞旧文档末页码时被去重吞掉），无需修改。
- 上报路径 `handleViewerPageChange`（第 218-228 行）：去重后直通 `onProgressChange`，防抖统一收敛在 previewPersistence 层（1s + dispose flush），无双重防抖，与注释一致。
- 该组件自身不注册 Android back（无 `registerBackHandler` 引用），返回键复核项对它不适用。教材 PDF 路径的 back 处理在 EnhancedPdfViewer 内部，其 handler 自带运行时可见性守卫（`isConnected` / `getClientRects` / computed visibility，第 1263-1269 行附近），保活隐藏实例返回 `false` 不吞键 —— 该文件本轮禁改，仅确认状态正常，无需 wrapper 层补偿。

## 3. 验证说明

本轮禁用 npm/vitest，未运行类型检查/测试；两个独占文件零改动，结论均来自人工复读与调用链核对（TabPanelContainer → UnifiedAppPanel → FileContentView/TextbookContentView → EpubPreview 的 `isActive` 链、EnhancedPdfViewer back handler 的可见性守卫）。
