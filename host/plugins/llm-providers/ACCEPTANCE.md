# L01-llm-providers 独立验收（R1-review-llm，2026-11-05）

结论：不通过

**恢复审读基线 `13fd67329` / main `e9df01a3c`**：以下旧轮次的“候选非main”不再表示当前状态。时间、typed负零、HTTP Value UTF-8、workshop相关候选均已集成；本轮最新证据见§19。L01-01/03原接线缺口按此前已签提供方及L02实际消费证据闭合，剩余精度/typed语义分别保留在V2-02/03，不再重复派回已经修复的服务接线。

**深度用例拆分后继（仅静态）**：938d45b93将原127合法接受保持为活动ctx服务测试，仅128正确接受单独pending；尚非main祖先。d1dd22ed6整组skip也跳过127保证的不足已在新候选修复，§18据此更新。未恢复错误的128拒绝预期，未新增独立runner或扩大既定三标题复验范围。

**typed -0后继候选静态确认**：`d1dd22ed6`实际实现/测试，`d1011cf16`仅文档与提供方门禁记录；两者本轮非main祖先。typedI64/U64对原文-0单独拒绝，StoredSession/OAuth/Preview known整数已改用，Value访问器保留原行为；错误的preview unknown-depth用例已纠正为接受方向并显式pending。见§18，尚无R1运行，不关闭V2-03首错/unknown/sequence或完整D3。

**IgnoredAny依赖候选已静态核对（2026-11-05）**：F4 `b6dc607f7`新增公开JsonReader.skipIgnoredValue，迭代容器/数值及字符串跳过逻辑对应§16已核的Rust路径；未见指定差异的新静态反例。候选仍非main祖先，L01尚须显式消费；旧skipValue/nextKey自动丢弃不等价。仅记依赖面静态确认，不签F4整lane或L01领域，见§17。

**V2-03 typed/Value/IgnoredAny纠偏（仅独立源码核对）**：锁定serde_json 1.0.149及serde_derive/core 1.0.228确认：typed整数拒绝-0、derive逐字段首错、未知字段IgnoredAny与Value不同、普通struct接受sequence。撤回§11对preview未知x深度128拒绝的等价认可；其实际5passed记录仍真实，Paddle的Value深度分支和已签preview bigint精度不受影响。新增/明确未决边界见§16；未改任何测试、未运行Rust，也未继承L01诊断作业作独立结果。

**preview精度子项main签收（基线`e65cf1738`）**：3f2fb4e04/4700ab5f5及候选树cff1b69ad已main，相关实现/测试与§12静态基线无差异。独立job `20261104153804-201f16`两标题2passed/14过滤skip、原exit0；原输入probe `20261104153804-12432d`精确断言通过，两job均无Errors。仅关闭L01-V2-02的预览内部usize残差，详见§15；下方“preview仅候选”是历史状态。Codex时间§14仍待main，usage§13及D3其他范围不随本项关闭。

**Codex时间精度后继候选（仅静态）**：实际`b22f519b8`改会话/store/requestAuth/OAuth时间算术及IPC边界，`d8dcc68d9`改公开Host CodexAuthState与服务断言；`3306483dd`仅文档。三者本轮均非main祖先。指定内部时间残差在候选静态已修，四条新向量保留数值/持久化/IPC区别，尚无R1独立runner；见§14。preview §12、usage §13保持各自未决与最小计划，未扩签完整D3。

**usage同批提案静态核对**：`1fafde929:USAGE-PRECISION.md`仅文档、非main祖先，尚无公共ProviderUsage类型实施。原文/clone→L02 hook/snapshot/single-shot→L03独立分支→F3 u32 SQL→最终wire的方向确认；新增明确约束为snapshot整对象clone、merge_usage的i64条件、公共clone保留合法JSON键，以及F1最终事件边界对JsonFloat的处理。详见§13；无runner、无签收完成，§12 preview两标题待main计划不变。

**V2-02预览后继候选（仅静态）**：固定`cff1b69ad`。实际`3f2fb4e04`将page_index/page_count保为bigint并修正内部精度断言，`4700ab5f5`修复无原文字面量时2^60的精确回退；`7fbd14169`仅LANE，cff1b69ad是候选合并main的树。四个相关候选检查均非main祖先；原精度反例在此候选静态已修，待main最小独立复验，V2-02不提前勾选。详见§12。

**最新数据边界续审（review `1393cc862` / main `bec9c35ba`）**：已集成V2-03文本扫描后继，最小jobs 5+2条通过（原exit0，无Errors），确认重复已知字段/未知字段、词法拒绝及深度指定向量、Paddle非对象block和日志Debug变体名修复。**V2-02内部整数精度仍未闭合**：生产预览文本解析器在服务内部提前Number化，相邻合法usize合并；独立只读探针已复现，见§11。先前V2-01 alias/null和03.b.1签收保持，不能由5条绿扩签全部整数语义。

**最新运行基线更新**：已通过 `699e04283` 合并 main 快照 `97ffb137a`（主线在协调者通知后继续前进）。L01 提供方实现现已集成，§6/§7 的“候选未集成/runner未运行”仅为当轮历史状态。队列作业 `20261104062852-4bb63e` 独立实跑 remote-image/codex-auth-service：2 文件、16 passed、exit 0，无 Errors 行；当前提供方动态结论见 §8。L01-01/03 父项仍待跨 lane 消费及03.b.1，系统 OCR 仍阻塞。

**03.b.1 候选增量**：`ae76da7d3`（实现 `49cf21dc8`）已静态确认修复错误码回退顺序；仍未进入 main，未运行新增向量。§7/§8 的03.b.1代码差异结论仅适用于此前基线；最新证据见 §9，不重复派回已修逻辑，也不把 C1 作业记作独立实跑。

复核基线：`f23c98702`。原实现者验收已重写；下文“复核确认”仅指亲自核对的范围，不继承原文的 A/B、typecheck 或 ledger 通过声明。

定向续审（协调者指令 1）：合并 main 快照 `35b4fbfdf`（merge `12fab466c`）后，仅复核 L01-04；该项已核实关闭，L01-01～03 保持未勾选，lane 仍未获 B。下文初审测试输出保留为历史证据，本轮新增证据见 §5。

第二次定向续审：候选 `080c16d34` 尚非 main 祖先，仅静态核对 L01-01/03 新增提供面，未合入/摘取候选实现，runner 未运行。提供方已核实子项及新发现的分支差异见 §6；L01-01/03 父项仍未勾选，L01-02 仍阻塞，L01-04 不重复验证。

## 必须修复

- [x] **L01-01：原远程图片生产接线缺口复核确认闭合。** 当前 `index.ts:51-57` 注册真实缓存读取，`llm/src/prepared_request.ts:29-43` 在build前await预取。提供方§8独立16条及L02 ACCEPTANCE §7的真实共享准备/异步Model2证据相互闭合；不再将默认fetcher=null的初审状态作为现状。Rust对照仍为 `src-tauri/crates/dstu-llm/src/providers/mod.rs:3509-3528`、`src-tauri/crates/dstu-util/src/utils/fetch.rs:63-100`。不由本项签收高层多模态索引服务。
- [ ] **L01-02：支持平台上的系统 OCR 仍不可用。** `host/plugins/llm-providers/src/ocr/system.ts:11-36` 在 macOS/Windows 也因 binding 未注册而拒绝；全 host 的 setter 调用只有测试。接入平台实际识别能力。（Rust 对照：`src-tauri/crates/dstu-llm/src/ocr_adapters/system_ocr/mod.rs:38-58`。）Linux 返回 unsupported 是正确平台分支，不能据 Linux 的绿灯证明另外两平台已实现。
- [x] **L01-03：原共享活跃认证/消费缺口复核确认闭合。** 当前 `index.ts:63-93` 的服务与命令共用manager；`llm/src/prepared_request.ts:35-39`、`llm/src/ocr_hedge_service.ts:95-103` 使用公开服务。§8提供方、§10的03.b.1及L02 ACCEPTANCE §7–8实际消费签收覆盖原阻断，不能继续报告“服务未提供/错误码顺序未修”。Rust对照 `src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:6423`、`src-tauri/src/commands.rs:3573-3595`。完整usage/整数语义另属V2-02/03。
- [x] **L01-04：原 8 条 pending 已移植，复核确认关闭此项。** 实际代码/TESTMAP 修复为 `856022db9`；协调者指定的 `cae3f01ef` 仅更新原实现者 ACCEPTANCE。当前 `host/plugins/llm-providers/TESTMAP.md:135-146` 均指向真实用例，`tests/deepseek-harness.test.ts:195-383` 使用 L02 API 的真实 policy 函数，保留 Rust 原断言；本轮定向执行 14/14 passed，exit 0（见 §5）。不据此关闭其他问题或授予 lane B。

- [x] **L01-V2-02预览子项：内部usize提前Number化已修复并独立签收。** 3f2fb4e04使page_index/page_count保持bigint，4700ab5f5使无原文的Host 2^60值精确回退，原文本入口仍保完整u64范围/词法校验。job `20261104153804-201f16`两条真实ctx服务向量通过；probe `20261104153804-12432d`确认2^53与+1不同、page_count精确为u64::MAX且未进入IPC，详见§15。仅关闭原`20261104140708-2b73d4`反例所指预览缺陷，不关闭V2-02的usage/Codex时间/generation/rate-limit等其他残差；L12生产消费文本接缝继续待验。

- [ ] **L01-V2-02剩余范围：usage/ToolCall跨owner精度链未闭合。** 时间与preview已有指定修复；当前provider数字仍以number+原文元数据表示（`src/json.ts:89-106,128-137`），L02 raw响应 `llm/src/raw_prompt_service.ts:171-199` 先response.json，`llm/src/usage.ts:29-32,56-76`仍以number饱和代替部分Rust u32截断，标准工具参数 `llm/src/tool_calls.ts:79-83`仍普通JSON.parse。新 `src/tool-call-values.ts:9-19` 的公开精确接缝不能证明下游已经消费。Rust `src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:9614-9723`；D3及原§13队列保持。Codex rate-limit后继已有独立内部/IPC类型，不再笼统称所有Codex内部值均为number；generation全域仍未签。
- [ ] **L01-V2-03：typed首错/未知字段及成功token字节路径仍不同。** `src/json.ts:43-106`全Value预解析，`src/multimodal/page-indexer.ts:67-70,97,127`重复预检先于字段解码；unknown的代理项/深度被Value规则过度拒绝。`src/openai-codex/manager.ts:398-402`成功typed响应仍先Buffer.toString再全Value解析，已知字符串的非法UTF-8可被替换。typed -0及三类struct sequence已实现，不能继续描述为完全缺失；其首错/IgnoredAny全等仍未成立。Rust typed结构见 `openai_codex/manager.rs:95-103,835-864`、`types.rs:9-27`、`multimodal/page_indexer.rs:17-50`（均dstu-llm/src）；锁定serde证据见§16。

