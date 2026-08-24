# SOTA-R07 — 市面 SOTA 对照与本轮剩余缺口（只读）

- 代理：R07-sota；模型：`claude-fable-5-thinking-high`（期望 xhigh 不可用，显式降级，非静默）。
- 基线：`origin/cursor/cloud-sync-sota-b343` @ `871528a3`（2026-08-24 检出，隔离 worktree）。
- 性质：只读对照，不改业务代码。行号锚点以上述 commit 为准。
- 对照对象：Joplin / AnkiWeb（Anki 同步）/ Syncthing / restic / rclone / Nextcloud / Seafile / Dropbox / OneDrive / Standard Notes。
- 视角：不比"功能有没有"，比生产可用性——E2EE 覆盖、多设备冲突、列表截断、错密码、跨平台文件名、自动同步、换机恢复。

## 0. 结论（TL;DR）

经过 R01–R06 六轮打磨，本仓库在**协议防损层**（列表截断硬失败、错密码 ZIP 路径 fail-fast、明文/密文混布拒绝、A/B 槽换机恢复、冲突双侧保留 + 隔离区）已达到或超过对照对象中的多数产品。剩余缺口高度集中在四件事，且与 R07 在飞任务对齐：

1. **文件级对象明文**（blobs / workspace db / 资产对象）——是当前与 restic、Standard Notes、Joplin 的最大差距，宣传"E2EE 已启用"时覆盖面不完整（UI 已诚实披露，但产品力仍差一档）。
2. **零自动同步**——十家对照对象全部具备某种形式的自动触发，我们是唯一纯手动的。
3. **跨平台资产文件名**——rclone 的 encoding 层是该维度的事实 SOTA，我们完全没有等价物。
4. **记录级同步的错密码防线不完整**——R06 校验子只护住了 ZIP 上传路径；记录级上传走的 bool 版策略不校验密码（本轮新确认，见 §3 GAP-4）。

## 1. 本仓库真实数据面（证据锚点）

### 1.1 E2EE 覆盖

- 加密范围（`sync/mod.rs` L720–739 的字段文档，代码与注释一致）：
  - ✅ 整包 ZIP 备份（`cloud_storage/mod.rs` L278–299，流式加密到 `.dsbk` 再上传）；
  - ✅ 记录级 `SyncManifest` / `SyncChangesPayload` / tombstones / 各类元数据清单（`encode_payload`，L777–785）；
  - ❌ VFS blob 原始字节（`sync_vfs_blobs_with_progress_excluding` L9919 直接 `put_file` 明文）；
  - ❌ workspace `.db` 快照（L9552 同样明文 `put_file`）；
  - ❌ 资产文件对象（`sync_asset_directories_*` L10246 明文 `put_file`，内容寻址 `objects/<sha256>`）。
- 防降级：`decode_payload`（L799–828）在本端启用加密时拒绝无 DSBK 头的明文对象；带 DSBK 头但无密码/错密码显式报错。
- UI 诚实披露：`cloudStorage.json` `encryption.statusConfigured` = "已配置端到端加密（部分覆盖）"，`description` 明说文件级对象以原文上传（zh L78–96）。

### 1.2 多设备冲突

- 记录级：`__change_log` + `(source_device_id, source_seq, table_name, record_id, operation)` 幂等去重索引（L5680）；冲突进 `__sync_conflicts`，**败方永不丢弃**（`conflict_resolver.rs` 模块文档），单侧（cloud-only）DELETE 冲突 R06 起可解（`b31ee744`）。
- 不可解析/坏时钟变更进隔离区（`SyncQuarantinePanel`），单条隔离不 DoS 整轮（R04-tombstone）。
- ZIP 备份：per-device manifest（`sync_manager.rs` L198–215 合并），规避多设备 read-modify-write 互相覆盖。
- 文件级：资产清单带 `base_sha256` + `revision` 乐观并发，base 变化时本地留冲突副本、不盲写（L10333–10386）；LWW 平局用内容哈希决胜保证全设备收敛（L9249–9272）。
- 局限：文件清单写前刷新只是"缩小竞态窗口"（代码自述 D9-lite），非 CAS/ETag 条件写；无向量时钟。

