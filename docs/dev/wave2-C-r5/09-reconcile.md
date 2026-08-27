# 0824 Wave2-C 第 5 轮 09 — 台账对账（P1–P8 × 第 1–5 轮审+改）

- 席位：第 5 轮台账对账员；只读对账，未改产品代码，未运行任何 npm/npx/node/tsc/vitest/tauri/CI，未 git commit。
- 对账基线：/workspace HEAD `cf8eb9e8`（工作树干净；r1–r4 已由父代理提交为 `98bbf3f1`→`e90fb360`→`752b592c`→`af0be136`→`2d78f248`→`cf8eb9e8` 共 6 个提交，r2–r4 净改动 70 文件 +6129/-159）。
- 输入：docs/dev/wave2-C-ledger.md + docs/dev/wave2-C-r1..r4（9+9+9+8 份原文）+ 本轮 /workspace 直接 grep 复核（所有断言均重新取证，不转抄台账）。
- 第 5 轮同轮席位状态（/tmp 各 worktree，对账时点）：仅 `r5-pdf-chrome` 有在途未提交改动（androidBackCoordinator.ts / EnhancedPdfViewer.tsx / PdfSelectionActions.tsx，即卡 6 P7-V1 正在做）；chat/hub/settings/anki-chrome 与 check-i18n / i18n-alias / i18n-ast 六席位工作树干净（未开工或未落盘）。本对账不含这些在途结果。

---

## 一、P1–P8 落地对账（已落地 / 部分 / 未做，全部本轮重新 grep 取证）

| 项 | 状态 | 本轮复核证据（/workspace@cf8eb9e8） | 残余欠账 |
|---|---|---|---|
| P1 外点误杀 | **部分**（短修已落地，机制欠账） | `isWithinComposerTerritory` 在 InputBarUI.tsx:1058 定义、:1079 焦点门控与 :1404 外点判定共用；`hasOpenRadixOverlayBesides` 让行 :1434；回归测试文件 `InputBarUI.appMenuOutsideClick.pointer.test.tsx` 存在 | **owned-overlay 零生产接线**：`registerOwnedOverlay/isOwnedOverlayTarget` 仅存在于 overlayOwnership.ts、OverlayCoordinator.tsx 及 2 个测试文件，28 处外点监听一处未迁移；r2-08 审阅登记的 closest 过宽（不限定 menuId）原样 |
| P2 附件清理三所有者 | **已落地**（带 1 条已登记残债） | store 单一所有者：`cancelAttachmentProcessing` 顶层 sourceId 守卫（sessionActions.ts:233-236，在 resourceId 分支之外）；AttachmentPanelBody/Chips 零 cancel/revoke（r4-07 审阅红线 grep 通过）；三删除入口裸委托 | `usePdfProcessingStore.remove(sourceId)` 仍嵌 `if (attachment?.resourceId)` 分支内（:249-250）——孤儿附件单删时 cancel 发但 store 条目不清，与 clearAttachments（:322 无条件清）不对称；r4-07 审阅点名，连续两轮登记未修 |
| P3 44px 机制 | **部分**（机制批 1–3 已落地，存量与门禁欠账） | 批 1：ComposerToolbar/水位环实体盒（r3-04）；批 2：buttonPrimitiveContract.ts:73-83 全部尺寸档追加 `[@media(pointer:coarse)]:min-h/min-w-[var(--touch-target-size)]`；批 3：eslint-rules/coarse-touch-target.js 存在、eslint.config.js:122 挂 **warn** + 40 行白名单；coarseHit.ts/TouchTarget.tsx 共享出口在 | 批 4 codemod 未做：全库 coarse 散点存量（r1 计 4079 处）、anki ~90 处冗余覆盖原样；**lint 仍 warn 未升 error**（自注释：清完存量后升，目标第 8 轮） |
| P4 coarse 兼当移动+相机 | **已落地**（采用平台判定折衷） | `canCapturePhoto`（inputBarCapabilities.ts，platform 判定，无 enumerateDevices）；布局仍 isMobile 断点（设计如此） | 触屏 Windows/键鼠平板真机表现未验证（折衷本身已登记） |
| P5 InlinePanel 四小项 | **已落地** | ①closing 期 inert（ComposerInlinePanel.tsx 内 9 处 inert 相关）+ aria-hidden；②clamp 二段下限；③`inlineAriaLabel` 全部 t()（InputBarUI.tsx:2152-2179，skills:title/common:chat_controls zh+en 双语键均在，python3 核验）；④role=img 已随 R3 去除 | 键盘态真机布局未验证 |
| P6 动态 i18n 键盲区 | **部分**（缺键已补，测试侧欠账） | sidebar section_study/section_manage 双语已补（R1，提交 98bbf3f1）；Composer 侧无实际缺键（r1 已核） | **契约测试未升级**：inputBarSplitI18nKeys.contract.test.ts 无 uploadStage/permissionPreset 模板键枚举展开、AttachmentPreviewChips/ContextUsagePopover/ComposerInlinePanel/ComposerPanel 四文件未入清单（本轮 grep 零命中）——卡 4 只做了一半；第 5 轮 check-i18n/i18n-alias/i18n-ast 三席位应正在补此面，对账时点未落盘 |
| P7 PDF/EPUB | **未做→在途**（V1 高危项截至 HEAD 未修） | PdfSelectionActions.tsx:79-81 back handler 仍无守卫（`registerBackHandler(() => { closePanel(); return true; })`，无 isConnected/getClientRects/visibility）；`registerVisibilityGuardedBackHandler` 全库零命中；V2 手贴收敛、V4 132 魔数均未动 | 卡 6 全部内容；**r5-pdf-chrome 席位在途正改这三个文件**，本轮结束后需按其 diff 重新对账 |
| P8 键盘/back 底座 | **部分** | 发现#2 让行：InputBarUI.tsx:1434 已做；androidBackCoordinator 测试 2 份已写（menuThenPanel + order.source，R2） | 发现#1 **未修**：ShadApiEditModal.tsx:50 仍 import `../hooks/useKeyboardInset`（旧双轨 hook 原样存在）；McpToolsSection/Todo 详情让行未做；useKeyboardHeight 零单测 |

