# 学习 OS（Workbench）20 子代理极致打磨编排

- 日期：2026-07-08
- 前置：P1–P11 已交付，模块功能完整（383 测试全绿，tsc exit 0）
- 目标：**从"正确可用"提升到 macOS 级丝滑与极致细节**。重点 = 交互手感 / 美术质感 / 前端性能，
  以及把桌面端用户可能遇到的每一个使用细节都想到并落实。
- 模式：O1–O19 完全并行优化，O20 最后接线/reconcile/性能门禁（与上一轮 P11 同构）。

---

## 0. 基线现状（优化对象，务必先读代码再动手）

已实现且质量尚可、**本轮要深化而非重写**：
- 视觉：`styles/workbench.tokens.css`（明暗两套 Liquid Glass token + 三档材质降级）、`styles/workbench.css`（契约类）
- 窗口：WindowShell（拖拽/缩放/落位）、WindowTitleBar（三键）、WindowBody（四档生命周期）
- 交互：pointerEngine（rAF 合帧）、tiling/snapZones（平铺吸附）、TileMenuPopover（九宫格）
- 导航：Dock（三分支+badge+autohide）、ExposeOverlay（俯瞰）、WindowSwitcher（Ctrl+Tab）、shortcuts
- 内核：windowStore、scheduler（预算冻结）、occlusion、snapshot、materialTier、projection、eventHub

**当前明显的体验短板（本轮要消灭）**：
1. 拖拽/缩放是纯几何跟手，无惯性、无边缘阻尼、无亚像素、无 magnetic 手感
2. Dock 无 macOS 邻近放大（magnification）、无打开弹跳、指示点无动画、无拖拽排序
3. 最小化动画是简单 scale，非 genie/吸入；开窗动画单一；无窗口关闭消散
4. 焦点切换、平铺落位、俯瞰进出的动画曲线未精细调校（缺 spring 感）
5. 缺触控板手势（双指、捏合）、缺拖放文件到桌面/窗口、光标形态不随交互变化
6. 无障碍（焦点环、aria、屏幕阅读器、键盘可达）未系统化
7. 应用窗口内加载态粗糙（无骨架屏）、缩放时内容重排
8. 性能：will-change/contain/layer promotion 未精细管理；遮挡计算未增量化

---

## 1. 冲突规避铁律（所有代理必守，违者 O20 回滚）

### 1.1 文件独占（一个文件只有一个主责代理可写）

见 §3 归属表。**只能改自己名下文件；他人文件只读**。

### 1.2 CSS 完全隔离（最关键）

- `styles/workbench.css` **全员冻结，禁止修改**（它是契约类基线）。
- `styles/workbench.tokens.css` **仅 O1 可写**（token 是全局单点，只追加不删旧）。
- 每个组件代理若要加/改视觉，**新建组件同目录的 `<Component>.css`**，在组件 tsx 顶部 `import './<Component>.css'`。
- 新样式类**必须带独占前缀**避免撞名：用 `wb-<域>-<细节>` 形式，例如
  `wb-dock-mag`（O5）、`wb-title-ripple`（O3）、`wb-shell-drag`（O2）。
- **不得重定义** workbench.css 已有的契约类（`wb-window`/`wb-dock`/`wb-titlebar` 等）；
  需要覆盖时用更高特异性选择器（如 `.wb-window.wb-shell-dragging`）并在进度文件声明，交 O20 reconcile。
- 共享动效基建（缓动曲线、spring keyframes、通用 keyframes 库）**仅 O1** 建 `styles/motion.css`，
  由 tokens.css `@import`；其他代理引用 O1 暴露的 CSS 变量/keyframes 名，不自造重复曲线。

### 1.3 契约只读

- `core/types.ts` **仅 O11 可追加**（不可改已有导出签名）；其他代理需要新类型在自己文件内定义局部类型。
- `core/workbenchBus.ts`、`appRegistry.ts`、`registerAll.ts`、`WorkbenchEventBridge.tsx`、
  `legacyNavigationMap.ts`、`eventHub.ts` **全员冻结**（逻辑接线层，本轮不优化）。
