# W13 G3 差分录制管线修复：进度

分支 `assault/W13-g3-pipeline`，worktree `wt/W13`。中断后从“下一步”续上。

## 当前状态

- [x] 根因调查（服务器只读取证，见下文）
- [x] 同步冻结分支 `ops/g3-night-frozen`（`811c441e8`）的 `g3-batch.mjs` 改动：6 worker 上限、准入控制、PID namespace、`RECORDING.json`（`c4c6151`）
- [x] 复现测试（进程夹具；未修代码上 4 条挂死、6 条失败）（`de1bf89` 抽取、`c6e3084` 红测试）
- [x] 进程生命周期修复（`cd93285`）；`g3-batch` 端到端测试、namespace init 的 PID 1 守卫（`b3565af`）
- [x] 证据可追溯：`RECORDING.json` v2、Host 回执、worker 回执、manifest 封存、报告门禁（`7555300`）
- [x] 参数化托管运行器 `g3-supervise.mjs`（`dd5cf51`）
- [x] 服务器运行手册 `G3-RECORDING-RUNBOOK.md`（`e72fcf0`）
- [x] 收尾测试（`5cec5ba`）：`npx vitest run -c vitest.host.config.ts host/e2e/differential` 9/9 文件通过（连续 3 次）；
  `node --test host/e2e/differential/*.test.mjs` 55 个用例：51 通过、0 失败、4 跳过（Linux PID namespace 用例，需在服务器上跑，见手册 §1.4）。
  本机测试时临时放了 X7 的 `normalize-approvals.json`（未提交，已删除）。
  顺带修正了 X7 遗留的 `g3-normalize.test.ts` 计数（`.mjs` 有 4 个用例，包装仍写 `pass 3`，与任何绿灯结果都不符）。
- [x] 第二轮：`host/platform/serde-compat` 与 `scripts/serde-audit` 审计报告，见文末“第二轮”。

## 根因结论（证据均为服务器只读取证，2026-11-07 02:45 前后）

### 1. A/A2 挂起：`xvfb-run` 成为 PID namespace 的 1 号进程，永远等不到 Xvfb 的就绪信号

- 冻结提交 `811c441e8` 把 worker 包装从 `unshare -rn bash -c 'ip link set lo up && exec "$@"'`
  改成 `unshare -rnpf --mount-proc --kill-child bash -c '... && exec "$@"'`。`unshare -f` 的子进程在
  新 PID namespace 里是 PID 1，bash 再 `exec` 成 A 侧命令链的第一个程序 `xvfb-run`，于是 `xvfb-run` 是 PID 1。
- `xvfb-run`（Debian 12，xvfb 2:21.1.7-3+deb12u12）的启动握手：`trap : USR1`，后台启动 Xvfb 并忽略 USR1，
  然后 `wait`，等 Xvfb 用 SIGUSR1 通知就绪（`/usr/bin/xvfb-run:162-168`）。
- Xvfb 只在父进程 PID 大于 1 时才发 SIGUSR1（xorg-server 21.1.7 `os/connection.c:209-212`：
  `if (RunFromSmartParent) { if (ParentProcess > 1) { kill(ParentProcess, SIGUSR1); } }`）。
  父进程是 PID 1，信号不发，`xvfb-run` 永远阻塞在 `wait`，根本没走到 `dbus-run-session` / `node g3-run-a.mjs` / Tauri。
- B 侧命令链不经过 `xvfb-run`，所以同一个包装下 B 正常完成（smoke 的 B `host.stderr.log` 里 Host 是 `(node:14)`，确认 PID namespace 生效）。
- 证据：
  - `/home/dsdev/ops-night/g3-smoke/logs/A`、`logs/A2` 是空目录：`g3-batch` 只在收到数据时才 `appendFileSync` 日志，A/A2 从未输出过一个字节。
  - 没有 `g3-smoke/A`、`g3-smoke/A2` 目录：`g3-run-a.mjs` 校验完构建回执后第一件事就是建输出目录，说明 node 从未运行到这里。
  - `journalctl -u ds-g3-smoke2.service`：01:07:32 停止时 batch 以 143 退出，但 90 秒后 systemd 仍要 SIGKILL 残留进程，
    只有 `unshare`、`xvfb-run`、`Xvfb` 三种（各两组，对应 A 和 A2），**没有** `dbus-run-session`、`node`、Tauri 进程。
  - 两个残留 Xvfb 的 PID（3701349、3701352）比 batch（3675414）晚约 2.6 万号，是 SIGTERM 杀掉原 Xvfb 后
    `xvfb-run -a` 的重试循环（`xvfb-run:169-174`，最多 10 次）新拉起的。
