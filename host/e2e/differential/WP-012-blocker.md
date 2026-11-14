结论：队列分类与 34-ID 范围阻塞已解除；WP-012 已于 15:07Z 按部分完成交付，后续构建由 C1 正式派发 WP-043 承接。

2026-11-05 最新裁定：C2 确认专用 `rust` 类满足 build 政策，使用
`CARGO_BUILD_JOBS=12`、经 jobs、复用 target、不 clean；保留现有 34 IDs。
X7 只读实取 status.json at=15:25:35.262Z：limits 为
`{typecheck:3,test:3,build:1,other:3,rust:1}`，rust running=0。
下列内容保留为历史阻塞原件，不再代表当前状态。尚无新增 Rust 构建或运行结果。

## 历史记录

- 已合并 main `967f43c75`；当前工作树干净起步，正在修独立 harness 的直接 `log = "0.4"` 依赖。
- 实际使用的 `/home/dsdev/dev/deep-student/scripts/electron-migration/jobs/runner.mjs:25–30` 仅将 vite/build:demo/npm run build 归为 build；`env CARGO_BUILD_JOBS=8 nice -n 10 cargo build --manifest-path src-tauri/crates/dstu-differential/Cargo.toml` 会落入 `other`。没有提交 cargo 作业，也没有改名包装绕过分类。
- 请 C2/队列所有者修复并确认运行中的 runner 已采用 cargo build 分类；X7 无权改 jobs/ 或重启该服务。此次 brief 已授权 log 增量重试，旧“无工具链/等待重试授权”说法不再适用。
- `src-tauri/crates/dstu-differential/src/main.rs:63–126` 现有 34 个 dispatch ID。audit 的早期 revision 2 为 33 个，后续 C2 批次增加 `regex.boundedOriginal`（audit §C2 review corrections / §Final preparation scope confirmation）。本包没有增加或删除 ID。请明确沿用已有 34，还是仅允许早期 33；不擅自更改已冻结参考程序。
- 原失败 build `20261104143346-a72af4` / exit 101 原件在 `fixtures/differential/builds/20261104143346-a72af4/`；此次仍复用现有 target，绝不 clean。
- 在前置解除前，继续 TS 门禁、AppState command oracle 最小方案与交付记录；当前 Rust→TS 动态结果为未运行，不是通过。

## 更新 2026-11-05 22:55 CST：规则已改，运行中的执行器未加载

- 主仓库 `scripts/electron-migration/jobs/runner.mjs:19,24,29` 已新增 `rust` 类（并发 1，超时默认 150 分钟），cargo 不再落入 other。文件 mtime 为 22:37:39 CST。
- 运行中的执行器 `ds-jobs.service` ExecMainPID=2068047，启动于 21:47:42 CST，早于该修改；ESM 在启动时加载 classify。`~/.oc-jobs/status.json` 的 limits 仍是 `{typecheck:6,test:6,build:2,other:6}`，没有 rust。现在提交 cargo，实际仍会按 other / 30 分钟超时执行。
- 请队列所有者重载 `ds-jobs.service`，并确认 status.json 出现 `rust` 限额。X7 不重启共享服务，也不提交会落入 other 的构建。
- 请同时确认：brief 要求的 “build 类” 由这个专用 `rust` 类满足；以及沿用现有 34 个 ID（含 `regex.boundedOriginal`）。确认后只提交一次已授权的增量构建，不 clean。
