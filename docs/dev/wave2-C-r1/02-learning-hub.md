# 0824 Wave2-C R1 扫描台账 — learning-hub 移动端

- 扫描员:learning-hub 移动(第 1 轮,只静态审阅,未运行任何构建/测试命令)
- 口径:docs/dev/mobile-uiux-unify/README.md 五条规范(①全局顶栏唯一 ②左侧按钮语义 ③右侧≤2×44px ④禁桌面组件滥用 ⑤可达可回退)
- 范围:任务清单 25 个文件全部逐读(超长文件 LearningHubSidebar/MemoryView/IndexStatusView/ExamContentView 以模式检索+关键段落精读)
- 约束遵守:未改 finder host buckets(不变量 10),未散点手贴 !min-h-11,未触碰 coordinator.rs/域存储 —— 本轮只产出台账

---

## 一、逐页核验表(view/子屏 × 五条)

| # | view / 子屏 | ①顶栏唯一 | ②左键语义 | ③右侧≤2×44 | ④禁桌面组件 | ⑤可达可回退 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | 页面壳(三屏布局) `LearningHubPage` | PASS | PASS | PASS | PASS | PASS | useMobileHeader('learning-hub') 单一写者;Resizable/PanelGroup 仅桌面分支 |
| 2 | 左屏抽屉 `DstuAppLauncher` | PASS | 折衷 | — | PASS | PASS | 左屏时顶栏仍显 ☰(语义=收起抽屉),非返回箭头;有意为之(见 F8) |
| 3 | 中屏文件列表(finder 根/文件夹) | PASS | PASS | PASS | PASS | PASS | 顶栏=MobileBreadcrumb;子目录左键=goUp;右侧仅刷新 1 键 |
| 4 | 中屏移动工具栏(搜索/新建/清空回收站) | PASS | — | — | PASS | PASS | 内容级工具条非第二顶栏;44px 达标;特殊视图下未隐藏(F4) |
| 5 | 中屏子屏:移动到…(FolderPickerDialog inline) | **FAIL(轻)** | 折衷 | — | PASS | PASS | 自绘页内返回条,与全局顶栏面包屑叠双 chrome(F2);Android 返回键已接 |
| 6 | 中屏特殊视图 MemoryView | PASS | PASS | — | PASS | PASS | 自带密集工具栏(10+ 图标)属内容 chrome,flex-wrap 防溢出;44px 全量补齐 |
| 7 | 中屏特殊视图 IndexStatusView | PASS | PASS | — | PASS | PASS | 紧凑头(isMobile∥窄容器);OCR 详情为内联展开非模态;更多菜单接返回键 |
| 8 | 中屏特殊视图 DesktopView | PASS | PASS | — | PASS | PASS | 触屏菜单=贴底面板+44px;FolderPicker 触屏走 inline |
| 9 | 回收站/最近/收藏(容量视图) | PASS | PASS | PASS | PASS | PASS | 顶栏标题按 quickAccessType 映射(centerViewTitle);空态钮 min-h-11 |
| 10 | 右屏 TabBar | PASS | — | — | 折衷 | PASS | 触屏 tab 视觉 38px+伪元素补 44(F6,INVENTORY 已登记);自绘菜单接返回键 |
| 11 | 右屏 NoteContentView | PASS | PASS | PASS | PASS | PASS | 属性面板桌面=浮层,移动=inline 子屏;返回键已接 |
| 12 | 右屏子屏:笔记上下文面板(移动) | **FAIL(轻)** | 折衷 | — | PASS | PASS | 自绘返回行未走 useMobileSubviewChrome,右屏双 chrome(F1) |
| 13 | 右屏 ImageContentView | PASS | PASS | PASS | PASS | PASS | 顶部内容工具栏 max-md 收纳+44px;裁剪子屏(ImageCropDialog)走 subview chrome |
| 14 | 右屏 TextbookContentView(预览路由) | PASS | PASS | PASS | PASS | PASS | 纯路由组件;移动适配下沉到 Docx/Epub/Xlsx/Text 预览件(契约测试覆盖) |
| 15 | 右屏 UnifiedPreviewToolbar | PASS | — | — | PASS | PASS | <md 收纳重置钮、紧凑页码;coarse [&_button]:min-h-11 |
| 16 | 右屏 ExamContentView | PASS | PASS | PASS(经更多菜单) | PASS | PASS | 非根态返回键页内回退(overlay 档+inert 让行);导出/历史子屏走 subview chrome |
| 17 | 右屏 TranslationContentView | PASS | PASS | PASS | PASS | PASS | 设置经顶栏更多菜单事件(translation:openSettings);错误条 44px |
| 18 | 浮层 LearningHubContextMenu | PASS | — | — | PASS | PASS | 触屏=贴底动作面板+44px+返回键;桌面=定点菜单 |
| 19 | 浮层 FinderQuickLook | PASS | — | — | PASS | **FAIL(轻)** | 无 registerBackHandler,Android 返回键关不掉(F3);触屏无入口故低危 |
| 20 | 底部 FinderBatchToolbar | PASS | — | — | PASS | PASS | coarse min-h-11+flex-wrap+safe-area;排序菜单接返回键 |
| 21 | FinderToolbar(仅桌面壳/OS 窗) | N/A(移动不渲染) | — | — | 折衷 | — | 触屏视觉 40px+after 外扩 48px 热区(F7,INVENTORY 已登记折衷) |
| 22 | FinderQuickAccess(仅桌面/canvas) | N/A(移动页不渲染) | — | — | PASS | — | isSmallScreen 且无 portal target 时不渲染(LearningHubSidebar:3257) |
| 23 | FinderFileList / FinderFileItem | — | — | — | PASS | PASS | 触屏行高 48、更多钮常显非 hover-only、拖放靶 44;无宽表 |
| 24 | 全局 UnifiedMobileHeader / MobileHeaderContext | PASS(机制) | PASS | 折衷(仅注释约定) | PASS | PASS | ≤2×44 只有注释约定无机制/测试(F10) |

