# L24-chatanki 行为规格（`host/plugins/chatanki/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 0 个 · 发出事件 1 种 · 契约：`contracts/ipc/L24-chatanki.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：工具输出用 `json!` 显式写 `null`（如
  `chatanki_status` 的 `finalError`、`chatanki_analyze` 的 `routePlan`/`glossaryMode`），
  未实现 `skip_serializing_if` 的输出字段一律保留 `null`；入参侧 `Option` 缺省与 `null`
  等价（`chatanki_run`/`start` 的 `resource_id`、`template_id` 等，chatanki_executor.rs:2244–2500）。
  TS 输出构造保持同键同 `null`，不删除键。
- [x] u64/i64 超过 2^53 的表示：毫秒时间戳、计数、`u32` 上限与 `f32` 置信度都在安全
  范围内；`expectedReviewVersion` 在 Rust 是 `i64`（chatanki_executor.rs:1180/1205/
  1362/1380），可以超过 2^53。TS 不对它增加 `Number.isSafeInteger` 校验：线上
  JSON 数字沿用 Tauri 已有的精度边界，解析后的 number 原样传给 L15/L16 公开
  CAS，不做 `Number(BigInt)` 截断；只用 BigInt 做 i64 上下界校验，越界仍按 Rust
  serde 拒绝。`u32` 参数继续用 `Number.isInteger` + 同一上下界校验。
- [x] 字段顺序（serde_json preserve_order）：`src-tauri/Cargo.toml:101` 启用
  `serde_json/preserve_order`，输出键序即构造顺序；TS 对象保持同样的赋值顺序，
  测试断言 `Object.keys`/JSON 文本时按该顺序。
- [x] f32 精度：`RoutePlan.confidence` 是 `f32`（chatanki_executor.rs:9176–9185），
  Rust 在 `resolve_route_decision` 用 `f32` 与 `ROUTE_PLAN_MIN_CONFIDENCE` 比较，
  日志用 `{:.2}`（chatanki_executor.rs:9701–9706）。TS 用双精度保存同一十进制值，
  阈值比较与 `toFixed(2)` 日志保持相同可见结果；不做 f32 舍入模拟（无跨阈值样本）。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：`ToolExecutor::execute`
  返回 `Result<ToolResultInfo, String>`，失败时 `ToolResultInfo.error` 是纯字符串
  （chatanki_executor.rs:1930–2005）；`fsrs_settings_executor.rs:41–56` 把结构化
  错误序列化成 JSON 字符串（`code`/`hint`/`retryable`/`messageFallback`…），本 lane
  的其它工具沿用 Rust 原文案。Rust 的 panic 会中止该次调用并由上层转成错误文本；
  TS 用异常 + `errorText` 保持同样的用户可见字符串，不新增错误码。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：Rust 以
  `anki_block_id` 为键注册 `CancellationToken`（chatanki_executor.rs:116–181），
  `chatanki_control(action=cancel)` 先取消 token、停流并把未完成任务落 `Failed`。
  TS 的生成管线尚未移植（见下「阻塞」），已移植的短工具没有取消点；`chatanki_control`
  保持未注册，不伪造取消语义。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：Rust 的卡片/复习写路径
  由 SQLite 事务串行化，版本 CAS 防并发覆盖（`update_card_if_version`）；活跃管线用
  `Mutex<HashMap<blockId, CancellationToken>>`（chatanki_executor.rs:116–181）。
  TS 执行器声明 `concurrencyClass = 'serial'`，写路径走 L16 仓储的 CAS/事务，
  不另建队列；await 交错处不读后写共享可变状态。
- [x] 时间与 ID：生成方式、格式、时区：id 用 `uuid::Uuid::new_v4()`；块 id 前缀
  `blk_`（chatanki_executor.rs:6988），文档/任务 id 为裸 UUID。毫秒时间用
  `Utc::now().timestamp_millis()`，字符串时间用 `Utc::now().to_rfc3339()`
  （chatanki_executor.rs:6988–6997、7305、8661）。TS 统一走 `host/platform/time`
  的 `now()`（同一时刻的毫秒 + RFC 3339；UTC `+00:00`，小数秒 AutoSi 0/3/6/9 位）。
- [x] 不对含 HashMap 的结构做序列化后比对：本 lane 输出不含 HashMap（活跃管线表只在
  进程内使用，不序列化）；测试若需比较键集合只比较显式字段，不比较整个 JSON 文本的
  键序以外的哈希顺序。

## v2-1.3 / PreferenceEntry.subject 的 serde Option 修正

- Rust `dstu-anki/src/anki_preference_memory.rs:124–135`：`subject: Option<String>`，
  缺省或 null 都解码为 None；错误类型仍拒绝。TS 原 `field('subject')` 错把它当必填。
