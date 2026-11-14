# F2-shell 阻塞与证据

## WP-199（2026-11-06）：诊断供方边界

- 090/134/194 已在 main `df2cd30a1`；原 Started 诊断缺口在本包同步 preload 中补齐，真实 main/官方 Host/原日志入口已验证。原090事件与abandon/HostReady序列未改。
- browser-content 同样安装诊断，但原 `capabilities/browser-content.json` 只允许 trusted-input，`report_frontend_log` 被正式ACL拒绝。这是原权限语义，测试明确断言失败回执/零callbacks/无递归rejection，不计成日志落盘成功，也不开放能力。
- Linux真实detached已验证；mac/Win embedded仍未实跑。本包不替代U1实际产品入口修复、L10租约消费或L19业务接管验收。137 的旧writer停止前置、browser profile登录态及其余下列阻断保持。
- TESTMAP 三条Android helper仍无精确批准，保持pending。WP-199没有对应Rust测试去向可转换。

## WP-194（2026-11-05）：供方候选与消费者边界

- 193 / 134 依赖已核在 main `fd9d654d7dddee26913a1f8ab2b064445ff99dc0`，不是当前阻塞。
  本包补 F2 browser typed body 发送，真实 Linux Electron 链路已由窄反证/修复后回归验证（见 LANE/SPEC）。
  新供方仍需协调者正常集成；L19 WP-195 的 ShellError.data→领域 BridgeError、接管策略及消费者验收由 L19 完成。
- **命名核对**：Rust `browser_bridge.js:453-458` / L19 `src/browser-bridge.js:455-460` 的密码拒绝
  原 body code 为 `BLOCKED`，details.reason 为 `password_field`，没有 `PASSWORD_INPUT_BLOCKED` 字面码。
  本包保原 body；不以测试场景标签改写原码，不跨 owner 改业务策略。
- **后继 F2-BRIDGE-DECODE（未在本包修复，不影响有效 body 传输）**：
  `bridge.rs:114-132,153-174` 先 Value 再 from_value::<BridgeEnvelope>；F2 parser 尚有既有差异：
  code/message 缺失/错型时 Rust InvalidJson、TS 仍 UNKNOWN/fallback 显示；v/epoch 的 Option<u32/u64>
  类型范围未检查，ok=true 时不解码错误字段，serde positional struct 数组被拒；JSON.parse 的任意精度
  Value/语法 Display、trim 与 truncate 字节语义未对齐。需要后继依 F4 已发布精确 Value/from_value
  能力逐分支接入，不能在 WP-194 静默扩写 decoder 或把任意坏 body 提升为 typed。
- 普通失败/invalid JSON/timeout 保原分类和显示；missing/null error 无原 typed body 不附数据。
  macOS/Windows 本包未实跑，历史目标平台缺口保持。TESTMAP 原三条 pending 去向不变。

## WP-137（2026-11-06）：D-054 已批准，旧 writer 停止核验仍阻断

- D-054 已批准 Linux 已见布局、全量 UTF-16 码元、target wins、Host/首个页面脚本之前迁移；源与快照保留，失败仅重试或退出。已删除 DESIGN 过时的等待裁定、skipped、hash 清单及复制+integrity_check 保证并发一致性的表述。
- **交 C1：缺正式入口可消费的旧应用/WebKit writer 停止确认能力**。Electron `main.ts:79,89` 的 userData 单实例锁与 Tauri 的 session D-Bus 单实例不互锁。Tauri `lib.rs:689-701` 可绕过该插件；插件 2.4.2 `platform_impl/linux.rs:22-26,56-94,103-110` 只发布唤醒回调/应用名，不提供 WebKit writer 退出及静止区间确认。当前进程名检索未见旧应用不构成生产保证，不能猜锁/终止进程/迁活库。
- 解除条件：C1 提供或指定经实证的离线交接方法，绑定源目录并确认旧应用及存储子进程已经退出、复制期间不会重开。F2 在此前置可核实后接 main/preload；若需新公共能力/依赖或 Rust 修改，另派 owner，不能在本包越权。详见 `storage-migration/WP-137.md`。
- 当前树无 dist：传递依赖 IndexedDB 静态与运行均未验；旧报告“只需 localStorage”不能签整个 W6b。真实 browser profile 登录态仍未迁且未批准丢弃。
- 待 U-001：macOS WKWebView 与 Windows WebView2 源路径/格式实测；WebView2 LevelDB 能否被 Electron 45 读取。
- 与 F3 的边界：Linux 上 `startup-recovery.ts:112-122` 可能把 WebKit 的 `localstorage/` 等移入 `recovery/incidents/*/legacy-root/`（Rust 同语义）。F2 方案在 Host 启动前快照并兼查该路径，不要求 F3 改动。

