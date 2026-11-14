# F1-kernel 当前状态与下一步

## WP-193：Shell typed 错误传输公共面（2026-11-06）

- 开工合 main `f3753b682` 为 `1aa28157e`；WP182 已交付 `0427d9650` 并在本分支祖先中，
  此时 main 尚未带其 raw budget 修复。本包依赖的 ShellService/连接协议已亲核 main，未依赖外部新接口。
- 基线 typecheck `20261105200516-0d0be1` exit0；services+connection
  `20261105200516-335f52` 2文件20pass、exit0。
- 测试先行 `20261105200729-b8053c` 1pass/6fail、exit1：三条 typed 失败丢 data，
  普通错误/超时/断连三条尚无新增 data 字段；成功配对已绿。实现后
  `20261105201250-f7dab3` 新7例+原services/connection共27pass、exit0、无Errors。
- strict `20261105201023-8a7289` 3109files/0violation、exit0；ledger
  `20261105200853-6713c4` exit0，commands/tests/orphan problems均0。
- 按裁定增补 ShellResponse.errorData / ShellError.data，公开 ShellError 与 ShellErrorData；
  精确签名见 API.md §5。真实 MessagePort 测试覆盖结构化失败及既有四条 settle/清理路径。
- TESTMAP pending35→35，新映射0；F2 WP194 发送、L19 WP195 恢复领域错误及 F5 登记均为后继包。
  本包正式 gate、tip/base 与 raw 结果见 WP-193 交付报告。

## WP-182：工具结果预算保留 raw 数字原子（2026-11-06）

- 开工合 main `676b29852`。亲核 main `agent-api.ts::applyToolResultBudget` 用 Object.entries 展开原生 raw 原子。
- 先红 `20261105193420-343595`：9例 7fail/2pass，失败均为原子变 `{rawJSON}`（含 registry 默认预算两例）。
- 修复只在遍历中以既有 `serde.ts::isJsonNumberAtom` 原样返回原子；预算算法/文案未改。
- 绿 `20261105193849-38cae4`：新测试+agent-api+chat executor-registry 3文件58pass、exit0；
  typecheck `20261105193849-dd61a1` exit0。TESTMAP pending35→35，新映射0。

## WP-143：bigint-only 出站原始 JSON（2026-11-06）

- 保留 WP-133 正式交付 `23ee1e4d4` 完整祖先；开工合 main `136320e68` 为 `d503743c7`。
  已只读核 main 的 wireJsonOutput、json/payloadJson 协议及 F4 原生 raw atom 公共面。
- `json.ts::hasRawJson` 识别根部/容器内 bigint，复用既有一次序列化与 JSON.parse 投影；命令成功、
  CommandError 和广播/定向事件经原出口提供原始整数 token。protocol.ts 仅订正注释，无新字段。
- 真实 MessageChannel→serveHost 回归覆盖相邻9007199254740992/3、i64两端、0、数组/嵌套对象，
  同时核文本、投影和内部值；普通对象/Uint8Array/ArrayBuffer回归保留。
- 起点定向 `20261105183518-9a0dde`：4文件39pass、exit0。测试先行红证据
  `20261105183718-c65bd3`：2pass/2fail、exit1，失败为bigint-only结果缺json，非空响应精度证据。
  修复后定向 `20261105183859-6d7886`：6文件49pass、exit0，含原commands/services/raw/binary/own-key
  全部断言；起点typecheck `20261105183518-6293b6` exit0。正式gate与精确tip/base/raw日志见WP-143交付报告。
- TESTMAP pending35→35，原89条去向不变。供方交付解决WP096所列bigint-only缺原文残差；
  X1/X7录制与C签收由后继验证承担，本会话按WORKER仅完成WP-143后结束。

## WP-133：入站 JSON 源文精确解码供方（2026-11-06）

- InvokeRequest/DispatchRequest 增补 `argsJson?: string`，connection→runtime→commands 透传；JSON 时源文权威，
  raw bytes 与旧对象入口保留。复用 main 已有 F4 `parseJsonDocument/jsonNumberToRawJSON`，不复制 lexer。
- 契约校验先用精确原子校验 Rust integer 宽度及 JSON Schema 数值约束，AJV 仍校验容器/联合/required 等；
  成功后递归解码 typed 不安全整数为 bigint，Value 非安全/非整数字面量保 raw atom。
- 真实 MessagePort→serveHost→生产 review/index.ts 的 insight_list 处理器已验证相邻 i64、两端、null/default、
  原错误顺序；外部 insight 服务仅记录入参，证据止于处理器→服务边界，不冒称 L17 DB/全1058命令闭合。
- C1 已收到协议签名、错误形状与 L15/L17 消费签名需求；F2 WP134/F5 WP136/X1 WP135 后继包独立完成。
- 起点 typecheck `20261105175019-a8c027` exit0；kernel `20261105175019-7c1748` 36文件251pass。
  首轮传输+原commands/binary/raw回归 `20261105175912-009bf1` 28pass；递归补测
  `20261105180328-46011e` 5pass；typecheck `20261105175912-ca1ad3` exit0。最终 gate 以交付精确tip为准。
- 递归/tuple/union/数值上下界与原service回归 `20261105180807-1456ef` 2文件21pass、exit0、无Errors。
- TESTMAP 35 pending→35，未更改原Rust测试去向，旧组装/iLink问题不在本WP内续派。

## 2026-11-06 WP-074：页面开始加载生命周期端口（仅供方）