- `src/preference-memory.ts::decodePreferenceEntry` 改为缺省 → null，保留其它字段的
  必填、enum、u32 检查以及损坏值不覆盖的 best-effort 行为。
- 原 `tests/v2-decoders.test.ts` 的缺省 subject 拒绝向量并不符合 Rust，本次替换为
  `subject:1` 的真实错误类型向量；原缺省输入由新的生产链成功回归覆盖，不是删去保证。
- `tests/preference-decoder-real-host.test.ts` 经 `chatankiTools.execute(update_card)`
  → 真实 L04 UI 预检、L16 cards/preferenceMemory、F4 settings store → 实际持久化，
  验证编辑成功、无 warn、原条目保留且 subject 写回 null。无卡片/偏好算法替身。
- 修复前 `20261104161559-921b7e` exit 1，1 failed，准确抓到 `missing field subject`
  warn；修复后 `20261104161712-be0b20` exit 0，3 files / 17 passed。
  两份日志都没有单列 Errors 行。该小单元不等于全 PreferenceStore 的 f32/i64 已签收。

### preference i64 精确持久化后继（候选，联合待验）

- Rust `anki_preference_memory.rs:125–135` 两时间为i64，`chatanki_executor.rs:11036–11055`
  按typed from_str读取并to_string写回；本 lane类型对齐L16候选PreferenceTimestamp=number|bigint，
  包括两个时间字段、consolidate与持久化nowMs/index适配，原第五兼容性断言不动。
- 入站共享JsonReader逐字段解码，时间直接readSigned为bigint，无JSON.parse先丢精度或safe上限。
  保Option缺省/null、未知字段忽略、已知duplicate拒绝、必填与原serde结构/枚举表示。
  非时间u32经宽度校验后才转number，confidence仅从数值token窄化，不用出站null规则放宽入站。
- 两时间字段用JSON.rawJSON写数字词法，无bigint普通stringify/引号/Number(bigint)；旧number参数
  保已表示的整数（不冒称恢复早期Number丢失的输入词法），正常epoch的JSON数值形状不变。
  这是时间整数精度保证，不签f32短十进制/负零/整个JSON文本字节一致。
- 新真实持久化回归14例：卡编辑通过公开真实owner与settings，内部nowMs经生产持久化函数；
  min/max、相邻>2^53、旧number与bigint、非法数字token/duplicate/引号/越界与不覆盖保障。
  oracle用原生JSON源词法独立校验。修前005640-03892f原exit1/12fail1pass（当时13例），
  修后Node010420-3d80ee原exit0/31pass（4files）、Electron010920-06e304原exit0/14pass，
  无单列Errors行。旧负例输入及断言方向保持，错误detail按真正serde类型文本纠正。
- L16 `931643d80/2d558e65b` 的完整API/检索排序正常联合及独立复核仍待，不私引/改owner代码；
  f32共享出站primitive仍单列，不将本次通过签成整个PreferenceEntry持久化域。

## X6-AP-0187 / get_cards owned snapshot 真实链

- Rust `chatanki_executor.rs:15084–15137` → 新
  `tests/owned-snapshot-real-host.test.ts`：公开 owner API 插入/归属设置后，调用
  `chatankiTools.execute(get_cards)`，不注入卡片/复习 provider。
- 原 16 条断言按 Rust 行号逐条保留（实际插入量、分页 total/长度/id、越界空页、
  error filter 的全局 index、edited filter）。既有数组 helper 用例及断言未删。
- 证据：`20261104184905-218327` exit 0 / 17 passed（2 files，真实新增 1），
  无单列 Errors 行。不代替全 get_cards 分支/错误映射签收，不改 GENERATED TESTMAP。

## X6-AP-0189 / C3 workspace 只读授权共用 L05 状态

- Rust `chatanki_executor.rs:16345–16384` → 新
  `tests/workspace-read-scope-real-host.test.ts`：同 L04 实际调用的 L05 公共 installer
  设置 trusted scope；真实 L16 cards/documents + `chatankiTools.execute` 读/写入口。
- 原六项保证逐条保留并标 Rust 行号，额外验证完整行无写及 owner release 后撤权。
  手动安装前提与 Rust 单测一致，不替代完整 worker 管线创建/取消/异常动态回归。
- 修正本 lane 接线：移除重复 Map / guard，只读预检从 L05 公共 `workspaceCardReadScope`
  取权威状态；L04 已在 `workspace-run-agent.ts:304` 安装该状态，`:626,743` 释放。
  原 verifyDocumentOwnership/loadOwned/CAS 写路径不查询 scope，仍严格检查 worker 自己会话。
