# X2 → C2-platform / F2-shell：23 命令 profile 接线复核

主旨：旧缺陷已经合入 main，不重复实现；本轮没有全量重扫或 invoke 成功结论。

- X2 原扫描产物标注：`e139c9716`（`result.json.commit`；首份移交误写成工具提交 `5e55a95f9`，本条订正）；动态导入 34 个 profile 模块的 meta，未执行 apply。`electron/index.ts` 在 profile 外，单独 import 取得 23 条命令；其中 21 条被 src 显式调用，因此旧报告有 21 条 F2 profile 缺漏，不是 23 条调用缺漏。
- 本次合并 main：`9c13dfc39f2c29aaffda6c61f7dedee2273197f5`，merge commit `3dd266634`。
- 已在 main 的修复：`642b3d6c4319378b047c0958b0be4e99bb3e2643` 将 `dstu.shell → ../../electron/index.ts` 加入 `host/profiles/desktop.json:40-42`，生成器同步加入 SHELL_PLUGINS。
- 已在 main 的防回归：`ddd54715ac5c250f1c8d9df377345a45837da7d1` 在真实仓库生成时断言 `dstu.shell` 不能静默消失。
- 当前真实入口：Electron main 选择 profile（`electron/shell/host-profile.ts:24-33`）→ Host `loadProfile` → `electron/index.ts` 的 `apply` 注册命令；不是在 Electron main 自动执行该插件。
- 当前结论：**旧报告的 F2 profile 声明缺漏已静态核实修复并集成**。本轮没有重新动态加载全部插件、没有调用 `apply`、没有实际调用这 23 条命令，服务依赖、错误路径与平台语义仍由 F2 / 独立验收人验证。

23 条原始声明：copy_file、export_unified_backup_data、get_app_data_dir、get_app_version、get_file_size、get_prevent_sleep、hash_file、install_apk、load_webview_settings、open_file_externally、open_system_permission_settings、pdfstream_check_access、read_file_bytes、read_file_text、save_text_to_file、save_webview_settings、set_android_immersive_mode、set_backend_sentry_enabled、set_prevent_sleep、set_sidebar_vibrancy、set_window_appearance、sync_titlebar_sidebar_material、updater_install_supported。

不需要为这个已修编号再改 Host/前端。后续严格等价验收依旧不能把 meta.commands 当作 invoke 成功。
