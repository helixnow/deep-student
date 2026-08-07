# 学习 OS（Workbench）验收清单（30 条）

- 日期：2026-07-08（P10 起草；P11 于同日执行并回写结果）
- 关联：`docs/dev/learning-os-workbench-design.md`、`docs/dev/learning-os-10-agent-parallel-prompts.md`
- 用法：P11 接线完成后逐条执行；每条填写 `结果`（✅ 通过 / ❌ 失败+缺陷描述 / ⏭ 暂缓+原因）。
- 前置：桌面端 dev 构建；除特别说明外，验收在「设置 → 常规 → 学习桌面（实验）」开启总开关后进行。
- **P11 执行方式说明**：按任务约束不启动 dev server / tauri dev，本轮以
  **代码级验证**（静态审查 + 383 条 vitest 全绿 + P11 总装冒烟测试
  `tests/vitest/workbench/p11-workbench-desktop.test.tsx`）执行。
  `✅（代码级）` = 行为已由自动化测试/静态证据确认；`⏭ 需人工` = 接线已就绪且
  相关逻辑有单测覆盖，但帧率/动画观感/真实后端链路必须在运行中的应用里复核。
- **O20 收尾轮（2026-07-09）**：打磨轮补齐 Dock 弹层 / Exposé / TileMenu / 生命周期动画 /
  资源窗体验后，对「因功能缺失而暂缓、现已代码具备」的项追加注记
  「代码级已具备，待人工运行验证（2026-07-09 收尾轮）」；**不虚标 ✅**。
  纯帧率/视觉/真实后端项保持 ⏭。详见 `docs/dev/workbench-progress/O20.md`。

## A. 开关与回退（1–4）

- [x] **1. 总开关默认关闭 & 零回归**
  - 操作：全新配置启动应用，不动任何设置，遍历主导航（Chat、学习中心、笔记、设置等）。
  - 期望：`desktop.workbenchMode` 默认 false；所有现有页面行为与开关引入前完全一致；workbench lazy chunk 未被网络加载。
  - 结果：✅（代码级）`get_setting` 空值 → false；App.tsx 静态导入仅 `core/workbenchBus` +
    `core/legacyNavigationMap` 两个轻模块，桌面本体为 `React.lazy` 独立 chunk 仅在开关开启时加载；
    legacy 视图层仅被 `workbenchActive===false` 分支的 Fragment 包裹，JSX 未改动。全仓 tsc 0 错误。
    主导航人工遍历建议随下一次 dev 运行抽查。
- [x] **2. 开关开启即时生效**
  - 操作：设置 → 常规 → 学习桌面（实验）→ 打开「启用学习桌面」。
  - 期望：无需重启，主内容区切换为桌面（壁纸 + Dock + 空桌面引导）；`workbench:mode-changed` 事件被派发；左侧导航按设计折叠/隐藏。
  - 结果：✅（代码级）事件派发 `workbenchSettingsSection.test`（5 case）；App 监听
    `workbench:mode-changed` → setState 切渲染分支并隐藏导航列；桌面挂载渲染壁纸+Dock+空桌面
    由 P11 冒烟测试断言。
- [ ] **3. 开关关闭即时回退**
  - 操作：在桌面模式下开 2 个窗口，回到设置关闭总开关。
  - 期望：立即恢复现有 currentView 布局；无报错；再次开启后桌面布局从快照恢复原样。
  - 结果：⏭ 需人工。接线完成：mode-changed(false) → 桌面整树卸载（cleanup：flushSnapshot 落盘 →
    注销 provider → dispose projections → stopScheduler → resetEventHub）→ legacy 分支渲染；
    重新开启后快照恢复由冒烟测试第 4 case 佐证。运行时无报错需人工确认。
- [x] **4. 关闭开关不删除快照**
  - 操作：布置 3 窗布局 → 关闭开关 → 重启应用 → 重新开启开关。
  - 期望：3 窗的位置、尺寸、displayMode 完全恢复。
  - 结果：✅（代码级）关闭仅 flushSnapshot（不清 key）；save→load→hydrate 往返一致性为
    P1 `snapshot.test` DoD case + P11 冒烟测试「快照恢复」case（frame/displayMode/dockPinned 全等断言）。

## B. 窗口基础（5–10）

- [x] **5. 空桌面引导**
  - 操作：开启开关且无任何窗口。
  - 期望：显示玻璃引导卡（提示从 Dock 开始）；点击引导动作可打开资源浏览器。
  - 结果：✅（代码级）水合后无窗渲染 EmptyDesktop（冒烟测试 case 1/2）；P11 为引导卡补充了
    「打开资源库」按钮（`bus.launch({typeId:'files'})`，原 P4 实现为纯提示无动作）。
