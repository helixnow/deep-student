# L19 MCP 依赖状态（v2；新增 chrono serde 日期接缝，见末节）

## WP-214：WP-184 后继候选

- runtime-only Electron 六文件 `20261105222628-e2186b` 102p/Errors0/raw0，原13失败路径通过。
  EOF 驱动的真实 host dispose 新回归仍在双端复现 inactive logger（Node
  `20261105222522-94618c`、Electron `20261105222808-b343ab`，均2failed/Errors6/raw1），
  证明不能把原 Errors 一概归于 GUI fixture 或负载。
- `index.ts` 绑定活跃上下文真实 logger，两个既有 disposer 返回清理 Promise；修后 stderr
  Electron `20261105222929-4895b4` 6p/Errors0/raw0。最终全域结果及候选 tip 见 WP-214-REPORT。
- 最终 Node `20261105223012-be876d` / Electron `20261105223333-d1917c`：各51文件、
  471passed/failed0/skipped0/Errors0/raw0；自有原13失败与新卸载回归均绿。官方直接 gate
  仍 exit2（仅以下两份 foreign 账本），不以这些分项替代清洁组合签收。
- WP-184 原报告/原红不覆盖，仍部分 blocked 直到 C2 清洁组合完整 gate；用 WP-214 新候选
  替换 `a69530132645e8b2f6349ae58be90fecedb7a66f`，不借旧 tip 作证。起点两份 foreign
  `migration/LEDGER.md` / `migration/ledger.json` 不提交/还原；无新增 F1/F2 接口需求。

## WP-184 交付边界

- WP-154 / WP-118 已在 main：本包起点 `fd9d654d7` 包含官方 L19 集成 `acc3ecac3` 及
  `578bcfba3`；initialized 原名修正没有新增 owner API 依赖。
- 起点既有 foreign `migration/LEDGER.md`、`migration/ledger.json` 未提交改动保留，不修改、
  不提交或还原；正式提交 `be24c297e` / merge main `be646f252` 后直接执行绝对路径官方
  lane-gate，原 exit2：`有未提交的改动，先提交再自检（自检结果按提交记录）`，列出的仅上述
  两份账本，未进入门禁 jobs。最终 tip/raw 交 WP-184 报告；由 C2 正常组合完成全 gate，分项绿不代签。
- 原 browser 所有权问题（`browser/repository/vfs-metadata.ts` → L11 resources）、typed 桥
  WP-195/194、网页 WP-196 均不在本包；不因本次 MCP wire 修复关闭原 finding 或签 A/C/G1。
- 合并后的 main `be646f252` 已正式有 L11 `types/files.ts:158` / `repository/resources.ts:439`
  的 `updateResourceMetadataWithConn(conn, resourceId, metadataJson, updatedAtMs): void`。原
  `browser/BLOCKERS.md` “owner 尚未提供”是历史证据，现应由 WP-196 消费；browser 自有
  `repository/vfs-metadata.ts:11` 的直接 UPDATE 仍在，不能据 owner 已发布提前关闭 X6-SW-0003。
- Electron 双目录 `20261105220929-a6af3e` 原 exit1：456 passed / 13 failed / Errors9。
  失败在本包未改的 client/stdio-proxy/stdio-stderr/stdio-stdout/transport-auth 测试，原日志有
  裸 Electron 子进程 Missing X server / $DISPLAY，以及 reader 结束晚于 host dispose 的
  `cannot get required service "log" in inactive context`。本包两文件36项在该run通过，不能
  抹掉整run红。归 L19 后继 runtime/env/清理单元，不新索要 F2 API；原失败逐项见 WP-184报告，
  尚未旧tip重跑，不凭来源未改声称整个Electron已签收。

- 已解除（V02-05）：L02 早已以独立服务 `llmMcpTools`（`clear()` / `preheat(window)`，
  `host/plugins/llm/src/mcp_tools_service.ts`）发布，本lane原先在 `llm` 上找 `clearMcpToolCache` /
  `preheatMcpTools`，真实 desktop profile 两条命令必报错。现 `index.ts` 每次调用经
  `ctx.reflect.get('llmMcpTools')` 取服务（不进 inject，其余 MCP 命令不等 dstu.llm）；
  `tests/tool-cache-commands.test.ts` 装载真实 llm 插件，按 Rust 断言 `{ ok: true, count }` 与
  `{ success: true, message: 'Backend MCP disabled; frontend SDK in use' }`，并经前端事件往返验证缓存真被清掉。
- F4 `SseEventBuffer` / F1 target：已正常合入并消费，不再阻塞；接手最小集25passed、exit0。
  旧尾 CR 缺口也已由当前 main `platform/util/sse-buffer.ts:330` 的全部行尾 CR 去除处理，
  不再重复报给 F4，也不在本 lane 复制修补。
- Electron真实窗口MCP桥与Windows子进程路径尚未实机验证，不以本地Host target测试替代。
  V10-P1-1 已修：`.bat`/`.cmd` 按 Rust std `make_bat_command_line` 经 `<SystemRoot>\System32\cmd.exe
  /e:ON /v:OFF /d /c` 逐字启动（`src/spawn-plan.ts`，`tests/stdio-spawn-plan.test.ts` 用纯函数和
  mock spawn 固定）；仍缺 Windows CI 上真实 `echo-mcp.cmd` 冒烟。