- 新回归修复前 `20261104220756-84468e` exit 1 / 1 failed，现有 L24 私有 Map 看不到
  真正 owner 授权；修复后 `20261104220953-a19d15` exit 0 / 9 passed（4 files），
  无单列 Errors 行。旧测试只更换公共 installer 和 guard release，未删/弱化原断言。
  整 C3/生命周期仍待独立复核，不改 GENERATED TESTMAP。

### AP0189/C3 读预检日志补齐

- Rust `chatanki_executor.rs:1783–1789` → 既有 verifyDocumentOwnership 的单次查询异常 warn；
  读预检复用该路径再取成功/失败，不静默吞掉 DB 错，也不在外层补第二条 warn。
  正常 false 不 warn、异常仍 fail-closed/尝试原 coordinator 分支，查询顺序与次数不变。
- Rust `:1826–1832` → 仅实际 scope 命中发 info：
  `[ChatAnkiToolExecutor] read-only coordinator scope hit: worker=…, workspace=…, coordinator=…, document=…`。
  直接 caller-owned 不算命中。get_cards/status 透传已有 ctx.warn/info，index 原真实 logger 不变。
- 新日志回归通过真实注册 wrapper 的 snake_case context 及 Cordis exporter，双读工具分别
  检查直接拥有/合法scope/拒绝/无scope/真实数据库异常/首错后恢复，记录查询参数、level、
  原文字段顺序、错误与生命周期。DB观察器仅调用原方法，schema错误只在私有测试库制造。
- 修复前 `20261104234905-27de6e` exit 1 / 6 failed + 4 passed；修复后
  `20261104235711-c837be` exit 0 / 20 passed（含新14及原scope6），无单列 Errors 行。
  不以旧scope6通过签新日志；旧权限/CAS/行不变断言保持，完整worker生命周期仍未执行。
  完整预检 `20261105000326-7ef60e` exit 1（420 passed / 1 既有入队测试30秒超时），
  其中新日志14条通过；该未改用例单文件 `20261105001834-6e9a6b` exit 0 / 1 passed。
  保留原始失败与测试预算，不将这次最小区分当作整组通过或新日志证据。

## C2/C7 / JSON export 真实链

- Rust `chatanki_executor.rs:15558–15642,15646–15700` →
  `tests/export-real-host.test.ts`：两个原用例所有原断言保留并标 Rust 行号，经公开
  `chatankiTools.execute(export)` → L16 cards/documents + JSON sink，不注入替身。
- 显式库卡允许原向量中的跨会话选择，保请求顺序和完整字段；包含软删除卡则整批失败。
  文档选择器仍严格拒绝外部会话，owner 导出的 JSON 与原 id/front/条目数一致。
- 附加实际文件 oracle：失败不新增文件、不覆盖已有内容；输出还与完整 owner 行逐字段比较。
  只在测试配置中将 paths.os.temp 指向私有目录，避免其它 lane 临时文件变化污染断言。
- `20261104193345-c0d09e` exit 0 / 4 passed（2 files，真实新增 2），无单列 Errors 行。
  原生产分支正确，未改权限或 sink；不签 APKG/全导出域/A5 联合装配。

## C3 / chatanki_list_library_cards（正常main精确owner已接，待独立复验）

- Rust 入口 `chatanki_executor.rs:1909,3562–3653`，参数 `:1219–1301`；
  TS `index.ts::hydrate` → `src/executors.ts` → `ChatAnkiLibraryListExecutor.execute`，
  `parseChatAnkiListLibraryCardsArgs` 现由真实生产入口调用，不再只有helper路径。
- 目标顺序必须保持：参数解析失败 `Invalid chatanki_list_library_cards arguments: ...`；
  再检查库依赖/执行列表，失败 `Failed to list Anki library cards: ...`；
  列表成功后才 `getReviewStatesForLibrary('agent', pageIds)`，失败保完整 AppError；
  最后投影，`ratingAvailableToAgent:false`，复用原 tool start/finish/error helpers。
- 正常main `536aad095` 已具备正式 `listAnkiAgentLibraryPage` 及PreferenceTimestamp；
  本入口通过`Pick<AnkiService,...>`/`Pick<ReviewService,...>`消费公开契约，不另镜像查询协议。
  显式传parser已归一化的page/pageSize20及diagnostic=filter；owner全局COUNT/过滤/排序/分页后，
  只向L15传本页ids，按id挂状态；不自行分页/过滤、重查locator或复制SQL。
  `total:bigint`直接进内部输出；owner flat `dueMs:bigint|null`未Number化，且不额外输出Rust无的flat dueMs。
  `reviewState`沿L15 canonical结构，reviewVersion保持bigint。仅宿主已有外层wire边界负责JSON投影。