- [x] **6. 开窗与级联落位**
  - 操作：从 Dock 连续打开 4 个新窗口。
  - 期望：每窗按 +24,+24 级联偏移，超出边界回卷；开窗动画 scale 0.96→1 + fade（160ms）。
  - 结果：✅（代码级）级联 +24/回卷为 P1 `windowStore.test` 覆盖；`wb-anim-open` 类已挂
    （P4 实现 scale .96→1+fade）。动画观感需随人工轮复核。
- [x] **7. 标题栏三键**
  - 操作：对任一窗口分别点击 关闭 / 最小化 / 缩放。
  - 期望：关闭走 requestClose 流程销毁壳；最小化后窗口从桌面消失且 Dock 运行区可召回；缩放在 maximize/还原间切换（保留 Dock 可见）。
  - 结果：✅（代码级）`window-titlebar.test`（7 case）+ `window-shell.test`（关闭拦截 /
    maximize-restoreFrame 往返 / 最小化）+ `Dock.test`（运行区召回）。
    O9 收尾：壳路径已接 `requestCloseAnimated` / `requestMinimizeAnimated`（genie / pop-out）；
    Dock 单击最小化、显示桌面、快捷键等入口仍可能直调 store（见 O20 R1）。
    **最小化飞向 Dock 动画：代码级已具备（壳路径），待人工运行验证（2026-07-09 收尾轮）。**
- [x] **8. 双击标题栏 & 标题更新**
  - 操作：双击标题栏两次；打开一个会改标题的应用（如 Chat 会话）。
  - 期望：双击在最大化/还原间切换；应用通过 onTitleChange 更新的标题实时反映在标题栏与 Dock 窗口列表。
  - 结果：✅（代码级）双击 toggle：`window-titlebar.test`；onTitleChange 写回：
    `window-body.test`；Chat 标题订阅同步：`ChatAppWindow.test`（双窗标题隔离）；
    Dock 弹层显示窗口标题：`Dock.test`。
- [ ] **9. 拖动与八向缩放 60fps**
  - 操作：打开 5 窗（含 1 PDF + 1 Chat 流式输出），拖动焦点窗口并用四边四角缩放柄缩放。
  - 期望：拖动/缩放过程直写 DOM 不触发 React 重渲染，帧率 ≥55fps（DevPanel 帧耗时 <18ms）；Esc 中断拖动回原位；minSize 生效。
  - 结果：⏭ 需人工（帧率实测）。代码级已证：拖动全程 0 次 React 重渲染
    （`useWindowPointer.test` renderCount===1 DoD）、八向几何/minSize clamp/Esc 与
    pointercancel/blur 四路回退（`pointerEngine.test` 27 case）；P11 已把 WindowShell 默认
    指针替换为该引擎（吸附命中生效）。
- [x] **10. 焦点与层叠**
  - 操作：点击不同窗口切换焦点。
  - 期望：被点击窗口置顶（zIndex 最高）且阴影切到焦点档；其余窗口降为非焦点阴影档。
  - 结果：✅（代码级）focusStack/zIndex 不变量：`windowStore.test`；
    `wb-window-focused|idle` 类切换：`window-shell.test`（夺焦 case）。

## C. 平铺与吸附（11–15）

- [ ] **11. 边缘吸附半屏**
  - 操作：拖窗口到桌面左/右边缘 24px 内。
  - 期望：出现吸附预览轮廓（120ms fade-in，主题色描边）；松手落位半屏；从平铺态拖走时恢复 restoreFrame 原尺寸。
  - 结果：⏭ 需人工（拖拽体感）。代码级已证：边缘 24px 命中矩阵（`snapZones.test` 28 case）、
    预览 120ms fade（`SnapPreview.test`）、commit 时 zone→`zoneToDisplayMode`→setDisplayMode
    接线（P11 改造 WindowShell handleCommit）、平铺态拖走恢复 restoreFrame
    （WindowShell handleMovePointerDown + `windowStore.test` restoreFrame 往返）。
- [ ] **12. 四角吸附四分屏**
  - 操作：分别拖 4 个窗口到四个角落 64px 区。
  - 期望：四窗各占四分之一屏，几何精确（含 margin）；顶缘吸附 = maximize。
  - 结果：⏭ 需人工（拖拽体感）。几何精确性：`tiling.test` 36 case（12 形态 × margin 0/8
    互补不变量）；四角 64px 优先级与顶缘 maximize：`snapZones.test`。