- 不改任何 legacy 文件（`src/features/chat/**`、`learning-hub/**` 等），应用代理只改 `workbench/apps/**` 适配层。

### 1.4 不破坏现有测试

- 优化后必须保持已有 383 测试全绿；改了结构导致测试失败的，**同步更新该测试**（测试文件随主文件归属）。
- 新增行为尽量补测试。

### 1.5 通用纪律

- 所有动画**仅 `transform` / `opacity`**（阴影档切换的 box-shadow transition 属状态过渡例外）。
- 拖拽/缩放/放大等高频交互**直写 DOM 不进 React state**，rAF 合帧。
- 尊重 `prefers-reduced-motion` 与 minimal 材质档（动效可降级为 0）。
- 不启动 dev server / tauri dev；不 git commit。
- 进度实时写 `docs/dev/workbench-progress/O{N}.md`（开始建 checklist，完成即勾，结尾四节：
  已完成 / 视觉与交互决策（供人工复核）/ 需 O20 reconcile 事项 / 新增 i18n keys）。

### 1.6 自验

- `npx tsc --noEmit -p tsconfig.json` 无自己引入的错误；
- `npx vitest run <自己涉及的测试>` 全绿。

---

## 2. 二十子代理分工（每个都要做"足够多且内聚"的深度优化）

> 每个代理是一个子系统的**全栈精修师**（交互手感 + 美术质感 + 性能，一并负责）。
> 下列"macOS 参考"是必须达到的细节标准，不是可选项。

### O1 — 设计语言 / 材质 / 动效基建（其他视觉代理的地基）
**文件**：`styles/workbench.tokens.css`、`core/materialTier.ts`、新建 `styles/motion.css`
- 精修玻璃材质：多层（底色 + blur + saturate + 内缘高光 + 微噪点/grain 可选 + 边缘光折射），
  对标 Tahoe Liquid Glass 的"厚度感"；明暗两套都要重新调校对比度与通透度。
- 建立 **spring/缓动曲线库**（`motion.css`）：定义 macOS 级标准曲线——
  标准弹出、快速淡入、genie、magnification、overshoot 回弹等，全部导出为 CSS 变量 + 命名 keyframes，
  供 O2–O9 引用（统一手感语言，禁止各自造曲线）。
- 补足 token：焦点/悬停/按压三态的过渡时长与曲线、z-index 统一刻度表（消除各代理硬编码层级）、
  高光/阴影随主题与"焦点强度"的分档。
- materialTier：增加平滑过渡（切档时短暂淡入而非硬切）、修正各档在 WebView2/WebKitGTK 的差异。
**DoD**：motion.css 曲线库可被引用；三档材质切换有过渡不闪；z-index 刻度表文档化供全员。

### O2 — 窗口拖拽 / 缩放引擎（手感核心）
**文件**：`core/pointerEngine.ts`、`components/window-shell/useWindowPointer.ts`、
`components/WindowShell.tsx`、`components/WindowResizeHandles.tsx`、新建 `components/WindowShell.css`、相关测试
- 拖拽手感：亚像素跟手（transform 用 translate3d + subpixel）、**释放惯性/动量**（可选轻微滑行）、
  拖到屏幕边缘的**阻尼**、多显示器/桌面边界回弹。
- 缩放：八向缩放锚点精确（对角保持对角固定）、缩放时保持内容不跳动、比例锁定修饰键（Shift 等比）、
  最小/最大尺寸软阻尼。
- magnetic 吸附手感：接近吸附区时预览渐显 + 轻微磁吸位移（交 O4 的 snapZones 命中，O2 负责手感呈现）。
- 拖拽视觉：拖拽中窗口轻微抬升（阴影加深 + scale 1.002）、内容层 `pointer-events:none` 且降频。
- 性能：拖拽全程 0 React 重渲染（保持 P2 的 renderCount===1 不变量）、will-change 精确开关（拖前加、拖后移除）。
**DoD**：拖拽/缩放 60fps；惯性与阻尼可感；八向锚点无跳动；现有 pointerEngine/useWindowPointer 测试全绿。

