# X5-stream-parity：聊天流式事件全链路审计

日期：2026-11-04。首轮审计基线：`f23c98702`，分支 `ds-mig/X5-stream-parity`。最新状态见下方 C1-app 续记；首轮测试结果不代表 merge main 后重新执行的结果。

## WP-123：qbank 首组确定性 LLM 外部输入接缝

目标：消费 L14 提供的原始 provider sidecar，给真实 B 客户端提供逐字 HTTP/SSE 应答。服务供方结果不计 C/G3；A/B 业务输出仍以 A 实录为准。

- 起点正常 merge main=`a1625a75b`（main=`e6bce8aae`）；`main:host/plugins/chat-pipeline/src/tool-loop.ts` 已核到 L03 outer-cancel 修复。`main:host/e2e/streaming/wave0/llm-service.ts` 当时不存在，但它是本 lane 已提交依赖，按 brief 直接消费自身历史，没有复制其他 lane 接口。
- 来源完整审读：`ee55bf25e:host/plugins/qbank/equivalence/pending-provider/ai-grading-scripted.provider.json`、对应场景、README 第98行起；Rust `src-tauri/crates/dstu-qbank/src/qbank_grading/pipeline.rs:152–431,1130–1292`。`wave0/__fixtures__/ai-grading-scripted.provider.json` 与该 git 对象经 `cmp` 字节一致（exit0），10 个 ID / 11 次响应；不是自编 verdict/score 预期。fixture 被协调者自动检查点 `9a9eaaa70` 保存。
- 最小格式增量：既有 `extraScripts` 接受 `ResponseScript { description, responses: [{status,headers,chunks}] }`。`providerScripts(unknown)` 读取原格式；CLI `--provider-script FILE`；`baseUrl(scenario.id)` 选择脚本。每服务实例克隆输入并独立维护逐 script 请求序号；重判两次分别消费第一/第二应答，耗尽明确409，不重复尾帧。旧 built-in 仍按 tool history 推导轮次。
- 响应 status/原 headers/UTF-8 chunks 直接写 HTTP，以 EOF 关闭，不添加 finish/usage/`[DONE]`，不折叠 `stream:false`。记录实际请求原文/原 header、应答 header/成功写入的 chunks、序号、status、结束原因；独立 HTTP 客户端另保存 rawHeaders 和 entity base64 以核实收到的字节。正常、HTTP500、错误请求、客户端取消、服务停止均保日志与清理。
- 本 lane `runner.ts` 支持 L14 `${provider.url}` 作为 `${llm.baseUrl}` 的明确别名；调用方传 `{...scenario,llm:scenario.id}`，每 scenario×backend×take 启一个新服务。X1/X7 外部 runner 的地址替换/生命周期说明在 `wave0/README.md`，未改其代码。
- 起点经队列：typecheck `20261105181512-327e04` exit0；旧 `wave0/service.test.ts` `20261105181512-95d351` exit0，13 passed / 0 failed / 0 skipped。定向新测试及最终新 tip 完整门禁回执写入 WP-123 正式报告，不沿用旧 `5828` 证书。
- 新定向 job `20261105182237-520f83` exit0，2 files / 6 passed / 0 failed / 0 skipped：两实例各11次精确 HTTP；同实例重判顺序与409耗尽；错误请求不消耗、非流请求不改写；客户端取消/服务 stop 各在39/128次压力写入后收尾、openCount=0；CLI stdin EOF 后端口拒绝连接。B 真实 L02/L01 客户端消费全部11次响应（含HTTP500及空正文），真实公开 `qbank_ai_grade` 经原 L14 前五步与 `${provider.url}` 成功消费首条应答。没有 fake adapter、没有自编 DB/判分期望。
- 原件：`/tmp/opencode/x5-wp123-http-ebcVY6/raw.json`（两实例逐字收到的 headers/entity 与服务日志）；`/tmp/opencode/x5-wp123-b-client-BQOGw8/raw.json`（11次生产客户端请求、文本/错误）；`/tmp/opencode/x5-wp123-qbank-3dylnn/raw.json`（真实 kernel step argsJson/valueJson、所有事件与HTTP）。日志 `/home/dsdev/.oc-jobs/done/20261105182237-520f83.{json,log}`。这是供方及 B 消费证据，不计 A/B/C/G3。
- 取消状态纠偏：LANE/BLOCKERS/TESTMAP 的旧九条/十条红灯描述属历史；按本包协调者证据，固定组合 `aae7910e3`、C2 job `20261105175017-81cbe6` 已原0/1pass。该结论限固定组合；本包完整门禁保留原九事件/全部预算，未另跑单取消或993/992探针重复取证。

TESTMAP：本 lane 无 Rust ported/pending 映射行，0→0；本包只加供应方与生产消费者证据，不改 L14/L03/L04 的映射。剩余依赖：X7 A1/A2 实录、X1/X7 正式 scenario/seed/DB capture 消费、C2 独立签收；WP-089 A TLS trust/D38 仍 open。供抽检：重判双应答的跨实例序号与完整字节；真实 L02/L01 及 qbank 命令的本地 HTTP 请求/事件原件。

## WP-089：固定 HTTPS iLink 的逐实例隔离接缝

结论：本地 CONNECT/TLS 模拟、每进程 CA、B 生产 IlinkClient 原件已交付；A 缺可运行录件及 reqwest 0.11 的 CA 信任接口，**D38 open，不是双端/登录/C 成功**。运行说明与边界见 `host/e2e/streaming/fixed-https/README.md`。

- 完整阅读 WORKER、lane 卡、LANE/TESTMAP（原无 BLOCKERS，已补）、WP-048/050 报告与 standard-v2。起点 main 合并 `d43e72fc3`，main `736ad9f1a`。`git show main:host/kernel/ilink-client.ts` 确认生产默认 fetch/固定域依赖已在；WP-042 的 `wave0/llm-service.ts` 尚不在 main、仅在本分支历史，本包独立 Node 服务不依赖该候选接口、不复制他人接口。
- `service.ts`：每 take 独立 loopback 随机端口、目录、CA/叶证书、日志和 HOME/XDG；仅允许 iLink:443 CONNECT，隧道只转到自身 TLS 服务，原业务 URL/Host/SNI/method/path/body 不改。TLS SAN 固定域，客户端保签名链与域名校验；无 DNS/全局证书更改。其他 CONNECT（含 GitHub/codeload/clawhub）明确 403，不实现后包协议。
- 固定脚本仅 QR 离线标记、status=wait、getupdates 空消息。没有真实账号、确认 token、伪造登录 golden。原 HTTP entity 字节 base64，rawHeaders/编码 query 原形保留，无 JSON 解析重写；随机 x-wechat-uin 不 normalize。服务响应原文与传输失败同时保存。
- `run.ts` 逐进程隔离 env，通过现成 proxy 配置；`node-proxy.mjs` 只在一次性 B 子进程给真实 fetch 配置现成 undici ProxyAgent+指定 CA。实际 `new IlinkClient()` 无 fetch 注入，生产编码、HTTP 和解码均执行。子退出/失败/信号释放连接/端口/私钥，保留原件；零流量不能报 ok。此接缝不是任意联网代码的 OS 网络沙箱。
- **B 原件** job `20261105173827-caa449` exit0，`/tmp/opencode/x5-ilink-7WFOYV/{requests.jsonl,child.stdout,result.json,transport.jsonl,config.json}`，3 请求/0 fault。请求/输出逐字副本提交在 `fixed-https/evidence/`（cmp 一致），仅 B Node 生产客户端证据，未运行 Electron IPC。
- **A 精确阻塞**：Rust `plugins/ilink_bot/client.rs:137–141,154–196` 默认 builder/固定端点；Cargo.toml:157 的 reqwest 0.11 `rustls-tls` 使用 webpki。Cargo.lock:10371–10412 的 0.11.27 没有 rustls-native-certs；object_store:160–167 启用 native-roots 的是 0.12，不合并到 0.11。本机 reqwest 源 async_impl/client.rs:459–507 仅 native-roots 分支读取额外本机根。现有 `SSL_CERT_FILE` 不足，不能伪称 A 可用。
- **交维护/X7 的接口**：在其授权构建范围，为同一 A 的 reqwest 0.11.27 提供 `rustls-tls-native-roots` 与对应锁依赖，验证 Linux 子环境 `SSL_CERT_FILE=<逐实例CA>` 生效；消费现有 `HTTPS_PROXY/NO_PROXY`，保 TLS 校验，不改业务 feature/URL。本包未运行 Rust、不改 Cargo、不安装依赖。A 之后经真实 invoke/事件录制独立 A1/A2；Electron Host preload 传递待 X1/F2。
- 起点类型 job `20261105173500-56f081` exit0；目录测试 `20261105173500-9bb479` exit1：57 passed / 1 failed / 0 skipped，唯一原 cancel-after-partial 九条/十条差异，原 trace `/tmp/opencode/x5-cancel-zOL0Ai/trace.json` 保留，无断言改动。
- 接缝首跑 `20261105174004-54b7aa` exit1（4p/2f）：新测试漏列真实 Option null；按 Rust client.rs:37–55 补精确 null（不弱化断言）。另发现 launcher 在信号监听前宣告 ready，立即 SIGTERM 可杀死父进程、未清理；把 ready 移到监听和退出回调全部安装后，旧失败目录 `/tmp/opencode/x5-ilink-guoFj7` 保日志，仅移除遗留 tls/。修订 `20261105174104-d6f39b` exit0：6 passed / 0 failed / 0 skipped，含 SIGTERM 与错误/no-traffic 释放、TLS 不可信/错域拒绝、两实例保真、任意 body 字节。
- 类型首跑 `20261105174004-5ad9b7` exit2：新代码 result 可选与 SNI 可 null 两处；已用明确 Promise 结果类型及保留 null 的 SNI 类型修复。最终 lane-gate 原 job/exit 见本包交付报告；不以定向绿覆盖 lane 原红。
- 正式门禁：tip `e51a5d374` / main `b3264ae78`，lane-gate exit1；typecheck `20261105174638-1ce4c0`、boundaries `-de1948`、strict `-8e5e8c` 均 exit0；tests `-608ab9` exit1，63 passed / 1 failed / 0 skipped，本包六条通过。唯一失败仍为 `cancel-after-partial.test.ts:137` 九条/十条，trace `/tmp/opencode/x5-cancel-D6Wm9F/trace.json`。门禁相对 main 称新增失败，因为原红仍在 X5 既有候选，未因此豁免。原件 `/home/dsdev/.oc-jobs/done/<job>.{json,log}`，最终报告 `host/e2e/streaming/fixed-https/WP-089.report.md`；末次仅文档补结果，不重复同红检查。

TESTMAP：本 lane 无 Rust ported/pending 行（0→0）；本包新增基础设施测试，F1/L07 映射不改。供复核：默认 IlinkClient 的三条 wire、无 CA/错域 TLS 拒绝及 SIGTERM 清理。后续 QR 完整状态机、skill ZIP/market、A/B 命令级差分另包。

## WP-096：修复 WP-042 记录器数值失真

结论：保留原始 wire 的修复与定向回归已落地；最终作业及 lane-gate 回执见 WP-096 交付报告。候选仍待 C2 审核，完整 parity 未通过。

