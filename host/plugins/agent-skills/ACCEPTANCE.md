# L07-agent-skills-ptc 独立验收（R1-review-llm，2026-11-05）

结论：不通过

**WP-C2-VERIFY-010（main `e1204ee8a`）**：workshop 13 条 ported 映射断言等价，但被测符号没有生产调用点，13/13 不通过，应撤回 pending。见“必须修复”与 §16。

**恢复审读基线 `13fd67329` / main `e9df01a3c`**：workshop元数据/receipt候选已正常集成，最新复核见§15；下方非main描述是历史。L04现已读取执行器收集器，但完整L03准入运行时尚未提供，48条PTC仍pending；不再将“全host只有测试读取toolExecutors”作为当前事实。

**workshop receipt后继候选静态确认**：`38e43cbfe`撤销propose/list/apply及list.files.size的Number化，`811c5a83c`新增两条Host receipt精确值测试；均非main祖先。原提前舍入在候选静态已修，不再返工该差异；独立复验仍待main，unknown/sequence及实际工具注册消费未闭合。见§14，不沿提供方两pass签整链。

**Workshop UD0004/0005候选窄核（2026-11-05）**：实现`3d6108625`、新测试`82564b117`尚非main祖先。元数据/版本饱和/hash/marker持久化精度静态修复确认；未知字段仍用旧skipValue且只支持object，receipt在Host返回对象提前Number化，完整typed/receipt链仍未决。详见§13；提供方26/10pass不计R1独立结果，正常main后仅workshop-json.test.ts最小复验，旧48PTC及平台范围不变。

**main复验签收（v2）**：基线`eeaf5bdc7`已由`21cc05604`合并。jobs `20261104105922-ff769c`（8passed）和`20261104111742-4e66b9`（5passed）均原exit0、无Errors；L07-02/03/04/06/07及D3指定修复独立签收。L07-01真实dispatcher/48条PTC不能据这些测试升级；L07-05的repack和错误分类子项确认，v2同步I/O/平台边界仍未闭合。详见§10，旧候选未集成描述仅为历史。

**05 main最小复验签收**：`ddcd6dde9`及文档`1bef65e53`已进入main，基线`b70b5e238`。按C1要求执行§11原定最小命令，job `20261104131936-08027e`原exit0、7passed/42过滤skip、无Errors。关闭本地read和tap write两个Host同步I/O残差；utilityProcess、打包及三平台仍未验证。详见§12，§11“仅候选/未运行”为历史状态，旧02/03/04/06/07/D3签收不变。

复核基线：`f23c98702`。审读 15 条 IPC 命令、15 条 marketplace 原测试，并补查 7 条 PTC 执行测试及 staging 事务；测试通过不替代生产接线。

定向续审（协调者指令 1）：合并 main 快照 `35b4fbfdf` 后仅检查新注册收集器与 L07-01 的关系；未发现 PTC 生产执行接线，L07-01 保持未勾选。其余编号本轮未复核；初审证据与测试结果保留，新增证据见 §5。

完整候选续审：固定 `7455ad39f`，尚未进入 main（祖先检查 exit 1），只读 Git 对象复核 L07-01～07。候选已新增真实 PTC 执行器，不能再称其“只有收集器”；但 L04 消费仍缺失，ZIP worker 亦有残留同步分支/错误分类差异。§6 逐项记录静态确认子项和未决项。七个父项暂不勾选：未集成、runner 未运行；31 文件/417 passed 是实现者结果，不是本轮独立证据。

最新05/06候选更新：`db5bfe8f5`（实现 `1aff05ac5/60fc55f8e`）已静态确认两处 repack 改走worker，且恢复基础设施/业务错误分类；§6的两项代码遗漏不再适用于该新候选。新增本地读取测试有平台静默return和精确界限断言不足的证据限制，详见§8。候选仍未入main，本轮runner未运行；其他已验项不重做。

**后继 L07-06 更新：`b34d4cbaa` 已静态修复§8的两项测试证据问题**（显式平台skip及精确MAX+1断言），详见§9。上述不足只适用于旧候选db5bfe8f5，不再作为新候选残差派回。后继仍未入main，独立运行待验；05/D3及其他已审项本轮不重做。

## 必须修复

- [ ] **L07-01：PTC已有注册及L04 registry消费，实际中央准入调度未闭合。** `index.ts:222-236`注册PtcToolExecutor，`chat/index.ts:124`已读取toolExecutors；`chat/src/execution-context.ts:54`的admitted_tool_dispatcher仍默认null，`chat-pipeline/src/execution-runtime.ts:215-224`仅查找chatToolRuntime，未见生产提供方。`tests/ptc-production-wiring.test.ts:39`自行提供dispatcher只能证明L07适配边界。Rust `src-tauri/crates/dstu-agent/src/chat_v2/pipeline.rs:153-196`的真实准入链仍需跨owner组合验证。当前TESTMAP是303ported/48pending，不再沿用旧351ported或“未实例化”的描述。
- [x] **L07-02：prepare后提前失败清理已修复并签收。** `d5912d52f`的dispose及install/tap/market/update finally已在main；§6记录逐路径Rust Drop对照。本轮`prepared_package_dispose`及实际market错误digest后无staging回归通过（job `20261104111742-4e66b9`，exit0）。签收本finding，不扩大为所有crash/目录交换原子性已验证。
- [x] **L07-03：market provenance时间格式已修复并签收。** `d5912d52f`使用平台currentInstant().rfc3339，Rust对照仍为`skill_market_client.rs:1427-1439`；实际安装marker +00:00/非Z断言通过（job `20261104111742-4e66b9`，exit0）。不宣称墙钟纳秒测量精度高于平台承诺。
- [x] **L07-04：两处原warn遗漏已修复并签收。** `d5912d52f`注入ctx.logger并在越界/非目录分支warn；Rust对照`skills.rs:309-315,390-395`。job `20261104111742-4e66b9`的warns_on_path通过、exit0；本项不代替所有日志全仓审计。
- [x] **L07-05：已发现的同步ZIP工作与两处磁盘I/O残差完成指定修复签收。** worker/repack/错误分类沿用§8/10已核证据；本轮仅复验`ddcd6dde9`的本地异步read与tap异步write，job `20261104131936-08027e`通过让出事件循环、MAX+1、open/read阶段错误、本地/虚拟写与清理7条向量。Rust对照skills.rs:2378-2413、skill_taps.rs:693-732,762-884（均`src-tauri/crates/dstu-agent/src/chat_v2/`）。本勾选关闭所列代码缺陷，不签utilityProcess、打包、三平台或未测性能上限；这些运行环境边界继续未决，lane仍不通过。
- [x] **L07-06：有界MAX+1及open/read阶段错误已修复并签收。** 实现`d5912d52f`、测试`60fc55f8e/b34d4cbaa`已入main；job `20261104105922-ff769c`实际运行增长/精确MAX+1、Linux非root open/read错误三用例通过，原exit0。显式skipIf静态对照确认，当前平台两场景实际执行；不据此声称Windows/macOS运行已验。
- [x] **L07-07：单请求redirect deadline重置问题已修复并签收。** `d5912d52f`循环外一次signal，对照Rust transport:72-86；job `20261104111742-4e66b9`共享signal/abort传播两用例通过，exit0。测试替换外部fetch/时钟seam，实际调用FetchSkillMarketTransport；签收原超时重置finding，不扩大为所有HTTP细节差分通过。