- 旧的 42 worker 批跑用的是 `unshare -rn`（没有 `-p`），`xvfb-run` 不是 PID 1，所以当时 A 侧能跑。
- 本机 Docker（colima 磁盘在外置卷，I/O 错误）不可用，没能在本机 Linux 容器里复现；服务器验证步骤见手册 §1.4。

### 2. 挂起后无法停止：每一层都吞掉 SIGTERM，batch 本身没有超时也不升级信号

- 外层 `unshare --fork`：util-linux 2.38.1 在等待子进程期间屏蔽 SIGINT/SIGTERM（`sys-utils/unshare.c:950-955, 985-987`）。
- `xvfb-run` 作为 namespace init：内核只把“init 装了处理函数”的信号从祖先 namespace 投递给它；它只 trap 了 USR1 和 EXIT，SIGTERM 被丢弃。
- Xvfb 收到 SIGTERM 会退出，但 `xvfb-run -a` 立刻换显示号重启它。
- `g3-batch.mjs`：`run()` 只等 `close`，没有任何超时；`--deadline-min` 只是不再开新分片；
  SIGTERM 处理是给进程组发一次 SIGTERM 后立刻 `process.exit(143)`，不等待、不升级 SIGKILL，留下孤儿。
- 只有对外层 `unshare` 发 SIGKILL 才能收掉整个 namespace：`--kill-child` 给 namespace init 设了 `PR_SET_PDEATHSIG`（`unshare.c:1010`）。

### 3. 潜在的第二处挂死（smoke 没走到，但代码里确实存在，已用夹具复现）

- `g3-run-a.mjs` 的 `finally`：`child.kill('SIGTERM')` 后无限期 `await exited`；`await logsClosed` 在 Tauri 退出后若 WebKit 子进程仍持有管道会永远卡住。
- `process.mjs` 的 `JsonLineProcess.close()` 只等 `close`（stdio EOF），孙进程持有 stdout 时同样挂死。

### 4. `ds-g3-smoke.service` 启动 168ms 即以 1 退出：冻结工作树的 gitdir 当时归 root

- 时间线：00:52:27 root 创建 worktree `_g3-night-frozen`；00:56:45 root 提交 `811c441e8`（提交对象、树对象、
  分支 ref、分支 reflog 至今仍是 root 属主）；00:57:12 `ds-g3-smoke.service`（User=dsdev）启动，00:57:13 退出码 1；
  00:59:23.886 gitdir `.git/worktrees/_g3-night-frozen/` 下所有文件 ctime 相同（同一次 `chown -R`），现为 dsdev 属主；
  01:00:35 参数完全相同的 `ds-g3-smoke2.service` 通过了 git 检查（随后卡在问题 1）。
- 守卫 `night-resource-guard.mjs` 第一件事是以 dsdev 身份 `git rev-parse HEAD`；git 2.39.5 要求链接工作树的 gitdir
  属主等于当前用户，否则报 “detected dubious ownership” 退出 128，`execFileSync` 抛异常，node 以 1 退出。
- 旁证：守卫要在 git 检查通过后才建 `g3-smoke/` 目录，该目录 birth 时间是 01:00:36（smoke2）；
  W11 诊断（`docs/dev/electron-migration/audits/W11-coordinator-diagnosis.md` 1.2）独立记录了同一晚 root 改写 git 文件、X7 提交失败。
- 00:57 的原始报错已无法取得：这两个 transient unit 的 stdout/stderr 都没有进 journal（smoke2 写进 `batch.log` 的
  “shards 1, …” 那一行在 journal 里也查不到）。因此运行器自己写日志和终态回执，手册要求 `StandardOutput=append:`。