### 1.3 列表截断

- 契约层：`ListOutcome.truncated`（`traits.rs` L57–72），同步下载路径把截断当硬错误，"漏列 ≠ 删除"。
- S3：`is_truncated=true` 却无 continuation token 时如实报错而非静默返回半页（`s3.rs` L532–543）。
- FTP：递归遍历超 200 目录上限标记 truncated，绝不静默（`ftp.rs` L34–36、L876–956）。
- WebDAV：无分页协议，只能启发式——单目录 response 数命中 750/751/1000/1001 判为已知服务端截断边界（`webdav.rs` L109–132）；manifest 列表截断时拒绝合并版本列表（`sync_manager.rs` L290–298）。
- 残余风险：WebDAV 启发式对"未知边界截断"的服务端无能为力（诚实局限，见 §3 GAP-9）。

### 1.4 错密码

- ZIP 上传：`.encryption-marker` v2 携带不可逆密码校验子，错密码设备在写任何 `backups/` 对象**之前**失败；旧 v1 标记一次性升级；损坏/未知 KDF/v2 缺校验子一律 fail-closed（`sync_manager.rs` L494–562，测试 L1511–1675）。
- ZIP 下载：DSBK 魔数识别，无密码/错密码显式失败，解密到临时文件成功后才 persist，不会用损坏产物覆盖下载件（`cloud_storage/mod.rs` L434–483）。
- 记录级下载：`decode_payload` 错密码显式报错，停机保护。
- **缺口**：记录级**上传**走 `enforce_encryption_policy_before_upload(bool)`（`commands_sync.rs` L53–62），该入口自述"不校验密码一致性"（`sync_manager.rs` L576–582）——见 §3 GAP-4。

### 1.5 跨平台文件名

- 资产对象云端 key 为内容寻址（`objects/<sha256>`），传输层规避了非法字符；但**清单 key 是本地相对路径**（`active/<dir>/<rel>`）。
- 下载侧 `asset_local_path_from_key`（L10524+）只防路径穿越/符号链接，不做 Windows 保留名、非法字符（`: * ? " < > |`）、大小写折叠、NFC/NFD 归一。
- 后果推演：Linux 端上传含 `:` 文件 → Windows 端 `get_file` 创建失败落入 `download_failures`（跳过不炸整轮，尚可）；大小写仅异的两个 key 在 Windows/macOS 指向同一物理文件 → 冲突副本churn；macOS NFD 与 Windows NFC 同名文件 → 云端分裂成两个 key 永不合一。R07-asset-names 未交付。

### 1.6 自动同步

- 记录级云同步与 ZIP 云备份均**无任何自动触发**：`SyncTab.tsx` 只有手动 双向/上传/下载 按钮；`sync.json` 的 `autoSync` 键（zh L83）无消费方。
- 本地自动备份存在（`backup_config.rs` `start_auto_backup_scheduler`，6–72h 档位），但不接云端上传（grep 无 cloud/upload 引用）。R07-autosync 未交付。

### 1.7 换机恢复

- 云 ZIP → 下载校验 SHA256 → 解密 → 写非活动 A/B 槽（`commands_restore.rs` L628–714）→ 原子登记 cutover（L1091–1097）→ 重启切换（`requires_restart: true`）。
- 恢复后 device_id 轮换 + restore journal 幂等（`sync_manager.rs` L1087–1174），避免回声过滤吞掉旧身份备份点之后的变更。
- 恢复后 `reset_sync_baseline_after_restore` 截断 change_log 重置基线。
- 平台差异：Android `mobile-slim` 无 S3 feature、FTP 编译期禁用（`cloud_storage/mod.rs` L24–27、L108–124），换机几乎只能走 WebDAV；`app.restart()` 语义未实测（R07-android 在飞）。

## 2. 逐家对照

图例：**已达** = 我们在该维度不劣于对方；**未达** = 对方明显更强；**我们更强** = 我们有对方没有的防损能力。

### 2.1 Joplin

