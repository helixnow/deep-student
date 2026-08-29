# 云同步与备份恢复 SOTA 打磨（专属分支）

> 分支：`cursor/cloud-sync-sota-b343`
> 目标：把 Deep Student 的云同步、备份、恢复对标市面 SOTA，并结合本仓库真实数据结构做多轮审阅、修复、极端测试。
> 约束：在用户明确要求停止前持续迭代；每轮至少 10 个 Fable 子代理。

## 为什么单独开这个分支

仓库里同时有多条并行任务。本程序只碰云同步 / 备份恢复 / 数据治理同步面，避免和以下工作冲突：

| 并行任务 | 避开的范围 |
|---|---|
| 审阅 notes / mindmap / chat / 翻译 / 教材 / 作文 | 对应业务模块内部逻辑与 UI |
| 审阅桌面壳层 UX / 系统工具 / files 资源库 | workbench 壳层、files 业务（`resourceSync` 仅只读对照） |
| 子应用极致优化 `cursor/sota-subapp-polish-2399` | 各子应用 polish |
| 核心对话协议缓存 `cursor/sota-responses-cache-review-6117` | chat 协议 / cache |
| 移动 UIUX 规范 `cursor/mobile-uiux-unify-0888` | 全局移动视觉规范（本程序只改数据治理相关文案/流程） |
| 既有同步修复枝 `cursor/fix-sync-tombstone-db14` 等 | 合入前先 rebase / 避开同文件热改 |

本程序**允许修改**的文件面：

- `src-tauri/src/cloud_storage/**`
- `src-tauri/src/data_governance/sync/**`
- `src-tauri/src/data_governance/backup/**`
- `src-tauri/src/data_governance/commands_{backup,restore,sync,zip}.rs`
- `src-tauri/src/backup_*.rs`、`src-tauri/src/crypto/backup_crypto.rs`
- `src-tauri/src/cloud_config_commands.rs`
- `src/features/settings/components/data-governance/**`
- `src/features/settings/components/{SyncSettingsSection,CloudStorageSection}.tsx`
- `src/components/DataImportExport.tsx`（仅本地 ZIP 导入后的整槽拒绝门，不改其它页）
- `src/utils/cloudStorageApi.ts`、`src/stores/syncStatusStore.ts`、`src/hooks/useBackupJobListener.ts`
- `src/locales/*/sync.json`、`src/locales/*/cloudStorage.json`
- `docs/user-guide/16-数据管理与云同步.md`（仅云整包/恢复诚实句，不改其它章节）
- `src-tauri/tests/sync_*.rs`、`tests/vitest/data-governance/**`
- `docs/dev/cloud-sync-sota-b343/**`（本目录）

超出上述范围的改动必须先在本 README 登记，并确认不与并行代理撞车。

## 产品定位（当前代码事实）

Deep Student 是本地优先学习工作台。云同步在 README 中标记为 **experimental（backup-style，不是实时协作）**。

当前实现分两层：

1. **整包云备份**：本地 ZIP（可 AES-256-GCM / DSBK）上传到用户自有 WebDAV / S3 / FTP，带版本清单与保留策略。恢复走 A/B 槽位，重启后切换。
2. **记录级同步**：`__change_log` + tombstone + HLC/版本戳 + 冲突策略 + 隔离区。面向多设备换机/备份式合并，不是 OT/CRDT 实时协作。

平台差异（必须纳入测试矩阵）：

| 平台 | WebDAV | S3 | FTP | 备注 |
|---|---|---|---|---|
| Windows / macOS / Linux | 有 | 默认 feature `cloud_storage_s3` | 有（实验，已知一致性风险） | 桌面完整能力 |
| Android | 有 | **`mobile-slim` 未开 S3 feature** | **编译期禁用** | 换机场景目前几乎只能走 WebDAV |

## SOTA 对照对象

审阅时不只看“有没有功能”，而看生产可用性：

- 备份完备性：Obsidian（官方 Sync / 第三方 Remotely Save）、Joplin、Standard Notes、Apple 设备备份
- 自托管同步：Syncthing、Nextcloud、WebDAV 坚果云/TeraCloud、S3/R2/OSS/MinIO
- 学习数据同步：AnkiWeb / Anki 多设备、Logseq/Anytype 本地优先同步
- 安全：E2EE（Standard Notes / Signal 备份模型）、凭据隔离、半配置状态、错误密码不可静默损坏
- 复杂同步：tombstone、因果序、时钟漂移、重复包幂等、断点续传、列表截断当删除、跨版本 schema

## 轮次约定

- **调研 / 复审**：`claude-fable-5-thinking-xhigh`（若不可用则明示降级到 `claude-fable-5-thinking-high`）
- **落地修复**：`claude-fable-5-thinking-high`（父代理不直接改业务逻辑）
- 每轮至少 10 个子代理；父代理只写本目录文档、协调、开 PR
- 每一轮输出：发现、P0/P1/P2、修复清单、测试证据、剩余风险

## 进度

