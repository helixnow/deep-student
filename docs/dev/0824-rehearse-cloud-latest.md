# 0824 预演（重做）：最新 #177 tip 直接合入统一分支

日期：2026-08-24  
预演分支：`cursor/0824-rehearse-cloud-latest-cde6`（**不回推 0824 本身**）  
基座：`origin/cursor/0824-cde6` @ `e54603a0`（已含 E optimization #213 + C generative-ui #214 + H theme-cache #175/#183）  
被合方：`origin/cursor/cloud-sync-sota-b343` @ `bcd61eec` = **PR #177 最新 tip**

## 0. 为什么重做

上一轮预演（`cursor/0824-rehearse-cloud-cde6`，见 `0824-rehearse-cloud.md`）合的是
theme-cloud 快照 `493c4c74`，其 #177 底座停在 `5440d582`。最新 tip 在其后又走了
**44 个提交**：R12 delta backup-v2 原语族（format codec / inventory / lease /
delta-upload / delta-restore / two-pass GC，均 unwired）、#169 根因修复自行吸收
（`06e82848`）、E2EE 存储密码下全保真 ZIP 导出（`bcd61eec`）、Android 文案矫正、
CI vitest heap 修复、license notices 刷新（`8de4b63d`）等。旧预演的冲突结论与
#169 判定因此过期，本轮以最新 tip 重新走一遍。

合并提交：`4adefd9d`，165 文件，约 +46932 / −1216。后续提交：
`a949558b`（#174 移植）、`44c714c1`（notices 重新生成）、`fa289618`（0824 基座
自带编译破损修复）。

## 1. 冲突实况（2 处，比旧预演多 1 处）

1. **`.github/workflows/ci.yml` rust-test-build env**（与旧预演相同）：
   HEAD 的 `RUSTC_WRAPPER: sccache` + `SCCACHE_GHA_ENABLED`（#213）vs tip 的
   `CARGO_BUILD_JOBS: '3'`（R07-archive OOM 缓解）。语义互补，**全保留**。
2. **`public/legal/THIRD_PARTY_NOTICES.txt` modify/delete**（新出现）：
   0824 侧 `d248cbab`（#213 WI-9 legal 去重）把唯一权威路径移到
   `legal/THIRD_PARTY_NOTICES.txt` 并删除 public 副本（避免随 frontendDist
   双份进安装包）；tip 侧 `8de4b63d` 在旧路径刷新内容（Cargo 新增
   `unicode-normalization@0.1.25`）。**解法：保持删除 public 副本，合并后在新
   路径 `npm run licenses:generate` 重新生成**——notices 头部有 Cargo.lock
   SHA256 门禁（`licenses:check`），tip 改了 Cargo.lock 后不重生成必红。
   不要机械恢复 public 副本。旧预演没有此冲突，因 theme-cloud 快照早于 tip
   的 notices 刷新提交。

热点四文件 `ftp.rs` / `s3.rs` / `webdav.rs` / `cloudStorageApi.ts` 本轮依旧
**全部单侧、自动干净合并**（0824 仍未合 A wrapup #268）。正式合入若 A 先进，
这四个文件将双侧冲突，解法原则不变：#177 大改写为底座，#169/#174 行为
（下文 §2、§3）逐条核对存活。

## 2. #169 行为核对：**已在 tip，且被加固，无需移植**

| #169 行为（旧 doc §2 清单） | 最新 tip 状态 |
|---|---|
| 1. tombstone 应用处用未过滤清单解析物理 object_key（`download_assets_manifest_before_tombstones`） | ✅ tip 自行移植（`06e82848`，与 #169 头提交同标题），调用点在 `sync_asset_directories_with_tombstones_and_progress` |
| 2. 内容寻址对象（`ASSET_OBJECTS_PREFIX`）不随 tombstone 物理删除，回收交 GC | ✅ `is_content_addressed_asset_object`，注释语义一致 |
| 3. FTP 550 白名单分类 | ✅ 且**更严**（见下） |
| 4. 回归测试断言 | ✅ 部分（见下） |

