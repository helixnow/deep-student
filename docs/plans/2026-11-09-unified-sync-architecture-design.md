# Deep Student 局域网与网盘跨版本、跨端、跨插件统一数据同步架构设计（Sync V5 基石规范 · Rev 3.0 零歧义定稿版）

- **文档状态**：Architecture Cornerstone Specification · **Revision 3.0（经 GPT-6.1 Sol / DeepSeek V4.1 / Gemini 4 Argon 两轮独立盲审、二阶漏洞深挖与字节级协议定稿）**
- **日期**：2026-11-09
- **适用范围**：`host/plugins/sync` (L20)、`host/plugins/sync-support` (L20b)、`host/plugins/backup` (L21)、`host/plugins/sync-providers` (L23)、`host/platform/secrets`、`host/plugins/plugin-workshop`、`host/plugins/notes`、`mobile/src/worker`、`src/features/settings`、`src/components/crepe`
- **基线版本**：`v0.20.0` (`main @ 2d9f81502`)

---

## 1. 背景、核心命题、设计红线与威胁模型

### 1.1 为什么数据同步是 Deep Student 的架构灵魂与最高复杂度点？

Deep Student 坚持 **Local-First（本地优先、离线全功能可用、零中心服务器强制依赖、用户数据主权归己）** 的多端架构（macOS / Windows / Linux 桌面端 + iOS / Android 移动端 + 可选无头守护端）。在这一前提下，用户的数据流转必须同时跨越四个正交的不确定性维度：

1. **跨传输介质（LAN + Dumb Cloud Drives）**：用户在校园网/家庭 Wi-Fi 下期望局域网毫秒级直连同步百兆 PDF 与原图；离开局域网后，又依赖 WebDAV（如坚果云、Nextcloud）、S3（Cloudflare R2、MinIO、OSS）或 FTP 等**无计算能力、无原生条件写（CAS）、目录列举截断（`MAX_DIRS = 200` 且单目录 `750/1000` 条目即判截断）并存在严格请求配额限制（坚果云 540 次请求 / 30 分钟）的「哑存储（Dumb Storage）」**异步接力。
2. **跨客户端版本（Cross-Version Forward/Backward Compatibility）**：iOS App Store 审核延迟、测试版与稳定版混用、旧电脑未及时升级是常态。例如桌面端已升至 `v0.22`（新增了业务表与字段），手机端仍停留在 `v0.20`。手机端同步时**既不能因 `SchemaMismatch` 锁死同步，更不能在编辑旧字段回传时把桌面端写入的新字段、新字段时间戳或新表抹除**。
3. **跨异构终端（Cross-Endpoint Desktop vs. Mobile OPFS）**：桌面端拥有充裕磁盘、Node.js 原生 IO 与完整子进程工具链（PDFium、FFmpeg）；移动端运行在受限的 WebKit/Chromium 单线程 Worker 与 OPFS（Origin Private File System，`opfs-sahpool` 固定 `POOL_CAPACITY = 32`）及严苛的 iOS WebContent Jetsam 内存上限下，面临后台挂起导致事务丢失、移动蜂窝流量昂贵、无法加载原生二进制（`.node`/`.dylib`）等硬约束。
4. **跨插件与技能生态（Cross-Plugin & Workshop Isolation）**：用户通过 `dstu-workshop` 或社区安装了各类插件与技能。不同设备的插件安装集、版本、平台支持能力不同；插件产生的业务数据、配置与自定义 Markdown 块（Block）必须在未安装该插件的设备上**无损落盘、透传同步、经受 Milkdown/ProseMirror 往返序列化而不丢失字节、安全降级渲染，且严禁跨设备自动传播未授权的代码执行信任**。

### 1.2 现有代码基线盘点（已核实源码位置与真实缺陷）

基于对主线 `host/plugins/sync/`、`host/plugins/sync-providers/`、`host/platform/secrets/`、`mobile/src/worker/` 及独立交叉审读报告 `docs/dev/electron-migration/audits/R4-review-sync.md` 的代码级核查，当前同步引擎的真实状态与结构性缺口如下：