---

## 二、逐文件证据(file:line)

### 1. src/features/learning-hub/LearningHubPage.tsx
- **顶栏唯一**:`useMobileHeader('learning-hub', …)` 单一注册点(723-750);右屏内联子屏经 `useMobileSubviewChromeHost` 并入同一配置(719-720),保持单一写者。PASS。
- **左键语义**(738-748):右屏→返回箭头收回中屏或子屏 onBack;中屏子目录→返回箭头 goUp;中屏根→☰ 开左抽屉;左屏→☰ 收抽屉(折衷,见 F8)。`showBackArrow` 与 `showMenu` 互斥正确。
- **右侧动作**(633-713):中屏=刷新 1 键(h-11 w-11,636-647);右屏=引用到对话+更多菜单 ≤2 键(660-699,均 h-11 w-11);重载/设置收进 AppMenu(689-698)。PASS。
- **禁桌面组件**:`PanelGroup/Panel/PanelResizeHandle` 仅出现在 `if (isSmallScreen)` 早退之后的桌面分支(1186 早退;1299-1387 桌面);移动分支用 `MobileSlidingLayout`(1194)。PASS。
- **可达可回退**:抽屉导航桶(mobileReachabilityContract 已覆盖 learning-hub);Android 返回键:中屏子目录 goUp 注册 view 档(762-770),顶栏菜单开着时 overlay 档(616-622),tab 全关自动回中屏(1176-1179);DevMobileRecoveryFab 兜底复位(624-631)。PASS。
- **宿主桶**:移动读写 `FINDER_HOST_IDS.pageMobile`、桌面 `page`(498-500,1276/1316)——与不变量 10 一致,未动。

