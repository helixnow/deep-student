# Good First Issues 候选清单

> 适用版本：**v0.20.x**（Electron / Cordis TypeScript 架构）。
> 每项均已核对当前源码路径与测试现状，可直接作为 GitHub Issue 模板发布。
> 建议发布时打标签：`good first issue` + 领域标签（`frontend` / `host` / `contracts` / `i18n` / `docs`）。

## 使用说明

- 发布前请完整保留「验收标准」，降低外部贡献者的理解与验证成本。
- 每个任务附「入口指引」（从哪个文件开始阅读），方便首次贡献者快速切入。
- 难度标尺：`入门` = 半小时内；`进阶` = 半天内；`深入` = 需要理解单个子系统。

---

## 前端（TypeScript / React）

### 1. [入门 · i18n] 卡片生成引擎的用户可见错误信息接入 i18n

- **现状**：`src/components/anki/cardforge/engines/SegmentEngine.ts` 中仍有硬编码中文错误与进度阶段提示（如 `'文档内容不能为空'`、`'硬分割'`、`'构建分段'`、`'完成'`），`CardAgent.ts` 的内部默认字段规则回退描述（`buildDefaultFieldRule`）也仍含硬编码中文，英文界面下用户或调用方会看到中文文本。
- **任务**：把其中通过 UI（通知/任务面板）展示给用户的字符串替换为 `i18next` key（`anki` 命名空间），同步补齐 `src/locales/zh-CN/anki.json` 与 `src/locales/en-US/anki.json`；仅在控制台输出的调试日志不必处理。
- **验收**：切到英文界面触发制卡失败场景时无中文提示；`npm run check:i18n` 与 `npm run check:i18n:missing` 通过。
- **入口**：`src/components/anki/cardforge/engines/SegmentEngine.ts`。

### 2. [进阶 · 一致性] 移动端断点与触控判定收敛到统一 Hook

- **现状**：部分组件或辅助逻辑仍直接读取 `window.innerWidth`（如 `src/components/crepe/features/imageUpload.ts` 等），未统一收敛到响应式 Hook；移动端布局与断点规范见 `docs/frontend/patterns.md` 与 `docs/frontend/ui-review-checklist.md`。
- **任务**：将分散的裸 `window.innerWidth` 断点判断迁移到 `src/hooks/useMediaQuery.ts`（`useIsMobile()`）或 `src/hooks/useBreakpoint.ts`；单个 PR 聚焦 1–3 个文件即可。
- **验收**：迁移目标内不再出现裸 `innerWidth` 比较；`npm run typecheck`、`npm run lint` 与相关单测通过。
- **入口**：`src/hooks/useMediaQuery.ts`、`src/hooks/useBreakpoint.ts` 与 `docs/frontend/patterns.md`。

### 3. [入门 · 架构卫生] `formatTokenCount` 提取到共享工具模块

- **现状**：`src/features/chat/components/TokenUsageDisplay.tsx` 导出了工具函数 `formatTokenCount` 并被 `src/features/chat/components/message/MessageActions.tsx` 反向依赖；同时 `GoalStatusChip.tsx` 与 `subagentEmbed.tsx` 各自维护了同类格式化函数。
- **任务**：将 `formatTokenCount` 提取至 `src/features/chat/utils/`（或 `src/utils/`）并统一多处引用；补充 0 / 千级 / 百万级数值的单元测试。
- **验收**：`npx vitest run` 通过；`TokenUsageDisplay.tsx` 不再导出非组件工具函数。
- **入口**：`src/features/chat/components/TokenUsageDisplay.tsx`。

### 4. [进阶 · 清理] 演示组件 `AppMenuDemo` 改为仅开发环境按需加载

- **现状**：`src/components/ui/app-menu/AppMenuDemo.tsx` 目前在 `src/components/ui/app-menu/index.ts`（L59）静态重导出，并被 `src/features/settings/components/Settings.tsx` 与 `SettingsDesktopDialogs.tsx` 直接静态导入。
- **任务**：将 `AppMenuDemo` 改为仅在 `import.meta.env.DEV` 下通过动态 `import()` 按需加载，并移除生产路径上的静态导入，避免演示代码进入生产构建产物。
- **验收**：`npm run build` 产物中不含 `AppMenuDemo` chunk；`npm run typecheck` 与 `npm run lint` 通过。
- **入口**：`src/components/ui/app-menu/index.ts` L59。

### 5. [进阶 · 可用性] 设置搜索索引扩充中英同义词

- **现状**：设置侧栏搜索索引定义在 `src/features/settings/components/useSettingsNavigation.tsx`（`SettingsSearchIndexItem` 的 `keywords` 字段），部分高频入口的中英文同义词（如代理/proxy、快捷键/shortcut、API Key 等）仍可继续补全。
- **任务**：为高频设置分组与子标签的 `keywords` 补充常用中英文同义词，并在对应测试中补充检索断言。
- **验收**：搜索 `"proxy"`、`"api key"`、`"备份"`、`"shortcut"` 均可命中目标设置项；`npx vitest run src/features/settings/components/__tests__/SettingsSidebar.searchKeyboard.test.tsx` 通过。
- **入口**：`src/features/settings/components/useSettingsNavigation.tsx`。

