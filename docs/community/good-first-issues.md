# Good First Issues 候选清单（2026-07-04）

> 用途：按战略路线图 v0.10「good-first-issue 挂 10 个」要求准备的候选池。
> 每项都经过代码核实（文件路径、数量均为 2026-07-04 实测），可直接复制到 GitHub Issue。
> 建议发布时打标签：`good first issue` + 领域标签（`frontend` / `rust` / `i18n` / `docs`）。

## 使用说明

- 发布前把「验收标准」原样带上，降低外部贡献者的猜测成本。
- 每个 issue 附一句「入口指引」（从哪个文件开始读），这是新贡献者最需要的。
- 难度标尺：★ = 半小时内；★★ = 半天内；★★★ = 需要理解一个子系统。

---

## 前端（TypeScript / React）

### 1. 【★·i18n】卡片生成引擎的用户可见错误信息接入 i18n

- **现状**：`src/components/anki/cardforge/engines/SegmentEngine.ts`（68 处）、`CardAgent.ts`（51 处）、`TaskController.ts`（52 处）中的错误/状态提示为硬编码中文，英文界面下用户会看到中文报错。
- **任务**：把其中通过 UI（toast/任务面板）展示给用户的字符串换成 `i18next` key（`anki` 命名空间），中英双语补全；仅在控制台输出的 `debugLog` 字符串**不必**处理。
- **验收**：切到英文界面触发制卡失败场景，无中文提示；`npm run check:i18n:missing` 输出 0 缺失。
- **入口**：`src/components/anki/cardforge/engines/SegmentEngine.ts` 顶部 import 区。

### 2. 【★·UI】诊断面板残留的 emoji 状态图标替换为 Phosphor 图标

- **现状**：主要错误页已在 2026-07 换成 `WarningCircle` 图标，但 `src/features/learning-hub/views/IndexDiagnosticPanel.tsx`（2 处 ⚠️）与 `src/components/TagTreeImportCheckModal.tsx`（✅/⚠️ 文本前缀）仍用 emoji。
- **任务**：参照 `src/components/ViewErrorFallback.tsx` 的写法换成 `@phosphor-icons/react` 图标 + 语义色。
- **验收**：`rg "⚠️" src --glob '*.tsx'` 在非 debug-panel/dev 目录下无用户可见残留。
- **入口**：`src/components/ViewErrorFallback.tsx`（参考实现）。

### 3. 【★★·一致性】移动端断点判定收敛到统一 Hook

- **现状**：移动端判定存在多套标准（`window.innerWidth < 640`、`< 768`、UA 嗅探、`useIsMobile()` 混用），640–768px 区间行为不一致（详见 `docs/reviews/mobile-uiux-review-2026-06-11.md` §A-6）。
- **任务**：以组件为单位迁移到 `src/hooks/useMediaQuery.ts` 的 `useIsMobile()` / `useBreakpoint()`；一个 PR 迁移 1-3 个组件即可，不要求一次做完。
- **验收**：被迁移组件内不再出现裸 `innerWidth` 比较；行为在 640/768 两个断点处与迁移前一致或有意收敛（PR 描述里说明选择）。
- **入口**：`rg -n "innerWidth < 7|innerWidth < 6" src --glob '*.tsx'` 的输出任选其一。

### 4. 【★·架构卫生】`formatTokenCount` 提取到共享工具模块

- **现状**：`src/features/chat/components/TokenUsageDisplay.tsx` 导出了 `formatTokenCount`，被 `MessageActions.tsx` 反向依赖——工具函数住在组件文件里。
- **任务**：移到 `src/utils/`（或 `src/features/chat/utils/`）并更新两处 import；顺带补 3 个单测（0 / 1.5k / 2.3M 的格式化输出）。
- **验收**：`npx vitest run` 通过；`TokenUsageDisplay.tsx` 不再导出非组件符号。
- **入口**：`src/features/chat/components/TokenUsageDisplay.tsx`。

### 5. 【★★·清理】示例/演示文件移出生产源码树

- **现状**：`src/components/shared/CommonTooltip.example.tsx`（63 处中文示例文案）无任何 import 方；`src/components/ui/app-menu/AppMenuDemo.tsx` 仅被设置页的开发者演示弹窗引用。
- **任务**：`CommonTooltip.example.tsx` 直接删除（README 中引用改为代码块示例）；`AppMenuDemo` 用 `import.meta.env.DEV` 条件加载，避免打进生产包。
- **验收**：`npm run build` 产物中不含 AppMenuDemo chunk（`dist/assets` 里 grep 不到 `AppMenuDemo`）；tsc/lint 通过。
- **入口**：`src/components/ui/app-menu/index.ts` L59。

### 6. 【★★·可用性】设置搜索索引扩充同义词