- 分支对应（同Rust文件）：`:3569–3579` parser错误→handler首个catch；
  `:3580–3590`无DB→libraryCards缺失的原databaseUnavailable；`:3594–3612`列表SQL错→list catch原prefix；
  `:3613–3625`本页ids/完整review AppError→库状态调用/finishChatAnkiAppFailure（NotFound亦不改为session key）；
  `:3626–3653`逐项卡片+locator投影/输出→convertLibraryRecordForTool及finishChatAnkiSuccess。
- 所有权/运行时：只读L16 agent页与L15状态；跨session显式库读不改变session写拒绝。
  不新增写表/事务/worker/取消点；短同步owner调用沿现有服务，计时performance.now，class沿Rust默认serial，敏感度low。
  此分支无额外Rust业务warn/error，通用info/start及finish生命周期复用原实现。
- `tests/library-list-real-host.test.ts` 真实chatankiTools验证AP0188原14语义保证、默认20实际页长、
  诊断过滤在COUNT/OFFSET前、new-state Due、其余schedule、稳定排序/空页、locator/版本/截断、
  精确total/owner dueMs/reviewVersion、session写拒绝、parser→真实SQL列表错→真实review AppError顺序。
  review NotFound用真实列表读后公开owner竞争删除触发，不伪造provider结果；无DB/缺review能力分支仅源码核对，
  不把这十例当完整Host能力缺失/全工具域签收。旧helper/GENERATED断言及映射不改。
- 后继C1审读修正（不沿用旧十例声称全入站已齐）：library decoder现在按map输入顺序逐字段解码，
  search/query到第二个别名时duplicate search（首值null仍已出现）；更早非法值优先于晚到的duplicate/unknown/enum。
  支持完整六槽sequence与unit-enum单键map+null，前六槽解码失败优先于尾部长度错误；
  中间enum缺槽默认，但page/pageSize的Option仍需要位置，故两槽输入在slot4报invalid length4。
  错误来自from_value模型，复用kernel unexpectedOf/oneOf；u32数值越界等沿locked Number typed parse报invalid number，
  不带from_str行列/path，不把已解析Value转JSON再解析。其它工具共享decoder不变。
- 新25个真实入口case保上述反例/正例及首错，原十例原14保证不改。Rust计时`:1873`在info/start前，
  此入口现先performance.now再begin；可控单调时钟证明40ms info+60ms start均计入duration100ms。
  Node三文件56passed/exit0、Electron本文件35passed/exit0，原红25failed/10标题过滤/exit1分列保留（详见LANE）。
  这是locked serde源码逐分支审读+生产入口测试，不是已跑Rust差分或整个输入域/完整工具独立签收。
- 历史：旧正式 L16 `listAnkiAgentLibraryCards` 实际委托 UI filtered 列表：
  due排除新卡、enqueued无分支、缺 error_only 的全局COUNT/分页前诊断过滤，
  返回页缺 `dt.document_id` locator。page/cap20、flat卡投影本可本地适配，
  不是接口阻塞；上述查询语义/原快照定位则不可由分页后筛选、额外重查或复制SQL补齐。
- 真实 owner 诊断 `20261104231341-19e80d` exit 2：normal 新卡已到期、error未入队，
  现due=[]（应normal），enqueued=[normal,error]（应normal），并核缺locator。
  不是新工具测试通过/新增pass；没有提交假列表或改变原AP0188十四保证。
- 精确输入/输出及D3 total:u64接缝已在 `native-needs.md` §6 经 C1/架构交接。
  L15 canonical reviewVersion:bigint原样保留；显式agent库读可跨session，不把这一
  权限用于session写路径。此处历史缺口现由新正式agent-page及上述生产回归补齐，独立复验仍待。

## 待接线（跨插件）

- `agentTools`：L07 已发布 `registerToolExecutors`/`toolExecutors`。`index.ts` 在
  `apply` 中通过 `ctx.inject(['agentTools'])` 注册 8 个**包装执行器**；包装器在调用
  `ChatAnkiExecutor` 前执行与 `ctx.chatankiTools.execute` 相同的 `hydrate`，因此 L04
  registry 直接派发也会拿到 review/nativeRegex/anki 等宿主服务。包装器同时转发
  `sensitivityLevelForCall`/`hasDynamicSensitivity`，保留 transform script 的 High
  动态分级。
