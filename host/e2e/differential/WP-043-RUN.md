# WP-043 真实 A 首命令：运行说明与证据边界

## 当前入口

输入：`fixtures/differential/wp043/get-app-version.v0.json`（WAVE0 §3 v0）。
仅 `get_app_version({})`、empty seed、A1/A2 两个独立进程；没有八实例池。

`record/tauri-harness.html` 从原 Tauri `devUrl` 提供。
`tauri-harness.mjs` 在真实 main webview 内调用 `__TAURI_INTERNALS__.invoke`。
不复制业务函数，不构造替代 AppState，不依赖 WebDriver。

原 Rust：`src-tauri/src/commands.rs:499–507`；注册 `src-tauri/src/lib.rs:1913`。
入口仅返回编译版本字符串，没有可达 `Err`、事件 emit 或数据库写入。
这不是 Rust 行覆盖报告，也不构成例外审批。

## 构建与运行

全部命令从 X7 工作树通过正式 job.mjs。保持默认生产 features、dev、coverage、jobs12。
已提交构建与精确环境见各 `fixtures/differential/wp043/builds/<job>/job.json`。
重试的 PROTOC 指向原锁中已下载的 vendored 可执行文件，不是安装新依赖。

成功后归档：

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- node scripts/electron-migration/record/tauri-build-receipt.mjs BUILD_JOB SUBMITTED_SHA
```

启动前依赖：

- 成功的真实 Tauri coverage build receipt 与同一 binary SHA256。
- D46 路径放行后由授权配置将 identifier 改成 `com.deepstudent.differential`，按同 target 增量构建。
  当前脚本**拒绝**原生产 identifier；不以 TAURI_CONFIG 绕过配置门禁。
- X3 正常 main 的 `scenario-seeds.ts` 与 `database-state.ts`；缺少直接报 MODULE_NOT_FOUND，绝不补空库。
  18:14Z 已随 main `e6bce8aae` 合入本工作树，新增第五条 X7 消费测试验证此接缝。
- 已有 Xvfb、dbus-run-session；LLVM 工具缺失不妨碍保存 raw profiles，但妨碍产出覆盖率报告。

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- xvfb-run -a dbus-run-session -- node scripts/electron-migration/record/tauri-first-command.mjs fixtures/differential/wp043/get-app-version.v0.json fixtures/differential/wp043/builds/BUILD_JOB/receipt.json fixtures/differential/wp043/runs/NEW_RUN
```

输出目录必须新建；A1/A2 独立 HOME/XDG/TMP，empty seed 先创建一次再复制。
保原输入字节及 SHA256、实际构建提交/tree/环境/锁及 binary SHA256、每步原参数、
返回/错误 JSON 原文、renderer 投影、HTTP IPC 原文、请求的 DB 快照、退出后的 DB 终态、
应用 stdout/stderr、每个应用进程的 `.profraw`。A1/A2 原始 DB 差异单独保存，不自动归一。
失败保存 failure.json，抛出原始启动/传输/读取错误；不能冒充业务 Err。

## 原精度与事件边界

- 响应在 Tauri 调 `response.json()` 前，用 `response.clone().text()` 保存原文。
  这条实际路径基于下载锁定的 tauri 2.11.5 `scripts/ipc-protocol.js:37–57`。
  若 WebKit 改走 postMessage fallback，没有原文就报阻断。
- 首包原参数限定 `{}`。没有宣称浏览器 JSON.parse 对一般大整数入参无损。
- Tauri 事件源 `event/listener.rs:283–289` 只向已登记名字的监听者发事件，
  `event/mod.rs:200` 用 eval 注入 JSON。没有 wildcard 原精度全局事件源。
  本命令源码不发事件；记录明确标注 `no global event subscription`，不会把空数组说成全局事件完备。
  X5/后继提供一般事件原文与终止条件前，不扩展到流式命令，不输出命令 C pass。
- 关闭走现有 `plugin:process|exit`（原 capability `process:default`），
  进程结束后才读最终 DB；超时/信号退出不称完整录制。
- build-script/proc-macro 的 profraw 与 A1/A2 应用 profraw 目录严格区分。
  现有 build-script 原件不算 get_app_version 的运行覆盖率。

## v0 最小已验证范围

`scenario-v0.mjs` 显式验证 JSONPath（`$`、`.name`、`.*`、`[index]`、`[*]`、`["key"]`）；
未知语法明确报错。任何非空 normalize 都需 C2 审核，当前没有变换或动态 ID 抹除。
`${n.path}` 仅解析先前成功原始结果，保整数/小数词法精度、null/缺失区别和重复引用。
不插值成字符串，不把所有 ID 折成同一 placeholder。

`scenario-v0.test.mjs` 的真实 SQLite/HTTP 用例验证：返回中的 9007199254740993 经重复引用
写入 FK，与事件 payload、PK 一致；storageClasses 保留；原始小数和 -0 HTTP 字节保留；
缺失/未来/失败引用、传输失败、DB 读取失败、未批准 normalize 均拒绝。
**这是 recorder 单元证据，不是真实 A 答案或 X5 的事件精度验收。**

没有 TESTMAP 去向调整、没有 34-ID 增删、没有命令 C/golden pass 输出。

## WP-153：共享 v0 运行准备（Node 已验证，应用尚未运行）

源协议仍是 X3 [`SCENARIO-V0.md`](../data-compat/SCENARIO-V0.md)。先用
`createSeed(scenario.seed, catalog)` 构造一次静止源，再为每次运行调用：

```js
import { createSeed } from './host/e2e/data-compat/__fixtures__/scenario-seeds.ts';
import { prepareScenarioRun } from './scripts/electron-migration/record/scenario-v0.mjs';

createSeed(scenario.seed, catalog);
const one = await prepareScenarioRun(scenario, { catalog, directory: firstDirectory });
const two = await prepareScenarioRun(scenario, { catalog, directory: secondDirectory });
// one.seed / two.seed 是 X3 原始 SeedDirectory，保留 provenance。
// spawn 的 env 使用 one.env / two.env；不修改父进程 process.env。
// 应用配置使用各自 seed.dataDir / seed.dataLocalDir。
```

每个返回对象包含 `source/seed/directories/env`；`HOME=<seed.directory>/home`，
`XDG_DATA_HOME=seed.dataDir`，config/cache/runtime/tmp 也均位于同一副本。
`seed.dataLocalDir` 保留 X3 的 `<副本>/local-data`，供应用的独立 local-data 配置消费；
不存在一个通用 XDG 环境变量可替代该应用配置。原 Tauri 首入口仍限 empty/get_app_version，
沿用其 XDG 根 + 编译 identifier/slot 布局；不宣称 SQL seed 已映射到真实 Tauri 数据布局。

skill-zip-v0 的 `~/w0-zip-seeds/...` 参数原样保留，由两端应用按各自 HOME 展开；
准备入口按 X3 `SKILL_ZIP_SEED_FILES` 检查源文件，缺文件/文件被目录替换直接失败。
未知名称和未创建源保持 X3 错误；不自动重建、不回退 empty。源不写入运行目录。
此实现解除 X3 文档 §“v0 接缝”中的准备能力缺口；实际 A/B 录制仍待运行依赖。

既有 Node suite 新增三项：十个合成 ZIP 的两个独立副本与真实 Node 子进程 HOME/字节读取、
未知/未创建/逐个缺文件失败及源不变、原 empty/get_app_version 输入准备。
这些只是准备验证；ZIP 的 `synthetic-zip` 与 SQL 的 `sql-constructed` 标签不变，
没有历史 A 答案、没有 A1/A2/golden、没有 G3/C 升级。