本地优先笔记，同步目标 WebDAV/Dropbox/OneDrive/S3/Joplin Cloud，可选 E2EE（主密钥模型，笔记与**附件资源都加密**），冲突落"Conflicts"文件夹，定时自动同步（默认约 5 分钟档），2.x 起有 sync target 锁防多客户端升级踩踏。

- 已达：冲突不丢数据（我们冲突表双侧保留 vs 其冲突文件夹，粒度相当甚至更细——字段级合并注册表 vs 其整条笔记副本）；错密码——Joplin 主密钥校验失败提示，我们 ZIP 路径 fail-fast 等价。
- 未达：**E2EE 覆盖附件**（我们资产/blob 明文）；**自动同步**（我们无）；sync target 锁——我们对"新旧版本客户端同时写同一 root"仅靠 `remote_format_version/min_reader_version` 门槛，无租约锁。
- 我们更强：列表截断防线（Joplin 依赖 provider 列表正确性，坚果云截断场景有真实丢同步先例）；整机换机（Joplin 无 A/B 槽整包恢复，重装后需全量重拉且设置不随 E2EE 同步）；错密码污染防护（Joplin 允许多主密钥并存，配错密码的设备会产出另一套密文共存，我们校验子直接拒绝）。

### 2.2 AnkiWeb（Anki 同步）

中心化同步（官方服务或自托管 anki-sync-server），打开/关闭自动同步，schema 变更强制"全量上传或全量下载、二选一"，选错一侧整侧数据丢失；无 E2EE；媒体文件单独同步管道。

- 已达：换机（登录即拉全量，我们 WebDAV 下载最新版恢复等价，多一步重启）；媒体/正文分管道（我们记录级/文件级分离类似）。
- 未达：**自动同步**（开合即同步的顺滑度是学习类应用的标杆）；同步耗时——增量协议 + 服务端合并比我们"全 ZIP 或全变更包"轻。
- 我们更强：**冲突语义整个层级领先**——AnkiWeb 冲突时用户被迫整库二选一（数据丢失级 UX），我们记录级合并 + 冲突表 + 隔离区；**E2EE**（AnkiWeb 无，服务器可读全部卡片）；自托管自由度（任意 WebDAV/S3/FTP vs 专用协议）。

### 2.3 Syncthing

P2P 持续文件同步，块级传输、监视文件系统即时触发、冲突生成 `.sync-conflict-*` 文件、版本化选项、receive-encrypted（不受信节点存密文）；对大小写冲突与 Windows 非法名有显式检测报错。

- 已达：冲突保留双方（其冲突文件 vs 我们冲突表/冲突副本）；截断问题域不存在于 P2P 索引交换，我们在 provider 模型下做到的硬失败是等价审慎。
- 未达：**自动同步**（watch + 即时块级传播是该维度天花板）；**跨平台文件名**（Syncthing 显式拒绝/提示大小写冲突与非法名，我们无检测）；传输效率（块级增量 vs 我们整文件/整 ZIP）。
- 我们更强：E2EE 语义更完整（Syncthing 常规节点明文存储，receive-encrypted 仅覆盖不受信节点且元数据裁剪有限；我们记录级文本面 AES-256-GCM + 密码校验子）；结构化数据合并（Syncthing 只会对 SQLite 文件整体冲突，无法记录级合并——这正是我们产品定位的护城河）；换机恢复（Syncthing 无"备份版本"概念，删除会传播，我们 A/B 槽 + 10 版保留可回退）。

### 2.4 restic

加密优先备份工具：仓库级 E2EE（默认且不可关）、内容定义分块去重、快照/保留策略（`forget --keep-*`）、`check` 完整性巡检、错密码开仓即失败、append-only 防勒索模式。

- 已达：错密码 fail-fast（我们 ZIP 路径校验子等价）；保留策略（我们 10 版 prune，先发布 manifest 再 GC 的顺序正确）；校验和全链路。
- 未达：**E2EE 全覆盖且无明文模式**——restic 不存在"部分覆盖"与"明文降级"这两个概念，标记删除攻击面也不存在（我们 `.encryption-marker` 被删即回到可明文状态，见 GAP-6）；**去重/增量**——我们每次云备份传整 ZIP，restic 只传新块，10GB 库日备份的流量差两个数量级；仓库巡检（我们无 `check` 等价物，坏对象要等恢复时才发现）。
- 我们更强：记录级多设备合并（restic 是单向备份，无冲突概念）；恢复 UX（A/B 槽 + 自动重启预告 vs 手动 restore 到目录）；面向终端用户的错误文案。

