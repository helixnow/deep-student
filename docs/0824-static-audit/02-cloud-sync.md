model=gpt-5.6-sol-xhigh-fast
# 云同步 / E2EE / ZIP 恢复静态审计

- 审计基座：`2d41ea8b`
- 审计对象：云同步大改写 #177、tombstone 发布后复读、WebDAV `decode_path`、S3 `normalize_endpoint`、FTP 550/501 白名单、E2EE、ZIP restore fail-closed
- 源枝：`cursor/cloud-sync-sota-b343`，远端只读查询确认 tip 为 `89808fd8a5470e03eb2383ee6375c81b90f10d28`
- 映射终点：`89808fd8` → `172fd10d`
- 方法：只读 Git 谱系、`git cherry`、stable `patch-id`、目标树逐路径复核；未修改产品代码

## 结论

**PASS。**

#177 截至源 tip `89808fd8` 的 14 个源提交均已有 patch 等价的产品落点；14/14 stable
`patch-id` 一致，14/14 落点都是基座 `2d41ea8b` 的祖先。映射终点
`172fd10d` 对基座执行 `git cherry -v` 无输出，未发现 #177 新的独特产品 patch。
要求核对的 tombstone 发布后复读、WebDAV 解码、S3 endpoint 归一化、FTP
550/501 严格白名单、E2EE 防降级与 ZIP 恢复 fail-closed 均在基座树中。

无需产品修复，也不回放任何已移植 SHA。**本轮不改代码。**

## 谱系与 patch 等价性

### `git cherry`

- `git cherry -v 2d41ea8b 172fd10d`：空输出（0 行）。
- 当前本地可见的 `origin/cursor/cloud-sync-sota-b343` 曾 rewind 到
  `4e28168c`；`git cherry -v 2d41ea8b origin/cursor/cloud-sync-sota-b343`
  同样为空，且该 ref 是基座祖先。不能用这个已回退的本地 ref 冒充远端当前 tip。
- 远端当前 tip `89808fd8` 的对象未写入本地 object store；因此以远端只读 patch
  与本地产品落点逐对计算 stable `patch-id`，再检查全部落点的祖先关系。

### 14 个源 patch 均已等价落地

| 源提交 | 产品落点 | stable patch-id（两侧一致） |
| --- | --- | --- |
| `ef3c104d` | `4bebbf81` | `d558fc11b6d34f8b8ceae19854754f7ab23e0dcd` |
| `8eb675ce` | `394851a7` | `f60a2baec4213d925e6e3a823858d0e682ae67de` |
| `75f12160` | `587cfccd` | `fad5429ceabf35677f7a432cb04fb8be7558ccf3` |
| `f39f0d3a` | `af414ed6` | `aa09b34bf575efcfefc4c85bfaeb9de55e2babfc` |
| `0fcbc59b` | `947910db` | `6e780854157647cdaa7d0f26f563ca35eb83c75e` |
| `bb81e9d6` | `06f32d0e` | `9e687cfae0f1e339033e805bd58429e589974772` |
| `86a1e7c4` | `6887bf84` | `737252b686f950d018f80d4325fddcffaf732389` |
| `6d6769bc` | `bf8ab827` | `461e1e5b7a8f443e116ca0d265f91377f96f8d63` |
| `f7efe4e5` | `8c8b79bd` | `ed1eaed2d831f26ae6fc6b8853557d7904d9c49c` |
| `405ad31f` | `aa2a6744` | `b91228da35a64e675958acf8b30853f3ebc00b54` |
| `a439433a` | `42696414` | `9782f6c4bd3884071cdf4a0fc2fbddd19b83f485` |
| `519fb9d2` | `72660bf4` | `24185293390a9cfbabe3eeee4317a950936099e1` |
| `edd5672d` | `957fe6d7` | `6c5869c5df95bf4e4356e4d9926dd497b524d518` |
| `89808fd8` | `172fd10d` | `20bfcef3f2791cf319a19c842596957237fb7941` |

基座内 14 个产品落点的祖先检查结果为 `mapped_ancestors=14 missing=0`。
其中最后两项分别补 S3 陈旧 multipart 清理，以及 WebDAV/S3 内存对象 GET 的
90 秒逐块停滞超时；不存在需要再摘取的源提交。

### #177 之后的产品加固也已进入基座

以下直接产品提交均为 `2d41ea8b` 祖先：