- 原始 C2 探针 `/tmp/opencode/c2-x5-precision-1548.mjs`、原日志 `/home/dsdev/.oc-jobs/done/20261105155309-c669ab.log` 保留：993/992 两份 JSON 都被录为 992，`rawEventsEqual=true`、`verdict=identical`、exit1。根因是 `wirePayload` 解析后丢弃原始 `payloadJson`，step 的 JSON 往返也会舍入；runner 的 `host.invoke` 仅给出展示投影，丢失 outcome.json。
- 依赖已在 main 核实：`host/kernel/protocol.ts` 的 `BackendEvent.payloadJson` / invoke `json`，以及 `host/platform/util/api.ts` 公开 `parseJsonDocument/objectLastWins`。对照全文阅读 `host/kernel/tests/raw-json-wire.test.ts`；只复用公开 reader/native raw 数字机制，没有复制 C2 探针或另写 JSON parser。
- 记录仍为 v0，事件增加 `payloadJson: string|null`，step 增加 `argsJson/valueJson: string|null`；原始文本逐字保留。展示值供 wait/terminal/UI 读取，可以舍入，但候选比较改用原文的精确数值视图。i64/u64/大指数/下溢/小数数值原子通过 JSON.stringify 仍为 JSON number，不是业务 string；finish 只克隆展示值与原文字符串，不克隆 native raw 原子。
- B `hostDriver` 调同一个公开 `runtime.dispatchInvoke`，保留成功/CommandError 的 json；args 原对象与原子直接传递，step 前捕获原输入。结果占位符用精确视图，使返回→后续 args 不再二次舍入。缺省 args 才补 `{}`，显式 null 保留。
- A `push(channel,payload,payloadJson)` 必须由 tap 提供原文；只有解析 object 时记 `payloadJson=null`。A driver 需提供 `invokeWire` 的原始 json，普通 invoke 结果不能证明精度。B kernel 没给 raw 且已投影成 unsafe Number 时同样明确不支持；尤其 BigInt-only output 若未带 json，记录器不能反推原文，仍需 F1 提供原始文本。known safe B wire object 才允许序列化。
- 比较发现缺 raw（含旧录件缺字段）即 `unrepeatable`，不能 identical；数值原子按原 token 比较，绝不当作动态字符串/时间戳归一化。applyRules 在精确视图上改候选，再输出带数值的 JSON，原录件不变。null/缺省、数组与事件顺序/数量/晚事件全部保留。
- `wave0/recorder.test.ts` 覆盖 C2 993/992→finish→候选差异、同输入重复相同、i64/u64/指数/小数/-0、保存重载、缺 raw、旧录件、候选应用以及真实 kernel→hostDriver→runScenario 的 args/return/error/events/占位符链。`service.test.ts` 的合成 A 数据改为在输入创建处提供 raw；原候选断言全部保留，旧事件全量断言额外要求原文，FK 反例同时修改原文。不是从真实 A 已舍入 object 伪造 raw。
- 起点（merge `f2aef744f`）作业 `20261105165023-3de4b7` typecheck exit0；`20261105165023-dc27ec` wave0 exit0，18 passed / 0 failed / 0 skipped，无 Errors。
- 修复首跑 `20261105165756-51c5de` exit1，25 passed / 5 failed / 0 skipped，无 Errors：4 条来自旧合成 A 夹具缺 raw / 事件形状新增字段，1 条抓住精确解析出的可表示大整数在后续输入被误标缺 raw；已修原子投影和自有夹具，未放宽断言。该次真实 B runner 5/5 通过。
- 修订最小集 `20261105170146-ad8e81` exit0：`wave0/recorder.test.ts` 13/13、`wave0/service.test.ts` 13/13，共 26 passed / 0 failed / 0 skipped，无 Errors。原探针及正式门禁在提交后取回执，详见 WP-096 交付报告。
- **旧 WP-042 B 录件、旧探针和原 cancel trace 全部保留；旧 B 录件没有原始数值文本，不可用于精度证明。** 原 cancel-after-partial 的九条 Rust 预期未修改；额外 scoped_cancelled 的十条实测仍由 L03 牵头核定 outer Drop，须 C2 组合复验。没有 A/B 等价或 C 级签收。

TESTMAP：本 lane 无 Rust ported/pending 映射行，本包改动条目 0，pending 前后不变；新增的是记录基础设施回归，不迁移 L03/L04 的测试资格。

## WAVE0（WP-042）：事件记录器 + 确定性 LLM 服务，供 A/B 差分共用

结论：工具包已可用。B 端独立 runner 通过生产记录器录下了五个场景。A 端录制属于 X7，尚未进行，所以本节**没有任何 A/B 等价结论**，下面的候选规范化规则全部待 C2 审核。原 cancel-after-partial 红断言没有改动，仍然是红的。

### 公开调用方式（给 X7 / X1）

使用说明见 `host/e2e/streaming/wave0/README.md`。

- 进程内：`startLlmService({host?, port?})` → `{url, baseUrl(scriptId), requests, whenIdle(ms), stop()}`。
- 进程外：`node host/e2e/streaming/wave0/llm-service.ts [--port N]`。stdout 第一行是 `{"url","pid","scripts"}`；`GET /__x5/requests` 读请求日志；收到 SIGTERM/SIGINT 或 stdin EOF 时输出 `{"stopped":true,"requests":[...]}` 并以 exit 0 退出。
- ApiConfig 设置 `baseUrl = ${url}/s/<scriptId>/v1`、`apiProtocol=openai_chat_completions`、`authMode=none`，不需要真实 key。服务只绑定 127.0.0.1，默认使用 port 0，每个 take 一个实例，请求日志互不污染。`stop()` 会销毁仍被挂起的流（记为 `server-stopped`）。
- 确定性：响应只由 (scriptId, 请求 body) 决定。轮次 = 最后一条 user 消息之后带 `tool_calls` 的 assistant 消息数，请求之间不共享游标。chunk 的 `id`/`created` 是固定值，`model` 原样回显。

### 脚本

`success.answer`、`success.thinking`；错误类 `error.eof-after-partial`（有一个 chunk，之后 EOF，没有 finish 也没有 `[DONE]`）、`error.http-500`；中断类 `interrupt.hold-after-partial`（发出一个 chunk 后保持连接，直到客户端关闭）；工具类 `tool.second-round`（round0 调用请求中第一个可用工具，round1 给出正文）。请求不含工具时返回 400 `no-tool-offered`，超出脚本轮次返回 409 `unscripted-round`，未知脚本返回 404。每种情况都写进请求日志，不丢弃。

### 记录格式 `x5.stream-record.v0`

字段：`scenario/side/take/llmScript/steps[]/events[]/terminal/llmRequests[]/llmOrigin/llmIdle`。WP-096 后 `events[]` 按发射顺序保存 `{index, channel, payload, payloadJson}`，payload 仅为展示解析值，payloadJson 保留原文；step 同时保留 argsJson/valueJson。记录器不过滤、不排序、不去重，取消、错误、audit 事件以及终态之后的事件全部保留。`terminal` 只是派生摘要；出现 `none` 或 `multiple` 本身就是发现。终态集合按 `dstu-core/src/events.rs:89–93`：`stream_complete` / `stream_error` / `stream_cancelled`。A 端在窗口事件出口逐条调用 `push(channel, payload, payloadJson)`；只有 payload object 的旧 tap 不支持精度证明。

### Rust 事件实际入口（A 端录制时应能观察到的发射点）

| 事件 | Rust 位置 |
|---|---|
| `chat_v2_request_audit` | `dstu-agent/src/chat_v2/handlers/send_message.rs:549`（send），`:764` |
| 取消入口 | `send_message.rs:860` `chat_v2_cancel_stream` |
| session 通道 `chat_v2_session_{id}`：start/complete/error/cancelled | `chat_v2/events.rs:1195`；`emit_stream_start:1732`、`_complete:1745/1756`、`_error:1772`、`_cancelled:1790`；`SessionEvent.duration_ms:414`，`stream_complete` 填值 `:496–509` |
| 块通道 `chat_v2_event_{id}` | `events.rs:1190`；工具准备 `emit_tool_call_preparing*:1618–1692` |
| pipeline 外层取消 select | `chat_v2/pipeline.rs:1143` |
| 工具循环 | `chat_v2/pipeline/tool_loop.rs:468` `execute_with_tools` |
| scoped `${streamEvent}_start/_id/_usage/_cancelled` | `dstu-llm/src/llm_manager/model2_pipeline.rs:6285/6615/6980/6358,6729` |
| `chat_v2_llm_request_body` | `model2_pipeline.rs:4002` |

### B 端独立 runner 实测（作业 `20261105151637-f60340`，wave0 部分 18/18 passed）

真实 Host 插件加上真实 L01 OpenAI parser（`realProviders`，没有 fake adapter，`fake.created=[]`）。数据流是 v0 场景文件 → runner → 生产记录器 → WAVE0 服务，每个 take 都以 `llmIdle=true` 结束。

| 场景 | B 实际事件（kind 序列） | 终态 |
|---|---|---|
| success.answer | request_audit, stream_start, skill_injection_audit:end, llm_request_body, scoped_start, scoped_id, content:start, scoped_usage, content:chunk, content:end, stream_complete（11 条） | complete |
| error.eof-after-partial | 同上前 7 条, content:chunk, content:error, stream_error（10 条）；error=`LLM error: LLM provider 回复流提前结束，未收到完整结束标记；已保留已生成内容，可重试` | error |
| interrupt.cancel-after-partial | 前 7 条, content:chunk, **scoped_cancelled**, stream_cancelled（10 条）；provider 连接 `client-closed` | cancelled |
| tool.second-round | 前 6 条, tool_call_preparing:start, scoped_usage, stream_error（9 条）；error=`Tool error: tool round execution requires the chatToolRuntime owner service, which is not installed`；服务只收到 round0 | error |

- cancel 场景同样多出 `_cancelled`，与原红测 `cancel-after-partial.test.ts` 的 9 对 10 一致（本次全目录作业里该测试仍按原断言失败，见 `/tmp/opencode/x5-cancel-OY3pK9/trace.json`）。差异仍由 L03 核定，记录器不删这条事件。
- tool 场景在 B 端到不了第二轮，原因是 main 上没有任何插件 provide `chatToolRuntime`（`chat-pipeline/src/tool-loop.ts:599`）。这是 L04/L03 owner 缺口，不能当作通过。脚本本身的第二轮已经在 HTTP 层验证：round 0→1→0 是确定的，第二次 round0 返回字节完全相同（`service.test.ts`）。

### 候选规范化规则（待 C2 审核；目前只有 B 自重复证据，不能代替 A1/A2）

同一 B 场景录两次（success.answer），用 `candidateRules(B1,B2)` 跑同一套规则生成机制：

| 类别 | JSONPath（pattern） | 变换 | 理由 |
|---|---|---|---|
| llm-origin | `$.llmOrigin` | 每个 take 把自己的 origin 整串替换为 `${llm.origin}` | runner 注入的临时端口，属于输入，不是后端输出 |
| dynamic-id | `$.steps[*].value.id`、`$.steps[*].args.request.sessionId`、`$.events[*].channel`、`$.events[*].payload.{sessionId,streamEvent,stream_event,request_id,id,blockId}` | 按值映射到 `<id:n>`，全记录一致替换（返回值 → 事件 → 通道名 → 后续参数） | session/run/block/事件 id 由后端生成 |
| timestamp | `$.events[*].payload.timestamp`、`$.steps[*].value.{createdAt,updatedAt}` | 在精确 pointer 处替换为 `<ts>` | 键名是时间戳形状，值在 epoch 范围内，两次录制不同 |

**不可重复（不生成规则，交 C2 裁定）**：`$.events[10].payload.durationMs`（stream_complete，两次 1020/553）。Rust 的 `SessionEvent.duration_ms` 是真实耗时，按规则不能自动抹掉；是否加一条 "仅存在性/类型" 的规则由 C2 决定。

A1/A2 到位后用同一函数生成正式候选。双录中只要出现事件数量/顺序、错误文本、null 与缺失、数字精度或 DB 行的差异，结果就判 `unrepeatable`，不会出规则。

### 需要 X7 协调（不改 record/）

1. `record/json.mjs normalize` 目前只接受 JSON Pointer，并且会把整个值替换成 `<volatile>`。这表达不了 id 槽位的一致映射，也表达不了通道名里的子串；对 `channel` 用整值掩码还会把事件名一起抹掉。请 X7 决定：直接调用 `applyRules`，或在 v0 中加入 JSONPath `[*]` 和 slot 变换。候选规则同时给出 `jsonPath` 和精确 `pointer`。
2. 场景扩展字段：`llm`、`${llm.baseUrl}`，以及 step 级 `waitBefore`/`waitAfter`（固定 15s，超时抛错，不跳过步骤）。请 X7 runner 确认是否接受。
3. A 端需要在 emit 出口做全量事件 tap：动态 scoped 通道（`…_run_<hex>__stream_generation__N_*`）无法提前 listen。
4. B 端一个进程同时只能有一个 Host（deletion-journal 等进程级 slot，第二个实例会报 `SlotOccupied`）。实例池需要按进程隔离。
5. `capture.db` 不在本包范围（X3）。runner 只记录 steps、events 和 LLM 请求。


## 最新续记：cancel-after-partial 红轨迹与 owner 核定请求

**C1复核后的本轮收尾：仅本轮可执行事项已完成，不是parity通过。** C1已亲取定向 `20261105015318-089cba` exit1/1fail 与官方 `70ad586ca` / base `628b4192e` 的 `20261105020134-ff7f35` exit1/26pass1fail（无Errors/非超时），确认同一extra scoped_cancelled；第二轮完整原件 `/tmp/opencode/x5-cancel-ySbOwE/trace.json` 与首轮 CmPIhY 原件一并保留。官方其余type/boundaries/strict通过，不能覆盖该新场景红灯。

C1另核 Rust send_message.rs:860–881 仅取消chatState token，pipeline.rs:1143–1148外层select Drop与L02自身取消分支6710–6741不能简单等同；待架构授权 L03/L02 实际writer核定/修复。现停止无改动红runner循环、不扩retry/变体，不改生产/删L02事件/改九条预期。两次给parked L03的既有信箱不删；后续依赖统一经C1/C2/架构，不再追加停放执行消息或解除停放。未观察late content:end，仍不写成已发生。**完整parity仍不通过**，本次只提交限定收尾记录，不重复正式红轮次。

固定 `eaab4d13a` / main `f2d5b6c46`，本轮只新增 `cancel-after-partial.test.ts`。原作业 **`20261105015318-089cba` exit1 / 1failed**（非超时），命令 `npx vitest run -c vitest.host.config.ts host/e2e/streaming/cancel-after-partial.test.ts --maxWorkers=1`，日志 `/home/dsdev/.oc-jobs/done/20261105015318-089cba.log`。原始全事件、数据库、socket关闭与日志证据：`/tmp/opencode/x5-cancel-CmPIhY/trace.json`。

### 不把 EOF 冒充取消

