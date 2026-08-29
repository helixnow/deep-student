# 0824 Wave2-C 第 6 轮 08 — hub/pdf/settings/anki chrome 复核（R5 二检）

- 席位：第 6 轮复核员-chrome（claude-fable-5-thinking-high）；只读复核，未执行任何测试/编译/lint，未 git commit，未改任何代码。
- 复核对象：R5 提交 `b35038a8`（fix: close mobile chrome gaps and tighten i18n guards）中 hub/pdf/settings/anki 四域改动 + 对应 R5 报告 `/tmp/0824-wave2-c-r5/{01,02,03,04}-*.md`。
- 复核方式：逐文件读 `git show b35038a8` diff，对报告每条声明重新取证（grep/读源码/核 i18n 键/核提交祖先关系），不转抄 R5 结论。
- 禁改区自查：`git show --stat` 对 rust/src-tauri/sync/webdav/s3/ftp/finderStore/ankiStore/fsrs 全部零命中；四域改动全在前端展示层。

---

## 一、通过清单（逐项重新取证）

### 02 PDF chrome — 全部通过 ✅

| 声明 | 取证结果 |
|---|---|
| `registerVisibilityGuardedBackHandler` 纯加法，不动排序/栈语义 | ✅ diff 仅在 `registerBackHandler` 后追加接口+两函数，既有导出/`handleAndroidBack` 零改动 |
| 三重守卫逐条等价抽取 | ✅ isConnected → getClientRects().length===0 → computed visibility，与原 EnhancedPdfViewer:1260 手写版逐条一致，含 visibility:hidden 布局盒注释 |
| PdfSelectionActions 迁移 + deps 补 containerRef | ✅ import 换名、`registerVisibilityGuardedBackHandler(containerRef, …)`、deps 补 ref（身份稳定无行为变化） |
| EnhancedPdfViewer 浮层链迁移，关闭顺序未动 | ✅ 净 -5 行，仅换注册函数，关闭链/hasOverlay 条件/优先级原样 |
| pdf 域无裸 `registerBackHandler(` | ✅ `rg --pcre2 '(?<!Guarded)registerBackHandler\('` 在 src/features/pdf 零命中（含注释，负向断言静态可过） |
| 测试升级形态 | ✅ `viewerSource`/`actionsSource` 在测试文件头部已定义（L21-22），新断言引用合法；JS lookbehind Node 环境支持 |

### 03 anki chrome — 全部通过 ✅（含对 R1 台账的翻案确认）

| 声明 | 取证结果 |
|---|---|
| Checkbox.css 基元 coarse 热区已存在（R1「无热区」系误报） | ✅ Checkbox.css:41-55 `[data-radix-checkbox-root]::after` max(100%,44px) 两维；Checkbox.tsx:20 确实设置该 data 属性 |
| 引入提交 `a38c75a6` 是 R1 扫描 HEAD `29ca02d9` 祖先 | ✅ `git merge-base --is-ancestor` 通过——**R5 对 R1 台账的更正有据，维持翻案成立** |
| 删 3 处手抄 `before:-inset-3.5`（:686/:812/:843）安全 | ✅ 原 className 仅承载该 hack，删后基元 ::after 兜底；事件路径不变（::after 属 checkbox 自身，外层 stopPropagation span 仍在） |
| 吸底条 5 处 aria-label（难度/标签/重置/删除/取消） | ✅ 逐个在 diff 中核到，键串与 title/可见文案一致 |
| ankiCardsBlock 零 diff、两处裸 Checkbox aria 完备 | ✅ 该文件不在提交 stat 中；:2836 selectAll、:2972 selectCard（含序号插值）aria-label 实在 |
| anki 域逻辑禁改区 | ✅ 仅 Checkbox 注释 + QuestionBankManageView 展示层，FSRS/出题/评分/store 零触碰 |

### 04 settings chrome — 通过 ✅

| 声明 | 取证结果 |
|---|---|
| WorkbenchSettingsSection 两折叠钮换 DsButton | ✅ aria-expanded/aria-controls/disabled 保留；DsButton 默认 `type="button"`（DsButton.tsx:63），无表单语义回归；sm 档契约 `<lg` 44px + coarse min-h（buttonPrimitiveContract.ts:74）保底成立 |
| AuditTab 散点清理依赖的两个前提 | ✅ AppSelect 基座 coarse `!h-11` 已内建（app-menu/AppSelect.tsx:165-166）；DsButton icon 档 44/44 + lg 收敛（契约 :78）——`size="icon"` 替换 `h-8 w-8 p-0`+4 段覆盖成立，aria-label 保留 |
| useKeyboardInset 迁全局单例 + 删旧 hook | ✅ `@/hooks/useKeyboardHeight` 确有 `export function useKeyboardInset()`（:175）；全仓无任何残留 import 指向已删的 settings/hooks/useKeyboardInset；消费门控（mobilePanelMode && inset>0）未动 |
| BackupTab 卡片化仅展示层 | ✅ `handleRestoreClick` / 两 badge 渲染函数为逐字符搬移；卡片四动作（验证/导出/恢复/删除）回调、disabled、aria-label 与表格逐一对应；卡片新引用 i18n 键（data:governance.verify/export_zip/restore/no_backups、common:actions.delete、common:status.loading）双语全部存在且与表格同键；空态/加载态文案一致 |
| 不变量 13-15（WebDAV/S3/FTP） | ✅ 禁区 grep 零命中，onClick 全走既有 props 回调 |
| P0 移交项（TouchTarget.tsx 注释截断） | ✅ 已在 b35038a8 中一行修复（`h-*/w-*` → `h-* / w-*`，`*/` 不再提前终止块注释）——R5 报告的升级路径闭环，无需本轮动手 |