- [ ] **X6-UD-0004/0005（workshop）：metadata/receipt精度已修，typed接受集与生产工具链仍未闭合。** 当前 `src/tools/skill-workshop-executor.ts:483-486`仍只beginObject且unknown走reader.skipValue，不等于Rust derive sequence/IgnoredAny；`:865,897-899,1177`已保留精确Host值，旧Number化缺陷不再派回。Rust结构/输出见 `src-tauri/crates/dstu-agent/src/chat_v2/tools/skill_workshop_executor.rs:47-108,1282-1302`。全host的new SkillWorkshopExecutor仍仅测试，完整执行/保存边界不能由生产类测试签收。§15记录本轮证据。

- [ ] **WP-C2-VERIFY-010：workshop 13 条 ported 映射不具生产资格，应撤回 pending。** TESTMAP:323-335 的被测符号最终只汇入 `src/tools/skill-workshop-executor.ts:747,1009` 的 `propose/apply`；该类没有 `execute`，全 host 没有生产实例，`index.ts:226-236` 只注册 PTC，`chat/src/executor-roster.ts:14` 也不会收无 `execute` 的贡献。断言 13/13 与 Rust 对应，但不满足 standard-v2 §1.1。原声明 `0a3660ecb`；只撤这 13 行，不 revert 整个提交。Rust 对照 `src-tauri/src/agent_wiring/roster.rs:105-107`、`skill_workshop_executor.rs:1263-1302`。详见 §16。

## 建议

入口中的 SkillsService/ToolingService 类（`index.ts:42-176`）可移到 src，入口只接线。补充命令层失败清理验证：现有底层显式 rollback 测试不能覆盖 prepare 后提前返回的清理保证。

## 已核实通过

- [x] `agentSkills/agentTools` 命名、版本和服务声明一致（`api.ts:321-330`、`index.ts:55,150,190`）。通过 Cordis Service 构造函数注册，不能因没有字面量 ctx.provide 而判为未提供。
- [x] 文件命令的校验顺序、UTF-8 内容/大小与基本错误信封已核对；`CommandError(JSON.stringify({code,message}))` 对应 Rust ChatV2Error→String（`src/files.ts:69-85`），不是未包装 Error 导致 IPC panic。
- [x] install 的明确持久化失败分支确实 rollback，且提交后才持久化 provenance、最后 finalize（`src/skill-taps.ts:354-367` ↔ `src-tauri/crates/dstu-agent/src/chat_v2/skill_taps.rs:598-613`；market 同理）。不把这一正确分支与 L07-02 的 prepare 提前失败混为一谈。
- [x] PTC 测试确实执行平台 Starlark 引擎，不是 JS 仿写脚本结果：`src/tools/ptc-runtime.ts:684-697` 调用 `starlark.evaluate`；测试有实际脚本、准入拒绝、超时和 trace 断言。但生产接线仍缺失。
- [x] SQL 位于 repository，经 storage API；抽查 skill_usage/skill_candidates 写入属于本 lane（`repository/skill-usage.ts:85-114,242-285`）；未发现本 lane 写其他插件所有表。跨插件生产导入经 api，边界检查未抑制违规 `[]`；没有发现 console 或测试替身导入生产。

## 1. 命令等价抽查（15 条）

TS 路径相对 `host/plugins/agent-skills/`；Rust 路径相对 `src-tauri/crates/dstu-agent/src/chat_v2/`，另列 app 包装。以下“通过”指所列参数/结果/分支，ZIP 调度共性问题见 L07-05。

| # | 命令 | 结论与证据 |
|---|---|---|
| 1 | skill_probe_requires | 通过：三个 Option 数组缺省 []；bins/env/python 分别探测，无 env 值泄漏，missing_count 汇总。`index.ts:210-211`、`src/requires.ts:186-225` ↔ `skill_requires.rs:88-99,496,537`。Rust timeout 也不终止 blocking 子进程，未误判为 kill-on-drop 缺失。 |
| 2 | skill_list_directories | 问题 L07-04（warn）；主语义通过：先路径许可，缺目录返回 []，非目录错误，跳过隐藏目录。`src/files.ts:156-169` ↔ `skills.rs:371-433`。 |
| 3 | skill_list_package_files | 通过所查行为：根需 SKILL.md、缺资源 []，深度 4/最多 200、跳过 symlink/隐藏构建目录、按 UTF-8 字节排序。`src/files.ts:146-153,172-203` ↔ `skills.rs:446-591`。 |
| 4 | skill_read_file | 通过所查行为：许可→存在→is_file→读 UTF-8，保留 BOM，非法 UTF-8 错误。`src/files.ts:206-219` ↔ `skills.rs:596-630`；路径拒绝日志仍受 L07-04 影响。 |
| 5 | skill_create | 通过校验/返回主路径：2MiB 字节限额优先，id 字符再空串，校验最终 SKILL.md 路径，已有目录拒绝，返回 content/path。`src/files.ts:222-239` ↔ `skills.rs:647-729`。 |
| 6 | skill_update | 通过校验顺序：大小先于路径/存在/类型；写原文件并返回 content/path，不另加原子 rename。`src/files.ts:242-247` ↔ `skills.rs:744-782`。 |
| 7 | skill_delete | 通过：许可、目录存在、is_dir、SKILL.md，成功 null。`src/files.ts:250-257` ↔ `skills.rs:797-839`；路径拒绝日志见 L07-04。 |
| 8 | skill_import_zip | 问题 L07-05/06；dryRun 默认 false、虚拟/本地分流和包大小预检通过；本地读由 Rust bounded read 改为 readFileSync 全读后检查，IO 阶段也被合并。`src/skill-package.ts:808-841` ↔ `skills.rs:2321-2413`。 |
| 9 | skill_tap_catalog | 问题 L07-05；URL 候选→下载→scan 的 InvalidInput/IoError 分类和返回原 repoUrl/resolvedZipUrl/skills 通过。`src/skill-taps.ts:288-299` ↔ `skill_taps.rs:463-482`。 |
| 10 | skill_tap_install | 问题 L07-02/05；dryRun=false 默认、codeload 校验、先 prepare 再 digest、持久化失败回滚正确，但未保留提前返回 Drop 清理。`src/skill-taps.ts:302-368` ↔ `skill_taps.rs:490-613`。 |
| 11 | skill_export_tap | 问题 L07-05；空列表/64 上限/id→目标扩展名顺序、隐藏文件/marker 排除、README 计数通过。`src/skill-taps.ts:371-438` ↔ `skill_taps.rs:734-869`；app 命令 `src-tauri/src/chat_v2/skill_taps.rs:18-28`。 |
| 12 | skill_market_search | 问题 L07-07（底层 deadline）；defaults/分支/结果通过：24、true、trending；空 query 浏览，否则 trim 搜索；verdict 丰富结果；错误分类符合 Rust。`src/skill-market.ts:812-865` ↔ `skill_market_client.rs:1197-1234,1479-1486`。 |
| 13 | skill_market_skill_detail | 通过所查 wrapper：slug 原样交客户端校验，错误按同一分类。`src/skill-market.ts:868-870` ↔ `skill_market_client.rs:1238-1249`。 |
| 14 | skill_market_verify | 通过所查 wrapper：version 缺省按 None，校验结果原样输出。`src/skill-market.ts:873-875` ↔ `skill_market_client.rs:1253-1270`。 |
| 15 | skill_market_download_and_scan | 问题 L07-02/03；install/overwrite=false，verify→detail 解析 version、二次确认、digest/risk 绑定、临时 ZIP finally 清理、安装后缺省 tempZipPath 等分支通过。`src/skill-market.ts:878-1007` ↔ `skill_market_client.rs:1278-1476`。 |

契约核对：`contracts/ipc/L07-agent-skills-ptc.json:264-1043`。临时路径/结果的 Option omit 与 null 以契约及 Rust serde 为准；没有把市场 installed 结果不含 tempZipPath 误报为缺字段。