- `anki`：L16 实际服务名是 `anki`，`index.ts` 静态注入该名字（不再使用 `anki@1`）。
  `hydrate` 消费已发布的 `getCustomTemplateById`、`saveJsonFile`（JSON 导出）、
  `checkAnkiConnectAvailability`、`consolidatePreferenceObservation`，并在
  `anki.cards`/`anki.documents`/`anki.chatBlocks` 存在时直接接入真实仓储
  （当前 main `anki/api.ts:144–178,272–286` 已发布仓储适配器）。
  真实 review 入队和大 i64 CAS 测试已不再注入卡片替身；前者已独立验证，后者仍因
  L15 精度缺陷失败。模板 CRUD 数据库 facade、生成管线 facade 仍待发布；其它
  原 pending 用例须逐例真实复验，不能由这次服务发布整批签收。
- `chatanki_import_apkg` 还需要 L11 `ChatAnkiApkgVfs`（blob/原文件读取）与 L04
  `ChatAnkiSessionResourceLookup`（会话资源归属）；缺任一服务时按 Rust AppError
  形状返回 `[apkg_database]`，不会跳过归属检查。
- `review`：main 的 L15 已发布 `getReviewStatesForSession`、`getStats`、
  `enqueueCardsForSession`、`getEnqueuedCards` 与 scheduler 方法；`hydrate` 直接
  接入，`chatanki_get_cards` 缺服务时显式失败。`chatanki_enqueue_review` 已在
  真实 L15 + 真实 mistakes 迁移库上验证入队行与 `fsrs://changed`
  （`tests/real-review-enqueue.test.ts`）。`setSuspendedForSession`/
  `undoLastReviewForSession` 已在 main 的 `FsrsReviewService` 类实现真实 CAS，
  但 `review` 插件发布的 `ReviewService` API 尚未暴露这两个方法；main 运行时
  缺失时两个工具显式接线失败，不在本 lane 自建 CAS。`chatanki/index.ts::hydrate`
  只有在服务实际暴露方法后才接入，发布前生产成功路径保持 pending。
  `expectedReviewVersion` 是 Rust `i64`，不是 JS safe integer；超过 2^53 的
  number 不再被本 lane 拒绝，原样传给真实 CAS（只有超出 i64 才按 serde 拒绝），
  不做 `Number` 舍入或截断。L15 的
  `CommandError(AppError)` 按公开错误协议映射：`NotFound` →
  `blocks.ankiCards.errors.statusNotFound`，其余保留结构化 `output.error`。
- `llmRawPrompt`：`chatanki_retemplate` 的 `fill_missing_llm` 现经 hydrate 消费
  L02 公开 `callModel2RawPrompt(prompt,null,'anki')`；缺失时工具显式失败，不跳过 Phase 2。
- `llm.callAnkiRoutedRawPrompt`（L02 Planner 槽）：`chatanki_analyze` 按
  `ChatAnkiRoutePlanner` 边界调用。`hydrate` 标记 `llmManagerPresent`：真实 manager
  不存在时走 Rust 的 `plan=None` 启发式回退；manager 存在但缺该 seam 时显式报接线
  错误，不伪装成回退。
- `nativeRegex`（F7）：F7 只发布异步引擎。生产 `chatanki_transform` 通过
  `compileTransformOpsAsync`/`planTransformOpsAsync` 使用真实 Rust regex 引擎；
  L16 仍使用同步纯函数 API（`nativeRegex` 同步边界），不把它的 fixture 计为真实异步 provider。
  F7 原语已在正常 main `5b1b19055`，L24 对常量/capture 统一使用必需的
  `replaceAllProjected`：完整原文、`limitBytes=max(1MiB, utf8Bytes(text))`、
  失败原样首越界 bytes；没有 JS 常量结果拼接或后置 `replaceAll` fallback。
  引擎 u64 与 JS safe-integer 参数域分别验证，不扩张接口输入域。
  本 lane `tests/regex-projected-real-host.test.ts` 独立跑原八向量和真实工具链，
  检查 1049600 首越界（不是最终 2097152）、错误 opIndex/field、失败不写、全原文
  边界、旧超长字段保留/收缩及权限；非仅有声明或复用供方通过数。
  常量替换工具另验首越界 1052672（不是最终 8388608），定向
  `20261104212517-e1bd60` exit 0 / 1 passed、10 名称过滤未执行。
  同步 legacy 字面前后缀计数的 UTF-16 错误也已修为 UTF-8；固定真实 capture 数据
  的纯计数回归不代表存在已验证的同步原生 provider。
  定向 `20261104210852-a98613` exit 0 / 52 passed（3 files）；无单列 Errors 行。
  C1 已亲核 R5 `c4d5744cd` 固定 main `650ddffbe`：`20261104230316-7884d4`
  两文件 23 passed / 21 标题过滤 / 原 exit 0，并核同 tip 官方 gate
  `20261104230548-697ebd` 49 files / 407 passed / 0 skip / 原 exit 0。
  async 常量预检、capture 后置 fallback 删除及原实际工具场景已获限定接受；不扩常量
  apply 动态覆盖、legacy 同步 provider、C4 脚本/平台，不改 GENERATED TESTMAP。

