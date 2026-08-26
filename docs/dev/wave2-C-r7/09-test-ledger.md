# 0824 Wave2-C 第 7 轮 09 — 测试台账（本会话新增测试全量清单 × P1–P8 × 预期红绿 × 第 8 轮执行清单）

- 席位：第 7 轮测试台账员（claude-fable-5-thinking-high）。只读盘点，未执行任何测试/编译/lint，未 git commit，未改任何代码。
- 取证基线：/workspace HEAD `0f5435a7`（fix: wire owned overlays and un-nest pdf store cleanup），分支 `cursor/0824-wave2-mobile-uiux-a875`，对照基线分支 `cursor/0824-cde6`。工作树仅 `docs/dev/wave2-C-ledger.md` 有他席位在途改动，无未跟踪测试文件。
- 取证方法：`git diff --name-status cursor/0824-cde6...HEAD` 限定 tests/、__tests__/、*.test.*；逐文件 `git log --diff-filter=A` 归属提交/轮次；逐文件提取 describe/it 断言标题；比对 r1–r6 各席位 /tmp 台账。
- 时点声明：盘点时刻（16:18–16:25）第 7 轮 8 个并行席位工作树（/tmp/0824-wave2-c-r7-{a11y-seq,attach-seq,back-matrix,hit-gap,i18n-matrix,kb-inset,ptr-matrix,safe-area}）全部干净在 HEAD `0f5435a7`，**尚无任何未合入新测试**。第 7 轮若晚于本时点落盘新测试，不在本清单内，第 8 轮开跑前须先 `git status` + 重新 diff 一次补收。

---

## 一、本会话新增测试文件全量清单（22 个新增 + 4 个既有文件本会话扩展）

提交→轮次对照：`e90fb360`=R2，`752b592c`=R3，`2d78f248`=R4，`b35038a8`=R5，`0f5435a7`=R6。

### 新增（A，22 个）

