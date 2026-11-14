# W21 进度（审计编排轮，只做 MCP）

## 第三轮（F 趟；a251949f 复核中，只追加提交）

INT 仍是 `1d1fdb78`（上一轮已合，无需再合）。

| # | 项 | 状态 | 提交 |
|---|---|---|---|
| R3-1 | `equivalence/mcp-service.test.ts:440` Linux 必红（A17 补丁） | 完成 | 4245db4f |
| R3-2 | A05 必须修 1：卸载插件 dispose 后台 OAuth 的插件级测试（V09-P1-4） | 完成 | 1c7e61eb |
| R3-3 | A05 必须修 2：脚本名校验登记 RF-W21-bat-script-metachar | 完成 | 0bb6677a |
| R3-4 | A20 跟进 I：`oauth-websocket.test.ts` port + 1 被占时不再空过 | 完成 | 2dc8d6dc |
| R3-5 | A20 跟进 H：R2-2 的 G3 影响范围措辞 | 完成 | 本提交 |

### R3-4（`equivalence/oauth-websocket.test.ts` 'fixed port, logDir and node …'）

原写法 `.catch(() => null)` 后直接 `return`，任何启动错误都让用例不跑断言就通过。现在只对 EADDRINUSE 重新探端口，
最多 5 次，仍被占就抛错；其他错误照常抛出。断言未改。预加载脚本让 port + 1 每次都 EADDRINUSE：旧写法 1 passed
（断言全被跳过），新写法失败并报 `port + 1 was taken on 5 probed ports`；只占一次：新写法重试后 1 passed。
整文件原生 9/9、模拟 Linux 9/9。

### R3-1 根因

用例第一次 `startMcpService({ logDir, selfContained: true })` 没给端口，OAuth 服务器按 `mcp-service.ts:397`
（`oauthPort ?? (port ? port + 1 : 0)`）监听 0；第二次给了端口，OAuth 在 `port + 1`。`bindings().oauth` 的
`url/resourceUrl/noRegistrationResourceUrl` 两次必然不同。macOS 临时端口顺序分配（本机连续 6 次 `listen(0)`：
55934…55939），第一次的 OAuth 端口碰巧是 `P + 1`；Linux `bind(0)` 从随机偏移起只挑奇数端口
（`inet_csk_find_open_port` 的 `offset |= 1`），`P + 1` 是偶数，所以每次必红（B/C 趟的 P 是 43595、41651，都是奇数）。
夹具约定（固定端口时 OAuth 在 `port + 1`，G3 用 47130/47131）与 Rust 侧要求一致（`auth.rs:697-698,902-908`
资源源带端口并持久化），所以修测试：先起一个探测实例拿到两个空闲端口，两次正式启动都固定 `port` 和 `oauthPort`；
`:446` 的整份 `toEqual` 不变。

- 模拟 Linux `bind(0)`（`--import` 预加载，随机奇数端口）：修复前 3/3 红，差异只有 oauth 三个叶子
  （例：第一次 59609，第二次 56325+1=56326）；修复后 5/5 绿，另设 `TMPDIR` 1/1 绿；整文件原生 28/28、模拟 Linux 28/28。

### R3-2 红 → 绿（`tests/oauth-lifecycle.test.ts`）

新用例：abandon('reloaded') 后卸载 `dstu.mcp`，回调端口必须关闭、不发 token 请求。临时把 `index.ts:242` 改成
`ctx.effect(() => () => {})`：新用例红（`:256` `expected 2 to be 1`，端口仍在监听），其余 6 例照旧绿；还原后 7/7 绿。

### R3-3（`tests/stdio-spawn-plan.test.ts`）