自有实现的v2复审项不是跨lane阻塞，见 LANE.md。

## L19-V2-09：WebSearchTool 可选 reranker（L02）

- 原 Rust `dstu-mcp/src/tools/mod.rs:931-1079`：配置启用 reranker、有 model_id 且命令上下文带 llm_manager 时，调用 `call_reranker_api(query, chunks, model_id)`；成功按返回 document_id/score 重排，失败 warn 后保留原排序。
- 当前 `host/plugins/llm/api.ts` 没有 rerank 方法。请求 L02 发布其真实 reranker 的 API：输入 query:string、modelId:string、chunks（每项 chunk:{id,document_id,text,chunk_index,metadata}, score）；输出同结构的有序 chunks（保留精确 document_id 和分数）；支持 AbortSignal（registry 超时必须取消）。失败应原样抛出给本 lane 的 best-effort warn 分支。
- 引擎门、会话路由与多引擎聚合已按 Rust `tools/mod.rs:776-928,1167-1382` 移植（`src/web-search-tool.ts`，W21 LA-03），只差 reranker 一段；聚合 usage 的 `reranking_time_ms` 暂为 null。
- 本 lane 自有工作：接口发布后接配置门、citation→chunk、按返回顺序重排/重建 citations/inject/usage 及逐条日志，不把接口缺失写成全单元阻塞。registry/timeout/error 映射可独立验证；完整 test_search_engine 仍不签 v2 完成。

## D3 / serde 原文：共享 Value 读取面已发布，消费待另包（WP-014 核实 main）

- main 的 F4 `JsonReader` / `parseJsonDocument` 已正式公开，并保留 u64/i64 BigInt 和原始数字 raw；typed struct 可使用它，不能笼统说没有共享 parser。
- main `967f43c75` 的 `host/platform/util/json-exact.ts:445–475` 已实现 Value/arbitrary_precision
  `readValue/valueTree`：合法数字保留 raw，超 f64 为 `{kind:'arbitrary',raw}`，不再因 `1e400`
  拒绝。typed `readNumber/readUnsigned/readSigned` 仍保持类型边界；不能再引用旧 ParserNumber
  限制声称 Value 原文读取面未提供。`util/api.ts` 亦公开 `stringifyJsonValue/jsonNumberToRawJSON`。
- 剩余是 L19 自有消费工作：按另包调整 Value 表示、transport/序列化并接入公开读取面，补真实
  数值/错误顺序测试。WP-014 仅实现详细工具结果，不复制或扩展 F4 parser。
- 受影响：browser `parseBridgeJson` 和 mcp provider raw JSON（原 X6-UD-0017/0018/0049/0050）。当前本 lane serde-json.ts 仍使用 JSON.parse+三类拒绝，语法错误原文与完整数值精度明确开放，不能以此冒充完整 serde。
- 本 lane 自有后续：消费该正式面，调整内部 Value 表示和 transport/JSON 序列化，补真入口数值/错误测试；不是把所有 D3 工作推给共享 owner。get_mcp_status 的字符串 u64 已独立修复，不依赖这个接口。

## 持久化 OAuth 的 chrono serde 日期面（原 X6-UD-0042，交 C1/C2 集中）

- Rust OAuth2Token.expires_at 是 `Option<DateTime<Utc>>`。Cargo.lock 实际 chrono=0.4.41；其
  datetime/serde.rs DateTimeVisitor 调用 `value.parse()`，再走 datetime/mod.rs FromStr 与
  format/parse.rs parse_rfc3339_relaxed，不是 JavaScript Date，也不等同于严格 RFC3339 parser。
- 只读源码依据：https://github.com/chronotope/chrono/blob/v0.4.41/src/datetime/serde.rs 、
  https://github.com/chronotope/chrono/blob/v0.4.41/src/datetime/mod.rs 、
  https://github.com/chronotope/chrono/blob/v0.4.41/src/format/parse.rs 。未编译或修改参考 Rust。
- F4 已发布 parseRfc3339 / ParsedDateTime（含 epochNanos），并非完全没有日期面。但 serde relaxed
  还接受 `2012-12-12 12:12:12+0000`、`2012-12-12 12:12:12 UTC`、分隔符周围的允许空白等；
  不能直接换成较窄的 parseRfc3339，也不能用接受无时区的 parseFlexibleTimestamp 冒充。
- 精确请求：由 C2 安排 F4 的 chrono DateTime<UTC> serde/FromStr 公共解析语义，保留完整纳秒/闰秒与
  UTC 归一化，成功返回现有精确时间表示，失败可明确区分；不另造任意时间范围/格式限制。
- 当前自有风险必须保持开放：parseSession 仍会把无效日期字符串的 JS Invalid Date 降成 expiresAt=null，
  可能把无效记录当作无过期时间；纳秒也会被 Date 丢失。本轮只修 map 字段必填/Option/Vec 类型，不签日期内容等价。
- 消费方后续：无效日期内容使整个 persisted session 读取失败（Rust from_str(...).ok() → None），而不是
  None 过期时间；调整内部时间表示、过期比较和序列化。原始重复字段和 struct 序列形式也仍需原文级 decoder，
  不能把字段 guard 当成整条 serde 例外。
