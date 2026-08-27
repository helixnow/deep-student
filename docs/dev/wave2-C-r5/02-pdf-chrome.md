# 0824 Wave2-C R5 · 落地 02 — PDF chrome 返回键守卫（台账 03 V1）

- 角色：chrome 修复-PDF/EPUB（第 5 轮，claude-fable-5-thinking-high）
- 基线：`cf8eb9e8`（docs: record Wave2-C R4 attachment and a11y landing）
- 依据：`docs/dev/wave2-C-r1/03-pdf-epub.md` V1（PdfSelectionActions 返回键 handler 缺可见性守卫）
- 约束遵守：未执行任何测试/构建；未 git commit；未触碰 PDF 解析/渲染算法、散点 44px（V2）、WebDAV/S3/FTP

---

## 一、问题回顾（V1）

`PdfSelectionActions.tsx` 的返回键 handler 在 `panelOpen` 时注册并无条件 `return true`。
保活但不可见的 PDF 实例（ViewLayerRenderer keep-alive 隐藏层）若残留打开的解释/翻译面板，
会吞掉当前活跃页面的系统返回键——违反规范 5「可回退」。同一浮层体系里
`EnhancedPdfViewer.tsx:1260-1266` 已手写 isConnected/getClientRects/computed-visibility 三重守卫，
`EpubPreview.tsx:150-156` 用 `isActive` prop 解决同一问题；V1 明确要求不要在第三处再手抄，
应在协调器层提供共享注册函数。

## 二、改动清单

```
 src/app/navigation/androidBackCoordinator.ts       | 37 ++++++++++++++++++++++
 src/features/pdf/components/EnhancedPdfViewer.tsx  | 13 +++-----
 src/features/pdf/components/PdfSelectionActions.tsx | 10 +++---
 .../__tests__/pdfSelectionToolbar.source.test.ts   | 18 +++++++++--
 4 files changed, 63 insertions(+), 15 deletions(-)
```

### 1. `src/app/navigation/androidBackCoordinator.ts`（纯加法）
- 新增 `BackHandlerElementRef` 接口（`{ readonly current: Element | null }`，与 React ref 结构兼容但框架无关）。
- 新增 `isElementVisibleForBack(el)`：三重检查原样抽取自 EnhancedPdfViewer 手写版——
  `isConnected` → `getClientRects().length === 0` → `getComputedStyle(el).visibility === 'hidden'`
  （注释保留了「visibility:hidden 不清除布局盒，必须单独查 computed visibility」的关键说明）。
- 新增 `registerVisibilityGuardedBackHandler(elementRef, handler, priority = BACK_PRIORITY.overlay)`：
  内部就是 `registerBackHandler`，只在外面包一层「宿主元素不可见时返回 false 让行」。
  **未改动**排序算法（`handleAndroidBack` 的 priority/seq 降序比较）、栈语义、Radix 兜底探测、
  既有导出（`registerBackHandler` / `BACK_PRIORITY` / `handleAndroidBack` 等全部原样），
  因此 `androidBackCoordinator.menuThenPanel.test.ts` / `androidBackCoordinator.order.source.test.ts`
  钉住的契约不受影响（静态核对，未运行）。

### 2. `src/features/pdf/components/PdfSelectionActions.tsx`（V1 修复本体）
- import 从 `registerBackHandler` 换为 `registerVisibilityGuardedBackHandler`。
- `panelOpen` effect 改为 `registerVisibilityGuardedBackHandler(containerRef, () => { closePanel(); return true; }, BACK_PRIORITY.overlay)`，
  直接复用宿主传入的 `containerRef`（`.ds-pdf-viewer` 根元素）——正是 V1 建议的接法。
- effect 依赖数组补 `containerRef`（ref 对象身份稳定，行为无变化，满足 exhaustive-deps）。
- 修复后语义：隐藏保活实例的面板 handler 仍在栈上，但轮到它时守卫返回 false 让行，
  事件继续下发给活跃页面的 handler / Radix 兜底 / 导航 fallback；可见实例行为与改前完全一致。

### 3. `src/features/pdf/components/EnhancedPdfViewer.tsx`（可选项，已做，净 -5 行）
- 浮层关闭链（划词翻译→高亮菜单→活跃高亮→更多菜单→缩放菜单→侧栏→搜索栏）的注册
  从 `registerBackHandler` + 4 行手写守卫，改为 `registerVisibilityGuardedBackHandler(containerRef, …)`。
- 关闭顺序、`hasOverlay` 注册条件、`BACK_PRIORITY.overlay`、依赖数组均未动；守卫检查逻辑
  与原手写版逐条等价（同一 `containerRef`，同三项检查，同 return false 让行）。
- 自此全仓不再有手抄的三重守卫，机制唯一来源是协调器。

### 4. `src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts`
- 原断言（L104-107）只钉「registerBackHandler + BACK_PRIORITY.overlay 存在」——事实上钉住了
  V1 缺陷现状。按任务要求升级为「守卫存在」：
  - 钉 import：`registerVisibilityGuardedBackHandler, BACK_PRIORITY` 来自 `@/app/navigation/androidBackCoordinator`；
  - 钉调用形态：`registerVisibilityGuardedBackHandler(containerRef,` + `BACK_PRIORITY.overlay`；
  - 负向断言 `not.toMatch(/(?<!Guarded)registerBackHandler\(/)` 禁止退回无守卫裸注册；
  - 新增一条：EnhancedPdfViewer 浮层链同样走共享守卫注册、且不再有裸 `registerBackHandler(`。

## 三、边界确认

- **未改**排序算法/优先级数值/栈语义（新函数是 registerBackHandler 的薄包装，纯加法）。
- **未改** PDF 解析/渲染/选区算法（`pdfPageNavigation.ts`、pdf.js 相关零触碰）。
- **未加**任何散点 44px 手贴（V2 属债务收敛轮，本轮不涉）。
- **未触** WebDAV/S3/FTP、EPUB 侧文件（EpubPreview 的 isActive 守卫本就合规，保持原样）。
- V3（断点自造）、V4（132 魔数）按台账建议留给后续轮，本轮未动。

## 四、静态自查（未运行测试，逐条人工核对）

1. 类型：`useRef<HTMLDivElement>(null)`（viewer）与 `React.RefObject<HTMLElement | null>`（actions prop）
   的 `.current` 均可赋给 `readonly current: Element | null`，`BackHandlerElementRef` 接口兼容。
2. 全仓 `src/features/pdf` 下已无裸 `registerBackHandler(` 调用（grep 核对），与新负向断言一致。
3. 其他引用 `registerBackHandler` 的测试（InputBarUI / AppMenu / 协调器自身 / UserAgreementDialog mock）
   针对的都是未改动文件，且协调器既有导出签名原样保留。
4. `pdfMobilePanelTabs.source.test.ts` 只钉 panel tabs 与 44px 内联串，与本次改动区域无交集。

## 五、遗留（供后续轮）

- 台账 03「覆盖缺口 1」：EnhancedPdfViewer 浮层**关闭顺序**仍无契约测试（本轮只钉了守卫存在）。
- 覆盖缺口 4：EpubPreview 的 `isActive` 守卫无契约；若愿意，可让 FileContentView 一并迁到
  `registerVisibilityGuardedBackHandler`（其守卫是 prop 驱动而非 DOM 可见性，语义略不同，需单独评估）。
- V2/V3/V4 原样留存。