`"`/结尾 `\` 改用 std 1.98.1 文案：改前该用例红（仍是 master 文案），改后 39/39 绿。`^`/`%` 照 master 拒绝，
标 `RUST-FIX(RF-W21-bat-script-metachar)`；临时移走登记文件时 rust-fixes 报孤立标记 1 错误，放回后 0 错误。

## 第二轮（b63e7ff0 审计中，只追加提交）

合入 INT `2be7ed80` → `6acd124e`（INT 未改 host/plugins/mcp，无冲突）；交付前再合 INT `1d1fdb78` → `d6d75b58`
（带入 W05 的 browser `web-search-fallback.ts`，在新 registry 上 8 例 + llm 注入 1 例绿）。

门禁（`d6d75b58`）：boundaries 0 违规；import-cycles 0 new；rust-fixes 0 errors；portability ok；
contracts:check OK；tsc 退出码 0；`vitest host/plugins/mcp` 35 文件 369 例全绿。

| # | 项 | 状态 | 提交 |
|---|---|---|---|
| R2-1 | LA-03 web_search 引擎门/路由/聚合、host_str、f32 score、api 导出 | 完成 | ee4a24a5 |
| R2-1d | W05 交接：`.reports/W05-handoffs/W21-web-search-fallback-use-mcp-registry.{md,patch}` | 完成 | —（仓库外） |
| R2-3 | SPEC/ACCEPTANCE preheat/reload 文字 + web_search 文字 | 完成 | 9dd25653 |
| R2-2 | equivalence 临时目录泄漏 | 完成 | e93f587f |
| R2-4 | V09/V10 中 host/plugins/mcp 的 P2/P3 | 无剩余（第一轮已全部修完） | — |

### R2-2 红 → 绿（`equivalence/mcp-service.test.ts`，按 `ls $TMPDIR | rg -c mcp-wave0-` 计数）

- 修复前：389 → 413，本次运行新增 24 个 `mcp-wave0-*`（28 例全绿，泄漏不影响断言）。
- 第一次修复（只在 `stop()` 里删目录）：6 例红，`ENOENT … mcp-wave0-P38H7v/stdio-records.jsonl`
  （`mcp-service.ts:402 stdioRecords` ← `liveStdio` ← 测试 afterEach :29）。原因：`stop()` 之后
  `records()` / `liveStdio()` 仍要可读（测试 :421 在用例内 stop，afterEach 再读；CLI 在 stop 后打印 records），
  afterEach 抛错后 `services` 未清空，后续 5 例连锁失败。上一轮报告建议的补丁不完整。
- 最终修复：只对自建目录，在 `stop()` 删除前把 stdio/browser 记录存快照，之后从快照返回；
  `liveStdio` 仍按 `alive(pid)` 过滤，`whenIdle` 不会卡住。调用方给定 `logDir`（G3 固定 `/tmp/g3-mcp`）不删。
- 修复后：419 → 419，新增 0；mcp-service 28 + oauth-websocket 9 = 37 例绿。
- 清理：`$TMPDIR` 下目录内无任何 30 分钟内改动的 `mcp-wave0-*` 共 389 个，已删除；剩 30 个较新的未动。
- G3：`scripts/electron-migration/record/g3-inputs.mjs:35` 把 `mcp-service.ts` 列为服务模块，指纹会变，
  含任一 `${mcp.` 场景的整份套件（`g3-inputs.mjs:316-322` 把整份文件并入 `mcp` 单元；a251949f 上是
  mcp-commands、browser-session、settings-websearch 共 63 个场景，另有 pending 下 5 个）旧 A 录制会判为过期，
  需要重录或刷新指纹；运行时行为对 G3 不变。（F 趟按 A20 复核更正，原文写成“含 `${mcp.` 的场景”。）

### R2-1 红 → 绿（`tests/web-search-routing.test.ts`、`tests/web-search-rust-parity.test.ts`）

修复前 21 红 / 1 绿，代表性输出：
- host_str：`expected 'b.example:8443' to be 'b.example'`；无标题结果文件名 `expected [ 'ported.example:8443', '\u0085' ] to deeply equal [ 'ported.example', 'nel.example' ]`
- f32：`expected 0.6666666666666666 to be 0.6666666865348816`；`'[1,0.6666666666666666,0.3333333333333…' to be '[1,0.6666667,0.33333334]'`；DeepSeek `'[0.7000000000000001,0.099999999999999…' to be '[0.7,0.1]'`
- 导出：`normalizeUrl is not a function`
- 门：未选/空白引擎 `expected [ true, …(5) ] to deeply equal [ false, null, …(4) ]`
- 路由：`expected [ { engine: null, …(2) } ] to deeply equal [ { engine: 'searxng', …(2) } ]`
- 全失败：`'null down'`（应为 `web_search error`）；无 window 仍发事件 `expected [ { event: 'chat_web_search', …(1) } ] to deeply equal []`
- 生产接线：`expected [ false, …(1) ] to deeply equal [ true, null ]`

修复后 22/22 绿；合入 INT 后连同 web-search、tool-details、client、bridge、integration/tools-registry、
browser/search-commands、chat-pipeline 两个 registry 调用方共 10 文件 116 例绿；tsc 退出码 0。

断言改动：`tests/client.test.ts` 'invokes the local web_search tool through the registry' 只给带
stream_event 的那次调用补了 `window`（输入），期望不变。原输入无 window 却断言发事件，与 Rust
`tools/mod.rs:1123` `if let (Some(window), Some(stream_event))` 相反。

W05 交接已在本工作树临时叠加 W05 文件验证（未提交，已还原）：W05 原 8 例 → 替换后仍 8/8，search-commands 23 绿，tsc 0。

## 第一轮

开工：2026-11-07 14:31。合入 INT `390f244b` → `a9f448fa`，无冲突。
起点：oauth-manager / stdio-proxy / stdio-validation / tool-cache-commands 4 个文件 53 例全绿。

| # | 项 | 状态 | 提交 |
|---|---|---|---|
| 1 | V09-P1-4 OAuth 失败不关回调监听 + 插件卸载不 dispose | 完成 | ba52342e |
| 2 | V09-P1-1（mcp 部分）start_mcp_oauth 接 CallContext.signal | 完成 | ba52342e |
| 3a | V10-P1-1 Windows .cmd/.bat spawn（buildSpawnPlan） | 完成 | 479f54a8 |
| 3b | V10-P3-1 Windows 杀进程树（RF-W21-windows-stdio-kill-tree） | 完成 | fb28feef |
| 4 | V02-05 preheat/reload 改用 llmMcpTools | 完成 | c2166d0a |
| 5a | V10-P2-3 win32 子进程 env 大小写不敏感合并 | 完成 | 6a03f27c |
| 5b | V10-P2-2 win32 PATHEXT 优先、跳过无扩展名垫片（RF-W21-windows-pathext-before-shim） | 完成 | a3456f90 |

## 1+2 红 → 绿（`tests/oauth-lifecycle.test.ts`）

修复前 6/6 红：
- `three failed startOAuth calls leave no extra TCPServerWrap behind`：`expected 2 to be +0`（DCR 失败、无 registration_endpoint 两条各漏一个监听）
- `dispose() cancels …`：`manager.dispose is not a function`
- `aborting while waiting for the browser callback …`、`aborting while discovery HTTP is in flight …`：`expected 'still pending' to be 'OAuth authorization cancelled'`
- `unloading dstu.mcp cancels an in-flight start_mcp_oauth …`：`still pending`，且 afterEach 的 `host.dispose()` 因 120 秒回调等待 `Hook timed out in 10000ms`
- `a page reload only detaches the reply …`：`still pending`

修复后 6/6 绿（连跑 3 次稳定）；oauth-manager 20、oauth-websocket 9、transport-auth 16、oauth-session-decode 1 仍绿。

设计要点：插件停止（`CommandStoppedError`）→ 取消授权、关端口；窗口关闭/重载（abandon）→ 只释放已无人接收的回复，授权照 Rust 继续并落库（kernel/API.md §2：Rust 不因页面关闭停止的命令迁移后也不得停止）。shutdown 时 serve.ts 以 `'reloaded'` abandon 全部调用，命令立即返回，随后插件 effect 的 `oauthInstance.dispose()` 关掉进行中的授权。

## 3a 红 → 绿（`tests/stdio-spawn-plan.test.ts`）

修复前 2 例红（经 mock 的 `node:child_process.spawn` 记录参数）：spawn 收到 `file: "C:\\Users\\a\\.playwright-mcp\\start-mcp.cmd"`、`args: ["--port","1"]`（Node ≥18.20.2 在 Windows 上对此抛 EINVAL）；无法安全转义的参数没有被拒绝，报的是 `spawn recorded (kind=Uncategorized…)`。修复后 38/38 绿；stdio-proxy/stderr/stdout/probe-stages 84 例仍绿。

按 Rust std `make_bat_command_line`：`<SystemRoot>\System32\cmd.exe /e:ON /v:OFF /d /c ""script" args"`，`windowsVerbatimArguments` + `argv0` 逐字复现；含 CR/LF 的参数、含 `"`/`^`/`%` 或以 `\` 结尾的脚本名、NUL 一律 InvalidInput。

更正（F 趟，A05 必须修 2）：脚本名校验不是严格向 Rust 对齐。项目锁定的 std 1.98.1 只拒绝 `"` 和结尾 `\`（文案 ``Windows file names may not contain `"` or end with `\` ``），`^`/`%` 的拒绝取自 std master。现拆成两段：`"`/结尾 `\` 用 1.98.1 原文案；`^`/`%` 照 master 拒绝，登记 RF-W21-bat-script-metachar（rust-bug/proposed：1.98.1 下 cmd.exe 会展开脚本路径里的 `%VAR%`）。

## 3b 红 → 绿（`tests/stdio-kill-tree.test.ts`）

修复前 2 例红：`expected [] to deeply equal [ { file: 'C:\\Windows\\System32\\taskkill.exe', args: [ '/PID', …, '/T', '/F' ] } ]`；taskkill 失败时没有 warn 行。修复后与 stdio-proxy、stdio-spawn-plan 一起 61/61 绿。Rust 同缺陷，登记 RF-W21-windows-stdio-kill-tree（rust-bug/proposed）。

## 4 红 → 绿（`tests/tool-cache-commands.test.ts`，装载真实 llm 插件）

修复前 2 例红：
- `V02-05: preheat_mcp_tools asks the calling window through llmMcpTools …`
- `V02-05: reload_mcp_client clears the real tool cache …`

两条都是 `invoke failed before asking the window for tools: {"error_type":"Unknown","message":"LLMManager 未发布 clearMcpToolCache/preheatMcpTools，无法执行 MCP 工具缓存清理/预热","details":null}`，与审计探针一致。

修复：mcp 不再注入 `llm`；两条命令每次调用经 `ctx.reflect.get('llmMcpTools', false)` 取服务，调 `clear()` / `preheat(call.source)`。没有放进 inject：kernel 的 inject 全是必需项，硬注入会让所有只给 `llm: {}` 替身的测试宿主（含 integration lane 的 `tools-registry.test.ts`）里 mcp 起不来；而且其余 21 条 MCP 命令本来就不依赖 llm。修复后 6/6 绿；bridge、config、oauth-lifecycle、llm/service_names、integration/tools-registry 一并绿。

## 5a 红 → 绿（`tests/stdio-child-env.test.ts`）

修复前 4/4 红：三条纯函数用例 `proxy.mergeChildEnv is not a function`；经 `createStdioTransport`（mock spawn）的用例 `expected [ 'PATH', 'Path' ] to deeply equal [ 'PATH' ]`，即 spawn 拿到的 env 同时有继承的 `PATH` 和用户的 `Path`，Node 排序去重后 `PATH`（继承值）胜出。修复：抽出 `mergeChildEnv(platform, inherited, user)`，win32 下按大写折叠键名，保留首次写入的拼写、替换值（Rust `CommandEnv`/`EnvKey`）。修复后 4/4 绿，stdio 相关 6 个文件 88 例绿。向 Rust 对齐，不登记 RF。

## 5b 红 → 绿（`tests/stdio-pathext.test.ts`）

修复前 3 条 RF 用例红：`Expected "<bin>/npx.cmd" / Received "<bin>/npx"`（两条）；只有无扩展名文件时 `expected [Function] to throw an error`。修复：`validateStdioStart` 增加可选 `platform`，win32 无扩展名命令只试 PATHEXT 候选。修复后 5/5 绿，stdio-validation/stdout/length-text/probe-stages 一并 73 例绿。夹具 PATHEXT 用小写与文件名一致：JS `realpathSync` 保留输入大小写，大写 `.CMD` 在 APFS 上解析成 `npx.CMD`、在 ext4 上找不到，结果会随测试机文件系统变化。
