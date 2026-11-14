# SEC-E06 Host 半：社区插件隔离的分块与顺序（W01）

依据：`reviews/ELECTRON-SHELL-SECURITY.md` SEC-E06 第 1、3 条与 W01 修法建议；现状与阻断项见 `API.md` §16.7。
UI 半见 `src/ui-kernel/SEC-E06-SANDBOX-DESIGN.md`（W17）。决策 5：1.0 前不开放社区插件，下面全部是开放前的阻断项。

## 1. 已落地

| 块 | 内容 | 位置 | 测试 |
|---|---|---|---|
| K0 | `plugin:host\|call` 调用方绑定（调用方插件 id = 服务所属插件 id），缺 `caller` 时 `warn`（计数）/ `require`（拒绝）两档 | `runtime.ts::hostCall`、`DEFAULT_HOST_CALL_CALLER_MODE`、`DS_HOST_CALL_CALLER` | `tests/ui-bridge.test.ts`、`tests/serve-preimported.test.ts`、`tests/env-config.test.ts` |
| K1 | v1 不给社区插件 `commands` / `protocols` / `backendEvents` / `shell`：装载时拒绝 `meta.commands` 与注入，运行时拒绝调用（`KERNEL_API_FORBIDDEN`） | `kernel.ts::assertKernelSurface`、`manifest.ts::checkPluginModule` | `tests/community-kernel-surface.test.ts` |

K1 调用方清单（`rg` 于本轮）：
- 社区插件：`examples/plugins/community-word-of-day`、`translation-custom.mjs` 都不用这四个服务（只用 `ctx.get('log')`），不受影响。
- 官方插件：没有 `packageRoot`，不受影响；`host/plugins` 中 `Service` 子类里经 `this.ctx` 取 kernel 服务的只有 `chat-pipeline/index.ts:307`（箭头函数字段，取服务自己的 `ctx`），社区插件调用它时事件照常发出。
- 移动端：profile 没有社区条目（没有 `packageRoot`），不受影响。
- 归属不明（`ctx.root.*`、kernel 自身）：保持原行为。这是同进程方案的已知缺口，由 K5 关闭。

## 2. 剩余分块（按顺序）

| 顺序 | 块 | 归属 | 人日 | 前置 | 内容 |
|---|---|---|---|---|---|
| 1 | K2 翻转默认 | 主代理 | 0.1 | W17 `src/ui-kernel/kernel.ts` 的 `ctx.ui.host` 与 W14 `mobile/src/main.ts` 的诊断调用带 `caller` 并进入 INT | `DEFAULT_HOST_CALL_CALLER_MODE` 改为 `require`；`ui-bridge.test.ts` 的默认值断言同步改 |
| 2 | K3 同意记录 | W01 + W17 | 2 + 1 | 无（同进程即可做） | 记录 = 插件 id + 版本 + 权限集合摘要，存在 Host 自有文件（数据目录下，不在 `plugins/`）；只能经 kernel 命令写入（主窗口、本地 origin，同 SEC-E11）；profile 中没有匹配记录的社区条目降级 `CONSENT_REQUIRED`；权限增加后只授予已同意的交集。W17 做同意界面 |
| 3 | K4 拉起与端口转交 | W06 | 2 | 无 | main 为每个社区插件 `utilityProcess.fork` 一个子进程（打包版 RunAsNode 已关，Host 不能自己 fork）；环境变量白名单，不继承 main 的 env；MessagePort 转交 Host；崩溃 / 退出事件回报 Host |
| 4 | K5 子进程运行时与服务代理 | W01 | 5 | K4 | 子进程跑最小 Cordis Context：注入的服务 = 清单 `service:` ∩ 同意记录，全部是异步代理（参数与返回值纯 JSON，`{ signal }` 映射为取消消息）；插件 `provides` 的服务在 Host 侧也是异步代理；`meta.remote` 照常经 `plugin:host\|call`；崩溃 / 超时按插件降级，卸载即结束进程。先审一遍要开放给社区的服务（`contracts/services/`）是否都是异步、纯 JSON、无回调参数 |
| 5 | K6 移除同进程装载 | W01 | 1 | K5 | `profile.ts` 不再在 Host 进程 `import()` 社区模块；`checkPluginModule` 改在子进程握手时用模块 meta 做；K1 的运行时检查保留为纵深防御 |
| 6 | K7 安装期拒绝 kernel 服务权限 | W01 + W09 | 0.5 | 安装器（P1） | `assertInstallable` 拒绝 `service:commands` 等声明；W09 gate 同步，保持与 kernel 一致性测试逐条一致 |

K3 不依赖进程隔离，先做可以立刻关掉"放一个 `user.profile.json` 就装上插件"；K4、K5 是工作量主体，K6 之后
§16.4 的"防误用，不是安全边界"才可以改写。

## 3. 每块的验收

- K2：缺 `caller` 的 `plugin:host|call` 在默认配置下被拒（现有 require 模式测试改为默认模式）。
- K3：没有同意记录、记录版本不符、权限摘要不符各降级一次；新增权限在重新同意前注入不到；写记录的命令在非主窗口与远程 origin 被拒。
- K4：子进程 `process.env` 只含白名单变量；子进程崩溃后 Host 收到退出事件；打包版冒烟（`electron/scripts/__tests__/packaged-smoke.mjs`）能拉起。
- K5：子进程里 `import('node:fs')` 拿不到 Host 的服务；未授权服务不存在；跨进程取消生效；超时与崩溃各降级一次；卸载后进程退出。
- K6：Host 进程的模块图里没有社区模块（装载后检查 `import.meta` 记录或 loader hook）；K1 测试照常通过。
- K7：安装期与启动期对同一份 package.json 给出同一个错误码。

## 4. 不在本计划内

- 移动端社区插件：移动端没有 `utilityProcess`，需要另行设计（Web Worker + 同样的 RPC 服务面）。
- UI 半沙箱：W17 设计文档。