## 事件 `fsrs://changed`

<!-- BEGIN GENERATED:event:fsrs://changed -->
- 事件名 `fsrs://changed`
- 发送点：`src-tauri/src/chat_v2/tools/chatanki_executor.rs:8757`（emit）
- 发送点：`src-tauri/src/chat_v2/tools/chatanki_executor.rs:12230`（emit）
- 发送点：`src-tauri/src/chat_v2/tools/chatanki_executor.rs:12467`（emit）
- 发送点：`src-tauri/src/chat_v2/tools/chatanki_executor.rs:13719`（emit）
- 发送点：`src-tauri/src/chat_v2/tools/chatanki_executor.rs:13730`（emit）
<!-- END GENERATED:event:fsrs://changed -->

- [x] 载荷：五种发送点的 payload 都以 `source: "agent"` 开头（ACR 4.0，前端兼容
  `"ai"`）：生成完成 `{action:"cards_persisted", entityIds, runId}`
  （chatanki_executor.rs:8750–8760）；入队复习由 `build_enqueue_review_changed_payload`
  生成（chatanki_executor.rs:12230）；卡片变更 `{action, cardStateIds, cards, runId}`
  （chatanki_executor.rs:12467）；导入 `{action:"import", documentId, entityIds, runId}`
  （chatanki_executor.rs:13730）；卡片增删改的通用
  `{action, entityIds, runId, cards?}`（chatanki_executor.rs:13719）。TS 由
  `review-payloads.ts` 生成同一形状，`runId` 取 `ctx.runId`（Rust `ctx.run_id()`）。
- [x] 触发时机与顺序：均在对应数据库写成功之后、工具结果/块写入收尾之前发出
  （生成完成在卡片入库后，chatanki_executor.rs:8740–8770；enqueue 在入队事务返回后，
  chatanki_executor.rs:12200–12235；APKG 导入在导入完成并拿到 cardIds 后，
  chatanki_executor.rs:13719–13736）。发送失败只记 `debug` 日志并继续，不影响工具结果。
- [x] 节流/合并：无节流、无合并；每次写操作/每次 Import 结束各发一次。生成管线按文档
  终态发一次 `cards_persisted`，用户取消时不发（chatanki_executor.rs:8743–8748）。
- [x] 是否在事务提交后：是。事件发送位于仓储写入（事务已提交）之后；Rust 注释
  「卡片写库完成点 emit fsrs://changed（DESIGN §5.6）」（chatanki_executor.rs:8741）。
- [x] 目标窗口（emit / emit_to / emit_filter）：`ctx.window_ref().emit(...)` /
  `params.window.emit(...)`，广播到主窗口，不做定向窗口过滤
  （chatanki_executor.rs:8757、12230、12467、13719、13730）。TS 用
  `ctx.emitEvent`；headless 时按 Rust 的发送失败路径仅记 debug 日志。

## 阻塞（跨 lane，保持 pending）

### v2 / C4 script 运行时排雷（本 lane，自有修复）

- [x] 入口：Rust `chatanki_transform_script.rs:1109` → TS
  `src/transform-script.ts::runTransformScript`，生产链为
  `chatankiTools.execute → ChatAnkiExecutor → executeChatAnkiTransform → runTransformScriptMode`。
- [x] 分支：Rust `:1184–1188` wait Err 在返回 Setup 前释放 command resources；
  TS wait/timeout 正文使用 `try/finally`，错误路径同样执行 `cleanupResources`，
  不执行成功分支的 `cleanupFinishedProcessGroup`。
- [x] 运行时：Rust `:1149` 在 spawn 前取 Instant，`:1245` 算 elapsed；TS
  `performance.now()` 同样移到异步 spawn 前，watchdog timeout 仍只包 wait。
- [x] 流错误：Rust `:998–999` read Err 等价 EOF，保留已读前缀；TS
  `drainStreamTail` 的 iterator.next 拒绝同样结束循环，finally 关闭迭代器。
  Rust `:1222–1226` 任务 JoinErr 返回 empty capture，TS 立即挂 rejection handler，
  不在 wait 完成前留下未处理拒绝。
- [x] 错误/输出：wait 错误保留 `Failed to wait for sandboxed transform script: `
  前缀，经工具返回 `status:failed,error:script_setup_failed,mutationApplied:false`，
  不写卡片；stdout 错误不让工具失败。清理失败原有 warn 级别/文案保留。
