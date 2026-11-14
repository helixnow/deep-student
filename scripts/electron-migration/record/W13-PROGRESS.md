# W13 第四轮：A/A2 预录与仅 B 录制解耦 — 进度

分支 `assault/W13-g3-pipeline`，worktree `wt/W13`，起点 `cb025e10`。前三轮记录见
`host/e2e/differential/W13-PROGRESS.md`（挂死根因、serde-compat、N-010~N-013、四分类器、只读回放）。
中断后从“下一步”续上。

## 目标

- A/A2（Rust 参考，构建回执固定）先录进一个 **A 预录目录**（A store），不需要 B 提交。
- 每个新的 B 提交只录 B，与 A store 里已接纳的 A/A2 trace 比较；一个 A store 可被多个 B 输出目录复用，引用带 sha256。
- worker 上限按实际启用的边计（仅 B 时 6 个都给 B）。
- 确认/处理不同时间录制的输入一致性（种子、夹具、时钟、环境）。
- 按业务域分批，每批出报告。

## 设计（实现时以代码为准）

- `g3-batch.mjs --mode combined|a-store|b-only`（默认 combined，行为不变）。
  - `a-store`：`--sides` 只能是 A/A2；写 `A-STORE.json`（g3-a-store/v1：录制树提交与干净、runtime 回执、A 构建回执 sha256、
    钉住的环境、各套件输入指纹）和 `recorder-receipt.json`；worker 回执引用 `A-STORE.json` 的 sha256。不写 RECORDING.json、不 compare。
  - `b-only`：`--a-store DIR [--a-store-sha256 HEX]`（可多个，后者覆盖前者）；只录 B；RECORDING.json v3
    （`a.source: a-store`，A 构建回执取自 store 并校验，`inputs` 为本树各套件输入指纹）；
    每用到一份 store 回执就在本目录写 `a-refs/<边>/<store sha 前 12>__<回执名>`（store 身份文件与回执文件各带 sha256）。
    输入指纹与任何 store 都不符的套件不录、不比，列入 `a-store-coverage.json`。
- 报告：v3 目录的 A/A2 trace 只经 a-refs 接纳（store 身份 sha256、store 回执 sha256、store 无缺陷、同一 A 构建、同一环境、
  同一套件输入指纹，全部满足才算）；不满足记 `unattributable-recording` 并写明原因。
- 输入指纹 `g3-inputs.mjs`：套件字节、provider sidecar、生成后的种子（逻辑快照，只把等于建种时钟的格子换成占位）、
  LLM/云服务与录制驱动的源码闭包、钉住的 TZ/LANG/LC_ALL。
- 时钟：不冻结（见下文“输入一致性”）；报告给出每个对比 A/A2 与 B 的录制日期差，恰好按日期差平移的日期型差异自动归为环境差异（只解释，不改 fail）。
- 分批：`--domain chat,notes,...`（host/plugins/<域>/），按给定顺序排分片；报告 `--domain` 输出本批范围小结。

## 状态

- [x] 红：测试（`70dae17b`）
- [x] 绿：g3-inputs + clock-skew（`a02c3e15`）、batch/provenance/manifest/report（`9ad7029e`）、supervise（`edf30477`）、未定义种子（`fee6b955`）
- [x] 手册第 9–11 节 + 估算
- [x] RF 登记（rust-fixes/）接入比较器、四分类器、报告、只读回放（主代理 08:03/08:15 新增）：红 `8e8c8ba8`，绿 `0fa26c67`、回放 `59389ee8`，手册第 12 节
- [x] 修 g3-batch：不等的 compare（g3-compare 退出码 1）曾被计为 compare error → 批次退出 3、监督器判不完整（`1f4d5148`）
- [x] 回报（全量 vitest 17 文件 17 条全过，`b9cb379a` 时）

## 实现中的取舍（与上面设计的差异）

- `--domain` 只决定**录哪些分片**；目录里已录好的其他域分片照常比较（上一批因 deadline 推迟的比较也会补上），`compared` 是目录累计数。
- b-only：一个分片里没有任何场景有 A/A2 时不录这个 B 分片（预录没跑完时不浪费 B）；`awaitingA` 计预录回执还没覆盖的场景。
- 预录目录的身份文件逐字节复核；`RECORDING.json` 先于 runtime 回执复核，错误信息带第一处变化的 JSON 路径。
- 真实语料引用 25 个种子，生成器只认 5 个：其余记为 `unavailable`（两侧同样失败），不让批处理崩溃。
- supervisor：只含“预检失败回执”的目录视为新目录（原回执改名保留）；a-store 也可 `--coverage`（profraw 在预录目录里）。
- RF：豁免不改 compare 产物（原始差异照留），在分类/报告/回放时生效；`rust-fix` 不进四分类（`CATEGORIES` 仍四项）。
  第五轮起按登记覆盖：整条差异的每个差异位置都要被**同一登记**的某个选择器覆盖；不同登记之间不合并（手册 12.2）。
  比较器新增可选字段 `paths`/`pathsComplete`（outcome、events）、`eventNames`（events）。

## 验证

- `node --test` 新测试：g3-inputs 4、g3-clock 2、g3-split 5、g3-supervise-split 3，全过。
- 全量 `DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.host.config.ts host/e2e/differential --maxWorkers=2`（经 heavy）：16 个文件 16 条全过（`edf30477` 时）。
- 真实语料输入指纹：215 套件约 3 秒，两次运行逐字节相同。
- 手册 10.3 的 smoke 流程（预录只录 1 个套件、B 带/不带 `--file`）在夹具上手工核对：complete / incomplete（awaiting A）。
- g3-rust-fixes 5 条（路径列举、四种 surface 命中/未命中/同表他列负例、approved/proposed/deliberate、登记校验、端到端报告）。
- RF 回放演示（G2 真实 trace，临时登记在 /tmp、未提交）：产品差异 28 → 26（approved ipc 豁免 2 条），proposed deliberate 列待审，混合样本与跨事件名不命中。见手册 12.4。

## 风险

- 时钟未冻结：日期以外的时间相关差异（剩余天数等）无法自动识别。
- 夹具共享主仓库 node_modules：其他代理同时 `npm install` 会让 Host 回执变化，测试中同目录重跑被拒（是正确行为，曾偶发一次）。
- 6 个 B worker 的内存峰值未实测。

- RF 整条命中规则偏保守：数据库差异样本常混有多张表（真实录制里几乎每条都含 `chat_v2_compaction_memory_flushes` 等结构差异），
  这种差异里即使有登记的列也不会被豁免，直到其余差异被修掉或归一化。

## 第五轮（INT `edf15754`，首次落地前）

- [x] 合入 INT（RF 28 条）。
- [x] RF 匹配与闸门 schema 对齐（`666d7705`）：按登记覆盖；`*` 通配（fs path 单段）；事件 `jsonPath` 相对 `{event, payload}`；同列多个 `jsonPath` 一起遮盖；格式规则照 `rust-fixes.schema.json`。28 条全部加载。
- [x] 语料检查 `g3-corpus-check.mjs` + 运行器把未提供的绑定命名空间、未定义种子记为 `unsupported`，不再启动应用（`d456e794`）。
- [x] `g3-batch --scenario`（`6304f05b`），供 W04 单场景诊断。
- [x] 服务器命令清单 `host/e2e/differential/SERVER-COMMANDS.md`；手册第 13 节（语料检查、`--scenario`、时钟、MCP 方案）。

语料检查结果（226 套件、3881 场景）：阻塞 245 条、102 个场景。非 pending 的只有 MCP 绑定（39 个场景）；其余都在 `pending-*` 套件（未定义种子 44 条、`${runner.*}`/`${seed.*}` 绑定）。警告：`llm-script-missing` 152、`date-literal` 527。时钟与随机数两侧都未冻结。

