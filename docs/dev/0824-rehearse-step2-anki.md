# 0824 Step-2 基线 Anki 合并预演（第五轮）

日期：2026-08-24  
分支：`cursor/0824-rehearse-step2-anki-cde6`

## 目的

第一轮预演（`cursor/0824-rehearse-anki-cde6`，`b2dbbe71`）基于 step-1 基线
`8361e6b7`。本轮在**含 Step 2（H 缓存主题 + genui i18n 移植）**的最新 0824 基线
`eec20398` 上重演 Anki 主题合并，验证既有裁决在新基线上依然成立，并把上一轮
有价值的修复移植过来。

## 结论

- 从 `origin/cursor/0824-cde6`（`eec20398`）创建预演分支。
- 合并 `origin/cursor/0824-theme-anki-cde6`（`07146ea9`），Git 无文本冲突；
  Step 2 的 H 缓存改动（`streaming_anki_service.rs` 等）与 Anki 主题改动
  自动合并干净。
- 沿用第一轮裁决：Generative UI 闪卡保持只读展示，保存、QA/critic 与审计统一由
  `anki_cards` 负责。移植了两个修复提交（见下），其中只读收敛提交在
  `resolveGenerativeUIChatActionHandlers.ts` 出现一处冲突——HEAD 侧
  仍保留闪卡保存 handler 块、cherry-pick 侧删除之；导入与接口签名已被
  自动合并的其余 hunk 移除，故取删除侧，语义与第一轮 `6e9a9997` 一致。
- **E0515 跳过移植**：第一轮在 `f16ebb1f` 修复的
  `parse_note_edit_accepts_append_payload` E0515，0824 已在 Step 2 期间以
  `2f7eec54`（`.as_ref()` 借用后再 `.get`）等价修复。合并后确认该修复仍在
  （`generative_ui_executor.rs` 测试内 `note_edit.as_ref().and_then(...)`），
  且 `cargo test --lib` 测试目标可编译，无需再动。
- 未修改或推送 `main`、`cursor/0824-cde6`。

## 提交

- `b15f9381`：合并 Anki 主题分支（`origin/cursor/0824-theme-anki-cde6`）。
- `f352403c`：移植第一轮 `6e9a9997`——收敛 Generative UI 闪卡为只读展示
  （移除 `flashcardActionHandlers` / `extractFlashcardsFromIntent` /
  `save-to-library` 接线，新增 `flashcardDisplayOnly.test.ts` 防回归契约）。
- `40265239`：移植第一轮 `58b09e01`——清理两侧 `generativeUi.json` 的
  `flashcard.save_to_library` 死键及 `generativeUIChatBlock.newTypes.test.tsx`
  对应 mock 行。

## 移植后复核

- 全库检索确认无残留保存链路：`createFlashcardSaveActionHandlers` 仅剩
  `generativeUIArchitectureContract.test.ts` 的 `not.toContain` 防回归断言；
  `common.json` 的 `save_to_library` 属错题本功能、
  `chatAnkiIntegrationTestPlugin.ts` 的 `ca_save_to_library` 属 `anki_cards`
  自身保存管线，均非 Generative UI 泄漏。
- `generativeUi.json` 两侧 `flashcard` 块仅剩展示键
  （`preview_title` / `front` / `back` / `preview_meta_title`），i18n parity 保持。
- 与第一轮预演分支相比，`src/features/generative-ui/` 仅
  `resolveGenerativeUIChatActionHandlers.ts` 与 `dispatchCanvasAIEditRequest.ts`
  两文件有差异，均来自 Step 2 已移植的 genui i18n（本轮基线更新），
  只读收敛语义等价。

## 验证

以下完整门禁通过：

```bash
npm ci && npm run version:generate && npm run typecheck && npx vite build && \
  cargo check --manifest-path src-tauri/Cargo.toml --lib
```

- `npm run typecheck`：通过。
- `npx vite build`：通过，仅既有 chunk 体积告警。
- `cargo check --lib`：通过，27 项既有非阻断 warning（较第一轮 25 项的差异来自
  Step 2 H 缓存合入的 never-used 告警，与 Anki 主题无关）。
- `cargo test --lib --no-run`：测试目标可编译，确认基线 E0515 修复在合并后有效；
  实际运行 `generative_ui_executor` 23 项、`streaming_anki` 74 项（含主题分支
  新增的 token 清理/遮挡回归）均通过。
- 受影响单测全绿：GenUI 契约 7 文件 61 项（含 `flashcardDisplayOnly` 双向
  防回归）、遮挡/QA 3 文件 39 项、`generativeUiI18n.parity.contract` 6 项。

环境准备说明（与第一轮一致）：

- 仓库忽略的 `src/version.ts` 需先由 `npm run version:generate` 生成。
- Cloud 镜像默认 Cargo 1.83 无法解析 edition 2024 依赖；按仓库 CI 契约切换
  stable Rust 1.98。
- Rust 检查还需 CI 所列 `libwebkit2gtk-4.1-dev libgtk-3-dev
  libappindicator3-dev librsvg2-dev patchelf protobuf-compiler`，以及
  `scripts/download-pdfium.sh linux-x64` 准备的忽略态 PDFium 动态库。
  本镜像 `fuse3` 存在 conffile 交互阻塞，需 `DEBIAN_FRONTEND=noninteractive`
  加 `--force-confold` 先 `dpkg --configure -a` 再安装。

## 对正式合并链（D 步）的指引

- 在含 Step 2 的基线上合 Anki 主题无文本冲突；只读闪卡收敛需以 cherry-pick
  方式带上（本分支 `f352403c` + `40265239` 可直接采用），
  `resolveGenerativeUIChatActionHandlers.ts` 的冲突按"删除保存 handler 块"解。
- E0515 无需处理，基线 `2f7eec54` 已修。
- 后续合 wrapup 时仍应保留本次 Anki QA/critic 语义，再吸收 wrapup 的
  非冲突修复（同第一轮备忘）。
