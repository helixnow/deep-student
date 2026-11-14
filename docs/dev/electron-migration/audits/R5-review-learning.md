# R5-review-learning 独立复核汇总

日期：2026-11-04。验收人：R5-review-learning（独立上下文）。初审统计及整目录测试保留为历史快照；协调者指令1的定向增量结论见文末，不自动改变验收勾选。

**结论：四条 lane 均不通过 B 级。** 共27个“必须修复”编号，其中25个是实现/接线/测试证据/架构缺口，2个是测试运行未能干净退出的验证阻塞；编号按可派回的整改单元计数，不按缺失命令或测试逐项膨胀计数。

## 范围与基线

- 工作树 `/home/dsdev/dev/ds-mig/R5-review-learning`，分支 `ds-mig/R5-review-learning`；实现基线 `f23c98702`。
- 只写四个 ACCEPTANCE 与本报告；实现、测试、SPEC、TESTMAP 均只读。没有切换分支，没有编译或运行 Rust。
- 依据：`contracts/ipc/L14-qbank.json`、`L15-review-analytics.json`、`L16-anki.json`、`L24-chatanki.json`，对应 Rust/TS 源码与测试断言、实际工具输出。实现者自述仅用于查找“是否登记”，不作为等价证据。
- 四目录原无 ACCEPTANCE；所有勾选项均为本次“复核确认”。
- 恢复后执行过用户指定的 `git log --oneline -20`、`git status`、TESTMAP统计和只读 ledger 检查。服务器重启取消的测试不算成功，随后重新执行该两组。
- 并发进程存在；未使用 stash/reset/checkout/clean。协调者自动检查点保存过 Anki/chatanki 报告，已用 git log/show 核实，不把 diff 为空误判为文件丢失。

## 初审汇总与最严重问题（历史快照）

| lane | 结论 | 必须修复数 | 最严重的3项 | 独立结论文件 |
|---|---|---:|---|---|
| L14-qbank | 不通过 | 8（含1验证阻塞） | Q1答题/改判学习闭环省略；Q2批改真实依赖缺失且图片一律失败；Q8与L11重复写题目表 | `host/plugins/qbank/ACCEPTANCE.md` |
| L15-review-analytics | 不通过 | 6（含1验证阻塞） | R1合法null触发错误/崩溃；R2 scoped服务未公开；R3跨领域测试用复制业务SQL | `host/plugins/review/ACCEPTANCE.md` |
| L16-anki | 不通过 | 6 | A1缺9条生成生命周期命令；A2日志接线冒充业务可达；A3与review双写FSRS表 | `host/plugins/anki/ACCEPTANCE.md` |
| L24-chatanki | 不通过 | 7 | C1旧服务名阻止启动；C2服务/工具注册未真实接通；C4原子性/CAS测试只验证替身 | `host/plugins/chatanki/ACCEPTANCE.md` |

所有未勾选项均阻止 B 成立；修复应回原 lane，由独立复核人核实后勾选。不是“测试全绿但有建议”的有条件通过。

## 初审五项清单结果（历史快照）

| lane | 命令/入口等价 | 测试真实性与账本 | 亲自运行 | 架构 | 差异分类 |
|---|---|---|---|---|---|
| qbank | 问题；18条抽查 | 初审16条ported样本通过；原102 pending；2 merged无需审批，目标断言覆盖不完整 | 169断言通过，但RPC错误退出1；import/wiring通过 | 问题：与L11重复仓储/表写入 | 已区分业务缺陷、待接线与已登记毫秒精度 |
| review | 问题；17条抽查 | 19条scheduler通过；另1条跨域样本不真实；2 pending | 143断言通过，但RPC错误退出1；import/wiring通过 | 问题：scoped服务面和FSRS所有权 | 同上；优化器是缺实现而非平台豁免 |
| anki | 问题；18条抽查 | 15条AnkiConnect样本通过；存在无生产消费者的ported；112 pending | 568通过/1跳过，退出0；import/wiring通过 | 问题：FSRS双写、对外API不完整 | 同上；取消/生成缺口未获豁免 |
| chatanki | 问题；0 IPC命令，改查18工具入口 | 15条样本中10条被测仓储是替身，5条normalize通过；16 pending | 319通过，退出0；import/wiring通过；真实加载名校验失败 | 问题：旧名和无真实提供方 | 同上；事件/回退/错误形状属于缺陷 |

**抽样口径需协调者确认：** `contracts/ipc/L24-chatanki.json:4` 明确 `commands: []`。本报告没有虚构15条 Tauri命令；以18个 Rust ToolExecutor 入口作静态替代抽样，并在该 ACCEPTANCE 说明。其余三 lane 满足至少15条命令；每 lane 至少15条 ported 测试逐项给出文件和行号。

## 实测输出

### 测试（未改配置或断言）

```text
npx vitest run -c vitest.host.config.ts host/plugins/qbank
Test Files 21 passed (21); Tests 169 passed (169); Errors 8 errors
Duration 129.56s; exit 1

npx vitest run -c vitest.host.config.ts host/plugins/qbank --maxWorkers=1
Test Files 21 passed (21); Tests 169 passed (169); Errors 4 errors
Duration 119.10s; exit 1

npx vitest run -c vitest.host.config.ts host/plugins/review
Test Files 13 passed (13); Tests 143 passed (143); Errors 1 error
Duration 68.34s; exit 1

npx vitest run -c vitest.host.config.ts host/plugins/review --maxWorkers=1
Test Files 13 passed (13); Tests 143 passed (143); Errors 1 error
Duration 91.24s; exit 1

共同错误原文：Error: [vitest-worker]: Timeout calling "onTaskUpdate"

npx vitest run -c vitest.host.config.ts host/plugins/anki
Test Files 31 passed (31); Tests 568 passed | 1 skipped (569)
Duration 59.59s; exit 0

npx vitest run -c vitest.host.config.ts host/plugins/chatanki
Test Files 31 passed (31); Tests 319 passed (319)
Duration 8.23s; exit 0
```

qbank/review 的 RPC 超时未归因为业务缺陷；限 worker 重跑仍有错误，本次不能宣称测试验收通过。Anki 跳过项为外部 APKG 环境 smoke（`tests/apkg-importer.test.ts:1872`），不计作通过。

### 可导入、可达性、边界、账本

```text
node scripts/electron-migration/importable.mjs host/plugins/qbank/index.ts host/plugins/review/index.ts host/plugins/anki/index.ts host/plugins/chatanki/index.ts
importable: ok
exit 0

node scripts/electron-migration/wiring.mjs --lane qbank
合计 ported 137，其中所测模块未从 index.ts 接入 0（0.0%）
node scripts/electron-migration/wiring.mjs --lane review
合计 ported 126，其中所测模块未从 index.ts 接入 0（0.0%）
node scripts/electron-migration/wiring.mjs --lane anki
合计 ported 518，其中所测模块未从 index.ts 接入 0（0.0%）
node scripts/electron-migration/wiring.mjs --lane chatanki
合计 ported 270，其中所测模块未从 index.ts 接入 0（0.0%）
以上各退出0。

node scripts/electron-migration/boundaries.mjs host/plugins/qbank host/plugins/review host/plugins/anki host/plugins/chatanki
boundaries: scanned 275 files, 0 violation(s), 33 suppressed via boundary-allow
exit 0

npm run migration:ledger -- --check --no-write
ledger: commands 1058 (A 88.8% B 1.8% C 0%), tests 8036 (A 70.3% B 0.4%);
problems: commands 0, tests 250, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
exit 1
```

ledger 的250是全仓问题数，不归到本次四 lane。边界扫描不能识别两个合法 repository 对同表双写，也不能识别调用测试自己实现的业务。扫描通过与静态审读不通过并不矛盾。抽查 chatanki 两个空 catch suppression，Rust 确实 `let _` 且无日志（`chatanki_executor.rs:14504,14589`），不错误要求增加日志。

### 无文件改动的直接复现

1. review 生产校验：`desiredRetention:null` → Validation；`learningSteps:null`、`fsrsParams:null` → `TypeError ... reading 'length'`。合法 wire Option 应不更新（契约 `L15-review-analytics.json:4875-4996`）。
2. chatanki Host依赖：仅提供当前新名 `anki` 时，`PluginLifecycleError: plugin "dstu.chatanki" did not start: required services not available: "anki@1"`。
3. chatanki 生产 analyze 普通文本：`{"success":true,"events":["end"]}`；Rust dispatcher 必先发 start（`chatanki_executor.rs:1882-1883`）。

## 共性问题（建议回灌规范）

1. **模块可导入 ≠ 业务可调用。** Anki 为 logger 导入整模块、review 未公开 scoped方法、chatanki 测试伪造服务字段，均能得到 wiring=0 未接入。ported 证据必须指向“真实入口→真实方法→真实副作用”；模块级扫描只作必要条件。（A2、R2、C1/C2。）
2. **不能复制被测业务到测试辅助文件。** review 的 `tests/anki-data-layer.ts` 和 chatanki 的 `CardStoreDouble` 把真正要验证的数据库保证搬到测试里。真实 SQLite 也不能证明复制SQL等于生产SQL；替身可替外部依赖，不能替被验收的 CAS/事务/删除实现。（R3、C4。）
3. **表只有一个写入者，不能仅靠目录边界审查。** qbank/L11 都写 questions 及相关表，anki/review 都写 FSRS 表。机械边界允许各自 repository 中的 SQL，不等于架构符合。公开 API 要保留原事务边界，避免“修所有权”时拆掉原子操作。（Q8、A3/R4。）
4. **缺依赖不能伪装成已完成的错误分支。** qbank 批改总失败、chatanki APKG固定失败、API字段“存在时使用”都不是完整移植；已登记“待接线”不是批准的平台差异。（Q2、C2/C3、A5。）
5. **测试断言全绿不等于测试进程通过。** qbank/review 有未处理RPC错误，必须同时报告退出码；环境取消单列。测试数量也不能包含 skipped。`vitest | tail` 未开pipefail时的shell成功只代表tail成功，不能冒充Vitest退出0；需直接执行或保留 `PIPESTATUS[0]`/pipefail及Errors证据。（Q7、R6；新增原始事件证据见文末。）
6. **保留生命周期和跨模块副作用。** qbank 的复习闭环、anki 删除时取消调度、chatanki 的 start/error事件均可在纯函数/CRUD测试全绿时被遗漏。命令审读必须包含提交后、取消和事件顺序。（Q1、A4、C5。）

## 派回与复核要点

- L14：Q1/Q2/Q3/Q4/Q5/Q6，联动 L11 修 Q8，隔离资源确认 Q7。
- L15：R1/R2/R3/R5，联动 L16 修 R4，隔离资源确认 R6。
- L16：A1/A2/A4/A6，联动 L15/L24 修 A3/A5。
- L24：C1–C7；真实接线需要 L07/L16/L15/L02/L04/L11/F7 共同契约，不能只补测试对象。
- 平台差异只认可已登记的真实平台限制，例如 `decisions.md:52-59` 的时间精度；本报告未批准新例外，也未改 approvals/TESTMAP。

## 协调者指令1：Q6 规则纠正（增量）

本轮先合并 main：`4b9c2809b`，其 main 父提交为 `35b4fbfdf`。**撤回 Q6 中“merged需协调者审批”的错误要求**。当前 `scripts/electron-migration/lib/ledger-core.mjs:37-76` 只有 obsolete 查 approvals；merged 查目标文件/可选用例，并在有Vitest报告时要求对应断言通过。

实际复核 `TESTMAP.md:247-248` 的两个目标：第一个保留主要换判行为但缺原链长1/2与首判返回值断言；第二个测试 false→false→true→false，未覆盖原 Rust 的 false→true→true 同向重放。证据见 `host/plugins/qbank/ACCEPTANCE.md` 增量章节。目标经生产 `host.ctx.mastery` 跑通不等于合并覆盖完整。Q6 保持未勾选，阻塞理由纠正为实际覆盖缺口；当前行状态164 ported/75 pending/2 merged，与未刷新的表头有差异。

实跑 review 的两个目标及 R2 新用例：`npx vitest run -c vitest.host.config.ts host/plugins/review/tests/fsrs-commands.test.ts host/plugins/review/tests/mastery.test.ts -t 'review_service_exposes_agent_scopes_and_review_statistics|qbank_verdict_correction_false_to_true_recomputes_state|qbank_verdict_correction_is_idempotent_and_supports_reflip' --maxWorkers=1 --no-file-parallelism`，**3 passed / 11 filtered，4.91s，exit 0**。不以此小范围结果关闭 Q7/R6 的整目录资源超时阻塞。

## 协调者指令1：编号→提交→真实入口→实测结果

本轮仅做被指定增量；**所有原有验收勾选保持不变，四lane结论仍不通过**。`4b9c2809b` 合并父提交为 `17fa90a1b` 与 main 快照 `35b4fbfdf`；合并后main继续前进不纳入此次运行基线。

| 编号 | 修复/候选提交与状态 | 真实生产入口和本次判定 | 测试与退出码 |
|---|---|---|---|
| R2部分 | `14cbe1b2a`，已在合并树 | `review/index.ts:25-44` → Cordis `host.ctx.review` → `FsrsReviewService` → SQLite。session入队、session/library快照、review statistics四方法已提供并实测。library CAS入队、scoped挂起/撤销仍未发布；完整chatanki消费链未验。 | T1：3通过（R2占1，Q6占2），11由过滤排除，exit0；T3 import exit0。R2不整项关闭。 |
| C5部分 | `afc0f422a`未在合并树；共同start/info来自祖先`440782ab1` | 从git对象内存加载候选的 `ChatAnkiExecutor.execute`，成功/失败analyze都发start与info。独立`ChatAnkiMutationExecutor.execute`仍只有error；status终态error仍改warn。候选代码中start先于info，Rust相反，未认定全部日志顺序等价。 | T4：候选真实模块3个断言场景 exit0；并非完整Host/Vitest套件。C5保持未勾选，等待合入及剩余通道修复。 |
| A1/A2 | `355e79df1`累积树（端口/handler在祖先`e492d1001`、`840b04705`）已在合并树 | 命令已声明；真实handler在`plugin-handlers-generation.ts:42-50,190-205`查不存在的`ankiGeneration@1`即Configuration。注入端口后确实调用真实分段/调度，但切卡/入库/事件全被端口宣称交给L02；本lane StreamingAnkiService未被生产实例化，critic无收尾调用。 | T2：4通过/13过滤，exit0；T3 import exit0。无服务失败属实；替身只记录任务/返回预置cards，不证明生成闭环。630ported不关闭A1/A2。 |
| Q6纠正 | 本轮审读纠正；被映射测试没有新增实现提交 | `mastery.test.ts:68-94`经真实`host.ctx.mastery`；merged无需审批。原首判/链长断言及纠正后的true→true重放未完整覆盖。 | T1中两目标通过，exit0，但不能补上缺失断言；详见Q6纠正章节。 |
| Q7/R6 | 无本轮完整目录复测 | 只作上述定向验证；212断言运行已由C1核实为2 unhandled errors、tail掩盖退出码（见文末），不改变R5初审完整运行exit1的独立证据。 | 保留验证阻塞；本轮未重跑全目录。 |

### 本轮准确命令与原始输出摘要

**T1** 命令见上一节（review 两个文件的3用例过滤）：

```text
Test Files  2 passed (2)
Tests       3 passed | 11 skipped (14)
Duration    4.91s
exit 0
```

**T2**：

```text
npx vitest run -c vitest.host.config.ts host/plugins/anki/tests/anki-generation-commands.test.ts -t 'generate_from_document_fails_configuration_without_generation_service|start_fails_configuration_without_generation_service_and_writes_no_tasks|start_creates_tasks_emits_started_and_runs_each_task_to_completion|generate_from_document_maps_success_and_passes_subject_and_options' --maxWorkers=1 --no-file-parallelism
Test Files  1 passed (1)
Tests       4 passed | 13 skipped (17)
Duration    8.95s
exit 0
```

`skipped`均由`-t`筛选产生，没有新增skip、修改测试或删除断言。成功生成用例的 `generationDouble` 只返回预置数组/记录task（`anki/tests/anki-generation-commands.test.ts:84-92`），只支持命令/调度层结论。L16需自己接通Rust流式制卡业务，L02仅承接模型传输能力；不能把自有生成管线一并移交其他lane。

**T3**：

```text
node scripts/electron-migration/importable.mjs host/plugins/review/index.ts host/plugins/anki/index.ts
importable: ok
exit 0
```

**T4**：`node --input-type=module` heredoc（内存候选模块验证，exit0）。下面为实际执行逻辑，未落地脚本/替换工作树源码：

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = process.cwd(), revision = 'afc0f422a';
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:')) {
    const relative = path.relative(root, fileURLToPath(url));
    if (relative.startsWith('host/plugins/chatanki/') && relative.endsWith('.ts')) {
      const source = execFileSync('git', ['show', `${revision}:${relative}`], { encoding: 'utf8', cwd: root });
      return { format: 'module', source: stripTypeScriptTypes(source), shortCircuit: true };
    }
  }
  return nextLoad(url, context);
}});
const load = name => import(pathToFileURL(path.join(root, `host/plugins/chatanki/src/${name}.ts`)).href);
const { ChatAnkiExecutor } = await load('chatanki-executor');
const context = trace => ({sessionId:'audit',messageId:'m',blockId:'b',
  emitToolCallStart:()=>trace.push('start'),info:()=>trace.push('info'),
  emitToolCallEnd:()=>trace.push('end'),emitToolCallError:()=>trace.push('error'),
  saveToolBlock:()=>{},warn:()=>{}});