## WP-006（2026-11-05）：Shell 能力前提与错误归属

- `get_app_version` 原 Rust 无 AppHandle/Err，属于 F2 可自行修复的不必要 Shell 依赖；本包改为 Host 本地读取完整构建元数据。不是给 X1 安装成功替身。
- `restart_app` 的所有者是 F3；Rust `data_space.rs:2611-2613` 强制注入 AppHandle、返回 unit，无业务错误 schema。当前 `storage/index.ts:246` 请求 `plugin:process|restart`；无 main 的 ShellError 进入 F1 panic 通道，不能为了探针绿而加字符串/AppError 或吞错返回 null。
- `filestream_check_access` 的契约 lane 为 L13-vfs-api，实际命令 owner 是 L13b-vfs-handlers（`index.ts:246`）。Rust `file_stream_protocol.rs:719-741` 虽为 Result<bool,String>，函数只有 Ok 分支；main 缺失不等于真实路径不可达。当前 `src/filestream.ts:40-44` 先 realpath，失败 false；成功才请求 `app.pdfStreamAllowedDirs`，ShellError 未转换。
- **交 C1/C2 裁定 headless 前提/探针分类**：无 AppHandle 等价桥时，后两条本来就不能执行桌面副作用/查询 OS 授权根。现有 Rust 未定义此运行模式，不擅改 F3/L13，也不把一般异常全部包装为业务 Err。具体签名、分支、F1 传输规则与真实桌面覆盖见 `migration/spec/F2-shell.md` 的 WP-006 小节。
- 本轮开工 main 已具备 F1 ShellRequest/ShellResponse/HostReady 及 main `onShellRequest` 路由，已用 `git show main:<路径>` 核实。原真实官方 Host 用例基线 job `20261105140101-321aea`：16 passed、0 failed、0 skipped、exit 0；包括 PDF/filestream 目录与两次 restart/零次 exit。X1 无 Shell panic 不能直接归类为真实 GUI 损坏。
- 本会话只完成 WP-006，遵循 WORKER.md 交付即结束；下文自动续派/旧树缺口是历史记录，不作为本包扩大范围依据。

## F1-RAWJSON-01 后继原文协议（2026-11-05）

- **候选联合验证已解除该具体阻塞，尚不冒充 main 签收**：已按批准正常 ancestor merge F1
  `d2592fecb28c9cb944ae606a082e5b3d6c7ffd05`，联合树 `e843cfee6`；原“F5
  `1df7ba29e` 已是 main 祖先”判断错误，现已正常合其完整 owner 祖先纳入后继候选，未称主线。
  `20261105110555-1783b2` 4 files / 11 passed /
  exit 0 / 无 Errors，真实 serveHost→MessagePort→main→preload→renderer 的成功/错误/定向事件
  混合 raw 极值与 typed null/lookalike、ordinary/binary 均验证。后文保留该任务的形成与失败证据。
- 本轮已正常合并正式 main 的 F4 Value/IgnoredAny/endArray：旧“F4 原语尚未发布”描述
  现为历史，不沿用为当前阻塞。`util/api.ts` 已公开 JsonValueNumber、jsonNumberToRawJSON、
  stringifyJsonValue；F1 `toWireJson` 正式 main 尚无 raw 品牌识别，接线不能把原 atom
  当普通对象发给前端；F1 候选与极值来源协议的状态分别核对。