---

## 后端（TypeScript / Cordis Host 与 IPC 契约）

### 6. [进阶 · contracts] 收敛 `contracts/ipc/UNRESOLVED.md` 中的未确定事件负载类型

- **现状**：`contracts/ipc/UNRESOLVED.md` 记录了 6 个契约文件（`L04-chat-session.json`、`L10-notes.json`、`L12-vfs-index.json`、`L13-vfs-api.json`、`L19-mcp-browser.json`、`L21-backup-governance.json`）中的 10 处 `x-unresolved` 事件负载注解。
- **任务**：任选 1 个契约文件，对照 `host/plugins/` 中对应事件的实际发射结构，在 `contracts/ipc/*.json` 中补全准确类型并移除 `x-unresolved`，运行 `npm run contracts:generate` 更新生成文件。
- **验收**：`npm run contracts:check`、`npm run typecheck:host` 与对应插件测试通过，`contracts/ipc/UNRESOLVED.md` 条目数减少。
- **入口**：`contracts/ipc/UNRESOLVED.md`。

### 7. [入门 · host] 为 `host/plugins/plugin-services/` 补充边界单元测试

- **现状**：`host/plugins/plugin-services/` 负责向社区插件暴露受控的 `notify`、`schedule`、`secrets`、`study-data` 等桥接服务，目前仅有 2 个测试文件（`plugin-services.test.ts`、`study-data.test.ts`）。
- **任务**：针对 `src/schedule.ts`、`src/notify.ts` 或 `src/secrets.ts` 中的权限拒绝、非法参数与边界值补充 Vitest 单元测试。
- **验收**：`npm run test:host`、`npm run typecheck:host` 与 `npm run check:arch` 通过。
- **入口**：`host/plugins/plugin-services/tests/plugin-services.test.ts`。

### 8. [进阶 · host] 为 `host/plugins/ilink/` 微信通道模块补充异常场景单测

- **现状**：`host/plugins/ilink/src/` 包含 `pairing-guard.ts`、`photo-batch.ts`、`control-commands.ts` 等核心模块，现有 4 个单测文件尚未完整覆盖配对守卫与多图合批的超时及异常路径。
- **任务**：针对 `pairing-guard.ts` 或 `photo-batch.ts` 补充纯本地（无外部网络依赖）的超时、重复/乱序消息与异常输入单测。
- **验收**：`npm run test:host` 与 `npm run typecheck:host` 通过。
- **入口**：`host/plugins/ilink/src/pairing-guard.ts` 与 `host/plugins/ilink/tests/`。

---

## 文档 / 测试

### 9. [入门 · docs] `docs/BUILD-CONFIG.md` 增补 Linux 排障小节

- **现状**：Linux 用户在 AppImage 运行、Wayland/X11 切换或桌面窗口装饰与托盘显示上遇到问题时缺少集中排障指引。
- **任务**：在 `docs/BUILD-CONFIG.md` 增补「Linux 常见问题」小节，覆盖 AppImage 沙箱参数、Wayland/X11 环境变量与 KDE/GNOME 托盘排查步骤。
- **验收**：至少包含 3 条可执行排查步骤；`npm run check:public-surface` 通过。
- **入口**：`docs/BUILD-CONFIG.md`。

### 10. [入门 · 测试] 为 `src/hooks/` 常用共享 Hook 补充单元测试

- **现状**：`src/hooks/` 下共有 46 个 Hook 文件，其中 `useDebounce.ts`、`useCountdown.ts`、`useMediaQuery.ts`、`useBreakpoint.ts` 等通用 Hook 尚无独立单元测试。
- **任务**：任选 1–2 个尚无测试的通用 Hook，参照 `src/hooks/__tests__/` 中已有测试写法补充 Vitest + Testing Library 单测（覆盖初始化、状态变化、边界条件与卸载清理）。
- **验收**：`npx vitest run src/hooks/__tests__` 与 `npm run typecheck` 通过。
- **入口**：`src/hooks/__tests__/useMotionPresence.test.ts`（参考实现）。

---

## 已完成（发布 Issue 前请勿重复挂出）

| 原候选 | 状态 |
|---|---|
| 错误页与诊断面板状态图标替换（`ErrorBoundary` / `ViewErrorFallback` / `IndexDiagnosticPanel` / `TagTreeImportCheckModal`） | 已完成：已统一替换为 `@phosphor-icons/react` 图标 |
| `CommonTooltip.example.tsx` 示例文件清理 | 已完成：文件已从源码树移除 |
| 首启欢迎引导 `WelcomeOnboardingDialog` 单元测试 | 已完成：已在 `src/components/onboarding/__tests__/` 补齐 6 组单测 |
| 设置搜索 UI 接线 | 已完成 |
| `@tabler/icons-react` 死依赖清理 | 已完成：已卸载 |
| `NoteEditorPortal` / `DataCenter` / `ApiConfigRecovery` 死组件清理 | 已完成：已删除 |
| 制卡 prompt 输出语言跟随材料语言 | 已完成 |
