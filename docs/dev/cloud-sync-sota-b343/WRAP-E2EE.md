# E2EE 收尾核对（`3d0a74db`）

## 结论

本轮未发现需阻断交付的 P0/P1，未改生产代码。三条指定安全不变量在当前基线均成立：

1. 云端可控 Argon2 参数的所有派生汇入 `crypto/backup_crypto.rs::derive_key`，其首个执行步骤是 `ensure_kdf_params_within_app_limits`；
2. 本机已记住某云 root 曾经加密后，即使 `.encryption-marker` 被删除，ZIP 与记录级同步的明文上传策略入口仍会拒绝；
3. `FileCipherSession` 不存在绕过 KDF 上限或明文降级的可达路径。

## 核对证据

### KDF 上限

- `derive_key` 在构造 `argon2::Params`、分配派生内存和调用 `hash_password_into` 前先执行应用级上限检查。
- 校验子复算、DSBK v1/v2 密码解密、`FileCipherSession::with_params` 和会话缓存未命中派生均调用该入口。
- 全仓另一个同名函数 `secure_store.rs::derive_key` 是对本机随机种子做固定 SHA-256 的本地设备密钥派生，不接收云端 KDF 参数，不属于本项攻击面。

### 删除标记后的明文门禁

- 成功登记/校验加密标记，以及明文尝试读到既有标记时，都会按 `instance_binding_hint` 指纹调用 `EncryptedRootMemory::remember`。
- `ensure_plaintext_upload_allowed` 在云端标记缺失后继续查询 `was_encrypted`；命中或记忆文件损坏均 fail-closed。
- bool 策略与带密码策略的明文分支都汇入该检查；ZIP 上传命令及记录级四个写入口均在写业务对象前执行策略检查。
- 既有 `sync_r10_verifier.rs` 已覆盖“登记 → 删除标记 → 同进程/重启后拒明文”、bool 入口、root 隔离和补记忆路径。

### FileCipherSession 无旁路

- 会话自身 `(salt, params, key)` 只能由 `with_params` 经 `derive_key` 成功后构造。
- 解密缓存只能在缓存未命中且 `derive_key` 成功后写入；因此自身 key 命中和缓存命中都只可能复用已通过应用上限的参数组合。
- 原始 with-key / key-provider 函数均为模块私有；公开的 bytes/file 加解密入口无法注入未校验 key。
- 记录 payload 和 workspace/VFS/资产文件均通过会话入口；加密失败只跳过/报错，不回退上传明文。

## 非 P0/P1 的边界

- 本机记忆是第二道、本机范围防线；全新设备在云端标记也已被删除时无法推断该 root 的历史加密状态。
- 记忆持久化失败目前只告警、不阻断当次加密操作；云端标记仍是第一道防线。若后续要把本机记忆提升为强事务保证，应让“标记写入 + 本机记忆落盘”共同成功后再放行业务上传。
- `CloudSyncManager::upload*` 与底层 `cloud_storage_put` 是可写的低层 API，策略由现有应用命令在调用前执行。当前产品调用链无绕过；后续若新增调用方，应优先把受保护 namespace 的策略收口到写 API，避免依赖调用纪律。

## 验证

- 静态核对：`derive_key`/Argon2 全仓入口、`FileCipherSession` 构造与缓存、ZIP/记录级上传入口、文件级 DSBK 包装及明文防降级路径。
- 尝试目标测试：`cargo test --test sync_r10_verifier`、`cargo test crypto::backup_crypto::tests::session_ --lib`。
- 两次命令均未进入项目测试：首次构建时 GUI 开发库尚未就绪；库就绪后，Rust 1.88 仍无法编译基线依赖 `rusqlite 0.40.1` / `libsqlite3-sys 0.38.1` 多处使用的 `cfg_select!`。曾以仅作用于本机 Cargo registry 的等价 `#[cfg]` 改写跨过 `libsqlite3-sys` 构建脚本，随后在 `rusqlite` 库本体同因失败。该临时环境改写未进入仓库；本轮不把“未执行断言”误报为测试通过。