### 5. 旧批跑数据（用于定超时）

- 旧全量（10 场景/分片）：A 分片 p50 257s、p90 590s、p99 713s、最长 942s；A2 最长 3720s（单场景最长 1860s）；
  B p99 672s。所有旧 `summary.json` 都没有 `runnerCode`（确认原始退出码丢失）。
- 当前语料 215 个套件、3850 个有效场景；6 worker 上限下全量约 14 小时，手册按 `--deadline-min` 分批续跑。

## 修复要点

- `record/supervise.mjs`：子进程独立进程组；分别记录 exit 与 stdio close，两者都有上限；超时/停止时 SIGTERM→宽限→SIGKILL 整个进程组；
  主进程退出后仍占管道的同组子进程被 SIGKILL，脱离进程组的则切断管道并记为 `stdio: forced`；回执带真实退出码/信号，永不抛异常。
- `record/g3-worker.mjs`：namespace init 让 bash 留在 PID 1、负载在后台运行（`xvfb-run` 不再是 PID 1），trap TERM/INT/HUP 转发给 namespace 内全部进程；
  init 自检必须是 PID 1（否则 `kill -1` 会波及用户全部进程）；`acceptSummary` 只接纳“正常退出 + 管道关闭 + 退出码与 summary 一致（0 无 runner-error / 1 有 runner-error）”的分片；
  每个 worker 写 `receipts/<侧>/<分片>.json`。
- `record/g3-batch.mjs`：分片/compare 超时、SIGTERM/SIGINT 时停止并等待全部 worker 与回执、被拒绝分片改名保留且不复用、`batch-result.json` 终态、退出码 0/3/143/130。
- `record/g3-run-a.mjs`：Tauri 在受监督的独立进程组里运行，收尾有界，`app-process.json` 和 summary 的 `app` 字段记录 Tauri 进程结局；summary 写完 30 秒仍未退出则报告残留句柄并退出（B 侧同）。
- `record/process.mjs`：`close()` 等 exit，stdout EOF 只短暂等待，再收掉进程组。
- `record/g3-provenance.mjs` + manifest/报告：见手册 §7。
- `record/g3-supervise.mjs`：托管运行器，见手册。

## 交接事项

- **主代理 / 集成**：W13 基线 `cffae73` 没有 `fixtures/differential/g3/normalize-approvals.json`（X7 `707d49c4a` 中有，7595 字节，sha256 `71c8ac72…8e1a`），
  `g3-batch`、`g3-report` 和既有的 `g3-report.test.mjs` 都要读它。本机测试时临时放了一份（未提交）。集成时请从 X7 补进来。
- **主代理**：按 `G3-RECORDING-RUNBOOK.md` 先跑 §1.4 的 Linux 生命周期测试，再 smoke，再全量。
- `ops/ser38/g3-night.py`、`ds-g3-night.service`、冻结分支 `ops/g3-night-frozen` 作废。

## 仍需在服务器上验证

- §1.4 的 4 条 Linux 用例（尤其是真实 `xvfb-run -a` 在新包装下能启动），本机没有可用的 Linux 环境。
- smoke 中 Tauri 在独立会话/进程组（`detached`）下运行是否一切正常（`app` 回执应为 `exited/0/closed/-`）。
- ~~`TasksMax=1200` 是否够用~~：不够。2026-11-07 A 预录第 1 批撞顶（EAGAIN，runner-error 约 43%），第七轮起 unit 4000、slice ≥ 6000（手册 §2）。
- 第七轮新增的 Linux 用例“each worker gets its own private MCP directory at the fixed path”（手册 §1.4）。
- 包装里的 `ip link set lo up`、`--mount-proc` 与新 init 脚本的组合只在服务器上真实执行过旧版本。

## 下一步

- 交付完成；等主代理集成后按手册执行。第四至第八轮的记录在 `scripts/electron-migration/record/W13-PROGRESS.md`（第七轮：重试与基础设施失败分类、G3-STARTUP/v1、MCP 接线、N-016/N-017 提案；第八轮：A 指纹 v2 的设计、证明、取舍，`g3-a-stale`，交接处理，第四批的影响）。

