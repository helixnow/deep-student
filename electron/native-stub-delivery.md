# 固定 macOS main stub 打包集成交付

2026-11-07；主编排批准的 mac-only 集成，不承诺 Windows/Linux 修复。

## 交付结论

- **真实新建包：packaged-smoke 18/18，完整 fuse/签名/ASAR 行为检查 13/13，均 exit 0。**
- **既有外部缓存 + PORTABLE=1 隔离：4/4，exit 0。** 调用者旧缓存的 400 个文件/目录项（含根目录、398 文件）在 app 正常启动及退出 flush 后，字节/树/mode/mtime 保持不变。验证只读，不删除/覆盖旧缓存。
- 必要 targeted 单测：hook/审计/launch-env/packaging **34/34**；缓存输入差异检测 **1/1**。
- 功能提交 `cd326647`；既有输入验证提交 `6e03adf5`。真实包固化的源码 SHA 为 `cd326647`；后一提交仅增加不进包的测试脚本/用例，不改变被验收产品代码。

## 产品改动

1. `electron/native/mac-main-45.2.1.cc`：保留上游非 helper 的 stdio 修复、framework RunAsNode 决策、同进程 ElectronMain(argc, argv)；nodeOptions fuse 关闭时，在首次 Node 初始化前清 NODE_COMPILE_CACHE / NODE_COMPILE_CACHE_PORTABLE，失败即退出。无 exec/relaunch/旧 main 备用入口，helper 不改。
2. `electron/scripts/mac-main-stub.cjs`：afterPack 的 framework fuse 设置之后、electron-builder 正式签名前编译替换主 Mach-O；只接受 Electron 45.2.1。按 context.arch 明确选择 arm64/x86_64，lipo 校验原 target、读取原 minOS；不按构建主机猜架构。不支持的版本/架构不静默回退。
3. 新 stub 源文件不进 asar，MIT 许可随 Resources/licenses 安装。`-nostdlib++` 去掉原型中多余的 libc++ 依赖；本次 `otool -L` 只有同 bundle Electron Framework 与 libSystem，rpath 与原入口一致。
4. `launch-env.ts` 增加明确 native 缓存变量名单；JS 仍承担其它开发变量的真实删除，未假称 JS 删除已被 native 移除的变量。Windows/Linux 的 JS 清理不等于其前置 Node 缓存问题已修。
5. `packaged-smoke` 保留18项，审计项改为联合验证两个**真实阶段**。native 必须精确匹配 `[dstu-native-cache-v1]`、实际 spawned child PID、完整有序变量名单，不能多/少/重复/错PID；JS 必须有其独立完整精确名单。负例覆盖缺阶段、错标识/PID、未知/缺少变量、伪前缀、尾随文本及重复日志。不接受仅“包含某些字符串”。native 审计来自直接子进程 stdout，JS 原壳日志另行保留；不是伪造 main 单行日志。
6. 原外部 NODE_COMPILE_CACHE canary 输入保留，新增 PORTABLE=1 输入；**canary 目录不存在 + Host userData cache 存在**两个硬条件原样保留，没有 skip 或改 warning。

## 新构建产物与 UI 边界

外置新根：`/Volumes/DSWork/W06-native-stub-delivery-20261107-1816`。

- app：`release/mac-arm64/Deep Student.app`（相对于上述根）。真正重新执行 package.mjs，不是仅改原型副本。
- 源码 `cd326647`，build number 20000，Electron 45.2.1 / Node 24.22.1，macOS arm64，ad-hoc hardened runtime，未注入 Sentry DSN。
- **UI 是 W12 dist/index.html 17:39 的只读快照**，用 APFS clone 复制到 W06 dist；不是10:04旧产物，也不是声称已做统一候选最新UI构建。原 W06 10:04 dist 完整保留于 `.cache/dist-pre-native-stub-20261107-1816`，未删除旧文件腾空间；未改 W12 dist/source。
- 最终候选仍需集成分支统一前端构建及 UI 验收。本轮只接受打包入口与关联功能回归。

## 命令与证据

工作目录 `wt/W06`，以下 OUT 指上述外置新根；所有重任务均经根 bin/heavy。GUI 用外置 `run-native-check.mjs` 透明 import 原测试脚本，使 heavy 正确分到 gui；不改变 argv/env/canary/断言。

