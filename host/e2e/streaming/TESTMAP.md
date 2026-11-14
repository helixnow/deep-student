# X5 streaming 测试地图

这是跨 lane 审计新增测试，不迁移或改标 L03/L04 的 Rust TESTMAP 行。

## WP-089：固定 HTTPS 接缝（无 Rust 映射变更）

`fixed-https/service.test.ts` 验证本地 CONNECT/TLS 基础设施：两实例运行 F1 公开 IlinkClient 默认构造器（无 fetch 替换）、原 Host/SNI/path/method/body；任意 entity 字节；无 CA/错域证书拒绝；其他固定域 CONNECT 与未知路由明确失败；子进程退出/信号及端口/私钥释放。这是传输与夹具验收，不将外部模拟响应当 A 答案，不标任何生产 Rust 测试 ported。pending 前后均无本 lane 映射行（0→0）；F1/L07 地图不改。D38 因 A 缺构建/信任实证保持 open。

## WP-096：记录器精度回归（无 Rust 映射变更）

`wave0/recorder.test.ts` 经真实 StreamRecorder→finish→candidateRules 覆盖 993/992、i64/u64 边界、正负大指数/下溢/精确小数/-0、同输入复录、保存重载、null/缺省/事件与数组顺序/数量/晚事件；另经真实 kernel register/dispatch/BackendEventService、hostDriver、runScenario 验证 args→return→结果占位符→error/事件全链。测试插件仅提供数值输入，不代替 kernel/记录器/比较器。候选应用后仍保留数值差异、raw 原件不变；A 缺 raw 和旧录件均不允许报 identical。没有新增/修改 ported 条目，pending 前后不变。

## 最新：cancel-after-partial 保红，待 L03 核定取消 Drop 分支

固定测试提交 `eaab4d13a` / main `f2d5b6c46`。只新增 `cancel-after-partial.test.ts`，定向 **`20261105015318-089cba` exit1 / 1failed**，不是超时。命令 `npx vitest run -c vitest.host.config.ts host/e2e/streaming/cancel-after-partial.test.ts --maxWorkers=1`。完整原值 `/tmp/opencode/x5-cancel-CmPIhY/trace.json`，覆盖全部事件、终态回调 DB、fake 消费、连接关闭、日志与 active/tasks。

- （D4 起改走 llm-replay）真实 OpenAI adapter + 挂载的 llm-replay 内置脚本 `interrupt.hold-after-partial`：只写一帧 `取消前内容` 并保持 open；等待生产 content:chunk 确认消费后才公开 `chat_v2_cancel_stream`，回放端从未结束响应。回放日志唯一一条 POST，取消前 framesWritten=1、end=null、openCount=1，取消后 end=`client-closed`、openCount=0；请求到达时用户消息已保存，审计 requestBody 与回放收到的请求体一致；日志含实际 AbortError。不是自然 EOF/坏帧/测试发终态。
- 失败前已确认：唯一 session stream_cancelled/gen1、终态回调真实用户/助手部分文本可读，块按 Rust context.rs:790–817 保 success、无error，trackedTaskCount=0、active=false。后续 pending-cancel/log 断言位于失败点之后，不能计已通过。
- 保留 **9条 Rust外层取消 Drop 预期 vs 10条实测** 的红断言：content:chunk 后、session terminal 前，新增 `${streamEvent}_cancelled`，payload reason=user_cancelled。没有 content:end 或第二个 session terminal。Rust pipeline.rs:1143–1148 的取消分支 drop execute_with_tools，tool_loop.rs:1163–1174 明确说明显式后续代码不再执行；TS execute.ts:309–317 Promise.race 不终止 loser，tool-loop.ts:415–442 将 signal 转给 L02，model2_transport.ts:180–199 继续发 raw cancelled。原日志在 session/handler取消后还出现 LLM call succeeded(cancelled=true)/usage计算，需 owner 裁定该跨层轨迹是否偏离 Rust；**未声称已观察到 late content:end**。
- 已通过 coord.mjs 投递 L03 牵头及 C1，请核语义/给依据或修复；不改生产、不删 raw event、不将表改为10来迁就当前实现、不标 fails/skip。不签该 cancel 场景，完整 parity 继续不通过，提交报告后仅 §5 收尾，不扩 retry/变体。

