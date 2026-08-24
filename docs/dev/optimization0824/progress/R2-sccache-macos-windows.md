# R2 / WI-3（macOS + Windows release）：sccache 扩展到剩余两个 release 构建

> 子代理：SA-R2-02  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`  
> 状态：✅ 完成

## 变更内容

沿用 SA-R1-03（`ci.yml`）/ SA-R1-04（`reusable-build-linux.yml`）已验证的模式，
对两个文件做完全对称的四处修改：

### `.github/workflows/reusable-build-macos.yml`

1. **job 级 env** 新增 `SCCACHE_GHA_ENABLED: 'true'` + `RUSTC_WRAPPER: sccache`
   —— 覆盖两个 matrix target（`aarch64-apple-darwin` / `x86_64-apple-darwin`）
   内 `npx tauri build` 的整个 cargo release 编译。
2. **新增步骤 `Setup sccache`**：
   `mozilla-actions/sccache-action@fc920bf0ec8de6ee65d409111f7ec508035751ba # v0.0.11`
   （与 ci.yml / linux 同一 SHA pin；本次已再次用 `git ls-remote` 核验
   `v0.0.11^{}` peeled commit = `fc920bf0…`）。放在 `Setup Rust` 之后、
   任何 cargo 调用（含 `cargo metadata`）之前 —— `RUSTC_WRAPPER` 是
   job 级 env，sccache 二进制缺失时 cargo 会直接失败。
3. **保留 `Swatinem/rust-cache`**（`shared-key: release-${{ matrix.target }}`，
   未改动）：rust-cache 负责 registry/git 依赖与 target 目录整体缓存，
   sccache 按编译单元缓存 rustc 输出，两者叠加。
4. **新增步骤 `Show sccache stats`**（`Build Tauri app` 之后）：输出命中率，
   供后续轮次量化收益。
5. `Print build tool manifest` 补充 sccache 版本行 + actions 清单加入
   `sccache-action v0.0.11`。

### `.github/workflows/reusable-build-windows.yml`

同样四处：job env（`SCCACHE_GHA_ENABLED` + `RUSTC_WRAPPER`）、
`Setup Rust` 之后新增 `Setup sccache`（同一 SHA pin）、
build 后新增 `Show sccache stats`、manifest 补 sccache 行与 actions 清单。
`Rust cache` 步骤保留未动。

## 兼容性说明

- **macOS matrix 双 target**：两个 target 跑在不同架构宿主
  （macos-15 arm64 / macos-15-intel x86_64）。sccache-action 提供双架构
  二进制；sccache 缓存 key 含 rustc 版本与完整编译参数（含 `--target`），
  GHA cache 后端天然按 key 隔离，两个 target 不会互相污染。
- **macOS split-debuginfo**：Sentry secrets 就绪时
  `CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO=packed`。packed 是 macOS 默认
  行为 —— debuginfo 留在各编译单元 object 内、dsymutil 在 link 阶段
  聚合 dSYM；link 阶段本就不经 sccache，rustc 编译单元照常可缓存。
- **Windows MSVC**：sccache 支持 MSVC rustc；`ci.yml` 的
  `windows-shell-sandbox` job（SA-R1-03）已在 windows-latest 上验证过
  同一模式（sccache-action + GHA 后端），无平台问题。
- **incremental**：release profile cargo 默认关闭 incremental，与 sccache
  无冲突（无需像 CI job 那样显式设 `CARGO_INCREMENTAL=0`，与 linux
  release workflow 保持一致）。
- **GHA cache 配额**：与 rust-cache / npm cache 共享 10GB/repo，LRU 驱逐。
  新增 3 个 release job（macOS×2 + Windows×1）的 sccache 条目粒度小；
  首轮观察 `Show sccache stats` 后如有配额压力再调整。

## 验证

- `python3 yaml.safe_load` 两个文件语法通过
- `actionlint v1.7.12` 两个文件 0 报错
- sccache-action SHA pin 经 `git ls-remote` 复核（`v0.0.11^{}` =
  `fc920bf0ec8de6ee65d409111f7ec508035751ba`）

## 后续

- 首次带缓存的 release / rebuild-release 运行后，从三个平台的
  `Show sccache stats` 步骤读取命中率，回填 COORDINATION.md 的 WI-3
  收益数据（父代理或 R3 子代理）。
- WI-3 至此覆盖全部 Rust 构建入口：ci.yml（R1）、linux release（R1）、
  macOS/Windows release（本次）。