真实本地 HTTP/SSE 只 write 一帧后永久保持响应打开；测试先等生产 content:chunk=`取消前内容`，确认响应未 writableEnded/未 destroyed、无终态且 session active/generation1，再调用公开 `chat_v2_cancel_stream`。服务端没有 end/destroy，取消后实际 close={afterCancel:true,writableEnded:false,socketDestroyed:true}，LLM 日志有 `AbortError: This operation was aborted`。fake.created/requests 各一次、parsed一帧、finishStream=[]。测试从未手动 abort生产token、调用save/emit/bindSink。

唯一 session stream_cancelled 回调中的真实DB已保留用户正文与助手部分正文，block status=success/error=None 对齐 Rust context.rs:790–817，generation1、active=false/tracked0 等前置断言已过；完整事件失败之后的 pending-cancel 等断言尚未运行，不计验证。

### X5-03/cancel-drop：待 L03 牵头确认，保红不迁就

Rust pipeline.rs:1143–1148 的外层取消会 drop execute_with_tools；tool_loop.rs:1163–1174 的 guard 注释明确显式后续代码不会再执行。因此测试保留其外层取消分支的九条完整预期：audit→session start→skill audit→request-body→scoped start/id→content start/chunk→session cancelled。

实际为十条，额外原值位于 content:chunk 与唯一 session terminal 之间：

```text
channel: chat_v2_event_sess_x5_real_cancel_var_msg_x5_cancel_answer_run_562ecc5ea6c04c24b88f7e6f4d082169__stream_generation__1_cancelled
payload: {"id":"13e4065a-9203-48cf-99a4-a94b33eee1a0","reason":"user_cancelled","timestamp":"2026-11-05 01:54:00.315"}
```

真实日志顺序：session stream_cancelled(seq1)→handler Pipeline cancelled→LLM call succeeded(cancelled=true)→After LLM call→Token usage计算，说明 JS loser 路径仍继续。TS `execute.ts:309–317` Promise.race 返回后未停止 loser，`tool-loop.ts:415–442` 将 signal 桥接 manager取消，L02 `model2_transport.ts:180–199` 因此继续发 scoped cancelled。L02 的直接 cancel 分支本身在 Rust 存在；这里请求 L03核定**外层 token 取消+Drop**的跨层语义，不请求全局删除 L02 合法事件。目前未观察到 late content:end 或重复 session terminal，不扩大结论。

已由 coord.mjs 向 L03 牵头与 C1 投递固定SHA/原值/调用点，请 owner 给 Rust 分支依据或实现修复；在裁定前不改九条红断言、不过滤事件、不加fails/skip，不改任何生产代码。**本 cancel 场景未通过，完整 parity 不通过**；下一步仅提交报告与 §5 收尾，不扩 retry/工具/变体。

### 已签前序门槛与旧门禁不混淆

C1已亲核 `1d788c4a1` / main `f2d5b6c46` 四项official通过，tests `20261105012734-ffc959` exit0/5文件26pass。该轮error探针 `/tmp/opencode/x5-error-stages-PFfhkI/stages.jsonl`（pid3559266、36条，至cleanup:done）只覆盖error及宿主；未装探针的components/thinking不声称定位。旧77c/004831的15pass2fail9skip/Errors3/exit1仍保留，新绿不证明旧CPU/RPC根因；普通/thinking/EOF-error限定签收保持，不覆盖本次cancel红灯。

## 历史续记：error-after-partial，真实 EOF 缺完成标记分支

### 正式自检仍红：先定位阶段，不以并发直接归因

`77c0326be` / main `a9683a43b` 的官方 `20261105004831-04d655` **exit1**，原结果 3files失败/2通过、15pass/2fail/9skip、Errors3（Vitest worker `onTaskUpdate` timeout）。components 是 beforeAll60s，error/thinking 是各 test60s；normal/reachability通过。typecheck/boundaries/strict三项通过也不能覆盖 tests 红灯，更不能用旧 thinking 或 error 单条通过声明正式完成。

已读同次原日志与装载路径：StorageService 构造函数不跑迁移；宿主依次执行 lazy locations→MigrationCoordinator schema定义/三库迁移→secrets/settings→createPaths→真实插件装配，之后才是测试模型配置、send与流等待。设备ID日志来自 `platform/paths/index.ts:214`，不是 schema 阶段标记；stdout 缺失也可能受同次 RPC 超时影响。先前负载64/默认五文件并行只作线索，**不据此判定 CPU/基础设施已确诊**。

按 C1 要求，本轮只给失败的 error-after-partial 文件及共用宿主加只读阶段观测：每个阶段带 performance.now 耗时、PID，写独立 `/tmp/opencode/x5-error-stages-*/stages.jsonl`，绕开 worker RPC。观察 schema/三库迁移/插件/配置/send/HTTP/terminal/drain/cleanup，不增加超时、不删除/过滤断言、不引入共享脏库、不扩取消/变体。固定诊断 revision 后仅作必要单文件区分；原 Errors3/exit1 永久保留。

### 固定 `c6d58ce8f` 的阶段证据：尚未复现旧 official 失败

1. `20261105011125-f717a1`，`npx vitest run -c vitest.host.config.ts host/e2e/streaming/error-after-partial.test.ts`：**exit0/1passed**。阶段文件 `/tmp/opencode/x5-error-stages-CWB8z7/stages.jsonl`，pid3500224，schema定义约9ms；chat/mistakes/vfs迁移各一次，合计3.39s；插件0.98s；模型设置0.09s；send准入0.41s；drain到终态0.88s；总6.03s。
2. 同一 revision、未改代码：`20261105011341-23b4da`，仅原三个失败文件，以 `-t 'content: Rust channel names|^error after partial:|^thinking:'` 各选一条，保持默认 worker 和60s预算：**exit0/3passed/10标题过滤**，无 Errors。error 阶段文件 `/tmp/opencode/x5-error-stages-HkQVwI/stages.jsonl`，pid3509218，schema定义约6ms，三库迁移3.87s、插件1.00s、send准入0.49s、drain0.98s、总6.61s；components约4.99s/thinking约6.50s。两次均能到 assertions:done 和 cleanup:done。

这区分了目前可观测的schema/插件/流等待阶段，未发现重复迁移或共享脏状态，**但不能反推原 official 的确切卡点**：原五文件轮次无独立阶段记录，且报了 worker onTaskUpdate 超时。三文件组也不等同原五文件+当时系统状态。原 `20261105004831-04d655` 的3files失败/15pass2fail9skip/Errors3/exit1不变；负载/并发只作线索，不给CPU或生产bug定论。阶段证据交 C1 与共享RPC诊断关联；本轮没有反复整矩阵，没有提高预算或业务“容错修复”。当前正式自检仍未收敛为绿。

基线 **main `a9683a43b`**，正常 merge **`1c392486c`**。本轮仅新增 `host/e2e/streaming/error-after-partial.test.ts`，作业 **`20261105004415-2455a3` 经 job.mjs wait 取得 exit 0，1 passed**。命令 `npx vitest run -c vitest.host.config.ts host/e2e/streaming/error-after-partial.test.ts --maxWorkers=1`，日志 `/home/dsdev/.oc-jobs/done/20261105004415-2455a3.log`。

### 先定 Rust 失败来源，再验生产链

- Rust `dstu-llm/src/llm_manager/model2_pipeline.rs:543–579,7188–7213`：adapter requires explicit completion，EOF 时没有 terminal success 即 AppError::llm 的 missing-terminal 错误。真实本地 HTTP/SSE 只发送原 error 脚本的一帧 `部分回答` 后 response.end，不发 Done，也不发坏解析帧。fake.created/requests 各一次、parsed 精确一帧、finishStream 被真实 transport 调用一次，HTTP body 与 buildRequest 一致；本次不触发 fake 的额外帧解析异常。
- Rust `tool_loop.rs:1296–1310,1745–1760`：有输出后抑制自动 retry，adapter.on_error 用原 message 关闭块，再映射 ChatV2Error::Llm。精确块 error=`LLM provider 回复流提前结束，未收到完整结束标记；已保留已生成内容，可重试`，终态 error=`LLM error: `+原message；同时精确核对生产日志和单次请求，不能把任意拒绝/网络错当成功。
- Rust `pipeline.rs:997–1055`：收集已输出 segments→尝试 save_results→emit_stream_error。终态只读 listenWindow 回调里，真实 DB 已有用户正文与助手部分正文；后读一致、消息仅用户/助手各一条，blockId 与事件对应。Rust `context.rs:790–817` 明确将 collected text 保存为 status=SUCCESS/error=None，即便整轮失败；测试保持这一政策，不迁就 UI 直觉改成 error。无 Usage 帧时 DB usage 为0/source=tiktoken，失败终态无 usage。

### 完整事件与清理

全量事件通过 JSON 序列化再比较，不过滤，数组长度不变。严格十条：request audit→stream_start→skill audit→request-body→scoped start/id→content:start→content:chunk→content:error→stream_error；没有 content:end、成功/取消终态、reconnect、usage 或多余事件。生产 emitter flush 在块 error 前，部分持久化在唯一失败终态前，块 seq0..3/session seq0..1/generation1 全部核对。

任务 drain 后 session active=false、trackedTaskCount=0、公共 consumePendingCancel=false。生产 StreamHooksGuard 负责 hook/cancel 清理，但无公共只读 hook 查询，本轮不靠替身/私有 registry 自证 hooks 已空。未手动保存、绑定 sink、写错误块或 emit 终态，未修改任何生产代码。普通回答/thinking 已签门槛保持，本轮未额外手动重跑旧场景；仅该 error-after-partial EOF 分支定向通过。socket read-error、取消、retry generation、工具 chatToolRuntime、多变体、L01 parser 和 GUI 仍未签，**完整 parity 仍不通过**。提交后再执行 §5。

## 已复核续记：thinking 主链定向通过与 reasoning 完成分支

main `e9df01a3c` 已由 `38f927675` 正常合入。普通回答已有 C1 对 `3fbb56cc0` 的限定签收，本轮只增加 `thinking.test.ts`，不手动重跑旧 24/六局部、不扩工具/变体。

最终作业 **`20261105001757-5863a6` exit 0，1 passed**，由 `job.mjs wait` 亲取；命令 `npx vitest run -c vitest.host.config.ts host/e2e/streaming/thinking.test.ts --maxWorkers=1`，原日志 `/home/dsdev/.oc-jobs/done/20261105001757-5863a6.log`。当前仅新增这条 Host thinking 主链成功证据，提交后再执行 §5，不直接修改独立验收勾选。

测试沿真实 diagnostics/send→L03 execute→L02 unified stream→公共假 adapter→真实本地 HTTP/SSE，fake.created/requests 各一次、parsed 四帧，reasoning/content 都实际消费；在唯一 stream_complete 回调中读取真实 thinking=先分析、content=再回答 两块及 usage，block ID/顺序/起止时间与事件一致。全部15条序列核对思考先 chunk/end 再 content:start、正文 flush/end 在唯一终态前、generation=1、块 seq0..6 与 session seq0..1。thinking 脚本的 usage 为 prompt9/completion6/total15，嵌套 reasoning2；终态及 DB 都精确为 source=mixed、lastRoundPromptTokens=15/lastRoundInputTokens=9，对应 Rust llm_adapter.rs:63–84 与 types.rs:234–275，reasoning 不重复加入 total。

首跑作业 **`20261105000718-50a066` exit 1，1 failed**：fake/HTTP 消费、terminal 时两块落库与 usage 已通过，但 14 条事件预期被真实 15 条打破。精确新增原值为 `${streamEvent}_reasoning` 汇总，位于 content:end 与 stream_complete 之间。静态核对 Rust `dstu-llm/src/llm_manager/model2_pipeline.rs:7395–7412` 与 TS `llm/src/model2_stream_events.ts:122–124`：非空 reasoning 在 hook 完成后仍单独发完整汇总，是正确生产分支，不是要删除的事件。候选改为完整15条，并断言其 content=先分析、is_complete=true、chunk_id=对应请求ID_reasoning_final_chunk_2。

thinking 的 end result=None、切换先 close thinking 再 start content，分别对齐 Rust llm_adapter.rs:372–432；测试明确 JSON 线上 thinking:end 无 result、content:end 有正文权威内容，不硬套普通回答表。工具 chatToolRuntime 未决、错误/取消部分保存、retry generation、多变体、L01 真实供应商 parser 与真实 GUI 均未签；完整 parity 仍不通过。

第二次定向 `20261105001033-ff97b2` **exit 1 / 1 failed**：全15条已匹配，但 Host 内存对象存在 `result` 自有键，值为 undefined。不是生产返回了权威 reasoning result：`chat/src/events.ts:167` 的 `result: result ?? undefined` 与 `kernel/json.ts:65,85–90` 正式保留该内存表示，main JSON.stringify 才省略 undefined；Rust events.rs:105–106 的 None 则在序列化时跳过。测试改为先断言 raw own-key/result=undefined，再对全部 Host events 做 JSON.stringify/parse，序列化数组长度必须不变，继续严格检查 thinking:end 的 result 键缺省。没有删事件、按类型过滤或接受宽松值。两次 exit1 保留，不记通过。