| 模块与能力 | 现有实现位置（已核实） | 结构性瓶颈与生产级风险（经两轮三模型代码级交叉核实） |
|---|---|---|
| **混合逻辑时钟 (HLC)** | `host/plugins/sync/src/hlc.ts:5-35` (`Hlc.parse`, `MAX_DRIFT_MS = 60_000`) | 1. 源码注释 `This is a legacy parser, not a writable clock`；<br>2. `hlc.ts:20-35` 解析允许 64-bit `millis`，但 `toU64()` 执行 `(this.millis << 16n)` 仅容纳 48-bit `millis`（`new Hlc(1n << 48n, 0).toU64() === 0n` 发生高位截断归零）。 |
| **变更采集与行/列合并** | `host/plugins/sync/src/field-merge.ts`, `repository/apply-record.ts:443-480, 779-805`, `record-data.ts:149-151, 209-250` | 1. `record-data.ts:209-250` 在上传封包时按历史日志 ID 读取**当前表中的最新行值**而非触发时刻冻结值；<br>2. `apply-record.ts:779-804` 先做**整行新鲜度早退**再 UPSERT 整行，且 line 805 在 upsert 后直接抹除 `__sync_delete_versions`，缺少跨 `Delete -> Reinsert` 的行代际（`floor_deleted_hlc`）保护；<br>3. `record-data.ts:149-151` 虽已回拼 `readUnknownFields`，但未保留未知列的**原始字段级 HLC**，旧端编辑已知列会把暂存的旧未知列时间戳抬高为当前行的新时间戳，导致覆盖新端随后将该未知列置 `null` 的操作（**僵尸复活漏洞**）。 |
| **跨版本 Schema 与外键** | `host/plugins/sync/src/unknown-fields.ts`, `manifest-upload.ts:55`, `repository/apply-fk.ts:62-67` | 1. `manifest-upload.ts:55` 遇 `state.schema_version > version` 直接抛 `SchemaMismatchError`；<br>2. 缺少未知表操作日志金库与外键乱序孤儿池；<br>3. `apply-fk.ts:62-67` 中外键检查查询异常被 `catch { continue }` 静默吞掉；<br>4. 复合主键解析 `sqlite-values.ts:351-385` 仍使用原生 `JSON.parse`，超安全整数会丢失精度。 |
| **密钥派生、加密容器与发布** | `host/platform/secrets/backup-crypto.ts:46-48, 456`, `dsbk-stream.ts:1-13`, `marker.ts:12-19`, `verified_publish.ts:150-178` | 1. **KDF 算力雪崩**：`backup-crypto.ts:456` 仅当 `salt` 相同时复用会话密钥，跨设备或新 salt 对象每个都要跑一次完整 `Argon2id (64MiB, t=3, p=4)`；<br>2. **旧端重写 `.encryption-marker` 抹除扩展字段**：`sync_manager.rs:980-986` / `marker.ts:12` 仅含 4 个固定字段，旧客户端执行 claim 重建会抹掉新增字段；<br>3. **4 倍流量放大与悬空删除**：`verified_publish.ts` 每个对象执行 7 次请求、4 倍流量；且 `sync_manager.ts:658-664` 在 `final PUT` 已成功但回读网络超时（`CommitUnknown`）时会误删远端已发布对象。 |
| **网盘配额与目录截断** | `host/plugins/sync-providers/src/webdav-rules.ts:10-11, 45-47, 121-133`, `webdav.ts:336-349, 710-743`, `ftp.ts:647-666` | 1. 坚果云真实配额为 **540 请求 / 30 分钟**；<br>2. `webdav.ts:710` 限制 `MAX_DIRS = 200`，且 `:336-349` 单目录 `750/1000` 个响应即判 `isSuspiciousResponseCount` 截断并 fail-closed 中止；<br>3. `CloudStorage` 缺少 `getRange(key, offset, len)` 原语，且 `ftp.ts:647` 每次 `put` 均新建连接。 |
| **移动端运行时与笔记/插件** | `mobile/src/worker/sqlite-runtime.ts:38`, `transaction-recovery.ts:36`, `host/plugins/notes/src/structure.ts:123-150`, `widgetLocalState.ts:222` | 1. `sqlite-runtime.ts:38` `opfs-sahpool` 硬上限 `POOL_CAPACITY = 32`；<br>2. `apply-batch.ts:91` 单外层大事务包裹全部变更，阻塞单线程 Worker 易触发 `HostWorkerSupervisor` 8 秒超时强杀；<br>3. 笔记存于 `resources.data`（带 `<!-- ds:block-id=... -->` 根注释的 Markdown），Milkdown/ProseMirror 往返会擦除未注册 AST 节点，普通代码块若含 ` ``` ` 会发生围栏逃逸；<br>4. `widgetLocalState.ts` 仅存于 `localStorage`，且 `mobile/` 未监听 `visibilitychange` 紧急刷盘。 |

### 1.3 架构不可违背的七条铁律（Invariants）

1. **Invariant 1（零静默丢数、原始版本保真与因果序保持）**：任何版本差异、插件缺失、外键乱序或并发文本冲突，严禁静默丢弃任意字节。远端记录的 `col_hlc` **永远原样落库**（严禁在接收端改写远端记录的存储时间戳）；若某条远端记录因时钟严重超前暂不物化，必须整条隔离进 `deferred_skew` 待时钟追平后物化；一旦物化暴露给用户，本机 `HlcClock` 必须完整吸收该 `remote.hlc`，保证用户随后的修改满足严格因果律 $T_{\text{new}} > T_{\text{observed}}$。
2. **Invariant 2（传输层与状态层正交 + 多化身历史分叉可检测）**：局域网直连（LAN P2P）、中继隧道（E2EE Relay）与网盘（WebDAV/S3/FTP）交换完全相同的不可变加密日志段（`Segment`）与内容寻址分块（`Chunk`）。写入者身份由 **`writer_key = (device_id, incarnation_id)`** 二元组唯一界定；全局 `VersionVector` 按 `writer_key` 索引，当设备从旧备份恢复或克隆重置时必须生成新 `incarnation_id`，严禁在同一 `writer_key` 下对相同 `seq` 发布不同内容（违反即触发 `HistoryForkError`）。
3. **Invariant 3（稳态同步零目录列举、两级索引与 `CommitUnknown` 保全）**：网盘同步常规读写路径**严禁依赖 `PROPFIND`/`LIST` 扫描目录**，一律通过 `repo-head.json` -> `manifests/<device_id>.json` -> `indices/<device_id>/{base,delta}.dsix` 显式寻址。所有物理存储目录均做 16 分片（`<hex1>/`，每子目录对象数严格 `< 500`，避开 WebDAV `750` 条目截断线）。当发布处于 `CommitUnknown` 时，**严禁在异常处理中主动 `DELETE` 可能已被引用的数据对象**。
4. **Invariant 4（独立 `.keyring` 三层信封、双轴密钥轮换、长度前缀 AAD 与仓库级防回滚）**：Sync V5 密钥封套独立存储于 `sync-v2/.keyring`（绝不与旧版 `.encryption-marker` 混写）。采用**内容寻址密钥 (`k_cid`) 与数据加密主密钥 (`MK_e`) 双轴分离设计**：密码修改仅重包 keyslot（$O(1)$），设备吊销轮换 `MK_{e+1}` 而不改变 `chunk_id`（零重传跨代去重）。所有 HKDF `info`、AEAD `AAD` 与 Ed25519 签名载荷一律采用 `lp(x) = u16be(len) || x` 无歧义长度前缀编码；通过 owner 签名的 `sync-v2/repo-head.json` 与 `DSPAIR2` 带外锚点彻底消除新设备首次同步的 TOFU 回滚风险。
5. **Invariant 5（大整数与无损 JSON 全链路保真）**：从 SQLite 读取、复合主键解析（修复 `sqlite-values.ts:351`）、`merge.ts` 序列化到网络封包，全链路强制使用 `lossless-json.ts`（`parseJsonLossless` / `stringifyJsonLossless`），64 位序列号（限定 `0 .. 2^63 - 1`）、HLC 时间戳与雪花 ID 严禁经由 JS `Number` 发生 `> 2^53 - 1` 精度截断。
6. **Invariant 6（接收去重与物化状态分离 + 根实体闭包微批次原子提交）**：去重账本 `__sync_applied_ops` 显式区分 `received_at`（更新 Log Merkle）与 `materialization_state`（`'materialized' | 'pending_schema' | 'pending_fk' | 'deferred_skew'`），确保金库与孤儿池重放时既不重复计入 Merkle 树、又不被去重表误拦截。微批次重放按**根实体闭包（Root Entity Closure）**切分，且每微批次在自身事务内即时查询 `pendingLocalKeys` 与 `preLogMax`，严禁跨批次缓存快照。
7. **Invariant 7（SQLite WAL 先行落盘 + 原地日志合并 + 插件单行转义栅栏）**：本地插件与画板写入必须立即落入 SQLite WAL（`< 1ms`），严禁将未持久化数据滞留在纯内存防抖定时器中；通过触发器对 `__change_log` 中 `sync_version = 0` 的未发布同行记录做原地 `UPDATE` 合并来抑制写放大。笔记中的插件块强制使用**单行 Canonical JSON + `\u0060` 反引号转义**的标准围栏代码块，从数学上杜绝围栏逃逸。

### 1.4 威胁模型与安全边界声明（Threat Model）

| 威胁主体 / 故障源 | 攻击或故障能力 | Sync V5 防御原语 | 检测与恢复行为 |
|---|---|---|---|
| **被动窥探者**（网盘厂商、公共 Wi-Fi、中继节点） | 读取全部云端文件内容、文件名、目录结构与传输字节流 | **`sync-v2/.keyring` 三层信封** + **密钥化块标识 `chunk_id = HMAC-SHA256(k_cid, plaintext)`** + 定长 `64 KiB` 分帧 AEAD | 对象键名不含明文 SHA-256，外部无法通过公开教材/题库哈希表离线比对用户拥有哪些学习资料（消除指纹泄露）。 |
| **主动篡改者 / 损坏的网盘网关** | 互换两个 Packfile 内的分块、跨设备嫁接段、截断文件尾部、利用字段拼接歧义伪造 AAD | **全链路 `lp(x)` 长度前缀 AAD 绑定** + **读取器 7 条完整性铁律（`T1~T7`）** + **解密后重算 `HMAC(k_cid, plain) == chunk_id`** | 任何块替换、跨设备段嫁接、尾部帧截断（未见 `is_final=1`）均触发 `AEAD Tag Mismatch` 或 `TruncatedStreamError` 立即拒绝。 |
| **状态回滚者（含针对新装设备的全仓回滚）** | 向已有设备或刚配对的新设备返回 30 天前的旧 `manifest.json`、旧 `.dsix` 或旧 `.keyring` | **本地单调水位表 `__sync_remote_watermarks`** + **Owner 签名的 `sync-v2/repo-head.json`** + **`DSPAIR2` 二维码带外传递 `(repo_id, repo_head_gen, repo_head_sha256, owner_pubkey)`** | 已有设备靠本地高水位拦截，新装设备靠 `DSPAIR2` 带外锚点直接校验 `repo-head.json` 最新世代，**实现零 TOFU 防回滚**。 |
| **旧版本客户端误写密钥文件** | 仍运行 `v0.20` 的设备对 `.encryption-marker` 执行整文件重建（`sync_manager.rs:980-986`） | **物理路径隔离**：旧版 `.encryption-marker` 保持 v2 格式不变；Sync V5 密钥环独立存于 `sync-v2/.keyring` | `v0.20` 客户端不触碰 `sync-v2/.keyring`，彻底杜绝旧端抹除 `wrappedMasterKey` 与 keyring。 |

---

## 2. 行业生产级实现对齐矩阵（Rev 3.0 定稿版）

| 核心子系统 | 对齐的行业生产实现 | 采纳的生产级原语与工程参数 | 针对 Deep Student 场景的二阶加固（Rev 3.0） |
|---|---|---|---|
| **双轴密钥环与定长分帧加密** | **Kopia Keyring** & **Age STREAM / TLS 1.3 Record** | `sync-v2/.keyring` 多 keyslot + `k_cid`（内容 ID 密钥）与 `MK_e`（纪元加密密钥）分离；`64B Header + N × 65552B Frame` | 改密码只换 slot（$O(1)$），吊销设备升 `MK_{e+1}` 但 `k_cid` 不变（跨纪元零重传去重）；Pack 内使用 `u32be(entry_idx) \|\| u64be(frame_idx)` 派生唯一 Nonce，偏移量具备闭式解。 |
| **因果时钟与分段对账** | **CockroachDB HLC** & **Actual Budget Merkle** | 48-bit HLC + **不改写远端 `col_hlc` 的因果隔离策略** + **段级/区间级二叉-三叉 Merkle Tree (`__sync_applied_ranges`)** | 彻底修复 `receive()` 钳制落库导致的因果倒置（`P0-S02`）与跨设备 `col_hlc` 分裂（`P0-9`）；支持 Checkpoint 压缩后用 `range_leaf` 替代区间叶子，消除 Merkle 断裂。 |
| **列级生命周期与分数阶排序** | **Vlcn (`cr-sqlite`)** & **Rocicorp (`fractional-indexing`)** | 行级 `floor_deleted_hlc` 墓碑水位 + 逐列 `(col_hlc, col_dev)` 寄存器 + **纯 Base-62 分数阶索引 + tie-group 内分裂协议** | 解决 `Delete -> Reinsert` 后旧列复活及存量无版本行（默认 `col_hlc = row.updated_at ?? "000000000000000-00000"`）问题；尾追加 $O(\log_{62} N)$。 |
| **两级索引链 `.dsix` 与配额引擎** | **Kopia Index Compaction** + **Syncthing BEP (`index_id + seq`)** | 每设备 `1 base + <= 8 delta` 二进制分片索引（104B/条目）+ `supersedes[]` 显式回收 + `packs/<dev>/<hex1>/` 16 分片目录 | 彻底解决「全量索引重传太重 vs 增量索引 1000 次 GET 打爆坚果云配额」的二难问题（`P0-4`），且所有目录条目数恒 `< 500`，永不触发 WebDAV `750` 截断。 |
| **设备日志折叠检查点与安全 GC** | **Kopia Epoch GC** & **Join-Semilattice Log Folding** | `.dschkpt` 严格定义为**单写入者 `(device, incarnation)` 在 `[from_seq, upto_seq]` 的逐列日志折叠投影** + 发布前 `pending/<dev>/<attempt>.json` 引用保护 | 修复检查点混入他端数据（`P0-5`）与发布后 `stat` 的 TOCTOU 竞态（`P0-S06`）：GC 扫描 `manifests ∪ pending_uploads`，只要引用已在 `pending` 登记即受保护。 |
| **根实体微批次与单行转义插件栅栏** | **Linear Sync Engine** / **Obsidian Mobile** & **CommonMark §4.5** | **按根实体闭包（Root Entity Closure）切分微批次** + SQLite WAL 先行落盘 + `__change_log` 未发布行原地合并 + **`\u0060` 单行 Canonical JSON 代码块** | 彻底解决微批次切碎父子表导致的「半截笔记脏读」、间隙本地写被误杀为回声、移动端锁屏丢 2s 内存防抖数据，以及插件块内含 ```` ``` ```` 引发的围栏逃逸。 |

---

## 3. 总体分层架构与双轨同步模型（LAN + Cloud Unified Engine）

### 3.1 五层正交架构图

