# 迁移质量规范（来自 2026-11-03 第一次抽检）

4 名独立审查者逐行对照 Rust 与 TS，抽查了 12 条 lane。总体情况：主路径大多等价，例如检索规划、FSRS 打分、
笔记租约、Anthropic 流解析、WebDAV 重试，测试也有不少比 Rust 更严格。但下面这些问题反复出现。
**所有 lane 必须按本规范自查已提交的代码，并在后续工作中遵守。** 审查会持续进行。


> **2026-11-04 起以 [质量标准 v2](standard-v2.md) 为准**（八类硬规则、命令完成清单、角色分工、机械门禁）；本文件与之冲突的条目以 v2 为准。

## 一、等价性：最常见的 7 类偏差

1. **Rust 库的隐式默认行为被丢掉。** 用手写代码替换 crate 时，要把它的默认行为一并实现：
   - aws-sdk 的标准重试：3 次，对 5xx、限流、瞬时 IO 错误退避；
   - reqwest 默认跟随重定向，最多 10 次；
   - tokio 的 `kill_on_drop`，以及 close stdin → 等待 → SIGTERM → 等待 → SIGKILL 的分步关闭；
   - chrono 的 `to_rfc3339`：小数位按 AutoSi 变长，时区写 `+00:00`。
   **替换一个 crate 前，先读它的默认配置和 Drop 行为。**
2. **把 Node 的异步当成 Rust 的同步。** `spawn` 的 ENOENT、子进程 `exit`/`close`、流结束都是异步事件。
   Rust 中同步返回的错误，TS 必须在返回前等到对应事件再判断；所有等待都要有超时兜底。
3. **"warn 后继续"被改成了"抛异常"。** Rust 里 `if let Err(e) = … { warn!(…) }` 这类尽力而为的副作用
   （标记索引、追加 block id、写 outbox 等），TS 也只能记日志后继续，不能让整个操作失败。反过来同理：
   Rust 用 `?` 传播的错误，TS 不能吞掉。
4. **事务边界和提交后副作用错位。** Rust 在 `tx.commit()` **之后**才做的事（取消令牌、发事件、通知），
   不能挪到 `db.transaction(...)` 闭包里面。Rust 有 `BEGIN IMMEDIATE`/`SAVEPOINT` 的地方，TS 必须有对应事务。
5. **错误文案被扁平化。** Rust 按步骤给出的不同错误上下文（"Failed to start …"、"… commit …"），以及
   `{e}` 中库错误的具体 Display 文本（base64、utf8、rusqlite、DNS 与传输错误的区分），都必须保留，
   不能合并成一句笼统的话，更不能改成别的含义（例如把 DNS 失败报成"内网地址被拦截"）。
6. **Rust crate 语义被当成 JS 内置语义。**
   - **正则**：Rust `regex` 与 JS `RegExp` 的方言不同。Rust 支持 `(?i)` 内联标志，替换语法是 `$name`/`${1}`；
     `\w`、`\d`、`\b` 默认匹配 Unicode；不支持环视和反向引用。**用户或 AI 提供的正则一律走 F7 提供的
     Rust-regex wasm 引擎**（`nativeRegex`，与 starlark 同一个 wasm 产物），不要用 `new RegExp` 处理。
     代码内部的固定正则，要确认它在两种方言下语义一致，必要时加 `u` 标志。
   - **字符串**：Rust 的 `trim`、`chars()`、`len()` 按 Unicode/UTF-8 字节计算，用平台共享的实现，不要各自手写。
   - **数值**：超过 2^53 的整数（ID、HLC、大小）不能经过 `Number()`。`saturating_sub` 可能为负，
     不要擅自 `Math.max(0, …)`。
7. **静默的部分移植。** 命令或工具已经注册，但其中依赖其他 lane 的步骤被悄悄省略了，例如 LLM 规划、
   立即索引、Super 会话钩子。规则：**某个步骤做不到，就不要注册这个命令**；或者调用对方 `api.ts`
   中的接口（没有就写最小接口，测试中用替身），绝不能悄悄降级。

## 二、架构

1. **不要复制别的 lane 的 Rust 逻辑。** 要用别人的表或逻辑（笔记创建、资源 create_or_reuse、索引状态、
   `notes.deleted_at`），只能通过对方的 `api.ts`。自己再实现一份，一定会丢掉对方的事务和钩子
   （已经造成数据完整性问题）。每张表只有一个写入方。
