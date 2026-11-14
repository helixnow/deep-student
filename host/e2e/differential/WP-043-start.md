# WP-043 已实际启动，首个真实 Tauri coverage 构建已入专用 rust 队列

- 2026-11-05T17:34:22.529Z 开始；调度 PID 3158851 / opencode PID 3158852。
- 当前原始会话事件的 sessionID：`ses_e53394115ffekLMlt1CB4m1PJP`（sessions.json 尚未回填）。
- 首构建 `20261105173612-f65814`，17:36:12.990Z 已启动，实际 cls=rust。
  `CARGO_BUILD_JOBS=12`、dev、`RUSTFLAGS=-Cinstrument-coverage`、`--locked`、默认生产 features，复用原 `src-tauri/crates/dstu-differential/target`，不 clean。
- 构建暂不修改三个根配置文件；D46 allowlist 仍缺，确需改时交精确 diff。
- 实际检查：Xvfb 有；PATH 中 llvm-cov / llvm-profdata / tauri-driver / WebKitWebDriver 无。
  正核查工具链自带 LLVM；最小 harness 可用现有 devUrl 本地页面自驱动，尚未实际启动 A。
- `git show main:host/e2e/data-compat/SCENARIO-V0.md` exit128；7fbe42516 候选有接口。
  依 WORKER 不复制 X3 实现，请 C2 正常集成该接口，供 seed 与精确 SQLite 终态消费。
- 首检查点预计启动后 60–90 分钟，最迟 19:34Z；未有 A1/A2/golden/C 通过。