## 第八轮：本目录里的改动

- **新测试**：
  - `g3-slice.test.mjs`：9 条，含 V8 覆盖率对照和种子生成器全局状态；
  - `g3-a-stale.test.mjs`：2 条。
- **扩充的测试**：
  - `g3-inputs.test.mjs`：10 条，含 v2 的真实树变异、符号链接摘要；
  - `g3-wait.test.mjs`：8 条，含媒体流水线和 qbank 任务的终态等待；
  - `g3-corpus-check.test.mjs`：embedding 场景、`wait-without-events`，以及在真实树上加载各登记表（4 条）；
  - `g3-split.test.mjs`：v1 预录目录重算。
- **`g3-inputs.test.mjs` 的 `better-sqlite3` 导入**：加 `boundary-allow native-import`（只改临时种子副本的 `vfs.db`）。
- **`SERVER-COMMANDS.md`**：
  - 开头加第八轮说明、第四批的影响、合入 `fe5feb68` 后的复测；
  - 新增 S2b（每棵冻结树跑 `g3-a-stale`）；
  - S2 的警告计数、阻塞计数和阻塞列表；
  - S5、S6、S8 的提示。
- **`G3-RECORDING-RUNBOOK.md`**：
  - §11.1 A 指纹 v2；
  - §9.2 测试清单与“哪些预录目录还能用”，拆分测试判定改为 `pass 30`；
  - §10.4 按 `g3-a-stale` 增补；
  - §13.1 语料检查的新条目，embedding 模型表路径改到 `llm-providers/src/replay/embeddings.ts`。

## 第九轮：本目录里的改动

设计、A 失效数字、交接处理、RF 选择器问题清单和未做项都在 `scripts/electron-migration/record/W13-PROGRESS.md` 第九轮。本轮 G3 暂停，不录制、不连服务器。

- **新测试**（`.test.ts` 包装的 `# pass N` 与用例数一致）：
  - `g3-seed.test.mjs`：6 条，`${seed.*}` 的解析、运行准备、缺绑定拒绝、语料检查、逐场景指纹分量 `seedBindings`、真实比较器下的 N-007（两侧路径只差运行根时相等，位置或文件名不同仍判差）；
  - `g3-services.test.mjs`：1 条，真实 OAuth 套件的场景都要替身浏览器，其他 MCP 场景、没有 MCP 服务的场景不改 `PATH`；起真实 MCP 服务后，启动环境里 `sh -c 'command -v xdg-open'` 解析到服务的替身；
  - `g3-rf-check.test.mjs`：5 条，选择器的问题与范围宽、事件通道（名字与动态模式）、A 建表语句解析（含注释和字符串里的括号）、登记级问题与报告、本树全部登记跑通；
  - `g3-normalize-split.test.mjs`：2 条，`NORMALIZER_FILES` 等于规范化入口的相对 import 闭包且每个模块不到 800 行；`normalizerSha256` 在同一棵树上相同，任一模块改动就变。
- **新夹具** `__fixtures__/normalizer.mjs`：`copyNormalizer(root)` 把 `NORMALIZER_FILES` 全部复制进临时仓库；原来只复制 `g3-normalize.mjs` 和 `json.mjs` 的 7 处改用它。
- **扩充的测试**：
  - `g3-report.test.mjs`：只改 `g3-normalize-clock.mjs`，原来有效的 compare 也判 `normalizer sha256 mismatch`；`g3-manifest`、`g3-provenance`、`g3-report` 的夹具复制整个 `NORMALIZER_FILES`；
  - `g3-wait.test.mjs`：8 → 12 条，通道候选、空候选拒绝、等待捕获的解析/校验/`executeScenario` 端到端；
  - `g3-corpus-check.test.mjs`：4 → 7 条，`${wait.N…}` 引用、两侧拒绝场景级 `concurrent`（真实 OAuth 套件）、`protocolVersion` 不算日期（同一文本里别的日期照报）；seed 绑定的阻塞信息按确切文本断言；
  - `g3-a-stale.test.mjs`：`g3-supervise --top-up-from` 接受 `--to <同一提交>` 的报告、拒绝别的提交的（R02 L-2）；
  - `g3-inputs.test.mjs`：MCP 单元资源期望加 `oauth-browser.ts`（第五批 W21 `83b49b40` 新增的资源；断言本身没放宽，只是补上真实存在的一项）；`g3-normalize-values.mjs`、`g3-normalize-clock.mjs` 加进“不在 A 路径上”的清单。