验证：全量 differential vitest（经 heavy）18 个文件 18 条全过；`g3-split`+`g3-supervise-split`+`g3-inputs` 13 条全过；`rust-fixes.mjs --check` 28 条 0 错误；命令清单 bash 块 `bash -n` 通过。

遗留（按优先级）：

1. MCP 接线（39 个场景）：固定端口 + 每个 worker 私有 mount namespace 固定日志目录和 stdio-server 路径；需 MCP lane 认可。
2. 时钟冻结：两侧都未冻结，A/A2 与 B 跨天录制时日期相关场景会漂移；需要 A 侧（Tauri）和 B 侧（Host）都提供可注入时钟，跨 lane。
3. 6 个 B worker、3+3 个 A worker 的内存峰值未实测；首次 S5/S6 用 `g3peak` 记录后修订手册第 2 节。
4. `g3-supervise` 不透传 `--scenario`；诊断目前直接跑 `g3-batch`（没有预检和监督结论），需要时再加。
5. RF 跨表样本：数据库差异若混有未登记的表，整条仍不豁免（设计如此，等其余差异被修掉或归一化）。

## 第六轮（INT `4384a313`；落地 `007c1af5` 的 B smoke 之后）

- [x] N-014（proposed）拆分录制时钟读数（`0177605b`）：b-only 下 A1=A2 位置上落在各侧录制窗口内的时间戳按形状比较，并检查先后；窗口外逐字比较；窗口重叠或缺失时不生效。比较方式与取舍见手册 13.3、`normalize-approvals.json` N-014。
- [x] N-015（proposed）`get_app_version` 只屏蔽构建号和提交。
- [x] 报告和回放按 compare 产物的 `splitRecording` 重算：用同样的窗口重算；A 窗口须落在该 take 的 worker 回执窗口内。没有这一步，带 N-014 的 compare 在报告里会判为“recorded result differs from recomputation”。
- [x] 手册 1.1 的 sha256 改为“与录制提交里的文件一致”，给出命令；预检新增 `approvals` 项，自动显示 sha256 和已批准的规则。
- [x] A 预录增补与失效检测（按场景）：
  - 每个场景的输入包括：场景定义、种子、LLM 脚本条目、闭包、环境、引用的 fixtures。新预录写在 `inputs.scenarios`；旧预录从 `recorder.head` 用 git 重算。
  - b-only 按场景取“最后一个有匹配 A/A2 的 store”；不匹配的判 stale-a，不比较，单独列出。
  - coverage v2 增加 `topUpScenarios` 和 `sources`。报告的 `recording.aStores[].scenarios` 列出逐场景来源。
  - 同一套件里只有别的场景变了时，用 store 提交里的旧套件文件比较（`--a-scenario-file`），前提是该场景逐字节相同。
  - provenance 改为逐 trace 检查输入。
  - `g3-supervise --mode a-store` 支持 `--scenario` 和 `--top-up-from`。
- [x] `g3-rust-fixes.mjs` 导出 `selectorProblem(selector)`、`entryProblem(entry, fileName)`。
- [x] SERVER-COMMANDS 新增 S8 A 增补；S4、S6 判定改为 stale-a/missing/awaiting；手册 10.1、10.3–10.5、11、13.2–13.4 同步。

交接：

1. **W09（rust-fixes 闸门）**：G3 的选择器校验是 `scripts/electron-migration/record/g3-rust-fixes.mjs` 的 `selectorProblem(selector)`（单个选择器，返回 null 或原因）和 `entryProblem(entry, fileName)`（整条登记），都是纯函数，无 I/O。闸门可以直接 import 复用，两边就不会再判得不一样。`RF-W05-web-search-connectivity-unregistered` 被判无效，是因为落地提交 `007c1af5` 还是第四轮的规则（“scenario * 的 ipc 选择器必须有 jsonPath”）。第五轮 `666d7705` 已按闸门 schema 去掉这条（只约束 scenario * 的 db），INT 上 34 条全部有效，下次落地就没有这个问题。测试：`g3-rust-fixes.test.mjs`「exported selectorProblem / entryProblem …」。
2. **时钟冻结：Rust/Tauri 参考构建（A）**：需要一个可注入的时钟，例如环境变量 `DS_G3_NOW=<ISO 8601>`。设置后，进程内所有“现在”（`chrono::Utc::now`/`Local::now`、`SystemTime::now`）从这个时刻起按真实流逝推进（offset 模式，保留先后），不设置时行为不变。SQLite 的 `datetime('now')`/`CURRENT_TIMESTAMP` 默认值不受影响，需要改成由应用传值，或者在连接上注册同名覆盖函数。要动 A 构建，所以要重新出构建回执，基础预录也要重录。
3. **时钟冻结：Host（B）**：同一个变量。Host 入口在设置时替换 `Date.now`/`new Date()`（offset 模式），better-sqlite3 连接的 `datetime('now')` 同上。
4. **录制侧（W13，A、B 都支持后做）**：运行器给两侧传同一个 `DS_G3_NOW`（取 B 录制时刻，A 预录用它自己的），写进 `trace.recording.clock`；这些场景就不再需要 N-014。W04 的 S7 单场景 trace 由主代理执行，不受影响。
5. **W21（MCP）**：接线契约见手册 13.4。要点：不改录制器闭包（否则全部预录 stale-a）；服务由运行器启动，用固定端口和 `/run/g3-mcp` 固定路径（私有 mount namespace）；`CLOSURE_ENTRIES.mcp` 和 `suiteUses` 只影响 MCP 场景；接线后 MCP 场景按 S8 增补。W21 补的 44 个种子和 152 个 LLM 脚本落地后，用到它们的场景会变成 stale-a 或 missing，按 S8 增补即可（估计 200–250 个场景，约 1.5–2 小时）。

验证：全量 differential vitest（经 heavy）19 个文件 19 条全过；定向 node 测试：`g3-split` 6、`g3-supervise-split` 3、`g3-supervise` 5、`g3-inputs` 5、`g3-provenance`、`g3-split-clock` 5、`g3-rust-fixes` 7，全过；`rust-fixes.mjs --check` 34 条 0 错误；命令清单 bash 块 `bash -n` 通过。

遗留：内存峰值仍未实测（首次 S5、S6 用 `g3peak` 记录）；RF 跨表样本（设计如此）；MCP 等 W21 的方案。

## 第七轮（INT `f3439333`；A 预录第 1 批 EAGAIN 之后）

| SHA | 内容 |
|---|---|
| `21261209` | merge INT `f3439333` |
| `12dbd312` | `g3-supervise` 透传 `--retry-errors`/`--retry-errors-before`/`--retry-infra-errors`；EAGAIN、线程创建失败归为基础设施 runner 错误（`g3-failures.mjs`） |
| `7bcdbd15` | `g3-report` 的 runner 错误计数只算录制里实际有的边（与监督结论一致） |
| `0d3688a8` | G3-STARTUP/v1 两侧启动屏障；等待锚点；`NODE_COMPILE_CACHE` 移出种子；MCP 接线；闭包边界 |
| `84f1d71b` | 提案 N-016、N-017；smoke `__change_log.changed_at` 回归 |
| `56200bea` | 手册、命令清单 |

1. **重试与失败分类**：
   - 重试参数是运行参数，不进意图。preflight 检查录制树里的 `g3-batch` 是否认识该参数（`batch-option:*`），所以新的 supervisor 也能驱动冻结的旧树。
   - 基础设施签名（`EAGAIN`、`os error 11`、`Resource temporarily unavailable`、`pthread_create`、spawn/create thread、GLib `creating thread`）从 `summary.json` 的 `reason` 和该 take 的 stderr 尾部 4MB 里找。
   - `--retry-infra-errors` 只重跑这类分片。有基础设施错误时监督结论是 `incomplete`，原因里写明“不是场景结果，用 `--retry-infra-errors` 重跑”；`phases.failures` 按边、按签名计数。
   - 手册 §2：unit `TasksMax` 4000，slice ≥ 6000；§9.7、S5b 是重试做法。