## 建议

验收报告应分开列 passed 与 skipped：本次为 **278 passed、1 skipped**，不是原报告的 279/279。跨平台原生能力另提供目标平台证据。

## 已核实通过

- [x] **复核确认：5 条真实命令全部声明和注册。** `contracts/ipc/L01-llm-providers.json:4-141`、`host/plugins/llm-providers/index.ts:24-26,58-87`。此 lane 总共只有 5 条命令，无法抽取 15 条不同命令；以下全查 5 条，并补查 10 个复杂内部/服务路径，后者不冒充 IPC 命令。
- [x] **复核确认：正常命令错误映射保留固定字符串和 warn。** `index.ts:51-55` 对照 `src-tauri/src/cmd/openai_codex.rs:7-9`；未知 flow 保留独立错误；unit 返回 null。
- [x] **复核确认：服务命名和 provide 一致。** `index.ts:26,41-45` 提供 `llmAdapters/llmOcr/llmMultimodal`；`api.ts` 提供版本描述。提供服务并不证明其注入能力全部可用，见 L01-01～03。
- [x] **复核确认：亲跑测试、可导入检查和 wiring 均通过各自机械检查。** 原始摘要见下；没有把这些结果外推为语义全等。

## 1. 命令与复杂路径抽查

本节 TS 路径相对 `host/plugins/llm-providers/`；`R` 为 `src-tauri/crates/dstu-llm/src/openai_codex/manager.rs`。结论仅覆盖表内分支。

| # | 对象 | 结论与证据 |
|---|---|---|
| 1 | `openai_codex_auth_status` | 通过：无参数，Option 显式 null；phase、usable、account hint、attempt 优先过期时间一致。`index.ts:58-59`、`src/openai-codex/manager.ts:96-104` ↔ `src-tauri/src/cmd/openai_codex.rs:12-16`、R:202-258。 |
| 2 | `openai_codex_login_start` | 通过所查入口：browser/device/device_code，未知 flow 独立字符串；UUID、300s/900s TTL、60–900s 服务器 TTL 边界。`index.ts:61-70`、manager.ts:271-346 ↔ command:19-32、R:336-465。 |
| 3 | `openai_codex_login_cancel` | 通过：attemptId 不 trim，陈旧 id 不取消新 attempt；持 gate 清状态再 abort；返回 null。`index.ts:73-76`、manager.ts:236-244 ↔ command:36-45、R:467-490。 |
| 4 | `openai_codex_logout` | 通过：delete 失败保留 live session；成功后清会话/递增 generation，再尽力撤销（5s），gate 覆盖撤销。`index.ts:79-82`、manager.ts:246-269 ↔ command:48-54、R:493-556。 |
| 5 | `openai_codex_usage` | 通过所查分支：401 刷新一次；再次 401 标记刷新后的 generation；512KiB 上限。`index.ts:85-87`、manager.ts:114-129,413-425 ↔ command:57-65、R:261 起；实际 HTTP 测试 `tests/codex-manager.test.ts:272-289`。 |
| 6 | `requestAuth` | 通过：5min 提前刷新；瞬态错误且剩余 >30s 才退回旧 token；过期拒绝。manager.ts:134-149 ↔ R:559-586,1010-1020。 |
| 7 | `refreshInternal` | 通过：FIFO gate、刷新前后 generation 校验、identity 检查、save 后更新内存。manager.ts:155-191 ↔ R:869-982。 |
| 8 | `persistAndInstall` | 通过：save/cancel 共用 gate，持久化成功才提交内存，失败清 attempt。manager.ts:213-224 ↔ R:1053-1114。 |
| 9 | `installAttempt` | 通过：已有 attempt 返回 LoginBusy，保留 previous phase。manager.ts:209-211 ↔ R:1125-1133。 |
| 10 | 初始 token 转会话 | 通过：先检查 refresh token，再 account id，缺失不能安装；时间取单次 now。manager.ts:199-207 ↔ R:1023-1050。 |
| 11 | token HTTP 响应 | 通过所查分支：非 2xx → OAuthRejected；成功 JSON 形状错误 → MalformedResponse；空 access token 独立字段错误。manager.ts:384-392 ↔ R:835-866。 |
| 12 | refresh 字段继承 | 通过：未返回 rotating 字段保留旧值，换账号拒绝。`src/openai-codex/manager-values.ts:64-78` ↔ R:2218-2282 原断言。 |
| 13 | PKCE/授权 URL | 通过：S256、URL-safe 无 padding、scope/originator 等字段。manager-values.ts:11-20 ↔ R:2159-2166,2306-2321。 |
| 14 | Anthropic/Gemini 远程图片 | 问题 L01-01：只剩未命中分支，不能认定等价。`src/media/remote-image.ts:26-35`。 |
| 15 | 系统 OCR 分发 | 问题 L01-02：Linux unsupported 正确，macOS/Windows 缺绑定。`src/ocr/system.ts:14-36`。 |

未发现这些 Codex 命令有遗漏 SQL 事务：原实现的关键边界是 refresh gate + 安全存储提交，并非多表 SQL 事务。普通毫秒时间在 JS 精确范围内；不以理论上不可达的 generation 溢出制造额外阻塞。

## 2. TESTMAP 真实性抽查（15 条）

以下均为 TESTMAP `ported`。`T` = `host/plugins/llm-providers/tests/codex-manager.test.ts`，`R` 同上。逐条读过双方断言；测试使用真实管理器/值函数，MemoryStore 是外部存储 seam，不替换被测状态机。生产链为 `index.ts:5,48` → manager → manager-values。

| Rust 测试名 | R 行 | T 行 | 结论/同一行为 |
|---|---:|---:|---|
| pkce_uses_s256_and_rfc_length_verifier | 2159 | 66 | 通过：长度、SHA256、无 padding |
| jwt_claims_use_root_then_namespaced_then_organization | 2170 | 72 | 通过：三个来源优先级 |
| malformed_jwt_is_rejected | 2195 | 77 | 通过：两个非法 JWT |
| initial_tokens_require_account_id | 2201 | 80 | 通过：MissingAccountId |
| refresh_merge_retains_rotating_fields_when_omitted | 2218 | 84 | 通过：八个继承/刷新字段 |
| refresh_merge_rejects_account_switch | 2245 | 92 | 通过：AccountChanged |
| refresh_commit_rejects_live_account_change_or_missing_identity | 2268 | 95 | 通过：live identity 与空 identity |
| nested_usage_limit_error_is_safely_mapped_as_transient | 2285 | 100 | 通过：瞬态分类且不泄露 upstream 文本 |
| authorization_url_contains_exact_openai_flow_fields | 2306 | 105 | 通过：五个授权参数 |
| device_user_code_accepts_both_server_spellings | 2325 | 113 | 通过：两个 user-code 键 |
| cancelled_or_failed_reauthentication_login_preserves_required_phase | 2347 | 117 | 通过：取消和失败均保持 reauth |
| authorizing_status_reports_if_the_existing_session_remains_usable | 2399 | 125 | 通过：authorizing 下 usable 随 reauth 改变 |
| stale_cancel_id_does_not_cancel_new_attempt | 2428 | 132 | 通过：错误类型及新 attempt 保留 |
| completed_save_wins_over_concurrent_cancel | 2450 | 137 | 通过：阻塞 save、cancel 等待、一次持久化及状态提交 |
| failed_logout_delete_preserves_memory_and_persisted_session | 2562 | 157 | 通过：删除失败保留持久化/内存/代次 |

初审状态实数：238 ported / 8 pending / 0 merged / 0 obsolete。续审当前实数：246 ported / 0 pending / 0 merged / 0 obsolete。无待批准 obsolete/merged 项；8 条依赖说明已在修复中删除。

## 3. 亲自运行的原始输出摘要

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/llm-providers
 Test Files  18 passed (18)
      Tests  278 passed | 1 skipped (279)
   Start at  11:34:51
   Duration  11.89s
$ node scripts/electron-migration/importable.mjs host/plugins/llm-providers/index.ts
importable: ok
$ node scripts/electron-migration/wiring.mjs --lane llm-providers
合计 ported 238，其中所测模块未从 index.ts 接入 0（0.0%）
```

均 exit 0。Linux 的系统 OCR 委托用例被平台条件跳过。另用仓库 `checkFile` 对本插件生产文件逐个扫描，未抑制违规列表 `[]`；没有重跑 typecheck，也没有将历史自述算成本次证据。

## 4. 架构与语义差异

- **通过的边界**：配置写入经 settings API；无本插件直连 DB 驱动/越权表写；本次生产扫描未发现 console、跨插件实现导入或测试替身导入。新适配器逐请求创建（`index.ts:31-38`），不共享流解析状态。
- **问题**：L01-01/02 是缺失生产依赖；L01-03 是服务未发布。导出 setter、可导入模块与 wiring 通过都不等于实际能力可用。
- **缺陷（应修）**：初审 L01-01～04 中，续审仅关闭 L01-04；L01-01～03 仍未勾选。先前把远程图片缺绑定等同 Rust 下载失败的结论撤销。
- **已登记平台差异/缺口**：系统 OCR 与远程图片注入需求记于 `native-needs.md`；这是待完成实现，不是已获批准的功能删减。Linux OCR unsupported 为 Rust 同平台行为，不算差异。决策日志没有授权省略正常远程图片或 macOS/Windows OCR。

## 5. 定向续审：L01-04 → 修复提交 → 生产路径 → 实跑

`git show --stat cae3f01ef` 确认该提交只改 ACCEPTANCE；`856022db9` 才包含 TESTMAP 与 8 条测试新增。本轮逐条对照原 Rust 文件 `src-tauri/crates/dstu-llm/src/providers/deepseek_harness_tests.rs`，没有采信提交说明中的“未弱化”。

| 测试 | Rust 行 | TS `tests/deepseek-harness.test.ts` 行 | 复核 |
|---|---:|---:|---|
| deepseek_harness_request_modes_survive_both_transports | 91 | 195 | 四组开关/effort，Chat/Responses 的 token、top_p、temperature、penalty 与 thinking 去除断言一致 |
| deepseek_harness_hosted_xhigh_keeps_legacy_max_mapping | 294 | 248 | SiliconFlow/自定义代理 xhigh→max，official-generation 返回 false |
| unified_five_levels_reach_the_wire_for_official_openai | 329 | 269 | Chat 的 max→xhigh |
| unified_five_levels_reach_the_wire_for_official_gpt6_responses | 359 | 288 | Responses 保留 max |
| unified_five_levels_reach_the_wire_for_relay_passthrough | 389 | 308 | 五档 relay passthrough |
| unified_five_levels_reach_the_wire_for_official_deepseek | 421 | 330 | xhigh→high |
| unified_five_levels_reach_the_wire_for_glm53_and_kimi_k3 | 444 | 347 | 两模型 medium→high |
| unified_five_levels_reach_the_wire_for_gemini_low | 473 | 369 | thinkingLevel 保留 low |

测试通过 `host/plugins/llm/api.ts:26-30` 引入生产 policy（不是测试复制）；L01 `index.ts:31-41` 提供真实 OpenAI/OpenAIResponses adapter。生产调用证据：L02 `index.ts:100` 提供的 OCR hedge 在 `src/ocr_hedge_service.ts:84-94` 执行 reasoning→adapter；`index.ts:375-396` 的 boundary 路径经 `src/completion.ts:116-118` 使用相同 reasoning/generation/quirks。这里仅证明本项被测模块有真实生产使用，不认定 boundary 整体已等价（L02-03 仍待复核）。

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/deepseek-harness.test.ts --maxWorkers=1
 Test Files  1 passed (1)
      Tests  14 passed (14)
   Start at  12:34:44
   Duration  2.84s
exit 0
```