- 现有 `WindowLifecycle`/`host/window` 增补状态 `page-load-started`，对应 Rust `on_page_load`
  `PageLoadEvent::Started`（`src-tauri/src/lib.rs:487-491`）；不新建事件总线。`api.ts` 的事件签名改为
  `WindowLifecycle['state']` 单一来源并导出 `WindowLifecycle`。connection/runtime 路由不变，原样派发 WindowRef。
- 回归 `connection.test.ts` 经生产 `serveHost` 投递：window≠webview＋origin 原样到达，focus/close-requested/invoke
  不算页面加载，卸载后不再收到。F2 尚未发送该状态（`electron/shell/windows.ts` 只有五态），L10 cleanup 另包；
  D005-01 未关闭。protocol.ts 属 G0 冻结边界，需 F5 在 `contracts/CHANGES.md` 登记本增补。

## 2026-11-05 Linux 续作 / fix(main-red)

- 当前原三红已在新联合源通过：`20261105110218-923c71` 全kernel249pass/1fail，失败仅新增raw
  fixture引起coverage期望缺项，已精确补入不删原集合；capability原两例与profile-generate均绿。
  Electron capability `20261105110218-7efe84` 6pass/exit0；generator --check
  `20261105110218-8633d7` exit0；strict `20261105110218-558956` 3024files/0violations exit0。
  F4与L20/F3正式祖先等待已解除，F5 `1df7ba29e` 已登记RAWJSON-02可选文本合同；待F2 renderer联测。
  coverage的静态/真实host两处精确数组均需列新增fixture_raw_json；首次定向
  `20261105110521-eb1c95` 14pass/1fail暴露第二处，补齐后 `20261105110633-aa8edf`
  1pass/14按-t过滤、exit0。原断言未删，新增夹具即新增未注册项。typecheck
  `20261105110218-fc54c6` exit0；ledger `20261105110218-1e45b6` exit0、problems全0。

- **F1-RAWJSON-02获批协议已实现**：InvokeResponse两支json? / BackendEvent.payloadJson?，
  仅原生raw消息，JSON文本及投影同源，混合typedInfinity/NaN仍null；ordinary/binary无字段。
  red `20261105104913-504545` 两失败；首次生产进程例因fixture ACL漏新命令失败
  （`20261105105149-7fafb6` 19pass/1fail），已只增fixture许可，保断言。
  `20261105105513-1aa321` Electron 2文件10pass/exit0，含真实Host子进程success/error/event与
  ordinary/binary分支；`20261105105149-562098` typecheck exit0。未改F2消费方，renderer联合仍待其落地。
  原7bc gate已结束4/5通过，唯一新fixture generator/$defs类型遗漏已修；不将旧gate写成全绿。

- **F1-RAWJSON-01实际修复**：kernel/json.ts用原生JSON.isRawJSON识别，在toWireJson出口才
  JSON.parse原token，避免L18→L14 question-import-progress数字变成{rawJSON}对象；普通同形对象不改。
  red `20261105102753-373c9d` 两失败；green `20261105102850-172e58` 四文件39passed，
  Electron `20261105102850-8c0a5c` 两passed，均exit0。typecheck捕获新测试schema布尔值不合
  JsonSchema类型（`20261105102850-682be0` exit2），已改为正式serde_json::Value注解，断言保持。
  F2后继JSON.stringify对Infinity/-0仍有独立出口缺口，已交C1/C2/F2，不声称极值整链闭合。
- W13真实官方三分支：`20261105102038-6a0818` Node与`20261105102038-b57f59` Electron
  各3passed/4按-t过滤、exit0，无Errors，覆盖purge成功/reset真实开库失败/marker真实unlink失败。
  现已正常merge L20最终 `b47197a30`（含F3公共API内容），后继reset不再私引F3实现；F3原SHA
  祖先归属仍由C2/F3收口，最终固定组合只确认受影响入口。ledger `20261105102038-bcc495` exit0。

- W13新writer已交付 `d74ad476b` 的sync/startup.ts；F1已补生成器精确入口发现，保paths-only守卫。
  新独立模块测试red `20261105095806-524ad3`：3passed/2failed，exit1；实现后
  `20261105100106-02ffba`：2文件8passed、exit0。按C2明确授权正常merge L20真实提交后，
  `20261105100915-4706c1` 正式生成38条清单，bootstrap第2条；`20261105101230-80cf78` --check exit0。
  `20261105101230-e24cb0`：官方生成/安装/排序三文件13passed、exit0，含真实purge回调在storage
  发布前消费、marker清除及业务库打开；`20261105101230-3f7716` typecheck exit0。
  最终仍需F3 `55884368c` 公共开库API及L20消费切换，候选的私有F3导入不作为最终main闭环。

- Context诊断已获正式候选验证：F4 `f11a2cf5d`，固定 `71f7a3d10` / base `4a89995ce` 的
  `20261105085124-e82e54` exit2，F1亲读只剩9条Value TS2339，无Context/F4路径诊断；C2已接受
  该限定修复。当前待联合发布的是F4＋L22/L18/L14三消费owner（不是历史四owner），整支仍未绿。
  F1自有Context定位任务已交付；main尚未有新原语，capability/W13及35条pending仍未解除。