### 2. src/features/learning-hub/LearningHubSidebar.tsx
- 移动工具栏(3315-3448):搜索/新建/清空回收站均 h-11 w-11(3336/3352/3366/3432),搜索框 h-11 + 16px 防 iOS 缩放(3329);刷新已上收顶栏不重复(3347 注释)。PASS。
- **F4**:该工具栏仅以 `isSmallScreen && !hideToolbarAndNav` 门控(3315),viewKind=memory/indexStatus/desktop 时仍渲染(禁用态搜索/新建+项目数),与 MemoryView/IndexStatusView 自带工具栏在中屏叠两条内容工具条;对比底部 FinderBatchToolbar 已按 viewKind 摘除(3824)。建议同门控。
- 桌面 FinderToolbar 门控 `!isSmallScreen && mode === 'fullscreen'`(3586),移动不渲染。PASS。
- QuickAccess 移动页不渲染(3257);canvas 模式导航/多选工具条触屏 44px(3457/3467/3476/3562/3575)。
- 移动「移动到…」走 `FolderPickerDialog inline={isSmallScreen}`(3950),注释明示契约(3937-3938)。
- 无 Resizable*;无 hover-only 关键操作(上下文菜单触屏由 FinderFileItem 常显更多钮触发)。

### 3. src/features/learning-hub/components/TabBar.tsx
- 栏高触屏 44px(544 `[@media(pointer:coarse)]:h-[44px]`);滚动钮触屏 w-11(554/608)。
- **F6(折衷)**:TabItem 视觉高 38px(237),用 before/after 3px 条带补足 44 热区(240-241),触屏「更多/关闭」钮用伪元素扩热区(286/307)。INVENTORY「仍开(有意折衷)」已登记。
- 自绘右键菜单:portal+边缘检测(315-325/204-216),触屏 min-h-11(332/345/358/370/381/392),Android 返回键 overlay 档(193-199),移动端无分屏入口时隐藏菜单项(327 注释)。PASS。
- **F5(轻)**:关闭钮 `role="button"` + `aria-hidden="true"`(294-297),更多钮 `tabIndex={-1}`(272)——读屏不可达;键盘等价操作存在(Delete/Backspace 关标签,152-164),故降级为 a11y 备注。

### 4. src/features/learning-hub/components/MobileBreadcrumb.tsx
- 三级降级(full/collapsed/minimal,55-81);触屏命中区用 min-h 真实占位防 overflow 裁剪(23-24 注释+113);折叠「…」可点回上一级(160-169)。全 PASS。

### 5. src/features/learning-hub/components/DstuAppLauncher.tsx
- 新建菜单接 Android 返回键(129-135);菜单项 min-h-11(51-52);搜索框 coarse !h-11 + 16px(299-304);清除钮伪元素热区(313);回车收抽屉看结果的操作闭环(292-297)。PASS。

### 6. src/features/learning-hub/components/LearningHubContextMenu.tsx
- 触屏=贴底动作面板(950-961)+抓手+完整文件名头(970-977);菜单行 coarse min-h-11(154/948);返回键 overlay 档显式注册(333-339,注释说明无 data-state 不吃 Radix 兜底);滚动/触摸穿透关闭(297-318)。PASS。

### 7. src/features/learning-hub/components/finder/FinderToolbar.tsx
- 仅桌面壳 header portal / OS 窗标题栏使用(titlebarMode,481-515);移动页面不渲染(LearningHubSidebar:3586 门控)。
- **F7(折衷,已登记)**:触屏图标钮视觉 40px(!h-10)+after:-inset-1 外扩 48(280/292/340/362/403/421/435 注释 273-274);受 38px 窗口标题栏 chrome 约束。compact 溢出菜单收纳排序/新建/刷新(355-385)。搜索框 titlebar 模式 40、内嵌模式 min-h-11(462-465)。
- 面包屑触屏热区用 padding+负 margin(56-57)——与 MobileBreadcrumb 的 min-h 范式不同源;titlebar 槽无 overflow-hidden 裁剪风险,可接受,如统一范式更佳。

