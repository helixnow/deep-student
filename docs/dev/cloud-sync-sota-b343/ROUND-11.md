# Round 11 — 大包任务表（每路 ≥4 个可验证交付物，文件面独占）

模型约定：只读复审/调研用 `claude-fable-5-thinking-xhigh`（不可用则**明示**降级 high，回复第一行自报实际 slug）；写代码/测试用 `claude-fable-5-thinking-high`。禁止静默降级。每路必须做完一整包再推，禁止只交单测或单注释。

## 前置与派出时机

- 输入：[SOTA-R10](./SOTA-R10.md) §2 各"诚实差距"与 §5 汇总。
- **派出前先收 R10 十路**：R10-conflict-ui（P1-1）/ verifier / names / download / ux / providers / protocol / chaos / android 若已合入，R11 对应路只收增量、不重做；若某路未交付，其任务并入下表同域代理（在 FIX-QUEUE 登记后接手其文件面）。
- 全轮避开 notes / chat / workbench / 移动全局规范 / 协议缓存等并行任务文件面；允许改动面以 [README](./README.md) 白名单为准。

## 派出状态

R10 已合入：conflict-ui / sota / ux / protocol / android / download / chaos / verifier / **providers**。R11 已合入：rotate / check / review / autosync2 / history / unsynced-ui。R12 已合入：decoded-dead / **repocheck-fix（P1）**。专属枝 HEAD `d746da20`。收尾见 [WRAP-CLOSE.md](./WRAP-CLOSE.md)。不合并 `r07-docs`。

