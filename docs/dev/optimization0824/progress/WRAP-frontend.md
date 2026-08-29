# optimization0824 前端测试收尾

> 代理：SA-WRAP-FE  
> 模型：`gpt-5.6-sol-xhigh-fast`  
> 分支：`cursor/optimization0824-5575`  
> 日期：2026-08-24

## 结论

- 定向 Vitest 共覆盖 27 个文件、126 个用例，最终 `126 passed`。
- `npm run build` 通过，包含 license compliance 与 TypeScript 检查。
- bundle size 的 7 项预算全部通过。
- PDF worker 仍保持单一实际 payload，CMap 子集及 CJK fallback 守卫均通过。

## Vitest

| 范围 | 用例数 | 结果 |
| --- | ---: | --- |
| token budget | 7 | 通过 |
| PDF / CMap / PDF context / PDF tools | 39 | 通过 |
| FlowToken renderer 与冲突守卫 | 24 | 通过 |
| DnD / session 与 settings sidebar | 46 | 通过 |
| skill bundle / usage | 10 | 通过 |
| **合计** | **126** | **全部通过** |

主矩阵执行结果为 20 files / 98 tests passed；补充的 DnD、session item、
mobile/settings sidebar 矩阵为 7 files / 28 tests passed。两组文件不重叠。

## 修复

1. PDF context 测试改为显式传入 `pdf: ['text', 'image']`，与当前
   `injectModes` 源内容契约一致，同时继续验证 OCR 不会被隐式注入。
2. PDF page-image 前端契约不再从已瘦身的工具 description 复制后端
   `1_500_000` bytes 实现常量，改为守卫对模型公开且稳定的 2048 边长和
   “不返回截断 base64”语义；精确字节上限仍由 Rust executor 及其单测持有。
3. settings quiet-hover 测试移除已随旧移动端 Settings Sheet 一起删除的
   `settingsMobileSheetCloseButtonClassName` 断言；raw hex 禁止项仍保留。

测试修复提交：

- `62da3afb` — `test(frontend): fix wrap-up vitest regressions on optimization0824`
- `0877b058` — `test(frontend): align removed settings mobile sheet contract`

## PDF 静态资产守卫

- `public/` 仅保留 `pdf.worker.wrapper.mjs`，不存在手工同步的
  `pdf.worker.min.*` 副本。
- Vite 只从 `node_modules/pdfjs-dist/build/pdf.worker.min.mjs` 拷贝一份实际
  worker payload；`GlobalWorkerOptions.workerSrc` 在 `src/` 中也只有
  `EnhancedPdfViewer.tsx` 一处赋值，并指向 wrapper。
- `config/pdfjs-local-assets.json` 仍是 Vite 与 PDF 测试共享的 CMap 白名单。
- 简中本地子集、现代日文 CMap、遗留日文 CMap 裁剪降级以及三级 fallback
  用例全部通过。

## Build 与 bundle

`npm run build` 通过：

- license compliance：通过
- `tsc --noEmit -p tsconfig.json`：通过
- Vite production build：通过

`npm run check:bundle-size`：

| 预算项 | 实测 gzip | 上限 | 结果 |
| --- | ---: | ---: | --- |
| entry | 1178.0 KiB | 1219.8 KiB | 通过 |
| init | 336.8 KiB | 1438.8 KiB | 通过 |
| vendor-mermaid | 717.6 KiB | 739.2 KiB | 通过 |
| vendor-pptx | 425.9 KiB | 438.7 KiB | 通过 |
| vendor-milkdown | 387.1 KiB | 398.7 KiB | 通过 |
| vendor-exceljs | 263.2 KiB | 271.1 KiB | 通过 |
| total JS | 8285.2 KiB | 8560.6 KiB | 通过 |

构建仍会输出 renderer barrel circular chunk 与静态/动态重复 import 警告，但
不影响本轮 build、typecheck 或 bundle gate 的成功退出。
