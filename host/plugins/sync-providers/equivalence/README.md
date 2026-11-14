# sync-providers 等价语料：本地云边界服务（WP-046）

WAVE0 A/B 双后端逐场景差分用的确定性、可重置本地 WebDAV / S3 边界服务，加上 `cloud.scenarios.json`（WAVE0 §3 v0）。
这个服务只存字节、按协议应答，不计算任何同步/业务结果，也不是 B 后端。A（Rust）的实际结果是 oracle。

| 文件 | 内容 |
| --- | --- |
| `__fixtures__/cloud-service.ts` | 服务本体：进程内 API + CLI（HTTP 层复用 `tests/fake_dav.ts`、`tests/fake_s3.ts`） |
| `__tests__/cloud-service.test.ts` | 自测：用生产 `WebDavStorage` / `S3Storage`（AWS SDK）客户端连服务，并做场景文件结构检查 |
| `cloud.scenarios.json` | 22 个场景，8 条命令（WP-046 的 16 个 + WP-240 补的 delete/stat/exists 错误分支 6 个） |
| `cloud-sync.scenarios.json` | WP-240：16 个场景，7 条同步管理命令（G3 分母 768 内）+ 3 条外层命令（见下方“同步管理命令”） |

## 用法

进程内：

```ts
import { startCloudService } from './__fixtures__/cloud-service.ts';
const cloud = await startCloudService({ seed: 'basic' }); // 端口默认 0（随机），数据目录默认 mkdtemp
cloud.reset(scenario.cloud.seed);                          // 每个场景前：恢复种子、逻辑时钟、计数器，清空故障和请求日志
cloud.setFaults(scenario.cloud.faults ?? []);
const steps = cloud.resolve(scenario.steps);               // 替换 ${cloud.webdav.endpoint} / ${cloud.s3.endpoint}
// ...驱动 A 或 B...
cloud.requests();                                          // 本次场景的边界请求记录（可作附加证据）
await cloud.stop();                                        // 释放全部端口，删除私有数据目录
```

进程外 CLI（Node 26 直接运行 .ts；Electron 下加 `ELECTRON_RUN_AS_NODE=1`）：

```sh
node --experimental-strip-types host/plugins/sync-providers/equivalence/__fixtures__/cloud-service.ts \
  [--seed basic] [--webdav-port N] [--s3-port N] [--control-port N] [--data-dir DIR] [--keep-data-dir] [--no-stdin]
```

- stdout 第一行：`{"webdav","s3","control","dataDir","seed","seeds","pid"}`。
- 收到 SIGTERM / SIGINT / stdin EOF 时输出 `{"stopped":true,"requests":[...]}`，然后 exit 0。
- 控制面（JSON）：`GET /__cloud/state`、`POST /__cloud/reset {seed?}`、`POST /__cloud/faults {faults}`、`GET /__cloud/requests`。
- 请求记录同时追加写到 `<dataDir>/requests.jsonl`。

隔离与清理：只绑定 127.0.0.1。每个实例有独立端口和独立数据目录。`stop()` 和进程 `exit` 都会删除服务自建的数据目录；传入 `--data-dir` 或 `--keep-data-dir` 时保留。

## 确定性

- 状态全部在内存里，种子写入顺序按 UTF-8 字节序。
- 时间来自逻辑时钟：从 `2021-01-01T00:00:00Z` 起，每次写（种子对象、PUT、CompleteMultipartUpload、CreateMultipartUpload）+1s，WebDAV 和 S3 共用一个时钟。
- ETag 是 MD5，multipart ETag 是 `md5(parts)-N`；uploadId 为 `wave0-upload-N`，`x-amz-request-id` 为 `wave0-<seq>`；ListObjectsV2 的 continuation token 是上一页末 key 的 base64url。
- 同种子的两个实例收到相同请求序列时，应答、`requests()`、`snapshot()` 逐字节相同（自测 `gives two same-seed instances…` 验证）。
- 唯一的非逻辑字段是 Node HTTP 自动加的 `Date` 响应头。WebDAV 客户端不读它；AWS SDK 只用它做时钟偏差校正。

种子：`empty`；`basic`（WebDAV 目录 `wave0/docs` + `a.txt`=alpha、`b.txt`=bravo，S3 同名两个对象）；`s3-paged`（`wave0/paged/p0..p4.txt`，服务端每页最多 2 个 key）。