2. **录制器时序**（`g3-startup.mjs`，手册 §13.5）：
   - 两侧都从就绪时刻开始记录事件（A 在就绪时订阅；B 从 fork 起）。
   - 至少等 8 秒，再要求事件数和数据库指纹连续 1 秒不变，上限 30 秒。
   - 然后调 `vfs_set_indexing_config`（把索引间隔设为 86400 秒），等静置，取边界。边界之前的事件存进 `trace.startup.events`，不比较；`before` 快照和每一步的事件都从边界开始。
   - 不用归一化。不同启动规则的 take 拒绝比较；setup 结果不同报 `startup-setup`，MCP 收尾状态不同报 `service-idle`，两者都按原样比较。
3. **W21 交接**：
   - setup 命令的结果（成功或错误）原样记录，不中断录制，覆盖恢复模式下命令没注册的情况。
   - `NODE_COMPILE_CACHE` 放在种子目录之外；落在种子目录里就直接报错。
   - `g3-wait`：新增 `channel`、`payload`（按点路径精确比较）、`jsonrpcId`，只认本步 invoke 之后到达的事件（`since`）。
4. **MCP 接线**（手册 §13.4）：
   - 每个 worker 在私有 tmpfs `/tmp/g3-mcp` 下运行，固定端口 47130，服务自包含（`selfContained`），由录制用 node 启动。
   - `scenario-v0` 支持 `mcp` 命名空间，键里允许 `-`，整值占位替换成 JSON 原值。
   - 指纹加 `closure:mcp` 和 `launch:mcp`；MCP 场景单步上限 90 秒；静置状态 `settle`。
   - 语料检查用服务实际提供的键做核对：39 个非 pending 的 MCP 场景都能录；5 个 `pending-mock` oauth/WebSocket 场景记为 `unsupported`。
   - 闭包停在种子模块、技能 ZIP 模块和其他闭包的入口处（`recorder` 从 894 个文件降到 6 个）；新增 `runner-a` 闭包。
5. **归一化提案**（`proposed`，手册 §13.6）：
   - N-016：AEAD 信封的 ciphertext 和 nonce 按带长度的 token 处理，只在 A1≠A2 时生效。
   - N-017：主键各列稳定时，占位符按主键命名，不再用序号。
   - 证据：ser-38 smoke 里 `save_api_configurations` 的 vendor/model JSON 差异，正是这两条的组合（信封每次加密都不同，加上 A 独有的 `lance.optimize.last.*` 行让序号错位）。两条都批准后，只剩 lance 行这一条真实差异。
   - `vfs.db __change_log.changed_at`：smoke 的证据在拆分录制下已被已批准的 N-014 覆盖（回归测试用真实秒数），不提新规则。合录时 A1=A2 同一秒而 B 晚一秒的情况没有覆盖，没有证据，记为已知缺口（手册 §13.3）。

验证（`56200bea`）：
- `node --test host/e2e/differential/*.test.mjs`：24 个文件，133 条用例，128 条通过，5 条跳过（Linux namespace 用例，含新增的 MCP 私有目录用例，只能在服务器上跑）。
- differential vitest（经 heavy）：23 个文件 23 条全过。
- `rust-fixes.mjs --check`：48 条，0 错误。
- SERVER-COMMANDS 的 18 个 bash 块 `bash -n` 全过；`g3slice` 用模拟的 `systemctl` 对 1800、6000、`infinity`、12000 都核对过。
- 语料检查：231 个套件、3881 个场景，阻塞项 56 条（33 个场景），全部在 `pending-*` 套件里。

交接：

1. **主代理**：
   - 第七轮合入并落地后，用新的 `ASHA` 重录 S3 和 S5（约 10–11 小时）。`g3-astore-007c1af54c3e` 对第七轮之后的 B 全部是 stale-a，比较器也会拒绝启动规则不同的 take。
   - 旧的第 1 批是否重试由你决定：只对第七轮之前的 B 有用。做法见 S5b，用新树的 supervisor 驱动旧树，带 `--retry-errors-before`（10:30）或 `--retry-errors`。
   - slice 的 `TasksMax` 现在是 `--runtime` 覆盖，重启就失效，`z-night.conf` 也可能把它压回去，是否持久化由你或用户决定。命令清单里每批启动前都会跑 `g3slice`。
   - 生命周期测试 16 条，其中 MCP 私有目录那条只能在服务器上验证。
   - 请审批 N-016、N-017。
2. **W21**：
   - 等待写法：MCP stdio 用 `{"channel":"mcp-stdio-${N.sessionId}-message","jsonrpcId":<id>}`，备份用 `{"channel":"<事件名>","payload":{"<点路径>":<值>}}`。
   - pending-mock 的 `${mcp.oauth.*}`、`${mcp.*.wsUrl}` 要等服务提供这些键才能录。
   - 改 `mcp-service.ts`、`stdio-server.ts` 或它们 import 的文件，只会让这 39 个 MCP 场景变 stale-a（按 S8 增补）。
3. **W25**：
   - `llm-service.ts` 只在 `llm` 闭包里（目前 1 个文件；新加的相对 import 会自动纳入），改它只让用到 LLM 的场景变 stale-a，按 S8 增补。
   - 在现有 `${llm.baseUrl}` 下新增路由，录制侧不用改；如果需要新的 `${llm.*}` 键或场景字段，请告知 W13。
4. **W07 / W10**：
   - 启动事件和 lance 行现在是两侧一致观察下的真实比较。
   - smoke 里 `save_api_configurations` 的 vendor/model JSON 差异等 N-016/N-017 批准。之后剩下的 A 独有 `lance.optimize.last.*` 行，请在第七轮录制上重新判断（启动维护现在两侧都在边界之前完成）。
5. **W11（`lib/resource-budget.mjs`）**：
   - G3 的准入与作业队列共用“dsdev 线程数 < 1400”（产品沙箱的 NPROC=2048 按 UID 统计）。A/A2 各 3 个 worker 约 1000 个线程，所以 A 预录期间作业队列只剩约 400 个线程的余量。unit 的 TasksMax 4000 改变不了这一点。
   - 并行时如果出现 EAGAIN，录制侧会把它归为基础设施错误，可以用 `--retry-infra-errors` 重跑。

## 第八轮：A 指纹 v2（INT `6c491e6f`，合入点 `246e490a`；交付前合入 INT `fe5feb68`（第四批），合入提交 `b06fd19d`）

| SHA | 内容 |
|---|---|
| `cf1f10ed` | `g3-slice.mjs`：一个进程能执行的代码的声明级切片 |
| `2e94536e` | `g3-inputs` v2：每个场景的 A 指纹取 A 进程切片；v1 预录目录按其 `recorder.head` 重算 |
| `9c0a413d`、`84d1a9af` | `g3-a-stale`：两个提交（或一个预录目录和一个提交）之间哪些场景的 A 失效、为什么；测试 |
| `b30ceb32` | 切片的证明测试：规则、V8 覆盖率、种子生成器的全局状态 |
| `d2aedfaa` | `g3-a-stale --json` 给出 `topUpScenarios`；`g3-supervise --top-up-from` 接受它 |
| `90dbbb70` | 命令清单 S2b、手册 §11.1 |
| `16b4a8d5` | `g3-wait` 测试：媒体流水线和 qbank 任务的终态等待，录制器不用改 |
| `6e68d7f6` | 语料检查：只配 embedding 模型的场景核对模型名，不再报 `llm-script-missing`（W21 #7） |
| `56c76fad` | 切片 `followContained`：第四批里种子模块从新模块取常量，v2 原本会直接报错 |
| `9a426e0f` | 语料检查：`wait-without-events` 阻塞项 |
| `155a9c48` | 种子摘要：符号链接只记链接文本，不跟随（W21 #6 的录制器一半） |
| `b06fd19d` | 合入 INT `fe5feb68`（第四批），无冲突 |
| `9783eff3` | 语料检查的 embedding 模型表改读 `host/plugins/llm-providers/src/replay/embeddings.ts`：第四批里 W05 删了 `host/e2e/streaming/wave0/embeddings.ts`，X5 的 `/embeddings` 改由前者应答，合入后语料检查直接报模块找不到。新增用例在真实树上加载各登记表，模块再搬家时测试会先失败 |
| `4822dfd3` | `g3-inputs.test.mjs` 的 `better-sqlite3` 导入加 `boundary-allow native-import`（只改临时种子副本）：本轮把 `createRequire(...)('better-sqlite3')` 拆成两行后，边界检查才认出这个导入 |