- [x] **13. 绿灯（缩放键）平铺菜单**
  - 操作：悬停缩放键 350ms，用鼠标和键盘方向键分别操作九宫格菜单。
  - 期望：菜单弹出且键盘可达；左/右半、四角、填满、居中、恢复全部生效。
  - 结果：✅（代码级）`tile-menu.test` 9 case（hover 350ms + 宽限 / 键盘导航回卷 /
    Enter/Esc / 全部动作回调）+ `window-shell.test` 平铺几何断言。
    O4 收尾：`TileMenuPopover` 玻璃九宫格 + motion token 进出场已落地；
    **观感与键盘可达：代码级已具备，待人工运行验证（2026-07-09 收尾轮）。**
- [ ] **14. 平铺间距设置**
  - 操作：设置里关闭「平铺间距」，再开启并把数值改为 16。
  - 期望：关闭后平铺窗口紧贴（0px）；16px 时缝隙可见变宽；设置持久化重启不丢。
  - 结果：⏭ 需人工（视觉核对）。设置读写往返：`workbenchSettingsSection.test`；
    传递链已接：启动读取 + `workbench:settings-changed` 热更新 → Desktop `tileMargin`
    （enabled=false→0）→ WindowShell/SnapPreview/computeTiledFrame。
- [ ] **15. 左右平铺中缝调比例**
  - 操作：左右平铺两窗，拖动中缝到约 70/30，重启应用。
  - 期望：比例实时跟手（clamp 0.2–0.8）；比例入快照，重启后恢复 70/30。
  - 结果：⏭ 需人工（跟手体感）。中缝拖拽写 setTilingRatio + clamp + Esc 回退：
    `useTilingDivider.test` 8 case；tilingRatios 入快照与往返：`snapshot.test`；
    P11 已在桌面渲染左右平铺对的中缝命中条（TilingDivider）。

## D. Dock（16–19）

- [x] **16. Dock 点击三分支**
  - 操作：对同一应用依次验证：无实例点击、单实例点击、单实例已聚焦再点击、多实例点击。
  - 期望：无实例→launch 新窗；单实例→聚焦；已聚焦→最小化；多实例→弹出窗口列表（含标题与最小化标记），点击列表项聚焦。
  - 结果：✅（代码级）`Dock.test` 23 case（三分支 ×4、弹层行为 ×5）。
    O6 收尾：`DockWindowList` 缩略预览 / 升起动画 / 键盘导航已落地；
    **多实例弹层打磨：代码级已具备，待人工运行验证（2026-07-09 收尾轮）。**
- [x] **17. Dock 固定/取消固定 + 右键菜单**
  - 操作：右键运行中应用图标：固定；关闭其全部窗口；再右键取消固定。
  - 期望：固定后关窗图标仍在；「关闭全部窗口」逐窗走 requestClose；取消固定且无实例后图标消失；固定列表入快照。
  - 结果：✅（代码级）`Dock.test` 右键菜单 ×5（含 canClose 拦截）；固定列表入快照：
    P11 冒烟测试断言 snapshot.dockPinned（默认 chat/files/settings/todo，恢复时非空原样、
    空/无快照套默认值）。
    O6 收尾：`DockContextMenu` 玻璃升起 / motion token 已落地；
    **右键菜单打磨：代码级已具备，待人工运行验证（2026-07-09 收尾轮）。**
- [ ] **18. Dock 运行指示与角标**
  - 操作：打开应用观察指示点；触发制卡任务（badgeSource 数据源）。
  - 期望：运行中应用图标下有指示点；角标数量在源变化后 2s 内更新。
  - 结果：⏭ 需人工（真实制卡任务链路）。指示点 + badge 2s 轮询：`Dock.test`；
    制卡任务 badge 源（轮询 + anki_generation_event）：`p9-projection.test` / P9 实现。
- [ ] **19. Dock 自动隐藏**
  - 操作：设置开启「自动隐藏 Dock」，指针移到屏幕底缘再移开。
  - 期望：Dock 收起至底缘热区，指针进入 180ms 滑出，移开滑回，无抖动；设置持久化。
  - 结果：⏭ 需人工（动画抖动观察）。autohide 逻辑：`Dock.test` ×3；
    设置持久化与热更新接线完成（dockAutohide → Dock prop）。

## E. 俯瞰 / 切换器 / 快捷键（20–23）

