# R11-delta：整包 ZIP 备份走向增量的路线调研

- 调研基线：`origin/cursor/cloud-sync-sota-b343` @ `bdf4d630`
- 基准脚本提交：`35682826`
- 性质：协议与对象布局调研；**不含生产实现**
- 约束：云端只有 `put/get/list/delete/stat`，没有 conditional PUT / CAS；可选
  E2EE 为当前 DSBK（随机 salt / nonce 的 AES-256-GCM 容器）

## 0. 结论

**现在不能宣称「增量备份」或「增量去重」。**

记录级 data-governance sync 是另一条增量合并链；本文件讨论的 Cloud backup
仍是「全量 staging → 全量 ZIP → 可选整包 DSBK → 单对象 `put_file`」。流式、
multipart 和断点下载改善内存/可靠性，不会减少一次成功上传必须传输的有效载荷。

推荐下一步先做 **manifest 级未变对象跳过**：

> 每个恢复点发布一份自包含的完整快照描述；沿本设备上一恢复点复用未变逻辑文件的
> 随机命名、不可变 DSBK 对象，只上传变更文件。恢复不追 parent 链，直接按该版本的
> 完整对象表物化现有可恢复 staging/ZIP。

它适配 dumb-storage，不要求确定性加密或 plaintext hash 出现在远端 key，也能先吃到
「资产未变、少数数据库变化」的主要收益。首版应明确称
**「未变文件复用 / 增量传输」**，不能称 CDC、块级去重或全局内容去重。

内容寻址对象可作为第二阶段；CDC 只应在对象协议、恢复和 GC 经故障注入稳定后再做。

## 1. 现状基准：一次变化为什么仍传整包

### 1.1 代码路径

当前设置页的云备份顺序是：

1. `CloudStorageSection.tsx:860-903` 调 `backupTiered`，选择
   `core/important/rebuildable/large_assets` 并包含资产；
2. 同一入口调用 `DataGovernanceApi.exportZip(backupId)`；
3. `zip_export.rs:991-1135` 遍历 staging，逐文件 DEFLATE，写成一个 ZIP；
4. `cloud_storage/mod.rs:317-340` 在配置云端 E2EE 时，把**整个 ZIP**再流式加密为
   一个临时 DSBK v2 文件；未启用时直接使用 ZIP；
5. `sync_manager.rs:728-755` 生成唯一版本 ID，只调用一次
   `put_file("backups/<version>.zip", whole_path, ...)`；
6. 对象完成后才把 `BackupVersion { size, checksum, ... }` 发布到本设备
   `manifests/<device>.json`（`sync_manager.rs:769-811`）。

因此：

- 没变化：新 staging/manifest/ZIP 仍产生，新 ZIP 仍整包 PUT；
- SQLite 一页或一行变化：外层 ZIP 是新对象，仍整包 PUT；
- 一个资产变化：仍整包 PUT；
- E2EE：`encrypt_backup_file` 每次生成随机 salt 与 nonce prefix
  （`backup_crypto.rs:260-323`），同一 ZIP 重传也得到不同密文；密文相等比较不可用；
- provider 的 S3 multipart / FTP 流 / WebDAV 流式 PUT 只改变传输方式，不改变上传字节数。

当前默认 `DEFAULT_MAX_VERSIONS = 10`，且 `prune_versions` 作用于本设备 manifest；
多设备 manifest 合并后的全局可见数可以大于 10。现有安全提交顺序是
「先发布已裁剪 manifest，再删不再可见的 ZIP」，删除失败最多留下孤儿，不破坏可见恢复点。

### 1.2 可复现的安全本地脚本

脚本：

```text
src-tauri/tests/cloud_sync_delta_benchmark.py
```

手动运行，不属于 Cargo/Vitest 门禁：

```bash
python3 src-tauri/tests/cloud_sync_delta_benchmark.py
```

安全边界：

