# F1 v2 真实跨 lane 阻塞（2026-11-04）

## WP-193 Shell typed 错误供方边界（2026-11-06）

本包无未就绪外部接口。ShellResponse 失败支保 error:string，增 errorData?:ShellErrorData，
ShellService 拒绝为公开 ShellError（op/message/data）。真实 MessagePort 覆盖供方接收与清理。
R4 VERIFY014 指出的整链还需 F2 WP194 从真实错误发送 code/message/details，L19 WP195 消费
公共 ShellError 恢复 BridgeError；两供方进 main 后由消费者验证，X6-LP-0089 不在本包关闭。
F5 冻结增补登记另包。其余旧组装/iLink pending 仍按各自包边界保留。

## WP-143 出站供方边界（2026-11-06）

WP096报告第39行的“仅bigint、无native raw atom时缺json/payloadJson”已由本包共享出站判定补齐。
既有协议与F4原生raw能力已在main，不需要新F2字段；真实MessagePort测试记录完整命令/错误/事件原文。
相邻整数投影可以相同，X1/X7应使用既有json/payloadJson精确记录，不能对投影stringify还原。
本包无供方接口阻塞；消费者联合录制/C签收、WP-133后继消费者与下方旧组装/iLink问题仍按各包处理。
正式验证结果和精确tip/base以WP-143交付报告为准，不用供方绿替代C。

## WP-133 供方与消费边界（2026-11-06）

F4 公共精确 Value 面已在 main（基线6898abaae），本包不再等待它。入站 argsJson→精确契约→handler
已实现；测试与确定签名见 API.md / tests/inbound-json.test.ts。后继工作不等于本包已经闭合：
- F2 WP134：原始 JSON `payload.data` 转发到 `InvokeRequest.argsJson`；没有文本的旧对象无法恢复已舍入数字。
- L15 `src/insight-commands.ts:70,99-100` ListArgs 与 L17 `src/insight-api.ts:160,216-217` /
  `src/insight-service.ts:317-319` / `repository/insight-cards.ts:547-553`：i64 参数类型需接纳 number|bigint，
  大 limit 的 clamp/Math.min 需由 owner 保 Rust 语义（offset 当前运行时直接传递，供方测试已证明）。
- F5 WP136：冻结增补 argsJson 与 api.ts 的 IpcInteger/IpcJsonValue；X1 WP135：真实 Shell/renderer复验。
- 非本包承诺：生成契约遗漏/自定义 Deserialize、既有复杂 serde 错误文案、全部业务数值消费与 f32 极端双舍入。
  未修改生成契约、消费方或任何既有断言/超时。原35条agent_wiring pending继续按各自真实依赖保留。

## 2026-11-05 续作核实（覆盖下方历史等待状态）

### 当前已解除项（19:05本地）

- F4完整Value原语与消费者已正常进入main并合入本树；capability-decode直接调用公共
  skipIgnoredValue/endArray，不再保候选存在性检查。`20261105110218-7efe84` Electron原文件6passed、
  exit0；全kernel `20261105110218-923c71` 原两条capability红和profile-generate均通过。
- W13正式生成38条清单，sync-startup第2条；已正常merge正规F3/L20 `527d79a12`，原F3
  `55884368c` 与L20 `b47197a30` 真祖先齐。F3公共API切换后Electron `20261105103517-f6ab97`
  三真实purge分支+raw两例5passed，exit0；最新generator --check `20261105110218-8633d7` exit0。
  不再把私有导入/无provider/身份归属列为当前阻塞。
- RAWJSON-02已发布正式字段与生产生成端给F2（`d2592fecb`），F5变更单 `1df7ba29e` 已登记。
  Host真实子进程10pass是生成/传输证据，F2 renderer联合仍待其实际消费者复验；一般Infinity
  serializer已撤回。其余35条Rust组装pending与iLink/必需finalizer政策保持独立。
- 最新kernel全量初跑249passed/1failed、exit1，唯一新失败是coverage断言未列新增fixture_raw_json；
  已在完整unregistered期望数组增该命令，原集合和其余精确断言保留，属于测试夹具更新而非业务放宽。