普通/thinking/EOF-error 限定门槛按 C1 已亲核的新 official `1d788c4a1` / main `f2d5b6c46` 保持：tests `20261105012734-ffc959` exit0/5文件26pass，type/boundaries/strict 同批code0。旧 `77c0326be` 的 exit1/Errors3 与诊断小集保历史，不据新绿宣称 CPU/RPC 根因已解。

## 最新：error-after-partial 的 missing-terminal EOF 分支定向通过

**§5 未通过，不能标本轮正式完成。** 固定 `77c0326be` / main `a9683a43b` 的官方 tests 作业 `20261105004831-04d655` exit1：3 files failed / 2 passed，15 passed / 2 failed / 9 skipped，另有 **Errors 3**（worker `onTaskUpdate` timeout）。失败为 components beforeAll60s、thinking/error 各 test60s。旧单场景绿不覆盖该结果；负载与默认并发只能是排查线索，尚不能据此认定 CPU 原因。

收敛诊断只给 error-after-partial 与它调用的 `__fixtures__/host.ts` 加阶段观测，保留所有60s/15s预算与业务断言：区分 locations/schema定义/三库迁移/secrets/paths/插件装配/模型配置/send准入/真实HTTP/终态/drain/清理。阶段 JSONL 写独立 `/tmp/opencode/x5-error-stages-*/stages.jsonl`，不依赖 Vitest RPC；不同测试仍各用独立 DB，不引入模板或共享可写状态。设备ID输出实际在 `platform/paths/index.ts:214`，不是 schema 完成探针，且 stdout 本身经RPC，原日志不足以细分阶段。

### 固定 revision `c6d58ce8f` 的最小阶段区分结果（不覆盖原 official）

| 作业 / 原退出 | 必要范围 | 诊断结果 |
|---|---|---|
| `20261105011125-f717a1` / exit0，1passed | 仅 error-after-partial 文件，默认 worker，不加预算 | pid3500224：三库迁移3.39s、插件0.98s、send准入0.41s、drain0.88s，总6.03s |
| `20261105011341-23b4da` / exit0，3passed/10标题过滤 | 仅原失败的 components/thinking/error 三文件，各选一条相关用例，默认并行 | error pid3509218：三库迁移3.87s、插件1.00s、send准入0.49s、drain0.98s，总6.61s；另两用例分别约4.99s/6.50s |

原始阶段文件：`/tmp/opencode/x5-error-stages-CWB8z7/stages.jsonl`（单文件）、`/tmp/opencode/x5-error-stages-HkQVwI/stages.jsonl`（三文件组）。每种schema迁移各一次，之后装配/HTTP/唯一失败终态/清理均到达，未见共享脏库或重复初始化。两次均没有超时/RPC错误，但只说明**当前最小诊断未复现**；原五文件 official 无阶段文件，仍不能追溯确定它卡在 schema、装配、流等待或报告RPC，也不能由负载/并发直接判CPU。保留 `004831-04d655` 原 exit1/Errors3，自检仍未签通过，交 C1 关联共享 RPC 证据；未再次跑整矩阵。

基线 main `a9683a43b`，正常 merge=`1c392486c`。只新增 `error-after-partial.test.ts`：作业 **`20261105004415-2455a3` exit 0，1 passed**，命令 `npx vitest run -c vitest.host.config.ts host/e2e/streaming/error-after-partial.test.ts --maxWorkers=1`。未额外手动重跑普通回答/thinking/六局部，不扩其他场景。

