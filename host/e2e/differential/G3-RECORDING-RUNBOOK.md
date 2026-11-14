# G3 正式录制运行手册（先 smoke，再全量）

> 执行人：主代理，在 W13 集成进 main 之后到 `ser-38` 上执行。W13 本身不执行本手册。
> 运行器：`scripts/electron-migration/record/g3-supervise.mjs`（取代 `/home/dsdev/ops-night/g3-night.py` 和 `ds-g3-night.service`，两者作废，不要再用）。
> 背景与根因：`host/e2e/differential/W13-PROGRESS.md`。
> 落地服务器（`/home/dsdev/dev/ds-landing`）上可直接复制执行的命令清单：`host/e2e/differential/SERVER-COMMANDS.md`（含语料检查、单场景诊断、每步耗时与判据）。

## 0. 原则

- 所有 git、node、录制操作都以 **dsdev** 身份执行（`sudo -u dsdev …` 或 `systemd-run --uid=dsdev`）。root 跑过的 git 会把 gitdir 里的文件变成 root 属主，dsdev 随后的 `git rev-parse` 直接失败（2026-11-07 00:57 `ds-g3-smoke.service` 168ms 退出就是这个原因）。
- 录制树冻结在一个提交上，工作树干净；B 端提交、Host 回执、A 构建回执 sha256 由运行器自动写进 `RECORDING.json`，缺一项报告就不计入。
- 旧目录（`X7-differential/.../runs/full`、`/home/dsdev/ops-night/g3-smoke`）只读保留，只作诊断；每次正式录制用新的输出目录。
- 录制并发上限 6 个 worker（本次实际录制的各侧之和：合录为 A + B + A2，A/A2 预录为 A + A2，仅 B 录制为 B），批处理会拒绝更多。
- A/A2 不依赖新的 Node 代码，可以与 B 分开录：先按第 9 节录一次 A/A2 预录目录，之后每个 B 提交按第 10 节只录 B（6 个 worker 全给 B），与预录的 A/A2 比较。第 1–4 节是 A、A2、B 同时录（合录）的流程，仍可用。

下文变量：

```bash
SHA=<集成后 main 的 40 位提交>          # B 端提交
TREE=/home/dsdev/dev/ds-mig/_g3-record-${SHA:0:12}
RECEIPT=/home/dsdev/dev/ds-mig/X7-differential/fixtures/differential/wp043/builds/20261106023719-bc16bc/receipt.json
NODE=/opt/node26/bin/node
OPS=/home/dsdev/ops-night
```

## 1. 前置检查（全部通过才进入 smoke）

### 1.1 录制提交必须包含的内容

- W13 的 `scripts/electron-migration/record/**`（`supervise.mjs`、`g3-worker.mjs`、`g3-provenance.mjs`、`g3-supervise.mjs` 等）。
- `fixtures/differential/g3/normalize-approvals.json`：比较器读录制树里的这份文件，它的 sha256 写进每个 compare 产物。不再钉死某个 sha256（文件随规则审批更新）；要求是**与录制提交里的该文件一致**（冻结树干净即保证）。preflight 的 `approvals` 检查项会读取并解析这份文件，给出 sha256 和已批准的规则列表，读不到或格式不对就判 preflight 失败。

```bash
sudo -u dsdev git -C /home/dsdev/dev/deep-student cat-file -e $SHA:scripts/electron-migration/record/g3-supervise.mjs && echo ok-supervise
sudo -u dsdev git -C /home/dsdev/dev/deep-student show $SHA:fixtures/differential/g3/normalize-approvals.json | sha256sum   # 与下一行相同
sha256sum $TREE/fixtures/differential/g3/normalize-approvals.json
```

dry-run 输出里 `approvals` 一项的 `detail.sha256` 也是这个值，`detail.approved` 列出生效的规则（`proposed` 的不在其中）。

### 1.2 建冻结工作树（dsdev）

```bash
sudo -u dsdev git -C /home/dsdev/dev/deep-student worktree add --detach $TREE $SHA
sudo -u dsdev ln -s /home/dsdev/dev/deep-student/node_modules $TREE/node_modules
sudo -u dsdev git -C $TREE status --porcelain --untracked-files=no   # 必须为空
```

`node_modules` 是指向主仓库的软链，录制期间不要在主仓库里 `npm install`。运行器会把 node 二进制、`node_modules/.package-lock.json` 和全部原生 `.node` 文件的 sha256 写进 `host-receipt.json`；重跑时若有变化会拒绝继续。

### 1.3 属主检查（防 00:57 那类失败）

```bash
G=$(sed 's/^gitdir: //' $TREE/.git)
find $TREE -maxdepth 1 ! -user dsdev; find $G ! -user dsdev     # 两条都必须没有输出
```

有输出就以 root 执行 `chown -R dsdev:dsdev <路径>`，再查一遍。

### 1.4 在服务器上跑生命周期测试（验证本次修复，必须做）

```bash
cd $TREE && sudo -u dsdev env HOME=/home/dsdev PATH=/opt/node26/bin:/usr/bin:/bin \
  $NODE --test --test-reporter=spec host/e2e/differential/g3-lifecycle.test.mjs
```

测试的临时目录在 `/tmp/opencode` 下，先确认 dsdev 可写：`sudo -u dsdev mkdir -p /tmp/opencode && sudo -u dsdev test -w /tmp/opencode && echo writable`。

判定：`pass 16`、`fail 0`、`skipped 0`。其中 5 条 Linux 用例必须真的运行（不能 skipped）：

- “first program is not PID 1”：验证 `xvfb-run` 不再是 PID namespace 的 1 号进程（挂起的根因）；
- “xvfb-run readiness handshake”：用模拟 Xvfb 的夹具走一遍 SIGUSR1 握手；
- “torn down with its whole namespace”：忽略 SIGTERM 的进程被 SIGKILL 连同 namespace 一起收掉；
- “each worker gets its own private MCP directory at the fixed path”：两个并发 worker 各自在 `/tmp/g3-mcp` 挂私有 tmpfs（user + mount namespace，非 root），互相看不到对方的文件，宿主机上不留东西（MCP 场景的 stdio 服务器副本和日志就放在这里，见 13.4）；
- “real xvfb-run -a under the wrapper”：真实 `xvfb-run` 在包装下 30 秒内启动并退出。

这条 MCP 目录用例本地 macOS 跑不了（skip），**只能在服务器上验证**。它失败时录制本身仍能跑：worker 的 stderr 会有 `g3-worker: no private /tmp/g3-mcp; MCP scenarios will refuse to run`，只有用到 `${mcp.*}` 的场景报 runner-error，其余场景不受影响；但要带输出回来，不要带着它进全量。

任何一条失败都**停止**，不要进入 smoke，把输出带回来。也可以加跑其余工具测试：

```bash
sudo -u dsdev env HOME=/home/dsdev PATH=/opt/node26/bin:/usr/bin:/bin $NODE --test \
  host/e2e/differential/g3-batch-cli.test.mjs host/e2e/differential/g3-provenance.test.mjs \
  host/e2e/differential/g3-supervise.test.mjs host/e2e/differential/g3-report.test.mjs host/e2e/differential/g3-manifest.test.mjs
```

### 1.5 A 构建回执

```bash
sha256sum $RECEIPT                                    # 记下，作为 --a-receipt-sha256
ls -l $(dirname $RECEIPT)/tauri.effective.json        # g3-run-a 校验 identifier/devUrl 用
```

dry-run 时加 `--verify-binary`，运行器会重算 binary 的 sha256 并与回执比对（约 1 分钟）。

### 1.6 资源与互斥

- 没有其他 G3 进程：`pgrep -u dsdev -af 'g3-(batch|supervise|run-a|run-b)|Xvfb|unshare' || echo none`。
- 准入阈值（`scripts/electron-migration/lib/resource-budget.mjs`，批处理每开一个分片前都会检查，不满足就等）：可用内存 ≥ 8 GiB、`/tmp` 所在盘可用 ≥ 25 GiB、dsdev 线程数 < 1400、`dsdev.slice` CPU pressure ≤ 40%、load ≤ 1.4 × CPU 数。
- 输出盘：旧批跑 1043 组对比约 12GB，全量（3850 个场景 × A/A2/B）按 40GB 以上预留：`df -h $OPS`。
- 全量测试、作业队列的重任务最好错开；同时跑时准入控制会让 G3 等待，不会挤爆机器，但总时长会变长。

### 1.7 dry-run（只检查，不写任何文件）

```bash
cd $TREE && sudo -u dsdev env HOME=/home/dsdev PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin \
  $NODE scripts/electron-migration/record/g3-supervise.mjs --tree $TREE --b-commit $SHA \
  --a-receipt $RECEIPT --a-receipt-sha256 <1.5 的值> --out $OPS/g3-smoke-${SHA:0:12} \
  --phase smoke --file fixtures/differential/wp043/get-app-version.v0.json --verify-binary --dry-run
```

输出的 `preflight.ok` 必须为 `true`；`checks` 里每一项都有 `ok` 和原因（非 root、git 可读、HEAD 等于 `--b-commit`、工作树干净、回执 schema/code/binarySha256、binary 存在且 sha256 一致、`nice/unshare/bash/xvfb-run/dbus-run-session/ip/mount` 都在（仅 B 模式不要 `xvfb-run`/`dbus-run-session`）、输出目录是新的或属于同一意图）。

## 2. 资源上限

| 项 | smoke | 全量 | 说明 |
|---|---|---|---|
| worker（A/B/A2） | 1/1/1 | 2/2/2 | 合计 ≤ 6，`g3-batch` 硬性检查 |
| compare worker | 1 | 1 | |
| 分片大小 | 10 | 10 | `--shard-size` |
| 单分片超时 | 20 分钟 | 30 分钟 | `--shard-timeout-min`；旧数据 A 分片 p99 713s、最长 942s |
| 单次 compare 超时 | 15 分钟 | 15 分钟 | `--compare-timeout-min` |
| 本次运行总超时 | 90 分钟 | 420 分钟 | `--total-timeout-min`，到点 SIGTERM→SIGKILL 整个批处理 |
| 终止宽限 | 30 秒 | 30 秒 | `--kill-grace-s`：先 SIGTERM，宽限后 SIGKILL 整个进程组 / namespace |
| systemd | MemoryMax=12G，TasksMax=4000，CPUQuota=1000%，Nice=10，KillMode=control-group，TimeoutStopSec=300 | 同左 | TasksMax 按线程计；外层 `dsdev.slice` 的 TasksMax 必须 ≥ 6000（见下） |

`TimeoutStopSec` 必须大于 `2 × kill-grace + 90` 秒，保证 `systemctl stop` 时运行器能先把 worker 收干净、写完终态回执。

**线程上限（2026-11-07 A 预录第 1 批事故）**：每个 Tauri take 约 170 个线程（tokio 按 32 核起 worker，加 WebKit），6 个 A/A2 worker 并发时 unit 的 `TasksMax=1200` 撞顶（`pids.events` 250 次），线程创建返回 EAGAIN，前 33 个分片 runner-error 约 43%。现在 unit 用 **4000**；unit 在 `dsdev.slice` 里，slice 的上限同样生效（夜间 drop-in `z-night.conf` 曾把它压在 1800），所以 slice 必须 **≥ 6000**（作业队列、测试也在这个 slice 里）。每次启动录制前：

```bash
systemctl show dsdev.slice -p TasksMax,TasksCurrent --no-pager    # TasksMax ≥ 6000（或 infinity）
systemctl set-property --runtime dsdev.slice TasksMax=6000          # 不够时（root；--runtime 重启失效）
```