### W13 实际writer已交付候选，F1接线进行中

L20 `d74ad476b` 已提供 `host/plugins/sync/startup.ts`（default `dstu.sync-startup`，仅inject paths），
并迁出late sync的同名provide；此前“无writer/无候选”等待已解除。F1生成器已按精确路径补发现，
保原唯一provider/paths-only/固定位置逻辑；新增两条独立模块用例先红（`20261105095806-524ad3`），
实现后与原排序用例合计8passed（`20261105100106-02ffba`，exit0）。这只证明生成/loader接缝。
随后按C2明确授权正常merge真实L20提交（非复制源码），由正式生成器生成38条desktop清单：
kernel首条、dstu.sync-startup第2条、全部platform其后。`20261105101230-80cf78` generator --check
exit0；`20261105101230-e24cb0` 三文件13passed/exit0，含原profile一致性与真实官方purge消费：
reset执行时storage未发布且marker仍在，真实回调完成后state文件存在、marker清除、业务库可打开。
该证据不只验证声明，也未以测试服务替代provider。`20261105101230-3f7716` typecheck exit0。
最终组合仍待F3 `55884368c` 的openStartupDatabase公共出口和L20后继消费切换；L20已确认不会将
私有Connection/PROFILES导入留到main，F1不越界修改。最终source固定后再确认受影响的真实入口。

### F1-CONTEXT-01：固定 F4 类型分裂诊断（08:38Z，已交回 F4）

**正式候选闭环（更新）**：F4已按最终裁定提交 `f11a2cf5d`，仅移动其secrets/api已有Context
类型导入。固定 `71f7a3d10` / base `4a89995ce` 的正式作业 `20261105085124-e82e54` exit2；
F1已亲读完整日志18行，只有9条TS2339，无Context/F4路径/旧缺参TS2345。C2已接受该实际树的
限定修复证据，不再要求F2/F7修改，也不再把Context列为尚待定位。
剩余仅3个消费owner、4文件、7位置：L22 stream-context.ts:220（1条）；L18 text-formats.ts:59
及vlm-serde.ts:58/202/241（4条）；L14 question-import-service.ts:175/589（4条）。
历史L21已不在当前类型错误中。F4整体gate仍ok=false，候选尚未正常main发布；因此F1原capability
回归仍待这三个消费者与F4联合落地，不能由Context闭环推导其已通过。以下保留原诊断来源与撤回记录。

本项与三条旧fulltest红灯分开。C2提供原作业 `20261105073417-58e20e`：F4固定
`0a51a244c` / base `d41d57d68`，tsc exit2，1057 diagnostics / 247 files；同一安装目录的
Cordis `index.d.ts` 与 `context.d.ts` 两个 Context 分裂。

**最终证据以原tsconfig枚举顺序为准**。`tests/context-resolution.diagnostic.mjs` 只读指定git树的
TS/JSON，通过TypeScript自己的 `matchFiles` / `parseJsonConfigFileContent` 枚举根文件；首项为
`host/e2e/data-compat/data-space.test.ts`，不是git字典序的electron文件。编译器5.6.3，
`createProgram` 非增量，无buildinfo读写；候选改动只覆盖内存内容，不修改F4工作树或node_modules。
脚本exit0只说明诊断程序完成，**不等于被测树类型检查通过**。

| 作业 | 固定树 / 单一内存变更 | 结果 |
|---|---|---|
| `20261105082335-da0d8c` | base d41原版 | 0 diagnostics；两Context均63声明 |
| `20261105082335-012a53` | 0a原版 | 1057 / 247；barrel有59声明，内部Context仅6个核心声明 |
| `20261105082335-f12744` | 0a仅electron/api前置Context type import | 仍1057 / 247，不是实际输入的修复 |
| `20261105082803-954876` | 0a仅native/api前置Context type import | 10 / 5；两Context均63声明 |
| `20261105083337-7f70f5` | 0a将secrets/api已有底部Context type import移到顶部 | 10 / 5；两Context均63声明；最小归属F4 |