- （D4 起改走 llm-replay）真正失败来源为挂载的 llm-replay 内置脚本 `error.eof-after-partial` 返回一帧可解析正文后正常 EOF，**没有 finish/Done 完成标记**；真实 OpenAI adapter 要求显式完成。回放日志唯一一条 POST，framesWritten=1、end=`eof`，连同块错误原文，证明真实读流进入 EOF finalization，不是额外坏帧或测试 parse throw。唯一 POST/body（审计 requestBody 与回放收到的一致）、请求到达时用户消息已保存均断言。
- Rust `model2_pipeline.rs:543–579,7188–7213` 对应 missing-terminal 的 AppError::llm；块错误精确为 `LLM provider 回复流提前结束，未收到完整结束标记；已保留已生成内容，可重试`；session terminal 精确为 ChatV2Error::Llm Display（前缀 `LLM error: `）。公开 send 只返回任务准入 ID，异步 pipeline 拥有失败，测试不把 IPC 返回 ID 当成功。
- terminal 的只读回调读取真实 DB：用户消息/正文及助手部分文本 `部分回答` 已保存，后读一致，无重复消息。Rust `context.rs:790–817` 的 collected text 持久化状态仍为 success、error=None；这是失败回合保留部分内容的政策，不应改成块 status=error。没有 Usage 帧，DB usage=0/source=tiktoken，失败终态不附 usage；没有虚构 token。
- 全部 JSON 事件严格匹配 **10 条**：request audit→stream_start→skill audit→request-body→scoped start/id→content:start→content:chunk→content:error→stream_error。flush 先于块 error，部分保存先于唯一失败终态；无 content:end/success terminal/cancel/reconnect。块 seq0..3（含 skill audit），session seq0..1、generation=1。
- 真实 session stream 已释放、tracked tasks=0、公共 pending-cancel 消费为false；日志精确证明有输出后抑制重试及 Llm 错误映射。hooks guard 由生产代码执行，但公开服务没有只读 hook 查询，本用例不额外声称动态测得 registry 内部为空。

这是正常 EOF 缺完成标记的 error-after-partial 分支；不冒充 socket read-error/用户取消/自动 retry/工具或变体覆盖。完整 parity 仍不通过；提交后执行 §5。

## 已复核：thinking 主链限定场景

基线 main `e9df01a3c`，正常 merge=`38f927675`；普通回答 `3fbb56cc0` 已由 C1 签限定门槛，本轮不手动重跑旧 24 条/六局部。新增 `thinking.test.ts` 走同一真实 diagnostics/send→L03/L02→HTTP/SSE→生产 sink/DB/终态；只在外部 adapter 的 thinking 脚本追加 usage（9 input / 6 completion / reasoning2）。

最终定向作业 **`20261105001757-5863a6` exit 0，1 passed**，命令 `npx vitest run -c vitest.host.config.ts host/e2e/streaming/thinking.test.ts --maxWorkers=1`。日志 `/home/dsdev/.oc-jobs/done/20261105001757-5863a6.log`。只新增 thinking 的成功主链证据，不是完整 parity。

- （D4 起改走 llm-replay）真实 OpenAI adapter + 挂载的 llm-replay 内置脚本 `success.thinking`：回放日志唯一一条 POST，framesWritten=4、end=`done`；回放收到的请求体与审计 requestBody 一致，用户消息已在请求到达前保存。
- 唯一 terminal 的只读 listenWindow 回调中，真实 DB 必须已存在 thinking=`先分析`、content=`再回答` 两个独立 block，按原 block ID/顺序保留，状态 success、起止时间合法，思考先结束再开正文。
- 完整序列严格匹配 **15 条**：request audit→stream_start→skill audit→request-body→scoped start/id→thinking start/chunk/end→content start→scoped usage→content chunk/end→scoped reasoning 汇总→stream_complete。块通道 seq=0..6（含 skill audit）、session seq=0..1、generation=1，未过滤任何事件。
- Rust `llm_adapter.rs:372–432,1272–1318`：thinking end 不带 result，正文 end 带权威内容；`llm_adapter.rs:63–84`/`types.rs:234–275`：reasoningTokens=2 是 completion 的子计数，total=15 不应变成17，累加 source=mixed。
- 首跑 `20261105000718-50a066` **exit 1 / 1 failed**：消费/落库断言已过，完整事件断言报 15 实际 vs14预期。不是可忽略的多余事件：Rust `model2_pipeline.rs:7395–7412` 与 TS `model2_stream_events.ts:122–124` 明确在 hooks 结束后仍发 reasoning 汇总，现已补全其精确 content/is_complete/chunk_id 及位置。