- **F1-CONTEXT-01 已定位并交owner**：正确原tsconfig根枚举下，固定F4 `0a51a244c` 冷编译复现
  1057/247，base d41为0；仅移动F4 secrets/api.ts已有Context type import到顶部即降为10（旧Value9+
  旧测试参数1），两Context统一63声明。最终job `20261105083337-7f70f5`；实际修复归F4，不改其树。
  早期git根排序导致的electron修法结论已撤回，OOM exit128保留，完整证据见BLOCKERS的专节。
  诊断脚本门禁console违规已改CLI stdout；不把诊断exit0当作F4联合树通过。

- 自动续作合入 main `10f987035`：F4/W13路径无变更；L17已发布真实生产metadata的纯策略入口，
  不能再把parallel/hooks整组归为L17未发布。仍缺的L13/L14/L06公开策略符号已逐例记入BLOCKERS并交C1；
  35条pending保留。L24 createChatAnkiExecutors新增真实library-list执行器，已提交custom_agent最小回归
  `20261105032703-4db900`：1 passed、exit 0、无 Errors，只验证新main对已有原断言的影响。

- 03:04Z fulltest 回派已核：分支快进到 main `dd564e12f`；三条失败相关 kernel/profiles/util/sync
  入口自 `76e05ef8f` 均无变更，仍缺 F4 正式集成与 W13 提供方接管。再次上报架构师
  `2026-11-05T030747326Z-F1-kernel.md`，精确证据见 BLOCKERS；未把阻塞说成修复完成。

- 已读交接并合 main `e9df01a3c` 为 `bf335b35d`；旧代码进度保留，未重做已迁移单元。
- 首轮内核 job `20261105000102-584cd7`：34 文件，233 passed / 4 failed，exit 1。
  其中 F3 缺省 config 已修，真实 official profile 安装通过；capability 的 fromDirectory 原文接线已通过。
- wire-own-keys 的 reject=true 根因在 F1 `CommandError` 构造期 JSON.stringify，早于命令边界执行
  非法类值的 toJSON；同一路径还会拒绝内部合法 BigInt。已修构造诊断并保留原 value，新增 debug/release
  错误 BigInt 边界回归。job `20261105000644-82e9c9`：3 文件 30 passed，exit 0，无 Errors。
- capability 原文解码仍有两条失败，缺 F4 IgnoredAny/endArray/arbitrary Value；profile generator
  被 L20 晚期 storageStartupSync 声明阻断。证据与上报回执见 BLOCKERS 顶部，不改所有者实现、不弱化断言。
- 首轮 typecheck `20261105000102-eb8745` exit 2：endArray 尚未发布且旧保护分支未让 TypeScript 收窄；
  已修正分支收窄，等待正式 F4 方法后改为直接消费。复验作业 `20261105000804-113f73`。
- ledger `20261105000329-a2e5c1` exit 0：commands 1058 (A 100% B 0% C 0%), tests 8109
  (A 87.8% B 1.9%); problems: commands 0, tests 0, orphan registrations 0。
- L04 registry/descriptors 已发布并消费 F1 roster；L05/L24 custom_agent 接口也已发布，已新增原断言的
  真实公共入口测试（`agent-wiring-custom-agent.test.ts`）。其余测试准确阻塞更新见 BLOCKERS；
  不再把“L04 未发布 registry”当作当前原因。
- custom_agent job `20261105000803-708f42`：1 passed，exit 0，无 Errors；TESTMAP 已标 ported，
  实际52 ported / 2 approved obsolete / 35 pending。
- 复验 typecheck `20261105000804-113f73` exit 0；strict `20261105000804-48c8fc` exit 0，
  2950 files / 0 violations；wiring `20261105000804-503814` exit 0（工具仍不扫描kernel，不能当作全量接线证明）。
  Electron `20261105001443-ea31a2`：2 文件 / 7 passed，exit 0，无 Errors；F1 plugins.ts importable: ok。
- F4/C2 已确认剩余三原语有实现候选，当前待联合集成；W13由C2上报接管停放L20，不重复相同红灯全量测试。
- `fix(main-red)` 提交 `9a00069e2` 的官方 lane-gate：3项全通过，基线 main `c6309183c`。
  W02 新的正式profile诊断 `20261105003527-c8eec3` exit 0：degraded=[]，app roster阶段分别缺52/57项，
  完整原始名单、L21 metadata-only贡献和C1回执记录在 BLOCKERS；不把诊断退出0计成Rust测试通过。
  更新 TESTMAP 后 ledger `20261105001436-9bf915` exit 0，无 commands/tests/orphan problems。
- C1 补充边界已记录：同次 catalog 的固定尾部只有 PtcExecutor 有 execute，ToolPackExecutor /
  GeneralToolExecutor 未注入；52/57不是完整pipeline最终缺失数。仅补文档，不重复启动profile。
  C2已接受构造修复与原字符串断言；当前其余未决项待正式提供方变化后按原ID续作。

更新：2026-11-04（新会话，基线 `main` 已合并）。行为规格在 `migration/spec/F1-kernel.md`，
测试去向在 `migration/testmap/F1-kernel.md`；本文件只记录状态与阻塞，不替代 SPEC/TESTMAP。

## 已完成（生产代码已随 main 集成；本文件与最新文档提交除外）

> v2：以下是旧账本/既有证据，不等于整链验收；接手发现的缺口见文末。

- **11 个插件命令**全部注册，旧 ledger 中全部 A 级；v2 已撤回 start/set_enabled/begin_login 三条整链完成勾选（F1-V2-04），静态 A 不代表真实任务链完成：
  `plugin_list/start/stop/get_status/get_config/set_config/set_enabled/begin_login/cancel_login/logout/unbind`。
