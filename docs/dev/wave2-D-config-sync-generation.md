# 0824 Wave2-D R2 并发窗口：配置 generation 与同步引擎的可见性契约

> 角色：R2「并发窗口」。只读锚定 + 设计冻结，本轮**未落挂钩**（理由见 §5）。
> 上游输入：`/tmp/0824-wave2-r1-reports/07-frontend-config.md`（P1/P2 实证）、
> `docs/dev/wave2-D-ledger.md` §7（R2 草稿/测试/发布设计冻结）。
> 本文未改任何产品代码，未执行编译/测试。

---

## 0. TL;DR

1. 今日没有草稿态：**测试即发布**，连接测试失败的配置已经是正式 SSOT，auto-sync 下一轮就会拿它去跑（07 报告 §1）。
2. R2 目标不变量：**同步引擎只读 active generation；draft 测试对同步引擎完全不可见**。
3. `BACKUP_GLOBAL_LIMITER` 是 `Semaphore(1)` 进程内全局互斥。推荐：**publish 不拿这把锁**；作为交换，**sync 必须在开局一次性 snapshot「generation + 凭据」，整个 run 期间不得再 hydrate**。后端单命令内今天已满足「一次 hydrate」；风险在 `hydrate_cloud_config` 每次 IPC 都重读最新 active——所有**前端编排的多 IPC 流程**（put/get 原语、逐条 tombstone）在 publish 中途落地时会换凭据。
4. 最小挂钩建议已给出（§4.4：命令入口缓存本次 hydrate 结果 + generation 回执/校验）；本轮不落码，留给实现 `cloud_config_publish` 的后续轮（§5）。

---

## 1. 今日现状：测试即发布

07 报告（R1，行号级实证）已钉死，此处只记结论与本轮补核的后端半边：

- 前端 `doTestConnection`（`src/features/settings/components/CloudStorageSection.tsx:529-623`）的顺序是
  `saveCredentials` → `saveCloudConfigSsot` → `checkConnection`。**持久化在测试之前**；
  `checkConnection` 失败只置 UI `connectionStatus='failed'`，凭据与 SSOT 不回滚。
- 「测试」与「保存」是同一条持久化路径（`doSaveConfig` 418-486 行逐字段等价），差异只是测试多一步只读连通检查。
- 后端半边（本轮补核）：`cloud_storage_check_connection`（`src-tauri/src/cloud_storage/mod.rs:200-208`）
  开头调用 `hydrate_cloud_config`，而 `hydrate_cloud_config`（`src-tauri/src/secure_store.rs:2309-2334`）
  会**整体丢弃 IPC 传入的非密字段、从 active SSOT 重建配置**（`replace_with_persisted_cloud_config`，
  `secure_store.rs:2282-2289`），再从安全存储补密（`hydrate_cloud_config_credentials`，`:2291-2307`）。
  所以今天「不先保存就测试」在架构上做不到：check_connection 测的**永远是已发布的 active 配置**，
  这正是前端被迫先写后测、从而「失败配置可被 auto-sync 当正式配置」的根因。
- auto-sync 消费面：`performAutoSyncOnce`（`src/stores/syncStatusStore.ts:280-324`）读同一条 SSOT，
  凭据存在性检查会通过（错凭据也已保存），坏配置直接进入自动同步失败/退避循环。

## 2. R2 目标不变量（同步 × generation）

沿用台账 §7 冻结的 draft/staged/active 模型（staged generation + active pointer），本文补足并发侧约束：

- **G1 唯一读面**：同步/备份/恢复/删除传播引擎的配置读取只允许经
  `load_hydrated_cloud_config_ssot`（`src-tauri/src/cloud_config_commands.rs:547-557`）或
  `hydrate_cloud_config` 到达 **active generation**。draft/staged 键永远不进这两个函数的读取路径。
- **G2 draft 不可见**：`cloud_config_test_connection_draft`（R2 新命令）接收一次性完整草稿
  （非密字段 + 密文字段全部走 IPC 入参），**不写任何存储、不动 active pointer**，并且**绝不能**对
  草稿调用 `hydrate_cloud_config`——按 §1，hydrate 会把草稿整体替换成 active，测试就白测了。
  草稿测试需要走 `hydrate` 之外的旁路（只做 `validate` + `create_storage` + `check_connection`）。