恢复检查：已读取 git log -20/status 与 TESTMAP，未重做已提交普通回答。恢复要求的 `npm run migration:ledger -- --check --no-write` 作业 **`20261105000424-0819c1` exit 0**：commands1058（A100%）、tests8109（A87.8%/B1.9%），problems commands0/tests0/orphan0；prod-reachable unreachable16（unknown3633, not vetoed）。日志 `/home/dsdev/.oc-jobs/done/20261105000424-0819c1.log`。该结果不等于新的场景或完整 parity 实测。

## 已签限定门槛：首条真实 Host 普通回答通过

基线 **main `0d8591e00`**，正常 merge **`a4639ff0d`**。仅运行一条 `host/e2e/streaming/normal-answer.test.ts`：**作业 `20261104234958-48890f` 经 job.mjs wait/result 取得 exit 0，1 passed**。命令 `npx vitest run -c vitest.host.config.ts host/e2e/streaming/normal-answer.test.ts --maxWorkers=1`，完整日志 `/home/dsdev/.oc-jobs/done/20261104234958-48890f.log`。

### 实际可达链与断言

1. X5 宿主可选安装真实 `host/platform/diagnostics/index.ts`，由该插件实际 provide/shutdown backgroundTasks；L04 `index.ts:301–315` 的注入条件成立后注册 send。原不带 diagnostics 小宿主及其严格负向证据保留，不再当作主链永久阻塞。
2. 用公开 `llm.saveApiConfigurations/saveModelAssignments` 配置唯一离线模型与无工具/无 memory/RAG/web 场景，公开 chatSession 建真实会话。测试只从公共 `llmAdapters` 注入假 provider 输出，未修改 pipeline、仓储或 sink；真实 send IPC 返回 assistant ID 后，等待真实 chatState 任务结束，不手发终态。
3. `fake.created=['openai']`、requests=1，真实本地 HTTP 服务收到唯一 POST，body 精确等于 buildRequest 快照，用户消息在该请求到达时已落库。服务仅发送四个 SSE 字节帧；`fake.parsed` 精确匹配这四帧，真实 collector 消费两段正文、Usage、Done。
4. 终态只读 `listenWindow` 回调里直接读取真实 chatSession，断言用户、助手和唯一 content block=`固定回答` 已存在；唯一终态是 stream_complete，usage=prompt7/completion3/total10，generation=1。事件结束后再次查询与回调读数相同。没有测试调用 save、onComplete、bindSink 或手工 emit。
5. 保留 **全部 11 条 Host events**，严格断言 request audit→stream_start→skill audit→request-body→run-scoped start→run-scoped id→content:start→run-scoped usage→content:chunk→content:end→stream_complete。正文 block ID 对应实际 DB，块通道 seq=0..3（含 skill audit），会话通道 seq=0..1，末块 flush/end 先于 terminal。

### 失败历史与范围

- `20261104234635-f9948e` exit 1：测试错误地把 `backendEvents.listen`（返回 void）当注销函数；改用公开 `listenWindow`（实际同步监听且返回 disposer）。
- `20261104234809-167b44` exit 1：前述消费与落库断言已过，但完整序列断言发现多出 request-body/scoped start/id/usage；对照 L02 `audit_log.ts:169–179`、`model2_transport.ts:68–78`、`model2_stream_events.ts:52–55` 及 Rust `model2_pipeline.rs:6272–6292,6622` 后补齐，不删除生产事件或先过滤。
- 原 6 条局部未定向重跑；本条不是 L01 真实供应商解析器或真实 Electron 窗口验证。chatToolRuntime 仍影响工具轮，其他场景尤其工具第二轮、部分保存、cancel/retry generation、多变体仍未验收。**普通回答前置门槛已过，完整 parity 仍不通过。** 不因这一条同时关闭完整 X5-01/02/03 或独立验收勾选。

## 历史续记：fulltest `650ddffbe` 批量重试 main-red，基线 `f821b3733`

本轮正常 merge main 快进到 `f821b3733`。fulltest 报告限定在 `650ddffbe` 的该项失败，不代表最新 main 全仓结果。根因：X5 的 retry 参数表错误地把批量重试和单变体重试都写成 `variantId`。真实公开契约要求 `variantIds: string[]`（generated L04:1455–1463），L04 `register.ts:115–120` / `index.ts:330–341` 已按 L03 `executeVariantsRetryBatch` 条件注册。按指令立即 `coord.mjs escalate` 上报，回执 `2026-11-04T233337170Z-X5-stream-parity.md`；应修 X5 测试，不要求 owner 回退新接口。

修改为三种重试各自满足生成 Args 类型；合法双 variant ID 请求必须有注册表命中，并精确拒绝为 `{"code":"MESSAGE_NOT_FOUND","message":"Message not found: msg_assistant_x5"}`，不接受 invalid-args、command-not-found 或其他错误。真实数据库先确认消息/块不存在，调用后统计及查询结果不变；fake 的 created/requests/parsed 和全部 Host events 为空，stream 未注册。该证据只覆盖真实业务 guard，不是成功 E2E。原七脚本负向检查改为夹具范围的未绑定说明及精确 command-not-found，未宽松签收七场景。

| 当前基线 → 编号 | 当前方法/注册与待验收边界 | 归属 |
|---|---|---|
| `f821b3733` → X5-01 | L04 已实现四个注册；本夹具缺 backgroundTasks（真实提供者 `host/platform/diagnostics/index.ts`），send 注入条件未满足，三个 retry 已注册 | X5 补真实宿主；不再称 main 未实现注册 |
| 同基线 → X5-02 | L02 unified stream + L03 生产消费均存在；没有真实消费 fake 的成功 send 证据 | X5 首条普通回答复验 |
| 同基线 → X5-03 | L03 单/多变体运行时存在，L04 `src/service.ts:86–141` 已发布先前缺失 owner 方法 | X5 仍须证明模型输出→生产 sink→真实持久化→终态；不能以静态存在性关闭 |

**完整 parity 仍不通过。** 本轮仅 main-red 最小整改，不替换 pipeline、仓储或 sink，不手动生成终态。以下矩阵描述均按各自旧 hash 保留为历史。

最小回归命令 `npx vitest run -c vitest.host.config.ts host/e2e/streaming/reachability.test.ts -t 'registered but stops|chat_v2_retry_variants accepts' --maxWorkers=1`：作业 **`20261104233543-76712a` exit 0，3 passed / 9 filtered skipped**。首跑 `20261104233501-9738d0` exit 1 为本轮类型约束换行导致的解析错误，未收集测试，修正后才取得上述成功结果。随后提交 `fix(main-red)` 并执行 §5 自检。

## 历史续记：main `7f4fb688b` 的真实 execute 到位与旧断言整改

正常 merge=`a9413c1c5`。本次集成失败并非 execute 未实现，而是 X5 的缺口断言已过时。定向复现作业 `20261104172917-e99a8d` **exit 1**：`reachability.test.ts` 要求 `execute` 为 undefined，实际为 `[AsyncFunction execute]`。修正为检查 `execute/executeWithEmitter/executeWithExistingUser` 三个公开方法存在，保留 L02 hooks/unified-stream 及 fake 未消费断言，不把存在性检查算作真实发送成功。

| 当前 hash → 编号 | 方法/注册与剩余缺口 | owner |
|---|---|---|
| `a9413c1c5` → X5-01 | `host/plugins/chat` 仍无四个 send/retry 命令注册 | L04，阻塞 |
| 同基线 → X5-02 | L02 unified stream 已发布，L03 已在生产组合消费；尚无 send 进入该闭环的实测 | 提供/消费实现已在 main；待主链复验 |
| 同基线 → X5-03 | `6cb7aad13/e014fffbb/a27a04e7b` 实现单变体执行、工具环/工具轮和压缩；`index.ts:212–220` 已发布三个执行入口。`execution-runtime.ts:39–52` 在组合时要求 L04 17 项 owner 方法（含 createMessageWithConn/createBlockWithConn 等），当前 L04 服务未提供完整事务面，缺失时在 emit/write 前拒绝 | L03 实现已进 main；L04 仓储面与端到端复验仍阻塞 |

不再使用“公开 execute/tool-loop 未实现”的旧结论，也不因生产方法已发布就关闭完整 X5-03。**完整 parity 仍不通过**；真实普通回答首条仍待 L04 注册与 owner 面正常进入 main。没有改生产实现，没有向 chatSession 补测试仓储方法。

协调者指定的同样三项检查已执行并取结果：`20261104173123-e79ea8` `npm run typecheck:host` **exit 0**；`20261104173123-34ba58` `npm run migration:boundaries` **exit 0**（2755 文件，0 violation）；`20261104173123-31fdd8` `npx vitest run -c vitest.host.config.ts host/e2e/streaming --maxWorkers=1` **exit 0，23 passed**。这是整改门禁复验，不能当新主链通过数。

## 历史续记：main `677f6727c` 的 VFS 宿主装载回归

正常 merge=`23a47af33`。lane-gate 的 tests 作业 `20261104161456-919d77` exit 1，两个 suite 均因 `dstu.vfs` 缺必需注入 `notes/vfsIndex` 在装载时失败；与先前已修的 L02 注入缺口无关。只在 X5 夹具补装真实 `dstu.notes/dstu.vfs-index`，并在宿主装载用例检查插件 ID 与服务存在，不改生产代码、不加空服务。

定向回归 `20261104161902-1b782a`，`npx vitest run -c vitest.host.config.ts host/e2e/streaming/reachability.test.ts -t 'loads the real chat/pipeline/LLM and dependency plugins' --maxWorkers=1`：**exit 0，1 passed / 11 filtered skipped**。不是主链场景；三行主链缺口未解除，完整 parity 仍不通过。修复提交后另执行 lane-gate。

## 续记：main `1e893eb61`，L03 unified stream 消费与文本轮局部到位

正常合并为 `61c8b64cb`；L03 `e3e715e00` 已在该基线。以下是静态生产入口核对，不是新运行通过的主链场景。

| 当前 hash → 编号 | 真实方法/注册与剩余缺口 | owner |
|---|---|---|
| `61c8b64cb` → X5-01 | `host/plugins/chat/**/*.ts` 仍无四个 send/retry 命令注册 | L04，阻塞 |
| 同基线 → X5-02 | `chat-pipeline/index.ts:201–204` 发布 `createUnifiedTextStream`，`src/unified-text-stream.ts:58–69` 实际调用 L02 unified stream；不再称“无 L03 消费方”。但 send→execute→该绑定仍不可达 | L02/L03 局部到位；主链待 L04/L03 |
| 同基线 → X5-03 | `index.ts:194–199` 已有 `createFinalPersistence/createPreparedTextExecution`；`src/text-execution.ts:80–122` 已实现无工具预备文本轮的即时用户保存、最终与错误/取消部分保存、终态。公开 `chatPipeline.execute` 与 tool-loop 仍缺；`api.ts:245–269` 的 `ChatPipelineExecution` 明示为尚待运行时组装的目标契约 | L03，完整编排仍阻塞 |

不能用测试自行组装 persistence/history/effects 再调用预备文本轮，冒充真实 send 闭环。继续保留 `REAL-CHAIN-PLAN.md` 中首条普通回答门槛：fake 确实消费、真实生产 sink、真实落库与终态；首条成功后才扩七场景。**完整 parity 仍不通过。**

## 历史续记：main `45c3250b0` 合入，X5-02 提供方到位

| 编号 | main 上的状态（逐 hash） | owner |
|---|---|---|
| X5-01 | `host/plugins/chat` 仍无 `chat_v2_send_message/retry_*` 四个注册 | L04，阻塞 |
| X5-02 | `44e7e8a76` 已真实 provide `llmModel2Streaming.callUnifiedModel2Stream/WithConfig`（`api.ts:224–228`，`index.ts:108`）；C1 所报后继 `ccd8c907f` 不在 main。**提供方已存在，尚无 execute 消费它，闭环未证明** | L02 提供方完成；闭环待 L03 |
| X5-03 | `chatPipeline.execute` 仍缺 | L03，阻塞 |

`44e7e8a76` 给 `dstu.llm` 新增必需注入 `injectionBudget`、`llmCodexAuth`，X5 夹具因此装载失败。修复只在 `__fixtures__/host.ts`：`injectionBudget` 用 F3 真实纯函数；`llmCodexAuth` 为已登出且拒绝请求的替身（真实 L01 插件会重复提供 `llmAdapters`，与假 adapter 冲突；X5 场景不走 Codex）。`reachability.test.ts` 的 X5-02 断言改为提供方存在、execute 仍缺。验证结果见 lane-gate 记录。

## 续记：集成门禁 test-double 修复

集成 log 报 7 个 changed 文件 21 条 `test-double`，精确扫描（作业 `20261104092041-0d6e13`）全部落在 `host/e2e/streaming/bridge.spec.mts`、`demo.spec.mts`：`boundary-rules.mjs:32–38` 的 `isTestFile` 不把 `.spec.mts` 视为测试。处理：merge main 得 `1251b2b6a`（main `081b3426d`），两文件原样移入允许目录 `host/e2e/streaming/__tests__/`，仅调整相对路径和前端配置 include。没有删断言、改拼写或加豁免。