- **89 个 Rust 测试**：53 A（51 个 `ported` + 2 个已批准的 `obsolete:rust-mutex-poisoning`；ledger 对
  obsolete 同时记 B）、36 pending；pending 全部是跨 lane 的 `agent_wiring` 组装用例（见下），
  待真实执行器；另外远程任务胶水待 L04/L06 发布业务 API（F1-V2-04）。
- **官方 profile**：最新main已发布vector入口，`host/profiles/desktop.json` 已由生成器重生成37条（`20261104135341-006a79` exit0）；插件按 inject 稳定拓扑排序，
  缺服务/apply 失败按插件隔离并汇总 `host://plugins-degraded` 与 `plugin:host|status`。
- **窗口 capability ACL**：`host/kernel/acl.ts` 读取 `src-tauri/capabilities/*.json` 与 `permissions/*.toml`，
  按 platform/window/webview/origin 校验，拒绝文案对齐 Tauri 2.11.5；`main.ts` 的生产入口已接线，
  `origin` 由 F2 从 main 持有的可信 frame URL 推导（`electron/main.ts:328`、`electron/shell/runtime.ts:241/253,298`）。
- **serde 放宽**：unit enum 的 `{"Variant": null}` 按 `x-also-accepts` 接受；tagged/untagged/flatten/tuple/NonZero
  的 detail 保持 ajv 文案，已审读前端无依赖（`host/kernel/API.md` 记录依据）。
- **D3 BigInt 边界**：内部保留 BigInt，只在命令结果/错误、事件载荷、`plugin:host|call` 线上边界转 JSON number。
- **x-binary 结果边界（X2-R05）**：`result.x-binary === true` 的契约允许 `Uint8Array`/`ArrayBuffer` 原样穿过 Host，
  `__dstuRawBytes` 信封继续兼容；非 binary 命令仍拒绝二进制。
- **listenWindow target/source（C2 05:49 纠正）**：订阅按 `EventTarget::Window{label}` 登记，`emit` 广播可达，
  `emitTo` 只达目标窗口；`source` 不参与接收范围；disposer 幂等并随插件卸载撤销（commit `902d86ee3`）。
- **D2 启动收尾组合根**：`connection.ts::boot` 在 profile 装载后调用 `finishStartup`；正常执行 finalizer 后
  mark gate，恢复模式跳过 finalizer 但仍 mark，失败发 `HostFatal`/exit 1 且不 ready/gate。
- **F4 版本测试目标**：`host/kernel/connection.test.ts::app_version_is_injected_from_app_manifest` 经生产握手
  把真实 `src-tauri/Cargo.toml` 版本送入 `ctx.app.version`（commit `1b3cedeaa`）。
- **验证（本会话，main `081b3426d` 合并后）**：typecheck 作业 `20261104091743-4f0579` exit 0；
  `host/kernel` 测试作业 `20261104091743-b5250a` 24 文件 198 用例全过、exit 0；
  `node host/profiles/generate.ts --check` 通过。

## 真实跨 lane 阻塞（有证据，不重复实现）

1. **F3 finalizer API 等待已解除**：main `d84e29565` 已包含 `9900d8dda`，公开
   `registerFinalizer/runStartupFinalizers/finalizerNames` 及 `syncStateDatabasePath`。
   仅属F1的7文件测试提交已按批准方案 `cherry-pick -x 7fdd36afe` 为 `5d451e443`，没有合混合证据分支。
   原8例证据不重做；正式接口集成后仅确认 `connection.startup-real.test.ts` 四例（Node/Electron）。
2. **36 个 `agent_wiring` 测试**需要其他 lane 的 executor/registry 实现，F1 已迁移自己的组装纯函数
   （`agent-roster.ts` 的 63 个执行器顺序 + coordinator 组 + L03 固定尾部）：
   - `roster_tests`（22）与 `descriptor_tests`（4）：L04 `ToolExecutorRegistry` / `BUILTIN_DESCRIPTORS` /
     `assemble_registry`，以及 L02/L03/L05/L06/L07/L10/L13/L14/L17/L18/L19/L21/L24 的执行器实例。
   - `legacy_tests`（5）：L07 `LegacyToolProvider` 与 L04 旧注册表（其中两条只依赖构建器的用例已移植）。
   - `hooks_tests`（2）：L03 approval manager 与 L05 审批管理器。
   - `custom_agent_tests`（1）、`headless_tests`（1）、`parallel_tests`（1）：L05/L24 执行器与 L02/L03 白名单/只读类。
   - 证据：main 的 `host/plugins/chat/api.ts` 未公开 `ToolExecutorRegistry` / `BUILTIN_DESCRIPTORS`；不能把其他已导出的事件/state类误说成“只有类型”。
   这些用例断言的是对**真实执行器**的组装，不用占位 executor 冒充；等 L04 registry 与各 executor 进 main 后，
   先由 L04/pipeline 消费 `composeAppExecutorRoster`/`composePipelineExecutorRoster`，再把对应 TESTMAP 行改为 ported。
3. **已解除：F7 `dstu.vector` 入口**：main `16a254adf` 有真实 `host/platform/vector/index.ts`，生成器已收录。
   `profile-vector.test.ts` 从正式生成清单选取并安装/卸载真实provider；该装配证据不代表所有native能力通过。