- F1 候选 `7bc801fa8`（尚非本轮 main）在 raw 品牌仍在时识别原生 atom，修复有限数字变对象。
  F2 `main.ts:257` / `ShellRuntime.encodeBody` 的后继 JSON.stringify 对 raw 投影的
  Infinity/-0 仍会变 null/0。但该 number 本身也可能来自普通 typed 值，F2 不能推断来源。
- F1/C1 明确禁止通用 Infinity→raw token replacer：typed 非有限 f64 应保持 null。
  本轮未提交的一般 serializer 已逐 hunk 撤回，main/runtime 对 main 无差异。
  作业 `20261105103634-1a300b`（2 failed/exit 1）、`20261105103727-0822bf`
  （真实 main/preload 1 failed/exit 1）抓到二次编码丢值，但输入未携带 raw 来源；
  无效实验 `20261105103842-8bc921` 11 passed/exit 0 不能签收，原日志不改。
- C1/C2 已联签；F1 已确认唯一字段 BackendEvent.payloadJson?: string 与 InvokeResponse
  两支 json?: string，仅原始 raw 消息携带。F2 消费者已按此接线，生成端正式候选已发布并完成
  双方完整树联合验证，待最终 gate 与官方集成。F2 不私改 protocol.ts，
  不传失去品牌的 raw 对象、不改消费者；此处不再记为“待字段命名/审批”。
- 新回归改为普通消息正确 oracle：typed 非有限/null、负零/0 归一、有限数字与普通 rawJSON
  属性对象不变。这些是本轮新增的非 Rust 移植测试；纠正的是无来源输入的错误 raw 假设，
  没有修改既有移植测试或原 Rust 断言。最终 renderer 原值现在已有候选联合测试，不等于主线独立签收。
- 真正双方链路的初始 red `20261105105035-43f218` 1 failed/exit 1，混合载荷的 raw
  数字在 main 当前 Host 出口变对象；typed null、lookalike、普通消息、binary 断言均保留。

## 续作核对（2026-11-05，main e9df01a3c）

- main-red 已定位为 F2 自有 watchdog：Host 安装官方 profile/迁移/finalizer 尚未结束，
  外壳 30 秒先杀进程。作业 `20261105000218-1ac390`（312 passed/1 failed/6 skipped，
  Errors 1，exit 1）与限两 worker 的 `20261105001130-e20656` 均复现该日志。
  后者还拾取了正在编写的 White_Space 红测试（176 passed/2 failed/6 skipped，exit 1），
  不把这次套件当成修复后基线。单文件 `20261105000504-058dd7` 1 passed/exit 0，
  表明 restart/PDF 原断言在当前接口组合可通过；不等于全套稳定。
- watchdog 对齐 Rust `startup_gate.rs:22-24` 的 120 秒慢启动预算，仍有界终止；
  不改原真实 Host 测试的报告期限/测试超时/expect。假时钟先复现生产定时器过早 kill
  （`20261105001927-db1d84` 2 failed/exit 1），真实组合复验结果见 LANE 最新记录。
  `INACTIVE_EFFECT` 在 SIGTERM 之后出现，当前证据不支持据此归责 L11 的正常启动实现。
- F1 已在 main 公开 `parseCapabilityFile` 原文入口，但其 typed 未知字段要求
  `JsonReader.skipIgnoredValue`，当前 F4 尚无此方法；`readValue` 仍拒绝 `1e400`
  （`host/platform/util/json-exact.ts:397-398`）。F2 不把现行可接受的 Value 改成错误，
  等 F4 的 arbitrary_precision Value/IgnoredAny 正式出口后再切换 capability 与 WebView 文件读取。
  上报 `2026-11-05T001946228Z-F2-shell.md`，没有在 electron 复制通用 lexer。