### 01 hub chrome — F1/F3 通过，F2 机制通过但有一处取证遗漏（见翻案区）

| 声明 | 取证结果 |
|---|---|
| F1 NoteContentView 接通道 + 条件自绘 | ✅ hook 签名 `(chrome, deps, enabled)→boolean` 匹配；`notes:contextPanel.title` zh/en 双语在；enabled 含 isActive 守卫与既有 back handler 同口径；`useMobileSubviewChrome` 从 `@/components/layout` 导出确认 |
| F1 偏离说明（通道不注册返回键，保留本地 registerBackHandler） | ✅ MobileSubviewChromeContext 全文无 registerBackHandler，偏离有据、代码注释已写明 |
| F2 LearningHubPage 分支改写等价 | ✅ 逐分支对照：右屏有/无 chrome、中屏无 chrome、左屏，六个 header 字段全部与改前等价；中屏+chrome 为新增行为；screen 缺省 'right' 使既有三消费者零改动 |
| F2 FolderPickerDialog hook 位置 | ✅ hook 在 :242，`if (inline)` 早退在 :309，无条件调用合法 |
| F2 Provider 仅移动分支 | ✅ LearningHubPage.tsx:1194 在 `if (isSmallScreen)` 分支内，桌面分栏/workbench 无 Provider → hosted=false 自绘保留 |
| F2 主用例（Sidebar 批量移动） | ✅ LearningHubSidebar:3939 `inline={isSmallScreen}`，中屏承载与 screen:'center' 匹配，接管成立 |
| F3 FinderQuickLook 返回键 + 热区 | ✅ 挂载即打开（LearningHubSidebar:3980 条件渲染）无需 open 门控；伪元素 after:-inset-1 使 coarse 命中 40+8=48px；BACK_PRIORITY.overlay 范式与 LearningHubContextMenu 一致 |

---

## 二、翻案/复议清单

### A.【翻案：中危，报告 01 F2「另两处承载都安全」取证不全】

R5 报告 01 只核了两处 FolderPickerDialog inline 降级承载（chat 保存为笔记、DesktopView），**漏了第三处**：learning-hub 内 PDF/教材阅读器的划词「保存为笔记」。

链路（全部本轮取证）：小屏 learning-hub 右屏打开 PDF/教材 tab → FileContentView/TextbookContentView → PdfReader → EnhancedPdfViewer → PdfSelectionActions:187 `<SaveAsNoteFolderPicker>` → 小屏 `inline` 形态（useSaveAsNoteFlow.tsx:95 `inline: isSmallScreen`）→ `fixed inset-0 z-[1200]` 包裹 FolderPickerDialog inline。该 React 子树在 LearningHubPage 移动分支 Provider（:1194）之内，因此：

1. `subviewChromeHosted = host !== null = true` → 自绘「返回 + 标题」行被隐藏；
2. 注册的 chrome 带 `screen:'center'`，但当前 screenPosition='right' → LearningHubPage 屏位匹配失败，统一顶栏**不接管**；
3. picker 是 fixed 全屏覆盖，统一顶栏本身也被盖住。

净效果：该流程丢失顶部标题与返回行。**非死路**（Android 返回键的本地 registerBackHandler 保留、底部取消/确认条在 :341-359 仍在），定级中危 UX 回归而非阻断。

根因是 `useMobileSubviewChrome` 返回值语义为「存在 Provider」而非「实际被接管」，与 F2 引入的屏位匹配拆开后出现真空。修法非一行级判断题（两个方向：SaveAsNoteFolderPicker inline 分支用 `MobileSubviewChromeProvider value={null}` 隔离通道；或把 hosted 语义改为实际接管回执），且涉及 shared/notes 文件，按本轮约束**未改代码，移交下轮 hub/coord 席位裁决**。

### B.【登记不翻案：低，NoteContentView chrome enabled 缺 `!propertiesPanelDisabled` 门控】

子屏渲染（:1002）带 `!propertiesPanelDisabled` 门控，chrome enabled（:168）不带；命令事件 `NOTES_TOGGLE_OUTLINE`（:846-853）可在 disabled 时置 mobilePanelOpen=true。但全仓 `propertiesPanelDisabled=true` 仅 NotesWorkspaceApp（workbench 承载，无 Provider → setSubviewChrome 不会被调用，no-op），且与既有本地 back handler（:150）同口径。无实际症状，销案；若后续 learning-hub 内出现 disabled 承载须回看。

### C.【维持 R5 对 R1 的翻案】

anki 报告 03 对 R1 台账「Checkbox 无 coarse 热区 / ankiCardsBlock:2972 硬违规」的更正，经 Checkbox.css 内容 + `a38c75a6` 祖先关系独立复核**成立**，建议台账正式回写（R5 报告 03 遗留 4 已列）。

---

## 三、遗留确认（R5 自报欠账，抽查属实）

- BackupTab 桌面表格内 `max-md:min-h-11` 等 4 处覆盖类：表格现 `<md` 不渲染，max-md 段成死代码（coarse 段对 iPad ≥md 仍生效）——R5 自报属实，留待建议 1 批量清理。
- SyncTab/AuditTab/OverviewTab 宽表、V2/V3/V4、EnhancedPdfViewer 关闭顺序契约、CSV 导入/导出钮 aria：均与 R5 自报一致，未动。
- 运行验证仍为 0（本轮同样禁执行）：四域全部结论为静态口径；pdf source 契约测试、i18n 契约测试一次未跑。

## 四、声明

- 未修改任何代码（唯一符合「一行级明显错误」标准的 TouchTarget P0 已在 b35038a8 内修复，无需动手）。
- 未 git commit；工作树保持干净。
- 禁改区（finder buckets、WebDAV/S3/FTP、anki 域逻辑）本轮改动零命中，复核过程亦未触碰。