验证作业（均经 `job.mjs result/wait` 取真实退出码）：`typecheck:host` **`20261104105315-1892a1` exit 0**；全量 boundaries **`20261104105315-657032` exit 0**（2344 文件 0 violation）；本目录 boundaries **`20261104105315-f1296c` exit 0**；host vitest 本目录 **`20261104110355-11e8fd` exit 0**（23 passed）；前端 spec **`20261104110355-56e46f` exit 0**（6 passed）。这些是门禁复核，不新增主链场景，下方三行阻塞矩阵与"完整 parity 不通过"不变。

## 续记：08:21Z 主链复验准备 / 08:28Z 交付回执

本轮已正常合并 main：**`3380b7849`**，main 快照 **`3b2758d7a`**，无冲突。重启恢复时 HEAD=`de77fd6ae`（协调者自动保存了本轮复验计划与 reachability 的 hooks 描述修正），不重做该提交。以下基于这个已合并生产基线，**不是推测其他 owner 分支的最新状态**。

### 当前 hash → 方法/注册 → owner：三行阻塞矩阵

| 编号 / 当前生产快照 | 当前已存在与尚缺的入口（静态证据） | 责任 owner / 本轮结论 |
|---|---|---|
| **X5-01**；基线 `3380b7849`，chat 注册文件最后提交 `40fe1f202` | `host/plugins/chat/index.ts:38–72` 未声明 send/retries 四命令：`chat_v2_send_message/chat_v2_retry_message/chat_v2_retry_variant/chat_v2_retry_variants`；在 `host/plugins/chat/**/*.ts` 查询对应 `commands.register` 无匹配 | **L04**：交付真实注册与 handlers→公开 pipeline 调用；仍阻塞，不再重复运行已知 command-not-found 场景 |
| **X5-02**；同基线，llm api 最后提交 `7bc9eb9d6` | `api.ts:178–184` 已发布 `llmStreamEvents` register/unregister/owner hooks，`index.ts:98` 真实 provide；`llmStreaming` single-shot 亦存在。`api.ts:207–230` 无 `callUnifiedModel2Stream`，TS 实现查询 camelCase/snake_case 均无 unified chat stream 调用入口 | **L02**：剩余是**统一 chat stream 实际调用**，不是“hooks 全缺”；独立 hooks/single-shot 不能代替生成主链，仍阻塞 |
| **X5-03 剩余主编排**；同基线，pipeline api/index 最后提交 `245237524` | `api.ts:216–223` / `index.ts:162–174` 已有 `createPersistence/createSessionEventEmitter/bindStreamingSink/createVariantStreamContext`；`src/incremental-persistence.ts:38–129` 有即时用户保存/增量事务 helper。公开 `execute/executeWithExistingUser/executeMultiVariant` 与 tool-loop 最终/错误/取消保存主编排仍缺，现有 `executeRetrievals` 不等价于 execute | **L03**：交付真实 execute/tool-loop→L02 unified call→L04 仓储绑定/最终与部分保存；不否认 binder/context/增量 helper 的已存在能力，但不关闭完整 X5-03 |

**完整 parity 继续“不通过”。** X5-05、X5-04 接线、X5-03 发射部分的 `3d293b55e` / `20261104065020-9dacfe` 已签局部结果保持，不重跑旧六条、不再改独立验收勾选。本轮真实主链测试未运行，runner 退出码 **N/A**：上述入口未齐备，不能用 fake pipeline 或手发终态制造普通回答成功。

### 08:28Z 新交付纠正：旧 sink 夹具缺 paths 已解决

- 静态核对 `1f39f5d83` 的 `tests/chat-host.ts`：已提供真实 F4 Paths 并校验桌面 platform；`745463f6b` 补记最终交付证据。**不再把“新候选夹具缺 paths”列为当前待修项**，下方 `20261104064332-f79e14` 失败仅是修复前历史。
- 本轮没有重跑它：从本工作树调用 `job.mjs result 20261104073614-29a529`，亲取已有作业原始结果：**2 tests passed，`[作业 20261104073614-29a529] 退出码 0`**，无 Errors。该作业实际 cwd=`/home/dsdev/dev/ds-mig/L03-chat-pipeline`，命令 `npx vitest run -c vitest.host.config.ts host/plugins/chat-pipeline/tests/stream-sink-wiring.test.ts --maxWorkers=1`；这是提供方分支已执行作业的复核，不冒称本工作树重新运行或当前 main 已包含该后续提交。
- 静态核对 `e7b0de787`：`chatPipeline.immutableCommandGuardForToolCall` 已真实委托 L05 immutable shell guard，**不是完整 execute**。按 `745463f6b` 与 C1 回执，`isLocalShellExecuteTool(name,args)` 分类口仍待 L05 api，原 `catastrophe_guard_is_wired_only_to_backend_local_shell` 仍 pending；本轮未新增该分类器替身、未销项、未运行该测试。

### 已准备但未执行的真实闭环断言

`host/e2e/streaming/REAL-CHAIN-PLAN.md`（`de77fd6ae` 已保存）包含：

1. 先只跑一条普通回答，断言 `fake.created>0` **且** requests/parsed 实际发生；真实 send→execute→统一 stream→生产 sink→终态前仓储数据，不手动补 save/emit。第一条成功后才扩到七场景。
2. 工具第二轮必须真实 registry 执行确定性本地工具，第二次 provider request 同时匹配 assistant call id 与 tool result `tool_call_id`、固定输出标记，再核对 terminal 时实际持久化的 tool output/sidecar/第二轮正文；当前 web_search 脚本不能冒充离线真实工具。
3. 出错/取消先消费固定前缀，再由真实 provider 错误或公开 cancel+AbortSignal 收尾；terminal 时直接读真实持久化部分正文、检查终态互斥与 generation，不允许测试调用保存 helper 造落盘。
4. 真实 cancel 后同 messageId retry 分配严格递增 generation；旧流真实晚到终态不能结束新流。若生产 guard 抑制旧终态就核对抑制事实，不能手造旧事件冒充主链证据。

本轮仅给假 LLM 加上 `buildRequest` 入参的只读快照观测 `requests:{round,model,body}[]`，用于未来严格核对第二轮输入；不实现 transport，不修改 provider/pipeline 输出。现有 `127.0.0.1:9` 是防意外联网的占位，**不是**可运行 provider 字节输入；入口齐备后若仅 llmAdapters 替换仍不足以给出离线读流，将登记真实公开传输注入缺口，不用 mock execute 绕过。`reachability.test.ts` 已修正为检查独立 `llmStreamEvents` 存在而 unified 调用仍缺；该更改本轮未运行，不宣称更新后的通过数。

跨平台和真实窗口/utilityProcess/完整持久化主链仍未验证；本轮无新增通过场景。

### 中断恢复检查与 ledger（本轮）

按恢复指令已读取 `git log --oneline -20`、`git status`、本 lane TESTMAP，确认 `de77fd6ae` 已保存计划与 hooks 描述修正，未重复重做。工作区只续作本 lane 的报告/地图和假 LLM 请求观测。

经全局 jobs 执行恢复要求中的 `npm run migration:ledger -- --check --no-write`，作业 **`20261104085046-46783d`**；`job.mjs result` 原始结果：

```text
ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 78% B 0.9%);
problems: commands 0, tests 0, orphan registrations 0;
checkCoverage（host/kernel/coverage.ts）
[作业 20261104085046-46783d] 退出码 0
```

该结果是全仓迁移账本一致性，不是完整流式 E2E 实测，不能据 ledger 通过关闭上述三行阻塞。输出路径 `/home/dsdev/.oc-jobs/done/20261104085046-46783d.log`。本轮不重复旧六条、不运行新普通回答（生产入口仍缺），未写 ledger。

## 历史续记：06:00Z 队列定向复核（实际运行 14:43–14:50 +08）

已按授权 merge main，提交 **`46e6299e0`**，main 快照 **`9c13dfc39`**；无冲突。`git merge-base --is-ancestor a5a8ffa30 HEAD` 与 `a7fdaf010 HEAD` 均退出 **0**，因此不是只读分支候选或摘实现到审计分支，而是合法合并后的真实生产代码。本轮只验证下列三个局部项，不重跑完整 29 条、不重新运行全仓类型检查/ledger，不修改任何生产实现、其他 lane 夹具或 ACCEPTANCE 勾选。

**最新结论：X5-05 关闭；X5-04 的公开生产 binder 接线缺口关闭；X5-03 只关闭“变体 Host 发射入口缺失”子项。完整 X5-03、X5-01、X5-02 的 chat unified 调用闭环以及完整 parity 仍未通过。** 下面旧轮次中“X5-05 未修复 / 只在分支 / 测试 binder”的文字保留为历史，不是当前状态。

| 编号 / 本轮裁定 | 修复提交 | 本基线真实生产入口 | 本轮真实 runner 证据 |
|---|---|---|---|
| **X5-05：已证明修复，关闭** | `a5a8ffa30`；没有重复实现修复 | `host/plugins/chat-pipeline/src/llm-adapter.ts:239–260` 的 `resetStreamState → touchActivity()`；`:441–442` 写入 `this.elapsed()`，与 Rust `llm_adapter.rs:294–307,721–722` 的 Instant 活动时钟一致；经真实插件 `chatPipeline.createStreamingAdapter` 调用 | X5 `components.test.ts` 中对应 `.fails` 已移除为普通 `it`，保留 wall=1_800_000_000_000、mono100→151 的 **51ms** 断言，追加 wall 回拨仍51ms、收到正文后20ms；使用生产 binder，无时钟替代生产状态机。通过作业 **`20261104065020-9dacfe`，退出码 0** |
| **X5-04：生产 sink 接线子项关闭** | `a7fdaf010`，L03 交付说明 `c0f8fd3be` | `host/plugins/chat-pipeline/src/stream-sink.ts:5–31`；`index.ts:165–174` 的公开 `createSessionEventEmitter/bindStreamingSink`；`api.ts:218–223`。start/preparing 注册元数据并调用 L04 WithMeta，chunk 调 L04 `emitChunk`，没有用绕过 batcher 的 `emitChunkWithMeta` | X5 精确正文 JSON/通道/两套 sequence、reasoning/content 交替合批、工具 preparing+args/元数据、error 尾部，均由**生产工厂与生产 binder**发至 Host；同作业 **退出码 0**。本目录手写 `bindSink` 已删除，不再作为接线替身 |
| **X5-03：仅“变体发射”子项关闭；完整执行仍阻塞** | `a7fdaf010` | `chatPipeline.createVariantStreamContext` 在 `index.ts:172–174` 绑定真实 sink；`src/variant-adapter.ts:185–212` 从 context 方法直接发至该 sink，不再只写 diagnostic events 数组；`createVariantStreamingAdapter` 仍走生产服务 | X5 变体用例改为真实公开 context/adapter：`onContentChunk` 后、`onComplete` **之前** Host 已见 `variant_start/content:start`，context 有增量文本；完成后精确 chunk/end、string variantId、variant_end/usage、session terminal。没有回放 diagnostic events。作业 **退出码 0**；没有证明多变体执行调度或 DB 持久化 |

### 队列命令与失败记录（全部保留，不截取通过行代替退出码）

全局客户端：`node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs`。所有 submit/result 命令均在本工作树执行，没有进入主仓库改文件。

1. **`20261104064332-f79e14`**：按要求最小运行提供方测试：

   ```sh
   job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/chat-pipeline/tests/stream-sink-wiring.test.ts --maxWorkers=1
   job.mjs result 20261104064332-f79e14
   ```

   result 原始结果：**`[作业 20261104064332-f79e14] 退出码 1`**；2 tests failed。两条均在 `createPipelineHost → createTestHost → verifyStarted` 失败，错误 **`plugin "dstu.vfs-repos" did not start: required services not available: "paths"`**。未到 sink 断言，不当作修复失败，也不冒记该测试通过。**没有越界修改 `host/plugins/chat-pipeline/tests/chat-host.ts` 或其 notes/merge 夹具**，仍需责任 lane 修正真实依赖装载。
2. **`20261104064621-9b0d8b`**：X5 自有定向用例首跑，命令与下一条相同；result **退出码 1**，suite 装载阶段因同样缺 `paths` 失败，11 tests skipped，**没有实际断言通过**。已仅在 X5 自有测试夹具补入真实 `createPaths`（路径/env 限定自身临时目录），没有提供 dummy paths；补装真实 workspace 插件以满足 pipeline 新增 `agentVfsResolver` 注入。
3. **`20261104065020-9dacfe`**：补齐**本 lane 测试宿主**的新生产依赖后，唯一一次有效局部重跑：

   ```sh
   job.mjs submit -- npx vitest run -c vitest.host.config.ts host/e2e/streaming/components.test.ts --maxWorkers=1 -t 'X5-05|content: Rust|reasoning/content|tool preparation|error closes|X5-03 variant'
   job.mjs result 20261104065020-9dacfe
   ```

   result 原始摘要：

   ```text
   Test Files  1 passed (1)
        Tests  6 passed | 5 skipped (11)
     Duration  25.06s
   [作业 20261104065020-9dacfe] 退出码 0
   完整输出 /home/dsdev/.oc-jobs/done/20261104065020-9dacfe.log
   ```

   六条为正文 wire、思考交替、工具准备、错误、生产变体发射、计时；其中 X5-05 是**正常通过，不再是 xfail**。其余5条只因 `-t` 未选，不声称本轮覆盖，原 bridge/demo/完整场景均未重跑。