这类失败现在归为**基础设施** runner 错误（`summary.json` 的 `reason` 或该 take 的 stderr 日志里有 `EAGAIN`、`(os error 11)`、`Resource temporarily unavailable`、`pthread_create`、`can't/failed to spawn|create … thread`、`creating thread '…'`，见 `g3-failures.mjs`），与场景 runner 错误分开计数：`SUPERVISOR-RESULT.json` 的 `phases.failures`（按侧 `infrastructure`/`scenario` 与签名计数）和报告 JSON 的 `runnerErrors`。有基础设施错误时结论不是 `complete`，原因写明“不是场景结果，用 `--retry-infra-errors` 重跑”；按 9.7 重试。

## 3. Smoke

### 3.1 启动

smoke 套件（共 6 个场景，每个都跑 A、A2、B）：

- `fixtures/differential/wp043/get-app-version.v0.json`：1 个场景，最小 Tauri 往返；
- `host/plugins/review/equivalence/wp229-insight.v0.json`：3 个场景，写数据库；
- `host/plugins/review/equivalence/pending-provider/wp229-essay-stream-scripted.json`：2 个场景，用到 namespace 内 47110 端口的模拟 LLM 服务和事件等待。

文件不存在时，按同样原则换：seed 为 `empty`、每个 1–3 个场景、至少一个使用 `${llm.*}`。

```bash
LABEL=g3-smoke-${SHA:0:12}
systemd-run --unit=ds-$LABEL --uid=dsdev --gid=dsdev --slice=dsdev.slice \
  --property=WorkingDirectory=$TREE --setenv=HOME=/home/dsdev --setenv=PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin \
  --property=MemoryMax=12G --property=MemorySwapMax=1G --property=TasksMax=4000 --property=CPUQuota=1000% --property=Nice=10 \
  --property=KillMode=control-group --property=TimeoutStopSec=300 \
  --property=StandardOutput=append:$OPS/$LABEL.service.log --property=StandardError=append:$OPS/$LABEL.service.log \
  $NODE scripts/electron-migration/record/g3-supervise.mjs --tree $TREE --b-commit $SHA \
    --a-receipt $RECEIPT --a-receipt-sha256 <1.5 的值> --out $OPS/$LABEL --phase smoke \
    --file fixtures/differential/wp043/get-app-version.v0.json \
    --file host/plugins/review/equivalence/wp229-insight.v0.json \
    --file host/plugins/review/equivalence/pending-provider/wp229-essay-stream-scripted.json
```

stdout/stderr 用 `append:` 写文件：这台机器上 transient unit 的输出没有进 journal（smoke2 的输出在 journal 里查不到），不能指望 journal。

### 3.2 观察

```bash
systemctl status ds-$LABEL --no-pager | head -5
tail -3 $OPS/$LABEL/batch.log
cat $OPS/$LABEL/progress.json
ls $OPS/$LABEL/receipts/*/ 2>/dev/null
```

预计 10–20 分钟。`SUPERVISOR-RESULT.json` 在运行中就会更新（`verdict: "running"`，`phases` 逐步填充）。

### 3.3 判定 smoke 通过（全部满足）

```bash
cd $OPS/$LABEL
$NODE -e '
const r = require("./SUPERVISOR-RESULT.json"); const b = r.phases.batch.result;
console.log({ verdict: r.verdict, exit: r.exitCode, batch: [r.phases.batch.process.outcome, r.phases.batch.process.code],
  rejected: b.rejectedShards, outcomes: b.workerOutcomes, compared: b.compared, equal: b.equal, unequal: b.unequal,
  compareErrors: b.compareErrors, runnerErrors: b.runnerErrors, defects: r.phases.provenance.defects,
  report: r.phases.report?.summary?.totals, reasons: r.reasons });'
for f in receipts/*/*.json; do $NODE -e '
const x = require(process.argv[1]); const s = x.summary ? require(x.summary.file) : { runs: [] };
const apps = s.runs.filter(run => run.app).map(run => `${run.id}:${run.app.outcome}/${run.app.code}/${run.app.stdio}/${run.app.escalation.join("+") || "-"}`);
console.log(x.side, x.shard, x.admitted, x.process.outcome, x.process.code, x.process.durationMs, apps.join(" "));' $PWD/$f; done
pgrep -u dsdev -af 'Xvfb|unshare|deep-student|g3-run' || echo "no leftovers"
```

通过条件：

1. `verdict` 为 `complete`，`exit` 为 0；批处理 `exited/0`。
2. `rejected` 全为 0，`outcomes` 只有 `exited`；每个 worker 回执 `admitted: true`、`process.outcome: exited`。
3. A/A2 每个 take 的 `app`（Tauri 进程回执）是 `exited/0/closed/-`：正常退出、管道正常关闭、没有用到 SIGTERM/SIGKILL。出现 `forced` 或 escalation 说明 Tauri 或 WebKit 子进程收尾异常，即使 trace 已录到也要先查清再上全量。
4. `compared` 等于 6，`compareErrors` 为 0（`equal`/`unequal` 是比对结论，不是 smoke 判据）。`runnerErrors` 非 0 时逐条看 `summary.json` 的 `reason`，确认是场景本身的已知问题而非管线问题。
5. `defects` 为空数组；`report/g3-report.md` 第一段有“录制回执：…B 端提交 `<SHA>`（工作树干净）…”，smoke 涉及的命令状态是 pass 或 fail，不是 no-scenario。
6. 运行结束后没有残留进程。
7. 单个 A take 用时（`app.durationMs`）在 3 分钟以内；明显更长时先看 `app.stderr.log`。

任一条不满足：不要上全量，按第 5 节定位。

## 4. 全量

### 4.1 规模与分批

- 语料约 215 个套件、3850 个有效场景，每边约 385 个分片（10 场景/分片）。按旧数据 A 分片中位 4.3 分钟、每边 2 个 worker 估算，全量约 14 小时，一次 7 小时的运行跑不完。
- 分批方式：**同一条命令、同一个输出目录，分多次运行**。用 `--deadline-min` 让每次运行在 N 分钟后不再开新分片、把在跑的分片收尾后正常结束（结论为 `incomplete`，原因含 `deferred by --deadline-min`）；再次执行同一条命令时，已被接纳的分片直接复用，被拒绝或没跑的分片重新跑。
- 建议每次 `--deadline-min 300 --total-timeout-min 400`，大约 3 次跑完；夜间可以连续排。

### 4.2 启动（每一批都是同一条命令）

```bash
LABEL=g3-full-${SHA:0:12}
systemd-run --unit=ds-$LABEL-$(date +%m%d%H%M) --uid=dsdev --gid=dsdev --slice=dsdev.slice \
  --property=WorkingDirectory=$TREE --setenv=HOME=/home/dsdev --setenv=PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin \
  --property=MemoryMax=12G --property=MemorySwapMax=1G --property=TasksMax=4000 --property=CPUQuota=1000% --property=Nice=10 \
  --property=KillMode=control-group --property=TimeoutStopSec=300 \
  --property=StandardOutput=append:$OPS/$LABEL.service.log --property=StandardError=append:$OPS/$LABEL.service.log \
  $NODE scripts/electron-migration/record/g3-supervise.mjs --tree $TREE --b-commit $SHA \
    --a-receipt $RECEIPT --a-receipt-sha256 <1.5 的值> --out $OPS/$LABEL --phase full \
    --deadline-min 300 --total-timeout-min 400 --coverage
```

- `--coverage` 在每批结束时合并 profraw 并导出覆盖率摘要（`llvm-profdata` / `llvm-cov`，LLVM 22.1.8 已装）；只在最后一批需要时也可以只在最后一批加。
- 每批结束后看 `SUPERVISOR-RESULT.json`：`incomplete` 且原因只有 deferred → 排下一批；有 `rejected shards` → 先按第 5 节看拒绝原因，修好或确认是偶发后再排下一批（被拒绝的分片会自动重跑）；`failed` → 停下定位。
- 运行器拒绝的情况：`--out` 已属于别的意图（换了提交、回执、侧别等）会报 `out: changed …`；另一个运行器持有 `supervisor.lock` 会报 `another supervisor holds …`；两种都不会改动已有的终态回执。

### 4.3 中途停止

`systemctl stop ds-$LABEL-…`：运行器把 SIGTERM 传给批处理，批处理对每个 worker 先 SIGTERM、宽限后 SIGKILL（namespace 整体收掉），等它们的回执写完再退出 143；`SUPERVISOR-RESULT.json` 的结论为 `stopped`。之后可以用同一条命令续跑。

## 5. 失败定位

先看 `SUPERVISOR-RESULT.json` 的 `verdict` 和 `reasons`，再顺着下表找：

| 现象 | 去哪看 | 常见原因 |
|---|---|---|
| `preflight-failed` | `reasons` / `preflight.checks` | git 不可读（属主，见 1.3）、HEAD 不对、工作树脏、回执 sha256 不对、缺工具、`--out` 意图不同 |
| `rejected shards: A=n …` | `receipts/<侧>/<分片>.json` 的 `process`（outcome、code、signal、stdio、escalation）和 `log` | 见下面几行 |
| worker `timeout` | 该分片日志最后几行（最后打印的场景就是卡住的那个）；`<分片>.rejected-*/<场景>/<take>/run/app-process.json`、`app.stderr.log`、`harness-failures.json` | Tauri 启动卡住、某步骤无响应；单分片确实太慢时调大 `--shard-timeout-min` |
| worker `signaled`（SIGKILL） | `journalctl -k --since … \| grep -i -E 'oom\|killed process'` | 内存超限（cgroup OOM） |
| worker 退出码 97 | 分片日志 | namespace 内 `ip link set lo up` 失败 |
| worker 退出码 98 | 分片日志（`namespace init is not pid 1`） | `unshare -p` 没生效；回到 1.4 |
| `stdio: forced` | 该 worker 回执；A 侧看 `app-process.json` | 有子进程在主进程退出后仍占着管道（已被收掉，但要查明是谁） |
| exit 1 且 `summary.json` 有 `runner-error` | `summary.json` 的 `runs[].reason` | 单个场景失败，分片其余场景照常计入 |
| `compare errors` | `logs/compare/<套件>.log` | trace 缺失或格式不符 |
| `recording provenance incomplete` | `phases.provenance.defects` | 回执文件被改、A 回执文件被移动或改写 |
| `report …` | `supervisor-report.log` | 分母漂移、manifest 不一致（报告生成期间有人改了输入） |

worker 的回执、日志和被拒绝的分片目录都会保留，重跑不会覆盖。

## 6. 产物封存

全部批次结论为 `complete` 之后：

```bash
cd $OPS/$LABEL
sudo -u dsdev mkdir -p a-build && sudo -u dsdev cp $RECEIPT $(dirname $RECEIPT)/tauri.effective.json a-build/
sudo -u dsdev sh -c 'sha256sum RECORDING.json host-receipt.json RUN-MANIFEST.json SUPERVISOR-RESULT.json SUPERVISOR.json \
  batch-result.json invocations.jsonl supervisor-runs.jsonl report/g3-report.json report/g3-report.md a-build/* \
  $(find receipts -type f | sort) > SEAL.sha256'
sudo -u dsdev chmod -R a-w $OPS/$LABEL
sha256sum $OPS/$LABEL/SEAL.sha256
```

- 不要删除 trace 和 compare：报告每次都会从原始 trace 重算并校验 sha256。
- A 构建回执原文件（`$RECEIPT`）在报告重算时也会被校验 sha256，不能改动或移动；`a-build/` 只是副本。
- 需要备份时把整个目录打包（`tar --zstd -cf $LABEL.tar.zst $LABEL`）并记录其 sha256，放到备份盘。
- 冻结工作树 `$TREE` 保留到报告被验收为止（报告重算要求同一棵树）。

## 7. 报告