### 8. src/features/learning-hub/components/finder/FinderBatchToolbar.tsx
- coarse:h-auto min-h-11 flex-wrap + 底部安全区(124-126);所有图标钮 isTouchPrimary→!h-11 !w-11(108-109);排序菜单接返回键(112-119)。PASS。

### 9. src/features/learning-hub/components/finder/FinderQuickAccess.tsx
- 移动页面不渲染;桌面/触屏平板下搜索 coarse h-11+16px(339/363)、清除钮 44 热区(375)、新建钮伪元素热区(390/411)、折叠钮 min-h-11(455)。PASS。

### 10. src/features/learning-hub/components/finder/FinderFileList.tsx
- 触屏行槽 48px 与虚拟滚动同源(394-395 LIST_ITEM_HEIGHT_TOUCH);拖放靶 coarse min-h-11(134);空态/错误重试钮 min-h-11(1081/1113/1152);无表格组件、无横向宽表。PASS。

### 11. src/features/learning-hub/components/finder/FinderFileItem.tsx
- N-3/N-4 触屏范式:单击即打开(146-154)、更多钮常显非 hover-only(list:288-302 触屏 !h-11 !w-11 opacity-100;grid:338-350 视觉 36px+before -inset-2 热区 52);多选模式单击只 toggle(147-149);行内改名输入 coarse !h-11+16px(241/372)。PASS。

### 12. src/features/learning-hub/components/finder/DesktopView.tsx
- 触屏菜单贴底+min-h-11(191/209-212/232);触屏「添加快捷方式」显式入口替代右键(711-719);快捷方式改名输入 coarse !h-11+16px(401);资源挑选走 inline(764 `inline={isTouchPrimary}`)。PASS。

### 13. src/features/learning-hub/components/finder/FolderPickerDialog.tsx
- inline 子屏:返回钮 min-h-11(304-313)、树行 coarse 44(84/255)、展开钮 44 热区(114-118)、底部确认条含安全区(324)、Android 返回键 overlay 档(210-216)。
- **F2(FAIL 轻/折衷)**:inline 形态自绘顶部返回行(302-316)。中屏无 subview chrome 宿主——LearningHubPage 仅在 `screenPosition === 'right'` 取栈顶(720 `rightSubviewChrome = screenPosition === 'right' ? …`),中屏子屏无法把 title/onBack 注入全局顶栏,于是全局顶栏仍显示面包屑(其返回箭头 goUp 会在子屏下层导航),页内再出现一条返回行,违反「后退不放全局顶栏之外」。回退本身可用(返回键+页内钮),定级 FAIL(轻)。

### 14. src/features/learning-hub/components/finder/FinderQuickLook.tsx
- **F3(FAIL 轻)**:仅空格/Esc/点遮罩关闭(74-94/170-173),无 `registerBackHandler`,且自绘 portal 无 `data-state="open"`(androidBackCoordinator 的 Radix 兜底匹配不到,对照 LearningHubContextMenu.tsx:331-339 的注释)。触屏无空格入口,常规手机不可触发;iPad+外接键盘可打开后返回键失效。关闭钮 coarse !h-10(192,40px<44,伪元素未补);「打开」钮 min-h-11(260)。

### 15. src/features/learning-hub/views/MemoryView.tsx
- 无自绘顶栏(1167 起为内容工具栏,flex-wrap 防溢出 1169);全量 coarse !min-h-11/!min-w-11 补齐(1194-1247 等 60+ 处);触屏删除钮常显弱化态替代 hover 隐身(2038-2039 注释);批量导入/新建为内联面板非模态。PASS。备注:工具栏 10+ 图标在 375px 触屏下折 2-3 行,属可用性观察非违规。

### 16. src/features/learning-hub/views/IndexStatusView.tsx
- 紧凑头 `useCompactHeader = isMobile || isNarrowContainer`(1063,容器感知比纯视口更稳);更多菜单接返回键+inert/offsetParent 让行守卫(1084-1094);资源行操作钮触屏常显(1496 `[@media(pointer:coarse)]:opacity-100`);OCR/块详情为内联展开面板非 fixed 模态(1817-1830 注释);按钮全量 coarse 44 补齐(1351/2051/2055/2061 等)。PASS。

