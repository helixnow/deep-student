# 0824 预演：主题仓 B cloud 合入统一分支

日期：2026-08-24  
预演分支：`cursor/0824-rehearse-cloud-cde6`（**不回推 0824 本身**）  
基座：`origin/cursor/0824-cde6` @ `8361e6b7`（已含 E optimization #213 + C generative-ui #214）  
被合方：`origin/cursor/0824-theme-cloud-cde6` @ `493c4c74`
（= #177 cloud-sync SOTA 底座 + #169 FTP 550 tombstone + #174 WebDAV/S3 端点 + R02 引擎加固回归测试 + auto-sync 持久化状态修复）

合并提交：`4fa804f7`，143 文件，约 +38964 / −1200。

## 1. 冲突实况

本次预演**唯一**冲突是 `.github/workflows/ci.yml` 的 `rust-test-build` job env 块：

- HEAD（0824，来自 #213 optimization）：`RUSTC_WRAPPER: sccache` + `SCCACHE_GHA_ENABLED: 'true'`
- theme-cloud（R07-archive OOM 缓解）：`CARGO_BUILD_JOBS: '3'`（4 路并行链接巨型测试二进制会 OOM 打死 16GB runner）

两侧语义互补（缓存加速 vs 并行度压峰值），**解法：全保留**，两组 env 并存。

预告过的四个热点文件——`src-tauri/src/cloud_storage/ftp.rs`、`s3.rs`、`webdav.rs`、
`src/utils/cloudStorageApi.ts`——本次**全部干净自动合并**。原因：这四个文件相对
merge-base（`0e4c9fad` = main）只有 theme-cloud 单侧改动；当前 0824 尚未合入
A wrapup（#268），另一侧不存在。**正式合入时若按计划顺序（第 5 步 A → 第 6 步 B）
先合了 wrapup，这四个文件必然冲突**，届时不能机械取某一侧，必须按第 2、3 节的
语义逐条核对存活。

## 2. #169 语义（FTP 550 tombstone 契约，commit `f18e1662`）

正式合并后无论 ftp.rs / sync mod.rs 长成什么样，以下行为必须保留：

1. **tombstone 应用处用「未过滤」资产清单解析物理 object_key**。
   新增 `download_assets_manifest_before_tombstones`（现位于
   `src-tauri/src/data_governance/sync/mod.rs`），仅供 tombstone 应用点调用；
   另外两个清单调用点保持原有「已过滤」语义。
   背景：条目被 tombstone 过滤后查询必然 miss，只能回退到 legacy 逻辑路径
   `data_governance/assets/{key}`，而新布局对象实际在
   `data_governance/asset_objects/{sha256}`，回退路径父目录在云端不存在，
   FTP cwd 550 直接硬失败（Cloud Provider Contract Gate 因此红）。
2. **内容寻址对象不做物理删除**。解析出的 key 若位于
   `data_governance/asset_objects/`（sync mod.rs 中 `ASSET_OBJECTS_PREFIX`）
   前缀下则跳过删除：这类对象按 sha256 去重、可被多个逻辑 key 共享，是独立
   retention unit，回收交给 GC。只有 legacy 前缀 `data_governance/assets/`
   下的对象与逻辑 key 一一对应，可随 tombstone 物理删除。
3. **FTP delete 的 550 分类是白名单制**（ftp.rs `is_missing` 一族）：
   仅状态码 550/501 且服务器消息明确表达「不存在」（vsftpd
   `550 Failed to change directory.`、proftpd/pyftpdlib
   `550 ...: No such file or directory`）才按「已不存在=成功」处理；
   无法归类的 550（权限/磁盘错误共用同码）必须按真实错误上抛，
   绝不能把删除/下载误判成功。
4. **回归测试断言**（`sync_provider_contract_tests.rs`、`sync_scenarios_tests.rs`）：
   同内容双逻辑 key，tombstone 其中一个后另一 key 的内容对象必须仍在，
   且不得对 legacy 路径发起删除。

## 3. #174 语义（WebDAV 编码归一化 + S3 端点识别，commit `f72f9a60`）