- 只写系统临时目录，结束后清理；
- 不读取 Deep Student 用户目录；
- 不访问网络；
- 用 Python ZIP DEFLATE level 6 镜像外层打包形态；
- DSBK 字节数按当前 v2 格式的精确开销计算，但**没有**测 Argon2/加密 CPU；
- 上传耗时是按给定 Mbps 算出的纯传输时间，不冒充 WebDAV/S3/FTP 实测。

合成 profile 不是「典型用户统计」：它声明为 32 MiB 目标的混合文本/随机 SQLite、
128 MiB 已压缩类资产、16 个资产文件。SQLite 实际落盘略大，合计源数据
`169,684,992 B`（`161.824 MiB`，17 个文件）。

2026-08-24 在本 Cloud Agent（Linux 6.12.94+ / Python 3.12.3）连续两次独立实跑。
字节数逐次相同；本地打包受 VM 争用与页缓存影响，以下按两次观测给区间：

| 场景 | ZIP | DSBK v2 | 本地打包观测 | 10 Mbps 纯上传 | 50 Mbps 纯上传 |
|---|---:|---:|---:|---:|---:|
| 初始快照 | 144.953 MiB | 144.956 MiB | 2.727–9.792 s | 121.598 s | 24.320 s |
| 用户数据零变化（只换版本元数据） | 144.953 MiB | 144.956 MiB | 2.749–11.122 s | 121.598 s | 24.320 s |
| SQLite 仅一行时间戳变化 | 144.953 MiB | 144.956 MiB | 4.024–11.005 s | 121.598 s | 24.320 s |

解释：

- 零变化与一行变化都仍需约 **145 MiB/次**；这是当前 whole-object PUT 语义直接决定的，
  不是 provider 优化能消掉的流量。
- DSBK v2 额外开销只有 44 B 头 + 每 1 MiB 块 16 B tag；它几乎不放大流量，
  但随机化使「比较密文判断未变」不可行。
- 同 profile 简单乘以本设备 10 个整包约为 `1,449.534 MiB`（约 `1.416 GiB`）。
  这只是等尺寸示意；真实版本大小会变，多设备总数也不是固定 10。
- 本地打包时间是脚本数量级，不是 Rust exporter 性能结论；未测真实 provider、
  TLS、重试、限速、DSBK Argon2 和磁盘争用。

脚本证明的是「现实现对小改动没有网络增量性」，**没有**证明某个增量方案的生产收益。

## 2. 三条路线

### 2.1 路线 A：内容寻址 objects 复用

定义：把 staging 的逻辑文件或数据块映射成稳定内容 ID；已有 ID 不再上传，新版本
manifest 只引用对象。

#### dumb-storage 可行性

基本可行，但不能机械地写成 `exists(hash) -> put(hash)`：

- `CloudStorage` 可 `stat/list/get/put/delete`，足以查询和读取对象；
- 但没有「仅当不存在时创建」和 CAS。两个设备可能同时判断不存在，再以不同密文覆盖
  同一个 key；双方各自回读成功也不能证明之后没有被另一方覆盖；
- 若 key 是 plaintext SHA-256，provider 可对已知小文件做离线枚举确认；
- 若 key 是 ciphertext SHA-256，当前随机 DSBK 让同一明文每次 ID 都不同，去重消失；
- 若用确定性/收敛加密恢复稳定 ID，会扩大相等性与已知明文泄露，并引入 nonce/密钥误用风险，
  本路线不建议这样做。

安全形态应是：

1. 仓库生成独立随机 `id_key`，由密码派生的 KEK 包裹；对象 ID 使用
   `HMAC(id_key, domain || plaintext_hash)`，不直接暴露 SHA；
2. 对象密文仍用随机 nonce；稳定内容 ID 到随机密文对象 key 之间需要加密索引，
   或要求仓库级备份写租约保证 immutable first-writer；
3. 多设备并发无锁时宁可上传重复随机对象，也不能覆盖一个双方 manifest 已引用、
   但 checksum 不同的稳定 key。

这已不再是给现有 `CloudManifest` 加一个字段，而是新仓库格式、wrapped repository key、
索引与锁协议。

#### E2EE 与泄露