### 2.5 rclone

70+ provider 的传输瑞士军刀：crypt 后端（文件名+内容加密）、每 provider 的**字符 encoding 层**（自动把目标端非法字符映射成安全码点再还原）、分页列表正确处理、重试/限速成熟、bisync 双向同步（冲突双保留改名）。

- 已达：列表分页正确性（我们 S3 token 死循环防护、WebDAV 启发式在 provider 抽象层做到了同等诚实）；重试退避（webdav.rs 423/429/5xx + Retry-After 封顶）。
- 未达：**跨平台文件名 encoding 层是该维度事实 SOTA**——我们完全没有等价物（R07-asset-names 的验收标准应向它看齐：可逆映射，而不是有损净化）；crypt 文件名加密（我们清单虽加密，资产对象 key 虽是哈希，但 ZIP 备份的 `backups/<version>.zip` 命名暴露设备短 ID 与时间）；provider 广度。
- 我们更强：应用级语义（rclone bisync 无结构化合并、无隔离区，中断后需 `--resync` 人工介入）；E2EE 密码一致性校验（rclone crypt 配错密码会静默产出第二套密文树）；换机语义（rclone 是工具不是产品，无恢复编排）。

### 2.6 Nextcloud

自托管文件云：ETag 增量同步、冲突文件、服务端版本历史+回收站、客户端持续自动同步；服务端 4.x 起强化非法文件名治理（Windows 兼容名检测/改名）；E2EE 插件长期口碑不佳（folder 级、恢复脆弱）。

- 已达：E2EE 实用性（Nextcloud E2EE 插件的错密码/丢 key 恢复故事比我们弱，我们 ZIP+记录级文本面的密码校验子模型更稳）；冲突保留。
- 未达：**版本历史+回收站**（服务端任意文件时点回退，我们记录级同步无时点恢复，只有 ZIP 10 版整机粒度）；**自动同步**；**非法文件名治理**（服务端+客户端双侧检测改名）。
- 我们更强：不依赖自建服务端（我们对任意 dumb storage 工作，Nextcloud 需要维护一台服务器——这是产品定位差异也是真实优势）；列表截断（Nextcloud 客户端信任自家服务端，遇残缺 PROPFIND 网关同样会误判，我们启发式+硬失败在敌意 provider 假设下更稳）。

### 2.7 Seafile

库级同步：CDC 分块去重、库历史快照可回溯、加密库（客户端加密文件内容，**文件/目录名服务端可见**，密码有 magic 校验、错密码开库即拒）、冲突文件 `name (SFConflict ...)`、持续自动同步。

- 已达：错密码 fail-fast（其 magic 校验 ≈ 我们校验子）；E2EE 元数据泄露面——互有攻防：Seafile 暴露全部文件名，我们记录级清单加密但资产清单 key（含明文相对路径）在启用加密时也加密（`download_assets_manifest` 走 `decode_payload`），文件名泄露面反而更小；对象内容我们明文、Seafile 加密——内容维度未达（并入 GAP-1）。
- 未达：**分块去重+库历史**（时点回溯任意文件）；**自动同步**。
- 我们更强：任意 provider（Seafile 绑定自家服务端）；结构化记录合并；换机 A/B 槽。

### 2.8 Dropbox

商业标杆：持续同步、块级增量、"conflicted copy" 冲突副本心智被全行业借鉴、30–180 天版本历史 + Rewind 整账户时点回退、非法文件名居中提示、无用户持钥 E2EE（团队版另说）。

