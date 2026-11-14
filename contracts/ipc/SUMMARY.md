# IPC 契约汇总

由 `npm run contracts:generate` 生成（deep-student/node-contracts@1.0.0），勿手改。

源文件：`contracts/ipc/*.json`。生成与校验不读取实现源码，不依赖 Rust 工具链。

命令 1061；事件 127（按所属契约计）；类型定义 978。

| 契约 | 命令 | 事件 | 类型 |
|---|---:|---:|---:|
| F1-kernel | 11 | 3 | 7 |
| F2-shell | 23 | 10 | 2 |
| F3-storage | 33 | 0 | 15 |
| F4-security | 44 | 1 | 26 |
| L01-llm-providers | 5 | 0 | 8 |
| L02-llm-manager | 27 | 24 | 32 |
| L04-chat-session | 107 | 6 | 101 |
| L05-agent-workspace | 12 | 9 | 18 |
| L06-agent-orchestration | 18 | 8 | 18 |
| L07-agent-skills-ptc | 22 | 4 | 27 |
| L10-notes | 81 | 9 | 63 |
| L12-vfs-index | 3 | 7 | 5 |
| L13-vfs-api | 214 | 6 | 151 |
| L14-qbank | 88 | 10 | 164 |
| L15-review-analytics | 70 | 1 | 74 |
| L16-anki | 61 | 2 | 44 |
| L17-memory-research | 34 | 3 | 14 |
| L18-media-docs | 75 | 6 | 54 |
| L19-mcp-browser | 62 | 13 | 33 |
| L20-sync | 24 | 1 | 27 |
| L21-backup-governance | 33 | 2 | 34 |
| L23-sync-providers | 14 | 1 | 7 |
| L24-chatanki | 0 | 1 | 0 |
| _shared | 0 | 0 | 54 |
