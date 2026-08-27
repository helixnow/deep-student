# 0824 Wave2-C 第 10 轮：五条规范终验表

- 取证时点：2026-08-26（UTC），分支 `cursor/0824-wave2-mobile-uiux-a875`，HEAD `fe8ff43c`。
- 口径：以 `docs/dev/mobile-uiux-unify/README.md:7-13` 的五条规范为准；读取 R1 的 01–09 扫描报告及 `wave2-C-ledger.md` 中 R5–R9 追加台账，再对当前源码做定点 `file:line` 抽查，不重扫全库。
- 范围：Chat 移动、learning-hub、PDF/EPUB 移动、anki/qbank chrome、设置/数据治理。
- 本轮只写本文档；未使用 computerUse，未运行新测试、构建或真机，未改产品代码。

## 判定口径

- `PASS`：当前静态实现满足该条规范；历史折衷只有在 R1 已明确判为内容 chrome / 机制化例外且当前仍有等价入口时才并入 PASS。
- `FAIL`：当前源码仍可定位到违反五条规范的实现，不用“折衷”淡化。
- `留白`：该规范对该内容组件不适用，或真机证据不存在。
- “静态终验”只汇总源码与已归档测试证据；“真机”单列，不能用 jsdom/source test 冒充。

## A. Chat 移动

| 页面 / 子屏 | ①顶栏唯一 | ②左侧语义 | ③右侧≤2×44 | ④禁桌面组件滥用 | ⑤可达可回退 | 静态终验 | 真机 | 关键证据 |
|---|---|---|---|---|---|---|---|---|
| chat-v2 默认聊天 / browser | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | 单一 `useMobileHeader('chat-v2')` 及默认菜单/返回分支：`src/features/chat/pages/useChatPageLayout.tsx:168-291`；右侧动作契约逐分支限制 1–2 个 DsButton：`tests/vitest/mobile-uiux/chatHeaderRightActionsContract.test.ts:63-100` |
| 沙箱、资源预览、资源库、分组编辑子屏 | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | 四类子屏都复用同一顶栏写者，左侧为返回，右侧 1–2 动作：`useChatPageLayout.tsx:168-274` |
| Composer 内联面板 / AppMenu | 留白 | 留白 | 留白 | PASS | PASS | PASS | 留白 | 外点与焦点共用 owned-overlay 谓词：`InputBarUI.tsx:1068-1098,1429-1456`；Android back 先让行上层 Radix 再关面板：`:1458-1470`；收起态 inert + `aria-hidden`、键盘高度二段下限：`ComposerInlinePanel.tsx:58-75,90-117`；水位环为实体 44px button：`ContextUsagePopover.tsx:87-102` |

结论：Chat 移动五条规范静态 PASS。R9 风险表登记的过宽
`closest('[data-app-menu-id]')` fail-open 仍在 `InputBarUI.tsx:1089-1097`，其后果是极端同屏场景可能“误保护、面板不收”，不是原 P1 的菜单动作丢失；不翻为规范⑤ FAIL，但真实 tap 事件链仍是本表真机留白。

## B. learning-hub

| 页面 / 子屏 | ① | ② | ③ | ④ | ⑤ | 静态终验 | 真机 | 关键证据 |
|---|---|---|---|---|---|---|---|---|
| LearningHubPage 三屏壳 | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | 中屏 1 个刷新、右屏“引用 + 更多”至多 2 个动作：`LearningHubPage.tsx:633-699`；子屏按 screen 接管同一顶栏：`:713-752` |
| 中屏 finder / 文件夹 / 容量视图 | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | 面包屑与 goUp 进入统一顶栏，R1 02 §一 #3/#9；当前中屏动作见 `LearningHubPage.tsx:633-647,733-750` |
| 中屏「移动到…」FolderPicker inline | PASS | PASS | 留白 | PASS | PASS | PASS | 留白 | `screen:'center'` 发布并由宿主按屏位接管：`FolderPickerDialog.tsx:235-247`、`LearningHubPage.tsx:713-752`；无宿主才降级自绘：`FolderPickerDialog.tsx:306-339` |
| Memory / IndexStatus / Desktop 特殊视图 | PASS | PASS | 留白 | PASS | PASS | PASS | 留白 | R1 02 §一 #6–#8 判定其工具条为内容 chrome；当前特殊视图分发仍在 `LearningHubSidebar.tsx:3627-3650`。`LearningHubSidebar.tsx:3315` 的通用移动工具条未按 viewKind 摘除是 F4 可用性残项，不构成第二个全局顶栏 |
| TabBar / Finder 文件项 / 批量工具条 | PASS | 留白 | 留白 | PASS | PASS | PASS | 留白 | Tab 热区 38px 视觉 + 上下各 3px，且有显式 back：`TabBar.tsx:192-199,234-241`；该 44px 视觉/命中分离是 R1 明确登记的有意折衷 |
| NoteContentView + 移动上下文子屏 | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | 子屏发布统一 chrome 并保留 Android back：`NoteContentView.tsx:148-170`；宿主存在时不再自绘返回行：`:1000-1020` |
| Image / Textbook / UnifiedPreviewToolbar | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | 内容工具条容器统一 coarse 44px，窄屏把重置收进菜单：`UnifiedPreviewToolbar.tsx:170-220`；R1 02 §一 #13–#15 |
| Exam / Translation | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | R1 02 §一 #16/#17；页面顶栏动作由 LearningHubPage 的右屏分支统一收纳：`LearningHubPage.tsx:650-699` |
| FinderQuickLook / ContextMenu / BatchToolbar | 留白 | 留白 | 留白 | PASS | PASS | PASS | 留白 | QuickLook 已显式注册 overlay back：`FinderQuickLook.tsx:98-106`；关闭动作经共享 coarseHit 扩到 ≥44：`:200-215` |
| 划词「保存为笔记」FolderPicker | PASS | PASS | 留白 | PASS | PASS | PASS（静态） | **留白** | **R9 已隔离**：inline fixed 承载外包 `MobileSubviewChromeProvider value={null}`，恢复唯一可见的自绘标题/返回行：`src/shared/notes/useSaveAsNoteFlow.tsx:108-139`。R9 已有 8/8 本体测试及 31/31 相关回归，但小屏 learning-hub 真机路径未验 |