1. **WebDAV `extract_relative_key`**（webdav.rs）：href 与 base 两侧**统一解码后**
   再做 `strip_prefix` 比较（先取原始路径，不要先解码再 `Url::parse` 重编码）。
   否则端点路径含非 ASCII/空格（坚果云中文同步文件夹）时前缀永不命中，
   列举结果被静默清空——症状是上传正常、下载/双向同步永远看到 0 个文件。
2. **WebDAV `build_path_url`**（webdav.rs）：base 路径片段先解码再交给
   `push` 单次编码；直接 push 已编码片段会再转义 `%` 造成双重编码。
3. **S3 `normalize_endpoint`**（s3.rs）：用户从腾讯云/阿里云/缤纷云控制台
   粘贴的是带 bucket 前缀的访问域名，再单独填 bucket 后 SDK
   virtual-hosted-style 会拼出 `bucket.bucket.…`，DNS/TLS 直接失败。
   归一化行为：trim → 补 https scheme → 剥离 host 前缀 `{bucket}.`
   （剩余必须是 ≥3 段服务域名；IP/localhost 不剥离）→ 剥离 path 尾部
   `/{bucket}`。**未触发归一化时字符串必须原样返回**，保证
   `instance_binding_hint` 稳定。
4. 叠加顺序：#174 原 PR 注明「若与 #169 的清单解析叠加，先合 #169 再 rebase」。
   theme-cloud 内已按此序落盘（`f18e1662` → `f72f9a60`），正式合并整仓时无需再管。

## 4. 附带内容

- `99868d8a`：移植 R02 引擎加固回归（`src-tauri/tests/sync_r02_hardening_tests.rs`，
  598 行；`sync/tombstone.rs` 2 行配合改动）。
- `493c4c74`：`src/stores/syncStatusStore.ts` auto-sync 持久化状态返回补全。
- `src/utils/cloudStorageApi.ts`（+97/−14）来自 #177 的 E2EE 显式停用与
  Android R11 支持（`e416dd23`、`87e9cc61`），与 wrapup 侧改动正式合并时同样要语义核对。

## 5. 编译门禁结果（全绿）

| 门禁 | 结果 |
|---|---|
| `npm ci` | ✅ |
| `npm run typecheck` | ✅（需先 `npm run version:generate` 生成 gitignored 的 `src/version.ts`） |
| `npx vite build` | ✅ 1m18s，仅 chunk 体积警告 |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅ 仅警告（22 条） |

环境前提（新机器复现时需要）：

- Rust 工具链要新：CI 用 `stable`，预演最终用 1.98.0。原装 1.83.0 因依赖要求
  `edition2024` 直接失败；1.89.0 也不够——`libsqlite3-sys 0.38.1` 的 build script
  用了 `cfg_select!`（E0658），需更新的 stable。
- Linux 需 Tauri 系统库：`libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev
  librsvg2-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev`（缺失时 `gdk-sys` 构建脚本报
  pkg-config 找不到 `gdk-3.0`）。
- `protobuf-compiler`（`lance-encoding` build script 需要 `protoc`）。
- `bash scripts/download-pdfium.sh linux-x64`（Tauri build.rs 的 app ACL 校验要求
  `src-tauri/resources/pdfium/libpdfium.so` 物理存在）。

## 6. 对正式合入的结论

1. B cloud 对**当前** 0824（E+C）基本干净：一处 ci.yml env 互补冲突，全保留即可。
2. 若维持计划顺序（A wrapup 先进），ftp.rs / s3.rs / webdav.rs / cloudStorageApi.ts
   将从「单侧改动」变成双侧冲突。解法原则沿用 0824-MERGE-PLAN §7：
   **#177 大改写为底座，#169/#174 的行为（第 2、3 节清单）逐条移植核对**；
   #268 侧的针对性修复同样按行为合，不整文件取侧。
3. 合并后跑 `sync_provider_contract_tests.rs` / `sync_scenarios_tests.rs` /
   `sync_r02_hardening_tests.rs` 及 webdav.rs 内嵌单测，可直接验证第 2、3 节语义是否存活。