- **G3 发布原子可见**：`cloud_config_publish` 成功之前，任何引擎读到的都是旧 generation；
  成功之后新开始的操作读到的都是新 generation。**正在进行中的操作继续用它开局时的 snapshot 跑完**（见 §3）。
- **G4 每 run 单快照**：一次 sync run 内 hydrate 恰好一次（入口处），此后配置/凭据/storage 实例
  全部由该快照派生，禁止 run 中途再触碰 active。

## 3. publish 中途 × 正在跑的 sync：BACKUP_GLOBAL_LIMITER 关系

### 3.1 这把锁是什么、护什么

- 定义：`src-tauri/src/backup_common.rs:74-75`——`Semaphore::new(1)` 的进程级
  `LazyLock<Arc<Semaphore>>`；用 `OwnedSemaphorePermit` 跨 `.await` 持有。
- 包装：`DataGovernanceOperationGuard::acquire / try_acquire`（`backup_common.rs:136-168`）在 permit 之上
  叠加跨进程文件锁 + 「当前操作」账本（kind/operation_id/started_at）。
- 持锁范围（sync 侧全部入口）：
  - `data_governance_run_sync`：`commands_sync.rs:1625-1628` `try_acquire`，permit 持到命令结束；
  - progress 变体：`:2806-2814` `try_acquire`（拿到锁才发 preparing 事件）；
  - `data_governance_import_sync_data`：`:2482-2493` 带 `SYNC_LOCK_TIMEOUT_SECS=60s` 超时的 `acquire`
    （`data_governance/commands.rs:176`）；
  - 冲突写回 `:4422-4425`、快照回滚 `:5023-5026`：`try_acquire`；
  - `cloud_sync_upload/download/delete_version`（`cloud_storage/mod.rs:322-325、:456-459、:586-589`）：
    经 Guard `try_acquire`。
- 它护的是**数据治理状态**：active slot、业务库写入、远端根的串行化。它从来不护「设置库里的一行
  SSOT + 安全存储里的一条凭据记录」。

### 3.2 谁先持锁？

时序事实（两条 run_sync 路径一致）：**先取配置、后拿锁**——
SSOT 读取 + hydrate 在 `:1567-1589` / `:2741-2769`，permit 在 `:1625` / `:2806`。
因此存在一个窗口：publish 在「sync 已 hydrate、还没拿到 permit」之间落地时，这次 sync 会**持着锁、
用 publish 之前的旧 generation** 跑完。这不是 bug——只要整个 run 用同一个快照，就是我们要的语义；
但审计里应记下该 run 所用的 generation id，否则事后无法解释「为什么 publish 之后那轮 sync 还写了旧根」。

### 3.3 publish 要不要拿 BACKUP_GLOBAL_LIMITER？

**推荐：不拿。**

- publish 不跑备份、不写业务库、不碰 active slot 与远端对象；它写的两条记录各自行级原子
  （`save_setting` 单 key：`cloud_config_commands.rs:512-514`；安全存储单记录：`secure_store.rs:2086-2092`）。
- 若 publish 拿锁：一次 60 秒的 import / 长 sync 会把「保存设置」阻塞或直接 try_acquire 失败，
  设置页保存变成看运气；反过来 publish 持锁期间 auto-sync 撞锁又会制造无意义的 skipped_busy。
  两边都是纯损耗。
- 不拿锁的代价是：**publish 与 sync 可以真并发**，于是必须由 sync 侧的「开局快照」不变量（G4）
  兜底——publish 成功不得让正在跑的 sync 中途换用新凭据/新根。快照之后 active 怎么变，与本次 run 无关。
- publish 自身的原子性（凭据 + SSOT 两段写的单逻辑提交、失败保持旧 generation）由 staged
  generation + active pointer 切换解决（台账 §7），与这把 limiter 无关，**不要**借 limiter 假装事务。
- 唯一需要的新互斥是 **publish 对 publish**：两个设置窗口并发发布用一把独立的轻量锁
  （或 CAS active pointer）解决，不复用 BACKUP_GLOBAL_LIMITER。

### 3.4 真实风险面：hydrate 每次 IPC 读最新 active

`hydrate_cloud_config` 的语义就是「以调用当刻的 active 为准」。逐命令盘点（本轮全量只读）：