R11-names2 已在 `cursor/cloud-sync-sota-names2-b343` 专枝交付：非法字符改为带版本
标记的可逆映射，旧 R09 `_` key 走双 key 查找并在内容更新时迁移；段/总长越界
fail-closed。实现与测试登记见 [FIX-QUEUE](./FIX-QUEUE.md#r11-names2分支-cursorcloud-sync-sota-names2-b343资产-key-可逆映射)。

## 十路大包

| 代理 | 模型 | 分支 | 一整包必须交付（每路 ≥4） |
|---|---|---|---|
| R11-review | xhigh | `cursor/cloud-sync-sota-r11-review-b343` | ① R10 十路合入项逐条核销表（FINDINGS-R11.md）；② 新发现按 P0/P1/P2 分级并给证据锚点；③ 仍开项的锁定测清单（指明测试文件与断言）；④ SOTA-R10 §3 矩阵改判建议（哪些行因 R10 交付可翻"已达"） |
| R11-check | high | `cursor/cloud-sync-sota-r11-check-b343` | ① 云端仓库巡检命令（restic `check` 档）：遍历 manifest 引用对象、核对存在性/SHA256/DSBK 头可解、报孤儿与缺失，只读不修；② 巡检结果 UI 入口与人话报告（含"发现坏对象后该做什么"指引）；③ zh+en locale 键；④ 集成测试新文件（好库全绿 / 缺对象 / 坏密文 / 孤儿对象 / 截断时拒绝给"全绿"结论）；⑤ 用户指南 16 巡检小节 |
| R11-history | high | `cursor/cloud-sync-sota-r11-history-b343` | ① 记录级时点恢复最小版：冲突批量解决/库级策略覆盖执行前自动快照受影响记录（GAP-8 最小闭环，快照进本地表不上云）；② 快照浏览与单批回退命令；③ 回退与 change_log/回声过滤的交互测试（回退不得被同步再覆盖）新文件；④ SyncTab/冲突面板"可撤销"文案 zh+en；⑤ 保留策略（快照上限与清理） |
| R11-delta | xhigh | `cursor/cloud-sync-sota-r11-delta-b343` | ① 调研文档 DELTA-R11.md：整 ZIP → 增量的三条路线（内容寻址 objects 复用 / manifest 级未变跳过 / CDC 分块）在我们 dumb-storage + E2EE 约束下的可行性与恢复语义影响；② 现状基准：典型库尺寸下整 ZIP 备份的流量/耗时测量脚本与数据；③ 推荐路线的对象布局草案（含与现有 `backups/` 版本清单、10 版保留、GC 顺序的兼容性分析）；④ 不做实现，产出下一轮可直接认领的任务拆分；⑤ 风险清单（增量链损坏、GC 竞态、加密去重信息泄露） |
| R11-names2 | high | `cursor/cloud-sync-sota-names2-b343` | ① `asset_filenames.rs` 从有损净化升级为 rclone 档可逆映射（非法字符 → 安全码点编码，可无损还原）；② 旧净化 key 的兼容/迁移路径（云端已有净化 key 不得变孤儿）；③ 全边界测试更新+新增（编码往返、大小写、NFC/NFD、保留名、与旧 key 共存）；④ 冲突人话消息按新语义更新 zh+en；⑤ 在 FIX-QUEUE 登记与 R10-names 增量的关系 |
| R11-lease | high | `cursor/cloud-sync-sota-r11-lease-b343` | ① 常规记录级同步的 sync target 租约（Joplin 锁档）：上传窗口内互斥、带 TTL、陈旧锁回收，复用换机两段式租约的存储格式；② 租约被占时的人话错误与重试指引 zh+en；③ 集成测试新文件（并发两设备、陈旧锁回收、租约与 `remote_format_version` 门槛叠加、崩溃残锁）；④ ARCHITECTURE.md 租约状态机小节；⑤ 改 `sync_manager.rs`/`mod.rs` 前先在 FIX-QUEUE 登记 |
| R11-unsynced-ui | high | `cursor/cloud-sync-sota-r11-unsynced-ui-b343` | ① Dropbox 档"未同步文件清单"常驻面板：`download_failures`、文件名净化/大小写冲突跳过、明文遗留拒收对象一处可见；② 每条目给原因与可执行建议（重试/改名/迁移）；③ zh+en locale；④ vitest 新文件（空态/多类目/重试动作）；⑤ 后端若需新查询命令，独立新增不改既有命令签名 |
| R11-rotate | xhigh | `cursor/cloud-sync-sota-r11-rotate-b343` | ① 调研文档 KEY-ROTATION-R11.md：SN 式原地密钥轮换 vs 现状"换密码=换 root 全量重传"的差距、我们 DSBK 会话密钥模型下的轮换协议草案（标记 v3、双钥过渡窗、中断恢复）；② `backups/<version>.zip` 命名暴露设备短 ID/时间戳的元数据泄露评估与收敛方案（含向后兼容）；③ Argon2 参数钳制（R10-verifier 交付）的独立复审；④ 不做实现，产出下一轮任务拆分与验收标准 |
| R11-autosync2 | high | `cursor/cloud-sync-sota-r11-autosync2-b343` | ① 自动同步定时档位（如 15min/1h/6h，默认关不变）；② 触发前置检查复审+加固：未配置云端/无密码/租约被占一律静默跳过并记录状态，绝不弹错打扰；③ 状态可见（上次自动同步时间/结果进 `syncStatusStore` 与 UI）；④ rust+vitest 测试新文件（档位调度、fail-close、与手动同步互斥锁）；⑤ zh+en locale |
| R11-android2 | high | `cursor/cloud-sync-sota-r11-android2-b343` | ① Android 真机/模拟器换机验证手册（docs/dev 本目录，含 WebDAV 配置→同步→恢复→重启逐步核对单与已知限制）；② content URI（SAF）导入/导出路径的现状审计与缺口清单；③ `mobile-slim` 启用 S3 feature 的体积/依赖影响评估（量化数据）；④ 能修的修：S3 拒绝文案 i18n 映射（FIX-QUEUE 已登记的 P2-LOCALE-PLATFORM-MSG，错误码优于字符串正则）；⑤ 相关测试更新 |

## 文件面独占

| 代理 | 独占文件面 |
|---|---|
| R11-review | 只读；产出 FINDINGS-R11.md 归本目录 |
| R11-check | `cloud_storage/repo_check.rs` 新文件（或 `sync_manager.rs` 内新巡检段——动 `sync_manager.rs` 先登记）、`commands_sync.rs` 新巡检命令段、巡检 UI 落点（`CloudStorageSection.tsx` 巡检入口区）、`cloudStorage.json`（zh/en）`repoCheck.*` 新键、`src-tauri/tests/sync_r11_repo_check.rs` 新文件、用户指南 16 巡检小节 |
| R11-history | `data_governance/sync/history.rs` 新文件、`conflict_resolver.rs` 快照挂钩段（先登记）、`RecordConflictsPanel.tsx` 撤销入口、`data.json`/`sync.json` 新键、`src-tauri/tests/sync_r11_history.rs` 新文件 |
| R11-delta | 只读+基准脚本；DELTA-R11.md 归本目录，脚本放 `src-tauri/tests/` 不进 CI 门禁 |
| R11-names2 | `data_governance/sync/asset_filenames.rs`、`tests/sync_r09_filenames.rs` 与 `sync_r07_*names*` 既有测试按新语义更新、`sync.json` 冲突消息键 |
| R11-lease | `cloud_storage/sync_manager.rs` 租约段（先登记）、`data_governance/sync/mod.rs` 上传窗口挂钩（先登记）、`src-tauri/tests/sync_r11_lease.rs` 新文件、`sync.json` `errors.leaseHeld` 等新键、ARCHITECTURE.md 租约小节 |
| R11-unsynced-ui | `data-governance/UnsyncedItemsPanel.tsx` 新文件、`SyncTab.tsx` 面板挂载点（仅挂载行）、`sync.json` `unsynced.*` 新键、`tests/vitest/data-governance/r11-unsynced-*.test.tsx` 新文件、必要时 `commands_sync.rs` 新只读查询命令段 |
| R11-rotate | 只读；KEY-ROTATION-R11.md 归本目录 |
| R11-autosync2 | `data_governance/sync/` 自动同步文件（R07-autosync 落点，接手前核对 FIX-QUEUE）、`SyncSettingsSection.tsx` 档位 UI、`syncStatusStore.ts`、`sync.json` `autoSync.*` 键、`src-tauri/tests/sync_r11_autosync.rs` 与 `tests/vitest/data-governance/r11-autosync-*.test.tsx` 新文件 |
| R11-android2 | 手册文档归本目录、`cloudStorage.json`（zh/en）S3 拒绝键与 `CloudStorageSection.tsx` 映射段、`tests/sync_android_*.rs` 更新 |

交叉规则：`sync_manager.rs` 本轮有 R11-check（可选落点）与 R11-lease 两个潜在写者——**R11-lease 持有独占**，R11-check 必须用独立新文件 `repo_check.rs`；`SyncTab.tsx` 本轮仅 R11-unsynced-ui 可动且仅限挂载行；`commands_sync.rs` 由 R11-check（巡检命令）与 R11-unsynced-ui（只读查询）分段共享，各自只加新命令不改既有函数,推前 rebase 消解。与 R10 未合入路撞面时,以 FIX-QUEUE 登记时间先后为准。