## 二、扫描员补充项（任务卡 5/7/8/9）对账

| 卡 | 状态 | 证据 |
|---|---|---|
| 卡 5 learning-hub F1/F2/F3/F4 | **未做** | NoteContentView.tsx 无 useMobileSubviewChrome（grep 0）；FinderQuickLook.tsx 无 registerBackHandler（grep 0）。第 5 轮 hub-chrome 席位对账时点未落盘 |
| 卡 7 settings 触控点+键盘双轨 | **未做** | 旧 useKeyboardInset.ts 存在且被 ShadApiEditModal 消费；WorkbenchSettingsSection:742 折叠钮仍 `py-1 text-xs` 裸样式无 44 触控 |
| 卡 8 数据治理宽表卡片化 | **未做** | `ResponsiveDataList` 全库零命中；BackupTab 6 列宽表原样 |
| 卡 9 anki/qbank Checkbox+可访问名 | **未做** | shad/Checkbox.tsx 无 coarse 热区（grep 0）。第 5 轮 anki-chrome 席位对账时点未落盘 |

按 10 张任务卡计：卡 1/2/3 落地，卡 4 半张（P5 done、P6 契约没做），卡 10 约四成（InputBarUI 让行+coordinator 测试），卡 6 在途，卡 5/7/8/9 未动。修复面 ≈ **4.9/10 张卡**。

## 三、第 6 轮二检必须翻的前 5 项（按风险降序）