- 运行器在每批结束时都会重新封存并生成 `report/g3-report.json` 和 `report/g3-report.md`（旧的 `RUN-MANIFEST.json` 改名为 `RUN-MANIFEST.superseded-<时间>.json` 保留）。以最后一批 `complete` 时的报告为准。
- 报告只计入同时满足以下条件的对比：compare 产物与原始 trace 重算一致（原有规则）；所在目录的 `RECORDING.json` 完整（B 端提交且工作树干净、Host 回执、A 构建回执 sha256 与当前文件一致）；每个 trace 都出现在一份正常退出且被接纳的 worker 回执里，sha256 相同。不满足的对比记为 `unattributable-recording` 问题，不计入 pass/fail。
- 手动重算（例如 C2 更新了 blockers/excluded 之后），在同一棵冻结树里执行：

```bash
cd $TREE && sudo -u dsdev env HOME=/home/dsdev $NODE scripts/electron-migration/record/g3-report.mjs \
  --runs $OPS/$LABEL --out $OPS/$LABEL/report-<日期> --jobs 4 [--coverage $OPS/$LABEL/coverage-summary.json]
```

- 报告中的 pass/fail 是 768 条命令的五态结论；场景 equal 不能换算成命令 pass。把 Markdown 交给 C2 前，核对第一段的“录制回执”一行和问题表。

## 8. 清理

- 录制完成且报告验收后：`sudo -u dsdev git -C /home/dsdev/dev/deep-student worktree remove $TREE`（输出目录不受影响）。A/A2 预录用的冻结树 `$ATREE` 不要删：预录目录的 `A-STORE.json` 记录了它，之后的 B 录制不读它，但复查预录时要用。
- 作废的旧件：`/home/dsdev/ops-night/g3-night.py`、`ds-g3-night.service`、`ds-g3-smoke*.service` transient unit，以及冻结分支 `ops/g3-night-frozen`（其 `unshare … exec "$@"` 包装会让 A 侧挂死，不要再用）。

## 9. A/A2 预录

只录 A 和 A2，不需要 B 提交。录一次，供之后任意多个 B 提交复用。

### 9.1 预录目录里有什么

| 文件 | 内容 |
|---|---|
| `A-STORE.json`（`g3-a-store/v1`） | 录制树提交（`recorder.head`，工作树干净）、`recorder-receipt.json` 的 sha256（录制用的 node、原生模块）、A 构建回执（路径 + sha256 + binarySha256）、固定的环境（`TZ`/`LANG`/`LC_ALL`）、每个套件的输入指纹（见第 11 节）、录制器代码 sha256 |
| `recorder-receipt.json` | 录制运行时回执，格式与 B 的 `host-receipt.json` 相同 |
| `receipts/A/`、`receipts/A2/` | 每个分片的 worker 回执，`recording` 字段按 sha256 指向 `A-STORE.json` |
| `A/`、`A2/`、`profiles/`、`logs/` | trace、Tauri profraw、日志 |

没有 `RECORDING.json`、`host-receipt.json`、`B/`、`compare/`。同一目录再次运行时，`A-STORE.json` 必须逐字节相同，否则拒绝（`A store inputs changed; use a new output directory (first change at /…)`，括号里是第一处变化）。

### 9.2 变量与冻结树（dsdev）

A/A2 不依赖 Node 代码，但套件、种子生成器、录制器代码取自录制树，所以录制树用**当时的集成 main**，与之后的 B 提交越接近，需要补录的套件越少（第 10.4 节）。

```bash
ASHA=<录 A/A2 时的 main 40 位提交>
ATREE=/home/dsdev/dev/ds-mig/_g3-astore-${ASHA:0:12}
STORE=$OPS/g3-astore-${ASHA:0:12}
sudo -u dsdev git -C /home/dsdev/dev/deep-student worktree add --detach $ATREE $ASHA
sudo -u dsdev ln -s /home/dsdev/dev/deep-student/node_modules $ATREE/node_modules
sudo -u dsdev git -C $ATREE status --porcelain --untracked-files=no   # 必须为空
```

照第 1.3 节查属主、第 1.4 节在 `$ATREE` 里跑生命周期测试（A 侧需要 `xvfb-run`），第 1.5 节记下 `$RECEIPT` 的 sha256。另跑一遍拆分测试：

```bash
cd $ATREE && sudo -u dsdev env HOME=/home/dsdev PATH=/opt/node26/bin:/usr/bin:/bin $NODE --test \
  host/e2e/differential/g3-split.test.mjs host/e2e/differential/g3-supervise-split.test.mjs host/e2e/differential/g3-inputs.test.mjs \
  host/e2e/differential/g3-slice.test.mjs host/e2e/differential/g3-a-stale.test.mjs
```

判定：`pass 30`、`fail 0`。

**哪些预录目录还能用**：一个场景的 A 只能给“该场景 A 输入相同”的 B 树用（第 11 节）。直接问 `g3-a-stale --from <预录目录>`（11.1，`SERVER-COMMANDS.md` S2b）：它按仅 B 的同一判定列出 stale 的场景和原因。W13 第七轮（G3-STARTUP/v1 启动屏障、等待锚点、MCP 接线）改了 A 进程的代码，所以**此前录的预录目录（含 2026-11-07 的 `g3-astore-007c1af54c3e`）对第七轮之后的 B 树全部是 stale-a**；即便绕过输入检查，比较器也会因启动规则不同（一侧有 `startup` 记录、一侧没有）拒绝比较。第七轮之后录的预录目录在第八轮（A 指纹 v2）之后仍可用：v2 只在 A 进程能执行的代码、种子、A 命令行等真正决定 A 产出的输入变了时才判 stale-a（11.1），本轮合入本身对 3881 个场景都不判 stale-a。

### 9.3 磁盘

旧批 1043 组对比约 12GB（含 A、A2、B 三侧 trace 与 compare），约 11.5MB/场景，A+A2 约占 2/3。全量 3850 个场景的预录目录约 30GB，**按 40GB 预留**：`df -h $OPS`。`/tmp` 另需 ≥ 25GiB 可用（准入阈值）。

### 9.4 dry-run 与 smoke

```bash
cd $ATREE && sudo -u dsdev env HOME=/home/dsdev PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin \
  $NODE scripts/electron-migration/record/g3-supervise.mjs --mode a-store --tree $ATREE --commit $ASHA \
  --a-receipt $RECEIPT --a-receipt-sha256 <1.5 的值> --out $OPS/g3-astore-smoke-${ASHA:0:12} --phase smoke \
  --file fixtures/differential/wp043/get-app-version.v0.json --verify-binary --dry-run
```

`preflight.ok` 为 `true`，检查项含 `commit`（不是 `b-commit`）和 `tool:xvfb-run`；`batch` 一行含 `--mode a-store`、`--sides A,A2`，没有 `--workers-b`。

smoke（与第 3.1 节同样的 3 个套件、6 个场景，A/A2 各 1 个 worker；单独的 smoke 目录，不与正式预录目录混用）：

```bash
LABEL=g3-astore-smoke-${ASHA:0:12}
systemd-run --unit=ds-$LABEL --uid=dsdev --gid=dsdev --slice=dsdev.slice \
  --property=WorkingDirectory=$ATREE --setenv=HOME=/home/dsdev --setenv=PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin \
  --property=MemoryMax=12G --property=MemorySwapMax=1G --property=TasksMax=4000 --property=CPUQuota=1000% --property=Nice=10 \
  --property=KillMode=control-group --property=TimeoutStopSec=300 \
  --property=StandardOutput=append:$OPS/$LABEL.service.log --property=StandardError=append:$OPS/$LABEL.service.log \
  $NODE scripts/electron-migration/record/g3-supervise.mjs --mode a-store --tree $ATREE --commit $ASHA \
    --a-receipt $RECEIPT --a-receipt-sha256 <1.5 的值> --out $OPS/$LABEL --phase smoke \
    --file fixtures/differential/wp043/get-app-version.v0.json \
    --file host/plugins/review/equivalence/wp229-insight.v0.json \
    --file host/plugins/review/equivalence/pending-provider/wp229-essay-stream-scripted.json
```

判定（全部满足）：

```bash
cd $OPS/$LABEL && $NODE -e '
const r = require("./SUPERVISOR-RESULT.json"); const b = r.phases.batch.result;
console.log({ verdict: r.verdict, exit: r.exitCode, mode: b.mode, rejected: b.rejectedShards, outcomes: b.workerOutcomes,
  runnerErrors: b.runnerErrors, store: r.phases.store, reasons: r.reasons });'
ls RECORDING.json host-receipt.json B compare 2>&1 | grep -c 'No such file'   # 必须是 4
```

1. `verdict` 为 `complete`，`mode` 为 `a-store`，`rejected` 全为 0，`outcomes` 只有 `exited`。
2. `store.defects` 为 `[]`；`store.coverage` 的 `A`、`A2` 等于这 3 个套件的场景数（6）减去 `runnerErrors`。
3. 第 3.3 节第 3、6、7 条（Tauri 进程正常退出、无残留、单个 A take < 3 分钟）同样适用。

### 9.5 全量（按业务域分批）

同一条命令、同一个预录目录，多次运行。`--domain` 只录这些域的分片，按给出的顺序；已接纳的分片直接复用。每批结束都有 `SUPERVISOR-RESULT.json`（`phases.store.coverage` 给出已录的 A/A2 场景数）。

| 批 | `--domain` | 场景数（W13 树统计） |
|---|---|---:|
| 1 | `chat,notes,anki,review,qbank` | 1112 |
| 2 | `vfs,vfs-handlers,vfs-repos,vfs-index` | 1232 |
| 3 | 不加 `--domain`（其余全部，前两批的分片自动复用） | 1506 |

```bash
DOMAINS=chat,notes,anki,review,qbank          # 第 2 批换成 vfs,vfs-handlers,vfs-repos,vfs-index；第 3 批删掉 --domain 一行
LABEL=g3-astore-${ASHA:0:12}
systemd-run --unit=ds-$LABEL-$(date +%m%d%H%M) --uid=dsdev --gid=dsdev --slice=dsdev.slice \
  --property=WorkingDirectory=$ATREE --setenv=HOME=/home/dsdev --setenv=PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin \
  --property=MemoryMax=12G --property=MemorySwapMax=1G --property=TasksMax=4000 --property=CPUQuota=1000% --property=Nice=10 \
  --property=KillMode=control-group --property=TimeoutStopSec=300 \
  --property=StandardOutput=append:$OPS/$LABEL.service.log --property=StandardError=append:$OPS/$LABEL.service.log \
  $NODE scripts/electron-migration/record/g3-supervise.mjs --mode a-store --tree $ATREE --commit $ASHA \
    --a-receipt $RECEIPT --a-receipt-sha256 <1.5 的值> --out $STORE --phase full \
    --domain $DOMAINS \
    --deadline-min 300 --total-timeout-min 400 --coverage
```

- 默认 A、A2 各 3 个 worker（合计 6）。`--domain`、`--file`、worker 数、超时、`--deadline-min` 都是运行参数，每批可以不同；提交、A 回执、`--tz`/`--locale`、分片大小是意图，不能变（变了报 `out: changed …`）。
- 结论 `incomplete` 且原因只有 `deferred by --deadline-min` → 用同一条命令排下一批（不改 `DOMAINS` 就是继续本批）；有 `rejected shards` → 按第 5 节查，被拒绝的分片下次自动重跑。
- `--coverage` 把 `profiles/` 下的 profraw 合并成 `$STORE/coverage-summary.json`；B 侧报告可用 `--coverage $STORE/coverage-summary.json` 引用（第 10.6 节）。
- 预估：A 与 A2 各 3 个 worker 并行。按旧数据 A 分片中位 4.3 分钟/10 场景（约 26 秒/场景），3850 × 26 秒 ÷ 3 ≈ 9.3 小时；A2 的长尾更重（旧数据单分片最长 62 分钟），按 10–11 小时计，即 3 批 `--deadline-min 300` 左右。G3-STARTUP/v1（第 13.5 节）每个 take 启动多等 8–9 秒（最长 30 秒），约 +0.3 秒/场景 × 3850 ÷ 3，总计多 ~15–25 分钟。
- 每批启动前按第 2 节查 `dsdev.slice` 的 TasksMax（≥ 6000）。结论里出现 `infrastructure runner errors` → 按 9.7 重试，不要当场景结论。