4. **F2 的 invoke source origin 已闭环，不是待办**：main 的 `electron/main.ts:325-327` 只从 main 持有的
   `WebFrameMain`/`WebContents` 读取真实 frame URL；`electron/shell/runtime.ts:240-253,298` 用该 URL
   构造 `WindowRef.source.origin`，不信任 renderer 自报的 `message.headers.origin`；
   `browser-surface-host.test.ts` 已断言伪造 `headers.origin` 不污染 source。F1 侧 `acl.ts` 已支持
   origin。当前没有需要 F2 重复实现的具体 Host ACL 差异；若以后发现，须附真实 source/target/调用证据
   再单独立项。
5. **政策待架构师裁定**：可选插件 `apply` 中 `registerFinalizer` 失败仍按 degraded 隔离，boot 可继续 ready；
   若失败插件本应提供必需恢复/清理钩子，当前会把“启动不完整”呈现为“可选插件降级”。F3 registry 注册失败
   也没有注销已成功钩子的句柄（部分注册泄漏）。F1 不擅自把全部 apply 错误改为 fatal；显式重试只允许外壳/恢复
   编排在获得失败状态后触发，业务插件不得 catch 后自行启动或定时等待。

## 下一步顺序

0. W13：官方生成器已加入 `storageStartupSync` 显式 bootstrap 位置（仅依赖paths，早于platform），
   接缝测试已通过，F3路径API已进main；等 L20 真实provider合入后，生成正式profile并验证purge/reset/marker/业务库整链。
   详见 BLOCKERS.md 的W13精确方案；不是D2 post-plugin finalizer。
1. F3已集成，`7fdd36afe`已带回为`5d451e443`；完成真实链四例的最小确认与standard-v2 §5 lane-gate。
2. 等 L04 registry/各 executor 进 main：接入真正的 roster 消费方后移植对应 `agent_wiring` 测试。
3. F7 vector入口已进main并重生成清单；最小装配验证见本轮记录，不再等待index.ts。
4. F2 origin 已从 trusted frame 设置，无需等待；若后续发现 Host ACL 差异，用真实 source/target 证据单独立项。
5. 架构师对“必需 finalizer 注册失败”的政策裁定后续改 gate 语义；裁定前保持现状。

## 复核“必须修复”状态

当前无 `migration/acceptance/F1-kernel.md`，也无未处理的复核“必须修复”项。C2/X2 本轮已确认：
target/source 路由（`902d86ee3`）、D3 BigInt、F4 版本测试（`1b3cedeaa`）、x-binary 边界（`0f3c8ef7f`）
均已完成；剩余项都是上面列出的跨 lane 集成或政策裁定。

C2 2026-11-04 08:26 回执：接受只 `cherry-pick -x` `7fdd36afe`（不整支合入证据分支），依赖 F3
`9900d8dda` 与 F1 `5d373dbf2` 正常集成；main 缺 F3 时暂不强行带入；D2 注册失败政策已追加
`082349530` 的真实泄漏证据。本轮无需再跑 ledger 或重复 8 例，正式接口/政策到位后恢复。

## v2 接手盘点（2026-11-04，GPT-6 Astra）

### C2 补充排雷：F1-DECODE-01 / F1-DECODE-02

本轮基线main `ad11a8394` 已包含上一轮结构校验，不能把旧行号的直接JSON断言当作当前仍未修改。
以下使用C2新finding ID，不冒用X6编号，不改已有前置校验的profile.ts断言。

| finding | 当前证据 / 尚需处理 | 验证入口 |
|---|---|---|
| F1-DECODE-01 | `acl.ts:23-68,247` 已有结构校验；仍未保留供F2消费的allow/deny scope，检查按固定字段次序而非serde值访问次序，权限Identifier未按Tauri解码，Target单元enum map形态缺失；抽出并公开唯一capability领域解码器 | 真实文件→CapabilityAcl.fromDirectory→denial；公开解码器保scope、unknown/default与错误顺序；不改变origin匹配 |
| F1-DECODE-02 | `contracts.ts:65-89,162-178` 已有envelope/commands/args结构校验及文件路径错误；schema当前只检查object/boolean，补实际schema结构的标准meta-schema校验及非数组/字段定位回归 | ContractSet.fromDirectory→checkArgs，非法文件抛ContractError而不是TypeError |

Rust依据：tauri-utils 2.9.3 `acl/capability.rs` CapabilityFile/Capability/PermissionEntry，
`acl/identifier.rs` Identifier，`acl/mod.rs` Scopes，`platform.rs` Target（只读源码）。
F4 `JsonReader` 目前仅在F4分支 `util/json-exact.ts`，未在main；领域解码由F1负责，公共值级结构出口先给F2，
词法候选正常集成后再消费，不复制F4 reader、不用AJV替代Tauri领域错误。

当前交付：`capability-decode.ts`为唯一F1/F2公共领域面，api.ts导出decoder、错误类、完整Capability/Scope类型及unexpectedOf。
已对照F2 `e8815ad0b` 同义实现并通知其保readCapabilityDir/scope派生、改用公共领域面，错误包装读取error.detail保原调用者前缀。
差异逐条包括：present→missing顺序、flatten identifier→scope、Target map、struct sequence、scope保留、Identifier uppercase/core及u8 separator Display。
Host文件层按Rust拒绝非法UTF-8/BOM及重复capability id；不改变remote origin判断。F4确认词法候选24941bb3d尚非main，
typed list原文重复/字段错误与尾部语法的先后仍待正式reader，由F1后续接线，不宣称已解决原文反序列化。