### O3 — 标题栏与三键微交互
**文件**：`components/WindowTitleBar.tsx`、新建 `components/WindowTitleBar.css`、相关测试
- 三键：hover 时符号浮现（已有）再加**逐键悬停微光**、按压凹陷、close/min/zoom 各自 hover 色微调，
  对标 macOS 三键的精确尺寸/间距/符号。
- 标题栏：双击 maximize 的**涟漪/反馈**、长标题渐隐省略而非硬截断、拖拽区光标 grab/grabbing、
  焦点态与非焦点态标题色/权重过渡。
- 可选：标题栏右侧留 App 自定义操作位（不强制）。
**DoD**：三键像素级对标 macOS；双击/悬停/按压反馈细腻；测试全绿。

### O4 — 平铺 / 吸附 / 平铺菜单
**文件**：`core/tiling.ts`、`core/snapZones.ts`、`components/SnapPreview.tsx`、
`components/window-shell/useTilingDivider.ts`、`components/TileMenuPopover.tsx`、
新建 `components/SnapPreview.css`、`components/TileMenuPopover.css`、相关测试
- 吸附预览：更精致的轮廓（主题色描边 + 玻璃填充 + 圆角随目标）、命中不同区时**平滑变形**（morph 而非闪切）、
  多层级区（半屏/四分屏/maximize）优先级清晰、离开区淡出。
- 平铺落位：落位动画用 O1 spring 曲线（当前是直接 setDisplayMode，无过渡）。
- 中缝：拖动阻尼 + 双击复位 50/50 + hover 高亮加宽命中区 + 光标 col-resize。
- 平铺菜单：九宫格微缩桌面示意更真实、hover 项高亮动画、键盘导航焦点环、弹出/收起动画。
**DoD**：吸附预览 morph 平滑；落位有 spring 感；中缝跟手且可双击复位；几何测试全绿。

### O5 — Dock 放大与动效（macOS Dock 灵魂）
**文件**：`components/Dock.tsx`、`components/DockItem.tsx`、新建 `components/Dock.css`、相关测试
- **邻近放大（magnification）**：鼠标在 Dock 上移动时，图标按距离指针的远近连续放大（高斯衰减），
  相邻图标平滑联动——这是 macOS Dock 最标志性的交互，必须做到丝滑（rAF + transform，不进 state）。
- 打开应用：图标**弹跳**动画（launch bounce）；运行指示点淡入 + 呼吸。
- 图标：真实图标质感（当前多为占位），hover tooltip（应用名，玻璃小气泡带箭头）。
- Dock 拖拽排序固定项（可选，若做需与 DockPinnedStore 协作，O6 拥有该 store——通过其暴露的 setter）。
- autohide：滑入滑出用 O1 曲线，无抖动，展开有轻微 overshoot。
**DoD**：magnification 连续丝滑 60fps；launch bounce 自然；tooltip 精致；现有 Dock 测试全绿。

### O6 — Dock 弹层 / 右键菜单 / 固定态
**文件**：`components/DockWindowList.tsx`、`components/DockContextMenu.tsx`、`components/DockPinnedStore.tsx`、
新建对应 `.css`、相关测试
- 多实例弹层：窗口**实时缩略预览**（CSS transform 缩放对应窗口 DOM 或占位卡）、玻璃气泡带指向箭头、
  弹出动画从 Dock 图标升起、hover 项高亮、键盘可达。
- 右键菜单：玻璃材质、分组、图标、危险项（关闭全部）配色、进出动画。
- 固定态：拖拽排序（若 O5 不做则 O6 做）、固定/取消固定的加入/移除动画。
**DoD**：弹层预览可用且精致；菜单动画细腻；固定排序可拖拽；测试全绿。