第二次 `20261105001033-ff97b2` **exit 1 / 1 failed**：完整15条顺序已过，thinking:end 的键缺省断言误用 Host 内存表示。`chat/src/events.ts:167` 明确产出自有属性 `result: undefined`，`kernel/json.ts:65` 明确 main JSON.stringify 才省略它；Rust events.rs:105–106 是 Option None 跳过。现先精确断言 raw result=undefined（不接受null），再将**全数组** JSON 序列化后检查该键缺省，并断言事件数量不变；没有条件过滤事件或字段。

只推进 thinking；工具 chatToolRuntime 未决、错误/取消部分保存、retry generation、变体与 GUI 仍独立未通过。

中断恢复按要求经 jobs 运行 ledger `20261105000424-0819c1`：**exit 0**，commands1058 / tests8109，problems commands0/tests0/orphan0；prod-reachable unreachable16（unknown3633, not vetoed）。这是全仓账本一致性，不是 thinking 或 parity 通过证据；未手动重复运行旧24/六局部。

## 已签限定门槛：首条真实 Host 普通回答通过（不是完整 parity）

基线 main `0d8591e00`（正常 merge `a4639ff0d`）。`normal-answer.test.ts` 经 **`20261104234958-48890f` exit 0，1 passed**：

- `streamingHost('answer', { diagnostics: true, providerUrl })` 装载真实 `dstu.platform.diagnostics`，实际 provide/shutdown backgroundTasks；原默认无 diagnostics 小宿主保持不变。
- 公开 L02 模型设置 + 真实会话，公开 `chat_v2_send_message`→L03 execute→L02 unified stream→真实 OpenAI adapter→挂载的 llm-replay（D4 起；内置脚本 `success.answer`）。回放日志唯一一条 POST，framesWritten=4、end=`done`；回放收到的请求体与审计 requestBody 一致，用户消息在请求到达回放时已保存。
- terminal 的只读 `listenWindow` 回调立即查询真实 chatSession；唯一 stream_complete 时用户、助手及 `content=固定回答` 已存在，usage=7/3/10。未手动调用保存、绑定 sink 或补终态。
- **不筛事件**：严格核对全部 11 条，顺序为 request audit→stream_start→skill audit→request-body→scoped start→scoped id→content:start→scoped usage→content:chunk→content:end→stream_complete；内容 block ID 与 DB 对应，两通道 sequenceId 及 generation=1 均核对。

命令：`npx vitest run -c vitest.host.config.ts host/e2e/streaming/normal-answer.test.ts --maxWorkers=1`。首跑 `20261104234635-f9948e` exit 1 是测试误把无返回值的 listen 当注销函数；改为公开 listenWindow 后，`20261104234809-167b44` exit 1 抓住原七条事件预期遗漏的四类生产事件，已按实际生产与 Rust 发射点补齐完整断言，未过滤事件求通过。**两个失败保历史，不计通过**。

只签首条普通回答；其他脚本、真实工具第二轮（chatToolRuntime 仍缺）、错误/取消部分保存、retry generation、多变体、真实 Electron 窗口链均未签。完整 parity 继续不通过。

提交 `6ae973766` 后 §5 自检只有 typecheck exit 2：固定脚本 `scripts.answer[0]` 的 TS2532。修订为显式非空索引（answer 固定定义有首轮），不改任何运行时断言；重新提交后再自检，未将该次自检记为通过。

## 最新：fulltest `650ddffbe` 的批量重试 main-red（复核基线 `f821b3733`）

根因是 X5 旧测试未跟进接口：三种 retry 共用单 `variantId`，但公开契约 `contracts/ipc/generated/L04-chat-session.ts:1455–1463` 要求批量重试用 `variantIds: string[]`。main 已真实注册该入口，原断言收到的是 `invalid args variantIds`，不是 command missing。已用 `coord.mjs escalate` 上报（回执 `2026-11-04T233337170Z-X5-stream-parity.md`），不请求回退合法的新接口。