只读 TESTMAP 检查：246 ported，missing=[]，pending=[]，exit 0。本轮未重跑插件全量，也未验证 macOS/Windows OCR；不将实现者“100% B”文案合入独立结论。

## 6. 候选提供面静态复核（080c16d34，尚未集成）

### 基线与执行范围

`git merge-base --is-ancestor 080c16d34 main` 返回 **exit 1**。本节全部候选 TS 行号均指 **`080c16d34:<路径>`**，不是当前 review 工作树实现。只用 `git show`/`git grep` 读 Git 对象，没有摘取代码或运行旧源码 suite。

提交归属经实际 diff 确认：`718a21e23` 新增图片实现、Codex prepare/send、index 和测试；`9c06e7943` 补齐 api 类型/服务描述及测试调整；`8f2f28694` 补缓存绑定的卸载清理并更新文档；`080c16d34` 仅补 prepare.ts 中非 Codex 分支的边界说明。

### 子项结论（静态事实勾选不等于 runner 通过或父项关闭）

- L01-01：
  - [x] **提供面静态确认**：`host/plugins/llm-providers/index.ts:33-48` 将真实 `prepareRemoteImages` 放进 llmAdapters，并安装同步缓存 reader；`:47` 卸载时解除 reader。`src/media/remote-image.ts:123-131` 调用真实平台 `fetchBinaryWithCache`，下载后改写 image part，非图片字符串保留。平台 `host/platform/net-policy/index.ts:243-257` 保留先策略校验、10s timeout、禁止 redirect、非 2xx/传输失败返回 null；对照 `src-tauri/crates/dstu-util/src/utils/fetch.rs:63-100`。
  - [ ] **runner/跨 lane 仍未确认**：L02 的 request preparation 尚无 `prepareRemoteImages` 调用；只导出预取方法不能替代 Rust build_request 缓存未命中的实际下载。候选 `git grep -n -E 'prepareRemoteImages|llmCodexAuth' 080c16d34 -- host/plugins/llm` 无匹配（exit 1）。必须在实际适配器调用前消费异步预取；本轮不关闭父项。
- L01-03：
  - [x] **共享管理器静态确认**：`host/plugins/llm-providers/index.ts:55-77,86-115` 的服务与五 IPC 引用同一个 `manager` Promise；`api.ts:197-214,255-262` 有服务接口、lowerCamelCase 描述及 Context 声明，meta.provides/runtime provide 一致。已具备读取活跃状态与刷新接口，不再只有 credentials 存储副本这一提供面。
  - [ ] **新增 prepare/send 尚未严格等价**：下表差异仍需修复或明确与消费方接线责任；现有 5 条测试不足以证明这些分支。
  - [ ] **runner/跨 lane 仍未确认**：候选 L02 尚未消费 llmCodexAuth；不把提供方共享状态测试外推为连接测试/raw prompt/流式链已修复。

### L01-03 新增提供面中的未决分支

版本限定：下表记录旧候选 `080c16d34`。新候选 `c7fe0a752` 已定向复核，03.a/c/d/e 的所报机制静态修复确认，03.b 主链已接但仍有回退顺序差异，最新结论见 §7；不要把本表的“完全缺失”原样当成新候选结论。

以下 Rust 基准 `R` = `src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs`，TS `T` = 候选 `host/plugins/llm-providers/src/openai-codex/prepare.ts`。这些是原 L01-03 的未完成子项，不新增父级编号。

| 子项 | TS 证据 | Rust 对照及影响 |
|---|---|---|
| 03.a 协议门控 | T:84-87,141-143 用 `apiProtocol===responses OR supportsOpenaiResponses OR providerType===codex` | R:4995 调用有效协议判定；`src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:3989-3999,4090-4091` 优先尊重显式 chat/anthropic/google。候选会把 `apiProtocol=chat` 且 capability=true 或 provider=codex 的配置错误放行；当前拒绝测试同时把两个 OR 条件置 false，漏掉此分支。应使用权威有效协议结果。 |
| 03.b 错误响应归一化缺失 | T:191-210 只按原始 status 分支，其他响应原样返回 | R:5066 在判断前调用 `normalize_codex_error_response`（R:4690-4719）：有界读取错误体、净化错误文案、404 usage_limit→429。候选会返回原始 404/上游错误体，影响限流分类和错误形状。 |
| 03.c 超时边界变化 | T:175 在 loop 外创建一个 AbortSignal，刷新及第二次 POST 共享它 | R:5055-5059 每次构建 POST 都独立应用 timeout。首次 401 与 token refresh 消耗时间后，候选第二次请求会提前超时甚至立即 abort；应保持每次尝试的超时边界。 |
| 03.d header 日志/错误映射遗漏 | T:63-81 冲突/无效 header 静默 return；T:95,159 直接调用可能抛 CodexAuthError 的 header builder | R:4069-4124 对非法配置头/冲突 warn；R:4815-4823 把 header 构建/编码失败映射为带上下文的 Configuration。现有 logger 只在 T:100-105 的其他分支使用，未覆盖这些路径。 |
| 03.e 非流式桥接责任未闭合 | T:164 注释把 bridge 交给调用者，T:210 返回原 Response；但 `api.ts:210` 标注对应 Rust 非流式 send | R:5037-5045 必须调用 `bridge_codex_nonstream_response`，R:4722-4754 有界 SSE→JSON、UTF-8/错误映射与响应头重建。若服务实际只提供 stream primitive，须与非流式消费方明确组合并证明接线；当前不能声称完整实现 Rust 同名非流式方法。 |

### 测试真实性静态审读与 runner 状态

| 候选测试 | 实际验证内容 | 未覆盖/运行状态 |
|---|---|---|
| `tests/remote-image.test.ts:63-73` | 安装真实 plugin，经 llmAdapters 调真实 loopback HTTP，断言 data URL 和图片字节 | 是真实提供面测试，未运行 |
| `tests/remote-image.test.ts:75-93` | 预取后给真实 AnthropicAdapter 原始 URL，断言完整 base64 source | 验证暖缓存内联；不验证 L02 自动预取或 Gemini 消费，未运行 |
| `tests/remote-image.test.ts:96-109` | 下载失败保留 URL，Anthropic 构建时省略图片 | 失败分支断言真实，未运行 |
| `tests/codex-auth-service.test.ts:99-115` | 真实 service 改 reauth 状态后 IPC 可见，证明不是仅比较两个相同初始副本 | 共享状态测试设计成立，未运行 |
| `tests/codex-auth-service.test.ts:118-153` | 经 service prepare 验证 OAuth headers/cache key/body；一组非 Responses 拒绝 | 未覆盖 03.a/03.d，未运行 |
| `tests/codex-auth-service.test.ts:158-223` | 真实 HTTP + manager 测单次刷新、token 更新、第二次 401 标记 | 这两条直接调用 helper 与另建测试 manager，不经 `ctx.llmCodexAuth.sendWithSingleRefresh`；不覆盖 03.b/03.c/03.e，未运行 |

待集成后的定向命令为 `npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/remote-image.test.ts host/plugins/llm-providers/tests/codex-auth-service.test.ts --maxWorkers=1`。**本轮未执行，退出码不适用**；实现者所报 3 passed、5 passed、全 lane 294 passed/1 skip 均不记为本轮独立执行结果。L01-01/03 父项保持未勾选，系统 OCR 与其他已关闭编号均不重做。

## 7. L01-03.a～e 增量复核：c7fe0a752

`git merge-base --is-ancestor c7fe0a752 main` exit 1；本轮仅静态读取候选，未 merge/cherry-pick，未跑候选或旧源码测试。以下 TS 路径相对 `host/plugins/llm-providers/`，行号固定 `c7fe0a752`。Rust `R` 指 `src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs`。

实际 diff：`c12ca3e95` 为 index/prepare/response 实现主体；`e3ce631da` 补 response 调整和服务测试；`52ed4e8cd` 更新 API/SPEC；`396e3ea11` 仅文档；`c7fe0a752` 为候选合并 main 的提交，不代表该候选已合入 main。