### 9.6 封存预录目录

全部批次 `complete`、`phases.store.coverage` 的 `A`/`A2` 不再增长后：

```bash
cd $STORE
sudo -u dsdev sh -c 'sha256sum A-STORE.json recorder-receipt.json SUPERVISOR-RESULT.json SUPERVISOR.json batch-result.json \
  invocations.jsonl supervisor-runs.jsonl $(find receipts -type f | sort) > SEAL.sha256'
sudo -u dsdev chmod -R a-w $STORE
sha256sum $STORE/A-STORE.json      # 记下：STORE_SHA，所有 B 录制都用它钉住这个预录目录
```

封存后不要再往这个目录录（要补就另建补录目录，第 10.4 节）。A 回执原文件 `$RECEIPT` 依然不能改动或移动。

### 9.7 重试 runner 错误

已接纳的分片（worker 正常退出、`summary.json` 与退出码一致）同一条命令再跑会**直接复用**，含 runner-error 的也一样。要重跑它们，在同一条命令上加下面的运行参数（不是意图，不改 `--out`，不触发 `out: changed`）；`g3-supervise` 原样传给录制树里的 `g3-batch`，preflight 的 `batch-option:<flag>` 会检查那棵树的 `g3-batch` 是否认识该参数：

| 参数 | 重跑哪些分片 | 什么时候用 | 录制树要求 |
|---|---|---|---|
| `--retry-infra-errors` | 含**基础设施** runner 错误（第 2 节的签名，读 `reason` 和该 take 的 stderr 日志）的分片 | 首选：线程/进程上限修好后，只重跑被环境打断的分片；场景本身的 runner 错误保留为结论 | W13 第七轮之后 |
| `--retry-errors-before ISO` | 含任何 runner 错误、且 `summary.json` 修改时间早于该时间的分片 | 环境在某个时刻修好、树又没有上一项时；重跑后的新 `summary.json` 晚于截止时间，所以链式作业里每个失败只重试一次 | `cffae736` 起（2026-11-07 的 `$ATREE` 已有） |
| `--retry-errors` | 含任何 runner 错误的分片 | 一次性整批重试；**每次运行都会重跑**，包括场景本身的错误，所以只加在一次运行上，后续批次去掉 | `cffae736` 起（2026-11-07 的 `$ATREE` 已有） |

注意：

- 修好时正在跑的分片，`summary.json` 的修改时间晚于修复时刻，但里面可能有修复前的 EAGAIN。用 `--retry-errors-before` 时截止时间要取“修复时刻 + 单分片超时（默认 `max(20, 3 × shard-size)` = 30 分钟）+ kill-grace”，或者直接用 `--retry-infra-errors`（按签名，不看时间）。
- 重跑前的分片目录改名为 `<分片>.superseded-<ms>` 保留，`logs/` 里有一行 `… rerun: infrastructure runner-error retry` 或 `… rerun: runner-error retry`。
- 先 `--dry-run`：输出的 `batch` 一行末尾应有该参数，`preflight.checks` 里 `batch-option:--retry-…` 为 `ok`。
- 冻结的旧录制树（比如 2026-11-07 用 `007c1af5` 建的 `$ATREE`）的 `g3-supervise` 不认这些参数（`parseArgs` 严格模式，直接报 `Unknown option`）。可以用新树里的 `g3-supervise.mjs` 驱动旧树：`$NODE $TREE/scripts/electron-migration/record/g3-supervise.mjs --mode a-store --tree $ATREE --commit $ASHA …`，工作目录仍是 `$ATREE`；它在 `$ATREE` 里启动旧树自己的 `g3-batch`，`a-store` 的意图字段两版相同，所以同一 `--out` 可以续跑。旧树的 `g3-batch` 只认 `--retry-errors` 和 `--retry-errors-before`，加 `--retry-infra-errors` 会在 preflight 失败。命令见 SERVER-COMMANDS S5b。

## 10. 仅 B 录制

每个新的 B 提交一个输出目录，引用同一个（或几个）预录目录，6 个 worker 全给 B，不需要 X server。

### 10.1 引用与可追溯

- `--a-store DIR --a-store-sha256 <A-STORE.json 的 sha256>` 必须成对给出，可以重复（后给的目录优先）。sha256 不符、预录目录有缺陷（回执被改、A 构建回执被改、录制树不干净等）、多个预录目录的 A 构建回执不同、环境（`TZ`/`LANG`/`LC_ALL`）与本次不同，都在写任何文件之前拒绝。
- 本次目录的 `RECORDING.json` 为 `g3-recording/v3`：B 提交、`host-receipt.json` 的 sha256、A 构建回执（取自预录目录并重新校验）、环境、本树的输入指纹。预录目录本身不属于身份，所以同一个 B 目录之后可以再加补录目录。
- 每个用到的预录回执在 `a-refs/<A|A2>/<预录 sha 前 12 位>__<回执名>` 留一份引用（`g3-a-ref/v1`）：预录目录、`A-STORE.json` 的 sha256、回执文件和它的 sha256。报告只在引用完好、回执 sha256 一致、回执正常退出且被接纳、预录的 A 构建回执 / 环境 / **该场景**的输入（第 11 节）与本次 `RECORDING.json` 一致时才承认这条 A/A2 trace；否则这条 compare 记为 `unattributable-recording`，原因写明（`A trace not admitted: A store receipt changed` 等），不计入 pass/fail。
- 按**场景**取 A：每个场景取命令行里最后一个“有接纳的 A 和 A2 take、且该场景输入与本树相同”的预录目录。输入不同的场景是 **stale-a**（不比较、不计 pass/fail），预录里没有的是 missing，同输入但还没录到的是 awaiting A。只要套件里还有一个场景可比，这个套件的 B 照录。`a-store-coverage.json`（`g3-a-store-coverage/v2`）：
  - `suites[<套件>]`：`status`（`matched` 全部可比 / `partial` / `stale` / `awaiting` / `missing`）、`available`、`staleA`（`{id, store, reasons}`）、`missing`、`awaitingA`、`sources`（场景 id → 提供 A 的预录 sha256 前 12 位）；
  - `stores[].scenarioInputs`：`recorded`（新预录自带）/ `recomputed-from-recorder-head`（旧预录，从它的录制提交重算）/ `suite-fingerprint-only`（提交读不到，退回套件级）；
  - `topUpScenarios`（`{file, id}`，stale-a 与 missing）、`topUp`（涉及的套件）、`staleA`（全部 stale-a 及原因）、`awaitingA`（还在等预录的套件）。
- 场景定义没变、只是同一套件里别的场景变了时，A 跑的是旧的套件文件：批处理从预录的录制提交取出那个文件放到 `<out>/a-inputs/<sha256>.json`，`g3-compare --a-scenario-file` 只在它的 sha256 等于 A trace 的输入、且该场景逐字节相同（`stringifyExact`）时接受，compare 里记 `splitRecording.aScenarioFile`，报告重算时同样校验。

### 10.2 冻结树与 dry-run

```bash
SHA=<B 端 40 位提交>
TREE=/home/dsdev/dev/ds-mig/_g3-record-${SHA:0:12}
STORE_SHA=<9.6 记下的值>
# 建树、软链 node_modules、属主检查：同 1.2、1.3（B 侧不需要 xvfb-run）
cd $TREE && sudo -u dsdev env HOME=/home/dsdev PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin \
  $NODE scripts/electron-migration/record/g3-supervise.mjs --mode b-only --tree $TREE --b-commit $SHA \
  --a-store $STORE --a-store-sha256 $STORE_SHA --out $OPS/g3-b-smoke-${SHA:0:12} --phase smoke --dry-run
```

检查项含 `b-commit`、`a-store:$STORE`、`a-store-sha256:$STORE`、`a-store-defects:$STORE`、`a-store-build`、`a-store-environment`，不含 `tool:xvfb-run`；全部 `ok`。

### 10.3 smoke

预录 smoke 目录（9.4）就是 B smoke 的 A/A2 来源：

```bash
SMOKE_STORE=$OPS/g3-astore-smoke-${ASHA:0:12}
LABEL=g3-b-smoke-${SHA:0:12}
systemd-run --unit=ds-$LABEL --uid=dsdev --gid=dsdev --slice=dsdev.slice \
  --property=WorkingDirectory=$TREE --setenv=HOME=/home/dsdev --setenv=PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin \
  --property=MemoryMax=12G --property=MemorySwapMax=1G --property=TasksMax=4000 --property=CPUQuota=1000% --property=Nice=10 \
  --property=KillMode=control-group --property=TimeoutStopSec=300 \
  --property=StandardOutput=append:$OPS/$LABEL.service.log --property=StandardError=append:$OPS/$LABEL.service.log \
  $NODE scripts/electron-migration/record/g3-supervise.mjs --mode b-only --tree $TREE --b-commit $SHA \
    --a-store $SMOKE_STORE --a-store-sha256 $(sha256sum $SMOKE_STORE/A-STORE.json | cut -d' ' -f1) \
    --out $OPS/$LABEL --phase smoke \
    --file fixtures/differential/wp043/get-app-version.v0.json \
    --file host/plugins/review/equivalence/wp229-insight.v0.json \
    --file host/plugins/review/equivalence/pending-provider/wp229-essay-stream-scripted.json
```

`--file` 不能省：预录 smoke 目录的输入指纹覆盖全部套件，但只录了这 3 个，不限定范围时其余场景都算“等待 A”，结论会是 `incomplete`。

判定（全部满足）：

```bash
cd $OPS/$LABEL && $NODE -e '
const r = require("./SUPERVISOR-RESULT.json"); const b = r.phases.batch.result; const c = require("./a-store-coverage.json");
console.log({ verdict: r.verdict, mode: b.mode, rejected: b.rejectedShards, compared: b.compared, compareErrors: b.compareErrors,
  aStore: b.aStore.suites, awaitingA: b.aStore.awaitingA, defects: r.phases.provenance.defects, report: r.phases.report?.summary,
  topUp: c.topUp, reasons: r.reasons });'
ls receipts; ls a-refs/A | wc -l; grep -m1 '预录目录' report/g3-report.md
```

1. `verdict` 为 `complete`（若 `$ASHA` ≠ `$SHA` 且其间改了或新增了这 3 个套件里的场景，会是 `incomplete` 且原因为 `A/A2 unavailable: N stale-a scenario(s), M missing, K awaiting A (…)`；其余场景照常比较；按 10.4 增补后再跑）。
2. `receipts` 只有 `B`；`a-refs/A` 有引用文件；`compared` 等于预录 smoke 中 A、A2 都录到的场景数，`compareErrors` 为 0。
3. `defects` 为 `[]`；报告“录制回执”一行含 “A/A2 取自 A 预录目录 1 个 …”，问题表没有 `unattributable-recording`。
4. 第 3.3 节第 6 条（无残留进程）。

### 10.4 增补（stale-a 或新增的场景）

`a-store-coverage.json` 的 `topUpScenarios` 非空时，从**本次 B 的树**只录这些场景，封成一个新的增补预录目录，再把它加在原预录目录之后。基础预录目录不动，继续用 `$ATREE` 的旧代码录完。

```bash
TOPUP=$OPS/g3-astore-topup-${SHA:0:12}-$(date +%m%d%H%M)
# 在 $TREE 上按 9.5 的 systemd-run 命令跑：--mode a-store --tree $TREE --commit $SHA --out $TOPUP --phase full \
#   --top-up-from $OPS/g3-b-${SHA:0:12}/a-store-coverage.json（不加 --domain/--file/--scenario）
# 完成后按 9.6 封存，记下 TOPUP_SHA
```

