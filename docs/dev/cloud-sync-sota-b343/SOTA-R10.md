# SOTA-R10 — R09 合入后的市面对照（我们已有 / 诚实差距 / 不该学）

- 代理：R10-sota；模型：`claude-fable-5-thinking-high`（用户要求 xhigh，该 slug 当前不可用，明示降级，非静默）。
- 基线：`origin/cursor/cloud-sync-sota-b343` @ `25519c0c`（2026-08-24 检出，隔离 worktree）。
- 性质：只读对照，不改业务代码。行号/文件锚点以上述 commit 为准。
- 对照对象：Joplin / AnkiWeb（Anki 同步）/ Syncthing / restic / rclone / Nextcloud / Seafile / Dropbox / OneDrive / Standard Notes。
- 与 [SOTA-R07](./SOTA-R07.md) 的关系：R07 版写于文件级 E2EE 合入前。本版基于 R09 五路（文件级 E2EE / names / android 换机测 / WebDAV 续传 / 人话错误）**已合入**的事实重打分，R07 的 GAP-1（文件级明文）、GAP-3（文件名无检测）、GAP-4（记录级上传不校验密码）、GAP-5（Android 未实测）四个当年最大缺口已经关闭或大幅收窄。

## 0. 结论（TL;DR）

R09 合入后，本仓库在**E2EE 覆盖面**上完成了从"文本面加密、文件面明文"到"全对象 DSBK 密文"的跨越（`sync/mod.rs` 文件级对象上传统一走透明 DSBK 包装，明文哈希内容寻址不变），加上 R06/R07 的密码校验子（ZIP 与记录级上传双路径）、R09 的跨平台文件名净化与 WebDAV 下载续传，此前 SOTA-R07 判定"未达"的七个维度里已有四个翻为"已达"。

剩余诚实差距集中在五件事，均已写入 [ROUND-11](./ROUND-11.md) 排期：

1. **增量/去重**：每次云备份仍传整 ZIP，restic/Seafile/Dropbox 均块级——这是流量与时长上两个数量级的差距（长期最大缺口）。
2. **时点恢复**：ZIP 10 版是整机粒度，单条记录被错误批量覆盖后无法回退；Dropbox Rewind / Nextcloud 版本历史无对应物。
3. **仓库巡检**：无 restic `check` 等价物——坏对象要等恢复/下载时才被发现。
4. **文件名可逆性**：R09-names 是**有损净化 + 冲突人话**（OneDrive/Syncthing 档），还不是 rclone encoding 层的可逆映射档。
5. **多客户端写锁**：对"新旧版本客户端同时写同一 root"仅有 `remote_format_version` 门槛，无 Joplin 式 sync target 租约。

另有两项取决于 R10 在飞路的交付：cloud-only 冲突「保留本地」（P1-1，R10-conflict-ui）与 Argon2 参数上限钳制（R10-verifier）。本文按"未交付"保守打分。

## 1. R09 后的基线事实（证据锚点）

写对照前先钉死我们自己现在到底有什么。以下全部在 `25519c0c` 可验证：