keyed ID 能阻止不持有 `id_key` 的 provider 对常见小文件直接猜 hash，但不能消除：

- 同一仓库内「两个对象相等」的等价类；
- 对象大小、数量、上传时间；
- 某一版本只新增了多少对象；
- `id_key` 泄露后的历史确认攻击。

`id_key` 不能直接等同登录密码：密码轮换若改变 ID，会令全仓去重失效并要求重写。

#### 恢复语义

正确设计应让每个 snapshot manifest 直接列出完整对象图，不要求先恢复父版本。这样
manifest 丢失只损坏该恢复点；对象损坏会影响所有复用它的恢复点。恢复必须逐对象验证
密文 checksum、AEAD tag 与明文 keyed ID，并在全部对象齐全后才进入 A/B 槽。

#### 判断

中期可行、收益上限高，但首轮改动面过大；不作为第一生产增量版本。

### 2.2 路线 B：manifest 级未变跳过（推荐）

定义：以现有完整 staging 中的**逻辑文件**为复用单位。新恢复点仍发布一份完整文件表；
若某路径的类型、大小和明文 hash 与本设备上一份 v2 快照一致，直接复用上一对象引用；
只把变更文件写为新的随机、不可变对象。

它不是「delta manifest」：

- descriptor 没有 `parent` 解析依赖；
- 未变项是直接 object ref，不是「沿链应用 patch」；
- 零数据变化时可以只发布小 descriptor/版本索引，保留该时点；也可以产品层选择
  coalesce，但不能假装上传了新完整数据副本；
- 删除体现在新 descriptor 不再引用旧路径；不会立即删除仍被其他版本引用的对象。

#### dumb-storage 可行性

高：

- 每个新对象使用随机唯一 key，不需要 CAS、不覆盖；
- 比对只需读取本设备上一份 descriptor；现有 per-device manifest 已避免跨设备 RMW；
- 多设备可能为相同内容各存一份，降低跨设备去重率，但不影响正确性；
- 上传失败发生在版本发布前，只留下不可见孤儿；
- 版本发布仍是唯一 commit point。

首版只沿同设备、同逻辑路径复用。重命名后重复上传、跨设备重复上传是刻意接受的边界；
不要用「全局内容去重」描述它。

#### E2EE 可行性

高，且无需确定性加密：

- object key 随机；路径、明文 hash、对象映射放在加密 descriptor 内；
- 未变文件复用旧 DSBK 密文，不重新加密；
- 变更文件生成新随机 salt/nonce 的 DSBK；
- 多对象加密必须一次 KDF 后使用会话/仓库数据密钥，不能对几千个对象逐一跑当前
  `encrypt_backup_file` 的 Argon2；
- 明文模式可保留相同布局但不加密，不能反向削弱 `.encryption-marker` 的防混布门禁。

它仍泄露对象大小、时间和「这次新增了几个对象」，但不会把 plaintext hash 放进 key。

#### 恢复语义

恢复指定版本时只需：

1. 下载并验证该版本 descriptor；
2. 按 descriptor 直接下载每个对象；
3. 验证 ciphertext checksum → DSBK AEAD → plaintext hash/size；
4. 在临时目录物化与现有 `BackupManifest` 相同的完整 staging；
5. 复用现有导入验证/A-B 槽切换；任何对象缺失都在切槽前 fail-closed。

本地可重新打一个兼容 ZIP 再交现有导入器，代价是额外磁盘与压缩时间；首版为少改恢复核心，
这个代价可以接受。后续再让恢复器直接消费 staging。

#### 收益边界

- 不变资产占大头：接近只上传变更数据库，收益明显；
- 小改动发生在一个 5 GiB SQLite：仍需传整个 5 GiB 文件，收益差；
- 全库零变化：对象流量接近 0，只写小 descriptor/索引；
- 它降低网络量，不消除生成一致性 SQLite staging 和计算 hash 的本地 I/O。

#### 判断

当前约束下风险/收益比最佳，推荐先落地。

### 2.3 路线 C：CDC 内容定义分块