`--top-up-from` 等价于对 `topUpScenarios` 的套件给 `--file`、对其中的场景给 `--scenario`（分片键 `…/only-<hash>-NNN`）。也可以给 `g3-a-stale --from $STORE --json` 的输出（11.1），不必先录 B；它必须是在 `--commit` 那个提交的干净工作树上生成的，否则拒绝。完整命令与时长见 `SERVER-COMMANDS.md` S8。

之后 B 命令里写两对（或更多）：`--a-store $STORE --a-store-sha256 $STORE_SHA --a-store $TOPUP --a-store-sha256 $TOPUP_SHA`，每个各自校验 sha256，同一场景以后给的为准。同一个 B 输出目录可以直接续跑（预录目录不是身份）；已录的 B 分片复用，新可比的场景会补上比较。报告“录制回执”一行写每个预录目录提供了几个场景的 A，逐场景来源在 `g3-report.json` 的 `recording.aStores[].scenarios`。

`awaitingA` 非空表示预录还没录完（9.5 的批次没跑完），继续跑预录即可，不需要补录目录。

### 10.5 全量（按业务域分批）

```bash
DOMAINS=chat,notes,anki,review,qbank          # 第 2 批 vfs,vfs-handlers,vfs-repos,vfs-index；第 3 批删掉 --domain 一行
LABEL=g3-b-${SHA:0:12}
systemd-run --unit=ds-$LABEL-$(date +%m%d%H%M) --uid=dsdev --gid=dsdev --slice=dsdev.slice \
  --property=WorkingDirectory=$TREE --setenv=HOME=/home/dsdev --setenv=PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin \
  --property=MemoryMax=12G --property=MemorySwapMax=1G --property=TasksMax=4000 --property=CPUQuota=1000% --property=Nice=10 \
  --property=KillMode=control-group --property=TimeoutStopSec=300 \
  --property=StandardOutput=append:$OPS/$LABEL.service.log --property=StandardError=append:$OPS/$LABEL.service.log \
  $NODE scripts/electron-migration/record/g3-supervise.mjs --mode b-only --tree $TREE --b-commit $SHA \
    --a-store $STORE --a-store-sha256 $STORE_SHA --out $OPS/$LABEL --phase full \
    --domain $DOMAINS \
    --deadline-min 300 --total-timeout-min 400
```

- 默认 B 6 个 worker、compare 2 个。6 个 Host 进程同时运行时的内存峰值还没有实测：第一批开始后用 `systemctl show <unit> -p MemoryCurrent,TasksCurrent` 观察，接近 `MemoryMax=12G` 就调大上限或用 `--workers-b 4` 续跑；准入控制仍按第 1.6 节阈值把关。
- `--domain` 只录这些域的 B 分片；目录里已录好的其他域分片照常比较（上一批因 deadline 推迟的比较也会在这一批补上）。`batch-result.json` 的 `compared` 是整个目录的累计数。
- 每批结束后报告带 “## 本批范围（<域>）” 一节：本批套件涉及的命令 pass / fail / 未跑，只看本批套件的 compare；报告上方的台账总数始终覆盖整个目录。
- 结论：`deferred by --deadline-min` → 同命令续跑；`A/A2 unavailable: N stale-a scenario(s), M missing, K awaiting A (…)` → 看 `a-store-coverage.json`，stale-a/missing 按 10.4 增补，awaiting A 先把预录跑完；其余同第 4.2 节。
- **磁盘**：B trace + compare 约占旧数据的 1/3，全量约 15GB，**每个 B 目录按 20GB 预留**。

### 10.6 仅 B 全量耗时估算

| 项 | 取值 | 依据 / 假设 |
|---|---|---|
| 场景数 | 3850（503 个分片：按套件切 10 个一片，零头单独成片） | W13 树统计；以录制树实际为准，`batch.log` 第一行打印 |
| 单场景 B 用时 | 约 26 秒 | **假设**：旧数据没有 B 分片中位数，只有 B p99 672 秒（A p99 713 秒），按 A 中位 4.3 分钟/10 场景保守取同值；B 不启动 Tauri/WebKit，实际可能更快 |
| worker | 6 | 全部给 B |
| 录制 | 3850 × 26 秒 ÷ 6 ≈ 4.6 小时 | 假设准入控制不限流（可用内存 ≥ 8GiB 等，见 1.6） |
| 比较 | 与录制重叠，结束后尾巴约 0.3–0.5 小时 | compare 2 个 worker；**假设**单个 compare 远小于单个录制 |
| 合计 | **约 5 小时**（B 若比 A 快一倍则约 2.5–3 小时） | 合录全量约 14 小时（每侧 2 个 worker）；A/A2 只录一次 |

建议每批 `--deadline-min 300 --total-timeout-min 400`：按上面的估算，3 个域批次合计约 5 小时，单个 B 提交一晚能跑完。实际速度看第一批的 `progress.json`（`bDone` 增速）后调整。

### 10.7 报告与封存

- 运行器每批结束自动封存并出报告（第 7 节规则不变）；手动重算加 `--domain` 得到某批的范围节，加 `--coverage $STORE/coverage-summary.json` 引用 A 侧覆盖率。
- 封存时 SEAL 增加 `a-store-coverage.json` 和 `$(find a-refs -type f | sort)`；预录目录有自己的封存（9.6），报告重算时会按 `a-refs` 逐份校验预录回执，预录目录不能移动或改写。

## 11. 分开录制时的输入一致性

A/A2 与 B 在不同时间、从不同的树录制，以下各项必须相同才可比；运行器逐项指纹化（`g3-inputs.mjs`，`g3-inputs/v2`），**按场景**判断（`inputs.scenarios`：场景定义 `scenario`、它的种子 `seed`、它用到的 LLM 脚本条目 `llm`、它的 A 代码单元 `a`（逐文件 `code:<文件>`、`resource:<文件>`、`program:<入口>:<文件>`、`package:<名>`）、前端事件表 `events`、A 命令行与隔离 `launch:a`、`launch:mcp`、node `runtime:node`、环境 `environment`、场景里引用的仓库文件 `file:<路径>`），不同的场景判为 stale-a、不比较，并指出是哪一项。套件级指纹（套件字节、provider 旁车、各场景摘要）仍写进身份，只在预录的录制提交读不到时作为退路：

| 输入 | 处理 |
|---|---|
| 场景文件 | 套件字节 sha256（`suite`）；provider 旁车文件 `<套件>.provider.json`（`provider`） |
| 种子 | 用本树生成器实际生成一次，取 X3 逻辑快照 + 非数据库文件字节（`seed:<名>`）。种子生成器写入生成时刻（`historical-wp013-v1` 的 `__change_log.changed_at`、`l15-review-cas-tombstone-w0` 的 `vfs_indexing_config.updated_at` 等，SQLite `datetime('now')` 默认值），只把**等于生成时刻**的单元格换成占位后再算摘要，其余单元格照算。生成器不认识的种子（W13 树统计：语料引用 25 个种子，生成器只认 5 个）记为 `unavailable`，两侧会同样失败 |
| A 进程的代码 | `g3-run-a.mjs`（A 进程入口）的**声明级切片**（`g3-slice.mjs`，11.1）：A 进程加载的每个模块的顶层副作用，加上被执行代码（传递地）引用到的声明，逐文件摘要（`code:<文件>`）。按场景启动的服务分 4 个单元：`a`、`a+llm`、`a+cloud`、`a+mcp`（含 MCP 场景的套件里每个场景都带 `mcp`：A 每个分片都起一次 MCP 服务查键）；未启动的服务模块不在切片里。服务按 `new URL(…, import.meta.url)` 复制或提供的文件按字节计（`resource:<文件>`，MCP 的 stdio-server.ts、protocol.ts），其中独立运行的程序（stdio-server.ts）另算切片（`program:…`）；切片用到的 npm 包按 `package-lock.json` 的版本与 integrity（`package:<名>`）。只有 B、比较、报告、批处理会跑的代码不在切片里，改它不让 A 失效 |
| 种子生成器 | 不进代码切片：它导入 Host 产品代码，按产出的种子内容计（上一行“种子”）。`g3-run-a` 用到的种子模块其余函数（`resolveSeed` 等）照常在切片里；种子模块加载时的副作用及其产品导入不计，`g3-slice.test.mjs` 验证它们加载并构建全部种子后进程全局状态不变 |
| 前端事件表 | 捕获事件的场景记 `frontendEvents` 对 `contracts/ipc`、`src` 的结果（`events`）；`src` 下与事件名无关的改动不让 A 失效 |
| A 命令行与隔离 | `g3-batch.mjs` 里唯一那个含 `g3-run-a.mjs` 的参数数组（按词法记号，排版无关）加 namespace 包装与 init（`launch:a`） |
| MCP 启动参数 | 用到 `mcp` 的场景另记 `launch:mcp`（固定端口、`/tmp/g3-mcp`、录制用 node 的真实路径与版本）：stdio 服务器的命令行是场景输入的一部分，A、B 两侧必须相同 |
| node | 录制用 node 的版本（`runtime:node`；旧预录取它的录制回执） |
| 环境 | `--tz`（默认 `UTC`）、`--locale`（默认 `C.UTF-8`，写成 `LANG`、`LC_ALL`），worker 去掉 `LANGUAGE`；写进 `A-STORE.json` / `RECORDING.json`，不同则拒绝（`environment`） |
| A 构建 | 所有预录目录必须同一个 A 构建回执（sha256 校验） |
| 隔离方式 | namespace 包装与 init 脚本写进两边身份 |
| 启动观察 | 每个 take 的 `trace.startup.rule`（第 13.5 节）。不是输入指纹，而是比较器的硬条件：同一 compare 的各 take 规则必须相同，否则拒绝比较（`startup protocol differs between takes (A=none, B=G3-STARTUP/v1, …); re-record the older side with the current recorder`）。旧预录在代码检查处已经是 stale-a，一般走不到这一步 |
| 时钟 | **没有冻结**（拆分录制的窗口内时间戳见 13.3 的 N-014）。B 与 A/A2 不在同一天录制时，日期类值会差出录制间隔的天数。报告给每个 compare 记 `clock`（各侧录制日期、B−A 天数偏移，时区取录制环境），顶部汇总；只有“除日期部分外完全相同、日期正好差这个天数”的差异（结果、事件、参数、全部样本都是此类的数据库文本单元格）归为“环境差异 `clock-skew`”，**仍计 fail**。剩余天数、到期间隔这类数值差异无法自动识别：涉及复习/到期的 fail 要在同一天重录 A 复核，或定期重录预录目录 |

建议给种子负责人（data-compat）的改进：种子里的时间默认值改成固定值，这样就不需要按生成时刻屏蔽（W13 不改该路径）。

`normalize-approvals.json` 与预录无关：归一化在比较时按 B 树的规则执行，同一预录目录在规则更新后仍可用（比较会按新规则重算）。

### 11.1 A 指纹 v2：哪些改动让 A 失效，怎么查

v1 把整个 `record/` 目录（`recorder` 闭包等）算进每个场景，任何录制器改动都让 3881 个 A 全部失效，重录 10–11 小时。v2 只算 **A 进程能执行的代码**：

