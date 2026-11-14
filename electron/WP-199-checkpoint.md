# WP-199 首检查点（2026-11-05 23:40Z）

结论：同步 preload 接线与真实首脚本/四类错误/8000ms timer/cleanup/reload/独立 webview 验证已通过，正在整理文档并进入全目录回归与正式 gate。

- 起点 `cf01cbe44`，正常 merge main `df2cd30a1` 返回 Already up to date；137 四文档及所有阻断保留。已读 WORKER、任务卡、LANE/BLOCKERS/TESTMAP、standard-v2、Rust 完整 IIFE、前端 cleanup、Tauri 全局 callback 接线。
- `git show main:electron/preload/preload.ts` 和 `main:host/platform/log/commands.ts` 确认正式 bridge/日志入口在 main。生产仅新增 self-contained 主世界 installer，并在 preload 的正式 bridge 安装后同步调用。未用 did-navigate eval 改写时序。
- 基线 typecheck job `20261105232951-360189` exit0；基线 5 passed/0 failed/0 skipped/Errors0（`20261105232951-cbc68c`）。该命令中误写的 page-load-started 文件不存在，不能声称它被执行；正确 `page-load-lifecycle-host.test.ts` 已随后实跑通过。
- 修前真实反证 `20261105233237-4b2b21`：1 failed/exit1，三个文档 cleanup 均 undefined。原件 `/tmp/opencode/f2-boot-acK79d`。首次 reporter 测试打包缺 Vite import.meta 定义，已按开发运行设置 define PROD=false；不改前端源码。
- 接线后 `20261105233407-e5d17b`：原090 lifecycle 1 passed，新诊断测试1 failed（首文档 HostReady 后尚有10 callback，测试过早 reload）；原件 `/tmp/opencode/f2-boot-s7fBe3` 记录真实四类 BOOT 事件、8秒空root、同主世界 cleanup、reload 重装。保留红灯，不称整套通过。现测试在原50秒报告/60秒用例预算内等待调用清空再 reload。
- 修后 typecheck `20261105233407-b78a20` exit0。新增 exact cleanup 单测与真实三 webview 扩充 `20261105233750-4b763f`：2 files / 3 passed / 0 failed / 0 skipped / Errors0 / exit0。
- Tauri `manager/webview.rs:288-311` 全局回调覆盖 main 与 browser-content；原 browser-content capability **不允许** report_frontend_log，必须保持拒绝并走 best-effort catch，不能开主窗权限。测试已验证原拒绝、零递归 rejection、callback清空及不同文档隔离；main+quick-assistant均经正式F4日志落盘。Linux detached已验，mac/Win embedded未实跑。
- TESTMAP：10 ported / 4 merged / 1 obsolete / 3 pending → 3 pending，无映射/资格变更。不消费L10租约，不改变L19接管。