## 2. TESTMAP 真实性抽查

### Marketplace：15 条均通过所查断言

`R` = `src-tauri/crates/dstu-agent/src/chat_v2/skill_market_client.rs`；`T` = `host/plugins/agent-skills/tests/skill-market.test.ts`；对应 TESTMAP:20-34。生产链 `index.ts:16,200,232-245` → SkillMarket → SkillMarketClient；MockTransport 与 Rust 原测试的 transport seam 相同，未 stub 被测 client。

| 原 Rust 测试名 | R 行 | T 行 | 同一行为 |
|---|---:|---:|---|
| classify_zip_by_magic | 1928 | 56 | PK 魔数及完整 ZIP bytes |
| classify_github_handoff_json | 1937 | 64 | sourceRef/repo/path/archiveUrl |
| classify_rejects_unknown_json | 1951 | 74 | 非 handoff JSON 拒绝 |
| handoff_rejects_wrong_host_or_ref | 1957 | 78 | host 和 commit 不匹配 |
| install_verdict_is_exact_and_fail_closed | 1968 | 88 | version/安全状态精确匹配 |
| stale_artifact_policy_and_consumption_cleanup | 1989 | 101 | 24h 边界、实际文件清理 |
| parse_retry_after_seconds | 2010 | 114 | 7 秒解析 |
| respects_429_retry_after_then_succeeds | 2017 | 120 | 429 后第二次成功、调用数 2 |
| cache_hit_skips_second_http_call | 2044 | 132 | 两次 cache get；Rust 原测试也直接测 cache，并非请求链测试 |
| download_follows_github_handoff_branch | 2081 | 148 | handoff→重包的真实 ZIP 条目、调用数 2 |
| provenance_format | 2138 | 213 | slug@version 精确字符串 |
| decode_provenance_slug_and_version | 2146 | 217 | 反向拆分 |
| decode_provenance_rejects_non_skill_market | 2154 | 223 | 非 market 来源拒绝 |
| version_outdated_marks_when_remote_differs | 2159 | 227 | 同/异/空/trim 六种情况 |
| skill_detail_version_drives_outdated_check | 2171 | 162 | 真实 detail 解析参与版本判断 |

### PTC 补查：断言通过，生产接线有问题

`R` = `src-tauri/crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs`；`T` = `host/plugins/agent-skills/tests/ptc-executor.test.ts`。

| 原 Rust 测试名 | R 行 | T 行 | 结论 |
|---|---:|---:|---|
| execute_requires_central_dispatcher | 963 | 187 | 缺 dispatcher 拒绝，同原断言；L07-01 |
| execute_script_without_calls_inline_result | 974 | 194 | 真实 Starlark 返回 42、零调用/空 trace；L07-01 |
| execute_script_with_whitelisted_call | 990 | 206 | 一次调用及 args_hash/trace；L07-01 |
| execute_script_whitelist_rejection_fails_with_trace | 1015 | 223 | 拒绝且预算零；L07-01 |
| execute_script_budget_exhaustion_fails | 1037 | 236 | 第二次调用超预算，保留第一次 trace；L07-01 |
| execute_admission_rejection_surfaces_in_envelope_and_trace | 1056 | 250 | 子调用拒绝但脚本成功，失败 trace；L07-01 |
| execute_wall_clock_timeout_interrupts | 1084 | 267 | 1s 超时、<8s 结束、失败 trace；L07-01 |

另核对 `tests/skill-package.test.ts:283-301` ↔ `skills.rs:3082-3103`：两边都是**显式 rollback**，不能声称该原测试验证了自动 Drop。它的正确移植不覆盖 L07-02。

351 ported / 0 pending / 0 obsolete / 0 merged，路径均存在，无需要 approvals 的去向。但 PTC 的 ported 状态不满足 quality.md:65-66。wiring 从所有 index 构建导入图，还把 type import/re-export 计入；`api.ts` 可达不代表执行器被注册（`scripts/electron-migration/wiring.mjs:15,50-55,74-78`）。

## 3. 亲自运行的原始输出摘要

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/agent-skills
 Test Files  29 passed (29)
      Tests  406 passed (406)
   Start at  11:36:34
   Duration  19.74s
