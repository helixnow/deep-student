# 2026-03-17 Apple 级 UI/UX 审计与可执行 TODO（LLM 勾选版）

## 结论快照（Apple 设计视角）

- App 模式：8.2 / 10（内容优先、结构克制）
- Settings 模式：7.5 / 10（定位反馈与状态反馈不足）
- 视觉一致性：7.2 / 10（圆角/字号存在硬编码漂移）
- 交互清晰度：7.5 / 10（Focus 与错误恢复链路不完整）
- 可访问性：7.8 / 10（焦点对比度与触控尺寸需优化）
- 跨平台原生感：5.0 / 10（安全区、平台材质映射、断点中间态不足）

---

## 执行策略（最小改动，高收益）

- 原则：只做高 ROI 的细节修正，不做大改版。
- 范围：基于现有 React + Tailwind + shadcn/Radix 架构增量优化。
- 约束：遵循 `AGENTS.md` 的 token、字体、交互和图标规范（Phosphor only）。

---

## TODO（可打勾执行）

### P0（本轮必须完成）

- [x] **补齐 Dropdown 焦点可见性**
  - 文件：`src/components/ui/dropdown-menu.tsx`
  - 动作：为可聚焦项统一补上 `focus-visible:ring-2 focus-visible:ring-ring`。
  - 完成定义：键盘 Tab 导航可稳定看到焦点位置。

- [x] **统一禁用态“原因可见”反馈**
  - 文件：`src/components/content/settings-demo-sections.tsx`、`src/components/content/SettingsPanel.tsx`
  - 动作：为关键 disabled 控件补充说明文案（就近提示/tooltip/辅助文本任选一种）。
  - 完成定义：用户能理解“为什么不可点击”。

- [x] **修复 Settings 场景的“位置感缺失”**
  - 文件：`src/components/shell/AppChrome.tsx`、`src/components/content/SettingsPanel.tsx`
  - 动作：在 Settings 主内容区增加当前 tab 标题（如“外观/模型/高级”）。
  - 完成定义：进入设置后，不看侧栏也能判断当前页位置。

- [x] **提升焦点环对比度**
  - 文件：`src/styles/app.css`
  - 动作：提高浅色主题 ring 可见性（保持语义 token，不硬编码新色系）。
  - 完成定义：focus 在浅色背景下可清晰辨识。

### P1（本周应完成）

- [x] **侧边栏活跃态增加更强指示器**
  - 文件：`src/components/shell/Sidebar.tsx`
  - 动作：保留当前选中色块，同时增加轻量左侧指示（不引入复杂动画）。
  - 完成定义：active 与 hover 在移动/桌面都易区分。

- [x] **减少圆角与字号硬编码**
  - 文件：`src/components/content/SettingsStatsPanel.tsx`、`src/components/content/SettingsPanel.tsx`、`src/components/shell/ShellButton.tsx`
  - 动作：将 `rounded-[Npx]`、`text-[Npx]` 优先收敛到规范类（`rounded-lg/rounded-3xl/text-sm/text-base...`）。
  - 完成定义：视觉节奏更统一，后续全局缩放更稳定。

- [x] **修复移动触控最小命中区**
  - 文件：`src/components/ui/button.tsx`、`src/components/ui/input.tsx`
  - 动作：移动端关键操作区域对齐 44px 触控基线，桌面端保持紧凑。
  - 完成定义：移动端误触下降，控件更易点按。

### P2（下个迭代）

- [x] **补充 safe-area 适配**
  - 文件：`src/styles/app.css`、`src/components/shell/AppChrome.tsx`
  - 动作：为移动端顶部/底部固定区域接入 `env(safe-area-inset-*)`。
  - 完成定义：刘海屏/手势区不遮挡关键控件。

- [x] **跨平台材质映射对齐（macOS/Windows）**
  - 文件：`src-tauri/tauri.macos.conf.json`、`src-tauri/tauri.windows.conf.json`、`src/styles/app.css`
  - 动作：确保 Tauri 配置与前端 token 语义一致，避免“配了效果但界面层无响应”。
  - 完成定义：平台原生感一致，视觉行为可预期。

---

## 验收清单（每次提交前）

- [x] `npm run lint`
- [x] `node --test scripts/interaction-states-contract.test.mjs`
- [x] `node --test scripts/shell-phosphor-icons.test.mjs`
- [x] `node --test scripts/settings-sidebar-surface-contract.test.mjs`
- [x] `node --test scripts/window-background-visual-contract.test.mjs`
- [x] `npm run build`

---

## 参考文档（引用链接）

- [AGENTS 总规范](../../../AGENTS.md)
- [跨平台 Shell 实施计划](./2026-03-10-cross-platform-shell-implementation.md)
- [原生窗口背景设计](./2026-03-10-native-window-background-design.md)
- [Radix + shadcn 设计系统基座](./2026-03-10-radix-shadcn-ds-foundation.md)
- [Settings Demo 优化](./2026-03-11-settings-demo-optimization.md)
- [侧边栏按钮宽度一致性](./2026-03-12-sidebar-button-width-consistency.md)
- [侧边栏高亮边界修复](./2026-03-12-sidebar-highlight-boundary-fix.md)
- [Apple 半透明侧边栏研究](./2026-03-13-apple-translucency-sidebar-research-executable-todo.md)
- [Apple UI/UX 对齐执行清单](./2026-03-13-apple-ui-ux-alignment-executable-todo.md)
- [系统半透明最佳质量方案](./2026-03-16-system-translucency-best-quality-executable-todo.md)
- [Sidebar SOTA Refactor](./2026-07-sidebar-sota-refactor.md)

---

## 给 LLM 的执行说明

- 按 P0 → P1 → P2 顺序推进。
- 每完成一项只提交最小改动，不做无关重构。
- 每项完成后先跑对应测试再勾选。
- 若遇到规范冲突，优先遵循 `AGENTS.md`。