定义：在 ZIP 和加密之前，对逻辑大文件用 Rabin/Buzhash/Gear 等 rolling hash 切成
可变块；插入/位移只改变附近块。chunk 使用加密的完整 snapshot graph 直接引用。

#### dumb-storage 可行性

理论可行，工程风险最高：

- 小 chunk 逐个 PUT 会在 WebDAV/FTP 上产生高 RTT、对象数和 LIST 压力；
- 必须把多个 chunk 聚合为 pack（例如 8–32 MiB）并维护 pack index；
- pack 是 append-only 后，删除单个 dead chunk 需要 repack，而不是简单 `delete`；
- 全局 chunk index 在无 CAS 下不能安全原地更新；需 per-device append-only index +
  完整合并，或仓库级写租约；
- LIST 截断必须让备份/GC fail-closed，不能把「索引没列到」当成 chunk 不存在；
- CDC 参数与 seed 是仓库格式，改变会使后续去重断层；seed 应属于加密 repository config。

#### E2EE 与泄露

CDC 必须发生在加密前。chunk ID 至少应是 repository-keyed MAC，不能是裸 SHA；
CDC seed 也应仓库随机化，降低边界指纹。即使如此，仓库内相等性、chunk/pack 大小和更新时序
仍会泄露。对高敏感用户应提供「禁用去重、随机对象」选项，且产品文案明确取舍。

当前 DSBK 是文件容器，不是 pack/chunk 仓库协议。直接把每个 chunk 包成独立 DSBK 会带来
逐块 KDF、海量对象和 GC 放大，不能作为实现捷径。

#### 恢复语义

snapshot descriptor 必须直接记录每个文件的有序 chunk 序列，不允许依赖「父版本 + delta」。
恢复可并行拉 pack/range，但一个共享 chunk 损坏会同时破坏许多版本；需要 repository check、
冗余/修复策略与坏块到受影响版本的反向报告。

#### 判断

长期上限最高，特别适合超大 SQLite/工作区 DB 的页级小改动；当前不应先做。

## 3. 推荐路线的对象布局草案

### 3.1 为什么不能直接把 v2 条目塞进现有 manifest

旧客户端会忽略 `BackupVersion` 的未知字段，却仍固定下载
`backups/<id>.zip`。如果同一 `manifests/<device>.json` 出现只有 descriptor/object graph
而没有 ZIP 的 v2 版本，旧客户端会展示它，随后下载不存在的 ZIP。

所以「serde 向后兼容」不等于恢复兼容。未建立可靠 reader-version gate 前，v2 必须使用
旧客户端不会扫描的独立 namespace；现有 v1 只读兼容，不能让新旧格式混写同一索引。

### 3.2 namespace

```text
.encryption-marker                         # 现有；继续作为全 root 防混布门禁

manifests/<device_id>.json                 # 现有 v1，仍只引用 backups/*.zip
backups/<version_id>.zip                   # 现有 v1 整包，原样可恢复

backup-v2/config.dsbk                      # 加密 repository config：format、id/key epoch
backup-v2/manifests/<device_id>.json       # v2 per-device 版本索引（可见元数据最小化）
backup-v2/snapshots/<device>/<id>.dsbk     # 完整、自包含 snapshot descriptor
backup-v2/objects/<device>/<uuid>.dsbk     # 随机 key、不可变逻辑文件对象
backup-v2/gc/candidates/<uuid>.json        # 两遍 GC 候选；不等于立即可删
backup-v2/locks/<operation_id>.json        # contender 式 backup/GC 仓库租约
```

明文仓库可用相同 key，扩展名不应作为安全判断；真实格式字段与 `.encryption-marker`
共同决定解码策略。这里写 `.dsbk` 只是强调 E2EE 情形。

v2 版本索引条目至少包含：

```text
id, timestamp, device_id, app_version, note,
format = "snapshot-v2",
snapshot_key, snapshot_cipher_sha256, snapshot_size,
logical_size, newly_uploaded_size
```

路径、文件名、plaintext hash、对象引用都只在 snapshot descriptor 内。v2 reader 把
v1 + v2 两类版本合并展示；类型决定下载恢复器，绝不靠探测失败后猜格式。