```sh
BUILD_NUMBER=20000 DEEP_STUDENT_BUILD_NUMBER=20000 \
DS_ELECTRON_PACKAGE_OUTPUT="$OUT/release" TMPDIR="$OUT/tmp" \
  /Users/heli/der/tmp-58068a80b38aa6d0/bin/heavy env -u SENTRY_DSN \
  node electron/scripts/package.mjs --mac --dir

TMPDIR="$OUT/tmp" /Users/heli/der/tmp-58068a80b38aa6d0/bin/heavy env -u SENTRY_DSN \
  node "$OUT/run-native-check.mjs" "$PWD/electron/scripts/__tests__/packaged-smoke.mjs" \
  --app "$OUT/release/mac-arm64/Deep Student.app" --keep

TMPDIR="$OUT/tmp" /Users/heli/der/tmp-58068a80b38aa6d0/bin/heavy \
  node "$OUT/run-native-check.mjs" "$PWD/electron/scripts/verify-fuses.mjs" \
  --app "$OUT/release/mac-arm64/Deep Student.app"

TMPDIR="$OUT/tmp" /Users/heli/der/tmp-58068a80b38aa6d0/bin/heavy env -u SENTRY_DSN \
  node electron/scripts/__tests__/run-native-cache-isolation.mjs \
  --app "$OUT/release/mac-arm64/Deep Student.app" \
  --cache /Volumes/DSWork/W06-packaging-smoke-20261107-1745/tmp/ds-packaged-smoke/run-ceJL2E/dev-overrides/compile-cache
```

打包 exit 0：migrations 逐字节一致，332 个包生产闭包全部进 asar，测试 sqlite-busy 二进制/源码不进包。正常 builder 签名阶段在 stub 安装之后完成，不手动绕过签名。

smoke 18/18：首窗3679ms、Host ready5009ms、42/42插件；包内 koffi/better-sqlite3、SQLite/FSRS、worker、诊断导出、假LLM流式交互均通过；日志无ERROR、page errors0。native 审计实际PID23980，精确记录两个缓存输入；JS独立记录其8个DS_*输入。数据在 `tmp/ds-packaged-smoke/run-KLlxBL/`。

完整加固13/13：原 framework fuse wire、asar-only、完整签名、5个main/helper hardened runtime、entitlements等均通过；修改ASAR的子副本在原framework的asar_util.cc报header完整性失败并SIGTRAP；RunAsNode、inspect、松散app、DYLD注入行为均保持防护。

既有输入4/4：实际使用上一轮遗留的398文件缓存，不伪造空目录；PORTABLE=1，native审计PID24650，两变量真实删除，JS capture canary另行删除且没有截图；正常Host/本地frontend可用，Host cache在新userData。退出后比较完整输入树的文件字节、mode/mtime，验证脚本不向输入写入也不删除输入。只读遍历可能影响文件系统atime，未把atime当作不变条件。数据在 `tmp/ds-packaged-smoke/existing-cache-oDry5P/`。

根 `.reports/server/land-test-E/` 日志：`native-stub-delivery-build.log`、`native-stub-delivery-smoke.log`、`native-stub-delivery-fuses.log`、`native-stub-delivery-existing-cache.log`、`native-stub-unit.log`、`native-stub-existing-cache-unit.log`。

## 发布与平台限制

- 实测仅本机 macOS arm64 ad-hoc 包；**x64 仅测试编译参数/目标校验逻辑，未实测x64二进制或机器**。universal2明确不支持，不生成伪通用包。
- 未验证Developer ID、notarization、Gatekeeper/TCC身份、发布升级/relaunch链及其它macOS版本。现有签名/entitlements流程不降级，但不把ad-hoc验收当正式发布验收。
- 固定版本framework的导出ABI/上游stub职责是维护前提。升级Electron时必须核对源码、符号及签名/行为后再变更guard；不能直接改版本字符串跳过审查。
- Windows/Linux保持现有入口；本次无其Node初始化前修复承诺。
- 未证明恶意缓存可执行任意代码、未演示TCC/ASAR可利用绕过。该安全影响边界仍见 `runtime-cache-options.md`；本次关闭的是已实测的mac打包入口缓存隔离偏差。
- 不改共享Electron、依赖版本、INT、host/kernel、host/e2e/smoke或vitest共享setup；无SSH/G3/全量Electron源码构建；旧已留证包保留。