### 17. src/features/learning-hub/apps/views/UnifiedPreviewToolbar.tsx
- `<md` 收纳缩放重置(216-220)/字号重置(279-285),等价入口保留在档位菜单(206-208);pptx 页码窄屏紧凑数字(233-245);coarse 全钮 min-h-11/min-w-11(172)。PASS,契约测试已覆盖。

### 18. src/features/learning-hub/apps/views/NoteContentView.tsx
- 断点与壳同源 useIsMobile(138-139);移动子屏返回键 overlay 档+isActive 守卫(146-154);子屏打开抑制底部编辑工具条(937-939);桌面属性面板=页内浮层非 Resizable(967-983)。
- **F1(FAIL 轻)**:移动上下文子屏自绘返回行(986-1002 `absolute inset-0 z-40` + 页内 CaretLeft 返回钮),未走 `useMobileSubviewChrome`。此时全局顶栏仍显示笔记标题+引用/更多动作(指向被子屏盖住的正文),右屏出现两条 chrome;同工程内题库导出/历史/裁剪(QuestionBankExportDialog/QuestionHistoryView/ImageCropDialog)均已用 subview chrome 通道,本处不一致。

### 19. src/features/learning-hub/apps/views/ImageContentView.tsx
- 顶部内容工具栏:max-md + pointer:coarse 双保险 44(951 注释,965/1051/1063/1084);次要钮(实际大小等)<md 收纳(1074/1094 hidden md:inline-flex);缩放档位菜单项 min-h-11(1001/1012)。裁剪子屏走 subview chrome(components/ImageCropDialog)。PASS。

### 20. src/features/learning-hub/apps/views/TextbookContentView.tsx
- 纯预览路由(1-55),自身无 chrome/无断点分支;移动适配全部下沉到 DocxPreview/EpubPreview/XlsxPreview/TextFilePreview + UnifiedPreviewToolbar,由 previewMobileAdaptation.source.test.ts 守卫。PASS。

### 21. src/features/learning-hub/apps/views/ExamContentView.tsx
- 断点同源 useIsMobile(21/305);非根态硬件返回键页内回退,overlay 档+inert 让行+守卫注释完整(1692-1716);顶部 tab 为内容级导航非第二顶栏(1718 起)。PASS。

### 22. src/features/learning-hub/apps/views/TranslationContentView.tsx
- 无自绘顶栏(567 起);保存失败条触屏两行折行替代 title 悬停(575-577 注释),重试/关闭钮 coarse 44(585/597/616);设置由顶栏更多菜单经 `translation:openSettings` 事件进入(LearningHubPage:600-610)。PASS。

### 23. src/components/layout/UnifiedMobileHeader.tsx
- 左键三态互斥优先级清晰(61-73);floatingMenuButton 形态(75-102);标题槽 titleNode 优先+fallbackTitle 兜底(181-189);移动平台去 tauri-drag-region 防触摸干扰(106-108)。
- **F10**:右侧「≤2×44」仅注释约定(197-200),无收纳机制也无静态守卫。

### 24. src/components/layout/MobileHeaderContext.tsx
- 视图隔离缓存+activeView 切换(87-113);clearConfig 防 LRU 驱逐后陈旧 rightActions 滞留(96-101);enabled 参数防嵌入实例覆盖(184-221);写/读 context 分离防渲染循环(71-75)。机制 PASS。config 接口的 rightActions 同样只有注释约定(27-31)。

### 25. docs/dev/mobile-uiux-unify/INVENTORY.md
- learning-hub 已登记注册 useMobileHeader、三屏、面包屑;「仍开(有意折衷)」列有 TabBar/FinderToolbar 尺寸折衷,与本轮实测一致(F6/F7 归档为折衷不重复立案)。

