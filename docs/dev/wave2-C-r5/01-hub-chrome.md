# 0824 Wave2-C R5 — learning-hub chrome 修复（F1/F2/F3）

- 轮次：第 5 轮「chrome 修复-learning-hub」；模型 claude-fable-5-thinking-high
- 基线：cf8eb9e8（/tmp/0824-wave2-c-r5-hub-chrome）
- 依据：docs/dev/wave2-C-r1/02-learning-hub.md 台账 F1–F3
- 约束遵守：未执行任何测试/编译；未 git commit；未触碰 finder store / host buckets / coordinator.rs；未散点手贴 `!min-h-11`（QuickLook 关闭钮按伪元素外扩范式，非散贴）

## 结论

F1、F2、F3 三项全部完成，F2 按「小改加 screen 标记」路径做成（3 处集中改动，未碰 finder 逻辑）。共改 5 个文件，均在允许清单内。

## 改动明细

### F1 — NoteContentView.tsx（笔记移动上下文子屏双 chrome）

- 新增 `useMobileSubviewChrome({ title: t('notes:contextPanel.title'), onBack: () => setMobilePanelOpen(false) }, [t], isActive && isSmallScreen && mobilePanelOpen)`，把子屏标题/返回推给 App 级统一顶栏（与同工程 QuestionBankExportDialog / QuestionHistoryView / ImageCropDialog 同通道）。
- enabled 含 `isActive` 守卫：保活隐藏的笔记 tab（display:none）不得接管活跃标签页的顶栏，与该文件既有返回键 handler 的守卫同口径，也符合 MobileSubviewChromeContext 头注释的保活约束。
- 自绘返回行（CaretLeft + 标题那条 border-b 行）改为 `{!subviewChromeHosted && (…)}`：有宿主时隐藏，探测不到宿主（桌面分栏 / workbench 窗口）保持原自绘，行为不变。

**与台账建议的一处偏离**：台账 F1 写「顺带可删本地 registerBackHandler（通道内已含）」——经核实不成立。`useMobileSubviewChrome` 只接管顶栏渲染，不注册 Android 返回键（MobileSubviewChromeContext.tsx 全文无 registerBackHandler）；既有三个消费者（ImageCropDialog:219-232、QuestionHistoryView:236-249）也都是「通道 + 本地 registerBackHandler」并存。故本轮保留 NoteContentView 的本地返回键注册，并在代码注释中写明「通道只接管顶栏，不注册返回键」防后人误删。

### F2 — 中屏子屏 chrome 宿主（screen 标记，3 文件小改）

1. **MobileSubviewChromeContext.tsx**：`MobileSubviewChrome` 增加可选字段 `screen?: 'center' | 'right'`，缺省 `'right'`——既有右屏消费者（题库导出/历史/裁剪、本轮 F1 的笔记子屏）零改动即保持原行为。文件头场景注释同步补充中屏用例。
2. **LearningHubPage.tsx（719-750）**：栈顶接管条件由 `screenPosition === 'right' ? activeSubviewChrome : null` 改为按屏位匹配 `(activeSubviewChrome.screen ?? 'right') === screenPosition`；变量更名 `rightSubviewChrome → subviewChrome`。useMobileHeader 配置各分支相应调整：
   - `titleNode`（中屏面包屑）在 chrome 接管时置 undefined，改显 chrome.title；
   - `showMenu` 在 chrome 接管时为 false，`showBackArrow` 为 true，`onMenuClick` 提前到最外层三元取 `subviewChrome.onBack`；
   - 右屏各分支语义与改前完全等价（右屏时 showMenu 本就 false、showBackArrow 本就 true）；左屏不受影响（chrome 无 'left' 取值，匹配必失败）。
   - 滑屏语义保持：中屏子屏打开时滑到右/左屏，匹配失败 → 顶栏立即恢复该屏位原语义，子屏保持打开等待返回（与原右屏行为对称）。
3. **FolderPickerDialog.tsx**：inline 形态注册 `useMobileSubviewChrome({ title: resolvedTitle, onBack: () => onOpenChange(false), screen: 'center' }, …, inline && open)`（hook 置于 `if (inline)` 早退之前、所有既有 hooks 之后，无条件调用合法）；自绘顶部返回行改为 `{!subviewChromeHosted && (…)}`。底部取消/确认条保留不动。Android 返回键的本地 overlay 档注册保留（理由同 F1）。

**降级路径核实**：`FolderPickerDialog inline` 的另两处承载都安全——
- `useSaveAsNoteFlow`（chat「保存为笔记」，fixed inset-0 独立承载）：不在 LearningHubPage 子树内，无 Provider，hosted=false，保持自绘返回行；
- `DesktopView.tsx:759`（`inline={isTouchPrimary}`）：移动页内时在中屏子树内，自动获得 header 接管；触屏桌面分栏时无 Provider（Provider 仅挂在 LearningHubPage 移动分支 1190），保持自绘。

### F3 — FinderQuickLook.tsx（返回键 + 关闭钮热区）

- 新增 `useEffect(() => registerBackHandler(() => { onClose(); return true; }, BACK_PRIORITY.overlay), [onClose])`，与 LearningHubContextMenu.tsx:333-339 同范式；注释说明自绘 portal 无 `data-state="open"`、Radix 兜底匹配不到必须显式注册。组件挂载即打开（LearningHubSidebar:3979 `{quickLookItem && <FinderQuickLook…>}`），无需 open 门控。
- 关闭钮触屏热区：保持视觉 40px（`!h-10`），加 `relative + [@media(pointer:coarse)]:after:absolute after:-inset-1 after:content-['']` 外扩至 48px ≥44px——对齐 FinderToolbar:273-280 / FinderQuickAccess 的伪元素范式，未散贴 `!min-h-11`。

## 风险与后续建议

- 风险最低点：F3（纯增量）；F1（条件渲染 + 既有通道消费者范式照抄）。F2 的行为变化面是「中屏 + FolderPicker 打开」这一种新状态，右屏/左屏路径经逐分支对照与改前等价。
- 未运行测试（本轮禁令）。与改动最相关的既有守卫：`folderPickerToggleA11y.source.test.ts`（只检树节点展开钮段落，本轮未触及）、`useSaveAsNoteFlow.test.tsx`（mock 掉 FolderPickerDialog，不受影响）、`mobileHeaderViewRegistryContract`（'learning-hub' 单一写者未变）。
- 建议下轮补台账既列的 T2（子屏 chrome 通道 source 契约：NoteContentView / FolderPickerDialog 纳入 allowlist）与 T3（自绘 portal 浮层必接 registerBackHandler：FinderQuickLook 由 ✗ 转 ✓ 后作回归防线），并把台账 F1 中「通道内已含返回键」的表述修正。