验证：`20261104132159-8d63bd` 初版共享decoder+原file/ACL入口11passed、exit0，无Errors；
02 meta-schema/非数组/定位/合法注解回归 `20261104132753-e4b7be` 8passed、exit0。
类型检查 `20261104132753-771d90` 初跑发现F1 target字符串类型未收窄，已用as const修正，待最终复验。
原全量profile错误在当前main仍可复现：`20261104132815-be4e15` exit1，根因F3 `config.migrationsDir`读取undefined，
非schema/fixture失败；真实degraded原因及完整旧断言保留于测试，已派F3/C2并上报BLOCKERS。

补充回归 `20261104134416-a3045c` 34passed/1failed exit1，抓住Target错误文案重复`one of`；
已修实现（不改预期），最小复验 `20261104135104-a4189e` 6passed exit0。typecheck
`20261104134416-7a9d78` exit0；合main后的typecheck `20261104135745-822ba4` 也exit0。
已要求F2收敛到本公共领域decoder，保其readCapabilityDir和错误包装，禁止私有serde.ts导入。
F3缺省config已有候选`04e6c7ef7`，C2确认但main `16a254adf`尚不含；不重复已知失败，等正常main后原official入口复验。

### vector正式入口解锁（main 16a254adf）

生成器作业 `20261104135341-006a79` exit0，只生成新增dstu.vector条目，未手改desktop.json。
新增最小装配测试从正式profile解析出真实F7入口，直接installProfile、检查vector provide并卸载；不提供假storage。
Node `20261104135745-0b1f0a`（含生成一致性）4passed、exit0；Electron `20261104135745-d6b3f8`
1passed、exit0，均无Errors；
F3 P0仍单独阻塞完整官方profile，vector装配不等于LanceDB所有操作或native root所有能力可用。

### fix(main-red)：16a254adf 全量红灯闭环记录

- profile-generate漂移：原因是F7真实vector入口已进main，官方清单未重生成；已运行正式generator新增唯一vector条目。
  Node作业`20261104135745-0b1f0a`包含原生成一致性测试，4passed exit0；Electron真实vector装配1passed exit0。
- profile-isolation：当前仍红的提供方原因已证实为F3缺省config（`20261104132815-be4e15` exit1），
  已escalate并得到候选`04e6c7ef7`。main `bec9c35ba`的apply仍无缺省参数，不能称已修；不重复已知失败，
  正常main集成后只复验原official入口。所有旧断言保留，未用假storage/追加config绕过。
- 架构师已确认22:00那轮`gate-excerpt.mjs:2 import fs`为工具故障；未因此修改业务代码/门禁脚本。
- 本轮前一候选`756d0531e`在main `bec9c35ba`上官方lane-gate三项通过；下次自检按新提交记录，不沿用旧tip结果。
- F4 JsonReader现已进main；前文“候选未集成”是当时状态。typed Target unit-map需精确enum key/闭合原语，
  已给F4最小请求及Rust逗号位置反例；F1不反向import electron、不复制第三份lexer，领域/typed编排仍归F1。

### F4 enum接缝候选到位（待main）

已只读审阅`17890ae41`（F4候选head `6e41ad274`）的`readEnumVariant(expected?)` / `endEnumObject()`，
满足之前请求的变体key/colon与单成员map结束位置接缝。F4报告作业`20261104143236-316e47`；
本lane没有把提供方报告当自身原入口复验。当前main `306eb8bbb`仍无两方法，F3 P0缺省config也未集成。
下一步在正常main包含接口后：F1消费util/api.ts、自己实现typed Capability/Target/PermissionEntry分支，
覆盖顶层map完整Value→from_value（领域错误无原文位置）、顶层list流式错误优先、enum多key/缺colon等反例；
沿用现有唯一领域出口供F2，不复制reader、不跑替身证明整链。当前仅更新候选证据，不重复已通过测试。

### 自动续作：独立字符串边界自查（F1-TEXT-01）

当前tip `30b56cadc`已自检通过且main仍是`879e0a56b`，无新集成接口；本轮继续独立可做的v2数据边界审读。
`dstu-agent-api/registry.rs:285-310` 用Rust trim判空但保存原名；`plugins/ilink_bot/client.rs:145-151`
只用Rust trim判断URL是否为空，非空分支仅去尾随`/`。对应TS尚有两处JS trim（agent-api.ts / ilink-client.ts），
对U+0085误放行、对U+FEFF误当空值。已统一消费F4公开util/index.ts的rustTrim，不另写Unicode规则。
新`rust-text-boundaries.test.ts`走公开ToolRegistryBuilder/IlinkClient，覆盖主名/alias判空、有效原名不改写、
URL默认回退与非空BOM URL拒绝；HTTP依赖只记录请求并校验URL，无真实外网请求，不把它计成任务链整链验证。
无表/文件所有权变化；错误种类/日志/副作用顺序不变；不改变既有Rust测试断言、不增加TESTMAP已移植数。
验证：`20261104152808-8ed5e8`（新增边界+原agent-api/plugins）3文件60passed、exit0、无Errors；
`20261104152808-de6f30` typecheck exit0；`importable.mjs host/kernel/api.ts`通过。