```text
+-----------------------------------------------------------------------------------+
| Layer 5: 业务与插件消费层 (Domain & Plugin Consumers)                             |
| - 核心库表 + widgetLocalState (主键: owner_id, source_hash, widget_id + 切后台刷盘)|
| - 受管插件存储 (__plugin_sync_records: WAL 立即落盘 + __change_log 原地合并)      |
| - 单行 Canonical JSON (\u0060 转义) 插件围栏代码块 + <UnsupportedPluginBlockCard/>|
| - 移动端 VFS Virtual Stub 按需水化器 (256MiB OPFS Arena L1 + 1GiB IDB L2 缓存)    |
+-----------------------------------------------------------------------------------+
                                         |
+-----------------------------------------------------------------------------------+
| Layer 4: 跨版本演进与列级生命周期合并层 (Schema Evolution & Column-CRDT Layer)    |
| - 三水位门控 (writer / min_reader / min_writer) + repo-head.json 特性门控         |
| - 三级金库: __sync_unknown_fields(含原 col_hlc) + __sync_unknown_op_log           |
|             + __sync_deferred_orphans (按 op_id 追加保存 + 别名重写 + 16次死信)   |
| - 行级 floor_deleted_hlc 生命周期屏障 + 逐列 (col_hlc, dev) 合并 + Base-62 排序   |
+-----------------------------------------------------------------------------------+
                                         |
+-----------------------------------------------------------------------------------+
| Layer 3: 因果时钟、多化身向量与根实体微批次层 (Causal Clock & Entity Micro-Batch) |
| - 写入者身份 writer_key = (device_id, incarnation_id) + 迁移生成静态捕获触发器    |
| - 48-bit HLC (远端原值落库，<=60s 完整吸收，>60s 整段进 deferred_skew 保全因果)   |
| - 状态分离账本 __sync_applied_ops (received vs materialization_state)             |
| - 根实体闭包微批次 (Root Entity Closure, 逐批即时查 pendingLocalKeys & preLogMax) |
+-----------------------------------------------------------------------------------+
                                         |
+-----------------------------------------------------------------------------------+
| Layer 2: 双轴密钥环、定长 64KiB 帧与两级索引层 (Keyring, Frame & Index Layer)     |
| - sync-v2/.keyring (多 keyslot + 稳定 k_cid + 按纪元 MK_e) + repo-head.json 签名  |
| - 64B 固定对象头 + 65552B 定长 AEAD 帧 (Pack 派生 Nonce + lp(x) 长度前缀 AAD)     |
| - 两级二进制分片索引 .dsix (1 base + <=8 delta, 104B/entry, supersedes[] 回收)    |
+-----------------------------------------------------------------------------------+
                                         |
+----------------------------------------+------------------------------------------+
| Layer 1A: 网盘异步传输适配器 (L23)     | Layer 1B: 局域网与多实例实时通道         |
| - WebDAV (540 req/30min 窗口 + 16分片) | - mDNS + OpenChamber Candidate Refresh   |
| - S3 / R2 / MinIO (原生 Checksum/Range)| - 局域网直连 WS / E2EE Relay 段与块直传  |
| - FTP (连接池 + REST 偏移流式读取)     | - Pre-Mount Drain (仅排空 .dsseg + 1.5s) |
+----------------------------------------+------------------------------------------+
```

### 3.2 多化身版本向量 `VersionVector`、迁移静态触发器与双轨无缝接力

1. **迁移期静态生成触发器与不可变事件冻结（修复 `P1-S01`）**：
   - 修复现有 `record-data.ts:209-250` 在上传时回查当前表最新行值的缺陷，同时适应 SQLite 触发器不支持动态枚举 `NEW.*` 的限制：
   - 在每次执行 DDL 数据库迁移时，由表 Schema 注册表（`syncClassificationRegistry`）在迁移事务内**自动 DROP 并重新生成静态列级触发器**（并在 `sync_state` 中记录 `capture_schema_hash`，开放写连接前强校验触发器哈希与表结构一致）：
     - `INSERT` 触发器：用 `json_object('col1', NEW."col1", ...)` 冻结完整初始行（大整数转字符串、BLOB 转 base64 标记对象）；
     - `UPDATE` 触发器：通过 `CASE WHEN OLD."c" IS NOT NEW."c" THEN ...` 精确记录本次真正发生变化的列集合 `changed_columns_json` 及新值快照；
     - **原地合并未发布变更（In-Table Coalescing）**：若 `__change_log` 中已存在同一 `(table_name, record_id)` 且 `sync_version = 0`（尚未被封包入 `.dsseg`）的记录，触发器直接将该行的新变更列合并入既有未发布行并更新 `changed_at`，既保证 100% 捕获修改时刻的不可变值，又防止高频局部修改刷爆日志表。
2. **多化身版本向量（Multi-Incarnation Version Vector，修复 `P1-S02`）**：
   - 写入者唯一键定义为 `writer_key = "${device_id}@${incarnation_id}"`（其中 `seq` 取值范围严格限定为 `0n .. (1n << 63n) - 1n` 正有符号 64 位整数，完美适配 SQLite `INTEGER`）。
   - 全局版本向量支持同一设备并存历史化身与当前化身：`VersionVector = Record<WriterKey, { contiguousSeq: bigint; headSegmentSha256: string }>`，因此当设备恢复备份轮换到 `inc_2` 时，其他设备尚未拉取完的 `inc_1` 历史段依然能按独立槽位对账，绝不发生槽位覆盖。
   - **分叉判定只认操作身份**：段边界可随重封包或合并变化，真正的 `HistoryForkError` 严格定义为：**同一 `(device_id, incarnation_id, source_seq, op_ordinal)` 出现了两个不同的规范化操作哈希 `op_hash`**。

---

## 4. 因果时钟、状态分离去重账本与列级生命周期合并引擎

### 4.1 严格保持因果律（Causality-Preserving）的可写 HLC 状态机

针对第二轮审阅中 GPT-6.1 Sol `P0-S02` 与 DeepSeek V4.1 `P0-9` 同时证明的 **「若 `receive()` 将远端超前 HLC 钳制（clamp）后落库或只将本地时钟推进到钳制值，会导致：(1) 同一远端操作在不同设备上落库不同的 `col_hlc` 破坏最终一致性；(2) 本地用户在看到远端记录 $v_1$ ($10:05$) 后立刻修改产生 $v_2$ ($10:01$)，因 $10:01 < 10:05$ 导致因果后继 $v_2$ 反被旧值 $v_1$ 吞噬」**，制定零因果倒置的 HLC 规则：

1. **铁律 A：远端操作携带的 `changed_at` / `col_hlc` 永远原封不动落库，严禁任何接收端改写远端操作的时间戳！**
2. **铁律 B：接收远端段时的两级时钟偏差处置（吸收 vs. 延迟物化隔离）**：
   - 设本机当前物理时间为 $T_{\text{wall}}$，容忍漂移上限 `MAX_DRIFT_MS = 60_000n`（60 秒）：
   - **情况 1（正常或轻度超前：$T_{\text{remote}} \le T_{\text{wall}} + 60\text{s}$）**：
     - 立即物化应用该段记录；
     - **本机 `HlcClock` 必须完整吸收原始 $T_{\text{remote}}$**（即 `this.lastMillis = max(T_wall, this.lastMillis, T_remote.millis)`），确保本机随后发生的任何用户编辑通过 `tick()` 生成的 $T_{\text{new}}$ **严格大于 $T_{\text{remote}}$**，100% 满足 `v1 happens-before v2 => HLC(v1) < HLC(v2)`！
   - **情况 2（严重超前异常：$T_{\text{remote}} > T_{\text{wall}} + 60\text{s}$）**：
     - **既不污染本机 `HlcClock`，也不向业务表物化暴露该段**！
     - 将该段标记为 `materialization_state = 'deferred_skew'` 存入本地持久收件箱 `__sync_deferred_segments`（不阻塞其他正常设备段的同步），并在 UI 顶部显示提示：「收到来自设备 X 的未来时间戳数据（可能因本机或对方系统时间不准），已安全暂存；校准系统时间或点击【强制接纳】后即可显示」。一旦物理时间追上或用户点击强制接纳，再调用 `HlcClock.receive` 完整吸收 $T_{\text{remote}}$ 并物化。
3. **铁律 C：候选值先校验后赋值**：`tick()` 与 `receive()` 先在局部变量计算 `(nextMillis, nextCounter)`，通过 `0n <= nextMillis <= (1n << 48n) - 1n` 校验后才更新 `this.lastMillis`，防止异常中断污染内存时钟。

### 4.2 接收与物化分离的去重账本 + 区间可压缩 Merkle Tree

为了解决 GPT-6.1 Sol `P0-S04`（未知表/孤儿记录一旦记入 `__sync_applied_ops`，升级后重放时会被自己的去重账本拦截跳过）与 DeepSeek V4.1 `P0-5`/`P1-1`/`P1-2`（检查点压缩后 Merkle 树断裂且去重表无限膨胀）：

```sql
-- 1. 细粒度操作去重与物化状态表（未压缩的近期窗口）
CREATE TABLE IF NOT EXISTS __sync_applied_ops (
  source_device_id TEXT NOT NULL,
  incarnation_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  op_ordinal INTEGER NOT NULL DEFAULT 0,
  op_hash BLOB NOT NULL,              -- 32-byte SHA-256
  materialization_state TEXT NOT NULL,-- 'materialized' | 'pending_schema' | 'pending_fk' | 'deferred_skew' | 'quarantined'
  received_at TEXT NOT NULL,
  PRIMARY KEY (source_device_id, incarnation_id, source_seq, op_ordinal)
);

-- 2. 已压缩区间去重与 Merkle 区间叶子表（与 Checkpoint 对齐，防止去重表无限膨胀）
CREATE TABLE IF NOT EXISTS __sync_applied_ranges (
  source_device_id TEXT NOT NULL,
  incarnation_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL,
  upto_seq INTEGER NOT NULL,
  range_leaf_hash BLOB NOT NULL,      -- 32-byte 确定性区间摘要
  checkpoint_key TEXT,
  PRIMARY KEY (source_device_id, incarnation_id, from_seq)
);
```

1. **接收与物化两阶段状态转换**：
   - 当首次从网络收到操作 `op_id = (dev, inc, seq, ord)` 时：插入 `__sync_applied_ops` 并计算进 Log Merkle。
   - 若该操作因表不存在进入 `__sync_unknown_op_log`，其状态记为 `'pending_schema'`；若因缺父记录进入 `__sync_deferred_orphans`，记为 `'pending_fk'`。
   - **当客户端升级建表或父记录到达触发 Rehydrate 重放时**：重放器允许消费 `materialization_state IN ('pending_schema', 'pending_fk', 'deferred_skew')` 的记录，物化成功后将其状态原子更新为 `'materialized'`（且不再重复计入 Log Merkle）！
2. **字节级确定的规范化哈希与区间压缩编码（修复 `P0-6` / `P1-2`）**：
   - 定义统一长度前缀编码函数：`lp(str_or_bytes) = u16be(byteLength) || bytes`。
   - 单条操作哈希：
     $$\text{op\_hash} = \text{SHA256}\left(\texttt{0x00} \parallel \text{lp(db)} \parallel \text{lp(table)} \parallel \text{lp(record\_id)} \parallel \text{u8(op)} \parallel \text{lp(hlc)} \parallel \text{lp(dev)} \parallel \text{lp(inc)} \parallel \text{u64be(seq)} \parallel \text{u32be(ord)} \parallel \text{sha256(canonical\_payload)}\right)$$
   - 当区间 `[from_seq, upto_seq]` 被压缩为检查点后，各端统一将该区间内的单条记录压缩为 1 行 `__sync_applied_ranges`，其在 Merkle 树中的叶子摘要固定为：
     $$\text{range\_leaf} = \text{SHA256}\left(\texttt{0x02} \parallel \text{lp(dev)} \parallel \text{lp(inc)} \parallel \text{u64be(from\_seq)} \parallel \text{u64be(upto\_seq)} \parallel \text{merkle\_root(ops\_in\_range)}\right)$$
   - 因此，无论是「逐段重放了 1..500 的设备 X」还是「直接拉取了 1..500 检查点的设备 Y」，只要应用了 manifest 中宣告的同一 `compactions[]` 边界，两端计算出的 Merkle Root、State Checksum 与 `vault_digest` **100% 逐字节恒等**！