### A 指纹 v2：设计

问题：v1 把录制器闭包算进每个场景。任何录制器改动、W25 改 LLM 模拟服务、W05 改插件里的一条 `import type`，都会让 3881 个 A 全部失效，重录要 10–11 小时。

拆分：一个场景的输入分成“影响 A 输出”和“只影响 B、比较或报告”两类。

- **影响 A 输出的**，逐场景各算一份，任何一份变了这个场景就是 stale-a，原因写明是哪一份：
  - 场景定义；
  - 种子内容；
  - 它用到的 LLM 脚本条目；
  - A 进程代码单元；
  - 前端事件表；
  - 固定环境；
  - A 命令行与隔离方式（`launch:a`）；
  - MCP 启动参数（`launch:mcp`）；
  - node 版本；
  - 场景引用的仓库文件。
- **A 进程代码单元**：`g3-run-a.mjs` 加上该场景进程会启动的服务模块，按声明级切片（`g3-slice.mjs`）。真实树上共四种：
  - `a`：12 个代码文件；
  - `a+llm`：16 个；
  - `a+cloud`：15 个；
  - `a+mcp`：15 个，另有 stdio 程序作为独立程序切片。

  单元里还有被服务或被复制的资源文件，以及 A 代码用到的 npm 包（按 `package-lock.json`）。
- **只影响 B、比较或报告的**：`g3-run-b`、`g3-compare`、`g3-normalize`、`g3-report`、`g3-provenance`、`g3-batch`（A 命令行那个数组除外，它在 `launch:a` 里）、`g3-worker`、`g3-supervise`、`g3-inputs`、`g3-slice`，以及 A 加载但不执行的声明（例如 `json.mjs` 的比较函数、`database-state.ts` 的 `compareDatabaseStates`、`g3-services.mjs` 的 `lookupBinding`）。
- **切片规则**：
  - 模块顶层语句分成两类：纯声明（函数、字面量绑定、没有求值部分的类、类型），和副作用。
  - 加载到的模块，副作用都算；纯声明只有被算进来的代码（传递地）引用时才算。
  - 拿不准的往多算：同名局部变量算引用；命名空间导入、不解构的动态导入算全部导出。
  - 分析不了的直接报错：计算出来的动态导入、`eval`、`require`、`Function()`、其他 `import.meta` 用法。
  - 整文件计：解析错误、`import =`、`export =`、非代码文件。
  - CLI 主体只在进程入口里算。
- **种子生成器**（`scenario-seeds.ts`）按“包含”处理：
  - 它的导入不跟随，副作用不计；
  - `createSeed` 和 `SEED_NAMES` 按种子内容计（种子摘要），A 运行的 `resolveSeed`、`copySeed`、`describe` 等按代码计；
  - 本轮加了 `followContained`：被包含模块里算进来的代码用到某个导入的绑定时，只取那个声明，目标模块同样按包含处理；目标模块里能（经本模块的声明）够到这些绑定的副作用也算进来；动态导入仍然报错。没有它，第四批合入后 v2 会在 `describe` 用到 `A_PRODUCED_SEED_NAMES` 时直接失败。

### 证明

1. **规则逐条的小模块用例**（`g3-slice.test.mjs` 前 7 条）：副作用和声明、纯表达式、导入的各种写法、主体守卫与包含、停止、边界、资源、`followContained`、分析不了的情形、`evaluateSlice`。
2. **真实树上的变异**（`g3-inputs.test.mjs`）：
   - 13 处只属于 B、比较、报告或批处理的改动，3881 个场景一个都不失效；
   - 13 处 A 路径改动，恰好让该单元的场景失效，原因写的就是那个文件；
   - `package-lock` 里 `better-sqlite3` 的版本、A 命令行、namespace init、node、事件表也逐项验证过。
3. **V8 覆盖率对照**（`g3-slice.test.mjs`）：
   - A 进程依次做这些事：加载 `g3-run-a.mjs`、跑它的辅助函数、起停 LLM/云/MCP 服务并发请求、跑一次 MCP stdio 会话。
   - 执行过的每个函数都落在切片的语句里。
   - 对照组：故意调用只有 B 用的 `lookupBinding`，测试必须报出它，而且只报它一个。
4. **种子生成器的全局状态**：加载生成器、构建全部 19 个种子前后，这些都完全相同：全局对象、内建原型、环境变量、进程监听器、cwd、exitCode、`Error` 设置、Intl、活动句柄。所以生成器的产品导入不在切片里也不影响 A。
5. **端到端**（`g3-a-stale.test.mjs`）：在临时仓库里提交 B 侧改动、A 侧改动、场景改动，用工作树和预录目录两种方式比较，结果和预期逐条一致。
6. **实测**（本机，种子都构建并比较过）：

| 从 | 到 | 不受影响 | stale | 说明 |
|---|---|---|---|---|
| `246e490a` | 本轮树 | 3881 | 0 | 本轮自身不使任何 A 失效 |
| `e01987a7`（第七轮交付） | 本轮树 | 3713 | 168 | 全是 W25 `c9f5029c` 改 `llm-service.ts` 及其 3 个新导入，真实失效；v1 下同一改动让 3881 个全部失效 |
| `246e490a` | `int/stage-1245`（第四批） | 0 | 3877 | 另有 4 个被替换。全部来自 `scenario-seeds.ts` 和 `a-produced-seeds.ts`（W21）；168 个 LLM 场景另加 W05 的 `llm-providers/src/replay/*` 和 `@noble/hashes` |
| `int/stage-1245` | 本轮与它的试合并（`git merge-tree`，无冲突） | 3881 | 0 | 本轮叠加在第四批上不多失效一个 |
| `fe5feb68`（INT，第四批已快进） | `b06fd19d`（本轮合入 INT 后） | 3881 | 0 | 交付树上复测，与试合并一致 |
| `246e490a` | `b06fd19d` | 0 | 3877 | 原因分布与暂存分支那一行相同。另外，`backup.audit.cleanup.seeded_*` 两个场景还带 `seed`（种子内容变了），`qbank.g3.authgen.pending.*` 两个还带 `llm`（LLM 脚本条目变了）。被替换的 4 个是 backup 场景从 `pending-seed/`、`pending-runner/` 移进正式套件，同 id 换了文件 |

### 查询命令

`node scripts/electron-migration/record/g3-a-stale.mjs --from <提交|预录目录> [--to <提交>]`，详见手册 §11.1 和命令清单 S2b：
- 每个提交在子进程里用当前检出的 `g3-inputs` 算指纹。提交用 `git archive` 取出到临时目录，`node_modules` 用符号链接接入，退出（含 SIGINT/SIGTERM）时清掉。
- 预录目录则读它记录的输入；v1 目录按其录制提交重算。
- 输出：有效场景数、不受影响数、stale 数（按原因计）、missing、逐场景原因。
- `--json` 另给 `topUpScenarios`，可以直接喂给 `g3-supervise --top-up-from`。只接受干净工作树、而且就是要录的提交生成的报告。

