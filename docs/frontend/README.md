# 前端 UI / 视觉规范

写 UI、评审 UI PR、或让 AI 代理改界面时，先查这里。这里记录的是代码**今天实际怎么做**，以及**新代码必须怎么做**。所有 token 名、文件路径、组件名、数值都对照源码核实过（基线提交 `04932be8`，其中棘轮计数已同步当前 `scripts/lint/lint-ratchet-baseline.json`）。文档与代码冲突时以代码为准，并回头修正文档。

## 文档索引

| 文档 | 内容 | 谁要读 |
|---|---|---|
| [design-tokens.md](./design-tokens.md) | 颜色分层与语义名、暗色与调色板、字号/字体、尺寸与间距、圆角、阴影、z-index、断点、动效；如何新增 token | 写样式的所有人；改 `src/styles/*` 前必读 |
| [components.md](./components.md) | 每种需求对应的标准组件（按钮、弹窗、菜单、提示、表单控件、滚动、通知、加载/空/错态）与不该再用的旧实现；图标规则 | 写 TSX 的所有人 |
| [patterns.md](./patterns.md) | 桌面/移动壳、触控目标、安全区、滚动、焦点与键盘、减少动态、加载/空/错态、i18n、暗色自查 | 做页面级或移动端改动的人 |
| [ui-review-checklist.md](./ui-review-checklist.md) | 一页式勾选清单，每项链接到解释它的章节和执行它的 lint 规则 | 评审者、AI 代理（每个 UI PR 跑一遍） |
| `architecture.md`（待写） | 前端分层架构 | 本目录不覆盖分层，届时见该文件 |

最少阅读路径：只改一个组件的样式 → `components.md` 对应小节 + `ui-review-checklist.md`；新增 token 或改主题 → `design-tokens.md` 全文。

## 优先级

1. **Lint 规则**（`eslint.config.js` + `scripts/lint/eslint-rules/*`、`.stylelintrc.json`）。机器能拦的以机器为准。
2. **本目录文档**。
3. **`docs/CODE_STYLE.md`**：通用代码风格规范；涉及前端 UI / 视觉细则时以本目录为准（详见 [components.md §滚动](./components.md#scroll) 和 [patterns.md §触控目标](./patterns.md#touch)）。

规则在本目录写了“必须”，但 lint 只给 `warn`（例如原生 `<button>`、`text-[Npx]`）：新代码按“必须”执行，不允许新增 warning。

<a id="debt"></a>
## 现有欠账（不要再加）

以下是当前棘轮基线与白名单中的存量问题。本目录不要求顺手修，但**新代码不得增加计数**。受棘轮约束的 ESLint 规则由 `npm run check:lint-ratchet`（基线文件 `scripts/lint/lint-ratchet-baseline.json`）按 `(规则, 模块)` 冻结，只减不增。

| 欠账 | 存量 | 对应规则 |
|---|---|---|
| `text-[Npx]` 等硬编码字号（不随界面字号缩放） | 816（棘轮基线） | `ds-components/no-arbitrary-font-size`（全局 warn，`src/components/ui/**` error；`npm run check:lint-ratchet` 冻结） |
| JSX `className` / `style` 中的硬编码颜色（hex、`rgb()`/`hsl()` 字面量、`bg-[#…]` 等） | 22（棘轮基线） | `ds-components/no-hardcoded-color`（warn；`npm run check:lint-ratchet` 冻结）；见 [design-tokens.md §颜色](./design-tokens.md#color) |
| `z-[N]` 与内联 `style.zIndex` 数字魔数 | 28（棘轮基线） | `ds-components/no-arbitrary-z-index`（warn；`npm run check:lint-ratchet` 冻结）；见 [design-tokens.md §z-index](./design-tokens.md#z-index) |
| Tailwind 原色板类（`bg-gray-100`、`text-blue-500`、`bg-white` 等） | 2400+ | 无 lint |
| 内联 `style={{…}}` 对象 | 1000 | 无 lint；仅允许运行时计算值 |
| 原生 `<button>`（lint 生效范围内） | 754（棘轮基线） | `ds-components/no-native-button`（warn；`npm run check:lint-ratchet` 冻结） |
| `CommonTooltip` 调用点 | 44 个文件 | `ds-components/no-legacy-tooltip`（error，存量按 `scripts/lint/eslint-rules/common-tooltip.allowlist.json` 豁免） |
| `CustomScrollArea`（已 `@deprecated`）调用点 | 228 个文件 | 无 lint |
| coarse 触控散点覆盖 | 1515（棘轮基线，另豁免 7 个文件） | `ds-components/coarse-touch-target`（全局 warn，`input-bar` error；`npm run check:lint-ratchet` 冻结，白名单见 `scripts/lint/eslint-rules/coarse-touch-target.allowlist.json`） |

## 其他参考

- 通用代码与后端规范：[docs/CODE_STYLE.md](../CODE_STYLE.md)
- 前端插件扩展规范：[docs/plugins/FRONTEND.md](../plugins/FRONTEND.md)
- WebUI / PWA 适配说明：[docs/WEBUI-AND-PWA.md](../WEBUI-AND-PWA.md)

## 维护

改了 token、组件 API 或 lint 规则的 PR，同一个 PR 里更新本目录对应段落。