- **切片规则**（`g3-slice.mjs`，TypeScript AST）：模块顶层语句分成纯声明（函数、字面量值的绑定、没有求值部分的类、类型）和副作用。A 进程加载的每个模块，副作用都算；纯声明只有被算进来的代码（传递地）引用时才算。拿不准的一律往多算：局部变量与顶层同名也算引用；命名空间导入、不解构的动态导入算导出的全部。分析不了的直接报错（计算出来的动态导入、`eval`、`require`、`Function()`、其他 `import.meta` 用法）或整文件计（解析错误、`import =`、`export =`、非代码文件）。CLI 主体 `if (… import.meta.url === …process.argv[1] …)` 只在 A 进程入口里算，在被导入的模块里不可能为真。种子模块 `scenario-seeds.ts` 按“包含”处理：它的导入不跟随、副作用不计，`createSeed`/`SEED_NAMES` 按种子内容计；A 运行的 `resolveSeed`/`copySeed` 用到它导入的某个绑定（第四批起 `describe` 用 `a-produced-seeds.ts` 的 `A_PRODUCED_SEED_NAMES`）时只取那条声明，目标模块里能够到这个绑定的副作用也一起计入。第九轮起 A 运行时还调用 `a-produced-seeds.ts` 的 `seedBindings`（`${seed.*}`，13.7）：它和 `createSeed` 一样不进切片，读 `${seed.` 的场景改按它对该种子的输出计（指纹分量 `seedBindings`，`scenarioDifference` 报 `seedBindings`）。
- **证明**（`g3-slice.test.mjs`、`g3-inputs.test.mjs`）：规则逐条有小模块用例；真实树上，B 侧、比较、报告、批处理、指纹自身的文件逐个改动后 3881 个场景的指纹都不变，A 侧文件改动只让对应服务单元的场景失效；V8 覆盖率：A 进程加载 `g3-run-a.mjs`、跑它的辅助函数、起停 LLM/云/MCP 服务并发请求、MCP stdio 程序走一次会话，**执行过的每个函数都落在切片的语句里**（另故意调用一个只有 B 用的函数作对照，检查必须报出它）；种子生成器加载并构建全部种子前后，全局对象、内建原型、环境变量、进程监听器、活动句柄完全相同。
- **取舍**：MCP 场景所在套件的每个场景都带 `mcp` 单元（A 分片里 `mcpBindingKinds` 起一次 MCP 服务）；种子生成器的产品导入靠种子内容与全局状态测试覆盖，不逐文件计；npm 包按 `package-lock.json` 计，不读 `node_modules`（原生模块另由录制回执的 sha256 守住）；`frontendEvents` 用录制提交自己的实现重算。完整的设计、证明与取舍见 `scripts/electron-migration/record/W13-PROGRESS.md` 第八轮。

查询（只读，约 30 秒/预录目录、两个提交约 1 分钟；`SERVER-COMMANDS.md` S2b 是服务器上的完整命令）：

```bash
node scripts/electron-migration/record/g3-a-stale.mjs --from <提交|预录目录> [--to <提交>]   # --to 缺省：当前工作树
#   [--file 套件 …] [--domain 域,…] [--tz 时区] [--locale 区域] [--no-seeds] [--json]
```

输出：有效场景数、不受影响数、stale 数（按原因计数）、预录里没有的（missing）、逐场景原因；`--json` 另有 `topUpScenarios`，在要录的提交的干净工作树上生成时可直接给 `g3-supervise --mode a-store --top-up-from`（10.4）。`--from` 是预录目录时，环境默认取它的 `environment`（仅 B 也要求相同）；node 与 MCP 启动参数是运行它的机器的，所以对预录目录要在录 B 的机器上跑。`--no-seeds` 不构建种子，种子内容不比较（输出注明）。

## 12. Rust 修复登记（rust-fixes/）与比较

各 lane 移植时修掉的 Rust 缺陷（`kind: rust-bug`）和有意的产品改动（`kind: deliberate`）登记在 `host/e2e/differential/rust-fixes/RF-*.json`（格式见 WAVE2-BRIEF §7，格式校验归 W09 门禁）。B 在这些地方有意与 A 不同，比较阶段按登记处理。录制不受影响。

### 12.1 与归一化的分工

| | `normalize-approvals.json`（N-xxx） | `rust-fixes/RF-*.json` |
|---|---|---|
| 处理什么 | 两侧都有的不确定噪声（随机 id、时间戳等），A1 与 A2 之间也会不同 | B 端有意的行为改变（修 Rust 缺陷或产品决策），A1 与 A2 一致、只有 B 不同 |
| 怎么处理 | 比较前把值换成占位符，差异消失 | 差异照常算出、原样留在 compare 产物里，分类时归入“Rust 修复豁免”（`rust-fix`），不计不一致 |
| 审批 | C2 | 主代理（`approvedBy: main`） |

两者互不替代：不能用 RF 登记掩盖噪声，也不能用归一化规则吞掉 B 的行为改变。

### 12.2 规则

- 只有 `status: approved` 的登记能豁免。命中的差异归 `rust-fix`，记登记 id 与 `kind`，不计入不一致；某 compare 的差异全部被豁免时该 compare 算相等，命令可以 pass。
- `status: proposed` 的命中只列为“待审”，差异保持原归类，**照常计 fail**。
- 未命中的差异按原规则（已知差异登记表、A1≠A2、clock-skew、真实产品差异）。approved 登记先于这些规则判断。
- `rust-bug` 与 `deliberate` 同一规则；报告按 `kind` 分开列出。
- **整条命中**：一条差异的每个差异位置（结果的每条差异路径、事件的每条差异路径、数据库的每个样本行）都必须被**同一条登记**的某个选择器覆盖才算命中；同一登记的多个选择器合起来覆盖（例如一行里同时改了 `vfs_index_units` 的 5 列，登记按列写 5 个选择器即可）；不同登记的选择器不合并。差异位置不完整时（数据库样本被截断、路径超过 64 条、旧产物没有路径列表）一律不命中。同一条差异里既有登记的位置又有别的位置时，整条照常计数。
- 格式规则以门禁 schema（`scripts/electron-migration/gate-checks/rust-fixes.schema.json`）为准：`table`/`event`/`command`/`path` 可含 `*` 但不能只有 `*`，`column` 可含 `*`；`scenario: *` 的 db 选择器须有 `jsonPath` 或不含通配的 `column`。G3 另外要求 `jsonPath` 是它能求值的字段路径。格式不符的登记（含文件名与 id 不一致、approved 缺 `approvedBy`/`approvedAt`、`affects` 与 `selectors` 矛盾、id 重复）不生效，列入报告“问题”（`invalid-rust-fix`）。

### 12.3 选择器与差异记录字段的对应

| 选择器 | 匹配的差异 `kind` | 字段对应 |
|---|---|---|
| `scenario` | 全部 | 场景 id，`*` 匹配任意字符 |
| `surface: ipc` + `command` | `outcome`、`outcome-kind`、`expectation`（`args` 是输入，从不豁免） | `command`（可通配）匹配 `difference.command`；不带 `jsonPath` 覆盖整个结果（含成功/失败形态改变）。有 `jsonPath` 时只匹配 `outcome`，且 `paths` 全部在该路径之下、`pathsComplete` 为真 |
| `surface: event` + `event` | `events` | 每个差异路径 `/<i>/…` 的第 `i` 个事件名（`eventNames[].A/.B`，非空的那些）都匹配 `event`（`*` 通配）；`jsonPath` 相对 G3 记录的事件 `{event, payload}`（`payload` 即 Tauri 事件载荷），路径须在 `/<i><jsonPath>` 之下，例如 `$.payload.result` 对应 `/<i>/payload/result` |
| `surface: db` + `table` + `column` | `database`、`final-database` | 样本完整（`sample.length == count`），每个样本行都是匹配 `table`/`column`（可通配）的 `value`/`storageClass` 差异；有 `jsonPath` 时两侧单元格都解析为 JSON，屏蔽同一登记里匹配该列的全部 `jsonPath` 后必须相同 |
| `surface: fs` + `path` | `database`、`final-database` | 每个样本都是 `kind: database`（数据库文件只在一侧存在），`db` 路径匹配 `path`（`*` 匹配一级目录）。G3 只采集数据库文件，其他文件不在比较范围内 |

`jsonPath` 支持 `$.name`、`$['name']`、`$[N]` 的组合。

比较器为此新增的差异字段（可选字段，旧产物没有；报告与回放总是从原始 trace 重算，所以旧录制也能用）：

- `outcome`、`events`：`paths`（全部差异位置的 JSON Pointer，最多 64 条）、`pathsComplete`（是否列全）。
- `events`：`eventNames`（`[{index, A, B}]`，每个差异事件下标两侧的事件名标签）。

### 12.4 报告与回放

- 报告（`g3-report.mjs`）自动读取树里的 `rust-fixes/`：JSON 顶层 `rustFixes`（`source` 目录与逐文件 sha256、`applied`、`exempt`、`pending`，每项 `{id, kind, differences, scenarios, commands}`），`inputs.rustFixes`；每个 compare 记 `rawEqual`（原始是否相等）与 `equal`（扣除豁免后）；逐命令行记 `rustFixes {exempt, exemptDifferences, pending}`。Markdown 有“Rust 修复登记（rust-fixes/）”一节，`rust-bug` 与 `deliberate` 各一小节。
- 只读回放（不写任何文件）：

```bash
cd $TREE && $NODE scripts/electron-migration/record/g3-replay.mjs --runs $OPS/$LABEL [--rust-fixes <树内目录，默认 host/e2e/differential/rust-fixes>]
```

  输出的 `rustFixes` 给出 `exempt`/`pending`（按 `kind` 分开，每个登记的差异条数、compare 数、示例场景）、`unequalCounted`（扣除豁免后仍不等的 compare 数）、`exemptOnly`（只因豁免而相等的 compare 数）与登记问题。

- 本机演示（2026-11-07，G2 留存的真实 A1/A2/B trace，现行场景文件字节一致的 2 个场景 `chat.stream.success.answer`、`review.rate.preview-good-undo`；临时登记只放在 `/tmp`，未提交）：无登记时残余 28 条差异全是“真实产品差异”。加一条 approved `rust-bug`（ipc `fsrs_get_card_memory_history` `$.card.text`）后，该命令的 2 条 `outcome` 差异归入豁免，产品差异 28 → 26。approved 的 db `anki_cards.extra_fields_json` 不命中，因为这些数据库差异的样本里还有别的表。proposed `deliberate` 的事件选择器 `chat_v2_event_*` 不命中，因为差异里第 7 个事件是 `chat_v2_session_*`；改成 `chat_v2_*` 后命中并列为待审，差异照常计数。

### 12.5 选择器检查（第九轮，`g3-rf-check.mjs`）

格式校验（12.2）只看登记写得对不对，不看它在比较器里能不能命中。`g3-rf-check` 不启动应用、不读 trace（约 1 秒），对每条登记的每个选择器回答两件事：比较器能不能解析，是否太宽。只报告，不改登记，不加任何归一化：

```bash
$NODE scripts/electron-migration/record/g3-rf-check.mjs [--json FILE] [--strict] [--root 树]
```

问题（这个选择器永远豁免不了任何差异，或整条登记根本没加载）：

| 类型 | 含义 |
|---|---|
| `entry` | 比较器拒绝整条登记（不是 JSON，或 12.2 的格式规则），它的选择器都不生效 |
| `selector` | 比较器求值不了这个选择器（例如 `jsonPath` 不是它支持的字段路径） |
| `no-scenario` | `scenario` 匹配不到语料里任何场景 |
| `no-command` | ipc：匹配的场景里没有一步执行匹配的 `command` |
| `no-capture` | event：匹配的场景都不捕获事件；db/fs：都不采集数据库 |
| `no-event` | event：`event` 匹配不到 A 订阅的任何通道（`g3-run-a` 的 `frontendEvents` 名字和 `{}` 模式） |
| `event-path` | event：`jsonPath` 不在 `$.event`/`$.payload` 之下（被覆盖的记录是 `{event, payload}`） |
| `no-table` / `no-column` | db：A 的建表语句（`src-tauri` 的迁移与源码里的 `CREATE [VIRTUAL] TABLE`、`ALTER TABLE … ADD COLUMN`）没有匹配的表或列；A 没有的表或列，差异是 `table`/`column` 行，db 选择器永远覆盖不到 |
| `fs-path` | fs：`path` 不含 `/`，只能指运行根下的文件，那里没有数据库（fs 选择器只覆盖“数据库文件只在一侧存在”的样本，`row.db` 相对运行根） |