结论：learning-hub 当前没有五条规范的静态 FAIL；Hub「保存为笔记」必须保留“R9 已隔离、真机未验”的双重口径，不能写成真机通过。

## C. PDF / EPUB 移动

| 页面 / 子屏 | ① | ② | ③ | ④ | ⑤ | 静态终验 | 真机 | 关键证据 |
|---|---|---|---|---|---|---|---|---|
| PdfReader | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | 独立 `pdf-reader` 顶栏只有返回 + 1 个打开文件动作：`PdfReader.tsx:22-43` |
| EnhancedPdfViewer 移动 panel / 底栏 | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | viewer 内 panel header 是复用阅读器的内容子屏；复合浮层回退改走共享可见性守卫：`EnhancedPdfViewer.tsx:1250-1302` |
| TextbookPdfViewer | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | 纯包装层，顶栏归 learning-hub；R1 03 §一 |
| PdfSelectionActions | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | R1 V1 已修：结果面板 back 使用 `registerVisibilityGuardedBackHandler`，保活隐藏实例不吞返回：`PdfSelectionActions.tsx:70-85` |
| EpubPreview | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | 内容阅读工具条不是第二套页级顶栏；窄屏侧栏 back 有 `isActive && isNarrow && sidebarOpen` 守卫：`EpubPreview.tsx:144-156` |
| UnifiedPreviewToolbar | 留白 | 留白 | PASS | PASS | PASS | PASS | 留白 | 容器级 coarse 44px，窄屏等价入口留在菜单：`UnifiedPreviewToolbar.tsx:170-220` |

结论：PDF/EPUB 五条规范静态 PASS。`PdfSelectionActions.tsx:37` 的 132px 底部魔数及 viewer 自造 640px 断点是维护债，不属于本表五条硬 FAIL；keep-alive back 与真实 WebView 仍需真机。

## D. anki / qbank chrome

| 页面 / 子屏 | ① | ② | ③ | ④ | ⑤ | 静态终验 | 真机 | 关键证据 |
|---|---|---|---|---|---|---|---|---|
| ankiCardsBlock 聊天卡片块 | 留白 | 留白 | **FAIL** | PASS | PASS | **FAIL** | 留白 | 触屏卡片右上仍同时常显“引用 / 编辑 / 删除”3 个 44px 快捷动作：`ankiCardsBlock.tsx:880-936`，未按 R1 建议收为“编辑 + 更多”。原 16px Checkbox 硬违规已由基元修复：`Checkbox.css:37-55`、调用点 `ankiCardsBlock.tsx:2971-2977` |
| anki-tasks 任务台 | PASS | PASS | PASS | **FAIL** | PASS | **FAIL** | 留白 | 顶栏与小屏壳合规：`AnkiTasksApp.tsx:450-481,505-519`；但 SessionRow 的卡片明细在窄屏仍是横向 `CustomScrollArea` + 动态多列 `min-w-[100px]`：`SessionRow.tsx:496-546`，即 R9 通报的宽表同类残项 |
| QuestionBankManageView | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | `<768` 改卡片，操作收进行内“⋯”：`QuestionBankManageView.tsx:640-748`；批量图标按钮已有可访问名：`:1118-1162`；Checkbox 热区由基元接管 |
| QuestionInlineEditor | PASS | PASS | PASS | **FAIL** | PASS | **FAIL** | 留白 | 标签删除 chip 仅纵向扩区，明确 `after:inset-x-0`；短标签横向命中仍可能 <44px：`QuestionInlineEditor.tsx:1033-1044` |
| practice 全目录 + ReviewQuestionsView | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | R1 04 页 5 的可达、回退与窄屏 chrome 均 PASS；R5–R9 无新增五规范翻案 |

