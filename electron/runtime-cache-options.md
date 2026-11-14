# NODE_COMPILE_CACHE：运行时修复途径与安全裁定依据

后续主编排已批准并完成固定mac入口集成；18/18+13/13及既有缓存回归证据见 `native-stub-delivery.md`。本文保留原研究时点与安全影响边界，不把后续mac验收扩张为全平台/正式签名验收。

核查时间：2026-11-07。研究基线 W06 `396633e8`；本轮没有修改产品代码、package.json/lock 或安装的 Electron，也没有构建 Chromium/Electron 源码。

## 明确结论

1. **没有找到可直接升级解决此问题的已发布运行时、fuse 或跨平台打包元数据。** 核了当前稳定 Electron **45.2.3 / Node 24.22.2**、维护分支 44.10.2 / 43.8.7，以及已发布的 46.0.0-alpha.7 / Node 26.13.0。对应源码仍有相同入口；这是源码核查结论，未下载或实跑这些新版本。不能建议仅升级 45.2.3 就关闭问题。
2. **最小跨平台可靠修复点在 Electron 原生 `NodeBindings::Initialize`，首次 Node 执行之前，而不是应用 main JS。** main-only 过滤可保留 Host 已固定到 userData 的缓存。需要定制 Electron 二进制并重新签名/验收，本轮未实施。
3. **macOS 有较轻的候选：替换主启动 stub，在同一进程清变量后调用现有 framework 的 `ElectronMain`。** 理论上只编译一个很小的 Mach-O，不需重编整个 Electron；已核导出符号，**尚未完成产品包集成验证**。Windows/Linux 不能照搬其 framework ABI，独立 wrapper + 原始 exe 不构成完整修复。
4. **已证的是外部磁盘缓存入口与读写边界问题，不是任意代码执行或已利用的 ASAR 完整性绕过。** 原 SEC-E02 的环境注入威胁模型相关，但原高危的直接 Host 入口/远程 origin 问题不能自动移植为本缓存问题的已证影响。

## 1. 上游发布与控制项

