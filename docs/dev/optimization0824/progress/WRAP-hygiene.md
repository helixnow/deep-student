# optimization0824 合并卫生收尾

> 代理：SA-WRAP-HYGIENE
> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24

## 清扫结果

| 检查项 | 结果 |
| --- | --- |
| 冲突标记 | 全仓无真实 `<<<<<<<` / `>>>>>>>` 残留；唯一文本命中是冲突守卫测试自身的正则 |
| PDF worker | `public/` 仅保留 `pdf.worker.wrapper.mjs`；worker 实体由 Vite 从 `pdfjs-dist/build` 复制，无重复仓库副本 |
| 本地 PDFium | `libpdfium.so` 未跟踪、未纳入提交；新增精确 ignore，避免 CI/本地下载产物误提交 |
| 过时配置 | 删除已卸载 `react-hotkeys-hook` 的 `optimizeDeps.include` 条目 |
| 过时注释 | `mobile-slim` 从“草案”纠正为 R2/R3 已落地状态；Android PDFium 注释对齐实际 jniLibs 打包链 |
| 错误路径 | PDF.js worker 文档改为 `node_modules/pdfjs-dist/build` 构建单源；R4 报告的 notices 路径对齐 `legal/THIRD_PARTY_NOTICES.txt` |

## WI 代码对照

- WI-5：`tests/vitest/pdf/pdfStaticAssets.test.ts` 守卫 public 无 worker 副本，Vite
  从 `pdfjs-dist/build/pdf.worker.min.mjs` 复制。
- WI-6：Android workflow 已统一
  `--no-default-features --features mobile-slim`，正常 release 为
  `opt-level=z / codegen-units=16`，应标记完成。
- WI-11：`provider_quirks.rs` 仍不存在，`model2_pipeline.rs` 的 provider 判定函数
  仍在，Phase1 确实未交付。
- WI-12：JSONL exporter、Tauri command 与 ACL 均存在。
- WI-13：`PipelineHook` 四个切点及默认审批/审计 hook 已注册；第一阶段完成，
  后续扩展是独立刀口。

`COORDINATION.md` 已据此纠正 WI-5/6/11/13，并将 R4 标记为 `✅ 收尾中`；
当前唯一缺失的 R4 工作包仍是 WI-11 Phase1。