| 轮次 | 状态 | 说明 |
|---|---|---|
| R01 只读调研 | 已完成 | 10 个 Fable xhigh 并行审阅，产出 [FINDINGS-R01](./FINDINGS-R01.md)：9 P0 |
| R02 修复落地 | 已合入 | 十路修复全部合入本枝（含中断重试），R01 P0/P1 基本关闭，见 [ROUND-02](./ROUND-02.md) |
| R03 复审 | 已完成 | xhigh 独立只读复审，产出 [FINDINGS-R03](./FINDINGS-R03.md)：新增 2 P0 / 6 P1 / 2 P2 |
| R04 修复落地 | 已合入 | 七路修复分支合入本枝，FINDINGS-R03 十项关九项；P1-ANDROID-FTP-SSOT 未交付转 R05，见 [ROUND-04](./ROUND-04.md) |
| R05 极端测试与复审 | 已合入 | 五路分支合入本枝（android-ftp / ftp-i18n / tests / zip-resume / webdav-1k，另含直接提交）；R05-guide 未交付转 R06，见 [FINDINGS-R05](./FINDINGS-R05.md) |
| R06 E2EE 闭环与跨平台资产 | 部分合入 | 校验子 / 单侧 DELETE 可解 / 指南回写已合；资产文件级 E2EE、自动同步、跨平台文件名、Android 语义未交付，见 [ROUND-06](./ROUND-06.md) |
| R07 CI 收口与文件级 E2EE | 部分合入 | 已合文件级 DSBK、自动同步、记录级校验子、WebDAV 409、文件名测试；文案已回写不再称文件级明文，见 [ROUND-07](./ROUND-07.md) |
| R08 复审与收口 | 进行中 | 见 [ROUND-08](./ROUND-08.md) |
| R09–R10 大包 | 进行中 | 每路 ≥4 交付物；P1-1 冲突 UI 已关；P2-2 KDF 钳制已合，见 [ROUND-10](./ROUND-10.md) |
| R11 大包 | 部分合入 | history / unsynced-ui / autosync2 / check / review / rotate / android2 / lease / names2 / delta 调研已合，见 [ROUND-11](./ROUND-11.md) |
| 收尾 | 进行中 | P2-1/P2-2/P2-6 稳定 code 已关；delta 积木已合（未接线）；中性对象名阶段一已合；记录级/tombstone 路径短哈希已合；文件级清单与快照新写入改为中性 UUID；资产 tombstone 显式 skip 共享对象已合（未带 ftp.rs）；内存级 `get()` 半包闸与 S3 multipart 分块重试已合（不宣称跨会话上传续传 / 增量）；见 [WRAP-CLOSE.md](./WRAP-CLOSE.md) |

## 文档索引

- [ROUND-01.md](./ROUND-01.md) — 第一轮调研任务拆分
- [FINDINGS-R01.md](./FINDINGS-R01.md) — R01 调研结论（P0/P1/P2）
- [ROUND-02.md](./ROUND-02.md) — 第二轮修复拆分与合入状态
- [FINDINGS-R03.md](./FINDINGS-R03.md) — R03 复审结论（R04 输入）
- [ROUND-04.md](./ROUND-04.md) — 第四轮修复任务拆分
- [ROUND-05.md](./ROUND-05.md) — 第五轮极端测试、复审与残留补做
- [FINDINGS-R05.md](./FINDINGS-R05.md) — R05 合入结论与复审残留（R06 输入）
- [ROUND-06.md](./ROUND-06.md) — 第六轮 E2EE 闭环、单侧冲突可解与跨平台资产
- [ROUND-07.md](./ROUND-07.md) — 第七轮 CI 收口、文件级 E2EE、自动同步与跨平台资产
- [ROUND-08.md](./ROUND-08.md) — 第八轮文件级 E2EE 复审、文件名净化、Android 与 CI
- [ROUND-10.md](./ROUND-10.md) — 第十轮大包收口（冲突 UI / 文件名 / 校验子硬化）
- [SOTA-R10.md](./SOTA-R10.md) — R09 合入后的 SOTA 对照（我们已有 / 诚实差距 / 不该学）
- [PROTOCOL-R10.md](./PROTOCOL-R10.md) — FINDINGS-R01/03/05/07 与 FIX-QUEUE 逐条核销（仍开项锁定测）
- [ROUND-11.md](./ROUND-11.md) — 第十一轮大包任务表（巡检 / 时点恢复 / 增量调研 / 可逆文件名 / 租约）
- [DELTA-R11.md](./DELTA-R11.md) — 整包 ZIP 走向增量的三路线、合成基准、推荐对象布局与下一轮拆分
- [KEY-ROTATION-R11.md](./KEY-ROTATION-R11.md) — 备份密码更换现状与用户流程、文件名元数据收敛、KDF 参数钳制复审与 R12 任务拆分
- [WRAP-CLOSE.md](./WRAP-CLOSE.md) — 收尾 go/no-go 与已合/未关清单
- [FINDINGS-R11.md](./FINDINGS-R11.md) — R10 七路 + R11 两路合入项核销、新发现（含 repo_check DSBK v2 头偏移 P1）、锁定测清单与 SOTA-R10 §3 改判建议
- [FINDINGS-WRAP.md](./FINDINGS-WRAP.md) — 收尾只读复审：四类 P0 核销、仍开 P1/P2、诚实未达与生产 Go/No-Go
- [WRAP-E2EE.md](./WRAP-E2EE.md) — E2EE 收尾核对：KDF 上限 / 删标记拒明文 / FileCipherSession 无旁路
- [ANDROID-HANDBOOK-R11.md](./ANDROID-HANDBOOK-R11.md) — Android WebDAV/SAF/恢复重启真机核对单、已知缺口、mobile-slim + S3 量化评估
- [FIX-QUEUE.md](./FIX-QUEUE.md) — 修复认领队列（文件面独占）
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 当前架构与数据面地图