- 已达：冲突不丢数据（conflicted copy ≈ 我们冲突副本/冲突表）；传输可靠性（我们重试/校验和链路达标）。
- 未达：**自动同步**；**版本历史/Rewind**（整账户时点回退是换机之外的第二张安全网，我们没有）；文件名问题的用户提示闭环（它有专门的"文件未同步"面板；我们失败只进 `download_failures` 日志与审计，UI 无专项清单）。
- 我们更强：**E2EE**（Dropbox 服务端可读内容，我们文本面用户持钥加密）；数据主权（自选 provider）；列表截断防线在敌意 provider 下的稳健性（Dropbox 信任自家 API）。

### 2.9 OneDrive

与 Dropbox 同档：持续同步、版本历史、Files On-Demand、Office 协同实时合并、严格的非法字符/保留名拦截（上传前改名提示）、Personal Vault（非用户持钥）。

- 已达：冲突（"保留两者"心智等价）；恢复（版本历史 vs 我们 ZIP 版本，粒度互有胜负——它按文件、我们按整机）。
- 未达：**自动同步**；**非法文件名前置拦截**（OneDrive 在写入前就拒绝并引导改名，我们要等下载失败才知道）；Office 级实时协同合并（超出我们产品定位，不追）。
- 我们更强：**E2EE**（用户持钥 vs 微软持钥）；换机语义完整性（A/B 槽 + device_id 轮换处理了"恢复到过去时间点后同步身份悖论"，OneDrive 没有对应问题域但也没有对应能力）。

### 2.10 Standard Notes

E2EE 绝对主义标杆：XChaCha20-Poly1305 + Argon2id、所有内容含附件永远加密、无明文模式、冲突以"复制成两份"策略保证零丢失、按变更即时自动同步、登录即全量恢复、密钥轮换有版本化协议。

- 已达：加密算法档次（AES-256-GCM + Argon2id 同代）；冲突零丢失；错密码不可能污染（其认证密钥派生使错密码根本无法通过服务端认证——我们 ZIP 校验子达到同等效果，记录级见 GAP-4）。
- 未达：**E2EE 无例外覆盖**（附件也加密，我们文件级明文）；**自动同步**（变更即推）；密钥轮换协议（我们换密码 = 换云端根目录重传，无原地轮换）。
- 我们更强：自托管任意 provider（SN 自托管需跑其服务端）；结构化多库同步（SN 数据模型单一）；本地整机备份/恢复纵深（A/B 槽、分层导出、DSBK 便携包）。

### 2.11 对照矩阵（速览）

| 维度 | 我们（@871528a3） | 最强对照 | 判定 |
|---|---|---|---|
| E2EE 覆盖 | 文本面全加密+校验子；文件级明文（UI 已诚实） | restic / Standard Notes（无例外全覆盖） | **未达**（GAP-1） |
| 多设备冲突 | 记录级双侧保留+隔离区+单侧可解；文件级乐观并发+冲突副本 | Standard Notes / Dropbox | **已达**，结构化合并维度**更强** |
| 列表截断 | trait 级 truncated 契约，S3/FTP/WebDAV 全部 fail-closed | rclone | **已达**，敌意 provider 假设下**更强** |
| 错密码 | ZIP 路径上传前校验子 fail-fast；下载显式失败 | restic / Seafile | ZIP 面**已达**；记录级上传**未达**（GAP-4） |
| 跨平台文件名 | 无检测、无归一、无前置拦截 | rclone encoding 层 / OneDrive 前置拦截 | **未达**（GAP-3） |
| 自动同步 | 无（本地自动备份不接云） | Syncthing / Standard Notes | **未达**（GAP-2） |
| 换机恢复 | 下载→校验→解密→A/B 槽→重启→device_id 轮换 | AnkiWeb（顺滑度）/ restic（可靠性） | **已达**，恢复后同步身份处理**更强**；Android 面未实测（GAP-5） |

## 3. 本轮剩余缺口（按优先级）