| 产品提交 | 审计意义 |
| --- | --- |
| `17f8cdba` | marker 缺失但已有旧 DSBK 备份时，先试解验证密码再登记 v2 marker |
| `1df0ec6a` | 恢复路径、ZIP 输出/解压目标与 A/B 切槽 fail-closed |
| `6cfabf67` | 便携/部分归档导入成功后不再弹出整槽恢复提示 |
| `d7fb7677` | ZIP 拒绝检查格式整理，无语义回退 |
| `1119f9be` | fail-closed 移植后的无用 import 清理，无语义回退 |
| `a4057892` | 自动同步持久化 hydration 对旧快照安全补默认值 |

工作树的 `src/`、`src-tauri/` 与基座产品树无差异。

## 分项审计

### 1. Tombstone 解析、传播与发布后复读：PASS

- `src-tauri/src/data_governance/sync/mod.rs:11453-11464` 明确从未过滤的 asset
  manifest 解析物理 `object_key`；`12126-12133` 在应用 tombstone 前调用该路径。
- `sync/mod.rs:12184-12192` 对内容寻址资产检查活跃引用，避免共享对象被单个逻辑
  key 的删除误删；`9857-9863` 钉住内容寻址 key 的识别。
- `src-tauri/src/data_governance/sync/tombstone.rs:594-616` 在 `put` 后立即 `get`
  并逐字节比较；缺失、内容不一致或 GET 错误均返回失败，不得报发布成功。
- 同一 helper 已接入 blob、asset、workspace 三类每设备清单
  （`tombstone.rs:1430-1434,1466-1470,1495-1500`）。
- `tombstone.rs:2027-2032` 有源码守卫，`2048` 起有回读不一致的异步回归。

判定：发布确认不是只信 PUT，短写不能推进删除状态；旧路径迁移只在新清单复读成功
之后进行。

### 2. WebDAV `decode_path` 与内存对象 GET：PASS

- `src-tauri/src/cloud_storage/webdav.rs:176-208` 构造 URL 时先解码 endpoint
  path segment，再交 URL API 单次编码，避免中文、空格路径被双重编码。
- `webdav.rs:596-620` 的 `decode_path` 让 PROPFIND href 与 base path 在同一
  解码空间比较；非法解码保持原字符串，不发生破坏性猜测。
- 非 ASCII、`%20`、绝对/相对 href 的回归位于
  `webdav.rs:1995-2066`；源码契约位于 `2144-2153`。
- #177 最后映射提交已在 `webdav.rs:1233-1254` 将 manifest/change shard 所用
  内存对象 GET 改为 90 秒逐块停滞超时，并在有声明长度时拒绝短体。

判定：坚果云中文/空格 endpoint 不会因编码空间不一致静默列空；响应头成功但 body
半挂死也不会无限等待。

### 3. S3 `normalize_endpoint`、multipart 与内存对象 GET：PASS

- `src-tauri/src/cloud_storage/s3.rs:67-119` 仅对已知供应商
  `{bucket}.{service-host}` 形式剥离重复 bucket 前缀；空 bucket、解析失败、自建
  endpoint 保持保守。
- `s3.rs:122-143` 明列已知 COS/OSS/S4 服务域名形状；path-style 不猜改，
  对应回归见 `s3.rs:1201` 起。
- `s3.rs:260-324` 只清理同 key、超过 6 小时且有 `Initiated` 的陈旧 multipart；
  list/abort 失败不阻断当前上传。调用发生在创建新 multipart 前
  （`s3.rs:450-464`）。
- `s3.rs:800-832` 对内存对象 GET 使用 90 秒逐块停滞超时，并按
  `content_length` 拒绝短体。

判定：控制台复制出的 bucket 前缀 endpoint 可被识别，同时不扩大到自建/path-style
误改；陈旧上传清理和 GET 完整性门均在。

### 4. FTP 550/501 白名单：PASS

- `src-tauri/src/cloud_storage/ftp.rs:239-265` 先解析三位 FTP 状态码。
- `ftp.rs:267-287` 只有状态码为 550/501，且消息明确包含 no-such、
  not-retrievable、does-not-exist 或 file/directory-not-found 语义时，才归为
  not-found。
- `ftp.rs:289-313` 对父目录 CWD 同样 fail-closed；歧义 550、权限拒绝与策略拒绝
  不会被当作“已不存在”。
- 正/负回归位于 `ftp.rs:1284-1382`：无状态码宽泛 `not found`、permission
  denied、`Failed to change directory`、非白名单 450 均不得放行。