### 测试位置与未证明事项

- `host/e2e/streaming/__fixtures__/host.ts`、`__fixtures__/fake-llm.ts` 现在是真正的纯测试 helper 所在位置；更新测试 import，不拆词逃扫描、不削断言。宿主使用真实 native/vfs/vfs-repos/llm/chat/agent-workspace/chat-pipeline 入口和真实 storage/settings/secrets/paths 实现；仅 llmAdapters 按最初要求作测试注入。本次选中用例未驱动生成，**假 LLM 仍没有被完整 send 消费的证据**。
- L02 `llmStreamEvents` 本轮合并后的 `index.ts` 已提供，不再称其“完全无 hooks”；但没有据此验证 chat unified stream/生产循环。L04 registry 的分支进展也不等于 send 已闭合。
- 没有把 X5-03 的 execute/tool-loop、工具实际往返、partial-save、多变体调度、真实完整持久化从阻塞改为通过。Rust 基线中取消可能无全部 block end、token batch 合并、双通道独立序号等规则仍按下文规格不变。
- 本轮仅 Linux/Node Host 局部定向回归；macOS、Windows、真实 Electron 窗口/utilityProcess、完整发送跨平台仍未验证。独立 B 级验收由独立验收人处理，本轮没有勾选或改写其结论。

## 历史：C1-app 04:25Z 续记（当轮仅更新阻塞）

已按指令合并 main：merge commit **`0e6f4dc20`**，合入的 main 快照 **`29bc10a47`**。无冲突。本轮只静态核对接口/实现与提交，不重跑 29 条新增测试、不运行 Rust、不自修管线、不修改独立验收勾选。

**当前仍为“不通过完整 parity”；X5-05 未修复。** 下表更新首轮“hooks / registry 尚无接口”的表述，不能把新增能力等同于生产发送闭环。

| 修复编号 | 提交 / 快照证据 | 真实生产入口（静态核对） | 当前状态 | 本轮测试命令 / 退出码 |
|---|---|---|---|---|
| X5-01 / L04 | 合并 main=`29bc10a47`；L04 分支快照=`12c075dd5` | 已合并 `host/plugins/chat/index.ts` 仍未注册 send/retry；L04 分支 `BLOCKERS.md:20–22` 仍记录 handlers 本体未完及 L03 execute 缺口 | **阻塞，不销项** | 未运行；退出码 N/A |
| X5-02 / L02 | `cc047f02c` 引入 `src/model2_stream_events.ts`；`af32992c2` 是后续说明/本轮读取的分支快照，不当作独立运行验收 | 分支 `api.ts:178–184` 的 `LlmStreamEvents`；`index.ts:77,97` 声明并 provide `llmStreamEvents`；`src/model2_stream_events.ts:136–142` 真实构造 registry、register/unregister/owner 清理与 collector | **hooks 子缺口在分支有实现证据，未合入本次 main；chat unified stream 仍阻塞**。本次 main 已有 `llmStreaming.singleShotCompletion`（`index.ts:91–92`、`src/streaming_service.ts:11–75`），它不是 chat unified stream；不能再泛称 L02“完全没有流式服务” | 未运行；退出码 N/A；未采信提供方测试自述为本轮实测 |
| X5-03 / L03 + L04 | `f47467e34` 含 registry/context/service 实现；`1a056a918` 后续只改 SPEC/BLOCKERS，不当作新增实现；L04 快照=`12c075dd5` | 分支 `host/plugins/chat/api.ts:20–24,137–138` 导出 `ChatExecutionContext/ToolExecutorRegistry` 与工厂；`src/service.ts:56–57` 真实创建 context/registry | **registry/context 子缺口在 L04 分支局部解除，尚未合入本次 main**；L03 execute、send 生产调用方、工具结果转下一轮与变体生产 sink 仍未闭合，不销项 | 未运行；退出码 N/A |
| X5-04 / L03 + L04 | 本轮未收到针对性修复提交 | 首轮 L03 meta 对象 sink 与 L04 positional variantId/preparing 方法的生产绑定仍待完成 | **保留接线缺口**；测试 `bindSink` 不能代替生产接线 | 未运行；退出码 N/A |
| X5-05 / L03 | 本轮无修复提交；只读 L03 快照=`a0a64ab40`；该文件最后相关提交仍为 `e191e0950` | 合并后的 `host/plugins/chat-pipeline/src/llm-adapter.ts:239–260` 与上述 L03 分支快照均仍为 `lastActivityAt=this.now()`，而构造/touchActivity 用 `this.elapsed()` | **确认仍存在，保持 `components.test.ts:177–185` 的 `it.fails`**；这是静态确认，不是本轮重复运行复现 | 未运行；退出码 N/A |

分支证据通过当前工作目录中的 `git show <ref>:<path>` 只读取得，未切换分支、未进入其他 worktree。读取分支代码不代表合入或运行过它。上述正向接口证据、时钟表达式查询及 `git merge --no-edit main` 均退出 0；“未运行”没有伪造测试退出码。

### 后续复核触发条件（本轮不执行）

1. **收到 X5-05 的 L03 修复通知并核实已合入后**，移除该条 `.fails`，通过真实 `chatPipeline.createStreamingAdapter` 运行局部回归：

   ```sh
   npx vitest run -c vitest.host.config.ts host/e2e/streaming/components.test.ts --maxWorkers=1 -t 'retry reset must reset the monotonic idle clock'
   ```

   记录“X5-05 → 实际修复提交 → 真实生产入口 → 命令 → 退出码”；不能把当前 xfail 的 runner 通过算为修复成功。
2. **send/hooks/execute/unified stream 与工具 registry 的真实调用方均齐备并合入后**，再复核普通、思维链、工具往返、错误、取消、重试、变体。必须观测到假 LLM **实际被消费**、真实生产 sink 发射、真实持久化结果；不得用测试 `bindSink`、手发终态或内存 events 回放替代接线。当前 `reachability.test.ts` 是阻塞复现，不是未来完整发送验收的现成通过证明。
3. Linux 首轮局部测试历史结果保留；本轮没有新增平台实测，macOS/Windows、真实 Electron utilityProcess/窗口及完整发送跨平台语义均**未验证**。

本轮完成阻塞说明后暂停，等待责任 lane 修复通知；下面保留首轮审计与命令记录，均按当时基线解读。

## 首轮结论（`f23c98702`，当前局部修复见最新续记）

**不通过：尚不能证明完整发送的 Rust/Electron parity。** 首轮真实 Host 可装载 chat、chat-pipeline、LLM 及其必要依赖，但 send/retry IPC 未注册，当时 L02 无 chat 流式调用/hooks，L03 无完整 execute/tool-loop。七个脚本均在到达假 LLM 前失败，事件序列是空数组。后续 hooks/registry 的局部进展见上方续记，完整闭环仍未成立。没有以测试自建管线、手发终态、demo 或 mock 替代此缺失并宣称 E2E 成功。

- 规格：**36 个已声明事件类型**（21 block + 15 session），另有 2 个通道、4 个 phase、2 个通用 envelope 和顺序/终态规则。不是声称 36 种业务工具的所有 JSON 变种均已动态覆盖。
- 新增测试：Host **23** 条（含 **1 条明确的预期失败 `it.fails`**）；Electron/前端消费边界 **4** 条；真实 demo 播放器对照 **2** 条。**29 条 runner 通过 ≠ E2E parity 通过**。
- 另运行现有前端消费测试 **21** 条，全通过。
- 不一致/缺口：L04 入口 1 组、L02 流式服务 1 组、L03 执行/变体接线 1 组、L03/L04 sink 对接 1 组、L03 单调计时缺陷 1 项，共 **5 组**。未修改任何管线、Rust、前端或已有 lane TESTMAP。

## 1. 证据与测试边界

| 层 | 真实代码 / 证据 | 本次验证方式 |
|---|---|---|
| 权威名称 | `src-tauri/crates/dstu-core/src/events.rs:12–122` | 只读解析，逐个与 TS 常量对象全等比较 |
| Rust wire | `src-tauri/crates/dstu-agent/src/chat_v2/events.rs:59–435` | 读取 serde 命名、字段、skip 语义；不编译/运行 Rust |
| Rust 实际执行 | `chat_v2/pipeline.rs:838–1055,1099–1149`；`pipeline/tool_loop.rs:1293–1370,1657–1786` | 分支和收尾静态核对 |
| TS 插件 | `host/plugins/{chat,chat-pipeline,llm,vfs,vfs-repos}/index.ts`；`host/platform/native/index.ts` | 在真实 `createTestHost` 中安装；真实 storage/settings/secrets 实现和 chat_v2/mistakes/vfs 迁移库 |
| 假 LLM | `host/e2e/streaming/fake-llm.ts` | **仅**通过 `provide.llmAdapters` 公开注入；固定 token、reasoning、tool call/第二轮、error 脚本；cancel 由公开取消服务驱动。当前 send 阻塞，适配器创建 0 次，不能声称脚本已驱动生成 |
| 局部流事件 | `host/e2e/streaming/components.test.ts` | 经公开 `chatPipeline.createStreamingAdapter`；测试内显式 sink binder → 真实 `ChatV2Emitter`/`BackendEventsSink`/Host；**不经过假 LLM/生产 execute** |
| Electron 桥 | `electron/shell/runtime.ts:149–157`、`shell/plugins/event.ts:42–56`、`preload/bridge.ts:147–208` | 真实 ShellRuntime/registry/plugin:event/preload，官方 `@tauri-apps/api/{core,event}`，真实 TauriAdapter 注册/消费；只替换 OS 窗口与进程传输 |
| 前端事实契约 | `src/features/chat/adapters/tauri/adapterLifecycle.ts:37–55`、`blockEvents.ts:29–149`、`sessionEventHandler.ts:55–58,312–461` | 收到的 block payload 与 Host JSON 逐项全等；session 正确消费成功/error/cancel/stale generation。**eventBridge/store 下游是观测 spy，并非真实 store/render E2E** |
| Demo | `src/demo/scriptPlayer.ts:100–177,187–193` | 运行真实播放器；emit 采样 spy、snapshot 外围替身；正常+取消对照 |

测试数据仅在本次创建的 `/tmp/opencode/x5-stream-*` 中读写，结束清理自身目录。无远端、无真实 LLM、无 Rust 构建、无生产数据库操作。桥测试与插件宿主测试分开执行，未启动真实 Electron 窗口或 utilityProcess。

## 2. 权威事件规格

以下 `R` 指 `src-tauri/crates/dstu-agent/src/chat_v2/`；`F` 指 `src/features/chat/`。`JSON` 为 serde_json::Value，`?` 表示缺省时**省略键**，不是 `null`。嵌套 JSON 中的显式 `null` 保留。

### 2.1 通道与 envelope

1. 块通道：`chat_v2_event_{session_id}`。不是 `content_chunk` 等独立事件名：`type` 与 `phase` 在同一个 payload 内。
2. 会话通道：`chat_v2_session_{session_id}`，用 `eventType`（不是 block 的 `type`）。前端按此精确注册，见 `F/adapters/tauri/sessionEvents.ts:6–11`。
3. LLM 内部的 run/variant-scoped stream key 不是另一个供 TauriAdapter 订阅的 block 通道。全局诊断旁路 `chat_v2_llm_request_body` 由 `F/adapters/tauri/blockEvents.ts:153–193` 按 `streamEvent`/message 过滤；本次完整生成阻塞，未证明此旁路。

**BackendEvent**（`R/events.rs:71–140`，serde camelCase）：

```ts
type BlockEnvelope = {
  sequenceId: number; // Rust u64，每会话共享的 block counter，从 0 开始
  type: string;
  phase: 'start' | 'chunk' | 'end' | 'error';
  sessionId?: string; // 真实 emitter dispatch 时补入
  messageId?: string; blockId?: string; blockType?: string;
  chunk?: string; result?: JSON; error?: string; payload?: JSON;
  skillStateVersion?: number; roundId?: string;
  variantId?: string; modelId?: string; status?: string; usage?: TokenUsage;
};
```

- 普通 start：`messageId:string`，`blockId?:string`、`payload?:JSON`；chunk：`blockId:string,chunk:string`；end：`blockId:string,result?:JSON`；error：`blockId:string,error:string`。`messageId` 不要求重复出现在 chunk/end/error。
- variant_start/end 和 skill_injection_audit 是下表列出的**无 blockId 特例**，不能用“所有 end 必须 blockId”的假规则拒绝。
- block 元数据可先注册，后续 chunk/end/error 继承 `variantId/skillStateVersion/roundId`。同一会话不同 emitter 不重置计数；不同会话独立。
- u64/usize/i64 在现有 JS 契约中为 number；本次未构造大整数边界，也不声称覆盖该数值范围。

**SessionEvent**（`R/events.rs:365–435`）：