### 3.3 发布顺序

一次上传在 backup-v2 仓库租约内执行：

1. 生成并验证完整本地 staging；
2. 计算 inventory；读取本设备上一份 v2 descriptor；
3. 对未变项复用 direct ref；
4. 以全新随机 key 上传变更对象，逐对象验证大小/cipher checksum；
5. 上传完整 snapshot descriptor，并读回验证；
6. 将版本加入 `backup-v2/manifests/<device>.json`，按时间合并后只保留本设备最近 10 个；
   **这一步是版本可见的 commit point**；
7. commit 成功后才进入 GC；前面任一步失败只会留下不可见孤儿。

v1 与 v2 的「10 版」过渡不能假装是原子操作：

- 新客户端 UI 按同一设备合并排序，默认只展示最近 10 个可恢复点；
- v1 manifest/object 在仍可能被旧客户端读取时不得因 v2 配额直接删掉；
- 明确完成格式迁移或经过兼容保留窗后，才可按「先从 v1 manifest 移除、再删 ZIP」
  的原顺序物理回收旧版本；
- 因而过渡期物理对象可能暂时超过 10 版，这是防止旧客户端出现 dangling ZIP 引用的
  必要保守行为，必须在 UI/运维文档说明。

### 3.4 GC 顺序

对象被多个版本复用后，不能沿用「删一个版本就删一个同名 ZIP」：

1. 在 v2 per-device manifest 中先移除被裁剪版本并成功发布；
2. 删除该版本 descriptor 失败时只留下不可见孤儿，可稍后重试；
3. 在仓库级 backup/GC 租约下完整列举所有 v2 device manifests；任一 LIST 截断、
   manifest/descriptor 读取或解密失败，**本轮零删除**；
4. 从所有保留版本的完整 descriptor 建 live object set；
5. 未被引用对象只写入 `gc/candidates`，记录首次确认时刻与 sweep generation；
6. 下一次独立成功全扫描后，仍未引用、早于 grace window、且不晚于本轮扫描起点的候选
   才可删除；
7. 删除对象后再清 candidate；失败最多留下垃圾，不得留下可见版本缺对象。

租约与双扫描同时需要：租约解决正常客户端并发；grace/candidate 保护崩溃残留、
时钟/列表异常与未来不识别租约的旧客户端。任何时候都选择空间泄漏而不是恢复点损坏。

现有 `repo_check` 后续要理解 v2 descriptor/object graph；在此之前不能把
`backup-v2/` 纳入旧版「孤儿 ZIP」判定。

## 4. 恢复与兼容语义的硬约束

1. **每版自包含描述，不建增量链**：禁止 `base_version + patch` 成为唯一恢复路径。
2. **commit 后可恢复**：manifest 可见前，所有对象与 descriptor 已上传并验证。
3. **全量验证后切槽**：缺任一共享对象，整个恢复点失败；不得部分 overlay 后称成功。
4. **v1 永久可读**：`backups/<id>.zip` 与现有 checksum/DSBK 解密路径不改格式。
5. **类型显式**：v1/v2 由索引字段选择，不靠扩展名、魔数失败或对象是否存在猜测。
6. **E2EE 不降级**：有 marker 时，descriptor、逻辑对象、未来 chunk/index 全部密文；
   明文对象不得因「复用失败」回退上传。
7. **校验分层**：远端传输 checksum、DSBK AEAD、descriptor 内 plaintext hash/size
   都要通过；其中任一失败不得发布或切槽。
8. **损坏影响诚实报告**：共享对象损坏会让多版同时不可恢复，repo check 要列出全部受影响
   version ID，不能只报一个坏 key。

## 5. 下一轮可直接认领的任务（文件面独占）

以下任务按顺序进入；前一阶段没有故障注入证据时，不启动 CDC。