| 能力 | 状态 | 锚点 |
|---|---|---|
| 文件级 E2EE（blobs / workspace db / 资产对象） | ✅ 已合 | `sync/mod.rs` 文件级对象上传统一透明 DSBK 包装（提交 `41c309e3`）；集成回归 `tests/sync_file_level_e2ee.rs`、`tests/sync_r09_file_e2ee.rs`（含"云端对象必须是 DSBK 密文"断言与旧明文对象迁移测） |
| 会话级文件加密器 | ✅ 已合 | `crypto/backup_crypto.rs`：一次 Argon2 派生、跨对象复用密钥，规避逐对象数百毫秒 KDF 成本 |
| 密码校验子（ZIP + 记录级上传双路径） | ✅ 已合 | `.encryption-marker` v2 携带不可逆校验子，v1 一次性升级、v2 缺校验子 fail-closed（`sync_manager.rs` L28–115、L485+）；记录级四个上传入口全部走 `enforce_record_upload_encryption_policy_for_config`（R09-e2ee 审计结论，见 [FIX-QUEUE](./FIX-QUEUE.md)）——SOTA-R07 GAP-4 已关 |
| 跨平台文件名净化 | ✅ 已合（有损档） | `sync/asset_filenames.rs`：`sanitize_segment` / `sanitize_rel_path` / `casefold_key` + 四类冲突人话消息（本地重复 / 大小写冲突 / 上传占用 / 影子分歧）；接线 `sync_asset_directories`；全边界测 `tests/sync_r09_filenames.rs` |
| Android 换机闭环 | ✅ 已合（宿主机测试档） | `tests/sync_android_device_switch.rs`：Android 拒 FTP/S3 四路径、仅 WebDAV 换机闭环（进程内假服务器 + 加密上传/下载/密码门禁/B 槽/重启切换/两段式租约）、device_id 恢复后轮换；`PlatformStorageCapabilities` 测试钩子 |
| 云 ZIP 下载断点续传 | ✅ 已合（WebDAV only） | `traits.rs` `supports_resumable_download` / `get_file_resumable`（默认 fail-closed，禁止整包重下冒充续传）；`webdav.rs` HTTP Range（206 校验起点、200 诚实从零、错位 fail-closed）；`sync_manager.rs` `.part` 断点编排 + 整文件 SHA256 兜底；S3/FTP 诚实走整文件 |
| 无密码导入早失败 | ✅ 已合 | `backup/zip_export.rs` `precheck_sealed_payload_password`，解压任何条目之前失败 |
| 引擎错误人话 | ✅ 已合 | `SyncTab.tsx` `classifySyncError`（明文遗留拒收 / 密码缺失 / 错密码），`syncE2eeErrorMapping.ts`，zh/en `sync.json` `errors.*`；原始错误保留为技术详情 |
| 自动同步（默认关） | ✅ 已合 | `SyncSettingsSection.tsx` `useAutoSyncStore`（默认 `false`），R07-autosync——SOTA-R07 GAP-2 已关（最小档） |
| 列表截断 fail-closed | ✅ 已合（R02 起） | `ListOutcome.truncated` 契约，S3 无 token 报错、FTP 200 目录上限、WebDAV 750/751/1000/1001 启发式 |
| A/B 槽换机 + device_id 轮换 | ✅ 已合（R01 前即有，历轮加固） | `commands_restore.rs` 下载→SHA256→解密→非活动槽→原子 cutover→重启；restore journal 幂等 |
| cloud-only 冲突「保留本地」 | ❌ 仍开（P1-1） | R10-conflict-ui 在飞；`RecordConflictsPanel.tsx` 批量 keep_local 对无本地侧的对不生效 |
| Argon2 参数上限钳制 | ❌ 仍开 | 解密侧信任 DSBK 头内 argon2_params，恶意大参数可 DoS；R10-verifier 在飞 |

## 2. 逐家对照（我们已有 / 诚实差距 / 不该学）

### 2.1 Joplin

- **我们已有**：E2EE 覆盖含附件——R09 后资产对象/blob 全 DSBK，与 Joplin"笔记+资源都加密"打平且我们多一层密码校验子（Joplin 允许错密码设备产出第二套主密钥密文共存，我们直接拒写）；冲突不丢数据（冲突表双侧保留 + 字段级合并 vs 其整条笔记进 Conflicts 文件夹，粒度更细）；自动同步（R07 起有，默认关）；列表截断防线（Joplin 依赖 provider 列表正确性，坚果云截断有真实丢同步先例，我们 fail-closed）；A/B 槽整机换机（Joplin 重装需全量重拉且设置不随 E2EE 走）。
- **诚实差距**：**sync target 锁**——Joplin 2.x 的 lock 文件机制防"新旧客户端同时写同一 root 的升级踩踏"，我们只有 `remote_format_version/min_reader_version` 静态门槛，两个同版本客户端并发全量上传仍靠 per-device manifest 缩窄而非租约互斥（换机恢复路径有两段式租约，常规同步路径没有）；同步频率档位——Joplin 有 5min–1h 多档定时，我们自动同步档位单薄。
- **不该学**：多主密钥并存模型（错密码设备产出并存密文是事故温床，我们校验子 fail-fast 是更优解，勿为"灵活性"倒退）；Joplin 把设置排除在 E2EE 同步外的做法（我们整包 ZIP 含配置，换机语义更完整）。