### 取舍

- **MCP 按套件**：一个 MCP 套件的分片会先跑 `mcpBindingKinds`，起一次 MCP 服务，所以同套件的非 MCP 场景也带 `a+mcp` 单元。
- **种子按内容，不按源码**：生成器导入产品代码，按源码算等于回到 v1。代价是生成器的加载副作用靠全局状态测试覆盖。`followContained` 只看本模块里能够到被用绑定的副作用；另一个模块的副作用去改这个模块导出的数组，查不出来。这种写法极少见，测试也会在加载前后报出全局层面的变化。
- **npm 包按 `package-lock.json`**，不读 `node_modules`。A 用的原生模块由录制回执里的 sha256 守住。
- **事件表**：v1 预录目录用它自己录制提交的 `frontendEvents` 重算。
- **`g3-worker.mjs` 的 `NAMESPACE` 末尾的 `'g3-worker'` 不计入指纹**：它是 `bash -c` 的 `$0`，只是进程名；`-c` 之前的包装和 init 脚本都计入（`launch:a`）。
- **全树取出**：两个提交各占约 0.6 GB 的 /tmp，命令结束即删除。
- **`--no-seeds`**：跳过种子构建，可以快一些，但种子内容不比较，输出里会注明。
- **node 版本和 MCP 启动参数都是本机的**：对预录目录跑查询，要在录 B 的那台机器上跑。
- **`arrayText` 读 A 命令行数组的原文 token**：只加一个尾逗号也算变化，偏保守。
- **覆盖率对照只覆盖不需要 Tauri 就能执行的部分**：`g3-run-a.mjs` 里只在 A 二进制运行时才执行的代码没有被执行到，但它们在切片里（主体守卫在入口里是活的）。

### 第四批合入的影响（交主代理排期）

- 第四批合入后，A 必须全量重录：W21 的种子模块改动让 3877 个场景失效。第七轮本来就要求重录 S3、S5，两者合成一次。
- 下面“推迟项”里 A 路径上的录制器功能，如果在这次重录之前合入，就不用多录一轮；之后再合，就要再录 10–11 小时。要不要等，由主代理决定。

### 交接处理

| 来源 | 事项 | 处理 |
|---|---|---|
| W04 #1 | B 启动后要像 A 一样等启动维护 | 第七轮 G3-STARTUP/v1（`0d3688a8`）已做：两侧都在就绪后等至少 8 秒、再等静置，然后才 setup。剩下的 `lance.optimize.last.*` 差异，请 W07/W04 在第七轮之后的录制上重新判断 |
| W04 #2 | `waitAfter` 等流水线到终态 | 录制器不用改，下面的写法今天就能用（`16b4a8d5` 用真实事件形状测过）。15 秒上限不放宽 |
| W21 #1 | 恢复模式下跳过 setup | 第七轮已改为把 setup 结果（成功或错误）原样记录、不中断录制，两侧不同就报 `startup-setup`。跳过反而会藏住差异，所以不再改 |
| W21 #2 | `${seed.*}` | 推迟（A 路径），设计见下 |
| W21 #3 / 任务 5 | `${fixture.qbank_page_png_base64}` | 录制器不用改。值是 qbank README 第 602-606 行给出的常量（1×1 PNG 的 base64），由语料 owner 直接写进 `pending-provider/g3-authoring-generation-llm.json` 第 39 行即可。`${fixture.pendingExportRequestId}` 要从事件里取值，推迟，设计见下 |
| W21 #4、#5、#8 | payload 等待、编译缓存、MCP | 第七轮已做 |
| W21 #6 | 快照条目类型 | 录制器这一半已做（`155a9c48`，链接只记文本、FIFO 只记名字）；X3 的 `database-state.ts` 还拒绝链接，等 X3 |
| W21 #7 | 语料检查误报 | 已做（`6e68d7f6`）：17 条降到 2 条，剩下 2 条是真的要 LLM 脚本的 qbank 出题场景 |
| W21 任务 5 | 后台任务终态等待 | 录制器不用改，写法见下 |
| W05 | G3 B 侧挂 llmReplay | 按 W05 的建议继续用 HTTP 模拟服务，接线不变。在被测 Host 里挂还缺的四样，见 W05 报告 |
| W05 | `recorder` 闭包估算 | v2 已经取代：插件代码不在 A 切片上（测试断言），`import type` 不算边 |
| V10（`.reports/reviews/V10-cross-platform.md:386`） | `g3-normalize.test.ts` 的批准清单过期（N-014、N-015） | INT `982241b9` 批准 N-016/N-017 时已把清单改为 N-001…N-017；合入后 4 条全过，W13 不再改 |

终态等待写法（场景要 `capture.events: true`；否则新的 `wait-without-events` 阻塞项会报出来）：

```json
{"channelPrefix": "media-processing-", "payload": {"fileId": "<传给 media_transcript_import 的那个文件 id，如 ${K.id}>",
  "stage": ["pending","text_extraction","page_rendering","page_compression","image_compression","ocr_processing","vector_indexing",
            "completed","completed_with_issues","error","queued","decode","vad","asr","indexing"]}}
```

- 媒体：事件的 `fileId` 是流水线的文件 id（`MediaFileInfo.file_id`）；`media_transcript_import` 返回的 `TranscriptView` 里没有它，`resourceId` 是另一个 id，所以要沿用这一步参数里的文件 id。W04 第九轮的两个原因第七轮都已解决：现在可以按 channel 和 payload 字段匹配，等待也只认本步 invoke 之后的事件，step 9/10 不会被 step 8 的完成事件提前满足。`media-processing-completed` 和 `media-processing-error` 顶层都有 `stage`，取值是这 15 个 `ProcessingStage`（`pdf_processing_service.rs:171-185`）。`media-processing-progress` 的 stage 在 `status` 里面，所以永远匹配不上。PDF 的兼容事件 `pdf-processing-*` 前缀不同，也不会匹配。
- qbank 出题：`{"channel":"qbank_generation_task_event","payload":{"id":"${2.id}","status":["completed","failed","cancelled"]}}`，写在 `qbank_ai_generate_questions` 那一步的 `waitAfter` 里。这里引用的是本步自己的结果：`waitAfter` 在本步结果记录之后才解析，事件从本步 invoke 开始时就计入，任务完成得再快也能等到。

### 推迟项（都在 A 路径上，合入即让相关单元的全部场景 stale-a）

1. **`${seed.*}`**：`scenario-v0` 增加 `seed` 命名空间，取值用第四批 `a-produced-seeds.ts` 的 `seedBindings(name, seedDirectory)`。问题在路径：每个 take 都把种子复制到自己的目录，`${seed.file.*}` 是绝对路径，A1、A2、B 三者不同，命令结果或数据库里一旦回显路径就会出现假差异。建议像 MCP 的 `/tmp/g3-mcp` 那样，worker 在私有 tmpfs 的固定路径 `/tmp/g3-seed` 下挂种子副本，这样三者的路径完全相同。改动涉及 `scenario-v0.mjs`、`g3-run-a.mjs`、`g3-run-b.mjs`、`g3-worker.mjs`。
2. **`${fixture.*}` 从事件取值**（`pendingExportRequestId`）：这需要“等待捕获”，即 `waitAfter` 匹配到的事件 payload 能被后面的步骤引用，比如 `${N.wait.request_id}`。改动在 `scenario-v0.mjs` 和 `g3-wait.mjs`。
3. **等待里写多个 channel**（`channel: "a|b"`）：现在用 `channelPrefix` 加 payload 已经能表达，不急。

以上三项建议一次合入，并赶在第四批之后那次全量重录之前；赶不上，就等下一次无法避免的重录。

### 验证与命令清单