### O7 — 俯瞰（Exposé / Mission Control）
**文件**：`components/ExposeOverlay.tsx`、新建 `components/ExposeOverlay.css`、相关测试
- 进入/退出：所有窗口从原位**平滑飞入网格**（FLIP 动画：记录原 rect → 计算目标 → transform 过渡），
  退出时飞回原位——当前是直接 transform 缩放，要升级为 FLIP 丝滑过渡。
- 网格：更优布局算法（保持宽高比、间距均衡、行末居中）、hover 窗口高亮放大 + 标题浮现、
  非 hover 轻微暗化、点击目标窗口放大飞回聚焦。
- 键盘：方向键在网格中导航 + 高亮、Enter 选中、Esc 飞回。
- 10+ 窗仍 60fps。
**DoD**：FLIP 进出丝滑；网格美观；键盘导航完整；帧率达标；现有 expose 测试全绿。

### O8 — 窗口切换器（Ctrl+Tab）
**文件**：`components/WindowSwitcher.tsx`、新建 `.css`、相关测试
- 中央玻璃条：图标 + 标题、选中项放大高亮 + 玻璃焦点框滑动过渡（选中框在图标间平滑移动）、
  快速连按流畅、松开聚焦有反馈、可选窗口内容缩略。
- 进出动画、大量窗口时横向滚动/换行。
**DoD**：选中框平滑滑动；连按流畅；测试全绿。

### O9 — 窗口生命周期动画 / frozen 唤醒体验
**文件**：`components/WindowBody.tsx`、`components/WindowErrorBoundary.tsx`、
新建 `hooks/useWindowLifecycleAnim.ts`、新建 `.css`、相关测试
- 开窗：从 launch 来源（Dock 图标 / 点击位置）**放大展开**（配合 O1 曲线，origin 可注入）。
- 关窗：消散动画（scale down + fade + 轻微模糊）后再卸载壳。
- 最小化：**genie / 吸入 Dock** 效果（向 Dock 图标坐标收敛的曲线变形），需接收 Dock 图标坐标
  （从 DockPinnedStore/Dock 暴露的坐标 provider，或 O20 接线时注入 CSS 变量）。
- frozen 唤醒：优雅的休眠占位卡（玻璃 + 应用图标 + "点击唤醒"）+ 唤醒时淡入重建，非生硬 remount。
- ErrorBoundary：精致的崩溃恢复卡（图标 + 错误摘要 + 重载按钮），与整体设计语言一致。
**DoD**：开/关/最小化动画连贯有生命感；frozen 占位与唤醒平滑；测试全绿。

### O10 — 调度器 / 遮挡 / 性能监控
**文件**：`core/scheduler.ts`、`core/occlusion.ts`、新建 `core/perfMonitor.ts`、相关测试
- 遮挡计算增量化（仅重算受影响窗口，避免每次 O(n²) 全量）、rAF 防抖合并。
- 生命周期降频策略精细化：visible 档的降频粒度分级（完全可见 vs 部分可见）、
  滚动/流式时的动态降频、焦点切换时的过渡（避免骤停骤起）。
- `perfMonitor.ts`：采集帧耗时、长任务、掉帧、各生命周期窗口数、内存预算占用，
  暴露订阅接口供 O15 诊断 HUD 消费；开发期可开关。
- 预算冻结的平滑：冻结前给"即将冻结"的宽限，唤醒预取。
**DoD**：遮挡增量正确（不错杀）；perfMonitor 数据可订阅；scheduler 测试全绿。

### O11 — 状态机 / 快照体验 / 契约扩展
**文件**：`core/windowStore.ts`、`core/snapshot.ts`、`core/types.ts`（仅追加）、相关测试
- 焦点切换的**焦点栈平滑**（避免 zIndex 跳变导致的视觉闪烁，必要时用过渡 zIndex 分配策略）。
- 窗口进出场的状态标记（供 O9 动画消费的瞬态生命周期字段，若需扩 types 只追加可选字段）。
- 快照：分层保存（布局高频防抖 + 元数据低频）、恢复时的逐帧唤醒调度优化、快照版本迁移健壮性、
  多显示器/分辨率变化时的窗口位置自适应恢复（钳回可视区、比例缩放）。