范围宽（能命中，但豁免的不止修复改动的那个字段；宽不一定错，例如必须豁免结果形态，交属主确认）：`whole-outcome`（ipc 不带 `jsonPath`，覆盖整个结果，含成功/失败形态）、`whole-event`（event 不带 `jsonPath`）、`any-scenario`（`scenario: "*"`）、`name-wildcard`（`command`/`event`/`table`/`column` 里有 `*`）、`fs-name`（fs 的文件名没有数据库扩展名，只有 SQLite 文件头才算数据库）。

`--strict` 在有任何“问题”类时退出 1（范围宽不算）。第九轮树（合入 INT `2be7ed80`）的结果按属主 lane 列在 `scripts/electron-migration/record/W13-PROGRESS.md` 第九轮。

## 13. 语料检查、单场景录制、时钟

### 13.1 语料检查

```bash
$NODE scripts/electron-migration/record/g3-corpus-check.mjs [--json FILE] [--strict]
```

不启动任何应用，约 1 秒。检查全部套件：

- 阻塞项（这些场景一定录不成）：`invalid-scenario`、`not-a-v0-suite`、`unparseable-json`、`duplicate-id`、`unknown-seed`（不在 `scenario-seeds.ts` 的 `SEED_NAMES`）、`forward-reference`（`${N…}`、`${wait.N…}` 指向本步或之后的步骤）、`error-step-reference`、`bad-reference`（`${x.…}` 里的 x 不是 `g3-services.mjs` 提供的 `llm`/`provider`/`cloud`/`mock`/`mcp`/`search`，也不是录制自己解析的 `seed`/`wait`/`runner`（13.7）；`${runner.…}`、`${search.…}` 的键录制器不提供；`${mcp.…}` 的键不在 MCP 服务实际提供的键里；`${seed.…}` 的种子不提供绑定或没有这个键；`${wait.N…}` 的第 N 步没有 `waitAfter`；或非字符串的整值占位被嵌在字符串中）、`unknown-cloud-seed`、`unknown-search-response`（场景的 `search` 写了 SearXNG 模拟没有的引擎或响应名）、`wait-without-events`（步骤有 `waitBefore`/`waitAfter`，场景却是 `capture.events: false`；A 只在捕获事件的场景里订阅，等待必然超时，B 却可能等到）。W13 第七轮树：231 个套件、3881 个场景，阻塞项 56 条、涉及 33 个场景，全部在 `pending-*` 套件里（其中 MCP 8 条：`pending-mock/mcp-oauth-websocket.json` 的 `${mcp.oauth.*}`、`${mcp.*.wsUrl}`，服务没有这些 mock）。W13 第九轮树（合入 INT `2be7ed80`）：233 个套件、3887 个场景，阻塞项 43 条、涉及 26 个场景，仍全部在 `pending-*` 里：`bad-reference` 32 条（`${runner.*}` 25、`${seed.*}` 4、`${fixture.*}` 2、`${search.*}` 1）、`unknown-seed` 11 条；`date-literal` 警告 521 条。W13 第十轮树（合入 INT `1d1fdb78`，`${runner.*}`、`${search.*}` 已接）：阻塞项 17 条、涉及 13 个场景，全部在 `pending-*` 里：`unknown-seed` 11 条、`bad-reference` 6 条（`${seed.*}` 4、`${fixture.*}` 2）。
- 警告：`llm-script-missing`（场景若调用模型会拿到 404）、`unknown-embedding-model`（场景对 LLM 服务的绑定全部写在 `isEmbedding: true` 的模型配置里，所以只会走 `/embeddings`，而这个路由不看脚本名、照样应答；此时改为检查模型名，不在 `host/plugins/llm-providers/src/replay/embeddings.ts` 的会拿到 404）、`a-unregistered-command`（命令不在 `src-tauri/src/lib.rs` 的 `generate_handler!` 里，`plugin:` 命令除外）、`date-literal`（步骤里写死的日期；MCP 协议版本 `"protocolVersion": "2025-06-18"` 是版本号而非日期，第九轮起不再算，无论它是参数字段还是嵌在 JSON 文本里）。

`--strict` 在有阻塞项时退出 1。`g3-run-a`/`g3-run-b` 对未提供的绑定命名空间、未定义的种子、种子不提供的 `${seed.…}` 键和场景级 `concurrent`（13.4）直接记为 `unsupported`（不启动应用）。

### 13.2 单场景录制（诊断）

`g3-batch.mjs --scenario ID`（可重复，配合 `--file`）只录指定场景。分片键为 `<套件>/only-<12 位 hash>-NNN`，与全量分片分开，之后对同一输出目录跑全量也不会把它当常规分片复用。找不到的 id 在写任何文件之前拒绝。诊断直接跑 `g3-batch`（命令见 `SERVER-COMMANDS.md` S7）；`g3-supervise --mode a-store` 透传 `--scenario`，并有 `--top-up-from <B 目录>/a-store-coverage.json`（按 `topUpScenarios` 选套件和场景，录成封存的增补预录目录，见 10.4）。

### 13.3 时钟与随机数

两侧都没有冻结时钟和随机数，只固定了 `TZ`/`LANG`/`LC_ALL`。语料里 527 个步骤带日期字面量；A/A2 预录与 B 录制不在同一天时，依赖“今天”的场景可能出现差异，判读时先对照两边的录制时间。

拆分录制的时间戳（N-014，已批准，INT `3c8f35f7`）：A1、A2 同时录，写库时刻常常同一秒，N-010 因 A1=A2 不当易变处理，按确定值逐字比较；B 几分钟到几天后录，必然不同。比较方式：
- 只在 `g3-compare --split-recording`（批处理只在 b-only 传）且 A、B 都有录制窗口、两窗口不重叠时生效；否则记入 `normalizationSkipped`，照常逐字比较。
- 窗口 = 本侧 worker 进程启动（种子在 worker 内建，含生成时刻）到本次 take 结束，按整秒放宽 1 秒。B 和新录的 A 在 trace 里带 `recording {workerStartedAt, startedAt, endedAt}`；旧预录用 worker 回执 `process.startedAt` 到 `run/app-process.json` 的 `endedAt`（批处理以 `--a-window` 传入，报告重算时校验它落在该 take 的 worker 回执窗口内）。
- 只看 A1=A2 的位置（A1≠A2 的位置照旧由 N-010 等决定）；文本里的 `YYYY-MM-DD[ T]hh:mm:ss[.f][Z|±hh:mm]` 片段和 10/13 位 epoch 整数，**落在本侧窗口内**的换成形状占位 `<tw:…>`，窗口外（种子里的历史时间等）原样比较；一侧窗口内、另一侧窗口外仍判差。
- 先后检查：两侧都被替换的位置配对，A、B 上严格先后相反的报 `timestamp-order` 差异（按较粗精度，同一秒不报）。
- 取舍：不比较相对窗口起点的偏移（两侧启动都有 8 秒以上静置，Tauri 与 Host 每步耗时不同，容差要放到几十秒才不误报，没有意义）；因此“某个时间戳晚了 20 秒”这类差异在拆分录制下看不出来，需要时用同时录制或冻结时钟复核。
`get_app_version` 的构建号和提交（N-015，已批准）：只对 `<版本> (Build <n>, <hex>)` 整串把构建号和提交换成占位，版本号照比。

已知缺口（不提规则，没有证据）：合录时 A1、A2 同时写 `vfs.db` 的 `__change_log.changed_at`，若 A1=A2 同一秒而 B 晚一秒，N-010 不把 A1=A2 的位置当易变，N-001 的同秒碰撞只覆盖 `mistakes.db`，这一格会判差。拆分录制下 N-014 已覆盖（`g3-normalize-proposals.test.mjs` 用 ser-38 smoke 的真实秒数回归）。合录真出现时带 compare 产物回来再提。

冻结时钟（两侧注入同一个“现在”）需要 A（Rust/Tauri）和 B（Host）各自支持，交接见 `W13-PROGRESS.md` 第六轮；录制侧已在 trace 里记录窗口，接上后可直接把注入值写进 `trace.recording`。

### 13.4 MCP 场景（第七轮已接线）

按 `host/plugins/mcp/equivalence/README.md` 的“G3 接线”一节实现（W21 提供服务模块，W13 接录制侧）。语料里 39 个非 pending 场景使用 `${mcp.*}`，现在两侧都录；`pending-mock/mcp-oauth-websocket.json` 的 5 个场景用到服务没有的键（`${mcp.oauth.*}`、`${mcp.*.wsUrl}`），两侧都记 `unsupported`（不启动应用），语料检查列为阻塞项。第九轮树（合入 INT `2be7ed80`）：服务已提供 oauth、wsUrl 键，W21 把这些场景并入 `mcp-commands.json`（`85d5905d`），语料检查不再有 MCP 阻塞项；用到 MCP 服务（`${mcp.…}` 或 `mcp` 字段）的场景 44 个，其中 41 个不在 `pending-*`，另外 2 个在 `pending-runner/mcp-oauth-browser.json`（OAuth 浏览器），1 个在 browser 的 `pending-network/`。

- **私有目录**：每个 worker 的 namespace init 在 `/tmp/g3-mcp` 挂一个私有 tmpfs（`mode=0700,size=64m`）并导出 `G3_MCP_DIR`（`g3-worker.mjs`；生命周期测试“each worker gets its own private MCP directory”验证，见 1.4）。服务把 stdio 服务器及其依赖复制到这里自包含运行（`selfContained`），日志也写在这里；不在 worker 里（没有 `G3_MCP_DIR`）的 MCP 场景直接拒绝运行。
- **固定输入**：端口 47130（每个 worker 有自己的 net namespace），命令是录制用 node 的 `process.execPath`，所以 `${mcp.<名>.command}`、`.args`、`.cwd` 等在 A1、A2、B 上逐字节相同。场景里键段允许 `-`（`${mcp.disconnect-on-list.args}`）；整值占位（字符串里只有这一个占位）按服务给出的 JSON 原值替换（数组、对象、数字不再被转成字符串）。
- **输入指纹**：用到 `${mcp.` 的场景（以及同一套件里的其他场景，A 分片会起一次 MCP 服务查键）用 `a+mcp` 代码单元（切片含 mcp-service.ts；stdio-server.ts、protocol.ts 按字节计为 `resource:`，stdio-server.ts 另有自己的切片 `program:`），用到的另记 `launch:mcp`（第 11 节）；其他套件不受影响。
- **等待**：MCP stdio 回复用 `{"channel": "mcp-stdio-${N.sessionId}-message", "jsonrpcId": <id>}`（按 JSON-RPC id 匹配 `payload.message`）；备份任务用 `{"channel": "<事件名>", "payload": {"<点路径>": <值或候选列表>}}`（按路径做 JSON 精确相等）。所有等待只认本步 invoke 之后到达的事件（锚点 `since`），同一会话发两次、第二个备份任务都不会被前一步的事件满足。
- **超时与静置**：用到 MCP 的场景单步上限 90 秒（高于 A 的 60 秒 SSE 探测与 30 秒 stdio 断连探测）。每次取快照前等 MCP 的 HTTP/SSE 请求结束；最后一次（`after`）还等 stdio 子进程全部退出。等不到不算错误，状态 `{idle, open, liveStdio}` 记进 trace，两侧不同时报 `service-idle` 差异（Rust 端留着某个子进程或请求而 Host 关掉了，或者反过来）。
- **证据**：trace 的服务记录里有 `mcp {port, logDir, scripts, records}`，只记服务端证据（stdio 的 pid 和会话号每次运行都不同，不记）。
- **OAuth 浏览器（第九轮，mcp README “G3 接线” 第 9 条）**：场景 `mcp.oauth: true` 或用到 `${mcp.oauth.…}` 时，两侧应用启动环境的 `PATH` 最前面是服务给的替身浏览器目录（`service.browserLaunch().pathDir`，里面的 `xdg-open` 把授权 URL 交给服务）。A、A2 由 `startSupervised` 带进 Tauri，B 由 `HostProcess` 带进 Host，同一个场景两侧相同；其他场景的环境不变。`g3-services.test.mjs` 在真实 OAuth 套件上起服务，检查 `command -v xdg-open` 解析到替身（在服务器上用 dash 也跑一遍，见 `SERVER-COMMANDS.md` S2）。
- **`concurrent`（第九轮，第 10 条）**：录制器按顺序执行步骤，不支持场景级 `concurrent`。照顺序录出来的 take 是另一个场景，所以两侧都记 `unsupported: scenario uses concurrent`，不启动应用（现有语料只有 `host/plugins/mcp/equivalence/pending-runner/mcp-oauth-browser.json` 的 `start_with_client_id_then_cancel`）。要支持需要两侧驱动都能并发发 invoke，以后若做会是 A 路径改动（13.7 末尾）。