### 2.2 AnkiWeb（Anki 同步）

- **我们已有**：冲突语义整层级领先——AnkiWeb schema 变更强迫用户"全量上传或全量下载二选一"（选错整侧丢失），我们记录级合并 + 冲突表 + 隔离区 + 单侧 DELETE 可解；E2EE（AnkiWeb 无，服务器可读全部卡片）；自托管任意 dumb storage（AnkiWeb 专用协议，自托管要跑 anki-sync-server）；换机（我们 WebDAV 拉最新版 + A/B 槽 ≈ 其登录即拉全量，且我们有 device_id 轮换处理恢复后身份悖论）。
- **诚实差距**：**同步耗时与流量**——Anki 增量协议 + 服务端合并比我们"全 ZIP 或全变更包"轻得多，大库日常同步体验有实感差距（归入增量/去重长期缺口）；开合应用即同步的顺滑度——我们自动同步是最小档，无"退出时自动推"钩子。
- **不该学**：中心化"整库二选一"冲突模型（数据丢失级 UX，是我们全部冲突投资的反面教材）；无 E2EE 的服务端可读设计。

### 2.3 Syncthing

- **我们已有**：文件名冲突检测——R09-names 后我们对 Windows 非法名/保留名做净化、对大小写冲突给四类人话消息，达到 Syncthing"显式检测报错"档；冲突双侧保留；E2EE 语义更完整（Syncthing 常规节点明文，receive-encrypted 仅覆盖不受信节点且元数据裁剪有限，我们全对象 DSBK + 校验子）；结构化记录合并（Syncthing 对 SQLite 只能整文件冲突，这是我们产品定位的护城河）；版本可回退（Syncthing 删除会传播、无备份版本概念，我们 10 版保留 + A/B 槽）。
- **诚实差距**：**即时性**——watch + 块级即时传播是自动同步维度天花板，我们最小档自动同步不在一个量级（但见"不该学"）；**块级增量传输**（归入增量/去重）；净化是有损单向的，Syncthing 至少保留原名报错让用户改，我们改名后云端 key 与本地原名的映射只靠净化函数的确定性，无逆映射表。
- **不该学**：P2P 全网状拓扑（我们 dumb-storage 单 root 假设是部署优势，引入设备互联会摧毁"任意 WebDAV 就能用"的卖点）；把删除即时传播到所有节点的默认行为（学习数据场景下误删即全网丢，我们 tombstone + 冲突表 + 版本保留的保守语义更对）。

### 2.4 restic

- **我们已有**：错密码 fail-fast（校验子 ≈ 开仓校验）；保留策略（10 版 prune、先发布 manifest 再 GC）；**E2EE 无明文例外**——R09 后启用加密时全对象密文，restic"无部分覆盖"的核心批评已不成立；校验和全链路 + 下载续传整文件 SHA256 兜底。
- **诚实差距**：**内容定义分块去重**——10GB 库日备份流量差两个数量级，这是对 restic 的最大也是唯一结构性差距（GAP-7 存续）；**`check` 巡检**——我们无主动遍历云端对象验完整性的命令，坏对象要等用到才发现；**append-only 防勒索模式**——我们的 provider 凭据都是全读写；`.encryption-marker` 可删攻击面 restic 不存在（无明文模式），我们"本地曾加密位"双源仍在 R10-verifier 在飞（GAP-6 收窄中）。
- **不该学**：纯 CLI、无恢复编排的交付形态（我们 A/B 槽 + 重启预告 + 人话错误是面向终端用户的必需品）；restic 仓库格式的强耦合（我们对象布局刻意保持"敌意 provider 也能懂"的简单性，manifest+objects 可被人工检修）。