1. **owned-overlay 尚未接线（P1 长修空转）**——高危族 P1 目前只靠 `closest('[data-app-menu-id]')` 短修防守，该谓词不限定 menuId（r2-08 审阅已点名）：任何带该属性的 portal 都能豁免 Composer 外点关闭，误保护面未知；28 处外点监听零迁移，OverlayCoordinator 的 registerOwnedOverlay 是死代码。二检动作：翻 overlayOwnership.ts 消费点（应仍为 0），核 closest 是否已限定实例 id；若第 6 轮接线，逐监听点对账迁移清单。
2. **真机/运行验证空白（1–5 轮零执行）**——所有「已落地」仅静态 grep 证据；五轮写下的全部测试文件（pointer 全链、back 栈、attachmentLifecycle、hit source、lint 规则单测等 20+ 份）一次未跑，tsc/lint 也零执行。任何一处语法或断言错误都会把「已验证」整列降级。二检动作：若第 6 轮解禁执行，首个动作跑 vitest 全量 + tsc；仍禁则至少人工复核新测试文件的 import/断言可运行性，并明确标注运行置信 = 0。
3. **pdf store remove 仍嵌 resourceId 分支（P2 残债，连续两轮登记未修）**——sessionActions.ts:249-250 的 `usePdfProcessingStore.remove(sourceId)` 在 `if (attachment?.resourceId)` 内：孤儿附件（有 sourceId 无 resourceId）单删后 store 条目残留，与 clearAttachments 行为不对称。修复一行级（提到 sourceId 顶层守卫），风险在「永远被登记从不被修」+ 配套孤儿用例测试现钉住缺陷现状，修时须同步改测试。二检动作：核该行是否仍在 resourceId 分支内。
4. **lint 仍 warn 未升 error（门禁不闭环）**——coarse-touch-target 规则 warn 态无阻断力，散点可无感回流；升 error 前置条件（批 4 codemod 清 ~4000 存量 + anki ~90 冗余）完全未做；40 行白名单无人复审。二检动作：核 eslint.config.js:122 严重级、白名单 diff、存量计数是否开始收敛（对照 r1-09 报告 4079 基数）。
5. **宽表未卡片化（卡 8 整卡未动）**——BackupTab 6 列宽表+每行 4 动作（规范④最重违规，操作列初始视口外）原样；ResponsiveDataList 未建；SyncTab/AuditTab/OverviewTab 同欠。实施时须守 WebDAV/S3/FTP 禁区（不变量 13–15），只动展示层。二检动作：翻 settings-chrome 席位产出（本轮在途），核是否只动了展示层、禁区 rg 零命中。

（次级欠账，不进前 5 但登记：卡 5 learning-hub 三 FAIL、卡 7 键盘双轨、卡 9 Checkbox 热区、P6 契约升级、P7 V2/V4、P8 发现#1、McpToolsSection 让行、useKeyboardHeight 单测。）

## 四、完成度诚实估计（第 1–5 轮审+改，95% 置信）

- **审阅/定性面**：P1–P8 全部完成属实性判定 + 全库五规范逐页核验 + ~70 back 注册点/28 外点监听/44px 存量全表——审阅覆盖 ≈ 完成（静态口径）。
- **修复面（按任务卡加权）**：落地 ≈ 4.9/10 卡；若按风险权重（P1 短修与 P3 机制地基权重高）加权约 55–60%。第 5 轮在途席位（卡 6 + 各域 chrome + i18n 契约）若全部落盘可再推 15–20 个百分点，但对账时点不可计入。
- **验证面**：0%——零测试执行、零编译/类型检查、零真机。所有「已落地」的运行置信为空。
- **综合诚实估计**：静态口径整体完成度 **50%–60%（95% 置信区间）**，点估计 55%；经运行验证的完成度 **0%**。两个口径必须分开报，合并成单一数字会掩盖「五轮全部产出未经一次执行」这一最大事实。

## 四点五、对账时点补记（并发落盘）

对账收尾时（15:52–15:55）观察到同轮席位并发落盘：/tmp/0824-wave2-c-r5/ 新增 `02-pdf-chrome.md`、`07-i18n-alias.md`；/workspace 工作树出现非本席位改动 `tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts`（+11 行，内容为 i18n-alias 席位的 `common:actions.more` alias 裁决断言）。该改动**不是** P6 所欠的模板键枚举/四文件清单升级，P6「部分」结论不变。本对账的全部 grep 证据取证于 HEAD `cf8eb9e8` 干净树时点；第 6 轮二检时第 5 轮各席位产出已全部落盘，须以届时 HEAD 重新取证，不得转抄本表。

## 五、声明

- 本轮未标注 Goal complete；按指令不得标注。
- 第 6 轮欠账首位清单（用户钦定五项，均已在本文第三节按风险展开）：owned-overlay 尚未接线、pdf store remove 仍嵌 resourceId、宽表未卡片化、lint 仍 warn、真机空白。
- 本对账未运行任何测试/编译/lint；未修改产品代码；未 git commit。