整改：按生成 Args 类型分开三种重试；批量给两个合法 variant ID，明确检查 `ctx.commands.has`，精确匹配 `MESSAGE_NOT_FOUND` JSON 字符串；真实 chatSession 查询消息/块、数据库统计前后不变；fake.created/requests/parsed、Host 全部 events 均为空，且无 active stream。这仅证明参数解码后进入真实 handler 的消息 guard，**不是重试成功、不是生产 sink 的成功轨迹**。

原七个脚本只保留“本夹具缺 backgroundTasks 导致 send 未绑定”的负向证据：额外核对注册表 false，并将宽松 `/not found/i` 收紧为完整 command-not-found 字符串，未改成任意拒绝即过。三个已注册 retry 则与它们分开；不能因业务错误包含 `not found` 就继续声称未注册。

main `f821b3733` 的 L04 已提供事务仓储与 send/retry 注册，L03 多变体也有实现；旧“注册全缺/事务面缺失”矩阵作废。下一步是 X5 为首条普通回答安装真实 diagnostics/backgroundTasks、配置模型和离线 transport，而不是改生产 pipeline 或补测试仓储。完整 parity 仍不通过。本次不声明 `f821b3733` 全仓 fulltest 结果。

最小回归作业 `20261104233543-76712a` **exit 0，3 passed / 9 filtered skipped**，只选 `registered but stops|chat_v2_retry_variants accepts`。修订首跑 `20261104233501-9738d0` exit 1 是本轮 Args `satisfies` 换行语法问题（尚未收集测试），已纠正；不是业务链失败或成功证据。

## 最新：main `7f4fb688b` 发布真实单变体 execute，修正过时缺口断言

merge=`a9413c1c5`。L03 `6cb7aad13/e014fffbb/a27a04e7b` 已进入 main：`index.ts:212–220` 发布 `execute/executeWithEmitter/executeWithExistingUser`，`src/execute.ts`、`tool-loop.ts`、`tool-round.ts`、`compaction-run.ts` 为实际生产编排，不再只是接口或预备文本工厂。

旧断言 `execute === undefined` 触发本次集成失败；原样定向复现作业 `20261104172917-e99a8d` **exit 1**，精确报 `expected [AsyncFunction execute] to be undefined`。修改为三个公开执行方法均为 function，保留 hooks/unified-stream 与 `fake.created` 断言，无豁免、无 `.fails`。

剩余：L04 仍无四个 send/retry 注册，且 `chatSession` 未发布 execute 所需的事务 owner 面。`execution-runtime.ts:39–52` 列 17 个必需 owner 方法并在缺失时拒绝。不得测试补仓储方法或手动 save/emit 来造普通回答通过；第一条真实 send 仍不能运行，完整 parity 不通过。以下旧基线缺 execute 的描述仅保历史。

协调者要求的三项复验均经 jobs 取到真实退出码：`20261104173123-e79ea8` typecheck:host **exit 0**；`20261104173123-34ba58` migration:boundaries **exit 0**（2755 文件，0 violation）；`20261104173123-31fdd8` host vitest 本目录 **exit 0，23 passed**。23 条只是本次门禁整改复验，不新增主链证据。

## 最新：main `677f6727c` 的 VFS 宿主依赖修复

merge=`23a47af33`。自检 tests 作业 `20261104161456-919d77` 在装载时退出 1：`dstu.vfs` 新增必需注入 `notes`、`vfsIndex`，两套测试共用的 X5 宿主未安装它们。只在本 lane `__fixtures__/host.ts` 补装真实 `dstu.notes`、`dstu.vfs-index`，不提供空对象或替代服务；`reachability.test.ts` 装载断言同时要求插件 ID 与服务存在。

定向回归作业 `20261104161902-1b782a`：只选 `loads the real chat/pipeline/LLM and dependency plugins`，**退出码 0，1 passed / 11 filtered skipped**。这只证明依赖装载修复，不是新的主链场景，不关闭 X5-01/02/03 或完整 parity。

## 最新：main `1e893eb61` 的 L03 消费接线（静态复核）

正常 merge=`61c8b64cb`。`e3e715e00` 已进入该基线：