### 2.5 rclone

- **我们已有**：列表分页正确性与重试退避（S3 token 死循环防护、WebDAV 423/429/5xx + Retry-After 封顶、Range 续传——rclone 有的传输可靠性件我们逐一补齐了）；E2EE 密码一致性校验（rclone crypt 配错密码静默产出第二套密文树，我们校验子拒绝——这一点我们**更强**）；应用级语义（bisync 无结构化合并、无隔离区，中断需 `--resync` 人工介入）。
- **诚实差距**：**encoding 层可逆映射**——rclone 按 provider 把非法字符映射成安全码点再还原，是文件名维度事实 SOTA；R09-names 的有损净化 + 冲突检测只到 OneDrive 档，"两个原名净化后同 key"要靠冲突消息兜底而非无损共存；**crypt 文件名加密**——我们资产对象 key 是内容哈希（好），但 ZIP 备份的 `backups/<version>.zip` 命名仍暴露设备短 ID 与时间戳元数据；provider 广度（70+ vs 3，不追，见下）。
- **不该学**：provider 广度竞赛（WebDAV/S3/FTP 已覆盖自托管主流，Android 补 S3 feature 比加第 4 家 provider 价值高一个量级）；rclone 的配置复杂度（数百 flag 是工具属性，产品不该外露）。

### 2.6 Nextcloud

- **我们已有**：E2EE 实用性反超（Nextcloud E2EE 插件 folder 级、恢复脆弱、口碑长期不佳；我们全对象 + 校验子 + 错密码解锁指南）；非法文件名治理（R09-names ≈ 其服务端 4.x 的 Windows 兼容名检测档）；不依赖自建服务端（任意 dumb storage）；列表截断在敌意 provider 假设下更稳。
- **诚实差距**：**服务端版本历史 + 回收站**——任意文件时点回退是 Nextcloud 核心安全网，我们记录级同步无时点恢复、ZIP 只有整机粒度（GAP-8 存续，ROUND-11 排最小版）；持续自动同步的成熟度（桌面客户端 watch + 即时推）。
- **不该学**：服务端组件模式（要用户维护一台 PHP 服务器是我们刻意规避的部署负担，dumb-storage 假设是列表截断等防损投资的意义所在）；E2EE 作为事后插件的架构（密钥管理与主同步链路割裂导致其恢复故事脆弱——我们加密在协议层内生，勿学）。

### 2.7 Seafile

- **我们已有**：错密码 fail-fast（其加密库 magic 校验 ≈ 我们校验子）；元数据泄露面更小（Seafile 加密库**文件/目录名服务端可见**，我们记录级清单加密、资产清单在启用加密时同样密文、对象 key 是内容哈希）；内容维度 R09 后打平（其客户端加密文件内容 ≈ 我们 DSBK 全对象）；任意 provider。
- **诚实差距**：**CDC 分块去重 + 库历史快照**——时点回溯任意文件 + 增量传输的组合仍是结构性差距（与 restic/Nextcloud 条目合并为 ROUND-11 的 delta 与 history 两路）。
- **不该学**：绑定自家服务端与私有块存储格式（同 Nextcloud 理由）；加密库不加密文件名的折中（我们已经比它好，勿倒退）。

### 2.8 Dropbox

- **我们已有**：冲突不丢数据（conflicted copy 心智 ≈ 我们冲突副本/冲突表）；传输可靠性（重试/校验和/续传链路达标）；**E2EE**（Dropbox 服务端可读，我们用户持钥——结构性更强）；文件名问题的用户提示（R09-names 四类人话消息进同步结果，接近其"文件未同步"提示档，但见差距）。
- **诚实差距**：**Rewind 整账户时点回退**——换机之外的第二张安全网，我们没有（GAP-8）；**未同步文件的专项 UI 清单**——我们的净化冲突与 `download_failures` 进结果消息与审计日志，但无一个常驻面板列出"哪些文件云端有而本地没有/反之"（ROUND-11 排 UI 一路）；块级增量。
- **不该学**：无用户持钥 E2EE 的商业模式（数据主权是我们卖点）；把删除文件默认 30 天后永久清除的服务端策略作为唯一安全网（我们本地 A/B 槽 + 云端 10 版是用户可控的，勿把安全网外包给 provider）。