| 入口 | hydrate 次数/时机 | run 中途 publish 的暴露 |
| --- | --- | --- |
| `data_governance_run_sync(*_with_progress)` | 入口 1 次（`:1589`/`:2769`），storage 单次 `create_storage`（`:1631`/`:2823`） | **安全**：单快照贯穿整个 run |
| `cloud_sync_upload/download/delete_version`、`commands_zip.rs:150` | 入口 1 次 | 安全（单命令单快照） |
| `cloud_storage_put/get/list/delete/stat/exists/check_connection`（`mod.rs:204-303`） | **每次 IPC 1 次** | **暴露**：前端编排的多步流程（`putFile`/`getFile`，`src/utils/cloudStorageApi.ts:635-667`）跨 IPC 时，publish 落在两次调用之间 ⇒ 同一逻辑操作前半用旧凭据、后半用新凭据 |
| `data_governance_mark_blob_deleted` / `mark_asset_deleted`（`:3884`/`:3918`） | 每条 1 次 | **暴露**：删除传播是前端逐条调用，中途换 generation 会把 tombstone 写进新根、而清单还是旧根读的 |
| `detect_prune_gap`（`:4877`）→ 随后的 run_sync | 各自入口 1 次 | **暴露**：预检查的是 A generation，正式 sync 跑的是 B generation，断层预检结论作废 |

结论：后端**单命令内部**今天已经等价于「命令入口缓存本次 hydrate 结果」；残余风险全部是
**跨 IPC 的前端编排流程**。这是 hydrate-per-IPC 语义的固有属性，publish 一旦存在就会被踩到。

### 3.5 R2 实现时的时序建议

1. sync 入口把顺序调整为 **先拿 permit → 再 snapshot（generation id + SSOT + 凭据）**，
   或至少在拿到 permit 后把入口快照的 generation id 写进审计 details；二选一，推荐前者
   （锁内快照 = 该 run 一定用的是持锁当刻的最新 active，审计无歧义）。
2. 快照后禁止 run 内任何组件再调 `hydrate_cloud_config` / `load_hydrated_cloud_config_ssot`。
   （现状已满足，需要一条源码级测试钉住，防回归。）
3. publish 不拿 BACKUP_GLOBAL_LIMITER，只做 publish-vs-publish 互斥 + generation 单调递增。

## 4. 最小挂钩建议（给实现轮，本轮不落码）

- **4.1 命令入口缓存（后端）**：新代码一律遵循「hydrate 恰好一次于命令入口，快照下传」；
  把 §3.4 表格里「安全」两行的现状固化为约定，写进 `hydrate_cloud_config` 的 doc comment。
- **4.2 generation 回执**：`hydrate_cloud_config` / `load_hydrated_cloud_config_ssot` 附带返回
  active generation id（发布单调递增整数）。
- **4.3 跨 IPC 校验**：多步前端流程（删除传播、put/get 编排）在首个 IPC 拿到 generation id，
  后续每个 IPC 带 `expected_generation`；后端不符即 fail-closed（稳定码建议
  `E_CLOUD_CONFIG_GENERATION_CHANGED`），前端把它归类为「配置已变更，请重新开始本操作」，
  不计入 auto-sync 失败退避。
- **4.4 更彻底的收敛（可选，后于 4.3）**：把逐条 tombstone 循环整体下沉为单个后端命令，
  消灭这一处跨 IPC 编排——一次命令一次快照，4.3 的校验对它退化为免费。

## 5. 本轮为何不落挂钩（一个文件 <40 行做不出健全的钩子）

约束是「只改一个文件、<40 行、不破坏现有 hydrate 调用方」。逐项排除：

1. **generation 计数器**需要在 publish 的唯一提交点自增才健全；今天没有 publish 命令，
   「发布」= 两个文件里的两个写入点（`secure_store.rs` 凭据合并写 + `cloud_config_commands.rs`
   SSOT 保存）。单文件计数器必然漏掉另一半写入，产生**假 generation 不变量**，比没有更糟。
2. **命令入口缓存**的后端半边现状已成立（§3.4），没有可改之处；跨 IPC 半边要么改前端编排
   （多文件/大文件，禁区），要么给后端加带过期语义的会话态（超 40 行且需新 managed state）。
3. 结论：健全挂钩的自然落点是 `cloud_config_publish` 诞生的那一轮（单一提交点 = 单一自增点），
   本轮按任务卡第 4 条选择只写文档。

## 6. 验收清单（给实现轮的红灯测试，源码即可，不必执行）