| 任务 | 交付 | 独占文件面 |
|---|---|---|
| R12-delta-format | `SnapshotDescriptorV2`/object ref/config 的 schema、上限校验、v1/v2 fixture、未来版本 fail-closed；只做 codec | 新 `src-tauri/src/cloud_storage/delta_format.rs`；新 `src-tauri/tests/sync_r12_delta_format.rs` |
| R12-delta-inventory | 从已验证 staging 生成规范 inventory；稳定排除 volatile manifest 字段；SQLite/资产/crypto 覆盖测试 | 新 `src-tauri/src/data_governance/backup/delta_inventory.rs`；新 `src-tauri/tests/sync_r12_delta_inventory.rs` |
| R12-delta-lease | contender 式 backup-v2/GC 租约、TTL、截断/损坏 fail-closed；不复用 record-sync namespace | 新 `src-tauri/src/cloud_storage/backup_lease.rs`；新 `src-tauri/tests/sync_r12_backup_lease.rs` |
| R12-delta-upload | 随机不可变对象、同设备上一 descriptor 未变复用、objects→descriptor→manifest commit、失败留孤儿测试；不做 GC | 新 `src-tauri/src/cloud_storage/delta_upload.rs`；新 `src-tauri/tests/sync_r12_delta_upload.rs` |
| R12-delta-restore | v2 下载、三层校验、完整 staging/兼容 ZIP 物化、任一对象缺失不触碰活动槽 | 新 `src-tauri/src/cloud_storage/delta_restore.rs`；新 `src-tauri/tests/sync_r12_delta_restore.rs` |
| R12-delta-gc | 合并所有 v2 manifests、两遍 candidate/grace GC、截断/并发/崩溃注入；共享对象绝不误删 | 新 `src-tauri/src/cloud_storage/delta_gc.rs`；新 `src-tauri/tests/sync_r12_delta_gc.rs` |
| R12-delta-integration | 最后才接命令/UI、双索引版本列表、v1 只读迁移窗、repo check v2；统一进度与术语 | `cloud_storage/mod.rs` + `sync_manager.rs` **仅类型分派段**；`repo_check.rs` v2 段；`CloudStorageSection.tsx` 增量状态区；zh/en `cloudStorage.json` `delta.*`；新 vitest |
| R13-cdc-lab | 只做离线 pack/chunker benchmark 与格式 ADR；不得接生产上传 | 新 `src-tauri/tests/cloud_sync_cdc_benchmark.py`；新 `docs/dev/cloud-sync-sota-b343/CDC-R13.md` |

认领规则：

- `sync_manager.rs` 只给 integration 路，前六路不得改；
- `repo_check.rs` 只给 integration 路；
- 每路新测试文件独占，不改现有 sync 测试；
- 不碰 `ftp.rs`；provider 特例不得进入协议层；
- 不碰 notes/chat/workbench；
- 基准脚本继续是手动工具，不加入默认 CI。

验收术语：

- format/restore/GC 绿灯前：功能不可暴露；
- manifest route 落地后：可称「未变文件复用、增量传输」；
- keyed content ID 全局命中落地后：才可称「内容去重」；
- CDC + pack + 恢复 + GC 全闭环后：才可称「块级增量去重」。

## 6. 风险清单

### P0：恢复与删除

| 风险 | 失败形态 | 必要防线 |
|---|---|---|
| 增量链损坏 | parent/patch 任一丢失导致后续全灭 | 不建恢复链；每版 descriptor 直接列完整对象图 |
| GC 与未发布上传竞态 | 新对象已上传、manifest 未发布时被当孤儿删除 | backup/GC 仓库租约 + 两遍 candidate/grace + 扫描起点门槛 |
| 共享对象误删 | 裁剪一个版本破坏仍引用对象的九个版本 | 全仓 reachability mark；任一列表/描述失败则零删除 |
| 半发布版本 | manifest 可见但对象/descriptor 未齐 | objects → descriptor → version index，索引最后提交 |
| 旧客户端误读 v2 | 固定拼 `backups/<id>.zip` 后恢复失败 | v2 独立 namespace/索引；显式类型；迁移窗内 v1 只读保留 |

### P1：E2EE 与完整性

