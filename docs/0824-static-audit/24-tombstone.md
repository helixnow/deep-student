model=gpt-5.6-sol-xhigh-fast

# Tombstone PUT→GET 三路径复读深审

## 结论

blob、asset、workspace 三条每设备兼容清单路径都确实接入了同一个
`put_tombstone_manifest_and_reread`：PUT 后立即 GET，并对上传时的原始 payload
逐字节比较；GET 缺失、内容不一致和 GET 报错都会让调用返回失败，旧明文设备名对象也只在
复读成功后尝试删除。就“不能只凭 PUT 成功便对调用方报发布成功”这一窄不变量而言，三条路径
均成立。

但这不是事务提交，也不能推出“删除状态未推进”或“兼容清单不会丢项”。三条路径都先发布并
复读 v4 不可变事件，再覆盖 v3 兼容清单；因此兼容清单复读失败时，删除事件可能已经对其他
设备可见。更重要的是：

1. PUT 真正落下损坏对象而 GET 读到不一致时，损坏的新短哈希清单不会回滚或隔离，可能令本机
   后续重试以及其他设备下载持续 fail-closed；
2. 同一 `device_id` 的并发 read-modify-write 没有 CAS/版本前提，存在两个调用都成功、最终
   兼容清单却丢掉一方条目的时序；PUT→GET 只能证明“本次某一时刻读回了这些字节”，不能证明
   它没有随后被覆盖。

所以总体判定是：**三路径接线通过，发布确认有条件通过；损坏对象恢复和同设备并发覆盖仍是
实质缺口。** 本轮不改代码。

## 三条实际路径

### 1. blob

- 入口：`upload_blob_tombstones`（`tombstone.rs:1401-1435`）。
- 先把每个条目映射为 v4 事件，保留 `object_id`、`deleted_at`、`size` 和
  `relative_path`，调用 `publish_events(..., "blobs", ...)`。
- 事件全部返回成功后，刷新 `updated_at`，序列化整个 `BlobTombstones`，再只调用一次
  `codec.encode`。
- 最终键是
  `data_governance/tombstones/blobs/{device_id_short_hash}.json`
  （`:525-530`）；编码后的同一份 payload 被传给复读 helper（`:1427-1432`）。
- 只有 helper 返回成功，才进入旧明文设备名对象的尽力删除（`:1433-1434`）。

### 2. asset

- 入口：`upload_asset_tombstones`（`:1438-1471`）。
- 顺序与 blob 相同；事件保留 `size`，`relative_path` 固定为 `None`
  （`:1444-1462`）。
- 最终键是
  `data_governance/tombstones/assets/{device_id_short_hash}.json`
  （`:541-546`）。
- `updated_at`、序列化、编码、PUT→GET、旧路径删除依次位于
  `:1463-1470`。

### 3. workspace

- 入口：`upload_workspace_tombstones`（`:1474-1504`）。
- 顺序仍相同；workspace 事件没有 `size` 和 `relative_path`
  （`:1480-1491`）。
- 最终键是
  `data_governance/tombstones/workspaces/{device_id_short_hash}.json`
  （`:557-562`）。
- `updated_at`、序列化、编码、PUT→GET、旧路径删除依次位于
  `:1492-1503`。

三者只有事件字段和对象前缀不同，发布闸没有分叉，因此 helper 本身的修复会同时覆盖三条
路径；反过来，helper 的缺陷也会同时影响三条路径。

## 复读闸究竟证明什么

`put_tombstone_manifest_and_reread`（`:594-616`）的状态机很窄：

1. `storage.put(key, payload)` 报错：返回“上传失败”；
2. PUT 成功后 `storage.get(key)`：
   - `Some(read_back)` 且与 `payload` 完全相等：成功；
   - `Some(...)` 但不同：返回“上传后回读不一致”；
   - `None`：返回“上传后对象不存在”；
   - GET 报错：返回“上传后回读失败”。

比较对象是**编码后的原始字节**，不是解码后 JSON。这里做法正确：加密启用时
`encode_payload` 会产生 DSBK 容器，但每条路径都只编码一次，再将同一 `Vec<u8>` 同时用于
PUT 和比较，因此随机 nonce 不会制造假不一致；密文的任一字节变化也会被挡住。

该闸能证明的是：这次 GET 返回了与本次 PUT 输入相同的完整字节。它不能证明：

- 远端对象在 GET 之后仍保持该版本；
- 同 key 没有并发写者；
- v4 事件和 v3 兼容清单构成原子提交；
- 失败后远端已恢复到先前的健康版本。

## 双写顺序与部分提交

三条路径都先 `publish_events(...).await?`，后写兼容清单。单个事件自身又经
`put_event_verified`（`:302-350`）执行 PUT 后 GET、解码、结构相等和
`payload_hash` 校验。由此得到的真实失败边界是：

| 失败点 | 已可能可见的状态 | 调用结果 |
|---|---|---|
| 事件循环中途 | 前缀事件已发布，后续事件未发布；兼容清单未写 | 失败 |
| 兼容清单 PUT | 全部事件已发布；旧兼容清单通常仍在 | 失败 |
| 兼容清单 GET 缺失/报错/不一致 | 全部事件已发布；新 key 状态取决于后端 | 失败 |
| 复读成功、旧路径删除失败 | 事件和新清单已发布；新旧清单并存 | 成功并告警 |