2. **通用工具只能有一份**，放在平台层（由 F4 发布）：
   - `host/platform/time`：chrono 兼容的 rfc3339 格式化与解析、单一时刻取值。
     目前散落着约 20 份手写实现，小数位长度不一。
   - `host/platform/util`：Rust 兼容的 trim、UTF-8 长度、截断、HTTP 状态短语、zip 与 CRC32。
   - `host/platform/net-policy`：对应 `dstu-core/src/net_policy.rs` 的 IP/SSRF 判定。目前有 3–4 份拷贝。
   - `host/platform/storage/feature-flags`：browser 中有一份重复实现。
   平台模块发布后，各 lane 必须删掉本地拷贝，改为引用平台模块。
3. **日志统一走 `ctx.log` / Cordis logger，不要用 `console.*`。** Rust 的 tracing 会写进日志文件，
   前端的调试日志命令要读这些文件。
4. **`index.ts` 只做接线。** 业务逻辑放在 `src/`，SQL 放在 `repository/`。单个文件超过约 800 行就按职责拆分。
5. **服务要真正提供出去。** `api.ts` 中声明的服务，必须在 `meta.provides` 里出现，并在运行时 `provide`，
   否则移植好的代码在应用里没有消费方。

## 三、测试

1. **测试必须走生产代码路径。** 以下都不算移植：
   - 断言测试自己构造的对象字面量；
   - 断言 `Math.min(...)` 之类的算式本身；
   - 只测试 JS 内置函数，例如 `String.replace`；
   - 用 `source.toContain` 去 grep 源码；
   - 把被测逻辑本身 stub 掉，例如 `vi.stubGlobal('fetch')` 后就不再测错误分类。
2. **涉及 Drop、锁、竞态、超时的 Rust 测试，TS 测试必须验证同样的保证**，例如锁已释放、取消已传播、
   超时后一定结束，不能只比对返回值。
3. **只有对应的生产代码已经接入（命令已注册或服务已提供）时，TESTMAP 才能标 `ported:`。**
   测试文件存在、生产代码却没有任何调用方的，标 `pending` 并注明原因。
4. TESTMAP 的表头统计和行状态必须与实际测试文件保持同步。

## 四、门禁

1. **不得规避扫描器**，例如拆字符串躲过 TODO 检测，或者用 `catch (e) { void e }` 冒充非空 catch。
   确实需要豁免时，用 `// boundary-allow <rule>: <理由>`，理由要说得出来。
2. **不要滥用 `boundary-allow`**：本来就在 `repository/` 里的 SQL 不需要豁免。

## 五、补充：源码锁定类测试（source-lock）

Rust 中有一类测试本身就是在断言源码或文档文本（例如"某函数已删除""某模块零生产接线""前端常量为某值"）。
它们**不能直接标 obsolete**，要按被锁定的对象处理：
- **锁定前端（`src/`）或用户文档文本的**：前端和文档原样保留，被锁定的事实依然成立。用 TS 测试做同样的
  源码/文档断言即可，这种情况下 `source.toContain` 是等价移植（被测对象就是源码本身）。
- **锁定 Rust 源码的**：把它表达的**不变量**迁到 TS 实现上验证。例如"delta 模块零生产接线、上传仍是整 ZIP"
  → 断言 TS 同步引擎上传整 ZIP、未接入 delta；"事务内重读业务行"→ 用行为测试断言 TS 实现在事务内重读；
  "已删除的 API 不存在"→ 断言 TS 插件没有导出或注册对应接口。
- **只对移动端（content:// / SAF / Android）有意义的**：可以标 `obsolete:mobile-only`，附 cfg 或调用路径证据，由协调者批准。

## 六、补充：用成熟库对齐 Rust crate，不要手写替代

Rust 使用的 crate 若有同源或公认等价的 npm 库（例如 aws-sdk-s3 → `@aws-sdk/client-s3`，标准重试和签名语义同源），
**在报告中申请安装，由协调者安装**，不要为了绕开"不能改 package.json"而手写替代实现。手写会丢掉库的隐式默认行为
（第一节第 1 条），这是抽检中高风险问题的主要来源之一。没有等价库时才手写，并逐项实现原 crate 的默认行为。

## 七、补充（第二次抽检）：Rust 的 `warn!`/`error!` 不能静默丢弃

Rust 中 `if let Err(e) = … { warn!(…) }`、`let _ = …` 搭配日志的位置，TS 必须**记录同样的日志**（经 `ctx.log` /
插件 logger；仓储函数通过参数接收 logger），然后继续执行。`catch { void 0; }`、`catch (e) { void e; }`
会把日志一起丢掉，和空 catch 等价，按规避扫描处理。`boundary-allow` 中写的理由必须属实
（例如"Rust 仅 warn"，那就必须真的记录这条 warn）。