| # | 文件 | 轮次 | 行数 | 类型 | 钉住内容 |
|---|---|---|---|---|---|
| 1 | `src/app/navigation/__tests__/androidBackCoordinator.menuThenPanel.test.ts` | R2 | 195 | 运行时（coordinator 栈） | 菜单叠面板 LIFO：back 先关菜单再关面板，第三次交还 native；overlay 档优先 |
| 2 | `src/app/navigation/__tests__/androidBackCoordinator.order.source.test.ts` | R2 | 86 | source 契约 | 同优先级按注册 seq 倒序；AppMenu/InputBarUI 均恰以 `BACK_PRIORITY.overlay` 注册、开着才注册 |
| 3 | `src/components/shared/__tests__/OverlayCoordinator.ownership.source.test.ts` | R2 | 73 | source 契约 | ownership API 纯加法扩展、ref-backed 免渲染、fail-empty、委托 overlayOwnership 模块 |
| 4 | `src/components/shared/__tests__/overlayOwnership.test.ts` | R2 | 105 | 运行时（纯函数） | element/selector 双注册匹配、per-ownerId 隔离、unregister 幂等、target 归一化 |
| 5 | `src/components/ui/app-menu/AppMenu.visualViewport.source.test.ts` | R2 | 79 | source 契约 | 菜单定位改用共享 visualViewport util，双效果订阅，window 监听降级为 passive fallback |
| 6 | `src/components/ui/__tests__/TouchTarget.source.test.ts` | R3 | 62 | source 契约 | coarse 下 ≥44px 实体盒（min-h/min-w token）、flex 居中、asChild、禁伪元素扩区/!min-h-11 逃逸 |
| 7 | `src/components/ui/__tests__/buttonPrimitiveContract.coarse.source.test.ts` | R3 | 94 | source 契约 | 每档 lg 紧凑后追加 coarse min-h/min-w 地板；只 min-* 不动视觉高度；桌面 fine 不受影响 |
| 8 | `src/features/chat/components/input-bar/__tests__/ComposerToolbar.adjacentHit.test.tsx` | R3 | 345 | 运行时（jsdom） | 右簇相邻热区归属：点击单一归属无串扰、stop/send/水位环各自实体盒、热区矩形不重叠 |
| 9 | `src/features/chat/components/input-bar/__tests__/ComposerToolbar.hitTarget.source.test.ts` | R3 | 150 | source 契约 | 右簇不再用 after:-inset 伪元素默认扩区；水位环单一热区所有者；控件顺序与 testid 归属 |
| 10 | `src/features/chat/components/input-bar/__tests__/inputBarCapabilities.test.ts` | R3 | 127 | 运行时+source | P4 三分离：Android/iOS 直判可拍照、桌面不出拍照口、触摸=any-pointer:coarse、无 enumerateDevices |
| 11 | `tests/vitest/coarseTouchTargetRule.test.ts` | R3 | 136 | 运行时（RuleTester） | eslint 规则 coarse-touch-target 的命中/豁免/报错文案矩阵 |
| 12 | `tests/vitest/mobile-uiux/touchTargetOwnership.contract.test.ts` | R3 | 149 | source 契约 | 每个登记触控点恰一个生产所有者；水位环跨文件唯一热区；所有者文件均含 coarse 处理 |
| 13 | `src/features/chat/components/input-bar/__tests__/AttachmentPreviewChips.removeCancels.source.test.ts` | R4 | 113 | source 契约 | chip 层保持薄（只委托 onRemove）；store 层 remove/clear 含 cancelPdfProcessing（写时标注"卡 1 落地前红"，卡 1 同提交落地） |
| 14 | `src/features/chat/components/input-bar/__tests__/ComposerInlinePanel.focusOrder.source.test.ts` | R4 | 132 | source 契约 | 开面板=可命名 region、不对 open 面板 aria-hidden/inert；Tab 顺序=DOM 顺序、禁正 tabindex |
| 15 | `src/features/chat/components/input-bar/__tests__/ComposerInlinePanel.focusOrder.test.tsx` | R4 | 128 | 运行时（jsdom） | open 面板暴露为带名 region；内联面板→输入区→发送钮 DOM 顺序 |
| 16 | `src/features/chat/components/input-bar/__tests__/ComposerInlinePanel.inertClamp.source.test.ts` | R4 | 79 | source 契约 | 折叠态 inert+aria-hidden；160px 下限受可用空间守卫（0px 硬底）；桌面 overlay 本轮不动 |
| 17 | `src/features/chat/components/input-bar/__tests__/InputBarUI.inlinePanelAriaI18n.source.test.ts` | R4 | 36 | source 契约 | inline panel aria-label 全走 t()，无 MCP/Skills 硬编码，双语键存在 |
| 18 | `src/features/chat/core/store/__tests__/sessionActions.attachmentLifecycle.test.ts` | R4（R6 随 un-nest 修同步更新） | 433 | 运行时（store） | P2 全链：remove/clear 按 sourceId 取消后端恰一次、孤儿附件（无 resourceId）同样清 pdf store、blob 恰 revoke 一次、cancel fire-and-forget、不伤旁附件 |
| 19 | `src/features/chat/components/input-bar/__tests__/InputBarUI.androidBack.sequence.test.tsx` | R2 | 213 | 运行时（jsdom） | 菜单开→back→面板仍开→back→面板关→back 交还 native；只开面板一次 back 关 |
| 20 | `src/features/chat/components/input-bar/__tests__/InputBarUI.appMenuOutsideClick.pointer.test.tsx` | R2（R3 小改） | 287 | 运行时（jsdom）+source | P1 案发链全链：资源库/拍照/清空三菜单项 pointerdown 不误杀、click 达成动作；`[data-app-menu-id]` 豁免；真外点仍关面板 |
| 21 | `tests/vitest/check-i18n.script.source.test.ts` | R5 | 77 | source 契约 | check-i18n 脚本 --strict、失败分类、双语静态引用扫描、退出码语义、npm script 挂接 |
| 22 | `tests/vitest/mobile-uiux/chatHeaderRightActionsContract.test.ts` | R5 | 104 | source 契约 | 规范③：chat 顶栏每分支 1–2 个快捷动作、全部经 DsButton（继承 coarse 44px 地板） |

### 既有文件本会话扩展（M，4 个）

| # | 文件 | 扩展轮次 | 净增 | 扩展内容 |
|---|---|---|---|---|
| 23 | `src/components/ui/__tests__/migrationFoundation.source.test.ts` | R3 | +14/-2 | primitives 平板保持触控尺寸、仅 lg 紧凑（配合批 2 coarse 地板） |
| 24 | `src/features/chat/components/input-bar/__tests__/InputBarUI.mobileSplitContract.source.test.ts` | R3 | +5/-0 | coarse 工具栏/附件面板动作 ≥44px 断言加严 |
| 25 | `src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts` | R5 | +18/-4 | P7 V1 落地后的 selection toolbar 挂载/能力接线断言更新 |
| 26 | `tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts` | R5（R1 起多轮累加） | +180 累计 | 模板键枚举展开、四文件入清单、known-gaps 自清洁清单、`common:actions.more` alias 裁决、枚举漂移守卫 |