- **`SERVER-COMMANDS.md`**：
  - 开头加第九轮说明：第五批让全部 A 失效（3877 stale + 10 missing），三项 A 路径功能及另外两项录制侧改动，在 S5 之前合入的建议，新 `ASHA` 的取法；
  - S2 多跑 `g3-seed`、`g3-services`、`g3-rf-check` 三个测试和只读的 `g3-rf-check`（不阻塞），判定表加两行；第九轮树的语料检查数字；
  - S2b 原因列表加 `seedBindings`；S5 加第五批必须重录的说明，`unsupported` 清单更新；
  - 20 个 bash 块全部通过 `bash -n`。
- **`G3-RECORDING-RUNBOOK.md`**：
  - §11.1 `seedBindings` 指纹分量；
  - §12.5（新）选择器检查 `g3-rf-check.mjs`；
  - §13.1 阻塞项与 `protocolVersion`、第九轮树数字；
  - §13.4 第九轮的 MCP 场景数、OAuth 浏览器 `PATH`、`concurrent`；
  - §13.7（新）通道候选、等待捕获、种子绑定的写法，对现有输出和现有 A 的影响，重录建议，以后的 A 路径项。

## 第十轮：本目录里的改动

不录制、不连服务器。开工合入 INT `1d1fdb78`（D 趟）。

- **`${runner.*}`、`${search.*}` 两侧接通**（`ce3ea902`）：写法与影响见手册 §13.7；SearXNG 模拟是新模块 `scripts/electron-migration/record/g3-search-service.mjs`。语料检查阻塞项 43 → 17，非 pending 为 0。`g3-a-stale 99f01253 → ce3ea902`：3887 个全部 stale，原因只有 `code:`（`scenario-v0.mjs`、`g3-services.mjs`、`g3-search-service.mjs`），场景、种子、LLM 分量不变。
- **LLM 端口参数**（同一提交，W28 补丁里 `g3-run-b.mjs`、`g3-services.mjs` 两处）：缺省值不变；语料里没有场景写死 47110（全部走 `${llm.baseUrl}`/`${provider.url}`），所以没有场景要改。
- **新测试** `g3-runner-search.test.mjs`：6 条（派发时取时钟及 ±N、运行准备的 scratch 与夹具、SearXNG 模拟、serviceGap、语料检查、端口参数）。另外两个测试里“未提供的命名空间”的示例从 `${runner.*}` 改成 `${fixture.*}`，断言本身不变。
- **`LANE.md`**：冻结说明按现状重写（`d7100fa0`）。

## 第二轮：serde-compat 工具 + 全仓 serde 表示审计（2026-11-07）

### 状态：完成

- `host/platform/serde-compat/`：产出与 Rust serde_json 逐字节一致的 JSON（API 见该目录 `API.md`）。
  - 数字：`formatF64`（zmij，整数写 `.0`）、`formatF32`（binary32 最短往返）、`formatInt`（u64/i64 全精度），
    以及 kernel 原生数字原子 `f64Atom` / `f32Atom`。
  - 声明式 schema `rs.*`：struct 字段声明序、`skipIf`、rename/rename_all、flatten；enum 四种表示；
    HashMap / BTreeMap / IndexMap；`Value` / `valueObject`；chrono。
  - 入口：`toRustJson`（DB 写入，支持 `pretty`）、`toRustValue`（IPC 返回值）。
  - `fromContractSchema`：只接受序列化形状契约，反序列化形状（`__De`、只作参数）拒绝并报 `deserialization-form`。
  - 不依赖 Node API；`portability.test.ts` 保证导入图里没有 `node:*`，且删掉 `JSON.rawJSON` 后仍可用。