- `chat-pipeline/index.ts:201–204` 发布 `createUnifiedTextStream`，`src/unified-text-stream.ts:58–69` 实际调用 L02 `llmModel2Streaming.callUnifiedModel2Stream`。因此“L02 方法无任何 L03 调用方”不再成立；仍未证明 send→execute 闭环。
- `index.ts:194–199` 发布最终保存工厂与预备文本轮；`src/text-execution.ts:80–122` 有即时用户保存、最终/错误/取消部分保存及终态编排。这是显式无工具预备阶段，不是完整 execute；依赖仍须调用者组装，不能由测试拼装后当作真实 send 成功。
- `api.ts:245–269` 的 `ChatPipelineExecution` 是目标接口；已安装的 `ChatPipelineService` 尚无 execute，chat 插件也仍无四个 send/retry 注册。X5-01 与完整 X5-03 继续阻塞，完整 parity 不通过。本轮不运行普通回答或旧六条。

## 历史：main `45c3250b0` 合入后的夹具与 X5-02 状态

- main 上 L02 `44e7e8a76` 让 `dstu.llm` 新增必需注入 `injectionBudget`、`llmCodexAuth`，导致本 lane 夹具装载失败（lane-gate tests exit 1）。`__fixtures__/host.ts` 改为：`injectionBudget` 用 F3 真实纯函数（与 storage 插件发布的三项相同）；`llmCodexAuth` 为“已登出且拒绝任何请求”的替身。原因是真实 L01 插件同时提供 `llmAdapters`，与假 adapter 重复提供会被拒；X5 场景不选择 openai_codex。
- 同一 main 已有 `llmModel2Streaming.callUnifiedModel2Stream/WithConfig`（`api.ts:224–228`、`index.ts:108`，`44e7e8a76`）。`reachability.test.ts` 改为断言该提供方存在、`chatPipeline.execute` 仍缺、`fake.created` 仍为空。**X5-02 提供方已在 main，消费方闭环未证明**；C1 所指后继 `ccd8c907f` 不在 main，不据它下结论。
- X5-01（L04 send/retry 注册）与 X5-03（L03 execute/tool-loop/持久化）仍缺。完整 parity 不通过。

## 集成门禁修复（boundaries test-double 21 条）

merge main=`1251b2b6a`（main `081b3426d`）。21 条 `test-double` 全部来自 `bridge.spec.mts`/`demo.spec.mts`：边界规则 `isTestFile` 只识别 `*.test.*`、`__tests__/`、`__fixtures__/`，不识别 `.spec.mts`。两文件原样移入既有允许目录 `__tests__/`，只改相对 import/`vi.mock` 路径与 `vitest.frontend.config.ts` 的 include；未删断言、未改拼写、未加 boundary-allow。

| 作业 | 命令 | 退出码 |
|---|---|---|
| `20261104105315-1892a1` | `npm run typecheck:host` | 0 |
| `20261104105315-657032` | `npm run migration:boundaries`（全量 2344 文件，0 violation） | 0 |
| `20261104105315-f1296c` | `npm run migration:boundaries -- host/e2e/streaming`（7 文件，0 violation） | 0 |
| `20261104110355-11e8fd` | `npx vitest run -c vitest.host.config.ts host/e2e/streaming --maxWorkers=1`（2 文件 23 passed） | 0 |
| `20261104110355-56e46f` | `npx vitest run -c host/e2e/streaming/vitest.frontend.config.ts`（2 文件 6 passed） | 0 |

恢复后 ledger `20261104112137-c50d09` exit 0（commands 1058 / tests 8036，problems 0/0/0 orphan）。host 目录测试是协调者指令要求的门禁检查，不是新增主链场景；三行阻塞（L04/L02/L03）与"完整 parity 不通过"不变。

## 08:21Z 剩余主链准备（未运行，不计通过）

正常 main merge=`3380b7849`，main=`3b2758d7a`。本基线三行阻塞：**X5-01 send/retry 注册→L04；X5-02 unified chat stream 实际调用→L02；X5-03 execute/tool-loop/final与partial持久化编排→L03**。L02 `llmStreamEvents` hooks、L03 生产 binder/context、增量保存 helper 均已存在，不能沿用“hooks全缺/variant仅数组”的旧描述。