故障 `CloudFault`：按 `service` + 可选 `method` + 可选 `pathIncludes`（解码后的路径子串）匹配，消耗 `times` 次（默认 1），应答为指定 `{status, headers?, body?}` 或 `'reset'`（直接断开连接）。

## 配置注入

两个后端的 `cloud_storage_*` 都不信任 IPC 传入的 config：先用已发布的 SSOT 整体替换，再从安全存储补 secret（Rust `cloud_credentials.rs:127 hydrate_cloud_config`；B `index.ts:112` → L21 `ctx.backup.hydrateCloudConfig`）。所以每个场景的第 0 步是 `cloud_config_publish`，后续步骤的 `config` 只是前端会发出的形状。

```ts
const { publish, runtime } = cloud.config('webdav'); // 或 's3'，root 默认 'wave0'
await invoke('cloud_config_publish', publish);
// publish = { config: {provider:'webdav', webdav:{endpoint, username}, root:'wave0'},
//             credentials: {webdavPassword:'wave0-pass'}, encryptionPasswordIsPreexisting:false }
await invoke('cloud_storage_put', { config: runtime, key: 'docs/c.txt', data: [...bytes] });
// runtime = { provider:'webdav', webdav:{endpoint, username, password:''}, root:'wave0' }
```

`publish.config` 不含任何 secret，因为 Rust `SafeWebDavConfig` / `SafeS3Config` 设置了 `deny_unknown_fields`（`cloud_config_commands.rs:48-65`）。S3 只支持 path-style（`pathStyle: true`）。

## 命令与来源

| 命令 | owner | 前端调用点 | Rust 入口 |
| --- | --- | --- | --- |
| `cloud_config_publish` | F4-security（B：`host/platform/errors/cloud-config-commands.ts`） | `src/utils/cloudStorageApi.ts:511` | `src-tauri/src/cloud_config_commands.rs:28` → `dstu-sync/src/cloud_config_commands.rs:832` |
| `cloud_storage_check_connection` | L23 | `cloudStorageApi.ts:716` | `dstu-sync/src/cloud_storage/mod.rs:298` |
| `cloud_storage_put` | L23 | `cloudStorageApi.ts:729` | `mod.rs:310` |
| `cloud_storage_get` | L23 | `cloudStorageApi.ts:748` | `mod.rs:323` |
| `cloud_storage_list` | L23 | `cloudStorageApi.ts:766` | `mod.rs:335` |
| `cloud_storage_delete` | L23 | `cloudStorageApi.ts:783` | `mod.rs:347` |
| `cloud_storage_stat` | L23 | `cloudStorageApi.ts:800` | `mod.rs:359` |
| `cloud_storage_exists` | L23 | `cloudStorageApi.ts:817` | `mod.rs:371` |

协议语义来源：`cloud_storage/webdav.rs`（重试 `request_with_path:454`，可重试状态 423/500/502/503/504 `:306`，429 和限流型 503 不重试 `:179`；`check_connection:1074`，`put:1616`，`get:1640`，`list:1688`，`delete:1751`，`stat:1765`）和 `cloud_storage/s3.rs`（SDK 标准重试，checksum WhenRequired `:202`，path-style `:217`；`check_connection:414`，`put:877`，`get:892` NoSuchKey→None，`list:952`，`delete:1025`，`stat:1039`）。

## 分支覆盖

`expect: "error"` 只是注释，比对以 A 的实际结果为准。

| 命令 | 成功场景 | 错误 / 提前返回场景 |
| --- | --- | --- |
| `cloud_config_publish` | 全部已发布场景第 0 步（发布不做连接测试，错误凭据也能发布，见 `*.auth_denied`） | 它自己的错误分支（短加密口令、凭据为空、非法配置）属于 F4，不在本包 |
| `check_connection` | `*.roundtrip` | `*.auth_denied`（401 / InvalidAccessKeyId），`*.unpublished`（SSOT 未配置，hydrate 回落默认配置后校验失败） |
| `put` | `*.roundtrip`，`*.retry_then_success`（503 一次后成功） | `*.server_error`（507），`*.auth_denied` |
| `get` | `*.roundtrip`，`*.retry_then_success`（连接重置后成功），`*.retry_exhausted` 第 2 步 | `*.missing`（→ null），`*.retry_exhausted`（500×3），`webdav.rate_limited`（429 不重试），`*.auth_denied`，`*.unpublished` |
| `stat` | `*.roundtrip`，`*.object_errors`（故障耗尽后再查） | `*.missing`（→ null），`*.object_errors`（WebDAV PROPFIND 403 / S3 HEAD 403），`*.object_auth_denied`，`*.object_unpublished` |
| `exists` | `*.roundtrip`（true，删除后 false），`*.object_errors` | `*.missing`（false），`*.object_errors`（同 stat，`traits.rs:399` exists=stat.is_some），`*.object_auth_denied`，`*.object_unpublished` |
| `list` | `*.roundtrip`，`s3.list_paged`（3 页 continuation） | `*.missing`（空数组），`*.server_error`（PROPFIND / ListObjectsV2 403） |
| `delete` | `*.roundtrip`，`*.object_errors` 末步 | `*.missing`（WebDAV 404 / S3 204，均视为成功），`*.object_errors`（DELETE 403 `webdav.rs:1751` 非 2xx/404 → Err；`webdav.object_errors` 另有 500×3 重试耗尽），`*.object_auth_denied`，`*.object_unpublished` |