- TESTMAP 仅 3 条仍 pending：source/staging/purge 的 Android helper，完整 ID 的批准仍仅有
  content_uri 一条（`migration/approvals.d/C2-platform.json`）；不扩大 obsolete 批准范围。
- 旧记录里 MCP 事件“没有生产订阅”已过时：main `host/plugins/mcp/index.ts:102-109`
  已接 `onToolsChanged` 和 `startBackendMcp`。不代替 L19 签收其所有事件路径。
  L21 的两个启动事件当前仍无生产 emit；macOS/Windows 实机验证、Sentry SDK 安装仍待外部处理。

## main 部分集成的当前边界（2026-11-04 16:54Z）

- 已核 main `fb463060d` 包含 `56980fcff`/`114ed8061`：`shellWindows` 的公开契约、provider、
  main 查询路由已正式在 main，不再记为仅候选。L04 消费签收仍未完成，且 parked 不送执行消息。
- 显示 helper 及其余入口也已随部分集成到 main，但 `browser-surface-host.test.ts:87` 仍是原始 spawn。
  `99839395d`/`fe8a17554` 尚非 main 祖先；**不可称五入口的显示修复全部已在 main**。
- 本分支合并 main 后，仅剩该测试 import/spawn 两处代码差异及历史证据文档。
  对此新组合定向复验 `20261104165418-486d72`（env -u DISPLAY）：1 passed/exit 0。
  这是待集成分支证据，不冒充 main 独立复验；正常剩余提交集成后由 C2 核验主线新组合。

## 最新 main-red 复验（2026-11-04 16:40Z）

- fulltest `677f6727c` 的五条环境失败原记录不变。F2 已在测试层统一提供缺失 DISPLAY 时的
  隔离 Xvfb；不改生产、不 skip、不弱化业务断言。
- `20261104163555-5e7dd9` 显式 xvfb 队列：4 条协议 Host 测试通过；真实 Host 仍报旧 F3 配置错误。
- 随后合并包含 F3 `04e6c7ef7` 的 main（`apply(ctx, config = {})`），
  `20261104163928-932c32` 以 `env -u DISPLAY` 重跑 `shell-real-host`：1 passed/exit 0。
  **F3 默认配置这一具体阻塞已解除**；后文相关失败栈仅保留历史证据。
- 五条入口的证据来自上述分次作业，不声称全量 Electron 业务、所有平台或 L04 消费已签收。

## 最新状态（2026-11-04 15:38Z）

- **已解除**：F1 公共 capability decoder / `unexpectedOf` 已随 main `4525e11ac` 到位，
  F2 已删除本地领域 decoder 并改用 `host/kernel/api.ts`。文件层仍独立保留，错误取 `.detail` 包装。
  以下关于“F1 未在 main”的段落为历史证据，不再是当前阻塞。
- **仍未关闭**：值级公共面不等于原文反序列化；F1 仍声明 typed-list/from_str 未闭合，
  F2 也不宣称重复 JSON 键、词法、精确错误次序已等价。WebView settings 的任意精度 Value
  接口需求仍按后文 `2026-11-04T151413805Z` 的上报保留。

2026-11-04 接手：没有本 lane 的 ACCEPTANCE.md，用户注入清单为「复核未勾选项：无」。
不得自行生成通过结论。

## 待验证，不先称阻塞