### 4.3 行生命周期代际（Row Lifecycle Floor）与逐列寄存器合并代数

针对 GPT-6.1 Sol `P0-S03` 指出的 **`Delete -> Reinsert` 旧列复活、存量无版本列默认时间戳缺失**问题，定义严密的寄存器半格代数：

```sql
CREATE TABLE IF NOT EXISTS __sync_row_meta (
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  floor_deleted_hlc TEXT,             -- 该主键历史上最后一次被 Delete 的 HLC 水位（永不因普通 upsert 清零）
  floor_deleted_dev TEXT,
  col_versions_json TEXT NOT NULL,    -- { [colName]: { hlc: string, dev: string, seq: number } }
  PRIMARY KEY (table_name, record_id)
);
```

1. **存量老数据行的确定性 Bootstrap 水位**：
   - 对于升级前已存在但尚未在 `__sync_row_meta` 登记的存量行，首次参与逐列合并时，其所有非空列的初始版本确定性推导为：`bootstrap_hlc = timestampValueToLwwString(row.updated_at ?? row.created_at) ?? "000000000000000-00000"`，`bootstrap_dev = row.device_id ?? ""`。两端对同一存量行推导出的基线版本完全一致。
2. **`Delete` 与 `Insert / Update` 的跨代屏障规则**：
   - 当收到 `Delete(table, record_id, del_hlc, del_dev)` 时：
     - 若 `(del_hlc, del_dev)` 大于当前行所有列的最高 `(col_hlc, col_dev)`：从主表物理删除该行，将 `__sync_row_meta.floor_deleted_hlc` 更新为 `del_hlc`，并清空该行所有 `< del_hlc` 的 `col_versions_json` 与 `__sync_unknown_fields`。
     - 若主表存在某列的 `(col_hlc, col_dev) > (del_hlc, del_dev)`（即并发的更新晚于该次删除）：更新 `floor_deleted_hlc = max(floor_deleted_hlc, del_hlc)`，主表保留该行，但将所有 `< (del_hlc, del_dev)` 的旧列置为 schema 默认值/`NULL`。
   - 当收到 `Update` 或 `Insert`（携带逐列 `incoming.col_version[col]`）时：
     - 对每一列 `col`，首先检查 **`incoming.col_version[col] > (floor_deleted_hlc, floor_deleted_dev)`**！任何时间戳小于或等于 `floor_deleted_hlc` 的迟到旧代列修改（含旧端回拼的过时未知列）一律被 `floor_deleted_hlc` 屏障过滤丢弃，**从根本上杜绝 `Delete -> Reinsert` 后旧代字段借尸还魂**！
     - 通过屏障的列，再与当前 `local.col_version[col]` 比较 `(hlc, dev)` 全序，胜出者写入主表并更新 `col_versions_json`。
3. **标签集合与分数阶排序的确定性闭环（修复 `P1-S06`）**：
   - **标签集合统一选定 `Column-LWW Tag Map`**：每个标签的值版本为完整二元组 `(hlc: string, dev: string)`，同时间戳下按 `compareUtf8(left.dev, right.dev)` 决胜。
   - **Base-62 分数阶索引 tie-group 分裂规则**：标准编码严格对齐 `rocicorp/fractional-indexing`（整数头字符 `'a'..'z'` / `'A'..'Z'` 定长前缀 + Base-62 小数位）。当两台设备并发在同一缝隙插入产生完全相同的 `position_key = "a0V"`（通过 SQL `ORDER BY position_key COLLATE BINARY, source_device_id COLLATE BINARY, id COLLATE BINARY` 排序为 $R_1 < R_2$），若后续用户要在 $R_1$ 与 $R_2$ 之间再插入新项 $R_{\text{mid}}$，客户端在同一个本地事务内将 $R_2$ 的 `position_key` 推进为 `midpoint("a0V", nextDistinctKey)`（如 `"a0V8"`），并在 `"a0V"` 与 `"a0V8"` 之间为 $R_{\text{mid}}$ 分配 `"a0V4"`，确保任意时刻任何相邻两项之间皆可无限插入。

---

## 5. 跨版本 Schema 前后向兼容协议（Zero-Data-Loss Envelope）

### 5.1 三水位 Schema 门控与仓库级特性协商

- 在 `DatabaseSyncState` 中维护 `(schema_version, min_reader_schema_version, min_writer_schema_version, checksum, vault_digest)`。
- **跨代容器启用门控（修复 DeepSeek V4.1 `P0-2/P0-10`）**：
  - `sync-v2/` 目录树与 `sync-v2/.keyring` 与旧版 v1/v2 `manifests/` 物理并存隔离。当新版本客户端加入仓库时，先检查 `sync-v2/repo-head.json`；在用户所有活跃设备升级到支持 Sync V5 的桥接版本前，客户端可同时向下兼容旧通道，避免旧版本客户端因不认识新加密格式而报错。

### 5.2 三级未知数据保全金库（不可变操作粒度孤儿池）

针对 GPT-6.1 Sol `P0-S04` 指出 **`__sync_deferred_orphans` 若以 `(table_name, record_id)` 为主键，同一孤儿记录的连续 `Insert -> Update -> Delete` 会互相覆盖丢失中间列更新**，将孤儿池与未知表金库统一升级为**按操作唯一身份追加的有序日志表**：

```sql
-- 1. 已知表的未知列金库（带字段级原始 (hlc, dev, seq) 信封与 floor_deleted_hlc 校验）
CREATE TABLE IF NOT EXISTS __sync_unknown_fields (
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,            -- parseJsonLossless / stringifyJsonLossless 规范化主键
  fields_json TEXT NOT NULL,          -- { "new_col": { "value": ..., "hlc": "...", "dev": "...", "seq": 120 } }
  source_schema_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (table_name, record_id)
);

-- 2. 未知整表追加式操作日志金库
CREATE TABLE IF NOT EXISTS __sync_unknown_op_log (
  op_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source_device_id TEXT NOT NULL,
  incarnation_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  op_ordinal INTEGER NOT NULL DEFAULT 0,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  data_json TEXT,
  changed_at TEXT NOT NULL,
  source_schema_version INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_device_id, incarnation_id, source_seq, op_ordinal)
);

-- 3. 乱序外键孤儿追加池（按操作身份唯一定位，绝不覆盖同一记录的多步操作！）
CREATE TABLE IF NOT EXISTS __sync_deferred_orphans (
  orphan_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source_device_id TEXT NOT NULL,
  incarnation_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  op_ordinal INTEGER NOT NULL DEFAULT 0,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  change_payload_json TEXT NOT NULL,
  missing_parent_table TEXT,
  missing_parent_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'dead_letter'
  first_seen_at TEXT NOT NULL,
  last_error TEXT,
  UNIQUE (source_device_id, incarnation_id, source_seq, op_ordinal)
);
```

**业务唯一键别名（`IdAliasMap`）的全局确定性决胜规则（修复 GPT-6.1 Sol `P0-S01`）**：
- 现有 `apply-id-aliases.ts:424` 优先保留「本机已有 ID」，导致设备 A（本地 ID 为 `id_A`）与设备 B（本地 ID 为 `id_B`）离线创建相同业务唯一键（如同名文件夹或同哈希资源）时，A 将 `id_B -> id_A`、B 将 `id_A -> id_B`，两端主键永不收敛！
- **修正为与到达顺序无关的全网确定性赢家规则**：当两条不同主键 `(id_1, created_hlc_1, dev_1)` 与 `(id_2, created_hlc_2, dev_2)` 在 `business_unique_keys` 上发生冲突时，**全网所有设备一律以 `(created_hlc, dev, id)` 字典序较小（即最早创建）的一方作为唯一 Canonical ID**，另一方作为 Alias 映射并在同一事务内级联重写本机已引用该 Alias 的外键列，实现 100% 跨端收敛。

---

## 6. 双轴密钥环 `.keyring`、64 KiB 定长分帧、两级索引 `.dsix` 与网盘配额引擎

### 6.1 `sync-v2/.keyring` 双轴密钥体系（闭环密码修改、设备吊销与跨纪元去重）

针对 DeepSeek V4.1 第二轮 `P0-1`、`P0-2`、`P0-8` 提出的密钥轮换、旧客户端覆盖与备份恢复后密钥重用问题，制定完整的 `sync-v2/.keyring` 协议：

1. **物理隔离与双轴解耦（Two Orthogonal Key Axes）**：
   - 保持根目录 `.encryption-marker` 仅供旧版/v2 备份子系统使用；Sync V5 使用独立路径 **`sync-v2/.keyring`**，彻底杜绝 `v0.20` 客户端执行 claim 时抹除 v3 密钥环。
   - **轴 1：稳定内容寻址密钥 `k_cid`（`content_id_key`）**：
     $$\text{chunk\_id} = \text{HMAC-SHA256}(k_{\text{cid}}, \text{plaintext\_bytes})$$
     `k_cid` 在仓库生命周期内保持稳定（仅在用户显式执行「全仓深度重构 Reindex」时才更换）。
   - **轴 2：按纪元轮换的数据加密主密钥 `MK[content_epoch]`**：
     - **场景 A（用户修改同步密码）**：只需用新密码派生新的 `KEK_new`，重新加密 `slots` 中的 passphrase slot 并递增 `keyring.generation`（耗时 `< 100ms`，无需重加密任何 `MK` 或数据块）。
     - **场景 B（旧设备遗失 / 吊销设备授权）**：从 `slots` 中移除被吊销设备的 `device_slot`（并同时更新 passphrase slot），新增纪元 `content_epoch = e + 1` 及全新的随机 32 字节主密钥 `MK[e + 1]`，仅向当前合法的 slots 包裹分发 `MK[e + 1]`。
     - **为什么双轴分离能完美解决跨纪元去重与 GC？**
       因为 `k_cid` 未变，设备在纪元 `e + 1` 计算出的 `chunk_id` 与纪元 `e` **完全一致**，查 `.dsix` 索引即可直接命中纪元 `e` 已上传的旧 Pack（零流量去重）；读取旧 Pack 时根据索引条目记载的 `content_epoch = e` 从本地 keyring 取出历史 `MK[e]` 解密，而所有新写入的 Pack 与 Segment 均使用被吊销设备无法获知的 `MK[e + 1]` 加密！