门禁（交付树 `b06fd19d` 之后，各跑一次）：
- `node --test host/e2e/differential/*.test.mjs`：149 条，144 通过，0 失败，5 跳过（只在 Linux 上跑的命名空间用例）；
- differential vitest（经 `bin/heavy`）：25 个文件全部通过；之后改过的 `g3-corpus-check`、`g3-inputs` 两个包装单独复跑，通过；
- `boundaries.mjs`：0 违规（修 `4822dfd3` 之前 1 条，就是那个导入）；
- `import-cycles.mjs --check`：0 新增，0 过期；
- `rust-fixes.mjs --check`：63 条登记，0 错误；
- 语料检查：233 个套件、3881 个场景，阻塞项 52 条、31 个场景，`pending-*` 以外 0 条；
- SERVER-COMMANDS 的 20 个 bash 块全部通过 `bash -n`。

命令清单和手册的改动：
- S2b（新增）；
- 开头的第八轮说明、第四批的影响，以及合入 `fe5feb68` 后的复测；
- S2 的警告计数和第八轮交付树的阻塞计数，阻塞列表加 `wait-without-events`；
- S5、S6、S8 的提示；
- 手册拆分测试的判定从 `pass 28` 改为 `pass 30`（本轮 `g3-slice`、`g3-inputs` 各加 1 条）；手册和 S2 里的 embedding 模型表路径。

## 下一步

- 等主代理按 `SERVER-COMMANDS.md` 在 ser-38 执行：第四批合入后，S1 → S2 → S2b → S3 → S5 全量重录 → S4/S6。
- W13 第九轮候选：上面的推迟项（看主代理是否等）、X3 改好快照器后补测符号链接种子的端到端用例。

## 第九轮（开工合入 INT `390f244b`（第五批），合入提交 `4ae24dc9`；期间合入 INT `2be7ed80`，合入提交 `7b0778ca`）

G3 暂停（等 Linux 转绿），本轮不录制、不连服务器。目标：让第五批之后的 A 全量重录（10–11 小时）一次到位。

### 提交

| 提交 | 内容 |
|---|---|
| `4ae24dc9` | 合入 INT `390f244b` |
| `5c0777f1` | `g3-inputs.test.mjs`：MCP 单元的资源列表加 `__fixtures__/oauth-browser.ts`（第五批 W21 `83b49b40`，按 URL 复制；W21 交接 1、M3 第四节第 2 条） |
| `eabde8ad` | 推迟项 3：等待的 `channel` 可写 `"a\|b"` |
| `618e412e` | 推迟项 2：等待捕获 `${wait.N.path}` |
| `3991a334` | vitest 包装计数（`g3-wait` 12、`g3-corpus-check` 5） |
| `89b54389` | 推迟项 1：`${seed.*}` |
| `3b187884` | 场景级 `concurrent` 两侧记 `unsupported`（W21 交接 3）；MCP OAuth 场景的替身浏览器放到 A/A2/B 的 `PATH` 最前（W21 交接 2） |
| `cc66fbba` | 语料检查：`protocolVersion` 不算日期字面量（W21 交接 5）；两侧拒绝 `concurrent` 的测试 |
| `7b0778ca` | 合入 INT `2be7ed80`（C 趟）；`g3-inputs.test.mjs` 冲突取 INT 版本（内容相同，只是 INT 写成一行） |
| `171970dc` | 新增 `g3-rf-check.mjs`：rust-fixes 选择器检查 |
| `3358b2c8` | `g3-supervise --top-up-from` 也接受 `--to <同一提交>` 生成的 g3-a-stale 报告（R02 L-2） |
| `c6afc827` | 命令清单与手册（下文“文档”） |
| `2409372c` | 本文件第九轮 |
| `f1606bc3` | 拆分 `g3-normalize.mjs`，compare 的规范化器 hash 覆盖整组模块（下文“拆分”） |

### 第五批对 A 的影响（`g3-a-stale --from fe5feb68 --to 390f244b`，本地经 `bin/heavy`）

3887 个场景：3877 个 stale、10 个 missing（新场景或新路径）、4 个被删除；要增补 3887 个，远超约 1500 的重录门槛，所以必须全量重录。原因：
- W21 `b07960e0` 之前的种子模块改动（`scenario-seeds.ts` 在每个场景的 A 路径上）；
- W21 `83b49b40` 的 MCP 服务（64 个场景另有 `code:`/`resource:` 原因）；
- 14 个场景定义改了。

增补清单就是全部 3887 个场景（`topUpScenarios` 等于全量），所以不单列；按 S5 全量重录。

### 三项 A 路径功能（各自一个提交，各自有测试）

| 功能 | 提交 | 测试 | 现有场景的输出 |
|---|---|---|---|
| 通道候选 `"channel": "a\|b"` | `eabde8ad` | `g3-wait.test.mjs`（候选匹配、空候选拒绝；媒体流水线 `media-processing-completed\|media-processing-error` 按 `fileId` 过滤） | 不变：语料里没有通道写 `\|`；单个通道名按 `\|` 拆开只有它自己，仍是精确相等 |
| 等待捕获 `${wait.N.path}` | `618e412e` | `g3-wait.test.mjs` 3 条（解析、校验、`executeScenario` 端到端）、`g3-corpus-check.test.mjs`（`forward-reference`/`bad-reference`） | 不变：语料里没有 `${wait.`；`waits` 只在 `waitAfter` 匹配时记录，原有引用解析路径不变 |
| `${seed.*}` | `89b54389` | `g3-seed.test.mjs` 6 条：解析；`prepareScenarioRun` 注入绑定；`serviceGap`/`seedBindingKinds`；语料检查；指纹（只有读 `${seed.` 的场景带 `seedBindings` 分量）；真实 `buildCompare` 下两侧路径只差运行根时相等（N-007），位置或文件名不同仍判差 | 不变：没有 `${seed.` 时不取绑定（`bindings` 为 null）；用到的 2 个场景（`backup/pending-seed/historical-zip.json`）种子还不存在，照旧 `unsupported` |

设计相对第八轮推迟项的两处变化：
- 等待捕获写成 `${wait.N.path}`，不是第八轮设想的 `${N.wait.…}`：`${N.path}` 已经是“第 N 步结果的路径”，再在里面嵌 `wait` 会和结果里真叫 `wait` 的字段冲突。
- `${seed.file.*}` 不用固定 tmpfs 路径：种子副本目录就是 take 的运行根（`dirname(trace)/run`），已批准的 N-007 把各侧运行根换成 `<run>`，回显的路径在比较时相同；`g3-seed.test.mjs` 用真实比较器证明。少改 `g3-worker.mjs`，也就不碰 namespace 包装（`launch:a`）。

**对现有 A 的影响**（`g3-a-stale`，本地经 `bin/heavy`，3887 个场景）：

| 区间 | stale | 原因 |
|---|---:|---|
| `4ae24dc9` → `5c0777f1` | 0 | — |
| `5c0777f1` → `eabde8ad` | 3887 | `code:g3-wait.mjs` |
| `eabde8ad` → `618e412e` | 3887 | `code:g3-services.mjs`、`g3-wait.mjs`、`scenario-v0.mjs` |
| `3991a334` → `89b54389` | 3887 | `code:g3-run-a.mjs`、`g3-services.mjs`、`scenario-v0.mjs` |
| `4ae24dc9` → `89b54389` | 3887 | 只有这 4 个 `code:`；missing 0、removed 0 |

场景、种子、LLM、事件表分量全都不变。`3b187884` 也改了 `g3-run-a.mjs`、`g3-services.mjs`，同样是全部 stale（没有单独测；结论不变）。之后的提交（`cc66fbba` 语料检查、`171970dc`、`3358b2c8`、文档）不在 A 路径上。