未覆盖，原因如下：

- `create_storage` 里的 `缺少 WebDAV/S3 配置`、endpoint/用户名为空、公网 HTTP 未授权：发布时 `validate_and_normalize` 已拒绝，hydrate 后无法到达；唯一可达的是未发布路径（`*.unpublished`）。
- S3 未编译（`S3_UNSUPPORTED_IN_BUILD_CODE`）和 Android 上的 FTP：需要不同构建或平台。
- FTP provider：不在本服务范围内。
- multipart（≥16 MiB）和 Range 续传下载：服务已实现，但场景里的备份对象都是几十字节，`cloud_sync_upload` / `cloud_sync_download` 只走单次 PUT/GET；大对象需要场景能引用 ≥16 MiB 本地文件，待 X7 runner 支持文件型输入后再补。

## 同步管理命令（WP-240，`cloud-sync.scenarios.json`）

7 条命令都在 G3 分母 768 内。Rust 入口全在 `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs`，管理器逻辑在 `sync_manager.rs`；B 入口 `host/plugins/sync-providers/index.ts:220-291`。

| 命令 | 前端调用点 | Rust 入口 |
| --- | --- | --- |
| `cloud_sync_get_status` | `src/utils/cloudStorageApi.ts:838` | `mod.rs:384` → `sync_manager.rs:823` |
| `cloud_sync_list_versions` | `cloudStorageApi.ts:851` | `mod.rs:396` → `sync_manager.rs:869` |
| `cloud_sync_upload` | `cloudStorageApi.ts:870` | `mod.rs:410` → `sync_manager.rs:1574` |
| `cloud_sync_download` | `cloudStorageApi.ts:898` | `mod.rs:552` → `sync_manager.rs:1737` |
| `cloud_sync_delete_version` | `cloudStorageApi.ts:917` | `mod.rs:714` → `sync_manager.rs:1885` |
| `cloud_sync_get_device_id` | `cloudStorageApi.ts:931` | `mod.rs:731` → `dstu-storage/src/data_space/device_id.rs:205` |
| `cloud_storage_is_s3_enabled` | `cloudStorageApi.ts:1029` | `mod.rs:737` |

外层命令（不属于本包计分，只用来串联前置状态）：

| 命令 | owner | 用途 |
| --- | --- | --- |
| `cloud_config_publish` | F4-security | 第 0 步发布配置（同上文“配置注入”） |
| `cloud_storage_put` / `list` / `exists` | L23 | 往云端写旧版 `manifest.json`、`backups/<id>.zip`、`.encryption-marker` 等前置对象；事后核对 `backups/` 和标记 |
| `get_app_data_dir` | F2-shell（B：`electron/index.ts:86` 返回 `ctx.app.dataDir`） | 给 `cloud_sync_download` 的 `localDir`、`cloud_sync_upload` 的 `zipPath` 提供真实绝对路径。前端 `CloudStorageSection.tsx:1079` 用 `${appDataDir}/backups/cloud-downloads`；runner 的 `${n.path}` 必须占满整个值，不能拼接子目录，所以场景直接用 `${n}`（应用数据目录本身） |

前置对象：旧客户端写的 `manifest.json`（`CloudManifest` v1，两个版本 `w0-legacy-v2`/`w0-legacy-v1`，checksum 为对象字节的 SHA-256，deviceId `wave0-other-device`）。上传用的本地 ZIP 是先下载得到的 `${n.localPath}`，所以每个上传场景都是“下载 → 上传 → 列表/删除”的真实链路，不需要预置本地文件。