$ node scripts/electron-migration/importable.mjs host/plugins/agent-skills/index.ts
importable: ok
$ node scripts/electron-migration/wiring.mjs --lane agent-skills
合计 ported 351，其中所测模块未从 index.ts 接入 0（0.0%）
```

均 exit 0。运行中输出 Node `ExperimentalWarning: WASI is an experimental feature`，PTC 用仓库已有预编译引擎；未执行 cargo 或启动 Rust 应用。运行时校验和源码接线审读结论须同时保留。

## 4. 语义差异分类与架构结论

### 缺陷（应修）

L07-01～07 为本次发现的全部应修项：生产注册、异常路径清理、持久化时间、warn、CPU 调度、有界读取/阶段错误和真实 HTTP deadline。

### 已登记的平台差异（不冒充已获批准）

- **原子目录交换退化 rename fallback**：`SPEC.md:205` 已登记 Node 无 renamex_np；TS `skill-package.ts:621-675` 走 live→backup→staging→live，Rust `skills.rs:2039-2056` 等优先 exchange。这是记录在案的平台差异；本次未宣称 crash/并发读原子性相同，需协调者裁定其接受范围。
- **ZIP 压缩字节**：`SPEC.md:386` 已登记 zlib/miniz_oxide 字节不一致风险；源码为 TS `src/zip.ts:16,270-271` 对 Rust `skill_taps.rs:369-397`。不可仅凭相同 level=6 认定同字节。旧 provenance 用 ZIP 字节 SHA256，market handoff 也比较重包 bytes（`src/skill-market.ts:746-750`），因此影响不只“压缩包可解开”。没有 Rust 动态向量，本次不虚报具体差异字节；此项尚无 decisions 协调者批准，需同字节证据或明确裁定。
- **content:// 移动端通道**：`SPEC.md:187`/`index.ts:29-39` 记录桌面缺该通道；本轮桌面范围可保留明确拒绝，不能据测试里的虚拟 reader 声称桌面具备移动端 ContentResolver。
- 时间精度的全局平台决定不授权 `installedAt` 从 +00:00/AutoSi 变为固定毫秒 Z，故 L07-03 仍是缺陷。

架构总评：数据写入所有权与 import 边界在抽查内通过；PTC 生产接线、CPU 工作调度和文件生命周期不通过。仅静态可导入及全绿单测不足以认定 B 级。

## 5. L07-01 定向续审：收集器不等于 PTC 执行

修复候选提交：`358e562d6` 新增 `src/tools/executor-registry.ts`，后续 `789669c5c` 为文档记录。真实入口 `index.ts:146-162,220` 创建 agentTools 收集器并提供 registerToolExecutors/toolExecutors；`src/tools/executor-registry.ts:23-42` 的 execute 还是可选方法，运行逻辑仅 append/snapshot。

当前非测试全 host 检索 `PtcExecutor|ptc_run|runPtcScript`：没有 PtcExecutor 实例化与执行器注册；`host/kernel/agent-roster.ts:87` 只有名称常量，`host/plugins/agent-orchestration/src/tool-descriptors.ts:374` 只有 descriptor。两者都不是 Rust `src-tauri/crates/dstu-agent/src/chat_v2/pipeline.rs:174-180` 的实际 `PtcExecutor::new()` 注册。

新增 `tests/agent-tools-registry.test.ts:9-15,29-43` 仅注册自建 Canvas/ChatAnki routing 对象并断言列表/匹配，没有 PTC 或中央准入执行。此测试不能关闭 L07-01；本轮未重复运行该测试或旧 PTC 测试（无执行链修复证据），测试退出码记为“不适用”，不虚报 exit 0。上述只读检索 exit 0。

## 6. 完整候选 7455ad39f：七编号静态复核

### 基准与提交归属

本节全部 TS 行号指 **`7455ad39f:<路径>`**；本节简写 `src/`、`tests/`、`repository/` 均相对 `host/plugins/agent-skills/`。当前 review 未合入或摘取候选实现。

- `git merge-base --is-ancestor 7455ad39f main`：exit 1，候选尚未集成；runner 不执行。
- 新准则已读取 main 的 `quality.md:116-128` 与 `decisions.md:102-138`（D1～D6）。尤其 D3 要求内部精确、IPC 不额外拒绝合法 i64；D1/D4 不要求为单写者拆散原事务。
- 实际实现主体：`d5912d52f`（七项主修复及 ZIP worker）；`4b61b9d7b`（PTC 返回结果形状归一）；`3a58d7aec`（新增回归测试）；`4f28d58d8` 实际只增加 API 导出与 worker 导出用例，不是 worker 实现主体；`b93ecbb44` 含 connector parser/测试；`7455ad39f` 仅追加 LANE 报告。以上按 git diff 归属，不采信提交标题作为行为证明。

### 逐项结论

1. **L07-01：提供方注册静态确认，L04 生产消费未闭合。**
   - [x] `index.ts:222-231` 实例化 PtcToolExecutor 并真实注册；`src/tools/ptc-tool-executor.ts:36-40,50-83` 内部持有真实 PtcExecutor，脚本子调用回传 `context.admitted_tool_dispatcher.dispatchWithAdmission`，不再仅提供 descriptor/名称。对照 Rust `src-tauri/crates/dstu-agent/src/chat_v2/pipeline.rs:174-180`。
   - [x] `ptc-tool-executor.ts:103-125` 派生子 block/cancel、保留 session/run 信息，清除 shell_guard_approved/shell_authority_admission；对照 Rust `src-tauri/crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs:209-247` 的审批不继承不变量。
   - [ ] **真实调度器消费/独立 runner 待验证**：候选全 host 非测试检索没有 L04/L03 读取 `agentTools.toolExecutors()` 组装的生产调用。`tests/ptc-production-wiring.test.ts:37-49` 的 dispatcher 是测试 seam；测试从公开列表找到执行器后直接 execute（`:100-111`），不是 L04 registry 驱动。因此只证明提供方适配/委托设计，不能证明审批/预算/超时的真实中央实现已消费它。

2. **L07-02：所报 prepare 后提前失败的清理路径静态确认修复。**
   - [x] `src/skill-package.ts:704-705` 暴露 PreparedSkillPackage.dispose；install 的 finally（`:804-813`）、tap 的 finally（`src/skill-taps.ts:395-440`）、market 的内外 finally（`src/skill-market.ts:959-1015`）、update finally（`src/skill-updates.ts:335-390`）均覆盖 digest/risk/marker/来源解析的提前退出。原提交成功后的 `_stagingDir=''` 仍使 dispose 不删除 live 目录。对照 Rust `src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:2012-2017` 的 Drop。
   - [ ] runner 待集成后执行；显式 dispose 测试与 market digest 失败测试有真实文件断言，但尚无本轮执行结果。不以此宣称所有 committed guard 的 Drop/crash 原子性已额外验证。

3. **L07-03：market 持久化时间格式静态确认修复。**
   - [x] `src/skill-market.ts:975-984` 使用 `currentInstant().rfc3339`；候选平台 `host/platform/time/index.ts:142-151,181-186` 由同次 epochNanos 采样生成 RFC3339，保留 +00:00 格式；对照 Rust `src-tauri/crates/dstu-agent/src/chat_v2/skill_market_client.rs:1427-1439`。
   - [ ] runner 未运行；`tests/skill-market.test.ts:311-318` 检查 marker 的 +00:00/非 Z/可解析，只是格式回归，不是纳秒时间精度证明。D3 内部精度要求不得据此削弱。

4. **L07-04：原两个 warn 分支静态确认修复。**
   - [x] `index.ts:207` 把 ctx.logger 注入 SkillFiles；`src/files.ts:100-118,160,178` 在越界/非目录原分支记录 warn，再抛原错误。对照 Rust `src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:309-315,390-395`。
   - [ ] 新测试 `tests/files.test.ts:104-124` 验证两个 warning 及异常，未运行；不外推为全部 info/debug 日志审计完成。

5. **L07-05：worker 部分接入，尚未修完整。**
   - [x] `src/skill-taps.ts:362,386,455` 的 catalog/repack/export 与 `src/skill-package.ts:750` 的 scan 已调用实际 worker_threads；`src/workers/zip-pool.ts:81-100` 启动 zip-worker.ts 并 postMessage，worker 在 `zip-worker.ts:21-34` 执行真实 ZIP 函数。不是把同步函数换名或测试替身。
   - [ ] **遗漏生产调用点**：market GitHub handoff 的 `src/skill-market.ts:746` 和 tap 来源更新的 `src/skill-updates.ts:148` 仍直接同步调用 repackSkillSubdir（inflate/deflate）。这些正常下载/更新路径仍阻塞 Host，不能将“已有四个 worker 任务”解释成所有压缩已迁移。需接入已存在 worker 路径。
   - [ ] **worker 故障与无效 ZIP 被扁平化**：`src/workers/zip-pool.ts:115-127` 的任务失败与 worker error/exit 都 reject Error，`src/skill-taps.ts:362-363,386-389`、`src/skill-package.ts:750-751` 均映为 INVALID_INPUT。Rust 分开 join/运行基础设施错误（IoError，`skill_taps.rs:473-475,533-537`、`skills.rs:2158-2161`，均在 `src-tauri/crates/dstu-agent/src/chat_v2/`）与业务扫描 InvalidInput。恢复原阶段分类与上下文，不能把 worker 启动/退出失败报成用户 ZIP 无效。
   - [ ] 该实现为 lane 自有 worker pool（`zip-pool.ts:9-12`），不是已验证的平台池接线。现有导出测试只覆盖 Node 测试宿主；本轮 Linux runner 亦未运行，更无 Electron utilityProcess、打包路径、macOS/Windows 验证。不要将提供方 Linux 报告外推到这些平台。

6. **L07-06：原有界读取/open-read 分段静态确认修复。**
   - [x] `src/skill-package.ts:836-864` 独立 open/read 错误上下文；循环每次最多读取 `MAX+1-total`，达到 MAX+1 即停止并报增长超限，finally 关闭 fd；对照 Rust `src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:2397-2413`。
   - [ ] 当前新增测试中未见本地 open/read 故障注入或读取过程中越过 MAX 的定向断言；既有 `tests/skill-package.test.ts:371-375` 只覆盖虚拟 reader 错误/超限及不存在本地文件。runner 与本地阶段错误验证待补，不把源码静态界限当成实跑。

7. **L07-07：原 redirect 重置 deadline 的问题静态确认修复。**
   - [x] `src/skill-market.ts:64` 在循环外建立一次 AbortSignal，所有 hop 使用同一 signal（`:67-75`），最终 body read（`:99`）属于该 fetch Response；对照 Rust `src-tauri/crates/dstu-agent/src/chat_v2/skill_market_client.rs:72-86,122-136` 的单请求 timeout。
   - [ ] `tests/skill-market.test.ts:327-383` 分别断言三个 hop 共享 signal、单次 timeout 创建/abort 向调用者传播。它们保留被测 transport，只替换外部 fetch/时钟 seam，并非 stub transport 本身；但未实跑，也未证明真实重定向加慢 body 的端到端 10s deadline。该编号只覆盖原超时重置问题，不声称所有 reqwest 重定向细节已等价。

### 新增测试真实性与最小运行集

`tests/ptc-production-wiring.test.ts:78-91` 从真实插件的公开注册表取执行器；`:94-124` 执行真实 Starlark 脚本，断言子调用结果、数量、session/block/runId 和审批不继承。测试没有替换 PTC 被测主体；但外部 dispatcher 是自建对象，**不能算 L04 实际 dispatcher 的消费验证**。

其他新增用例：`skill-package.test.ts:335-347` 实际创建/清理 staging；`skill-market.test.ts:274-323` 真实包内核处理错误 digest 后确认没有 staging，再成功安装并读 marker；`skill-taps.test.ts:124-148` 经真实 exportTap 走 worker，检查输出计数/条目。没有在静态审读中发现它们反转原不变量，但覆盖范围不能扩大为整套失败生命周期或三平台 worker。

集成后的最小验证命令可按问题选择：

```text
npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/ptc-production-wiring.test.ts --maxWorkers=1
npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/skill-package.test.ts -t prepared_package_dispose --maxWorkers=1
npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/skill-market.test.ts -t 'persists_autosi|reuses_one_signal|propagates_abort' --maxWorkers=1
npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/files.test.ts -t warns_on_path --maxWorkers=1
npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/skill-taps.test.ts -t export_tap_archives --maxWorkers=1
```

**以上本轮全部未运行，退出码不适用；没有可报告的 runner Errors 行。** 实现者“31 文件 417 passed”不转录为独立通过；将来执行需按 quality §10.6 同时报 Errors 与退出码，不能只抄 passed 行。

### C1 已派回的大整数缺陷（不与原七编号混为已修复）

**版本限定更新：本段缺陷仅适用于旧候选 `7455ad39f`。新候选 `111fab06a` 已静态确认修复此 D3 子项，见 §7；不得继续把旧“拒绝合法 bigint”结论派回新候选。**

静态复核确认 C1 指出的 D3 冲突仍存在：候选 `repository/connector-ledger.ts:129-145` 将合法 i64 bigint 超过 JS safe integer 的值拒绝；例如 `9007199254740992n` 位于 i64 范围内，却在 `:137-138` 抛错。Rust `src-tauri/crates/dstu-agent/src/chat_v2/connector_ledger.rs:140,175` 为 `Option<i64>`/row.get，不存在 2^53 限制。

`tests/connector-executor.test.ts:488` 新增 TEXT 列类型拒绝测试不能证明合法大整数保真。D3（`decisions.md:118-121`）要求内部 bigint 精确传递/比较，在 IPC 边界遵循原 JSON 数字语义，不能通过提前 Number 转换或拒绝合法值“修复”精度。此项沿用 C1 既有派单，不另造重复编号；该候选不得据“更严格”签收。七个原父项暂不勾选，另明确保留该候选回归阻塞。

## 7. D3 增量复核：111fab06a

本轮只检查 C1 指定 D3 子项，不重做 §6 已确认的七项静态审读。`git merge-base --is-ancestor 111fab06a main` exit 1；仅读候选 Git 对象，未摘取实现、未运行 runner。以下路径相对 `host/plugins/agent-skills/`，行号固定该候选。

- [x] **静态确认：旧“合法 >2^53 bigint 被拒绝”缺陷已修。** `repository/connector-ledger.ts:74-96,140-158,205-214` 内部 expiresAtMs 为 bigint，读写接受完整 i64 范围 bigint，仅对越界值或已经不精确的内部 number 拒绝。不是 IPC 新增合法请求拒绝；实际 draft 输入的过期值由服务内生成（`src/tools/connector-executor.ts:762`），写库保留 bigint。
- [x] **静态确认：真实存储读取保持精度。** 四个查询 `repository/connector-ledger.ts:239-255` 均 `options.safeIntegers:true`，get/list 使用这些 query（`:257-292`）；平台 `host/platform/storage/connection.ts:128` 真正调用 statement.safeIntegers，非类型声明假接线。
- [x] **静态确认：比较/输出边界分开。** `src/tools/connector-executor.ts:499-508` 过期比较为 bigint，null/负数仍不算过期，符合 Rust `src-tauri/crates/dstu-agent/src/chat_v2/tools/connector_executor.rs:464-467`；`:796,827` 仅工具结果 JSON 边界转 Number，符合 D3:118-121，不将结果转回存储或排序。
- [x] **新增向量断言静态确认。** `tests/connector-executor.test.ts:222-262` 通过真实仓储/数据库往返 `2^53+1`、`i64::MAX`，比较各自前一整数与本值；`:264-288` 经真实 executeConfirm 断言工具结果为 Number。不是只测自造 bigint 算式；原过期向量 `:213-219` 仍保持边界、null 含义。
- [ ] **集成后独立最小实跑待执行**。代码提交 `7b04e407f`（仓储）、`26c15aef6`（比较/边界及向量）、`8365744b5`（测试改走公共 API）；`111fab06a` 是文档。候选未入 main，本轮无作业号、无 runner 退出码/Errors；不复用实现者结果。

进入可运行基线后只需通过全局队列提交：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/connector-executor.test.ts -t 'd3_i64|con_06_expired_drafts' --maxWorkers=1
```

