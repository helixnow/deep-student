# 0824 Wave2-C 台账

- 基线：origin/cursor/0824-cde6 @ 061b4815；本枝 cursor/0824-wave2-mobile-uiux-a875（HEAD 29ca02d9，即基线上加一个 bootstrap 提交）；PR #347
- 说明：docs/0824-quality-review/* 在 tip 不存在（已核实目录），本会话以用户任务书 P1–P8 + 仓内 docs/dev/mobile-uiux-unify/ 五条规范（①全局顶栏唯一 ②左侧按钮语义 ③右侧≤2×44px ④禁桌面组件滥用 ⑤可达且可回退）为准
- 第 1 轮只做静态审阅；本台账「已验证」栏只写静态 grep/读文件证据，**不写「测试已跑绿」**——本轮未运行任何 npm/npx/node/tsc/vitest/tauri/CI
- 汇总来源：docs/dev/wave2-C-r1/01–09 共 9 份扫描报告（原文见该目录，本台账不改写原文）

---

## P1–P8 归组

状态口径：属实 / 部分属实 / 否。优先级：P0（本波必修，回归/高危）> P1（本波应修）> P2（机制债，2–5 轮内收敛）> P3（观察/折衷，不派修）。

### P1 AppMenu portal 外点误杀 Composer 面板 —— 属实（高危），优先级 P0

- **机制**：InputBarUI 的 document `pointerdown` 外点关闭只认三个 ref（`panelContainerRef`/`composerPanelOverlayRef`/`inputContainerRef`，InputBarUI.tsx:1387-1420，监听 :1414），**不认 `[data-app-menu-id]`**；而同文件键盘焦点门控已特判该属性（:1064-1066，M3 修复）。AppMenu 内容 portal 到 body（AppMenu.tsx:491-543，子菜单 :972-1004 无条件 body），菜单项动作在 `click` 才执行（AppMenu.tsx:597-601），pointerdown→click 之间的空窗被宿主抢先卸载 → 动作丢失。
- **实锤链路**（07 报告 §2.1）：附件面板「更多」菜单（AttachmentPanelBody.tsx:151-192，资源库/拍照/全部清除）一点即面板塌、动作丢。**双端都中招**（:1387 无 isMobile 门控），桌面语义验证归 B 组。
- **同构扩散面**（07 报告 §1.2）：全库 28 处 document 级外点监听**无一认 `data-app-menu-id`**；已确认同构隐患：`shad/Popover.tsx:71`（Popover 内嵌 AppMenu 同 bug）、`DockItem.tsx:275`（桌面，通报 B）。次级同源：AppMenu 根级 Esc 不 preventDefault（AppMenu.tsx:82-89）→ 一次 Esc 关两层。
- **机制化修法**：第 2 轮短修——InputBarUI 外点判定抽共享谓词 `isWithinComposerLayers(target)`（三 ref + `closest('[data-app-menu-id]')`，与 :1066 对称），同轮补 pointerdown-portal 回归测试；第 3–5 轮长修——OverlayCoordinator 扩展浮层归属登记（`registerInteractiveOverlay` 已在，07 报告 §2.3），28 处外点监听渐进迁移。**不采用**给 ComposerPanelOverlay 打 `data-overlay-container` 的路线（外壳 overflow-hidden 会裁菜单，07 报告已否决）。
- 已验证：静态读码 + grep（01 报告 §二 P1、07 报告 §1.2/§2）。未验证：真机触发链路。

### P2 附件清理双所有者（实为三所有者 + 路径不一致）—— 属实，优先级 P1

- 清理职责分裂：store `removeAttachment/clearAttachments`（sessionActions.ts:204-306）**缺 cancelPdfProcessing**；UI `AttachmentPanelBody`（:91-128）做全套又转调 store 重做一遍；**chip X 路径（AttachmentPreviewChips.tsx:352-357）裸 onRemove，不取消后端**——移动端最常用的删除入口走的是最不完整的清理，后端任务变孤儿（01 报告 P2 表）。
- **机制化修法**（第 2 轮）：清理收敛为 store 单一所有者——`cancelPdfProcessing` 移入 sessionActions，删 AttachmentPanelBody 的 UI 层重复清理，chips 自动继承；**两文件必须同一人同轮打包**，避免中间态双取消。宿主卸载兜底 revoke（InputBarUI.tsx:1731-1739）保留。补删除路径等价性契约测试。
- 已验证：三处清理代码逐行比对（01 报告 P2 证据表）。未验证：后端孤儿任务实际行为。

### P3 伪元素扩区重叠 / 水位环双重扩区 —— 属实，优先级 P1（收敛入 44px 机制工程）

- ComposerToolbar 右簇 `gap-2`（8px）+ 相邻控件各 `-inset-2`（:211/:617/:832）→ 命中区互相重叠约 8px；水位环外壳（ContextUsagePopover.tsx:87-95）+ 内层 span（ComposerToolbar.tsx:211）**双层扩区嵌套**；环是弹层触发器却标 `role="img"`（:207-211）。
- 全库面（09 报告）：`[@media(pointer:coarse)]` 散点 **4079 处**；伪元素扩区 169 处/81 文件，其中 **25 行裸扩区未套 coarse 门控**（FinderFileItem.tsx:344、TodoAppWindow.tsx:93、TabBar.tsx:286/306 等，桌面鼠标也被扩区）；COARSE_HIT 常量 **至少 8 份拷贝、4 种参数**无共享出口。
- **根因**（09 报告 §3.1）：DsButton primitive 尺寸压缩条件是 `lg:` 视口断点而非 `pointer:coarse` 指针类型——iPad 横屏/触屏笔记本拿到 32px，1335 处 `!min-h-11` 全是调用点在手工补 primitive 没给的保证。连 DsDialog 自己都在打补丁（DsDialog.tsx:504/523）。
- **机制化修法**（禁止散点 44px，按 09 报告四批走）：批 1（第 2 轮）ComposerToolbar+水位环簇改容器分配触控位、私有三档常量上收共享 `coarseHit` 出口、role=img→button 语义；批 2（第 3 轮）`buttonPrimitiveContract.ts` coarse min-h/min-w 下沉（契约冻结区，须带 19 项契约测试同步）；批 3（第 3–4 轮）lint 规则 `ds-components/coarse-touch-target`（warn+白名单，骨架照抄 no-arbitrary-font-size）；批 4（可选 codemod）批量清冗余覆盖。**不派 200 个手修点当任务。**
- 已验证：grep 计数与逐点读码（01 报告 P3、09 报告 §1/§2/§3）。未验证：真机命中区实测。

### P4 (pointer:coarse) 兼当移动+触摸+相机 —— 部分属实，优先级 P2

- **证伪的一半**：布局分支没有用 coarse——一律 `isMobile` 断点（InputBarUI.tsx:319-324 双轨声明，:2133/:2558 等全核对属实）。
- **证实的一半**：`isMobileEnv = useMediaQuery('(pointer: coarse)')`（:804-808）直接决定相机入口（ComposerPlusMenu.tsx:315/475、AttachmentPanelBody.tsx:172/225，配 `<input capture>` :2573）。coarse 指针 ≠ 有摄像头。
- **机制化修法**（第 3–4 轮）：相机入口改捕获能力探测（`enumerateDevices` videoinput，Tauri WebView 可行性需验证）或平台判定与 coarse 求与；`isMobileEnv` 更名 `hasCoarsePointer` 阻止继续被当「移动环境」复用。触控 CSS 继续用 coarse 不动。
- 已验证：全部消费点静态核对（01 报告 P4）。未验证：触屏 Windows/带键鼠平板实机表现。

### P5 ComposerInlinePanel closing 无 inert / 160px 硬下限 / 硬编码 aria-label / role=img —— 属实（四小项全实），优先级 P1

- ①closing 期内容挂载可聚焦、无 inert 无 aria-hidden（ComposerInlinePanel.tsx:50/63-65，全目录 grep 无 inert）；②`clamp(160px,…)` 在小屏+iOS overlay 键盘下把面板硬撑超出可视视口（:51-54，桌面同名常量只用于翻转 placement 而非硬撑，ComposerPanelOverlay.tsx:10/97-99）；③`inlineAriaLabel = 'MCP'/'Skills'` 硬编码（InputBarUI.tsx:2158/2167-2171）；④role=img 并入 P3。
- **机制化修法**（第 2 轮）：①② ComposerInlinePanel 一处解决（closing 加 inert，min 改 `max(0px,…)` 或随 `--keyboard-inset` 二段 clamp）；③换 t() 词条，顺 P1 修 InputBarUI 时一并带走。
- 已验证：读码 + grep（01 报告 P5）。未验证：键盘态真机布局。

### P6 动态 i18n 键盲区 —— 部分属实（盲区实、Composer 侧缺键否；sidebar 侧缺键实且已补），优先级 P1（测试侧）

- 契约测试只匹配字面量键、自述模板键不在范围（inputBarSplitI18nKeys.contract.test.ts:16-17/:34）；模板键清单见 01 报告 P6；**当前 Composer 侧未实际缺键**（locale JSON 已核对）。文件清单缺 AttachmentPreviewChips/ContextUsagePopover/ComposerInlinePanel/ComposerPanel 四文件。
- **实际缺键在 sidebar**（06 报告 §4）：`sidebar:mobile_drawer.section_study/section_manage` zh/en 双缺，**v0.9.44 既有债非 0824 回归**，第 1 轮已补齐两份 JSON（见「第 1 轮已落地」）。
- **机制化修法**（第 2 轮测试卡）：契约测试升级为「模板键前缀 × 枚举域」展开校验 + 补 4 文件进 SPLIT_INPUT_BAR_FILES。
- 已验证：测试文件读码 + locale JSON 逐键核对 + python3 json.load 语法校验（01 报告 P6、06 报告 §4）。未验证：vitest 实际运行。

### P7 PDF / EPUB 移动 chrome —— 大面合规，1 个机制性缺口（V1）+ 3 项债，优先级 V1=P1、其余 P2

- **V1（新发现，高危同族）：PdfSelectionActions 返回键 handler 无可见性守卫**（PdfSelectionActions.tsx:77-83，panelOpen 时无条件 return true）——**保活吞 back**：ViewLayerRenderer keep-alive 隐藏的 PDF 实例若残留打开的解释/翻译面板，会吞掉当前活跃页面的系统返回键。同文件体系里 EnhancedPdfViewer.tsx:1260-1266 已有 isConnected/getClientRects/visibility 三重守卫、EpubPreview.tsx:150-156 用 isActive prop，PdfSelectionActions 两者皆无。**现有 source test（pdfSelectionToolbar.source.test.ts:104-107）只断言 handler 存在，事实上钉住了缺陷现状，修复时必须同步改测试。**
  机制化修法（第 2 轮）：不在第三处手抄守卫——在 androidBackCoordinator 提供 `registerVisibilityGuardedBackHandler(elementRef, fn, priority)`，EnhancedPdfViewer 与 PdfSelectionActions 共用。
- V2（债，不再扩散）：PDF 侧 ~20 处内联 coarse 44px 手贴（PdfReader/EnhancedPdfViewer/TextbookPdfViewer 逐行清单见 03 报告），应收敛进 `enhanced-pdf.css` 既有 coarse 块，测试断言目标同步迁移。归入 P3 机制工程节奏（第 3 轮）。
- V3（低）：EnhancedPdfViewer.tsx:389-411 手写 matchMedia 断点样板，建议补 `useViewportBelow(px)`/`useCoarsePointer()` 通用 hook；640 断点是文档化设计不动。
- V4（低）：`MOBILE_BOTTOM_INSET_PX = 132` 魔数（PdfSelectionActions.tsx:37）与 CSS 变量（enhanced-pdf.css:1599-1602）会静默分叉，改为运行时读 computed 变量或共享常量+source test 钉住。
- O1/O2（观察，不判违规）：PDF 移动 panel 自绘子屏 header、EPUB 工具条 52px 横条，当前形态可接受。
- 已验证：逐文件核验表 + back 链 file:line 索引（03 报告 §一/§二）。未验证：keep-alive 吞 back 真机复现。

### P8 键盘 inset 与 Android back 链 —— 底座健康不重写；2 个加法点，优先级 P1

- **底座结论**（08 报告）：useKeyboardHeight 单例（双端分支表见 08 报告 §1）、androidBackCoordinator（overlay 100→Radix Escape 兜底→view 50→navigation 0→moveTaskToBack，同档栈语义后注册先执行）、mobileShell（47 行）——结构自洽，**不重写，只做加法**。全库 back 注册点 ~70 处已列全表（08 报告 §2），Composer 面板/AppMenu/InputBarUI 注册无缺失，「先关菜单再关面板再收抽屉」链路静态核实成立。
- **发现 #1：useKeyboardInset 双轨**——`src/features/settings/hooks/useKeyboardInset.ts` 是独立旧实现（阈值 80 vs 单例 150、innerHeight vs clientHeight、无旋转基线重置），唯一消费方 ShadApiEditModal（:50/:166）。修法（第 2 轮）：ShadApiEditModal 改 import `@/hooks/useKeyboardHeight`，旧 hook 删除或 re-export，一行级迁移。
- **发现 #2：显式 overlay handler 与 Radix 兜底错序风险**——自绘面板（已注册 overlay）之上叠未显式注册的裸 Radix 浮层时，back 先关下层。仅 Settings.tsx 用了 `hasOpenRadixOverlayBesides` 让行。修法（第 2 轮）：排查 InputBarUI 组合面板、McpToolsSection、TodoItemDetail 等，按 Settings 模式补让行，纯加法一处一行。
- 另：TimedPracticeMode `overlay + 1`（唯一非标准档，语义正确）建议提具名档或注释登记。
- 测试空白（给序列测试轮）：androidBackCoordinator 与 useKeyboardHeight **均零单测**；建议序列级契约「抽屉开→面板开→菜单开→连按 back」固化消费顺序。
- 已验证：底座逐行读码 + ~70 注册点全表 + 不变量 18 静态自证（NOTICES/Composer 拆分/44px/safe-area/back 桥，08 报告 §4）。未验证：真机 back 序列。

### 扫描员新发现补充归组（用户任务书之外）

| 发现 | 状态 | 关键出处 | 修法轮次 | 优先级 |
|---|---|---|---|---|
| learning-hub F1：笔记移动上下文子屏自绘返回行，右屏双 chrome | 属实（FAIL 轻） | NoteContentView.tsx:986-1002 | 第 2 轮：改 useMobileSubviewChrome，无宿主时降级自绘（Context 已内建降级） | P1 |
| learning-hub F2：「移动到…」inline 子屏无中屏 chrome 宿主 | 属实（FAIL 轻） | FolderPickerDialog.tsx:302-316；宿主门控 LearningHubPage.tsx:720 | 第 2 轮：SubviewChrome 注册带 screen 标记、host 按屏位匹配接管（改 Context+Page 两处，不碰 finder 逻辑） | P1 |
| learning-hub F3：FinderQuickLook 无 registerBackHandler，Android 返回键关不掉 | 属实（FAIL 轻，触屏无入口故低危） | FinderQuickLook.tsx 全文无注册；对照 LearningHubContextMenu.tsx:333-339 | 第 2 轮：补 overlay 档注册 + 关闭钮 44 对齐 | P1 |
| learning-hub F4：特殊视图下移动工具栏叠双条 | 折衷→建议 | LearningHubSidebar.tsx:3315 vs 3824 | 第 2 轮：共享 `CHROME_EXEMPT_VIEW_KINDS` 常量门控 | P2 |
| learning-hub F10：顶栏右侧 ≤2×44 仅注释约定无守卫 | 缺口 | UnifiedMobileHeader.tsx:197-200 | 第 2 轮测试卡 T1：source 契约计数 | P1（测试侧） |
| settings 宽表：数据治理三张宽表横滑未卡片化 | 属实（规范④精神违背） | BackupTab.tsx:923-1103（6 列+每行 4 图标动作，最重）；SyncTab.tsx:290-366；AuditTab.tsx:186-237；OverviewTab.tsx:354-357 | 第 2–3 轮：共享 `ResponsiveDataList`（≥md 表格、<md 卡片行），优先 BackupTab；**禁触 WebDAV/S3/FTP 逻辑（不变量 13–15）** | P1 |
| settings 孤立 <44px：快捷键折叠钮、AuditTab 两个 AppSelect | 属实 | WorkbenchSettingsSection.tsx:742；AuditTab.tsx:149-178 | 第 2 轮最小修；根治靠 AppSelect/Input 基座纳入触控契约（随 P3 批 2） | P1 |
| settings 保存入口不对称：mcpTool/mcpPolicy 底部 footer vs vendorConfig/modelEditor 顶栏 | 备注（非违规） | Settings.tsx:670-698 vs McpEditorSection.tsx:1661/1818 | 第 3 轮：settingsHeaderRightActions 补两 case 统一 | P2 |
| anki/qbank：批量 Checkbox 16px 裸用无热区（唯一硬违规） | 属实（v0.9.44 既有债） | ankiCardsBlock.tsx:2971-2977；基元 shad/Checkbox.tsx:15 无 coarse | 第 2 轮：Checkbox 基元补 coarse 热区，删 QuestionBankManageView:686/812/843 手抄 | P1 |
| anki/qbank：吸底条 <sm 可访问名丢失 | 属实（既有债） | QuestionBankManageView.tsx:1143-1161 | 第 2 轮：图标钮补 aria-label | P1 |
| anki/qbank：coarse 散点模式 0→~90 处（「打掉默认再补回」） | 属实（0824 回归引入的模式债，G 波 "enlarge leftover" 系列） | AnkiTasksApp/SessionRow/practice 全目录/ankiCardsBlock，清单见 04 报告 | 随 P3 批 2 下沉后整批删；桌面压缩改 `lg:` 前缀 | P2 |
| overlay：AppMenu 定位缺 visualViewport 监听（软键盘弹出菜单不重定位） | 属实 | AppMenu.tsx:388-389；正确对照 ComposerPanelOverlay.tsx:150-175 | 第 3–4 轮：改共享组件须先通报 B 桌面回归面（60 消费点共用） | P2 |
| overlay：AppMenuSubContent 恒 portal body 的 stacking 结构债 | 属实（无显性受害者） | AppMenu.tsx:1003 | 记录，随长期 coordinator 方案 | P3 |
| INVENTORY.md L11 task-dashboard 备注过时 | 文档陈旧 | docs/dev/mobile-uiux-unify/INVENTORY.md:11 vs AnkiTasksApp.tsx:506 | 第 2 轮顺手回写 | P3 |

---

## 五条规范逐页核验表

汇总自 9 份报告的逐页表，按域折叠；明细 file:line 见各原文。符号：PASS / FAIL(轻/重) / 折衷。

### learning-hub（02 报告 §一，24 行明细）

| view/子屏 | ① | ② | ③ | ④ | ⑤ | 出处 |
|---|---|---|---|---|---|---|
| 页面壳三屏 LearningHubPage | PASS | PASS | PASS | PASS | PASS | 02 §二.1（useMobileHeader :723-750；PanelGroup 仅桌面分支 :1299-1387） |
| 中屏文件列表/工具栏/容量视图 | PASS | PASS | PASS | PASS | PASS | 02 表 #3/4/9 |
| 中屏「移动到…」FolderPicker inline | **FAIL(轻)** | 折衷 | — | PASS | PASS | F2，FolderPickerDialog.tsx:302-316 |
| 特殊视图 Memory/IndexStatus/Desktop | PASS | PASS | — | PASS | PASS | 02 表 #6/7/8（F4 双工具条另记） |
| 右屏 TabBar | PASS | — | — | 折衷 | PASS | F6 已登记折衷（38px+伪元素补 44，TabBar.tsx:237-241） |
| 右屏 NoteContentView 主体 | PASS | PASS | PASS | PASS | PASS | 02 表 #11 |
| 右屏笔记上下文子屏（移动） | **FAIL(轻)** | 折衷 | — | PASS | PASS | F1，NoteContentView.tsx:986-1002 |
| 右屏 Image/Textbook/Exam/Translation | PASS | PASS | PASS | PASS | PASS | 02 表 #13/14/16/17 |
| 浮层 FinderQuickLook | PASS | — | — | PASS | **FAIL(轻)** | F3，无 registerBackHandler |
| 其余浮层/底栏/finder 件 | PASS | — | — | PASS | PASS | 02 表 #18/20/23 |

### PDF / EPUB（03 报告 §一）

| 文件 | ① | ② | ③ | ④ | ⑤ | 出处 |
|---|---|---|---|---|---|---|
| PdfReader | PASS | PASS | PASS | PASS | PASS | useMobileHeader('pdf-reader') :25-43；散点手贴记 V2 |
| EnhancedPdfViewer | 折衷(O1 子屏自绘 header) | 折衷 | PASS | PASS | PASS | back 链 :1254-1307 带三重守卫；断点自造记 V3 |
| TextbookPdfViewer | PASS | PASS | PASS | PASS | PASS | 纯包装层 |
| PdfSelectionActions | PASS | PASS | PASS | PASS | **FAIL** | V1：back handler 无守卫 :77-83（保活吞 back） |
| EpubPreview | 折衷(O2 内容工具条) | PASS | PASS | PASS | PASS | isActive 守卫 :150-156 是全仓正面样板 |
| UnifiedPreviewToolbar | PASS | PASS | PASS | PASS | PASS | 容器级 coarse 44 :172，机制化样板 |

### anki / qbank chrome（04 报告，只评 chrome）

| 页 | ① | ② | ③ | ④触控/组件 | ⑤ | 出处 |
|---|---|---|---|---|---|---|
| ankiCardsBlock（聊天卡片块） | PASS(不适用) | PASS | 折衷（右上触屏常显 3 钮 ~140px 遮卡面） | **FAIL**（批量 Checkbox 16px 裸用 :2971-2977）+ 散点债 ×16 | PASS | 04 页 1 |
| anki-tasks 任务台 | PASS | PASS | PASS | 折衷（反机制覆盖再 coarse 补回，AnkiTasksApp/FailedTasksPanel 清单见 04） | PASS | 04 页 2 |
| QuestionBankManageView | PASS | PASS | 折衷（吸底条 <sm 可访问名丢失 :1143-1161） | PASS（<768 卡片化正面样板） | PASS | 04 页 3 |
| QuestionInlineEditor | PASS | PASS | PASS | 折衷（chip 热区横向不扩 :1039 + 散点债） | PASS | 04 页 4 |
| practice 全目录 + ReviewQuestionsView | PASS | PASS | PASS | 折衷（~30 处冗余 coarse 散点，0824 回归） | PASS | 04 页 5 |

### 设置 / 数据治理（05 报告 §一，16 行明细）

| 页 | ① | ② | ③ | ④ | ⑤ | 出处 |
|---|---|---|---|---|---|---|
| Settings 移动壳（Sheet+hidden 注册） | PASS（机制化例外，备注 A） | PASS | PASS | PASS | PASS | Settings.tsx:703-705/:1982-2023；四级回退链 :542-569 |
| 各设置分区（General/Appearance/Engine/Memory/Pdf/Sync） | PASS | — | — | PASS | PASS | 05 表 |
| WorkbenchSettingsSection | PASS | — | — | 折衷（:742 折叠钮 <44） | PASS | 05 问题 1 |
| McpEditor / McpTools / VendorDetail | PASS | PASS | 折衷（保存入口不对称，备注 B） | PASS（coarse 常显+pointer-events 防误触是机制样板） | PASS | 05 表 |
| data-governance SyncTab | PASS | — | — | 折衷（4 列宽表横滑） | PASS | :290-366 |
| data-governance BackupTab | PASS | — | — | **FAIL 倾向**（6 列宽表+每行 4 动作，操作列初始视口外） | PASS | :923-1103 |
| data-governance AuditTab | PASS | — | 折衷（过滤器 <44 :149-178） | 折衷（5 列宽表横滑） | PASS | 05 问题 2/3 |
| DataGovernanceDashboard / DataImportExport | PASS | PASS | PASS | PASS | PASS | 05 表 + 备注 C |

### Chat 移动（Composer 面，01 报告 §三）

| 项 | ① | ② | ③ | ④ | ⑤ | 出处 |
|---|---|---|---|---|---|---|
| Composer 输入栏整体 | PASS（chat-v2 经 useChatPageLayout.tsx:168 注册，不自绘顶栏） | PASS（左「+」是功能入口非导航） | 折衷（右簇 3-4 交互件，44 靠伪元素扩区凑且相邻重叠，P3） | PASS（零 ResizablePanel/宽表；portal 全 `!isMobile` 网关；chip 删除 coarse 常显） | **FAIL(高危例外)**：P1 外点误杀使 portal 菜单「点了等于关面板」；back/Esc/外点/视图切换四通道本身齐全 | 01 §三 |

### 壳（06 报告 §5）

| 项 | 结论 | 出处 |
|---|---|---|
| ①顶栏唯一 | PASS：`data-mobile-shell="header"` 打点唯一来源 UnifiedMobileHeader.tsx:109，封禁契约锁定；16/16 CurrentView 注册全覆盖、与契约测试注册表逐条一致 | 06 §1/§5 |
| ②左键语义 | PASS：互斥决策链 showBackArrow > showMenu > 全局历史（UnifiedMobileHeader.tsx:61-73） | 06 §5 |
| ③右侧≤2×44 | 折衷：仅注释约定（:197-200），无收纳机制无契约测试（=learning-hub F10，全局缺口） | 06 §5 |
| ④禁桌面组件 | PASS：壳内零违规；drag-region 仅非移动平台 | 06 §5 |
| ⑤可达可回退 | PASS：三桶 16/16 无孤岛；回退三通道（顶栏/系统返回键/手势）；Android 10+ 手势热区抢占为已登记已知局限 | 06 §3/§5 |

---

## 第 4 轮已落地（附件动作统一 + 面板 a11y）

- **P2**：`cancelPdfProcessing` 进入 store `removeAttachment`/`clearAttachments`（只看 sourceId）；AttachmentPanelBody UI 只传 id；chip 路径自动继承。发送/流式段未入 diff。
- **P5**：ComposerInlinePanel closing/closed 走 inert DOM property + aria-hidden；clamp 改为二段下限。Skills/MCP region 改 t()。水位环 role=img 第 3 轮已去。
- **测试只写不跑**：三路径生命周期、inert/clamp source、焦点顺序（DOM 序=面板→输入→工具栏）。
- 观察：`pdfProcessingStore.remove` 仍嵌在 resourceId 分支（基线债），未本轮改。
- 原文 `docs/dev/wave2-C-r4/`。

## 第 3 轮已落地（触控目标体系化）

- **机制**：`TouchTarget` + `coarseHit.ts` 共享出口；`buttonPrimitiveContract` 在 `lg:` 后追加 `[@media(pointer:coarse)]:min-h/min-w-[var(--touch-target-size)]`（min 非 !h-11）。
- **lint**：`ds-components/coarse-touch-target` **warn** + 白名单（审阅后摘除 ComposerToolbar/MiniCalendar 僵尸项）。第 8 轮才升 error。
- **第一批替换**：ComposerToolbar/水位环去伪元素重叠，改实体盒；附件面板/PlusMenu 行高走 token。视觉 24/28/36 审阅通过。
- **P4**：布局仍 isMobile；触摸 any-pointer:coarse；相机 `canCapturePhoto`（platform，无 enumerateDevices）。R2 `isWithinComposerTerritory` 未动。
- **测试只写不跑**：命中 source 契约、规则单测、capabilities 单测。
- 原文 `docs/dev/wave2-C-r3/`。禁止散点 !min-h-11 全库手修。

## 第 2 轮已落地（浮层所有权与事件序）

- **P1 短期**：`InputBarUI.tsx` 抽出 `isWithinComposerTerritory`（三 ref + `closest('[data-app-menu-id]')`），外点 pointerdown 与焦点门控共用；bubble 未改 capture。顺手 `hasOpenRadixOverlayBesides` 让行。
- **长期最小实现**：`overlayOwnership.ts` + OverlayCoordinator 加法 `registerOwnedOverlay` / `isOwnedOverlayTarget`（tooltip API 未改）。本轮零生产接线，供第 3+ 轮替换过宽 closest。
- **AppMenu**：定位改 visualViewport（主菜单+子菜单），抽 `visualViewport.ts`；未改 ComposerPanelOverlay；打开/关闭/click/portal/back 未动。
- **back 链**：排序算法未改；注释登记同档 overlay 栈语义。静态核验「菜单→面板」已成立。
- **测试（只写不跑）**：pointer 三动作全链 + source 契约；back 栈语义 + InputBarUI 集成序列；卡 8 修了两处跨卡假红契约。
- **桌面通报 B**：宽屏桌面附件面板无「更多」AppMenu（移动分支才有）；共享层修复自动覆盖窄桌面窗口。DockItem 低危留 B。
- **事件序审阅**：通过（带风险）。R1 closest 过宽不限定 menuId——本轮不改，走 owned overlay。
- 原文归档 `docs/dev/wave2-C-r2/`。禁改区未动。

## 第 1 轮已落地

- **legacy: sidebar 缺键双语补齐**——`src/locales/zh-CN/sidebar.json` 与 `src/locales/en-US/sidebar.json` 的 `mobile_drawer` 各增 `section_study`（学习/Study）、`section_manage`（管理/Manage）。归因 **v0.9.44 既有债（P6），不是 0824 回归**：MobileSidebarNavigation.tsx:132-133 自引入分组起即引用该键，两份 locale 同缺，现网 en 用户看到未翻译中文 fallback。两份 JSON 已 python3 json.load 校验语法；`git status` 确认仅此 2 文件改动（+ 本目录文档）。既有键（section_app/section_chat/section_learning）未动。未 commit，待父代理统一提交，建议提交信息注明 `legacy(i18n)` 归因。
- **扫描报告原文归档** `docs/dev/wave2-C-r1/`（01–09 共 9 份，本台账不改写原文）。

---

## 第 2 轮任务卡草案（供父代理派发）

通用约束（写进每张卡）：**同文件同轮单人**；**P1（外点误杀）最高优先**；**禁止散点 44px 手贴**（一切触控目标问题走机制出口，见卡 9/10）；**禁止跑 npm/npx/node/cargo/tsc/vite/vitest/tauri/CI**（测试文件可以写，不可以跑）；不动 coordinator.rs / tool_loop / 缓存 / anki-qbank 域逻辑（FSRS/出题/评分/store 服务层）/ Composer 桌面专属语义（桌面回归面通报 B 组）；文档只追加。

### 卡 1｜Composer-外点与标签（P1 + P5③）——最高优先
- 文件：`src/features/chat/components/input-bar/InputBarUI.tsx`（本卡独占该文件）
- 要点：外点关闭（:1387-1420）抽共享谓词 `isWithinComposerLayers(target)` = 三 ref contains + `target.closest('[data-app-menu-id]')`，同时供焦点门控（:1058-1068）消费，保证两处判定对称（M3 同款认知）。顺手 :2158/:2167-2171 硬编码 `'MCP'/'Skills'` 换 t() 词条（`skills:title` 与 MCP 既有键）。注意 :2556 的 `onMouseDown stopPropagation` 是 mousedown 通道，勿误删（07 报告 §2.2 提醒）。
- 测试（写不跑）：新增「面板开 + pointerdown 落在 `[data-app-menu-id]` portal 内 → 不触发 closeAllPanels」回归用例挂 InputBarUI 测试族。
- 证据包：01 报告 P1、07 报告 §2。

### 卡 2｜附件清理单一所有者（P2）
- 文件：`src/features/chat/core/store/sessionActions.ts` + `src/features/chat/components/input-bar/AttachmentPanelBody.tsx`（**必须同一人同轮打包**，避免中间态双取消）
- 要点：`cancelPdfProcessing(att.sourceId)`（fire-and-forget+日志）移入 removeAttachment/clearAttachments；删 AttachmentPanelBody:91-128 的 UI 层重复清理；chips 路径自动继承；宿主卸载兜底 revoke 保留。
- 测试（写不跑）：面板删除与 chip 删除的清理等价性契约。
- 证据包：01 报告 P2 三所有者表。

### 卡 3｜Composer 右簇触控位与水位环（P3 批 1 + P5④）
- 文件：`src/features/chat/components/input-bar/ComposerToolbar.tsx` + `ContextUsagePopover.tsx`（同一控件内外层，同一人）
- 要点：右簇改容器分配触控位（coarse 下外层 `min-h-11 min-w-11` 真实占位），取消散点 after:-inset；水位环只留外层 trigger 一处扩区、内层 aria-hidden；`role="img"`→button 语义（`aria-haspopup` + keydown）；三档私有 COARSE_HIT 常量上收 `src/components/ui/coarseHit.ts` 共享出口（为第 3 轮批 2/3 打地基）。**不新增第四档 -inset 常量。**
- 证据包：01 报告 P3、09 报告 §2 重叠点 1-3、§5 批 1。

### 卡 4｜ComposerInlinePanel + i18n 契约（P5①② + P6）
- 文件：`src/features/chat/components/input-bar/ComposerInlinePanel.tsx` + `tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts`
- 要点：closing 期给内容容器加 inert（React 19 属性或 ref）；min 高度改 `max(0px,…)` 或随 `--keyboard-inset` 二段 clamp，键盘态允许内部滚动；契约测试升级模板键枚举展开（uploadStage×3、permissionPreset.{modes,hints,shortHints}×4、injectMode×3、thinkingDepth×档位）+ 补 AttachmentPreviewChips/ContextUsagePopover/ComposerInlinePanel/ComposerPanel 四文件进清单。
- 证据包：01 报告 P5①②/P6。

### 卡 5｜learning-hub 子屏 chrome 三修（F1+F2+F3，附 F4）
- 文件：`src/features/learning-hub/apps/views/NoteContentView.tsx`、`components/finder/FolderPickerDialog.tsx`、`components/finder/FinderQuickLook.tsx`、`src/components/layout/MobileSubviewChromeContext.tsx` + `LearningHubPage.tsx`（宿主两处）、`LearningHubSidebar.tsx`（F4）
- 要点：F1 改 useMobileSubviewChrome（无宿主降级自绘，Context 已内建）；F2 SubviewChrome 注册带 screen 标记、host 按 `activeSubviewChrome.screen === screenPosition` 接管（只改 Context+Page，不碰 finder 逻辑）；F3 补 overlay 档 registerBackHandler（LearningHubContextMenu.tsx:333-339 同范式）+ 关闭钮按伪元素范式对齐 44（非散贴）；F4 移动工具栏与 FinderBatchToolbar 共享 `CHROME_EXEMPT_VIEW_KINDS` 门控常量。
- 测试（写不跑）：02 报告 T2（子屏 chrome 通道 allowlist）、T3（自绘浮层必接返回键 source 扫描）、T6（门控常量共享）。
- 证据包：02 报告 §三 F1-F4、§四 T2/T3/T6。

### 卡 6｜PDF back 守卫与常量（P7 V1+V4）
- 文件：`src/app/navigation/androidBackCoordinator.ts`（加法：新增 `registerVisibilityGuardedBackHandler`，**不改排序/兜底逻辑**）、`src/features/pdf/components/PdfSelectionActions.tsx`、`EnhancedPdfViewer.tsx`（改用共享守卫）、`src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts`
- 要点：V1 保活吞 back——共享守卫替代三处手抄（内置 isConnected/getClientRects/visibility），PdfSelectionActions 复用宿主 containerRef；**同步改 source test :104-107 从「handler 存在」升级为「守卫存在」**（现测试钉住缺陷现状）；V4 132 魔数改运行时读 CSS 变量或共享常量+source test。
- 测试（写不跑）：补 PdfReader useMobileHeader 注册形态契约、EpubPreview isActive 守卫契约（03 报告缺口 3/4）。
- 证据包：03 报告 V1/V4 + 缺口清单。

### 卡 7｜settings 触控点与键盘双轨收敛（P8 发现#1 + 05 问题 1/2）
- 文件：`src/features/settings/components/ShadApiEditModal.tsx`、`src/features/settings/hooks/useKeyboardInset.ts`（删除或 re-export）、`WorkbenchSettingsSection.tsx`、`data-governance/AuditTab.tsx`
- 要点：ShadApiEditModal 迁移到 `@/hooks/useKeyboardHeight` 的 useKeyboardInset（一行级）；WorkbenchSettingsSection:742 裸 button 换 DsButton ghost；AuditTab:149-178 两个 AppSelect 补触控高（短期最小修，根治等 AppSelect 基座契约随第 3 轮批 2）。
- 证据包：08 报告发现#1、05 报告问题 1/2。

### 卡 8｜数据治理宽表卡片化（05 问题 3）
- 文件：新建共享 `ResponsiveDataList`（建议 `src/components/ui/`）+ `data-governance/BackupTab.tsx`（首站，6 列+4 动作最重）；SyncTab/AuditTab/OverviewTab 视工作量顺延第 3 轮
- 要点：≥md 渲染 shad Table、<md 卡片行（主字段+Badge+动作收「更多」菜单）；**仅动展示层，禁触 WebDAV decode_path / S3 normalize_endpoint / FTP 白名单（不变量 13–15）**——SyncTab.tsx:109-116 注释「不改引擎」边界保持。
- 证据包：05 报告问题 3、建议 3。

### 卡 9｜anki/qbank chrome 硬违规与可访问名（04 报告，仅壳层）
- 文件：`src/components/ui/shad/Checkbox.tsx`（基元补 coarse before:-inset-3.5 热区）、`src/features/chat/plugins/blocks/ankiCardsBlock.tsx`（仅壳：Checkbox 裸用受益于基元修复；右上 3 钮触屏收敛为「编辑+⋯」评估）、`src/components/QuestionBankManageView.tsx`（删 :686/812/843 手抄热区 + :1143-1161 图标钮补 aria-label）、`docs/dev/mobile-uiux-unify/INVENTORY.md`（L11 备注回写）
- 要点：**不触碰 FSRS/出题/评分/store 服务层**；闪卡只读不变量已核验完好（ankiCardsBlock 无 save_to_library 写回流，04 报告头部证据），保持。散点 coarse 债不在本卡手删，等第 3 轮批 2 下沉后 codemod。
- 证据包：04 报告页 1/3 违规项、机制化建议 2。

### 卡 10｜back 链让行加法 + 序列测试铺垫（P8 发现#2）
- 文件：`src/features/chat/components/input-bar/InputBarUI.tsx` back handler 段（**与卡 1 冲突——若同轮派发，此项让行内容并入卡 1 由同一人做**；否则顺延下一轮）、`src/features/settings/components/McpToolsSection.tsx`、`src/features/todo/components/TodoItemDetail.tsx`、`src/app/navigation/androidBackCoordinator.ts`（仅注释：BACK_PRIORITY 登记 TimedPracticeMode overlay+1 用法或提具名档）
- 要点：含裸 Radix 子浮层的 overlay handler 按 Settings.tsx:588-598 模式补 `hasOpenRadixOverlayBesides` 让行（纯加法一处一行）。测试（写不跑）：androidBackCoordinator 单测（优先级降序/同档 seq 栈语义/兜底插入点/异常吞噬）+ useKeyboardHeight 单测（阈值 150/基线重置/CSS 变量写入）——纯函数+jsdom 可测，为第 7 轮序列测试铺底。
- 证据包：08 报告发现#2、建议 2-6。

### 派发注意（同文件冲突矩阵）
- `InputBarUI.tsx`：卡 1 独占；卡 10 的 InputBarUI 项并入卡 1 或顺延。
- `androidBackCoordinator.ts`：卡 6 加新导出函数、卡 10 只动注释——若父代理担心冲突，卡 10 的注释项并入卡 6。
- `LearningHubPage.tsx` / `MobileSubviewChromeContext.tsx`：仅卡 5 触碰。
- 第 3 轮预告（不在本轮派发）：`buttonPrimitiveContract.ts` coarse 下沉（批 2，契约冻结区须带 19 项契约测试同步）→ lint 规则 `coarse-touch-target`（批 3）→ codemod 清冗余（批 4）；AppMenu visualViewport 定位（须先通报 B）；PDF 手贴收敛进 enhanced-pdf.css（V2）。

---

## 禁改区自检

- **coordinator.rs**：未动（git status 无任何 .rs 改动）。
- **tool_loop / hooks / 缓存**：未动。
- **anki/qbank 域逻辑**（FSRS/出题/评分/store 服务层）：未动；04 报告核验闪卡只读不变量完好（ankiCardsBlock 无 save_to_library 写回流；ChatV2AnkiAdapter 仅存 debug 目录无生产挂载）。
- **Composer 桌面专属**：未动；桌面 overlay/飞出层逻辑仅作对照引用（01/07 报告），桌面回归面已标注通报 B 组。
- **finder host buckets（不变量 10）**：未动（02 报告核验 FINDER_HOST_IDS 读写与不变量一致）。
- **WebDAV/S3/FTP（不变量 13–15）**：未动，且 05 报告确认所扫文件均不涉及该后端逻辑。
- **mobileShell / androidBackCoordinator 底座**：零改动（08 报告结论：不重写）。
- 工作区实际改动 = 2 份 locale JSON（第 1 轮缺键补齐）+ docs/dev/wave2-C-r1/（9 份报告）+ 本台账。未 git commit / push。

---

## 已验证 / 未验证

### 已验证（静态 grep / 读文件证据）
- 基线与分支：git log 确认 HEAD 29ca02d9 父提交 061b4815；docs/0824-quality-review/* 目录在 tip 不存在。
- P1 机制链：InputBarUI 三 ref 判定 vs :1066 焦点门控不对称；AppMenu portal/click 时机；28 处外点监听全表（07 报告）。
- P2 三所有者：三处清理代码逐行比对（01 报告表格）。
- P3/44px 全库统计：coarse 4079 处、伪元素扩区 169 处/81 文件、25 行裸扩区、COARSE_HIT 8 份拷贝、DsButton `lg:` 门槛根因（09 报告）。
- P6/i18n：Composer 模板键在两份 locale 均可解析（无实际缺键）；sidebar section_study/section_manage 双缺已补，JSON 语法经 python3 json.load 校验。
- P7 V1：PdfSelectionActions 无守卫 vs EnhancedPdfViewer 三重守卫/EpubPreview isActive 的代码对照。
- P8：useKeyboardHeight 双端分支表、~70 处 back 注册点全表、排序/兜底插入点实现与期望顺序一致、不变量 18 静态自证（08 报告）。
- 壳：16/16 CurrentView 注册与契约测试注册表逐条一致、三桶可达 16/16 无孤岛（06 报告）。
- 各域五条规范逐页核验表（01–05 报告，全部 file:line 锚定）。

### 未验证（需真机 / vitest / 门禁，本轮明确没做）
- 任何 vitest 运行结果（含既有契约测试是否通过）——本轮零执行。
- P1 外点误杀、P7 保活吞 back、P5 键盘态 160px 撑高、P4 触屏笔记本相机入口等的真机复现。
- Android back 序列（菜单→面板→抽屉→view→navigation）的运行时顺序。
- 编译/类型检查/lint/CI 门禁——全部未跑。
- 第 1 轮 locale 补键的渲染效果（仅静态核对键名与消费点一致）。

---

## 第 5 轮对账 / 第 6 轮首位欠账

对账基线 /workspace HEAD `cf8eb9e8`（r1–r4 已提交，工作树干净）；全部断言本轮重新 grep 取证，原文 `/tmp/0824-wave2-c-r5/09-reconcile.md`。对账时点第 5 轮仅 pdf-chrome 席位有在途未提交改动（androidBackCoordinator / EnhancedPdfViewer / PdfSelectionActions，即卡 6），其余七席位（chat/hub/settings/anki-chrome、check-i18n、i18n-alias、i18n-ast）工作树干净未落盘，其结果不计入本对账。

### P1–P8 状态一览

| 项 | 状态 | 一句话证据 |
|---|---|---|
| P1 | 部分 | 短修在（isWithinComposerTerritory :1058/:1404 共用）；**owned-overlay 零生产接线**（registerOwnedOverlay 仅本体+2 测试文件），closest 过宽未限定 menuId |
| P2 | 已落地（1 残债） | cancel 顶层 sourceId 守卫 :233-236；残债：pdfProcessingStore.remove 仍嵌 resourceId 分支 :249-250（孤儿附件 store 条目不清，r4-07 审阅点名两轮未修） |
| P3 | 部分 | 批 1–3 落地（契约 :73-83 coarse 下沉、lint 规则挂 warn+40 行白名单）；批 4 codemod 未做，~4000 散点存量原样，**warn 未升 error** |
| P4 | 已落地 | canCapturePhoto platform 判定；布局仍 isMobile（设计如此） |
| P5 | 已落地 | inert/二段 clamp/t()（skills:title 等双语键核验在）/role=img 已去 |
| P6 | 部分 | 缺键已补（R1）；**契约测试未升级**（无模板键枚举、四文件未入清单，grep 零命中）——第 5 轮 i18n 三席位在补，未落盘 |
| P7 | 未做→在途 | V1 吞 back 截至 HEAD 未修（PdfSelectionActions :79-81 仍无守卫，registerVisibilityGuardedBackHandler 全库零命中）；pdf-chrome 席位在途；V2/V4 未动 |
| P8 | 部分 | 发现#2 InputBarUI 让行已做+coordinator 测试 2 份已写；发现#1 未修（ShadApiEditModal:50 仍用旧 useKeyboardInset），McpToolsSection 让行、useKeyboardHeight 单测未做 |

扫描补充项：卡 5（learning-hub F1–F4）/卡 7（settings 触控+键盘双轨）/卡 8（宽表卡片化，ResponsiveDataList 零命中）/卡 9（Checkbox coarse 热区零命中）全部未做。按 10 卡计修复面 ≈ 4.9/10。

### 第 6 轮二检必须翻的前 5 项（按风险降序）

1. **owned-overlay 尚未接线**——P1 高危族只靠不限定 menuId 的 closest 短修防守，误保护面未知；28 处外点监听零迁移，coordinator 侧新 API 是死代码。翻：overlayOwnership 消费点数（应仍为 0）、closest 是否限定实例。
2. **真机/运行验证空白**——五轮 20+ 测试文件、tsc/lint 一次未跑，全部「已落地」运行置信为 0。翻：若解禁执行先跑 vitest+tsc；仍禁则人工复核新测试可运行性。
3. **pdf store remove 仍嵌 resourceId**——sessionActions.ts:249-250，孤儿附件单删 store 残留、与 clearAttachments 不对称；一行级修但连续两轮只登记不修，且孤儿用例测试钉住缺陷现状（修时必须同步改测试）。
4. **lint 仍 warn**——门禁无阻断力散点可回流；升 error 前置（批 4 清存量）未启动、白名单 40 行无人复审。翻：eslint.config.js:122 严重级与存量计数是否收敛（对照 r1-09 基数 4079）。
5. **宽表未卡片化**——BackupTab 6 列宽表原样（规范④最重违规），ResponsiveDataList 未建；实施须守 WebDAV/S3/FTP 禁区只动展示层。翻：settings-chrome 席位产出与禁区 rg 零命中。

次级欠账登记：卡 5 三 FAIL、卡 7 键盘双轨、卡 9 Checkbox 热区、P6 契约升级、P7 V2/V4、P8 发现#1、McpToolsSection 让行、useKeyboardHeight 单测。

### 完成度诚实估计（第 1–5 轮审+改，95% 置信）

- 审阅/定性面 ≈ 完成（静态口径，P1–P8 判定+全库核验表齐）。
- 修复面按卡计 ≈ 4.9/10，风险加权约 55–60%；第 5 轮在途席位落盘后预计再 +15–20 个百分点，对账时点不可计。
- 验证面 = **0%**（零测试执行、零编译、零真机）。
- 综合：静态口径 **50%–60%（95% 置信区间，点估计 55%）**；经运行验证口径 **0%**。两口径必须分开报。
- 本轮未标注 Goal complete（按指令不得标注）；对账过程未运行测试、未改产品代码、未 git commit。
- 时点补记：对账收尾时观察到同轮席位并发落盘。第 6 轮二检须以届时 HEAD 重新取证。

## 第 5 轮已落地（chrome FAIL + i18n 守卫）

- learning-hub F1/F2/F3：子屏走 useMobileSubviewChrome（含 screen 标记）；QuickLook 注册 overlay back。F3 关闭钮仍用 after:-inset 逃生舱——第 6 轮改 TouchTarget/coarseHit。
- PDF V1：`registerVisibilityGuardedBackHandler` 加法；PdfSelectionActions + EnhancedPdfViewer 共用。
- anki/qbank chrome：Checkbox 基元热区已在 CSS（更正 R1）；吸底条补 aria-label；删手抄 before:-inset。
- settings：折叠钮 DsButton；键盘双轨删除 useKeyboardInset；BackupTab 卡片化（只展示层）。
- Chat：无独立 chrome FAIL；补右侧≤2 source 契约。
- i18n：模板键展开 + 叶子必须非空字符串；actions.more 正式 alias；check-i18n 非 0 exit + check:i18n:strict。补 thinkingDepth.minimal 双语。
- 修 TouchTarget JSDoc 中 `h-*/w-*` 提前截断注释（父代理注释白名单）。
- 第 6 轮首位：owned-overlay 接线、pdf store remove 嵌 resourceId、lint 仍 warn、F3 伪元素逃生舱、真机空白。

## 第 6 轮已落地（二检翻案）

- P1：InputBarUI 登记 `registerOwnedOverlay` + 查询 `isOwnedOverlayTarget`，closest 作 fail-open；AppMenu 可选 `overlayOwnerId`（默认不登记）。
- P2 残债：`pdfProcessingStore.remove` 提升到 sourceId 顶层。
- F3：FinderQuickLook 关闭钮改 `coarseHitClassFor36`。
- a11y：inertClamp 测试假红（注释含 `clamp(160px,`）已改写。
- chrome 新观察：小屏划词「保存为笔记」子屏 hosted 但 screen 不匹配——登记第 7+ 轮。
- lint 仍 warn（第 8 轮升 error）。真机仍空白。

## 第 7 轮已落地（交互序列测试源码，只写不跑）

- 新增矩阵：overlay pointer、back 全场景、keyboard inset 契约、safe-area 不变量、读屏顺序、附件三路径、命中补遗、i18n 动态键。
- 原文 `docs/dev/wave2-C-r7/`。第 8 轮才允许 vitest。

## 第 8 轮台账（input-bar 触控机制放量与散点收敛）

### 机制放量与替换口径

- HEAD `900e7a33`，前序提交 `73883668`。`eslint.config.js` 已将 `src/features/chat/components/input-bar/**` 的 `ds-components/coarse-touch-target` 由全局 `warn` 单目录放量为 `error`；全库其余目录仍为 `warn`，后置测试文件 override 仍为 `off`。这是「机制吃散点」，不是十路各自追加 44px 小修。
- input-bar 内旧的 coarse `!min-h-11` / `!h-11` 与内联 `after:-inset`，统一替换为 `--touch-target-size`，或导入 `@/components/ui/coarseHit` 的既有档位；桌面视觉尺寸和动作语义不借机改写。分批明细见 `wave2-C-r8-attach-scatter.md`、`wave2-C-r8-chips-leftover.md`、`wave2-C-r8-bars-leftover.md`。

### 已知残留

- `AttachmentPanelBody.tsx` 仍有无 coarse 前缀的 `className="!h-11 !min-w-11"`（另有两处 `!h-11 !w-11`）；`InputBarUI.mobileSplitContract.source.test.ts` 仍以精确字面量钉住该契约，不误报为本轮 coarse 散点。
- `ComposerToolbar.tsx` 注释仍含 `after:-inset` 字样；R7 命中契约依赖「注释文本与渲染字符串字面量分离」的扫描口径，不能把注释命中算作产品类名残留。

### 已验证（仅本轮已有证据）

- 静态证据：`73883668` 加入 input-bar 单目录 `error` override，并保持全局 `warn`、测试 `off`；`900e7a33` 将余下 bars/chips 散点改走 token 或 `coarseHit`。当前源码仍可定位上述两类有意残留。
- 已发生的命令证据：`npm ci` 成功。
- 仓内尚无本轮定向 vitest 报告文件：**定向 vitest 进行中，本台账不预支绿**。

### 未验证与边界

- 真机四项仍留白：键盘 inset、厂商 WebView、VoiceOver/TalkBack、44px 实机命中。
- `vite build`、`cargo`、migrations 在本轮台账时点未跑；定向 vitest 也尚无可归档报告，四项门禁未齐。
- 不标 Goal complete。sidebar 缺键继续按 v0.9.44 既有债归档，不算 0824 回归。

### 第 9 轮首位欠账

- 全库 `coarse-touch-target` 仍为 `warn`，尚未全局升 `error`。
- Learning Hub「保存为笔记」子屏仍有 hosted `screen` 不匹配。
- 真机验证仍空白。
- 定向 vitest / `vite build` / `cargo` / migrations 四项门禁尚未齐套。

### 第 8 轮实测补记（vitest / lint / typecheck 已回，只追加）

- input-bar 族：`238 passed / 7 failed`。7 条全是测试未随机制更新（`cancelAttachmentProcessing` 包装、注释里的 `after:-inset`、`useDeferredOpen` 220ms 退场、owned-overlay 常量、`enumerateDevices` 注释），**不是产品回归**。明细 `wave2-C-r8-vitest-input-bar.md`。
- mobile 契约：navigation 29 / keyboard 18 / shared 21 / mobile-uiux 140（过期 `after:-inset` 计数断言已改为 token 所有权）/ check-i18n 10 绿。`coarseTouchTargetRule.test.ts` 收集期环境失败（`import.meta.url` 非 file: scheme）。明细 `wave2-C-r8-vitest-mobile.md`。
- lint input-bar：`coarse-touch-target` **0 error**；`version:generate && typecheck` 绿。明细 `wave2-C-r8-redlight.md`。
- 本补记时点仍未跑：`vite build` / `cargo check --lib` / `check-migrations`。

## 第 9 轮已落地（扫尾，只追加）

- 过期探针：R8 的 7 条 input-bar 测试红已改测试跟上机制（包装函数、literal 扫描、`data-panel-motion`、owned-overlay 常量、注释剥离）。定向 35/35 绿。见 `wave2-C-r9-stale-tests.md`。
- Hub「保存为笔记」：`SaveAsNoteFolderPicker` inline 外包 `MobileSubviewChromeProvider value={null}`，恢复自绘返回行；F2 `screen:'center'` 未改。见 `wave2-C-r9-hub-save-as-note.md`。
- 暗色/字号/溢出：顶栏字号走 token；AppMenu 跟 visualViewport 高度 + coarse 下 hover 改 click；数据治理三表 `<md` 卡片化（只展示层）；FolderPicker 树行走 `TouchTarget`。见 `wave2-C-r9-dark-overflow.md`。
- 死键：chatV2 `inputBar.*` 下 31 个零引用叶子双语删除（legacy）；`actions.more` alias 保留。见 `wave2-C-r9-dead.md`。
- lint 收集：allowlist 加载不再在非 file: URL 上抛死；RuleTester 在 ESLint 9 下仍有配置匹配失败，见 `wave2-C-r9-lint-loader.md`。
- 硬门禁：本环境 `rustc 1.83.0` ≠ 1.98.0，cargo 停；vite/migrations 被该席位连带跳过。见 `wave2-C-r9-hard-gates.md`。
- 文档：真机留白 `wave2-C-r9-device-blank.md`、风险 `wave2-C-r9-risks.md`、PR 初稿 `wave2-C-r9-pr-draft.md`；`mobile-uiux-unify` 只追加 Wave2-C 节。
- 不标 Goal complete。真机四项仍留白。

### 第 9 轮门禁补记（父代理，vite / migrations 不依赖 Rust 1.98）

- `CI=true npx vite build`：退出码 0，约 67s。
- `node scripts/check-migrations.mjs`：退出码 0，111 个迁移文件。
- `cargo check --lib`：仍因 rustc 1.83.0 ≠ 1.98.0 停，不装 toolchain。

---

## 第 10 轮终检（归档时点登记，只追加）

- 归档时点：HEAD `fe8ff43c`（r1–r9 已提交）。未提交改动含上方「第 9 轮门禁补记」（vite / migrations 绿、cargo 因 rustc 1.83.0 停），本轮保留该补记不改写；归档期间观察到 r10 并行席位正向工作树落盘（如 `tests/vitest/coarseTouchTargetRule.test.ts` 在途改动），其内容不计入本节。
- r10 各报告指向（按既有命名约定 `docs/dev/wave2-C-r10-*.md`）：
  - 已落盘：`wave2-C-r10-pr-final.md`（PR #347 中文描述定稿，自述取证 HEAD `fe8ff43c`）——指向原文，本台账不复述其结论。
  - 其余席位（lint 升级、真机留白复核、门禁复跑等按第 9 轮欠账推定的方向）：归档时点 `docs/dev/` 与 `/tmp/` 均无对应产出文件——**并行席位产出中，本节不预支任何结论**；落盘后以各报告原文为准，本台账不代写。
- 截至上一轮的门禁快照（仅引用已归档证据，非 r10 结论）：定向 vitest 见 `wave2-C-r8-vitest-input-bar.md` / `wave2-C-r8-vitest-mobile.md` / `wave2-C-r9-stale-tests.md`；lint/typecheck 见 `wave2-C-r8-redlight.md`；vite build 与 check-migrations 绿见上方第 9 轮门禁补记；cargo 停摆见 `wave2-C-r9-hard-gates.md`。
- 结转欠账（沿第 9 轮登记，待 r10 报告核销）：全库 `coarse-touch-target` 仍 `warn` 未升 error；真机四项（键盘 inset、厂商 WebView、读屏、44px 实机命中）仍留白；`cargo check --lib` 因 rustc 版本停。
- 不标 Goal complete。本轮归档未运行测试、未改产品代码、未 commit。

### 第 10 轮终检补记（报告已齐）

- 交叉终审：`wave2-C-r10-review-events.md` / `review-system.md` / `review-a11y.md` / `review-i18n.md`
- 红线自证：`wave2-C-r10-redlines.md`（禁改区零命中；input-bar 无新增散点 `!min-h-11`）
- 五条规范终验：`wave2-C-r10-five-norms.md`（Chat/hub/PDF/设置静态 PASS；anki/qbank chrome 仍 3 项静态 FAIL：卡片右上 3 动作、任务台窄屏宽表、标签删除横向热区）
- 风险续册：`wave2-C-r10-risks.md`；PR 定稿：`wave2-C-r10-pr-final.md`
- `coarseTouchTargetRule.test.ts` 已补 ESLint 9 flat-config 匹配，席位回报 34/34 绿（覆盖 R9 收集失败 + 配置匹配失败）




