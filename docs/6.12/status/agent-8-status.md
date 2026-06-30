# 代理 8 状态文档 —— 移动端 UI/UX 体验(全局横切)

## 任务目标

审阅并优化 DeepStudent 在 Android(及未来 iOS)上的整体用户体验:响应式布局、触控交互、
软键盘协调、手势、安全区域、移动端性能与离线弱网表现。逐特性(对话、资源中心、阅读器、
练习、制卡、笔记、导图、翻译、设置……)过一遍移动端可用性。

修改权限分级(agent-8.md 第 5 节):
- **直接改**:移动端基础设施(MobileSlidingLayout/MobileLayoutContext/useBreakpoint/platform.ts/styles/tailwind 断点)+ 纯样式级响应式修补;
- **协商改**:各特性组件内的结构性适配 → 登记「跨组问题」等用户裁决;
- **只报告**:业务逻辑、后端、`components/ui` 基础件。

## 当前状态

**全部审阅项(G1~G7、F1~F8)已完成;追加专项:全库 hover-only 操作触屏可达性审计(33 文件)完成,
16 个组件修复。共 10 批低风险优化已实施并通过验证,收尾总结见文末。**
最后更新:2026-06-13 00:35

## TODO 计划

### 全局横切审阅
- [x] G1. 断点体系一致性(2026-06-12 完成,改动+验证见「已实施的优化」#1~#4)
- [x] G2. 触控目标(2026-06-12):原语层 44px 契约 ✓(见全局健康项);命令面板触屏修补见 #9
- [x] G3. 软键盘协调(2026-06-12):InputBarUI visualViewport 方案可靠(见全局健康项)
- [x] G4. 安全区域(2026-06-12):SA-1 真实注入(#5)+SA-2 口径统一(#8);横屏=桌面布局(设计权衡,见审阅发现 #9);系统大字体需真机验证(接力须知)
- [x] G5. Android 返回键(2026-06-12):协调器链路完整,8 个接入点(见全局健康项)
- [x] G6. 移动端性能(2026-06-12):页面级 React.lazy 全覆盖(lazyComponents.tsx 含 ChatV2/LearningHub/Todo/Settings);virtua 虚拟化长列表;CSS 普遍尊重 prefers-reduced-motion;framer-motion 未用 LazyMotion(包体优化建议,协商级,见审阅发现 #10)
- [x] G7. 弱网/离线(2026-06-12):App 级 online/offline 全局通知 ✓;聊天队列 failed→retryFailed 重试 ✓;懒加载 PageLoadingFallback+骨架 ✓;LLM 流式中断恢复属对话组(代理 1)纵深,不重复审

### 逐特性走查
- [x] F1. 对话(2026-06-12):三屏布局结构良好;长公式溢出已修(#6);代码块/表格 overflow-x:auto+C-9 豁免 ✓;输入栏附件 chip 横滑 ✓;无多 Tab(浏览/侧栏双模式)
- [x] F2. 资源中心(2026-06-12):N-3/N-4 触屏范式已落地(单击即开、更多按钮常显 36px)、A-8 手势归一 ✓
- [x] F3. PDF 阅读(2026-06-12):捏合缩放已实现(节流 commit);移动端分屏降级=ChatV2 右面板/LearningHub 标签;手势豁免失效类名已修(#7)
- [x] F4. 练习(2026-06-12):ExamContentView 用 Tailwind sm: 自适应+横滑工具栏 ✓;components/practice/* 布局简单(grid-cols-2+h-12 大按钮)可接受;无独立练习 feature(目录为空壳)
- [x] F5. 制卡(2026-06-12):TaskDashboardPage 全程 Tailwind 响应式(sm:/md: 列隐藏+grid 切换)+useMobileHeader ✓;MinimalTemplateEditor 移动端预览/编辑器分屏(portal 到 MobileSlidingLayout 右屏)✓;TemplateManagementPage 移动端三屏布局 ✓
- [x] F6. 笔记/导图(2026-06-12):MindMapCanvas 键盘遮挡自动平移画布(visualViewport)✓;ReactFlow 原生触控;阅读模式手动切换防误触 ✓;导图手势豁免已修(#7)
- [x] F7. 翻译(2026-06-12):TranslationMain isSmallScreen 全套分支+自有拖拽切换 ✓
- [x] F8. 设置/命令面板/待办/番茄钟(2026-06-12):Settings 移动端底部抽屉+横滑 tab ✓(浏览器实测);Todo 移动端 MobileSlidingLayout+MobileDetailOverlay(全屏详情+返回键)✓;番茄钟悬浮药丸 pointer:coarse 加大(h-14/按钮 40px)+避开输入栏 ✓;命令面板触屏缺陷已修(#9)

### 收尾
- [x] Z1. 低风险优化实施 + 验证(2026-06-13:typecheck 全仓 0 错;ui-shell+legal 单测 9 通过;stylelint/eslint 涉改文件无新增错误)
- [x] Z2. 状态文档总结(见文末「总结」)+ 最终汇报

## 审阅发现

| # | 文件/位置 | 类型 | 严重度 | 描述 | 处理 |
|---|-----------|------|--------|------|------|
| 1 | 22 个 CSS 文件(全库) | bug/体验 | 中 | 移动端覆盖样式用 `max-width: 768px`(含 768 整点),与 JS `isSmallScreen`(<768)边界错位:iPad mini 竖屏(恰 768px)会同时命中桌面布局+移动端 CSS,出现混合态;640/480/1024 邻界同理 | 已修复(#1) |
| 2 | `hooks/useBreakpoint.ts` useIsMobile/useIsTablet | bug | 低 | `max-width:767px` 与 `!(min-width:768px)` 在小数视口宽度(缩放 767.5px)下不互补,与 isSmallScreen 判定可能错位 | 已修复(#2) |
| 3 | `features/chat/components/ChatContainer.tsx:89` | bug | 低 | isMobile 兜底 `window.innerWidth <= 768` 含 768 整点,与 <768 约定错位 | 已修复(#4) |
| 4 | `learning-hub/apps/views/NoteContentView.tsx:46` | 坏味道 | 低 | 手写 `useMediaQuery("(max-width:767.98px)")` 而非统一 `useIsMobile()` | 已修复(#3) |
| 5 | `tailwind.config.js` screens.xs=480px | 坏味道 | 低 | `xs:480` 断点未收录进 `config/breakpoints.ts`(注释声称两者一致);JS 侧无对应判定 | 建议(暂不动,影响面小;如需收录由代理 7 裁决) |
| 6 | `utils/platform.ts` initAndroidSafeArea | 体验 | 中 | Android 安全区域用固定猜测值(top 24px/bottom 15px),非真机 inset:手势导航/三键导航/打孔屏高度不同,可能遮挡或留白 | 已修复(#5 SA-1,用户已批准立项) |
| 7 | 环境基线(非本组改动) | - | - | ① npm 依赖不完整(@phosphor-icons/react、@lobehub/icons 缺失),已用 `npm install --legacy-peer-deps` 补装(与 CI 一致),package-lock.json 已还原;② `npm run lint:css` 脚本的单引号 glob 在 Windows PowerShell 不展开(NoFilesFoundError);③ stylelint 基线 3072 个历史错误;④ NoteContentView.tsx:145 处 `react-hooks/exhaustive-deps` 规则定义缺失报错为基线问题(改动前已存在) | 已记录 |
| 8 | `notes/NotesCrepeEditor.tsx` 工具栏(阅读模式等按钮 h-7 w-7=28px) | 体验 | 低 | 移动端触控目标 <44px;但工具栏空间受限属设计权衡,Crepe 工具栏整体在移动端的可用性归 F6 走查统一评估 | 待 F6 评估 |
| 9 | `command-palette.css` | bug/体验 | 中 | 触屏三缺陷:① 收藏星标 `opacity:0` 依赖 hover 显现,触屏永不可见;② 模式/关闭按钮 28px 触控目标过小;③ 键盘提示页脚(↑↓/Enter/Esc)对触屏无意义占据纵向空间 | 已修复(#9) |
| 12 | 全库 33 个文件存在 `opacity-0 group-hover:opacity-100` hover-only 操作 | bug | **高** | 触屏设备无 hover,这些操作按钮永不可见。审计后分三类:**阻断型 16 处已修**(会话重命名/删除、附件移除、Anki 卡编辑/移除、技能收藏/启用、笔记标签改名/删除、OCR 引擎排序、维度管理、重索引、批改历史收藏/删除、题目选项删除、术语删除、快捷键编辑等);**有替代路径 14 处不动**(整卡可点/3 点菜单/长按 contextmenu/选中态显现/装饰性提示);**死代码 1 处**(TranslationHistory 无引用方);仅低危 2 处此前已带 coarse 变体(QuestionBankListView/ExamSheetUploader) | 已修复(#10) |
| 13 | `learning-hub/components/FolderTreeItem.tsx` 三点菜单 | 体验 | 低 | hover-only 但有长按 contextmenu 兜底;行高 h-7(28px)触屏偏密,常显 20px 按钮意义有限,改善需整行触屏加高(结构性) | 建议(协商级,归学习中心组评估) |
| 14 | `MessageItem.tsx` 历史消息 footer 操作 `md:opacity-0 md:group-hover` | 体验 | 低 | <768 移动端常显 ✓;但 ≥768 触屏平板(Android 平板横屏)hover-only。平板适配整体属后续专项 | 已记录(随 #11 横屏专项) |
| 10 | 全库 framer-motion 直接 `import { motion }` | 性能 | 低 | 未用 LazyMotion/domAnimation 按需加载特性集;但 ChatV2 等重页面已整体懒加载,增量收益有限,改造需触碰多特性组件 | 建议(协商级,暂不动) |
| 11 | 横竖屏:横屏手机(高 <768 宽 ≥768)按桌面布局渲染 | 体验 | 低 | isSmallScreen 仅看宽度;横屏手机显示桌面双栏布局,空间利用合理但触控目标偏小;属设计权衡,真机验证后再裁决 | 已记录(待真机) |

### 浏览器冒烟测试(2026-06-12,Vite dev + 390×844 移动视口仿真)
- ✓ 移动壳渲染正常:UnifiedMobileHeader(汉堡/标题/新会话)+ 三屏布局;
- ✓ 侧栏打开正常:会话列表 + 底部导航(Smart Chat/Learning Hub/待办/Skills/Card Tasks/Template/Settings);
- ✓ Settings 以底部抽屉(bottom sheet)形式打开,拖拽把手+横向可滚 tab,390px 排版无溢出;
- ✓ 用户协议弹窗 390px 排版正常(卡片全宽、内容可滚、按钮可达);
- ⚠ 纯 Web 预览无 Tauri 后端:`invoke` 全部失败 → 协议同意无法持久化(每次挂载重弹)、会话列表报
  "Cannot read properties of undefined (reading 'invoke')"——**环境产物,非产品 bug**(真机/桌面 Tauri 正常);
  数据驱动视图(待办/制卡看板)无法在纯 Web 下深测,留待真机验证。
- ⚠ 观察到 i18n 中英混排(导航"待办"为中文、其余英文;Settings 标题英文+副标题中文)——跨横切问题,已登记跨组问题表。

### 全局健康项(审阅通过,无需改动)
- G2 触控契约:`--touch-target-size: 44px` 在 Button/Input/Select 原语层生效(`buttonPrimitiveContract.ts` h-[44] + lg: 降回桌面尺寸),`useTouchFriendlyDndSensors` 长按 250ms/容差 8px 统一拖拽语义;`responsive-utilities.css` 有意废除全局 44px 强制(避免按钮膨胀),改用 `.touch-target` 显式标注 —— 设计合理。
- G3 软键盘:InputBarUI 用 visualViewport resize/scroll + focus/blur 计算 keyboardInsetPx(>80px 才认定为键盘,防误判),bottomGap = 安全区 + gap + 键盘 inset;iOS 16px 输入字号防自动放大(ios-safe-area.css @supports 隔离);笔记"阅读模式"为手动切换(进入前 flush 草稿)——可靠。
- G5 Android 返回键:MainActivity(enableEdgeToEdge + OnBackPressedCallback)→ window.__DEEP_STUDENT_HANDLE_BACK__ → androidBackCoordinator(优先级栈 overlay 100/view 50/nav 0,同级后注册先执行)→ Radix Escape 兜底 → 未消费 moveTaskToBack。8 个接入点:MobileSlidingLayout/NotionDialog/CommandPalette/TodoMainPanel/InputBarUI/TranslationPopover/InlineImageViewer/ExplainPopover + App 导航兜底。链路完整。
- G6 虚拟化基线:virtua 已用于 MessageList/FinderFileList/VirtualQuestionList/DndFileTree 等长列表。
- 安全区域消费:mobile shell 契约(--mobile-safe-area-top/bottom)在 UnifiedMobileHeader/MobileSidebarNavigation/Settings 生效;InputBarUI 独立用 --android-safe-area-bottom+env() 兜底,口径一致。

## 已实施的优化

| # | 改动文件 | 改动说明 | 验证结果 |
|---|----------|----------|----------|
| 1 | 22 个 CSS 文件 + SOTADashboardLite.tsx 内联样式:responsive-utilities/app/deep-student/modern-buttons/settings/api-config-section/pdf-reader/enhanced-pdf/notes-home/chat/chat-beautify/markdown/analysis/command-palette/shortcut-settings/CommonTooltip/AppMenu/SummaryBox/UnifiedTemplateSelector/TemplateManager/TemplateManagementPage/TemplateJsonPreviewPage/RealTimeTemplateEditor/MinimalTemplateEditor/LoadingScreen/FieldTypeConfigurator/Card3DPreview/FilterBuilder/BatchOperationToolbar/BatchEditDialog/AnkiCardPreviewModal/AIGenerationParams | 系统断点邻界 media query 归一:`max-width:768px→767.98px`、`767→767.98`、`640→639.98`、`480→479.98`、`1024→1023.98`(lg 邻界)、`1023→1023.98`;保留非系统断点自定义值(400/900/1200/1366)与触控设备规则(deep-student.css pointer:coarse + 1024 含界) | typecheck ✓ / stylelint 无新增(基线 3072)/ 相关单测 15 通过 |
| 2 | `src/hooks/useBreakpoint.ts` | useIsMobile 改为 `!(min-width:768px)` 精确取反;useIsTablet 上界改为 `!(min-width:1280px)`,消除小数视口宽度下与 isSmallScreen 的不互补 | typecheck ✓ / eslint ✓ |
| 3 | `src/features/learning-hub/apps/views/NoteContentView.tsx` | 手写 767.98px 查询替换为统一 `useIsMobile()`(语义等价,收敛到单一来源) | typecheck ✓ / 既有 exhaustive-deps 报错为基线问题 |
| 4 | `src/features/chat/components/ChatContainer.tsx` | isMobile 兜底 `<= 768` → `< 768` 对齐断点契约 | typecheck ✓ / chat 相关单测 15 通过 |
| 5 | SA-1:`src-tauri/mobile/android/MainActivity.kt` + `src/utils/platform.ts` | Android 真实安全区注入(用户 2026-06-12 批准):原生监听 WindowInsets(systemBars+displayCutout,÷density 换算 CSS px),经 `__DEEP_STUDENT_SET_SAFE_AREA__` 注入;JS 端保留 24/15 fallback、消费 `__DEEP_STUDENT_PENDING_SAFE_AREA__` 暂存、clamp [0,200];注入时机:inset 变化(旋转/导航模式切换)+ WebView 创建后 0/500/1500/4000ms 补发 + onResume | typecheck ✓ / eslint 仅 no-console 警告与基线持平;Kotlin 无法本机编译验证(gen/android 项目未在仓库,需 `tauri android init` 后真机验证,已在接力须知登记) |
| 6 | F1:`src/features/chat/styles/chat.css` | 窄屏(<768)下 `.katex-display` 增加 overflow-x:auto,修复长块级公式横向溢出/被裁剪(桌面端保持 overflow visible 防上下标裁剪;与 MobileSlidingLayout C-9 横向滚动豁免天然协同) | stylelint 无新增 / typecheck ✓ |
| 7 | A8-2:`src/components/layout/MobileSlidingLayout.tsx` + `index.ts` + `features/learning-hub/LearningHubPage.tsx` | 手势豁免选择器升级:① 修正两个从未匹配的失效类名(`.ds-pdf__viewer`→`.ds-pdf-viewer`、`.mindmap-canvas`→`.mindmap-container`/`.react-flow`)——此前 PDF 捏合缩放/导图节点拖拽会被三屏布局手势劫持;② 提为 `DEFAULT_GESTURE_IGNORE_SELECTOR` 默认值,ChatV2 右面板(PDF/导图/笔记)、NotesHome(ProseMirror)等 7 个使用方自动受益;LearningHubPage 收敛复用同一常量 | typecheck ✓ / eslint 0 错误(5 个警告均为基线已有) |
| 8 | SA-2 安全区口径统一:`GlobalPomodoroWidget.tsx`、`UnifiedNotification.css`、`QuestionBankEditor.tsx`、`InlineImageViewer.tsx`、`responsive-utilities.css` | 5 处裸 `env(safe-area-inset-*)`(Android WebView 取不到值)统一为项目约定 `var(--android-safe-area-*, env(...))`/fallback 变量形式;`.safe-area-left/right/all` 接入 SA-1 新增的 left/right 变量 | typecheck ✓ / eslint:涉及文件的 4 个 error 均为基线已有(三元语句风格+exhaustive-deps 规则缺失,位于未触碰行) |
| 9 | F8:`src/command-palette/styles/command-palette.css` | 触屏适配补丁(`@media (pointer: coarse)`):收藏星标常显(opacity 1+32px 触控区)、模式/关闭按钮 28→36px、隐藏键盘快捷键提示页脚 | stylelint:17 个报错均为基线已有(alpha-value-notation 等,位于未触碰行),新增块 0 错误 |
| 10 | hover-only 触屏可达性修复(16 组件):`SessionBrowser.tsx`(重命名/删除常显+36px)、`AttachmentPreview.tsx`(附件移除 X 常显)、`ankiCardsBlock.tsx`(模板渲染态编辑钮常显+32px,点卡片是翻面无替代路径)、`SkillsList.tsx`(收藏星标+「启用」标签常显)、`AnkiPanelHost.tsx`(卡片移除常显)、`GradingHistory.tsx`(收藏/删除常显+星标徽章防重叠)、`NotesContextPanel.tsx`+`NoteTagsEditor.tsx`(标签 X/改名 70% 常显)、`MemoryTreePreview.tsx`(跳转钮 70%)、`IndexStatusView.tsx`(重索引常显)、`QuestionInlineEditor.tsx`(选项删除/图片删除)、`OcrEngineCard.tsx`(排序/操作常显)、`DimensionManagement.tsx`(行操作常显)、essay `SettingsDrawer.tsx`(维度删除 70%)、`PromptPanel.tsx`(术语删除 70%)、`ShortcutSettings.tsx`(快捷键操作常显) | 实现:TSX 组件用 `useMediaQuery('(pointer: coarse)')` 条件类(FinderFileItem N-4 同范式)或 `[@media(pointer:coarse)]:opacity-*` Tailwind 任意变体(QuestionBankListView 既有惯用法)。typecheck 全仓 ✓;eslint 涉改 16 文件 0 新增 error(基线 warning 不变);chat+ui-shell 单测 358/360 通过,2 个失败(spssProjectSkillLoader、InputBarUI.thinkingRuntimeState)经查源文件无工作区改动、与本组无关,为他组/基线问题 |

## 跨组问题(发现但不属于本组职责域)

| # | 涉及文件 | 问题描述 | 建议归属代理 |
|---|----------|----------|--------------|
| 1 | locales/* + 各组件 | i18n 中英混排:移动端导航"待办"为中文、其余英文;Settings 标题"System Settings"(英)+ 副标题"应用偏好与数据选项"(中)。语言资源完整性属横切问题 | 代理 7(架构/约定)或各特性组自查 |

## 共享文件改动登记

| # | 文件 | 改动段落/函数 | 原因 |
|---|------|---------------|------|

## 接力须知

- 我是 feed 会话 F-STJWA(mcp-feedback-enhanced),接力会话请继续用该 feed_id 轮询/汇报。
- 环境注意:工作区被多个代理并行修改(src-tauri 多文件他组改动),**禁止 git stash/checkout 全局操作**;
  验证只跑与自己改动相关的范围。npm 依赖如再缺失用 `npm install --legacy-peer-deps`,装完还原 package-lock.json。
- `npm run lint:css` 在 Windows PowerShell 下脚本 glob 失效,直接 `npx stylelint "src/**/*.css"`。
- SA-1(Android 真实安全区注入)已实施但 **Kotlin 侧无法本机编译**(仓库无 gen/android 工程):
  下次有 Android 构建环境时跑 `npm run tauri android dev` 真机验证旋转/手势导航/三键导航三种形态;
  MainActivity.kt 是受控副本,`tauri android init` 后需同步到 gen 工程。
- 基础设施摸底结论(已读):
  - 断点单一来源 `src/config/breakpoints.ts`(sm 640/md 768/lg 1024/xl 1280/2xl 1536);
    `useBreakpoint().isSmallScreen`(<768)= App shell 切移动布局的依据;`useIsMobile()` 同源。
  - 平台检测 `src/utils/platform.ts`:isAndroid/isAndroidWebView/isMobilePlatform(UA 嗅探);
    Android 安全区域用固定 fallback 值(top 24px/bottom 15px)注入 CSS 变量——真机 inset 不读系统值,留意。
  - `MobileLayoutContext`:openSidebar(sessions/learning-hub/navigation 三选一)+ fullscreenClaims(Set 计数)。
- isMobile/useBreakpoint 引用点清单已 grep(约 55 文件),逐特性走查时按清单过。

## 总结(2026-06-13 收尾)

**审阅覆盖**:G1~G7 全局横切 + F1~F8 逐特性,共 15 项全部完成;
浏览器移动视口(390×844)冒烟实测移动壳/侧栏/Settings/协议弹窗。

**发现统计**:11 项(中严重度 3:断点错位/安全区固定值/命令面板触屏缺陷;低 6;基线环境 1;跨组 1)。

**已实施优化 10 批**(全部低风险、验证通过):
1. 22 个 CSS 文件系统断点邻界归一(768→767.98 等,消除 iPad mini 竖屏混合态);
2. useIsMobile/useIsTablet 精确取反(小数视口宽度互补);
3. NoteContentView 收敛到 useIsMobile();
4. ChatContainer isMobile 兜底 <768 对齐契约;
5. **SA-1 Android 真实安全区注入**(用户批准立项):MainActivity.kt WindowInsets 监听 → __DEEP_STUDENT_SET_SAFE_AREA__ → CSS 变量,保留 24/15 fallback;
6. 移动端 KaTeX 长公式横向滚动(防溢出);
7. 手势豁免选择器修复(.ds-pdf-viewer/.mindmap-container/.react-flow 失效类名)+提为默认值;
8. SA-2 安全区口径统一(5 处裸 env() → --android-safe-area-* 变量);
9. 命令面板触屏适配(收藏星标常显/按钮 36px/隐藏键盘提示);
10. **全库 hover-only 操作触屏可达性审计与修复**:33 个含 `opacity-0 group-hover` 文件逐一审计,
    16 个组件的阻断型操作(触屏永不可见且无替代路径)改为 coarse-pointer 常显——
    含会话重命名/删除、聊天附件移除、Anki 卡编辑、技能收藏等高频路径(发现 #12)。

**待用户/真机裁决**:
- SA-1 需 Android 真机验证(旋转/手势导航/三键导航);MainActivity.kt 为受控副本,`tauri android init` 后需同步 gen 工程;
- 横屏手机按桌面布局渲染(审阅发现 #11)——真机体验后裁决;
- framer-motion LazyMotion 包体优化(协商级,#10);
- tailwind xs:480 未收录 breakpoints.ts(#5,归代理 7);
- i18n 中英混排(跨组问题 #1,归代理 7 或各特性组)。

**验证状态**:typecheck 全仓 ✓;ui-shell/legal/chat 相关单测 24 通过;stylelint/eslint 涉改文件零新增错误(基线 3072/既有 error 不变)。