| ID | 级别 | 缺口 | 对照锚点 | 归属 |
|---|---|---|---|---|
| GAP-1 | P0 | 文件级对象（`sync_vfs_blobs` L9919、workspace db L9552、资产对象 L10246）在有 `.encryption-marker` 时仍 `put_file` 明文。要求：加密包装（密文/明文双 hash 可分离，勿破坏内容寻址）或拒传+诚实文案 | restic / SN 全覆盖；Seafile 内容加密 | R07-asset-e2ee（在飞） |
| GAP-2 | P0 | 无自动同步。最小生产路径：默认关、可选启动后/定时触发、未配置云端绝不后台打 provider、幂等（复用 `DataGovernanceOperationGuard` 防并发）、状态进 `syncStatusStore` | 十家全部具备；Joplin 定时档最贴近我们形态 | R07-autosync（在飞） |
| GAP-3 | P1 | 资产文件名跨平台：Win 非法字符/保留名、大小写折叠冲突、NFC/NFD 归一。验收标准向 rclone encoding 层看齐（可逆映射优先于有损净化）；至少要做 OneDrive 式前置检测+UI 可见的"未同步文件清单" | rclone / OneDrive / Syncthing | R07-asset-names（待派） |
| GAP-4 | P1 | **本轮新确认**：记录级上传走 `enforce_encryption_policy_before_upload(bool)`（`commands_sync.rs` L53–62），不校验密码校验子。场景：root 只有 ZIP 加密备份+标记、尚无记录级密文时，B 设备配错密码可向同一 root 写入另一套密文的 changes/manifests，A 设备下载即报"密码错误或数据损坏"，记录级同步链被污染。修法：该路径改走带密码的校验子入口（密码原文在 `commands_sync.rs` 侧可得，`with_encryption` 已接收） | restic 开仓校验 / SN 认证派生 / 我们自己的 ZIP 路径 | 建议并入 R08（或 R07-asset-e2ee 顺手，需 FIX-QUEUE 登记 `commands_sync.rs`） |
| GAP-5 | P1 | Android 换机/重启语义未实测（`mobile-slim` 只有 WebDAV；配置→同步→恢复→`app.restart()` 闭环无测试） | AnkiWeb 移动端换机是学习类标杆 | R07-android（在飞） |
| GAP-6 | P2 | `.encryption-marker` 本身是明文可删对象：能删 root 的攻击者/误操作者删标记后，明文上传闸门消失（校验子防线同时失效）。restic 不存在此攻击面（无明文模式）。缓解：本地也持久化"该 root 曾加密"位，与云端标记双源判定 | restic | R08 候选 |
| GAP-7 | P2 | 云备份无增量/去重：每次传整 ZIP，O(数据集) 流量与时长。restic/Seafile/Dropbox 均块级。架构级改动，不建议本轮做，但应进长期路线图（或文档明示"大库用户调低备份频率"） | restic / Seafile | 路线图 |
| GAP-8 | P2 | 记录级同步无时点恢复：ZIP 10 版是整机粒度，单条记录被错误合并后无法回退（冲突表可救双方冲突场景，救不了"策略选错整批覆盖"）。Dropbox Rewind / Nextcloud 版本历史为对照 | Dropbox / Nextcloud | R08 候选（最小版：resolve 前自动快照 change_log 基线） |
| GAP-9 | P2 | WebDAV 截断启发式（750/751/1000/1001）对未知边界截断的服务端仍会静默漏列。已是无分页协议下的诚实极限；可补充：同一目录连续两次 PROPFIND 计数比对（廉价二次确认） | rclone（各 provider 原生分页） | 可选 |

## 4. 明确不建议追赶的方向

- **实时协作/OT/CRDT**（Office/Notion 式）：README 定位是 backup-style 同步，R01 起历轮均确认不做。
- **provider 广度竞赛**（rclone 70+）：WebDAV/S3/FTP 已覆盖自托管主流；Android 补 S3 feature 比加新 provider 更有价值。
- **服务端组件**（Nextcloud/Seafile 式）：dumb-storage 假设是我们的部署优势，也是列表截断等防损投资的意义所在。

## 5. 与 R07 在飞任务的关系

本文档 GAP-1/2/3/5 与 ROUND-07 已派出的 asset-e2ee / autosync / asset-names / android 四路一致，不重复认领；GAP-4（记录级错密码）与 GAP-6（标记可删）为本轮对照新增发现，建议 R07-review 合并进 FINDINGS-R07 供 R08 排期。
