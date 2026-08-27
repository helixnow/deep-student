# Wave2-C R9 · 死键 / 死类清理（仅本域）

范围：input-bar、MobileSidebarNavigation、mobile chrome（`src/components/layout/`）、
chatV2 `inputBar.*` / `selectionToolbar.*`。方法沿用 `scripts/check-i18n.mjs` 与
`tests/vitest/mobile-uiux/i18nKeyExtract.ts` 的提取思路（字面量 ns 键 / 裸键按
useTranslation 命名空间解析 / 模板骨架 + 枚举展开）。

## 1. 正向扫描（引用 → locale）：热区零缺键，无需补键

对 input-bar 24 个非测试源文件 + layout 10 个 mobile chrome 文件做严格
**按命名空间**（非全命名空间并集）双语解析：

| 引用形态 | 数量 | 结果 |
| --- | --- | --- |
| 显式 `t('ns:key')` / `i18nKey="ns:key"` | 333 | zh/en 全部解析到非空字符串叶子 |
| 裸键 `t('key')`（按文件 useTranslation ns + common 解析） | 44 | 全过（含复数 `_one/_other` 形态） |
| 模板键 `` t(`…${…}`) `` | 11 处 | 9 处在 `INPUT_BAR_TEMPLATE_EXPANSIONS` 注册表内；2 处 BlockingApprovalBar 无 ns 模板（`approval.sensitivity.*`、`skillInstall.approval.risk.*`），枚举 low/medium/high 双语齐全且带 fallback |

结论：本域没有引用缺失键，**本轮未补任何键**。

## 2. 反向扫描（locale → 引用）：删除 chatV2 `inputBar.*` 死键 31 叶（双语同删）

对 chatV2 `inputBar`（202 叶）与 `selectionToolbar`（18 叶）子树逐叶反查全库
（src 全量 ts/tsx，含测试；另全仓库含 scripts / src-tauri 复核）。
`selectionToolbar.*` 全部存活，未动。`inputBar` 下确认零引用后删除以下 31 叶
（zh-CN / en-US 各 -37 行）：

| 键 | 叶数 | 归因 |
| --- | --- | --- |
| `inputBar.imageGen.*`（含 `purposes.*` 4 叶） | 18 | 旧生图 composer 面板遗留（v0.9.2 起），生图现走 `skills/builtin-tools/image-generation` skill；消息块渲染键 `blocks.imageGen.*` 仍活，未动 |
| `inputBar.menuGroup.{context,aiSettings,modes,tools}` | 4 | 旧加号菜单分组标签，ComposerPlusMenu 现用别的键 |
| `inputBar.thinkingEnabled` / `thinkingDisabled` / `toggleThinking` | 3 | 旧推理开关按钮文案，现走 `thinkingState.*` / `thinkingOn` / `thinkingOff` |
| `inputBar.thinkingDepthExpensive` | 1 | `InputBarUI.thinkingRuntimeState.source.test.ts` 明确断言源码**不得**含它（"labels terse without slower suffix"），locale 侧同步清掉 |
| `inputBar.nonMultimodalImageFallback` / `…Unavailable` | 2 | 旧附件回退 toast，现走 `modesNotReady` / `completedMissingModes` 系 |
| `inputBar.ankiTools` | 1 | 旧输入栏 Anki 制卡入口标签；全库（含 anki 域）零引用。仅删 chatV2 locale 叶，不涉 anki 域代码 |
| `inputBar.toggleModelPanel` | 1 | 旧模型面板开关 aria；现走 `toggleModelMention` 等 |
| `inputBar.pasteNotReady` | 1 | 旧粘贴初始化提示，调用点已不存在 |

全部键 `git log -S` 归因 legacy（多为 v0.9.2 初始版本引入，`thinkingDepthExpensive`
为 DeepSeek reasoning controls 提交引入），**无 0824 回归**。

判活口径（不误删）：`inputBar.uploadStage.*`（3）与 `inputBar.thinkingDepth.*`（6）
是注册模板展开键，保留；`keyPrefix` 间接引用已排查（仅 OcrResultCard 空前缀，无影响）。

## 3. 官方裁决遵守 / 未动的死别名

- **`common:actions.more`**：按裁决保留作 alias，未删。组件侧已统一
  `t('common:more')`（顶层 `more` 双语存在），无组件引用 `actions.more`。
- **`sidebar:mobile_drawer.section_study` / `section_manage`**：已存在且被
  MobileSidebarNavigation 正常引用（带中文 fallback），归因 legacy 补键，
  非 0824 回归，未动。
- **mindmap.json 21 个跨语言缺键**（`import.imagePlaceholderNote` 等的
  `_one/_other` 复数形态漂移）：mindmap 域，未动。这是 `check-i18n.mjs`
  默认模式 exit 1 的**既有基线原因**（改动前后 exit code 相同，均为 1）。
- **全库 39 个 t() 引用缺失键**（crepe wikilink/callout、agentPanel、
  session-browser search、learning-hub indexStatus、mindmap canvas、
  notes editor 等）：全部在热区之外的其他域，未动。

## 4. CSS/class：input-bar 无死 coarse 常量，本轮零删除

- ComposerToolbar 已无 `coarseHitArea*` 残留（R3「命中区即盒模型」机制落地时
  已清，现只剩 hitTarget source test 注释里的历史提法）。现存私有常量
  `coarseSolidTouchTargetClass` / `coarseSolidTouchHeightClass` 及
  `iconButtonClass` / `studyUi*` 系全部有引用。
- AttachmentPanelBody 私有 `coarseRowClass` 4 处引用，活。
- 共享出口 `src/components/ui/coarseHit.ts` 的 `coarseHitClassFor32` 档位
  产品代码零直接引用（仅 `coarseHitClassByVisualSize` registry 与
  `TouchTarget.source.test.ts` 引用）——属共享 API 完整档位且不在 input-bar
  私有域，按「不要全库删 class」保留，仅在此记录。

## 5. 验证

- `chatV2.json` zh/en 叶子集合完全一致（各 1826 叶），JSON 解析通过。
- `check-i18n.mjs` 默认/strict 模式下 chatV2 无新增问题；exit 1 与基线同因
  （mindmap 复数漂移 + 其他域引用缺失），非本轮引入。
- vitest：`input-bar/__tests__` + `layout/__tests__` 32 文件 256 测试全绿；
  `tests/vitest/mobile-uiux/` 11 文件 140 测试全绿（含
  `chatV2I18nContract`、`inputBarSplitI18nKeys.contract`、
  `i18nDynamicKey.matrix`、`InputBarUI.thinkingRuntimeState.source`）。

改动面：仅 `src/locales/zh-CN/chatV2.json`、`src/locales/en-US/chatV2.json`
（-37/-37 行）与本文档。无产品代码 / CSS / CI / coordinator / tool_loop / anki
域改动，无散点 44px。
