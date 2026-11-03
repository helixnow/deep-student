# 原实施阶段验证结果 — 2026-11-03（历史快照）

> 本文件保留上一轮原始结果。随后源码已本地提交 `7fef25ec`，Phase-5已修复，真实视觉模型已授权并实测11/20次；最新证据见 [closure-results](closure-results.md) 与 [closure-progress](../closure-progress.md)。下方旧HEAD/未提交和数字不是当前状态。

仓库：`/home/xutao/deepstudent/deep-student`；分支：`feat/handwriting-annotation-chat`；HEAD仍为`6c73530d87f3180c2ff555dd5729943a77086dc3`，实现保留未提交。主agent亲自运行，不以子agent完成声明替代。日志均在同目录，失败历史保留；本Markdown提供不依赖被忽略`.log`打包的结果索引。

## 通过

| 命令（仓库根执行，省略日志重定向） | 结果 | 证据 |
| --- | --- | --- |
| `NODE_OPTIONS=--max-old-space-size=6144 npx vitest run --shard=N/4 --maxWorkers=2 --minWorkers=1 --logHeapUsage`，N=1..4串行 | 四片exit0；12668 passed / 4 skipped / 5 todo；1605files passed / 1 skipped | `vitest-final-r2-shard-{1,2,3,4}.log` |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run test-ct -- tests/ct/ink tests/ct/ink-editor tests/ct/ink-office tests/ct/ink-prepare tests/ct/ink-export tests/ct/ink-jobs tests/ct/paperExport.spec.tsx --workers=2` | exit0，51/51 passed | `ink-browser-final-r3.log` |
| `CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=4 xvfb-run -a dbus-run-session -- cargo test --manifest-path src-tauri/Cargo.toml --locked --workspace --lib --exclude dstu-agent --exclude deep-student --no-fail-fast -- --skip llm_manager::proxy_env_tests::http_client_honors_proxy_environment` | exit0，23suite共4059 passed / 0failed / 6ignored / 1filtered | `workspace-libs-final-r1.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-llm --lib llm_manager::proxy_env_tests::http_client_honors_proxy_environment -- --exact --test-threads=1` | exit0，1/1；上项过滤的代理测试独立通过，不称一次full858 | `llm-final-proxy-isolated-r2.log` |
| `CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=8 cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-agent --lib` | exit0，1965 passed / 0failed / 6原有ignored | `agent-full-final-r5.log` |
| `CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=8 xvfb-run -a dbus-run-session -- cargo test --manifest-path src-tauri/Cargo.toml --locked --lib` | exit0，1050/1050 passed | `app-full-final-r3.log` |
| `xvfb-run -a dbus-run-session -- cargo test --manifest-path src-tauri/Cargo.toml --locked --test app_command_acl` | exit0，4/4 passed | `app-acl-final-r3.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-llm --lib handwriting_provider_capture_tests` | exit0，3/3真实本地HTTP请求捕获 | `ink-provider-http-r5.log` |
| `npx vitest run tests/vitest/chat-v2/token-budget.test.ts src/features/chat/skills/__tests__/inkTools.test.ts tests/vitest/pdf/pdfStaticAssets.test.ts --maxWorkers=2 --minWorkers=1` | exit0，21/21 passed | `schema-and-pdf-final-r2.log` |
| `npx vitest run tests/vitest/chat-v2/plugins/blocks/McpToolBlock.test.tsx src/features/chat/core/store/__tests__/restoreActions.historyMerge.test.ts src/features/chat/core/store/__tests__/restoreActions.unsavedRefs.test.ts --maxWorkers=2 --minWorkers=1` | exit0，37/37 passed | `ink-card-final-green-r1.log` |
| `npm run typecheck` | exit0 | `typecheck-final-r5.log` |
| `npm run check:frontend-layers` | exit0，无新增；565旧违规基线保留 | `frontend-layers-final-r2.log` |
| `npm run check:lint-ratchet` | exit0，4611旧warnings/0errors，无新增告警 | `lint-ratchet-final-r3.log` |
| `npm run lint` | exit0，4611旧warnings/0errors | `lint-final-r1.log` |
| `npm run check:crate-layers` | exit0，25成员 | `crate-layers-final-r1.log` |
| `npm run check:i18n` | exit0；180旧缺键默认告警保留，新增Ink中英文键覆盖 | `i18n-final-r2.log` |
| `npm run licenses:check` | exit0 | `licenses-final-r1.log` |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run build` | exit0，最终worker及工具卡代码，1m7s | `frontend-build-final-r3.log` |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all --check` | exit0 | `fmt-final-r8.log` |
| `CARGO_BUILD_JOBS=2 cargo clippy --manifest-path src-tauri/Cargo.toml --locked --workspace --all-targets -- -D clippy::correctness` | exit0，最终冻结代码，存量style warnings保留 | `clippy-final-r2.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-vfs --lib vfs::ink::` | exit0，24/24 passed，使用非忽略共享fixture | `ink-packaged-fixture-final.log` |
| `git diff --check` | exit0，无空白错误 | 主agent最终复核 |

以上多套件重叠，不能把数字相加当互异测试总数。原生app完整库验证包含生产roster、所有六工具DB路径、prepare/export bus与真实提交、checked publication和可信undo；本地Provider捕获验证实际图片请求，不调用真实模型。

## 独立既有失败

命令：`xvfb-run -a dbus-run-session -- cargo test --manifest-path src-tauri/Cargo.toml --locked --test phase5_tool_execution_e2e`。

结果exit101；`tests/phase5_tool_execution_e2e.rs:212`期望todo事件来源`ai`，实际`agent`。主agent委派只读HEAD核对：该断言及`user_todo_executor.rs:267–269`按ACR4.0发`agent`均在起点`6c73530d`已存在，分支均未修改。没有为通过测试修改无关事件业务或降低断言。此旧harness不在CI nextest默认`_e2e`排除外的常规测试集合中，但结果仍独立保留于`phase5-e2e-final-r3.log`。

## 环境与未执行

- `cargo-nextest`当前未安装，使用cargo test完整库与相关app集成替代；未自动安装或拉取Docker/provider服务，ignored有凭据/服务条件测试不伪称执行。
- Android真实压感、误触、延迟、内存：没有设备，未验证。
- 真实视觉模型识别质量：未获外发/费用调用授权，未执行；没有外发用户资料。三Provider离线capture不能替代识别质量。
- 首次全浏览器CT默认4GiB V8 heap OOM exit134在构建阶段，改命令级8GiB+2worker后51/51通过；未改构建配置或依赖。
- proxy首次隔离命令只等待构建锁后timeout124，队列释放后第二次1/1通过，未算产品失败。
- package-lock.json、Cargo.lock、.gitignore保持不变，无运行时新增依赖、无自动commit/push/publish。

## 显式新增工具预算

旧工具组schema原上限51500不变，实测51299；compact Ink六工具2851，独立护栏3000。schema+prompt旧76600不变，Ink独立3200。all aggregate分别54500/79800，实测54150/79688。新增功能成本透明列示，未用放宽strict schema或修改lint基线绕过。