---

## 三、违规项与机制化修复建议

| ID | 定级 | 问题 | 位置 | 机制化修复建议 |
|---|---|---|---|---|
| F1 | FAIL(轻)·规范①② | 笔记移动上下文子屏自绘返回行,右屏双 chrome | NoteContentView.tsx:986-1002 | 改用 `useMobileSubviewChrome({ title: t('notes:contextPanel.title'), onBack: () => setMobilePanelOpen(false) })`,探测不到宿主(桌面/嵌入)时保留现有自绘作降级——该降级语义 MobileSubviewChromeContext 已内建(LearningHubPage:1188-1190 注释)。顺带可删本地 registerBackHandler(通道内已含) |
| F2 | FAIL(轻)·规范① | 移动「移动到…」inline 子屏自绘返回行,中屏无 chrome 宿主 | FolderPickerDialog.tsx:302-316;宿主门控 LearningHubPage.tsx:720 | 机制化:把 `useMobileSubviewChromeHost` 的接管从 `screenPosition === 'right'` 扩展为按子屏注册时的屏位匹配(注册时带 screen 标记,host 端 `activeSubviewChrome.screen === screenPosition` 才接管);FolderPicker/未来中屏子屏统一走通道。改动集中在 MobileSubviewChromeContext + LearningHubPage 两处,不碰 finder 逻辑 |
| F3 | FAIL(轻)·规范⑤ | QuickLook 浮层 Android 返回键关不掉 | FinderQuickLook.tsx(全文无 registerBackHandler) | 组件内 `useEffect(() => registerBackHandler(() => { onClose(); return true; }, BACK_PRIORITY.overlay), [onClose])`,与 LearningHubContextMenu.tsx:333-339 同范式;顺带把关闭钮 !h-10 对齐 44(或伪元素补 4px,同 FinderToolbar 范式) |
| F4 | 折衷→建议 | 特殊视图(memory/indexStatus/desktop)下移动工具栏叠双条 | LearningHubSidebar.tsx:3315 vs 3824 | 复用 FinderBatchToolbar 的 viewKind 门控:`isSmallScreen && !hideToolbarAndNav && !['memory','indexStatus','desktop'].includes(effectivePath.viewKind)`;常量与 3824 共享一个 `CHROME_EXEMPT_VIEW_KINDS` 集合,避免两处漂移 |
| F5 | a11y 备注 | TabItem 关闭/更多钮 aria-hidden + tabIndex=-1,读屏不可达 | TabBar.tsx:269-311 | 去掉 aria-hidden,补 aria-label(已有)并允许聚焦;或保持 roving tabindex 但在 tab 本体 aria-keyshortcuts 声明 Delete 关闭 |
| F6 | 折衷(已登记) | 触屏 tab 视觉 38px,伪元素补 44 | TabBar.tsx:237-241 | 维持;INVENTORY 已归档 |
| F7 | 折衷(已登记) | FinderToolbar 触屏视觉 40px(38px 标题栏约束) | FinderToolbar.tsx:273-280 | 维持;仅桌面壳/OS 窗使用,移动页面不渲染 |
| F8 | 折衷 | 左屏(抽屉开)时左键仍为 ☰ 而非收起语义图标 | LearningHubPage.tsx:722/738-747 | 维持可接受(一次点击关闭+防点击穿透的权衡有注释);若统一,可在 `screenPosition==='left'` 时换 X/CaretLeft 图标,属全局 UnifiedMobileHeader 图标策略,不宜本页单点特判 |
| F9 | 观察 | MemoryView 工具栏 10+ 图标窄屏折多行 | MemoryView.tsx:1169-1300 | 后续轮次可把 профile/审计/导出收进 AppMenu 溢出菜单(同 IndexStatusView 2059-2084 的「更多」范式);非本轮违规 |
| F10 | 缺口 | 顶栏右侧 ≤2×44 仅注释约定,无机制无测试 | UnifiedMobileHeader.tsx:197-200;MobileHeaderContext.tsx:27-31 | 见下节测试缺口 T1;不建议加运行时截断(会静默吞动作),建议契约测试守卫 |