for (const [args, terminal] of [[{content:'学习材料'},'end'],[{content:'学习材料',route:'invalid'},'error']]) {
  const trace=[];
  const result=await new ChatAnkiExecutor().execute({id:'audit',name:'chatanki_analyze',arguments:args},context(trace));
  assert.deepEqual(trace,['start','info',terminal]);
  console.log(JSON.stringify({revision,case:terminal,success:result.success,trace}));
}
const { ChatAnkiMutationExecutor }=await load('mutation-executor');
const trace=[];
await new ChatAnkiMutationExecutor().execute({id:'audit',name:'chatanki_update_card',arguments:{}},context(trace));
assert.deepEqual(trace,['error']);
console.log(JSON.stringify({revision,case:'mutation-invalid-args',trace}));
```

```text
{"revision":"afc0f422a","case":"end","success":true,"trace":["start","info","end"]}
{"revision":"afc0f422a","case":"error","success":false,"trace":["start","info","error"]}
{"revision":"afc0f422a","case":"mutation-invalid-args","trace":["error"]}
exit 0
```

这使用真实候选模块而非源码片段重实现；只能证明所列局部分支，不能替代真实profile/提供方装载测试。仅Linux Node环境，**Windows/macOS、Electron、完整候选Host与跨平台C级均未验证**。本轮未复跑无增量的全量检查，也未改动独立验收勾选。

## C1补充：Q7原始事件及管道退出码纠正

证据来自协调者只读核实的L14原始工具事件，不是R5新增测试或实现者报告自述：

| 运行 | 命令/原始输出 | 可确认的退出状态 |
|---|---|---|
| 事件显示12:16:17启动的212断言运行 | `npx vitest run -c vitest.host.config.ts host/plugins/qbank 2>&1 \| tail -40`，无pipefail；原输出 `Vitest caught 2 unhandled errors`、`Tests 212 passed`、`Errors 2 errors` | 外层shell exit0是tail退出码；**Vitest自身退出码未知** |
| 更早171断言运行 | 同样接 `\| tail -15`，有5 errors | Vitest自身退出码没有可追溯证据，不能由管道成功推出成功 |

结论：**Q7保持开放**。纠正“2条超时告警、非失败”的表述为“2个未处理错误；Vitest退出码被管道掩盖、未知”。不反向猜测Vitest具体退出码，也不将RPC错误直接归因为业务缺陷。上轮R5亲自完整运行的exit1与这两次L14运行分开记录。

L14应修正其实现者报告；R5仅更新允许的验收文件与本汇总。下次按修复验证安排直接执行Vitest，或使用 `set -o pipefail` / 明确保存 `PIPESTATUS[0]`，保留Errors行及真实退出状态，不能以tail摘要报绿。**本消息只增加证据，没有触发重跑，没有弱化断言/新增skip，也没有关闭Q7/R6或其他验收勾选。**

## C1 04:55Z：新增 R2/R4 提供面的静态复核

仅审候选api提交 `877089c34` 与完整快照 `f221d37fd`。检查时审读HEAD=`92a9ef56d`，main=`c7c15e5b5`；两候选对HEAD/main的四次祖先检查均退出1，**均尚未集成**。以git对象只读审查，没有摘取实现到审读分支，没有重跑旧代码测试，也没有执行候选代码。

| 编号 | 候选与真实提供路径（均指f221d37fd） | 已确认的增量 | 未闭合部分 / 测试 |
|---|---|---|---|
| R2公开面 | `877089c34`发布api；`review/api.ts:80-107` → `index.ts:31-77` → `FsrsReviewService`；`index.ts:17,170-175`实际提供review | `enqueueCardsForLibrary`、`setSuspendedForSession/Library`、`undoLastReviewForSession/Library`五方法已声明并逐参委托，保留CAS outcome和错误传播；不再只是内部类方法 | L24实际消费/端到端CAS未验证；R2不整项勾选。测试未运行，退出码不适用 |
| R4所有者接口 | `review/api.ts:108-115` → `index.ts:78-98` → `src/review.ts:638-678` → `repository/fsrs.ts:1011-1043` / 原insertState | 三个`cleanup*DeletionInTx`和`enqueueImportedCardsInTx`使用传入conn，无内部另开/提交事务；清理先logs后states，SQL在review仓储，提供同事务接入能力 | L16是否已实际调用、移除原有FSRS写SQL、保证整体事务回滚未验证；R4不整项勾选。测试未运行，退出码不适用 |

逐方法声明/委托行号和范围限制已补入 `host/plugins/review/ACCEPTANCE.md` 的04:55Z章节。提供方修复证据已认可，不据此认定双写所有权或真实消费者闭环完成；旧表格是旧运行基线的历史证据，不把“仍未发布”套用到该候选。

本轮没有新增运行验证，也不引用上一轮测试exit0为新增入口背书。所有验收勾选保持不变，Q7/R6仍开放；L24 C1/C5等等待明确编号交付后再复核。候选未进main，按本次指令记录后结束；跨平台/Windows/macOS/Electron未验证。

## C1 05:34Z：L15新交付的定向复核

本轮审读起点 `b2b138fe7`；检查时main=`11b57346f`。`8d213a08f`、`91c250fe5`、`ec41ef932`、`c07bd04d1` 均未进入HEAD/main（祖先检查exit1）。已读main的decisions D1–D6与quality§10；只读候选git对象，未摘实现、未在旧基线运行测试。详细逐项证据写入 `host/plugins/review/ACCEPTANCE.md` 的05:34Z章节。

| 编号 | 提交→真实入口/新增证据 | 本次结论 |
|---|---|---|
| R1 | `91c250fe5` → `8d213a08f:src/review-config.ts:14-55` / `src/review.ts:687-724`；真实Host invoke null回归 `tests/fsrs-commands.test.ts:125-139` | 静态确认17字段在校验、写入两层保持None语义，原错误具体修复成立；不再声称候选仍崩溃。未main集成、未R5本轮实跑，不自动改勾选。 |
| R2部分 | `ec41ef932` / `8d213a08f:tests/l24-review-state-consumer.test.ts:15-23,63-105`；真实review入队→真实chatankiTools.get_cards→真实review快照 | 局部消费者证据成立；`anki@1`空提供物和cards读取对象仍是替身，不能证明真实L16或scoped/library CAS端到端。 |
| R3部分 | `8d213a08f:tests/fsrs-cross-domain.test.ts:395-482` 安装真实Anki并invoke删除及library/content读 | 删除路径测试真实化子项确认；legacy-null的读取路径真实化确认，但仍缺原Rust读取结果中空tags/images/extra_fields的断言（Rust`:10135-10154`，TS`:462-470`）。另四条仍用业务镜像且TESTMAP仍ported；整项不关闭。 |
| R4提供方 | `8d213a08f:tests/service-transaction-api.test.ts:54-134`，真实 `host.ctx.review` +传入conn | 两条验证回滚/提交，第三条验证history/suspended统计；生产服务测试设计有效。未证明L16已调用这些接口，cleanupTask/Document未被这些新用例覆盖；候选L16删除仍直接写FSRS。 |
| R6 | C1核实 `c07bd04d1` 的原工具事件：review全目录150 passed、无Errors，显式捕获code并返回，真实exit0 | **认可该快照的干净运行证据**，不是普通tail exit0，也不是实现者自述。R5本轮未运行；不扩展为main/完整消费者闭环通过，不转借给Q7，签收勾选保留。 |

R3剩余四条：`soft_deleted_card_is_hidden_from_agent_crud_and_fsrs`、`soft_deleted_document_task_is_hidden_and_cannot_be_recovered_or_mutated`、`chatanki_versioned_delete_cas_cleans_fsrs_without_cleanup_trigger_and_conflict_preserves_it`、`agent_library_delete_conflicts_when_user_rates_after_preflight`；候选测试行135/188/253/484，TESTMAP行56/57/73/92均仍ported。需替换真实业务或先pending；R5没有越权改TESTMAP。

**运行证据边界**：C1指令未附150用例运行的完整命令原文/flags，本报告不构造命令文本或stdout中的“Errors 0”；准确记录为“review完整目录、150 passed、无Errors、捕获并返回code、exit0，来源C1原工具事件核验”。`git diff c07bd04d1 8d213a08f -- host/plugins/review`为空，能确认lane文件相同，不能证明所有依赖/集成环境相同。R5本轮测试未运行，退出码不适用；不重复旧全量证明未集成代码。

**规范落点**：D1/D4认可调用方传递同一SqlExecutor至所有者业务API，不能因此要求拆事务；D3内部精确整数/时间不能被早期“毫秒平台差异”笼统豁免；本轮未变更原事务/数值/错误/日志语义。quality§10要求真实测试与main消费证据，因此提供方、局部消费、整链及运行退出码分别记录。所有勾选未变，四lane整体不通过；跨平台/Windows/macOS/Electron未验证。

### 中断恢复检查（本审读工作树）

按恢复指令执行 `git log --oneline -20`、`git status`，确认起点仍为 `b2b138fe7`，只有本报告和review验收文件待提交；已写增量存活，无需重做。当前工作树review TESTMAP为126 ported/2 pending，四条镜像测试仍ported。随后只读检查：

```text
npm run migration:ledger -- --check --no-write
ledger: commands 1058 (A 91.5% B 7.7% C 0%), tests 8036 (A 75.7% B 0.4%); problems: commands 0, tests 21, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
exit 1
```

这是旧集成工作树的全仓ledger结果，不是候选 `8d213a08f` 的测试结果，21个测试问题也不全部归L15。本次未写ledger、未重跑Vitest。

## C1 05:49Z / 06:00Z：L24、L16新候选定向复核

### 范围、集成与作业纪律

审读起点 `b2394fbe4`；检查时main=`fa99dd561`。`2d627a513`（L24）、`ecccdc845`（L16）、先前L15 `8d213a08f`对HEAD/main的祖先检查均exit1。只读指定候选git对象，没有摘入实现、切换分支、运行旧代码或执行候选内存版本；不重复L15已完成的静态审查，其结论继续保留。

遵守架构师新规则：tsc/Vitest/build及其他重CPU工作须经 `node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- <命令>`，报告记录作业号与result退出码。本轮未集成且只需静态复核，**没有提交重任务，作业号/本轮测试命令/退出码均不适用**；没有以不运行测试为由捏造“通过”。后续进入运行基线时只验证新增必要单元，不重复全目录。

### L24 `2d627a513`

| 编号 | 真实候选路径/增量 | 判定与未闭合范围 |
|---|---|---|
| C1 | `index.ts:328,474`仅用anki；`tests/real-host-wiring.test.ts:29-50`安装真实Anki/review/L07/F7/chatanki | 旧名根因已修，真实插件启动测试设计认可；未main集成、未本轮运行，保留勾选。 |
| C2 | `index.ts:230-244`注册adaptContext→hydrate包装；`:267-299`转发L04顶层生命周期；`:326-457`补scheduler/快照/JSON/regex等 | raw注册绕过hydrate已修；真实registry对象被调用的测试有效，但完整模板CRUD、refs/planner、sessionResources等还未接。L16七面在另一候选已提供，不再称其完全不存在。 |
| C4 | Context nativeRegex→异步transform；NativeRegexDouble删除；原10仓储行退pending | 接线修复认可、pending纠偏不是回归。retemplate12/add2仍直接测CardStoreDouble且ported；新增regex适配丢前文边界（见下），不得整项签等价。 |
| C5 | 六个ChatAnki executor接统一begin；status经emitBlockError发anki_cards终态错误 | 以前独立mutation等完全缺start的描述已过时。新生命周期测试有效但块仓储为替身，实际L04整链未验；start/info顺序仍与Rust相反。 |
| C6 | 无manager时heuristic回退恢复，有manager但无planner显式失败 | 原合法fallback具体缺陷已修；Host还缺refs/planner装配，不能以直接executor测试证明资料引用规划完成。 |
| C7 | get_cards解包真实CommandError.value，NotFound→key，其他→完整output.error/errorCode文本 | 错误协议分流修复静态确认。真实review缺卡用例认可，但卡读取为替身；完整L16/CAS消费者链尚未验。 |
| C3 | review_stats/check_anki_connect新增 | run/start/wait/control/sync等仍缺，APKG export仍固定失败（`src/chatanki-executor.ts:416-418`）；保持开放。 |

**C4新具体偏差**：`src/transform.ts:487-525`先在完整文本findIter，再在每个match起点切片重新replace以展开捕获；合法输入 `afoo`、pattern=`\B(foo)`、replacement=`<$1>`，Rust对原文捕获输出 `a<foo>`，候选切成 `foo` 后 `\B`不匹配，拼回得到 `afoo`。这是源码静态推导，未执行候选；应使用原文同一次匹配的captures，不重匹配切片。Rust证据 `src-tauri/src/chat_v2/tools/chatanki_transform.rs:562-592`。

测试边界：`real-host-wiring.test.ts:101-153`的export/regex/get_cards虽使用真实sink/regex/review，卡仓储仍是CardStoreDouble；不能称完整L16所有权/CAS端到端。实际TESTMAP261 ported/25 pending，原10条pending在`:47-56`；尚ported的retemplate12在`:82-91,96-97`，add2在`:58-59`。不采信提供方335passed为本次测试结果。

### L16 `ecccdc845`

| 编号 | 真实候选路径/增量 | 判定与未闭合范围 |
|---|---|---|
| A1/A2 | `f00b1f8d2/871ff7045/00d643968`累积树删除generation-port；`plugin-handlers-generation.ts:40-54`构造AnkiGenerationService/StreamingAnkiService；真实llm+llmStreaming边界 | “只有端口替身、生成主体无生产调用”已不适用。`generation-service.ts:639-765,868-898`切卡、入库、事件、critic真实接通。测试只替模型传输的改进认可；路由省略/ready保障/Context regex问题仍在。 |
| A4 | `fdf1e7147`→命令await deleteDocumentSessionLifecycle，epoch→cancel→删库→清registry/tracker | 编排恢复认可；ID Set不是abort句柄，fallback仅重复cancelStreaming，无controller时仍no-op；未保证运行任务实际终止。 |
| A5 | `api.ts`/`src/service.ts`实际提供七嵌套服务；`chatanki-service-adapters.ts`/`repository/chatanki-surface.ts`真实SQLite与服务委托 | 真实提供面及测试操作确认，不再要求“从零补字段”。未main集成/未真实L24整链；新session delete仍写FSRS，A3不关闭。 |
| A6 | `anki-connect.ts:36-60`去掉while parsing与固定行1列1 | 数组错误局部修复认可；JSON语法错误改成V8 message不等于Rust reqwest/serde Display，精确错误仍未对齐。 |
| A3 | library listing改消费review快照 | 仅查询面局部改变；删除/导入及新session CAS仍写FSRS，`repository/chatanki-surface.ts:348-378`可见。L15已有所有者接口候选，“无排期接口”是过时阻塞，按D1保持同事务消费而非再复制SQL。 |

具体仍需修复（归入已有编号，不另扩张统计）：

- **A2路由**：`generation-service.ts:356-389`只旧单模型分支，`:931`的critic role decision固定null；Rust `streaming_anki_service.rs:952-990`存在Generator计划/降级路径。缺发布接口不能默许省略。
- **A1/A2校验顺序**：`enhanced-service.ts:864-876`先运行句柄再任务状态，Rust `enhanced_anki_service.rs:704-719`相反，Processing+运行句柄时具体Validation文案不同。
- **A4终止**：`enhanced-service.ts:153-162`仅Set+再次cancel，`streaming-anki.ts:886-897`无通道no-op、不remove；Rust `streaming_anki_service.rs:3470-3476`缺通道Err，删除侧再abort独立handle。新测试`:enhanced-anki-service.test.ts:303-345`没有真正进行中的任务，仅注入cancel抛错，不能证明终止。
- **A2 Context**：`plugin-handlers-generation.ts:18,45-51`仍具体import nativeRegex，profile覆盖未通过Context消费。
- **A6错误**：`anki-connect.ts:53-60,199-202`透传V8；`tests/anki-connect.test.ts:40-53`接受Unexpected token/not valid JSON/column子串，不是Rust `anki_connect_service.rs:458-471` response.json错误的精确断言。不能因位置不再伪造便签等价。

### 运行证据与完成状态

按C1交付与候选最后文档的时间界限记录：L16最后增强后只有**定向56/56、exit0**，后续全目录为**719断言通过但RPC errors/exit1**；更早719pass/exit0不能覆盖后续修改。未提供本轮可引用的完整原工具命令/flags、RPC数量，不伪造这些字段；它们不是R5本轮运行证据。L24提供方335passed也不转写为R5签收或真实全部消费者链通过。

只更新两份ACCEPTANCE与本汇总；未改实现/测试/TESTMAP、未运行Rust。所有原勾选保持不变，C3/A3与其他依赖未闭合，四lane整体仍不通过；L15上一轮R1具体修复/R6候选干净运行结论不回退，Q7继续开放。Windows/macOS/Electron及完整候选集成均未验证。

## L15后续纠偏：`83bca9a29` / `4ceacd86b`

审读HEAD=`f330c030a`，检查时main=`f37426009`；两候选尚未在HEAD/main集成（四次祖先检查exit1）。仅只读新增diff，无测试重跑、无实现摘取。

- **R3四镜像账本已纠偏**：候选 `host/plugins/review/TESTMAP.md:56,57,73,92` 为pending，表头及实际行一致为 **122 ported / 6 pending**。认可退回，不视为回归或业务已完成；旧章节126P/仍ported是旧快照，不作当前候选描述。
- **legacy-null新增断言已认可**：真实list/content命令现断言tags/images/extra_fields为空（候选 `tests/fsrs-cross-domain.test.ts:466-485`），入队断言保留。**原agent page仍未覆盖**（Rust `fsrs_review_service.rs:10142-10154`；TS`:486-487`只有待补注释），该行仍ported，完整移植仍不能签收。
- **提供方结果单列**：C1已取job **`20261104064103-da0785`**，**8 tests / exit0**；测试包含保留镜像，不计全部生产完成。这不是R5亲跑或本轮重取result，未提供的完整命令/Errors原文不伪造。R5本轮新作业号/测试退出码不适用。
- `l24-review-state-consumer.test.ts:1-3` 已声明替身边界，与上轮review→真实L24局部消费结论一致，不是完整L16/CAS证据。

R3与其余验收勾选不变，L15整体结论不变。L24 regex及L16 ready/abort/trigger/A6暂无修复提交，本轮不重复审；main集成、分支提供、临时组合/提供方测试继续分别记账，未新增跨平台验证。

## C1 07:19Z：L14 Q1–Q6候选与L24正常main消费增量

### 集成与范围

从 `dd4e93150` 正常合并main至 **`2f65ad2c6`**（main父提交`679fd3e4d`）。L24 `f3c967eb8/b0ba8b75b`已随main进入该运行基线；L14 **`21a99cc47`仍未集成**，只读git候选对象。未搭临时混合worktree、未摘实现；本轮只跑已正常集成的一个新增enqueue单元。L15、L16前轮审读结论保留，不重复审无新修复的旧问题。

### L14逐项结论（行号见qbank ACCEPTANCE最新章节）

| 编号 | 提交/真实调用增量 | 判定 |
|---|---|---|
| Q1 | `78b602870`等→`21a99cc47`，事务内requireMastery；提交后reviewPlan创建/推进/改判回流 | 原省略调用静态修复；reviewPlan已有L15候选provider，不再列无人提供。测试仍端口替身证明调用，完整qbank+L15+L11组合未验。 |
| Q2 | `33a4fa3dd`等，真实llmStreaming.singleShot与VFS取图已接 | 虚构gradePracticeSnapshot/图片必失败已移除；取消错误被丢、singleShot重试/回退改变策略、reasoning字节当字符等仍未等价。 |
| Q3 | `ec6adc071`，requestCancelStream→cancelGenerationSession→markCancelled及日志/旧快照 | 命令分支修复；token注册只有测试调用，没有生成runner登记，不签在途任务完整取消。 |
| Q4 | `945c9ca04`，逐项catch包含读取、业务update错误包装Database | 原两处分支静态修复，未跑未集成候选，不自动勾选。 |
| Q5 | `945c9ca04`结构比较+真实命令键序回归 | 键序误判修复；比较器把 `[]` / `{}` 或 `[1]` / `{"0":1}` 混同，合法JSON类型变化漏历史，仍开放。 |
| Q6 | `9b7f9fdf1`新增mastery-correction-contract原名两测试 | 真实review/mastery+生产迁移库；首判/链长1、纠正链长2、false→true→true及r1存活原断言已齐，不再仅merged旧缺断言。候选仍167P/74pending、76/88声明命令，整lane覆盖未闭合。 |
| Q7 | C1交付原结果：231 passed/Errors8/exit1；定向65 passed/Errors2/exit1 | 均非干净通过，不用数量当成功，不归因RPC为业务断言失败。R5未跑该候选。 |
| Q8 | L11/L15/L18具体服务面已有候选；qbank题目重复写仍在 | 按D1由qbank传同一SqlExecutor给各所有者，不等L11替其包整个mastery事务。直接sharp import也越F7边界（crop-source-image.ts:10、paper-docx.ts:9），C1已派回，未关闭。 |

本轮新增具体语义证据（均为 `21a99cc47` 静态审读，不是运行复现）：

- **Q2取消仍可判分**：`llm-completion.ts:107-123,138-140`丢弃complete(true,null)返回的取消Err，返回error:null；`llm-grader.ts:112-122`解析已有verdict即可成功，`practice-grading-queue.ts:161-190`按response.ok写正式成绩。Rust `qbank_grading/stream.rs:151-155`/`pipeline.rs:124-129,1289-1291`应传播取消失败。普通AI命令的cancelled分支不能保护practice路径。
- **Q2隐式策略不同**：singleShot默认2次重试、nonStream回退、total时限；Rust普通provider stream_grade单请求，HTTP错误直接终止，只有Codex特定refresh路径。`llm-completion.ts:129`还将UTF8 reasoningBytes写成reasoning_chars，中文长度不同。
- **21a99cc47错误解包范围**：本提交只补authoring-route的CommandError.value透传；practice配置失败的 `llm-grader.ts:30-35,92-96`仍未解包value，不把局部修复描述成所有批改错误已对齐。
- **Q5类型缺失**：`question-service.ts:137-148`没先排除Array/Object一方类型不一致，导致空数组/空对象被keys比较视为相同；原serde_json::Value区分两种类型。

### L24：已集成16条账本纠偏与实际enqueue验证

`f3c967eb8`实际退回 **retemplate11 + add2 + agent-review3 =16条**；加原10条已退项目，当前TESTMAP **245 ported / 41 pending**。认可纠偏而非回归；保留的retemplate UI/payload条不是CardStoreDouble仓储CAS证明。

新 `review-executor.ts:106-144`经真实L15入队，结果后加载新增卡并发fsrs://changed。`tests/real-review-enqueue.test.ts:36-128`在正常main基线安装真实native/anki/review/L07/chatanki及SQLite，断言首次写1条state和事件、二次skipped且无多余事件；卡预检仍由`:79-87`的CardStoreDouble提供，所以仅证明L24→L15主写入/事件，**不是完整L16 ownership/CAS或L04 registry端到端**。

新增CAS参数缺陷保留：`executor-args.ts:82-85`用Number.isSafeInteger拒绝 **2^53=9007199254740992**（此数本身可由double精确表示，且属于Rust合法i64）；`review-executor.test.ts:220-235`把拒绝锁成测试。Rust `ChatAnkiUndoLastReviewArgs/ChatAnkiSetSuspendedArgs` 的expected_review_version是i64，只做非负normalize（`chatanki_executor.rs:1178-1215`）。D3要求内部精确而wire不比Rust更严，不能用“CAS前更安全”把参数失败替代合法后续CAS/冲突结果。已由C1派回，本轮归C3未决，不重复运行该错误预期测试报绿。

### 本轮队列作业原始摘要与退出码

```text
job submit -- npx vitest run -c vitest.host.config.ts host/plugins/chatanki/tests/real-review-enqueue.test.ts --maxWorkers=1 --no-file-parallelism
作业 20261104073232-d72dbf
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    18.28s
[作业 20261104073232-d72dbf] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104073232-d72dbf.log
```

submit/result均通过 `node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs` 在本工作树执行。完整result没有Errors段/未处理错误，仅有WASI ExperimentalWarning。本轮不是提供方临时组合结果，亦未将该单测exit0外推所有工具。

中断恢复按指令执行git log/status及TESTMAP检查；本工作树表头review126P/2待、qbank137P/102待/2merged仍是较早状态，不覆盖已审候选计数。按架构师规则把只读ledger检查也入队：

```text
job submit -- npm run migration:ledger -- --check --no-write
作业 20261104074505-6d7cdf
ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 78% B 0.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104074505-6d7cdf] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074505-6d7cdf.log
```

ledger机械检查exit0不代表静态等价或所有B成立，不用于关闭本报告问题。所有验收勾选未变；仅改允许的验收与汇总文件。Q7/Q8、L24剩余C3/C4及其他未决保持；Windows/macOS/Electron未验证。

## C1 07:56轮：L16 `18c563a46` 独立静态复核

本轮HEAD=`1488f09fa`，检查时main=`0409f4c8f`；`18c563a46`/`0857832cf`/`d6ed4f24d`均不是HEAD/main祖先。L16已在候选分支合入真实L15，不等于main真实消费；未摘实现、未开混合工作树、未独立执行候选。L14 Q2/Q5已保存，完成的enqueue作业未重跑。

| 编号/提交 | 新证据 | 本轮结论 |
|---|---|---|
| A2/A4，`18c563a46`累积树 | Map运行句柄、spawn前独立AbortController、缺取消通道Err、runSignal检查及onReady回执；真实start/delete命令在配置gate期间删除 | 旧Set/no-op缺陷与配置成功返回后的继续LLM问题已修。配置await在abort后reject仍先handleTaskError，可能写失败/发错误事件；保留剩余分支，不整项签收。 |
| A2，路由/Context/trigger | Generator/Critic消费llmAnkiRouting，nativeRegex经ctx，trigger恢复先状态后运行句柄 | 认可这些原具体缺陷修复，不重复“固定null/具体regex import/错误顺序未修”旧描述。ready Promise未被生产等待，不凭变量名认定全部生命周期语义。 |
| A3/R4，`0857832cf` + `d6ed4f24d` | FsrsTransactionOwner=Pick<ReviewService,...>；tests/env默认真实review；删除/APKG同一tx传owner，生产fsrs_写SQL检索0 | 分支所有者消费及单事务边界已形成，不再称L15接口缺失或L16仍fallback写表。普通删除改成immediate与Rust默认deferred不同；全部失败矩阵及main集成仍未签收。 |
| A5/公开导入 | L24集成只从api.ts导入；新增真实卡/库操作面 | 私有L24导入描述对候选已过时。文件内仍有NativeRegexDouble，公开导入修复不等于所有算法测试都真实；完整L24消费者仍需集成证据。 |
| `b36cefb22`夹具 | library-query.snapshotJson改camelCase | Rust `fsrs_review_service.rs:857-883`确有serde(rename_all="camelCase")，修正符合原快照契约，不是弱化断言。 |
| A6，`ba8e7b1f1`→候选 | serde-json.ts语法扫描后JSON.parse，两条语法错误精确断言 | 只认可这两类语法文案进展；实际AnkiConnect typed解码/顺序/数值/UTF-8仍有差异，见下。 |

### A3/A4最小证据边界

- A3：候选 `anki/repository/anki-cards.ts:225-260` 删除同一tx先调用review cleanup再删卡/任务；`src/apkg-import-persist.ts:136-202`插task/card后同tx调用enqueueImportedCardsInTx，异常传播出事务，模板导入仍提交后。tests/env默认真实review；APKG真实历史/挂起入队见测试`:1719-1814`，缺owner后回滚`:1817-1835`，第二卡trigger故障全回滚`:1273-1295`。不是仅接口存在或fsrs-owner-double。
- 剩余锁模式：普通deleteCard/Task/Session显式immediate（`:233,245,260`），Rust `dstu-storage/src/database/mod.rs:6055,6072,6097`为默认deferred transaction。不得为单写者接缝改变原锁语义。
- A4：`generation-service.ts:531-544`配置成功后检查runSignal，真实命令用例`tests/anki-generation-commands.test.ts:656-695`验证删除配置等待后无singleShot；但`:539-541`配置reject分支在signal检查前执行handleTaskError，仍能产生删除/暂停后的错误副作用。Rust独立JoinHandle abort不会恢复执行该分支。现有gate仅resolve，未覆盖reject；已补正常路径认可，剩余分支仍需修。

### A6可达输入与Rust源码依据（仅静态推导）

Rust `anki_connect_service.rs:112-116`直接Deserialize响应struct；版本探测`:371-408`为text→from_str，牌组`:458-471`为response.json→再from_value<Vec<String>>。候选parseResponse统一全文扫描再JSON.parse和手写类型检查（`anki-connect.ts:54-76`）：

1. version响应 `{`：候选给语法错误加reqwest Decode前缀，Rust该路径from_str没有该层前缀。
2. deckNames `{"result":[],"error":1}`：候选typed错误在语法扫描之后抛出，缺reqwest包装/serde位置；`{"error":1,"result":[}`则候选先报后方syntax，Rust先遇error字段类型错，优先顺序不同。
3. `{"result":["A"],"result":["B"],"error":null}`：Rust派生struct拒绝重复result；候选JSON.parse最后值覆盖，返回B。
4. version `{"result":5.0,"error":null}`：Rust Value.as_u64不把float词法当整数，warn后放行；JS解析成5后Integer判断导致过旧错误。deckNames结果中的9007199254740993还会先被舍入，类型错误文案丢精确数字。dstu-anki显式启用serde_json arbitrary_precision，不能套用“超范围一律拒绝”默认假设。
5. 牌组响应result字符串含非法UTF-8字节FF：Rust response.json拒绝原始无效字节；候选response.text先替换成U+FFFD，扫描器重新Buffer.from已丢原始字节，可变成成功。合法UTF-8语法扫描用字节列是进展，但typed错误位置仍丢失；version原本走text，必须分路径审。

两条ASCII精确语法测试不能覆盖上述协议。整改限于原AnkiConnect响应与解码边界，不另造泛用JSON框架；A6仍开放。详细文件/行与其他边界见Anki验收最新章节。

### 本轮取回的提供方job结果（不是独立实跑）

```text
job result 20261104074154-acbb9c
Test Files  36 passed (36)
Tests       728 passed | 1 skipped (729)
Duration    153.62s
[作业 20261104074154-acbb9c] npx vitest run -c vitest.host.config.ts host/plugins/anki --pool=threads --maxWorkers=1 --hookTimeout=120000
[作业 20261104074154-acbb9c] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074154-acbb9c.log

job result 20261104074725-5481ad
[作业 20261104074725-5481ad] npx tsc -p tsconfig.host.json --noEmit --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104074725-5481ad] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074725-5481ad.log
```

通过 `node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs result` 读取既有作业。与C1一致，无Errors失败段，仅WASI警告，唯一skip为外部APKG环境未设置；不重复全728、不把这些结果记成R5候选实跑。所有验收勾选保持不变；main集成、分支组合、提供方运行分别记录，Windows/macOS/Electron未验证。

08:06Z收到后继L24 `034d6c6fc` 通知：其i64/regex边界/日志顺序是**新候选**，将只审新差异；旧afoo左边界缺陷不能继续作为最新候选描述。上一轮正常main基线与本轮L16单元不被该通知替换。

## C1 08:06Z后继L24：仅新增差异审读完成

L16单元已由检查点 `6918e2340` 保存；当前正常运行基线仍为先前main合并 `2f65ad2c6`。本轮检查时main=`3b2758d7a`，`034d6c6fc`非HEAD/main祖先（exit1），只读候选，不重搭临时组合、不重跑suite。

| 编号 | 候选 `034d6c6fc` 新差异 | 独立静态结论 |
|---|---|---|
| C3/i64子项 | `executor-args.ts:82-101,120-127`移除safeInteger阈值，BigInt校验Rust i64范围 | 原“拒绝2^53等合法i64”缺陷修复确认。大i64透传测试仍用ReviewBoundaryDouble，不能证明真实L16/CAS与内部精确版本链；BigInt(number)不会恢复前序JSON解析已丢的位。 |
| C5顺序子项 | `result.ts:9-14`改info后start，测试锁定info/start/end或error及start恰一次 | 对齐Rust `chatanki_executor.rs:1873-1883`。旧顺序颠倒描述不适用于该候选；完整L04消费者事件链未在此轮验证。 |
| C4左边界子项 | `transform.ts:512-524`捕获在完整原文replaceAll；新增真实引擎afoo/`\B(foo)`断言 | 旧切片反例已修，不再以“暂无修复提交”描述最新候选。 |
| C4分配闸门 | 同文件`:521-523`先物化replaceAll结果再算bytes；可选replaceAllProjected未提供limit且返回value | **未等价**：Rust captures_iter累计一超限即return（`chatanki_transform.rs:562-590`），`:592`才replace_all。F7公开api/生产无replaceAllProjected，不能以声明或最终throws证明分配前停止。 |

最小已支持输入：2048个`a`，pattern `(?s)(.)`，replacement为`$1`重复1024次。替换串2048字符在4096上限内，候选fallback先构造2MiB再因1MiB限额拒绝；Rust在累计首次超限时停止，未分配全结果。新 `security_capture_expansion_growth_is_rejected_by_full_text_result` 只检查最终拒绝，不能锁定原分配不变量，连error.bytes也可能变成最终总量而非首次超限量。该差异为静态审读，本轮未运行增长输入；建议仅补满足Rust原不变量的F7最小接缝，不加通用框架。

C1提供的local临时组合结果：尾号 `075253-b63b15` **8pass/exit0**、`075440-1e237f` **3pass/exit0**；本轮未重新取result、未独立实跑，不把缺失的完整命令/Errors行伪造进报告。两者只作候选提供方证据，非main及真实卡CAS签收。候选TESTMAP表头244P/42待，正常运行基线245P/41待分开记；勾选均未变。

### 本次中断恢复与只读ledger作业

执行了git log --oneline -20、git status、TESTMAP检查；确认L16文件在 `6918e2340`，工作区当时干净，没有重做已提交的L16工作。恢复要求的ledger经全局队列完成：

```text
作业 20261104085128-438781
npm run migration:ledger -- --check --no-write
ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 78% B 0.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104085128-438781] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104085128-438781.log
```

该机械检查针对当前工作树，不是未集成L24/L16候选的类型/行为验证。已完成的 `20261104073232-d72dbf` enqueue作业未重跑，card preflight仍double，不升级为完整CAS/所有权证据。L14 Q2/Q5发现保留，L16 A3/A4/A6剩余与新L24分配闸门问题仍未闭合；跨平台/Electron未验证。

## v2正常main复验与扩域（2026-11-04，`d414183bf`）

正常merge的main父提交为 `eeaf5bdc7`，审计父提交为 `8915421f6`；含Qbank `21a99cc47`、Chatanki `034d6c6fc`及后续修复。未cherry-pick候选、未建混合工作树。范围增加notes/memory；实现/测试/SPEC/TESTMAP/Rust均只读。

| 独立作业 | 命令/结果 |
|---|---|
| `20261104105733-20ca4e` | `npm run typecheck:host`，exit0 |
| `20261104105733-b3311b` | `npm run migration:boundaries`，2382 files、0 violation、178 suppressed，exit0 |
| `20261104105733-5c57be` | `npm run migration:ledger -- --check --no-write`，1058 commands、8036 tests；0 command/test/orphan problems，exit0 |
| `20261104105734-fb823a` | `npx vitest run -c vitest.host.config.ts host/plugins/qbank --maxWorkers=1 --no-file-parallelism`：37 files、241 pass/2 skip，无Errors/Unhandled，348.61s，exit0 |
| `20261104105734-f5cb83` | 同flags，目录`host/plugins/review host/plugins/anki host/plugins/chatanki`：86 files pass/2 skip，1200 pass/13 skip，Errors1（RPC onTaskUpdate timeout），539.77s，exit1 |
| `20261104110148-b24179` | 同flags，目录`host/plugins/notes`：26 files、218 pass，无Errors/Unhandled，209.66s，exit0 |

完整日志均为 `/home/dsdev/.oc-jobs/done/<作业ID>.log`，使用result真实退出码；没有tail管道掩盖失败。memory作业 `20261104110148-00f31c` 已提交，待结果，不重复提交。

### finding闭环

- **签收Q4/Q5/Q7**：逐项失败处理及Database包装、键序/Array-Object判别、独立干净全目录证据分别闭合。Qbank历史失败的mastery弱点用例本轮2791ms通过，reparse9条通过；未将历史失败归因为已证实的业务缺陷。两项F7图像skip仍是未完成功能，不以Q7签收掩盖。
- **Q1/Q2/Q6/Q8部分认可**：真实notes+vfs-repos+review+memory+qbank弱点回流通过；取消后verdict不再成为成功、CommandError解包及零重试已修；两个mastery纠正原名测试通过；大部分写入已转L11公开仓储，直接sharp已移除。未决：完整计划链、24h/非流式请求/推理字符数差异、74 pending、AI/hash/sync仍直接写questions。详见更新后的Qbank验收顶部。
- **签收C1旧服务名根因**：生产inject为anki，真实插件启动用例通过；独立三目录总作业仍exit1，不宣称整门禁通过。C3/C4左边界/C5顺序已进入main，认可具体修复；C4有界分配及C2/C3完整消费者链仍未闭合。F7公开面确认缺原语，Node/Electron各9pass仅为提供方正则语义证据。
- L16 `b81395fe7`/`6d0b01b7c` 检查时未在该基线；后续只审其新差异，不把旧候选反例套到未审的后继。

重启后核对log/status/TESTMAP与已完成ledger结果，Q4/Q5/Q7改动存活；未重复运行已完成测试。新增notes/memory报告继续按v2命令/真实性审读，结论单独保存。

### 新增L10 notes补审完成

报告 `host/plugins/notes/ACCEPTANCE.md`：18命令、16原名测试，结论不通过。新ID：**N1** state JSON/i64内部精度；**N2** VACUUM/全表扫描直接阻塞Host；**N3**硬删除/清空后缺Rust完整索引清理及其错误返回、事务/提交错误分支不同；**N4**fts测试测未接线同名副本，资源测试依赖自写L11替身；**N5**purge仍直接写resources/folder_items。每项附Rust/TS行号及生产路径。认可已落地sync无损精度、普通CAS/墓碑与事件、真实L11注入及218测试通过；不把这些证据扩展到未闭合分支。

Memory独立作业 `20261104110148-00f31c` 已取result：同Vitest串行flags，`host/plugins/memory`，**36 files、242 passed、521.05s、exit0，无Errors/Unhandled**；不是待运行，也没有重跑。完整日志同job目录。实际TESTMAP168行=109 ported+57 pending+2 obsolete（表头未列obsolete），正文审计继续。

### 新增L17 memory补审完成与新门禁基线

报告 `host/plugins/memory/ACCEPTANCE.md`：18命令、18原名测试，结论不通过。**M1**非隐私fact固定ADD、未调用已有检索/缺原决策分支；**M2**删除引用直接UPDATE notes并漏成功info；**M3**receipt零行提交不报lease_lost、原名ported测试把Rust应报错反写成not.toThrow；**M4**画像JSON整数词法及附加fingerprint宽容规则不等价；**M5**OpTimer被墙钟耗时替换；**M6**smart命令遗漏空输入校验并改变错误顺序。认可真实log/insight/mastery等provider、原子性SQL抛错回滚、242测试通过；M3说明为何全绿仍不能验收。两条query_rewriter obsolete审批已核对C1分片，未误报审批缺口。

收到新门禁通知（Anki streaming hook 10000ms超时及RPC onTaskUpdate超时）后，按要求正常merge main得到 **`add36c913`**，main父提交 **`4c6cd1ba8`**；之前复验单元 `2ebac4d0c` 与notes单元 `f50da498f` 均已保存。这次merge没有修改六个被审目录的实现/测试，但有上游LLM实现及机械门禁变化。新门禁依请求提交，不是为置信度循环重跑旧基线：

| 作业 | 命令 | 状态 |
|---|---|---|
| `20261104112238-3f2e59` | `npm run typecheck:host` | 已完成：tsc无诊断，exit0；完整日志 `/home/dsdev/.oc-jobs/done/20261104112238-3f2e59.log` |
| `20261104112238-4862ba` | `npm run migration:boundaries` | 已完成：2400 files，0 violation，177 suppressed，exit0；完整日志 `/home/dsdev/.oc-jobs/done/20261104112238-4862ba.log` |
| `20261104112238-eb7e77` | `npx vitest run -c vitest.host.config.ts host/plugins/qbank host/plugins/review host/plugins/anki host/plugins/chatanki host/plugins/notes host/plugins/memory --maxWorkers=1 --no-file-parallelism` | 已结束：exit128，SIGTERM（作业工具提示可能超时30分钟）；日志已有memory单条30秒超时，无最终Vitest汇总，详见下方结果补录 |

上一次三目录job的RPC error与本次通知的hook timeout分别记录；未据超时直接修改实现/测试或取消原始断言。复核人仍仅修改验收文档。

### L16后继候选增量复核完成

`b81395fe7`/`6d0b01b7c`对当前HEAD/main仍非祖先；报告更新到 `host/plugins/anki/ACCEPTANCE.md`，只审新增差异。**A3普通删除deferred、A4配置reject-after-abort确认已修**；候选测试实际走真实start/delete命令，provider作业36pass/exit0已取。A6原分路径前缀、字段顺序、重复字段、大整数/5.0、严格UTF8等子项确认改进，provider14pass/exit0已取，不套旧全文扫描器反例。

**A6剩余新反例**：`{"result":null,"error":null}`被候选解析成JsonNode null而非Option None，deck本应“AnkiConnect返回空结果”却报“解析牌组列表失败: invalid type: null, expected a sequence”；version日志None也变Some(Null)。另HTTP send成功后arrayBuffer读取失败被post helper归为请求/连接错误，Rust分别走body读取或response.json解码错误阶段。均为源码对照，未运行候选/Rust。

提供方真实result：`20261104085943-d7822b` tsc exit0、`20261104085943-f88dce` generation+db 36pass/exit0、`20261104090738-901599` tsc exit0、`20261104090738-ac233d` connect14pass/exit0，无Errors/Unhandled。命令包含`--pool=threads --maxWorkers=1 --hookTimeout=120000`，不能把它当当前默认10秒hook的门禁证据。不重复728条或enqueue，不改未集成候选的整项勾选。

L15最新main核对亦已落 `host/plugins/review/ACCEPTANCE.md`：null/scoped owner/四镜像纠偏候选均仍非HEAD/main祖先；main仍126P/2待，候选122P/6待不能混用，R1/R2/R3/R4不能签main。当前review-config仍有null缺陷，先前候选修复认可保持。新notes BLOCKERS已随main进入，其中B-Lance-delete/B-L11-note-writes与N3/N5吻合；无需复核人越权改其BLOCKERS或实现。

### C1 X6-SW-MEM-01后继交接已纳入独立复核

- notes `993781333`报告及`518e8db56`/`7d0c54701`代码/测试：静态确认tags-only WithConn保留调用方事务、不改updated_at/resource/CAS、不滤软删、缺id零行与原SQL错误。提供方job **20261104111047-2a076d：2files/61pass/exit0、无Errors/Unhandled**已取，命令为notes v2-boundaries+notes-repo两文件；不是R5独立消费者验证。正常main后按请求只做最小同tx回滚/错误边界，不复制全suite。
- M2覆盖扩展到已确认的同类直接写：evolution tags setter及insight投影的anki_cards/document_tasks。L16 `1598b1112`完整树有公开三方法、service委托和owner实现；按Rust逐语句autocommit语义不自开事务是正确的。提供方声明2pass/tsc尚未在本轮取result，不充作独立运行。tags provider上线不能关闭insight消费/N5资源所有权等其他范围。
- 新 **M7**：memory自写getNoteContent把“note存在但resource缺失”返回空，误读Rust旧注释；Rust实际warn+Database Err。已核对Rust `note_repo.rs:1012-1031`、memory `service.rs:962-974`及TS `repository/vfs.ts:334-347`。notes候选已提供正确读取语义，L17消费仍待闭合。
- `95d567a50`已修L15候选消费者旧anki键；检查时未main。不要求L16旧依赖树重复修一行或增加旧名兼容；真实Anki/CAS限制仍保留。
- 上述5个候选均非检查时HEAD/main祖先，未挑拣合并。六目录新门禁/typecheck/boundaries已使用job wait后台等待完成通知，未重复提交。

本轮已保存：`2ebac4d0c`复验签收、`f50da498f`notes补审、`0afcff082`memory补审、`b9dc79b37`L16后继差异。Review基线更新由协调者检查点`484b8ad13`保存，汇总说明在`a7ab22e2d`；不能把检查点造成的diff变小误认成文档丢失。

### 112238六目录作业最终状态补录

后台wait返回 **`20261104112238-eb7e77` exit128 / SIGTERM**；工具原文“可能超时30分钟”不是已经确认的终止原因。完整日志 `/home/dsdev/.oc-jobs/done/20261104112238-eb7e77.log` 未输出最终Test Files/Tests/Errors汇总，不能填Errors=0或统计为整套通过。

日志`:13-23`已记录 `host/plugins/memory/tests/l13-ports.test.ts` **12 tests / 1 failed**：`compress falls back to originals when the model fails or returns blank`，33589ms，`Test timed out in 30000ms`。这是本次明确的用例超时证据，未确定为业务断言缺陷。Anki `streaming-anki.test.ts`本次报告94通过/3702ms，qbank mastery弱点用例亦通过；局部通过不能抵消前述超时和作业被终止。

当前三门禁：typecheck exit0、boundaries exit0、六目录测试exit128未完成。保留此前三目录RPC Errors1/exit1及各独立目录旧基线结果，不覆盖历史。按C1收尾指令，仅补真实exit/错误；未重提作业、未改测试超时/断言，等待修复main或新明确反例。

### C1新增owner候选交接（仅静态核对，未新增作业）

- **L15 `dbf5cf87a`**：公开`MasteryService.recordInsightRecallVerdictWithConn`；完整候选树`src/mastery.ts:127-129`直接委托`repository/mastery.ts:103-112`，在传入conn执行INSERT OR IGNORE，使用caller now、确定性insight/session/outcome ID；没有自开事务、recompute或profile回流，SQL错误保留“写入 mastery 证据失败”包装。后续L17消费复验须保留这些语义，不能改用带重算/回流的通用recordEvent。检查时候选对HEAD/main均非祖先。
- **L15运行证据来源为C1亲取**：`20261104111818-7413d8` 10pass/exit0；`20261104113541-7ec1fd` review17files/170pass/exit0。R5未重取或重跑，不补造Errors原文。候选`tests/storage.ts`静态确认完整执行mistakes迁移后checkpoint、关闭模板连接，再给每例独立临时目录复制文件；未见各例共用可写数据库。此性能改动及提供方绿灯不替代R1–R6业务签收，不覆盖R5六目录SIGTERM结果。
- **L10 `45becd1db`**：该提交本身只更新BLOCKERS，完整树`api.ts:124-138,160`公开notes.leases authorized/checkWrite/now，`index.ts:147`装配真实noteLeaseRepository。`repository/leases.ts:253-302`通过原noteTransaction(savepoint)使用同conn授予/校验/回收grant并执行work；后续核真实L13消费与失败回滚，不以可选声明关闭N1–N5。检查时候选对HEAD/main均非祖先。
- **L14 V2-OWNER-QBANK examCascade**：C1通知api/index/repository候选已交L11；本条未给明确提交ID，登记为待正常main消费者差异复验，不声称已独立审读该实现或关闭Q8。

本次无新测试、无合并候选；既有112238三作业均已结束并如上记录。后续等待main修复或新明确反例，只做新增消费者所需最小验证。

### L17 c4后继与L10负CAS版本核对

按C1要求映射现有finding，未新增重复缺陷组：

- **M2**：`c4c736484/X6-SW-MEM-02`确实把learning fixture写入移到tests并保留聚合断言；生产tags/insight跨owner写仍不是这次移除对象，M2不关闭。
- **M5**：c4完整树已有performance.now/Math.trunc；`32f418558/L17-V2-03/04`记录该改动与extract分支/日志修复。独立静态认可原墙钟缺陷已修于候选。
- **M7**：缺资源读notes owner是在后继 **`cc0b61878/L17-V2-08`**（代码检查点e13a921c9/2105b5f0a），不在c4。真实notes+memory命令回归检验Missing resource错误；静态认可消费者改用owner，不签main。V2-02 tags/metadata结构修复不等于M4画像JSON已修。
- 上述三提交对检查时HEAD/main均非祖先；候选提交内自述16/13pass及tsc未在本轮取result，不充作独立证据。没有重跑六目录或合并候选。
- **N1精度认可收窄并交叉引用R4-SYNC-02**：当前notes sync.ts:158单边MAX_SAFE判断会把-9007199254740994+1转Number成-9007199254740992，Rust checked_add应为-9007199254740993。C1已亲核派修，R5静态核对一致。已有正大数/无损读取证据不能签整个sync域，也不能关闭state精度N1。L17画像merge owner出口已请求，L20原向量恢复归C2；未替他方实现或重复派单。

## §5工作流与自动续派：正常main已集成代码的复核

先前全部报告提交后，正常merge得到`9299fa83e`（main父`d84e29565`），按新§5启动统一`lane-gate.mjs`，后台shell `sh_1a675d0b8001b59YrdnMiYC88R`。启动输出为4项：typecheck、boundaries、importable、tests，经全局队列；尚无完成通知/自检记录，不能声称通过。本次自动续派第一步再次merge main得到`fabf9d048`（只更新gate-runner构建槽），相对9299fa的host/contracts/Vitest配置无变化，未重复提交仍在执行的自检。

本轮已做新的main源码核对，而非继续等候未集成候选：

- **R1**：null校验/17字段更新及真实Host回归现已main，`91c250fe5`为HEAD祖先。独立运行结果由现有自检提供，未另起重复用例。
- **R2/R4**：L15公开scoped/事务owner方法已main；L16当前仍直接写FSRS，消费者闭环不能仅凭提供方合入签收。
- **R3**：实际main已121 ported/7 pending，四镜像和legacy-null均退pending；真实library/content断言保留，agent page仍缺。撤销当前状态中“legacy-null仍ported”的旧描述，不关闭业务完整性。
- **M5**：性能报告提交虽未main，但源代码已通过前序检查点进入main，service.ts:1041/1106为performance.now/Math.trunc；按实际代码认可，独立结果待回。
- **M2/N3**：`518e8db56` tag-only和`526512c2c` F3 SqlExecutor prepare/finish均已HEAD/main；L17仍直接UPDATE notes tags，L10仍raw+BEGIN IMMEDIATE/旧提交错误包装，故只解除provider等待，不签消费者。`993781333`是未main报告，不能据它的祖先关系误判代码不可用。

独立复核职责继续按dispatch及v2 §3：不改被审实现/测试/SPEC/TESTMAP。本轮有待复验与已派回缺陷，不能写“无剩余工作”。先保存本次main状态差异，统一自检结果到达后补原exit/Errors并安排当前提交的§5收尾；已有作业不重复提交。

### 首次统一自检已返回：1/4项失败

自检记录 `/home/dsdev/dev/deep-student/.oc-runs/selfgate/R5-review-learning.json` 标记tip=`9299fa83e`、base=`d84e29565`、ok=false、failed=[tests]，完成时间2026-11-04T12:34:08.723Z。不把自动续派后的`fabf9d048`冒充该记录的被测tip。

| 作业 | 原命令/结果 |
|---|---|
| `20261104120822-fad06b` | `npx tsc -p tsconfig.host.json --incremental --tsBuildInfoFile .integration.tsbuildinfo`，exit0 |
| `20261104120821-c4ca34` | `env DSTU_BOUNDARY_STRICT= /opt/node26/bin/node scripts/electron-migration/boundaries.mjs`，2430 files/0 violation/167 suppressed，exit0 |
| `20261104120822-9f1cce` | `/opt/node26/bin/node scripts/electron-migration/importable.mjs`加anki/chatanki/memory/notes/qbank/review六个index.ts，`importable: ok`，exit0 |
| `20261104120822-dcf771` | `npx vitest run -c vitest.host.config.ts host/plugins/anki host/plugins/chatanki host/plugins/memory host/plugins/notes host/plugins/qbank host/plugins/review`，**1 file failed/192 passed/2 skipped；1874 passed/109 skipped；Errors4；1233.60s；exit1** |

完整日志为`/home/dsdev/.oc-jobs/done/<ID>.log`。测试失败为 `anki/tests/streaming-anki.test.ts:93` beforeAll构造createAnkiTestEnv时 **Hook timed out in 10000ms**；另外4个Unhandled Error均为Vitest worker `Timeout calling "onTaskUpdate"`。原命令没有串行worker或hookTimeout覆盖，本轮没有改写命令来绕过门禁。该结果有明确最终汇总，与上一轮SIGTERM无汇总不同，不互相替代。

**本轮窄范围签收R1与M5**：R1生产两层null语义对齐且本次Host回归`fsrs-commands.test.ts`报告6通过，其中17字段null用例4557ms通过；M5主路径已使用performance.now/Math.trunc，auto-extractor-service4条报告通过，时钟等价依据为源码。签收不抹去总作业失败及Errors，不外推R6/完整memory链；没有据提供方170pass代签。notes v2-boundaries29条报告通过，只认可owner接缝局部，L17仍未消费，M2不勾选。

剩余门禁阻塞已精确定位到Anki迁移宿主hook与Vitest RPC；复核人不通过修改测试超时、断言或实现来“修绿”。保存此次证据后按§5对当前提交自检，结果仍需保留原退出状态；未声明全部完成或无剩余工作。

### C1 L16 `1e9f3a999`后继交接静态核对

最新候选对HEAD/main仍非祖先；不混用报告/代码归属：AnkiCard测试`9de6ab07b`、严格decoder/入口包装`1e2356b29`；A6 null→None实现`3726cd69f`、阶段测试`bdc3861c8`、body延迟读取实现`997d629a8`；`1e9f3a999`本身是报告及120秒hook调整。

**A6原两残差已在候选修复**：null结果现在走Option None；post只读响应头，version text与deck json分别处理body读取失败，非2xx deck不读body。9条新增Host测试验证阶段/外层载荷，fetch/port为边界替身，真实undici/hyper底层source文案尚未完全复现；未签main整项。

X7三错类型的生产decoder修复按Rust String/bool/Vec/map/default/Option逐字段核对认可；直接decoder测试和invoke无副作用证据分开。原IPC契约此前已拦三错值，不把helper宽松缺陷混称全部IPC可panic。`95d567a50`已main，未重做旧键测试。

本轮只取提供方result，不重跑：`20261104114623-b34c09` **6files/80pass/exit0**；`20261104120323-27bc51` **4files/50pass/exit0**（新增文件9条包含在50内），均无Errors/Unhandled。详细命令/flags与局限写入Anki验收；120秒hook只证明预算调整，不替代业务签收。当前`4d2054c6f`的§5自检后台shell `sh_1a691f904001C137jct5SYLM2T`继续执行，没有重复提交。

### 4d2054c6f统一自检结果补录：仅RPC阻塞，仍exit1

后台自检已结束；记录tip=`4d2054c6f`、base=`45c3250b0`、ok=false、failed=[tests]，时间2026-11-04T12:53:17.072Z。对应四作业：

| 作业 | 原命令/结果 |
|---|---|
| `20261104123907-38b0eb` | `npx tsc -p tsconfig.host.json --incremental --tsBuildInfoFile .integration.tsbuildinfo`，exit0 |
| `20261104123907-6d684d` | `env DSTU_BOUNDARY_STRICT= /opt/node26/bin/node scripts/electron-migration/boundaries.mjs`，2430 files/0 violation/167 suppressed，exit0 |
| `20261104123907-cb4a73` | `/opt/node26/bin/node scripts/electron-migration/importable.mjs`加六个被审插件index.ts，exit0 |
| `20261104123907-c1d800` | `npx vitest run -c vitest.host.config.ts host/plugins/anki host/plugins/chatanki host/plugins/memory host/plugins/notes host/plugins/qbank host/plugins/review`，**193 files passed/2 skipped；1968 passed/15 skipped；Errors1；769.53s；exit1** |

完整日志 `/home/dsdev/.oc-jobs/done/<ID>.log`。唯一Unhandled Error为`[vitest-worker]: Timeout calling "onTaskUpdate"`；没有Failed Suites/失败断言。Anki streaming文件本次94条通过/4889ms，R1 null回归812ms通过，memory auto-extractor-service4条通过；未修改测试或集成120秒hook候选，不能把这次hook未超时解释为该候选已生效或根因已修。R1/M5窄范围签收保持，R6及整体自检仍未通过。

本次仅补实际exit/Errors与历史差别；不覆盖上一轮hook失败/Errors4，不把候选提供方绿灯移到main。没有因结果回报再提交相同六目录作业，也没有声称当前报告增量提交获得该tip的通过记录。

## 自动续派正常main：Q1真实消费者补证

按续派先merge main得到 **`8318071b1`**（main父`44b66353c`），本次仅fulltest/dispatch脚本变化；按明确§5指令启动统一lane-gate后台shell **`sh_1a6a49440001kVRLrr7Oqmscwr`**，结果待通知。本次未改门禁flags或被审实现/测试。

排队期间推进原Q1未决证据：reviewPlan提供方已在main，原Qbank调用用例仍为替身；故新增两次**不同场景**的最小Node生产入口探针，而非重复全suite或旧用例。两者均安装真实notes/vfs-repos/review/memory/qbank及生产storage/paths/settings/log，在/tmp/opencode隔离临时库运行真实迁移，经Host命令调用。

- **`20261104130347-5e7bf4`，4场景组通过/exit0**：错答建计划、到期答对推进/未到期不推进、mastery不重复；改判为错创建计划且不重复submission；真实mastery SQL故障回滚question/submission/event；计划SQL故障不撤销已提交答题/mastery。
- **`20261104130725-4cfab2`，2场景组通过/exit0**：客观题practice四种答题分支与同revision重放，计数保持3 submissions/3 mastery/1 history；第二题mastery故障回滚前题写入且保留draft、不产生attempt/计划。
- 原命令均`node --input-type=module -e <源码>`；完整argv/源码在`/home/dsdev/.oc-jobs/done/<ID>.json`，日志同名.log。没有创建仓库测试文件，临时数据finally清理；SQL只作fixture日期/故障注入，不是测试镜像。

Q1主学习链这些部分现在有独立真实消费者证据，已从验收顶部撤下“仍仅替身/完整计划主分支未验”的笼统描述。剩余只列缺provider静默跳过及未覆盖的主观题后台/人工批改组合，不因本次通过关闭整个Q1/Q2/Q8。统一自检结果仍待回，不提前宣称全绿。

## 8318071b1自检结果与报告范围纠偏

自检记录tip=`8318071b1`、base=`44b66353c`、ok=false，完成时间2026-11-04T13:13:06.365Z。typecheck `20261104125926-05ae60`、boundaries `20261104125926-af4c3d`、importable `20261104125926-1ad699`均exit0。测试`20261104125926-6d8771`原命令为六目录Vitest（与前次相同）：**193 files passed/2 skipped，1968 passed/15 skipped，Errors2，815.60s，exit1**；两条Unhandled Error均为RPC onTaskUpdate超时，没有Failed Suites，Anki streaming94条通过/6765ms。完整日志位于`/home/dsdev/.oc-jobs/done/<ID>.log`。Q1两个独立探针exit0不抵消该门禁失败。

收到“新增notes/memory ACCEPTANCE路径超出范围”的拒绝后，按最新门禁约束将两份补审正文完整归并如下。此前指向`host/plugins/notes/ACCEPTANCE.md`、`host/plugins/memory/ACCEPTANCE.md`的历史描述，现分别对应本报告的[notes补审](#notes-acceptance)和[memory补审](#memory-acceptance)。原独立文件快照仍可用`git show 835d03c18:<原路径>`追溯；本次只改变报告存放位置，不撤销补审覆盖或finding，不修改实现/测试/SPEC/TESTMAP/门禁配置。

以下正文保留原审读基线、计数和后继证据；“本目录”分别指原notes/memory插件目录，不能解释为本Markdown文件目录。较新main集成状态以本报告前面的逐次增量为准。

<a id="notes-acceptance"></a>
<!-- BEGIN R5 NOTES ACCEPTANCE PRESERVED -->
# L10-notes 独立验收（R5，2026-11-04）

结论：**不通过**。基线为正常main合并 `d414183bf`（main父提交`eeaf5bdc7`）。依据 `standard-v2.md` §1–2，审读18条命令、16条原名测试；只写验收文档，未改实现/测试/TESTMAP/SPEC，未运行或编译Rust。

## 必须修复

- [ ] **N1 / 高：state持久化JSON与revision仍经过Number。** `repository/state.ts:25-35,41-46,57-65`以number读revision，以`JSON.stringify`写value；`repository/json.ts:127`最终`JSON.parse`。Rust `crates/dstu-vfs/src/vfs/repos/note_state_repo.rs:43-64,79-88,153-166`为i64与serde_json::Value。既有持久化`{"n":9007199254740993}`读入即丢位；revision读数也未启用safeIntegers，不能保证内部CAS token精确。此为受支持的持久化结构，不能用缩小合法输入范围修复。`repository/sync.ts:7-28,73-87`已经用lossless JSON/safeIntegers，**认可sync修复，不能据此称state已修**。普通小revision的state测试通过不是D3证据。
  **精度认可范围补正（C1/R4-SYNC-02）**：上句只认可sync已有无损JSON/精确读取接线，不签sync全域。当前`repository/sync.ts:155-158`对relation revision+1后仅检查`<= MAX_SAFE_INTEGER`即转Number，遗漏负侧安全范围。local revision=-9007199254740994时，Rust `dstu-sync/.../note_history.rs:102-114`得到精确-9007199254740993，TS转Number为-9007199254740992，改变CAS值。C1已亲核并派修；R5本轮静态确认该分支，没有新运行或重复派单，沿用R4-SYNC-02交叉引用，N1仍开放。
- [ ] **N2 / 高：耗时同步IO仍直接阻塞Host。** `index.ts:644-645`直接调用 `src/note-commands.ts:227-234` 的同步`conn.exec('VACUUM')`。Rust `src/cmd/notes.rs:3021-3036`明确放入spawn_blocking。此路径没有worker/异步存储调度；实际数据库压缩期间Host不能处理其他事件。`notes_list_tags`亦在Rust`:3050-3056`明确卸载全表扫描，TS `index.ts:270-271`→`note-commands.ts:139-143`同步执行。按v2 §1.7整改原有重任务，不需引入通用框架。
- [ ] **N3 / 高：硬删除/清空回收站缺少提交后的完整索引清理与失败返回。** Rust `src/cmd/notes.rs:1567-1584,1759-1775`在删除提交后调用`delete_resource_index_full`，收集错误并返回“笔记已硬删除/回收站已清空，但部分检索索引清理失败”。TS `index.ts:539-545`直接返回 `src/trash-commands.ts:87-145,148-203`，完成文件删除后就成功，没有该调用/错误分支。`repository/notes.ts:174-175,829`确实经L11清理SQLite索引并登记orphan队列，**不是完全没清索引**，但队列不等于Rust等待Lance完整清理及错误可见性。另事务`:113,130,168,187`为BEGIN IMMEDIATE/COMMIT，Rust`:1515-1550,1730-1740`为SAVEPOINT/RELEASE；COMMIT错误被TS包装成“硬删除笔记失败”，原为“提交笔记硬删除事务失败”。需保留同事务purge+prepared intent及提交后finish顺序，恢复这些缺失语义。
- [ ] **N4 / 高：TESTMAP的真实性仍有一条不可达副本与跨所有者替身证据。** `tests/markdown.test.ts:74-78`测试`src/markdown.ts:81`的`buildNotesFtsMatchQuery`；全插件检索只有定义和测试引用，真实高级列表用`repository/notes-manager.ts:53,77`另一个同名实现。这条ported不符合生产可达规则。`tests/notes-repo.test.ts:11,26`装配 `tests/test-vfs-repos.ts:15-110`，后者自行实现resources/index/folder SQL；下表资源变更测试确实调用真实note仓储，但其“资源变化/回收”的跨所有者部分测的是替身，不是L11。应测试真实生产实现；不能把整张135ported账本当作生产整链验证。
- [ ] **N5 / 高：notes仍直接写L11拥有的resources/folder_items。** `repository/notes.ts:810-847`的purge分支直接DELETE folder_items及resources；读取资源与经embeddingUnits清理索引后仍在`:830`自行删资源。`index.ts:100-107`明示L11是资源/索引owner并注入公开仓储，现状仍越过它。Rust `note_repo.rs`原同仓储SQL可直接执行，迁移后的表owner划分要求经L11公开同连接方法，不能仅按Rust文件归属复制SQL。N3是命令副作用缺失，N5是所有权，分别验收。

## 命令抽查（18条）

Rust根为`src-tauri/`，下表R指`src/cmd/notes.rs`；TS根为本目录。每行列出实际分支/数据/副作用核对，所称“对齐”只针对列出的部分；N1–N5及未抽查路径阻止整命令签收。公共错误映射见 `repository/errors.ts:53-81,89-147`，与R`:300-324`区分Conflict/Invalid/Database。未做跨平台或Rust运行差分。

| 命令 | Rust入口 → TS入口/实现 | 分支、边界、错误/所有权/运行结论 |
|---|---|---|
| notes_state_get | R697 → index194 / state39 | 校验UTF8 key、note存在，缺行null，墓碑可读；state owner正确；N1 |
| notes_state_list | R704 → index196 / state44 | include_deleted默认false、按key排序；N1；类型来自IPC契约，不以TS类型断言证明serde全等 |
| notes_state_put | R711 → index198 / state49,57 | create-only/expected revision CAS、变化数1、提交后state-changed；N1 |
| notes_state_delete | R721 → index204 / state52 | expected必填、value=null、tombstone、提交后事件；N1 |
| notes_create | R1207 → index211 / note-commands20 | title/content_md/tags映射、tags默认空、NoteItem输出；真实note仓储，资源依赖为L11；错误前缀已映射 |
| notes_get | R1328 → index214 / note-commands34 | 缺失或已软删→NotFound，读取失败保留VFS前缀；普通分支对齐 |
| notes_update | R1246 → index217 / note-commands42,66 | capabilities或lease选择授权写；普通路径OCC映射Conflict；内容未传时回读并保留独立错误前缀 |
| notes_set_favorite | R1311 → index230 / note-commands80 | 先写favorite再读NoteItem，写/读错误分别包装；未把读失败包装为设置失败 |
| notes_delete | R1343 → index233 / note-commands94 | 软删含folder item，成功true；owner边界需结合N5整仓储整改 |
| notes_restore | R1837 → index236 / note-commands101 | 恢复成功true、VFS恢复前缀；没有无故新增成功事件 |
| notes_list | R1111 → index239 / note-commands108 | 默认200/0，subject忽略，NoteItem列表；Rustspawn_blocking，TS同步执行，重IO问题见N2 |
| notes_list_meta | R1129 → index242 / notes-manager | 不载正文的元数据列表，接真实仓储；有noteStorage错误映射，未把列表成功当完整serde证明 |
| notes_list_deleted | R1783 → index267 / note-commands113 | 默认page0/size20，查询失败前缀；count失败回退items.length，与Rust一致；TS额外warn不冒充原有日志映射 |
| notes_list_tags | R3041 → index270 / note-commands139 | 上限50与错误前缀正确；N2阻塞 |
| notes_search | R3130 → index273 / note-commands147 | 空白返回[]，limit夹1..200、默认50，tag:/正文分支及不同错误前缀保留，输出id/title/snippet |
| notes_hard_delete | R1463 → index539 / trash-commands87 | governance guard接入，缺note=false；purge与prepared同事务，finish在提交后；N3/N5 |
| notes_empty_trash | R1596 → index543 / trash-commands148 | 删除前收集ids/资产，返回删除数；N3/N5 |
| notes_db_vacuum | R3021 → index644 / note-commands227 | 成功true、SQL错误Database正确；N2，缺worker |

## TESTMAP真实性抽查（16条）

实际135行/135 ported；未改去向。M=`crates/dstu-notes/src/notes_manager.rs`，V=`crates/dstu-vfs/src/vfs/repos/note_repo.rs`；TS `markdown.test.ts`简称md，`notes-repo.test.ts`简称repo。表内断言数量按每个输入实际断言计，整体对象断言可覆盖多个Rustassert，不为计数制造重复expect。

| Rust原名与行 | TS位置 | 逐断言对照及生产可达性 |
|---|---|---|
| test_get_heading_level M2104 | md9-14 | 9个标题/空串/非法级别输入全部对应；getHeadingLevel→section解析→canvas命令可达 |
| test_extract_section_content M2126 | md16-32 | 12项：存在性、嵌套、排除后段、不存在、忽略大小写齐全；canvasRead可达 |
| test_extract_section_content_without_hash M2176 | md34-37 | 非空、正文包含两项齐全；同上 |
| test_append_to_section M2195 | md39-45 | 非空、前后顺序、保留原正文5项齐全；canvasAppend可达 |
| test_append_to_last_section M2228 | md47-52 | 非空、原文/追加文、顺序4项齐全 |
| test_extract_section_ignores_headings_inside_code_fence M2249 | md54-61 | 非空、echo/tail、排除other、围栏内标题不可查5项齐全 |
| test_extract_section_with_atx_closing_hashes M2275 | md63-66 | Closed/C#两项精确正文齐全 |
| test_section_query_level_must_match_when_specified M2287 | md68-72 | 错级别不命中、正确/无级别命中3项齐全 |
| test_build_notes_fts_match_query M2297 | md74-78 | 4个输入值断言齐全，但测未接线副本，**N4不通过** |
| test_regex_replace M2313 | md80-92 | 原2项次数/全文齐全，并加非法pattern错误；真实F7 regex→canvas replace生产函数 |
| test_string_replace M2325 | md111-115 | 2项次数/全文齐全，调用生产replaceContent |
| test_create_note V3141 | repo85-92 | id非空/title/tags/favorite四项齐全；生产notes仓储，资源由替身创建，跨owner部分受N4限制 |
| test_get_note_content V3161 | repo95-99 | 正文精确相等；note读取真实，resource建库部分替身 |
| test_update_note_changes_resource_on_content_change V3182 | repo102-113 | resource变化/title/tags/正文四项齐全；资源变化由替身提供，N4 |
| test_update_note_keeps_resource_when_content_unchanged V3223 | repo116-123 | 同resource/title/原正文三项齐全；同上 |
| test_soft_delete_and_restore V3263 | repo126-134 | 软删不可读、含删可读、恢复deletedAt=null齐全；真实note仓储，仍非完整真实L11组合 |

生产链：`index.ts:194-209,495-507`→state/canvas；`src/canvas-commands.ts:12,30,48`→markdown；`index.ts:100-107,140-149`注入真实L11并发布notes仓储。被测大部分符号生产可达，明确排除fts副本；不因使用真实SQLite就把替身资源仓储视为真实owner。`tests/agent-tools-registration.test.ts`确实经插件注册，运行通过；L04完整聊天消费者未在此审查证明。

## 独立运行与已认可部分

- 作业 **20261104110148-b24179**：`npx vitest run -c vitest.host.config.ts host/plugins/notes --maxWorkers=1 --no-file-parallelism`；**26 files、218 passed、209.66s、exit0，无Errors/Unhandled**。日志 `/home/dsdev/.oc-jobs/done/20261104110148-b24179.log`。
- 同基线typecheck `20261104105733-20ca4e`、boundaries `20261104105733-b3311b`、只读ledger `20261104105733-5c57be`均exit0。测试成功证明该入口可导入/运行，不抵消上述静态缺失分支。
- state普通CAS、墓碑防ABA及提交后事件已有生产入口测试；历史/lease/sync套件均通过。sync无损JSON与精确读取接线认可，负CAS残差见N1/R4-SYNC-02，不签全域精度。日志有真实 `configureNotesLogger` 接线；未沿用“notes缺provider”的旧印象。
- N1/N2/N3/N5为源码对照结论，未注入或运行新的反例；N4为原测试断言与调用图审计。未声明已经完成全部135条真实性审查、全部命令或Windows/macOS/Electron验收。

## X6-SW-MEM-01 提供方候选复核

C1交付`993781333`为报告，实际代码`518e8db56`、测试`7d0c54701`；对检查时HEAD/main均非祖先。静态确认 `api.ts:72-80`发布可选`rewriteTagsWithoutTouchingUpdatedAtWithConn`，生产`repository/notes.ts:371-373`只在调用者conn执行UPDATE tags，无自开事务、updated_at/resource/CAS变更、deleted_at过滤或missing-id拒绝。与Rust memory `service.rs:3518-3521`一致，满足L17需要的窄接缝。

提供方job `20261104111047-2a076d`已取result：`npx vitest run -c vitest.host.config.ts host/plugins/notes/tests/v2-boundaries.test.ts host/plugins/notes/tests/notes-repo.test.ts`，**2 files/61pass/exit0，无Errors/Unhandled**。`v2-boundaries.test.ts:133-176`经真实notes/L11服务验证调用方commit/rollback、软删行、未改其他字段、缺id及SQL错误传播。另缺资源测试核实warn+Err且不自愈；Rust `note_repo.rs:1012-1031`为准，而非文件旧注释。

认可提供方代码/测试设计，尚不是R5独立main或L17消费签收；正常main后只做所需的最小同tx/错误边界验证。此接缝解决memory写notes的owner能力，**不关闭N5中notes自己写resources/folder_items的问题**，也不关闭N1/N2/N3/N4。

### `45becd1db` lease owner交接

候选完整树`api.ts:124-138,160`发布notes.leases authorized/checkWrite/now，`index.ts:147`装配生产noteLeaseRepository；`repository/leases.ts:253-302`继续在caller conn的原savepoint内授予/校验/清理grant并执行work。该提交本身仅更新BLOCKERS，接口/实现来自前序树；检查时非HEAD/main。静态确认公开面已存在，真实L13消费与异常回滚待正常main最小复验；没有新测试作业，N1–N5均不因声明齐全而关闭。
<!-- END R5 NOTES ACCEPTANCE PRESERVED -->

<a id="memory-acceptance"></a>
<!-- BEGIN R5 MEMORY ACCEPTANCE PRESERVED -->
# L17-memory 独立验收（R5，2026-11-04）

结论：**不通过**。首次运行基线`d414183bf`，补审保存时按新门禁要求正常merge至`add36c913`（main父提交`4c6cd1ba8`）；此次merge未改memory实现/测试。依据v2 §1–2审读18条命令与18条TESTMAP原测试；未改实现、测试、SPEC、TESTMAP，未编译/运行Rust。

## 必须修复

- [ ] **M1 / 高：非隐私fact智能写入跳过真实搜索/决策，固定ADD。** `index.ts:229-239`→`src/service.ts:820-825`→`src/write-store.ts:355-360`无条件“没有相似记忆，直接新增”。Rust `crates/dstu-memory/src/memory/service.rs:1968-2148`先内部去重检索，区分检索失败、索引未就绪的auto-extract SKIPPED/显式待复核、熔断及LLM决策，随后按决策处理，不能全部替换成空结果。当前`src/search-store.ts:117-142`已经消费真实retrieval，注释“没有backend”不能作为运行时判断；即便LLM能力未齐，也不得无条件声称没有相似记忆。TESTMAP确实把决策7条/语义去重6条保留pending，认可诚实去向，但生产命令仍未完成。
- [ ] **M2 / 高：删除反向引用仍直接写notes表。** `repository/vfs.ts:495-515`的`removeIncomingRefs`直接UPDATE notes.tags，实际由`src/write-store.ts:145-163`的delete调用；违反notes单写者。Rust `service.rs:3491-3529`要求只改tags、不推进updated_at，不能改用会更新时间的普通update来“修”边界，应经notes公开同连接窄方法保留原语义。原Rust清理成功后的info（note_id、cleaned）在该TS调用链也缺失。其余create/update确已通过notes owner，不能称所有写入都复制。
  C1后继交付：notes `518e8db56`/`7d0c54701`已发布并测试tags-only WithConn候选，独立静态认可，尚非main且L17消费待复验。相同UPDATE还用于`repository/vfs.ts:314-319`→`src/evolution-cycle.ts:134`；消费者应分别保留原传播/吞错布尔语义。另`repository/insight-projection.ts:13-42,58-89`直接写Anki卡/任务，由生产`src/insight-worker.ts:95-96,279-282`调用；**单写者扩展子项M2/insight**对应Rust `dstu-research/src/insight/jobs.rs:651-729`。L16 `1598b1112`已发布owner候选，不能只修notes tags就关闭整个跨所有者写入范围。
- [ ] **M3 / 高：receipt失主提交被静默接受，ported测试把错误断言反转。** `repository/idempotency.ts:85-88`不检查UPDATE changes；`src/write-store.ts:285-292`事务中cacheResult后直接返回成功。Rust `service.rs:3105-3150`在0行更新时返回`memory.idempotency.lease_lost`，使调用方可回滚。公开`cacheFlushReceiptWithConn`（`src/service.ts:991-994`）也直接走此路径；独立renew方法不能替代commit点检查。**原名ported** `stale_idempotency_lease_is_reclaimed_and_fences_previous_owner`：Rust`:5062-5065`断言旧owner finalize报Conflict，TS `tests/service-occ.test.ts:108`却断言`cacheResult(first)` **not.toThrow**。这不是测试缺一个边缘场景，而是已有租约回收场景的原断言方向被改。原子性用例通过仅证明SQL抛错时回滚，不证明0行更新失败语义。
- [ ] **M4 / 中：画像JSON类型解码仍不等价。** `src/learner-profile.ts:435-478`先JSON.parse后Number.isInteger，接受`{"version":1.0}`/`{"version":1e0}`；Rust `learner_profile.rs:112-134,506-514`先Value再typed from_value，u32拒绝浮点number。另TS`:452`拒绝非string `_promotion_fingerprint`，Rust`:508-513`对该附加键只as_str，非string按None忽略；`{"_promotion_fingerprint":7}`在Rust可形成默认画像，在TS成为null。生产`src/profile-store.ts:87-95,136,226,299`读取保留画像note，拒绝/接受差异会改变读取及更新基线。Rust此处先Value，重复键最后值行为与JSON.parse一致，**不报虚假的typed重复字段问题**。需保持词法数值种类及既有宽容字段规则，不新增输入拒绝。
- [x] **M5 / main单调耗时修复签收。** `9299fa83e`→`fabf9d048`的`src/service.ts:1041,1106`已用performance.now起止并Math.trunc毫秒，匹配Rust `auto_extractor.rs:106,200`→`audit_log.rs:271-284`的Instant。独立job `20261104120822-dcf771`中真实服务auto-extractor文件4条通过；时钟选择等价结论来自源码对照，不声称测试模拟了墙钟回拨。报告提交c4/32f虽非祖先，更早代码已main。总job Errors4/exit1仍阻塞整门禁，不影响已定位的时钟修复事实；receipt TTL原墙钟用途不在此问题范围。
- [ ] **M6 / 高：memory_write_smart入口遗漏空title/content校验且错误顺序改变。** Rust `handlers.rs:774-783`先返回精确字符串“标题不能为空”/“内容不能为空”，再取service并解析类型。TS `index.ts:229-234`先parse类型再进store；store`:265-266`先rootId再带`Invalid argument 'title'`前缀拒绝空标题，`:307-309`把空内容作为成功NONE。因此有合法类型/已配置root时空content会成功，而Rust命令应报错；空title+非法type时错误优先级也不同。修命令边界，不改变Rust内部store允许NONE的独立语义。
- [ ] **M7 / 后继cc0b61878已改notes owner读取，待main复验。** 当前main `repository/vfs.ts:334-347`仍把note存在但resource缺失读成空；Rust `note_repo.rs:1012-1031`warn+Database Err并由memory `service.rs:974`传播。后继`cc0b61878`完整树新增readNoteContent直接委托notes.repository.getNoteContent，删除原JOIN空值降级，read/append/profile等调用已传deps；真实notes+memory命令回归验证缺resource报错。静态认可修复，候选非main；它对应L17-V2-08，不是另一组finding，也不误记为c4c736484内已修。

## 命令抽查（18条）

R=`src-tauri/crates/dstu-memory/src/memory/handlers.rs`；TS根为本目录。公共`commandResult/Async`在`index.ts:15-34`把VfsError字符串传播为CommandError，memory://changed经`:115-116`发送`source:user/action/entityIds`。每行仅认可列出行为；所有权/日志/取消等完整性受上述finding限制，未把服务方法调用等同全消费者验证。

| 命令 | Rust → TS入口/实现 | 已核对分支、数据与副作用 |
|---|---|---|
| memory_read | R250 → index126 / write-store63 | 不存在/不在root返回null，存在返回id/title/content/folder/updatedAt；缺资源分支M7 |
| memory_write | R277 → index128 / write-store73,106,112 | title/content同时空先拒绝，noteId有无、append/update/create分流；成功调索引维护后emit；具体append读取错误顺序未作全故障证明 |
| memory_list | R338 → index144 | limit默认100夹1..500、offset默认0；folderPath可空 |
| memory_get_tree | R354 → index147 | service.getTree结果直接返回，可空root；错误按字符串传播 |
| memory_add_relation | R365 → index149 / service615-644 | 双向_ref、同事务读取/OCC/owner更新；成功emit双ID；自关联校验存在 |
| memory_remove_relation | R383 → index155 / service647-678 | 两边tag变更、同连接事务及版本校验、成功emit；没有整批静默失败 |
| memory_get_related | R401 → index161 / service681 | root成员校验，_ref前缀过滤后返回ID数组 |
| memory_update_tags | R413 → index163 / write-store166-179 | 保留系统tags、用户输入不能写_前缀、expectedUpdatedAt；经notes更新，成功事件 |
| memory_get_tags | R467 → index169 / service688 | 校验root成员后返回完整tags，不自行过滤系统tag |
| memory_restore_stale | R431 → index171 / write-store184-192 | 无stale=false不emit；有标志删除stale/hit/injected，审计成功后true/emit |
| memory_restore_archived | R448 → index177 / write-store195-204 | 无archive=false；恢复移除archive/stale及时间tag，markPending best-effort、审计/emit |
| memory_batch_delete | R479 → index183 / write-store231-243 | 逐项计数，errors最多5，成功IDs发事件且不泄漏内部changedIds到返回；继承M2 |
| memory_batch_move | R523 → index194 / write-store246-258 | 部分成功计数/最多5错误，成功才emit；每项事务不升级整批事务 |
| memory_move_to_folder | R567 → index202 / write-store207-228 | root/path/版本校验，notes更新和folder移动共享事务，成功emit |
| memory_update_by_id | R585 → index208 / write-store112-143 | title/content皆null拒绝、按note类型字数上限、敏感值与保留名检查；notes owner更新/审计、索引维护/emit |
| memory_delete | R615 → index215 / write-store145-163 | 先主存储后索引，索引错误warn而不撤销删除、markDisabled；M2反向引用边界/日志缺口 |
| memory_write_smart | R762 → index229 / write-store261-360 | M1/M3/M6；隐私标题去重、空/过滤输出局部分支有实现，但不能覆盖命令校验和完整决策 |
| memory_write_batch | R816 → index241 / write-store430-472 | >200拒绝、空列表0计数、默认study、逐项类型/purpose及fact分流；返回剥离内部noteIds、成功发事件；fact继承M1/M3 |

## TESTMAP真实性抽查（18条）

实际168行：**109 ported / 57 pending / 2 obsolete**。两条query_rewriter的审批位于`migration/approvals.d/C1-app.json:48-49`，已核实，不再要求merged审批或误报缺批准。以下17个纯函数原测试断言成立；最后一条lease测试不成立。

A=`src-tauri/crates/dstu-memory/src/memory/auto_extractor.rs`，F=`.../compaction_flush.rs`，S=`.../service.rs`；TS a=`tests/auto-extractor.test.ts`、f=`tests/compaction-flush.test.ts`、o=`tests/service-occ.test.ts`。

| Rust原名/行 | TS | 原断言与实际对应 |
|---|---|---|
| test_extract_json_array A495 | a9-14 | 取带前缀数组并解析，len=1 |
| test_extract_json_array_empty A503 | a15-19 | []精确等价空数组 |
| test_parse_extraction_response_full_object_format A511 | a20-26 | facts1/title/activities全文3项齐全 |
| test_parse_extraction_response_full_legacy_array_format A520 | a27-32 | facts1与activities空两项齐全 |
| test_parse_extraction_response_full_garbage A529 | a33-35 | 一次精确对象断言同时涵盖原facts空、activities空 |
| test_values_to_activities_filters A537 | a36-39 | 空/空白/超长/敏感均过滤，保留有效活动 |
| test_values_to_candidates_filters_long_content A548 | a40-49 | 90字符过滤，len1/title=ok；另断言folder，未弱化 |
| test_sensitive_pattern_blocks_invisible_unicode A560 | a50-56 | 4类不可见字符true、正常中文换行emoji=false齐全 |
| test_sensitive_pattern_blocks_private_key_material A584 | a57-62 | 两种密钥体拦截，合法key/token偏好不拦截，4项齐全 |
| test_parse_flush_response_basic F345 | f9-16 | facts长度/title/folder及activities长度4项齐全 |
| test_parse_flush_response_with_noise_and_codeblock F355 | f17-22 | facts空、活动精确全文两项齐全 |
| test_parse_flush_response_empty_for_chitchat F363 | f23-25 | 生产isEmpty判据true |
| test_parse_flush_response_garbage_returns_empty F370 | f26-28 | 无JSON不抛错且isEmpty=true |
| test_parse_flush_response_filters_invalid_facts F377 | f29-43 | 缺标题/超长/敏感剔除，保留有效title、activity空三项齐全 |
| test_parse_flush_response_caps_counts F395 | f44-50 | 10条输入各截到生产facts/activities上限两项齐全 |
| test_extract_json_object_with_nested_braces_in_string F411 | f51-55 | 含字符串花括号的JSON可解析且有facts键 |
| test_truncate_head_tail F419 | f56-60 | Unicode字符长度≤limit+20且包含中段省略，两项齐全 |
| stale_idempotency_lease_is_reclaimed_and_fences_previous_owner S5016 | o92-111 | token不同、renew旧owner冲突、旧clear无害及新owner成功保留；**原finalize旧owner应Conflict被改为not.toThrow，M3不通过** |

生产可达：`index.ts:71`构造并由`src/service.ts:102-110`发布memory服务；`:1016-1027`→parseExtractionResponseFull，`:848-856`→parseFlushResponse；两者使用被测json提取/敏感过滤；自动写入`:1062`及flush`:891,930`进writeSmart。它们是已发布服务上的真实纯函数，**不是L03完整ledger/worker消费者接线证据**。receipt通过writeSmart及公开WithConn方法可达。决策/未接线工具相关57 pending不因全suite绿而改ported。

## 运行、provider和证据限制

- 独立作业`20261104110148-00f31c`：`npx vitest run -c vitest.host.config.ts host/plugins/memory --maxWorkers=1 --no-file-parallelism`，**36 files、242 passed、521.05s、exit0，无Errors/Unhandled**；日志`/home/dsdev/.oc-jobs/done/20261104110148-00f31c.log`。这是`d414183bf`运行结果；新main门禁另行排队，不混为同次结果。
- `index.ts:69,84-114`有真实log依赖、insight代理、masteryProfileSink、memoryRetrieval、hpiasResearch、memoryConfig和note-delete hook；真实F4启动/删除hook/弱点sink测试通过。**不报旧“缺log/insight provider”问题**。qbank真实弱点回流组合亦已独立通过。
- M3包含既有Rust/TS测试逐断言反例，M1/M2/M4/M5/M6为明确生产源码分支对照；未运行新Rust差分或声称已执行反例。M4只报告已定位结构，不泛称全部JSON解码不合格。
- 新基线`add36c913`依新门禁请求提交：typecheck `20261104112238-3f2e59`、boundaries `20261104112238-4862ba`、六目录Vitest `20261104112238-eb7e77`，待result；此前完成的旧基线结果保留。Windows/macOS/Electron未独立验证。

## C1 X6-SW-MEM-01 / insight owner候选增量

`993781333`只是notes交接说明，代码/测试在`518e8db56`/`7d0c54701`，三者及L16 `1598b1112`均非检查时HEAD/main祖先。独立审读确认：

- notes `api.ts:72-80`的`rewriteTagsWithoutTouchingUpdatedAtWithConn`为可选接口，生产`repository/notes.ts:371-373`实际执行单条传入conn的UPDATE tags。没有新开事务、updated_at/资源/CAS变更，没有deleted_at过滤，missing id不报错。这正是M2所需窄语义；不能用可选调用静默跳过写入，也不能在memory回落到自写SQL。
- `tests/v2-boundaries.test.ts:133-176`经真实notes服务及真实L11，验证调用者事务提交/回滚、软删行、版本/资源/历史不变、缺id及SQL trigger错误传播；该测试的其他Agent上下文替身不参与这条仓储接缝验证。
- 已取**提供方**job `20261104111047-2a076d`：`npx vitest run -c vitest.host.config.ts host/plugins/notes/tests/v2-boundaries.test.ts host/plugins/notes/tests/notes-repo.test.ts`，2 files/61 passed、17.83s、exit0，无Errors/Unhandled，目录L10-notes。它不是R5独立测试或L17消费者完成。
- L16 `1598b1112`的公开三方法为tombstone/upsert task/write card WithConn；完整候选树`src/service.ts:221-233`委托生产`repository/insight-projection.ts`，保留原原地更新/复活、不碰FSRS及历史的分支。Rust原始`:685-729`为逐语句autocommit，owner未自开事务是正确的，不能擅自要求为整投影新增原子事务。该提交说明的2pass/tsc仅作提供方自述，本轮未取其result。
- 正常main集成后，最小复验覆盖真实L17消费者调用owner、tags调用者事务回滚及传播/布尔错误边界；复用已有61条证据，不为此复制整套suite。M2/M7与N5其他资源/folder所有权问题分开验收，提供方可用不自动签消费者。

### 新main门禁结果补录

`20261104112238-eb7e77`六目录作业已被SIGTERM终止，**exit128**（工具提示可能30分钟超时，原因未确认），无最终Vitest汇总。完整日志`:13-23`记录本目录`tests/l13-ports.test.ts` 12 tests/1 failed：`compress falls back to originals when the model fails or returns blank`运行33589ms，报`Test timed out in 30000ms`。不能称本次memory全绿或Errors=0；也不把超时直接归为业务断言错误。之前独立memory242pass/exit0仍是`d414183bf`证据。新typecheck/boundaries均exit0；按C1指令不重跑六目录，仅保留结果并等待修复集成。

## C1后继版本核对：M2/M5/M7与自查ID映射

本轮只读指定候选及后继提交对象；`c4c736484`、`32f418558`、`cc0b61878`对HEAD/main祖先检查均exit1。没有新运行作业，原门禁结果不变。

| 提交/自查ID | 已核实的新差异 | 对原finding的结论 |
|---|---|---|
| c4c736484 / X6-SW-MEM-02 | 生产learning仓储删除fixture INSERT，迁至tests/fixtures/learning-rows；study秒数fixture改用L15方法，聚合断言保留 | 认可测试夹具分离；不是M2中实际tags/insight消费者越权写的修复，M2不因此关闭 |
| c4完整树、32f418558 / L17-V2-03/04 | extract用performance.now/Math.trunc；profile读取失败按ok().flatten；活动追加日志、无候选提前返回及不写extract审计恢复 | M5具体修复静态认可；分支对齐Rust auto_extractor.rs:106-132。新增活动-only测试断言日志、0写入、无extract审计/完成info，调用生产service，外部依赖仍用原support宿主 |
| 32f418558完整树 / L17-V2-02 | parseTags改整列string[]校验，混合数组不再部分过滤；资源metadata由typed对象传owner，删除JSON.parse-as | 认可所列结构修复；不等于M4的learner-profile数值词法/fingerprint规则已修，不另建同名缺陷组 |
| cc0b61878 / L17-V2-08（代码在e13a921c9/2105b5f0a） | readNoteContent通过notes owner；getNoteContent仅把null转空而保留错误；read/append/export/profile/evolution等调用已传deps | M7具体修复静态认可；`tests/note-content-owner.test.ts:24-63`装真实notes/vfs-repos/memory，经write/read命令删资源后验证错误。日志为替身且未断言warn载荷，完整main复验仍待 |

候选提交自述的fixture16pass、V2-02/03/04 16pass、V2-08 13pass及tsc，本轮未取result或独立运行，不当main绿灯。画像merge owner出口为C1已请求事项，L20原向量恢复由C2负责；当前没有给定合入证据，不签消费者精度链。
<!-- END R5 MEMORY ACCEPTANCE PRESERVED -->

## 范围纠偏后的新候选增量（C1正式交接）

报告归并提交`644d2ddf6`已验证：notes81行、memory102行与`835d03c18`原文件逐字一致，相对main仅剩原四份ACCEPTANCE和本总报告五条允许路径。删除的是本lane新增报告路径，未删除补审证据或他人实现。随后merge main无新变化，并已启动§5统一自检（shell `sh_1a6bcb5c3001wmv3dxhBRZx8Ug`）；不额外提交六目录测试。

下列候选在本轮检查时均非HEAD/main祖先：`7a6783fdb`、`2b7786b43`、`02982f3b3`、`690988159`、`e9e8997e3`、`7dd81f614`、`cc0b61878`、`d2c80ee3f`、`0ebe74d3a`/`8539479d5`。只读完整候选树及新增差异，不运行候选代码、不组合工作树。上方保全正文是历史快照，以下认可修复不改成main签收。

| 对应finding | 候选新差异与独立静态结论 | 后续签收边界 |
|---|---|---|
| N1 / R4-SYNC-02负CAS | `7a6783fdb:notes/repository/sync.ts:155-160`同时判断MIN_SAFE/MAX_SAFE后才转Number，负大i64保持bigint；原-9007199254740994+1反例已修。`v2-boundaries.test.ts:255-284`经真实notes.sync/SQLite/caller tx覆盖负侧邻值、i64 MIN+1、安全边界、MAX溢出及外层回滚 | 认可具体修复；正常main后用原负向向量最小复验，不以正大数测试替代 |
| N1 / state | `02982f3b3`完整树state查询均safeIntegers，revision双边安全区间外bigint；decodeValue语法检查后返回lossless DbJson，encodeValue用rawJSON保留bigint和JsonFloat.source；index的wireState只在命令/事件边界投影 | 原持久化/内部CAS丢位子项静态修复认可。新增真实owner测试涵盖2^53+1、负大JSON值、邻值CAS拒绝、1.0原文往返及删除；不把wire允许number当内部精度豁免 |
| N3 / SqlExecutor与事务前缀 | `2b7786b43`是报告，完整树trash-commands删除raw适配；withSavepoint在caller conn上SAVEPOINT/work/RELEASE，purge+prepare同conn、finish在RELEASE成功之后；work失败ROLLBACK TO+RELEASE，RELEASE失败保留Rust不回滚行为与“提交…事务失败”前缀 | `notes-extra-commands.test.ts:317-365`通过真实命令和purge/延迟FK故障验证原分支，静态认可。**完整Lance清理仍缺，N3不能整关**；不因新F3面存在而抹掉该范围 |
| M3 / receipt fencing | `690988159:repository/idempotency.ts:85-112`读取UPDATE changes，0行抛精确lease_lost；write-store事务内先renew再mutation/cache，抛错使note/receipt回滚。原service-occ的not.toThrow已改回lease_lost负断言，新增Host命令在插note后改owner token，验证0行receipt不留note/已完成receipt | 生产cacheResult缺陷静态确认已修；**新finalizeResult目前只有定义及tests/service-occ两处调用**，没有index/provide到它的生产调用。原名测试方向修复不等于该辅助函数生产可达，后续应由实际生产入口/函数承接原阴性断言；留在M3真实性子项，不新建重复finding |
| M6 / 命令前置检查 | `e9e8997e3:index.ts:229-237`先检查title/content，精确“标题不能为空”/“内容不能为空”，之后才parse类型/purpose并访问store；内部NONE分支保持。`commands-core.test.ts:211-223`包含空输入+非法type优先级及不落note断言 | 原顺序/前缀/空content成功问题静态修复认可，候选非main，待最小命令复验 |
| M2 / notes写与日志 | `7dd81f614:repository/vfs.ts`删除所有实际UPDATE notes，vfsDependencies要求公开tags-only方法且bind owner；removeIncomingRefs、recordSearchHits、evolution setter传同conn。删除/search的warn与evolution is_ok布尔边界保留，成功清理info恢复 | 真实notes+memory命令测试断言_ref移除、updated_at不变、info载荷；同tx失败边界仍需main消费者最小复验。**Anki insight等其他owner范围仍开放，不能整关M2** |
| M7 / 内容读取 | `cc0b61878`的owner委托及真实缺resource命令测试已在前轮逐分支认可，本轮仅核候选状态，未重审/重跑 | 仍非main，按原缺资源负向测试复验；不把notes provider绿灯代替consumer |
| M4关联 / R4-SYNC-05出口 | `d2c80ee3f`是报告；完整树api.ts:51-57公开原mergeProfileJsonForSync，未修改learner-profile实现。profile-sync-merge测试从api导入，覆盖v3/v4→v5保留双方目标及非画像返回null | 只认可owner出口与这组向量；**不修M4既有数值词法/fingerprint残差**，L20原向量恢复仍归C2 |

M3测试范围补充：`idempotency-atomicity.test.ts`走真实memory命令/仓储，但fixture为既有setupMemoryHost（外部notes/repos依赖仍替身）；因此它是memory事务回滚证据，不冒充已安装所有真实owner的整链测试。`git grep finalizeResult 690988159 -- host/plugins/memory`只找到repository定义及service-occ测试引用，生产cacheResult本身仍真实可达且已修，二者分别记录。

L16 `8539479d5`迁移模板：每测试进程完整迁移一次、storage.dispose后为每个env复制目录，仍跑真实runAll校验；每例独立临时目录，未见把各例状态改为共用可写库。C1交付`0ebe74d3a`自检绿仍是候选提供方证据；本轮未取其作业result、不补造Errors或命令。该性能改进和120秒hook预算不能替代A6/X7 serde或其他业务签收。

本轮新候选没有R5独立运行结果；提交说明中的47/50/31/20等通过计数均未转记为独立通过。M1/M4、N3完整Lance、M2其他所有者链保持；M5只保留已签的自动提取单调耗时范围，不外推其余时钟/运行时行为。待正常main集成后按原负向场景最小验证。

## 644d2ddf6自检结果及新图像失败定位

自检记录tip=`644d2ddf6`、base=`ad11a8394`，2026-11-04T13:34:06.697Z结束，ok=false/failed=[tests]。报告范围纠偏生效：测试命令只含原anki/chatanki/qbank/review四目录，没有重新提交notes/memory全suite。

| 作业 | 结果 |
|---|---|
| `20261104132547-8b443a` | host增量tsc，exit0 |
| `20261104132547-36a53a` | boundaries，exit0 |
| `20261104132547-73176f` | 四个index.ts原生导入，exit0 |
| `20261104132548-d523e6` | `npx vitest run -c vitest.host.config.ts host/plugins/anki host/plugins/chatanki host/plugins/qbank host/plugins/review`；**2files failed/130 passed/1 skipped，1 test failed/1399 passed/100 skipped，Errors1，430.36s，exit1** |

失败分开记录：Anki streaming beforeAll hook10000ms；Qbank DOCX图片用例Cannot decode paper image；Vitest RPC onTaskUpdate未处理错误1。完整日志均在`/home/dsdev/.oc-jobs/done/<ID>.log`，不以错误摘要漏项或局部通过覆盖结果。

**图片根因已由新增最小诊断定位**：`20261104133759-21ff1f`以`node -e <源码>`直接调用真实F7 decode/encode及Qbank接口，打印 `DECODE_OK 1 1 ff00007f` 后 **`ENCODE_FAILED Cannot find module 'pngjs'` / exit1**。同名.json保留完整argv；未编译Rust、未改fixture/实现/依赖。编码worker的pngjs依赖在package.json缺失，F7 NEEDS仍登记未批准；这不是坏PNG或已证实的Rust解码不兼容。Qbank catch把编码失败也统一映成Cannot decode，符合其原Option返回路径。该probe失败后没有执行DOCX断言，不计图像功能通过。

另发现Qbank crop测试fixture仅装qbank/vfsRepos，没有nativeImage，仍以“F7未main”skip；现在能力方法已main，跳过说明与真正装配条件不符。记入Q6真实性/Q8运行接缝增量；R5不自行装包或改测试，待owner修运行依赖/真实宿主装配后最小复验。

### C1性能/组织交付证据边界

C1新通知作为**协调者来源**记录，本轮未重新运行：L16 `440704227`仅hook120s且110pass，提供方曾在gate启动期间临时替换他方生成ledger，C1已禁止并交infra统一dirty规则，因此其selfgate ok不能证明全程冻结树；不据此撤销或升级业务候选结论。L17 `78ce6af79`拆两个慢Host用例保留断言、C1亲取13pass，不关闭M1/M4或M5之外的运行时事项。L24 `c492a4c19`纯职责拆分、提供方4files85pass，不签缺失executor或bounded regex。没有为这些交付重跑六目录。

### 新版基线判定自检结果补录（9b98bb27f）

自检tip=`9b98bb27f`、base=`16a254adf`，2026-11-04T13:52:52.225Z结束，ok=false/failed=[tests]。`20261104134536-ca1797` host tsc、`20261104134536-2cbb4c` boundaries、`20261104134536-a0d3a9`四入口importable均exit0。

测试job **`20261104134536-7f2544`**，原命令仍为`npx vitest run -c vitest.host.config.ts host/plugins/anki host/plugins/chatanki host/plugins/qbank host/plugins/review`，结果 **1 file failed/131 passed/1 skipped；1 test failed/1493 passed/6 skipped；Errors1；322.61s；exit1**。唯一失败用例仍是DOCX图片，完整日志另有一条RPC onTaskUpdate未处理超时；Anki streaming本次94通过/9530ms，没有hook失败。日志`/home/dsdev/.oc-jobs/done/20261104134536-7f2544.log`。

新版gate摘要将DOCX用例标记为“新增失败1项，main既有失败0项不计”，这是按加载的baseline记录判定，**不是证明该失败由R5文档改动引入**，也不表示原始Vitest无RPC错误。原始exit/Errors与gate判定分别保存。pngjs缺失已由`20261104133759-21ff1f`定位，本轮未重复诊断、装包或重新提交测试；等待运行依赖修复或明确新差异。

## C1候选增量：N4真实测试、N2 worker、L15原静默日志

本轮只读候选，`dfe0ffaa9`、`ada2cde47`、`0edd575cd`对检查时HEAD/main祖先检查均exit1；没有新测试、自检或六目录作业。补审继续写在允许的本总报告，不重建notes/memory ACCEPTANCE路径。

### N4：具体两项修复认可，其他替身不外推

`dfe0ffaa9`本身只删除`src/markdown.ts`未接线FTS副本；完整树的前序改动已将`tests/markdown.test.ts`的FTS测试导入改为真实`repository/notes-manager.ts`，四条Rust `notes_manager.rs:2297-2309`原断言未变。`tests/notes-repo.test.ts`移除createNotesTestRepos/configureNoteResourceRepos，安装真实paths/vfs-repos/notes，由notes apply注入owner；32条原用例主体断言未改。独立静态认可原N4这两个具体问题在候选已修。

其他测试仍引用test-vfs-repos（如state、note-history、exporter、notes-extra-commands等），不能把这一文件切换升级为全部135条真实owner覆盖；N3完整Lance、N5单写者也不因此关闭。N4提交自述44pass，本轮未取result或独立运行；C1转交的N2 45pass/类型0亦只作提供方证据。共享ledger dirty导致§5 exit2是前置条件未满足，不是该候选main签收。

### N2：确有线程迁移，运行/清理边界仍需收口

候选`ada2cde47:index.ts:108-148,318,692`实例化F3 worker pool，将两条命令交给`src/worker-tasks.ts`；任务仍调用生产listTags/vacuum，未复制业务SQL。F3 `worker-entry.ts:46-64`每任务打开自己的storage/db并在finally dispose，主线程句柄不跨线程。`v2-boundaries.test.ts:255-271`经Host命令检查返回值/tag排序，并断言main vfs句柄未执行VACUUM/note_tags查询。这些证据支持阻塞主线程缺陷的修复方向，不等于全部边界已等价。

| 边界 | 静态核对与剩余限制 |
|---|---|
| 公开入口 | 候选index及worker-tasks直接import `platform/storage/worker-pool.ts`，main `storage/api.ts`未发布createDatabaseWorkerPool。按C1交C2/F3核公开接缝，不擅自新增私有导入豁免或复制worker实现。 |
| 业务错误与日志 | worker将CommandError.value与收集的logs一起返回，主线程先按原level回放，再抛业务错误；worker线程/模块异常走Internal加原join前缀。finally清空worker logger。认可正常/业务Err路径映射，新增测试没有注入全部异常或日志回放失败，不能宣称已全验。 |
| **新增120秒时限** | 候选调用`workerPool.run(...,{database:'vfs'})`未指定timeout；其F3 `worker-pool.ts:334-343`默认120000ms，超时reject并kill worker。Rust `cmd/notes.rs:3021-3056`只有spawn_blocking.await，没有该总时限。长VACUUM/扫描会因此由可完成变成Internal超时，**不是仅把Rust JoinError翻译出来**；此为N2运行时剩余差异，需owner保持原时限范围。未为复现制造大库负载。 |
| 维护屏障 | notes-worker登记vfs，进入await pause，失败先resume再传播；退出resume。F3 pause先drain再terminate，resume在pausing未完成时延后放行。源码有维护协作，不是没有屏障；该新命令测试未验证与切槽并发。 |
| 卸载完成性 | effect disposer先unregister，再`void workerPool.close()`，不向卸载者返回/等待close Promise；F3 close在异步terminate完成后才清空slots。不能据“调用过close”声称host.dispose返回时线程/连接已全退出。F3对terminate拒绝已有catch，**不臆测必然出现未处理Promise拒绝**；保留完成性/生命周期验证限制。 |

N2仍为候选部分修复；主线程IO问题、公开边界、新时限及卸载完成性分别记清，未以45pass关闭整项。

### L15 X6-LP-0247：原静默必须保持

`0edd575cd:src/commands.ts:134-139,160-166`仍保留两条fsrs_get_due补偿失败warn。Rust `src/cmd/fsrs_review.rs:147-151`用matches!(revert,Ok(Some(_)))、`:157-165`用record(...).is_ok()，两处错误原本静默保留pending；候选不得以“更多信息”替代原行为。C1已派回，不新增重复派单。这里描述候选仍保留的差异，不误称两条都由0edd该diff首次加入。

该候选对fsrs_rate/undo原有日志的其它修复继续认可：Rust`:309,321,329,364,432,439`分别有commit后query失败、revert确认、pending debug、tagless确认及undo确认/debug专用文案，候选diff已逐调用点恢复。删除原静默分支的自增warn不能顺带删除这些Rust原日志。提供方18pass/11pass与类型/边界结果来自交付说明，本轮未独立运行，不以此签全域日志等价。

## C1新交接：X7 cloze trim与L10 R4-SYNC-s03

本轮只读核对，无新门禁/六目录作业；X7两个正式ID已加入Anki验收，未合并到原AnkiCard/A6问题，也不重复派单。

| 正式ID | 最小输入与独立静态核对 | 证据范围 |
|---|---|---|
| X7-L16-OCCLUSION-IMAGE-TRIM | 一个合法box（x/y=0、w/h=0.25、label='L'），imageRef为单个实际U+0085字符。TS `host/plugins/anki/src/image-occlusion.ts:41,67`的JS trim保留该字符，未给empty_image_ref；Rust `src-tauri/crates/dstu-anki/src/anki_image_occlusion.rs:219-224,350` trim后为空，应报该问题 | C1已派owner；R5核源码，未运行Rust |
| X7-L16-OCCLUSION-LABEL-TRIM | imageRef='a.png'，同一合法box的label为实际U+0085且未指定clozeIndex。TS`:69-70`保留该label，Rust`:328-336`补默认“区域 1” | 与imageRef为不同分支；不把146输入TS preflight计为C级差分 |

生产可达已核：`src/apkg-export-model.ts:413-418`和`src/anki-sync.ts:371-387`使用validateSpec/parseOcclusionField，另有draft marker入口；不是只存在于测试的函数。这里只指出上述合法字符串反例，不把它们扩展为所有IPC入参可panic。

**L10 `a38068281` / R4-SYNC-s03**：检查时对HEAD/main均非祖先。候选`repository/sync.ts:updateInferredFormat`改为caller conn直接执行不带deleted_at过滤的notes/resources JOIN，对齐Rust `dstu-sync/src/data_governance/sync/note_history.rs:279-286` remote_sync快照分支；缺行报Query returned no rows，data=null保留原列类型错误。普通notes.repository.getNoteContent实现未改，仍过滤软删，不能将同步快照的特例推广到普通读取。

新增`v2-boundaries.test.ts`用真实notes命令创建/软删，再在调用者事务内调用notes.sync.updateInferredFormat，断言仍能推断format、普通getNoteContent为null、缺id报错；静态认可这项窄修复设计。C1亲取提供方`20261104135650-bbd324` **52pass**，L20 gate **1356pass/唯一s03 fail**均按协调者来源记录，本轮未重取result、不补造缺失的Errors行或独立运行。待有权infra正常集成后按原s03场景最小复验；不关闭N3完整Lance、N5或其他未决项。

## P0：L15已main的D3拒绝与L24缩向量同根

本轮只读main（读取时tip **`306eb8bbb`**），确认其中`227d44de4`已落地。审计工作树HEAD尚未合该更新，不能把“本地旧代码没有helper”误报为main不存在问题。新增 **R7 / L15-V2-S4 / D3**，与L24 **C3/D3**交叉引用；C1已分别派owner，不重复派单、不运行已知错误期望测试。

1. **main输入门槛错误**：`review/src/review.ts:58-59`的isI64Version实际为Number.isSafeInteger且非负，`:481,544`用于scoped suspend/undo。Rust `fsrs_review_service.rs:2875-2882`接收i64，只在此分支拒负值。`2^63-1024`能以JS Number精确表示且在非负i64内，却被TS拒绝，违反D3。
2. **main读取门槛错误**：`review/repository/fsrs.ts:878,888-909`把local_version经CAST TEXT/BigInt精确读取后，仍对超±MAX_SAFE抛Database，再转换number；AgentStateRecord仍number。Rust`:821-825`内部review_version为i64，`:2903-2905,2920-2928`精确比较/绑定/递增。精确读取的进展认可，**拒绝合法整数不是舍入问题的等价解法**。SQLite非INTEGER拒绝可按Rust row.get<i64>保持，不要求放宽原非法值。
3. **L24候选迁就限制**：`342c61556`（检查时非HEAD/main）把review-executor-real-l15.test.ts LARGE从`2**63-1024`降为MAX_SAFE-1，并加库值2^53+1的范围Database拒绝断言；原成功路径version()仍number回读。需恢复原合法大token与精确SQL回读（safeIntegers或CAST TEXT），不能用改小的向量证明D3。新增负向用例expected=MAX_SAFE与库值2^53+1本来不匹配，Rust应Conflict；不误称其应成功，拒绝的具体原因/形状仍错。
4. L24参数层早先移除SafeInteger的子项修复继续认可；本次是L15 owner的新同类门槛及消费者测试弱化，不撤销已核修复，也不把provider自定范围当成新规范。D3 `decisions.md:118-120`要求内部精确、wire按原JSON，明确不得因精度拒请求。

### N4第二批真实L11迁移候选

`f5422b022`完整树相对`dfe0ffaa9`已将note-history、notes-app、canvas-execute、note-sync、notes-referencing、note-columns、canvas-executor、note-lease、note-history-integration九文件的资源fixture改为真实paths/vfs-repos/notes安装；逐hunk核对为imports/setup/teardown更改，原用例断言未弱化。该tip自身只含canvas-execute，其他变更在前序检查点，按完整树归属记录。另有v2-boundaries新增N2/s03用例，不能混称旧断言被删改。

检索该候选仍有8个.test.ts引用test-vfs-repos：agent-tools-registration、exporter、import-markdown、note-storage、notes-commands、notes-export-commands、notes-extra-commands、state。N4两批改进认可，剩余跨owner替身证据不自动关闭。C1亲取 **`20261104142159-31c68c`：27files/258pass/exit0** 按提供方证据记录；本轮未重取/重跑。N2 `ada2cde47`与上述N4候选均非HEAD/main，§5 dirty exit2仍未通过，258pass不能代签worker公开边界、120秒时限、卸载完成性或N4全部真实性。

### L16两个正式X7 trim项的修复候选

`5e05f9bc0`实际代码/测试、`4194d8827`报告已静态核对，两者仍非HEAD/main。F4 rustTrim包含NEL(U+0085)、排除BOM(U+FEFF)；候选imageRef判空/输出及label归一化已使用它，原empty_image_ref/“区域 1”反例确认修复。buildCardFields图片名/Extra、occlusionImageRefFromFields同步改到Rust对应trim位置，新9例检验NEL与BOM两向及真实AnkiConnect rebuild辅助函数。Anki验收两X7条目更新为“候选已修待main”，不新增重复ID、不外推其它trim或整条Anki链。

提供方证据来源为C1亲取：`20261104143330-c19e5e` **3files/62pass/exit0（含新9例）**；`20261104143547-0d045c` **785pass/1skip/exit0**。R5本轮未重取/重跑；146输入TS preflight仍非C级差分。质量拆分与旧导入路径保留不新增业务签收；本轮dirtyledger未动且未跑gate如实记录，不能冒充候选冻结树自检通过。R7/L15-V2-S4与C3/D3的JS安全范围回归及不匹配token应Conflict结论保持，无新diff不重复全套。

### C1 14:57 C3/R7增量：恢复向量不等于恢复测试保证

独立只读`c5c8ce42c`完整树（tip只改BLOCKERS，检查时非HEAD/main）：大i64向量恢复为2^63-1024、SQL bigint绑定、CAST TEXT回读、精确+1和stale不写断言均已恢复，旧“拒绝合法值符合预期”测试已删，认可这部分修复。

新增`skipOnL15PrecisionDefect`（测试`:36-46`）却按三类错误子串，在`:125,136,163`的三条正向路径success断言前runtime skip；这会使现有L15精度错误不再令这些保证失败，stale场景也到不了真正的stale调用。C1已要求现在移除helper/skip并保留失败blocked，不能等owner修复后再移除。R7/C3同根问题保持开放，L15入参/存储两点已在修，本轮不重复派实现、不跑候选。提交自述1pass/3skip/exit0不记作三条成功CAS。

C1亲取L04 job **`20261104144011-3bba37`：5fail/1467pass/2skip/Errors2/exit1**，本轮未重取。新增3条真实L15消费者路径的失败不能据所在测试lane统归L04源码；其余失败原因未给完整定位，不猜测，也不把结果转借为R5运行。

X6 fixed-main手工AP清单（14lane/267条原ID）仅是已分发候选线索，不自动新增缺陷或签收。L10 schema函数的Rust原调用也仅在测试中，已交architect裁定口径；不为凑生产可达指标制造调用，不在无审批时自行改obsolete/TESTMAP。本轮只更新允许报告，无新增作业。

## R7/C3/D3后继a0515bf75：候选修复与实际组合失败分层

`a0515bf75`检查时非HEAD/main。独立静态核对实现检查点`21b30f5ff`/`6a32027af`：owner快照/AgentStateRecord为bigint；四入口number|bigint立即归一BigInt，按0..i64MAX检查；读取取消MAX_SAFE拒绝，比较/SQL绑定保持精确，只有kernel.toWireJson最终转Number。两处原拒绝根因在候选已修，不能继续把它们描述为最新候选未修。MAX允许读取与幂等；真实递增溢出由SQLite转REAL后精确回读失败导致事务回滚，未收窄合法输入。

5个真实provider测试保留2^53+1、2^63-1024、i64MAX，检查邻值Conflict、暂停/撤销、精确SQL状态及溢出回滚；小版本断言0n/1n等是同Rust值的内部表示对齐，wire仍0/1，不是削弱断言。其它累计S1/S2差异不在此轮一并签收。

本轮已取两份**提供方**原result（无新执行）：

- **`20261104145637-b0a249`**：新provider5例、fsrs-review69例通过；但整个4文件job是**2fail/81pass/exit1**，旧0/0n断言导致cross-domain与l24小快照用例失败。后继6a32027af树已改这些断言，保留toWireJson数字断言。与交付“job中5/5”一致，不能误记整job全绿。
- **`20261104150540-a52cf7`**：旧execute+直接new FsrsReviewService注入的CAS文件**2pass/2fail/exit1**，不是新版ctx.get('review')公开provider链；undo大i64/越界拒绝通过，暂停成功和stale Conflict先成立，失败在99/125行内部bigint `9223372036854774785n`与number LARGE+1（显示9223372036854775000）的类型/精度差异。后续SQL number断言未执行，不计验证成功。正确oracle为BigInt(LARGE)+1n及SQL bigint/TEXT，wire再Number；不降原向量、不skip。

日志均在`/home/dsdev/.oc-jobs/done/<ID>.log`，无Errors/Unhandled段；第二份命令只跑该L24文件。该文件快照不是c5c8ce42c的skip版本，两个运行树不混同。L15报告的a0515bf75自检5/5/main879e0a56b是提供方说明，本轮未取其自检各项作业，未升级main签收。R7/C3仍开放至正常main消费者最小复验，L16预检Double限制不因owner精度修复解除。

### C1 15:13纠偏：撤skip已修，公开链输出保证仍缺

`48063`解析为 **`48063ba9b`**，检查时非HEAD/main。已核实删除skip helper、三类错误文本及三处调用，原大数与SQL bigint/TEXT/+1/stale不写保留；不沿用“新候选还在skip”的旧结论。但是该版本`:102-125`缺原`output.reviewState.reviewVersion`与`output.current.reviewVersion`的精确断言，须补`LARGE_SQL+1n`，SQL正确不能代替返回值精度。C1已派L24，不重复派实现。

上文a52cf7口径已修正：其运行树`:15-17,55-60,77`直接导入/实例化FsrsReviewService并注入旧executor上下文。虽然调用真实CAS代码，**并未验证新版公开provider hydrate链**。a0515与48063都未main；待正常集成后最小验证公开链、原范围、stale不写、输出快照和wire，不用旧组合失败或绿子集代签。

## L10最后N4替身批次、AP0356/0357与LP0228候选

检查时`cc7e49000`、`3102525cb`、`0b0ab1296`、`160dafb23`、`2f8cb0703`对HEAD/main均非祖先。本轮只读候选/原Rust及既有提供方作业元数据与日志摘要，无新运行。

### N4最后8文件的依赖装配

完整diff确认notes-commands/extra/export-commands、note-storage、state、agent-tools-registration改为真实paths/vfs-repos/notes；teardown先host.dispose再关库。exporter安装真实L11，以其公开WithConn方法消费各源/目标fixture的executor；import-markdown只做纯函数/文件清理，删除了未参与断言的替身全局配置。旧输入/断言主体未削弱。`3102525cb`删除test-vfs-repos.ts；检索TS代码仅余v2-boundaries说明注释中的旧名称，无导入/调用消费者。

认可最后一批已清掉这个L11 SQL替身，不能继续把“该候选仍有8文件引用”当现状；原报告中的8文件列表是f5422b022快照。仍未做全部原测试逐断言签收，也不因N4候选进展关闭N2 worker边界、N5所有权或N3完整Lance。

### AP0356/0357：恢复具体原断言

- `0b0ab1296:tests/notes-repo.test.ts:329-333`保留backlinks数量2，新增every(sourceId===source.id)，对应Rust `note_repo.rs:3814-3816`，修复只比数量遗漏来源身份。
- 同提交`tests/note-storage.test.ts:350-354`在原错误与notes/operations/folder_items三表回滚断言后，DROP fail_review_receipt，再以**同request/operation id** saveAs成功；对应Rust `note_review_tests.rs:100-124`。没有另造新operation来绕过残留receipt，原负向保证保留。
- 两项仍在真实owner装配上调用生产仓储。认可这两个缺断言的候选修复，不凭AP扫描计数声称全部测试一致。

### LP0228：开启、正文、RELEASE三类分支分别保留

实际代码/测试在`160dafb23`，`2f8cb0703`仅LANE。`notes.ts`的create/update在SAVEPOINT开启失败时记录error并包装Failed to create savepoint；正文失败才进入原rollback；正文成功后的RELEASE移到独立try/catch，失败记录对应savepoint名error并返回Failed to release savepoint，**不进入正文rollback**。对齐Rust `note_repo.rs:493-500,573-589,669-676,885-901`，不是把所有失败统一回滚。

新增v2-boundaries的create/update两例经真实kernel命令、SQLite延迟FK制造RELEASE失败，断言精确Database前缀与error日志、事务仍开放及未提交行可见；调用者显式ROLLBACK后恢复原数据，撤trigger后用原参数重试成功。认可该分支设计；开启失败日志本轮为源码对照，未宣称这两例覆盖所有LP日志/错误路径。N3另有硬删除/Lance范围，N5亦不随之关闭。

### 提供方原作业：执行数与标题筛选分开

已读取以下.done.json元数据（运行目录L10-notes）及日志摘要；均是提供方结果，不是R5独立复跑：

| 作业 | 实际命令范围 | 结果 |
|---|---|---|
| `20261104145218-d2da3e` | notes-commands/export-commands/extra-commands、note-storage、state、import-markdown、agent-tools-registration | 7files/56pass/exit0 |
| `20261104145351-8a66ff` | exporter.test.ts | 1file/17pass/exit0 |
| `20261104150053-788062` | notes-repo+note-storage，`-t 'test_create_note_maintains_links_in_repo_layer\|save_as_receipt_failure_rolls_back_copy_folder_history_and_identity'` | **2pass/44标题过滤skip/exit0**，不是46条全部执行 |
| `20261104150640-e055c4` | v2-boundaries+notes-repo+notes-commands | 3files/80pass/exit0，无Errors/Unhandled段 |

命令均以`npx vitest run -c vitest.host.config.ts`开头，完整argv/日志位于`/home/dsdev/.oc-jobs/done/<ID>.json/.log`。标题过滤skip是此次定向选择范围，不是遇业务缺陷runtime skip，二者不混同。共享ledger dirty导致§5 gate2与上述业务测试结果分列，未声明整体自检通过。正常main后按原负向/返回值保证最小独立复验，本轮不新增作业。

## L16精确删除CAS与L24输出断言后继（均非main）

检查`a47f42ded`/`bcb3f2b61`/`c34dfbe14`/`de19f72a0`对HEAD/main均非祖先。前者是L16报告，代码/测试在两个检查点；本轮只读新增差异并取既有提供方result，无新运行。

- **L16精度修复认可**：library/session删除参数为number|bigint|null，输入归一精确非负i64；仓储用TEXT+typeof读local_version，再BigInt，内部snapshot保bigint。null的未入队语义和内容版本CAS保留，同连接读/比较/cleanup/删除顺序及原事务模式未改。对照Rust `database/mod.rs:5722-5745,5887-5928`；同事务所有失败场景仍待正常main最小核，不仅凭类型变化整关A3/A5。
- **提供方测试分层**：已取`20261104151313-17fc61`，`review-version-i64.test.ts --pool=threads --maxWorkers=1 --hookTimeout=120000`，**1file/5pass/exit0**，无Errors/Unhandled段。4例为实际L16服务/SQL精度，list wire例withReview:false+注入snapshot，只证明真实L16命令/kernel投影及内部原对象未变，不能当真实L15 owner联合读取。
- **保留类型兼容失败**：已取`20261104150842-c6c169`，`npm run typecheck:host` **exit2**，唯一`:210,7 L24SurfaceCompatibility` TS2322 boolean不能赋给never。不得移除类型断言或强转求绿；这与共享ledger dirty的gate前置exit2不同。
- **L24测试保证恢复认可**：`de19f72a0`补回output.reviewState/output.current的LARGE_SQL+1n，另补undo与toWireJson副本/内部值不变；大数向量/SQL TEXT/stale不写和撤skip均保持。该版本不再缺那两个返回断言，但api:173/234/507/510仍number，内部协议尚未与L15/L16对齐。不能以最终wire数字形式解释内部number限制。

R7/C3继续等正常main后的最小真实公开链及同事务删除验证；不跑旧直接类注入组合冒验收，不重跑全量，也不把785pass等其它单元历史结果用于此次签收。

## L24公共协议对齐与只读候选类型兼容证据

`6962cbfed`/`e8b2046c1`独立静态核对完成：snapshot.reviewVersion为bigint，scoped参数number|bigint、delete参数number|bigint|null，六个decoder以BigInt做完整i64范围判定并保留原值形式，nullable缺失/显式null规则不变。原de19返回值/wire/副本不变断言及撤skip仍在。检查时这些提交及L16报告`b789b9954`/输入`1df97b515`都非HEAD/main，不能将API修复当正常集成。

本轮只取既有提供方结果，无新执行：

| 作业 | 实际证据 | 不覆盖的范围 |
|---|---|---|
| `20261104152119-274d84` | 六文件44pass/exit0，解析六入口、ReviewBoundaryDouble透传、library/output/event payload与wire副本，无Errors/Unhandled段 | 未含real-l15文件，不是L15/L16真实联合运行 |
| `20261104152119-87836d` | `npm run typecheck:host` exit2，唯一旧L16 service-surface.test.ts:210 TS2322 | 不能删原兼容断言，亦不因两侧单独失败就否定已经静态核实的候选接口修复 |
| `20261104153009-ff06f8` | Node compiler-host原七项兼容断言，L16输入1df97b515＋内存提供6962 api.ts，diagnostics0/exit0 | 不是正式全树tsc、不是main、没有provider执行 |

第三项完整argv已读取：AST抽原两份type-only import、L24SurfaceCompatibility及原赋值语句，验证抽取数量；只覆写compiler host.readFile/fileExists读取虚拟源，设置noEmit/无增量，未调用emit/写文件，也未覆盖磁盘。原断言保留，故认可这组候选接口兼容；其范围仍小于正常main全树typecheck和公开服务组合。`c6c169`旧正式exit2、L24 `87836d` exit2及dirty gate前置分别保留，不能被该diagnostics0抹掉。

C2已收的同批候选组合按C1交接记录；R7/C3正常main后才独立跑最小chatankiTools.execute→hydrate→review服务与实际Anki删除，保原i64范围、SQL TEXT/内部bigint/stale不写/最外wire和副本不变。此轮没有旧class重跑或全量作业。

## L10-V2-07 relation本地CAS与M1事实决策候选（窄范围）

本轮检查`3f876059f`、`7deba2c66`、`dbdececcd`、`9ff4e1476`、`89cd2c243`、`3e2834548`、`351e1849e`对HEAD/main均非祖先；只读候选完整树与既有提供方结果，没有执行候选、Rust或新全量作业。

### L10-V2-07：relation本地get/list/put/delete，不混同N1/state或sync负CAS

实际实现/测试在`3f876059f`/`7deba2c66`，`dbdececcd`仅LANE。`repository/relations.ts`以safeIntegers命名查询读取revision，双边安全范围外保留bigint，list逐项复用get；put/delete内部expected可绑定number|bigint，未新增负数或MAX_SAFE拒绝。SQL仍原式revision+1，更新后回读若SQLite升为REAL则先返回Database列类型错误，触发保存点回滚，不提前clamp或拒绝合法i64MAX。对照Rust `note_relation_repo.rs:112-153,155-205`。

`index.ts`get/list/put返回ExactNoteRelation，Number投影留在kernel；新增3例用真实notes命令建关系，再验证2^53+1及负大i64的get/list、相邻CAS Conflict、caller外层回滚、精确更新/删除、安全边界及MAX溢出回滚。`7deba2c66`另断言前端Number(revision)已舍入时，notes_relation_put返回**Conflict**而非Validation；合法请求不因JS精度被拒。静态认可这些原反例的候选修复设计，未签整个locator/reference解码、worker、history sequence或N1/state。

已读提供方元数据/日志摘要，完整argv位于.done.json：

| 作业 | 范围/结果 |
|---|---|
| `20261104152212-93979d` | v2-boundaries `-t L10-V2-07`，**3fail/40标题过滤skip/exit1**，原红测保留 |
| `20261104152437-478299` | v2-boundaries+note-storage+note-lease，**3files/64pass/exit0** |
| `20261104153821-47ce54` | v2-boundaries `-t L10-V2-07`，**3pass/40标题过滤skip/exit0**，不是43条全部执行 |
| `20261104153821-89fc7d` | `npm run typecheck:host`，exit0 |

均为L10提供方运行，不是R5 main复验；此前notes.sync.prepareRelation负CAS与state.value_json/revision修复仍各按原ID记录。

### M1：候选已进入真实分支编排，真实角色提供方仍未闭合

`9ff4e1476`本身只改index少量await及报告，核心沿完整树核对：`89cd2c243`新增fact-decision/dedup-readiness，`3e2834548`等前序检查点写store与测试，`351e1849e`修测试当前resource identity。不能把tip说明当全部实现提交。

| 原Rust分支 | 候选生产落点与认可范围 |
|---|---|
| service.rs:1968-2026 内部去重、索引未就绪 | `service.ts:852-854`真实调用searchForPurpose(content,15,internal_dedup)；`fact-decision.ts`区分检索失败、无命中及索引未就绪，自动提取SKIPPED/显式待复核标签不再全部当无相似记忆 |
| :2040-2148 决策/熔断 | planFactWrite按相似命中调用MemoryDecisionCompletion并解析决策；实际模型失败才进入原ADD降级/熔断，空命中保留Rust免LLM ADD |
| :2155-2174 低置信度 | writeFactSmart返回NONE/downgraded并finalize，不写普通write_smart审计；没有无条件修改旧记忆 |
| :2177-2384 ADD/UPDATE/APPEND/DELETE/NONE | applyFactDecision按event分派，保候选target成员校验、缺target/NotFound降级与其他错误传播；UPDATE/APPEND实际调notes owner，DELETE replacement的mutation+receipt在同conn中 |
| :1140-1181 幂等事务 | writeSmart先await检索/模型，之后renew lease；commitFact在immediate tx内再次renew、mutation、cacheResult，同步闭包使用dbOverride，网络await不放入SQLite事务 |

**缺L02接口的边界已静态确认**：`service.ts:840-849`要求callMemoryDecisionRawPrompt；planFactWrite在有相似命中时，先于模型调用try/catch解析该接口，因此缺方法错误不被当成模型失败而静默ADD。write-store`:335-337`清理自己reservation后传播；新测试验证无新业务note/无残留reservation。空相似结果本来不调用模型，此合法ADD分支与缺接口错误必须分开。C1已要求保留显式阻塞，本轮不代造通用LLM替身作为生产实现。

**测试真实性分层**：smart-fact-decision.test.ts六例通过生产memory命令/服务编排，但retrieval/decision是外部替身，原support还提供其它依赖；note-content-owner.test.ts装真实L10/L11及memory，新增DELETE replacement用receipt trigger验证旧note/索引单元保留、新note不落库，撤trigger后同key重试才删除替换。其检索/decision仍为替身，所以这是**真实owner事务证据**，不是实际L02模型/检索后端端到端。该文件3例包含M7读取、M2引用清理及1例M1替换回滚，不能写成M1有3条新原子替换用例。

M3关联更新：690988159快照中finalizeResult仅有测试caller的历史判断保留；在9ff完整树`write-store.ts:405,414,427`已有生产调用，原“该helper在最新候选仍不可达”的限制应撤销。它不自动关闭M3/main或其它owner链。

### L02依赖TESTMAP逐ID区分：7条decision不是13条总项

在9ff完整树中以下13条仍为pending。D前缀=`crates/dstu-memory/src/memory/llm_decision.rs::tests::`，S前缀=`crates/dstu-memory/src/memory/semantic_dedup.rs::tests::`；新smart六例不等于这些原名测试全部接真实提供方。

| 原ID（前缀+测试名） | 归属/去向 |
|---|---|
| D test_memory_event_serde | decision，pending |
| D test_extract_and_parse_clean_json | decision，pending |
| D test_extract_json_from_surrounding_text | decision，pending |
| D test_extract_json_with_think_tag | decision，pending |
| D test_extract_json_markdown_with_text_before | decision，pending |
| D test_extract_json_returns_none_for_no_json | decision，pending |
| D test_memory_event_from_str | decision，pending |
| S test_parse_dedup_response_merge | 维护链semantic_dedup，pending |
| S test_parse_dedup_response_keep_with_noise | 维护链semantic_dedup，pending |
| S test_parse_dedup_response_invalid_action | 维护链semantic_dedup，pending |
| S test_validate_merge_decision_guards | 维护链semantic_dedup，pending |
| S test_extract_tag_count_max_merge | 维护链semantic_dedup，pending |
| S test_build_dedup_prompt_contains_both_notes | 维护链semantic_dedup，pending |

TESTMAP说明里的“writeSmarts只走本地判据”对新候选已过时，实际caller接线应如上认可；但L02角色接口缺口未由真实provider闭合。LANE/BLOCKERS的13项是7+6，不能把decision子集改进等同整个维护链完成。两个已批准query_rewriter obsolete不在这13条中。

### M1全作业结果：保留失败，不借子集绿灯签收

已取**提供方**`20261104152747-ea7d38`完整result：`npx vitest run -c vitest.host.config.ts host/plugins/memory`，**3files failed/36 passed；17fail/243pass；Errors3；762.60s；exit1**。日志确认smart-fact-decision六例及note-content-owner三例通过；失败分布于commands-core、flush-service、l13-ports，原输出有30秒timeout及3个RPC onTaskUpdate未处理错误。不自动把这些归为业务断言缺陷，也不忽略它们宣称全目录成功。

完整日志`/home/dsdev/.oc-jobs/done/20261104152747-ea7d38.log`。其它交付定向6/3通过按其各自范围保留，本轮未重跑；M1认可分支编排和真实owner回滚增量，仍未main且L02角色/全链未闭合，整项不勾。N4/LP、M2/M4及M5之外运行时边界均不随这些子集关闭。

## L16 474e38f29：anki_decks两写点owner候选

本轮独立静态核对且祖先检查为非HEAD/main。该提交包含实际api reexport＋`repository/fsrs-decks.ts`同步实现，不是只有声明：ensureDefaultFsrsDeckWithConn/writeFsrsDeckConfigWithConn均只对caller SqlExecutor执行原SQL，无新连接/事务，无JSON解码重编码，raw StorageError由未来L15调用边界包装。

Rust `fsrs_review_service.rs:1346-1352,3634-3644,3680-3690`逐项匹配：INSERT OR IGNORE保默认值且不复活/重置现有或墓碑；UPDATE仅live行、同内容仍增COALESCE(local_version,0)、绑定caller原文本和now、missing row不报新增错误。候选公开API＋迁移库四例还验证caller immediate回滚及trigger原错误。

已取**提供方**`20261104155443-cf2669` result：`fsrs-decks-owner.test.ts --pool=threads --maxWorkers=1 --hookTimeout=120000`，**1file/4pass/exit0，无Errors/Unhandled段**；完整命令前缀`npx vitest run -c vitest.host.config.ts`，日志同job目录。fixture withReview:false，不能当L15真实消费已通过。

当前已审L15 `repository/fsrs.ts:72-77,159-164`两处直接INSERT/UPDATE仍在；C1所述154906三例基线通过不证明这些SQL已移除。L15已接消费请求，正常main后仅核原conn/tx传递、相同成功/墓碑/同值增版本语义及错误只包装一次。该SW事项与a0515复习版本CAS分开；旧正式类型exit2与dirty gate前置继续保留，本轮无新增作业。

## L16 B2与N5三处membership删除候选

只读`1a21bc98a`/`8c2c4fb73`、`d52159c77`/`c64f9be64`/`286fe9570`，检查时均非HEAD/main；报告tip不代替代码检查点。本轮没有新运行作业。

### B2：getLiveResource修的是关联资源，不扩大res_ alias拒绝

L16实际代码1a21bc98a在`chatanki-vfs.ts:44-50`通过getFile/getLiveResource过滤file及关联resource墓碑；外层res_仍getResource并允许source_id重定向，逐分支对齐Rust `chatanki_executor.rs:10549-10622,10642-10668`。fallback关联file经attachments.resolveFileId后再getFile核live/resourceId；该候选L11解析器自身先按resource_id取live优先行，后置过滤不会把宽泛alias回退误当匹配。未找到file报mapping error，与找到file后关联resource被删返回null分开。

提供方`20261104155245-9f5dbc`已读元数据/日志：apkgVfs标题定向 **1pass/9 filtered skip/exit0**。资源/文件墓碑、恢复、NULL关联资源、软删alias指向另一live文件均有原/新增断言，静态认可B2局部修复。LP0059八warn静态映射不是八分支动态全测，D3联合也未签；正常main后只做原B2最小复验。

### N5：三个DELETE已消费owner，仍非全部写点闭合

实际依赖/测试d52159c77、仓储调用及补断言c64f9be64，286fe9570为报告。三处原folder_items DELETE均改`folders.removeItemByItemId(conn,'note',id)`，L11实际返回changes>0的bool，所以孤立membership删除成功/零行NoteNotFound语义保留；正常purge仍在原vfs_note_purge_tx中先删membership再删note，wrapper继续用同executor，不另开连接/事务。

新增真实L11+notes测试验证：caller transaction回滚保留孤立membership、再次删除成功与无行NotFound；owner membership错误先于note删除；note trigger失败使已删membership回滚，撤trigger重试两者都删除。wrapper目前未找到独立生产调用，不为扫描造假调用；本轮只认可三点ownership/顺序/回滚增量，不声称其它日志或错误载荷全部等价。

已读提供方metadata/summary：`20261104155331-e53196` **4pass/73标题过滤skip/exit0**；`20261104155635-42b783` **2pass/43标题过滤skip/exit0**；`20261104155331-67feaf` typecheck exit0。过滤数不计已执行，均非R5独立main运行。

OWNER-SEAMS.md沿原稳定X6-SW-0017..0020，**12操作=11 SQL写点**，不重编号。三DELETE迁移之外仍缺六个L11精确面（resource source_id绑定、单行资源删除、membership软删/最新一行恢复、索引单元双state禁用、回填维护标志）及sync未发布历史日志清理。Rust `note_repo.rs:3076-3089`明确维护key不属于普通setConfig白名单；应专用owner面，不能放宽公开setConfig白名单或复制假owner SQL。N5及N3/Lance均不整体关闭。

## SW deck消费撤回与真实临时组合结果

独立读`77c4bef2a`确认消费实现删除review两写SQL，调用474公开同步函数，原conn/tx、JSON.stringify和错误边界未改。再读当前L15交接HEAD **`84f328310`**：已明确revert77，两写点恢复；owner尚未main时的缺导出依赖会挡review及a0515 D3，不能宣称SW已修。L15已parked，不追加工作；C2已收正常先474 owner、再重应用77 consumer的顺序，SW/D1与R7/D3分开保留。

提供方临时树`/tmp/opencode/l15-deck-owner-77c4bef2a`只读状态clean，HEAD **5b728ccee**父提交是77与474的真实merge；R5没有创建/切换或执行该树。已取原result：

- `20261104160521-9ce58d`：deck-owner-transaction.test.ts 3＋service-transaction-api.test.ts 3＋fsrs-decks-owner.test.ts 4，**3files/10pass/exit0，无Errors/Unhandled段**。
- `20261104160521-4c059f`：`npm run typecheck:host` **exit2**，唯一旧L24SurfaceCompatibility:210 TS2322。

完整argv/receipt/log在`/home/dsdev/.oc-jobs/done/<ID>.json/.log`，cwd明确为临时组合树。10pass只证明这一组合范围，不覆盖正式缺导出失败、正常main类型检查或三方D3联合，也不将cleanup/import的统计用例冒充全部回滚测试。待正常集成后再最小复验。

## L17三项窄消费与L16 LP0061候选

### M2 insight与旧owner面：不依赖新D3候选

实际M2代码沿f4058960f/96278079e/23bfce4f3完整树审读，644c777ef只BLOCKERS、412afbaab只LANE，检查时均非HEAD/main。与此相反，**f09807bb4和8f037194c已为main祖先**；只读main API也确认三Anki投影WithConn与mastery.recordInsightRecallVerdictWithConn存在，不能误称必须等待a0515/a47的D3接口。

memory/repository/insight-projection.ts删除Anki表SQL，按原顺序传mistakes conn及同一now，调用tombstone/upsert task/write card；service通过可选ctx.inject('anki')保存生产owner，卸载清空，只有实际投影写才解析，缺owner明确失败。未自开事务，不将Rust逐语句autocommit擅改整段原子事务。verdict wrapper改调公开mastery同conn方法，保原insert幂等，不增加recompute/profile回流。

测试安装真实Anki/review owner，提供方`20261104155532-238566` **insight-worker+insight-service两文件10pass/exit0**已读metadata/summary。它证明这些owner调用与对应SQL行为，不证明所有外部依赖均真实。特别是memory的recordRecallVerdictToMastery wrapper本轮检索仍仅tests调用，而Rust同名原方法也仅在insight/tests.rs找到调用；此口径不制造假生产接线或自动新增缺陷，应与原调用范围分别审定，不能据该用例声称生产recall链闭合。

### PR0103：HPIAS guard真实入口已调用

23bfce4f3的hpias-service.startFromIntent改为调用shouldStartResearchSession，原intentHasResearchBlocks语义经该生产helper保留。原名测试增加实际ctx.hpiasResearch＋backendEvents：非research不发事件、research发round_started，fake timers只控制350ms时间线。提供方`20261104155734-fe576f` **hpias+l13-ports两文件37pass/exit0**已读metadata/summary；静态认可guard生产可达增量，不等于HPIAS真实retrieval/synthesis后端或所有pending完成。

### V2-02 getNote：owner解码/日志保留，不扩大到所有本地投影

`4d826f661`实际将getNote(deps,db,id)改调notes.repository.getNote(id,db)，null适配undefined，deletedAt缺省适配null；完整树13个production caller均传原db/scope与deps，含双端relation事务读取。真实notes插件测试用memory_get_tags读取混合/坏JSON tags，断言整列[]及实际Cordis notes logger警告；修正了先前观察F4 log替身的错误观察点。

提供方`20261104160646-c46993` **1pass/3标题过滤skip/exit0**已核，不能当4条都执行。标题/resource等其余local row decode未在此单元签收，M4画像结构亦不被该改动关闭。`20261104154220-e74070`仅commands-core/flush-service/l13-ports受影响三文件 **38pass/exit0**；不覆盖旧全lane **243pass/17fail/Errors3/exit1**，也不由本次定向绿推断全因CPU。13条L02依赖仍按本报告前文7 decision＋6 semantic逐ID表保存，query_rewriter obsolete不在其中；本候选TESTMAP说明已纠正“只走本地判据”的旧文字，不改变七条pending事实。

### LP0061：只新增一条原warn，卡片提交后语义不变

L16实际27b0712e8、b2089e4e6仅LANE，检查时非HEAD/main。importTemplateCandidates原catch先runtime.logger.warn模板id/name/error，再原report.warnings，匹配Rust apkg_importer_service.rs:2591-2598；persistPackage卡片tx已经成功，模板create失败继续best-effort而非回滚卡片。新真实importBytes＋SQLite trigger测试检查既有协议剥离warn与新增模板失败warn的顺序、报告、已提交卡片、协议字段移除及模板未创建。

已读提供方receipt/log：`20261104161439-95b72a` **1fail/50标题过滤skip/exit1**（缺第二warn）→`20261104161712-ea46c6` **2pass/49标题过滤skip/exit0，无Errors/Unhandled段**，包含原成功幂等用例。只签认候选该分支修复设计，不代签全部日志、APKG、D3或正常main；shared ledger前置与正式gate未绿仍分列。本轮无新运行，已完成的小值/owner证据未重跑。

## X7独立main复验：三个AnkiCard decoder子项签收

已取独立X7作业 **`20261104163838-b3c3ab`**（cwd X7-differential），命令`node scripts/electron-migration/record/recheck-l16-decoder.mjs`，exit0；已读X7工作树生成的`fixtures/differential/recheck-L16-decoder.json`与脚本。报告tsRevision为 **c9a9e1371**、正常main父 **fd925aa05**，修复1e2356b29确为两者/main祖先，所测生产decoder/入口相关文件无c9↔fd925差异。报告产物不在启动tip本身，本轮未误写为该提交已含产物。

脚本选择原三个固定ID/时间数字输入，调用真实decodeAnkiCardInput；只接受AnkiCardDecodeError，泛异常重抛，意外默认时间也失败。**X7-L16-SERDE-front** `front:3`、**tags** `tags:[3]`、**extra_fields** `{key:3}`均记录该特定类型错误，原历史actual未覆盖。对照Rust models.rs:1380-1411的String/Vec/Map值类型，三个直接decoder/internal assembly拒绝子项已在Anki验收勾选。

这是独立X7 main复验＋R5源码/脚本核对，不冒充R5亲跑；报告kind明确not-C。不签IPC绕过、全部serde行列/错误wire或C级差分；cloze5e05仍非main祖先，两X7 trim项和其它业务保持未决。没有重跑该三向量或新门禁。

## 最新main状态：L15 D3已合入；notes注册生命周期真实跨owner回归

祖先核实a0515bf75/7f9e63ea1已通过main merge **819b970b6**进入主线（R5工作树尚未合该更新）。只读main确认review/src/review.ts的i64Version使用BigInt并校验0..i64MAX，repo exactReviewVersion保留bigint、不再MAX_SAFE拒绝。R7/C3旧“当前main拒绝合法i64”描述仅适用于历史306eb8bbb，现更正为**L15提供方修复已main，独立三方正常集成复验待完成**。L16 a47f42ded及L24 6962cbfed仍非main。

已取提供方 **20261104164944-744fb3**：`npx vitest run -c vitest.host.config.ts host/plugins/chatanki`，44files/391pass/exit0，无Errors/Unhandled段；这是L24候选消费新main依赖后的结果，不能扩大为L16/L24两候选也已正常合入。已读官方selfgate receipt：tip **1d010c567**、base **fb463060d**、ok=false、failed=[typecheck]，时间16:52:47.846Z；不将391pass覆盖类型阻塞或旧正式388pass/3fail历史。

### N2 / F3-V2-05注册Disposer丢失

已取L17 **20261104164359-2a1224**：memory全目录 **259pass/3fail/exit1**，无Errors/Unhandled段；三个失败均为note-content-owner文件后续真实notes Host启动时报SlotOccupied，栈指向registerNotesAssetRetention。独立只读main确认asset-retention.ts:15-16返回void、调用F3注册却丢弃Disposer；notes apply未将其绑定卸载。既有L17 fixture已await host.dispose，不能误判为测试忘记卸载，也不能放宽F3 Slot重复注册拒绝以规避该生命周期泄漏。

候选 **5f9082dbf/51ec310bd**检查时非HEAD/main：wrapper从公开storage/api返回Disposer；index用两个独立ctx.effect依次注册journal与retention，各自立即返回dispose。第二次注册失败时scope rollback能释放先前journal，不释放他scope预占guard；旧disposer不会清掉replacement。新测试使用真实Slot/Disposer的call-through观察、真实notes卸载/重装、保留资产保护，以及第二槽被占导致apply失败回滚，符合所需生命周期语义。

已取提供方 **20261104164350-a2802b**：journal-registration2＋notes-app2，2files/4pass/exit0，无Errors/Unhandled段。候选也把workerPool import改到已公开storage/api；认可公开面与注册释放增量，不由此关闭N2其它时限/线程关闭完成性或N3/Lance。正常main后只核受影响重复Host/注册失败用例，不新增全量作业。

### 补齐先前交接：D3真实卡owner组合、subject decoder与N5双向面

**D3 a61798e9f**已静态核对真实公开documents/cards fixture替换与无cards/reviewStates注入，原大token/返回bigint/SQL TEXT/stale/wire断言保留。已取提供方`20261104161159-6893df`原result，cwd l15t_combo，**2files/5pass/exit0**，分别review scoped consumer1＋D3公开链4；不是整个job4。组合SHA按C1为7f9e63ea1+a617，临时目录已移除，未重建/运行；所有实际候选仍非main。4个AP helper不可达事项等待精确pending裁定，不冒充这组D3已验证。

**PreferenceEntry.subject**代码0a18bca11、真实Host测试5eda95098（均非main）已核：缺省Option→null，非Option校验不放宽，原错误“缺subject拒绝”测试改subject:1，原缺省输入另走真实chatanki update_card/L04 preflight/L16 cards+preferenceMemory/F4 settings成功持久化。已取`20261104161712-be0b20` **3files/17pass/exit0**；红测921b7e日志明确missing subject warn/exit1。只认可该字段，不关f32/i64持久化或整个serde。旧L24正式60dc04 **388pass/3fail/exit1**另保留，不被临时5pass覆盖。

**N5反向blob journal提供面**：实际f79ebc598、API1320f6e89（非main）。notes.blobDeletionJournal外层可选，获取后四方法必需；同conn执行重建取消、八列prepared INSERT、prepared取消、mark ready返回changes。无新连接/事务/时钟扫描，size按Option<i64>直接绑定，重复operation不吞错，blob/outbox仍归调用者。已读提供方161848-18d4fe元数据/摘要 **4pass/exit0**，不签L11消费或B-sync日志清理。

**N5正向L11六面**：实际705cbfcb2实现、fca1b46c9 api出口（非main），NoteOwnerWritesRepo仅使用caller conn。资源source绑定/单行删、membership软删/按原排序恢复一行、索引双state禁用、固定maintenance.note_links_backfill_done写入分别保原SQL条件/字段；databaseResult保L11错误边界。固定维护key有专门方法，不放宽普通setConfig白名单；不把12操作/11SQL重编号。提供方160908-a3ba2b已读receipt/摘要 **6pass/exit0**。4+6提供方测试不是双向消费完成，N5/反向journal/Lance/同步日志仍分项未闭合。

**L17 receipt时间范围**：C1交付的ce7c88d3f/base677/oktrue/16:27:18.576按当时协调者证据保留；本轮读取最新官方文件已为78b1ff11e/basefb463060d/okfalse/failed=[tests]/17:03:20.308Z，不能把较早green当当前结果，亦不改旧243/17/Errors3/exit1。最新SlotOccupied259/3/exit1已在上节完整记录，须修L10注册生命周期，禁止绕真实Slot保护。

## L16 LP0060候选：触及日志与主结果保护，不签整组

实际代码e9c2b05a1/5c1559b10、报告54f513a66均非HEAD/main，独立静态核对已完成。两生产runtime传ctx.logger；resolveCardFieldValue缺字段warn但仍导出空值，collectMediaEntries四类原失败/冲突位置补warn；single丢report入口成功后汇总missing，multi-report不重复汇总。对应Rust apkg_exporter_service.rs:948,1737,1747,1764,1772,1856。

single清理失败warn、multi-report清理失败静默，均不覆盖成功或主错误，符合:2062/2381。multi丢report wrapper第8项:2084目前仅测试caller，生产同名IPC调用report版，不制造生产调用凑LP数量。新7例真实命令断言日志字段/顺序、导出空字段、媒体报告及主结果；fs故障注入只用于清理/写入失败，不复制算法。

提供方原记录：**20261104164200-1f5273 4fail/exit1** → **20261104164831-278785 50pass/1fail/exit1**（三文件，原41+3子集通过）→ 已取 **20261104165312-0de9a1 7pass/exit0，无Errors/Unhandled段**。中间新增fixture错误是create_custom_template实际返回string而非{id}，5c已修，不把整job失败改写成通过。细节记入Anki验收；类型旧L24:210及ledger前置仍按owner原报告保留，不由LP子集关闭。正常main后只核该范围，本轮无新测试/门禁。

## 最新A5门禁反馈优先处理与canonical类型候选

收到17:23集成反馈后，正常`git merge --no-edit main`得到 **987c446f1**（审计父37074f66e，main父7f4fb688b），工作区干净；按新指令运行统一lane-gate，后台shell **sh_1a79985b2001K8TqRi88qqhQ7U**，检查列表与集成共用，已排队执行类型/边界/入口导入/原四目录测试，未再重提六目录。

反馈只列`anki-chatanki-service-surface.test.ts > anki service chatanki surface (A5)`，无完整异常，不能据摘要判为业务数据缺陷。当前main源码发现fixture:171-183只装vfs/vfsRepos/chat，而vfs/index.ts:152必需storage/notes/vfsRepo/vfsIndex；fixture未装notes/vfsIndex，真实chat又依赖vfs。因此明确存在测试宿主依赖装配缺口，实际异常与退出码待本轮完整job结果确认；复核人不擅自改测试或补假provider。

此main已含a0515 D3及51ec310bd注册生命周期修复；当前HEAD祖先确认a47f42ded、6962cbfed、25c1c30ce/9178ca2b6仍未集成，不能以新main合并一概关闭三方类型联合或候选N/M项。

排队期间完成25c1c30ce实际api静态核对（9178仅报告）：snapshot/outcome从review/api引用，service用Pick/Partial<Pick<ReviewService>>；full-i64内部bigint、六decoder、原SQL/返回/wire断言及无缺陷skip保持。已取**提供方**170120-fd00da（完整ID20261104170120-fd00da）**3files/17pass/exit0**，real公开CAS4＋projection5＋executor8，无Errors/Unhandled段。canonical type消除手写协议漂移，不等于全部runtime接线；L16:210兼容断言未改，正常三方main最小复验仍待。

C1通知的重复provider.content-filter为跨owner/reviewer共因故障，不向这些失败队列追加重复任务、不替其它域复核人签收。此轮门禁属于最新明确集成反馈后的正常自检，与已作废22:00/22:04工具故障无关，既有成功/失败历史不改。

### 987c446f1自检完成：A5缺必需服务，非hook/RPC

官方receipt tip=`987c446f1`、base=`7f4fb688b`，17:36:03.616Z，ok=false/failed=[tests]。类型job`20261104172659-1abf2d`、边界`20261104172659-4b4f8a`、四入口importable`20261104172659-db27fe`均exit0。

独立测试job **20261104172659-6c494f**，原命令`npx vitest run -c vitest.host.config.ts host/plugins/anki host/plugins/chatanki host/plugins/qbank host/plugins/review`：**2files failed/150 passed；2tests failed/1662 passed/11 skipped；536.79s；exit1**，没有Errors/Unhandled段。完整日志`/home/dsdev/.oc-jobs/done/20261104172659-6c494f.log`。

1. **A5 suite初始化失败**：`anki-chatanki-service-surface.test.ts:181`首先单独install(vfs)，报`PluginLifecycleError: plugin "dstu.vfs" did not start: required services not available: "notes", "vfsRepo", "vfsIndex"`。vfsRepo虽在下一行安排安装，但当前install调用先验证并失败，notes/vfsIndex也未在fixture装配；10个用例未执行。前轮静态缺口现获独立运行确认，不能归为Anki业务错误、hook超时或SlotOccupied。owner应保持真实依赖装配和原断言，不用假服务绕过。
2. **两个旧L24断言失败**：real-l15旧direct-class文件:99/125将内部`9223372036854774785n`与number LARGE+1比较；成功变更/Conflict均在失败断言前成立。新de19/a617/canonical候选尚未进入该运行树，不能据这些旧断言撤回L15精度修复。
3. 新gate摘要为“新增A5失败1项＋main既有失败2项不计”，是baseline判定而非原始Vitest零失败。保留全部三处失败（1 suite＋2 tests）与真实exit1，不把1662pass或两个被过滤的main失败当整体绿。

本次只补已完成原结果；不再提交相同全量。待owner装配修复正常main后，仅核A5原宿主及新的公开D3链必要场景，复核人未改实现/测试/门禁白名单。

## N2/F3-V2-05注册生命周期：固定正常main最小独立签收

按C1明确请求仅运行journal-registration.test.ts＋notes-app.test.ts，作业 **20261104174027-fd7344**：

```text
npx vitest run -c vitest.host.config.ts host/plugins/notes/tests/journal-registration.test.ts host/plugins/notes/tests/notes-app.test.ts
Test Files  2 passed (2)
Tests       4 passed (4)
Duration    26.91s
exit 0；无Errors/Unhandled段
```

运行目录R5-review-learning，运行树HEAD为 **28c95b16b**（文档提交，包含正常merge987c446f1/main **7f4fb688b**）。核对notes、platform/storage、kernel、vfs-repos相对该固定main无diff；没有摘取候选或改测试。完整receipt/log为`/home/dsdev/.oc-jobs/done/20261104174027-fd7344.json/.log`。

- [x] **N2 / F3-V2-05 注册Disposer生命周期子项签收**：生产asset-retention.ts:15-16返回真实F3 Disposer，index.ts:212-219两ctx.effect分别注册并释放。测试经真实notes install/unload/reinstall：注册有效、重复注册仍抛SlotOccupied、保留资产仍受保护、卸载令两个注册inactive；替换注册后旧disposer不得清掉新owner；第二槽预占导致apply失败时，之前journal注册回滚，原占用guard保持。最后可正常重装，真实notes_list_tags worker调用成功。
- 测试使用call-through spy观察真实Slot/Disposer，不替换保护规则；notes-app两条原用例同组通过。本轮不跑SQL矩阵、不绕真实Slot，不将L17旧固定基线三例SlotOccupied失败继续写成**最新main仍丢Disposer**。
- **签收边界**：这不是N2整体（120秒默认任务时限、void close完成性另保留），也不是N3/Lance、反向blob消费、N5其它owner写或B-sync日志清理。1320反向blob API虽已main，也不随本组4pass签消费者。L17未main消费分支等待owner恢复，本轮未替其造fixture或重跑全目录。

C1转交R1 TR04独立证据（e54b33f20、job20261104165619-790745、固定23ff/mainfb463）：原OCR6pass/exit0、无Errors，有WASI ExperimentalWarning。作为R1/C1来源记其限定注册/两解码/清理/缺文件/所选取消与字节门槛再编码范围；未由R5重新运行或跨域代签，大像素/PSNR/全竞速/平台不包含。文档allowlist拒绝不抹掉已产生独立结果，是否集成文档与行为证据分开。

## 正常main notes修复闭环（0b3c2f55e，2026-11-05）

自动续派先merge main得到 **0b3c2f55e**（main父 **e87727c09**）；随后按要求启动统一lane-gate，后台shell **sh_1a7b7e0d2001SG8M64EaXydD28**，结果待通知。工作区仅报告改动；未修改被审实现/测试。已确认02982f3b3、7a6783fdb、dbdececcd、2b7786b43、3102525cb、0b0ab1296、2f8cb0703、ada2cde47、a38068281及N5三DELETE修复均为HEAD祖先，故本轮不再止于候选审读。

### 独立最小运行：12条精度/事务＋7条真实性/AP

| 作业 | 原命令与选择范围 | 原始结果 |
|---|---|---|
| **20261104180229-20333f** | `npx vitest run -c vitest.host.config.ts host/plugins/notes/tests/v2-boundaries.test.ts host/plugins/notes/tests/notes-extra-commands.test.ts -t 'N1 notes.state\|L10-V2-07\|R4-SYNC-02\|L20 s03\|X6-LP-0228\|N5 folder membership\|hard delete maps purge failure\|empty trash maps purge failure' --maxWorkers=1 --no-file-parallelism` | **2files、12pass/48标题过滤skip、exit0、25.80s**，无Errors/Unhandled段 |
| **20261104180505-8a8679** | `npx vitest run -c vitest.host.config.ts host/plugins/notes/tests/markdown.test.ts host/plugins/notes/tests/notes-repo.test.ts host/plugins/notes/tests/note-storage.test.ts -t 'test_build_notes_fts_match_query\|test_create_note$\|test_get_note_content\|test_update_note_changes_resource_on_content_change\|test_update_note_keeps_resource_when_content_unchanged\|test_create_note_maintains_links_in_repo_layer\|save_as_receipt_failure_rolls_back_copy_folder_history_and_identity' --maxWorkers=1 --no-file-parallelism` | **3files、7pass/51标题过滤skip、exit0、25.10s**，无Errors/Unhandled段 |

两作业cwd均为R5-review-learning，完整argv/log在`/home/dsdev/.oc-jobs/done/<ID>.json/.log`。这是正常main集成后首次独立核这些修复，不是重跑提供方套件或先前注册生命周期4例；标题过滤数不计执行通过。

### 当前签收表（覆盖前文保全快照中这些条目的旧状态）

- [x] **N1 / state JSON与内部revision精度修复签收**。当前state.ts两查询safeIntegers，lossless DbJson/rawJSON保大整数和1.0原文，CAS绑定精确revision。原2^53+1值/版本、负大JSON数、相邻错误token冲突、精确put/delete及wire数值测试独立通过。只签原持久化值/内部CAS丢位finding，不宣称全部notes解码/极限overflow已审完。
- [x] **R4-SYNC-02 / 负大relation sync CAS子项签收**。双边MIN_SAFE/MAX_SAFE判断，原负i64+1不再转Number丢位；包括MIN+1、安全边界及MAX溢出/调用方事务回滚的原向量通过。不代签整个sync域。
- [x] **L10-V2-07 / 本地relation精确get/list/put/delete子项签收**。safeIntegers回读、负i64保留、邻值Conflict、外层rollback及SQLite REAL溢出回读拒绝/回滚通过；已舍入IPC token仍Conflict而非新Validation。与N1/state、sync准备CAS分别记录，不覆盖locator/history sequence。
- [x] **R4-SYNC-s03 / soft-deleted快照格式推断子项签收**。真实notes软删后caller tx仍可推断格式，普通getNoteContent仍null，缺id原错误通过；不扩普通读取权限。
- [x] **N4 / 原FTS副本及L11 SQL替身问题签收**。当前markdown.test导入repository/notes-manager生产函数，notes_list_advanced实际调用同函数；原副本已删。真实L11+notes装配替换原notes-repo资源替身，原创建/正文/资源变化与保持断言本轮执行通过；全插件TS检索test-vfs-repos/createNotesTestRepos仅余说明注释，无代码消费者，末批替身文件已删。签收原N4两种证据缺陷，不宣称135条全部逐assert认证或其它测试替身一律不存在。
- [x] **X6-AP-0356/0357两条具体原断言补齐签收**。真实owner测试验证反链来源身份，receipt故障后原三表rollback断言保留，撤trigger后同request/operation再saveAs成功，原Rust对应断言均执行通过；不以机械assert数量推广其它AP。
- [x] **X6-LP-0228 create/update SAVEPOINT/RELEASE子项签收**。开启错误日志/前缀经源码对照；独立create/update延迟FK用例验证RELEASE失败error日志、精确错误、事务保持开放、显式ROLLBACK恢复及同参重试成功。只签触及两条路径，不关闭整个LP组。
- [ ] **N3部分通过、整项开放**：硬删除purge失败/RELEASE失败及emptyTrash purge失败均独立通过，原同conn SAVEPOINT/finish在提交后和错误前缀认可；完整Lance提交后清理/错误传播仍未在此组验证，不能整关。
- [ ] **N5部分通过、整项开放**：三个membership DELETE经L11同conn，orphan rows>0/NotFound、owner错误优先、note失败回滚/重试及caller rollback独立通过；其余资源写/维护专用面/反向blob消费/同步日志未随此组关闭。
- [ ] **N2整体仍开放**：此前注册Disposer生命周期已签，本轮未重跑；worker两命令候选/主线增量不代表120秒时限、void close完成性或其它同步IO全部完成。

notes总体仍不通过。上述窄签收不覆盖当前统一自检的A5宿主装配阻塞或旧L24内部number断言，不转借为其它lane绿灯；统一门禁结果到达后另记原始exit/Errors。

### 同轮统一自检已返回（0b3c2f55e）

receipt tip=0b3c2f55e/base=e87727c09，18:06:51.579Z，ok=false/failed=[tests]。typecheck `20261104180009-06d45f`与boundaries `20261104180009-82ce9f`退出0，统一摘要确认importable亦通过。测试 **20261104180009-0d74cb** 原四目录命令：**2files failed/150 passed；2tests failed/1662 passed/11 skipped；396.30s；exit1**，无Errors/Unhandled段。

失败与上一轮同根：A5 beforeAll:181安装vfs缺notes/vfsRepo/vfsIndex；旧L24 direct-class测试:99/125内部bigint与number期望不同。baseline判定仅A5为新增、另外两项main既有不计，但原始失败照录。未据此撤销L15已main精度修复或新增notes独立窄签收，未改fixture/断言，也未重复提交全目录作业。日志`/home/dsdev/.oc-jobs/done/20261104180009-0d74cb.log`。

## C2 retemplate Phase2正式raw接口候选

实际73a23e3dc＋公开类型/收尾cbd4b027e、fixture条件2f73fd1d5检查时均非HEAD/main。独立静态确认hydrate不再等待不存在的llm.callAnkiModel2RawPrompt，改从正式llmRawPrompt调用`callModel2RawPrompt(prompt,null,'anki')`，只映射assistant_message；配置/adapter/重试/audit/usage继续由L02承担。生产retemplate先完成owner事务再await fill，与Rust chatanki_executor.rs:4448对齐。

新用例真实F4 settings/secrets、L01 adapter、L02 raw、L04 preflight、L16 CAS经chatankiTools.execute，远端本地HTTP；保fill计数、实际卡字段、一次请求及JSON response_format断言。VFS注册占位未调用、UI回调只是观察，不外推VFS/全部工具/UI事件链。gpt-* fixture改名恢复Rust force_json前提，原断言未删；Planner/VLM高层role task/配置重验/fallback仍未交付。

提供方证据已核：173849-92ae22（完整ID前缀20261104）1fail/exit1→174709-2dbf86定向1pass/exit0；175148-498e47 **45files/392pass/exit0**。官方receipt **cbd4b027e/basee87727c09/okfalse/failed=[typecheck]**，不得将4/5或测试绿写成全部门禁通过。Anki旧:210类型和A5宿主依赖问题继续单列，C2只认可候选这一接口修复，main后原入口最小复验；本轮无新作业。

### 指定收尾自检与077bf139c新测试增量

按C1 §5收尾要求，确认10326e8ed及检查点650a40975已提交，且本工作树无同tip在途gate/队列后，正常merge main得到 **b795d5582**（main父ccba04837），启动唯一官方lane-gate，后台 **sh_1a7d4cf8d0013LLUjWlAu2U41N**。该聚合仍待完成通知，没有另跑四目录或已签notes小组；回执只能归其实际tip/base，不能套到随后仅报告的候选增量提交。

新增指定候选077bf139c（非HEAD/main）已只读核对，只有真实入口测试和文档，没有owner/生产变更：原成功断言保留，HTTP回复前真实L16读Phase1，坏响应后终态整卡等于Phase1；请求内真实owner CAS竞争写manual Example，fill返回conflict/winner.version且整卡保留winner。interleavingErrors明确断言空、结果数量恰1，未吞异常。对应Rust chatanki_executor.rs:4432-4472及18489-18495，不把一个it内三场景当三条单独测试，更不称三文件7pass为7个端到端场景。

已读提供方红测182107-f101ff **1fail/exit1**，失败是同内容fixture被真实去重返回空数组；后继仅区分front，insert断言保留。182455-4fc8cd **三文件7pass/exit0**（真实入口1＋fill3＋mutation3），无Errors/Unhandled段；完整ID均前缀20261104，receipt/log同既有job目录。官方077/base01c/okfalse仅typecheck，旧L16:210未变。C2/C7只认可测试增强、main复验待；A5装配/Planner/VLM等未闭合，已签notes范围不变。

指定候选静态单元处理后，等待条件保持：retemplate及Anki联合/A5需owner修复正常main；N5其余owner消费待接线。本轮不循环相同探针或向失败owner/reviewer重复投递，不扩大为全部业务通过。

### 指定§5收尾同一回执完成（b795d5582）

官方receipt：tip **b795d5582**、base **ccba04837**、2026-11-04T18:40:42.846Z、ok=false/failed=[tests]。本轮仅取已启动聚合原结果，没有因报告追加另提同类作业。

| 作业 | 原检查 | 结果 |
|---|---|---|
| 20261104183144-b5355a | host tsc（`.integration.tsbuildinfo`） | exit0 |
| 20261104183144-7df05e | boundaries（DSTU_BOUNDARY_STRICT空值，官方列表原配置） | exit0 |
| 20261104183144-f00c1c | anki/chatanki/qbank/review四个index.ts原生导入 | exit0 |
| 20261104183144-067446 | `npx vitest run -c vitest.host.config.ts host/plugins/anki host/plugins/chatanki host/plugins/qbank host/plugins/review` | **2files failed/150 passed；2tests failed/1662 passed/11 skipped；533.31s；exit1**，无Errors/Unhandled段 |

完整receipt/log在`/home/dsdev/.oc-jobs/done/<ID>.json/.log`。A5 suite在beforeAll:181因vfs缺notes/vfsRepo/vfsIndex失败；另外两条旧L24:99/125内部bigint对number期待失败。gate按baseline报新增A5一项、main既有两项不计，原始失败没有改写为绿。已签notes小组及077候选提供方7pass均不能覆盖此固定tip自检结果，后续报告提交也不冒用此receipt为自己的通过证明。

本批指定静态任务已处理并保存；当前明确等待正常main的retemplate/Anki公开联合与A5依赖修复、N5其余owner消费。没有新的可执行差异时不重复四目录或已签探针，不代失败owner修改实现/fixture，不声称无剩余业务或全部验收通过。

## 本次自动续派固定gate与AP0187新增真实入口候选

自动续派要求下先正常merge main得到 **c11d07cd6**（main父cce44494c），启动唯一官方lane-gate后台 **sh_1a7f33629001qvL0r0rfxRkUcI**，结果待通知。相对先前b795d5582，被审六插件/storage/kernel无实现测试差异（仅Chatanki验收文档变动）；指定候选仍未集成，因此没有另起已签notes小组或相同探针。

新指定8055938c2（实际测试）/ce0ee3541（报告）只静态审读，检查时非HEAD/main。owned-snapshot-real-host.test.ts使用实际公开L16 documents/cards创建5卡归属，经chatankiTools.execute(get_cards) hydrate实际owned/review读取，无cards/review方法替身。原Rust chatanki_executor.rs:15084-15137 **16项断言**逐项保留：insert5、首/尾/越界页、error_only ID及原index2/4、edited_only ID；未以fixture数组长度替代真实insert结果。

提供方`20261104184905-218327`已读receipt/log：**2files/17pass/exit0**，新真实case1＋旧executor-args16，无Errors/Unhandled段。未调用llm:{}注册依赖、UI观察回调不外推真实LLM/UI或完整工具链。旧helper及GENERATED/TESTMAP未改；另4条可达性pending裁定不搭车闭合。AP0187只认可候选真实性增强，main后该入口最小独立复验；偏好f32/i64、A5联合与整D3仍各自保留，官方旧:210 type2不改写。

C1已提交185145463精确D3测试文件集成请求，不重复启动失败L16或削断言；其它域的provider/上下文阻塞及header/BOM/change-set候选只按协调记录，不由R5代签。当前只等既有官方gate回执，无新增测试作业。

### c11d07cd6官方回执补录

本次固定tip **c11d07cd6** / base **cce44494c**，2026-11-04T19:12:12.849Z，ok=false/failed=[tests]。四作业中typecheck **20261104190457-d65464**、boundaries **20261104190457-a316cb**、importable **20261104190457-094a61**均exit0；tests **20261104190457-b4b7d9**原四目录Vitest命令结果为 **2files failed/150 passed；2tests failed/1662 passed/11 skipped；431.68s；exit1，无Errors/Unhandled段**。

完整日志`/home/dsdev/.oc-jobs/done/20261104190457-b4b7d9.log`确认仍为同三处：A5 suite安装vfs缺notes/vfsRepo/vfsIndex，旧L24:99/125 bigint对number期待失败。baseline只拦新增A5、另两项main既有不计，原始失败不改成绿；候选AP0187的17pass与已签notes小组不覆盖该收据。未追加相同测试或自检，继续等待已记录的owner正常main修复条件。

## 本批收尾：26e9c3aa9官方回执与明确等待条件

已取同一在途聚合最终receipt：tip **26e9c3aa9**、base **810149749**、2026-11-04T19:44:06.949Z、ok=false/failed=[tests]。typecheck **20261104193435-ef80db**、boundaries **20261104193435-087712**、importable **20261104193435-4d0e0c**均exit0。测试 **20261104193435-2b0d93** 原四目录命令：**2files failed/150 passed；2tests failed/1662 passed/11 skipped；564.44s；exit1，无Errors/Unhandled段**；完整原输出在`/home/dsdev/.oc-jobs/done/20261104193435-2b0d93.log`。

失败仍为A5 beforeAll缺notes/vfsRepo/vfsIndex及旧L24两个bigint对number断言；baseline摘要只计新增A5、不计main既有两项，但原始失败全部保留。没有新原因或实现差异，不重复投递相同聚合，也不把已签notes或提供方候选绿灯移用为此tip通过。

按C1本批收尾指令：**本轮可执行审读无剩余工作**。AP0187及其它指定候选的静态单元均已处理；这不表示业务全部完成。后续仅等待以下明确事件再启动原最小独立复验：

1. L16/L24正常真实联合main：A5完整依赖装配、canonical接口、返回快照bigint/SQL精确回读/最终wire及stale不写。
2. retemplate Phase2与AP0187真实入口候选正常main，保原正向、Phase1失败保留及并发owner CAS场景。
3. N5其余owner正反向消费、反向blob journal及同步日志接缝实际闭合；Lance与其它明确未决范围仍分别保留。
4. 其它原finding有明确修复main通知或新反例时，按该差异复核，不代失败owner/reviewer修改实现、fixture或跨域签收。

本次只归档回执和等待条件，未新增测试/门禁，不循环已签notes小组或相同四目录。原失败记录及所有既有窄签收范围保持。

## 新指定JSON export候选静态单元（C2/C7）

`c1b106114`新增两真实case，`3e553386f`后继测试隔离/报告；检查时均非HEAD/main。独立逐项对读Rust chatanki_executor.rs:15558-15642/15646-15700原断言：显式library IDs可跨会话读取但按请求顺序、完整字段导出，混入软删ID整体拒绝；document选择仍仅owner，foreign拒绝，原输出形状/卡片数据保证保留。测试setup走公开L16 documents/cards，execute→hydrate→真实saveJsonFile，只有原Rust软删fixture SQL；未改变生产/owner或卡片权限。

library路径额外断言完整导出JSON等于owner rows，失败不增文件/不改旧文件；不将document用例的id/front断言误称同样做了全对象比较。llm:{}未调用，UI回调只是观察，不签LLM/UI/APKG或跨会话写权限。

提供方`20261104193106-6af59a` **1fail/3pass/exit1**日志显示共享系统tmp快照被F7临时文件变动干扰；后继只将paths.os.temp设置为case私有目录，保sink及无副作用断言。已取`20261104193345-c0d09e` **2files/4pass/exit0，无Errors/Unhandled段**，新真实2＋旧2，不扩大新E2E数或覆盖旧失败。官方仍旧L16:210类型失败按交付记录，未签main联合。

该指定静态单元已完成，正常main后仅原JSON入口最小复验；其它明示owner/main等待条件不变。本轮没有新增测试、自检或全量队列，不因新增测试自动升级其它不可达TESTMAP项。

### 自动续派固定回执补录（6e53e46cf）

按续派正常merge main后tip **6e53e46cf** / base **7528428c5**，官方自检于2026-11-04T20:29:51.695Z结束，ok=false/failed=[tests]。类型`20261104202208-716b2e`、边界`20261104202209-3437a3`、导入`20261104202209-6853d5`均exit0。原四目录测试 **20261104202209-0d94a1**：**2files failed/150 passed；2tests failed/1662 passed/11 skipped；457.90s；exit1，无Errors/Unhandled段**，日志位于`/home/dsdev/.oc-jobs/done/20261104202209-0d94a1.log`。

仍为A5缺notes/vfsRepo/vfsIndex的suite初始化错误及旧L24:99/125 bigint/number断言，baseline仅将A5计新增，原始两项失败继续保留。新main的raw-prompt变化仅新增agent compaction/chat-title服务，未解除memory-decision或Planner/VLM角色缺口；被审六插件实现无新增差异，未补跑探针或已签notes小组。

此份原回执已归档，本轮可执行审读无剩余工作；待既有owner修复/指定候选正常main或新反例再做原最小复验，不将等待描述为业务全部通过，不因本次归档重新启动同组检查。

## 新正常main联合复验启动（1e80f32b4）

本次自动续派正常merge得到 **1e80f32b4**（main父 **5b1b19055**），已核实L16 a47、L15 a0515、L24 canonical25c/077retemplate/805owned snapshot/3e553 JSON export、cloze5e05及LP0060/61均为HEAD祖先；终于有新实现差异，不再沿用“上述候选均未main”。A5 beforeAll现按vfsRepos→notes→vfsIndex→vfs→chat装配，七项L24SurfaceCompatibility断言保留；D3文件用真实documents/cards、ctx hydrate、2^63-1024、输出bigint/SQL TEXT/wire及无skip，均核实。统一lane-gate **sh_1a84975fe001kfdeGuIBOXWo72**已启动，等待实际固定tip结果后作相应窄签收，未另起四目录重复测试。

新F7 projected regex能力不在四目录门禁内，按原C4反例仅补独立job **20261104204101-dfb236**：native/tests/regex-projected.test.ts串行单worker，**11pass/exit0、15.86s、无Errors/Unhandled段**，仅WASI ExperimentalWarning。原文边界/capture/gap/tail/UTF8/首次超限bytes及无value均经真实native服务；源码确认u64预检完成后才replace_all，L24 capture路径传caller limit并消费该能力。原F7缺原语/capture先分配子项静态＋独立原生运行认可；常量替换仍边计数边拼前缀、fallback/完整工具链限制不外推关闭C4。

R5未编译Rust，未改实现/测试、未造临时组合。SW deck消费者review两写SQL仍在，不因L16 owner函数已main一并签；其它未决按各finding范围保留，等本轮官方结果。

## 联合main官方自检全过及窄签收收据（1e80f32b4）

**已取实际结果后签收**。官方receipt tip=`1e80f32b447888ee2a50fcfb23a41a004777bddc`、base=`5b1b190553712eaddfee1e862c10f61ab11a55f3`，2026-11-04T20:49:35.331Z，ok=true、failed=[]。这次是原始测试exit0，不是baseline过滤旧失败后放行。

| 原作业 | 命令/范围 | 原结果 |
|---|---|---|
| 20261104203909-576f49 | `npx tsc -p tsconfig.host.json --incremental --tsBuildInfoFile .integration.tsbuildinfo` | exit0，原L24SurfaceCompatibility保留 |
| 20261104203909-a46bb6 | `env DSTU_BOUNDARY_STRICT= /opt/node26/bin/node scripts/electron-migration/boundaries.mjs` | exit0 |
| 20261104203909-4f71e1 | 四个被审插件index.ts importable | exit0 |
| **20261104203909-c2516b** | `npx vitest run -c vitest.host.config.ts host/plugins/anki host/plugins/chatanki host/plugins/qbank host/plugins/review` | **160files passed，1709pass/1skip，618.35s，exit0，无Errors/Unhandled段** |
| 20261104204101-dfb236 | F7 regex-projected.test.ts，串行单worker | **11pass/exit0**，无Errors/Unhandled，WASI ExperimentalWarning |

唯一四目录skip在apkg-importer外部APKG环境fixture；原A5/D3/retemplate等文件实际执行。原始日志均`/home/dsdev/.oc-jobs/done/<ID>.log`，不重新运行同组获取“更绿”结果。

### 本轮实际签收与保留

- **R7/L15-V2-S4、C3/D3同根窄项签收**：真实L15 provider5、真实L16 library/session精度5、L24公开CAS4通过；原2^63-1024范围、SQL bigint绑定/TEXT+1、stale不写、成功/冲突/undo返回bigint、最外wire副本与内部不变全部保留，无CardStoreDouble或缺陷skip的四例链。list wire单独一例仍注入快照，其限制不抹去，也不用于冒充另一组真实链。
- **R6原运行阻塞签收**：现在有独立正常main干净全目录覆盖，不抹去旧RPC/type/hook失败历史。
- **A3原FSRS所有者/普通删除锁模式签收**：真实owner同tx、普通deferred/CAS与APKG原immediate、删除/APKG/事务用例通过，生产Anki仓储无直接FSRS状态/日志写SQL；不宣称所有其它表归属或全部故障矩阵完备。
- **A4原运行取消/config reject-after-abort签收**：generation-service成功/失败配置返回均先abort guard，独立generation-commands20例覆盖原正负路径，无取消后错误副作用。
- **A5七服务面/指定真实装配消费者签收**：service-surface10例执行，真实依赖顺序修复，兼容断言未减且tsc通过；不扩大全部工具/UI事件/APKG全域。
- **两X7 cloze trim、LP0061缺warn子项签收**：cloze9例、apkg-importer50执行含原trigger负向，通过。A6 Option-null/body阶段9例通过签认对应子项；底层source错误文案等其余范围不因子集绿灯整关。LP0060触及七例通过，第8测试caller wrapper不虚构生产接线，不整组签收。
- **C2/C7原retemplate、JSON导出、AP0187、subject字段子项签收**：真实retemplate1it内3场景；JSON2、owned snapshot1（原16断言）、subject1均独立通过，沿先前逐断言审查范围。LLM本地HTTP/VFS未调用占位/UI观察限制保留，不签Planner/VLM或所有工具。
- **C4仅capture预检修复认可**：F7真实bounded11向量及L24 transform33例通过；原文captures/gap/expanded/tail u64预检后物化，当前capture调用成立。常量分支仍边拼前缀、后置fallback仍在，C4不能整关，L24既有消费任务不重派。

**仍未闭合**：review两处anki_decks写SQL（474 owner已main，77和revert84均历史祖先，当前实际仍未恢复消费）；F7 optimize/evaluate发布不等于L15业务optimize接线/注册，当前足量历史仍抛requires trainer；JS同步FSRS ULP差异不在本次版本CAS签收内；N5其余owner消费/Lance/sync日志、M1/M3/M4/M7未集成链及其它原finding按原范围保持。四目录业务整体结论不是“全等价”。

### 会话接续要点

C1已确认新main条件并要求保存交接：这轮官方gate与F7小集**都已完成**，无需轮询/重提；notes在fce5c9bbb的窄签收保持，不重做。当前文档补录在gate之后，不把新的文档tip冒充receipt被测tip。下一会话先核提交/工作区与此收据，只有明确新main差异或新反例才复验原最小集；不安装包、不改实现/测试、不增加Ruby/Rust构建或跨域代签。

### C1确认及后继optimizer scaffold交接（2026-11-05）

C1最新指令确认已亲读`f7660f7ed`、官方`1e80f32b4/base5b1b19055/ok:true`收据并亲取`20261104203909-c2516b`与`20261104204101-dfb236`原结果，接受上述R7/C3-D3、R6、A3/A4/A5及cloze/LP/Option/retemplate/JSON/AP0187/subject对应窄项。常量/fallback/整个C4、同步FSRS math、N5等范围仍未签。

**后继main `9c2c60db1`不在旧1709通过的被测范围内。** 据C1本次静态复核通知，该版本新增L15 optimizer服务/adapter scaffold：`resolveFsrsTrainer`把F7 `NativeFsrs`强转旧`Partial<FsrsTrainer>`后调用`optimize(items, options)`，实际F7接收`{trainSet, cardIds, enableShortTerm, numRelearningSteps}`；错误guard读取`fsrsError`，实际F7 `FsrsError`仅有`kind`。命令仍未注册，属于真实接线前的新缺口；不能继续只用旧“无scaffold”描述后继，也不能凭旧gate签新adapter。以上为**C1静态证据转录，非R5本轮新增独立运行结论**，已交架构L15实际接管者。deck两写SQL仍由既有未决项跟踪。

**R5队列/接续状态**：本轮官方gate及native11向量均已完成，R5无待取结果或在途作业；本次仅补录报告，不重排四目录或已签notes小集。实现/测试未改，不运行Rust、不引入伪trainer。架构按`201307325/204940471`接续新会话；待实际owner修复与明确集成版本后，再确定对应原最小复验，保持已签/未签边界。本轮可执行审读无剩余工作，不代表业务整体通过。

## C1新派C4正常main独立窄复验（650ddffbe，2026-11-05）

本次有明确正常main可执行差异，依指令恢复复验；正常merge快进至`650ddffbef3c755dce9fc3b3eb2fe5502bf72382`。实际核实3423a821c/7c6df8295/c91904d99/1093329fd/54e138f45均祖先；`transform.ts:483-502`已删JS常量findIter/拼接与capture事后fallback，全部async必需调用F7 projected，传完整原文及max(1MiB,utf8 input)。原Rust:477-594与F7 regex_engine.rs:189-227逐分支核对，原文capture/gap/展开/tail预检完成后才物化；不能再把旧“常量/fallback仍在”当新main现状。

**独立job `20261104230316-7884d4`**：`npx vitest run -c vitest.host.config.ts host/plugins/chatanki/tests/regex-projected-real-host.test.ts host/plugins/chatanki/tests/transform.test.ts -t 'C4|regex_replace|bounded_replace|security_(regex|capture|projected|shrinking)|ops_apply' --maxWorkers=1 --no-file-parallelism`。**2files、23pass/21标题过滤skip、28.36s、原始exit0，无Errors/Unhandled/FAIL段**，仅WASI ExperimentalWarning。前文件11全执行，后文件12pass/21过滤；未重跑旧native11或手动四目录矩阵代替新证据。原metadata/log位于`/home/dsdev/.oc-jobs/done/20261104230316-7884d4.{json,log}`。

本轮窄签认async常量预检/fallback删除与真实工具触及场景：capture dry/apply首次超限1049600而非2097152且DB完整卡快照不变；常量首次1052672而非8388608**仅dry_run动态覆盖**，apply不得搭车宣称。真实工具正常`\B` apply写入、`a$[b]c`6bytes、无value失败、超长保持/收缩与foreign权限原断言均保留。工具1it含多场景，不扩增E2E条数；JS limit非负安全整数不等于u64全域；legacy真F7 capture＋固定match fixture仅计数证据，非同步生产provider。详细静态路径/断言真实性见chatanki ACCEPTANCE文末。

C4整体脚本/平台未决；4c0cbd520/8463031c3非本轮祖先，当前card-access仍本地Map，早期workspace-read-scope fixture不证明L05 owner，AP0189新scope/完整worker生命周期不签。本轮不重新签optimizer或N5，D3/A5等旧窄签收保持。实现/测试等只读，未运行Rust。

**§5接续**：本报告提交后正常merge main并启动官方lane-gate，定向23pass不豁免门禁。等待新固定tip官方收据，不用旧1e80f32b4的1709结果签此次新树。

## AP0189/C3 scope正常main独立窄复验（f821b3733，2026-11-05）

C1明确新main差异后恢复一次窄复验。正常merge固定`f821b37337d90b0d256f072ffbf5bc0c3487d526`，e2d6b27a2/4c0cbd520/8463031c3/5a09dc0e3/56eae1110与C4 c4d均经祖先检查为true。当前card-access删除本地Map，读L05 api.workspaceCardReadScope；真实fixture从L05公开installer安装并release。旧650“scope未main”只适用于历史基线。

**独立job `20261104232824-eb4b09`**：`npx vitest run -c vitest.host.config.ts host/plugins/chatanki/tests/workspace-read-scope-real-host.test.ts host/plugins/chatanki/tests/workspace-read-scope.test.ts --maxWorkers=1 --no-file-parallelism`；**2files/6pass/0skip，无标题过滤，20.71s，原始exit0，无Errors/Unhandled/FAIL或warning段**。真实Host文件1条＋CardStoreDouble文件5条，原metadata/log在`/home/dsdev/.oc-jobs/done/20261104232824-eb4b09.{json,log}`。

**窄签认AP0189/C3 scope读授权消费与写不放宽**：Rust `chatanki_executor.rs:16345-16384`六项在真实文件`:54,63-71`逐条对应真实insert、读预检、verify/load写拒绝、真实CAS NotFound、front不变；进一步通过公开chatankiTools get_cards/update_card验证完整卡行快照不变及release撤权。生产读路径用coordinator readSession消费L16/L15，写路径继续worker ctx.sessionId且真实仓储在UPDATE前拒绝非owner。手动trusted scope前提保留，1个it内多个场景不计成多个E2E；旧5条仍替身仓储，不能把全组6条称无替身。

**新增静态日志残差**：Rust `:1826-1832`scope命中info在TS card-access.ts:33-35缺失；Rust读预检通过verify_document_ownership在查询异常时warn（:1783-1789），TS读helper:40-44静默catch false。授权fail-closed不受此残差影响，但完整日志等价未签；本轮未动态注入查询异常或断言日志。详细分支/原断言对照见chatanki ACCEPTANCE文末。

本轮不签C3整体、L04 worker创建/取消/异常全生命周期、AP0188库列表或新L16 agent-page缺口。保留C4 c4d/base650官方407与定向23的原边界，不用旧1709/407代本轮6条；未手动重跑旧矩阵，未改实现/测试或运行Rust。**§5：报告提交后正常merge main并运行同轮官方gate，等待其实际固定tip/base与原码后收尾。**

## 新normal-main日志残差与N5六owner消费窄复核（f2d5b6c46，2026-11-05）

本轮正常merge固定`f2d5b6c4653200c4c9edfcb4ba9d948d303cc492`；独立核实日志31554ea96/bbbabfab8/2a8c03323/9ee3dcb96及notes dfe011e1f/ef975045a均为祖先。仅沿两个已记录未决子项复验，保旧scope授权6、C4 23/407及1709证据各自版本/范围。

### AP0189/C3日志

真实get_cards/status将ctx.warn/info传给card-access；注册wrapper经index adaptContext使用Host logger，读helper复用verifyDocumentOwnership，正常false不warn、每次查询异常各一次warn，direct-owned短路无hit，scope成功info含原四字段。对照Rust chatanki_executor.rs:1775-1836，原静默catch与缺info两处静态修复确认。指定job **20261105014748-26f08b**（workspace-read-scope-logs-real-host.test.ts，单worker串行）已亲取：**1file/14pass/0skip、无标题过滤、41.46s、原始exit0，无Errors/Unhandled/FAIL或Warning段**。窄签收原两处日志残差，C3整体不勾。

14场景经真实注册wrapper、Cordis exporter及SQLite列故障；DB.one只透传原调用，trace严格检查查询/日志顺序。首warn观察器恢复schema属于受控故障恢复，不签全部数据库故障或L04完整worker生命周期。详见chatanki ACCEPTANCE本轮节。

### N5/L10-V2-01正向六owner方法、七调用点

notes `index.ts:95-109`注入真实L11 `noteOwnerWrites`，`resource-deps.ts:28-40`缺能力明确失败、不设本地SQL回退。L11公开类型/实现`vfs-repos/types/note-owner-writes.ts`与`repository/note-owner-writes.ts`只使用caller conn，不开连接/事务；调用者保留引用检查、SAVEPOINT、索引清理与快照顺序。

| L11 owner方法 | notes/repository/notes.ts调用点 | 原Rust note_repo.rs |
|---|---|---|
| bindNoteSourceIdWithConn | 405，新建notes后绑定source_id | 493-540 |
| purgeNoteResourceRowWithConn | 506/873，update及purge先引用检查、清索引再删资源 | 823-841、1854-1879 |
| softDeleteNoteMembershipsWithConn | 781，软删活动membership | 2371-2385 |
| disableNoteUnitsWithConn | 784，随后只改text/mm state，不改updated_at | 2387-2404 |
| restoreLatestDeletedNoteMembershipWithConn | 829，只按原排序恢复最新一条 | 1618-1640 |
| markNoteLinksBackfillDoneWithConn | 1119，所有rebuild批成功后写固定维护key | 3076-3122 |

六方法七调用点静态核实均传原conn/executor，原对应跨owner写SQL已从notes仓储移除。资源update/purge均先embeddingUnits清理后删除；backfill每批仍BEGIN IMMEDIATE，失败不标done，维护key专用面不放宽普通setConfig白名单。

指定独立job **20261105014748-b1e7f8**（notes/tests/note-owner-consumption.test.ts，单worker串行）已亲取：**1file/4pass/0skip、无标题过滤、23.82s、原始exit0，无Errors/Unhandled/FAIL或Warning段**。完整命令`npx vitest run -c vitest.host.config.ts host/plugins/notes/tests/note-owner-consumption.test.ts --maxWorkers=1 --no-file-parallelism`。四项装真实L11+notes并使用公开notes.repository：spyOn默认原调用透传；create绑定与外层事务update回滚；软删membership后disable并只恢复最新mount；真实SQLite DELETE trigger令purge回滚、撤trigger可重试；真实note_links INSERT trigger令回填失败不写标志，重试成功才标记且再调用幂等。restore spy仅断言连接存在，原连接身份由生产源码/原SQL共同确认，不冒称每个方法都有逐一conn identity动态断言。该文件为owner消费补充回归，TESTMAP原同名Rust测试仍映射notes-repo.test.ts，不将4条当全部原断言重新验收。

**N5/L10-V2-01六owner消费子项签收**：以上七调用点的真实L11消费、原连接/顺序与触及rollback/retry已具静态＋本轮独立动态证据；原“六面只有提供方、notes尚未消费”不再适用于本main。两组原receipt/log分别为`/home/dsdev/.oc-jobs/done/20261105014748-26f08b.{json,log}`及`20261105014748-b1e7f8.{json,log}`，不合并成一个18条job。

边界：N5整体、Lance提交后完整清理、反向blob journal消费、sync-log清理、新history serde父域保持未签；本轮仅这六面消费，不签全部日志、SAVEPOINT RELEASE故障矩阵。只写既有chatanki ACCEPTANCE及本聚合报告，不新建notes ACCEPTANCE，不改实现/测试、不运行Rust。提交报告、正常merge main并按§5执行官方gate，同tip在途复用；正式结果待其原收据，不因两个定向exit0提前宣称门禁全过。

## 自动续派增量审读（d8366166a / main628b4192e，2026-11-05）

先正常merge，固定`d8366166aa3460a310d39684c7627f4537d578ad`，父为已审报告73f034977与main`628b4192e3c41a54b6a62f8d386a26176f53ad7f`。有新实现差异，依续派第2步启动官方gate **sh_1a975eef9001g1nD1JHk87MSie**，等待同一次原结果，不重提。该固定tip之后的审计补录不冒称被测tip。

### Preference i64：新main尚未配齐owner，不联合签收

L24新JsonReader/i64 rawJSON读写及number|bigint面已main，但当前L16 PreferenceEntry/nowMs仍number，`src/preference-memory.ts:667-670`同分检索仍用时间戳减法；`931643d80`不是本树祖先。第五项L24SurfaceCompatibility原断言保留，待官方原类型结果。新14例已审为精确数字词法/实际持久化证据设计，部分经真实卡编辑、部分直接生产helper；单entry用例不覆盖多项同分检索/容量排序，不以小组绿灯代完整provider联合。只读记录实际缺口，交owner正常集成，不改实现或弱化断言，不重做旧D3/C4/scope矩阵。

### L10-V2-09：history tags Vec<String>局部复验

本次main新`revisions.ts:149-165`将全串JSON.parse后验改为F4公开JsonReader逐项readString，再end检查尾部；`get:273-287`先tags后props/asset_refs，`setPinned:291-295`先get后UPDATE。对照原Rust `note_revision_repo.rs:290-315,321-337`的Vec<String>类型读取顺序及失败前无写入。命令接线为notes/index.ts:404-410，保留Serialization error→Database envelope。

新变化不在chatanki官方测试目录内，故仅补独立job **20261105020805-3d1e74**：`npx vitest run -c vitest.host.config.ts host/plugins/notes/tests/history-boundaries.test.ts -t 'L10-V2-09' --maxWorkers=1 --no-file-parallelism`。**1file/14pass/3标题过滤skip、42.38s、原始exit0，无Errors/Unhandled/FAIL或Warning段**；原receipt/log在`/home/dsdev/.oc-jobs/done/20261105020805-3d1e74.{json,log}`，没有运行Rust。

12负向经真实L11+notes和notes_history_get/set_pinned：整数/浮点词法/-0、类型错误优先于后续破损语法、中文UTF8列位置、null/非array/nested/trailing，精确原错误与tags/props/pinned行不变；同时破坏props验证tags错误先到。2正向保空数组、空字符串、中文及重复值、不归一化。该14条是新增边界回归，不冒称整个原Rust长测试；过滤掉的3条V2-08未重新运行，不追加签收其cursor/high-water范围。

认可所测L10-V2-09 tags类型/错误优先级/无写入窄项；history其他props/asset_refs/格式/序列及整个serde父域仍未签。N5六owner与原日志残差按上一轮已签范围保持。独立复核角色仍只写原授权报告，不改实现/测试或另建LANE/notes ACCEPTANCE；官方gate结束后据实际原码限定收尾。

## 后继正常main解除preference owner前提（dde940ee2，2026-11-05）

本次自动续派先正常merge，固定`dde940ee2cc2e5e5bc0514e5976ce172ee48c041`（main父`536aad0958f4fe5830da347b1f37a1f57089ce93`），工作区初始干净。`931643d80`现为祖先，真实L16 `PreferenceTimestamp=number|bigint`贯穿entry、两个consolidate公开面、服务与adapter，检索同分比较改为关系比较，不再bigint相减返回排序器；原容量淘汰关系比较保留。对照Rust `anki_preference_memory.rs:124-141,600-640,701-705`，原d836阶段“owner未main/仍number/减法”只保留历史。

L16 owner不在此前chatanki-only官方选择范围，故仅补独立job **20261105022908-0fa684**：`npx vitest run -c vitest.host.config.ts host/plugins/anki/tests/preference-memory-i64.test.ts --maxWorkers=1 --no-file-parallelism`，**1file/4pass/0skip、无标题过滤、18.08s、原始exit0，无Errors/Unhandled/FAIL或Warning段**。原receipt/log在`/home/dsdev/.oc-jobs/done/20261105022908-0fa684.{json,log}`。

四例均经真实Anki公开服务：i64 min→max强化时first不变/last更新；旧number与bigint共存且不safe-only拒绝；相邻2^53/2^53+1同分检索选较新、逆序输入不变、number混合仍正确；65条容量维护在无新候选时淘汰较旧且保64条。容量例为明确构造的store直接传公开服务，不是从持久化读取；L24卡编辑/精确JSON词法14例属于另一条链，不冒称单一E2E覆盖全部持久化＋检索＋淘汰。

官方gate **sh_1a98929ef001V2U47ysmoEu3wJ**已完成，固定dde940ee2/base536aad095，2026-11-05T02:31:33.930Z，**ok:true/failed:[]**。原测试job **20261105022821-02294c**：`npx vitest run -c vitest.host.config.ts host/plugins/chatanki`，**51files/435pass/0skip、89.83s、原始exit0，无Errors/Unhandled/FAIL段**；preference-i64-real-host14条通过。原typecheck **20261105022821-e7f5a2**、importable **20261105022821-16fa19**、boundaries **20261105022821-7fbf2c**均code0，原receipt/log在`.oc-jobs/done/`。本轮复用同一gate，未另跑consumer14矩阵。

**Preference时间i64联合窄签收**：L24精确读写/损坏值不覆盖14条与L16字段/强化/触及检索淘汰排序4条在正常main已共同成立；两个job、不同证据层级分列，不称18个E2E。原d836 owner未集成条件已解除，旧失败/限制保留历史。新增agent-page提供面已main，但chatanki生产未消费listAnkiAgentLibraryPage，AP0188库列表保持未签；f32输出/整Preference、worker和其余N5等未决不搭车关闭。本次仅审计补录，未改实现/测试、未运行Rust。

本轮可执行事项：无剩余工作。仅待上述明确owner/正常main条件；不是全部业务通过。官方被测tip是dde940ee2，之后报告保存提交不得冒称该receipt的tip；无在途job，无需重新运行已完成同组。

## 最终报告门禁纠正与新八mutation窄复验（18d8cb7e2，2026-11-05）

C1明确纠正：报告提交也必须满足§5，准确区分旧tip不构成豁免。保既有独立原结果，正常merge后固定`18d8cb7e230f35a3de66d082711018135f0dc44f`/main`dd564e12f9ced043381b3b61410a01aba38a1a1b`，只执行一次官方gate；运行中未变tip。收据`2026-11-05T03:02:21.870Z`、ok:true/failed:[]；**20261105025308-642255**为chatanki目录 **52files/443pass/0skip、113.45s、原始exit0，无Errors/Unhandled/FAIL**。同前缀typecheck4ba06b/boundaries683d43/importabledcc1ec均code0。该次已覆盖6d报告及正常main集成树，旧dde receipt不冒充此收据。

C1在途新增原C2/C7八mutation补证任务：a028c30da/95ed38981/18437f71c已确认在本固定树。独立job642255中 **card-mutations-real-host.test.ts 8条实际通过、10494ms**，因此复用该执行不另手动重跑8条。不是供方443，也不是旧scope/C4/pref证据代替。供方首6pass2fail/exit1为delete夹具误带patch，后8pass/exit0为夹具修正，仅按C1来源保留，不称产品缺陷修复。

逐条对照Rust `chatanki_executor.rs:16457-16572,16606-16819`与TS新文件:98-275：wrong/mixed owner update/delete的insert/NotFound/内容版本不变/物理tombstone仍null；update成功版本推进与stale赢家payload；normal delete live/物理行0；stale delete完整冲突payload且不写；active review遇null冲突、真实fsrs_rate后stale review版本1、真实工具刷新payload且无事件，当前双版本repo成功删除及FSRS state/log合计0。新工具补证还核完整卡对象不变与实际成功事件+1。八组映射见chatanki ACCEPTANCE文末表。

**窄签收C2/C7原八场景证据缺口**，不勾完整C2/C7。最终review CAS成功删除是公开repo而非tool；测试真L16/L15/L04和生产hydrate，callbacks观察、VFS/LLM未运行。旧替身文件和TESTMAP未改，八行pending账本未由复核人越权更新。AP0188、agent-list、其它UI、完整worker和原未决维持。

此新增报告必须提交→正常merge main→最终tip官方gate；完成后只取原收据，不再补确认文档改变tip。不重复手动八条或旧14/4/435专项、不改实现测试、不运行Rust。

## 自动续派新main库列表消费与LP0062日志（f2c6d46c4，2026-11-05）

正常merge固定`f2c6d46c468f57e920a55e1e59defb8dcf53f764`。区别于上次仅协调日志变更，本次实际新增L24 library-list生产handler/10条真实测试及L16三处fragment日志修正/3条回归。已依第2步启动官方gate **sh_1a9cb814a001L2ThjVK9miXRio**，运行中不改tip；既有scope/C4/pref/mutation证据不重复手动运行。

### AP0188 / 原C2/C3/C7 library-list消费

当前executors注册、index hydrate真实L16 agent-page与L15 library review。逐分支对照Rust chatanki_executor.rs:3562-3653/12270-12292及owner database/mod.rs:7604-7725，工具显式20默认、全局过滤先分页、Due包括新state、同SELECT locator、review agent域/结构AppError/精确内部bigint、无额外provenance输出及读不放宽session写成立。新10例真实性及原AP0188:15229-15268的14项语义核对见chatanki ACCEPTANCE最新节。真实page透传spy与真实竞争删除，不将它们称无任何测试观察器；未调用VFS/LLM/完整UI生命周期不签。

实际官方gate因HEAD=main只选2项：typecheck **20261105034049-b14b10**、boundaries **20261105034049-455bba**原code0，收据f2c6d46c4/base同、03:43:40.622Z ok:true/failed:[]。未执行测试或importable，故追加必要最小独立job **20261105034440-f3bb1c**：`npx vitest run -c vitest.host.config.ts host/plugins/chatanki/tests/library-list-real-host.test.ts --maxWorkers=1 --no-file-parallelism`，**1file/10pass/0skip、无标题过滤、24.82s、原始exit0，无Errors/Unhandled/FAIL或Warning段**。完整receipt/log在`/home/dsdev/.oc-jobs/done/20261105034440-f3bb1c.{json,log}`。

**窄签收AP0188原14项语义及上述实际library-list消费场景**。原“只有L16提供面/L24无真实handler”在本main解除；不签全部library工具/完整C2/C3/C7/所有typed输入，数值断言仅内部bigint，不冒称本文件独立kernel wire或真实超大COUNT。TESTMAP旧helper映射未改，保原复核写入边界。

### X6-LP-0062三处fragment日志

独立job **20261105034117-eb0f16**：`npx vitest run -c vitest.host.config.ts host/plugins/anki/tests/anki-generation-commands.test.ts -t X6-LP-0062 --maxWorkers=1 --no-file-parallelism`，**1file/4pass/20标题过滤skip、20.86s、原始exit0，无Errors/Unhandled/FAIL或Warning段**。原metadata/log在`/home/dsdev/.oc-jobs/done/20261105034117-eb0f16.{json,log}`。3条是新增stream/residual/truncated，第4条为标题命中的既有协议回退，不混淆新增数量。

窄签认原Rust streaming_anki_service.rs:1553-1570/1713-1731/1778-1792三处warning前缀/详情有无/Unicode字符计数；真实trigger命令、生产parser/残留修复/错误卡入库、统计/事件/logger及运行句柄释放执行通过。上游llm/stream/docs为fixture替身，未签供应商真实链、LP0062全域或A1/A2全部生成。未改实现/测试、未运行Rust。新报告提交后仍按§5提交→merge→最终tip gate，完成后不追加确认文档。

## 原最终gate失败保留与后继LP0063（59451501c，2026-11-05）

**前轮正式红灯**：最终tip56eecb90a/basef2c6d46c4，receipt 03:52:57.528Z ok:false/failed:[tests]。原job **20261105034708-504797**为anki/chatanki两目录，**98files pass/1fail，1277pass/1fail/1skip，343.05s，原始exit1**；唯一失败`document-processing.test.ts:454 forced_char_split_preserves_cjk_and_emoji`超30000ms（30581ms），无额外Errors/Unhandled段；skip为外部APKG环境fixture。generation24及library-list10当次通过；typecheckc8ef54、boundaries5e1dd7、importable4d3bfd（均前缀20261105034708）原code0。不能把“新增失败”当报告致错，更不能猜CPU或修改超时/断言。独立专项原结果继续按原范围保存，正式交付不能称全部gate通过。

本次自动续派先正常merge固定`59451501c2c5c4c5a24ce992ae22e90c9af3d21f`，main父`cf92ce1ebb41de93af216755d896a2c5076a62a7`。新实现差异是L16 LP0063 residual错误路径；旧超时测试未改。按第2步已启动同一官方gate **sh_1a9e6fee5001n26uHCHdagdV6P**，等待原结果，期间不改tip、不额外手动重跑全套。

LP0063静态核实：Rust streaming_anki_service.rs:1713-1733/1794-1806的普通residual解析失败仅debug、保存原payload，普通/truncated错误卡创建失败均静默best-effort；TS generation-service.ts:655-657/696-705/727-735已对应。新3例通过真实trigger/parser/SQLite拒绝INSERT trigger/logger验证一次尝试、原payload、无额外error、failed_cards=1与正常完成，db.run spy透传原调用。上游llm/stream/docs仍替身，未签真实供应商或所有残留成功/去重日志；运行结果待本轮gate。

**C1明确AP0188未决保留**：query/search重复别名、完整六槽sequence、unit-enum map、map首错及execute先计时后info/start。实际当前parser仍旧对象分支，library-list在begin之后performance.now；核Rust chatanki_executor.rs:1276-1287/1873-1883与TS executor-args.ts:463-486/library-list-executor.ts:23-24，原10真实场景不构成全AP0188入站/完整C3签收。L24正在处理，未main前不重做矩阵或预签。

本轮只写既有审计路径，未改实现/测试，未运行Rust。结果取回后完整报告先提交→merge→最终tip§5；最终结果后不再新增确认文档改变tip。

### 本轮官方实际选择范围更正

已取59451501c/basecf92ce1eb官方收据：04:14:48.630Z、ok:true/failed:[]；原测试 **20261105041051-362ea0**实际仅`host/plugins/chatanki`，**53files/453pass/0skip、159.79s、原始exit0，无Errors/Unhandled/FAIL段**。同前缀typechecka72b23/boundariesf1bd2e/importable57defe均原code0。此轮未运行Anki目录，所以不能把旧document-processing超时称已复验通过，也不能拿453签LP0063。保旧失败原因未明，未调整其输入/超时/断言。

为新LP0063仅补必要job **20261105041542-b91f8c**：`npx vitest run -c vitest.host.config.ts host/plugins/anki/tests/anki-generation-commands.test.ts -t X6-LP-0063 --maxWorkers=1 --no-file-parallelism`，已亲取 **1file/3pass/24标题过滤skip、19.97s、原始exit0，无Errors/Unhandled/FAIL或Warning段**。原receipt/log在`/home/dsdev/.oc-jobs/done/20261105041542-b91f8c.{json,log}`；仅窄签上述三处residual错误处理分支，不签全部LP0063/完整生成/模型链。协调者在gate完成后保存`3dca6d317`检查点，保其报告内容；它不是59451501c收据被测tip。统一提交最终报告再§5，不另手动重复Chatanki矩阵。

## AP0188已派parser/计时残差新main复核（a2c74534f，2026-11-05）

正常merge固定`a2c74534fa979c0c257089071c09246cadef7ccd`、main父`9c81543595ccbdb81b30bdd3b5658c043fe7e8fd`。新1e471b064/29b155fd3真实改变library-only parser与startedAt位置，已有明确差异，启动固定tip官方gate **sh_1a9fdb4c9001HYkCK9Hn5Un4Lq**；运行中不变tip。

已逐分支对照Rust struct/execute及本机只读serde_derive1.0.228、serde_json1.0.149依赖源码，确认query/search duplicate含首值null、map访问次序首错、六槽逐次解码而非先总长度、enum default缺槽与Option槽仍必需、单键map→variant→unit校验、arbitrary_precision数字宽度错误及计时早于info/start的修复设计。未运行Rust。新增25例=24 parser+1可控monotonic时钟，原10例保留，共35；数据provider真实，spy默认透传，计时oracle是测试观察，不称实际耗时/UI全链。细节见chatanki ACCEPTANCE本轮节。

官方原结果已取：receipt a2c74534f/base9c8154359，04:39:33.614Z、ok:true/failed:[]。**20261105043539-791db2**为`npx vitest run -c vitest.host.config.ts host/plugins/anki host/plugins/chatanki`，**99files/1306pass/1外部APKG skip、230.42s、原始exit0，无Errors/Unhandled/FAIL段**；library-list-real-host **35条全部执行通过**（7271ms，原10＋新增25，无标题过滤/缺陷skip）。typecheck312c10/boundaries79fda4/importableb15555（同前缀20261105043539）均code0，原receipt/log均在`.oc-jobs/done/`。

**AP0188/C3四类parser残差及起始计时窄签收**：alias重复含null、map首错、六槽序列/default/Option槽、unit-enum map及所测数值错误分类，实际生产入口/原首错断言通过；计时早于info/start由源码＋可控100ms oracle证明。from_value非from_str、无行列/path边界保持。供方56/35或旧10不代此独立结果；不签完整AP0188/C3、上游词法/对象顺序保真、缺library/review能力动态未测分支、其它typed/worker域。

前轮最终b78b53c0d/basecf92已实际四项通过：20261105041756-8c14fc为99files/1281pass/1外部APKGskip/原exit0，无Errors/Unhandled，CJK例19.702s通过；保更早30s失败原件，不据新绿推断根因修复。C1新指令确认此main与本次范围一致，复用已完成35条独立结果，不重跑旧pref/C4/scope矩阵。新报告统一提交后按§5执行当前最终报告tip门禁，不为确认再追加文档。

## C1后继任务：遮挡draft局部/外层单次清理（ac92e40cb，2026-11-05）

先完成库列表最终tip ac92e40cb/base92365bc5c gate（04:43:40.230Z ok:true/failed:[]，原20261105044149-a299b3仅Chatanki53files/478pass/0skip/exit0、无Errors/Unhandled，含35例；其余三项code0）。随后固定同一已正常merge树`ac92e40cbe0b4cf858e1797e557d03084a86b008`，核a94bf2aa6为祖先，按C1新任务仅跑两标题，不以旧gate代Anki新证据。

**20261105045055-29b2d4**：`npx vitest run -c vitest.host.config.ts host/plugins/anki/tests/anki-generation-commands.test.ts -t 'consumes the pending occlusion draft only after the first saved card' --maxWorkers=1 --no-file-parallelism`，**1file/2pass/27标题过滤skip、20.06s、原始exit0，无Errors/Unhandled/FAIL或Warning段**。原件`/home/dsdev/.oc-jobs/done/20261105045055-29b2d4.{json,log}`。与C1转述供方040703的1pass1fail/exit1及Node/Electron29pass分开。

对照Rust streaming_anki_service.rs:1522-1543/1742-1763，成功Some且含OCCLUSION_FIELD后才清pending；TS parseAndSave:614-631保条件/计数顺序，residual新callback:716-724同时清局部参数和外层闭包，避免第二payload继承旧对象。两例真实trigger/parser/wrapper/入库/读取/运行完成，正文两卡作控制、收尾两卡命中新修复；首卡imageRef/images/tag/cloze及答案，第二卡无机器字段/无image/tag/cloze且答案独立全部通过。

**仅签上述两卡draft消费子项**。上游LLM/stream/docs仍替身；生产统计执行不等于这两例单独断言GenerationStats全字段。重复/失败路径仅静态条件核对，不签完整遮挡/模型/全部失败路径。实现测试只读，未运行Rust。报告先统一提交→正常merge main→最终tip一次§5，gate结束后不为确认追加文档。

## C1新main任务：token估算guard等价性/原forced保证（7fc4bf00b，2026-11-05）

固定正常merge树`7fc4bf00bd72761a9740cfe8e1b869811b7c3249`/main`eaa17bc7e27ea6e522d3b51e093a7d2e05b2c290`，25efce989/faff8b6b9祖先true。生产仅增加code≤U+3000短路，F4共享White_Space表最大成员确为U+3000，故高位省恒false调用而不改分类。对照Rust document_processing_service.rs:257-276及TS完整函数，标量/CJK/词数、f32乘法截断、下限/二分切分分配不变；原31例、样本、≥25000增长loop、无损/10000预算断言/30s配置全部保留，新加9语义边界向量。未改变扫描复杂度。

任务到达时同树官方gate在途，按C1允许复用实际运行，不另排重复10例：**20261105050552-d1b549**，`npx vitest run -c vitest.host.config.ts host/plugins/anki host/plugins/chatanki`，**99files/1317pass/1外部APKG skip、323.52s、原始exit0，无Errors/Unhandled/FAIL**。document-processing文件 **40pass/0skip、无标题过滤、16652ms**，含新9＋原31，原forced测试体 **3801ms**。官方tip7fc4bf00b/baseeaa17bc7e、05:13:17.442Z、ok:true/failed:[]；同前缀typecheck2a2872/boundariesf6e5f3/importable5bd985 code0。原receipt/log在`.oc-jobs/done/`。

**窄签该guard语义等价性及原硬切保证**，不据3801ms称隔离性能测量、profile占比或旧超时/RPC唯一根因修复。旧034708的30s失败保持，88df通过基线无guard不归功补丁；C1转述供方043441九例旧实现控制、043803 Node69/Electron40、042845规模元数据均不当R5运行，未另执行增长loop或Rust。减少117928415次恒false调用的规模推导不等于码点扫描数量减少/复杂度改善或CPU负载解释。其它未决仍保持。

报告先统一提交、正常merge、最终报告tip一次§5；完成后仅取原收据，不追加确认文档导致未测tip。

## C1用户20:00目标：三原失败正常main独立验证（2026-11-05）

固定正常main **65f6688428603d219a3c8c2e2577a4685a0c0734**。555ebbe73与qbank实际fixture修复34402a1ff均祖先true；本轮仅执行指定三原用例，未跑全部学习目录/写实现测试/运行Rust。已在结果返回后、报告gate前向C1报告实际三例证据。

有效独立job **20261105104219-4c2d52**，cwd本lane：
```sh
npx vitest run -c vitest.host.config.ts host/plugins/qbank/tests/practice.test.ts host/plugins/qbank/tests/authoring-copy.test.ts host/plugins/translation/tests/c1_cross_lang.test.ts -t 'papers_keep_answers_when_export_hides_them_and_restore_with_the_exam|canonical_copy_preserves_materials_and_structured_data_and_restore_preserves_prior_deletions|set_params_rejects_incremental_job_with_english_removed_message' --maxWorkers=1 --no-file-parallelism
```
**3files/3pass/15标题过滤skip、31.81s、原始exit0，无Errors/Unhandled/FAIL或Warning段**。practice 1pass/11过滤、authoring-copy1pass/0过滤、translation1pass/4过滤。各测试体时间4304ms/3403ms/964ms。原metadata/log：`/home/dsdev/.oc-jobs/done/20261105104219-4c2d52.{json,log}`。

原首次job **20261105104122-b39d72**由于R5使用`^(.* > )?(三个标题)$`不匹配Vitest完整名称，**0执行/18标题过滤、3files skipped、24.22s、原始exit0**。保留该误筛选记录，不算三例通过，也不是代码红灯；仅修正-t后得到上表实际执行。

真实性与范围：
- qbank practice改用真实vfsRepo.exams（构造注入qbank cascade resolver），authoring-copy装真实vfsRepos+qbank。原diff仅装配，不删除答案/删除恢复断言。生产resolver为vfs-repos/index.ts:67→qbank/index.ts:253-257。paper答案A及删除拒读/恢复一题；copy两题材料/structured42/group重新生成，先删题在考试恢复后仍删、另题live/SQL count1均通过。
- translation测试先创建真实F3 storage再装backup，`:58-59`新增finalizerNames包含`backup.restore-activation`断言；backup/index.ts:316确实注册，未使用只有locations的假storage。原英文常量/failed status+phase/result.error/取消flag断言逐条未弱化。settings/secrets保最小占位，本例只证明finalizer注册与incremental setParams拒绝，不证明finalizer回调执行、真实备份/恢复/整个取消生命周期。
- qbank authoring copy为实际仓储/helper链而非全kernel命令；practice的原llm/mastery占位不计真实批改链。只签指定三条原场景在此main独立通过，不称全域迁移通过、20:00全测清零或ledger上涨。latest fulltest旧3f不是此树结论；Value其它候选不搭车签。

必要报告统一提交后正常merge并执行最终tip一次§5，结束只取收据不追加确认文档。

## WP-C2-D1-005：L10-notes 独立 ACCEPTANCE 草案（2026-11-05）

结论：**部分完成；草案不通过，非全域通过，不计 B 级完成。** 本次新上下文独立审读 **28/81 条命令、19/134 条 ported 映射**，另核实唯一 MFJS pending。发现租约生命周期接线缺失、历史 props 恢复丢整数精度等实际缺陷；未审范围明确留空框。

### 授权、基线、范围与交付位置

- 唯一修改文件：`docs/dev/electron-migration/audits/R5-review-learning.md`。下方完整草案的**最终路径为 `host/plugins/notes/ACCEPTANCE.md`**；该路径不在本包 allowlist，本次未创建，需 C2/C1 授权有权 lane 落盘。落盘本身也不构成 B 级签收。
- 按协议先完整阅读 WORKER、ORCHESTRATION-v3、standard-v2、R5 角色及 notes LANE/BLOCKERS/TESTMAP。R5 没有独立插件 LANE/TESTMAP；本包被审域为 L10。历史审计只用于定位既有编号，不替代此次源码证据；先前已签子项不因新发现被笼统撤回。
- 工作树 `/home/dsdev/dev/ds-mig/R5-review-learning`，分支 `ds-mig/R5-review-learning`；开工 `git status --short` 为空，有其它 lane/全测进程在途。`git merge --no-edit main` 快进后实际 HEAD **`967f43c7547d1ed29a7e3d736b8118fb95d3661e`**，与 brief 的 phase0 相同。本文源码行号均指此树。
- 契约直接读取 `contracts/ipc/L10-notes.json`（81 commands），并用 `git show main:host/plugins/notes/TESTMAP.md` 核实实际 main 内容。`index.ts:181-193` 提供真实 `notes`，`:95-110` 注入真实 L11，`api.ts:150-165,241-258` 发布 lease owner/service；没有把历史“owner 尚未 main”当当前事实。
- TESTMAP 实际行数 **135 = 134 ported + 1 pending + 0 merged + 0 obsolete**，不是表头历史快照的 135 ported。本包不改任何 TESTMAP、SPEC、实现、测试、审批、超时或依赖；不编译/运行 Rust。

<!-- BEGIN WP-C2-D1-005 NOTES ACCEPTANCE DRAFT; target=host/plugins/notes/ACCEPTANCE.md -->

### L10-notes 独立验收草案（R5-review-learning）

**结论：不通过（初稿、抽样审计）。** 以下未勾选项与未审范围必须随最终文件一起落盘，不能只复制“已核实通过”形成空缺陷清单。证据层级为 Rust 分支审读、真实 Host/仓储入口测试和 TS 诊断，非 Rust 动态差分。

本草案基线为正常合并 main 后的 `967f43c7547d1ed29a7e3d736b8118fb95d3661e`。本包审读28/81命令、19/134 ported及1条MFJS pending；TESTMAP实际134 ported/1 pending/0 merged/0 obsolete，前后不改。最终目标 `host/plugins/notes/ACCEPTANCE.md` 尚未获本lane写入授权，当前保存在audit，不计B。独立运行原件与证据限制附在本草案末尾。

#### 必须修复

- [ ] **D005-01 / 高：租约启动、TTL 与窗口/页面生命周期清理未接入生产。** Rust `src-tauri/src/lib.rs:487-491,704-712,1340-1354` 分别在页面加载、窗口销毁、启动时清旧 membership，并每 5 秒调用 cleanup；`src-tauri/src/cmd/notes.rs:526-553` 发 `notes:lease-ended`，失败 warn。TS `host/plugins/notes/repository/leases.ts:88-105,384-390` 有正确 cleanup SQL，但唯一生产调用是 unregister；`host/plugins/notes/index.ts:473-550` 只注册命令，`api.ts:150-165` 也未公开 cleanup，host/electron 无定时或生命周期消费者。`leases.ts:253-259` 的写栅栏不按时间自行消失，所以关闭/重启残留租约会继续阻断写入；不是 UI heartbeat 停止后自动解锁。应由 L10 与 shell/kernel 装配方接回原启动/5秒/页面/窗口语义、事件及 warn，不改为只依赖 renderer 主动 unregister。现有 `note-lease.test.ts:144-158` 手工调用 cleanup 不能证明生命周期已接线。
- [ ] **D005-02 / 高：历史 props 的精确整数在恢复时被改写。** Rust `src-tauri/crates/dstu-vfs/Cargo.toml:50` 开启 arbitrary_precision；`note_revision_repo.rs:303-311` 的 props 是 `Option<Value>`，`note_history_restore.rs:198-214` 将该值恢复并生成新历史。TS `host/plugins/notes/repository/revisions.ts:273-287` 用 `decodeJson`，其 `repository/json.ts:138` 最终 `JSON.parse`；`:436-441` 再传给 metadata 写入，`repository/props.ts:104-115` 用 JSON.stringify。持久化 `{"n":9007199254740993}` 在真实 `notes_history_restore_current` 路径成为 `{"n":9007199254740992}`。这发生在内部/数据库，不能由最终 wire 的 number 规则豁免。修复要保原 Value 数字与合法数值范围，不能 safeInteger 拒绝或把数值变字符串；原 N1/state 与 relation/seq 的已签精度修复不覆盖此处。
- [ ] **D005-03 / 中：持久化 typed serde 仍有三个明确缺口。** (a) `repository/leases.ts:108-124` 忽略 FrozenDraft 多余字段、重复字段，并拒绝 serde struct 的 sequence 形式；Rust `note_lease_repo.rs:16-21,286-288,332-334,408-409` 是 deny_unknown_fields 的 typed from_str。多余字段稿目前可被 flush 接受。(b) `repository/relations.ts:29-49` 先 parse 后 `Number.isInteger`，使 `{"type":"page","value":1.0}` 成功，重复 `type` 最后值覆盖；Rust `note_relation_repo.rs:12-20,119` typed u32/adjacent enum 应拒绝这些输入。缺字段/错误类型的文案、位置与优先级也未保持。(c) `repository/revisions.ts:165-180` 拒绝合法 `[["notes_asset","notes_assets/a.png"]]`（Vec 内的 struct sequence），并把缺字段错误改成无行列的 invalid type；Rust `note_revision_repo.rs:14-19,310-311` 的 NoteAssetRef derive 没有禁用 sequence。只恢复这些既有解码语义，不引入新的容错或数据自愈。已签 tags Vec<String> 的 JsonReader 修复 `revisions.ts:150-163` 不在问题内。
- [ ] **D005-04 / 低（原判中，见运行原件 a6fcbb 后下调）：relation 回读错误先后颠倒。** Rust `note_relation_repo.rs:117-125` 顺序为数据库列读取→locator decode→reference_status（可失败）→relation type decode。TS `repository/relations.ts:140-151` 在 `referenceStatus` 前先调用 `relationType`。对于 locator=card、非法 relation_type 且 Anki 查询失败（或仓储 anki=null），Rust 先报目标查询/连接错误，TS 先报 unknown variant。应恢复原顺序，不以错误都被包装 Database 视为等价。本项为源码审读，不冒称已执行双故障反例；Rust 与 TS 共用 `V20260922__note_storage_foundations.sql:43` 的 relation_type CHECK，非法类型只能来自绕过约束的数据。
- [ ] **D005-05 / 中：两条 ported 丢失原第二连接保证。** `note_lease_tests.rs:55-87` 用另一个仍独立借出的连接验证写栅栏；TS `tests/note-lease.test.ts:86-100` 全部调用同一个 `db()`。`note_history_integration_tests.rs:248-249` 从第二连接读取已持久化 policy；TS `tests/note-history-integration.test.ts:155-156` 再调 `storage.database('vfs')`，而 F3 `host/platform/storage/service.ts:98-114` 返回缓存的同一 handle。值断言虽然保留，跨连接场景未保留；应恢复真实第二连接，或由有权实现者如实调整去向。本包不改测试/TESTMAP。
- [ ] **D005-06 / 中：原静默 rollback 失败新增 warn。** Rust `note_revision_repo.rs:120-131` 在 work/RELEASE 失败后 best-effort rollback，丢弃 rollback 错误而返回原错误；TS `repository/transaction.ts:11-18` 保主错误正确，但新增 `[notes] note_history_write rollback failed` warn。standard-v2 的日志/错误语义应保持原分支，不能用额外日志代替等价；只处理此处，不删除原有业务 warn/error。该双故障日志路径为静态证据。
- [ ] **N5 / 原未闭合子项仍在：history 直接写 sync 所有的 `__change_log`。** `repository/revisions.ts:256-258` 仍直接 DELETE；原 Rust `note_revision_repo.rs:226-231` 的过滤条件已保留，但迁移 owner 裁定 `scripts/electron-migration/gate-checks/owner-rulings.json:6` 指定 sync。需要正式 `discardUnpublishedNoteHistoryLogsWithConn(conn: SqlExecutor): void`，保调用方保存点与条件/顺序，不能另开事务或省略清理；请求 SQL 已在 `host/plugins/notes/OWNER-SEAMS.md:43-58`。不把已签 L11 六面消费重新报作尚未提供。
- [ ] **MFJS / B-MFJS（证据缺口，已正确 pending）**：`tests/user-todo-executor.test.ts:152-210,239-257` 仍调用 `normalizeMfjsForTest` 副本。Rust `src-tauri/src/chat_v2/tools/user_todo_executor.rs:1821-1839` 实际调用 LLM normalizer。当前真实 TS 实现在 `host/plugins/llm/src/adapters/moonshot.ts:25`，生产 `src/model2_request.ts:115` 调用，但未从 `llm/api.ts` 发布；不是“整个 normalizer 尚未实现”。需 L02 正式公开面/真实消费，或 C2 对精确 test-only schema 行裁定；不能越界私有导入、造生产调用或自行 obsolete。`TESTMAP.md:147,168` 已 pending，本次未错误指控它仍 ported。

#### 必须保留的未审范围与旧开放项

- [ ] **其余 53/81 条命令**未在本次逐分支审读：CRUD/列表搜索/Canvas、transfer/undo/review-save 完整命令、资产/导入导出/RAG/删除等，不能用整目录运行代替分支表。本文只用 transfer 等生产实现确认所抽测试可达，不将它们额外计入 28 条命令。
- [ ] **其余 115/134 条 ported** 未在本次逐条读完 Rust→TS 原断言。19 条样本中的两个第二连接缺口亦未修；MFJS 1 条 pending 另计。
- [ ] 所审入口的所有 IPC serde 形态（struct sequence、enum/map、重复键/词法整数）、全部坏数据库列类型、超大格式版本与时间整数，以及异步取消/线程行为尚未逐项证明。契约 shape 校验与 TypeScript 类型不是完整 serde 等价证明。
- [ ] `structure.ts:55-70` 使用 mdast+GFM；Rust `note_structure.rs:15-47` 使用 pulldown-cmark Options::all。本文核实 marker/columns/所抽 history 范围断言，但尚未穷举其余 Markdown 扩展与原始跨度（如脚注/数学），不签全部解析器等价。
- [ ] **N2**：两命令确已迁至 F3 worker（`index.ts:111-148,326-327,702-703`），原注册 Disposer 已签保持；默认 `worker-pool.ts:389-398` 120秒与 `index.ts:132-135` void close 的旧剩余限制保留。本次所审 history/lease/format/relation 仍同步调用，而 Rust `cmd/notes.rs:300-324` 为 spawn_blocking；完整非阻塞执行/取消/维护并发没有因这份草案关闭。
- [ ] **N3**：`src/trash-commands.ts:94-196` 已有原 SAVEPOINT/提交后 finish，但依然没有 Rust `cmd/notes.rs:1567-1584,1759-1775` 的完整 Lance 清理及部分失败返回；旧未决保留。反向 blob/journal 全链、工具 Agent→Chat 生命周期适配、RAG owner 等本包未逐链重验，不借 notes 全量绿灯签收。
- [ ] Linux Node 以外的 Electron、Windows/macOS 与 Rust 动态差分未在本包验证。最终 ACCEPTANCE 路径授权仍待 C2/C1 处理。

#### 命令逐入口分支审读（28/81）

路径缩写只为表格可读：**R**=`src-tauri/src/cmd/notes.rs`；**RL/RF/RR/RH/RS** 分别为 `src-tauri/crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs`、`note_format_repo.rs`、`note_relation_repo.rs`、`note_revision_repo.rs`、`note_history_restore.rs`。**I**=`host/plugins/notes/index.ts`；**L/F/Q/H/T** 分别为同插件 `repository/leases.ts`、`format.ts`、`relations.ts`、`revisions.ts`、`transaction.ts`。所有位置都是实际生产函数，不是 SPEC 自述。

公共部分：R300-324→`repository/errors.ts:53-81` 的 Conflict(key+message)/Validation(reason)/Database(Display) 分流；手工 history 四入口保 databaseStorage，不误改成统一 Validation。R327-347→I222-232 的可选 lease（缺省/null 直接 work，有值 authorized(commit=true)）；R/RL/RF/RR/RH 所读代码除 cleanup warn 外无新增 warn/error 要求。T5-19 与 RH116-134 保 SAVEPOINT 开启失败直接抛、work/RELEASE 失败尝试 rollback 并保主错误，但额外 warn 见 D005-06。以下“对应”只签列出的分支，仍受上述缺陷及未审项限制。

| 命令 | Rust → TS 入口/业务落点 | 本次逐分支核对与断言证据 |
|---|---|---|
| notes_editor_register | R350-367 / RL122-162 → I473-479 / L134-152 | live note 校验先于 INSERT；nep UUID、TTL45；有旧 lease 加 ACK，ready→pending 且 deadline=min；仅 active_lease 非null emit。测试 T03；D005-01。 |
| notes_editor_heartbeat | R368-379 / RL164-191 → I481-483 / L154-169 | participant id+webview+expires>now；续 participant45，仅未过期且非pending owner lease续30；无token→null。T04，但跨生命周期不成立。 |
| notes_editor_unregister | R380-396 / RL525-538 → I485-491 / L386-390 | 按 id+webview 删除，嵌套 cleanup；任一参与者失联取消整租约，成功后逐条 ended，不静默缩 quorum。cleanup 函数存在不等于定时/关闭调用已接，D005-01。 |
| notes_editor_begin | R397-420 / RL193-261 → I493-499 / L171-219 | 先participant，再非空operation/去重排序ids；同operation验证owner/集合后幂等；新建逐note校验存在/占用/ACK，最后要求owner在scope；任一失败回滚。T01/T05；生成ASCII note-id主路径排序相符，任意Unicode ID全序未签。 |
| notes_editor_lease_status | R421-427 / RL68-97 → I501-503 / L35-55 | 缺token null；notes按note_id、waiting按participant排序；refreshing看refreshed，否则看draft null；此函数本来不主动清过期。D005-01不能通过修改status语义掩盖。 |
| notes_editor_freeze_ack | R428-456 / RL263-298 → I505-521 / L221-249 | participant→required→phase→note→stale→同note已有draft一致→更新恰1→全部ACK后ready。stale/divergent时命令另保存点remove，先ended再原Conflict；成功changed。T02/T03；持久化draft解码D005-03。 |
| notes_editor_flush | R457-477 / RL307-361,384-436 → I523-526 / L262-303,316-350 | capabilities缺省[]；grant先写锁→owner/ready，commit=false；无draft先scope再current；有draft相同则不写，变化走capability/OCC更新；更新同note ACK基线，最终删grant/失败回滚。T01/T02/T05；D005-03。 |
| notes_editor_finish | R478-492 / RL363-380 → I528-534 / L305-313 | owned→ready，写refreshing+TTL30→required，再changed；不提前释放栅栏。T02/T06。 |
| notes_editor_refresh_ack | R493-508 / RL438-461 → I536-542 / L352-372 | participant→required→refreshing→note/token最新版本→更新恰1，required返回后changed；非owner也可ACK自己的note。T02。 |
| notes_editor_release | R509-524 / RL463-502 → I544-550 / L374-381,75-85 | owned先检查；cancel=false要求refreshing且waiting空；依次删ack/note/grant/lease，返回原notes与cancelled/released原因，随后ended。T01/T02/T06。 |
| notes_get_format | R595-626 / RF98-150 → I374-376 / F25-57 / src/command-utils.ts:36-47 | 保存点内先format后含删note；已存格式直接返回，缺format JOIN正文推断，缺note失败；flatten格式+required_capabilities+updated_at，无额外baseline null遗漏。T08/T09/T17。 |
| notes_enable_columns | R628-646 / RF294-327 → I378-387 / F140-161 | lease可选→嵌套保存点；note→OCC→supported→正文detect；已启用直接返回；否则baseline snapshot/pin、保已有baseline、能力serializer、同正文更新OCC；提交后format-changed。T09/T10。 |
| notes_migrate_blocks | R677-693 / RF234-290 → I389-395 / F107-138 | note/OCC/support/必须legacy；先blocks全校验，再只剥根marker比较原文；相等才snapshot baseline与updateWithFormat；提交后事件。保columns capability、不任意重排正文。T17。 |
| notes_relation_get | R730-743 / RR112-136 → I346-348 / Q130-160 | 缺row null，先精确i64读取，locator/type/reference返回完整snake_case/null；安全区内number、外部bigint交kernel。D005-03/04；补充v2-boundaries461-511。 |
| notes_relation_list | R744-757 / RR137-154 → I350-352 / Q163-167 | id排序→逐get，缺行略过但错误传播，无写/事件；继承get缺陷，不用列表绿灯签locator解码。 |
| notes_relation_put | R874-887 / RR155-196 → I354-356 / Q169-209 | id trim→relation/locator配对→owner正文→可选owner block→目标存在→Some revision CAS或None INSERT DO NOTHING→changes=1→回读；原保存点，回读REAL溢出失败回滚。T18/T19；已签精确CAS保持，D005-03/04仍开。 |
| notes_relation_delete | R888-898 / RR197-206 → I358-360 / Q211-216 | 原id+revision DELETE，非1 Conflict、1 true，无新增事务/事件/日志；接受合法负i64而非safe-only拒绝。T07/T18。 |
| notes_reference_status | R899-913 / RR71-110 → I362-364 / Q64-115 | card用Anki连接查document_tasks/anki_cards及双墓碑；其它先resource与源实体墓碑过滤；whole=true、block须note且解析失败false、page>0与page_count、question关联live题。T18/T19；全SQL故障矩阵未跑。 |
| notes_invalidate_resource_refs | R914-923 / RR207-210 → I366-368 / Q218-223 | 仅resource相等且未invalidated行更新时间/置失效/revision+1，返回changes；不另加读取/事务/事件。T07/T19；此写本就不执行回读溢出检查，不把put的保证外推。 |
| notes_history_current | R926-932 / RS35-38 → I397-398 / H396-402 | JOIN资源、排软删，缺行Validation Current note missing or deleted，完整正文/title/updated_at；不自动snapshot/pin。T12/T14。 |
| notes_history_get_retention | R934-940 / RS40-51 → I412-413 / H480-484 | 唯一id=1读两个字段，无行/SQL错误传播，不造默认行；当前默认300/100由迁移提供。T15；异常大持久化整数尚未全审。 |
| notes_history_set_retention | R941-950 / RS53-72 → I415-420 / H404-414 | max=0→null；interval0..86400/budget1..100000校验；只更新policy+纳秒UTC，不立即裁历史，不自开事务。T15。 |
| notes_history_list | R1002-1029 / RH245-287 → I400-402 / H120-130,264-271 | cursor缺省null、limit30、pinnedOnly false；clamp1..100、多读1、seq DESC与严格<、末页null；safeIntegers保持next_cursor内部精度，字节长度别名正确。T12/T15与history-boundaries35-53；返回摘要不加载正文。 |
| notes_history_get | R1032-1051 / RH290-316 → I404-406 / H273-289 | note_id+version_id精确查找，missing/pruned错误不回退current；tags先于props再assets，get不pin/不写。tags typed已修；props及assets分别D005-02/03。history-boundaries76-112。 |
| notes_history_set_pinned | R1054-1074 / RH321-338 → I408-410 / H291-297 | 保存点先get全部解码后UPDATE；只返回9字段summary+新pinned，不泄漏content等字段，失败pin不变。T07/T15、history-boundaries20-33,90-101；D005-02/03。 |
| notes_history_restore_copy | R1077-1103 / RH361-435 → I422-428 / H307-336 | 精确get+pin→supported/selection→当前snapshot/pin→唯一标题(450字符+历史副本)→root创建/格式/props→删中间历史/清日志→新restore_copy来源；成功window定向created。T11/T13；D005-02/03/N5。 |
| notes_history_restore_selection_copy | R952-970 / RH365-435 / RS84-159 → I430-436 / H311-393 | 同copy，但命令采用noteStorage；格式/正文一致后校验行范围，完整document快返，否则不切根block/list/code/columns；带marker整体，引用定义要求全选；提交后created。T11/T13。 |
| notes_history_restore_current | R972-999 / RS161-217 → I438-444 / H416-443 | live/OCC在source pin前；当前format与正文detect→get+pin source→selection→before snapshot/pin→精确MAX(seq)→正文/title/tags/format→props→删除新中间seq→清日志→restore_current新ID，window updated在成功后发。T12/T14及history-boundaries55-73；D005-02会改写props，N5仍开。 |

#### TESTMAP 逐条真实性审读（19/134 ported；另查 MFJS pending）

已完整阅读下列 Rust 测试函数和对应 TS 用例，不以名字/expect 数量代替语义。Rust 根 **V**=`src-tauri/crates/dstu-vfs/src/vfs/repos/`，TS 根 **P**=`host/plugins/notes/tests/`。下表 T 编号仅本文引用，不修改原 TESTMAP ID。

生产链证据：I473-550→L（lease）；I374-395→F→`src/structure.ts:73-154`（format/columns）；I397-444→H（history）；I346-368→Q（relation）；I446-459→`repository/transfer.ts:129-211`（transfer）。各 fixture 安装真实 paths/vfsRepos/notes（lease:22-32、columns:23-33、history-integration:20-30、storage:26-35），不再使用旧自写 L11 SQL 替身。测试大多直接调用真实仓储而非 invoke，故“生产可达”不等于每条都是完整 IPC 端到端。

| 编号 / Rust 原 ID（V前缀） | TS 对应（P前缀） | 原断言逐项对应、结论 |
|---|---|---|
| T01 `note_lease_tests.rs::pending_fences_repo_raw_sql_and_other_connection_and_preserves_history` :49-88 | `note-lease.test.ts:86-101` | edit/raw资源/raw标题/delete/purge/未ready flush均失败；正文Before、history1、release后旧auth拒绝及普通edit成功均保留。但原other连接消失，**D005-05，不通过完整映射**。 |
| T02 `note_lease_tests.rs::unanimous_drafts_flush_once_commit_and_hold_until_all_refresh` :91-140 | `note-lease.test.ts:103-126` | 首ACK pending、全ACK ready、dirty须flush、peer不可写、第二flush时间不变、正常commit、非协调写/提前release/旧refresh拒绝，双方refresh后release及edit成功，全部对应。 |
| T03 `note_lease_tests.rs::late_registration_reopens_barrier_and_divergent_or_stale_ack_cannot_authorize` :143-177 | `note-lease.test.ts:128-142` | late→pending、flush失败、错webview/divergent/stale三ACK失败、authorized失败、正文Before，全部对应；只证明仓储屏障，不证明命令冲突取消事件。 |
| T04 `note_lease_tests.rs::heartbeat_does_not_extend_pending_deadline_and_close_cancels_whole_lease` :180-212 | `note-lease.test.ts:144-159` | 131清理1/status空；window=b清理1、b heartbeat失败/status空；webview=a清理1/status空，原7项对应。但测试手调cleanup，不能关闭D005-01的生产调度缺失。 |
| T05 `note_lease_tests.rs::sorted_multi_note_acquisition_rolls_back_on_overlap_and_grants_rollback_on_failure` :215-268 | `note-lease.test.ts:161-174` | overlap失败、lease_notes仅1；越scope授权写失败、grant0、phase ready、第二页Before，全部对应。 |
| T06 `note_lease_tests.rs::authorized_multi_step_writes_advance_the_frozen_baseline` :271-295 | `note-lease.test.ts:176-187` | 两次授权连续写成功、正文Step two；finish/refresh/release成功，原流程与断言对应。 |
| T07 `note_lease_tests.rs::relationship_logs_and_pin_backfill_use_row_sync_identity_and_replay_suppression` :298-348 | `note-lease.test.ts:189-220` | pin待上传UPDATE1、重放标记后待上传0、迁移SQL连跑2次relation/revision各补1、delete日志1，全部对应。测试读原SQL文件，不是重写触发器算法。 |
| T08 `note_columns_tests.rs::columns_are_one_root_node_and_fenced_escaped_quoted_examples_are_literals` :28-58 | `note-columns.test.ts:56-80` | 根3/首columns、stable块1/id/结束符；围栏/转义/quote三literal非columns；未来版/缺尾/嵌套/第三列四malformed失败，逐向量对应。 |
| T09 `note_columns_tests.rs::enabling_columns_is_lossless_pins_baseline_and_demands_capable_cas_saves` :61-139 | `note-columns.test.ts:82-106` | capability不等于opt-in；OCC变/正文不变/serializer/初版baseline/pin；旧writer与旧OCC失败；新能力+OCC正文COLUMNS成功，全部对应。 |
| T10 `note_columns_tests.rs::stable_columns_transfer_requires_both_page_optins_and_moves_entire_container_atomically` :142-206 | `note-columns.test.ts:108-137` | source serializer；target未opt-in失败且source不变；篡改失败；move两正文精确；undo恢复source，全部对应。只签原断言，不称该测试注入所有SQL故障。 |
| T11 `note_columns_tests.rs::history_selection_cannot_cut_column_containers_and_full_restore_preserves_capability` :209-241 | `note-columns.test.ts:139-146` | 5..7部分列拒绝，copy正文完整COLUMNS、serializer保columns能力，三原断言对应。 |
| T12 `note_history_integration_tests.rs::current_restore_cas_preserves_live_and_source_and_restores_full_envelope` :33-115 | `note-history-integration.test.ts:61-84` | current时间/title/正文；stale拒绝且source未pin；成功新OCC/props null/原正文；source和另一版本pin、provenance、当前资产仍被引用、旧live provenance null，13项对应。小props用例不能覆盖D005-02。 |
| T13 `note_history_integration_tests.rs::selection_rejects_partial_code_list_and_markers_and_copies_complete_nodes` :118-181 | `note-history-integration.test.ts:86-101` | 部分code/list两失败、完整code精确copy/源不变、单独body无marker失败/完整marker+body精确返回，共6项对应。 |
| T14 `note_history_integration_tests.rs::selected_restore_replaces_whole_current_body_and_failed_history_rolls_back_everything` :184-230 | `note-history-integration.test.ts:103-122` | 选Second替换整正文；restore_current历史INSERT触发器失败；正文/updated_at/history count全回滚，全部对应；额外finally删测试trigger只清fixture。 |
| T15 `note_history_integration_tests.rs::retention_is_persistent_deferred_and_controls_coalescing_and_budget` :233-307 | `note-history-integration.test.ts:151-175` | 默认policy、设置后可读、history5/改policy不裁5/下次edit后3、同bucket旧版消失、悬空待上传日志0、pin仍保留，数值断言齐；但所谓other是同一cached handle，**D005-05，不通过完整映射**。 |
| T16 `note_history_integration_tests.rs::v20260923_backfills_existing_versions_by_identity_and_logs_only_immutable_inserts` :310-352 | `note-history-integration.test.ts:124-149` | 原旧schema fixture与同一生产migration SQL；运行两次补旧id一次，新版本insert日志1、pin/delete不记非insert日志、format update1，四断言对应。属 F3 生产迁移SQL验证，不冒称notes命令测试。 |
| T17 `note_storage_tests.rs::migration_is_explicit_lossless_and_baseline_is_retained` :236-300 | `note-storage.test.ts:191-204` | 普通save不能隐式升格、迁移改正文拒绝、成功blocks与原baseline全文、去marker拒绝、future99拒绝且OCC未变，七断言对应。 |
| T18 `note_storage_tests.rs::relationships_follow_note_resource_replacement_and_invalidate_deleted_blocks` :371-422 | `note-storage.test.ts:227-247` | 初locator存在；resource变后retarget/未invalidated/locator仍真；旧revision删拒绝；移除block后失效且locator false，新revision可删，八断言对应。 |
| T19 `note_storage_tests.rs::anki_reference_uses_real_card_and_document_rows_and_observes_deletion` :440-497 | `note-storage.test.ts:263-287` | 原独立Anki内存两表fixture照搬数据形状；正确card可引用、错document不可引用、卡墓碑后resource真/locator假、invalidate1/失效时间非null，六断言对应。测试查询真实生产Q，不复制业务；仅两表最小SQL fixture，非完整L16插件链。 |

抽样结论：**17 条所列原断言/场景对应，2 条第二连接场景缺失**；17 不表示相关命令全域通过。T16 的实际生产资源为 F3 migration（`host/platform/storage/migration/definitions/vfs.ts` 中 `V20260923__note_history_integration.sql`），T07亦复用正式 `V20260924__note_editor_leases.sql`。MFJS pending 原测试全文与清理断言已另读：rewrites>0、8类banned、anyOf sibling、bare enum、update-list keys=['anyOf']虽保留，但被测normalizer为测试副本，**不计第20条 ported，也不计通过**。

#### 架构、数据边界、日志与清理结论

- 已核实 notes 服务名符合 `docs/plugins/ARCHITECTURE.md:120`；`index.ts:95-110,181-193` 真实注入/提供。所审 SQL 的 `note_editor_*`、`note_document_*`、`note_learning_relations` 为 notes 自有，relation 对 resources/files/exam/questions/Anki只读；`__change_log` 写入是明确例外缺陷 N5。跨插件生产 import 使用 vfs-repos/api、storage/api；本包未为普通 repository 同插件调用制造“跨插件”误报。
- Lease TTL是纪元秒，Rust `RL58-60` 对 TS `L23-25` 的 Date.now()/1000 合适，不机械换单调时钟；UUID simple 前缀与字段null形状对应。lease expiry/format_version全部i64极限仍留未审，不用普通时间值证明全域精度。
- `H120-130,264-271,427-439` 已保分页和恢复高水位精确seq；`Q130-144` 已保relation精确revision及REAL回读失败。上述正确部分不掩盖历史props内部parse丢位；输出投影应仅在kernel边界发生。
- `T5-19` 覆盖成功、work抛错、RELEASE抛错的保存点清理，grant在同保存点内写/删；不像仅在happy-path删grant。D005-06为额外日志，而非主错误被覆盖。D005-01为调度/生命周期缺失，而非cleanup SQL本身缺失。
- 旧签收 N1/state、relation i64、N4真实L11 fixture、N5六面消费、tags JsonReader、注册Disposer均保持其原限定范围。本包未沿用历史“尚未main/仍双写resources/仍用test-vfs-repos”的过时结论；LANE/SPEC/TESTMAP中若干旧自述与当前基线不一致，已在此报告纠正，因唯一写入授权未越界修改它们。

#### 已核实通过（仅下列范围）

- [x] 28条入口均沿契约Rust来源定位到真实index handler与仓储，没有用注册数代替分支审读。
- [x] 所抽19条映射逐一读取原Rust函数与TS全文，17条上述断言/场景保留；两个第二连接缺口单列未签。
- [x] MFJS仍是副本、当前行已pending、L02实现存在但缺公开出口三个事实均独立核实，不混淆为“仍ported”或“normalizer未实现”。
- [x] importable与wiring独立作业通过；wiring模块可达0缺失不抵消D005-01的具体生命周期调用缺失，也不认证MFJS。
- [ ] 发现项修复后由独立复核者按原输入/事务/日志复验；未审53命令、115映射及平台范围完成前，不签全域。

### 本包独立运行原件（仅本次，不借历史或供方绿灯）

所有运行经绝对共享 `node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- ...`，cwd均为本lane。原始 `.json` 保完整命令/argv，`.log` 保输出；位置 `/home/dsdev/.oc-jobs/done/<job>.{json,log}`。原命令未接tail管道、未调超时或测试条件。

| job | 实际命令 / 原始结果 |
|---|---|
| `20261105140012-c833de` | 请求 `npx tsc -p tsconfig.host.json --noEmit`；队列规范化为附加 `--incremental --tsBuildInfoFile .lane.tsbuildinfo`。无诊断，exit0。 |
| `20261105140028-8552ec` | `node scripts/electron-migration/importable.mjs host/plugins/notes/index.ts`：`importable: ok`，exit0。 |
| `20261105140028-6c10b9` | `node scripts/electron-migration/wiring.mjs --lane notes`：`合计 ported 134，其中所测模块未从 index.ts 接入 0（0.0%）`，exit0。 |
| `20261105140012-ec2ab9` | `npx vitest run -c vitest.host.config.ts host/plugins/notes`：**31 files passed，293 passed / 0 failed / 0 skipped，227.01s，exit0**。无Errors/Unhandled段；有WASI ExperimentalWarning。19个抽样原名用例均实际执行，仍不能弥补D005-05场景缺失。 |
| `20261105140624-72b3b0` | `node --input-type=module -e <原件json内完整源码>`：**8个诊断场景复现 / 0失败 / 0跳过，exit0**，无Errors/Unhandled段。断言观察到的偏差，**不是8个Rust等价通过**。 |
| `20261105141900-a6fcbb` | `node --input-type=module -e <原件json内完整源码>`：真实 `host.invoke` 主流程 **28/28 命令名通过（count 28, entryFlows passed）**；随后附加的 relation 错误顺序诊断在 fixture 准备阶段失败：`StorageError: CHECK constraint failed: relation_type IN ('source','card','mistake')`，**进程 exit1**。故最终摘要行未打印：入口主流程 28 passed / 0 failed / 0 skipped，错误顺序诊断 0 复现 / 1 fixture 失败（不是被测代码失败）。 |

整目录原始摘要：

```text
 Test Files  31 passed (31)
      Tests  293 passed (293)
   Duration  227.01s (transform 19.48s, setup 0ms, collect 130.51s, tests 509.71s, environment 46ms, prepare 9.62s)
