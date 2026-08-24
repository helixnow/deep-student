# R1-WI-5：删除冗余 pdf worker，统一到 .mjs

> 子代理：SA-R1-05  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`  
> Work Item：WI-5（删除冗余 pdf worker）

## 调查结论（引用图谱）

`rg "pdf.worker"` 全量结果（src / public / index.html / vite.config.ts 及全库）：

| 文件 | 体积 | 状态 |
| --- | --- | --- |
| `public/pdf.worker.min.mjs` | 1,046,214 B | **实际使用**。与 `node_modules/pdfjs-dist@5.4.296/build/pdf.worker.min.mjs` 逐字节一致（`cmp` 验证） |
| `public/pdf.worker.wrapper.mjs` | 316 B | **实际使用**。被 `EnhancedPdfViewer.tsx:56` 设为 `GlobalWorkerOptions.workerSrc`，内部 `import './pdf.worker.min.mjs'` |
| `public/pdf.worker.min.js` | 1,087,212 B | **冗余，已删除**。webpack UMD 格式、内嵌版本号 `3.11.174`——pdfjs v3 时代遗留（v4+ 上游只发布 `.mjs`），与当前依赖 5.4.296 完全不匹配；全库唯一提及处是 `docs/THIRD_PARTY_LICENSES.md`（文档，非代码引用） |

`index.html` 与 `vite.config.ts` 无 worker 引用（vite 只负责拷贝 cmaps/standard_fonts/wasm，见下）。

## 决策

1. **删除 `public/pdf.worker.min.js`**：零代码引用 + 版本错配（3.11.174 vs 5.4.296），纯粹是升级时未清理的死文件，白白让每个安装包多背 ~1.04 MiB。
2. **保留 `public/pdf.worker.wrapper.mjs`**（任务条件"若无引用"不成立）：
   - 它有活跃引用（`EnhancedPdfViewer.tsx:56`）；
   - 它不是冗余包装——pdfjs-dist v5 的 worker 代码依赖 `Promise.withResolvers`，而 **Worker 拥有独立全局作用域**，主线程的 `src/polyfills/promiseWithResolvers.ts` 覆盖不到 worker 上下文。直接把 `workerSrc` 指向 `pdf.worker.min.mjs` 会让旧 WebView（iOS < 17.4 / Android System WebView Chromium < 119，Tauri 移动端均用系统 WebView）上 PDF 渲染直接崩掉。
   - 已在 wrapper 顶部补注释说明存在理由，防止后续被当垃圾清理。

删除后 worker 链路唯一化：`workerSrc → pdf.worker.wrapper.mjs（polyfill）→ pdf.worker.min.mjs（5.4.296）`，全部 `.mjs`。

## 修改清单

- 删除 `public/pdf.worker.min.js`（1,087,212 B）
- `docs/THIRD_PARTY_LICENSES.md`：打包资源条目去掉 `.js`，改为注明经 wrapper 加载
- `public/pdf.worker.wrapper.mjs`：补充存在理由注释（无逻辑变更）

## pdfjs-dist 资源体量（du -sh，node_modules/pdfjs-dist@5.4.296）

```text
1.7M  node_modules/pdfjs-dist/cmaps
804K  node_modules/pdfjs-dist/standard_fonts
808K  node_modules/pdfjs-dist/wasm
37M   node_modules/pdfjs-dist（整包）
```

这三个目录由 `vite.config.ts` 的 `viteStaticCopy`（158-165 行）在构建时整目录拷入 dist 根，
`src/utils/pdfConfig.ts` 以 `BASE_URL` 相对路径消费。即每个安装包除 worker 外还携带
约 3.3 MiB 的 cmaps/字体/wasm 静态资源；cmaps（1.7M）为其中大头，是后续裁剪
（按需加载/剔除非 CJK 字集）的候选项，本 WI 仅记录不动刀。

## 验证

- `rg "pdf\.worker\.min\.js"` 全库（含 hidden，排除 node_modules/.git）：仅剩本报告自述，无代码引用。
- `cmp public/pdf.worker.min.mjs node_modules/pdfjs-dist/build/pdf.worker.min.mjs`：一致，无版本漂移。
- 未改动任何 TS/构建逻辑（仅删静态死文件 + 文档 + 注释），对现有 worker 加载路径零影响。

## 提交

- commit：`fix(pdf): remove duplicate pdf.worker and unify on .mjs`
