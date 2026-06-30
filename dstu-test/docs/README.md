# dstu-test/docs — 测试运行记录与设计文档

本目录存放真实环境（Tauri 多实例 + WebDAV/MinIO fixtures）测试体系的设计文档与历史运行报告，文件名带日期后缀，按时间归档、只增不改。

## 设计文档

| 文档 | 说明 |
|------|------|
| [local-tauri-instance-manager-design-2026-05-29.md](./local-tauri-instance-manager-design-2026-05-29.md) | tauri-lab 多实例管理器设计 |
| [cloud-sync-real-e2e-lessons-2026-05-29.md](./cloud-sync-real-e2e-lessons-2026-05-29.md) | 真实 E2E 测试经验教训（长期参考） |

## 运行报告（历史快照，不维护）

| 日期 | 报告 |
|------|------|
| 05-30 | [cloud-sync-parallel-e2e-run](./cloud-sync-parallel-e2e-run-2026-05-30.md)、[cloud-sync-deep-10-agent-run](./cloud-sync-deep-10-agent-run-2026-05-30.md)、[cloud-sync-matrix-30-run](./cloud-sync-matrix-30-run-2026-05-30.md)、[learning-hub-parallel-lifecycle-run](./learning-hub-parallel-lifecycle-run-2026-05-30.md) |
| 05-31 | [cloud-sync-six-agent-run](./cloud-sync-six-agent-run-2026-05-31.md)、[cloud-sync-wide-image-regression](./cloud-sync-wide-image-regression-2026-05-31.md) |

> 约定：新运行报告按 `主题-YYYY-MM-DD.md` 命名追加于此；过时报告若失去参考价值可移入 `docs/archive/`。