结论：本域静态终验有 3 个 FAIL：anki 卡片右上 3 快捷动作、anki-tasks 窄屏横向多列表、QuestionInlineEditor 短标签删除热区横向不足。Checkbox 与题库吸底条可访问名已修，不能继续按 R1 旧状态误报。

## E. 设置 / 数据治理

| 页面 / 子屏 | ① | ② | ③ | ④ | ⑤ | 静态终验 | 真机 | 关键证据 |
|---|---|---|---|---|---|---|---|---|
| Settings 移动壳 | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | 小屏自绘 Sheet header 时把 App 级顶栏设为 hidden：`Settings.tsx:700-705,1946-2023`，屏上只有一条；动作槽实体 44px：`settings.css:90-99`；分层回退：`Settings.tsx:542-569` |
| General / Appearance / Engine / Memory / PDF / Sync 设置分区 | PASS | 留白 | 留白 | PASS | PASS | PASS | 留白 | R1 05 §一；各分区无第二顶栏，桌面专属项有移动门控 |
| WorkbenchSettingsSection | PASS | 留白 | 留白 | PASS | PASS | PASS | 留白 | 旧 `<44px` 折叠入口已换 DsButton：`WorkbenchSettingsSection.tsx:731-754` |
| MCP / Vendor / Model 右滑编辑面板 | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | 顶栏右侧至多 1 个保存动作：`Settings.tsx:670-698`；其余编辑器底部保存/取消是等价入口，不构成不可达 |
| DataGovernanceDashboard / Overview | PASS | 留白 | 留白 | PASS | PASS | PASS | 留白 | Overview 的宽表仅 `md+`，`<md` 为卡片：`OverviewTab.tsx:345-444,444-527` |
| data-governance SyncTab | PASS | 留白 | 留白 | PASS | PASS | PASS | 留白 | `md+` 保留表格，`<md` 卡片：`SyncTab.tsx:290-418`；R9 只改展示层 |
| data-governance BackupTab | PASS | 留白 | 留白 | PASS | PASS | PASS | 留白 | 原 6 列宽表仅 `md+`；`<md` 卡片保留全部信息与 44px DsButton 动作：`BackupTab.tsx:1002-1119,1119-1196` |
| data-governance AuditTab | PASS | 留白 | 留白 | PASS | PASS | PASS | 留白 | 过滤器由 AppSelect coarse 44px 基座保证：`AppSelect.tsx:163-168`；日志表仅 `md+`，`<md` 卡片：`AuditTab.tsx:147-183,186-273` |
| DataImportExport / data-management | PASS | PASS | PASS | PASS | PASS | PASS | 留白 | 独立视图注册返回 + 1 个导出动作，嵌入 Settings 时禁用注册：`DataImportExport.tsx:276-298`；小屏不渲染桌面 HeaderTemplate：`:1322-1334` |

结论：设置/数据治理五条规范静态 PASS；Backup/Sync/Audit/Overview 的移动宽表残项已在 R5/R9 卡片化。WebDAV/S3/FTP 后端不变量不在本轮 UI 终验范围，R9 台账确认展示层改动未触碰其逻辑。

## 汇总与证据边界

| 域 | 静态终验 | 已知 FAIL | 真机 |
|---|---|---|---|
| Chat 移动 | PASS | 0 | 留白 |
| learning-hub | PASS | 0 | 留白；保存为笔记明确为“R9 已隔离、真机未验” |
| PDF / EPUB | PASS | 0 | 留白 |
| anki / qbank chrome | FAIL | 3 | 留白 |
| 设置 / 数据治理 | PASS | 0 | 留白 |

已归档、可计入静态/自动化证据的结果：

- R8：navigation 29、keyboard 18、shared 21、mobile-uiux 140、check-i18n 10 通过；input-bar coarse lint 0 error，typecheck 通过。
- R9：input-bar 过期探针修正后 35/35；Hub 保存为笔记本体 8/8、相关回归 31/31；暗色/溢出定向 4 files / 28 tests；Vite build 与 111 个 migrations 检查通过。
- Cargo 仍是环境前置红：实际 Rust 1.83.0，不满足要求的 1.98.0；不记成页面 FAIL，也不记成已通过。
- `docs/dev/wave2-C-r9-device-blank.md` 的键盘 inset、厂商 WebView、VoiceOver/TalkBack、44px 实际命中、AppMenu 真 tap、Android native back 六组真机项全部仍为留白。

本表不标 Goal complete：anki/qbank chrome 尚有 3 个静态 FAIL，且所有域的真机列均无证据。