- cascade 落位算法优化（避免新窗完全重叠、感知已有窗分布）。
**DoD**：焦点切换无闪烁；快照往返全等且分辨率变化自适应；windowStore/snapshot 测试全绿。

### O12 — 键盘 / 快捷键体验
**文件**：`core/shortcuts.ts`、`hooks/useWorkbenchShortcuts.ts`、
新建 `components/ShortcutCheatsheet.tsx` + `.css`、相关测试
- 补齐快捷键：窗口循环、发送到显示器边、平铺快捷组合、快速切换应用、关闭所有等，对标 macOS/主流 WM。
- **快捷键速查表**（`?` 或长按触发的玻璃浮层，分组展示所有快捷键 + 可视化键位）。
- 快捷键触发的**视觉反馈**（如平铺快捷键触发时短暂高亮目标区）。
- 输入焦点守卫更严谨（IME 组合中、可编辑区、shadow DOM）。
**DoD**：速查表美观完整；快捷键无冲突；守卫严谨；测试全绿。

### O13 — 桌面画布 / 桌面手势 / 右键菜单
**文件**：`components/WorkbenchDesktop.tsx`、新建 `components/DesktopContextMenu.tsx` + `.css`
- 桌面空白区**右键菜单**（整理窗口、平铺全部、切换壁纸、材质档、新建等）。
- 桌面手势：双击桌面空白最小化所有窗（show desktop）、可选框选。
- 多显示器/窗口尺寸变化的 ResizeObserver 处理更平滑（防抖 + 窗口位置自适应，与 O11 协作）。
- **注意**：WorkbenchDesktop 是总装文件，只做增量增强，不破坏 O20 接线预期（启动链路/订阅/卸载清理不动）。
**DoD**：桌面右键菜单可用；show desktop 手势；壁纸保持静止；不破坏总装逻辑。

### O14 — 壁纸系统 / 空桌面
**文件**：`components/WallpaperLayer.tsx`、`components/EmptyDesktop.tsx`、新建 `.css`
- 更多精调壁纸预设（≥6 套，明暗各调）、可选**动态/渐变流动**壁纸（低成本 CSS 动画，reduced-motion 关）、
  自定义图片的模糊/暗角/亮度适配层。
- 壁纸切换过渡（淡入淡出）。
- 空桌面引导升级：更精致的插画/图标组合、引导动作卡片（打开资源库/新建 Chat 等常用入口）、
  首次使用的轻量 onboarding 提示。
**DoD**：壁纸预设丰富且美；切换有过渡；空桌面引导精致且可操作。

### O15 — 诊断 HUD / 性能可视化
**文件**：`components/WorkbenchDevPanel.tsx`、新建 `.css`
- 消费 O10 的 perfMonitor：实时帧耗时曲线图、掉帧标记、生命周期分布饼/条、内存预算占用条（超限变红）、
  焦点栈、快照保存时间、活动窗口列表（lifecycle 着色）。
- 玻璃 HUD 可拖动、可折叠、不遮挡操作、开发期开关。
**DoD**：HUD 数据实时准确、美观、不干扰；可拖动折叠。

### O16 — Chat 窗口内体验
**文件**：`apps/chat/ChatAppWindow.tsx`、`apps/chat/ChatSessionSurface.tsx`、`apps/chat/register.ts`、
`apps/chat/newSession.ts`、新建 `.css` / 骨架组件（均在 `apps/chat/**` 内），相关测试
- 加载态：会话加载**骨架屏**（消息气泡骨架）而非空白/转圈。
- 窗口缩放时消息流不重排抖动（稳定滚动锚点）、非焦点窗流式降频的视觉平滑（不骤停）。
- 窗口尺寸自适应（窄窗紧凑布局）、多 Chat 窗焦点/输入隔离的视觉确认。
- 不改 legacy chat 组件，只在适配层做加载/降频/尺寸/骨架。
**DoD**：骨架屏顺滑；缩放不抖；窄窗可用；不动 legacy；测试全绿。