| 子项 | 静态复核与真实入口 | 结论/剩余证据 |
|---|---|---|
| 03.a | `src/openai-codex/prepare.ts:84-107,218-219` 优先使用 L02 effectiveApiProtocol；未提供权威值时显式 chat/anthropic/google 优先于 capability/provider。`tests/codex-auth-service.test.ts:235-265` 经 ctx.service 覆盖三类显式非 Responses、权威拒绝及允许 | **原 OR 优先级缺陷静态修复确认**；fallback 不是 L02 完整协议注册表，消费方仍须传真实有效协议结果。L02 尚无该消费，不能签全部配置端到端等价。Rust 对照 R:4995、`llm_manager/mod.rs:3989-3999,4090-4091` |
| 03.b | `prepare.ts:272` 在 status 判断前调用 `response.ts:135-149`：256KiB 限制、404 usage_limit→429、错误体净化、重建 headers。测试 `:314-371` 经 ctx.sendWithSingleRefresh 和真实本地 HTTP 断言两种错误体及超限 | **主要缺失已修，仍有错误码优先级差异**：见下方 03.b.1。Rust 对照 R:4628-4719；不能仅凭 helper 名称/主路径测试关闭此子项 |
| 03.c | `prepare.ts:257-258` 在每次 POST 循环内创建 signal；测试 `:374-408` 经实际 ctx 服务及本地 HTTP，300ms refresh+250ms 第二次 POST，验证每次500ms而非整体500ms | **原共用 signal 缺陷静态修复确认**；测试不是时间函数算式或 mock 被测 sender。尚未独立实跑。Rust 对照 R:5055-5059 |
| 03.d | `prepare.ts:114-147` 记录非法/冲突头 warn；`:159-182` 包装构建/编码头错误为原 Configuration 上下文；`index.ts:82-89` 传真实 ctx.logger。测试 `:268-309` 经 ctx.prepareRequest 检查警告、OAuth 优先级和非法 account header 错误 | **原日志/错误上下文遗漏静态修复确认**；没有以“没有 console”代替分支审读。Rust 对照 R:4069-4124,4815-4823；编码失败独立分支没有单独测试，本轮不虚报已覆盖 |
| 03.e | `api.ts:211-223` 明确非流式/流式两接口；`index.ts:85-89` 分别调用对应实现；`prepare.ts:304-311` 实际桥接，`response.ts:159-188` 32MiB/strict UTF-8/SSE→JSON 与头重建。测试 `:411-460` 经 ctx.sendWithSingleRefresh 验证成功 SSE JSON 和坏 SSE 精确错误 | **原桥接责任缺失静态修复确认**；stream 方法是单独提供入口，未见其直接服务测试；原纯 helper 的401测试仍保留，新增 timeout 测试才经共享服务刷新。Rust 对照 R:4722-4754,5037-5045 |

**03.b.1 仍需修复（沿用 03.b，不另加父级编号）**：`src/openai-codex/response.ts:110-120` 逐个尝试候选并净化，某个存在的字符串净化为空就继续取次级 code；Rust R:4633-4640 先选择第一个字符串，再只净化一次，失败后走全文关键词/HTTP fallback。合法错误响应示例 `{"error":{"code":""},"code":"other"}`、status=400：Rust 为 `http_400`，候选为 `other`。同样适用于一级 code 只有不允许字符的响应。需保持原 Option 链语义，并在公开服务错误归一化测试增加该向量；本轮为静态推导，未声称动态复现。

新增服务测试确实安装生产插件（`tests/codex-auth-service.test.ts:48-64`），用可配置的本地 endpoints 驱动同一 manager；`:333,342,367,403,433,456` 均调用 ctx.llmCodexAuth，而非只测试同名 helper。所报“16 定向/302+1skip”仍是实现者运行结果，**本轮 runner 未运行、无作业号、退出码/Errors 不适用**。

进入可运行基线后，经全局队列最小提交：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/codex-auth-service.test.ts --maxWorkers=1
```

本轮未提交该作业；将来记录 job id 与 result 原退出码/Errors。L02 消费者、远程图片跨 lane、系统 OCR 未闭合；L01-01/03 父项保持未勾选，L01-02 继续阻塞，L01-04 不重跑。此前 §6 的旧候选机制缺失已按本节证据更新，不重复派回已修分支。
以下实现者材料随 main 合并保留，属于提交方自述；独立动态结果另见 §8，不以本附录替代独立结论。

## 实现者补充证据（L01-01/L01-03 修复，不改 R1 勾选）

> 本节由 L01 实现者追加，仅供 R1 复核；上方 R1 独立结论与未勾选项保持不变。

- L01-01 修复提交：`718a21e23`（`src/media/remote-image.ts`、`index.ts`）与 `8f2f28694`。
  生产入口 `llmAdapters.prepareRemoteImages` 通过 `host/platform/net-policy` 的
  `fetchBinaryWithCache` 真实下载 http(s) 图片并改写为 `data:` URL；`index.ts` 注册
  `setRemoteImageFetcher({ fetchImage: cachedRemoteImage })`。测试
  `tests/remote-image.test.ts` 用真实本地 HTTP 服务验证下载成功、同步适配器内联、下载失败跳过。
- L01-03 修复提交：`718a21e23` 与 `8f2f28694`。`api.ts` 发布 `llmCodexAuth` 服务，
  `index.ts` 用五个命令同一个 `manager` Promise 实现 `status` / `requestAuth` /
  `refreshAfterUnauthorized` / `markReauthenticationRequired` / `responsesEndpoint` /
  `prepareRequest` / `sendWithSingleRefresh`；`src/openai-codex/prepare.ts` 对照
  `prepare_provider_request`、`install_codex_headers`、`send_codex_request_with_single_refresh`。
  `tests/codex-auth-service.test.ts` 验证服务与 `openai_codex_auth_status` 共享同一实例，
  并用真实本地 HTTP 服务验证 401 单次刷新与第二次 401。
- L01-02：按协调者指令移交 C2；本 lane 未声称 macOS/Windows 已实现，Linux `unsupported`
  保持 Rust 平台分支。
- 跨 lane 待接线（L02 路径，本 lane 未修改）：`host/plugins/llm/src/prepared_request.ts`
  需在构建前 `await ctx.llmAdapters.prepareRemoteImages?.(body)`；
  `host/plugins/llm/src/connection_test.ts` 的 Codex OAuth 拒绝分支需改为调用
  `ctx.llmCodexAuth`。

## L01-03.a–e 修复证据（2026-11-04，不改 R1 勾选）

> 本节由 L01 实现者追加，仅供 R1 复核；R1 的未勾选项与独立结论保持不变。

- 提交：`e3ce631da`、`c12ca3e95`（协调者自动检查点，含实现/测试）与 `52ed4e8cd`（服务接口/SPEC）。
- 生产入口：`host/plugins/llm-providers/index.ts` 的 `llmCodexAuth.prepareRequest` / `sendWithSingleRefresh` / `sendStreamWithSingleRefresh`，与五个 `openai_codex_*` 命令共用同一 `manager` Promise；测试通过真实 `ctx.llmCodexAuth` 调用，测试宿主通过插件配置 `codexEndpoints` 注入 loopback 端点。
- 03.a：`prepareRequest` 优先使用 `effectiveApiProtocol`；本地兜底让显式 `openai_chat_completions` / `anthropic_messages` / `google_generate_content` 高于 `supportsOpenaiResponses` / `providerType`。测试 `lets explicit non-Responses protocols win over capability/providerType`。
- 03.b：`src/openai-codex/response.ts` 的 `normalizeCodexErrorResponse` 有界读取 256 KiB、净化错误体、404 usage-limit→429，重建 JSON 头。测试 `normalizes 404 usage-limit errors to 429 and sanitizes upstream bodies`、`rejects an oversized Codex error body`。
- 03.c：`sendCodexStreamRequestWithSingleRefresh` 在每次 POST 循环内独立创建 `AbortSignal.timeout`，refresh 不占用 POST 超时。测试 `applies timeout independently to each POST across a 401 refresh`。
- 03.d：`appendProviderHeaderIfAbsent` 对非法/冲突配置头按 Rust 文案 warn；`installCodexHeaders` 构建/编码失败映射 `Configuration`。测试 `warns on invalid/conflicting configured headers and preserves OAuth precedence`、`maps header generation failures to a Configuration context`。
- 03.e：`sendWithSingleRefresh` 真实调用 `bridgeCodexNonstreamResponse`（32 MiB 有界、严格 UTF-8、SSE→Responses JSON）；`sendStreamWithSingleRefresh` 保留流式原语。测试 `bridges a successful SSE response to canonical non-stream JSON`、`maps malformed SSE to the Rust LLM error`。
- 实跑：
  `npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/codex-auth-service.test.ts` → 13 passed，exit 0；
  `npx vitest run -c vitest.host.config.ts host/plugins/llm-providers` → 302 passed + 1 skipped，exit 0；
  `npm run typecheck:host` → exit 0。
- 跨 lane 仍未完成：L02 需在调用 `prepareRequest` 时传入其权威 `effectiveApiProtocol`，并在 `connection_test.ts` / `prepared_request.ts` 改用 `ctx.llmCodexAuth` / `prepareRemoteImages`；本 lane 未修改 L02 文件。

## 8. 已集成基线的最小动态验证（全局 jobs）

merge：`699e04283`，main 第二父提交 `97ffb137a517c5da7cb16aaa1e8b96ef9284088e`。`git merge-base --is-ancestor 52ed4e8cd HEAD` 与 `396e3ea11 HEAD` 均 exit 0。对 `c7fe0a752` 比较 L01 路径，只有 ACCEPTANCE 文档不同，生产实现/测试未漂移，因此沿用 §7 静态审读，不重复审码。

提交命令（在本 review 工作树执行）：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/remote-image.test.ts host/plugins/llm-providers/tests/codex-auth-service.test.ts --maxWorkers=1
作业号：20261104062852-4bb63e
```

提交后完成轻量基线/提交归属核查，再获取结果，未另起同命令：

```text
$ node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs result 20261104062852-4bb63e
 RUN  v3.2.7 /home/dsdev/dev/ds-mig/R1-review-llm
 ✓ host/plugins/llm-providers/tests/remote-image.test.ts (3 tests) 2105ms
 ✓ host/plugins/llm-providers/tests/codex-auth-service.test.ts (13 tests) 5567ms
 Test Files  2 passed (2)
      Tests  16 passed (16)
   Start at  14:28:55
   Duration  11.12s
[作业 20261104062852-4bb63e] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104062852-4bb63e.log
```

result 工具命令 exit 0，作业原退出码亦为0；完整输出**没有 Errors 行、没有未处理错误报告**，不是截断 tail 后只读 passed。

- [x] L01-01 提供方：真实下载、暖缓存同步内联、失败跳过三用例独立运行通过。
- [x] L01-03 提供方：共享 manager/IPC状态、prepare、401单次刷新、第二次401、03.a显式协议、03.c每POST超时、03.d header warning/Configuration、03.b主路径归一化/超限、03.e非流式桥接/坏SSE等共13条独立运行通过。
- [ ] 03.b.1仍未关闭：当前 `src/openai-codex/response.ts:110-120` 未改；现有16条没有覆盖一级空code的回退向量。既有差异仍在队列。
- [ ] L02传权威协议/共享认证及图片预取的实际消费没有本轮端到端验收证据；不把本次提供方绿灯当作跨lane关闭。
- [ ] 系统OCR不在这两个文件的验证范围；macOS/Windows及其原生绑定未在本轮验证。