本轮未提交该作业；后续报告须记录 job id 及 `job.mjs result <id>` 的原退出码/Errors。L07-05 的两处同步 repack 与 worker 错误分类仍在原队列，L04 真实消费/utilityProcess/三平台也未据 D3 更新而关闭。此子项静态修复不授予整 lane B。

## 8. L07-05/06 增量候选复核：db5bfe8f5

`git merge-base --is-ancestor db5bfe8f5 main` exit 1；仅静态读取该完整Git树，不摘实现、不跑旧基线测试。本节TS路径相对 `host/plugins/agent-skills/`，行号固定候选。`1aff05ac5` 是worker调用点/分类与测试主体，`60fc55f8e` 补worker说明/本地增长测试，`db5bfe8f5` 仅报告。

### L07-05：两个遗留调用点与错误分类

- [x] **静态确认：遗留同步repack已接worker。** `src/skill-market.ts:747` 与 `src/skill-updates.ts:156` 均 `await runZipTask('repackSkillSubdir', ...)`，已删除同步repack导入；该候选src内直接调用repackSkillSubdir只剩worker入口。对应 Rust `src-tauri/crates/dstu-agent/src/chat_v2/skill_market_client.rs:583-588`、`skill_updates.rs:170-174` 的spawn_blocking。
- [x] **静态确认：基础设施错误与任务内容错误分开。** `src/workers/zip-pool.ts:32-46,88-91,107-132,136-147,164-166` 对spawn/postMessage/error/exit/pool不可用使用ZipWorkerInfrastructureError；worker返回业务错误保留普通Error。调用者映射恢复 `Zip import task failed:`（`src/skill-package.ts:753-756`）、`Catalog scan task failed:`、`Repack task failed:`、`Export task failed:`（`src/skill-taps.ts:362-369,392-399,465-473`）为IO_ERROR，业务scan/repack仍INVALID_INPUT。market分 `Handoff repack task failed:`/`Handoff repack failed:`；update基础设施加`Repack task failed:`，业务错误原传。Rust对照仍为前述market/update、`skills.rs:2158-2161`、`skill_taps.rs:473-475,533-537,881-884`，未反转原不变量。
- [x] **新增测试静态核对**：`tests/zip-pool.test.ts:7-33` 用不可structured-clone的payload触发真实postMessage失败，并与真实无效ZIP worker任务错误区分；测试的是pool错误分类，不是命令层完整错误信封。`tests/skill-market.test.ts` 的 `handoff_repack_content_failure_keeps_zip_error_context` 经真实client/worker验证业务错误前缀；`tests/skill-updates.test.ts:73-100` 仅替换外部仓库下载seam，真实refetch/repack产生ZIP条目。没有把被测压缩主体stub掉。
- [ ] **独立运行与平台边界仍待**：候选未集成；自有worker池、utilityProcess/打包/三平台未验证。不能把上述静态修复或C1的tsc结果写成平台运行通过；旧两处遗漏/分类缺陷已在新候选修复，不重复派回这些代码。