| 风险 | 失败形态 | 必要防线 |
|---|---|---|
| 裸 hash 去重泄露 | provider 猜常见文件 hash，确认用户是否持有 | 首版随机对象；未来只用 repository-keyed MAC |
| 确定性加密泄露/误用 | 跨版相等性显式、nonce 重用导致灾难 | 保留随机 AEAD；不以 convergent encryption 换去重 |
| 仓库内相等性泄露 | keyed ID 仍暴露同 repo 内重复关系 | 风险告知；高敏感模式禁用全局去重；ID key 与仓库隔离 |
| 密码轮换打断 ID | password-derived ID 改变导致全量重写 | 随机 repository `id_key`，仅用密码包裹；版本化 key epoch |
| 逐对象 Argon2 放大 | 千对象备份 CPU/内存不可接受 | 一次 KDF + 会话/仓库数据密钥；对象独立 nonce/tag |
| descriptor 被替换 | 下载到完整但属于另一版本的对象图 | Cloud index 固定 descriptor cipher SHA/size；AEAD 绑定 version/domain |

### P2：规模与运维

- 小对象风暴：WebDAV/FTP RTT、目录遍历和 LIST 截断先于带宽成为瓶颈；
- hash 全盘扫描：即使上传为零，本地仍要读完整 staging；后续可用可信本地 hash cache，
  但不能只信 mtime/size；
- SQLite 全文件变化：manifest route 对超大 DB 的收益有限，是 CDC 的真实驱动；
- 共享故障域放大：一个对象坏掉影响多版；repo check 频率要高于整包时代；
- orphan 增长：安全 GC 选择宁留不删，需要容量可见与人工诊断；
- 恢复临时空间：对象物化 + 兼容 ZIP + A/B 槽可能同时占用约 2–3 倍逻辑大小；
- 多设备重复：首版只沿设备 lineage 复用，不能承诺仓库全局节省率；
- format downgrade：新版本仓库被旧客户端继续写 v1 会形成双历史，UI 必须显式展示来源；
- 指标误导：`newly_uploaded_size`、`logical_size`、`reused_size` 要分开，不用「压缩率」
  代替「去重率」。

## 7. 外部设计参照

- [restic design](https://restic.readthedocs.io/en/stable/design.html)：完整 snapshot 文档、
  Rabin CDC、随机仓库 chunker 参数、加密对象；
- [Borg security internals](https://borgbackup.readthedocs.io/en/stable/internals/security.html)：
  用秘密 `id_key` 对 plaintext 做 MAC，避免裸 SHA 的已知小文件 fingerprinting；
- [Kopia architecture](https://kopia.io/docs/advanced/architecture/)：dumb blob storage 之上分
  content-addressed block/object/manifest 层，并以 pack 降低小对象成本。

这些项目证明「dumb storage 上做 E2EE + dedup」可行，但它们都有独立仓库格式、密钥层、
索引/pack 与完整性工具；不能把现有单 ZIP 路径加一个 hash 字段就等价宣称实现。

## 8. 最终判定

| 声明 | 当前能否宣称 |
|---|---|
| 云 ZIP 流式上传 / 大文件 multipart | 能 |
| WebDAV 云 ZIP 断点下载 | 能 |
| 记录级增量同步 | 能，但必须明确不是 Cloud backup |
| Cloud backup 增量传输 | **不能** |
| Cloud backup 内容去重 | **不能** |
| Cloud backup CDC/块级去重 | **不能** |

本轮只有调研、可复现的合成基准和协议草案；没有任何生产上传、恢复或 GC 行为改变。

> 进度注记（R12-delta-format / inventory / lease / upload / restore / gc）：codec、
> staging 规范清单、`backup-v2/locks/` 租约、未接线的
> `publish_verified_staging`、`restore_snapshot_to_staging` 与两遍 GC 已落地。
> 生产上传仍是整 ZIP 单对象 `put_file`，上表「Cloud backup 增量传输/去重」
> 判定不变，仍为**不能宣称**。GC 积木已合、未接线。integration 未接命令/UI
> 前，功能不可暴露。