根因边界：F4新增 `secrets/api.ts` 的 `NativeArgon2` 内联import及backup重导出，位于已有底部
Cordis类型导入之前，改变可达输入顺序，使native/tokenizer等外部增强先合并barrel，Cordis内部
registry/reflect/fiber/events增强仍落到context模块。不是第二份依赖，也不是缓存才会产生的问题；
base同环境冷编译为0，不能称main全域类型故障。

交付给F4的最小修法：**移动**现有 `import type { Context } from '@deepseek-ai/cordis';`
至secrets/api.ts顶部，早于native引用/重导出；保留原 `export type { Context }` 和全部服务增强。
无运行时导入、cast、服务删除或依赖改动。残余10条仍为Value旧9条加旧0a测试漏tCost/pCost1条；
C2确认后者已由F4 `126fa6c33` 修正，此旧树实验不能签收F4当前tip或联合main。

**撤回的早期归因与失败记录**：`075434-7044ce` / `081608-14e84e` / `081608-6a1e98`
按git顺序传入rootNames，electron先入；其electron方案1057→10只对该顺序成立，不能用于正式F4输入。
已通知F2撤回 `747d76a90/fb4666ee6` 的缺陷修复因果结论；其本树绿回执不否认，但不代表本缺陷修复。
`080438-d3725a` 多变体程序OOM、exit128，只打印出explicit-context-export仍1057，未计成功；
现每个进程只运行一变体。`082803-b8156d` 重复新增secrets import产生额外2条Duplicate identifier，
因此最终方案移动原行而非新增同名导入。无需再跑无关排列或fulltest。

最终结论已投C2/F4/F2并escalate `2026-11-05T083856719Z-F1-kernel.md`；F4实际固定树正式落地与
官方typecheck仍由owner完成。F1诊断脚本先前console门禁违规已改为CLI stdout输出，无boundary豁免。

### main `10f987035`：L17 纯策略等待已解除，整条测试仍有其他提供方缺口

L17 `api.ts:13-15` 已公开 `createMemoryToolMetadata`；`index.ts:75-80` 提供同一实例并登记到
agentTools。Memory/AcademicSearch/LearningOverview 的纯敏感度与并发策略不再记“未发布”；
这些对象没有 execute，不能计入完整可执行 roster。下方早期“L17无任何出口/注册”是历史证据。

- `parallel_tests::read_only_executors_declare_read_only_class`：11条原断言中，L07 Fetch/Skills 与
  L17 Memory/Academic 的公共策略面已到位；仍缺 L13 `BuiltinRetrievalExecutor` /
  `BuiltinResourceExecutor` 的公开并发策略入口。当前 vfs/api.ts 未导出这些类/同源工厂；retrieval
  的真实登记在 index.ts:230-236，依赖 llmReranker 等完整服务，不能用 descriptor 或替身代测。
- `hooks_tests::phase9_non_low_tools_enter_the_fail_closed_approval_path`：L17 Memory 已可测；仍需
  L14 EssayGrading 与 L06 Subagent 的真实公共敏感度入口，不能用静态 descriptor 代替执行器策略。
- `hooks_tests::phase2_phase3_and_phase8_non_low_tools_fail_closed_without_approval_manager`：
  L17 Learning、L06 sessionSensitivityLevel、L19 IndexWebpage 公共面已到位；仍缺 L13 Dstu 的
  公共策略入口。L03 approvalManagerRequired 已有，不归为缺失。
- 其余32条完整registry/roster/headless/legacy用例继续等待真实执行器注册/组合绑定，不以metadata
  的加入标记ported。具体52/57名单只描述下方旧job保存的catalog，不外推成最新catalog统计。

已向C1交接上述最小公共入口需求；不需要为纯策略测试等待完整工具执行链，但须等原断言实际消费的
生产策略公开，F1不跨边界导入私有实现。F4/W13相关路径仍无变更，不循环重跑同一红灯。

### 03:04Z main-red 回派：main `dd564e12f`