### L07-06：本地open/read与MAX+1增长向量

- [x] **实现静态核对**：`src/skill-package.ts:842-870` 仍使用独立open/read上下文、MAX+1-total限制每次读取、finally关闭fd；没有因增加测试改变原有有界读取保证。对照Rust `src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:2397-2413`。
- [x] **新增阶段错误测试确实触及生产方法**：`tests/skill-package.test.ts:380-404` 对无权限文件检查open阶段，对Linux `/proc/self/mem` 检查成功open后的read阶段；未替换被测readZipBytes。
- [x] **平台不适用不能记作通过——后继静态修复确认**：旧db5bfe8f5在`:381,396`运行时return的问题，已由b34d4cbaa改为带原因的skipIf（新行号380-415，详见§9）。不再派回该已修问题；尚不代表跨平台或独立runner通过。
- [x] **增长向量精确界限——后继静态修复确认**：旧db5bfe8f5仅断言超限错误/calls>1的不足，已由b34d4cbaa记录并断言累计请求/返回MAX+1、末次1byte、达到上限后无读取及失败后调用数不变（详见§9）。没有用测试重写生产循环；独立实跑仍待。

### 作业来源与集成后的最小集

C1报告tsc作业`20261104064149-3db956`、local-read作业`20261104064139-aa41c2`均exit0；本轮未亲取/执行这些作业，不作为R1独立通过。**本轮无job id、无runner退出码/Errors（不适用）**。进入可运行基线且测试证据问题修正后，可分别最小提交：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/zip-pool.test.ts host/plugins/agent-skills/tests/skill-package-local-read.test.ts --maxWorkers=1
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/skill-market.test.ts host/plugins/agent-skills/tests/skill-updates.test.ts host/plugins/agent-skills/tests/skill-package.test.ts -t 'handoff_repack_content_failure|tap_refetch_repacks|read_zip_reports_local' --maxWorkers=1
```

本轮未提交。05/06父项保持待集成/独立验证，新增测试限制如上；不重做01～04/07/D3已审部分，不据局部修复授整lane B。

## 9. 仅 L07-06 后继差异复核：b34d4cbaa

本轮仅比较db5bfe8f5→b34d4cbaa的两个测试文件；生产`src/skill-package.ts`无变化。`git merge-base --is-ancestor b34d4cbaa main`返回exit1；未摘取实现、未合并候选、未运行旧基线测试。

- [x] **平台skip静态确认**：候选`tests/skill-package.test.ts:380-400` 对Windows的chmod语义/root权限绕过建立原因字符串并用it.skipIf；`:402-415` 对非Linux的/proc/self/mem场景同样显式skip，测试名包含原因。原open/read阶段异常断言和资源清理保留，不再让不适用环境以零断言passed计数。这里是测试夹具适用条件，不表示Rust功能在这些平台被删减。
- [x] **MAX+1读取不变量静态确认**：候选`tests/skill-package-local-read.test.ts:27-36` 仅替换外部readSync、记录生产请求length及返回量；`:74-81`调用真实readZipBytes并断言增长失败；`:85-88`精确断言两种累计量均为MAX+1、末次请求1byte、readAfterLimit=false；`:90-93`在错误返回后再过一个microtask，调用数保持不变。对应Rust`src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:2401-2410`的take(MAX+1)/超限不变量。当前生产读取循环同步，microtask后的检查不外推为其他异步I/O实现的通用保证。
- [ ] **候选集成及独立运行仍待验**：本次没有发现上述两个指定差异的剩余静态问题。C1提供的`073038-f5442f`（Linux36pass/0skip）及`073038-9acac1`（1pass）均exit0，属于协调者结果；未继承为R1独立实跑。本轮无job id，runner退出码/Errors不适用。

集成后的最小jobs只跑06相关场景：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/skill-package.test.ts host/plugins/agent-skills/tests/skill-package-local-read.test.ts -t 'read_zip_reports_local|stops_at_limit_plus_one' --maxWorkers=1
```

本轮未提交该作业。L07-06父项保持独立运行待验，不将已修的两个测试问题继续派回；不重跑05/D3、不授lane B，不将Linux结果外推utilityProcess或三平台。

## 10. main闭环复验与v2证据范围

main快照`eeaf5bdc7`，merge`21cc05604`；b34d4cbaa已是main祖先。对b34d4cbaa比较已审实现文件（files/package/market/taps/updates/connector-ledger/workers）无差异，沿用§6～9静态证据，只跑新增向量。

| job id | 最小目标/过滤 | 原始结果 |
|---|---|---|
|20261104105922-ff769c|skill-package、skill-package-local-read、zip-pool、connector-executor；`read_zip_reports_local\|stops_at_limit_plus_one\|zip worker pool error classes\|d3_i64\|con_06_expired_drafts`|4文件，8passed/55skipped，14.96s，exit0|
|20261104111742-4e66b9|skill-package、skill-market、files；`prepared_package_dispose\|persists_autosi\|reuses_one_signal\|propagates_abort\|warns_on_path`|3文件，5passed/70skipped，9.33s，exit0|

两个作业均用`node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts <上列测试路径> -t <上列正则> --maxWorkers=1`提交，随后result取完整输出。**原exit0、无Errors行**；日志`/home/dsdev/.oc-jobs/done/<job-id>.log`。skipped均为本轮-t未选中的旧用例；Linux非root的open/read两条实际运行，不能抄成63或75全部passed。

- D3两条真实数据库大整数往返/工具JSON边界与原过期边界测试均通过，关闭旧拒绝合法i64回归的待验子项；不另增父finding。
- 05的真实worker postMessage基础设施错误/无效ZIP任务错误两条通过；market/update已走worker的静态修复保持确认。**05父项仍有v2§1.7未闭合范围**：`src/skill-package.ts:842-868`有界读仍readSync；`src/skill-taps.ts:465-468`worker返回后写ZIP仍在Host同步执行。不得以worker分类绿灯签所有同步大文件I/O已隔离。既有两处同步repack和错误分类已修，不重复派回。
- 01未因本轮其它测试绿灯升级。C1报告`13aca0f98`改48条PTC为pending是生产真实性纠偏；该提交本轮ancestor main exit1，当前main TESTMAP仍351ported。登记候选303ported/48pending与main区别，不自行改TESTMAP或将本地注册链当真实L04 dispatcher。
- utilityProcess、打包与macOS/Windows未验证。已签收的是指定缺陷保证；整lane仍不通过，未决父项为01、05。

## 11. L07-05异步I/O后继候选：ddcd6dde9

仅复核C1新交付差异，`git merge-base --is-ancestor ddcd6dde9 main` exit1。以下行号固定`ddcd6dde9`，路径相对`host/plugins/agent-skills/`；未摘实现/合候选、未重跑旧通过集或ledger。实际代码/测试在ddcd6dde9；1bef65e53只改BLOCKERS/LANE/SPEC，不把文档commit当实现。

