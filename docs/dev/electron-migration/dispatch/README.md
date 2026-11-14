# 派发清单（28 条 lane）

> **第二阶段（恢复派发后）**：lane 集合与工作来源以 `../RESUME-PLAN.md` 为准。处置表 `DISPOSITION.json`（提案 `DISPOSITION.proposed.json`）
> 决定哪些 lane 退役、并入、继续，以及路径归属；新增 lane 的任务卡为 `P1-plugin-health.md` … `P6-ui-features.md`。下文是 v1 时期的首批派发清单，仅作历史参考。

每个文件是一份**自包含的任务提示**，直接作为一个代理的初始指令。并发上限 30，全部可同时派发。

## 派发顺序

1. **先派**（被消费最多、需要先发布 `api.ts`）：F4-security（AppError）、L13-vfs-api、L04-chat-session、L02-llm-manager、L22-app-commands、L05-agent-workspace、L12-vfs-index、L11-vfs-repos、L23-sync-providers、L01-llm-providers、F3-storage（data_space 启动）、F1-kernel（官方 profile）。
2. **同时派**：其余全部 lane。它们按 DRAFT 写最小接口、测试里用替身，不等待提供方。
3. **暂缓**：F6 录制（用户决定暂缓，C 级）。

## 文件

- [F1-kernel](F1-kernel.md)
- [F2-shell](F2-shell.md)
- [F3-storage](F3-storage.md)
- [F4-security](F4-security.md)
- [F5-contracts](F5-contracts.md)
- [F7-native](F7-native.md)
- [L01-llm-providers](L01-llm-providers.md)
- [L02-llm-manager](L02-llm-manager.md)
- [L03-chat-pipeline](L03-chat-pipeline.md)
- [L04-chat-session](L04-chat-session.md)
- [L05-agent-workspace](L05-agent-workspace.md)
- [L06-agent-orchestration](L06-agent-orchestration.md)
- [L07-agent-skills-ptc](L07-agent-skills-ptc.md)
- [L10-notes](L10-notes.md)
- [L11-vfs-repos](L11-vfs-repos.md)
- [L12-vfs-index](L12-vfs-index.md)
- [L13-vfs-api](L13-vfs-api.md)
- [L14-qbank](L14-qbank.md)
- [L15-review-analytics](L15-review-analytics.md)
- [L16-anki](L16-anki.md)
- [L17-memory-research](L17-memory-research.md)
- [L18-media-docs](L18-media-docs.md)
- [L19-mcp-browser](L19-mcp-browser.md)
- [L20-sync](L20-sync.md)
- [L21-backup-governance](L21-backup-governance.md)
- [L22-app-commands](L22-app-commands.md)
- [L23-sync-providers](L23-sync-providers.md)
- [L24-chatanki](L24-chatanki.md)

## 协调者职责（派发后）

- 每隔几小时运行 `npm run migration:ledger -- --check --no-write`，按 A 级完成率排序，给落后 lane 加人（拆子包、独立目录）。
- 汇总各 lane 报告中的依赖需求，统一安装并提交 `package.json`。
- 裁定语义歧义并写入 `decisions.md`；批准 obsolete（`migration/approvals.json`）。
- 对齐 `api.ts` 与消费方的最小接口差异。
- A 级全部完成后，按 README §5.4 安排交叉审读。