[作业 20261105140012-ec2ab9] 退出码 0
```

诊断原输出（来自真实kernel+notes+L11+生产SQLite，未复制被测逻辑）：

```jsonl
{"id":"close-lifecycle","leaseRemains":true,"writeBlocked":true,"endedEvents":0}
{"id":"startup-lifecycle","leaseRemains":true,"writeBlocked":true}
{"id":"frozen-draft-deny-unknown","unexpectedFieldAccepted":true}
{"id":"locator-float","stored":"{\"type\":\"page\",\"value\":1.0}","accepted":{"type":"page","value":1}}
{"id":"locator-duplicate","duplicateTypeAccepted":true}
{"id":"asset-ref-struct-sequence","actual":{"error_type":"Database","message":"Serialization error: invalid type: sequence, expected struct NoteAssetRef","details":null}}
{"id":"history-internal-props","actual":{"n":9007199254740992},"actualType":"number","expectedInteger":"9007199254740993"}
{"id":"history-restore-props","persisted":"{\"n\":9007199254740992}","expected":"{\"n\":9007199254740993}"}
```

该诊断只在 `/tmp/opencode/WP-C2-D1-005-*` 新建隔离数据并 finally 清理；SQL仅准备持久化边界fixture。先通过register/begin，再发送kernel的window destroyed；重装是同Node进程中await host.dispose/关storage后新建Host并打开同库，不冒称真实Electron进程重启或已经等待5秒TTL。启动/定时/页面完整接线缺失另有上述全host/electron与Rust源码证据。props最后一步通过真实 `notes_history_restore_current` 并读取 notes.props 原文，故不只是wire舍入观察。Rust期望来自源码，没有运行Rust。

为补齐原19测试多为直接仓储调用的证据层级，另跑 `20261105141900-a6fcbb`：28条命令经真实 `host.invoke`（含双窗口ACK、格式升格、关系写删、历史恢复）全部到达生产入口并通过断言，原输出 `{"count":28,"entryFlows":"passed"}`。这只证明主路径可达，不覆盖 D005-01～06 的偏差分支。同一作业的 relation 错误顺序诊断因 `UPDATE ... relation_type='future'` 被表 CHECK 拒绝而未执行；Rust `src-tauri/migrations/vfs/V20260922__note_storage_foundations.sql:43` 有同一 CHECK，因此 D005-04 只在绕过约束的损坏/外部写入数据上可触发，仍按源码审读保留、未经运行复现，严重度相应下调为低。最终报告提交后正常merge main，再执行共享绝对lane-gate；实际tip/base/job/exit以交付报告和原selfgate receipt为准，最终gate后不追加文档改变被测tip。

<!-- END WP-C2-D1-005 NOTES ACCEPTANCE DRAFT -->