### O17 — 资源窗口内体验（笔记/PDF/思维导图/文件/图片）
**文件**：`apps/content/**`、`apps/files/**`、`apps/mindmap/**`（适配层）、新建骨架/加载组件 + `.css`，相关测试
- 各类型资源**骨架屏/加载态**（PDF 页骨架、笔记文本骨架、图片模糊占位渐显）。
- 缩放/平铺时内容平滑（PDF 重排节流、编辑器不丢滚动位置）。
- files 浏览器：列表/网格切换动画、hover 预览、拖拽资源到桌面开窗的反馈（与 O19 拖放协作）。
- 错误/空态精致化。不改 legacy 视图，只在适配层。
**DoD**：各类型加载态顺滑；缩放不跳；files 交互精致；测试全绿。

### O18 — 系统 / 沙箱窗口体验 + 投射呈现
**文件**：`apps/system/**`、`apps/sandbox/**`（适配层）、新建 `.css`，相关测试
- settings/todo/skills/templates/taskDashboard 窗口化的**尺寸自适应**（去除 legacy 全屏假设的空白、
  窄窗布局）、加载态、窗口内滚动。
- 投射窗（番茄钟/制卡任务）的**呈现打磨**：番茄钟窗精致计时视觉、任务进行中的窗口/角标呈现。
- sandbox 工作台窗口化的边界处理。不改 legacy 页面，只在适配层。
**DoD**：系统应用窄窗无空白；投射窗精致；测试全绿。

### O19 — 输入 / 无障碍 / 光标 / 拖放（横切细节）
**文件**：新建 `hooks/useWorkbenchGestures.ts`、`hooks/useDesktopDrop.ts`、`hooks/useWorkbenchA11y.ts`、
新建 `styles/a11y-cursor.css`（全局光标/焦点环，由 tokens.css 或各组件自愿引用），
产出 `docs/dev/workbench-a11y-checklist.md`（aria 接入规范，交各组件代理/O20 落实）
- 触控板/鼠标手势：捏合缩放窗口（可选）、双指滑动、滚轮在 Dock 上切换放大等。
- **拖放**：拖文件到桌面/窗口的落点高亮 + 反馈（与 O13/O17 协作，O19 出通用 hook）。
- 光标形态：拖拽 grab/grabbing、缩放各向 resize、中缝 col/row-resize、不可交互 not-allowed——全局统一。
- 无障碍：焦点环统一样式、键盘可达性 hook、窗口 role/aria-label 规范、屏幕阅读器提示、
  高对比模式适配。产出规范清单供各代理落实（O19 不改他人组件，只提供 hook + CSS + 规范）。
**DoD**：手势/拖放 hook 可用且有 demo 测试；光标全局一致；a11y 清单完整可执行。

### O20 — 集成 / reconcile / 性能门禁 / QA（最后启动）
**文件**：全仓（reconcile 权限）、`docs/dev/learning-os-acceptance.md`、新建性能基准脚本/测试
- reconcile 各代理的 CSS 叠加与 z-index（依 O1 刻度表统一）、动效时长一致性、避免视觉打架。
- 消化各 O 进度文件的"需 O20 reconcile 事项"与 a11y 清单落实。
- 落实 O19 的 aria 规范到各组件（此时有全仓写权）。
- 跑全量 tsc + vitest 全绿；补性能基准；执行 acceptance 里的视觉/交互项并回写。
- 统一 i18n keys 汇总补齐。
**DoD**：全仓绿；无 CSS/z-index 冲突；性能基准达标；acceptance 视觉交互项复核回写。

---

## 3. 文件归属表（写权唯一）

