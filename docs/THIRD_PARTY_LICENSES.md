# Third-Party Licenses | 第三方许可证

本文件列出 DeepStudent 项目所使用的第三方依赖及其许可证。

This file lists third-party dependencies used by DeepStudent and their licenses.

> 生成时间 / Generated: 2026-02-24

---

## 许可证合规声明

DeepStudent 采用 AGPL-3.0-or-later 许可证。所有第三方依赖均与该许可证兼容：

- **MIT / Apache-2.0 / ISC / BSD**：宽松许可证，允许在 AGPL-3.0 项目中使用
- **MPL-2.0**：弱 Copyleft，修改文件需开源（本项目使用 `dompurify` 未修改源码，且可选 Apache-2.0）
- **Apache-2.0 AND ISC**：`ring` 等加密库使用复合许可证，需同时满足两个许可证条款
- **Zlib**：宽松许可证，与 AGPL-3.0 兼容

---

## Rust (Cargo) 依赖

主要许可证分布（约 300+ crates）：

| 许可证 | 代表性依赖 | 说明 |
|--------|-----------|------|
| MIT OR Apache-2.0 | tauri, tokio, serde, rusqlite, pptx-to-md, umya-spreadsheet, tauri-plugin-mcp-bridge 等 | 绝大多数依赖 |
| Apache-2.0 | arrow-*, lance-*, lancedb, ppt-rs, sentry 等 | 数据处理与监控 |
| MIT | calamine, docx-rs, rtf-parser, html2text, jsonschema, moka 等 | 文档解析与工具 |
| Apache-2.0 AND ISC | ring（传递依赖，经 rustls 引入） | 加密库，需同时满足两个许可证 |
| MIT/Apache-2.0 | object_store（vendored） | 对象存储抽象层 |
| BSD-3-Clause | subtle（密码学原语） | 常量时间比较 |
| Zlib | foldhash | 哈希算法 |

完整依赖树可通过以下命令生成：

```bash
cd src-tauri && cargo tree --format "{p} {l}"
```

---

## NPM 依赖许可证分析

> 生成命令 / Command: `npm run check:licenses`
> 建议在每次发布前重新生成并同步此节。

当前分布（2026-02-24）：

| 许可证 | 数量 | 代表性依赖 |
|--------|------|-----------|
| MIT | ~111 | react, zustand, framer-motion, lucide-react, mermaid 等 |
| Apache-2.0 | ~8 | pdfjs-dist, docx-preview, @hello-pangea/dnd 等 |
| MIT OR Apache-2.0 | ~5 | @tauri-apps/* 等 |
| Apache-2.0 OR MIT | ~2 | — |
| ISC | ~3 | pptx-preview 等 |
| BSD-3-Clause | ~1 | — |
| (MPL-2.0 OR Apache-2.0) | 1 | dompurify（可选 Apache-2.0，无兼容性问题） |

---

## Vendored 依赖（本地修改版）

以下依赖通过 `[patch.crates-io]` 使用本地修改版本。根据 Apache-2.0 第 4(b) 条，修改后的文件需注明变更。

- **lancedb** v0.22.1（`src-tauri/vendor/lancedb/`）
  - 上游仓库：https://github.com/lancedb/lancedb
  - 许可证：Apache-2.0
  - 修改目的：解决 chrono/arrow trait 方法冲突（参见 `Cargo.toml` 注释）
  - 修改范围：Cargo.toml 依赖版本约束调整

- **object_store** v0.12.4（`src-tauri/vendor/object_store/`）
  - 上游仓库：https://github.com/apache/arrow-rs-object-store
  - 许可证：MIT/Apache-2.0（双许可证）
  - NOTICE：`vendor/object_store/NOTICE.txt`（Apache Arrow Object Store, Copyright 2020-2024 The Apache Software Foundation）
  - 修改目的：与 vendored lancedb 的版本兼容
  - 修改范围：Cargo.toml 依赖版本约束调整

---

## 打包二进制资源（Bundled Binaries）

- **PDFium 动态库**：`src-tauri/resources/pdfium/*`
  - 获取方式：`scripts/download-pdfium.sh`
  - 上游来源：[bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries)（Chromium PDFium 构建产物）
  - 许可证：BSD-3-Clause（遵循 Chromium/PDFium 许可证）
  - 源代码获取：Chromium 仓库 https://pdfium.googlesource.com/pdfium/

- **PDF.js Worker**：`public/pdf.worker.min.mjs`、`public/pdf.worker.min.js`
  - 上游来源：[Mozilla PDF.js](https://mozilla.github.io/pdf.js/)
  - 许可证：Apache-2.0

---

## 传递依赖许可证特别说明

### ring（加密库）
- 许可证：Apache-2.0 AND ISC
- 引入路径：reqwest → rustls → ring；tokio-tungstenite → rustls → ring
- 包含源自 BoringSSL（OpenSSL 分支）的 C/汇编代码
- 合规要求：分发时需同时包含 Apache-2.0 和 ISC 许可证声明
