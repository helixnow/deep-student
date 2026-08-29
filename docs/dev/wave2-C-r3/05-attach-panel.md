# 0824 Wave2-C 第 3 轮：替换-附件面板（行目标体系化）

- 基线：`e90fb360`（fix: recognize AppMenu portal in composer outside-click）
- 独占文件：
  - `src/features/chat/components/input-bar/AttachmentPanelBody.tsx`
  - `src/features/chat/components/input-bar/ComposerPlusMenu.tsx`
- 未 commit（按要求），工作树 diff：2 files changed, 46 insertions(+), 22 deletions(-)

## 目标

菜单行/列表行在 `pointer: coarse` 下由**实体元素**保证 ≥44px 高度：
统一走 `min-h-[var(--touch-target-size)]`（token = `--control-height-touch` = 44px，
定义于 `src/styles/shadcn-variables.css`），或沿用已有 DsButton 的触控高度；
去掉 `after:` 伪元素扩区（与相邻控件命中重叠）。

## 改动明细

### ComposerPlusMenu.tsx

1. **移动端扁平菜单行**：`mobileItemClass` 由无条件 `min-h-[44px]`（魔法数、跟随布局断点）
   改为 `[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]`（跟随设备能力、走 token）。
   覆盖全部扁平菜单行：添加文件/拍照/资源库/压缩上下文/Plan/Ask 开关/权限预设 4 行/知识库开关/技能/连接器/对话控制。
   - 语义变化：窄窗口 + 精确指针（桌面缩窄）时菜单行回落到桌面密度；coarse 设备不变
     （`AppMenu.css` 的 `@media (pointer: coarse) { .app-menu-item { min-height: 44px } }` 基线仍兜底，
     行内类将其体系化为 token 表达）。
2. **`plus-menu-switch-to-plan` 内联按钮**：`[@media(pointer:coarse)]:min-h-11` → token 写法
   `[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]`（该处无 `!`，不属于禁改的 `!min-h-11` 散点）。
3. **`full-access-active` / `danger-full-access-active` 两个权限 chip（伪元素扩区移除）**：
   - 删除 `after:absolute after:-inset-y-1.5 after:-inset-x-1 [@media(pointer:coarse)]:after:-inset-y-2.5`
     ——原伪元素横向 ±4px 扩区在 `gap-1`（4px）工具条上与相邻 "+" 按钮命中重叠。
   - 重构为：外层 `<button>` 是实体命中区（`group inline-flex items-center justify-center` +
     coarse 下 `min-h-[var(--touch-target-size)]`），视觉胶囊下沉为内层 `<span>`（保持
     `h-6` / `rounded-md` / 背景 / 文字样式全部不变，hover/focus 样式经
     `group-hover` / `group-focus-visible` 等价迁移到胶囊上）。
   - 精确指针下按钮高度仍由 `h-6` 胶囊内容撑起（24px，视觉与布局同前）；coarse 下按钮实体
     44px 高但透明，工具条高度不变（相邻 "+" 按钮本就 `!min-h-11`）。
   - `data-testid`、`title`/`aria-label`、点击降级行为均未动。

### AttachmentPanelBody.tsx

1. 新增模块级常量 `coarseRowClass = '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]'`，
   收敛行高写法。
2. **移动端 ⋯更多菜单的 3 个 `AppMenuItem`**（资源库/拍照/全部清除）：`min-h-[44px]` → `coarseRowClass`。
3. **附件列表行容器**（`attachment-row` div）：追加 `coarseRowClass`，列表行实体在 coarse 下 ≥44px
   （行内 重试/移除 DsButton 原有 `[@media(pointer:coarse)]:!min-h-11` 未动）。

## 明确未动（按任务边界）

- sessionActions、InputBarUI、AppMenu（组件与 CSS）行为：0 改动。
- DsButton 上的 `!min-h-11` / `!h-11 !min-w-11` 散点：全部保留原样
  （`InputBarUI.mobileSplitContract.source.test.ts` 对 `AttachmentPanelBody.tsx` 断言
  `className="!h-11 !min-w-11"` 存在且 `[@media(pointer:coarse)]:!min-h-11` ≥7 处——现仍为 7 处，契约不受影响）。
- 附件删除生命周期（`handleRemoveAttachment` / `handleClearAllAttachments` / cancelPdfProcessing / revokeObjectURL）：0 改动（留给第 4 轮）。
- i18n 动态键逻辑（`uploadStage.${...}`、`permissionPreset.*.${preset}` 等模板键）：0 改动。
- 图标：全部尺寸/weight/组件不变（chip 内 12px 图标仅换了父容器层级）。
- 其他文件（ComposerToolbar、PageRefChips、ModelPicker、BlockingAskUserBar 等）的
  `after:` 伪元素扩区：不在本轮独占范围，未动。

## 测试契约核对（静态核对，禁跑 runner）

- `ComposerPlusMenu.test.tsx`：`full-access-active` 断言 `className` 含 `inline-flex`（新按钮类含）✅；
  点击降级 `relaxed` 行为未变 ✅；textContent 仍只含标签 ✅。
- `permissionPresets.source.test.ts`：只扫 preset 字面量与 i18n 文案，未涉类名 ✅。
- `InputBarUI.mobileSplitContract.source.test.ts`：见上，两条 AttachmentPanelBody 断言仍满足 ✅。
- `chatV2I18nContract.test.ts` / `releaseUpgradeI18n.test.ts`：t() 调用零改动 ✅。

## 风险备注

- 精确指针 + 移动布局（桌面窗口缩窄）下，扁平菜单行与附件面板 ⋯菜单行由固定 44px 回落为
  AppMenu 默认行高——这是「行目标跟随指针能力而非布局断点」的预期语义收敛；触屏设备无回归。
- 两个权限 chip 的横向命中区不再越界 ±4px（原重叠即为要移除的问题）；chip 自身宽度
  （图标+文字+padding，约 50–70px）已满足横向触控目标。