另已重新核pending接口：custom_agent一例不必等待L04 registry；L05的safeToolSet/findCustomProfile已公开，
仅CHATANKI_READONLY_TOOLS常量未重导出；L24实际ChatAnkiExecutor已在main实现并被index使用，但api.ts仅给接口。
已向两所有者请求最小公开入口，避免将整组测试笼统归为“所有执行器未实现”。

合并 main 后：`20261104093144-8d9a0b` typecheck exit 0；`20261104093145-970421`
内核 24 文件 / 198 tests passed、exit 0、无 Errors。没有本 lane ACCEPTANCE 文件，派发复核未勾选项为零。
下表的 1–8 对应 standard-v2 §1.1–1.8；旧测试名与旧 ledger A 不代替 v2 验收。

| 命令/模块 | 八类自查结果 | 证据（接手时行号）/处理 |
|---|---|---|
| plugin_list | 1接线；2只读；3 null/排序；4失败继续；5入口测试；6分支具备；7快照；8待复核 | `plugins.ts:82`、`plugin-manager.ts:128-156` ↔ `manager.rs:119-145` |
| plugin_get_status | 1接线；2只读；3 Option=null；4凭证失败继续；5入口测试；6具备；7快照；8待复核 | `plugins.ts:85`、`ilink-bot.ts:541-568` ↔ `mod.rs:742-760` |
| plugin_get_config | 1接线；2只读；3 **F1-V2-01** 大usize回退10；4失败继续；5缺大数断言；6缺大数；7无时钟；8待修复复核 | `ilink-bot.ts:240-245,571-594` ↔ `mod.rs:120-124,763-784` |
| plugin_set_config | 1接线；2经settings；3 **F1-V2-01** SafeInteger拒绝合法u64；4首错退出；5补边界；6忽略未知键；7顺序写无事务；8待修复复核 | `ilink-bot.ts:597-630` ↔ `mod.rs:787-809` |
| plugin_start | 1 **F1-V2-04** tasks未注入；2经settings；3 **F1-V2-02** HTTP Vec/null、i64/u64偏差；4/6远程任务分支不完整；5未覆盖；7generation已有；8不签整链 | `plugins.ts:71-77,83`、`ilink-bot.ts:478-515` ↔ `mod.rs:442-556,596-696` |
| plugin_stop | 1接线；2无写库；3/4 stopped/错误具备；5入口测试；6具备；7remove→stopping→abort；8待复核 | `plugin-manager.ts:214-232` ↔ `manager.rs:240-267` |
| plugin_set_enabled | 1同start阻塞；2经settings；3bool校验；4保存错误具备；5补错误断言；6启停具备；7先保存；8不签整链 | `plugin-manager.ts:235-245` ↔ `manager.rs:269-287` |
| plugin_begin_login | 1自动start受F1-V2-04阻塞；2经settings；3同F1-V2-02；4/6缺token/id与刷新分支具备；5补真实流程；7 **F1-V2-03** 墙钟期限；8待修复复核 | `ilink-bot.ts:186,302-384` ↔ `mod.rs:210-334` 的Instant |
| plugin_cancel_login | 1接线；2无DB；3/4/6取消具备；5入口测试；7 **F1-V2-03** sleep正常完成不释放abort listener；8待修复复核 | `ilink-bot.ts:149-161`、`plugin-manager.ts:319-325` ↔ `manager.rs:421-427` |
| plugin_logout | 1接线；2删除凭证经所有者；3/4错误映射具备；5入口测试；6清理/保存失败具备；7serialized；8待复核 | `plugin-manager.ts:328-343` ↔ `manager.rs:430-451` |
| plugin_unbind | 1–7与logout共用；8待复核 | `plugins.ts:117-122` ↔ `commands.rs:87-90` |
| bootstrap | 1生产调用；2经settings；3无新结构；4/6 **F1-V2-05** get_setting异常未按ok().flatten()继续；5补失败输入；7后台rejection；8待修复复核 | `plugins.ts:128`、`plugin-manager.ts:369` ↔ `manager.rs:476-493` |
| IPC/ACL/profile/events | 1生产根；2无业务SQL；3IPC schema已有，文件JSON断言待去除；4panic/Err分流；5真实进程；6target/origin已核；7卸载/abandon已有覆盖；8旧项C2/X2已核，新项待复核 | `contracts.ts:143`、`acl.ts:198`；`connection.test.ts`、`services.test.ts` |
| primitives / agent-api | 1经api供L07等消费；2无SQL；3内存类型；4registry错误具备；5移植测试；6组装仍pending；7显式dispose；8poisoning批准已有 | `primitives.ts:4-109`、`agent-api.ts:99-128`；TESTMAP:20-61 |
| extensions/roster/D2 | 1缺真实组合消费；2不复制业务；3无新wire；4启动日志已接；5保持36pending；6/7finalizer政策待定；8等F3不重跑8例 | TESTMAP:145-222；本文件阻塞1/2/5 |
| 官方profile/vector | 1生成生产清单；2仅写清单；3profile校验；4导入失败上报；5生成测试通过；6F7入口缺失；7启动期扫描；8等待main | `host/platform/vector/`只有api.ts |

无复核 finding 待修。先修 F1-V2-01/02/03/05 并补生产路径测试，再去除文件解码断言。
F1-V2-04 的 F1 胶水（Launch/ACK/许可/日志）仍归 F1，不能把它说成已迁移；
只有 L04 task_command / L06 headless 真实 API 缺失部分记跨 lane 阻塞，详见 BLOCKERS.md。
F2 origin 已闭环，F1 生产根已在 main；F3 API、F7 vector、必需 finalizer 政策仍未到位。