两点语义差异要在正式合入时知情：

- **550 分类被 tip 收紧**（`23864140` strict not-found whitelist）：tip 的
  `is_not_found_error` 要求「状态码 550/501 **且**消息含明确不存在短语
  （no such file/directory、not retrievable、does not exist、file/directory
  not found）」。#169/theme-cloud 版的 `is_missing_directory_error` 会把 vsftpd
  裸 `550 Failed to change directory.` 当「父目录缺失=已删除」；tip 明确把它归为
  无法归类→按真实错误上抛（`test_unclassifiable_550_is_not_treated_as_missing`）。
  这是有意 fail-closed：删除/下载绝不误判成功；而根因修复（第 1 条）已使
  Cloud Provider Gate 不再走到 legacy 回退路径。**判定：tip 行为覆盖并强于
  #169，正式合并按 tip 侧存活，不要把 `is_missing_directory_error` 移植回来。**
- **回归测试**：`sync_scenarios_tests.rs` 的
  `asset_tombstone_resolves_object_key_and_keeps_shared_content_object`
  与 #169 同名同断言（不得对 legacy 路径发删除、共享内容对象存活、另一 key
  仍可下载）✅。但 #169 的 **Docker 门禁契约测试三连**
  （`{webdav,s3,ftp}_asset_shared_object_tombstone_contract` +
  `run_asset_shared_object_tombstone_contract`）未进 tip——tip 的
  `sync_provider_contract_tests.rs` 只有自己的
  `run_asset_directories_file_sync_and_tombstone_contract` 与「从未创建目录下
  删除幂等」契约。如要完整保真，可在正式合入时从 #169 头 `08238dfc` 补移植
  （仅 `DS_SYNC_TEST_DOCKER=1` 时运行，不影响常规门禁）。本轮未移植。

## 3. #174 行为核对：**tip 无，已移植**（`a949558b`）

tip 相对 theme-cloud 在 `webdav.rs` / `s3.rs` 两文件的差异**恰好等于 #174
端口本身**（含 `ce366107` 的 rustfmt 修正），说明 #177 从未吸收 #174。反向
应用该 diff 即完成移植，结果与 theme-cloud 版逐字节一致。逐条行为（旧 doc §3）：

1. `extract_relative_key`：href 与 base 统一解码后 strip_prefix（坚果云中文
   同步文件夹列举清空修复）✅ 含三个回归测试（非 ASCII / %20 / PROPFIND 端到端）。
2. `build_path_url`：base 片段先解码再交 `push` 单次编码（防双重编码）✅。
3. `normalize_endpoint`：剥离 bucket 前缀域名（≥3 段、IP/localhost 不剥）与
   path 尾 `/{bucket}`；未触发时字符串原样返回保 `instance_binding_hint` 稳定
   ✅ 含五个回归测试。
4. 叠加顺序（先 #169 后 #174）：tip 已含 #169，直接叠加合规。

tip 的 `webdav_contract_source_guards` 源码守卫断言（resourcetype、
list_outcome 截断标记等）不涉及 #174 改动面，移植后仍满足。

## 4. theme-cloud 附带内容对照（旧预演有、本轮怎么处理）

- **R02 引擎加固回归**（`sync_r02_hardening_tests.rs` 598 行 + tombstone.rs
  2 行，theme-cloud `99868d8a`）：不在 tip，**本轮未带入**（超出 #169/#174
  范围）。正式合 B 时需决定从 theme-cloud 移植与否。
- **auto-sync 持久化状态修复**（`syncStatusStore.ts`，theme-cloud `493c4c74`）：
  tip 已含等价内容（两分支该文件无 diff）✅ 无需处理。
- `cloudStorageApi.ts` 的 E2EE 显式停用 / Android R11：tip 自带（原属 #177）✅。