- C2 的实际 Host/main 组合：**未阻塞，已验证**。`tests/shell-real-host.test.ts` 启动真实
  `electron/main.ts`（经 `fixtures/restart-main.ts` 只替换 restart/exit hooks）+ 真实
  `host/kernel/main.ts` + 官方 `desktop.json` + `--tauri-dir` ACL，隔离 HOME/XDG/appData。
  经前端 invoke 断言：`plugin:host|status` 为 `[]`（无 degraded 插件）；`restart_app`（F3 →
  `plugin:process|restart`）→ null；`pdfstream_check_access` 对数据目录内 `.PDF` →
  `{available:true,size:9,reason:null}`；`filestream_check_access('')` → false（L13b 先 realpath，
  空路径不发 shell 请求）、数据目录内 PDF → true；`data_governance_purge_all_data`（L21 →
  `process:restart`）写 `.purge_on_next_start`=`1` 后 reject `应用重启未生效：进程仍在运行`；
  hooks 记录恰好两次 restart、零次 exit。作业 `20261104104945-974e13`：1 passed，exit 0，无 Errors。
  边界：Linux/xvfb；不是真实 relaunch，也不是整机前端冒烟。
  旁证：首轮作业 `20261104103134-c9c923` 失败原因为夹具在启动前把 PDF 放在数据根，F3 启动迁移把根目录
  旧文件移走；改为 HostReady 后再写入，断言未放宽。
- macOS 原生窗口与 Windows 打包/系统行为：Linux 当前未做目标平台实测，不算已验证。
- 历史 SPEC 中 L21/L19/F3 阻塞描述是旧树状态；必须以当前 main 审读/作业重新确认后才能沿用。

自有的 fd 清理、BOM、同步 IO、序列化等发现见 LANE.md，不属于跨 lane 阻塞。

## 跨 lane 阻塞（2026-11-04，C2 审阅后）

### F4：serde_json 兼容的文本解码器（`load_webview_settings` 解析错误文案）

- 现状：`electron/webview-settings.ts` 用 `JSON.parse`，失败时报 `解析 WebView 设置失败: <V8 SyntaxError 消息>`。
  Rust `commands.rs:7529-7530` 是 `serde_json::from_str::<Value>` 的 Display，例如
  `expected value at line 1 column 2`、`EOF while parsing an object at line 1 column 1`、
  `trailing characters at line 1 column 4`、`key must be a string at line 1 column 2`。
  错误类型 `Validation` 与前缀一致，细节文本不同。C2 未批准豁免，**不把 V8 消息当作等价**。
- 检索结论：`host/platform/util`、`host/platform/*`、`host/kernel/{json,serde}.ts` 都没有文本级 serde_json
  解析器（`serde.ts` 只把已解析的 IPC 值和 schema 比对）。按 quality §二.2「通用工具只放平台层」，F2 不自写副本。
- 需要的接口（建议 `host/platform/util`）：`parseJsonSerde(text: string): { ok: true; value: unknown } | { ok: false; message: string }`。
  `message` 必须逐字等于 serde_json 1.0.149（`preserve_order`、`arbitrary_precision`）`Error` 的 Display，
  包括 line/column 计数、BOM 不跳过、递归深度上限 128 的 `recursion limit exceeded`。
  成功值保持对象键序；超过 2^53 的整数按 D3 处理。
- 解除条件：F4 在 main 发布后，`webview-settings.ts` 改调它，并补入口测试逐条断言上面 4 类文案。

## 待协调者落地

- `src/external_file_opener.rs::tests::content_uri_detection_is_case_insensitive`：C2 已批准 `obsolete:mobile-only`，
  写在 `migration/approvals.d/C2-platform.json`，但还没进 main。进 main 后按精确 ID 把 TESTMAP 改为 obsolete。
- 另 3 条（`source_must_be…`、`staging_copies…`、`purge_removes…`）：helper 本身不在 cfg(android) 下，
  但唯一生产调用点在 Android 分支。现行 decisions 是否覆盖这种情况，C2 已上报架构师。裁定前保持 pending，Rust 测试不删。

### F1：公开 `decodeCapabilityFile`（F2-DECODE-01 收尾）

- F1 已告知将在 `host/kernel/api.ts` 公开 `decodeCapabilityFile(value, source?)`、`Capability`、`CapabilityDecodeError`。
  当前 main 上只有 `host/kernel/acl.ts:62` 的模块内私有函数，尚未导出。
- F2 在 `e8815ad0b` 先实现了 `electron/shell/capability-file.ts` 让 `deriveScopes` 不再 `as Capability`。
  F1 出口进 main 后，F2 删除该文件中的值级解码（Identifier/Target/字段），只保留目录读取、严格 UTF-8 与
  重复 identifier 检查（若 F1 也提供则一并删除），`tests/opener-scope.test.ts` 断言保留不放宽。