- [x] **本地读取静态修复确认**：`src/skill-package.ts:835-867`的stat/open/FileHandle.read/close均await fs/promises；每次读取仍限制`MAX+1-total`，open/read分别保留原错误前缀，finally等待close后才返回/报超限。对照Rust`src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:2378-2413`的tokio::fs/open/take(MAX+1)。原有同步磁盘读缺陷不再适用于此候选；Buffer组装/内存复制仍在Host，此处不声称所有CPU耗时为零。
- [x] **导出写入静态修复确认**：`src/skill-taps.ts:226-251`的writeFile/mkdir/rm改为await；本地直接写、虚拟暂存→writer→finally删除顺序和错误上下文保留。`:471-475`的真实exportTap在worker打包后等待异步写完成，不返回未settle Promise或提前删除staging。对照Rust`src-tauri/crates/dstu-agent/src/chat_v2/skill_taps.rs:693-732,762-884`。虚拟writer仍是同步外部接缝，本轮不声称桌面实现了ContentResolver。
- [x] **回归向量静态确认未削弱**：`tests/skill-package-local-read.test.ts:16-42`只将外部seam由readSync替换为实际open后的FileHandle.read，生产loop/open/close仍运行；`:83-96`保留超限错误、请求/返回MAX+1、末次1byte、无超限后读取及失败后调用数不变。`tests/skill-taps.test.ts:81-107`只把原同步调用改await/rejects，返回路径/字节/暂存清理/失败清理/本地无staging断言保留。
- [x] **新增让出向量针对真实函数**：local-read.test.ts:103-113、skill-taps.test.ts:110-120在实际读/写前安排setImmediate，await完成后断言回调已运行及字节不变。可检测原“async签名包同步磁盘操作”的退化；不把小文件让出测试扩称64MiB性能上限、utilityProcess或三平台实测。
- [ ] **独立复验待main**：C1亲取的`115144-605733`（34文件438pass/exit0）、`114750-ece318`（类型exit0、无Errors）为协调者提供方证据，不是R1本轮结果。本轮无job id、runner原退出码/Errors不适用。05父项尚未独立签收，不撤其它旧签收，也不升级01 PTC。

正常main包含候选后，只提交以下最小jobs（本轮未提交）：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/skill-package-local-read.test.ts host/plugins/agent-skills/tests/skill-package.test.ts host/plugins/agent-skills/tests/skill-taps.test.ts -t 'L07-05|stops_at_limit_plus_one|read_zip_reports_local|tap_export_virtual_destination_goes_through_staging_and_cleans_up|tap_export_local_destination_writes_directly' --maxWorkers=1
```

取result保留原退出码/Errors、区分-t过滤和平台skip；不跑全438。届时依据实际结果判断05原两处I/O缺陷是否闭合，平台未验继续单列，不把已修子项无限留在返工队列。本次无新增静态反例派单。

## 12. L07-05已入main：两处Host同步I/O残差最小签收

按C1“正常main解锁复验”指令执行。review HEAD `b70b5e238`，main基线`ad11a8394`；ddcd6dde9为实现/测试，1bef65e53仅文档，两者均已main。当前package/taps实现及local-read/taps测试与ddcd6dde9无差异，沿用§11逐分支审读，不将旧候选状态继续派回。

亲自经全局jobs提交§11完整原命令，排队期间核代码版本和显式skip条件，随后取result：

```text
job 20261104131936-08027e
npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/skill-package-local-read.test.ts host/plugins/agent-skills/tests/skill-package.test.ts host/plugins/agent-skills/tests/skill-taps.test.ts -t 'L07-05|stops_at_limit_plus_one|read_zip_reports_local|tap_export_virtual_destination_goes_through_staging_and_cleans_up|tap_export_local_destination_writes_directly' --maxWorkers=1
Test Files 3 passed (3)
Tests 7 passed | 42 skipped (49)
Duration 7.29s
原退出码 0；无Errors/Unhandled
```

日志`/home/dsdev/.oc-jobs/done/20261104131936-08027e.log`。42skip均为-t未选旧用例；Linux非root的open失败、/proc/self/mem read失败两条实际通过，非平台skip。7条对应：本地读让出、增长精确MAX+1、open错误、read错误、tap写让出、本地直接写、虚拟暂存成功/失败清理。测试调用真实生产函数，增长只替换FileHandle.read外部seam；未删改原断言。

签收范围只增加read/write两个残差，原worker/repack及其他已签项不重跑。本次没有独立提交438全套；此前官方门禁包含L07的广集是§5强制检查，并非本次最小专项。L07-01真实中央消费仍未决；utilityProcess、打包、macOS/Windows等三平台覆盖未验，不随Linux Node测试通过升级。

整体自检另有外部阻塞：该HEAD官方收据ok=false，tests作业`20261104131022-87fc5b`因F7正式tiktoken依赖缺失而exit1（2273passed/1failed/3skipped）；不将本专项exit0当整分支自检通过。已向C1/C2/F7及架构师交付该独立失败。

## 13. X6-UD-0004/0005 workshop JSON候选窄核

固定实现`3d6108625`、测试`82564b117`，两者本轮ancestor main均exit1；只读Git对象和Rust，不摘实现、不运行旧main同名测试。以下TS行号固定实现候选的src/tools/skill-workshop-executor.ts；R=src-tauri/crates/dstu-agent/src/chat_v2/tools/skill_workshop_executor.rs。

### 静态确认已修的部分

- `:40-54`以number|bigint保大整数，持久化workshopJson用JSON.rawJSON写数字token而非字符串；readProposalMeta在:464-474从原文创建公开F4 JsonReader，读完后end()。已知字段按输入序typed读取/判重复，缺字段最后检查；packageVersion u64、files.size usize的上界为u64MAX，合法大整数不被safe-integer cap拒绝。对照R:47-108,530-535。
- `:161-167`revision hash通过BigInt→writeBigUInt64LE精确写入；`:402`manifest比较及`:561,965`meta/marker/provenance序列化不经过Number。`:843-847`从marker的精确版本计算u64 saturating_add，MAX仍MAX，对照R:797-802,830。
- 新workshop-json.test.ts直接调用生产read/write/revision和SkillWorkshopExecutor.propose，使用临时真实文件；覆盖2^53/+1 hash区别、u64MAX文件size持久化、1.0/1e0/-0/溢出拒绝、重复known/Option null后重复、早坏字段先于后语法错、marker版本饱和与无效marker回退。没有把被测解析器复制进测试；旧测试未在该提交删除或减弱。但它未安装插件/kernel，不能称真实调度器端到端测试。

### 两类必须保留的残差

1. **typed接受集**：`:483`beginObject只接受map，Rust这些无flatten普通derive struct还支持sequence；`:486`unknown用skipValue。候选携带的F4 reader:351仍skipValue→readValue，深度/代理项校验与:398非有限数拒绝会多拒绝IgnoredAny原本能跳过的unknown值。L01 ACCEPTANCE §16已独立核锁定serde源码，F4 b6dc607f7另有skipIgnoredValue候选，但该workshop实现尚未显式消费，不能据公开reader名称签所有unknown字段。最小单文件通过也不覆盖这些遗漏。
2. **receipt不是已证明的IPC边界**：`:747-761`的公开propose返回Record<string,unknown>，内部proposeUpdate/list/apply在`:865,897,899,1177`主动Number化。R:837-854,882-904,1242-1258构造的json! Value保精确u64/usize；R:1282-1302将同一output既emit又交ToolResultInfo::success和save_tool_block。因此“工具JSON回执”并不授权在Host对象阶段舍入。新tests/workshop-json.test.ts最后三组只断言meta.packageVersion及proposal_revision，没有断言receipt.package_version/files.size，不能抵消此静态差异。

### Host消费链核查与证据边界

候选非测试全host检索SkillWorkshopExecutor只发现定义/API re-export及kernel agent-roster名字，未发现new实例/注册适配器；agent-skills/index.ts的实际registerToolExecutors只有PtcToolExecutor。故不能声称workshop receipt已抵达真正IPC，也不能虚构当前完整消费已跑通。现有L03通用工具历史函数`chat-pipeline/src/history.ts:61-69`把output同时JSON.stringify为模型上下文文本并保data_json，history-replay.ts:49-53同样序列化/复制Host结果；这些不是已接workshop的证明，却表明工具结果协议有内部消费者，未来接入必须保精确到持久化/模型文本及真正wire各自边界。L04停放与48PTC未决保持，不向停放lane追加执行任务。

C1亲取的153902-27684a红、154422-9d0ad1（两文件26pass）、154422-1d2f9c类型及155020-7128b8 Electron-Node新文件10pass仅登记提供方证据。本轮无R1 job、runner退出码/Errors不适用；Node/Electron-Node不外推utilityProcess/打包/三平台。

正常main包含候选后，只执行已约定的新文件（本轮未提交）：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/workshop-json.test.ts --maxWorkers=1
```