- [ ] **20. 窗口俯瞰（Exposé）**
  - 操作：开 6+ 窗口按 `Ctrl+Alt+E`；点击任一缩略窗；再次进入后按 Esc。
  - 期望：所有非最小化窗口 transform 网格缩放（不卸载不截图），带标题标签；点击聚焦并退出；Esc 直接退出；进出动画 200ms 不掉帧。
  - 结果：⏭ 需人工（帧率）。网格算法 + transform 注入/恢复 + 点击聚焦 + Esc + 最小化排除：
    `p6-expose.test` 15 case；P11 已在 WindowShell 根元素补 `data-wb-window-id`
    （ExposeOverlay 定位依赖，P6 硬性要求）并在桌面渲染 ExposeOverlay。
    O7 收尾：FLIP 进出 / dissolve 关窗 / `--wb-z-*` / reduced-motion·minimal 归零已落地。
    **俯瞰打磨：代码级已具备，待人工运行验证（2026-07-09 收尾轮）**；帧率仍须运行时复核。
- [x] **21. Ctrl+Tab 切换器**
  - 操作：按住 Ctrl 连按 Tab 循环，加 Shift 反向，松开 Ctrl。
  - 期望：中央玻璃条按最近使用（lastFocusedAt）排序循环；松开即聚焦选中窗口。
  - 结果：✅（代码级）`p6-use-workbench-shortcuts.test`（循环顺序=lastFocusedAt /
    松开聚焦 / Shift 反向 / Esc·blur 取消 / 会话中关窗安全）。
- [x] **22. 平铺/窗控快捷键全集**
  - 操作：依次验证 `Ctrl+Alt+←/→/↑/↓`、`Ctrl+Alt+C`、`Ctrl+W`。
  - 期望：与设计文档 §6.4 行为一致；`Ctrl+W` 经 requestClose 可被未保存拦截。
  - 结果：✅（代码级）`p6-use-workbench-shortcuts.test` 全部快捷键行为 +
    Ctrl+W 走 workbenchBus.closeWindow（canClose 拦截）；桌面根部已挂 useWorkbenchShortcuts。
- [x] **23. 输入焦点守卫**
  - 操作：焦点置于 Chat 输入框 / 笔记编辑器 / contenteditable 内，按全部 workbench 快捷键。
  - 期望：一律不触发窗口动作，按键正常进入文本。
  - 结果：✅（代码级）`isEditableTarget` guard：`p6-shortcuts.test` +
    `p6-use-workbench-shortcuts.test`（input/textarea/contenteditable 全部不触发）。

## F. 应用（24–26）

- [ ] **24. Chat 双会话并排**
  - 操作：打开两个不同会话的 Chat 窗口并排平铺，在两边分别输入并发送。
  - 期望：消息互不串扰；关闭一窗后会话数据完好，重开恢复；流式输出时非焦点窗降频但 token 不丢。
  - 结果：⏭ 需人工（真实流式链路，人工路径见 P7.md「DoD 人工验证路径」）。代码级已证：
    setInput 双实例隔离 / 双窗标题隔离 / currentSessionId 指针接管与归还
    （P7 三个测试文件 18 case）；关窗≠删会话（chat 未注册 canClose，壳销毁不动数据）。
- [ ] **25. files 资源浏览器开窗链路**
  - 操作：Dock 打开 files 窗，双击 PDF、笔记、思维导图各一。
  - 期望：分别开出对应类型窗口（textbook/note/mindmap），内容与现有面板等价；删除某资源后其对应窗口自动关闭。
  - 结果：⏭ 需人工（端到端）。代码级已证：双击→launch 映射与去重（`filesAppWindow.test`）、
    类型映射表（`typeMap.test`）、窗口渲染复用 UnifiedAppPanel（与现有面板同一组件，
    `createContentApp.test`）、删除联动（`resourceSync.test` 7 case）。
    O17 收尾：content/mindmap 骨架空态、files 视图切换/hover 预览/拖出开窗 bridge 已落地；
    Desktop `useDesktopDrop` 接线仍待第二波（O20 R3）。
    **资源窗内体验打磨：代码级已具备，待人工运行验证（2026-07-09 收尾轮）。**
- [ ] **26. 系统应用与投射**
  - 操作：开 settings 窗改一项设置并保存；启动番茄钟/制卡任务。
  - 期望：settings 窗在 Chat 旁正常保存；长活任务通过 project 出现窗口或 Dock 角标，任务结束按宿主策略收敛。
  - 结果：⏭ 需人工（真实保存/番茄钟链路）。代码级已证：系统应用注册元数据
    （`p9-systemApps.test`）、projection 出现/消失/keepShell 生命周期（`p9-projection.test`）；
    P11 已接 registerSystemProjections（挂载）+ resyncProjections（快照恢复后补投）+
    卸载 dispose。

## G. 持久化与生命周期（27–28）