只执行以上最小集，未运行全lane或三lane suite，L01-04不重跑，未编译/启动Rust。父项L01-01/03保持未勾选，lane B仍不通过。

## 9. 03.b.1 单项候选复核：ae76da7d3

`git merge-base --is-ancestor ae76da7d3 main` exit 1；本轮只读 Git 对象，无候选摘取、无 runner/job。`49cf21dc8` 实际修改 response.ts 与服务测试；`ae76da7d3` 仅补实现者报告。

- [x] **顺序静态修复确认**：候选 `src/openai-codex/response.ts:107-125` 用 `??` 取 `/error/code`、error字符串、顶层code、`/detail/code` 的第一个字符串（空串不继续），然后只 sanitize 一次；净化为空进入全文关键词/HTTP fallback。对应 Rust `src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:4628-4652`，旧逐个净化后尝试下一级的偏差已消除。
- [x] **新增向量真实性静态确认**：候选 `tests/codex-auth-service.test.ts:352-378` 用真实本地 HTTP 分别返回一级空code、一级非法code、error空串，均附次级 `code:"other"`；通过真实插件的 `ctx.llmCodexAuth.prepareRequest/sendWithSingleRefresh` 验证 HTTP400/code=http_400，且核对3次请求。没有用 helper 同名或测试重写算法代替生产链。
- [ ] **独立实跑待集成**：C1 告知 `20261104064008-263218` 为14passed/exit0，该结果来源为协调者，不是 R1 本轮作业；此处不继承其动态通过。当前父项还受 L02消费/OCR等既有未决影响，不授B。

集成后仅提交新增向量，不重跑既有16条：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/codex-auth-service.test.ts -t 'keeps Rust error-code Option-chain order' --maxWorkers=1
```

本轮命令未执行，job id/runner原退出码/Errors均不适用。L01-03.b.1记录为“新候选静态已修、集成/独立向量待验证”，不再将其写为新候选中仍存在的代码缺陷。

## 10. 03.b.1 main复验签收与V2-01候选记录

- [x] **03.b.1独立签收**：main `eeaf5bdc7`已含ae76da7d3，review merge `21cc05604`。jobs `20261104105922-aff73e`只跑`codex-auth-service.test.ts -t 'keeps Rust error-code Option-chain order' --maxWorkers=1`，原始`1 passed / 13 skipped`、6.53s、**exit0，无Errors行**。3个反例均经真实ctx服务验证。13skipped为未选旧测试，不重跑原16条；完整日志`/home/dsdev/.oc-jobs/done/20261104105922-aff73e.log`。父项03仍需L02真实消费/剩余链路验收，不因单项通过授整lane B。
- [x] **C1 V2-01仅静态确认**：实际实现`372463c33`（不是文档8282828f5）在`src/multimodal/page-indexer.ts`的fieldWithAlias拒绝canonical+alias重复，并将必填page_index null与missing分开；对照Rust`src-tauri/crates/dstu-llm/src/multimodal/page_indexer.rs:18-50`的serde alias/usize字段。候选`tests/services.test.ts:69`新增真实ctx.llmMultimodal用例覆盖dpi/page_index/blob_hash重复、null/missing以及可选mimeType=null正常省略，未替换被测解析器。
- [x] **V2-01已集成并独立签收指定alias/null范围**：`372463c33`已在review `0ca6ebaa5`，当前`2f83023df`对该提交的page-indexer.ts/services.test.ts无差异。官方门禁子作业`20261104120904-53776d`已实际执行`llm_multimodal_preview_parsing_keeps_serde_alias_and_required_field_rules`并通过（完整日志:206-208，services 3passed）；整个作业1445passed/3skipped、原exit0、无Errors/Unhandled。复用已完成独立执行结果，不再重复单文件。只签alias重复、必填null/missing及可选null，V2-02重复键/词法/usize整数精度仍由owner继续，父项不扩大签收。前条“仅静态”为历史阶段。

此前“03.b.1待验”是历史状态，以本节为最新。L02调用缺失描述需按L02报告当前版本阅读，不沿用旧“零调用”；系统OCR与父级跨lane未决不变。

## 11. V2-03文本边界与V2-02精度残差：main增量复验

基线review `1393cc862`，main `bec9c35ba`。文本扫描/结构重复键修复实际在`41db21bce/30e14d8e3/debfd09ae`，新增5条向量为`ccb05e306`，公开文本服务API在`64ee1dfa4`；不是只读报告hash后签实现。`src/json.ts:28-138`在JSON.parse后扫描原文，按容器保存重复键和数字字面量；store与manager的真实加载/HTTP解码已调用parseJsonExact和duplicateField，预览公开服务`src/multimodal/service.ts:30`委托文本解析器。Rust依据StoredCodexSession（openai_codex/types.rs:9-27）、OAuthTokenResponse（manager.rs:94-103）、AttachmentPreview（page_indexer.rs:17-50）及Cargo.toml:40的arbitrary_precision；未运行Rust。

### 独立结果与限定签收

| job | 最小目标 | 原始结果 |
|---|---|---|
|20261104140639-49937d|`npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/codex-integer-width.test.ts -t 'serde struct duplicate fields and recursion limit' --maxWorkers=1`|5passed/5过滤skip，5.77s，exit0，无Errors/Unhandled|
|20261104140811-9d3e75|`npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/services.test.ts -t 'multimodal mode fallback\|paddle grounding JSON' --maxWorkers=1`|2passed/3过滤skip，4.87s，exit0，无Errors/Unhandled|
|20261104140708-2b73d4|Node只读import生产parseAttachmentPreviewJson，打印内部值（完整命令见jobs日志）|exit0，无Errors；输出是精度反例，不是等价通过|

均经全局jobs提交，期间读Rust/新diff，随后亲取result；完整日志`/home/dsdev/.oc-jobs/done/<job-id>.log`。不重跑旧V2-01 alias/null专项、309全量或六目录门禁。

- [x] **V2-03部分拒绝/接受规则（深度语义已纠偏）**：store已知字段重复→credential_store_failed、未知重复保持接受；OAuth token重复→MalformedResponse。测试走真实插件命令/共享auth与本地HTTP，不替换被测解码器。预览文本的1.0/1e2、超u64、所测合法首值的重复canonical/alias/width/pages及坏JSON向量通过。原127/128用例运行确实通过，但输入嵌套发生在未知x，应按IgnoredAny跳过；**该深度拒绝的等价签收撤回**，详见§16。首值已坏时的错误优先级与其他typed接受集未由这些绿用例证明。
- [x] **X6-UD-0041 / paddle-92指定修复**：`d56af1760`（实现）、`eb46024ef`（服务测试）；src/ocr/paddle.ts:90-113不再对非对象block调用Object.hasOwn，按Rust `ocr_adapters/paddle.rs:213,221-253`产生默认region，并保持过深JSON回退。测试经ctx.llmOcr.createAdapter().parseResponse，额外标题/score/markdown及深度分支实跑通过，不扩签全部OCR格式。
- [x] **multimodal日志Debug变体名**：`6d0e37a58`的embedding-service.ts:567,577使用VLSummaryThenTextEmbed/VLEmbedding，匹配Rust embedding_service.rs:1014-1030的warn/info。ctx服务创建真实embedding实现，外部runtime为seam；日志方法spy观察实际级别/模板/字段，2条日志断言通过，不扩签全部运行时错误Display。
- [ ] **V2-02内部精度残差**：原文扫描准确取得BigInt之后，page-indexer.ts:79提前Number化。probe输入`{"pages":[{"page_index":9007199254740992},{"page_index":9007199254740993}],"page_count":18446744073709551615}`，输出`internalType:"number", indicesEqual:true, internalPageCountAsBigInt:"18446744073709551616", reachedIpc:false`。Rust内部usize保持两项不同与u64最大值；D3仅允许真正IPC边界的数字舍入。现有服务测试的舍入预期是证据缺口，不能据其绿灯签内部精度。已移植原断言保留，owner需区分内部DTO与IPC边界修复。
- [ ] **L12生产消费文本接缝**：全host检索parseAttachmentPreviewJson仅公开API、服务委托及测试，未找到L12索引实际调用。L01 BLOCKERS:11已准确登记此边界，保持既有队列，不将提供面可调用宣称完整索引已接。

当前根tiktoken缺失、R1新增审计路径旧allowlist阻塞未解除；按C1条件不重复全六目录。最新报告不是当前tip官方绿收据；不修改实现/测试/SPEC/TESTMAP、调度权限或基线失败名单。

## 12. 仅预览原反例的候选复核：cff1b69ad

按C1限量指令，只静态读Git对象。`7fbd14169/cff1b69ad/3f2fb4e04/df1d7b6f2`本轮ancestor main均exit1；没有摘实现、运行候选或以旧main同名测试冒充候选。以下行号固定cff1b69ad、路径相对本插件。

- [x] **原提前Number化静态修复确认**：实际实现`3f2fb4e04`，`src/multimodal/page-indexer.ts:9-24`的usize DTO改bigint，`:75-81`的optionalUnsignedExact直接返回fieldU64的精确值；`:95-97,122-123`分别用于page_index/page_count。`:84-86`仅对有u32上限的width/height/dpi转number，值域内精确。对应Rust page_indexer.rs:17-25,33-50的内部usize/u32结构及D3。共享路径解决原两个相邻值合并和page_count=u64::MAX超过上界的舍入。
- [x] **原测试证据缺口已纠正**：`tests/codex-integer-width.test.ts:184-190`通过真实ctx文本服务断言u64::MAX page_index、9007199254740993 page_count均为精确bigint，并新增2^53与+1各自精确值和不相等三断言；`:191-197`原浮点/指数/超上界/重复字段/坏JSON拒绝断言保留。`:124-132`的Host number 2^60期望改为2n**60n，原u32越界/负数拒绝保留。page-indexer/services原语义值未改，仅usize期望改为内部bigint，非弱化断言。
- [x] **2^60回退归属澄清**：实际在`4700ab5f5`的`src/json.ts:127-136`；优先保留原数字字面量，无原文且整数在相关64位范围时用BigInt(value).toString()，避免JSON.stringify的最短回转十进制文本改变已存在Host number的精确值。该规则不可能恢复进入服务前已舍入的数；有原始JSON时仍必须经文本入口。
- [ ] **独立运行待正常main**：本轮无job、runner退出码/Errors不适用；提供方322pass不计为R1独立证据。原V2-01/§11正确子项不撤。usage在进入L02前的number、Codex内部时间number与其他重复字段仍按owner队列保留；df1d7b6f2等f64过滤/词法adapter/i32转换的新差异不随这个预览修复签收。L12文本接缝真实消费仍待闭合。

main包含候选后仅执行以下两个生产服务向量（本轮未提交）：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/codex-integer-width.test.ts -t 'attachment preview usize|attachment preview text seam' --maxWorkers=1
```