统计：26 文件、净 +2869/-约 40 行（tests 口径）；纯 source 契约 15 份、运行时（jsdom/store/纯函数/RuleTester）8 份、混合 3 份。

---

## 二、P1–P8 覆盖矩阵

| 项 | 覆盖测试（表一编号） | 覆盖评价 |
|---|---|---|
| P1 外点误杀 | #20（案发链全链红绿）、#3、#4（owned-overlay 机制层）、#5（AppMenu 定位不回归） | **厚**：短修（closest 豁免）与长修（ownership 纯函数层）均有钉。缺口：R6 `0f5435a7` 的 InputBarUI/AppMenu **生产接线**（registerOwnedOverlay 消费点）尚无专属接线契约测试——#3/#4 只测机制模块本身 |
| P2 附件清理单一所有者 | #18（433 行全链）、#13（chip 薄层红线） | **厚**：含孤儿附件 un-nest（R6 修）与双 revoke 加严。缺口：无 |
| P3 44px 触控机制 | #6、#7、#8、#9、#11、#12、#23、#24 共 8 份 | **最厚**：token/primitive/工具栏几何/lint 规则/所有权契约五层。缺口：lint 仍 warn（升 error 属第 8 轮门禁事项，非测试缺口）；全库存量散点无测试（本来就靠 lint 管） |
| P4 coarse 兼职相机/移动 | #10（运行时矩阵+三分离 source 契约） | **足**：平台判定折衷已钉。缺口：真机行为无自动化（已知折衷） |
| P5 InlinePanel 四小项 | #14、#15、#16、#17 | **足**：inert/clamp/aria-label i18n/焦点序四项全钉，且 source+运行时双口径。缺口：键盘态真机布局 |
| P6 动态 i18n 键盲区 | #26（模板键枚举+漂移守卫+自清洁 gaps）、#21（check-i18n 脚本契约） | **足**（R5 升级后）。缺口：`check:i18n` 脚本本身一次未真跑 |
| P7 PDF/EPUB | #25（selection toolbar 挂载/能力接线） | **薄**：仅 V1 侧 toolbar 契约。缺口：`registerVisibilityGuardedBackHandler` 守卫语义、V2 手贴收敛、V4 魔数均无专属测试 |
| P8 键盘/back 底座 | #1、#2、#19（back 栈三份） | **中**：coordinator 栈语义+产品注册点已钉。缺口：useKeyboardHeight/键盘 inset 双轨零单测（r5 对账遗留，本会话始终未补） |

覆盖结论：P1–P6、P8 均有测试着陆；P7 最薄；横向缺口两处——**owned-overlay 生产接线契约**与**键盘 inset hook 单测**，建议第 8 轮补写或明示放弃。

---

## 三、预期红绿（HEAD `0f5435a7` 静态预判；全部测试至今 0 次执行，运行置信=0）

**预期全绿（26/26）。** 依据：所有写作时标注"修复前红"的用例，其对应修复均已在同轮或后续轮落地——

- #20 的 P1 豁免（R2 `e90fb360` 同提交落修复）；
- #13/#18 的卡 1 store cancel（R4 `2d78f248` 同提交落）；
- #18 的孤儿附件 un-nest 断言（R6 `0f5435a7` 修复与测试同提交更新）；
- #25 的 P7 V1（R5 `b35038a8` 落地，r6-08 复核通过）；
- 其余均为钉现状的守卫型契约，写作时即对着已落地源码取证（r6 各席位对 #6/#7/#14/#16/#26 做过静态复刻比对，均 PASS）。

**翻红风险点（第 8 轮首跑时重点看）：**

