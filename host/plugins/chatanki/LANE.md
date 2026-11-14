# L24-chatanki：ChatAnki

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L24-chatanki（ChatAnki） |
| 目录 | `host/plugins/chatanki/` |
| Rust 范围（lanes.md） | src/chat_v2/tools 的 chatanki、template、fsrs_settings，以及 tests/chatanki_* |
| 主要提供 | `chatankiTools`（接口 `ChatAnkiTools`，描述对象 `chatankiToolsService@1.0.0`） |
| 主要消费 | L16、L03、F7 starlark |
| 特别注意 | chatanki_executor 单文件 21K 行；转换脚本 |
| 规模（本目录） | 28468 行 · 6 个文件 · 0 个命令（前端调用 0） · 286 个测试 |
| 规模（整条 lane，inventory） | 28468 行 · 6 个文件 · 0 个命令（前端 0） · 286 个测试 |
| 契约 | [`contracts/ipc/L24-chatanki.json`](../../../contracts/ipc/L24-chatanki.json) |
| 服务草稿 | [`contracts/services/DRAFT-L24-chatanki.md`](../../../contracts/services/DRAFT-L24-chatanki.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/src/chat_v2/tools/chatanki_executor.rs` | 21173 | 169 |  |
| `src-tauri/src/chat_v2/tools/chatanki_transform.rs` | 1389 | 29 |  |
| `src-tauri/src/chat_v2/tools/chatanki_transform_script.rs` | 2274 | 40 |  |
| `src-tauri/src/chat_v2/tools/fsrs_settings_executor.rs` | 473 | 4 |  |
| `src-tauri/src/chat_v2/tools/template_executor.rs` | 2609 | 44 |  |
| `src-tauri/tests/chatanki_apkg_executor_e2e.rs` | 550 | 0 |  |

### 命令（0）

本目录没有 `#[tauri::command]`；职责是向其他插件提供服务（见服务草稿）。

### 发出的事件（1）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `fsrs://changed` | 字面量 | src/chat_v2/tools/chatanki_executor.rs:8757 (emit)<br>src/chat_v2/tools/chatanki_executor.rs:12230 (emit)<br>src/chat_v2/tools/chatanki_executor.rs:12467 (emit)<br>src/chat_v2/tools/chatanki_executor.rs:13719 (emit)<br>src/chat_v2/tools/chatanki_executor.rs:13730 (emit) |

### 契约中的事件（1，`contracts/ipc/L24-chatanki.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `fsrs://changed` | 否 | object \| Value | src/chat_v2/tools/chatanki_executor.rs:8757 (emit)<br>src/chat_v2/tools/chatanki_executor.rs:12230 (emit)<br>src/chat_v2/tools/chatanki_executor.rs:12467 (emit)<br>src/chat_v2/tools/chatanki_executor.rs:13719 (emit)<br>src/chat_v2/tools/chatanki_executor.rs:13730 (emit) |
<!-- END GENERATED:lane -->

## 备注

## v2 排雷清单（X6 gate-checks，候选基线 `2ee9a9cbe`）

来源：`git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/<gate>.json`。
info、计数类候选只作人工线索；下表逐位置核对当前 SHA，不按数量补 expect。
single-writer、prod-reachable：0 候选。

### C3/D3 优先增量（C1 14:50/57 指令）

- **当前联合条件已解除**：正常 main `5b1b19055` 已同时包含 L15、L16 与 L24
  精确类型/公开测试更新；原 `:210` 和旧 number CAS 测试不再按旧状态等待。
  `20261104211312-322e47` typecheck exit 0。本轮前的旧失败记录仅保留历史证据。
  C1 已亲核 R5 `f7660f7ed` 的限定 C3/D3、A5 装配/服务面与 C2/C7 真实子项，
  不扩张为全 D3/工具/Planner/VLM；1709 pass / 1 外部 skip 是复核方证据，未重跑代 C4。
- C1 组合验收增量：R5 `062a7d75e` / 独立固定 main 作业
  `20261104172659-6c494f` 的 A5 在 `anki-chatanki-service-surface.test.ts:181`
  install(vfs) 缺真实 notes/vfsRepo/vfsIndex，10 case 未执行；这是独立于
  `:210` 类型不兼容的装配阻塞。L24 官方 gate 的范围只含本 lane，
  「只剩 typecheck」不能外推为整个联合只剩类型即可签收。交 L16 owner/架构恢复，
  不假装 provider、不删除断言、不重复全量；canonical L15 API 与最新公开 D3 测试保持。
- **最新正常 main 复验**：`fb463060d` 已包含 L15 `a0515bf75` 完整 i64 修复。
  L24 merge tip `1d010c567` 自检只剩 typecheck 一项失败（exit 2，旧 L16 `:210`）；
  另外四项通过。真实全 lane 作业 `20261104164944-744fb3` exit 0，
  44 files / 391 passed，包含新版公开 provider 链 CAS 4/4；无单列 Errors 行。
  main-red 三条 scoped 大 i64 行为已在正常 main 组合恢复，不再沿旧缺陷文本标 blocked。
  L16 删除 CAS / 全 D3 复核签收仍 pending，不能把 L15 的通过当作 L16 已对齐。
- L24 快照/结果类型现在直接引用 L15 已发布 `review/api.ts`，scoped 服务类型取
  `ReviewService` 的真实方法签名，避免手写镜像再次滞后。仍保留 bigint，绝不
  放宽为 number 来绕过 L16 `:210`。L16 `a47f42ded` 尚未 main，已向架构师及 owner 上报。
- 自动续派自检 `e1ca62c56` / main `1e893eb61`（16:01Z）exit 1，
  2/5 项失败：typecheck exit 2 仍为旧 L16 `:210`；tests exit 1 仍为
  suspend/stale/undo 三条旧 L15 i64 缺陷，未弱化断言或加 skip；其余三项通过。
- 重新审读当前 main 发现 L16 cards/documents 已发布，纠正旧阻塞描述：
  `tests/real-review-enqueue.test.ts` 与 `review-executor-real-l15.test.ts` 的 task/card
  建库改用 `anki.documents/cards` 公开方法，context 不再注入 `CardStoreDouble`。
  真实入队、事件、重复入队不重发事件的原断言保持；作业
  `20261104160659-832304` exit 0 / 1 passed，日志无单列 Errors 行。
  这只证明真实小版本入队链；没有重跑大 i64 旧失败求绿或宣称 D3 已通过。
- 已移除 `review-executor-real-l15.test.ts` 三处缺陷文本 skip 和 helper；
  原 `2^63-1024`、SQL BigInt 写入/TEXT 读回、精确 +1 与 stale 不写断言保留。
  不把 owner 的临时精度拒绝当作 Rust 规则，不以缩小向量/skip 换绿。
- 现有失败证据：`20261104144120-7b4419` exit 1，3 failed / 1 passed，
  日志没有单列 `Errors` 行（不能改报为 Errors 0）；C1 已亲取 L04 作业
  `20261104144011-3bba37` exit 1，5 failed / 1467 passed / 2 skipped / Errors 2。
  本单元不重复运行已知失败；L15 bigint 修复正常进入 main 后最小复验。
- L15 已告知候选方向：`reviewVersion: bigint`，CAS 参数 `number | bigint`，
  内部 BigInt 比较/绑定，最外经 kernel `toWireJson` 转 wire；初次告知时尚待实现 SHA/main，
  本 lane 不提前 Number 化或直接 stringify bigint，不签 D3。
- L15 后续已提供候选 `a0515bf75`（实现检查点 `21b30f5ff`、`6a32027af`）；
  本次核验仍未进入 main，不能用候选结果代替 main 签收。
  原真实组合测试补回内部 `reviewState/current.reviewVersion === LARGE_SQL + 1n`
  精确断言，并单独经 kernel `toWireJson` 验证 wire 为 number、原对象仍为 bigint；
  保留 `2^63-1024` 输入与 SQL TEXT oracle，不加 skip，不重复跑旧 main 已知失败。
  L24 现已同步快照 bigint、scoped CAS `number | bigint`、delete CAS
  `number | bigint | null`；六个 session/library 工具 CAS 参数解析器保留输入类型，
  exact bigint 通过原 i64 范围检查，不经 Number，旧整数 number 调用不变。
  输出投影/事件携带 bigint，仅 kernel `toWireJson` 的 wire 副本转数字。
- L16 同接缝候选为 `a47f42ded`（代码 `bcb3f2b61`/`c34dfbe14`），
  与 L15 `a0515bf75` 均待正常 main；不改/删除 L16 `:210` 兼容性断言。
  本 lane 定向参数/输出/消费者作业 `20261104152119-274d84` exit 0，6 files / 44 passed，
  日志没有单列 Errors 行。typecheck `20261104152119-87836d` exit 2，
  唯一错误仍为当前旧 L16 的 `anki/tests/anki-chatanki-service-surface.test.ts:210`
  （旧 provider number 与新 consumer bigint 反向不匹配）；不改 owner 文件求绿。
  未重跑旧 main 已知失败的真实 L15 组合；两 owner 正常 main 后最小复验。
- L16 `b789b9954` 已记录只读候选类型核验：作业 `20261104153009-ff06f8`
  在 compiler host 内存读取 L24 `6962cbfed:api.ts`，对 L16 `1df97b515`
  原七项兼容性断言 diagnostics=0 / exit 0；未改原断言，未执行真实 provider。
  此证据只证明两候选接口兼容，不替代 main 正式 typecheck 或 D3 组合复验。
- X6 增量来源：固定 main `8d7b05d14`，清单读取版
  `a07019791e219c91f89fc3960ef5644846486b94` 的
  `scripts/electron-migration/gate-checks/reports/handoff-8d7b05d14.md`。
  AP 46 条沿本节原 X6-AP-0187–0232 映射，仍为人工待核线索；
  transform selection 两例当前位置为 `tests/transform.test.ts:325,331`，不重编号。

### C2 / F1 独立 custom_agent 分类测试接缝

- `api.ts::createChatAnkiExecutors()` 构造生产执行器，不需要 host 服务才能调用 metadata。
  `index.ts::ChatAnkiToolsService.executors` 使用同一工厂，处理器和构造顺序不变。
- Rust `src/agent_wiring/tests/custom_agent_tests.rs:29–36` 是一个执行器检查四工具；
  TS 按职责拆分：get_cards/status 各有真实 handler，analyze/list_templates 共用
  `ChatAnkiExecutor`，所以消费者应在工厂列表中 `.find(e => e.canHandle(tool))`，
  再调用该真实实例的 `sensitivityLevel(tool)`，不复制敏感度表。
- 本 lane `tests/api-exports.test.ts` 覆盖公共出口、四工具 Low 和 host 实际 handler
  构造器/顺序一致性；不调用工具业务、不依赖 F3 缺省配置，不替 F1 签档案过滤/顺序断言。
- 实现保存于独立检查点 `ebeeb6864`（仅 factory/API/index/出口测试四文件，
  与 D3 bigint 类型更改分离）。定向 `20261104153642-199ee0` exit 0 / 3 passed，
  无单列 Errors 行；Node 可导入 `20261104153642-760949` exit 0 / importable ok。
  typecheck `20261104153642-61c1a0` exit 2，唯一为旧 L16 `:210` bigint 接缝；
  F1 metadata 接缝本身没有类型报错，不宣称整仓 typecheck 或 D3 已通过。

### C4 优先交付接续：F7 projected capture gate

- 最新限定复核：C1 已亲核 R5 `c4d5744cd` 固定 main `650ddffbe`，
  `20261104230316-7884d4` 两文件 23 passed / 21 标题过滤 / 原 exit 0；
  同 tip gate `20261104230548-697ebd` 49 files / 407 passed / 0 skip / 原 exit 0。
  认可 async 常量原生预检、capture 后置 fallback 删除及原实际工具场景；
  常量 1052672 仍只 dry-run，capture 1049600 才双模式，legacy 同步 provider、
  C4 脚本/平台及整 C4 不扩签。本轮不为此追加业务矩阵。
- 正常 main `5b1b19055` 已含 F7 `4b2c21d37` API/绑定/WASI artifact；不再按旧
  提供方缺口等待。L24 异步常量和 capture 替换统一调用真实 `replaceAllProjected`，
  删除边扫描边拼接常量路径和捕获后置 fallback，不重写 Rust/JS 匹配或投影算法。
- 新 `tests/regex-projected-real-host.test.ts`：独立复验 native-needs 原八向量
  （第三行 `a$[b]c` 为 6 字节）、失败无 value、JS limit 0/MAX_SAFE 与非法域；
  引擎 u64 计数不被用作整个 JS u64 参数域已验收的理由。
- 真实 `chatankiTools.execute(transform)` 不注入 regex/cards provider：全原文 \B、
  `$$`、capture 炸弹首越界 1049600（不是最终 2097152）与 opIndex/field 错误，
  dry-run/apply 均拒绝且 DB 不变；旧超长字段可保留/收缩、外部会话仍拒绝；正常 apply 写回另验。
- 同步 legacy 纯计数发现字面前后缀 `.length` 错按 UTF-16，已用 UTF-8 字节长度修正。
  用真实 F7 capture 数据构造固定匹配 fixture，先红 `20261104210626-16b99f`
  exit 1 / 1 failed（另 10 名称过滤），抓到 prefix 应 1048579 却报 1048577；
  该 fixture 不冒充同步 regex provider，也不替同步兼容分支整体签收。
- 定向 `20261104210852-a98613` exit 0 / 52 passed（3 files，新文件 11 条），
  typecheck `20261104210144-22e810` exit 0；日志无单列 Errors 行（WASI experimental
  warnings 原样保留）。完整 C4、脚本沙箱和平台仍待独立复核，不更改 GENERATED TESTMAP。
- 常量分支另以同一真实工具入口补首越界 1052672（最终结果原会为 8388608），
  并验 dry-run 不写。`20261104212517-e1bd60` exit 0 / 1 passed、10 名称过滤未执行；
  不用提供方 tiny-vector 的 bytes=8 替代本 lane 实际工具常量分支证据。
- 同期正常 main A5 最小入口复验 `20261104210852-e4c9ce` exit 0：原七表面入口
  1 passed、其余 9 名称过滤未执行；只解除 fixture/此入口，不能签九例或全联合。
- 本轮提交前完整检查：`20261104211312-babd4b` exit 0 / 406 passed（48 files），
  typecheck `20261104211312-322e47` exit 0；完整/strict 边界、importable、wiring、ledger
  均 exit 0。全 lane 结果不替代上面 C4 专项 52 条，也不被当作独立复核签收。
  ledger 另报全仓 unreachable 16 / unknown 3640（not vetoed），不隐去这项提示。

### v2-1.3 自审：PreferenceEntry.subject 缺省语义

- 发现并修复本 lane 错误：Rust `anki_preference_memory.rs:128` 为 `Option<String>`，
  TS 不应要求显式 subject。缺省/null 现均保留 None；非字符串仍拒绝。
- 撤掉错误的「缺省 subject 必须拒绝」自加向量，改为 `subject:1` 拒绝；
  同时新增真实 `chatankiTools.execute(update_card)` → L04/L16/F4 持久化回归，
  原缺省向量完整保留为正向用例，保证无 warn、条目不丢失、subject 写回 null。
- 修复前 `20261104161559-921b7e` exit 1 / 1 failed，抓到缺省 subject warn；
  修复后 `20261104161712-be0b20` exit 0 / 17 passed（3 files），无单列 Errors 行。
  更早 `20261104161208-43ec99` exit 1 是测试未安装真实 L04 导致 UI 预检失败，
  已通过安装真实 chat 插件纠正，不拿它作为 decoder 失败证据。
- 尚需后续核实 PreferenceStore f32 输出与完整 i64 时间戳；本次只修 Option，
  不宣称整个持久化 decoder 已达 v2 签收。
- 后续审读确认具体缺口：本 lane `decodePreferenceEntry` 仍用 JSON.parse 和
  MIN/MAX_SAFE_INTEGER 验时间戳；L16 `PreferenceEntry.first_seen_ms/last_seen_ms`
  与 nowMs API 仍是 number、检索排序用减法，不能无损承接完整 Rust i64。
  已向 L16 请求这几个精确字段/参数的内部类型与排序接缝（不是再改 reviewVersion）。
  F4 JsonReader 已可复用，但不提前把精确 i64 Number 化塞进旧 owner。
  f32 confidence 的普通 0.9 等短十进制持久化需共享 formatter，已向 F4 请求归并
  现有同根需求；不在本 lane 用 toFixed/toPrecision 猜 serde_json 格式化。

#### preference i64 类型 / reader / writer 后继候选

- L16 已给实际候选 `931643d80`（测试 `2d558e65b`、报告 `96a5bd8df`）：
  PreferenceTimestamp=number|bigint、两时间字段与两种 consolidate nowMs 同类型。
  本 lane 对齐自身 `ChatAnkiPreferenceTimestamp`、entry/服务/持久化 helper 与 index 旧面适配；
  第五 SurfaceCompatibility 原断言保留。候选未正常 main 前，不把类型计划当联合签收。
- 已移除本 lane 时间读取的 JSON.parse / safe 上限：共享 F4 JsonReader 按字段读，
  first_seen_ms/last_seen_ms 用 `readSigned('i64', MIN, MAX)` 直接保 bigint。
  必填、Option subject、未知字段、重复已知字段、结构序列与 unit enum map 依 serde 处理；
  不把浮点词法1.0或数字字符串当i64，不接受越界；f32仅经数值token读取/窄化，null/string不放过。
- Writer 用宿主原生 JSON.rawJSON 的数字词法，只对两时间字段写精确整数；不是把 bigint
  交给普通JSON.stringify，也不加全局BigInt.toJSON。legacy integer-number 参数按其已表示的
  整数值无进一步损失写回（例2^63-1024），不宣称可恢复调用者在更早 Number 化时丢失的词法。
  正常epoch小值仍是JSON number；此处不签 f32 最短小数/负零/整段JSON字节等价。
- 新 `tests/preference-i64-real-host.test.ts` 消费真实 F4 settings、L16 memory/cards、L04 UI
  预检，经真实卡编辑或生产持久化函数测 min/max、相邻>2^53、bigint/旧number nowMs、
  duplicate/浮点词法/引号/溢出拒绝及损坏值不覆盖/卡编辑仍成功。
  数字词法oracle用原生JSON.parse的context.source，不把舍入后的Number再BigInt。
- 修复前 `20261105005640-03892f` 原 exit 1 / 12 failed + 1 passed（当时13例），
  抓到safe拒绝、BigInt序列化失败、unsafe number写错词法与错误接受1.0/duplicate；
  后补Rust结构序列/enum map正向例后，Node `20261105010420-3d80ee` 原 exit 0 /
  31 passed（4files，新14），Electron `20261105010920-06e304` 原 exit 0 / 新14 passed。
  typecheck `20261105010420-5a808b` 原 exit 0，无单列 Errors 行。
- 两条旧自加负例错误文本随真正from_str decoder更新为Rust类型错误（subject:1→expected a string，
  evidence_count:-1→expected u32），原非法输入/拒绝方向/损坏值保留断言不变；不是删去原向量求绿。
- 此证据仅为自身精确持久化，L16新API及检索/容量排序的正常联合仍需满足owner条件；
  f32出站共享primitive及整个Preference域不扩签。旧替身测试仍保留，不当新i64 provider证据。
- 实现由自动检查点保存：`90fc7fab7` 新真实回归（初13例）、`7ccf020a2` reader/writer、
  index与旧测试类型适配、`e2041561f` 第14例、`331a2596e` enum类型收敛、
  `df59dc7b9` 公共timestamp union及SPEC/接缝说明；`ec603dd3d` 只保存本段旧报告。
  后继手工证据提交不冒称上述源码首次落地；交付以完整最终tip为准，不能单取中间WIP。
- 提交前完整回归 `20261105012347-c8a8ad` 原exit0 / 51files / 435passed；
  typecheck `20261105012347-01e1a7` 原exit0；均无单列Errors行。
  boundaries `012347-d22d39` / strict `012347-bbae4b` 均原exit0，扫描2952files、
  0violation，分别216/233 suppressed（完整作业ID同为20261105前缀）。
  ledger `012347-b175b0` 原exit0：commands1058（A100%）、tests8109（A87.8%/B1.9%），
  problems commands0/tests0/orphan0，prod-reachable unreachable16（unknown3633，not vetoed）。
  wiring `012347-b7a392` 原exit0：ported0、未从index接入0；importable `012347-231606` 原exit0/ok。
  这些是precommit结果，不替代最终tip的§5官方回执。
- 本轮随后正常merge main `f2d5b6c46`，实际公开源码仍无PreferenceTimestamp、
  listAnkiAgentLibraryPage或f32ToJsonNumber；保留上述联合/库列表/f32边界。
  原七项SurfaceCompatibility中的第五项及全true数组未改、未cast。

### C2/C7 已发布仓储的真实 update/delete 补证（续派后继，非 Preference 改动）

- 自动续派时当前 tip/base 与 `72063aa7c/f2d5b6c46` 官方回执相同，未重复435；
  仅针对已解除provider阻塞、仍由CardStoreDouble覆盖的update/delete补真实测试。
  C1 后继稳定候选消息到达前，新增文件已由 `a028c30da` 自动检查点保存；
  Preference生产代码/第五兼容断言均无后继diff，不将此测试检查点冒称Preference修复。
- 新 `tests/card-mutations-real-host.test.ts` 安装真实native/chat/anki/review/chatanki与settings，
  通过公开L16卡片/文档、L15复习服务和`chatankiTools.execute`消费hydrate；无业务provider替身。
  VFS/LLM无操作；真实L04走“当前session无卡块”的合法UI预检路径，非完整UI块生命周期。
- 对照Rust `chatanki_executor.rs` 原八例，旧替身文件及GENERATED TESTMAP均不修改：
  `16457–16474` wrong-owner update、`16478–16516` mixed-owner update（含具体task可读但整doc拒绝）、
  `16520–16538` wrong-owner delete、`16542–16572` mixed-owner delete（物理行deleted_at=null）、
  `16606–16638` update版本成功/冲突、`16645–16668` delete正常/物理行归零、
  `16672–16710` stale delete不删、`16714–16819` enrollment/null与真实评分后stale review CAS、
  完整冲突payload及成功后state+log物理清理。各原断言取值/方向保留，未靠expect计数填充。
- 加强生产入口：四种ownership拒绝均不写卡/不发事件，update新旧版本与delete正常/stale
  走真实工具；review stale分支由真实L15刷新snapshot且不发mutation事件。
  最后成功删除的review CAS原断言仍直接经公开repo；不冒称全部步骤均为工具入口。
- 首跑 `20261105020053-0cbc81` 原exit1 / 6passed+2failed：两delete工具负例的自加夹具
  误带update的patch，严格deny_unknown_fields正确先拒绝，未到ownership；这不是产品红绿证据。
  只按真实工具分别构造参数，保原拒绝/不写/不发断言；修后
  `20261105020525-6596ca` 原exit0 / 8passed。typecheck `20261105020053-e829a6` 原exit0。
  日志均无单列Errors行。后继§5按新tip取得，不拿720回执覆盖新测试。
- 该单元仅补八例真实持久化证据，待独立复核；不将剩余27项、完整C2/C7或全工具签收。
  C1已请求架构正常联合L16 931/2d+ca01/6fc；当前停止扩项，等正常main才恢复agent-page。
  unknown/IgnoredAny、序列尾部首错及完整typed/f32域仍未决，不为交接改已测Preference代码。

### C2 / retemplate Phase 2 的真实 model2 接线

- 正常 main 已发布 L02 `llmRawPrompt.callModel2RawPrompt`；旧查找
  `llm.callAnkiModel2RawPrompt` 的代码永远拿不到它。本 lane 现在直接消费公开服务，
  按 Rust `chatanki_executor.rs:4448` 传 `(prompt, null, 'anki')`，
  将 `assistant_message` 投影到本 lane 边界，不复制配置、重试、provider 或审计逻辑。
- `tests/retemplate-model2-real-host.test.ts`：真实 F4 settings/secrets、L01 adapter、
  L02 raw-prompt、L04 UI 预检及 L16 transaction/CAS，经 `chatankiTools.execute` 完成
  模板 Phase 1 与 Example 字段生成写回；只有远端 HTTP 端点在本机，未替换 provider 方法。
  同时验证 gpt-* JSON response_format 请求（Rust `provider_quirks.rs:159` / raw `:9074`）。
- 修复前 `20261104173849-92ae22` exit 1 / 1 failed，抓到真实服务存在却报
  `LLM manager not available for fill_missing_llm`；修复后
  `20261104174709-2dbf86` exit 0 / 1 passed。无单列 Errors 行。
  `20261104174201-935868` exit 1 / 7 passed + 1 failed 是新测试误用非 gpt 模型
  却要求 response_format，已按 Rust 条件改测试模型名，保留断言；没有改 owner 规则。
- typecheck `20261104174202-a68f55` exit 2 仍唯一旧 L16 `:210`；不把该跨 lane 接缝
  改成 number 求绿。L02 usage/audit 全语义仍归 owner，本回归不替它签收。
- 提交后 §5 自检 `cbd4b027e` / main `e87727c09`：4/5 项通过，仅 typecheck exit 2
  仍为旧 L16 `:210`。真实全 lane `20261104175148-498e47` exit 0，45 files /
  392 passed（含大 i64 CAS 4 条与新 model2 链），无单列 Errors 行。
  此结果不覆盖上文 A5 另有装配阻塞的 10 个未执行 case；后续仅文档补充，不重复全量。
- 后续真实失败/并发回归（原实现正确，新增证据，不伪造业务修复）：同一真实 HTTP/
  provider 链增两场景。Rust `:4432–4461` 的响应解析失败仍返回已应用 Phase 1，
  fillStatus=failed，HTTP 回包前读到的 Phase 1 卡与终态 DB 全对象相同；
  Rust `:4466–4472,18489–18495` 的过期 fill CAS 在模型请求期间被公开 owner 编辑后
  返回 conflict/version_conflict，payload 版本与赢家相同、手动 Example 不被覆盖。
  未替换 owner 方法；竞争编辑由 HTTP 端点触发一次真实 owner CAS。
  `20261104182455-4fc8cd` exit 0 / 7 passed（3 files，真实链一例内三场景），
  无单列 Errors 行。首跑 `20261104182107-f101ff` exit 1 是新增卡片同内容被
  owner 去重（新建 0 条），只改测试卡片内容，保留插入成功断言/生产去重规则。
  typecheck `20261104182107-d73f12` exit 2 仍旧 L16 `:210`；不推广整工具或 TESTMAP。
- Planner/Vlm 仍缺 owner 高层 routed 出口：现有通用 config/image 调用不保证
  角色配置调用前重验/消失回退或 task 审计字段。已给 L02 精确 Rust `:8632–8672`
  输入/输出请求，不在 L24 复制 owner 配置逻辑；两条 routing TESTMAP 保持 pending。

### C2/C7 / JSON export 两选择器真实入口

- 新 `tests/export-real-host.test.ts` 保留 Rust `chatanki_executor.rs:15558–15642`
  与 `:15646–15700` 的原断言，分别经 `chatankiTools.execute(export)` + 真实 L16
  cards/documents/saveJsonFile；没有卡片仓储或文件 sink 替身。
- 库选择器：按原请求顺序导出两个跨会话库卡，完整 extra_fields/template_id 不丢失，
  返回不内嵌 cards/documentId；软删除卡混入时整批失败且含 library_cards_unavailable。
  另核实际完整 owner 行相等，以及失败不新增文件、不覆盖首个导出文件。
- 文档选择器：外部会话仍 statusNotFound；owner 可导出，含 documentId /
  hiddenOverLimitCount，真实 JSON 只有原卡 id/front。不会因为显式库选择器较宽而放宽文档权限。
- `20261104193345-c0d09e` exit 0 / 4 passed（2 files，2 条真实入口 + 2 条旧测试），
  无单列 Errors 行。原库用例首轮 `20261104192516-8d9502` exit 0 / 3 passed；
  扩展文档后 `20261104193106-6af59a` exit 1 是目录快照误扫系统 tmp 导致并发干扰，
  仅把测试 paths.os.temp 配置到私有目录，保留失败无文件副作用断言与真实 sink 规则。
- 生产 JSON 导出代码这些分支正确，本单元新增真实证据；APKG exporter、其他分支与
  独立复核仍 pending，不改 GENERATED TESTMAP、不外推 A5 联合 fixture 通过。

### unchecked-decode（5，info）

| ID | 位置 | 方向与核验 | 状态 |
|---|---|---|---|
| X6-decode-chatanki-index-362 | `index.ts` hydrate `store as unknown as {entries}` | 出站：本 lane `ChatAnkiPreferenceStore` 传给 L16 `consolidatePreferenceObservation`；结构可直接赋值，双重断言多余。回读经 `bae671417` 严格 serde decoder | 已修：去断言（代码 `84def7e4d`） |
| X6-decode-chatanki-index-258 | `index.ts` adaptContext 直通 | 进程内调用方已按 `ToolExecutionContext` 类型传入（非 JSON 线格式），只在形状识别后直通；无对应 Rust 解码 | 保留，非解码缺陷 |
| X6-decode-chatanki-index-415/425 | `index.ts` hydrate `review` 能力探测 | L15 服务对象的方法存在性探测（typeof 函数检查后才使用），返回数据由 L15 类型化 api 产出；非外部数据解码 | 保留；L15 api 发布 `getSchedulerConfig/getReviewStatesForSession` 类型后可去断言 |
| X6-decode-chatanki-mutation-executor-43 | `settingsStore` F4 get/save 适配 | 内部服务方法名适配，值为 string 原样；无 JSON 解析 | 保留，非解码缺陷 |

### log-parity（7，info，计数类）

| ID | Rust 位置 | 当前 SHA 逐位置核验 | 状态 |
|---|---|---|---|
| X6-log-chatanki-template-executor-1 = C2 X6-LP-0139 | `template_executor.rs:768,1159,1490` warn 3 条 | TS 经 `ctx.warn` 三条同文案（`template-executor.ts:270,413,538`），门禁未计 `ctx.warn`；另发现 TS 多出 3 条 `Failed to persist tool block` warn，Rust `:217,238,275` 为 `let _ =` 静默丢弃；info 三条代码在 `d46db1e99`（记录提交 `c2cf3a617`） | 已修：多余 warn 改为带 Rust 证据的 boundary-allow 静默 best-effort（代码 `20a4f5d17`），回归 `tests/template.test.ts` |
| X6-log-chatanki-transform-script-1 = C2 X6-LP-0137 | `chatanki_transform_script.rs:1194,1206` warn 2 条 | TS `transform-script.ts` 同文案两条；多出的 `failed to clean up sandbox resources` warn 无 Rust 对应（`cleanup_command_resources` 返回 `()` 静默吞错，dstu-agent `shell_sandbox.rs:148`、`windows.rs:385–395`） | 已修（C4）：改为静默（代码 `5c64f0f18`），回归 `tests/script-runtime-wiring.test.ts` |
| X6-log-chatanki-fsrs-settings-executor-1 = C2 X6-LP-0138 | `fsrs_settings_executor.rs:185` | TS `fsrs-settings-executor.ts:169` 同文案 `ctx.warn` | 等价，门禁计数误报 |
| X6-log-chatanki-apkg-executor-1 = C2 X6-LP-0135（warn）/ X6-LP-0136（error），按 rs 文件归到首个引用文件 | `chatanki_executor.rs` warn 37 / error 6 | error 6 条：`:129`、`:11027` 为 mutex poisoned（JS 单线程无对应）；`:7192,8139,8330,8604` 在 run/start 后台管线，随 L16 管线 facade 阻塞（BLOCKERS.md）。warn 37 条尚未逐条核（已核：preference persist `:11077`、analyze refs） | 部分核验；剩余 warn 待逐位置对照 |
| X6-log-chatanki-LANE-1 = C2 X6-LP-0140（warn 合计）/ X6-LP-0141（error 合计） | 合计 warn 43 / error 6 | 汇总行，随上述逐文件核验 | 同上 |

### assert-parity（46，计数类 assertion-deficit）

人工线索，未逐条核；按 Rust 原 assert 位置逐条对照后再改，不为凑数补 expect：
`tests/template.test.ts` 18 处（18,27,30,33,36,86,102,108,111,119,174,178,181,184,188,192,204,207）、
`tests/executor-helpers.test.ts` 15 处（108,156,166,233,268,351,407,457,520,674,691,697,785,791,814）、
`tests/mutation-ui-sync.test.ts` 5 处（76,112,191,230,378）、`tests/executor-args.test.ts` 3 处（107,390,399）、
`tests/transform.test.ts` 3 处（41,259,265）、`tests/workspace-read-scope.test.ts:75`、`tests/apkg-import.test.ts:101`。
状态：template 18 条及状态快照 5 条已逐原 assert 核为等价（下表）；AP-0187、
AP-0189 新增真实生产链逐断言回归（待复核）；AP-0197 的原保证与生产调用已核。
其余 20 条未决，其中 AP-0188 已解释计数但生产入口缺失，仍保持 production pending。

#### X6-AP-0188 / AP-0197 合并审读单元

核验起点为 merge main 后 `b2c2b44e2` / main `42a0f9e4a`；仅核本轮指定的两条，
不改实现/原测试/GENERATED，不重开 AP-0187 或 AP-0199–0203，不新增业务测试或 pass 数。
以下 Rust 均为 `src-tauri/src/chat_v2/tools/chatanki_executor.rs`，TS 测试均为
`tests/executor-args.test.ts`；没有发现这两个原测试向量的断言保证缺失。

| ID / 原 Rust assert | 原输入与取值/方向 | 既有 TS 对应 |
|---|---|---|
| AP-0188 `:15240` | query=`  spaced query  ` → search=`spaced query` | `:108–116` 同 query 输入与精确 search 比较 |
| AP-0188 `:15241` | templateId=`  design-swiss  ` → `design-swiss` | `:110,117` 同输入、同 trim 后结果 |
| AP-0188 `:15242–15243` | schedule enum NotEnqueued 且 as_str=`not_enqueued` | `:111,118` 字符串联合成员就是 wire 值，一个 `toBe('not_enqueued')` 同时约束类别与原字符串；无第二个序列化算法可漏测 |
| AP-0188 `:15244–15245` | filter enum ErrorOnly 且 as_str=`error_only` | `:112,119` 同字符串联合表示，`toBe('error_only')` 保两项保证 |
| AP-0188 `:15246–15247` | page=0 → 1；pageSize=999 → 20 | `:113–114,120–121` 相同输入与精确值（未放宽 cap） |
| AP-0188 `:15252–15255` | `{}` → all/all/page1/pageSize20 | `:123–127` 四个原值逐项比较 |
| AP-0188 `:15257–15268` | schedule=`reviewed` / filter=`edited_only` 均解析失败 | `:129–132` 同两个非法值，captureError 非 null，拒绝方向保持 |
| AP-0197 `:18325–18337` | 对 map_only/fill_missing/fill_missing_llm 各验 parsed=对应 enum，且 as_str=raw | `:420–423` 同三值循环，返回类型 `ChatAnkiRetemplateStrategy` 为同值字符串联合，逐次 `toBe(raw)` 合并 enum 与 as_str 保证（实际三次比较，不按一个字面 expect 误判） |
| AP-0197 `:18338–18340` | fill_all_llm 必须解析失败 | `:424` 同非法字符串 captureError 非 null |

表示/归一化源码也已核：Rust library enums `:1219–1265` 为 snake_case，
list struct `:1276–1287` 的 query 是 search alias，normalize `:1292–1301` trim 并夹到
page≥1/pageSize1..20；TS `executor-args.ts:451–486` 在这些原输入上保同值。
本表只解释原向量，不签整个 serde 输入域、数据库过滤或工具输出。

**真正生产调用分层：**

- AP-0197 可达：`index.ts:188` 用真实工厂 → `src/executors.ts:22` 构造
  `ChatAnkiRetemplateExecutor` → `retemplate-executor.ts:368/213` 执行/解析请求 →
  `executor-args.ts:764–770` 调用 `parseChatAnkiRetemplateStrategy` → `:749–750`。
  不是仅因 api.ts 转出而判可达；也不把该解析测试签成完整 owner/LLM/工具链。
- AP-0188 不可据 helper 通过签生产：全 host 精确符号检索仅有定义与该测试中的
  import/四个调用，未见生产直接、别名或函数表引用。`src/executors.ts:19–25`
  的真实 roster 没有库列表 handler；`chatanki-executor.ts:563–566` 支持集不含它。
  tool-metadata 的已知名称及 library-output/errors 中 guidance 只是词表/文案，不是接线。
  因而计数疑问虽已解释，原 TESTMAP 此项仍不能被当作真实库卡列表生产保证。
  这是本 lane 自有 C3 未实现入口，不虚构上游 API 缺口、不在审读授权内新增 handler；
  向 C1 按原 ID 交接，保持 GENERATED 不动。

#### 后继授权 C3 库列表入口：公开面不等价，精确交接

- 已按授权先核原 Rust `:3562–3653` 调用链及 storage `:7604–7725`，与真实 L16
  `api.ts:296` / `src/service.ts:99–113` 逐项比较。不是泛称无上游；现方法确实存在，
  但委托 UI filtered 查询。跨session库读、存活条件、默认顺序可匹配；归一化 page/cap20
  和 flat 卡投影可本地适配，不被当作 blocker。
- 不能本地遮掉的差异：Due多了 state!=0；Enqueued在UI无分支退all；diagnostic/error_only
  不在正式参数中、无法在全局COUNT/分页前过滤；页记录不含 dt.document_id locator。
  不假设 sourceId=documentId，不分页后筛选/overfetch聚合/复制SQL或逐卡重查。
- 真实公开 owner 诊断 `20261104231341-19e80d` exit 2（非工具测试/新pass）：
  实库 normal+error 两卡、真实 L15 normal入队state0且due已到，Rust应due=[normal]、
  enqueued=[normal]；现方法实际due=[]、enqueued=[normal,error]。full all/排序正常，
  page只有items/total/statusCounts、无documentId，total:number（小样本未丢精度）。
- 已向 C1 给最小正式agent-page要求（`native-needs.md` §6），包括全局schedule/diagnostic、
  原快照locator、完整u64 total，保持UI旧语义。L15 `getReviewStatesForLibrary('agent',ids)`
  已有且reviewVersion为bigint，无需再造review接口。列表→review错误顺序不能调整。
  total 源为 SQLite COUNT i64，原 Rust 读取后 max(0) 转 u64；owner 须从读取起
  BigInt/文本精确承接，不能先读 Number 再 BigInt。C1 已亲取 exit 2 诊断并确认差异，
  正由架构安排正式 agent page；L24 入口仍未注册/未完成，不补固定失败 handler。
- 该缺口现已具体证实，区别于上个AP审读尚未核owner时的自有handler未实现结论。
  当前不注册不等价的工具/假列表、不声明API已就绪；不向failed/parked owner发执行消息，
  不改GENERATED、C4、scope闭包。接缝到位后才能按新授权补真实入口与完整行为验证。
- L16 已回正式候选 `ca01db015`（API祖先 `6fc4b3e0a`），方法为
  `listAnkiAgentLibraryPage`，不是旧UI方法；待单元/正常main条件，当前不绑定handler。
  后续必须显式传本 lane parser 的 page/pageSize（含默认20），不沿owner可选参数默认12。
  page total/dueMs为bigint、同页locator、sourceRef=null；不复制SQL或逐卡补定位。

#### AP0188/C3 正常main后继：真实库列表入口候选

- C1已核正常main `536aad095` 同时含L16 `931643d80/ca01db015` 与L24 `72063aa7c`，
  本轮merge后实际api/service亦有PreferenceTimestamp与listAnkiAgentLibraryPage；
  旧“owner尚未main”解除，不再等待候选SHA。完整Preference/f32/unknown IgnoredAny/尾部首错仍未决，
  本轮不改Preference源码，不把联合类型已齐当整域签收。
- 生产路径：`index.ts::hydrate`绑定正式L16 agent-page＋L15库状态（类型均Pick公开owner）→
  真实`src/executors.ts` roster 的`ChatAnkiLibraryListExecutor.execute`→原parser→owner列表→
  `getReviewStatesForLibrary('agent', pageIds)`→`convertLibraryRecordForTool`。
  只新增已实现列表，不把词表中的其他library写工具注册为可用。
- 显式传已归一化page/pageSize（含默认20），diagnostic=filter；不继承owner默认12。
  只用同页flat record+locator；投影从locator取documentId，而非sourceId或二次定位。
  原`total:bigint`直接进内部输出；owner dueMs保持bigint、不新增Rust无的flat dueMs输出；
  reviewState沿L15 canonical结构/reviewVersion bigint。无SQL复制、分页后过滤/拼页或Number伪恢复。
- 错误顺序与Rust `:3562–3653`：parser错误原prefix→缺DB原key→列表SQL原prefix→
  完整review AppError（包括NotFound，不按session错误扁平化）→投影；ratingAvailableToAgent顶层/卡片均false。
  全分支表、边界/时钟/日志/权限说明见SPEC该节；未知能力缺失分支仅源码审读，不冒称本轮全动态覆盖。
- 新`tests/library-list-real-host.test.ts`真实chatankiTools入口10例：AP0188原14语义保证、
  实际默认20页长、过滤在COUNT/OFFSET前、created/id排序及空页、state0 Due/Enqueued等schedule、
  locator/版本/截断与真实rate日志、total/owner due/版本整数、跨session读而session写仍拒绝、
  parser→真实SQL列表错→真实review Database/竞争删除NotFound错误顺序。
  所有成功页均来自真实L16，review错误来自真实L15；spy为call-through观察，NotFound竞争用真实公开repo删除。
  旧helper测试/GENERATED均未改，不把旧双enum/as_str的表示合并计数误认成缺两保证。
- 首跑 `20261105024147-dbe060` 原exit1 / 10failed（未实现roster/入口），
  修后Node `20261105024344-55bf86` 原exit0 / 31passed（3files，新10），
  typecheck `20261105024344-f08a06` 原exit0；Electron `20261105024740-9a49ca` 原exit0 / 新10passed。
  日志均无单列Errors行。测试自动检查点`ed7aad077`；handler/hydrate/roster/投影源码`9cb472cc1`，
  当时公共api hunks仍未提交，交付必须取包含后继api/文档的完整tip，不单取中间WIP。
- ledger `20261105024740-9f2fdf` 原exit0：commands1058 A100%，tests8109 A87.8%/B1.9%，
  command/test/orphan问题均0；prod-reachable unreachable14（unknown3632，not vetoed）。
  wiring `20261105024740-4bb51c` 原exit0：ported0、所测模块未从index接入0（0%）。
  不据此修改旧PORTED计数或签全C3；最终tip官方§5结果另据原回执交C1复验。

#### AP0188/C3 后继修正：library-only from_value 访问顺序与起始计时

- C1后继审读发现旧parser并未覆盖整个入站域：search/query同现静默选search、拒绝全部序列/
  unit-enum map、先预扫unknown再schedule/filter导致首错抢先；新入口计时也晚于info/start。
  这些均为实际本lane缺陷，不以原14保证/十例/旧c2d绿测反证或扩称全typed已完成。
- 仅改`executor-args.ts::parseChatAnkiListLibraryCardsArgs`所需libraryList*路径，
  其它工具的requireObject/denyUnknown/unitVariant/optionalU32完全不动；不复制scanner，
  不JSON.parse/stringify重串行化已解析Value。复用kernel unexpectedOf/oneOf文案原语。
- map按Object.entries输入顺序逐字段解码，query/search共用seen search（含首值null），
  重复仅到第二字段时判定；更早非法值仍先报错。unknown也是到该字段时失败，
  错误不附from_str行列/字段path，unknown列表按derive的字段顺序及sorted aliases（query在search前）。
- 六槽序列依Rust声明顺序读取search/templateId/schedule/filter/page/pageSize，
  逐槽decode而非先验全部长度；中间enum的serde(default)可用于缺槽，但Option page/pageSize仍需槽位。
  例[null,null]在slot4报invalid length4；多余元素仅在前六槽全部成功后报from_value fewer elements in array。
- library enum接string或单键map+null：先验证单键、再variant、最后unit payload；
  双键/空map、未知variant+非法payload、非null payload分别保原错误优先级。u32只在本decoder
  沿locked arbitrary_precision Value→Number typed parse，数字负值/溢出/小数报invalid number，非数字保expected u32。
  依据Rust struct`:1276–1304`、serde_derive1.0.228 `de.rs:451–505,805–835`、
  `de/struct_.rs:55–84,125–129`、serde_json1.0.149 `value/de.rs:169–209,234–265,328–346,482–495,556–560`、
  `number.rs:582–598`；版本见Cargo.lock。此为源码对照+真实Host测试，未运行Rust差分，不签未覆盖的完整域。
- `library-list-executor.ts::execute`现先performance.now再begin（info/start），对齐Rust`:1873–1883`；
  不改其它入口/时钟框架。可控monotonic oracle让info/start各消耗40/60ms，原duration0，现精确100ms。
- 原十例及helper原14语义保证断言全部保留，追加25个真实chatankiTools入口case。
  修前 `20261105033503-7393c2` 原exit1 / 25failed、10标题过滤未执行（日志显示skipped，非runtime豁免）；
  修后Node `20261105033714-a84f1c` 原exit0 / 3files56passed（其中本文件35），
  typecheck `20261105033714-33ce83` 原exit0；Electron `20261105034100-45a83e` 原exit0 / 35passed。
  均无单列Errors行。计时/新增回归由自动检查点`29b155fd3`保存；该点尚不含未提交parser，须交完整后继tip。
- ledger `20261105034100-4b380b` 原exit0：commands1058 A100%，tests8109 A87.8%/B1.9%，
  command/test/orphan问题皆0；unreachable14/unknown3632 not vetoed。wiring `20261105034100-8931ff`
  原exit0：ported0、未index接入0。最终提交后一次官方§5收尾；旧c2d/9df回执保留为历史，
  不覆盖新修复。Preference/f32/其它工具完整域/未实现library mutations及GENERATED均不扩大。

#### X6-AP-0199–0203：完整对象比较已保留 tuple 的各字段保证

本单元仅人工审读，无代码/测试更改、无新增执行或 pass 数，不重跑已签集合。
生产链为 `index.ts → createChatAnkiExecutors → ChatAnkiStatusExecutor.execute` →
`status-executor.ts:88` 调用 `deriveStatusSnapshot`，`:90` 调用 workflow 投影；
这些不是前述 wait/pipeline 的未接线 helper。以下 Rust 行均为 `chatanki_executor.rs`，
TS 行均为 `tests/executor-helpers.test.ts`：

| 稳定 ID | Rust 原断言 | TS 原有对应（取值/方向不变） | 结论 |
|---|---|---|---|
| X6-AP-0199 | `:18673–18678` not_found / Some(statusNotFound) / retry=true | `:692–694` 完整对象 status='not_found', error=原 key, shouldRetry=true | 三字段均已覆盖 |
| X6-AP-0200 | `:18685–18687` Pending→running/null/false；`:18695–18697` Failed+两卡→completed_with_errors/null/false；`:18701–18703` Failed+空卡→error/null/false | `:698–699,705–709` 同三组状态/卡数场景、三个完整对象，各同时比较 status/error/shouldRetry | 九项均已覆盖 |
| X6-AP-0201 | `:18882–18884` Cancelled→cancelled/null/false | `:786–788` 完整对象三个字段同值 | 三项均已覆盖 |
| X6-AP-0202 | `:18895–18899` limit-cancel→completed/null/false、limit=true、userCancelled=false；`:18902–18904` workflow=completed、issues/warnings空 | `:795–803` 完整 snapshot 三字段、两个标记判断、workflow/两个空数组原比较 | 八项均已覆盖 |
| X6-AP-0203 | `:18924–18926` Paused→paused/null/false | `:815–817` 完整对象三个字段同值 | 三项均已覆盖 |

以上只解释 AP 静态 expect 差额，不签 `chatanki_status` 的 DB/事件/错误全分支，
不替代手动 scope 或 worker 生命周期的独立验证，不改 GENERATED TESTMAP。
AP-0202 的 marker 也已核字面值：Rust `:13818` 与 `workflow-status.ts:10`
均为 `GLOBAL_CARD_LIMIT_REACHED`，不只依赖测试导入同一常量的自洽。

#### X6-AP-0189 / C3：worker scope 跨 owner 接线修复

- 真实缺陷：L04 `chat/src/workspace-run-agent.ts:304,534` 已调用 L05 公共
  `installWorkspaceCardReadScope`，并在 `:626,743` release；L24 却有自己的 Map / guard，
  所以 production worker 的只读授权对 get_cards/status 不可见。L05 API `:91–94`
  早已公开权威注册表，不是缺接口，不能继续用本 lane fixture 的 Map 证明整链。
- 已删除 L24 重复 Map / installer / guard，`card-access.ts` 仅从 L05 `api.ts`
  消费 `workspaceCardReadScope`。写路径 verify/load/CAS 原会话所有权不变，不读 scope。
- 原五个测试改从 L05 公共入口安装，用 owner `release()` 清理；原输入/断言全部保留。
  这五条仍使用 `CardStoreDouble`，不能扩称全 scope 已无替身；真实仓储/工具证据仅指下述新增用例。
  新 `tests/workspace-read-scope-real-host.test.ts` 在真实 L16 仓储上保 Rust
  `chatanki_executor.rs:16349,16359–16368,16378,16384` 六项保证：实际插入、scope 读放行、
  两种写预检拒绝、真实 CAS NotFound、原 front 不变；另经真实 get_cards/update_card
  验读允许而写拒绝、完整 owner 行不变、release 后读拒绝。无卡片/scope provider 替身。
- 先前 `20261104220135-b55138` exit 0 / 6 passed 使用的是本 lane installer，不能证明
  L04/L05 接缝。新回归切到 L04 同一个 L05 公共安装入口后，修复前
  `20261104220756-84468e` exit 1 / 1 failed，准确抓到只读授权被错误 statusNotFound 拒绝；
  修复后 `20261104220953-a19d15` exit 0 / 9 passed（4 files），typecheck
  `20261104220954-71a28d` exit 0，无单列 Errors 行。
- 本例手动安装 trusted scope 与原 Rust 相同；完整 worker 创建/取消/异常动态生命周期
  未由此用例执行，不签全部 C3，不改 GENERATED TESTMAP，不改 C4 提交闭包。
- 提交前完整检查：`20261104222014-9550d2` exit 0 / 407 passed（49 files）；
  `20261104220954-71a28d` typecheck exit 0，`20261104221053-aa8c48` importable ok / exit 0；
  完整/strict 边界、ledger 和 wiring 均 exit 0。日志无单列 Errors 行。
  ledger 的全仓 unreachable 16 / unknown 3635（not vetoed）提示原样保留，非本项签收依据。

#### AP0189/C3 后继日志子项（权限/注册表不重写）

- Rust `chatanki_executor.rs:1783–1789` 的查询异常 warn 与 `:1826–1832` 的 scope-hit
  info 原先仍漏。`resolveChatankiReadSession` 现接受已有 warn/info 出口，get_cards
  与 status 均传 `ctx.warn/ctx.info`；不造全局 logger。Info 只在 caller 校验失败、
  真正 coordinator scope 匹配后发一次，原文字段顺序 worker/workspace/coordinator/document 保持。
- `verifyDocumentOwnershipOk` 改用既有 verifyDocumentOwnership 后转换成功/失败（对应 Rust `.is_ok`），
  一次查询、只由既有 catch 记一次 warn；false 结果不记 warn，异常仍继续原下一 scope 分支。
  caller-owned 短路、无 scope、拒绝、持续错误的 statusNotFound 和查询次数不变。
- 新 `tests/workspace-read-scope-logs-real-host.test.ts` 从真实 L07 注册 wrapper / L04
  snake_case context 进入 get_cards/status，index 原 Host logger 由 Cordis exporter 观察；
  不注入日志替身 callback。卡片/复习/L04 UI 读取为真实 provider，UI/save 回调仍仅观察。
  DB one 仅原参数原结果透传观察，用测试私库列重命名制造真实 SQLite 异常，未替换仓储语义。
  主句柄 ownership trace 显式区分预检与 get_cards 原有快照重验，不将其冒称整个 L15 SQL trace。
- 每个读工具分别验：直接拥有（即使有无关 scope 也不报 hit）、合法 scope info 字段/顺序、
  scope 拒绝无 warn/info、无 scope 仅一次检查、无 scope 异常仅一次 warn、两次持续查询异常
  各一次 warn 后拒绝，以及首错后真实 schema 恢复再进入 coordinator 分支。没有为日志多查、
  双重 warn 或放宽权限；tool start/终态/save 次数一并核。
  首错后的 schema 恢复由测试观察器触发，仅用于验证原下一分支次序，不是新增业务重试/恢复机制。
- 修复前 `20261104234905-27de6e` exit 1 / 6 failed + 4 passed（尚未加无scope两组），
  抓到缺 info、缺 warn 及无法按 warn 时序进入恢复分支；修复后
  `20261104235711-c837be` exit 0 / 20 passed（3 files，其中新日志14、旧scope真实1+替身5）。
  `20261104235113-14830c` typecheck exit 0；无单列 Errors 行。旧六项写拒绝/CAS/原行不变
  断言未删改且本次保留运行通过。不据此签全部 C3/worker生命周期或 AP0188 库列表。
- 完整预检 `20261105000326-7ef60e` 原 exit 1 / 420 passed + 1 failed，新日志14条均通过；
  唯一失败是未改的 `real-review-enqueue.test.ts` 在重负载下触发原30秒测试超时。
  最小区分 `20261105001834-6e9a6b` 原 exit 0 / 1 passed（约7.5秒），未修改该文件的
  任何断言/超时，不把单文件通过改报成完整预检通过。普通/strict边界、ledger、wiring、
  importable 均 exit 0；日志无单列 Errors 行。提交后以官方 gate 当前回执另行判断。

#### X6-AP-0187：owned snapshot 的真实生产入口增量

- 原 Rust `chatanki_executor.rs:15084–15137` 不只是数组分页，还实际插入/读取 owned
  snapshot。旧 `executor-args.test.ts` 覆盖数组结果，却不能证明 owner setup/读取。
- 新 `tests/owned-snapshot-real-host.test.ts` 经公开 L16 documents/cards 建库，再经
  `chatankiTools.execute(get_cards)` → hydrate → 真实 L16 owned read / L15 review read。
  不注入 cards/reviewStates，保留原五卡、error/edited 标记及顺序输入。
- 全部原 16 个 assert 均有逐行注释对应：实际 inserted=5；first total=5、len=2、
  ids=1/2；final len=1、id=5；past-end 空；error total=2、ids=2/4、原始 index=2/4；
  edited total=2、ids=3/4。每次公开工具调用另验 success，不用新增数量掩盖缺失场景。
- `20261104184905-218327` exit 0 / 17 passed（2 files，新真实用例 1），无单列 Errors 行。
  旧 helper 测试及其所有断言保留；尚未改 GENERATED TESTMAP 去向或宣称独立复核签收。

#### AP 核差中的生产可达缺口（不按 expect 数误判）

核验 `0a18bca11`：下列 helper 仅有定义/测试调用（经 `rg` 查调用点），
不能因为断言字面数量可解释就签生产等价，也不为过可达扫描新增无意义调用：

| 稳定 ID | Rust → TS | 当前结论 |
|---|---|---|
| X6-AP-0198 | `chatanki_executor.rs:18583–18615` → `tests/executor-helpers.test.ts:108–127` 的 `isChatAnkiTool` | 循环含原 30 个 true 与 1 个 false（另加 builtin set_suspended）；但 helper 无生产调用，真实工厂仍不宣称 run/start/wait/control/sync 等未实现入口。完整原 `test_can_handle` 生产保证 pending，不能复制表扩大 canHandle 冒充实现 |
| X6-AP-0204 | `:18930` → `block-timing.ts::decideWaitTimeoutStatus` | 三个完整对象覆盖 Rust 六个 tuple 字段断言，但 helper 尚未由生产 wait 调用；wait 阻塞仍在 C3 |
| X6-AP-0207 | `:19138–19147` → `tests/executor-helpers.test.ts:351–358` | 同 8 个原文片段已在循环断言；`prompts.ts::buildImportPrompt` 当前无生产调用，真实 VLM full 入口仍待 L02/L16 |
| X6-AP-0211 | `:20716–20744` → `tests/executor-helpers.test.ts:166–173` | 四个 timeout 场景已覆盖；Rust 两个 as_str 断言由 TS 返回原生 'idle'/'total' 字符串合并覆盖。但 helper 无生产调用，pipeline 阻塞仍在 C3 |

这四行当前 TESTMAP 去向仍显示 ported，与上述审读不符。按本任务不得修改 GENERATED 区
的约束，未直接改 TESTMAP；已向 C1 请求按原 ID 校正为 pending，绝不整文件降级。

#### X6-AP-0215–0232 逐断言核验（核验起点 `48063ba9b`）

以下 Rust 位置均属于 `src-tauri/src/chat_v2/tools/template_executor.rs`，
TS 位置均属于 `tests/template.test.ts`。未改测试或业务，未执行新测试，不新增 pass 数。
这些用例仍经原生产 executor/解析器路径；本表只消除计数差额的疑问，不签整个模板 CRUD 整链。

| 稳定 ID | Rust assert → TS 对应语义 | 结论 |
|---|---|---|
| X6-AP-0215 | `:1702–1709` 8 个 builtin 工具均 true → `:19–20` 同 8 值循环、每值 `toBe(true)` | 已覆盖 |
| X6-AP-0216 | `:1722–1724` list/get/preview 均 true → `:28` 同 3 值循环 | 已覆盖 |
| X6-AP-0217 | `:1730–1733` 4 个无关工具均 false → `:31` 同 4 值循环、`toBe(false)` | 已覆盖 |
| X6-AP-0218 | `:1788–1789` errors/warnings 都为空 → `:34` 整个二元组 `toEqual([[], []])` | 已覆盖 |
| X6-AP-0219 | `:1814–1819` 非空 errors + 含 name/fields/frontTemplate/backTemplate/generationPrompt → `:38–40` 非空 + 同 5 字段循环 `some/includes` | 已覆盖 |
| X6-AP-0220 | `:1994–2028` 4 low、4 medium、delete high → `:87–89` 同 9 工具/方向/值 | 已覆盖 |
| X6-AP-0221 | `:2108–2111` active=true、另 3 字段 None → `:103` 完整对象 true/null/null/null | 已覆盖 |
| X6-AP-0222 | `:2125–2126` active=false、query=cloze → `:109` 同 2 字段对象比较 | 已覆盖 |
| X6-AP-0223 | `:2151–2162` expected_version/name/note_type/front_template/generation_prompt/css_style/is_active/is_built_in/preview_data_json 9 值 → `:115–117` 同 9 字段 `toMatchObject` | 已覆盖 |
| X6-AP-0224 | `:2176–2178` expected_version=2.1.0、note_type=Basic、front_template={{Front}} → `:120–121` 同 3 字段比较 | 已覆盖 |
| X6-AP-0225 | `:2392–2405` Err 且含 fields[0]/字符串 → `:175–176` 两个 `toThrow(子串)` 同时验证抛错和内容 | 已覆盖 |
| X6-AP-0226 | `:2417–2425` Err 且含 fields[1] → `:179` `toThrow('fields[1]')` | 已覆盖 |
| X6-AP-0227 | `:2437–2443` Err 且含 字符串数组 → `:182` `toThrow('字符串数组')` | 已覆盖 |
| X6-AP-0228 | `:2458–2468` Err 且含 name/字符串 → `:185–186` 两个 `toThrow(子串)` | 已覆盖 |
| X6-AP-0229 | `:2480–2493` Err 且含 isActive/布尔值 → `:189–190` 两个 `toThrow(子串)` | 已覆盖 |
| X6-AP-0230 | `:2504–2512` expectedVersion=true 时 Err 且含 expectedVersion → `:193` 同输入 `toThrow('expectedVersion')` | 已覆盖 |
| X6-AP-0231 | `:2556–2561` noteType=42 时 Err 且含 noteType → `:205` 同错误字段/值 `toThrow('noteType')` | 已覆盖 |
| X6-AP-0232 | `:2580–2588` isActive='true' 时 Err 且含 isActive → `:208` 同错误字段/值 `toThrow('isActive')` | 已覆盖 |

C2 冻结报告 `0119143715c0` 稳定 ID 映射（源码基线 `2ee9a9cbe`；原文 `.oc-runs/messages/C1-app-2026-11-04T124916977Z.md` L511–L556）。
上面的逐文件行号即这些条目；不重编号，状态同上（template 18/状态快照 5/AP-0197 已核、AP-0187/0189 真实回归待复核、其他 20 未决含 AP-0188 生产缺口），组合 assert 不机械补 expect：

| C2 ID | TS 位置 | Rust `#[test]` |
|---|---|---|
| X6-AP-0187 / 0188 / 0197 | `executor-args.test.ts:399` / `:107` / `:390` | `chatanki_executor.rs:15084` / `:15229` / `:18324` |
| X6-AP-0189 | `workspace-read-scope.test.ts:75` | `chatanki_executor.rs:16345` |
| X6-AP-0190–0194 | `mutation-ui-sync.test.ts:76,112,191,230,378` | `chatanki_executor.rs:17004,17053,17160,17215,17460` |
| X6-AP-0195, 0196, 0198–0208, 0210, 0211 | `executor-helpers.test.ts:407,457,108,691,697,785,791,814,156,233,268,351,520,674,166` | `chatanki_executor.rs:17680,17768,18583,18671,18682,18879,18888,18921,18930,19028,19091,19138,19812,20685,20716` |
| X6-AP-0209 | `apkg-import.test.ts:101` | `chatanki_executor.rs:20542` |
| X6-AP-0212–0214 | `transform.test.ts:41,259,265` | `chatanki_transform.rs:882,1314,1326` |
| X6-AP-0215–0232 | `template.test.ts:18,27,30,33,36,86,102,108,111,119,174,178,181,184,188,192,204,207` | `template_executor.rs:1700,1720,1728,1763,1793,1992,2106,2122,2134,2166,2380,2410,2430,2451,2473,2498,2542,2566` |

C2 本 lane 无 SW / UD / PR 条目；本节 `X6-decode-chatanki-*` 为 C1 清单自编 ID（C2 未列入，保留）。

## 2026-11-04 v2 接手盘点（Linux 续作，基线 `572986d4e`）

本节优先于下方旧会话的完成自述。已合并 main；未改复核人文件。
初次接手基线曾缺 `ACCEPTANCE.md`，当时依据派发 C1–C7 清单工作并请求恢复。
当前该复核人文件已在 main，保持只读；最新窄签收以其末尾表及 C1 指令为准，
不再把报告缺失当作当前阻塞，也不自行补写验收结论。`BLOCKERS.md` 记录剩余依赖。
286 行旧 TESTMAP 是待复核映射，不等于 v2 证明。

八类缩写：接线 / 所有权 / 数据 / 日志错误 / 测试 / 分支 / 运行时 / 签收。
“待核”不是完成，也不是外部阻塞。

| 命令/模块 | 问题类型与审读结论 | 证据（本目录相对路径，除另注） |
|---|---|---|
| `chatankiTools.execute`、L07 包装器 | 接线：已共用 hydrate；数据：`adaptContext` 仍有双重断言待核；签收：C1/C2 未签 | `index.ts:215–245,254–325`；`tests/real-host-wiring.test.ts:29–99` |
| `template_list/get/create/update/fork/delete/set_default` | 接线（WP-119）：`hydrate` 注入公开 `anki.templates`（`index.ts` templates 字段），无 mainDb/ankiDb 时 executor 经 `TemplateStore` 走同一 L16 仓储，set_default 经 `settings.saveSetting('default_template_id')`（F4 同 SQL）；原 TemplateDatabase 路径不变。真实回归 `tests/template-executor-real-host.test.ts`（正式插件安装 + L16 IPC 交叉读回：成功/缺失/stale/真实 SQL CAS 竞争/内置软删墓碑/user_modified/set_default）。与 Rust 仍有差异、需 L16 补公开方法（见 BLOCKERS）：空库自动导入内置、update 合并后再校验与同版本号归一、delete 计数失败致命及引用卡额外 warn、故障文案前缀；日志：delete/软删内置/set_default 三条 info 已补 | `src/template-executor.ts` getDb/TemplateStore/remove/setDefault；Rust `template_executor.rs:191–198,734–1630`；L16 `anki/src/template-service.ts` |
| `template_validate/preview` | 接线可达；数据：JSON 先转 unknown 再校验，但错误文本与 serde 有差异；测试以 helper 为主，需补生产入口；其余待核 | `src/template-executor.ts:148–174,324–338,469–512`；`tests/template.test.ts` |
| `fsrs_get_settings/update_settings` | 接线：真实 review scheduler 已 hydrate；运行时使用单调时钟；测试有真实迁移库；分支/日志需 v2 逐条证据 | `index.ts:414–423`；`src/fsrs-settings-executor.ts:153–164`；`tests/fsrs-settings.test.ts` |
| `chatanki_analyze` | C6 无 manager 合法回退已保留；有 manager 缺 planner/refs 仍外部阻塞；数据：analyze 参数解码已对齐 serde_json from_value 文案（无字段路径、按输入键序首错、数组位置形态、snake_case 键忽略），回归见 `tests/analyze.test.ts`；运行时：`src/` 全部 116 处 JS trim 已换为平台 `rustTrim*`（不去 U+FEFF、去 U+0085），回归见 `tests/v2-decoders.test.ts` | `src/chatanki-executor.ts:49–70,126–179,220–294`；`src/routing.ts:132–144` |
| `chatanki_list_templates/check_anki_connect/review_stats` | 已有生产入口与部分真实 L16/L15 测试；日志/分支/数据待逐条核对，不能仅因绿测勾完成 | `src/chatanki-executor.ts:297–370,451–508`；`tests/real-host-wiring.test.ts:70–99` |
| `chatanki_get_cards` | C7 错误分流已修；测试卡片仍替身，真实 ownership/CAS 链 pending；其余待核 | `src/get-cards-executor.ts:24–39,63–137`；`tests/real-host-wiring.test.ts:128–137` |
| `chatanki_update_card/delete_card`、偏好设置 | 所有权：经 L16 API，无生产 SQL 写别人表；数据：PreferenceStore 已按 serde 逐字段解码（必填/enum/u32/i64，未知键忽略），warn 文案对齐 rs:11077；测试以 Double 代替 L16 主体，不可签真实持久化 | `src/mutation-executor.ts:106–150,183–387`；`src/preference-memory.ts:17–28`；`tests/preference-memory.test.ts:15–155` |
| `chatanki_retemplate` | 所有权/CAS 经 L16；Phase2 消费公开 L02 llmRawPrompt，真实成功写回、解析失败不回滚 Phase1、请求期间竞争编辑的 CAS 冲突已回归；其它错误/完整工具签收仍 pending | `src/retemplate-executor.ts:209–363`；`tests/retemplate-model2-real-host.test.ts`；`TESTMAP.md:82–97` |
| `chatanki_enqueue_review/undo_last_review/set_suspended` | enqueue 有真实迁移库；后两条 scoped CAS 未在 review API 发布；D3 参数不新增 safeInteger 拒绝；内部版本精度仍需真实提供方签收 | `src/review-executor.ts:109–239`；`tests/real-review-enqueue.test.ts`；`tests/review-executor-real-l15.test.ts` |
| `chatanki_status`、块同步 | 生命周期与终态 error 已补；L04 真实整链未签；运行时：stateRevision 已改为 Rust 同款微秒墙钟（rs:95–104，`tests/v2-decoders.test.ts`） | `src/status-executor.ts:58–135`；`src/workflow-status.ts:20–27`；`src/block-reap.ts` |
| `chatanki_export` | JSON 库卡/文档选择器已补真实 L16 卡读取+文件 sink 回归，保权限差异与整批失败；APKG exporter 未发布，不可宣称完整 | `src/chatanki-executor.ts:394–466`；`tests/export-real-host.test.ts`；`native-needs.md:207–230` |
| `chatanki_import_apkg` | L04 sessionResources/L11 VFS/L16 importer 未 hydrate；超限预检已有，真实整链 pending；哈希/同步 IO 是否阻塞待核（自有） | `src/apkg-executor.ts:68–138`；`src/apkg-import.ts`；`index.ts:394–399` |
| `chatanki_transform` ops | 异步常量/capture 已统一真实 F7 完整原文预分配检查，JS 常量拼接及后置 fallback 删除；八向量/参数域/真实工具首越界和旧超长例外已回归。同步 helper UTF-8 计数已修，但同步 provider/整 C4 尚未签 | `src/transform.ts::boundedRegexReplaceAsync/expandedReplacementLength`；`tests/regex-projected-real-host.test.ts`；Rust `chatanki_transform.rs:550–594` |
| `chatanki_transform` script | 运行时：wait 抛错绕过 cleanupResources；计时在 await spawn 后才开始，漏 spawn 时间（自有）；硬隔离 F7 未合 main，七条 e2e 保持 pending | `src/transform-script.ts:1079–1131`；Rust `chatanki_transform_script.rs:1149–1188` |
| `chatanki_run/start/wait/control/sync` | 未注册，不冒充生产完成；缺 L16 streaming/document processing、L02 图像调用；六条 helper 测试仍 pending；本 lane 后台编排在接口发布后仍须完成 | `src/chatanki-executor.ts` 工具分派；`native-needs.md` 第 5 节；`TESTMAP.md:111,124–128` |

排雷顺序：先修 C4 中本 lane 可独立修复的分配顺序，以及 script wait 清理/
计时错误并加生产入口回归；再逐项核对 serde、日志、Unicode trim 与偏好解码。
外部能力不得用 Double 或未合入分支冒充。C1/C5/C7 的已修项交复核人重验；
C2/C3/C4/C6 的真实外部缺口列于 BLOCKERS。旧 `service-wiring` 之外已存在真实
L16/L15/L07 boot 测试，仍须明确其替身边界。SPEC 的 L16 实际名已是 `anki`。

基线检查已入队：typecheck `20261104093120-fb501a`，插件全量
`20261104093120-1ea5d6`；结果未取前不称绿。

服务入口：`index.ts` → Cordis `ctx.chatankiTools`（`chatankiToolsService@1.0.0`）；接口先行提交于 `api.ts`。
执行上下文事件、块持久化仍归调用方，类型对应 Rust `ExecutionContext` 的同名效果。

依赖对齐：`api.ts` 的 `SchedulerService` 是 L15 `FsrsReviewService` 的最小调用面，
`TemplateDatabase` 是 L16 模板数据库调用面；发布接口时工作树尚无这两条 lane 的 `api.ts`。
`get_then_update_roundtrip_on_migrated_db` 必须等 L15 的真实调度服务接线后移植，
不以测试替身替代其「迁移后的真实数据库」断言。

脚本沙箱：`runTransformScript` 不自己实现 Seatbelt/bwrap/AppContainer，而是消费
`api.ts` 的 `TransformSandboxBackend`（L05 shell_sandbox 的调用面：capability、
effect report、command/cwd/policy/env 交给后端封装、进程组终止与清理）。job 目录、
环境变量白名单、有界日志捕获、超时看门狗、输出文件闸门都在本 lane 内实现并有测试。
`chatanki_transform_script.rs` 的 7 个 `e2e_*` 测试断言的是真实硬沙箱行为
（断网、job 外文件不可读、符号链接输出拒绝），必须等 L05 后端与 F7
`nativeSandbox` 发布后才能移植；L05 adapter 已合 main，F7 仍未合；
`tests/transform-script.test.ts` 里另有 4 个编排测试用主机进程后端覆盖
超时/清理/输出读取路径，但不替代硬沙箱断言。

已知差异：脚本 `spec` 的 serde 错误文本按 serde_json 结构重建（`unknown field` /
`invalid type` / `missing field`），JS `JSON.parse` 的语法错误文本与 serde_json 不同；
输出合同、Cloze 校验与所有大小闸门的错误文本逐字对齐 Rust。
转换正则经 F7 异步 `nativeRegex` 编译（Rust regex 方言）。生产 `chatanki_transform`
调用 `compileTransformOpsAsync`/`planTransformOpsAsync`，直接消费 F7
`NativeRegex.compile/findIter/replace`；测试也使用同一真实引擎，不再保留 JS
`RegExp` 替身。L16 的同步纯函数 API 仍保留 `ChatAnkiNativeRegex` 同步边界。
`chatanki_transform` 已接入 `ChatAnkiExecutor`：ops 模式要求注入 F7
`nativeRegexAsync`（或同步兼容边界），script 模式要求注入 L05
`transformSandbox` 与会话 `transformTempRoot`；缺失时结构化拒绝，不静默降级。

## 2026-11-04 新会话续作：当前状态与下一步（08:40Z）

本会话先合并 main 得 `870e1b258`，最终再合并 main 得 `6f2c05b68`（HEAD），
未重做任何已提交工作。

- **当前状态**：TESTMAP 286 行中 244 ported / 42 pending。最终 typecheck:host
  作业 `20261104091559-009a02` 退出码 0；ledger `20261104092154-4e17d3`
  退出码 0（commands/tests 0 problems）；boundaries
  `20261104091559-869a04` 退出码 0（0 violation，169 suppressed）；
  `migration:wiring -- --lane host/plugins/chatanki` `20261104091259-d09681`
  退出码 0（0 未接入），全局 wiring `20261104090225-0c2e04` 仅其他 lane
  memory 13 条；strict boundaries `20261104091259-09d521` 退出码 1，仅
  `host/plugins/vfs` 的 4 条其他 lane violation，本 lane 0。本插件全量测试
  作业 `20261104091559-35d2d7` 退出码 0（39 passed files / 2 skipped files，
  356 passed / 12 skipped tests；skip 的是 L05 候选 8 条 + L16 候选 4 条）。
- **剩余 42 行全部为跨 lane 证据缺口，且均有明确提供方**：
  27 行 L16 卡片/文档仓储 CAS/事务/ownership（`ds-mig/L16-anki` 分支提供，
  main 未合）、2 行 L02 routed/model2 raw prompt、6 行 L16 生成管线服务、
  7 行 L05+F7 真实硬沙箱（Linux 候选已跑通；L05 adapter 已合 main，F7
  `nativeSandbox` 未合，macOS/Windows 未实测）。
  没有可只在本 lane 内完成的 pending 实现。
- **复核“必须修复”剩余项**：C2 的完整 hydrate 组合（模板 CRUD 的 mainDb/ankiDb、
  refs/planner、sessionResources）随 L16/L04 提供方未合 main 仍不能签收；C3 的
  run/start/wait/control/sync 与 APKG 导出仍随 L16 管线/导出服务缺口保持 pending
  （i64 语义已按 D3 修正）；C4 的 capture 展开分配前闸门等待 F7
  `replaceAllProjected`，真实 L16 仓储替换等待 main 合入；C5 的 info→start 顺序
  已修；C6 需要真实 L02 planner/refs 接线；C7 的 L16 卡片链同样等待 main 合入。
- **下一步顺序**：
  1. ~~F7 `replaceAllProjected` 精确契约~~：已写入 `native-needs.md` 第 1 节
     （输入/输出、`limitBytes`、首越界 bytes、饱和累加、u64/WASI32 计数、
     完整原文捕获展开、8 条验收向量，含 F7 的
     `(?P<suffix>\Bb)`/`xbZ`/limit 3 → bytes 4 向量）。F7-native 09:11Z 明确
     当前产物/公开 API 缺 `captures_iter`/`captures_at`/`replace_all_projected`，
     仅向 C2 提交最小 `regex 1.12.3` 绑定请求；定向作业
     `20261104085248-b0844d`/`3a495c` 只证明原文上下文与现有展开。`api.ts`
     的可选声明仍只作请求，生产 capture 展开 fallback 继续标缺口，不据此
     签收 C4。
  2. ~~L16 `deleteCardForSession` 候选复核~~：已提交
     `tests/candidates/l16-anki-delete-cas.test.ts`（provider HEAD
     `68a71d248`、blob 见 README），经 `chatankiTools.execute` hydration 驱动
     真实 L16 仓储；作业 `20261104085554-c90c0c` / `20261104085715-c0761e`
     均退出码 0（4 tests）。main 上自动 skip，不计 TESTMAP ported。
  3. ~~复查 APKG 导出/Pipeline 的 L16 服务面~~：APKG 导出器仍未在 main
     `anki/api.ts` 发布，已把精确签名/路径/模板/报告语义写入
     `native-needs.md` 第 3 节；Pipeline facade 的精确方法/事件通道写入第 5 节。
     生产继续显式失败，不写假文件，也不注册五条 pipeline 命令。
  4. 重跑 typecheck/测试/ledger/wiring/boundaries，更新 TESTMAP 与报告。
  5. L16/L05 合入 main 后先 merge，再替换 `CardStoreDouble` 主体、恢复
     TESTMAP ported 并重跑真实提供方测试。L05 adapter 已合入 main（blob
     相同），L16 仍未合入。

## 2026-11-04 C1 07:19Z 续作（D3 + L05）

- **D3（expectedReviewVersion）**：删除 `integerValue` 的 `Number.isSafeInteger`
  门槛。Rust 该字段是 `i64`（chatanki_executor.rs:1180/1205/1362/1380），
  线上 JSON 数字沿用 Tauri 已有精度边界；本 lane 不再因超过 2^53 新增
  Validation。新增 `i64Value` 只用 BigInt 做 i64 上下界校验，解析后的 number
  原样传给 L15/L16 公开 CAS，不做 `Number(BigInt)` 截断。`MAX_SAFE+1` 拒绝
  断言已替换为有效大整数 `2^63-1024` 的解析/委托测试，并保留 `2^63` 越界拒绝。
- **L05（transform sandbox）**：消费 L05 发布的 `agentTransformSandbox`：
  `hydrate` 注入 `ctx.transformSandbox`；`capability()`/`spawn()` 均按异步
  契约 `await`，capability 拒绝映射 `sandbox_unavailable`，spawn 拒绝映射
  `setup`，并透传 L05 的 pid/streams/wait/terminate/cleanup 与可选 signal。
  `tests/transform-script.test.ts` 新增异步 backend 成功/拒绝用例，
  `tests/transform-executor.test.ts` 新增真实 Host 注入 `agentTransformSandbox`
  的执行用例。
- **候选/真实提供方验证（不计 ported）**：
  - Linux 7 条硬沙箱 e2e：临时 worktree 组装 `ds-mig/L05-agent-workspace`
    HEAD `ff52577c4aeac9c9fe737c32cbabfb3f1ad65c3c`（该 adapter 已随 main
    合入，blob 相同）的
    `createTransformSandboxBackend`（blob
    `1011746922259ba3723f0d38d3cd4a84c962949f`）与
    `ds-mig/F7-native` HEAD `83e078af283f31860e72634d7dfc8cc9ab78fcd9` 的
    `nativeSandbox`（blob `0fc335fc20519f5b3260e75cc2a94c6985cbffdd`），以 bwrap 0.8.0 + prlimit 用本 lane
    真实 `runTransformScript` 逐条执行 Rust
    `chatanki_transform_script.rs` 的 7 个 e2e 场景（输入输出、断网、job 外
    文件不可读、超时杀进程组、非零退出/缺输出、node 同契约、符号链接输出
    拒绝）。持久化复核位置
    `tests/candidates/l05-linux-sandbox.test.ts`（main 无候选文件时自动
    skip，不当作通过）；作业 `20261104082217-1e212c`（lane `231c0a561`）
    退出码 0（8 tests，含 capability/contract）；当前测试文件复跑
    `20261104091936-012e18` 退出码 0（8 tests）。
  - D3 真实 L15 CAS：main 的 `FsrsReviewService`（blob
    `537458ad20d564e88303146b538fb11599b3d6b3`）把
    `fsrs_card_states.local_version` 种为 `2^63-1024`，经
    `chatanki_set_suspended` 解析后原样进入真实 CAS：首次更新成功（SQL
    `local_version` 精确 +1）；同一大整数重放时 JS 快照因 Tauri JSON 精度
    边界仍显示 `2^63-1024`，但真实 SQL CAS 以精确 i64 比较失配，返回
    `review_state_conflict` 且不写库；`2^63` 在进入 CAS 前仍按 i64 上界
    拒绝；`chatanki_undo_last_review` 也同样原样委托大整数版本。持久化复核位置
    `tests/review-executor-real-l15.test.ts`；作业 `20261104083031-e0008a`
    退出码 0（4 tests）。该测试直接注入 main 类，
    不证明 `review` 插件 API 已发布（main 的 `ReviewService` 仍缺这两个
    方法），生产 `ctx.get('review')` hydration 继续保持 pending。
  - L16 真实删除 CAS：`tests/candidates/l16-anki-delete-cas.test.ts` 用本 lane
    生产 `chatanki_delete_card`（经 `chatankiTools.execute` hydration）进入
    `ds-mig/L16-anki` HEAD `68a71d248…` 的真实 `anki.cards` 与 L15 事务
    owner，覆盖大整数正常物理删除、内容 CAS 冲突、复习 CAS 冲突；作业
    `20261104085554-c90c0c` 退出码 0（4 tests）。provider 文件 blob 见
    `tests/candidates/README.md`；main 的 `anki` 服务仍未发布 `cards`，该
    测试在 main 自动 skip，L16 行继续保持 pending。
  - 上述证据只证明候选接口/未发布方法可消费；TESTMAP 的 7 条硬沙箱 e2e
    与 L15/L16 CAS/仓储行继续 pending，不宣称生产完成。
  - 本 lane 全量（含候选测试在 main 自动 skip）：最终合入后作业
    `20261104091559-35d2d7`，39 passed / 2 skipped files、356 passed /
    12 skipped tests，退出码 0；typecheck 同 HEAD
    `20261104091559-009a02` 退出码 0。

## 2026-11-04 R5 C1–C7 整改

- **C1**：`inject` 改为 L16 实际发布的 `anki`，删除 `anki@1` 兼容查找。
  `tests/real-host-wiring.test.ts` 用真实 L16/L15/L07/F7 插件启动 Host。
- **C2**：L07 `registerToolExecutors` 现在收到 hydrate 包装器，L04 registry 直接派发
  也经过 `ChatAnkiToolsService.hydrate`；包装器转发 transform 的动态 sensitivity。
  hydrate 新增 L16 `saveJsonFile`→`exportSink`、`consolidatePreferenceObservation`、
  F4 settings 适配、L04 `chatSession`→块仓储、F7 async `nativeRegex`。
- **C4（正则）**：删除 `tests/native-regex-double.ts`；生产 `chatanki_transform`
  改用 `compileTransformOpsAsync`/`planTransformOpsAsync`，测试直接跑 F7 WASI
  regex 引擎；`test_chatanki_delete_card_normal_path` 恢复“物理行数为 0”的断言。
  `boundedRegexReplaceAsync` 不再按 `match.start` 截取后缀重匹配：capture 展开
  统一用完整原文的一次 `replaceAll`，保留 `\b`/`\B`/`^` 等左边界语义；
  常量替换仍在分配前按原文 match 跨度做增长预检。capture 展开的精确预检依赖
  F7 提供 `replaceAllProjected`（见 `native-needs.md`：必须带
  `limitBytes`，首次累计超限时返回首个越界 `bytes` 且不物化结果）。F7 分支
  当前无该实现；未发布时 fallback 会先物化完整结果再校验最终字节数，既不能
  阻止分配、也不能返回首个越界值，**不等价**于 Rust 的分配前闸门。因此 C4 的
  capture 膨胀预检保持缺口，不以该 fallback 签收，也不把相关行标为 ported。
  新增 `afoo` + `\B(foo)` + `<$1>` → `a<foo>` 反例测试，并新增 F7 契约替身
  测试锁定 `limitBytes`/首个越界 `bytes` 的调用方语义。
- **C4（仓储，未闭合）**：main 的 L16 `anki` 尚未发布 `ChatAnkiCardRepository`/
  文档任务/模板 CRUD/APKG 导入器；`ds-mig/L16-anki` 分支已提供真实
  `cards`/`documents` 与 `AnkiHostService` 适配器，但未合入 main，只能记为候选。
  仓储/CAS/ownership 契约测试仍使用 `CardStoreDouble`，不能宣称真实 SQLite 事务
  证据：`card-repository-contract` 10 条、`retemplate-contract` 12 条、
  `add-cards-contract` 2 条、`agent-review-contract` 3 条已退回 `pending`
  （L24 testA 244/286 = 85.3%）。`retemplate-contract` 的
  `batch_ui_upsert_and_fsrs_event_payload` 也依赖 `ChatBlockStoreDouble`
  持久化块，不证明真实 L04 块链，按 R5 要求一并退回。L16/L04 合入 main 后，
  替换替身并恢复这些行。
- **C5**：Mutation/GetCards/Status/APKG/Retemplate 入口补 `emit_tool_call_start`
  和 info 日志；`beginChatAnkiToolCall` 已按 Rust
  `chatanki_executor.rs:1873–1883` 改为先 info、后单次 start。status 终态错误经
  `emitBlockError` 走 L04 `anki_cards` error 事件，仅 headless 上下文降级为 warn。
  生命周期测试断言 info→start→end/error 且 start 恰好一次。
- **C6**：`llmManagerPresent=false` 时恢复 Rust `plan=None` 启发式回退；
  manager 存在但 `callAnkiRoutedRawPrompt` 缺失时显式接线错误。
- **C7**：get_cards 识别 L15 `CommandError` 携带的公开 `AppError`：`NotFound` 映射
  i18n key，其余保留结构化 `output.error` 并按 Rust 加 `[errorCode]` 前缀。
- `api.ts` 发布 L16 integration test 所需的 transform/script/route/retemplate
  纯函数与类型（14 条运行时 import 的完整集合）。

## 2026-11-03 抽检整改

- 用户/AI 提供的转换正则不再走 JS `RegExp`：`api.ts` 新增 F7 `ChatAnkiNativeRegex`
  边界，`compileTransformOps` 必须注入该引擎；JS 方言翻译只保留在测试替身中。
  F7 发布 `nativeRegex` 后直接替换注入，测试断言不变。
- `chatanki_analyze` 不再静默传 `plan=null`：新增 L02 `ChatAnkiRoutePlanner` 边界，
  有可解析引用时走 `chatanki.plan_route` 提示词并消费高置信度计划；规划器缺失时显式
  失败而不是降级，规划调用/解析失败才按 Rust 语义 warn 后回退启发式。
- chrono 时间戳统一走平台 `host/platform/time`（`now().rfc3339` / `parseRfc3339`，
  `+00:00`、毫秒精度三小数位），本 lane 不再保留本地时间实现。
- 块写入的 best-effort catch 按 Rust `let _ = …` 语义保留，并用
  `boundary-allow empty-catch` 说明理由；本 lane 在 `migration:boundaries:strict` 下无违规。
- Host 以 Node 原生类型擦除运行：本 lane 不使用构造函数参数属性、`enum` 或带实现的
  `namespace`；`node scripts/electron-migration/importable.mjs host/plugins/chatanki/index.ts`
  输出 `importable: ok`。
- `chatanki_transform` 已接入 `ChatAnkiExecutor`（dry_run/apply、ops/script、CAS 写回、
  UI 块同步与 `fsrs://changed` 尽力发出）；此前因未接线而回退 pending 的 62 行
  transform TESTMAP 恢复 ported，只剩真实沙箱 e2e 7 行 pending。

## chatanki_executor.rs 进度（169 个测试）

已移植 167 个纯函数测试：`tests/executor-helpers.test.ts` 覆盖工具名/敏感级、错误人读化、
等待/管线超时、僵尸 running 块判定、路由计划（启发式/LLM 解析/优先级/debug JSON）、
模板列表投影（fieldGuide/complexity/cloze/分页）、字段长度软校验、单模板归一、
templateId 校验、生成参数（maxCards/额外要求/critic）、词表启发式、单引用构造、
不支持的资源类型、prompt 数据块注入防护，以及状态快照/工作流投影
（`derive_status_snapshot`、`classify_generation_terminal`、`project_chatanki_workflow`、
task counts、错误分类；含 limit-cancel 与用户取消的优先级语义）。`tests/executor-args.test.ts`
覆盖 serde 参数合同：卡片 patch/别名同步、get_cards 字段截断、library 列表与双 CAS 变更、
export 选择器互斥、delete/add/enqueue/agent-review 参数、retemplate 选择器与策略、APKG 单一来源；
get_cards 分页/过滤覆盖纯选择逻辑（DB 入库与 owned snapshot 读取归 L16 仓储测试）。
`tests/preference-observations.test.ts` 覆盖偏好编辑/删除观察（别名去重、错误卡排除）；
`tests/retemplate-fill.test.ts` 覆盖 fill_missing_llm Phase 2 的 prompt、响应解析与字段落位。
`tests/library-output.test.ts` 覆盖库卡投影/版本冲突 payload/复习变更事件 payload，以及
get_cards 的 `attachReviewStates`（已入队挂快照、未入队显式 null）；
其中库卡记录与 FSRS 复习快照按 L16/L15 结构镜像，等对应 lane 发布 API 后改为消费契约。
`tests/occlusion-draft.test.ts` 消费 L16 `anki/api.ts` 的坐标解析与 marker 编解码，
覆盖 VlmFull「真实坐标优先、网格兜底、无图引用只剥离协议块」。
`tests/review-payloads.test.ts` 消费 L15 `review/api.ts` 的 wire 类型，覆盖 review stats
输出与 enqueue 事件 payload（含无入队/缺卡时不上报）。
`tests/analyze.test.ts` 覆盖 `chatanki_analyze` 执行编排：纯文本/词汇表/强制路由、
非法路由与空输入、引用不可解析的 fail-open warning、maxCards 档位，以及引用文件
正文进入 metrics（经 `ChatAnkiRefResolver` 边界注入）。`tests/workspace-read-scope.test.ts`
覆盖 workspace coordinator 只读作用域：同 workspace 放行、跨 workspace/混合归属拒绝、
写路径永不放宽、安装 fail-closed 与 guard 撤销（卡片仓储与作用域注册表经接口/测试替身注入）。
`tests/card-repository-contract.test.ts` 覆盖 L16 卡片仓储的归属/双 CAS/软删除/
复习 CAS 合同（当前用 `ChatAnkiCardRepository` 的内存替身锁定语义，L16 发布真实
仓储后直接替换实现，测试断言不变）。`tests/add-cards-contract.test.ts` 覆盖追加
卡片的顺序延续/去重跳过，以及按归属会话+文档入队复习（文档选择器重解析活跃卡集）。
`tests/list-templates.test.ts` 覆盖 `chatanki_list_templates` 执行：仓储 `created_at DESC,
id ASC` 稳定顺序、分页输出字段与空查询；模板仓储经 `TemplateDatabase` 测试替身注入。
`tests/document-session.test.ts` 覆盖失败/取消占位文档会话的幂等插入（已有任务行优先，
文档来源会话一次写入）；文档任务仓储经 `ChatAnkiDocumentTaskRepository` 替身注入。
`tests/media-source.test.ts` 覆盖媒体转写材料的出处要求追加与 `source_ref` 固定；
出处满足 L15 `mediaCitationSecondsFor` 的时间合法性判定。
`tests/agent-review-contract.test.ts` 覆盖跨会话卡片归属拒绝、L15 复习状态读取
（未入队跳过、跨会话/混合归属 NotFound、执行器预检拒绝）与 review 选择器预解析。
`tests/export.test.ts` 覆盖 `chatanki_export` 的 JSON 文档/库卡导出：归属原子性、
库卡全量字段、已删卡 fail-closed；文件落盘经 `ChatAnkiJsonExportSink`（L16）注入。
`tests/library-ui-preflight.test.ts` 覆盖库卡变更的 UI 同步预检：无来源会话直接
not_required，有来源会话经 `ChatAnkiChatBlockStore`（L04）定位预览块。
`tests/retemplate-contract.test.ts` 覆盖 L16 批量换模板事务的原子合同：别名/基础
字段映射与 required 归一化、归属/跨文档/文档集/精确版本集拒绝、活跃卡集增删、
单卡过期整批回滚、100 卡批量、Cloze 守卫、map_only/fill_missing 投影、
fill_missing_llm CAS 写回与汇总，以及批次 UI upsert 与 `fsrs://changed` payload。
`tests/mutation-ui-sync.test.ts` 覆盖卡片变更的 UI 同步生命周期：running/terminal
块保留 message/时序/顺序、预检失败阻止写库、无预览块 not_required、预检后晚到块
重查询、恢复工作流清错、requery/校验/最终写失败的结构化 partial 回执与 emit 规则、
跨会话块不是目标、文档严格校验、tombstone 合并与清理。
`tests/preference-memory.test.ts` 覆盖偏好记忆的 settings 编排：损坏值 fail-closed
不覆盖、重复观察强化、冲突 ADD-only、无可抽取候选仍执行写闭包、编辑/删卡信号
抽取与敏感原文不落库；L16 `anki_preference_memory` 的 consolidate 语义当前由
`PreferenceMemoryDouble` 替身锁定。
`tests/apkg-import.test.ts` 覆盖 APKG 资源导入边界：会话上下文归属、文件/附件/res_
解析、blob 优先与原文件 SHA-256 校验、超限在分配前拒绝，以及导入结果与
`fsrs://changed` import payload；VFS 读取经 `ChatAnkiApkgVfs` 替身注入。
`tests/block-reap.test.ts` 覆盖崩溃遗留 running/pending 块回收与会话删除闸门：
活跃管线豁免、超宽限期落库 failed 并写 interrupted 原因、守卫释放后二次回收、
新鲜块继续拦截删除，以及终态文档块快照按 DB 权威卡刷新（幂等、尊重
`deletedCardIds`、运行中文档不刷新）。

## TESTMAP 总进度

286 行中已移植 244（template 44、transform 29、transform script 33、
fsrs_settings 4、chatanki_executor 134），pending 42。本 lane 没有 IPC 命令，
交付物是 `ctx.chatankiTools` 服务。

pending 构成与原因（全部为跨 lane 阻塞，详见 SPEC「阻塞」）：

- **L16 真实卡片/文档仓储 + review CAS 契约（27，分支候选未合 main）**：
  `card-repository-contract` 10、`retemplate-contract` 12、
  `add-cards-contract` 2、`agent-review-contract` 3。这些断言依赖真实
  SQLite 事务、双 CAS、软删除/物理删除与跨会话 ownership；`CardStoreDouble`
  只能锁定边界语义。`ds-mig/L16-anki` 已提供真实 `cards`/`documents` 适配器
  （未合 main）；L15 的 `FsrsReviewService` 类已在 main 实现
  `setSuspendedForSession`/`undoLastReviewForSession`，但 `review` 插件发布的
  `ReviewService` API 尚未暴露这两个方法，因此相关行仍不能标记 ported。
- **L02 缺生成/视觉调用面（2，真实阻塞）**：`llm@1` 未发布
  `call_anki_routed_raw_prompt`（Planner/Vlm 角色、图片 payload）与
  `call_model2_raw_prompt`。受影响：
  `chatanki_plan_route_consumes_planner_role_through_fallback_adapter`、
  `chatanki_vlm_extract_branches_consume_vlm_role_through_fallback_adapter`。
- **L16 缺生成管线服务（6，真实阻塞）**：`start_background_pipeline` 直接依赖
  `dstu-anki` 的 `StreamingAnkiService`、`DocumentProcessingService`、
  `anki_connect_service`、`anki_preference_memory`；这些文件在 inventory 中归
  **L16-anki** 且测试仍为 pending，导致 `chatanki_run`/`chatanki_start`/
  `chatanki_wait`/`chatanki_control`/`chatanki_sync` 无法注册。受影响：
  `test_append_vlmfull_occlusion_*` 5 行、
  `test_ensure_failed_document_session_inserts_placeholder_once` 1 行。
  `occlusion-draft.ts` 与 `document-session.ts` 已实现并有测试，管线落地后直接接入。
- **L05 硬沙箱后端（7，真实阻塞）**：`chatanki_transform_script` 的 `e2e_*` 要求
  真实 Seatbelt/bwrap/AppContainer 隔离；main 已发布 `agentTransformSandbox`
  （L05 adapter blob `1011746922…`），但 F7 `nativeSandbox` 服务尚未合入。
  候选 L05+F7 已在 Linux 上用真实脚本跑通 7 个 e2e（见上「候选/真实提供方
  验证」与 `native-needs.md`），但 F7 未合入且 macOS/Windows 未实测，7 行
  继续保持 pending。
- FSRS 往返 1 已解除：`index.ts` 的 `hydrate` 现在把 L15 `review` 服务作为
  `ctx.scheduler` 注入（`getSchedulerConfig`/`updateSchedulerConfig` 齐备即接入；
  `getReviewStatistics` 缺失时读取工具按 Rust 错误分类 fail-closed，写入工具仍可用），
  `get_then_update_roundtrip_on_migrated_db` 已跑通并标记 ported。

2026-11-04 续作新增：

- `chatanki_review_stats` 由 `ChatAnkiExecutor` 生产执行：空对象参数校验（Rust
  `ChatAnkiReviewStatsArgs {}` + `deny_unknown_fields`）、L15 `getStats()` 快照经
  `chatankiReviewStatsOutput` 投影；L15 服务缺失时按 Rust 的
  `blocks.ankiCards.errors.databaseUnavailable` fail-closed。`review-payloads.ts`
  的两个函数由此获得生产调用方。
- `chatanki_check_anki_connect` 由 `ChatAnkiExecutor` 生产执行：经 `ctx.ankiConnect`
  调用 L16 `checkAnkiConnectAvailability`；探测抛错时按 Rust
  `(false, Some(e))` 返回 `{status:"ok",available,error}`，不把工具判失败。
- `chatanki_enqueue_review` / `chatanki_undo_last_review` /
  `chatanki_set_suspended` 由 `ChatAnkiReviewExecutor` 生产执行：
  `enqueue` 在 main 的 L15 `review.enqueueCardsForSession` 上真实跑通
  （`tests/real-review-enqueue.test.ts`：真实 mistakes 迁移库、真实
  `fsrs_card_states` 行与 `fsrs://changed` payload）；`undo`/`suspend`
  只在 `review` 服务实际提供 `undoLastReviewForSession`/`setSuspendedForSession`
  时调用，服务 API 未暴露时显式接线失败，不在本 lane 复制 CAS。
- 早期临时 worktree 证据（保留作历史，不作为 ported）：合并
  `ds-mig/L15-review-analytics` 后，真实 L15 上跑通 enqueue → `fsrs_rate`
  → `chatanki_undo_last_review` → `chatanki_set_suspended`（含 stale 版本
  conflict）与三条 `fsrs://changed`；合并
  `ds-mig/L16-anki` + `ds-mig/L15-review-analytics` 后，`hydrate` 直接消费
  `anki.cards`/`anki.documents`，跑通 get_cards、enqueue、update、stale
  conflict、delete；删除后 `anki_cards` 与 `fsrs_card_states` 均无残留行。
  这些是候选证据；L15 CAS 与 L05 Linux e2e 现已持久化到
  `tests/review-executor-real-l15.test.ts` / `tests/candidates/`，L16 分支
  合并证据仍为临时候选。D3 的旧 safe-integer 约束已在 C1 07:19Z 修正：
  `expectedReviewVersion` 是 i64，超过 2^53 不再被本 lane 拒绝。
- 补齐 Rust `ChatAnkiToolExecutor::execute` 的统一副作用：所有 `ChatAnkiExecutor`
  工具现在先 `emit_tool_call_start` 并记 `info` 日志（chatanki_executor.rs:1840–1852），
  此前只有 analyze/list/export/transform 的结束事件。

本次新增接线（`270` 行中）：

- `chatanki_get_cards` 由 `ChatAnkiGetCardsExecutor` 生产执行：读作用域预检、
  `selectChatankiCardsPage` 过滤分页、L15 `getReviewStatesForSession` 快照经
  `library-output.attachReviewStates` 挂到每张卡，并附带模板字段长度软告警。
- `chatanki_status` 由 `ChatAnkiStatusExecutor` 生产执行：任务计数/终态投影，
  终态文档的孤儿 `anki_cards` 块经 `block-reap.syncTerminalAnkiBlockWithDb`
  按 DB 权威卡刷新（`emitChunk` 存在时同步推送 UI）。
- `chatanki_import_apkg` 由 `ChatAnkiApkgExecutor` 生产执行：会话资源归属预检、
  `apkg-import` 的 blob→原文件 SHA-256 有界读取，L16 `ApkgImporterService`
  经 `ChatAnkiApkgImporter` 边界注入，成功后发 `fsrs://changed` import payload。
- `chatanki_update_card` / `chatanki_delete_card` 由 `ChatAnkiMutationExecutor`
  生产执行，写回后调用 `preference-observations` + `preference-memory`；
  覆盖 preference 14 行。
- `chatanki_retemplate` 由 `ChatAnkiRetemplateExecutor` 生产执行，
  `fill_missing_llm` 调用 `retemplate-fill` 的 prompt/解析/CAS 写回；覆盖 3 行。
- `index.ts` 通过 `inject` 注入 `settings`/`review`/`llm`/`anki`，并在 `hydrate`
  中把已发布服务（L15 review 快照/统计/scheduler、L16 模板查找/JSON 导出/
  AnkiConnect/偏好记忆、L04 chatSession 块仓储、F7 nativeRegex、F4 settings）
  合并进执行上下文。L16 尚未发布的卡片仓储、文档任务、模板 CRUD、APKG 导入器
  仍只能由调用方上下文提供（见缺口）。
- 执行器在 `apply` 中经 `ctx.inject(['agentTools'])` 注册到 L07。注册对象是
  hydrate 包装器，不是原始 executor：L04 registry 直接派发时也会经过
  `ChatAnkiToolsService.hydrate`，并转发 transform 的动态 sensitivity。

这些测试依赖的唯一外部数据是 `src-tauri/src/data/builtin-templates.json`
（design-* 模板的字段规则与 generation_prompt，归 L16 所有）；测试直接读取该权威
JSON，不复制、不修改。

块仓储与 APKG VFS 已用 L04/L11 契约的内存替身锁定语义；卡片/文档仓储的
CAS/事务/ownership 断言因 main 尚无真实实现而保持 pending（L16 分支候选见上）。
VLM 草稿与占位会话虽有实现与测试，但 `chatanki_run`/`chatanki_start` 管线尚未移植，
按 wiring 规则保持 pending（见上）。

接线统计（`migration:wiring`）：当前 TESTMAP 为 244 ported、42 pending；
ported 行的被测模块必须可从 `index.ts` 生产入口到达，transform 的 62 行全部可达。

逐模块生产调用方（防止"只 import 未调用"的假接入）：

| 模块 | 生产调用方 |
|---|---|
| `executor-helpers.ts` | 已按职责拆到 `tool-metadata` / `errors` / `block-timing` / `generation-options` / `routing` / `prompts` / `template-selection` / `context-refs` / `workflow-status` / `run-args`；原文件保留 re-export |
| `block-patch.ts` / `mutation-target.ts` | `mutation-executor`、`retemplate-executor`、`transform-executor` 的写回路径 |
| `library-output.ts` | `get-cards-executor` → `attachReviewStates` |
| `block-reap.ts` | `status-executor` → `syncTerminalAnkiBlockWithDb` |
| `apkg-import.ts` | `apkg-executor` → `verifyApkgResourceInSessionContext` / `resolveApkgResourceBytes` / `apkgImportResultForTool` |
| `transform.ts` / `transform-script.ts` | `transform-executor` → `chatanki_transform` |
| `retemplate-fill.ts` | `retemplate-executor` → `chatanki_retemplate` |
| `preference-memory.ts` / `preference-observations.ts` | `mutation-executor` 的更新/删除副作用 |
| `card-access.ts` | `mutation-executor`、`retemplate-executor`、`transform-executor`、`status-executor`、`get-cards-executor` |
| `review-payloads.ts` | `mutation-executor`、`retemplate-executor`、`transform-executor`、`apkg-executor` |

`document-session.ts` 与 `occlusion-draft.ts` 仍无生产调用方：前者只在
`chatanki_start` 后台管线失败/取消时插入占位会话，后者只在 `chatanki_run` 的
VLMFull 视觉抽取后追加草稿；两条管线（`start_background_pipeline`）尚未移植，
因此对应 6 行保持 pending，测试与实现保留，等管线落地后直接接入。
服务名按 ARCHITECTURE.md 保持 `chatankiTools`，`api.ts` 导出
`chatankiToolsService = { name: 'chatankiTools', version: '1.0.0' }`；`index.ts` 的
`meta.provides` 与 `ctx.provide` 继续使用字面量（能力目录生成器需要静态可读）。
`inject` 使用 L16 实际发布的服务名 `anki`（`anki@1` 在 Host 中不存在）。