- **现状**：设置侧栏搜索（2026-07 新增）基于 `src/features/settings/components/useSettingsNavigation.tsx` 的 `settingsSearchIndex`（48 条），关键词较少，如搜"代理/proxy""快捷键"命中有限。
- **任务**：为每个 tab 的 `keywords` 数组补充 3-5 个常用同义词（中英都要），特别是 API、模型、备份、同步、快捷键几个高频 tab。
- **验收**：搜索 "proxy"、"api key"、"备份"、"shortcut" 都能命中对应 tab。
- **入口**：`src/features/settings/components/useSettingsNavigation.tsx`。

## 后端（Rust）

### 7. 【★·清理】按模块清理 clippy 高频告警

- **现状**：`cargo clippy --workspace --all-targets` 约 600+ 条告警，Top 类别：`redundant closure`（87）、`this impl can be derived`（41）、`map_or 可简化`（40）、`needless borrow`（33+29）。
- **任务**：选**一个模块**（如 `src-tauri/src/vfs/` 或 `src-tauri/src/chat_v2/`）执行 `cargo clippy --fix` 后人工复核提交；PR 标题注明模块名。
- **验收**：该模块 clippy 告警数下降且 `cargo check` / 相关单测通过；diff 中无行为变更。
- **入口**：`cd src-tauri && cargo clippy --workspace 2>&1 | rg "vfs/"`。

### 8. 【★·现代化】迁移 9 处已废弃的 chrono API

- **现状**：9 处 `NaiveDateTime::from_timestamp_millis`（deprecated）告警。
- **任务**：换成 `DateTime::from_timestamp_millis`，注意时区语义保持 UTC 不变。
- **验收**：clippy 不再出现该告警；受影响模块单测通过。
- **入口**：`cd src-tauri && cargo clippy 2>&1 | rg "from_timestamp_millis" -B2`。

### 9. 【★·清理】删除 16 处重复的未使用 import

- **现状**：`unused import: crate::chat_v2::events::event_types` 等告警 16 处（多在测试模块）。
- **任务**：删除未使用 import；顺手开启该文件所在模块的 `#![warn(unused_imports)]` 不被豁免。
- **验收**：clippy unused_imports 告警清零。

### 10. 【★★★·架构】`vfs/handlers.rs`（7,400+ 行）按域拆分第一步

- **现状**：单文件承载 note/textbook/folder/search 等多域 handler，外部贡献者难以定位。
- **任务**：只拆**一个域**（建议 search：`vfs_search_*` 系列函数）到 `vfs/handlers/search.rs`，保持 pub use 重导出，不改变任何函数签名。
- **验收**：`cargo check` 通过；`rg "vfs_search" src-tauri/src/lib.rs` 的命令注册无改动。
- **入口**：`src-tauri/src/vfs/handlers.rs` 中 `vfs_search` 函数群。

## 文档 / 社区

### 11. 【★·docs】BUILD-CONFIG.md 增补 Linux 排障小节

- **现状**：Linux 用户遇到窗口装饰/托盘问题时缺少自查文档（对应 issue #65/#66 的经验沉淀）。
- **任务**：在 `docs/BUILD-CONFIG.md` 增补「Linux 常见问题」：KDE/GNOME 下装饰行为、AppImage 沙箱、Wayland/X11 切换。
- **验收**：文档含至少 3 个可执行的排查步骤，Markdown lint 通过。

### 12. 【★·docs】为 `docs/` 增加英文入口页

- **现状**：`docs/` 目录以中文为主，英文用户无导航入口。
- **任务**：新增 `docs/README.en.md`：一页式索引，链接到构建指南/贡献指南/架构概览，并注明哪些文档暂为中文。
- **验收**：从仓库根 README 的 Documentation 表格可以到达该页。

### 13. 【★★·测试】为首启欢迎引导补单测

- **现状**：`src/components/onboarding/WelcomeOnboardingDialog.tsx`（2026-07 新增）的 `useWelcomeOnboarding` 门控逻辑（localStorage 标记 + 已配置用户静默跳过）无测试覆盖。
- **任务**：用 vitest + testing-library mock `invoke('get_api_configurations')`，覆盖：已完成标记不再弹、有真实配置静默落标记、全空配置弹出、dismiss 落标记四条路径。
- **验收**：`npx vitest run src/components/onboarding` 通过。
- **入口**：`src/features/chat/components/__tests__/`（现有 mock invoke 的写法可参考）。

---

## 已完成（发布 issue 前请勿重复挂出）

| 原候选 | 状态 |
|---|---|
| 错误页 emoji 兜底（ErrorBoundary / ViewErrorFallback / FinderFileList / main.tsx 致命页） | ✅ 2026-07-04 已换 Phosphor 图标 / 内联 SVG |
| 设置搜索 UI 接线 | ✅ 2026-07-04 已实现 |
| `@tabler/icons-react` 死依赖 | ✅ 已卸载 |
| `NoteEditorPortal` / `DataCenter` / `ApiConfigRecovery` 死组件 | ✅ 已删除 |
| 制卡 prompt 输出语言跟随材料语言 | ✅ 2026-07-04 已加规则（cardforge + streaming + model2 三条链路） |
