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
