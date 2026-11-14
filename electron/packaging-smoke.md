# W06 打包实测（2026-11-07）

结论：macOS arm64 真实打包成功，静态加固校验 8/8；真实包冒烟 17/18。**不是可签收的全绿交付**：旧 W06 第十轮交接的 `NODE_COMPILE_CACHE` main 进程缺口仍可复现，未放宽断言。

## 本轮变更

`5b23b1f5`：新增打包时 `DS_ELECTRON_PACKAGE_OUTPUT` 输出目录覆盖；打包后 migrations / 生产闭包校验使用同一输出目录。默认仍为 `release`。用于本机系统盘空间不足时直接向外置盘打包，不修改依赖、不改运行时启动策略。

新用例只验证默认路径和外置盘路径：`bin/heavy npx vitest run -c vitest.host.config.ts electron/tests/packaging.test.ts -t 'external package output' --maxWorkers=2`，exit 0（1 个选中用例通过）。没有重跑已过的 closure / portable / gate。

## 真实产物及命令

- 根：`/Volumes/DSWork/W06-packaging-smoke-20261107-1745`，本轮新建；没有删除旧文件释放空间。
- `.app`：`release/mac-arm64/Deep Student.app`（相对于上述根）；位于仓库外，smoke 不需要再复制一份。
- 数据/日志/截图：`tmp/ds-packaged-smoke/run-ceJL2E`（保留 `report.json`、`stdout.log`、`stderr.log`、`chat.png`）。
- 源码基线：`891d75ed6549d7ccb3c8a2009c8ae0867a745290` + 本轮 `5b23b1f5` 的打包输出改动。build number 20000；包内版本信息固化的是打包启动时尚未提交的基线 `891d75ed`。
- 沿用工作树已有 `dist/`（`index.html` mtime 2026-11-07 10:04），没有做全量前端构建；因此不宣称验证了全部最新前端源码。

工作目录 `wt/W06`，外置根记为 `OUT`，每条命令均经根 `bin/heavy`：

```sh
BUILD_NUMBER=20000 DEEP_STUDENT_BUILD_NUMBER=20000 \
DS_ELECTRON_PACKAGE_OUTPUT="$OUT/release" TMPDIR="$OUT/tmp" \
  /Users/heli/der/tmp-58068a80b38aa6d0/bin/heavy env -u SENTRY_DSN \
  node electron/scripts/package.mjs --mac --dir

TMPDIR="$OUT/tmp" /Users/heli/der/tmp-58068a80b38aa6d0/bin/heavy env -u SENTRY_DSN \
  node electron/scripts/__tests__/packaged-smoke.mjs \
  --app "$OUT/release/mac-arm64/Deep Student.app" --keep

TMPDIR="$OUT/tmp" /Users/heli/der/tmp-58068a80b38aa6d0/bin/heavy \
  node electron/scripts/verify-fuses.mjs \
  --app "$OUT/release/mac-arm64/Deep Student.app" --static
```

打包 exit 0：Electron 45.2.1 / Node 24.22.1，ad-hoc + hardened runtime；未嵌入 Sentry DSN；migrations 逐字节一致，332 个生产闭包包均在 asar，测试 sqlite-busy 二进制未进包。

smoke exit 1：首窗 4210ms、Host ready 5512ms、42/42 插件；所有已加载 `.node` 来自包内，koffi / better-sqlite3、SQLite / FSRS、worker、诊断导出、本机假 LLM 流式交互正常。日志无 ERROR、页面错误 0。唯一失败为下节金丝雀。

静态校验 exit 0，8/8：fuses、asar 布局/完整性、原生解包、签名、main/helper hardened runtime、entitlements、麦克风说明均通过。未重复跑动态破坏性副本探针。

## 真实阻塞：main 启动前的编译缓存

原 smoke 的断言保持不变：外部缓存金丝雀目录必须不存在，同时 Host 的缓存必须在 userData 下。结果：

- Host 缓存在 `userdata/host-compile-cache`，符合预期。
- `dev-overrides/compile-cache` 被创建，退出后有 **398** 个缓存文件。
- 目录 birthtime `2026-11-07T09:44:12.075Z`；main 删除开发变量的首条日志为 `09:44:12.195Z`，晚约 120ms。
- 静态校验确认 `EnableNodeOptionsEnvironmentVariable=false`，该 fuse 没有阻止这个变量生效。

与旧 W06 第十轮交接一致：Electron 内嵌 Node 在应用 main JS 运行前处理缓存环境变量。公开 `node:module` API 只有 enable/get/flush，没有禁用已启用缓存的 API。已核同版本 Electron `shell/common/node_bindings.cc`：`SetNodeOptions` 处理 NODE_OPTIONS / NODE_EXTRA_CA_CERTS，不处理 NODE_COMPILE_CACHE；不能把关 NODE_OPTIONS fuse 当作修复。

**本轮没有安全、范围内的 JS 修复，阻塞未关闭。** 删除外部缓存目录会改写调用者文件且不能撤销首次读取；清变量后 relaunch 同样不能撤销首次读取；在 smoke 启动端清变量只是取消攻击输入。这些都没有实施。需要主代理协调 Electron 原生运行时在 Node 初始化前忽略该变量（或验证有相应修复的运行时版本）；依赖升级/自编运行时未获授权，不擅改 package.json/lock，也不做不可维护的二进制字符串补丁。

原始日志：根 `.reports/server/land-test-E/` 下 `packaging-build.log`、`packaging-smoke-initial.log`、`packaging-static.log`、`packaging-output-test.log`。无服务器/G3 操作，无 host/e2e/smoke 修改。