因此“复读失败不得报成功”准确；“复读失败时删除没有推进”不准确。v4 事件是当前更强的主
协议，失败后的重复发布依靠 operation id/事件内容核验走幂等路径。这种先主协议、后兼容
投影的顺序偏向不丢删除意图，但对调用方呈现的是安全的部分提交，不是零提交。

## 缺口一：损坏新对象会卡住重试

现有不一致回归使用 `CorruptTombstoneManifestPut` 把兼容清单实际写成
`corrupted-tombstone-manifest`（`:1975-2000`）。测试明确断言：

- 上传返回“回读不一致”（`:2048-2075`）；
- 损坏的最终对象仍保留（`:2076-2083`）；
- 旧明文名清单未删除（`:2085-2088`）。

“保留旧清单”并不能自动恢复读取：

- 本机 `download_*_tombstones_for_device` 都先读短哈希 key；只要它存在，就不会回退旧
  明文 key（`:573-591`，以及 blob `:1084-1097`、asset `:1238-1251`、workspace
  `:1382-1397`）。若短哈希对象不可解密或不是合法 JSON，重试会在读取旧状态时先失败，
  根本到不了再次 PUT。
- 全局下载按“legacy 共享清单 → 每设备兼容清单 → v4 事件”处理；任一短哈希清单解码失败
  会在读取事件前返回错误（blob `:946-994`、asset `:1100-1148`、workspace
  `:1254-1297`）。所以已经成功发布的不可变事件不能绕过这个损坏兼容对象。
- 批量删除队列只在上传成功后删行，失败会增加 `retry_count` 并保留待重试项
  （`commands_sync.rs:437-462,545-570,635-663`）。这能保住本地意图，却不能打破
  “每次重试先读同一个损坏短哈希清单”的循环。

这是 fail-closed 的可用性死锁，而不是静默数据丢失；但它可能阻断三类文件同步，需人工移除
坏对象或增加受并发保护的恢复协议。简单地在不一致后无条件 DELETE 也不安全：不一致可能是
并发写者刚写入的健康新版本，无条件删除会误删赢家。

## 缺口二：同设备并发覆盖不受复读保护

六个 `mark_*_deleted/deletions` 都执行“下载本设备整份清单 → 本地插入条目 → 覆盖上传”
（`sync/mod.rs:11717-11882`），没有条件 PUT、ETag 比较或清单版本号。完整同步入口虽然使用
`BACKUP_GLOBAL_LIMITER`（`commands_sync.rs:1622-1628,2803-2814`），但单条 blob/asset
Tauri 命令直接新建 manager 后调用 `mark_*_deleted`，没有获取该锁
（`:3875-3900,3910-3934`）。

因此存在以下合法时序：

1. 调用 A、B 同时读到基础清单 M；
2. A 生成 M+A，B 生成 M+B；两边不可变事件均成功；
3. A PUT M+A，随后 GET M+A，返回成功；
4. B PUT M+B，随后 GET M+B，也返回成功；
5. 最终兼容清单只有 M+B，A 的 v3 投影丢失。

两次复读都没有撒谎，却没有检测 lost update。v4 客户端仍可从不可变事件看到 A 和 B，风险
主要落在兼容读取方及迁移期语义；如果并发交错为 A PUT、B PUT、A GET，A 会得到显式
不一致，这只是另一种时序，并不能消除上面的“双成功”时序。

## 后端边界

- WebDAV/S3 的内存 `get()` 会在有声明长度时拒绝短读，再由 tombstone helper 做全字节相等
  比较（`traits.rs:81-103`，`webdav.rs:1219-1254`，`s3.rs:797-843`）。
- FTP 的 `put()` 使用临时名上传后 rename，`get()` 先取 SIZE，再按 SIZE 拒绝短流
  （`ftp.rs:328-347,814-907`），因此对半包的底层防线更强。
- helper 本身没有语义级重试或等待可见性。若某兼容后端在 PUT 返回后短暂读到旧版本，立即
  GET 会安全地报假阴性；不会误报成功，但会放大暂态失败。生产后端的真实 read-after-write
  行为仍需供应商集成验证，静态代码不能证明。

## 测试证据与盲区

- 正向证据：blob 的“回读不一致”和“PUT 后缺失”有异步回归
  （`tombstone.rs:2048-2122`），且不一致用例验证旧路径不会提前删除。
- 三路径所谓源码守卫 `per_device_tombstone_manifests_reread_after_put`
  （`:2027-2045`）只对整个源文件执行字符串 `contains`。helper 名出现在函数定义里，三个
  label 也出现在测试断言自身；即使将生产调用移除，该测试仍可能通过，不能证明控制流接线。
- 没有 asset/workspace 的动态不一致用例，没有 GET 报错用例，也没有“坏对象后下一轮重试
  能恢复”的用例。
- 没有同设备双写交错测试，也没有 WebDAV/S3/FTP 真实后端的 PUT→GET 一致性测试。

当前共同 helper 降低了三条路径行为漂移的概率，但测试强度尚不足以把“当前确实接线”提升为
可抗重构的长期契约。