2. **固定 64 字节对象头 + 16 字节每对象随机 Salt（彻底消灭 `P0-8` 备份恢复后密钥/Nonce 重用）**：
   - 所有 `.dspk`、`.dsseg`、`.dsix`、`.dschkpt` 均以固定 **64 字节二进制头部** 开头：
     ```text
     Offset  Size  Field
     0       4     magic: "DSPK" | "DSSG" | "DSIX" | "DSCK"
     4       1     format_version = 3 (u8)
     5       1     aead_suite = 1 (AES-256-GCM) | 2 (XChaCha20-Poly1305)
     6       2     content_epoch (u16be)
     8       16    object_salt (crypto.getRandomValues(16), 每个物理对象文件唯一！)
     24      4     frame_plain_size = 65536 (u32be)
     28      4     entry_or_frame_count (u32be)
     32      8     total_plaintext_len (u64be)
     40      8     total_ciphertext_len (u64be)
     48      16    header_mac = HMAC-SHA256(MK[content_epoch], bytes[0..48])[0..16]
     ```
   - **每对象数据加密密钥（DEK）派生公式（全部带 `lp(x)` 长度前缀与 `object_salt`）**：
     $$\text{dek} = \text{HKDF-SHA256}\left(\text{ikm} = \text{MK}[\text{content\_epoch}],\ \text{salt} = \text{object\_salt},\ \text{info} = \text{lp("ds/obj/v3")} \parallel \text{lp(magic)} \parallel \text{lp(repo\_id)} \parallel \text{lp(device\_id)} \parallel \text{lp(incarnation\_id)}\right)$$
   - 因为每次生成新文件都有全新的 128-bit `object_salt` 且绑定了 `incarnation_id`，即便设备从备份恢复后重写相同 `seq`，派生出的 `dek` 也 100% 互异，**在数学上彻底根除 AES-GCM Nonce 复用风险**！

### 6.2 64 KiB 定长分帧 AEAD 字节布局、闭式偏移公式与读取器 7 条铁律

针对 DeepSeek V4.1 `P0-3` 指出的分帧偏移量计算与截断检测问题，固定字节级规范：

1. **定长 `65,552` 字节加密帧（零逐帧 Nonce 存储开销）**：
   - 对于明文长度为 $L$ 字节的 Entry，切分为 $n = \max(1, \lceil L / 65536 \rceil)$ 个帧（序号 $i \in [0, n-1]$）：
     - 前 $n - 1$ 帧：明文固定 `65,536` 字节 + `16` 字节 GCM Tag = **定长 `65,552` 字节密文**；
     - 最后一帧（$i = n - 1$，标记 `is_final = 1`）：明文 $L - (n - 1) \times 65536$ 字节 + `16` 字节 GCM Tag；
     - 整个 Entry 的密文总长度恒为：$\text{entry\_ct\_len} = L + 16n$。
   - **确定性结构唯一 Nonce（12 字节）**：
     $$\text{nonce}_i = \text{u32be}(\text{entry\_index}) \parallel \text{u64be}(\text{frame\_index}\ i)$$
     （因 `dek` 已含 16B 随机 `object_salt` 且每 Pack 唯一，Pack 内 `(entry_index, frame_index)` 二元组严格不重复，零存储开销且 100% 安全）。
   - **逐帧无歧义长度前缀 AAD**：
     $$\text{aad}_i = \text{lp("DSFRM3")} \parallel \text{lp(magic)} \parallel \text{u16be(content\_epoch)} \parallel \text{lp(repo\_id)} \parallel \text{lp(container\_id)} \parallel \text{u32be(entry\_index)} \parallel \text{lp(chunk\_id)} \parallel \text{u64be(frame\_index\ } i\text{)} \parallel \text{u64be}(L) \parallel \text{u8(is\_final)}$$
2. **`getRange` 闭式字节偏移公式**：
   - Entry 内第 $i$ 帧的起始密文偏移：$\text{frame\_off}(i) = \text{entry\_data\_off} + i \times 65552$；
   - 读取单个 Chunk 时，只需发起 **1 次 `getRange(packKey, entry_data_off, entry_ct_len)`**（切勿按每 64 KiB 帧发起多次 HTTP 请求！），拿到字节流后在本地按 `65,552` 字节步长逐帧流式解密。
3. **读取器 7 条强制完整性铁律（`T1 ~ T7`，防尾部截断与块替换）**：
   - `T1`：`stat(pack).size === 64 + header.total_ciphertext_len + footer_len`；
   - `T2`：`header_mac` 校验必须在读取任何帧前通过；
   - `T3`（**防尾部截断**）：每个 Entry 必须恰好解出 $n = \max(1, \lceil L / 65536 \rceil)$ 帧，且第 $n - 1$ 帧必须在 `is_final == 1` 的 AAD 下认证通过；若未见到 `is_final == 1` 即到达 `entry_ct_len` 边界，立即抛 **`TruncatedStreamError`**；
   - `T4`：`is_final == 1` 帧之后若仍有剩余密文字节，立即抛 **`TrailingDataError`**；
   - `T5`：`getRange` 实收字节数 `< requested_length` 时，立即抛 **`TruncatedObjectError`**；
   - `T6`（**端到端内容重验**）：Entry 全部帧解密拼合完成后，强制校验 $\text{HMAC-SHA256}(k_{\text{cid}}, \text{plaintext}) \equiv \text{chunk\_id}$；
   - `T7`：FastCDC 切分参数（Gear 哈希表种子、`min=65536`、`avg=262144`、`max=1048576`）作为常量固化在 `sync-v2/repo-head.json` 中，确保桌面端、移动端与 Rust 端切分边界 100% 一致。

### 6.3 两级索引链 `.dsix`（`1 Base + <= 8 Delta`）与 16 分片目录拓扑

针对 DeepSeek V4.1 `P0-4` 指出的 **「全量索引每次重传 10MB vs 增量索引 1000 次后新设备需发 1000 次 GET 打爆坚果云 540 配额，且单目录超过 750 个文件会触发 `webdav.ts:336` 截断」**，采用对齐 Kopia 的**两级内容寻址二进制索引链 + 16 分片目录**：

```text
<cloud_root>/
├── .encryption-marker                     # 仅供旧版 backup 子系统兼容，Sync V5 绝不覆写
├── instance.json
└── sync-v2/
    ├── .keyring                           # Sync V5 独立三层密钥环 (DSKEYRING3, 含多 keyslot 与 MK_e)
    ├── repo-head.json                     # Owner 签名的仓库单调头 (防新设备首次同步 TOFU 回滚)
    ├── locks/                             # 仓库维护租约
    ├── pending/                           # 发布前引用预登记: pending/<device_id>/<attempt_uuid>.json
    ├── gc/
    │   └── epoch.json                     # GC 世代、retired_incarnations 与各设备 first_available_seq
    ├── manifests/
    │   └── <device_id>.json               # 设备提交点 (含 base_index_key, delta_index_keys[<=8], signature)
    ├── indices/
    │   └── <device_id>/
    │       ├── base_<gen>_<hash8>.dsix    # 压缩基线索引 (二进制定长 104B/entry，内部按首 nibble 16 分片)
    │       └── delta_<gen>_<hash8>.dsix   # 增量索引 (最多保留 8 个；满 8 个自动合并进新 base 并由 supersedes 清理)
    ├── segments/
    │   └── <device_id>/<hex1>/            # 按 seq_hash 首字符分 16 个子目录 (0..f)，每目录恒 < 500 文件！
    │       └── <inc>_<from>_<to>_<hash8>.dsseg
    ├── packs/
    │   └── <device_id>/<hex1>/            # 按 pack_uuid 首字符分 16 个子目录 (0..f)，规避 WebDAV 750 截断！
    │       └── <pack_uuid>.dspk
    └── checkpoints/
        └── <device_id>/
            └── <inc>_<from>_<upto>_<hash8>.dschkpt
```

1. **为什么 `1 Base + <= 8 Delta` 彻底终结了索引二难问题？**
   - **日常增量同步**：每次同步仅上传 1 个包含本次新增块的 `delta_<gen>_<hash8>.dsix`（仅数 KB），其他在线设备每次只需 `GET` 这 1 个新 delta（**1 次请求**）。
   - **自动折叠与零 LIST 清理**：当某设备的 `delta_index_keys.length > 8`（或累计增量条目 `> 4,096`）时，该设备在本地将 `base + 8 deltas` 合并为一个新的 `base_<new_gen>_<hash8>.dsix`，并在新 base 的 `supersedes[]` 列表中显式记录被替代的 9 个旧 `.dsix` 键名；当全网 `active ∪ idle` 设备的 `index_cursor` 越过该代后，直接按 `supersedes[]` 键名执行精准 `DELETE`（无需任何目录 `LIST`）。
   - **新装设备冷启动上界**：任何新设备加入时，每台远端设备最多只有 `1 个 base + 8 个 delta`（共 $\le 9$ 个索引对象），3 台设备的仓库最多只需 `<= 27` 次 GET 即可构建全库块映射表，仅占坚果云 30 分钟 540 配额的 **5%**！
2. **二进制 `.dsix` 内部 16 分片结构（104 字节/条目）**：
   - `.dsix` 头部之后紧跟 16 槽分片偏移表 `shard_table[16]: { offset_u64, count_u32 }`（按 `chunk_id[0] >> 4` 分片），随后是按 `chunk_id` 升序排列的 `104B` 定长记录（含 `chunk_id[32]`、`content_epoch_u16`、`compression_u8`、`pack_table_idx_u32`、`entry_data_off_u64`、`plaintext_len_u32`、`entry_ct_len_u32`）。

---

## 7. 跨端异构适配（根实体微批次重放）与多实例双速排空握手

### 7.1 移动端 OPFS 双层缓存、16MiB 流式预算与「根实体闭包微批次」