### 2.9 OneDrive

- **我们已有**：非法文件名前置拦截——R09-names 上传路径净化 + 冲突拒绝，达到 OneDrive"写入前拦截并引导"档（我们是自动净化 + 人话解释，交互略不同但不再是"等下载失败才知道"）；冲突"保留两者"；E2EE 用户持钥 vs Personal Vault 微软持钥；A/B 槽 + device_id 轮换的换机语义完整性。
- **诚实差距**：版本历史（按文件粒度回退，同 Dropbox/Nextcloud 条目）；Files On-Demand 式占位符（本地不落盘、按需拉取——对我们 blob 大库有真实价值，但属长期路线图，不进 ROUND-11）。
- **不该学**：Office 实时协同合并（OT/CRDT 超出 backup-style 定位，R01 起历轮确认不做）；把 E2EE 局限在一个"保险库文件夹"的产品切分（全或无的加密开关 + 诚实披露比"部分保险库"心智负担小）。

### 2.10 Standard Notes

- **我们已有**：加密算法同代（AES-256-GCM + Argon2id vs XChaCha20-Poly1305 + Argon2id）；**E2EE 无例外覆盖**——R09 后启用加密时笔记、清单、blob、资产、workspace db 全密文，SN"附件也加密"的标杆优势已被追平；冲突零丢失；错密码不可能污染（其认证密钥派生 ≈ 我们双路径校验子）；本地整机备份纵深（A/B 槽、分层导出、DSBK 便携包——SN 无对应物）。
- **诚实差距**：**变更即推的自动同步**（我们最小档 vs 其每次编辑即同步）；**密钥轮换协议**——SN 有版本化的原地轮换，我们换密码 = 换云端根目录全量重传（ROUND-11 排调研）；Argon2 参数钳制——SN 客户端对 KDF 参数有硬边界，我们解密侧还没有（R10-verifier 在飞）。
- **不该学**：强制账号 + 自家服务端优先的架构（自托管 SN 服务端门槛高，我们任意 WebDAV 即用）；单一数据模型（SN 万物皆 item 的模型无法承载我们多库结构化合并的需求）。

## 3. 对照矩阵（速览，R07 → R10 变化）

| 维度 | R07 判定 | R10 判定（@25519c0c） | 变化原因 |
|---|---|---|---|
| E2EE 覆盖 | 未达（文件级明文） | **已达**（全对象 DSBK + 双路径校验子；对照 restic/SN 不再有覆盖面差距） | R07-asset-e2ee + R07-record-verifier 合入 |
| 多设备冲突 | 已达，结构化合并更强 | 已达（同前）；**P1-1 cloud-only「保留本地」仍开**，交付前不改判 | R10-conflict-ui 在飞 |
| 列表截断 | 已达，敌意 provider 下更强 | 已达（无回退） | — |
| 错密码 | ZIP 已达、记录级未达（GAP-4） | **双路径已达**；剩 Argon2 参数钳制与标记可删双源两个收尾 | 记录级四入口审计通过；R10-verifier 在飞 |
| 跨平台文件名 | 未达（无检测） | **部分达**（OneDrive/Syncthing 检测档；距 rclone 可逆映射档一档） | R09-names 合入 |
| 自动同步 | 未达（零自动） | **最小档已达**（默认关、可选启）；距 SN 变更即推/Syncthing watch 仍有档差 | R07-autosync 合入 |
| 换机恢复 | 已达；Android 未实测 | **已达且 Android 有宿主机闭环测**；真机/模拟器仍未跑 | R09-android 合入 |
| 增量/去重 | 未达（GAP-7） | 未达（无变化，长期最大缺口） | 路线图 → ROUND-11 调研路 |
| 时点恢复 | 未达（GAP-8） | 未达（无变化） | ROUND-11 排最小版 |
| 仓库巡检 | （R07 未单列） | 未达（无 restic check 等价物） | ROUND-11 新列 |