1. **jsdom 运行时 4 份**（#8、#15、#19、#20）风险最高：mock/portal/pointer 事件序在真实 vitest 环境下从未验证过，任何 setup 缺失（如 visualViewport、matchMedia mock）都可能整文件红。
2. **#18（433 行 store 测试）**：R6 un-nest 改动与测试同提交手改，无执行验证，断言与实现错位可能性存在。
3. **#26 的 known-gaps 自清洁清单**：设计即"缺键修好后此表必须删行否则红"——若 R5/R6 补键后清单未同步清理，按设计翻红（这是期望行为，红了应删清单行而非改产品）。
4. **#11（RuleTester）**：依赖 eslint RuleTester API 版本行为，未跑过。
5. 全部 source 契约测试共同风险：正则/切片锚点对源码格式敏感，第 7 轮并行席位若改动被锚定文件（InputBarUI/AppMenu/ComposerInlinePanel/sessionActions），可能连带翻红——第 8 轮必须在第 7 轮全部落盘合入后的 HEAD 上跑。

---

## 四、第 8 轮应跑的 vitest 文件 glob

一把梭（本会话全部 26 份，建议第一跑）：

```bash
npx vitest run \
  'src/app/navigation/__tests__/androidBackCoordinator.*.test.ts' \
  'src/components/shared/__tests__/{overlayOwnership,OverlayCoordinator.ownership.source}.test.ts' \
  'src/components/ui/__tests__/{TouchTarget.source,buttonPrimitiveContract.coarse.source,migrationFoundation.source}.test.ts' \
  'src/components/ui/app-menu/AppMenu.visualViewport.source.test.ts' \
  'src/features/chat/components/input-bar/__tests__/*.test.{ts,tsx}' \
  'src/features/chat/core/store/__tests__/sessionActions.attachmentLifecycle.test.ts' \
  'src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts' \
  'tests/vitest/check-i18n.script.source.test.ts' \
  'tests/vitest/coarseTouchTargetRule.test.ts' \
  'tests/vitest/mobile-uiux/*.test.ts'
```

按 P 项分组重跑用（定位翻红时）：

| 分组 | glob |
|---|---|
| P1 外点/浮层 | `src/features/chat/components/input-bar/__tests__/InputBarUI.appMenuOutsideClick.pointer.test.tsx` `src/components/shared/__tests__/*.test.ts` `src/components/ui/app-menu/AppMenu.visualViewport.source.test.ts` |
| P2 附件 | `src/features/chat/core/store/__tests__/sessionActions.attachmentLifecycle.test.ts` `src/features/chat/components/input-bar/__tests__/AttachmentPreviewChips.removeCancels.source.test.ts` |
| P3 触控 44px | `src/components/ui/__tests__/*.test.ts` `src/features/chat/components/input-bar/__tests__/ComposerToolbar.*.test.{ts,tsx}` `tests/vitest/coarseTouchTargetRule.test.ts` `tests/vitest/mobile-uiux/touchTargetOwnership.contract.test.ts` `src/features/chat/components/input-bar/__tests__/InputBarUI.mobileSplitContract.source.test.ts` |
| P4 能力 | `src/features/chat/components/input-bar/__tests__/inputBarCapabilities.test.ts` |
| P5 InlinePanel | `src/features/chat/components/input-bar/__tests__/ComposerInlinePanel.*.test.{ts,tsx}` `src/features/chat/components/input-bar/__tests__/InputBarUI.inlinePanelAriaI18n.source.test.ts` |
| P6 i18n | `tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts` `tests/vitest/check-i18n.script.source.test.ts` |
| P7 PDF | `src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts` |
| P8 back 栈 | `src/app/navigation/__tests__/androidBackCoordinator.*.test.ts` `src/features/chat/components/input-bar/__tests__/InputBarUI.androidBack.sequence.test.tsx` |

第 8 轮执行注意：①先确认第 7 轮 8 个并行席位产出已全部合入 HEAD，并重跑一次 `git diff --name-status cursor/0824-cde6...HEAD -- '**/tests/**' '**/__tests__/**' '**/*.test.*'` 补收本清单外的新测试；②首跑除 vitest 外应连带 `npx tsc --noEmit` 与 `npm run check:i18n`（脚本零真跑）；③翻红优先按本文第三节风险点归因，区分「测试环境缺 mock」「实现真缺陷」「自清洁清单需删行」三类再动手。

---

## 五、声明

- 本轮未标注 Goal complete；按指令不得标注。
- 未执行任何测试/编译/lint/npm/node；未修改 /workspace 任何文件；未 git commit。
- 本台账所有文件归属、行数、断言标题均于 HEAD `0f5435a7` 直接取证，未转抄前轮台账（P1–P8 定义与轮次-提交映射引自 r5-09 对账并经 git log 复核）。