已合入该 main。与 F1 `76e05ef8f` 比较，`host/kernel`、`host/profiles`、`host/platform/util`、
`host/plugins/sync/index.ts` 均无 diff。fulltest 的 profile-generate 与两条 capability-text 失败仍是
下述同一组未集成依赖，不是新的 F1 行为回归；wire-own-keys/fromDirectory 已不在本次失败名单。
main 仍缺 JsonReader.skipIgnoredValue/endArray/arbitrary Value；sync 仍在依赖 storage 的 apply 中
声明并提供 storageStartupSync，违反生成器 paths-only 约束。已再次 escalate：
`2026-11-05T030747326Z-F1-kernel.md`。请求正常集成 F4 候选及 L21/L22/L18/L14 消费闭包、
由 W13 接管者迁出晚期同名 provide 并发布真实早期入口。尚无本 lane 可独立落地的三项修复，
不复制 reader、不放宽守卫、不改断言，也不为同一依赖重跑已知红灯。

基线 main `e9df01a3c`，合并提交 `bf335b35d`；全内核 job `20261105000102-584cd7`
233 passed / 4 failed，exit 1。F3 缺省配置问题已解除，原 official-profile 安装测试通过。

- **main-red / F4**：`util/json-exact.ts` 只有 ParserNumber，未发布 `skipIgnoredValue` / `endArray`，
  `parseJsonDocument` 仍拒绝合法 arbitrary_precision Value `1e400`。F1 的 typed capability / flatten / Target
  已在分支，但两条 capability-text 回归仍红。已用 coord escalate（`2026-11-05T000404105Z-F1-kernel.md`）
  和 F4 队列请求真实原语；不复制 lexer，不放宽断言。enum 原语已在 main，不再等待它们。
  **F4/C2 回执**：三实现已在 F4 候选 head `1ab9ef162`：IgnoredAny `b6dc607f7`、endArray `a1c87c360`、
  arbitrary Value `94ab7c10a`；main `c6309183c` 尚不含。不是要求 F4 重写，阻塞是 L22/L18/L14 对
  新 JsonValueNumber 联合类型的消费方修复与正常联合集成；C2 已请求架构接管。到位后 F1 按公共 API
  直接调用并独立复验，两条失败未签收。不为相同依赖重复全量自检。
- **main-red / L20 W13**：`sync/index.ts:60,92` 把 `storageStartupSync` 作为晚期服务发布，inject 含
  storage/notes/syncSupport；官方生成器按已裁定的 paths-only 规则拒绝。L20 `PENDING.md` 明确此适配
  不是 pre-storage provider，尚缺独立开库接缝及入口授权。已通知 L20/C2：迁出晚期同名 provide，
  正式 provider 到位后 F1 才重生成清单并验真实 purge/reset；不得放宽排序检查绕过。
  C2 00:13 确认 L20 parked、信箱不会执行，已上报指定接管者；等待该接管交付，不伪称提供方在处理。
- **agent_wiring**：L04 `chat/api.ts:46-49,199-201` 已发布 registry/descriptors/组装 API，
  `chat/src/executor-roster.ts:16` 已生产消费 F1 `composePipelineExecutorRoster`；L07 legacy API 也已发布。
  旧“L04 registry 未发布”及“L07 legacy 未发布”不再成立。L05/L24 的 custom_agent 公共入口已到位，
  原测试已移植通过（job `20261105000803-708f42`，exit 0），TESTMAP 现为35条 pending。
  剩余全花名册与 headless/parallel/hooks 仍缺 L17 真实 `MemoryToolExecutor`、`AcademicSearchExecutor`、
  `LearningOverviewExecutor` 公共实现/注册（当前 `memory/api.ts` 无这些出口，`index.ts` 无 executor 注册）。
  不能用 memory CRUD 服务或同名分类替身代替这些工具执行器；已通知 L17，并请 C1 确认 W02 统一接线范围。
  L03 `chatPipeline.approvalManagerRequired` 已公开，两条 hooks 的阻塞是领域执行器，不再是审批判断 API。
- **iLink**：`chat/api.ts` 仍未发布 RemoteTaskManager / createRemoteTaskSession / task_command，
  L06 `AgentSubagentService.runHeadlessAgentTurn` 仍条件可选，`index.ts:711-714` 依赖未提供的 runner。
  F1-V2-04 保持真实阻塞；三个命令的整链完成勾选继续撤回。
