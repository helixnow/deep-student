# Third-Party Licenses | 第三方许可证

本文件说明 DeepStudent 的第三方许可证策略和重点依赖。随发行包交付的完整组件清单、版权声明与许可证全文由 `scripts/generate-third-party-notices.mjs` 生成到 `public/legal/THIRD_PARTY_NOTICES.txt`。

This file describes DeepStudent's third-party licensing policy and notable dependencies. The complete component inventory, copyright notices, and license texts distributed with releases are generated at `public/legal/THIRD_PARTY_NOTICES.txt`.

> 生成时间 / Generated: 2026-07-14

---

## 许可证合规声明

DeepStudent 采用 AGPL-3.0-or-later 许可证。所有第三方依赖均与该许可证兼容：

- **MIT / Apache-2.0 / ISC / BSD**：宽松许可证，允许在 AGPL-3.0 项目中使用
- **MPL-2.0**：弱 Copyleft，修改文件需开源（本项目使用 `dompurify` 未修改源码，且可选 Apache-2.0）
- **Apache-2.0 AND ISC**：`ring` 等加密库使用复合许可证，需同时满足两个许可证条款
- **Zlib**：宽松许可证，与 AGPL-3.0 兼容

---

## Rust (Cargo) 依赖

主要许可证分布：

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

发行通知使用 Cargo metadata 的 normal/build 依赖闭包，排除 dev-only crate，并保留每个 crate 随包提供的 LICENSE、COPYING、NOTICE 与 COPYRIGHT 文件。MPL-2.0 crate 可以与 AGPL-3.0-or-later 组合；未修改的 MPL 文件保留原许可证与上游源码位置。

---

## NPM 依赖许可证分析

> 生成命令 / Command: `npm run licenses:generate`
> 校验命令 / Check: `npm run licenses:check`

生成器读取 `package-lock.json` 的生产依赖闭包，排除 `dev=true` 项，并收集实际安装包中的许可证文件。`sharp`/libvips 仅用于图标生成且属于 devDependency，不进入发行通知。

| 许可证 | 代表性依赖 | 选择/说明 |
|--------|-----------|-----------|
| MIT | react, zustand, framer-motion, mermaid, ExcelJS | 保留各包的版权与 MIT 文本 |
| Apache-2.0 | pdfjs-dist, docx-preview, @hello-pangea/dnd | 保留 Apache-2.0 文本和 NOTICE（如有） |
| MIT OR GPL-3.0-or-later | jszip | 采用 MIT 选项 |
| MPL-2.0 OR Apache-2.0 | dompurify | 采用 Apache-2.0 选项 |
| MIT AND Zlib | pako | 同时保留 MIT 与 Zlib 声明 |

---

## Vendored 依赖

`lancedb` 和 `object_store` 通过 `[patch.crates-io]` 使用本地修改版本；根据 Apache-2.0 第 4(b) 条，修改后的文件需注明变更。`rs-fsrs` 是未修改的直接 path 依赖。

- **lancedb** v0.22.1（`src-tauri/vendor/lancedb/`）
  - 上游仓库：https://github.com/lancedb/lancedb
  - 许可证：Apache-2.0
  - 修改目的：裁剪未使用的存储后端 feature（DynamoDB / 云端 object store），缩小依赖树
  - 修改范围：仅 `Cargo.toml` 三处 feature 调整，源码零改动；详见 `vendor/lancedb/PATCHES.md`

- **object_store** v0.12.4（`src-tauri/vendor/object_store/`）
  - 上游仓库：https://github.com/apache/arrow-rs-object-store
  - 许可证：MIT/Apache-2.0（双许可证）
  - NOTICE：`vendor/object_store/NOTICE.txt`（Apache Arrow Object Store, Copyright 2020-2024 The Apache Software Foundation）
  - 修改目的：为不支持 rename/hard_link 的文件系统（如 exFAT）增加 copy 回退，使 Lance 数据可存放于此类卷
  - 修改范围：仅 `src/local.rs` 运行时行为（PermissionDenied/Unsupported 回退分支，含临时文件 + 同目录 rename 的原子性保障），带 `DEEP-STUDENT PATCH` 行内标记；详见 `vendor/object_store/PATCHES.md`

- **rs-fsrs** v1.2.1（`src-tauri/vendor/rs-fsrs/`）
  - 上游仓库：https://github.com/open-spaced-repetition/rs-fsrs
  - 许可证：MIT，Copyright (c) 2023 Open Spaced Repetition
  - 用途：FSRS 闪卡调度器（不包含参数优化器）
  - 本地状态：未修改的 vendored 源码副本；完整许可证见 `vendor/rs-fsrs/LICENSE`
  - 二进制发行：Tauri 会将该完整许可证打包为 `$RESOURCE/licenses/rs-fsrs-MIT.txt`

---

## 打包二进制资源（Bundled Binaries）

- **PDFium 动态库**：`src-tauri/resources/pdfium/*`
  - 获取方式：`scripts/download-pdfium.sh`
  - 上游来源：[bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries)（Chromium PDFium 构建产物）
  - 许可证：PDFium BSD-3-Clause；预编译发布项目 MIT；静态链接组件依各自许可证
  - 源代码获取：Chromium 仓库 https://pdfium.googlesource.com/pdfium/
  - 法律材料：下载脚本保留上游 `LICENSE` 和完整 `licenses/`，涵盖 FreeType、ICU、OpenJPEG、libjpeg-turbo、libpng、zlib、Abseil 等组件

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

---

## 发布校验

- `cd src-tauri && cargo fetch --locked`：更新通知前先准备完整的锁定 Cargo 源码缓存。
- `npm run licenses:generate`：离线读取锁文件与实际依赖源码，生成确定性的第三方通知。
- `npm run licenses:check`：校验 Cargo/NPM 锁文件 SHA-256、未知生产许可证、PDFium 法律材料和 Tauri 资源映射。
- `npm run build`：在类型检查前自动执行许可证校验；通知过期或资源缺失会阻止发布构建。
- 应用“设置 → 关于 → 开源项目致谢”可直接查看项目 AGPL 全文与第三方许可证全文。