针对第二轮审阅中 GPT-6.1 Sol `P0-S01`/`P0-S05` 与 Gemini 4 Argon `P0-II-2`/`P1-II-2` 共同指出的微批次跨表撕裂与缓存规格问题：

1. **L1 OPFS Arena 与 L2 IndexedDB 分工明确（修补 `P1-II-2`）**：
   - `mobile/src/worker/sqlite-runtime.ts:38` 的 `opfs-sahpool`（`POOL_CAPACITY = 32`）100% 专供核心 SQLite 数据库使用。
   - **L1 热块环形缓冲（`256 MiB`）**：由固定 **4 个 `64 MiB` 的 OPFS Arena 文件** 组成（持久打开 `<= 4` 个句柄），缓存当前正在阅读的课件分块与热缩略图；
   - **L2 温冷块缓存池（上限 `1 GiB`）**：存储在 **IndexedDB `ds_chunk_cache`** 中（直接存储加密或明文 `Uint8Array` 分片以避免 iOS WKWebView `Blob` 克隆开销）。
   - **启动期 KDF 内存豁免（修补 DeepSeek V4.1 `P1-6`）**：密码解封 `sync-v2/.keyring` 的单次 `Argon2id` 优先调用原生桥（桌面端 Rust / 移动端原生插件），在纯 Web Worker 环境下于启动初始化阶段（水化队列启动前）独占执行，完成后立即释放 `64 MiB` 临时工作区，随后日常水化全程受 `MobileHydrationMemoryBudget = 16 MiB` 信号量管控。
2. **按「根实体闭包（Root Entity Closure）」切分微批次 + 逐批即时快照（彻底修补 `P0-S01` / `P0-S05` / `P0-II-2`）**：
   - **废除按扁平行号硬切 100 行的做法**！在将 `.dsseg` 投入微批次循环前，先按业务根实体主键将关联表变更聚合成不可分割的 **原子实体组（Cohesive Entity Group）**：
     - **笔记闭包**：同一 `note_id` 及其引用的 `resources`、`note_document_formats`、`note_document_revisions`、`note_learning_relations`、`folder_items` 强制归入同一个微批次事务；
     - **错题/题目闭包**：同一 `question_id` / `mistake_id` 及其关联的 `resources`、`anki_cards` 强制归入同一个微批次事务；
     - **外键强连通分量（SCC）与原事务组**：同一 `origin_tx_id` 内存在互相外键引用的行强制归入同一微批次事务。
   - 多个原子实体组按累计行数（目标 `<= 100` 行，若单个大实体闭包超过 100 行则以该完整闭包为 1 个独立批次）组装为一个微批次，并在**每个微批次事务内部**严格执行以下 6 步闭环：
     1. 调用 `orderedChangesForApply(batchChanges)` 按表依赖等级（`resources` rank 10 -> `notes` rank 40 -> `note_document_formats` rank 43 -> `folder_items` rank 60）排序；
     2. **即时查询本批 `pendingLocalKeys` 与 `preLogMax = changeLogMaxId(tx)`**（严禁跨微批次复用旧快照！确保在 `setTimeout(0)` 让出间隙用户刚保存的本地修改 100% 被识别并参与逐列 HLC 合并，且绝不会被 `suppressEchoChangeLog` 误标为回声）；
     3. 开启 `PRAGMA defer_foreign_keys = ON`，逐条应用变更并更新 `__sync_row_meta` 与 `__sync_applied_ops`；
     4. **在微批次末尾统一执行外键检查 `validateNoNewFkViolations`**（不在 SCC 中间单行提前报错）；
     5. **在微批次事务内部立即执行 `recomputeDerivedRefCountsIfRelevant(tx, batchChanges)`、`recomputeTodoCompletedPomodorosIfRelevant(tx, batchChanges)` 与 `persistIdAliases(tx, batchAliases)`**（防止批间让出时引用计数短暂为 0 被后台 Blob 清扫器误删，或中途切后台丢失派生统计重算）；
     6. 更新 `__sync_segment_apply_cursor` 并 `COMMIT`，随后 `await new Promise(r => setTimeout(r, 0))` 让出事件循环。

### 7.2 `Pre-Mount Drain` 元数据/附件双速解耦 + 1,500ms 超时逃生舱 + 因果令牌接管

针对 GPT-6.1 Sol `P1-S04` 与 Gemini 4 Argon `P0-II-3` 指出的 Remote Mode 切换阻塞与断网接管回退风险：

1. **Phase A（挂载前排空屏障）：仅排空轻量 `.dsseg` 元数据段 + `1,500ms` 硬超时取消**：
   - 挂载前排空屏障**只推送并等待 `.dsseg` 结构化变更段（通常 `< 50 KiB`）在桌面端完成物化（返回 `MaterializedAck(writer_key, latest_seq)`）**；手机离线期间产生的 20MB 截图/PDF `.dspk` 附件包转入后台异步流推送（桌面端若立即查看该图则经隧道按需拉取对应块）。
   - 绑定 `AbortSignal.timeout(1500)` 与显式「取消并继续使用本机」按钮：若 1.5 秒内因弱网或桌面端正在执行备份持锁未能完成握手，立即自动回退至 `Local-First Mode` 并恢复本机读写，**严禁无限期冻结前端 UI**。
2. **Phase B -> Phase C（断网本地接管的 Causal Token 水位校验）**：
   - 在 Remote Mode 期间，用户在手机上发起的每次写操作由桌面端返回当前 `remote_materialized_seq`。当网络断开触发 `Phase C: Local Takeover` 时：
     - 若后台 Piggyback Sync 已将本机 SQLite 追平至 `>= remote_materialized_seq`，立即零等待无缝接管；
     - 若断网瞬间仍有最后 1~2 条刚在远端确认的写操作尚未通过 Piggyback 流传回本机，前端将这 1~2 条已获确认的写操作载荷直接重放写入本机 SQLite（幂等相同 `op_id`），保证斷网瞬间 **100% 满足 Read-Your-Writes**！

### 7.3 `widgetLocalState` 细粒度主键与移动端 `visibilitychange` 紧急刷盘

针对 DeepSeek V4.1 `P1-12` 与 Gemini 4 Argon `P0-II-4`：
- **修正主键粒度**：`chat_v2.db` 中的画板状态同步表主键必须包含 `widget_id`（支持同一条消息内嵌多个交互画板互不覆盖）：
  ```sql
  CREATE TABLE IF NOT EXISTS message_widget_states (
    owner_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    widget_id TEXT NOT NULL DEFAULT 'default',
    model_content_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,           -- HLC 时间戳
    source_device_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, source_hash, widget_id)
  );
  ```
- **生命周期零丢写兜底**：`writeWidgetLocalState` 同步写入 `localStorage` 时打上 `dirtyForSqliteSync: true`；同时在渲染层注册 `document.addEventListener('visibilitychange')` 与 `window.addEventListener('pagehide')`，一旦转入后台立即跳过 500ms 防抖将脏状态刷入 Worker SQLite；下次冷启动时自动扫描残留 `dirtyForSqliteSync` 条目补写落库。

---

## 8. 跨插件与技能生态同步沙盒（WAL 即时落盘 + 单行转义围栏代码块）

### 8.1 `__plugin_sync_records`：SQLite WAL 立即落盘 + `__change_log` 原地合并 + 字段级未知版本信封

针对 GPT-6.1 Sol `P1-S05`、DeepSeek V4.1 `P1-4` 与 Gemini 4 Argon `P0-II-4`：
1. **废除内存延迟落库，改为「SQLite WAL 立即落盘 + 未发布日志行原地合并」**：
   - 插件调用 `ctx.pluginSyncStore.put(namespace, recordId, payload)` 时，Worker **立即同步执行 SQLite `INSERT OR REPLACE INTO __plugin_sync_records`**（在 `opfs-sahpool` WAL 模式下耗时 `< 0.5ms`），确保插件紧接着调用 `get()` 100% 读到最新值，且用户 100ms 后锁屏或强杀 App 零数据丢失！
   - 为防止高频写刷爆 `__change_log`，由第 3.2.1 节的触发器原地合并机制生效：只要上一条针对同一 `(plugin_id, namespace, record_id)` 的 `__change_log` 记录尚处于 `sync_version = 0`（未封包上传），直接原地更新该日志行的快照与 `changed_at`，使待上传队列永远只有 1 条最新记录；同时对单插件累计未决墓碑与日志字节数施加 `<= 10 MiB` 滚动上限。
2. **插件未知字段同样携带 `(hlc, dev, seq)` 版本信封（修复 DeepSeek V4.1 `P1-4`）**：
   - `__plugin_sync_records.unknown_fields_json` 严禁存裸 JSON，强制采用与第 5.2 节 `__sync_unknown_fields` 完全相同的字段路径版本信封 `{ [fieldPath]: { value, hlc, dev, seq } }`，防止旧版插件回拼时造成已清空插件字段的僵尸复活。

### 8.2 未知插件块的「单行 Canonical JSON + `\u0060` 转义围栏代码块」（根除围栏逃逸）

针对 Gemini 4 Argon `P0-II-1`、DeepSeek V4.1 `P1-5` 与 GPT-6.1 Sol `P1-S05` 共同指出的 **「若插件块的 `fallbackMarkdown` 或 `inlineData` 内部包含三个反引号 ```` ``` ```` 或多行空行，会导致 CommonMark 围栏提前闭合、炸毁 `structure.ts:146` 根块校验并触发 Milkdown `normalizeMarkdown.ts` 往返不一致」**，制定数学上绝对安全的落盘编码规范：

1. **Invariant 8.2-A（单行 Canonical JSON + `\u0060` 全反引号转义铁律）**：
   - 插件块围栏代码块内部的文本载荷**严禁使用多行 Pretty-Printed JSON**，强制规定为：**由 `stringifyJsonLossless` 序列化为单行紧凑 JSON 后，将字符串中所有 ASCII 反引号字符 `` ` `` (`0x60`) 统一替换为标准 JSON Unicode 转义序列 `\u0060`**！
   - 标准落盘示例：
     ````markdown
     <!-- ds:block-id=blk_9f8a7b6c -->
     ```ds-plugin:com.example.mind-canvas:v2
     {"fallbackMarkdown":"- **微积分基本定理**\n  - 代码示例：\u0060\u0060\u0060js\nconsole.log(1)\n\u0060\u0060\u0060","fallbackTitle":"交互式微积分思维导图","inlineData":{"nodeCount":18,"theme":"mineral-celadon"},"pluginVersion":"2.1.0","recordRef":"mind-canvas/node_graph_01"}
     ```
     ````
   - **为什么这一设计是 100% 零逃逸、零字节失真的？**
     - 在 JSON 规范（RFC 8259）中，`"\u0060"` 与 `` "`" `` 解析后的内存值 100% 恒等；
     - 经过 `\u0060` 与 `\n` 转义后，围栏代码块内部**只有唯一的一行纯文本，且物理上不含任何一个 `0x60` 反引号字节或空行**！
     - 无论插件在 `fallbackMarkdown` 里嵌套了多少层 Markdown 代码块，外层 3 个反引号围栏永远不可能被提前闭合，`host/plugins/notes/src/structure.ts:56`、`format.ts:85` 与 Milkdown `src/components/crepe/normalizeMarkdown.ts:67` 的 `sameMarkdownTree` 往返校验 **100% 恒等通过**！