| 命令 | 成功场景 | 错误 / 提前返回场景 |
| --- | --- | --- |
| `get_status` | `webdav.no_versions`（0 版本），`*.lifecycle`（种子前后、上传后、删除后），`webdav.corrupt_manifest`（`Ok` 但 `error` = “读取 manifest 失败”，`sync_manager.rs:848`），`*.auth_denied`（`Ok`，`connected:false`，`sync_manager.rs:857`），`webdav.list_server_error` | `*.unpublished`（`create_storage` 失败，`mod.rs:390`） |
| `list_versions` | `webdav.no_versions`（空），`*.lifecycle`，`webdav.e2ee_roundtrip`，`webdav.invalid_inputs`，`webdav.delete_version_gc_failure`，`webdav.marker_write_failure`，`webdav.list_server_error` 末步 | `webdav.corrupt_manifest`（JSON 损坏无 .bak `sync_manager.rs:711-715`；checksum 非法 `sync_manager.rs:470`），`*.auth_denied`，`*.unpublished`，`webdav.list_server_error`（`manifests/` PROPFIND 403，`sync_manager.rs:685`） |
| `download` | `*.lifecycle`（latest=null 与指定 id），`webdav.e2ee_roundtrip`（明文旧版、DSBK 解密、opt-in 明文历史），`webdav.corrupt_marker`（opt-in） | `webdav.no_versions` / `invalid_inputs`（未找到版本 `sync_manager.rs:1760`），`invalid_inputs`（`../escape`、空串 → `validate_version_id:431`），`e2ee_roundtrip`（防降级拒收 `mod.rs:160`；口令错 WRONG_PASSWORD `mod.rs:688`），`encrypted_object_password`（无口令 PASSWORD_REQUIRED `mod.rs:669`；DSBK 头但密文无效 → 解密失败），`corrupt_marker`（损坏标记按存在处理），`*.auth_denied`，`*.unpublished`，`corrupt_manifest` |
| `upload` | `*.lifecycle`（明文），`webdav.e2ee_roundtrip`（首次加密上传登记标记），`webdav.delete_version_gc_failure` | `invalid_inputs`（zipPath 不存在 `sync_manager.rs:1584`），`e2ee_roundtrip`（换口令 → 校验子不匹配），`corrupt_marker`（无口令 → PLAINTEXT_LEGACY_REJECTED `sync_manager.rs:1490`；有口令 → 损坏标记 fail-closed），`marker_write_failure`（`.encryption-marker` PUT 507），`*.auth_denied`，`*.unpublished` |
| `delete_version` | `*.lifecycle`（删除刚上传的版本，`backups/` 对象随之 GC），`webdav.delete_version_gc_failure`（对象 DELETE 403 只记 warn，仍 `Ok`，`sync_manager.rs:1905-1912`） | `webdav.no_versions`、`invalid_inputs`（不存在 `sync_manager.rs:1894`；`bad/id` 非法 ID；`w0-legacy-v1` 只在旧共享 manifest、不在本设备 manifest → 版本不存在），`*.auth_denied`，`*.unpublished` |
| `get_device_id` | `identity_and_capabilities`（连续两次，验证同进程稳定） | 无可达错误：签名 `-> String`，持久化失败也回落进程内稳定 ID（`device_id.rs:220-232`） |
| `is_s3_enabled` | `identity_and_capabilities` | 无可达错误：`-> bool`，`cfg!(feature)`；值取决于构建 feature，A/B 都应为同一构建口径 |

未覆盖及理由：

- `DataGovernanceOperationGuard::try_acquire` 冲突（upload/download/delete 互斥）：场景步骤串行，没有并发入口。
- 上传大小 >10 GB（`sync_manager.rs:1589`）、上传后远端大小不一致 / 对象消失（`sync_manager.rs:1620-1632`）、provider 返回非法 SHA-256：需要 10 GB 文件或服务端静默短写，本服务的故障模型（按请求应答状态码/断开）做不到。
- 下载对象过短 `<4` 字节（`mod.rs:638`）：校验和在此之前已比对，manifest 写短对象必须伴随正确 checksum；可以写，但与“DSBK 头密文无效”属同一下游分支，暂不单列。
- manifest 列表被截断（`sync_manager.rs:689`）：WebDAV 不截断，S3 需要 >1000 个 manifest 对象。
- S3 未编译构建（`is_s3_enabled=false`）：需要另一套构建。

normalize 候选（未经 A1/A2 双录，未生效）：