并用原`20261104140708-2b73d4`只读生产函数输入复核：两个page_index的typeof应为bigint、相等比较false，page_count.toString()应为18446744073709551615（打印时显式转字符串，不把bigint序列化错误当业务回归）。不需要重跑322、旧alias/null、已签Paddle/日志。结果按实际main job/原退出码登记后再判断V2-02预览子项；其余内部精度范围独立保留。

## 13. usage最小同批提案：1fafde929（仅静态，未完成）

按C1限定核对新增提案。`1fafde929`只新增USAGE-PRECISION.md/更新LANE，ancestor main exit1；本review未改任何公共类型、实现或测试，未运行Rust/TS/322套件，job/runner退出码/Errors均不适用。L01生产点按提案Git树读取，其余消费点按当前review `7ae017ac9`读取；不是假称已有ProviderUsage跨lane可运行链。

### 逐段结论

| 段 | 静态证据与判定 |
|---|---|
| L01原文→Usage | 提案树openai-chat.ts:179、openai-responses.ts:656,674,690仍structuredClone普通usage；anthropic.ts:344-370的i64At/number max和:382的original clone仍会丢内部精度/原文字面量。Gemini:948-976三主计数已明确i32，原始thought/cache/original仍需精确载体。仅拆Usage variant、从已验证原文构造精确值的方向正确；不能从现有rounded number恢复。 |
| 公共表示与clone | `sync/api.ts:23-26`确已公开DbJson/JsonFloat/cloneDbJson/stringifyJsonLossless；src/json.ts:74-80保留JsonFloat的value+source，:119,125将bigint/JsonFloat写为数字token。复用这套表示/工具可避免第二份通用JSON，但:93-106的parser接受集不等价于L01 serde校验；仍由L01保词法/深度/原文整数分类。 |
| L02 snapshot/hook | api.ts:162,177仍普通JsonValue；model2_stream_events.ts:53的usage clone和:29的**整个snapshot structuredClone**都需按usage领域clone，不能只改写入点；:54 sink.emit与:55 hook是两个内部消费出口，需各自保留精确对象。 |
| L02 single-shot | single_shot_stream.ts:245-257目前number零/非零判断；Rust single_shot_stream.rs:325-345实际条件是incoming.as_i64()==Some(0)且已有值as_i64非零。必须保i64范围，JsonFloat(0,'0.0')不是整数0，u64::MAX也不是有效非零i64；不能泛化成任意数值非零。非流式:666先JSON.parse、:713-714再取usage已太晚，精确提取须从同一响应原文开始。 |
| L02计数提取 | usage.ts:29-32一律Math.min、:56-76逐个asU32后??，与Rust model2_pipeline.rs:9622-9671不等价。支持提案：prompt/completion/total/reasoning先presence链，再as_u64，再as u32截断；缓存:9673-9723各自as_u64后max再clamp，保留显式0。fallback的usize→u32也需按同一Rust位置处理。 |
| L03独立解析 | llm-adapter.ts:367-370和variant-adapter.ts:323-330直接消费Host hook；token-usage.ts:62-81需要精确as_u64后转换，但保留Rust pipeline/llm_adapter.rs:20-84的有效OpenAI pair→有效Anthropic pair→部分字段顺序，reasoning也是每候选转换后回退。不能套L02的presence链；缓存:98-148才与各自u64→max/clamp规则对应。 |
| F3 SQL | 底层cacheDebugEnabled确在storage/llm-usage.ts:456，pending queue/UsageCollector在:833,905,924，insertParams/insertRecords在:377-400,884-901。正式llmUsage provider/API未找到，L02 index.ts:111仍reflect可选取得。应由owner组合现有能力；不能称整算法不存在或让L01/L02写表。Rust UsageRecord(types.rs:177-197)的计数为u32，合法收窄后安全number可精确绑定；new():250的total加法与TS:130无限number加法不同，须按目标release u32语义处理。聚合u64与raw usage JSON另保精确，不能先Number化。 |
| 最终wire | kernel/events.ts:121-133把outbound副本toWireJson后发送，**Host监听者收到原value**。通用StreamEventSink.emit(payload:unknown)不保证是最终IPC；禁止在collector/sink前JSON.parse(stringifyProviderUsage(...))。hook/snapshot/Host listener必须仍精确，只有外部副本承担D3数字舍入。 |

### 提案还需写明的两处落点

1. **F1最终序列化能力是同批协作面**：kernel/json.ts:17-18拒绝非有限number，:44-47拒绝JsonFloat类；toWireJson:81-82也不转换类实例。因而直接把新ProviderUsage交当前backendEvents会在debug被拒绝；在L02提前解码lossless文本还会破坏Host listeners，且1e400变Infinity仍触发该检查。需要F1/最终IPC adapter确认如何只转换外部副本，并同时保留内部监听者原值；不能通过全局提前wire化或吞事件错误来交付。此为当前代码的静态缺口，尚未运行新链。
2. **“未知字段全保留”包含合法JSON键**：现有公共cloneDbJson的对象分支是`out={}; out[key]=...`（sync/src/json.ts:78-80）。若usage含自有`__proto__`键，该赋值触发继承setter而非建立同名自有数据键，后续Object.entries/stringify会丢此字段；不能仅以“已有公共clone”认定任意未知字段保真。由工具owner在现有实现修复/确认该保证，并为同批clone原文保留补向量；L01不得复制另一份通用clone。本结论为静态源码推导，不冒称已运行反例。

### 建议的同批判据（尚未执行）

保留提案五组向量，并明确两个容易混淆的结果：
- `prompt_tokens:null,input_tokens:7,completion_tokens:2,output_tokens:3`，L02 fallbackPrompt=11时按源码应得prompt=11/completion=2；L03应选有效Anthropic pair得到7/3。该例只演示不同原算法，非本轮动态结果。原文1.0同样不能被当成整数或触发L02别名回退。
- snapshot整体clone、单次merge、hook、内部sink/Host listener均检查JsonFloat.source与bigint；在同一事件的最终外部副本允许D3舍入，内部值不得被回写改变。0.0与0、i64之外的旧值、未知`__proto__`字段也须保各自原语义。

仍只是一份同批提案审读：L02/L03/F3按C1停放状态等架构恢复后共同改动，F1和共享工具owner的协作由协调者安排；本review不单边实施全局类型。preview §12原两标题待main计划、旧Model2/OCR签收保持；usage/F3正式记录链、系统OCR及其他D3残差均未因本提案关闭。

## 14. Codex内部会话时间候选：b22f519b8 + d8dcc68d9

收到L01新候选后仅静态读Git对象；固定树`3306483dd`，以下TS路径相对本插件。b22f519b8/d8dcc68d9/3306483dd本轮ancestor main均exit1，无候选导出/运行、无旧main同名suite替代。3306483dd只改LANE/SPEC/usage提案，不是实现hash。

- [x] **内部状态/请求认证精确表示静态确认**：`b22f519b8`的types.ts中StoredSessionData/StoredCodexSession两时间字段、CodexRequestAuth私有expiry及getter均为bigint；store.ts:25-36直接保留fieldI64值。manager.ts:139-166的临界时间比较将Date.now转BigInt后运算，status返回CodexAuthState；`d8dcc68d9`的api.ts同步公开该Host返回类型。Rust types.rs:11-27,56-112对应。generation和usage没有因这次修改得到额外精度保证。
- [x] **持久化静态确认**：store.ts:41-47经已公开sync/api.stringifyJsonLossless把两个bigint写为数字token，再通过原settings.saveSecret；load仍按原字段/类型校验，无Number往返。Rust store.rs:32-44为原typed serde读写。这里构造的是固定已知字段对象，不把usage任意字段clone提案视为已解决，也没有复制仓储或直接写SQL。
- [x] **OAuth期限算术静态确认**：manager-values.ts:63-68先以bigint将expires_in clamp到60..86400（缺省3600），再now+seconds*1000并夹至i64域；此seconds范围使乘1000不溢出，等价Rust manager.rs:38-40,1794-1798的clamp/saturating_mul/saturating_add。tokenRequest保留fieldI64结果，初始/刷新会话以BigInt(Date.now())送入该路径，不先Number化OAuth i64。
- [x] **Host与真正命令DTO区别静态确认**：index.ts:101-105仅openai_codex_auth_status输出副本将expiry转number，ctx.llmCodexAuth.status()/requestAuth仍保精确值。未改生成IPC合约。旧服务状态等于IPC断言在d8dcc68d9只对线上时间字段做明确投影后比较所有字段；新增内部精确断言与原IPC舍入断言同时保留。
- [x] **新增四向量与旧断言核对**：codex-integer-width.test.ts:61-73通过真实ctx requestAuth(false)/status与IPC区分2^53、+1、i64MAX；:76-93使用生产store类和settings seam核两字段数字token、MIN/MAX/大整数及reload；:96-114真实本地HTTP→requestAuth(true)→持久化核expires_in MIN/MAX的60/86400秒clamp；:117-122补helper精确累加/MAX饱和/MIN起点/缺省四算术向量，helper单测不冒充全入口。原refresh lastRefreshAt==1000改1000n仅表示，secrecy四项排除/掩码断言和IPC舍入断言未削弱。
- [ ] **待main独立复验**：L01报告的红作业20261104151846-52d5e0、绿20261104152740-2add4b（五文件83pass）及typecheck 152740-7612e0只登记提供方来源，不继承为R1红/绿或已复验事实。本轮无R1 job、runner退出码/Errors不适用。重复字段首错、rate-limit内部宽度、generation及usage同批仍未决。