### 13.5 启动观察协议 G3-STARTUP/v1（第七轮）

修复前 A 在应用就绪后静置 8 秒才订阅事件，漏掉 step 0 之前的事件（如 `data-governance-migration-status`）；B 从 fork 起全量捕获。Lance 启动维护（setup 后 6 秒）落在 A 的 before 快照之前、B 的之后，两侧 before 不一致（A 独有 `rag_documents` 表等）。这是录制器的差异，不是产品差异，不能靠归一化掩盖。现在两侧（`g3-startup.mjs`，A 由 `g3-run-a.mjs`、B 由 `g3-run-b.mjs` 调用）做同一件事：

1. 就绪时开始记录事件（A 在就绪时订阅；B 从 fork 起记录）。
2. 至少等到就绪后 8 秒（Rust 插件引导 3 秒、Lance 维护 6 秒、Host 对应的 startup-maintenance 6 秒），然后要求事件数与数据库指纹连续 1 秒不变；最长到就绪后 30 秒，等不到记 `settled: false`，不算错误。
3. 调一次 `vfs_set_indexing_config {"key":"indexing.interval_secs","value":"86400"}`，把 5 秒一次的 VFS 索引计时器推到 24 小时，避免它插进命令采集。恢复模式下这条命令没注册：结果（成功或错误）原样记下，**不中断**录制；两侧结果不同时报 `startup-setup` 差异。
4. 再等一次静置，取边界：此前的事件存进 `trace.startup.events`，**不比较**（A 的 webview 听不到首次订阅前 Tauri setup 发的事件，B 都听得到，比较它们等于比较录制器）；`before` 快照和每一步的事件都从边界开始。

`trace.startup` 记规则名 `G3-STARTUP/v1`、静置结果、setup 结果、边界距就绪的毫秒数；compare 产物记各侧 `startup {rule, settled, setup, events}`。不同规则的 take 不比较（第 11 节）。代价：每个 take 多 8–9 秒（最长 30 秒）。

### 13.6 待批的归一化规则（`proposed`，未生效）

都写在 `normalize-approvals.json`，附证据与测试（`host/e2e/differential/g3-normalize-proposals.test.mjs`，用 ser-38 smoke `g3-b-smoke-007c1af54c3e` 的 `save_api_configurations` 真实值）。批准前照常逐字比较：

- **N-016 AEAD 信封**：任意转义深度的 `{"ciphertext":"<b64>","nonce":"<b64>","version":<n>}`，只在 A1≠A2 时把 ciphertext、nonce 当作 token，占位带长度（`~b64*<len>`），版本、键序、长度照比，同一密文在别处的引用必须一致；A1=A2 的信封逐字比较。
- **N-017 按稳定主键命名占位**：主键各列在每次采集中 A1、A2 的多重集都相同（不是审计表、不是 N-010 序列），且非空、唯一，则按主键顺序处理行，占位名用主键（`u1:mistakes.db/settings[key='vendor_configs']/value.3`），一侧多出的行不再让另一侧所有序号错位；随机主键的表照旧按序号命名。
- 两条都批准后，smoke 里 `save_api_configurations` 的 vendor/model JSON 差异消失，只剩 A 独有的 `lance.optimize.last.*` 行（真实差异，第七轮启动协议下应重新观察）。

### 13.7 等待里的通道候选、等待捕获、种子绑定（第九轮，A 路径）

第八轮推迟的三项录制器功能，各自一个提交、各自有测试：`eabde8ad`（通道候选）、`618e412e`（等待捕获）、`89b54389`（`${seed.*}`）。两侧用同一份 `scenario-v0.mjs`/`g3-wait.mjs` 解释场景，所以 A、B 的行为一起变。

**对现有场景的输出没有影响**：W13 第九轮树（合入 INT `2be7ed80`）的语料里没有场景写 `"channel": "a|b"` 或 `${wait.…}`；只有 `pending-seed/historical-zip.json` 的 2 个场景写 `${seed.…}`，它们的种子还不存在（下面），照旧是 `unsupported`。不用这些写法的场景走的是原来的代码：单个通道名按 `|` 拆开只有它自己，仍是精确相等；没有 `${seed.` 时不取种子绑定（`bindings` 为 null）。

**对现有 A 的影响**：三项都改了 A 进程执行的代码（`code:` 原因），所以各自都让全部场景 stale-a（`g3-a-stale` 本地实测，3887 个场景）。场景定义、种子、LLM 脚本、事件表这些分量都不变，原因只有 `code:`：

| 区间 | stale | 原因 |
|---|---:|---|
| `4ae24dc9`（第五批合入）→ `5c0777f1`（测试修正） | 0 | — |
| `5c0777f1` → `eabde8ad`（通道候选） | 3887 | `code:g3-wait.mjs` |
| `eabde8ad` → `618e412e`（等待捕获） | 3887 | `code:g3-services.mjs`、`g3-wait.mjs`、`scenario-v0.mjs` |
| `3991a334` → `89b54389`（`${seed.*}`） | 3887 | `code:g3-run-a.mjs`、`g3-services.mjs`、`scenario-v0.mjs` |
| `4ae24dc9` → `89b54389`（合计） | 3887 | 只有上面 4 个文件；missing 0、removed 0 |

第五批（INT `fe5feb68` → `390f244b`）本身已经让 3877 个场景 stale、10 个 missing（共 3887 个要增补），所以第五批之后的全量重录无论如何都要做。三项赶在这次重录前合入，**不多录一轮**；重录之后再合，就要再录 10–11 小时。

**通道候选**：等待的 `channel` 可以写 `"a|b"`，事件名等于其中任意一个就算匹配（`event` 原来就支持 `|`）。空候选（`"a|"`、`"|"`）在场景校验时报错。例如 MCP stdio 会话等回复或关闭，先到哪个算哪个（通道里的 `${1}` 照旧是第 1 步结果）：

```json
{ "waitAfter": { "channel": "mcp-stdio-${1}-message|mcp-stdio-${1}-closed" } }
```

**等待捕获 `${wait.N.path}`**：第 N 步 `waitAfter` 匹配到的那个事件的 payload，可以被后面步骤的 `args`、`waitBefore`、`waitAfter` 引用，取法和 `${N.path}` 读第 N 步结果相同（点路径；`${wait.N}` 是整个 payload；整值占位按 JSON 原值替换，嵌在更长的字符串里只能是字符串或数字）。第 N 步必须在本步之前且有 `waitAfter`，否则场景校验报错，语料检查报 `forward-reference`/`bad-reference`；运行时 payload 里没有这个路径，这次运行失败（`missing reference field`，和 `${N.path}` 一样是 runner 错误，不是结果）。解析出的值进入这一步的 `args`，两侧取到的值不同就是 `args` 差异（输入，从不豁免，12.3）。用途是 qbank 的 `pendingExportRequestId`：`qbank-export-paper` 事件（A 订阅表里有）的 `request_id` 是 Rust 端现生成的 uuid，只能从事件里取：

```json
{ "cmd": "<触发 qbank 导出工具的命令>", "args": {}, "waitAfter": { "channel": "qbank-export-paper" } },
{ "cmd": "qbank_complete_paper_export", "args": { "requestId": "${wait.0.request_id}", "data": "UEsDBA==", "error": null } }
```

**种子绑定 `${seed.*}`**：值来自 `a-produced-seeds.ts` 的 `seedBindings(种子名, 本次运行的种子副本目录)`（W21），每个 take 在自己的副本上取一次，例如 `${seed.file.portableZip}` 是副本里 zip 的绝对路径。

- 路径差异：种子副本目录就是 take 的运行根，A1、A2、B 各不相同。它们被已批准的 **N-007**（各侧运行根换成 `<run>`）统一处理，结果和数据库里回显的路径比较时相同；不需要第八轮设想的固定 tmpfs 路径。`g3-seed.test.mjs` 用真实 `buildCompare` 验证：两侧路径只差运行根时相等，相对运行根的位置不同（或文件名不同）时仍判差。
- 缺什么就不录：种子不提供绑定（`seedBindings` 返回 null）、场景要的键种子没有，两侧都记 `unsupported`（不启动应用），语料检查报 `bad-reference`。`l21-historical-zip-v1` 要等 W21 在服务器上用 A 跑 `producers.v0.json`、提交 `a-produced/PROVENANCE.json` 之后才存在（`A_PRODUCED_SEED_NAMES` 只在那之后进 `SEED_NAMES`），之后它的 2 个场景可录；不在全量重录里的话按 S8 增补。
- 输入指纹：读 `${seed.` 的场景，A 指纹多一项 `seedBindings`（该种子绑定在占位目录 `<seed>` 下的 sha256），绑定改了只让这些场景 stale；`seedBindings` 函数本身不进 A 切片（按输出计，和 `createSeed` 一样）。

**运行器绑定 `${runner.*}`**（第十轮，backup README §5、§9.4）：
- `${runner.scratchDir}`：每个 take 一个空目录 `<run>/runner/scratch`，不在 `HOME`、数据目录、`TMPDIR` 下（A 会对这些路径做 sanitize）；`${runner.scratchDir}/x.zip` 这样的拼接可以。
- `${runner.fixture.notZip}`：`<run>/runner/fixtures/not-a-zip.zip`，内容固定为 ASCII `not a zip\n`。
- 两者都在运行根下，和 `${seed.*}` 一样由 N-007 统一成 `<run>`，A、B 的参数比较时相同。只有用到 `${runner.` 的场景才建 `runner/` 目录，其他场景的运行目录不变。
- `${runner.unixNow}`、`${runner.unixNow(Plus|Minus)N}`：该步派发前读一次时钟得到的 Unix 秒（字符串），加减 N 秒；同一步的 `waitAfter` 用同一读数。值每个 take 都不同，进 `argsRaw`；没有为它加规范化规则，A1≠A2 的位置照现有规则处理，B 与 A 的差异照实报告。

**搜索模拟 `${search.searxngUrl}`**（第十轮，browser README pending-mock）：`g3-search-service.mjs` 在固定端口 47140 起一个本地 SearXNG（避开 47110、47120-47122、47130）；两侧都发 `GET {endpoint}/search?q=…&format=json…`，每个请求按场景的 `search.searxng` 列表依次回放（缺省 `["success"]`，列表用完后重复最后一项），可选 `success`、`empty`、`http-500`，返回固定 JSON。请求日志进 trace 的 `search`。未知引擎或响应名两侧记 `unsupported`，语料检查报 `unknown-search-response`。

**LLM 端口**（第十轮，W28 H-B3）：`startScenarioServices` 的 `llmPort`、`searchPort` 与 `runScenarioB` 的 `llmPort` 缺省就是 47110、47140，G3 录制不传；只有不在 worker 网络命名空间里的测试传 0。trace 的 `llmService.port` 记实际绑定的端口（缺省时仍是 47110）。

**以后的 A 路径项**（未做）：`${fixture.*}`（2 条，qbank：改写成上面的等待捕获即可，不需要录制器再改）、场景级 `concurrent`（13.4）。