2. **Invariant 8.2-B（ProseMirror `filterTransaction` 降级态写保护锁）**：
   - 在 `src/components/crepe/plugins/blockIdentity/index.ts` 中，当检测到 `code_block` 的 `attrs.language` 以 `ds-plugin:` 开头且当前处于 `<UnsupportedPluginBlockCard />` 降级只读视图时，通过 `filterTransaction` 拦截对该节点内部文本子节点的键盘编辑（仅允许整块移动、复制或整块删除），确保单行 JSON 载荷在未安装插件的设备上坚不可摧。

---

## 9. 设备日志折叠检查点 `.dschkpt`、发布前引用预登记与安全 GC

### 9.1 严格定义为「单设备日志折叠投影」的 `.dschkpt`（修复 `P0-5` / `P0-S07`）

针对 DeepSeek V4.1 `P0-5` 与 GPT-6.1 Sol `P0-S07` 指出的 **「检查点若混入其他设备的列写入会导致跨流重复应用与版本漂移」**，严格固定 `.dschkpt` 的数学定义：

1. **`checkpoints/<subject_dev>/<inc>_<from_seq>_<upto_seq>_<hash8>.dschkpt` 的精确语义**：
   - 它是写入者 `(subject_dev, inc)` 在序列号区间 `[from_seq, upto_seq]` 内**由该写入者自己发出的所有操作按列级寄存器半格折叠（Fold）后的纯投影**，**绝不包含其他设备写入的列值**！
   - 具体内容包含：
     - `(subject_dev, inc)` 在该区间内修改过的每个 `(table, record_id, col)` 的最后一次写入值及其原始 `(col_hlc, writer_dev = subject_dev, source_seq)`；
     - `(subject_dev, inc)` 在该区间内发出的最高行级删除墓碑 `(table, record_id, floor_deleted_hlc, source_seq)`；
     - `(subject_dev, inc)` 在该区间内写入三张金库表与 `__plugin_sync_records` 的折叠状态；
     - 该区间引用的所有 VFS `chunk_id` 集合 `chunk_refs[]` 以及区间 Merkle 摘要 `range_leaf_hash`。
2. **代数等价性证明**：
   - 因为逐列 LWW 与行级 `floor_deleted_hlc` 构成交换幂等半格（Join-Semilattice），离线 120 天的 iPad 拉取并合并 `checkpoints/A/inc1_1_500.dschkpt`，在数学上与逐条重放设备 A 的 `Segment(1..500)` **产生完全相同的数据库状态、`__sync_row_meta` 与 `Merkle Root`**，且绝不会覆盖 iPad 本地或其他设备具有更高 `col_hlc` 的列！

### 9.2 发布前引用预登记（`pending/`）消除 GC `Delete-While-Referencing` TOCTOU 竞态

针对 GPT-6.1 Sol `P0-S06` 与 DeepSeek V4.1 `P0-5` 指出的 **「提交 Manifest 后再 `stat` 存在 TOCTOU 窗口，GC 可能在 `stat` 成功后下一毫秒删掉被复用的旧 Pack」**，将保护点前移到**发布开始之前**：

1. **发布前预登记（Pre-Publish Intent Registration）**：
   - 当设备 $A$ 准备开始一轮同步上传（尤其是计划在新的 `.dsix` 中跨代引用已存在的旧 Pack 或上传新 Pack）时，第一步先向云端写入 `sync-v2/pending/<device_id>/<attempt_uuid>.json`（内含本轮即将引用的所有 `pack_keys[]` 与 `created_at`，TTL 为 2 小时），并回读确认该预登记文件可见。
   - 随后上传 `.dspk`、`.dsseg`、`.dsix` 并提交 `manifests/<device_id>.json`，提交成功后删除 `pending/<device_id>/<attempt_uuid>.json`。