- **政策**：必需 finalizer 注册失败与部分注册回滚仍待架构裁定，未擅自改变可选插件隔离规则。

### W02 正式 profile 实测（C1 00:33 确认后）

job `20261105003527-c8eec3` exit 0（诊断完成，不是原35条测试通过）：无 provide 替身的 createTestHost
安装正式 desktop.json，degraded=[]；读取真实 agentTools.toolExecutors，并经真实
chatSession.assembleExecutorRegistry([], L05 两个公开 approval policy 函数, workspace) 组装。
隔离临时 dataDir/XDG，finally 卸载并删除；未执行具体工具、未签收 AdmittedToolDispatcher/PTC 执行链。

20项注册贡献中18项有 execute：PtcExecutor、BrowserToolExecutor、IndexWebpageToolExecutor、
CanvasToolExecutor、UserTodoExecutor、NotesImportExecutor、BuiltinResourceExecutor、GenerativeUiExecutor、
AttachmentToolExecutor、FsrsSettingsExecutor、TemplateDesignerExecutor、ChatAnkiToolExecutor，以及
ChatAnkiMutation/Retemplate/Review/GetCards/Status/ApkgExecutor。另两项同名 DataGovernanceToolExecutor
没有 execute（L21 `backup/index.ts:196` 提供点），被 L04 的既有过滤正确剔除。

workspace=false 的 **实际 MissingExecutorError.names**（52项，保持原顺序）：

```text
AttemptCompletionExecutor, BuiltinRetrievalExecutor, InsightRecallExecutor, ConnectorToolExecutor,
TaskAuditExecutor, DstuToolExecutor, FetchExecutor, MediaToolExecutor, OfficeFidelityExecutor,
McpProposeExecutor, McpManageExecutor, AutomationExecutor, AcademicSearchExecutor, PaperSaveExecutor,
KnowledgeExecutor, TodoListExecutor, GoalExecutor, QBankExecutor, TranslationToolExecutor,
SettingsModelsToolExecutor, LlmUsageToolExecutor, LearningOverviewExecutor, DataGovernanceToolExecutor,
MemoryToolExecutor, SkillsExecutor, TextbookPdfToolExecutor, AskUserExecutor, SessionToolExecutor,
DocxToolExecutor, PptxToolExecutor, XlsxToolExecutor, ImageGenerationExecutor, WorkspaceFsExecutor,
LspNavigationExecutor, CodeNavigationExecutor, FileManagerExecutor, AttachmentStageExecutor,
SkillInstallExecutor, SkillMarketReadToolExecutor, SkillMarketInstallToolExecutor, SkillWorkshopExecutor,
SkillLifecycleExecutor, LocalShellPreflightExecutor, GitToolExecutor, SelfInspectExecutor, RolePackExecutor,
RuntimeRootRequestExecutor, LocalShellExecuteExecutor, EssayGradingExecutor, ReviewToolExecutor,
DocumentProcessingExecutor, WorkbenchToolExecutor
```

workspace=true 还依次缺 WorkspaceToolExecutor、SubagentExecutor、SuperSessionExecutor、
CustomAgentExecutor、CoordinatorSleepExecutor，共57项。app roster 抛错后尚未到固定尾部检查，
所以52/57仅为 app roster 阶段的缺失数，不是完整 pipeline 的最终缺失数。同次保存的贡献 catalog
明确显示：固定尾部 PtcExecutor 有 execute，ToolPackExecutor 和 GeneralToolExecutor 均未注入。
此尾部结论直接来自 job `20261105003527-c8eec3` 的 W02_CONTRIBUTIONS，未另启 profile runner，
也不表示尾部检查或工具执行已经成功。

这是**生产注册/绑定缺口**，不等于所有项都没有实现：例如 L07 api.ts 已公开 FetchExecutor/
SkillsExecutor/GeneralToolExecutor 等类，L05 已公开 createAgentWorkspaceToolExecutors；F1 不在测试里
把这些额外实例塞进 catalog 后冒称正式生产组装完成。C1 已收到完整名单与提供点，继续统筹所有者。
另外 C1 确认 chatToolRuntime 目前仅 L03 声明/消费/测试注入，无生产 provider；真实执行链仍受该独立阻塞。