```ts
type SessionEnvelope = {
  sessionId: string; eventType: string; timestamp: number; // Unix 毫秒 i64
  sequenceId?: number; // emitter 恒补；兼容旧事件才可缺省
  messageId?: string; streamGeneration?: number; skillStateVersion?: number;
  replayMode?: string; modelId?: string; retryAttempt?: number; retryMax?: number;
  error?: string; durationMs?: number; usage?: TokenUsage;
  title?: string; description?: string; payload?: JSON;
};
```

`sequenceId` 在 session channel 使用**另一套**每会话 counter，不能把两通道的 0/1/... 当作重复或丢包。`streamGeneration` 来自当前注册代次；不是 timestamp，也不能用 messageId 代替。直接 `window.emit` 的 goal/variant_deleted 是下面的自定义例外，并不具有所有 SessionEnvelope 字段。

**TokenUsage**（`R/types.rs:104–150`）：必需 `promptTokens/completionTokens/totalTokens:number(u32)`，`source:'api'|'tiktoken'|'heuristic'|'mixed'`；可省略 `reasoningTokens/cachedTokens/cacheWriteTokens/lastRoundPromptTokens/lastRoundInputTokens:number`。特别注意 `lastRoundPromptTokens` 历史语义为该轮 **input + output**，`lastRoundInputTokens` 才是纯 input。测试验证了 usage 透传，未穷举计费算法。

### 2.2 块级类型（21 条）

每行继承 BlockEnvelope 的对应 phase 字段。没有业务生产者证据的常量明确标出，不发明固定 payload，`JSON` 也不是声称已穷举工具协议。

| ID | `type` | 额外字段 / 数据形状 | 权威位置 / 说明 |
|---|---|---|---|
| B01 | `thinking` | start 无业务 payload；chunk `string`；end 无 result | `R/pipeline/llm_adapter.rs:334–419`；正文开始前结束当前 thinking |
| B02 | `content` | start；chunk `string`；正常 end `result:{content:string}` 为该段权威正文；`finalize_all()` 可无 result；error `error:string` | `R/pipeline/llm_adapter.rs:421–509,954–978,1548`；不可把所有 end 都强制成 `{content}` |
| B03 | `tool_call` | start `payload:{toolName:string,toolInput:JSON,toolCallId:string|null}`；chunk `string`（可编码进度 JSON）；end `result:JSON?`，执行器惯例 `{result:JSON,durationMs:number}`；error `string` | `R/events.rs:1581–1606`、`R/tools/executor.rs:636–738,767`；前端块类型是 **mcp_tool**，不是 tool_call |
| B04 | `tool_call_preparing` | start `payload:{toolCallId:string,toolName:string,status:'preparing'}`，blockId 可选；chunk 为参数 JSON 的字符串增量 | `R/events.rs:1609–1725`；adapter 对小增量缓存，到 500 UTF-8 字节或完整 call 时 flush；检索类 builtin 不建 preparing，防止孤儿块 |
| B05 | `image_gen` | 当前 adapter start `payload:{prompt:string,options:{width?:number,height?:number,n?:number,model?:string,style?:string,quality?:string}|null}`；随后 error `'图片生成功能尚未实现'` | `R/adapters/tool_adapter.rs:535–574,600–624`；不能写出虚构成功样例作为 Rust 基准 |
| B06 | `rag` | start；end `result:{sources:SourceInfo[],durationMs:number,sourceType:'vfs_rag'}`；失败 error string；其他检索 producer 可有附加 JSON 字段 | `R/pipeline/retrieval.rs:74–170`；这是可调用辅助方法，不表示首轮一定自动执行 |
| B07 | `memory` | 旧预检索辅助方法 end `{sources:[],durationMs:number,note:string}`；现行 builtin-memory_search 按工具生产者协议 | `R/pipeline/retrieval.rs:310–354` 明确 Memory-as-VFS；不能据旧注释假设非空检索 |
| B08 | `web_search` | start；LLM 服务端搜索 end `{sources:Array<{index:number,citationTag:string,typeIndex:number,title:string|null,url:string,snippet:string|null,score:null,source_type:'web_search'}>,count:number,durationMs:number}` | `R/pipeline/llm_adapter.rs:819–948`；仅 completed 的 provider 也先补 start；本地搜索工具的 result 可扩展，不等同所有结果都来自 provider |
| B09 | `multimodal_rag` | start；end `result:{results:SourceInfo[],durationMs:number}`；error string | `R/pipeline/retrieval.rs:199–293`；注意这里叫 **results**，不能改成 sources |
| B10 | `insight_recall` | BlockEnvelope；业务 payload/result 为工具所有者的 JSON | core 常量行 46；不在本次 chat-pipeline 动态覆盖范围，不把名称当作固定结果 schema |
| B11 | `anki_cards` | BlockEnvelope；结构化 `chunk:string`，通常每条为完整 JSON 记录；result JSON | core 常量行 47；`src/demo/scriptPlayer.ts:132–145` 明确不可任意切片；具体卡片字段属于 ChatAnki 工具协议，未在本次穷举 |
| B12 | `qbank_questions` | BlockEnvelope；业务 payload/result JSON，chunk string | core 常量行 49；业务题目记录未在本次动态覆盖 |
| B13 | `generative_ui` | BlockEnvelope；结构化意图 payload/result JSON | core 常量行 51；不能从名称推导固定 UI 字段 |
| B14 | `variant_start` | phase=start，**顶层** `messageId,variantId,modelId:string`；无 blockId | `R/events.rs:296–320`；先于该变体所有 block 事件 |
| B15 | `variant_end` | phase=end，**顶层** `variantId:string,status:'success'|'error'|'cancelled',error?:string,usage?:TokenUsage`；无 blockId | `R/events.rs:331–356`；在该变体 block 尾部之后，不是 session 终态 |
| B16 | `tool_approval_request` | start payload 为 ApprovalRequest：`sessionId,toolCallId,toolName,sensitivity,description:string;arguments:JSON;permissionPreset:string;timeoutSeconds:number;runtimeScope?:JSON`；end result `{toolCallId:string,approved:boolean,reason:string|null}`；error 为 `approval_cancelled/approval_channel_closed/approval_timeout` | `R/approval_manager.rs:31–52`、`R/pipeline/hooks.rs:1295–1420`；审批 end 仍用 **request** type |
| B17 | `tool_approval_response` | 已声明的 BlockEnvelope 类型；payload/result JSON | core 常量行 63；上述 hooks 的响应实际不是此 type；不要凭常量添加多余 response 事件 |
| B18 | `plan_gate` | start payload `{sessionId,planId,toolCallId,toolName,summary:string;timeoutSeconds:number;arguments:JSON}`；end `{planId,toolCallId:string,approved:boolean,reason:string|null}`；error `plan_gate_cancelled/plan_gate_channel_closed/plan_gate_timeout` | `R/pipeline/hooks.rs:1463–1574`；blockId=`plan_gate_{toolCallId}` |
| B19 | `tool_limit` | start 无 payload；end `result:JSON`，递归限制含 `recursionDepth,maxRecursion:number`，doom loop 为对应原因记录 | `R/pipeline/tool_loop.rs:551–574,2517–2543`；不是 stream_error，本轮仍可能正常完成 |
| B20 | `skill_injection_audit` | phase=end，**messageId**，无 blockId；`result:{injectedSkillIds:string[],droppedSkillIds:string[],missingSkillIds:string[],estimatedTokens:number,skillStateVersion:number}`，以及顶层 variant/skill/round 元数据 | `R/events.rs:1491–1523`；`R/pipeline/tool_loop.rs:737–748`；首个正文前可出现，不能只断言 text 事件 |
| B21 | `workspace_injection` | start payload `{workspaceId:string,messageCount:number}`；chunk formatted string；end result `{result:{workspace_id:string,message_count:number,senders:string[],message_types:string[],injected_at:string(RFC3339)}}` | `R/pipeline/tool_loop.rs:2613–2619,2674–2702`；内外层大小写不同，禁止统一 camelCase 改写 JSON 内容 |

`SourceInfo` 为 Rust 类型序列化后的检索 JSON（title/url/snippet/score/metadata），不是桥层重新构造的数据。上述保留 `Value` 的工具类型，其全面业务 schema 验收仍归各工具 lane；本次完整 send 被阻塞，**未完成所有业务工具 payload 的动态证明**。

### 2.3 会话级类型（15 条）

除明确标出的直接事件外，均继承 SessionEnvelope 的 sessionId/eventType/timestamp/sequenceId/streamGeneration。

| ID | `eventType` | 本类增加的字段 | 权威位置 |
|---|---|---|---|
| S01 | `stream_start` | `messageId:string,modelId?:string` | `R/events.rs:445–464` |
| S02 | `stream_reconnect` | `messageId:string,retryAttempt:number(u32),retryMax:number(u32)` | `R/events.rs:468–491` |
| S03 | `stream_complete` | `messageId:string,durationMs:number(u64),usage?:TokenUsage` | `R/events.rs:496–549` |
| S04 | `stream_error` | `messageId:string,error:string`；上下文超窗可有 `payload:{code:string,details:JSON}` | `R/events.rs:553–571,1777–1787`；`R/pipeline.rs:1045–1055` |
| S05 | `stream_cancelled` | `messageId:string`，无成功/错误字段 | `R/events.rs:576–594` |
| S06 | `save_complete` | 无额外必填字段，不必有 messageId | `R/events.rs:599–618`；发射器有 helper，不能据此臆造每轮 send 都会发它 |
| S07 | `save_error` | `error:string`，不必有 messageId | `R/events.rs:622–640`；与 stream_error 是不同语义 |
| S08 | `variant_deleted` | 直接事件 `{eventType,messageId:string,variantId:string,remainingCount:number,newActiveVariantId:string|null}`，**Rust 当前不带 sessionId/timestamp/sequenceId** | `R/handlers/variant_handlers.rs:357–368`；非本次生成流 |
| S09 | `summary_updated` | `title:string,description:string` | `R/events.rs:754–772`；可在 stream_complete 后异步发生 |
| S10 | `compaction_started` | `payload:{reason:string}` | `R/events.rs:644–648` |
| S11 | `compaction_finished` | 无 payload | `R/events.rs:651–655`；清理进度，不等同压缩成功 |
| S12 | `compaction_failed` | `payload:{reason:string}`，非顶层 error | `R/events.rs:662–680` |
| S13 | `compaction_completed` | `payload:{tokensBefore:number|null,tokensAfter:number|null}`，两个键都保留 | `R/events.rs:689–715` |
| S14 | `context_trimmed` | `payload:{droppedMessages:number,estimatedDroppedTokens?:number}` | `R/events.rs:723–750` |
| S15 | `goal_updated` | 直接事件 `{eventType,sessionId:string,goal:GoalRecord|null}`；无强制 timestamp/sequence | `R/events.rs:44–52`；GoalRecord 自身 camelCase |

S08 的 Rust payload 与前端 `isSessionEventForSession` 严格要求 sessionId 存在有既有矛盾（`F/adapters/tauri/sessionEventHandler.ts:55–58`）。这是 **Rust 已存在的消费契约风险，未当作新增 TS/Rust 差异计数**；不应通过修改 X5 样例默默替 Rust 补字段。

## 3. 发射顺序与终止语义

### 普通发送 / 思维链

```text
session stream_start
  [检索/审计/工作区等可选事件]
  thinking start → chunk* → end
  content  start → chunk* → end(result.content=本段完整正文)
  [reasoning/content 可多次交替，每次分配新 blockId]
  [save_results 成功]
session stream_complete(usage?,durationMs)
  [异步 summary_updated / goal_updated 等；terminal 不等于禁止所有后续业务事件]
```

权威：`R/pipeline.rs:838,866–883,906–941`；`R/pipeline/llm_adapter.rs:334–509`。文本不一定有 thinking，空回答也不能臆造 chunk。工具、审计、多变体交错不是固定全局单线程 block 顺序，只能断言各生命周期的偏序。

### 工具往返

`on_tool_call_start → tool_call_preparing:start → args delta chunk* → 完整 call 收集 → 准入/审批 → tool_call:start → progress chunk* → tool_call:end/error → 工具结果写入后续 LLM 上下文 → 下一轮文本/工具 → session terminal`。

preparing 不是独立的必定 start/end 成对业务块：前端按 toolCallId 合并/复用，builtin 检索类会抑制 preparing。参数 chunk 不是单个可解析的完整 JSON。工具执行失败可以被反馈给 LLM，不必升级为 session stream_error。生产工具循环和第二轮在本分支未可达，不能用手发 tool:end 冒充往返成功。

### 错误

- 流出正文后失败：`content:error`，当前 thinking 通过 end 收尾；随后外层尝试保存已累积内容，发**一个** stream_error。不追加 stream_complete。上下文超窗使用 `payload.code='CONTEXT_WINDOW_EXCEEDED'`。
- 无任何输出且错误可重试：先 `stream_reconnect(retryAttempt,retryMax)`，可取消退避；注销 owner hooks、reset、重新注册同一请求 hooks。**一旦已有 content 或 reasoning，禁止自动重试/failover 拼接两次生成。**
- 多变体落库失败：即使已有 variant_end(success)，session 只发 stream_error，不再补 success（`R/pipeline/multi_variant.rs:614–639`）。