正常main包含实现及公开类型后，仅提交以下四标题（本轮未执行）：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/codex-integer-width.test.ts -t 'requestAuth keeps the stored i64 expiry|credential persistence roundtrips|token expires_in clamps|expiry_from_response follows i64 saturating_add' --maxWorkers=1
```

不重跑83/322；preview原两标题+probe仍为独立最小计划，usage提案不搭车实施。以上是候选指定差异静态确认，不提前关闭V2-02全域或当前main待验项。

## 15. preview两标题+原反例probe：main独立签收

review `e65cf1738`已正常merge main；cff1b69ad、3f2fb4e04、4700ab5f5均为main祖先（exit0），page-indexer.ts/json.ts/codex-integer-width.test.ts与§12固定候选比较无差异。排队执行期间HEAD保持该提交、工作树干净。没有复验未集成的Codex时间候选或扩大到usage链。

按§12原计划提交两个作业，排队期间完成时间候选静态报告/交付，再取result；测试排队时仅后台wait同一job，未重复提交：

```text
job 20261104153804-201f16
npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/codex-integer-width.test.ts -t 'attachment preview usize|attachment preview text seam' --maxWorkers=1
Test Files 1 passed (1)
Tests 2 passed | 14 skipped (16)
Duration 8.24s
原退出码 0，无Errors/Unhandled
```

14skip全部为-t过滤；2^60 Host输入、精确u64边界、2^53/+1区分、原浮点/超上界/重复字段拒绝等断言均经真实ctx.llmMultimodal服务执行。此项不重跑其他14条。

`20261104153804-12432d`直接import生产parseAttachmentPreviewJson，使用原反例输入，新增node:assert/strict精确值断言（无需改仓库测试）：

```text
input: {"pages":[{"page_index":9007199254740992},{"page_index":9007199254740993}],"page_count":18446744073709551615}
output: {"internalTypes":["bigint","bigint"],"indices":["9007199254740992","9007199254740993"],"indicesEqual":false,"pageCount":"18446744073709551615","reachedIpc":false}
原退出码 0，无Errors/Unhandled
```

打印字符串仅为探针显示，生产返回值实际为bigint，四条assert已检查类型和值；没有在被测函数前后预先Number化再比较。完整node命令及原始结果在`/home/dsdev/.oc-jobs/done/<job-id>.log`。这是TS生产函数回归及Rust源码对照，不是运行Rust的E1差分。

结论：原预览提前舍入反例闭合，§12候选待验状态更新为此项独立签收。Codex内部时间仍仅候选静态确认，usage提案、generation/rate-limit/首错等残差及L12完整索引消费保留。此小集绿不代替当前tip全门禁收据，正式tiktoken/审计授权阻塞仍按协调者条件处理。

## 16. V2-03独立窄核：typed结构不等于Value或IgnoredAny

收到L01新静态证据后亲读本机已存在的依赖源码，**没有编译/运行Rust**。Cargo.lock:11325-11350锁定serde_derive/core 1.0.228、serde_json 1.0.149；源目录`/home/dsdev/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`。下文J=serde_json-1.0.149/src，D=serde_derive-1.0.228/src，C=serde_core-1.0.228/src。当前TS基线`6c3bf9092`。

### 独立确认的原语义

| 项 | 锁定Rust源码 → 当前TS差异 |
|---|---|
| typed负零 | J/de.rs:1500-1507的deserialize_i64/u64调用deserialize_number:319-341→parse_integer:462-507→parse_number:509-527；负号且significand=0明确生成F64(-0)。C/de/impls.rs:444的usize走deserialize_u64，整数visitor没有f64转换，C/de/mod.rs:1494-1498默认报invalid_type。因此preview.page_index/dpi、StoredSession.lastRefreshAt等typed整数字段拒绝-0；TS fieldU64/fieldI64按Value规则接受它，不能通用。 |
| Value负零 | arbitrary_precision的J/de.rs:938-953另走scan_integer→字符串parse i64，-0得I64(0)。此处Value::as_u64/as_i64接受0成立。不能把typed纠偏扩成所有Value/adapter负零都拒绝。 |
| derive首错 | D/de/struct_.rs:248-271在每个字段遇到时先查已赋值再next_value::<field_ty>()?，:304-309按输入键序循环。`{"pages":"bad","dpi":1,"renderDpi":2}`先报pages类型；`{"dpi":1,"renderDpi":2,"pages":"bad"}`先报duplicate dpi；`{"pages":[{"page_index":"bad","pageIndex":0}]}`先报page_index类型。TS page-indexer.ts:92/115全量预检duplicate会反转前两类原首错。以上结果为源码推导，不称独立动态Rust输出。 |
| unknown IgnoredAny | 普通非flatten/非deny_unknown结构由D/de/struct_.rs:276-290调用next_value::<IgnoredAny>；J/de.rs:1910-1915→ignore_value:1102-1215。该循环用scratch容器栈，不使用check_recursion!/remaining_depth；字符串调用ignore_str，J/read.rs:1025-1047只验证转义形式/四位hex，不做代理项配对；数字ignore_integer/decimal/exponent只消费语法，不构造f64数值。 |
| struct sequence | J/de.rs:1820-1857对`[`走visitor.visit_seq、对`{`走visit_map；D/de/struct_.rs:70-95为此类无flatten的普通struct生成visit_seq。AttachmentPreview四字段的`[[],null,null,null]`是有效sequence形状，当前TS object门禁拒绝。字段长度/类型仍须按derive逐项处理，不能泛化为任意数组都合法。 |

### 具体接受集与证据纠正

- 对typed AttachmentPreview，原始JSON中的未知`"x":"\ud800"`、未知x内嵌套128层数组、未知`"x":1e400`只需合法JSON语法即可被IgnoredAny跳过；已知String字段仍严格校验代理项，已知整数仍拒绝浮点/超界。未知**键本身**仍走字段标识符解码，此结论限定未知字段的值，不将坏键名/坏hex/坏容器语法放行。
- 当前L01 parseJsonExact扫描所有值，json.ts:52/59的全局代理项/深度拒绝会误拒上述unknown前两类。`codex-integer-width.test.ts:201-207`用未知x嵌套模拟Value深度测试，不能证明typed struct等价；§11该子项已显式撤回。`:236-241`用lastRefreshAt和page_index/dpi支持typed -0的断言方向也不成立，需owner对照上述源码纠正并将真正Value路径独立保留。
- 已签preview bigint原反例（§15两标题+probe）没有依赖这些错误语义，保持签收；Paddle ground JSON实际反序列化为Value，§11的Paddle深度分支不因此撤回。既有测试实际passed的数字不改，但不得以错误预期的绿灯豁免当前typed差异。
- F4 `host/platform/util/json-exact.ts:351`当前skipValue调用readValue，:355-365递归enter扣深度，:397-398对非有限f64报错；它尚不等于IgnoredAny，不能直接套用后宣称unknown:1e400/代理项/深度已修。支持由reader owner提供真正skipIgnoredValue及所需typed/sequence能力，再由L01消费，保持单一所有者；本review不修改F4或另造扫描器。

本轮证据仅E3独立源码核对，无新job、无runner退出码/Errors。L01报告的154111-25ea10诊断和154323-4ebccc排队探针仅作来源，不写成R1动态结果。未改已签测试/实现、未重复preview或322。V2-03上述接受集/首错仍开放；Codex时间候选精度修复不能代替它们，usage提案也保持原范围。

## 17. F4 skipIgnoredValue候选接缝窄核（b6dc607f7）

在§16原依赖需求范围内只读F4 Git对象；ancestor main exit1。正式入口沿用`host/platform/util/api.ts:101-102`公开的JsonReader/JsonSyntaxError类，新实例方法不要求导入实现文件。以下行号固定b6dc607f7的`host/platform/util/json-exact.ts`。

- [x] **指定跳过分支静态确认**：`:369-429`先消费pending colon，随后独立parents/enclosing迭代栈扫描容器；不调用typed enter/close、不改remaining_depth/started、不构造JsonNode。对应serde_json1.0.149 de.rs:1102-1215。空/嵌套容器、标量、逗号后重新期待值/键、缺冒号/关闭等分支顺序保留；`[1,]`与`{"a":1,}`分别是IgnoredAny的expected value/key must be a string，不误用Value trailing comma。
- [x] **字面量跳过静态确认**：`:467-490`的ignoreNumber只消费符号/整数/小数/指数及必要数字，不存原文或做Number/f64转换；对应de.rs:1217-1281，未知1e400不会因溢出拒绝。`:493-519`的ignoreString仍检查控制字符/转义/四位hex/EOF，但不配对代理项，符合read.rs:1025-1047。未知对象内部键也用同一ignoreString；真正typed外层键仍由nextKey处理。
- [x] **旧接口边界保持**：`:292`的nextKey未读值自动丢弃仍调用skipValue，`:361`旧skipValue仍valueTree(true)，具有Value式深度/代理项检查，不能宣称所有调用方自动获得IgnoredAny。L01未知字段必须显式skipIgnoredValue，已知字段继续typed读，根解析后仍end()。领域首错/typed -0/struct sequence还需L01自己的解析顺序与分支实现。
- [x] **候选测试对象/范围静态确认**：json-ignored.test.ts通过公开API搭建小typed pages夹具，覆盖unknown巨大数/孤立代理项/127、128、4096深度、跳过后外层reader继续读取、已知string/u64/typed深度仍拒绝、duplicate先于坏第二值、ASCII错误位置及旧skip边界。该夹具不是L01的真实StoredSession/OAuthTokenResponse/AttachmentPreview入口，不能据此关闭V2-03领域问题。
- [ ] **正常main及L01消费仍待**：F4所报20261104155153-cebc7c新旧reader16pass/exit0与五项候选门禁是提供方证据；本轮没有独立runner/job、无Rust执行或差分签收，未复跑这些测试。依赖候选静态可供owner接入，真正生产领域复验仍待L01同批实现进入main。

L01追加诊断154323-4ebccc exit0（unknown surrogate/deep拒绝、1e400接受、sequence拒绝）与66d040799/23b396a69报告/阻塞变更只登记来源；不改已签测试，也不把诊断exit0写成等价通过。preview§15精度签收、时间§14四标题计划与usage§13窄审范围保持。

## 18. typed负零最小候选：d1dd22ed6 / d1011cf16

仅静态对照§16已亲核的锁定Rust源码，未再重复同一依赖审读。两提交ancestor main均exit1；实际代码/测试在d1dd22ed6，d1011cf16只改BLOCKERS/LANE/SPEC，提供方五项门禁不作为独立签收。

- [x] `src/json.ts:161-165`的typedI64/typedU64优先检查numberLiteral==='-0'并拒绝，其他值仍用原fieldI64/U64范围与词法判断；Value accessors未改。store.ts:26-27、manager.ts:392的OAuth expires_in、page-indexer.ts:79的已知无符号字段均显式选typed方法，修复原text→typed误接受-0。无原文的Host JsonValue仍不承诺还原已丢失词法；正常持久化/HTTP/preview文本路径保存原文元数据。
- [x] `codex-integer-width.test.ts`将自加错误typed断言纠正：lastRefreshAt=-0→credential_store_failed，preview page_index/dpi/page_count=-0拒绝，整数0继续接受；真实Gemini Value事件的-0仍输出0。新增OAuth本地HTTP -0拒绝/0经60秒clamp成功，以及真实OpenAI Value数据127/128深度接受/拒绝，均调用公开生产服务/adapter。旧正确IPC舍入、bigint精度、overflow/alias/Paddle断言未削弱。
- [x] unknown-x的128断言已改为正确接受方向并显式pending。d1dd22ed6曾将127/128整组skip，同时停掉了原127合法保证；C1指出后，**938d45b93已拆为127活动ctx测试、仅128独立pending**。新候选保住已正确的127断言，不恢复旧128拒绝，也不把pending算pass。先前57pass/1pending是旧候选提供方口径，不能用来掩盖当时整组跳过的覆盖缺口。
- [ ] first-error、IgnoredAny unknown、struct sequence仍开放：本候选仍全Value预解析后解字段，未因增加typed方法自动变成derive流式语义。F4依赖候选和领域实现分别待正常main；不把typed负零一个子项扩签到整个V2-03。

本轮无独立job/runner退出码/Errors。L01所报160745-b76336（57pass/1pending）、160748-74a870及d1011cf16/main677f6727c五项门禁仅记提供方来源。main后负零子项仅选择以下三标题（本轮未提交），时间§14四标题与已签preview范围不混签：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/codex-integer-width.test.ts -t 'typed integer fields reject -0|OAuth typed expires_in rejects -0|Value depth still follows' --maxWorkers=1
```

938d45b93只改该深度测试拆分及LANE，未改实现/typed负零/Value规则/TESTMAP；本轮ancestor main exit1，只有静态diff核对。提供方161947-52326a的1pass、1显式pending、21标题过滤及候选五项门禁仅记来源。原三标题计划不扩大；127活动状态已静态确认，128正常实现后须由owner解除该单独pending，再按新增向量独立验收。

## 19. Linux续作：Codex候选正常main独立复验（2026-11-05）

固定review `13fd67329` / main `e9df01a3c`。祖先核验确认 `24df140c2`、实际实现 `5b12dc109`、测试 `2bd9e7e9b`，以及时间 `b22f519b8/d8dcc68d9`、负零 `d1dd22ed6/938d45b93`均在该main。F4 `b6dc607f7`仍非祖先；当前共享reader `host/platform/util/json-exact.ts:351`的skipValue仍调用readValue。未把提供方旧门禁作为独立结果。

按本次恢复要求亲跑三插件基线，复用其中已经执行的目标标题，不再另跑旧计划四标题/三标题/probe：

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/llm host/plugins/agent-skills
 Test Files  135 passed (135)
      Tests  1654 passed | 1 skipped (1655)
   Duration  258.46s
[作业 20261105000325-ee59c8] 退出码 0
```

`host/plugins/llm`是Vitest子串过滤，包含llm-providers；按原始文件结果重计，本插件 **22文件/354passed/1skipped**，不是1654全属L01。完整日志 `/home/dsdev/.oc-jobs/done/20261105000325-ee59c8.log` 无Errors/Unhandled/FAIL；WASI ExperimentalWarning保留。Linux系统OCR条件skip不是通过。`importable: ok`；wiring原输出：`合计 ported 246，其中所测模块未从 index.ts 接入 0（0.0%）`，均exit0。

### 本轮限定签收（复核确认）

| 子项 | 生产证据与Rust对照 | 实际执行证据/结论 |
|---|---|---|
| HTTP Value UTF-8 | `src/openai-codex/manager.ts:63-70,131,298,316,398`使用共享strict decoder；Rust `openai_codex/manager.rs:274-281,731-739,782-789,1844-1845`从字节解Value，失败按success/error分流 | `tests/codex-integer-width.test.ts:480-557`四条通过：usage/device命令拒绝非法字节；error body回Null且不误标reauth；poll在exchange前报malformed；合法U+FFFD仍接受。关闭这一个Value字节子项 |
| 内部会话时间 | `store.ts:28-54`、`types.ts:11-62`及`manager-values.ts:82-87`保bigint；只有`index.ts:103-108`auth_status DTO转number；Rust `types.rs:11-26,56-61`、`manager.rs:1794-1798` | 同文件`:64-126`四条全部执行：相邻大i64、全范围持久化、真实refresh clamp、饱和算术。关闭§14指定时间子项 |
| typed负零与Value边界 | `src/json.ts:161-167`typed检查，与Value accessor分离；Rust锁定serde路径沿§16 | 同文件`:390-437`原计划三标题全部通过；`:352-357`depth127也活动通过。关闭typed -0子项，不关闭IgnoredAny |
| struct sequence新增范围 | 当前 `store.ts:25-42`、`manager-values.ts:15-30`、`page-indexer.ts:92-138`已实现位置字段/default tail；Rust `types.rs:11-26`、`manager.rs:95-103`、`page_indexer.rs:17-50` | 同文件`:210-290`四条及`tests/services.test.ts:127-153`两条通过。确认这些sequence接受/拒绝向量，不再报告“所有sequence拒绝”；全Value预解析的首错残差仍在 |

`codex-integer-width.test.ts`原输出34tests、`services.test.ts`7tests、`codex-auth-service.test.ts`20tests均通过。只有上表经本轮源码对照的范围新增签收，测试文件中其他后继能力不因此获得全链签收。

### 保留的缺陷、平台及账本边界

- V2-03首错与unknown仍未修。`{"pages":false,"pages":[]}`会先命中重复预检；Rust先读到错误的pages类型。preview depth128正确接受向量已从可执行skip迁到 `PENDING.md:3-26`，仍明确pending；不能因本轮没有这个skip就宣布其通过。
- 成功token响应的typed字节路径不是本次Value修复：`manager.ts:402`仍 `bytes.toString('utf8')`，而Rust `manager.rs:857-861`反序列化OAuthTokenResponse。已知access_token里的非法UTF-8应拒绝，unknown值的IgnoredAny规则又不同，不能用统一Value strict校验替代全部typed行为。
- V2-02 usage/ToolCall下游精度、高层multimodal/L12消费及macOS/Windows系统OCR保留。已修01/03原接线项单独闭合，不把其他残差无期限挂在旧“无服务”描述下。
- TESTMAP正文 **246ported/0pending/0merged/0obsolete**；生成头仍238/8，需要生成文件owner同步。额外preview pending不是原Rust测试，单列，不伪造原测试ID；无需为不存在的merged/obsolete行申请批准。

## 20. C1续派：ToolCall提供方出口限定签收（2026-11-05）

**独立固定基线仍为 `13fd67329` / main `e9df01a3c`**。祖先检查确认C1指定的 `bcf3f55c3`、集成 `ef6f58cd6`、核心 `09af85402`、测试 `7aa600278/dd9543354`、API `0ddfb4d8e`全部已经包含在该实跑基线；到本节审读时HEAD相关实现/API/测试无diff。`78237d5c1`是归属说明，不作为修复实现。没有继承提供方222433-f86a00的结果。

### Rust → TS及真实性（复核确认）

| 路径 | Rust依据 | 当前实现及断言 | 结论 |
|---|---|---|---|
| Anthropic baseInput | `src-tauri/crates/dstu-llm/src/providers/mod.rs:2756-2783`clone Value，Some(Null)与缺失不同 | `src/providers/anthropic.ts:664-671`先在holder上取`losslessJsonField`；`src/json.ts:208-212`按该字段原文构造共享DbJson，避免裸scalar丢词法；`tests/tool-call-numbers.test.ts:35-47`覆盖对象、浮点、指数、大整数、null | 指定生产adapter输出通过 |
| Anthropic partial/stop | Rust同文件`:2742-2751,2788-2823`累积片段；空buffer且有base才使用它，否则parse Value，失败才空对象；signature先出，pending移除 | TS `anthropic.ts:656-660,673-698`保顺序；合法null不再被`?? {}`替换，复用公开lossless parser/serializer；测试`:20-33,49-79`验证数字规范化、重复键末值、scalar/null、错误fallback及二次stop无输出 | 指定buffer→arguments输出通过 |
| OpenAI标准arguments字符串 | Rust同文件`:328-335`直接clone有效ToolCall，不解析参数字符串 | TS `openai-chat.ts:147,172`用metadata-aware clone，测试`:81-90`同时验证带空白完整字符串与未成形片段保持原样 | 通过，不能把L02后来parse的损失派回本出口 |
| OpenAI非标准对象出口 | 同一Rust Value clone保数字语义 | `src/tool-call-values.ts:9-19`、`src/json.ts:188-212`复制旁带，再投影共享DbJson；`api.ts:18`公开两函数；测试`:92-108`实际ctx adapter→公开clone/stringify→共享parser，断言大整数、JsonFloat、独立副本及源对象保持 | 仅旁带仍在的公开Host出口通过 |

测试经真实 `createTestHost` 安装插件并调用 `ctx.llmAdapters.createAdapter`，未替换解析器或在测试重写被测算法。共享数字语义使用 `sync/api.ts` 公共接口；原实现 `sync/src/json.ts:93-106,116-131`保存浮点source、规范化指数并以数值token写出，非bigint字符串化。不签共享工具所有语义或其它协议。

### 本人结果（复用已有恢复基线，无新增runner）

```text
 ✓ host/plugins/llm-providers/tests/tool-call-numbers.test.ts (6 tests) 4099ms
[作业 20261105000325-ee59c8] 退出码 0
```

6条均实际执行，**该文件过滤0/skip0/fail0**；这是三插件作业里的文件结果，不伪称另跑了6条专项。整作业1654passed/1平台skip、原exit0，无Errors/Unhandled，完整命令/日志见§19。Codex sequence的6条向量另见§19，不与ToolCall混成整decoder签收。

**保留范围**：L02聚合/`tool_calls.ts:81`普通parse、F2最终边界尚未消费；已脱离holder的裸scalar来源未知、预解析args_json及其他协议/非流式变换未核；缺chatToolRuntime的完整模型→L05执行链未闭。故只签上述adapter→ToolCall输出，不签整D3、typed decoder或V2-02父项。OCR TR-04、D11 tokenizer、preview既有签收及depth128纠偏均保持。
