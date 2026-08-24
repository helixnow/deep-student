# 0824 Anki 主题合并预演

日期：2026-08-24  
分支：`cursor/0824-rehearse-anki-cde6`

## 结论

- 从 `origin/cursor/0824-cde6`（`8361e6b7`）创建预演分支。
- 合并 `origin/cursor/0824-theme-anki-cde6`（`07146ea9`），Git 无文本冲突。
- Anki 产品代码已落到 #213 + #214 基线上；未修改或推送 `main`、`cursor/0824-cde6`。
- 发现 Generative UI 自带 `save-to-library` 入库路径，会与 `anki_cards` 形成双保存管线并绕过生成侧 QA/critic。预演分支已移除该路径：Generative UI 保留只读 `flashcard-preview`，保存、QA/critic 与审计统一由 `anki_cards` 负责。
- 当前基线尚未包含 wrapup，因此没有发生已知的 `streaming_anki_service.rs` 文本冲突。后续合入 wrapup 时应保留本次 Anki QA/critic 语义，再吸收 wrapup 的非冲突修复。

## 提交

- `fa12b5ab`：合并 Anki 主题分支。
- `6e9a9997`：收敛 Generative UI 闪卡为只读展示，并增加防回归契约。

## 第四轮复查（2026-08-24）

独立复核以上裁决，结论如下：

- 只读收敛属实：`buildFlashcardPreviewIntent` 不再产出 action-bar；桥接层不注册
  `save-to-library`；外部 intent 传入遗留保存 action 时也不落 handler
  （`flashcardDisplayOnly.test.ts` 双向覆盖）。保存统一走 `anki_cards` 的
  `saveCardsToLibrary`，QA/critic 标记（`ankiQaFlags` / `AnkiQaFlagBadge`）随卡入库。
- 无误删：合并提交未触碰 `src/features/generative-ui/`；修复提交仅移除闪卡保存
  链路（handler、提取工具、action id、标签接线），`flashcard-preview` 仍在块注册表，
  其余 21 个块组件完整。
- `6c401455` 遮挡交互五个文件与 HEAD 逐字节一致，37 项遮挡测试通过。
- #187 token 语义在 `streaming_anki_service.rs` 保留（含 #268 保守清理细化：
  仅剥纯 token 残片与 JSON 外包装、保留正文字面 token），`error_content_is_repairable`
  重试过滤已接线，issue #58 / PR #187 回归单测在位。
- 复查清理：移除两侧 `generativeUi.json` 遗留的 `flashcard.save_to_library` 死键
  及 `generativeUIChatBlock.newTypes.test.tsx` 中对应 mock 行，防止沿遗留标签
  重新接回保存入口；i18n parity 契约保持通过。
- 门禁复跑全绿：`npm ci`、`npm run typecheck`（清理后复跑）、`npx vite build`、
  `cargo check --lib`（仍为既有 25 项 warning）。GenUI 契约 6 文件 43 项、
  遮挡 3 文件 37 项、清理影响面 4 文件 29 项测试均通过。
- 额外发现并修复一处**基线遗留**问题：`generative_ui_executor.rs` 测试
  `parse_note_edit_accepts_append_payload` 存在 E0515（闭包返回对局部 `Value`
  的引用），导致 `cargo test --lib` 无法编译。该错误在基线 `8361e6b7`
  （step-1 合入 #214 时）即存在，与 Anki 主题无关；`cargo check --lib`
  不编译 `#[cfg(test)]` 代码所以门禁未暴露。已就地修复；修复后
  `generative_ui_executor` 23 项 + streaming_anki token 回归 6 项共 29 项
  Rust 单测通过，lib test target 恢复可编译。正式合并链上其它以 `8361e6b7`
  为基线的预演分支若单独跑 `cargo test --lib` 也会遇到同一错误，可采用本修复。

裁决：正式合并 Anki 主题（D 步）时可直接以本分支为准。

## 验证

以下完整门禁通过：

```bash
npm ci && npm run typecheck && npx vite build && \
  cargo check --manifest-path src-tauri/Cargo.toml --lib
```

受影响的 Generative UI 契约测试通过：6 个测试文件、43 项测试。

环境准备说明：

- 仓库忽略的 `src/version.ts` 需先由 `npm run version:generate` 生成。
- Cloud 镜像默认 Cargo 1.83 无法解析 edition 2024 依赖；按仓库 CI 契约切换 stable Rust 1.98。
- Rust 检查还需仓库 Linux CI 所列 GTK/WebKit 依赖，以及通过 `scripts/download-pdfium.sh linux-x64` 准备的忽略态 PDFium 动态库。

门禁仅留下既有非阻断告警：Vite chunk/circular re-export 警告、Rust 25 项 warning，以及 `npm audit` 报告的 12 项锁定依赖漏洞；本次预演未扩大范围处理。