权威：`R/pipeline/llm_adapter.rs:954–978`、`R/pipeline/tool_loop.rs:1293–1370,1745–1760`、`R/pipeline.rs:997–1055`。

### 用户取消

- 取消优先于连接异常，错误不可伪装成 stream_error（`tool_loop.rs:1657–1666,1717–1742`）。保留部分正文/思维链，丢弃未执行工具调用，尝试保存，再 stream_cancelled（`pipeline.rs:946–995`）。
- 内部流取消/外部异常分支会 `adapter.finalize_all()`，可发无权威 result 的 block end；外层 `tokio::select!` 直接取消则可能跳过此 finalize（`pipeline.rs:1143–1149`）。**不能要求每个取消都把所有 open block 发 end。** 前端 completeStream/abort 清理承担未闭合块收尾。
- 审批/plan gate 等待中取消分别先发块 error `approval_cancelled` / `plan_gate_cancelled`，退出等待，随后外层取消终态。
- emitter 的 session 事件会先 flush 批量 chunk，因此尾部已排入 batch 的文本不可落在 terminal 后。

### 重试 / 变体

- 同 messageId 立即重试必须用新的 streamGeneration。旧代次的 complete/error/cancelled 均不得终止新流；前端也检查 message 目标和 timestamp。bridge 测试验证了旧 cancelled(11) 不结束新 start(12)。
- 变体：session start → variant_start → 该 variant 所有 block（每条顶层 variantId:string）→ variant_end(status/usage)；多个变体可交错；最后持久化后 session complete 汇总 usage。variant_end(error/cancelled) 不等同 session terminal。
- Rust `R/variant_context.rs:660–738` 会立即经 emitter 发事件并自动附 variantId；目前 TS VariantStreamContext 只记录 events，见差异 X5-03。

### batching / bridge / 前端

- Rust `R/events.rs:1023–1050,1250–1487` 的文本批量语义：100ms 窗口、4096 UTF-8 字节阈值，content/thinking 可合并；非文本结构化 chunk 不应合并。sequence 在实际 dispatch 时分配；遇 start/end/error/session flush pending。测试精确断言两个固定 token 合并为一个中文 chunk，并在 end/terminal 前发出。
- Electron main `electron/main.ts:222–235` 以 JSON.stringify 序列化 Host payload 后 `runtime.emitTo`。Shell registry 按 target 扇出、preload JSON.parse 后为 listener 包装 `{event,id,payload}`；TauriAdapter 取 **event.payload** 而不是将 wrapper 当业务 payload。
- 前端 success 有 32ms 静默窗口，先 drain backend sequence buffer，再 flush chunkBuffer，才 completeStream('success')；error/cancel 取消 pending success；见 `F/adapters/tauri/sessionEventHandler.ts:333–461` 和 `streamLifecycle.ts:9–10,127–157`。bridge 测试及现有 streamComplete 测试均验证消费规则。

## 4. 不一致与最小复现（按归属 lane）

### X5-01 / L04-chat-session：真实 send 与重试命令未注册（阻塞）

- `host/plugins/chat/index.ts:38–72` 没有 `chat_v2_send_message/chat_v2_retry_message/chat_v2_retry_variant/chat_v2_retry_variants`。
- Rust 入口：`R/handlers/send_message.rs:461`；现行前端调用：`src/features/chat/adapters/tauri/sendOperations.ts:186,571`。
- 最小复现：运行 `reachability.test.ts`；真实 `host.invoke('chat_v2_send_message',{request:{sessionId:'sess_x5',content:'固定问题',userMessageId:'msg_user_x5',assistantMessageId:'msg_assistant_x5',options:{}}})` 拒绝，文案含 `Command not found`；`fake.created=[]`、全部 `host.events=[]`。三个 retry 入口同样失败。
- 影响：普通、思维链、工具、error、cancel、retry、variant **全部完整 E2E 阻塞**。不是假 LLM 输出不匹配，更不是网络失败。

### X5-02 / L02-llm-manager：首轮 chat 流式生成和 hooks 公开面缺失（hooks 后续部分解除，见续记）

- `host/plugins/llm/api.ts:42–66` 仅配置/选择/取消；`src/service.ts:28` 的实际服务同样没有 `registerStreamHooks/unregisterStreamHooksIfOwner/callUnifiedModel2Stream`。
- Rust：`R/pipeline/tool_loop.rs:1364–1374` 实际依赖 hooks/stream；公开 llmAdapters 只有 `createAdapter(kind)`（`host/plugins/llm-providers/api.ts:170–174`）。
- 最小复现：真实安装后检查上述三个服务方法为 undefined，取消注册方法存在。`reachability.test.ts` 有运行断言。
- 影响：即使 L04 注册 send，也不能仅靠换 llmAdapters 驱动真实 chat 请求；X5 不把 essay transport、私有 completion 或测试驱动器当 chat 生成替代品。

### X5-03 / L03-chat-pipeline：执行/变体发射未接线（阻塞；L04 registry 后续局部进展见续记）

- `host/plugins/chat-pipeline/index.ts:134–345` 主要暴露辅助方法、createStreamingAdapter/createVariantStreamingAdapter；真实 `chatPipeline.execute` 不存在。
- `host/plugins/chat-pipeline/src/variant-adapter.ts:57–69,177–195` 的 VariantStreamContext 只 append 到内存 `events`，没有 Host emitter。`api.ts:182–185` 仅 type 导出 context，没有公开 context/emitter 绑定工厂。
- Rust：`R/pipeline.rs:866–869` 的 execute_internal/tool-loop、`R/variant_context.rs:660–738` 的即时携带 variantId 发射。
- 最小复现：`reachability.test.ts` 检查 execute 不存在；只调用 createVariantStreamingAdapter 不能经现有公开面构造一条生产 Host 事件路径。`components.test.ts` 的 variant 用例因此只验证真实 emitter 的字段/顺序，**未将本地 events 回放器当生产实现**。
- 工具准入、执行 registry、工具结果转下轮、部分结果保存/重放等缺口也归这一完整执行接线；关联 L04/L05 服务提供面。没有用 fake tool executor 制造通过记录。

### X5-04 / L03 + L04：两个公开 sink 接口不能直接连接（接线缺口）

- L03 `host/plugins/chat-pipeline/src/llm-adapter.ts:43–50,418–438`：emitStart 等末参是 meta 对象；需要 `emitToolCallPreparingStart`。
- L04 `host/plugins/chat/src/events.ts:780–807,963–1039`：普通 emitStart 末参是 `variantId:string`，preparing 方法叫 `emitToolCallPreparing[WithMeta]`。
- 最小复现：`components.test.ts` 中 `reproduces the unbound L03/L04 public sink mismatch`：显式越过类型系统直接传真实 emitter，`onContentChunk` 产生 **variantId 对象** `{skillStateVersion:3,roundId:'round_x5'}`，顶层元数据丢失；`onToolCallStart` 抛 `emitToolCallPreparingStart is not a function`。
- 不是宣称已有生产代码在这样强转，而是证明**不能将这两个接口直接当已完成接线**。本次局部事件测试的 `bindSink` 明确在测试目录，负责调用 L04 WithMeta 方法；它不是生产修复，且已单独记录绕过的缺口。

### X5-05 / L03：重试后空闲计时使用错误时钟（已复现 parity 缺陷）

- TS：`host/plugins/chat-pipeline/src/llm-adapter.ts:160–168,239–261`，构造和 touchActivity 使用 `elapsed()/performance.now()`；resetStreamState 却 `lastActivityAt=this.now()`（Date.now epoch）。后续 `idleElapsedMs` 为 `max(0,performance.now()-Date.now())`，无 token 时一直返回 0。
- Rust：`R/pipeline/llm_adapter.rs:296–307,721–722`，reset 走 touch_activity，重设 `Instant::now()`。
- 最小复现：同名 `KNOWN L03` 用例注入 wall=1_800_000_000_000、monotonic=100，reset 后 monotonic 增至 151；Rust 契约应得到 **51ms**，TS 为 **0**。
- 影响：可达的“无输出网络失败→自动重试→服务端无 token”场景，空闲超时收尾可能被延迟至其他绝对超时；不是修改总 timeout 策略的理由。
- 处置：按要求不改管线。测试 `it.fails` 保留正确契约，记录当前预期失败；修复后会 unexpected-pass，使维护者必须移除 `.fails`，不能长期掩盖。

## 5. 已验证一致 / 不应误报的差异

- 36 个事件名、4 phases 与 Rust 常量逐个一致；所测普通/思考/工具准备/terminal/usage 的 Host JSON 字段及中文内容正确。
- 原始 block/session 各自 0 起递增是**正确**的，不应合并序号校验；文本 token 经 batch 合并也是正确的，不要求假 LLM 的 token 数等于桥后的事件数。
- payload 内 toolCallId:null、output:null 保持显式 null；缺失可选顶层字段在实际 JSON 中省略。未做全量 `Some(Value::Null)` 与 None 的通用 codec 证明。
- variant lifecycle 的 variantId/status/usage 在**顶层**；emitter 局部验证通过，不能因此判定未接线的变体 pipeline 通过。
- 官方 listen → Electron plugin:event → preload → TauriAdapter 未发现名称/JSON shape/投递顺序差异。对下游 eventBridge 的断言是调用边界，不是 UI 状态正确性的替身证明。
- Demo 的 session 没有 sequenceId/streamGeneration；每轮 block 从 0 重新计数，content end 不一定有权威 result，abortScript 本身不发 cancelled（mock cancel 另发）。这些是 `scriptPlayer.ts:14,103,168,191` 可见的演示简化，**不能反向修改生产规格迁就 demo**。

## 6. 执行记录 / 覆盖状态

### 恢复检查（协调者要求）

执行 `git log --oneline -20`、`git status`：HEAD=`f23c98702`，本分支无已有 X5 提交；仅本次 `host/e2e/` 未跟踪新增文件，未重复改已有实现。

X5 原本无 TESTMAP，已新增 `host/e2e/streaming/TESTMAP.md` 区分真实层级。只读核对原 lane TESTMAP：L03 451 行（367 ported / 84 pending）；L04 527 行（173 ported / 354 pending），不改其迁移统计。

`npm run migration:ledger -- --check --no-write`：exit **1**，原始摘要：

```text
ledger: commands 1058 (A 88.8% B 1.8% C 0%), tests 8036 (A 70.3% B 0.4%);
problems: commands 0, tests 250, orphan registrations 0;
checkCoverage（host/kernel/coverage.ts）
```

这是本基线的全仓 ledger 结果，未写 ledger，没有把 X5 新增观测测试冒算原 Rust ported 行，也未修越界的既有问题。

### 本次亲自运行

```sh
npx vitest run -c vitest.host.config.ts host/e2e/streaming --maxWorkers=1
# 2 files passed; 23 tests passed; 16.59s
# includes 1 it.fails (KNOWN L03 monotonic-reset parity defect)

npx vitest run -c host/e2e/streaming/vitest.frontend.config.ts
# 2 files passed; 6 tests passed; 13.08s

npx vitest run -c vitest.config.ts \
  src/features/chat/adapters/__tests__/TauriAdapter.streamComplete.test.ts \
  src/features/chat/adapters/__tests__/TauriAdapter.streamReconnect.test.ts \
  src/features/chat/adapters/__tests__/TauriAdapter.errorChannel.test.ts --maxWorkers=1
# 3 files passed; 21 tests passed; 9.62s
```

WASI experimental 与 Browserslist 过期提示未影响这些测试。运行 `npx tsc -p tsconfig.host.json --pretty false`，exit **2**；修正本次测试 logger 的 target 类型后，最终仅剩基线 `scripts/electron-migration/accounts.test.ts:2:68` 对 `./lib/accounts.mjs` 缺声明（TS7016）。**X5 Host 文件无剩余诊断**，但不把全仓类型检查记为通过。原始输出在运行环境 `/tmp/opencode/x5-host-types.log`。

| 请求场景 | 局部证据 | 完整 send → fake LLM → tool loop → bridge → frontend |
|---|---|---|
| 普通回答 | 精确 content JSON/batch/顺序；bridge 成功收尾 | **阻塞 X5-01/02/03** |
| 思维链 | 真 adapter 四段交替、权威正文 end；demo 对照 | **阻塞** |
| 工具往返 | 真 preparing+args+收集、独立工具 JSON 保真 | **阻塞，未执行工具/第二轮** |
| 出错 | adapter block:error + session error；bridge 不转成功 | **阻塞，未证明真实失败持久化** |
| 用户取消 | 真实 L02 AbortSignal；emitter flush；bridge cancelled | **阻塞，未证明取消命令传播/保存** |
| 重试 | reconnect/reset；bridge 旧 generation 拒绝；1 个计时 xfail | **阻塞** |
| 变体 | emitter bracket/顶层 variantId/usage | **阻塞，内存事件未生产发射** |

最终验收必须待责任 lane 补完真实入口/流式调用/执行器与变体 sink，再让本目录假 LLM 脚本**实际被消费**，捕获整次发送的全部 Host 事件（包含审计/诊断/工具），按以上规格逐项断言。当前没有这个证据，不给“完全一致”结论。