F1 新审读确认 iLink 远程任务链未接通；请求发布真实 task_command/headless 接缝，不以注册命令当完成。

1. **F1-V2-04，L04/L06 API 未发布**：Rust `src/plugins/ilink_bot/mod.rs:442-556,596-696` 使用
   `RemoteTaskManager.dispatch/attach_session_at_generation/finish_turn_at_generation`、
   `create_remote_task_session`、`cancel_session_stream_with_retry`、`build_session_turn` 与
   `run_headless_agent_turn`。main `host/plugins/chat/api.ts:109-123` 仅公开 session CRUD，无 task_command；
   `host/plugins/agent-orchestration/api.ts:161-178` 的 headless 方法仍为条件可选。
   F1 `plugins.ts:71-77` 创建 bot 没有注入 `tasks`；旧 `RemoteTaskBridge` 无 Launch、代次、取消 token
   与逐 turn model/system prompt 参数，不能表达 Rust 协议。需要 L04 发布任务 manager 业务 API，
   L06 发布真实 headless 能力；F1 负责 binding/dedup、ACK→取许可→run、Stop→cancel→reply、结果日志和活动。
   未接线前不签收 plugin_start / plugin_set_enabled(true) / 扫码后自动轮询的整链 A。
2. **已解除：F3 main API**：main `d84e29565` 已包含 `9900d8dda` 及
   `registerFinalizer/runStartupFinalizers/finalizerNames`。仅 cherry-pick `-x 7fdd36afe`
   （7个F1文件）为`5d451e443`；正常分支做四例最小确认，不合整支证据分支，不重复原组合8例。
3. **36 条 agent_wiring 测试**：逐项分组见 `migration/testmap/F1-kernel.md:145-169`；需要 L04
   registry/descriptors、L03 pipeline 与各 lane 真实 executor。main chat/api 未发布 registry；
   X4 W02 的真实 roster 消费由 C1 协调。F1 已有纯组装函数，不用同名空执行器把这些行标 ported。
   **custom_agent一例的精确收窄**：L05 `api.ts:89-90`已公开safeToolSet/findCustomProfile；缺的是
   `src/workspace/tool-registry.ts:70`的真实CHATANKI_READONLY_TOOLS常量公开重导出。
   L24 `src/chatanki-executor.ts:522`已有生产ChatAnkiExecutor（index使用），但`api.ts:712`仅接口，无构造出口。
   请求真实类/工厂公开后即可由F1移植`chatanki_readonly_tools_are_allowed_and_low_sensitivity`；
   该用例无需等L04，也不借F3 profile失败推迟，不复制常量或伪造执行器分类。
4. **已解除：F7 vector入口**：main `16a254adf` 已有真实`host/platform/vector/index.ts`；
   官方生成器已运行并生成dstu.vector条目。最小装配单独验证，不等于全部native调用能力已通过。
5. **协调者明确暂缓 / 架构政策**：必需恢复/清理 finalizer 在业务 apply 注册失败时应如何阻止 ready，
   以及 F3 部分注册回滚的句柄，等待 C2 已上报的裁定；维持可选插件 degraded 规则。

F2 origin 不是阻塞：可信 frame URL 已经 main→runtime→WindowRef.source.origin；无需 renderer 新增 origin。
本轮无新增 npm 或原生依赖请求。以上不包含 F1 自有的解码/时钟/配置/错误处理修复。

## W13 pre-storage 接缝（C2 11月4日追加，精确方案）

Rust `lib.rs:1015-1063`：purge→同步消费基线reset→仅成功后清标记→业务库初始化。
F3 `syncStateDatabasePath` 和 pre-storage 消费测试已随最新main `d84e29565`集成；
main仍无真实L20 `storageStartupSync` 提供方，不能声称正式组合通过。

