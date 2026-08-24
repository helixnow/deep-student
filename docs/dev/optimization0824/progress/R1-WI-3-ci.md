# R1 / WI-3（CI）：ci.yml Rust job 启用 sccache

> 子代理：SA-R1-03  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`  
> 状态：✅ 完成

## 变更内容

`.github/workflows/ci.yml`，覆盖 5 个会发生 rustc 编译的 job：

| Job | 编译负载 | 变更 |
| --- | --- | --- |
| `backend` | clippy --all-targets | env + action + stats |
| `provider-contract` | cargo test（契约测试编译） | env + action + stats |
| `windows-shell-sandbox` | cargo check + cargo test（windows-latest） | env + action + stats（`shell: bash`） |
| `rust-test-build` | nextest archive（全部测试二进制） | env + action + stats |
| `migration-gate` | run-migration-tests.sh 内 cargo test | env + action + stats |

每个 job 的三件套：

1. **job 级 env**：`RUSTC_WRAPPER: sccache` + `SCCACHE_GHA_ENABLED: 'true'`。
   所有 5 个 job 均已有 `CARGO_INCREMENTAL: 0`，与 sccache 无 incremental 冲突。
2. **新增步骤** `Mozilla-Actions/sccache-action@fc920bf0ec8de6ee65d409111f7ec508035751ba # v0.0.11`
   （SHA-pinned + 版本注释，与仓库既有 pin 风格一致；`v0.0.11` 为 annotated tag，
   SHA 经 GitHub API 两级解引用到 peeled commit 核验，与 SA-R1-04 在
   reusable-build-linux.yml 使用的同一 SHA 一致）。放在 `dtolnay/rust-toolchain`
   之后、`Swatinem/rust-cache` 与一切 cargo 调用之前 —— `RUSTC_WRAPPER`
   是 job 级 env，sccache 二进制缺失时 cargo 直接失败。
3. **末尾步骤 `sccache stats to summary`**（`if: always()`）：
   `sccache --show-stats` 写入 `$GITHUB_STEP_SUMMARY`（带 job 名标题 +
   代码块），sccache 不可用时降级输出 "sccache unavailable" 不红步骤。

**保留全部 `Swatinem/rust-cache`**（clippy / provider-contract / tests 等
shared-key 不变）：rust-cache 负责 registry + target 整体缓存，sccache 按
编译单元缓存 rustc 输出，两层叠加 —— 依赖图局部变更导致 rust-cache 部分
失效时 sccache 仍能命中未变的编译单元。

## 未改动的 job（及原因）

- `rust-tests`（8 分片）：只下载 nextest archive 执行，不发生编译。
- `security-audit`：cargo-audit 只读 Cargo.lock，不编译。
- `build-config` / `frontend` / `frontend-tests`：非 Rust。

## 提交归属说明（共享工作区并发）

本子代理与多个子代理共享同一 worktree/分支。本任务的 ci.yml hunks 在编辑
完成后、本代理提交前，被并发子代理的 `git commit -am` 扫入其提交：

- `39579e63`（fix(pdf)…）：吸收了 backend / provider-contract /
  windows-shell-sandbox / rust-test-build / migration-gate 的 env + action
  + 前 4 个 stats 步骤；
- `2d06d6d5`（ci: path-filter provider-contract…）：吸收了 migration-gate
  的 stats 步骤（最后 11 行）。

内容已核验完整进入 HEAD 并与 path-filter（`changes` job）改动共存无冲突；
本报告随 `ci: enable sccache for Rust jobs in ci.yml` 提交入库。

## 验证

- `python3 yaml.safe_load` 语法通过
- `actionlint v1.7.7` 0 报错（对合并了并发改动后的最终 ci.yml 复验）

## 后续

- 首次带缓存运行后从各 job 的 step summary 读取命中率，回填
  COORDINATION.md 的 WI-3 收益数据。
- GHA cache 10GB/repo 配额与 rust-cache 共享，如驱逐压力大再调整。
