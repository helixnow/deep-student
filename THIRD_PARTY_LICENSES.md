# Third-Party Licenses | 第三方许可证

本文件列出 DeepStudent 项目所使用的第三方依赖及其许可证。

This file lists third-party dependencies used by DeepStudent and their licenses.

> 生成时间 / Generated: 2026-02-12

---

## 许可证合规声明

DeepStudent 采用 AGPL-3.0-or-later 许可证。所有第三方依赖均与该许可证兼容：

- **MIT / Apache-2.0 / ISC / BSD**：宽松许可证，允许商业使用
- **MPL-2.0**：弱 Copyleft，修改文件需开源（本项目使用 `dompurify` 未修改源码）

---

## Rust (Cargo) 依赖

主要许可证分布（约 300+ crates）：

| 许可证 | 说明 |
|--------|------|
| MIT OR Apache-2.0 | 绝大多数依赖，包括 Tauri、Tokio、Serde、Arrow 等 |
| Apache-2.0 | arrow-*, lance 等数据处理库 |
| BSD-3-Clause | subtle（密码学原语） |
| Zlib | foldhash |

完整依赖树可通过以下命令生成：
```bash
cd src-tauri && cargo tree --format "{p} {l}"
```

---

## NPM 依赖许可证分析

> 生成命令 / Command: `npm run check:licenses`  
> 建议在每次发布前重新生成并同步此节。

当前分布（2026-02-12）：

- `(MPL-2.0 OR Apache-2.0)`: 1
- `Apache-2.0 OR MIT`: 2
- `Apache-2.0`: 8
- `BSD-3-Clause`: 1
- `ISC`: 3
- `MIT OR Apache-2.0`: 5
- `MIT`: 111

---

## 打包二进制资源（Bundled Binaries）

- **PDFium 动态库**：`src-tauri/resources/pdfium/*`
  - 获取方式：`scripts/download-pdfium.sh`
  - 上游来源：`bblanchon/pdfium-binaries`（Chromium PDFium 构建产物）
  - 许可证：遵循上游 PDFium/Chromium 对应许可证（BSD-3-Clause 系）