strict 边界检查（`npm run migration:boundaries:strict`）现在会拦截：生产代码中的 `console.*`，以及只含 `void …` 的 catch。
**两小时后（2026-11-03 17:00 UTC）strict 将成为合入 main 的默认门禁**，请在此之前清零本 lane 的 strict 违规。

## 八、补充：Rust 中本身就是死代码的模块

被测模块在 Rust 中**本身没有生产调用方**（例如文件头注明"当前未被使用"，或只被 `mod.rs` 重导出、全仓没有使用者），
这样的测试可以标 `obsolete:dead-in-rust <证据：文件:行 或检索结论>`，由协调者核实后批准。
这类模块不迁移、不接线：迁移死代码只会增加维护负担。被其他 lane 的生产代码调用的模块不属于此类，
只是对方还没移植调用点而已，应保持 pending 并注明"待 Lxx 接入"。

## 九、补充：只用可擦除的 TS 语法（硬门禁）

Host 用 Node 原生类型擦除运行 `.ts`（不经编译），**不支持**构造函数参数属性（`constructor(private x: T)`）、
非 declare 的 `enum`、带实现的 `namespace`。tsc 和 vitest 都会自行编译 TS，所以测试全绿也发现不了——
2026-11-03 曾因 60 个文件使用参数属性导致**整个 Host 无法启动**。现在边界检查的 `erasable-syntax` 规则
和集成门禁的运行时可导入检查会直接拦截。写法：字段显式声明并在构造函数中赋值；枚举用 `as const` 对象 + 同名类型。

## 十、补充（独立复核 R1–R5 与协调者汇总的共性问题）

独立验收人在多条"已完成"的 lane 中发现了下列问题。它们是 B 级不成立的主要原因，所有 lane 自查并避免：

1. **测试必须测生产代码**：测试里不得重写被测算法、不得用自写函数冒充生产链路（如自写 apply 代替真实同步管线）、不得用 `*Double` 代替本 lane 自己应实现的业务主体后把相关测试计为 ported。被测行为必须经生产入口（插件注册的命令或公开服务）可达。
2. **不弱化、不反转断言**：错误类型、精确错误文案、feature-off 的预期等必须与 Rust 测试一致；做不到就保持 pending 并写明原因。
3. **单写者**：不得直接写别人拥有的表；需要跨插件原子操作时按 decisions.md D1 的 `*WithConn` 接缝。
4. **错误必须传到前端**：业务 `Err` 不得变成未捕获异常或永不 settle 的 Promise；命令边界按 Rust 的 `Result` → AppError 形状返回。
5. **保留 Rust 日志**：`warn!`/`error!` 对应位置必须有日志（见第七节）。
6. **测试结果如实报告**：报告必须保留测试运行器的**退出码与 Errors 行**（`Tests N passed` 但 `Errors 1` / exit 1 不算通过），不得用 `tail` 截掉。
7. **"接口存在于某分支" ≠ "main 可消费"**：声称阻塞解除或接入完成，必须以 main（或已合入 main 的提交）为准；只在别人分支上的接口，写明分支与提交，等集成。
8. **平台条件跳过要与 Rust 一致**：Rust 用 `cfg(target_os)`/`#[ignore]` 的，TS 用同等条件 `skipIf`；不能因为当前机器跑不了就删测试或标完成；未在目标平台验证的能力如实标注"未验证"。
9. **"同样能用"不等于等价**：QR mask、图片编码、优化器、PDF 引擎等，以 Rust 行为为准；有差异就记录证据与容差，交协调者/架构师裁定，不得凭 SPEC 自述签收。

## 十一、补充：重任务走全局作业队列，排队时做不占 CPU 的事

几十个 agent 同时跑类型检查/测试/构建会把 CPU 打满、互相拖慢。规则：
1. tsc、vitest、vite build 等重 CPU 命令经 `scripts/electron-migration/jobs/job.mjs submit -- <命令>` 提交，不直接运行。执行器（ds-jobs.service）按类别限流、按 lane 公平轮转、按 CPU 压力自适应，集成门禁运行时自动让路；同目录同命令自动去重；tsc 自动增量编译。
2. 提交后去做不占 CPU 的工作（对照 Rust 审读、补 TESTMAP/SPEC、核对接口、写报告），稍后 `job.mjs result <作业号>` 取结果；无事可做才 `wait`。
3. 测试只跑自己负责的目录或单个文件。
4. 报告贴作业号与 `job.mjs result` 给出的退出码。