**建议**：在第五批之后那次全量重录（S5）之前合入。第五批已经让 3877/3887 个失效，合入不多录一轮；之后再合就要再录 10–11 小时。`ASHA` 取落地后第一个同时含第五批和本轮的提交。

### 5 条 Linux 专属用例（读码核查，`g3-lifecycle.test.mjs`）

结论：没有明显的 Linux 问题，没有改动。逐条：
1. **first program is not PID 1**：`unshare --pid --fork --mount-proc`，`--mount-proc` 给新 PID namespace 挂自己的 `/proc`；supervisor（`supervise.mjs`）不读 `/proc`，用 pid 和信号。
2. **xvfb handshake**：照 xvfb-run 的写法（`trap : USR1`、`Xvfb … &`、`wait`），都是 POSIX，dash 能跑。
3. **hung payload teardown**：负载 shell 只用 `( … ) &`、`wait`、`[ … ]`、`$(ls -A …)`、`command -v`，都是 POSIX；`sleep 0.5` 依赖 coreutils 的小数秒，Debian/Ubuntu 上可用。
4. **private MCP directory**：namespace init（`g3-worker.mjs` 的 `NAMESPACE_INIT`）显式用 `bash -c` 执行，不受 `/bin/sh` 是 dash 影响；`unshare --mount-proc` 隐含新的 mount namespace，util-linux 默认把传播设为 `private`，所以 `/tmp/g3-mcp` 上的 tmpfs 不会传播到宿主或别的 worker。
5. **real xvfb-run**：`xvfb-run` 不存在时跳过并写明原因（服务器 S2 要求 `skipped 0`，缺了会被发现）。

其他：路径大小写全部与仓库一致（`/tmp/g3-mcp`、`G3_MCP_DIR`）；`linuxSkip` 覆盖 AppArmor 限制非特权 userns（`unshare -rnpf --mount-proc` 失败）和缺 `ip` 的情况：跳过而不是报错，服务器上 S2 要求 `skipped 0`，所以那种情况会被发现。

### rust-fixes 选择器检查（`g3-rf-check.mjs`，手册 §12.5）

85 条登记，其中 26 个 G3 选择器；问题 7 个（`no-scenario` 3、`no-table` 1、`fs-path` 3），范围宽 22 处。不加归一化，不改登记（属主改）。按属主：

**S01**
- `RF-S01-shell-environment-failure`（`host/e2e/differential/rust-fixes/RF-S01-shell-environment-failure.json:27-28`）：`*local_shell*` 匹配不到任何场景（db、event 两个选择器都不会生效）。第 29-30 行的 `*git_*` 只碰巧匹配 `automation.create.daily_time_single_digit_hour`（`digit_` 里有 `git_`），也不是想要的场景。请换成确实走到这个修复的场景 id；当前语料里没有 id 含 `local_shell` 的场景，对应场景还没写进语料的话，这四个选择器现在都不起作用。

**W07**
- `RF-W07-crypto-root-adopts-slot-master-key`（`…/RF-W07-crypto-root-adopts-slot-master-key.json:22`）：fs `.master_key` 永远不会命中：G3 只采集 SQLite 文件，fs 选择器只覆盖“数据库文件只在一侧存在”的样本，`.master_key` 不是数据库，也不在任何数据库路径上。G3 看不到这个差异，靠 W07 自己的测试守护；选择器可以删掉，或改 `affects` 说明 G3 不覆盖。
- `RF-W07-legacy-root-security-entries-copy`（`…:23-24`）：`.master_key`、`.secure` 同上。
- `RF-W07-llm-usage-session-caller-id`（`…:21`）：`scenario: "llm_usage.*"` 匹配不到场景；跑 `llm_usage_session_summary` 的 3 个场景 id 是 `storage.llm_usage.session_summary.empty`、`storage.llm_usage.session_summary.arg_errors`、`storage.llm_usage.seeded.recent_and_session`。建议：
  ```json
  { "scenario": "storage.llm_usage.*", "surface": "ipc", "command": "llm_usage_session_summary", "jsonPath": "$.<改动的字段>" }
  ```
  不带 `jsonPath` 是整个结果（含成功/失败形态），请确认是否需要这么宽。
- `RF-W07-pending-memory-candidates-schema`（`…:21`）：db `pending_memory_candidates.subject` 永远不会命中：A 不建这张表，两侧差异是 `table` 行（一侧没有这张表），db 选择器只覆盖 `value`/`storageClass` 行。第 22-24 行三个 ipc 选择器是 `scenario: "*"` 且不带 `jsonPath`（整个结果），范围宽；如果为了豁免“A 报命令不存在、B 成功”的形态差异，这是必要的，请在登记里写明。

**只是范围宽（请属主确认）**：W02 `RF-W02-super-closed-worker-revival` 三个 event 选择器 `chat_v2_event_*`（名字通配，41 个场景）；W05 `RF-W05-web-search-connectivity-unregistered` 三个 ipc 选择器 `scenario: "*"`（带 `jsonPath`，实际 5 个场景）。

### 交接处理

| 来源 | 事项 | 处理 |
|---|---|---|
| W21-1316 #1、M3 第四节 #2、`lanes/FROM-MAIN.md` | `g3-inputs.test.mjs` 的 MCP 资源列表缺 `oauth-browser.ts` | INT 已补；`5c0777f1` 修好合入后的断言 |
| W21-1316 #2 | OAuth 浏览器 PATH | `3b187884`；`g3-services.test.mjs` 在真实 OAuth 套件上检查 `command -v xdg-open` 解析到替身。端口 47131 在每个 worker 自己的 net namespace 里 |
| W21-1316 #3 | 场景级 `concurrent` | `3b187884`：两侧记 `unsupported: scenario uses concurrent`；`cc66fbba` 在真实 OAuth 套件上测两侧 |
| W21-1316 #4 | `${runner.*}`、`${seed.*}`、`${fixture.*}`、`${search.*}` | `${seed.*}` 已做（`89b54389`）。`${fixture.pending*ExportRequestId}` 不需要录制器再改，套件改用等待捕获即可（交接给 qbank owner，见下）。`${runner.*}`（25 条）、`${search.*}`（1 条）是新的 A 路径功能，场景都在 `pending-*`，本轮不做，留到下一次不得不做的全量重录前 |
| W21-1316 #5 | `protocolVersion` 被当成日期 | `cc66fbba`：这个键（参数字段，或嵌在 JSON 文本里的 `"protocolVersion":"…"`）不再算，`date-literal` 527 → 521 |
| W21-1316 #6（可选） | PROGRAMS 加 `oauth-browser.ts` | 不改：它已作为 `resource:` 整文件计入 MCP 单元指纹，再算成 `program:` 只会重复 |
| W21-1316 #7、W21-1208 #1 | 恢复模式跳过准备步骤 | 第七轮 G3-STARTUP/v1 已经解决：准备命令 `vfs_set_indexing_config` 的结果（成功或 `COMMAND_NOT_FOUND`）原样记录，**不中断**录制（`g3-startup.mjs:17`，测试 `g3-startup.test.mjs:55-56`），两侧不同时报 `startup-setup`。`backup/pending-runner/backups-path-is-file-recovery` 可以由 W21 移出 pending |
| W21-1316 #7 | 快照器新条目类型 | 录制器这一半第七轮已做（`155a9c48`）；`database-state.ts:115` 归 X3，仍未处理 |
| W21-1208 #4 bug | 没有 `event` 的等待会被任何事件满足 | 第七轮已修：`event` 只在 spec 写了时才比较，spec 必须有 `event`/`channel`/`channelPrefix` 之一 |
| W04 第九轮第 2 项、第十轮 | `waitAfter` 表达不了“等这次流水线到终态” | 录制器第七轮起已经能表达：按 payload 字段匹配，并且只认本步 invoke 之后的事件（锚点 `since`）；本轮加了通道候选。写法（`g3-wait.test.mjs:53-56` 就是这个例子）：`"waitAfter": {"channel": "media-processing-completed\|media-processing-error", "payload": {"fileId": "${8.fileId}"}}`。场景归 W04 改。等待上限 15 秒（`WAIT_DEADLINE_MS`）不改；A 在 15 秒内到不了终态时这个 take 是 runner 错误，要带服务器证据再议 |
| W04 第十轮 | B 启动后等启动维护 | 第七轮 G3-STARTUP/v1 已做（第八轮交接表已列） |
| W05-1316 | G3 B 要不要重放前端启动时的配置调用（`configApi.ts:117,135`） | **本轮不做，交主代理决定**，理由与设计见下 |
| W07-1316、W10-1316 | 在第七轮录制上重新判断 `lance.optimize.last.*` | 本轮没有录制，无法处理；第五批之后的 S4 smoke 出来后再看 |
| R02 L-2 | `--top-up-from` 只认干净工作树的报告 | `3358b2c8`：也接受 `--to <同一提交>` 的报告（短 SHA 本来就被 `--commit` 的 40 位校验拒绝）；`g3-a-stale.test.mjs` 两个方向都测 |
| V10、W28 H7 | `g3-normalize.test.ts` 快照没跟上批准 | INT `fe5feb68` 已修 |
| W21-1458 #2 | `mcp-service.ts:190` 的 `mcp-wave0-*` 临时目录不删 | W21 的文件，W21 自己的补丁已给出；G3 录制传固定 `logDir`，不受影响 |