## 5. 预演暴露的 0824 基座自带问题（重要，与 #177 无关）

`cargo check --lib` 在**未合并任何东西的 0824 基座上就已红**（tip 与
`llm_manager/` 零交集，合并树该目录与基座逐字节相同）。修复见 `fa289618`：

1. `model2_pipeline.rs`：`332fc2b1`（DeepSeek web_search 白名单收紧）按旧签名
   `server_side_web_search_enabled(config, ctx)` 写入 `config.model` 检查，而
   0824 另一侧已把该函数重构为 quirks 形态（静态半由
   `quirks.server_side_web_search` 编码：官方端点 × Responses 协议 × tools）。
   两侧内部合并时把新检查留在了 quirks 版函数体内，`config` 悬空（E0423）。
   修复：签名加 `model: &str`，生产调用点传 `&config.model`；测试统一为
   `resolve_quirks(&cfg) + &cfg.model`（顺带修掉同一测试里遗留的 `&proxy`
   直传）。另外 `provider_accepts_prompt_cache_key/_retention`（H theme-cache
   侧）裸调 `is_official_deepseek_config` 未导入（E0425），补 `super::` 限定。
2. `generative_ui_executor.rs` 测试（仅 test-profile 可见）：
   `parse_note_edit_accepts_append_payload` 在 `and_then` 闭包里借用已被移动的
   `Option<Value>`（E0515，与 step1 修过的 `82fc755a` 同族），补 `.as_ref()`。

**这意味着 0824 当前 tip 的 rust CI（rust-test-build 会编译 lib+tests）应为红。**
这两处修复应尽快回搬 0824 本身（本预演分支不回推，遵守任务约束）。

## 6. 编译门禁结果（全绿）

| 门禁 | 结果 |
|---|---|
| `npm ci` | ✅ |
| `npm run typecheck` | ✅（需先 `npm run version:generate`） |
| `npx vite build` | ✅ 1m06s，仅 chunk 体积警告 |
| `cargo check --lib` | ✅（26 条警告；需 `fa289618` 修复后） |
| `cargo check --lib --profile test` | ✅（本轮新增，验证 cfg(test) 模块） |
| `npm run licenses:generate` + `licenses:check` | ✅（本轮新增；合并后必须重生成，见 §1.2） |
| `cargo test --lib`（cloud_storage / web_search / quirks / note_edit 过滤） | ✅ 56 通过 0 失败（含 #174 全部 8 个移植回归、tip 的 strict-550、两组 web_search 门控） |

环境前提同旧 doc §5（Rust 1.98.0 stable、Tauri 系统库、protobuf-compiler、
`bash scripts/download-pdfium.sh linux-x64`）。补充：容器内 apt 装
fuse3/xdg-desktop-portal postinst 报错可忽略，所需 -dev 库均正常落位。

## 7. 对正式合入的结论

1. 用最新 tip 直接作 B 侧：冲突面 2 处（ci.yml env 全保留；legal notices
   保持 `legal/` 唯一权威路径 + `licenses:generate` 重生成）。
2. **#169 不需要再单独合**：tip 已吸收根因修复且 550 分类更严；合并时按 tip
   侧存活。#169 的 Docker 契约测试三连若要保真可另行补移植。
3. **#174 仍需移植**（PR 仍 OPEN，tip 未吸收）：成本极低——tip 相对
   theme-cloud 在两文件恰好只差 #174，反向 diff 即可；或等 #174 先合入
   #177/main 再取 tip。
4. tip 改了 Cargo.lock（新增 unicode-normalization），**正式合并后必须
   `licenses:generate`**，否则 `licenses:check` 门禁红。
5. 0824 基座自带两处编译破损（§5），与 B 主题无关，应先在 0824 上修掉
   （可直接摘 `fa289618`），否则任何后续合入的 rust 门禁都被它挡住。
6. R02 加固回归测试目前只存在于 theme-cloud，正式合 B 时按需决定去留。