判定：白名单存在且是“状态码 + 明确缺失语义”双门，不是宽松吞错。

### 5. E2EE 防降级与 marker 复读：PASS

- `src-tauri/src/cloud_storage/sync_manager.rs:566-599` 将损坏 marker 保守视作存在；
  `601-615` 写 marker 后 GET 逐字节复读。
- `sync_manager.rs:638-735` 在写任何 backup 对象前验证密码校验子；错密码、未知
  KDF、v2 缺 verifier、损坏 marker 全部 fail-closed。
- `sync_manager.rs:738-844` 对 marker 缺失或 v1 无 verifier 的旧仓库先下载既有
  备份并完整试解；验证失败保持旧 marker 原样。该闭环由产品提交 `17f8cdba`
  补齐，避免把误输密码固化成新基准。
- `src-tauri/src/data_governance/sync/mod.rs:825-950` 记录级与文件级对象共用
  `FileCipherSession`，加密端遇到明文遗留或加密 root 缺本机密码时拒绝混布。
- `src-tauri/src/crypto/backup_crypto.rs:21-52,549-657` 对来自不可信容器的 Argon2
  参数先做应用级上限检查，会话析构时 zeroize 密钥材料与密码。
- `src-tauri/src/data_governance/commands_zip.rs:75-113` 在启用 stored E2EE 却读不到
  密码时拒绝导出，且短密码不被降级成便携包；`116-135` 只在 ZIP 确有密封载荷时
  套用已存密码。
- `src-tauri/src/secure_store.rs:1909-1919,2062-2067` 按 Unicode 码点执行最短
  8 字符门槛，并在写安全存储前拒绝短密码。

判定：marker 发布、旧仓升级、记录/文件对象和全保真 ZIP 均没有可见的静默明文
降级路径。

### 6. ZIP restore fail-closed：PASS

- `src-tauri/src/data_governance/backup/zip_export.rs:1735-1779` 在改动目标目录前验证
  ZIP 与密封载荷密码；`1815-1820` 使用 `enclosed_name` 拒绝越界路径。
- `zip_export.rs:665-732` 要求解压根为普通目录，并逐路径拒绝 symlink；
  `1830-1889` 的续传仅跳过同大小普通非 DB 文件，实际写入走原子提取。
- `src-tauri/src/data_governance/backup/mod.rs:1061-1128` 的
  `validate_for_slot_restore` 拒绝旧版无 coverage、增量、仍密封、partial、
  key policy 不明确或 crypto coverage 不完整的归档。
- `src-tauri/src/data_governance/commands_restore.rs:459-472` 在整槽写入前再次执行
  manifest 门禁；`641-677` 在清槽和写数据库前要求 A/B manager 与磁盘预算；
  `834-956` 对任一数据库或资产恢复错误停止，不发布切槽。
- 前端不是安全边界，但已减少误导：`src/utils/cloudStorageApi.ts:26-38` 识别
  `partial_archive` / `restorable: false`；Dashboard 在
  `src/features/settings/components/DataGovernanceDashboard.tsx:883-897` 抑制恢复
  提示；云恢复在 `CloudStorageSection.tsx:1032-1071,1108-1119` 于确认前和导入后
  各拦一次，旧 stats 缺失时仍交由后端稳定错误码兜底。

判定：不可信路径、便携/部分归档、密码缺失、磁盘预算失败、非原子切槽环境及部分
恢复错误均不能被报告为整槽恢复成功。

## 发布口径与验证边界

- 本轮是静态审计，没有重新运行真实 WebDAV/S3/FTP 服务、Android 真机或全量 CI。
  既有落地记录在 `docs/0824-MERGE-PLAN.md:786-835`：Step 17 的 typecheck、Vite、
  `cargo check`、tombstone 定向测试和 18/18 不变量均通过。
- 不应把现状描述成已经接线的增量云备份：backup-v2 delta 原语仍未接生产上传链；
  当前生产备份仍是整 ZIP 对象。
- Android 当前只承诺 WebDAV；FTP 恢复、巡检和文件级下载仍整包重下；这些是已声明
  的能力边界，不构成本次静态不变量失败。
- 真实供应商兼容与灾难恢复放量仍需要外部凭据/真机/CI 证据；本报告不把静态源码
  存在性冒充线上演练。

## 处置

- #177：无新独特 patch，保持现状。
- 产品加固：全部已在基座，保持现状。
- 已移植 SHA：不回放、不 reset、不整枝 merge。
- 产品修复：无。
- **本轮不改代码。**