- [x] 所有权：仅 job 文件和外部 L05 process handle，无 SQL；不改变 job 保留规则。
- [x] 证据：新增 `tests/script-runtime-wiring.test.ts` 经公开服务执行，外部 process
  seam 注入，未替换本 lane 业务。初次作业 `20261104103125-41e3c2` exit 1，
  3 failed / Errors 1，确实抓住未清理、漏 spawn 时间、未处理拒绝，不能只报 Tests。
- [ ] 完整脚本能力签收：F7 硬沙箱、其他平台与同步文件 IO worker 待后续，
  此组测试不替代七个真实隔离 e2e，也不宣称整个 transform 工具已完成。

以下项需要其他 lane 先发布接口，本 lane 不以测试替身冒充完成：

- **L02 生成/视觉调用面（部分解除）**：当前 main 已发布 `llmRawPrompt`
  （`llm/api.ts:293–305`）及 `llmAnkiRouting`。retemplate Phase2 现通过生产
  hydrate 消费 `callModel2RawPrompt(prompt, null, 'anki')`，与 Rust `:4448` 一致；
  真实 L01/L02/L04/L16/F4 链已验证模板变更后生成 Example 字段并 CAS 写回，
  新测试 `tests/retemplate-model2-real-host.test.ts` 修复前 exit 1（缺错误方法名），
  修复后 `20261104174709-2dbf86` exit 0 / 1 passed，无单列 Errors 行。
  后续同一真实链补原 Rust `:4432–4461` 解析失败不回滚 Phase1、
  `:4466–4472,18489–18495` 请求期间真实 owner 编辑导致过期 fill CAS 冲突的回归。
  解析失败后原 Phase1 卡不变；竞争结果返回赢家版本，DB 手动 Example 不被覆盖；
  `20261104182455-4fc8cd` exit 0 / 7 passed（3 files），无单列 Errors 行。
  原实现这两个分支正确；其它错误/完整工具未签，不据此整批修改 TESTMAP。
  尚缺 Rust `model2_pipeline.rs:8632–8672` 高层角色调用，因而：
  - `chatanki_analyze` 的 Planner 槽回退链（`chatanki_plan_route_consumes_planner_role_through_fallback_adapter`）
    仍需要 owner routed 方法；baseline model2 已公开。不得把通用 config 调用
    冒充角色适配（缺调用前配置重验、消失时 model2 回退以及原 task 审计字段）。
  - VLM 抽取的三条路径（`chatanki.vlm_full_image_fallback` / `vlm_light_extract` /
    `vlm_full_extract`）已有通用图片 raw primitive，但角色回退链尚缺；
    `chatanki_vlm_extract_branches_consume_vlm_role_through_fallback_adapter` 仍 pending。
- **L15 scoped/CAS 复核（已解除）**：main 的 `review@1`（`host/plugins/review/api.ts:111–122`、
  `index.ts:54–70`）已发布并委托 `setSuspendedForSession`/`undoLastReviewForSession`。
  `tests/review-executor-real-l15.test.ts` 改为生产链：`chatankiTools.execute` →
  hydrate `ctx.get('review')` → 真实 FSRS CAS（迁移后 mistakes DB，评分经已发布
  `fsrs_rate` 命令），向量为 Rust 合法 i64 `2^63-1024`，SQL 以 BigInt 写入、
  `CAST(local_version AS TEXT)` 读回，断言首次更新精确 +1、重放判
  `review_state_conflict` 且不写、undo 精确 +1、`2^63` 在 CAS 前被本 lane 解析器拒绝；
  不再导入 L15 实现类。
  **[x] 原 L15 scoped i64 缺陷已在正常 main 组合复验（整个 D3 未签）**：旧版
  `review/src/review.ts:58–60` `isI64Version` 及
  `review/repository/fsrs.ts:884–897` `exactReviewVersion` 的 MAX_SAFE 拒绝已由 L15 修复。
  main `fb463060d` 包含该修复，L24 正常 merge 后真实公开服务链 CAS 4/4 通过，
  全 lane `20261104164944-744fb3` exit 0 / 391 passed，无单列 Errors 行。
  三条大 i64 CAS 用例无运行时缺陷 skip，保留成功、精确 +1、stale 不写的真实断言；
  不以跳过或缩小范围签 D3；尚待独立复核与 L16 删除 CAS 的完整 i64 主线对齐。
  L24 消费类型已对齐候选：`FsrsAgentReviewStateSnapshot.reviewVersion: bigint`，
  scoped CAS 参数 `number | bigint`，卡删除 CAS `number | bigint | null`。
  六个 session/library CAS 参数解析器原样保留 bigint 或 number，均检查完整 i64 范围；
  number 不新增 MAX_SAFE 校验。投影/事件保留精确 bigint，只有外层 wire 副本可舍入。
  快照/结果类型直接引用已 main 的 L15 `review/api.ts`，不维护手写 number/bigint 镜像。
  L16 `a47f42ded` 尚待 main；旧 `anki` number 快照仍触发 `:210` 类型兼容性失败，
  不修改该断言或放宽返回类型求绿。
  卡片归属与 task/card 建库现消费当前 main 已发布的 L16 `anki.cards/documents`，
  测试 context 不注入 cards/reviewStates，两个 provider 都经生产 hydrate。
  入队链与 scoped 大 i64 CAS 均已独立真实复验；L16 删除 CAS 的类型/版本接缝另记，
  不与已移除的预检替身边界混记。