- draft 测试失败后：active SSOT 与凭据逐字节不变；generation id 不变。
- publish 与 run_sync 并发：run_sync 全程使用开局 generation（可用注入 storage 的行为测试钉）。
- publish 不持有 BACKUP_GLOBAL_LIMITER：sync 持锁期间 publish 仍能成功。
- `expected_generation` 不符时 mark_blob_deleted / mark_asset_deleted fail-closed 且不写入。

## 附：禁改区与越权记录

- 未触碰 `coordinator.rs`、前端大文件；本轮零产品代码改动。
- 只读范围：`backup_common.rs`、`commands_sync.rs`、`cloud_storage/mod.rs`、`secure_store.rs`、
  `cloud_config_commands.rs`、`cloudStorageApi.ts`（引用行号均为本轮核对）。

---

## 7. R6 二检追记：limiter × publish × tombstone × 三把云端租约 × 90s 停滞上限

> 角色：R6「并发窗口」二检。本节为**追加小节**，不改动上文任何结论。
> 落了一个 14 行最小补丁（§7.2，两文件同形，不改协议语义）；其余为文档结论。
> 详报：`/tmp/0824-wave2-r6-reports/08-concurrency.md`。

### 7.1 时间常数全景（本轮逐一核对）

| 原语 | 值 | 出处 |
| --- | --- | --- |
| `BACKUP_GLOBAL_LIMITER` | 进程内 Semaphore(1) | `backup_common.rs:74` |
| 记录级同步租约 `sync_lease` TTL | 600s，心跳 = TTL/3 = 200s | `sync_lease.rs:33、:435` |
| backup-v2 租约 `backup_lease` TTL | 600s，心跳 200s（experimental，零生产调用方） | `backup_lease.rs:46、:452` |
| E2EE 认领租约 TTL | 60s，**无心跳**（一次性写入） | `e2ee_claim.rs:67` |
| provider 单块停滞上限 | 90s/块，**总时长不设限**（慢但有进展不超时） | `traits.rs:89`（`MEMORY_GET_STALL_SECS`）、`webdav.rs:979/:1155`、`s3.rs:742` |

锁序（run_sync）：hydrate（`commands_sync.rs:1576-1589`）→ limiter `try_acquire`（`:1625`）→
format 门（`:1648`）→ sync_target_lease（`:1656`）→ 加密策略（可能触发 60s claim，`:1663`）→
传输（每块 ≤90s 停滞）→ manifest。无反向取锁点，无死锁面；风险全部是**租约过期窗**。

### 7.2 已修（本轮唯一补丁）：过期回收 × 心跳续租的选主竞争窗

`scan_active_leases`（`sync_lease.rs:236-243`、`backup_lease.rs:249-256` 同形）对过期
contender 做「内容比对后删除」（`delete_if_unchanged`），但删除失败（= 读取与删除之间
对象内容已变，典型为**持有者的心跳续租恰好落地**，或本地时钟偏慢误判过期）时原代码
`let _ =` 丢弃返回值并 `continue`——把一把**刚续租、活着的租约**当作不存在，随后照常
写入自己的 contender 并选主成功 ⇒ 两台设备同时持有已提交租约，互斥被破。

该窗口不是纯理论：最坏情形下一次心跳续租链 = GET+PUT+回验 GET ≤ 3×90s = 270s，
心跳间隔 200s，自上一次 `expires_at` 打点起最晚 ~560s 才完成下一次续期，对 600s TTL
只剩 ~40s 裕量；任何一次额外停滞就会让「已过期但持有者仍在续租」真实出现。

修复（+10/−4，两文件）：`delete_if_unchanged` 返回 `false` 时不再 `continue`，该对象
按活跃租约 fail-closed 参与选主（后来者拿到既有 `E_SYNC_LEASE_HELD` / `E_BACKUP_LEASE_HELD`）。
不改对象格式 / key / 错误码 / 回收规则，仅令取锁更保守；持有者已正常释放（对象消失）
导致的误判是可重试的 spurious failure，符合两模块一贯的 fail-closed 准则。
既有测试（`sync_r11_lease.rs`、`sync_r12_backup_lease.rs`）用静态内存存储，读取与删除
之间内容不变，不受影响。本轮未编译未测试（按任务卡），实现轮请补一条「过期对象在
scan 的两次 GET 之间被续租 ⇒ 取锁失败」的注入式红灯测试。