- golden：37 个 G3 A 侧真实 Rust 输出，由 `scripts/serde-audit/g3-goldens.mjs` 抽取（triage sha256 `6f9de78f…0776`）。
  - 逐字节一致：processing_progress、anki config_json、essay 分数、HashMap<FieldExtractionRule>。
  - `exam_sheets.preview_json` 的 A 侧不是结构体输出（含非字段键、缺 `status`），而是 Rust 经 `Value` 原样保留的旧数据，
    因此改为“保留数字原文的 Value 往返”golden；也证明了普通 `JSON.parse` 会把 `50.0` 变成 `50`。
  - `AnkiGenerationOptions` 契约是反序列化形状，改为断言被拒绝。
- `scripts/serde-audit/`：`audit.mjs` 生成 `REPORT.md` 和 `audit.json`。
  - 宿主侧：TS AST，从 SQL 写入的列回溯 JSON 来源；另列出进入哈希的 JSON。
  - Rust 侧：tree-sitter 扫 Serialize 类型和 serde_json 写库。
  - IPC：契约中的 f32 / x-option / u64 / date-time。
  - G3：A/B 文本差异分类（`lib/classify.mjs`）。
  - 重跑命令：`node scripts/serde-audit/audit.mjs /Users/heli/der/tmp-58068a80b38aa6d0/.transfer/ds-g3-DIFF-TRIAGE.json.gz`。

### 提交

| SHA | 内容 |
|---|---|
| `92da6a4` | merge assault/integration（无冲突） |
| `9a8e49e` | serde-compat 测试（先红）+ G3 golden 抽取 |
| `7a26f1fe` | serde-compat 实现 + API.md |
| `b98d5112` | merge assault/integration（取最新） |
| `793ec51c` | serde-audit：分类、SQL 解析、Rust/宿主扫描、判定（含测试） |
| `3d491455` | serde-audit：全仓审计 + REPORT.md / audit.json / 修复指南 |
| `2b37d5c5` | merge assault/integration `6eb8acca` |

### 验证

- `npx vitest run -c vitest.host.config.ts host/platform/serde-compat`：5 个文件，110/110 通过。
- `node --test scripts/serde-audit/tests/*.test.mjs`：27/27 通过。
- `bin/heavy npx tsc -p tsconfig.host.json`：
  - 在 `3d491455` 为 0 错误。
  - 合入 `6eb8acca` 后有 2 个错误，都在 `host/platform/paths/index.ts:191,200`（`userInfo` / `resolveHome` 未导入）。
    该文件与集成分支逐字节相同，由集成 `ea3c3bc6`（W10r2）引入，不在本工作流可改范围内。
- `node scripts/electron-migration/boundaries.mjs`：20 个违规，与干净的 assault/integration 检出（`6eb8acca`）完全相同。
  本轮新增的 11 个文件贡献 0 个违规；违规在 electron/storage-migration、host/e2e/smoke 等处。

### 交接事项

- **W10 / 集成**：`host/platform/paths/index.ts` 缺少 `import { userInfo } from 'node:os'`，`resolveHome` 也未定义或未导入。
- **第二阶段（各插件 owner）**：按 `scripts/serde-audit/REPORT.md`「第二阶段修复指南」从前 10 项开始修。
  `anki_cards.extra_fields_json` 等 HashMap 键序是 Rust 侧不确定，宿主无法对齐，交比较器 N-009。
- **W04**：vfs-index `processing_progress` 在审计中显示为 `files.processing_progress`。
  Rust 侧是 `ProcessingProgress`（`pdf_processing_service.rs:225`），其中 percent 是 f32，可直接用 `rs.f32` 描述。

## 服务器只读访问记录

- 只执行了读命令（`ls`、`stat`、`cat`、`journalctl`、`systemctl cat/show/status`、`git log/reflog/diff/show/ls-files/ls-tree`、python 摘要）。
- 02:46 对冻结工作树执行过一次 `sudo -u dsdev git status`（会短暂建 `index.lock`，属主 dsdev），此后改用 `git --no-optional-locks`。