[GitHub latest release](https://api.github.com/repos/electron/electron/releases/latest) 返回稳定版 45.2.3，2026-11-04 发布；[最近发布记录](https://api.github.com/repos/electron/electron/releases?per_page=8) 中 45.2.2 更新 Node 为 24.22.2，45.2.3 主要是 Chromium/V8 等回移修复，没有缓存变量修复说明。不能只据发布说明判定，故也核了以下源码：

- [45.2.3 node_bindings.cc](https://github.com/electron/electron/blob/v45.2.3/shell/common/node_bindings.cc#L467)：`SetNodeOptions()` 仅按 fuse 处理 `NODE_OPTIONS` / `NODE_EXTRA_CA_CERTS`；`NodeBindings::Initialize()` 约 L713 调它，约 L737 设置 `kDisableNodeOptionsEnv`。没有处理 `NODE_COMPILE_CACHE`。
- [45.2.3 DEPS](https://github.com/electron/electron/blob/v45.2.3/DEPS#L6) 指定 Node 24.22.2。
- [45.2.3 fuse schema](https://github.com/electron/electron/blob/v45.2.3/build/fuses/fuses.json5) 没有 disk compile cache fuse；与核查的 43.8.7、44.10.2、46.0.0-alpha.7 schema 相同（内容 blob `1e251db2812681e916a8d8aebc82c428279de851`）。[官方 fuse 文档](https://www.electronjs.org/docs/latest/tutorial/fuses#nodeoptions) 明确 nodeOptions 的范围是上述两个变量，不包含所有 NODE_*。
- [44.10.2](https://github.com/electron/electron/blob/v44.10.2/shell/common/node_bindings.cc)、[43.8.7](https://github.com/electron/electron/blob/v43.8.7/shell/common/node_bindings.cc)、[46 alpha.7](https://github.com/electron/electron/blob/v46.0.0-alpha.7/shell/common/node_bindings.cc) 的 `SetNodeOptions()` 同样没有处理编译缓存变量。
- [Node 24.22.2 env.cc L1289](https://github.com/nodejs/node/blob/v24.22.2/src/env.cc#L1289)：`InitializeCompileCache()` 直接 `SafeGetenv("NODE_COMPILE_CACHE", ...)`；非空则启用。`NODE_COMPILE_CACHE_PORTABLE=1` 只改变键的路径计算，不禁用缓存。
- [Node 26.13.0 env.cc L1347](https://github.com/nodejs/node/blob/v26.13.0/src/env.cc#L1347) 保留此行为，新增 READONLY 选项也不是忽略外部缓存输入。
- 核了 45.2.3 的 `patches/node/` 清单及 startup-snapshot patch；没有发现修复此环境变量的补丁。上游 issue 搜索 `repo:electron/electron NODE_COMPILE_CACHE` 当次返回 0；这不是“世界上绝无修复”的证明，结论限于上述已核版本与公开接口。

### 看似便宜但不满足完整边界的选项

- **`NODE_DISABLE_COMPILE_CACHE=1`：** 如果在进程执行前存在，确实有效；但是一个由外部调用者可删改的环境变量不是应用内生的限制。它也会被 Host 继承而禁用 Host 缓存，不能直接加进整个应用环境后宣称满足现有 smoke。
- **mac Info.plist `LSEnvironment`：** 可为 Launch Services 启动设置上述变量，但 [Apple 文档](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/LaunchServicesKeys.html) 明确直接执行二进制不受它控制；现有 smoke 及本地环境注入威胁均包含直接执行。不足以关闭问题。
- **Windows 快捷方式 / Linux .desktop：** 只影响该入口，攻击者可以直接启动真正 exe；无通用的可强制清理进程环境的 manifest 属性。
- **snapshot fuse：** 改变 V8 snapshot 选择，不跳过 Node 的 `LoadEnvironment -> InitializeCompileCache`；不是磁盘缓存控制项。
- **JS 清变量 / 设置 disable / relaunch / 删目录：** 对首次读取太晚；删目录还会触碰调用者文件。不实施。
- **降级到没有该机制的老 Node/Electron：** 不是已修版本，而且本项目依赖 Node 24 类型剥离、Electron ABI 和当前安全补丁；不是最小兼容修复。

## 2. 最小独立实测（已执行）

外置现场：`/Volumes/DSWork/W06-packaging-smoke-20261107-1745/runtime-probe/`。现有 Electron 45.2.1 / Node 24.22.1，macOS arm64。没有复制或修改 Electron 分发，不建 BrowserWindow，不访问网络；HOME/tmp/userData 都在实验目录。

- `launcher.c` 仅 `unsetenv` 两个缓存输入，然后 `execv` 现有 Electron。
- `probe.cjs` 在应用第一段代码查询 `getCompileCacheDir()`；late 模式再删除变量、设置 disable、尝试 enable，然后再次查询；最后主动 flush 后退出。
- `run-native-cache-probe.mjs` 串行启动四个独立进程，每个有全新的缓存目录。`bin/heavy cc launcher.c -o launcher`；随后 `bin/heavy node .../run-native-cache-probe.mjs <existing Electron executable>`（文件名匹配 heavy 的 run-native/gui 分类），均 exit 0。

结果：

- **direct：** entry 执行前已启用外部缓存，目录存在。
- **late-js-disable：** 删除环境变量并设置 disable 后，`enableCompileCache()` 返回 status 3 / `Disabled by NODE_DISABLE_COMPILE_CACHE`，但 **getCompileCacheDir 前后仍是原外部目录**，并且 flush 后仍有缓存。status 3 只表示这次 enable 调用被禁用，不能当作既有 handler 已关闭。
- **early-env-disable：** 首次 entry 的缓存目录为空，金丝雀目录不创建。
- **native-launcher：** 首次 entry 的缓存目录为空，金丝雀目录不创建。

原始日志：根 `.reports/server/land-test-E/runtime-cache-probe.log`；机器可读结果 `runtime-probe/results.json`。日志字段 `files=3` 是递归目录项数（1 子目录 + 2 文件），不是 3 个缓存文件。

限制：该微型实验使用开发分发的正常 main 模式，不是 RunAsNode，不验证产品签名或 launcher 旁路封堵。产品 fuse 已关仍落盘的证据来自上一轮真实包 smoke（398 文件、17/18）。这些证据结合，足以确认修复必须早于 JS，不足以声称 launcher 已可发布。

## 3. 最小跨平台原生 patch（建议优先的语义）

固定版本参考：`shell/common/node_bindings.cc`，`NodeBindings::Initialize()` 中 `auto env = base::Environment::Create();` 后、`SetNodeOptions(env.get())` 前，原生过滤：

```cpp
if (browser_env_ == BrowserEnvironment::kBrowser &&
    !fuses::IsNodeOptionsEnabled()) {
  // Emit a native diagnostic if either inherited variable was present.
  env->UnSetVar("NODE_COMPILE_CACHE");
  env->UnSetVar("NODE_COMPILE_CACHE_PORTABLE");
}
SetNodeOptions(env.get());
```

这是建议补丁位置/语义，不是已编译验证的提交。处理失败必须阻止进入 Node，不能继续带着原值启动。需要对齐上游 fuse 契约或单独固定发行策略，不能声称现有 nodeOptions fuse 原本已有这个语义。

为什么 main-only：外部启动环境进入 main 时移除；之后 HostSupervisor 从可信配置注入 `<userData>/host-compile-cache`，utilityProcess 仍可使用它。若把过滤无条件放进公共 `SetNodeOptions()`，所有 utilityProcess 都会丢掉合法缓存，破坏现有 Host 缓存约定。Node [LoadEnvironment](https://github.com/nodejs/node/blob/v24.22.2/src/api/environment.cc#L593) 在 `StartExecution` 前调用 `InitializeCompileCache`，因此上述位置早于首次模块编译。

平台影响：同一公共 C++ 位置覆盖 mac / win / linux 的 browser Node 初始化；需要分别构建各 OS/arch 的 Electron 二进制，保留现有 Node ABI，然后走现有 fuses、asar integrity 和签名流程。不会要求 package.json/lock 变化，但运行时分发来源/版本及 CI 工具链必须由主代理明确接管，不能偷偷替换共享 node_modules。

验证必要项：同版本未修对照必须复现；修后第一段应用 entry `getCompileCacheDir()` 为空；新外部缓存目录不创建（原 smoke 金丝雀保留），已存在的缓存输入也不被启用；Host 缓存在 userData 且 worker/wasm 可用；各平台正式产物直启、系统正常入口、重启/升级入口均通过。若原生清变量后 JS 已看不到变量，现有“main 日志包含每个忽略变量”的单项检查须改成分别验证原生日志与 JS 日志，不能删除缓存金丝雀或直接把失败变成 warning。

## 4. launcher 的平台边界与 macOS 轻量候选

**不可采用：** 签一个 wrapper，rename 原始已签名 Electron exe 留在包内再 exec/spawn 它。实验表明清环境后 exec 有效，但攻击者可绕过 wrapper 直接执行原始 exe；那仍是可借用应用身份的入口。不能只把 Info.plist/快捷方式指向 wrapper。

**macOS 候选（不用完整源码构建，但还需集成验证）：**

- 上游 [electron_main_mac.cc L70-L111](https://github.com/electron/electron/blob/v45.2.3/shell/app/electron_main_mac.cc#L70) 的主 stub 最终调用 framework 的 `ElectronMain(argc, argv)`。
- [electron_library_main.h](https://github.com/electron/electron/blob/v45.2.3/shell/app/electron_library_main.h) 明确以 C ABI 导出 `ElectronMain`；本机 `nm -gU` 也确认 framework 有 `_ElectronMain`，不是只凭源码猜符号存在。
- 构建一个新的主 Mach-O，启动时原生清变量，再**同进程**调用同包内 framework 的该入口。保留原 CFBundleExecutable 路径，不把旧主 stub 作为备用入口发布；framework/helper 无需被复制到包外或改为不受签名的路径。
- `afterPack` 签名前部署此 stub；保留所需 stdio 初始化、正确 framework rpath、CPU/minOS、release 禁用 RunAsNode 的行为。主 stub 必须是包内签名主体的一部分；重签完整 app、原有 hardened runtime/entitlements/fuses/asar integrity 校验不能省略。
- helper 自身的启动/沙箱检查不要用简化主 stub 替换；要验证 Host fork、relaunch、单实例、updater 及 `app.getPath('exe')` 仍是对外的受保护入口。还需核 framework 初始化器是否在 main 前触碰缓存；本轮未做该 stub 产品实验，不把它当已闭环。

这比 JS/relaunch 真修得早，也没有留原主 exe 的 obvious bypass，但目前只能裁定为**mac-only 可实施候选**，不是已经验证的跨平台修复。Windows / Linux 的主执行路径是 `ContentMain` 等单体入口，不能靠这个 mac C ABI 套壳；无旁路的同进程原生入口改动仍需定制运行时。不要为三平台统一再搭一个复杂 launcher 框架。

## 5. 实际影响与原 SEC-E02 的范围

原裁定见 `reviews/ELECTRON-SHELL-SECURITY.md:70-84`：明确是 `DS_HOST_ENTRY` / profile 直接执行任意 JS，以及 dev URL/front-end dist 把远程页面当成本地高权限 origin。攻击前提是能影响用户启动环境的本地进程；目标是防止借签名应用及 TCC/白名单身份执行代码，不是只防网络攻击。

本缓存问题与该**威胁模型**相关，但并非原文列出的利用路径：

- 已确认：外部路径在 JS 拦截前被接受；已有缓存可以成为 Node 的候选输入，正常退出可向该目录写缓存；源机制由源码及微型实测相互印证。这里不是任意路径/任意内容文件写，缓存子目录和文件名由运行时规则生成。
- [Node compile_cache.cc](https://github.com/nodejs/node/blob/v24.22.2/src/compile_cache.cc#L108) 会校验 magic、源码长度/CRC32、缓存长度/CRC32；缓存按 Node 版本、arch、V8 tag、POSIX uid 分目录，然后交给 V8，V8 仍可 reject。24.22.1 与 24.22.2 的该文件内容 blob 相同（`6b054db1ccc2e8a47db0951b8a52d6b0eb9cee43`）。**目录创建本身完全没有证明恶意字节码被接受。**
- CRC32 是一致性检查，不是签名/真实性认证，故也不能反向断言“存在源码 hash 所以安全”。[module_wrap.cc](https://github.com/nodejs/node/blob/v24.22.2/src/module_wrap.cc#L533) 的确用 `kConsumeCodeCache` 并检查 V8 rejected 结果；这表明要裁定替换代码执行，需要兼容的缓存样本及被实际执行的证据，而不是仅看磁盘落盘。
- 本轮没有构造恶意缓存、没有演示任意 JS 执行、没有证明签名/ASAR 的可利用绕过、没有测试 TCC 权限继承。可以称“外部 bytecode/cache 输入未受 ASAR 签名覆盖的潜在信任边界缺口”，不能称“已证 RCE / 已证 TCC 绕过”。旧进度中的“绕过 asar 的一条路径”应按此证据边界理解，不是成功利用结论。
- 远程网页/普通 renderer 是否能设置下次 main 启动环境，没有本轮证据；不能扩张为远程利用。按原 SEC-E02 的本地环境注入模型，也不能仅以“同用户本来能写文件”为由忽略应用身份差异。

**建议主代理裁定：** 原 SEC-E02 直接入口防护已有单独通过证据；保留本缓存失败为“已复现的运行时环境隔离偏差，利用影响未证”，不自动套用原高危/RCE结论。如交付要求所有启动输入均不越过缓存边界，则原生修复前不能签为 18/18；若接受暂缓，应显式记录范围/风险例外，而非修改 smoke 断言把它刷绿。当前技术上优先协调 main-only 原生过滤；若仅需先解决 mac 交付，可授权下一步小型同进程 stub 产品实验。
