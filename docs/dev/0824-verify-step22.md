# 0824 Step 22 发版前独立实证

## 基线

- 分支：`origin/cursor/0824-cde6`
- Tip：`f83e541b1deaf65d9e9c4ac6f4755a73f4c19580`（Step 22：质量评审 10 路 + reviewfix）
- 隔离环境：`git worktree add -b cursor/0824-verify-step22-a875 /tmp/0824-verify-step22 origin/cursor/0824-cde6`，全部验证在该 worktree 内完成，未触碰官方工作区、未改产品代码。
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

在同一 tip `f83e541b` 上只读 grep/read 再证，数字口径以 `docs/0824-static-audit/27-invariants-number-errata.md` 为准。完整逐项行号见进度仓 `docs/0824-static-audit/51-invariants-step22.md`。

**18/18 PASS，无 FAIL。** Step 22 落地未回退：VFS coordinator 两个加法（`apply_vfs_init_missing_tables` + `pre_repair_vfs_v20260824_note_props`）定义/生产调用/测试俱在；HPIAS allowlist 恰 18 块；闪卡只读未加保存入口。

## leftover

同 tip 第六轮复扫（`docs/0824-static-audit/50-leftover-pass6.md`）：**结论 A**，开放非 `0824-*` PR 仍 115 个、无未吸收产品增量。`#328–#343` 已加法落地，勿整支 merge。`origin/main` 的 `b2a85a69` 仍被 `5f324e1f` 语义超集覆盖。

## Tauri 实机主路径

本隔离枝记录编译门禁与源码不变量。Tauri 桌面实机主路径（启动窗口、工作台/聊天主路径点击）在本文件后续段落补记。当前云 VM 有 `DISPLAY=:1` 与 `xvfb`/Xorg，**尚未**完成可复现的实机主路径走查；Goal 不因本步四门禁通过而 complete。

## 结论

- Tip `f83e541b`，四项硬门禁全部 exit 0，18/18 不变量 PASS。
- 无产品代码改动，未合 main，未推官方 `cursor/0824-cde6`。
- Tauri 实机主路径仍待补实证。