- `cloud_sync_get_device_id` 结果及所有 `deviceId`：未设 `DEVICE_ID` 环境变量时为随机生成。建议 runner 给 A/B 注入同一个 `DEVICE_ID`，而不是事后抹掉。
- 上传返回的 `version.id`（22 位随机）、`version.timestamp`、`get_status.lastSyncTime`、`manifests/<短哈希>.json` 键名：随机 ID / 墙钟时间，跨步骤引用一致性必须保留。
- `get_app_data_dir` 结果及 `localPath`：每次运行的临时数据目录。
- `cloud-sync-progress` 事件里的 `operationId` 和中间进度条数（取决于 chunk 回调次数）。

### cloud_sync_get_device_id / cloud_storage_is_s3_enabled 不写错误场景的理由（WP-277）

两条命令都没有前端可达的 `Err` 或提前返回，所以不加 `expect: "error"` 场景（成功路径由 `identity_and_capabilities` 覆盖）：

- 共同前提：两者都是同步命令，无参数、无 `State`/`AppHandle` 注入（契约 `contracts/ipc/L23-sync-providers.json` 中 `args: []`、`injected: []`），返回值不是 `Result`。没有可反序列化的参数，多余键会被忽略；没有 `State` 提取，恢复启动模式下也不会出现 `state not managed` 错误。`src-tauri/src/lib.rs:2238-2239` 在唯一的 `generate_handler!`（`lib.rs:1908`）里无条件注册，没有 `#[cfg]`；ACL 已放行（`src-tauri/permissions/application-commands.toml:203`、`:209`）。返回的 `String` / `bool` 序列化不会失败。
- `cloud_sync_get_device_id` → 无可达 Err（`dstu-sync/src/cloud_storage/mod.rs:731-734`）：函数体只有 `get_device_id()`，签名 `-> String`。`get_device_id`（`dstu-storage/src/data_space/device_id.rs:205-233`）先取 `DEVICE_ID` 环境变量，再取进程级兜底 ID，最后调用 `resolve_or_create_device_id`（`device_id.rs:122-188`）。后者所有 IO 失败都被吞掉：读文件用 `read_to_string(..).ok()?`（`:77`）返回 `None`；迁移写失败只记 `warn!`（`:148-152`）；新 ID 写失败或数据目录未初始化只记 `error!` 并返回 `persisted: false`（`:164-183`），由 `get_device_id` 回落到进程内稳定的临时 ID（`:220-232`）。`Uuid::new_v4().to_string()[..8]`（`:162`）的源串固定 36 字节，切片不会 panic；`normalize_device_id`（`:13-28`）对任意输入都返回值。
- `cloud_storage_is_s3_enabled` → 无可达 Err（`dstu-sync/src/cloud_storage/mod.rs:737-740`）：函数体只有 `cfg!(feature = "cloud_storage_s3")`，签名 `-> bool`，编译期常量。默认构建为 `true`（`src-tauri/Cargo.toml:596`、`dstu-sync/Cargo.toml:73`）。

## 已知限制

- S3 不校验 SigV4 签名，只从 `Credential=` 作用域核对 access key（所以 S3 的鉴权错误场景用错误的 access key，而不是错误的 secret）。只支持 path-style；delimiter/start-after、CopyObject、ListBuckets、aws-chunked 上传都返回 501。
- A 和 B 必须各连一个独立实例（或在两次运行之间 `reset`）。服务没有按客户端隔离状态。
- `cloud_config_publish` 会写系统安全存储。无桌面会话的 Linux 上 keyring 可能不可用，此时 A 的发布会失败，场景无法运行。这是运行环境问题，不是服务问题。

## 需要 X7 确认 / 实现

1. 场景级扩展字段 `cloud: {seed, faults?}`（类似 X5 的 `llm`）：runner 每个场景前对该场景用到的实例执行 `reset(seed)` + `setFaults(faults)`，并对 steps 执行 `resolve()`。顶层 `seed` 仍是 `empty`（应用数据目录）。
2. normalize 现为 `[]`。候选（未经 A 双录，未生效）：发布结果和 DB 里的 `endpoint` 端口（runner 注入的临时端口，类似 X5 的 llm-origin 规则）；错误消息中的端口。
3. `requests()` 记录可作为 A/B 附加证据：两个后端对同一场景发出的边界请求序列（方法、路径、重试次数）应一致；它不是 §3 capture 的一部分，是否纳入比对由 X7/C2 决定。