准备文件 `REAL-CHAIN-PLAN.md` 已在 `de77fd6ae` 保存：首条真实普通回答的 fake.created/requests/parsed+terminal+仓储断言；工具第二轮 call-id/result 对应；错误/取消的终态前部分保存；真实 cancel/retry 的 generation 与迟到旧终态。假 LLM `requests` 仅记录真实 buildRequest 输入，未运行完整 send、未增加通过场景。已签收旧六条不重跑。

08:28Z 回执已核对：L03 `1f39f5d83` 修复真实 Paths 夹具，`745463f6b` 有说明；本轮亲取已有作业 `20261104073614-29a529` 的 `job.mjs result`：**exit 0，sink两例通过，无Errors**（提供方分支运行，不是本工作树重跑）。下方旧缺 paths 的 exit 1 仅保历史，不再列当前待修项。`e7b0de787` guard 真委托有实现，但分类口待 L05 API、catastrophe 仍 pending，不等于完整 execute。

恢复后按要求经 jobs 运行 `npm run migration:ledger -- --check --no-write`，作业 **`20261104085046-46783d`，result 退出码 0**：commands 1058 / tests 8036，problems commands 0 / tests 0 / orphan registrations 0。这不是主链测试；本轮修改的请求观测和 hooks 描述没有新增运行通过数。

## 已签收定向复核：X5-05 / X5-04 / X5-03 发射子项

修复 `a5a8ffa30`、`a7fdaf010` 已经 `46e6299e0` 合并进入本工作树。已移除单调计时用例 `.fails`，保留 mono100→151=51ms 的原断言，并增加墙钟回拨及收到正文后活动计时断言。

`components.test.ts` 已删除测试自建 `bindSink`，改为公开生产 `chatPipeline.createSessionEventEmitter/bindStreamingSink`；variant 用例也改为 `createVariantStreamContext/createVariantStreamingAdapter`，断言 `onComplete` 前 Host 已收到 start、context 已有文本，无诊断 events 回放。原直接强转 raw emitter 的反例仍用于说明禁止的调用方式，不是声称生产 binder 还存在该缺陷。

仅选择 content 精确 wire、reasoning/content、tool preparing、error、variant 发射和 X5-05 共六个局部用例；不重跑原 29 条或完整 send。L03 提供的 `stream-sink-wiring.test.ts` 本轮也已定向运行，但夹具缺 `paths` 在装载阶段失败（作业 `20261104064332-f79e14`，退出码 1），不修改责任 lane 夹具。X5 自有夹具首跑同因缺 paths 装载失败（`20261104064621-9b0d8b`，退出码 1）；补齐本 lane 真实依赖后的作业 **`20261104065020-9dacfe` 经 `job.mjs result` 确认为退出码 0，6 passed / 5 skipped**，无 xfail。关闭 X5-05、X5-04 binder 缺口、X5-03 发射子项；不关闭完整 X5-03 或完整 parity。命令与完整退出结果见审计报告最新续记。

纯测试宿主和假 LLM 移到真正的 `__fixtures__/host.ts`、`__fixtures__/fake-llm.ts`，不拆词逃避边界扫描；宿主补装真实 workspace 插件以提供新增 agentVfsResolver，补入真实 Paths 实现并将所有路径指向本次临时目录。没有替换 pipeline、sink 或 registry。

## 历史：C1-app 04:25Z 状态更新（该轮不运行测试）

已通过 `0e6f4dc20` 合并 main（`29bc10a47`）。L02 分支 `cc047f02c` / 快照 `af32992c2` 已有公开 `llmStreamEvents` hooks；L04 分支 `f47467e34` / 快照 `12c075dd5` 已有真实 context/executor registry 工厂。这两项尚未进入本次合并的 main，且不等于完整 send/execute/unified stream 已接通。下表 hooks/registry 缺失描述和既有测试结果均指首轮基线；尤其不能只看 `ctx.llm` 上没有 hooks 就否认独立 `llmStreamEvents` 服务的新增实现。

