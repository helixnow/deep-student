# Generative UI — Tauri E2E 验收

> Round 41 · 分支 `Generative-UI-0824`

## 自动化（Rust Tauri harness）

真实 Tauri `App` + `WebviewWindow`，不经 vitest mock：

| 测试文件 | 覆盖 |
|----------|------|
| `src-tauri/tests/generative_ui_executor_e2e.rs` | `generative_ui` start/chunk/end 事件 |
| 同上 | `researchSessionId` → `hpias_event` `session_started` |
| 同上 | stub pipeline → `plan_generated` 生命周期 |

```bash
cd src-tauri
cargo test --test generative_ui_executor_e2e -- --nocapture
```

需 Linux GTK 依赖 + Rust stable（CI `rust-tests` job 覆盖）。

## 前端运行时（vitest，非 Tauri 壳）

| 测试 | 覆盖 |
|------|------|
| `generativeUIChatBlockHpiasRuntime.integration.test.tsx` | Chat 块 + 真实 `useHpiasEventBridge` + mock Tauri listen |
| `hpiasPipelineRuntime.integration.test.tsx` | Style Lab 时间线 → dashboard intent |
| `generativeUIAllBlocksRuntime.test.tsx` | 18 块 renderer smoke（含 markdown / chart / steps / table） |
| `generativeUITauriE2E.contract.test.ts` | Rust harness + 文档 + CT 与 18 type 契约 |

```bash
npm run test -- tests/vitest/generative-ui/
```

## 桌面手动验收（可选）

1. 启动应用：`npm run tauri dev`
2. Chat 中触发含 `research-plan` 的 `render_generative_ui`（或 research-mode skill）
3. 传入 `researchSessionId`
4. 确认：
   - `HpiasGenerativeResearchPanel` 实时更新 plan 步骤
   - 静态 research 块在 live 会话激活后被 omit
   - `copy-report` / `export-plan` action 可用
5. 确认 18 种内置块可渲染：`stat-card` / `alert` / `list` / `progress` / `action-bar` / `text` / `key-value-grid` / `flashcard-preview` / `review-calendar` / `mistake-analysis` / `mindmap-embed` / `paper-digest` / `research-plan` / `research-report`，以及新增：
   - `markdown`：标题 + Markdown 正文（`data-generative-markdown`）
   - `chart`：bar / line / pie 图表（`data-generative-chart`）
   - `steps`：学习计划步骤状态（`data-generative-steps`）
   - `table`：列 schema + 行（`data-generative-table`）
6. （可选）Intent v1.1 layout：发送 `version: '1.1'` + `layout: { mode: 'grid', columns: 2 }`（块级可选 `span`），确认根节点 `data-layout-mode="grid"` / `data-layout-columns="2"`，跨列块带 `data-layout-span`
7. （可选）`DEEP_STUDENT_HPIAS_BACKEND=retrieval` 验证 VFS 检索 + LLM synthesis

## Playwright CT（视觉 smoke，mock Tauri）

```bash
npx playwright test -c playwright-ct.config.ts tests/ct/generative-ui/
```

见 `tests/ct/generative-ui/hpiasResearchPanel.spec.tsx`：18 块 smoke（markdown / chart / steps / table）+ v1.1 layout 可选检查 + HPIAS 时间线契约。