F1 最小接缝：**只在官方生成器设置一个显式 bootstrap 位置**。扫描到唯一声明
`meta.provides: ['storageStartupSync']` 的插件时，把其生成条目放在 kernel 固定首条之后、
所有 platform 条目之前；要求它 `inject: ['paths']`（拒绝 storage/syncSupport/notes 等依赖）。
不约束 L20 目录名/插件id，不改 F3 inject，不加通用阶段/调度器，不把业务 SQL 搬到平台。
现有稳定拓扑排序于是确定 paths→bootstrap→storage：bootstrap在storage前，且storage ready时paths已ready，
bootstrap必定先被选中。F4 paths 当前无inject（`paths/index.ts:422`）。

失败边界：导入失败仍profile fatal；bootstrap apply失败沿既有isolated降级，F3 purge回调取不到provider时
必须保留标记/记录startup_cleanup/不打开业务库（恢复状态路径），不把“正常ready”偷换成“清理成功”。
reset抛错同样由F3处理；D2执行失败仍fatal/no mark，恢复模式的gate行为保持既有裁定。
正常无purge不新增reset；upload_seq与五张消费状态表的事务全部归L20，F1测试不能用替身证明它们。

F1已验证真实生成器→现有loader的排序/隔离机制；F3 API已进main，L20正式provider进main后，需用正式desktop.json
加真实provider验证：无标记、purge成功、reset失败、marker清除失败；核五表/保upload_seq、标记/业务库/恢复状态。
这组真实组合仍pending；不会重复D2已签收8例或把fixture当L20交付。

## C2 DECODE/profile 补充（main ad11a8394）

- **正式storage未能发布（F3所有者修复）**：官方desktop.json的storage条目没有config，这是既有合法输入；
  `HostRuntime.start`（runtime.ts:377）原样把undefined交给Cordis，F3 `index.ts:74,120` 无默认参数却读
  `config.migrationsDir`。真实原入口作业 `20261104132815-be4e15` exit1：
  `dstu.platform.storage` inactive 原因为 `Cannot read properties of undefined (reading 'migrationsDir')`，
  随后平台核心检查失败，其余插件级联inactive。F1只增强失败诊断（保原cause及全部断言），未给fixture/profile
  填config绕过，也未改F3目录。需要F3修apply缺省配置并正常集成后，以同一官方profile复验。
  F3已提供修复候选`04e6c7ef7`（`apply(ctx, config = {})`）；C2确认该最小修复，但main `16a254adf`尚不含。
- **F1-DECODE-01剩余词法接缝**：F4候选`24941bb3d`的正式
  `host/platform/util/api.ts` 出口`JsonReader/parseJsonDocument/objectLastWins`已随main `bec9c35ba`集成，旧等待解除。
  F1值级领域decoder已独立实现并公开。CapabilityFile顶层map本来先读完整Value再from_value（last-wins且领域错误无行列）；
  顶层list则是typed Vec<Capability>，已知字段重复/类型错误必须早于后续语法错误。
  JSON.parse后不能补回这些信息；typed流式分支仍归F1。当前不宣称文件词法全等价，
  不复制F4 reader，不用schema/AJV错误冒充serde，也不拿此等待阻塞已独立完成的领域校验。
  新发现的最小原语请求已交F4：raw Target外标签unit map读完null后需跳空白、只检查并消费`}`，
  遇逗号就在未消费逗号位置报`expected value`（serde_json 1.0.149 `de.rs::deserialize_enum`）。
  当前`nextKey()`会前进到下个key末，`fieldError()`会条件关闭但没有成功关闭协议；不能反射私有index或复制lexer绕过。
  需要字符串key+colon挂起与单成员map结束的正式读取原语（或等价reader回调），F1仍拥有Target校验及整条typed分支。
  反例：`[{"identifier":"x","permissions":[],"platforms":[{"linux":null , "windows":null}]}]`。
  **提供方更新**：F4已在`17890ae41`实现`JsonReader.readEnumVariant(expected?)` / `endEnumObject()`，
  候选head为`6e41ad274`（后者本身是merge提交，不是两个方法的独立实现提交）。已只读核对源码：
  变体值读取前保留colon挂起，结束检查不消费第二个key；反例逗号前报错位置由F4回归覆盖。
  当前main `306eb8bbb`不含两方法；等待正常集成后F1接typed-list与原文错误次序，不复制候选或改私有reader状态。