该结果届时只支持具体已修元数据/marker/hash子项；unknown/sequence/receipt与完整生产接线继续按实际修复证据判断，不扩整lane或撤旧L07-02～07/D3已签指定范围。

## 14. workshop receipt候选：38e43cbfe + 811c5a83c

两提交本轮ancestor main均exit1，未运行候选。`38e43cbfe`实际改实现及报告，`811c5a83c`为两条新测试；§13记录的提前Number化缺陷只适用于旧3d6108625。

- [x] 实现只撤四处转换：proposeUpdate/list/apply的package_version直接返回WorkshopUnsigned，list.files直接保留meta.files。metadata/marker/hash及版本饱和逻辑未变；Host对象精度不再因“工具JSON”命名提前丢失，仍没有虚构最终wire调用点。
- [x] `workshop-json.test.ts`新增`internal receipts retain the exact version through propose, list and apply`，真实临时文件/u64MAX marker→同一生产类propose/list/apply均断言18446744073709551615n；另一标题从persisted file size=9007199254740993读list并断言精确bigint。原10条元数据/词法/hash/饱和向量保留。测试仍是生产类/文件流程，不是已接kernel/中央调度的证明。
- [ ] 正常main独立复验待办：沿§13约定只运行新workshop-json.test.ts单文件，包含原元数据向量及两条新增receipt；当前此前10条也尚未由R1独立运行，不分两次重复同一文件。结果只签具体保证，不签unknown/sequence/完整工具链。

L07所报160540-285c73红2fail、160847-32b8db绿2pass/10过滤skip、160847-fd6792类型通过仅为提供方来源；本轮无R1 job/runner退出码/Errors。旧全量门禁不继承为新候选回执，48PTC/L04停放与平台未验边界保持。F4 skipIgnoredValue须正常main且由typed字段owner显式消费，beginObject并不等价struct sequence。

## 15. Linux续作：workshop精度子项main独立复验（2026-11-05）

固定review `13fd67329` / main `e9df01a3c`；祖先核验确认 `3d6108625`、`82564b117`、`38e43cbfe`、`811c5a83c`已集成。沿§13–14已完成静态审读核对当前实现：`src/tools/skill-workshop-executor.ts:483-549,843-865,897-899,1177`保留typed元数据/精确receipt，unknown与sequence残差未改。原候选“未入main/尚未独立运行”现在仅是历史。

恢复要求的三插件基线job `20261105000325-ee59c8`已包含约定的workshop-json单文件，故不再另提交同一文件：

```text
 ✓ host/plugins/agent-skills/tests/workshop-json.test.ts (12 tests) 604ms
 Test Files  135 passed (135)
      Tests  1654 passed | 1 skipped (1655)
   Duration  258.46s
[作业 20261105000325-ee59c8] 退出码 0
```

完整命令 `npx vitest run -c vitest.host.config.ts host/plugins/llm host/plugins/agent-skills`，全日志无Errors/Unhandled/FAIL，有WASI ExperimentalWarning。按文件结果计本插件 **35文件/453passed/0skipped**；上方总数含L01/L02。`importable: ok`，wiring原文 `合计 ported 303，其中所测模块未从 index.ts 接入 0（0.0%）`，均exit0。

- [x] **复核确认metadata/hash/marker/receipt指定精度闭合**：`tests/workshop-json.test.ts:33-46`验证2^53相邻revision区别及u64MAX文件size读写，`:49-66`验证整数词法/重复known/第一错误，`:68-91`真实marker饱和与回退，`:93-133`真实propose/list/apply回执u64MAX及list大file size。12条全部执行，无替换被测解析器。Rust结构/饱和/输出对照沿§13，原receipt提前Number化已关闭。
- [ ] **仍非完整typed或工具链签收**：unknown使用 `skipValue()`，struct仅 `beginObject()`；F4 `json-exact.ts:351`仍Value解码，候选skipIgnoredValue尚非main。当前new SkillWorkshopExecutor仍只有测试，测试未装kernel，属于真实生产类/临时文件流程，不是中央调度及save_tool_block端到端。
- [ ] **PTC剩余条件更新**：L04 `chat/index.ts:124` / `chat/src/service.ts:74-78`已经接执行器贡献与registry；L03 `chat-pipeline/src/execution-runtime.ts:215-224`仍等待chatToolRuntime提供，ExecutionContext的admitted_tool_dispatcher默认null。本轮PTC测试绿只证L07外部seam下的行为，不能把48pending改成ported。
- TESTMAP正文 **303ported/48pending/0merged/0obsolete**，头部仍351/0是生成统计陈旧；原测试与断言保留。utilityProcess/打包/macOS/Windows边界及既有压缩字节/目录交换待裁定范围不变。

## 16. workshop 13 条映射生产资格（WP-C2-VERIFY-010，2026-11-06）

基线 main `e1204ee8a`（含 `4723d8d46`）。`e13c2ad16` 不是 main 祖先，未计入。完整证据见 `docs/dev/electron-migration/audits/R1-review-llm.md` 的 WP-C2-VERIFY-010 节。

- [ ] **13/13 不通过（§1.1）。** 被测 TS 符号的非测试调用点全部在 `src/tools/skill-workshop-executor.ts` 内，终点是未注册、无 `execute` 的 `SkillWorkshopExecutor`。22 个导入 `agent-skills/api.ts` 的生产文件都不用这些符号。`agent-workspace/src/skill-packages.ts` 与 `agent-orchestration/src/custom-agent.ts` 的同名函数是各自的独立副本，不能为本组测试提供资格。
- [x] **断言等价复核确认。** 13 条 assert↔expect 数量一致且逐条对应。逐 assert 抽查了 328（批准后篡改，revision 先于 hash 的顺序与文案一致）、331（写入/回读）和 335（叙述常量，Rust 原测试同样只测字符串）。恢复接线后可直接沿用这些断言。
- 恢复前建议：`tests/skill-workshop-executor.test.ts:126` 的 root 已存在，弱于 Rust:1489-1490 的“两层都不存在”；`:223` 的 symlink 用例没有 Rust `#[cfg(unix)]` 对应的平台门。`writeProposalFiles` 把 create/write/fsync 三种错误文案合并为一种（TS:630-636 ↔ Rust:606-611）。
- `wiring.mjs` 报 0 未接入（job `20261105183316-84ff1d`，exit 0）是假阴性：它把 `index.ts:6-11` 的 `import type './api.ts'` 加上 `api.ts:214-223` 的 re-export 算作可达。
- TESTMAP 当前实际行为 323 ported / 28 pending（§15 的 303/48 已过时）。撤回 13 行后应为 310/41；本包按 R1 规则不改 TESTMAP。
