# 0824 Step 22 发版前独立实证

## 基线

- 分支：`origin/cursor/0824-cde6`
- Tip：`f83e541b1deaf65d9e9c4ac6f4755a73f4c19580`（Step 22：质量评审 10 路 + reviewfix）
- 隔离环境：`git worktree add -b cursor/0824-verify-step22-a875 /tmp/0824-verify-step22 origin/cursor/0824-cde6`，验证在该 worktree 完成，未改产品代码、未整支 merge 隔离枝。
- 工具链：Node v22.14.0、Rust 1.98.0（`88d9e12ae 2026-08-18`）、protoc 3.21.12、gtk3 / gdk-3.0 / webkit2gtk-4.1 齐备；`libpdfium.so` 经 `scripts/download-pdfium.sh linux-x64` 现场补齐（脚本改写的 `licenses/pdfium.txt` 已恢复，未提交）。

## 四项硬门禁

| # | 门禁 | 结果 | Exit | 备注 |
|---|------|------|------|------|
| 1 | `npm run version:generate && npm run typecheck` | PASS | 0 | 生成 `0.9.44+16403.f83e541b`；`tsc --noEmit -p tsconfig.json` 0 error |
| 2 | `npx vite build` | PASS | 0 | `✓ built in 1m 20s`，仅 chunk 体积 warning |
| 3 | `cargo check --manifest-path src-tauri/Cargo.toml --lib` | PASS | 0 | `Finished dev profile in 3m 10s`，28 warnings、0 error（Rust 1.98） |
| 4 | `node scripts/check-migrations.mjs` | PASS | 0 | 迁移静态门禁通过（111 个迁移文件） |

首次 `cargo check` 因环境缺 `resources/pdfium/libpdfium.so` 在 `build.rs` 失败；补齐动态库后复跑 exit 0。属环境预备，非产品回归。

## 18 项不变量

在同一 tip `f83e541b` 上只读 grep/read 再证，数字口径以进度仓 `docs/0824-static-audit/27-invariants-number-errata.md` 为准。逐项行号见 `docs/0824-static-audit/51-invariants-step22.md`。

**18/18 PASS，无 FAIL。** Step 22 落地未回退：VFS coordinator 两个加法（`apply_vfs_init_missing_tables` + `pre_repair_vfs_v20260824_note_props`）定义/生产调用/测试俱在；HPIAS allowlist 恰 18 块；闪卡只读未加保存入口。

## leftover

同 tip 第六轮复扫（`docs/0824-static-audit/50-leftover-pass6.md`）：**结论 A**，开放非 `0824-*` PR 仍 115 个、无未吸收产品增量。`#328–#343` 已加法落地，勿整支 merge。`origin/main` 的 `b2a85a69` 仍被 `5f324e1f` 语义超集覆盖。

## Tauri 实机主路径

在隔离 worktree 上 `cargo build --manifest-path src-tauri/Cargo.toml --bin deep-student`（8m 43s，exit 0）得到 debug 二进制。该 debug 构建带 `--cfg dev`，窗口走 `tauri.conf.json` 的 `devUrl` `http://127.0.0.1:1422`，因此必须先起 Vite；单独启动二进制会白屏并显示 `Could not connect to 127.0.0.1: Connection refused`（环境预期，不是产品回归）。

`npm run dev`（Vite `:1422` HTTP 200）后重启 `./src-tauri/target/debug/deep-student`，`DISPLAY=:1` 下窗口 `Deep Student` 1112×773 保持可交互。主路径走查：

| 路径 | 结果 |
| --- | --- |
| 工作台 Study Desktop（日历 / Dock / Open Files） | 渲染正常 |
| Chat Composer（New Chat、输入栏、Smart Chat） | 渲染正常 |
| 设置 → Model Service（供应商列表、API key 框未填写） | 渲染正常 |
| All Apps 启动器（15 个模块图标） | 渲染正常 |
| AI learning dashboard（Due flashcards 0） | 渲染正常 |

未登录云、未保存密钥、未发真实 LLM。未做 production `tauri build` 安装包。进程核验时 Vite PID 与 Tauri PID 仍在，窗口仍在。

## 结论

- Tip `f83e541b`：四项硬门禁全部 exit 0，18/18 不变量 PASS，Tauri 桌面主路径（debug + Vite `tauri dev` 等价路径）已走通。
- 无产品代码改动，未合 main。隔离对照枝 `cursor/0824-verify-step22-a875`（#344）只作对照，勿整支 merge。