| 文件/目录 | 主责 |
|---|---|
| `styles/workbench.tokens.css`、`core/materialTier.ts`、新建 `styles/motion.css` | O1 |
| `core/pointerEngine.ts`、`window-shell/useWindowPointer.ts`、`WindowShell.tsx`、`WindowResizeHandles.tsx`、新建 `WindowShell.css` | O2 |
| `WindowTitleBar.tsx` + 新建 `WindowTitleBar.css` | O3 |
| `core/tiling.ts`、`core/snapZones.ts`、`SnapPreview.tsx`、`useTilingDivider.ts`、`TileMenuPopover.tsx` + 新建 css | O4 |
| `Dock.tsx`、`DockItem.tsx` + 新建 `Dock.css` | O5 |
| `DockWindowList.tsx`、`DockContextMenu.tsx`、`DockPinnedStore.tsx` + 新建 css | O6 |
| `ExposeOverlay.tsx` + 新建 css | O7 |
| `WindowSwitcher.tsx` + 新建 css | O8 |
| `WindowBody.tsx`、`WindowErrorBoundary.tsx` + 新建 `hooks/useWindowLifecycleAnim.ts` + css | O9 |
| `core/scheduler.ts`、`core/occlusion.ts` + 新建 `core/perfMonitor.ts` | O10 |
| `core/windowStore.ts`、`core/snapshot.ts`、`core/types.ts`(仅追加) | O11 |
| `core/shortcuts.ts`、`hooks/useWorkbenchShortcuts.ts` + 新建 `ShortcutCheatsheet.tsx` + css | O12 |
| `WorkbenchDesktop.tsx` + 新建 `DesktopContextMenu.tsx` + css | O13 |
| `WallpaperLayer.tsx`、`EmptyDesktop.tsx` + 新建 css | O14 |
| `WorkbenchDevPanel.tsx` + 新建 css | O15 |
| `apps/chat/**` | O16 |
| `apps/content/**`、`apps/files/**`、`apps/mindmap/**` | O17 |
| `apps/system/**`、`apps/sandbox/**` | O18 |
| 新建 `hooks/useWorkbenchGestures.ts`、`useDesktopDrop.ts`、`useWorkbenchA11y.ts`、`styles/a11y-cursor.css`、`docs/dev/workbench-a11y-checklist.md` | O19 |
| 全仓 reconcile、`acceptance.md`、性能基准 | O20（最后） |

**全员冻结**：`workbench.css`、`workbenchBus.ts`、`appRegistry.ts`、`registerAll.ts`、`WorkbenchEventBridge.tsx`、
`eventHub.ts`、`legacyNavigationMap.ts`、`projection.ts`、`index.ts`（如需追加导出交 O20）、全部 legacy 文件。

---

## 4. 协作接口约定

- **Dock 图标坐标**（O9 genie 最小化、O5 launch bounce 需要）：O5 在 Dock 渲染时把每个 typeId 的图标屏幕坐标
  写入一个轻量 provider（O5 新建 `components/dockGeometry.ts`，导出 get/subscribe），O9 消费；O20 兜底接线。
- **spring/曲线**：全部来自 O1 的 `motion.css` CSS 变量/keyframes；引用名约定见 O1 进度文件。
- **z-index**：一律使用 O1 tokens 的 z 刻度变量，禁止硬编码；O20 统一校验。
- **perfMonitor**：O10 暴露订阅接口，O15 消费。
- **拖放/手势 hook**：O19 暴露，O13/O16/O17 消费。
- **a11y 规范**：O19 出清单，各代理尽量自行落实自己组件的 aria；未落实项 O20 兜底。

---

## 5. 启动顺序

1. **O1 优先**（其他视觉代理依赖它的 motion.css / z 刻度 / 材质 token）——但为最大并行，O2–O19
   可先按 O1 进度文件预告的曲线命名/变量名编码，O1 尽早落 motion.css。
2. O1–O19 全部并行启动（19 个）。
3. O20 待 O1–O19 全部完成后启动（reconcile + 门禁 + 验收）。

---

*本文档为本轮优化的唯一编排真相源；进度见 `docs/dev/workbench-progress/O{N}.md`。*