## 4. 明确不建议追赶的方向（历轮结论 + 本轮新增）

- **实时协作/OT/CRDT**：backup-style 定位，历轮确认不做。
- **provider 广度竞赛**：三家已覆盖自托管主流；Android 补 S3 feature 优先级更高。
- **服务端组件**（Nextcloud/Seafile/SN 自托管服务端式）：dumb-storage 假设是部署优势与防损投资的前提。
- **本轮新增——P2P 拓扑与删除即时传播**（Syncthing 式）：与学习数据的保守语义冲突。
- **本轮新增——部分保险库式 E2EE 切分**（OneDrive Personal Vault 式）：全或无 + 诚实披露的心智模型更优。
- **本轮新增——Files On-Demand 占位符**：有真实价值但属独立大工程，不进近两轮。

## 5. 与 R10 在飞任务及 ROUND-11 的关系

- 本文 §1 两个"仍开"项（P1-1 冲突 UI、Argon2 钳制）分属 R10-conflict-ui / R10-verifier，不重复认领；其交付后 §3 对应行改判。
- §2 各"诚实差距"已汇总为 [ROUND-11](./ROUND-11.md) 十路大包：巡检（restic check 档）、时点恢复最小版、增量/去重调研、文件名可逆映射、未同步清单 UI、sync target 租约、密钥轮换调研、备份命名元数据泄露收敛、自动同步档位、Android 真机手册。
- R09-restore-ops 已交付 WebDAV 续传与解锁指南，R10-download / R10-verifier 按 FIX-QUEUE"只收增量"约定执行,本文不再列为差距。

## 6. 收尾回写（父代理，后继 HEAD）

本节不改写上面基于 `25519c0c` 的正文，只标注其后继已交付因而过时的差距：

| 原文差距 | 现状态 | 证据 |
|---|---|---|
| §1 P1-1 cloud-only「保留本地」 | **已关** | R10-conflict-ui；单条/批量可达 + 两击确认 |
| §1 Argon2 参数上限 | **已关** | `backup_crypto.rs` `KDF_MAX_*` |
| §0 / §3 仓库巡检 | **已合（下载全量档）** | `repo_check.rs`；DSBK v2 头偏移已修 |
| §0 / §2.5 文件名可逆 | **已合** | R11-names2 rclone 风格可逆映射 |
| §0 / §2.1 sync-target 租约 | **已合** | `sync_lease.rs` + `E_SYNC_LEASE_HELD` |
| §0 / §3 增量/去重 | **积木已合，生产未接线** | 整 ZIP 仍整对象 PUT；不能宣称增量 |
| §3 时点恢复 | **记录级 history 已合** | ZIP 仍是整机粒度 |
| 云整包便携/全保真混淆 | **UI/协议已关一截** | 导入后看 `recovery_kind`；云端 `recoveryKind`；已知便携包下载前拒绝 |
| §2.5 ZIP 备份名暴露时间/设备 | **阶段一已合（R12-neutral-names）** | 新对象 22 位随机 ID；`manifests/<短哈希>.json`；新标记 `createdByDevice` 短哈希；旧时间戳名与旧清单文件名仍按 id 读写 |
| §2.5 记录级路径明文 device_id | **阶段二已合（R12-record-path-names）** | 新写入短哈希目录；旧 `changes/<device_id>/` 与旧清单名双读；新旧前缀并成同一 seq 流；本机短哈希对象不当成外设备。tombstone 清单/事件前缀同改；水位按内容完整 `device_id`；文件级 `file_manifests/` 与快照新写入改为 UUID 对象名，不再编码时间或设备；旧明文/短哈希目录仍可读 |

**生产放量仍 NO-GO。** 最短剩余：完整 CI 绿灯、Android 真机签字、整包增量传输接线或对外文案继续诚实到底。
