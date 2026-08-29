# R1 / WI-3（Linux release）：reusable-build-linux.yml 启用 sccache

> 子代理：SA-R1-04  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`  
> 状态：✅ 完成

## 变更内容

`.github/workflows/reusable-build-linux.yml`（与 SA-R1-03 在 `ci.yml` 的模式一致）：

1. **job 级 env** 新增 `SCCACHE_GHA_ENABLED: 'true'` + `RUSTC_WRAPPER: sccache`
   —— 覆盖 `npx tauri build` 内的整个 cargo release 编译。
2. **新增步骤 `Setup sccache`**：`mozilla-actions/sccache-action@fc920bf0ec8de6ee65d409111f7ec508035751ba # v0.0.11`
   （SHA-pinned，与仓库其余 action 的固定策略一致；SHA 已用
   `git ls-remote` 对 `v0.0.11^{}` peeled commit 核验）。
   放在 `Setup Rust` 之后、任何 cargo 调用（含 `cargo metadata`）之前 ——
   `RUSTC_WRAPPER` 是 job 级 env，sccache 二进制缺失时 cargo 会直接失败。
3. **保留 `Swatinem/rust-cache`**（`shared-key: release-linux-x86_64`）：
   rust-cache 负责 registry/git 依赖与 target 目录整体缓存，sccache 按
   编译单元缓存 rustc 输出，依赖或 profile 局部变更导致 rust-cache
   部分失效时 sccache 仍可命中。
4. **新增步骤 `Show sccache stats`**（build 之后）：输出命中率，供后续
   轮次量化 Release 墙钟收益（基线 ~141 min）。
5. `Print build tool manifest` 补充 sccache 版本行与 actions 清单。

## 兼容性说明

- release profile 未开 incremental（cargo 默认 release 关闭），sccache
  无 incremental 冲突。
- `CARGO_PROFILE_RELEASE_DEBUG=1`（Sentry symbol 场景）时 debuginfo
  由 sccache 正常缓存，无需额外配置。
- GHA cache 后端配额与 rust-cache 共享 10GB/repo；sccache 条目粒度小、
  LRU 驱逐，首轮观察 stats 后如有配额压力再在后续轮次调整。

## 验证

- `python3 yaml.safe_load` 语法通过
- `actionlint v1.7.12` 0 报错

## 后续

- 首次带缓存的 release 运行后，从 `Show sccache stats` 步骤读取命中率，
  回填 COORDINATION.md 的 WI-3 收益数据（父代理或 R2 子代理）。