X5-05 在合并后及 L03 分支快照 `a0a64ab40` 仍为 reset 写入 `this.now()`；保留该条 `it.fails`。收到修复并合入后才去掉 `.fails` 跑真实局部回归；完整闭环齐备后才跑七类完整发送，要求 fake LLM 实际消费、生产 sink 与持久化，禁止以本目录 `bindSink` 代替生产接线。本轮未重跑 29 条、无新增跨平台验证；编号→提交→入口→命令/退出码详见审计报告续记。

| 文件 / 场景 | 实际被测范围 | 不代表什么 |
|---|---|---|
| `reachability.test.ts` / 真实插件装载 | native、vfs、vfs-repos、llm、chat、chat-pipeline；真实迁移库、settings、secrets | 不代表 send 已实现 |
| 同上 / answer、thinking、tool、error、cancel、retry、variant | 每个脚本通过公开 `llmAdapters` 服务注入，真实 send IPC 返回 command not found；适配器创建数和事件数均为 0 | **七个阻塞复现，不是七次 E2E 成功** |
| 同上 / retry_message、retry_variant、retry_variants | 真实重试 IPC 不可达 | 不代表重试管线 |
| 同上 / hooks、执行入口 | L02 hooks/unified stream、L03 三个单变体 execute 均已公开 | 本次 23 条门禁复验通过；方法存在性不等于真实 send 闭环 |
| `components.test.ts` / 普通回答 | 真实 L03 adapter → 生产 bindStreamingSink → 生产 emitter 工厂/L04 emitter → Host；精确 JSON 字段/名称/序号/顺序 | 会话开始/终态由测试发射，不是完整发送 |
| 同上 / 思维链 | reasoning/content 交替，块分段和权威正文 end | 非真实 LLM transport |
| 同上 / 工具 | 参数准备、分片、完整调用收集；独立 tool start/end JSON 保真 | **执行器、工具返回注入、第二轮 LLM 尚未验证** |
| 同上 / error、cancel | 真实 adapter error，真实 L02 cancel registry，emitter 终态 flush | 部分结果持久化和取消命令到管线的传播未验证 |
| 同上 / reconnect、variant | reset/重连元数据；真实生产 variant context 即时发射，emitter 包围和 usage | 自动重试、多变体执行器/调度未验证；本轮未重跑 reconnect |
| 同上 / 直接接线反例 | L03 meta 对象与 L04 raw emitter 位置参数仍不同；必须使用现有生产 binder | 本轮不重跑此历史反例；不能据 raw 强转失败否定正确 binder |
| 同上 / `X5-05 retry reset` | 正常 `it`：Rust 单调时钟契约 51ms、墙钟回拨不影响 idle、正文后重新计时；生产 adapter/binder | 原 `.fails` 已移除；只证明该局部修复，不代表完整 retry pipeline |
| 同上 / 常量 | 只读 Rust 源自动核对 21 block type + 15 session type + 4 phase | 不把常量覆盖算为全场景覆盖 |
| `__tests__/bridge.spec.mts` / 4 条 | 真实 HostRuntime/BackendEventsSink/emitter → ShellRuntime/plugin:event/registry → preload → **官方 Tauri core/event** → 真实 TauriAdapter；成功 drain、error、cancel、重试旧 generation | OS 窗口/IPC 用内存传输；eventBridge/store 边界是 spy；没有声称真实渲染/store/utilityProcess E2E |
| `__tests__/demo.spec.mts` / 2 条 | 真实 scriptPlayer 的回答/思考/检索顺序、取消分工 | emit 为采样 spy；demo 不是权威 Rust 事件轨迹 |

## 运行

```sh
npx vitest run -c vitest.host.config.ts host/e2e/streaming --maxWorkers=1
npx vitest run -c host/e2e/streaming/vitest.frontend.config.ts
```

前端文件使用 `.spec.mts` 并放在 `__tests__/`（边界规则按目录识别测试），避免 Node-only `tsconfig.host.json` 把 DOM 侧源码和 `@/` 别名拖入 Host 类型图。自有前端配置复用仓库 jsdom/React/setup，仅去掉 core/event 的 mock aliases；不要用仓库默认 event mock 冒充 Electron bridge。

权威事件规格及差异归属见 `docs/dev/electron-migration/audits/X5-stream-parity.md`。
