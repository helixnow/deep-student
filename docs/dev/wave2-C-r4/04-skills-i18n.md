# Wave2-C R4 · 04 Skills / MCP 内联面板 aria-label 国际化

- 模型：claude-fable-5-thinking-high
- 基线：af0be136
- 工作目录：/tmp/0824-wave2-c-r4-skills-i18n
- 独占文件：`src/features/chat/components/input-bar/InputBarUI.tsx`

## 改动

`InputBarUI.tsx` 移动端内联面板（`inlineComposerPanelNode` switch，约 :2148-2183）的两个硬编码英文 aria-label 改为 t()：

| case | 改前 | 改后 | 键来源 |
| --- | --- | --- | --- |
| `'mcp'` | `inlineAriaLabel = 'MCP'` | `t('analysis:input_bar.mcp.title')` | 已有键：zh「MCP工具」/ en「MCP Tools」（`src/locales/{zh-CN,en-US}/analysis.json` `input_bar.mcp.title`） |
| `'skill'` | `inlineAriaLabel = 'Skills'` | `t('skills:title')` | 已有键：zh「技能」/ en「Skills」（`src/locales/{zh-CN,en-US}/skills.json` 顶层 `title`，与 ComposerPlusMenu :428/:606 同键） |

附带一处必要改动（同文件 :281）：`useTranslation` 命名空间列表补 `'skills'`（`['analysis', 'common', 'chatV2', 'settings', 'skills']`），与 `ComposerPlusMenu.tsx` :138 的用法一致。`src/i18n.ts` 的 `ALL_NS` 已含 `skills` 且 `useSuspense: false` + `bindI18nStore: 'added'`，显式前缀本可解析，此处仅为对齐「组件 useTranslation 引用与实际使用一致」的仓库约定。

## 未补任何 locale 键

MCP 与 Skills 的双语键均已存在（见上表），locales 目录零改动。任务预留的「缺键才补」分支未触发。

## 边界确认

- 未触碰 `isWithinComposerTerritory`、pointerdown 外点收起、Android back handler、`inputBarCapabilities` 相机逻辑（git diff 全文仅 3 行，均在 :281 与 :2163-2179）。
- 未改 `ComposerToolbar.tsx`（水位环 role=img 第 3 轮已处理）。
- 同 switch 内其余 case 本就已 i18n（attachment → `analysis:input_bar.attachments.title`，model → `runtimeModelTitle`，advanced → `common:chat_controls`），未动。

## 新增 source 测试（未执行，按规禁跑）

`src/features/chat/components/input-bar/__tests__/InputBarUI.inlinePanelAriaI18n.source.test.ts`：

1. 断言 InputBarUI.tsx 不再出现 `inlineAriaLabel = 'MCP'/'Skills'`，并全文件兜底禁止任何 `'MCP'`/`'Skills'` 字符串字面量（写作时已 grep 确认 0 处）。
2. 断言两处 aria-label 走 `t('analysis:input_bar.mcp.title')` / `t('skills:title')`。
3. 断言四个 locale 文件中对应键真实存在（zh/en × analysis/skills）。

## 状态

代码 + 测试已落盘，未 commit（按任务要求）。