### 7.3 已记录未修 1：E2EE 认领 TTL 60s < 单步停滞上限 90s（数值倒挂）

`e2ee_claim.rs:66` 的注释「认领只有几个小对象往返，60s 足够」忽略了同一 storage 的
单块停滞上限是 90s、且慢而有进展的传输**没有总时长上限**：协议第 3→7 步中任何一步都
可能合法地超过整把租约的寿命。可达序列：A 写租约（TTL 60s）后在第 5/6 步间停滞 ≥60s；
B 回收 A 的过期租约、完成认领并释放；A 恢复后第 6 步 PUT marker **覆盖 B 已发布的
marker**，随后 A 在第 7 步 fail-closed 失败——结果是「B 报成功、云端却是 A 的 marker」。
兜底现状：ZIP 备份路径在发 manifest 前有 `ensure_marker_unchanged_before_publish`
（`sync_manager.rs:974/:1704`）会拒发并回滚；**记录级路径没有对应复验**——
`enforce_record_upload_encryption_policy_for_config`（`commands_sync.rs:67`，调用点
`:1663/:2866/:3929/:3968`）在 claim 成功后即丢弃 marker 期望，后续记录对象与 cursor/
manifest 上传期间 marker 被换掉无人发现。建议（实现轮，超本轮预算）：
① `DEFAULT_E2EE_CLAIM_LEASE_TTL` 提到 ≥ 3×90s+裕量（对象内数据字段，回收规则不变，
兼容旧客户端）；② 记录级路径与 ZIP 路径同样留存 marker 字节并在 manifest 前复验。

### 7.4 已记录未修 2：600s 租约「心跳失败停跳」= 静默失去互斥

`sync_lease.rs:441-452` / `backup_lease.rs:458-469`：心跳任务对**任何**续租失败
（含一次瞬时网络抖动）一律 `break` 永久停跳，只留一行 error 日志「后续远端写入应尽快
结束」，但没有任何机制让操作真的结束：守卫不暴露 lease-lost 标志，run_sync 也不在
manifest 发布前复核租约仍属于自己。停跳后最迟 600s 租约过期，另一台设备合法取锁，
此后**双写者并发写 manifest / 记录对象**（§7.2 补丁只堵「续租成功却被当过期回收」的
误判窗，不覆盖「真过期后被合法接管」）。对慢链路上数小时的首次全量上传，这是最现实的
互斥失效路径。建议（实现轮）：续租失败按错误类别分流——所有权冲突（对象消失 / 被改）
才停跳，网络错误重试到下个心跳周期；并让守卫暴露 `lease_lost`，manifest 发布前检查。
backup_lease 同形同患，但 experimental 零接线（sync_r12 源码锁钉死），风险为潜伏级。

### 7.5 现状复核：R2/R4 建议的采纳情况（limiter × publish × tombstone）

- **publish 不拿 limiter**（§3.3 推荐）：已按推荐落地——`cloud_config_publish`
  （`cloud_config_commands.rs:825-899`）全程不触碰 `BACKUP_GLOBAL_LIMITER`，
  原子性由 staged generation + commit/abort 承担 ✓。
- **先拿 permit 再 snapshot**（§3.5 建议 1）：未采纳，run_sync 仍是先 hydrate
  （`:1576-1589`）后 permit（`:1625`）；G4「每 run 单快照」现状仍成立，属可接受偏差。
  审计 details（`:1612-1618`）仍未记录 generation id（§3.2 提醒未落）。
- **tombstone 串行化**：R4 已把两个直接命令纳入 limiter（`:3920/:3959`，permit 先于
  `create_storage`，覆盖 RMW + 复读闸全程）✓；清单是每设备键
  （`tombstone.rs:70-72`，`mark_*` 只读写 `self.device_id` 的清单），跨设备同键写不存在，
  不持 sync_target_lease 是安全的。
- **`expected_generation` 跨 IPC 校验**（§4.3）：仍未实现。`mark_blob_deleted` /
  `mark_asset_deleted` 每次 IPC 独立 hydrate 最新 active（`:3914/:3955`），前端逐条循环
  中途 publish 换 root 时，已写入旧 root 的 tombstone 条目随旧 root 弃用而丢失。
  删除队列「永不放弃失败条目」只兜住失败重试，不兜「成功写进了错的 root」。
  维持 §4.3/§4.4 结论：优先把逐条循环下沉为单命令。