**W05 的决定项**：A 的 webview 跑真实前端，启动时调 `get_model_profiles` 等命令，Rust 在这些命令里写入默认模型配置；G3 的 B 只有 Host、没有前端，这些行只出现在 A。可选做法是 B 在启动观察里按 `src/` 的调用重放这几个命令（只改 B 路径，不让 A 失效）。本轮没做，原因：
- 没有第七轮之后的录制，无法确认这些行是否真的出现在 A 的 `before` 快照里（取决于前端调用落在边界之前还是之后）；
- 手写的“前端启动调用表”会随前端版本漂移，需要像 `frontendEvents` 那样从源码推出来，并且要能证明 A 前端确实调了；
- 要先看第五批之后 S4 smoke 里 A 独有的配置行有多少，再决定。

### 交给其他 lane

- **W21**（`host/e2e/data-compat/__fixtures__/a-produced-seeds.ts:192-193`）：注释“the recorder's resolver does not read a `seed` namespace yet (W13)”已过时，改成“recorder: scenario-v0 `prepareScenarioRun`（W13 `89b54389`）”。另外 `backup/pending-runner/backups-path-is-file-recovery` 可以移出 pending（上表）。验证：`node scripts/electron-migration/record/g3-corpus-check.mjs` 该场景无阻塞项。
- **qbank owner**（`host/plugins/qbank/equivalence/pending-provider/g3-paper-exam-pending.json:12-16`、`33-37`）：`requestId` 改从等待捕获取值。`qbank-export-paper` 在 A 的订阅表里，payload 字段是 `request_id`（`export_bridge.rs:21-27,46-54`）：
  ```json
  { "cmd": "<触发 qbank 导出工具的 chat 命令>", "args": { … }, "waitAfter": { "channel": "qbank-export-paper" } },
  { "cmd": "qbank_complete_paper_export", "args": { "requestId": "${wait.0.request_id}", "data": "UEsDBA==", "error": null } }
  ```
  场景还要 `"llm"` 脚本让模型调用导出工具。验证：`g3-corpus-check.mjs` 不再报 `${fixture.…}` 的 `bad-reference`。
- **S01、W07**：上面的选择器问题，验证 `node scripts/electron-migration/record/g3-rf-check.mjs --strict` 退出 0。
- **W04**：上表的流水线终态等待写法，验证 `g3-corpus-check.mjs` 无阻塞项。

### 拆分 `g3-normalize.mjs`

`record/` 下只有它超过约 800 行（888 行）。按职责拆成三个模块，代码原样搬移：
- `g3-normalize-values.mjs`（39 行）：JSON 值的叶子遍历、取值/写值、`tableKey`；
- `g3-normalize-clock.mjs`（168 行）：N-014 拆分录制时钟（`stableJsonSites`、`projectClock`、`clockInversions`、`clockOrderDifferences`）；
- `g3-normalize.mjs`（704 行）：其余规则和入口，对外导出不变。

compare 产物原来记的是 `g3-normalize.mjs` 这一个文件的 sha256。拆开后，只改辅助模块不会改变这个 hash，过期的 compare 会被当成有效。所以新增 `NORMALIZER_FILES`（入口加三个依赖：两个新模块和 `json.mjs`）和 `normalizerSha256(root)`，hash 覆盖整个集合。五处用到这个 hash 的地方都改成调它：`g3-compare` 写入、`g3-report` 校验、`g3-manifest` 封存、`g3-batch` 复用判断、`g3-triage` 分组。产物里的 `normalizer.file` 仍写入口文件。

测试：
- 新增 `g3-normalize-split.test.mjs` 2 条：`NORMALIZER_FILES` 等于入口的相对 import 闭包（不允许动态 `import(`），每个模块都不到 800 行；同一棵树 hash 相同，任一模块改一个字节 hash 就变。
- `g3-report.test.mjs` 加断言：只改 `g3-normalize-clock.mjs`，原来有效的 compare 也判 `normalizer sha256 mismatch`。
- `g3-inputs.test.mjs` 把两个新模块列进“不在 A 路径上”。
- 复制规范化器的 7 处测试夹具改用 `__fixtures__/normalizer.mjs` 的 `copyNormalizer`；`g3-manifest`、`g3-provenance`、`g3-report` 的夹具改为复制整个 `NORMALIZER_FILES`。

**影响**：A 不受影响（规范化器不在 A 路径上，A 指纹不变）。hash 的范围变了，已有 compare 全部判过期：要重算，不需要重录。第五批之后反正要全量重录，所以没有额外代价。`host/e2e/differential/LANE.md:8`“不要改 `g3-normalize.mjs`、`g3-compare.mjs`、`g3-batch.mjs`”是吸收 X7 服务器分支时带进来的旧说明（2026-11-06，当时正在录制）；本轮不录制，派单明确要求拆分。

### 未做

- W05 的决定项（上面）。
- `${runner.*}`、`${search.*}`、场景级 `concurrent` 的支持：新的 A 路径功能，场景都在 `pending-*`。

### 验证（`f1606bc3`，已含 INT 最新 `2be7ed80`）

- `node --test host/e2e/differential/*.test.mjs`：171 条，pass 166、fail 0、skipped 5（`g3-lifecycle` 的 5 条 Linux 专属用例，本机 macOS 跳过并写明原因，只能在服务器 S2 验证）。
- `bin/heavy npx vitest run -c vitest.host.config.ts host/e2e/differential --maxWorkers=2`：29 个文件、29 条全部通过。
- `bin/heavy npx tsc --noEmit -p tsconfig.host.json`：0 错误（先 `version:generate`，跑完删掉 `src/version.ts`）。
- `boundaries.mjs`：3959 个文件，0 违规。`import-cycles.mjs --check`：0 新增、0 过期。`rust-fixes.mjs --check`：85 条，0 错误。
- `g3-corpus-check --strict`（`bin/heavy`）：233 个套件、3887 个场景，阻塞项 43 条（`bad-reference` 32、`unknown-seed` 11），涉及 26 个场景，`pending-*` 以外 0 条（`exit=1` 是预期）；`date-literal` 521。
- `SERVER-COMMANDS.md` 20 个 bash 块全部通过 `bash -n`。
- 本机已知的环境失败（bilibili pair.html、sqlite-busy darwin-arm64 等）不在本目录，没有碰到。