### F1-V2-01/03/05 验证

配置 u64/usize、登录单调时钟、sleep listener 释放、bootstrap 读错继续已修。
`plugins-v2.test.ts` 经生产入口新增 3 例；原 `plugins.test.ts` 断言未改（仅适配内部 JSON 类型）。
typecheck `20261104110010-62c323` exit 0；内核 `20261104110010-e8f52f` 25 文件 / 201 passed，exit 0，无 Errors；
`importable.mjs host/kernel/plugins.ts` 通过。ledger `20261104103729-4b6e3d` exit 0。
全仓 strict `20261104105638-a90004` exit 1：4 条均在 L13 `host/plugins/vfs/repository/{create,folders,resources,update}.ts`，
F1 无违规；不改其他 lane。wiring `20261104105638-7da92f` exit 0，但 kernel 不在该工具扫描范围，不能以 0 ported 签收。

### F1-V2-02 / 文件解码续作

`ilink-decode.ts` 从真实 HTTP 与凭证入口消费，严格区分 missing/null、整数/浮点 token，保留 i64/u64 精度，
处理重复字段与 serde 类型/位置错误；HTTP 解码加 reqwest 原前缀。sendmessage 的 as_i64 不再接受浮点错误码，
业务错误不把大整数舍入。旧5条诊断断言按 Rust/reqwest 增强，详见 SPEC，不删除原Rust测试。
ACL/ContractSet 去除直接 JSON.parse 类型断言，ACL 支持 Tauri single/list/named-list 文件形状。
新增依赖：无；Rust运行/编译：无；F3真实启动组合8例：未重跑。

最新定向作业 `20261104112711-f222e0`：4文件45 passed、exit0，无Errors；
typecheck `20261104112711-a5745b` exit0；ledger `20261104112711-01367c` exit0；
wiring `20261104112711-6fc90a` exit0（仍不扫描kernel）。文件解码接入后的全内核
`20261104111623-cfb163` 27文件204 passed、exit0；之后iLink解码变更已用上述45例最小集复验。
真实官方profile的Electron运行 `20261104111623-417f96` 4passed、exit0，无Errors。
strict `20261104111623-bdca67` exit1，仍是L13四条违规，F1无违规。

### W13 接缝交接

C2追加请求已按Rust `lib.rs:1015-1063` 审读；最小方案已投递C2/F3/L20。
只修改官方生成器：唯一 `storageStartupSync` 提供方占kernel之后/platform之前的位置，强制仅inject paths。
现有loader不改；无新阶段框架、无platform→business依赖、无L20表写入。fixture明确只证明生成/安装顺序和隔离，
不冒充真实purge/reset。`profile-bootstrap.test.ts` 新增正常、apply失败、非法依赖三例。
`20261104114102-d18d3c` 初跑8passed/1failed、exit1：非法依赖用例的临时TS文件未被Vitest解析器找到，
改为仓库内静态夹具，原拒绝断言不变；`20261104115116-c0797e` 最小复验3passed、exit0，无Errors。
`20261104114102-1210e2` typecheck exit0；`20261104114103-bbcaff` strict exit1（仍仅L13四条）；
`20261104114103-492399` 生成一致性exit0，正式desktop.json没有漂移。
正式profile目前没有L20 provider。最新main已包含F3路径API；仅等真实L20 provider，不手加条目、不签真实reset通过。

C2 2026-11-04T11:44确认此最小方案可实现；同意fixture只证明接缝，不是业务交付。
ledger仅附加打印计算结果（不改计算、不写文件）的作业 `20261104114224-e1b3cf`：
F1命令11/11 A=100%、B=0%；测试53/89 A=59.6%、2/89 B=2.2%。该静态计分仍不覆盖F1-V2-04整链缺口。

### C04-01 公共serde诊断出口

按L04请求增补 api.ts 的 serdeCheck/normalizeUnitEnums/rustDebugString 及 SerdeCheck/SchemaRefResolver/JsonSchema。
不复制算法。已通知L04：这是部分值级诊断，不能把unknown当通过，也没有from_str原文位置/重复键/数字token能力。
F1没有通用schema+原文位置解码面，iLink专用decoder不冒充snapshot；L04所有者结构解码与快照编排不转移。
最终typecheck `20261104115117-be465f` exit0；`importable.mjs host/kernel/api.ts` 通过。

### standard-v2 §5 自检接续（main d84e29565）

本节更新前文接手时的历史等待状态：F3 finalizer和路径API已进main，只有L20 provider及既有政策仍需等待。
已合main并带回批准测试，最小确认：Node `20261104120855-a7bc0b`、Electron `20261104120855-abb00b`
各4passed、exit0，无Errors。只确认新增真实registry四例，没有重跑原组合8例。
lane-gate当前 `gate-checks.mjs:13,32-35` 的touched规则未包含kernel/profiles，故只会自动执行类型与边界检查；
上述真实链测试显式走全局队列补足，不把gate通过解释成自动跑过kernel测试。
改动提交后按新流程合main并运行官方lane-gate；自检结果以`.oc-runs/selfgate/F1-kernel.json`的tip/base/ok为准。
仍有剩余工作：L20真实W13 provider、36条agent_wiring、iLink真实task/headless及必需finalizer注册政策；vector入口已解锁，
证据见BLOCKERS；不回复“无剩余工作”。