无「散点手贴 !min-h-11」新增需求:本清单文件的触控目标已系统化(isTouchPrimary 分支/共享 class 常量/伪元素范式),不存在需要手贴的裸小按钮;F3 的 QuickLook 关闭钮请按范式(伪元素外扩)而非散贴。

## 四、已有契约测试盘点与缺口

已有(与本域相关):
- `src/features/learning-hub/apps/views/__tests__/previewMobileAdaptation.source.test.ts`:UnifiedPreviewToolbar 收纳/44px、DocxPreview 台面留白、EpubPreview 断点同源、XlsxPreview 状态条、TextFilePreview 44px/溢出。
- `tests/vitest/mobile-uiux/mobileHeaderViewRegistryContract.test.ts`:learning-hub viewId 注册于 LearningHubPage(registry 表列明)。
- `tests/vitest/mobile-uiux/mobileReachabilityContract.test.ts`:learning-hub 抽屉桶可达。
- `tests/vitest/mobile-uiux/deprecatedMobileHeaderBanContract.test.ts`:封禁旧自绘 MobileHeader 与 data-mobile-shell="header" 冒用。
- `tests/vitest/learning-hub/learningHubGlobalHeaderContract.test.ts`:桌面 FinderToolbar portal 归属(shell/OS 槽)。
- `tests/vitest/learning-hub/finder-host-buckets.test.ts`:宿主桶不变量 10(本轮未触碰)。

缺口(建议新增,均可做 source 守卫,不需运行时渲染):
- **T1 顶栏右侧 ≤2 契约**:静态断言 LearningHubPage 的 `mobileHeaderRightActions` 各分支顶层交互节点 ≤2 且均带 `h-11 w-11`(可仿 previewMobileAdaptation 的正则式 source 断言);同时对 `useMobileHeader\(` 全仓扫描 rightActions 内 DsButton 计数(粗粒度)。堵 F10。
- **T2 子屏 chrome 通道契约**:断言 NoteContentView 移动子屏/FolderPickerDialog inline 使用 `useMobileSubviewChrome`(F1/F2 修复后加,防回退到自绘返回行);现有 QuestionBankExportDialog/QuestionHistoryView/ImageCropDialog 一并纳入 allowlist 式清单。
- **T3 自绘浮层返回键契约**:扫描 learning-hub 内 `createPortal` 且无 `data-state` 的浮层组件,断言同文件存在 `registerBackHandler`(现命中:TabBar✓、LearningHubContextMenu✓、DesktopView✓、FinderQuickLook✗——即 F3 的回归防线)。
- **T4 TabBar 触屏几何守卫**:断言 44px 栏高 token 与 before/after 3px 补条同时存在(TabBar.tsx:237-241/544),防止后续改行高时遗落伪元素导致热区回落 38px。
- **T5 ImageContentView 工具栏守卫**:previewMobileAdaptation 未覆盖图片工具栏的 max-md 收纳(1074/1094)与 44px 双保险(965),可并入该测试文件。
- **T6 移动工具栏特殊视图门控**(F4 修复后):断言 LearningHubSidebar 移动工具栏与 FinderBatchToolbar 共享同一 viewKind 豁免常量。

## 五、结论

learning-hub 移动端整体成熟度高:顶栏单一写者+子屏 chrome 通道+Android 返回键分档让行已成体系,五条规范大面 PASS。本轮立案 3 个轻度 FAIL(F1 笔记子屏双 chrome、F2 中屏子屏无 chrome 宿主、F3 QuickLook 返回键),均有对仓内既有范式的机制化修法,无需散点样式补丁;另归档 4 项已登记/可接受折衷与 2 项观察。测试侧最大缺口是「右侧≤2」与「自绘浮层必接返回键」两条无守卫,建议按 T1/T3 优先补。