- **L16 生成管线服务**：`start_background_pipeline`（chatanki_executor.rs:6901–9400）
  直接调用 `crate::streaming_anki_service::StreamingAnkiService`（2 处）、
  `crate::document_processing_service::DocumentProcessingService`（2 处）、
  `crate::anki_connect_service::check_anki_connect_availability` 与
  `crate::anki_preference_memory`；这些 Rust 文件在 inventory 中全部归
  **L16-anki**，且截至本报告仍为 pending（`migration/ledger.json` 中
  `crates/dstu-anki/src/streaming_anki_service.rs`、
  `crates/dstu-anki/src/document_processing_service.rs`、`anki_connect_service.rs`
  的测试均为 pending）。在 L16 发布这些服务前，管线的
  `chatanki_run`/`chatanki_start`/`chatanki_wait`/`chatanki_control`/`chatanki_sync`
  无法注册，受影响测试：`test_append_vlmfull_occlusion_*` 5 行、
  `test_ensure_failed_document_session_inserts_placeholder_once` 1 行。本 lane 的
  `appendVlmfullOcclusionDraft` 与 `ensureFailedDocumentSession` 已实现并有测试，
  等管线接线后直接标 ported。
- **L05 硬沙箱后端**：main 已发布 `agentTransformSandbox`（L05 adapter blob
  `1011746922…`，异步 bwrap/Seatbelt adapter）；仍缺 `ds-mig/F7-native` 的
  `nativeSandbox` 服务。本 lane 已用临时 worktree 在 Linux
  上通过真实 `runTransformScript` 跑通 `chatanki_transform_script.rs` 的 7 个
  `e2e_*`（断网、job 外文件不可读、超时进程组终止、符号链接输出拒绝等）；
  Windows AppContainer 与 macOS Seatbelt 目标尚未在本机验证。持久化复核见
  `tests/candidates/l05-linux-sandbox.test.ts` 与 `native-needs.md`（含 L05/F7
  provider blob hash）。F7 合入前该 7 行 TESTMAP 保持 pending。
- **L16 APKG 导出器（C3）**：`chatanki_export format=apkg` 的 Rust 路径调用
  `apkg_exporter_service::export_multi_template_apkg_report`；main 的 `anki` API
  未发布导出器，生产当前显式失败而不是写假文件。请求签名、路径/模板/报告语义
  见 `native-needs.md` 第 3 节。provider 合入前该分支保持缺口。
- **L16 卡片/文档/模板 CRUD/APKG 仓储**：main 的 `anki` 已声明模板查找、JSON 导出、
  AnkiConnect 与偏好记忆；卡片仓储、文档任务、模板 CRUD 数据库与
  `ApkgImporterService` 仍未发布。`ds-mig/L16-anki` 分支已提供真实
  `cards`/`documents` 与 `AnkiHostService` 适配器，`hydrate` 会在服务出现时
  自动接入。临时 worktree 同时合并 L16/L15 分支后已验证真实卡片
  get/enqueue/update/stale conflict/delete，删除后 `anki_cards` 与
  `fsrs_card_states` 均无残留行；`tests/candidates/l16-anki-delete-cas.test.ts`
  已用生产 `chatanki_delete_card` 覆盖大整数物理删除、内容 CAS 与复习 CAS
  冲突（作业 `20261104085554-c90c0c` 退出码 0，4 tests），但分支未合 main 前
  只能记为候选。main 上这些边界仍由 `ToolExecutionContext` 注入；本 lane 的
  仓储测试替身只锁定边界语义，不能替代真实 SQLite 事务证据。27 条
  CAS/事务/ownership 契约测试因此保持 pending。
- **L04/L11 只读引用与会话资源**：`ChatAnkiRefResolver`、`ChatAnkiSessionResourceLookup`
  已按 L04/L11 契约定义；真实适配器未发布时相关工具按 Rust 语义 fail-open/fail-closed，
  测试用替身覆盖。