### F1：capability 解码器进 main、`unexpectedOf` 走 api.ts（2026-11-04 C2 指示）

- F1 的 `host/kernel/capability-decode.ts` 与 api.ts 导出目前只在 `ds-mig/F1-kernel`（`59f74e019`），main 尚无。
  进 main 后 F2 删除 `electron/shell/capability-file.ts` 的值级解码，只保留目录读取、严格 UTF-8、跨文件重复 identifier。
  比对差异：F1 的 MultipleSeparators 文本 `'58'`（Rust `{}` 显示 u8）正确，F2 写成 `':'` 是错的，切换即修正；
  F1 还覆盖 Capability/Remote 的位置序列形式与 Target 的 map 形式。
- F1 已确认方案（调用者用 `CapabilityDecodeError.detail` 加文件前缀，避免双前缀）；F2 等其进 main 的 hash。
- `capability-file.ts`、`window-config.ts` 私引 `host/kernel/serde.ts` 的 `unexpectedOf`；需 F1 在 api.ts 导出
  `unexpectedOf`（和 `oneOf`），F2 再改 import。
- 观察到（非 F2 改动）：合并 main `ec0f68ef2` 后真实 Host 启动失败，`host/platform/storage/index.ts:120`
  `Cannot read properties of undefined (reading 'migrationsDir')` → `platform core services unavailable: "storage"`，
  作业 `20261104133230-ce12a9`。F2 本单元只改 electron 的配置解码，不在该调用链上。

### main 红灯定位（fulltest 16a254adf，2026-11-04）

- 4 条 electron 集成测试（plugin-ui-host、shell-restart-host、browser-surface-host、smoke）失败原因是 fulltest
  没有 X server（`Missing X server or $DISPLAY`）。在 F2 工作树用 `xvfb-run -a` 跑全部通过，属于运行器问题，已上报。
- `shell-real-host` 是真实回归，在 F3：`host/platform/storage/index.ts:120` 的 `config.migrationsDir`（45ec5baf9）
  在 profile 未配置 storage 时 config 为 undefined。已在 1afb212ed 临时 worktree 复现，已上报 F3。F2 不改他人文件。
- 集成门禁报 `gate-excerpt.mjs:2 import fs`：架构师已说明是门禁工具故障，F2 不做改动。

## 自动续派核对（2026-11-04 15:10Z，main 879e0a56b）

- C2 `content_uri_detection_is_case_insensitive` 的 approval 已到 main，TESTMAP 已按精确 ID
  落为 `obsolete:mobile-only`，解除该行的落地阻塞；另三条仍未获批准。
- F1 api.ts 仍无 `decodeCapabilityFile` / `CapabilityDecodeError` / `unexpectedOf` 导出，不能提前
  引用责任分支的文件。保留约定：正常 main 到位后删除本地值级 decoder，错误包装只用 `.detail`。
- F4 `util/api.ts` 已公开 `JsonReader` / `parseJsonDocument` / `objectLastWins`，因此“没有文本级
  parser”已过时。但还不足以直接闭合 `load_webview_settings`：出口是 `JsonNode`，没有
  `Value` → Host JSON 值投影；`json-exact.ts:375-376` 以非有限 f64 拒绝数字，而本项目
  serde_json 的 `arbitrary_precision` Value 可保存 `1e400` 及超 u64 整数原文。
  不能简单换成该函数而把合法设置拒掉，或先经 Number 丢精度。
  已向 F4 请求正式 `Value` 读取/投影接口（普通标量/对象/数组保持、整数 bigint、任意精度数按
  D3 在线边界处理），含 last-wins、保留 BOM 供 parser 拒绝和原错误位置；不在 electron 复制 lexer。
  旧 JSON 错误文案差异仍真实存在，不因 F4 原语到位就宣称解除。