2. **GC 存活集（Live Set）全集公式**：
   - 持有 `sync-v2/locks/` 维护租约的 GC 进程在计算可删除 Pack 时，存活集定义为：
     $$\text{LivePacks} = \left(\bigcup_{d \in \text{active}\cup\text{idle}} \text{PacksIn}(d.\text{base\_dsix} \cup d.\text{delta\_dsix} \cup d.\text{checkpoints})\right) \cup \left(\bigcup_{p \in \text{pending/*/*\ (TTL未过期)}} p.\text{pack\_keys}\right)$$
   - 若 GC 扫描过程中发现任何设备的 `manifest.generation` 发生变化或出现新的 `pending/` 文件，本轮 `sweep` 立即中止（Fail-Closed 零删除）。这样任何正在进行的上传在提交 Manifest 前后都受到 `pending/ ∪ manifests/` 的无缝重叠保护，**从协议上彻底根除 `Delete-While-Referencing` 悬空引用**！

---

## 10. 两轮三模型独立盲审与二阶加固完整可追溯台账（Full Traceability Ledger）

### 10.1 第一轮 DeepSeek V4.1 修正案 `M1 ~ M11` 正文与落点映射表（补齐可核查台账）

| 修正案编号 | 第一轮修正案核心内容 | Rev 3.0 正式落点章节 | 闭合状态 |
|---|---|---|---|
| **M1** | 三层密钥信封：`Password --Argon2id(1次)--> KEK --Unwrap--> MK --HKDF--> DEK` | §6.1 (`sync-v2/.keyring` 双轴密钥体系) | **Closed (Rev 3.0 补齐多 keyslot 与双轴轮换)** |
| **M2** | 密钥化块 ID `chunk_id = HMAC-SHA256(k_cid, plain)` + 分帧 AEAD，不做密文收敛去重 | §6.1 & §6.2 (定长 `65,552B` 帧与 `T6` 重验) | **Closed** |
| **M3** | 全链路上下文 AAD 绑定 + 段前驱哈希链 `prev_segment_sha256` | §6.1.2 & §6.2 (`lp(x)` 长度前缀编码 AAD) | **Closed (Rev 3.0 消除字段拼接歧义)** |
| **M4** | 显式索引对象 `.dsix`，稳态同步零 `LIST` / `PROPFIND` 目录列举 | §6.3 (`1 Base + <=8 Delta` 两级二进制索引) | **Closed (Rev 3.0 解决全量/增量二难与 750 截断)** |
| **M5** | 防回滚新鲜性：`generation` + `prev_sha256` + Ed25519 签名 + 本地高水位 + `repo-head.json` | §1.4 & §6.3 (`repo-head.json` + `DSPAIR2` 带外锚点) | **Closed (Rev 3.0 消除新设备 TOFU 盲区)** |
| **M6** | 发布校验分级：Commit-Point 四步写，不可变对象 `1x PUT + stat` + 1% 后台 Scrub | §6.3 & §9.2 (`CommitUnknown` 保全) | **Closed** |
| **M7** | 基于世代（Epoch-Based）的 GC + 三态设备生命周期 + 检查点重锚定（Re-Anchor） | §9.1 & §9.2 (单设备日志折叠投影 `.dschkpt` + `pending/` 保护) | **Closed (Rev 3.0 严格定义折叠投影与 TOCTOU 防护)** |
| **M8** | HLC 接收端不抛未捕获异常锁死全网 + 48-bit 边界检查 + 去重后更新 Merkle Tree | §4.1 & §4.2 (因果保持 HLC + `__sync_applied_ranges`) | **Closed (Rev 3.0 修复 clamp 因果倒置与跨机分裂)** |
| **M9** | 标准 Base-62 分数阶索引（尾追加整数递增 $O(\log_{62} N)$ + SQL 复合排序决胜） | §4.3 (`rocicorp/fractional-indexing` + tie-group 分裂) | **Closed** |
| **M10** | `DSPAIR2` 高熵配对（128-bit 一次性密钥 / X25519 ECDH + 10min TTL，禁传 `device_id`） | §1.4 & §7.2 | **Closed** |
| **M11** | 显式威胁模型章节（区分被动窥探、主动篡改、回滚截断、去重存在性推测） | §1.4 (威胁模型与安全边界声明) | **Closed** |

### 10.2 第一轮 GPT-6.1 Sol 全部 16 项（`P0-1 ~ P0-8` & `P1-1 ~ P1-8`）逐项核查映射表

| 首轮编号 | 首轮检出问题概述 | Rev 3.0 正式落点章节 | 闭合状态 |
|---|---|---|---|
| **GPT P0-1** | Merkle XOR 重传自抵消 (`h ^ h = 0`) 且哈希未绑定 `op` 与 `payload_sha256` | §4.2 (`__sync_applied_ops` + `lp` 编码完整 `op_hash`) | **Closed** |
| **GPT P0-2** | 备份恢复后复用 `seq` 引发静默历史分叉 (`HistoryFork`) | §3.2 (`writer_key = device_id@incarnation_id`) | **Closed (Rev 3.0 支持多化身并存向量)** |
| **GPT P0-3** | 旧端回拼未知列缺乏原始 `col_hlc` 引发已置空数据僵尸复活 | §4.3 & §5.2 (原始版本信封 + `floor_deleted_hlc`) | **Closed** |
| **GPT P0-4** | 未知表与孤儿池按单行主键覆盖丢失 `Insert->Delete->Insert` 生命周期与别名映射 | §5.2 (`__sync_unknown_op_log` & `__sync_deferred_orphans` 按 `op_id` 唯一追加) | **Closed** |
| **GPT P0-5** | `apply-record.ts:779-804` 整行新鲜度早退吞掉较旧行中的独立新列修改 | §4.3 (`__sync_row_meta` 逐列 `col_version` 寄存器合并) | **Closed** |
| **GPT P0-6** | GC 混淆「元数据游标推进」与「物理块持久副本」，且检查点缺乏一致切面定义 | §9.1 & §9.2 (单设备日志折叠投影 `.dschkpt` + `LivePacks` 全集公式) | **Closed** |
| **GPT P0-7** | HLC `toU64()` 48-bit 移位截断归零、本机前跳无钳制、接收端 clamp 导致因果倒置 | §4.1 (48-bit 守卫 + `<=60s` 完整吸收 + `>60s` `deferred_skew` 隔离) | **Closed** |
| **GPT P0-8** | `verifiedPublish` 在 `CommitUnknown` 时由 `sync_manager.ts:658` 误删已引用对象 | §1.3 Invariant 3 & §6.3 | **Closed** |
| **GPT P1-1** | 循环外键（SCC）单行验证失败与 `apply-fk.ts:62-67` 吞掉查询异常 | §7.1.2 (根实体闭包微批次末尾统一 FK 验证 + 修复吞异常) | **Closed** |
| **GPT P1-2** | SQL Savepoint 无法跨 OPFS、多库与网络游标提供幂等恢复 | §4.2 & §7.1.2 (`received` vs `materialization_state` 分离 + 微批次同事务游标) | **Closed** |
| **GPT P1-3** | `record-data.ts:209-250` 上传时读取当前行值而非修改时刻冻结值 | §3.2.1 (迁移期静态生成触发器冻结列快照 + 原地合并) | **Closed** |
| **GPT P1-4** | Additive 演进下非空约束/枚举变更破坏旧端写语义 | §5.1 (`min_reader` / `min_writer` 三水位 + `repo-head.json` 特性门控) | **Closed** |
| **GPT P1-5** | `BooleanOr` 无法取消收藏、`MaxValue` 无法正确累计双端增量、标签删除缺因果版本 | §4.3 (`is_favorite` 改逐列 LWW，计数改事实表重算，标签改 `(hlc, dev)` Map) | **Closed** |
| **GPT P1-6** | 分数阶索引 `_d1` 后缀破坏 `BINARY` 排序且同位再次插入无分裂规则 | §4.3 (纯 Base-62 + tie-group 内事务分裂协议) | **Closed** |
| **GPT P1-7** | 收敛加密缺随机 Nonce、Pack 缺全局块定位索引、PDF 单页不等同于单 CDC 块 | §6.2 & §7.1 (`.dsix` 二进制索引 + `#source-image` 独立预裁切块) | **Closed** |
| **GPT P1-8** | R4 审计对齐准确性（`notes` 真实正文位于 `resources.data` + `note_document_revisions`） | §4.3 Level D & §8.2 | **Closed** |

### 10.3 第二轮三模型深挖出的「二阶相互作用漏洞（Second-Order Hazards）」与 Rev 3.0 终极补丁汇总

| 二阶补丁编号 | 二阶漏洞名称（由第一轮补丁交互产生） | 检出模型 | 为什么 Rev 2.0 还会出问题 | Rev 3.0 落地的精确字节级/算法级修补方案 |
|---|---|---|---|---|
| **S2-01** | **`HlcClock.receive()` 钳制（clamp）引发因果倒置与跨设备 `col_hlc` 分裂** | **GPT-6.1 Sol** (`P0-S02`)<br>**DeepSeek V4.1** (`P0-9`) | 若把远端超前记录的 HLC 钳制到 `now+60s` 落库或仅把本地时钟推进到 `now+60s`，用户看到远端记录 $v_1$ ($10:05$) 后立刻修改生成的 $v_2$ ($10:01$) 会因 $10:01 < 10:05$ 被 $v_1$ 吞掉！ | **§4.1**：1. 远端 `col_hlc` 永远原样落库；2. 漂移 $\le 60\text{s}$ 时本机时钟完整吸收原始 `remote.hlc`（保证后续写 $T_{\text{new}} > T_{\text{remote}}$）；3. 漂移 $> 60\text{s}$ 时整段进 `deferred_skew` 暂不物化暴露，待时钟追平或用户确认后再吸收物化。 |
| **S2-02** | **机械按 100 行切分微批次撕裂跨表父子原子性、导致半截笔记脏读与间隙本地写被误杀** | **Gemini 4 Argon** (`P0-II-2`)<br>**GPT-6.1 Sol** (`P0-S01`, `P0-S05`) | 1. 全局排序后前 100 行只写了 `notes` 没写 `note_document_formats`，`setTimeout(0)` 期间前端读到半截笔记报错；2. 跨微批次复用 `pendingLocalKeys` 与 `preLogMax` 会把用户在让出间隙的新写入误当成回声抹掉；3. 批间引用计数为 0 会被 Blob 清扫器误删。 | **§7.1.2**：1. 改为按**根实体闭包（Root Entity Closure：同一 `note_id`/`question_id`/SCC）**聚合微批次；2. 每个微批次在自身事务内即时查询 `pendingLocalKeys` 与 `preLogMax`；3. 每个微批次事务末尾内联执行引用计数重算、番茄钟重算与别名持久化。 |
| **S2-03** | **接收去重与物化去重混用导致未知表/孤儿记录升级后被 `__sync_applied_ops` 跳过** | **GPT-6.1 Sol** (`P0-S04`) | Rev 2.0 在收到未知表记录时写入了 `__sync_applied_ops`，而重放管道见该表命中即 `no-op`，导致升级建表后金库记录永远无法物化！ | **§4.2**：在 `__sync_applied_ops` 中分离 `received_at`（仅首次更新 Merkle）与 `materialization_state`（`'pending_schema' | 'pending_fk' | 'materialized'`），重放管道专消费 `pending_*` 并将其转为 `'materialized'`。 |
| **S2-04** | **`Delete -> Reinsert` 旧列复活、存量无版本列基线缺失与 `IdAliasMap` 双端互指不收敛** | **GPT-6.1 Sol** (`P0-S03`, `P0-S01`) | `apply-record.ts:805` 在 upsert 后删掉了删除版本，导致旧代的迟到列更新污染新插入行；且 `apply-id-aliases.ts:424` 偏袒本机已有 ID 导致两端别名不收敛。 | **§4.3 & §5.2**：新增 `__sync_row_meta.floor_deleted_hlc` 跨代墓碑屏障，拒绝一切 $\le \text{floor\_deleted\_hlc}$ 的旧列修改；业务唯一键冲突统一按全网确定性的 `min(created_hlc, dev, id)` 选定 Canonical ID。 |
| **S2-05** | **`.encryption-marker` 被旧端重写抹掉密钥环、密钥派生缺 `incarnation_id` 导致恢复后 Nonce 重用** | **DeepSeek V4.1** (`P0-1`, `P0-2`, `P0-8`) | 1. `v0.20` 客户端重写 `.encryption-marker` 会抹掉 v3 新增字段；2. 吊销设备轮换 `MK` 若改变 `chunk_id` 会引发全库重传；3. `seg_dek` 未含 `incarnation_id` 与随机 salt。 | **§6.1**：1. 密钥环独立存于 `sync-v2/.keyring`；2. 解耦稳定 `k_cid`（块 ID 不变，跨代零重传去重）与按纪元 `MK[content_epoch]`；3. 每个物理对象带 64B 头（含 16B 随机 `object_salt`）且 HKDF `info` 强制含 `lp(incarnation_id)`。 |
| **S2-06** | **64 KiB 分帧偏移未闭合、AAD 字段拼接歧义与新装设备首次同步 TOFU 全仓回滚** | **DeepSeek V4.1** (`P0-3`, `P0-6`, `P0-7`)<br>**GPT-6.1 Sol** (`P1-S03`) | 变长字符串直接拼接存在 `"ab"+"c" == "a"+"bc"` 歧义；新设备首次同步无本地高水位，会被恶意网盘喂 30 天前的旧全集。 | **§6.2 & §1.4**：1. 全链路采用 `lp(x) = u16be(len) || x` 编码；2. 固定 `65,552B` 帧与 `u32be(entry_idx) || u64be(frame_idx)` Nonce 及 `T1~T7` 读取器铁律；3. 引入 Owner 签名的 `sync-v2/repo-head.json` 并由 `DSPAIR2` 带外锚定。 |
| **S2-07** | **`.dsix` 全量/增量二难困境、WebDAV 单目录 `750` 条目截断与检查点混入他端数据** | **DeepSeek V4.1** (`P0-4`, `P0-5`)<br>**GPT-6.1 Sol** (`P0-S06`, `P0-S07`) | 全量 `.dsix` 每次重传 10MB，纯增量 `.dsix` 1000 次后新设备需 1000 次 GET；扁平目录超 750 文件触发 `webdav.ts:336` 截断；发布后 `stat` 存在 TOCTOU 删块窗口。 | **§6.3, §9.1 & §9.2**：1. 采用 `1 Base + <= 8 Delta` 两级二进制分片索引（104B/条目）+ `supersedes[]` 清理；2. `segments/` 与 `packs/` 按 `<hex1>/` 16 分片（单目录 `< 500` 文件）；3. `.dschkpt` 严格定义为单设备日志折叠投影 + `__sync_applied_ranges`；4. 发布前先写 `pending/<dev>/<attempt>.json` 预登记保护引用。 |
| **S2-08** | **插件代码块内含 ```` ``` ```` 引发围栏逃逸炸毁笔记、`Pre-Mount Drain` 20MB 附件阻塞与 2s 内存防抖锁屏丢数** | **Gemini 4 Argon** (`P0-II-1`, `P0-II-3`, `P0-II-4`)<br>**DeepSeek V4.1** (`P1-4`, `P1-5`, `P1-12`) | 1. JSON 内含 ```` ``` ```` 会使 CommonMark 提前闭合代码块，触发 `structure.ts:146` 报错；2. 排空屏障若传大附件会卡死 UI；3. 2s 内存合并窗口在移动端锁屏时丢数据。 | **§8.2, §7.2, §7.3 & §8.1**：1. 插件代码块强制为**单行 Canonical JSON + `\u0060` 全反引号转义** + ProseMirror `filterTransaction` 写保护；2. `Pre-Mount Drain` 仅排空 `.dsseg` 元数据段且设 `1,500ms` 超时逃生舱；3. 插件写立即落 SQLite WAL，在触发器内对 `sync_version = 0` 的未发布 `__change_log` 原地合并；4. `message_widget_states` 增 `widget_id` 主键并绑定 `visibilitychange` 刷盘。 |