- [ ] **27. 快照恢复全等**
  - 操作：布置混合布局（1 maximize + 2 左右平铺 + 2 floating + 1 最小化），重启应用。
  - 期望：全部窗口 frame/displayMode/minimized/平铺比例恢复一致；首帧只完整渲染焦点窗，其余逐帧唤醒；指向已删除资源的窗口被静默丢弃（有日志）。
  - 结果：⏭ 需人工（真实重启）。代码级已证：往返全等（P1 `snapshot.test` DoD + P11 冒烟
    恢复 case）；已删资源窗口丢弃：P11 `pruneSnapshotWindows`（dstu.get 存在性检查 +
    console.info 日志，检查失败宁可保留交给 resourceSync 运行时兜底）；投射型（pomodoro）壳
    不自动恢复（设计 §7）。已知限制：instanceKey=null 的 chat 窗（Dock 直接点击自动建会话）
    重启恢复时会新建会话而非回到原会话（P7 遗留 4，规避路径=入口走 launchNewChatSession）。
- [ ] **28. 预算冻结与唤醒**
  - 操作：连续打开高权重应用直至超预算（默认 12 点 / macOS 9 点），观察 DevPanel；点击一个 frozen 窗口。
  - 期望：仅 background 窗按 LRU 冻结（focused/visible 永不冻结）；冻结窗显示唤醒占位；点击唤醒重建且业务状态由 store/后端恢复；坏快照 JSON 不白屏（空桌面 + console.warn）。
  - 结果：⏭ 需人工（DevPanel 实时观察）。代码级已证：预算 LRU 冻结 / focused·visible 永不
    冻结 / 唤醒解冻 / macOS 9 点（`scheduler.test` 12 case）；frozen→唤醒重建
    （`window-body.test` DoD case）；坏 JSON → null + warn 不抛出（`snapshot.test`）。

## H. 视觉 / 材质 / 诊断（29–30）

- [ ] **29. 材质三档与壁纸**
  - 操作：设置里在 跟随平台/full/reduced/minimal 间切换；切换明暗主题；换壁纸预设与自定义图片。
  - 期望：改 `data-wb-material` 即时生效无需重载；reduced 无 backdrop-filter；minimal 不透明且无开合动画；明暗主题下玻璃层可读；壁纸设置持久化。
  - 结果：⏭ 需人工（观感为 P4 遗留 1 的核心待验项：明暗两主题 × 三档在 WebView2 上的实际
    渲染）。代码级已证：档位切换只改 html attribute 即时生效（materialTier 实现 +
    `workbenchSettingsSection.test`）；启动回放（desktop.workbenchMaterialTier → setMaterialTier）
    与壁纸设置读取/热更新已由 P11 接线；reduced/minimal 的 token 降级为 P4 CSS 静态实现。
- [ ] **30. 诊断面板**
  - 操作：设置开启「诊断面板」，在桌面上增删/移动/最小化窗口并等待快照保存。
  - 期望：面板实时显示窗口 lifecycle 着色列表、预算占用条（超限变红）、焦点栈、快照最后保存时间与 rAF 帧耗时；关闭设置项后面板消失。
  - 结果：⏭ 需人工（实时观察）。代码级已证：面板渲染与快照事件消费
    （`workbenchDevPanel.test` 4 case）；P11 已补 snapshot.ts 保存成功后派发
    `workbench:snapshot-saved`（P10 遗留 3），并按 devPanel 设置条件挂载/热更新。

---

## 执行记录

| 执行人 | 日期 | 通过 | 失败 | 暂缓 | 备注 |
|---|---|---|---|---|---|
| P11（代码级验收轮） | 2026-07-08 | 14 | 0 | 16 | 按约束未启动 dev server；16 条「⏭ 需人工」均为接线完成且逻辑有单测覆盖、但帧率/动画/真实后端链路需运行时复核的项。0 条失败；已知限制记录在 #27（chat null-key 壳恢复）与导航迁移清单暂缓节。全套证据：tsc exit 0 + vitest 383 case 全绿（35 文件，含 P11 总装冒烟 5 case）。 |
| O20（收尾轮文档复核） | 2026-07-09 | 14 | 0 | 16 | 不虚标 ✅。对 #7/#13/#16/#17/#20/#25 追加「代码级已具备，待人工运行验证（2026-07-09 收尾轮）」注记（Dock 弹层 / Exposé / TileMenu / 最小化动画 / 资源窗打磨）。纯帧率/视觉/后端项保持 ⏭。问题清单与 reconcile 台账见 `docs/dev/workbench-progress/O20.md`。 |
| （待人工运行时验收填写） | | | | | |
