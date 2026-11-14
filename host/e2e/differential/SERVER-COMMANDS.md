# ser-38 服务器命令清单（G3 smoke、A/A2 预录、仅 B、单场景诊断）

> 执行人：主代理。W13 不连服务器。背景、判据细节与故障定位见 `G3-RECORDING-RUNBOOK.md`（下文“手册 §N”）。
> 前提：落地 worktree `/home/dsdev/dev/ds-landing`（分支 `assault/landing`）已落地完成且干净；以 root 登录执行下面的命令（`systemd-run` 需要 root），所有 git、node、录制都以 **dsdev** 身份运行，进 `dsdev.slice`。
> 录制产物（trace，大）写 `$OPS`；报告和判定材料（小）收进 `/home/dsdev/dev/landing/reports/<id>/`。

顺序：S0 变量 → S1 冻结树 → S2 前置检查 → S2b A 失效预查 → S3 A/A2 预录 smoke → S4 仅 B smoke → S5 A/A2 预录全量 → S6 仅 B 全量（之后每个 INT 版本重复 S1、S2、S2b、S4、S6）→ S7 W04 单场景诊断（S2 之后随时可跑，与 S5 互斥）；S2b 或 S4/S6 报 stale-a 或 missing 时插入 S8 A 增补；结论报基础设施 runner 错误时插入 S5b 重试。

**W13 第七轮（2026-11-07）后的变化**：unit `TasksMax` 1200 → 4000，`dsdev.slice` 须 ≥ 6000（`g3slice`）；生命周期测试 16 条；MCP 场景已接线（不再 `unsupported`）；录制器改了，**2026-11-07 用 `007c1af5` 录的预录目录对第七轮之后的 B 全部 stale-a，S3、S5 要从新的 `ASHA` 重录**（S5 开头）。

**W13 第八轮（2026-11-07）后的变化**：A 指纹改为 `g3-inputs/v2`。只有这些会让一个场景的 A 失效：A 进程能执行的代码（`g3-run-a.mjs` 的声明级切片，加上该场景启动的服务模块）、它构建的种子、A 的命令行与隔离方式、node、前端事件表、场景本身及其 LLM 脚本和引用文件。B 侧、比较、报告和批处理记账的改动不再让全部 3881 个 A 失效（设计与证明见 `scripts/electron-migration/record/W13-PROGRESS.md` 第八轮）。
- **第八轮合入本身不使任何 A 失效**：`g3-a-stale --from 246e490a`（本轮的 INT 基点）对本轮树 3881 个场景全部不受影响；本轮已合入 INT `fe5feb68`（第四批），`g3-a-stale --from fe5feb68` 对交付树也是 0 个。
- **第四批合入本身让全部 A 失效**（与第八轮无关，W13 在 `3380c140` 和交付树上都实测过）：3877 个场景 stale-a，原因是 W21 改了 A 复制种子时运行的 `scenario-seeds.ts`（`describe` 用到新模块 `a-produced-seeds.ts`）；另有 4 个场景被替换（missing）。其中 168 个 LLM 场景还因 W05 的模拟服务改用 `host/plugins/llm-providers/src/replay/*` 和 `@noble/hashes` 而失效。第七轮已经要求重录 S3、S5，这次全量重录正好覆盖它们，不会多出一轮。
- **S5 的时机**：第四批合入后必须全量重录。如果 W13 还要合入 A 路径上的录制器功能（`${seed.*}`、等待捕获、等待里写多个 channel，见 `W13-PROGRESS.md` 第八轮“推迟项”），在这次重录前合入就不用多录一轮，之后再合就要再录 10–11 小时。等不等，由主代理决定。
- 旧预录目录（v1，包括第七轮之后在录的 `$STORE`）不用重录：仅 B 按它的录制提交重算成 v2，再逐场景比较。
- 若 `$ASHA` 早于 W25 的 LLM 服务改动（`c9f5029c`，新增 `/embeddings`、`/audio/transcriptions`、`w0.directive`），用到 LLM 的 168 个场景会是 stale-a（`code:host/e2e/streaming/wave0/llm-service.ts` 等），按 S8 增补，约 1–1.5 小时。
- 新增 S2b：每棵冻结树跑一次 `g3-a-stale`，在录 B 之前就知道 S4/S6 会有哪些 stale-a，并可直接据此录增补。

**W13 第九轮（2026-11-07）后的变化**（细节见手册 §13.4、§13.7、§12.5）：
- **第五批合入（INT `fe5feb68` → `390f244b`）本身让全部 A 失效**：`g3-a-stale` 实测 3887 个场景里 3877 个 stale-a、10 个 missing（另有 4 个被删除），要增补的共 3887 个，远超 S2b 的约 1500 门槛，所以 **S5 必须从新的 `ASHA` 全量重录**。原因：W21 改了 A 复制种子时运行的种子模块（`b07960e0`），MCP 服务改动（`83b49b40`，64 个场景），另有 14 个场景定义改了。
- **第八轮推迟的三项 A 路径功能已经做完**（等待里写多个 channel `"a|b"`、等待捕获 `${wait.N.path}`、`${seed.*}`），各自一个提交、各自有测试。现有场景的输出不变（语料里没有场景用前两种写法；用 `${seed.*}` 的 2 个场景种子还不存在，照旧 `unsupported`）。它们改了 A 进程的代码，所以各自也让全部 3887 个 A 失效（原因只有 `code:`，场景、种子、LLM 分量不变）。**建议在 S5 之前合入**：反正要全量重录，不多录一轮；S5 之后再合就要再录 10–11 小时。
- 另外两项录制侧改动（同样在 A 路径上，同样建议在 S5 之前合入）：场景级 `concurrent` 两侧都记 `unsupported`（录制器按顺序执行步骤，录出来会是另一个场景）；MCP OAuth 场景启动时 `PATH` 最前面是服务给的替身浏览器（`xdg-open`）。
- **新的 `ASHA` 取落地后第一个同时含第五批与 W13 第九轮的提交**（`unset ASHA` 后重粘 S0），之后 S1 → S2 → S2b（对旧 `$STORE` 应报约 3887 个 stale）→ S3 → S5。
- S2 多跑两个测试（`g3-seed`、`g3-services`，后者在服务器上用 dash 解析替身浏览器）和一个只读检查（`g3-rf-check`，rust-fixes 选择器能否命中，不阻塞）。
- 语料检查数字变了（S2）：233 个套件、3887 个场景，阻塞项 43 条、涉及 26 个场景，仍全部在 `pending-*` 里；`date-literal` 527 → 521（MCP 的 `protocolVersion` 不再算日期）。
- **W13 第十轮**：`${runner.*}`（backup `pending-runner/` 25 处）和 `${search.searxngUrl}`（browser `pending-mock/` 1 处，SearXNG 模拟服务固定端口 47140）两侧都接上；LLM 端口可传参（缺省仍 47110）。同样只让 A 的 `code:` 分量失效（3887 个，`g3-a-stale 99f01253 → ce3ea902`），一起在 S5 之前合入即可。S2 多跑 `g3-runner-search`（端口都是 0）。语料检查阻塞项 43 → 17（手册 §13.1）。场景本身仍在 `pending-*`，移出由 W21 决定。
- 规范化器拆成三个模块（`g3-normalize.mjs` 加 `g3-normalize-values.mjs`、`g3-normalize-clock.mjs`），compare 产物里的 `normalizer.sha256` 改为覆盖整组模块和 `json.mjs`。所以旧树产生的 compare 在新树上一律判过期：报告记 `invalid-compare … normalizer sha256 mismatch`，`g3-batch` 不复用、从 trace 重算。只需重算，不用重录；A 指纹不变，S2b 的数字不受影响。

## S0. 变量和辅助函数（每个新 shell 先粘一次）

```bash
LAND=/home/dsdev/dev/ds-landing
NODE=/opt/node26/bin/node
OPS=/home/dsdev/ops-night
REPORTS=/home/dsdev/dev/landing/reports
RECEIPT=/home/dsdev/dev/ds-mig/X7-differential/fixtures/differential/wp043/builds/20261106023719-bc16bc/receipt.json
RECEIPT_SHA=$(sha256sum $RECEIPT | cut -d' ' -f1)
SHA=$(sudo -u dsdev git -C $LAND rev-parse HEAD)                 # 本次要录的提交（落地分支当前头）
TREE=/home/dsdev/dev/ds-mig/_g3-record-${SHA:0:12}
ASHA=${ASHA:-$SHA}                                                 # A/A2 预录用的提交：含 W13 第七轮的第一个落地提交，之后固定不变（S5 开头）
ATREE=/home/dsdev/dev/ds-mig/_g3-astore-${ASHA:0:12}               # A 树与 B 树分开建（S1），B 侧写入弄不脏预录的录制树
STORE=$OPS/g3-astore-${ASHA:0:12}
SMOKE_STORE=$OPS/g3-astore-smoke-${ASHA:0:12}
SMOKE_SUITES="--file fixtures/differential/wp043/get-app-version.v0.json --file host/plugins/review/equivalence/wp229-insight.v0.json --file host/plugins/review/equivalence/pending-provider/wp229-essay-stream-scripted.json"
DSENV="env HOME=/home/dsdev PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin"

# g3run LABEL WORKDIR SCRIPT ARGS… ：以 dsdev 在 dsdev.slice 里后台运行，打印 unit 名；输出追加到 $OPS/LABEL.service.log
g3run() {
  local label=$1 dir=$2; shift 2
  local unit=ds-$label-$(date +%m%d%H%M%S)
  systemd-run --unit=$unit --uid=dsdev --gid=dsdev --slice=dsdev.slice \
    --property=WorkingDirectory=$dir --setenv=HOME=/home/dsdev --setenv=PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin \
    --property=MemoryMax=12G --property=MemorySwapMax=1G --property=TasksMax=4000 --property=CPUQuota=1000% --property=Nice=10 \
    --property=KillMode=control-group --property=TimeoutStopSec=300 \
    --property=StandardOutput=append:$OPS/$label.service.log --property=StandardError=append:$OPS/$label.service.log \
    $NODE "$@" && echo $unit
}
# g3wait UNIT ：等到 unit 结束，打印退出状态
g3wait() { while systemctl is-active -q $1; do sleep 60; done; systemctl show $1 -p Result,ExecMainStatus --no-pager; }
# g3peak UNIT ：运行中看资源（MemoryCurrent 接近 12G、TasksCurrent 接近 4000 就要处理，见手册 §2）
g3peak() { systemctl show $1 -p MemoryCurrent,MemoryPeak,TasksCurrent,CPUUsageNSec --no-pager; }
# g3slice ：每次启动录制前查外层 slice 的线程上限：TasksMax 必须 ≥ 6000（或 infinity），否则 unit 的 4000 不起作用（手册 §2）
g3slice() {
  local max; max=$(systemctl show dsdev.slice -p TasksMax --value)
  systemctl show dsdev.slice -p TasksMax,TasksCurrent --no-pager
  if [ "$max" = infinity ] || [ "$max" -ge 6000 ]; then echo slice-ok; else echo "slice-too-low: systemctl set-property --runtime dsdev.slice TasksMax=6000"; fi
}
# g3collect OUT ID ：把小文件收进 $REPORTS/ID（不复制 trace）
g3collect() {
  sudo -u dsdev mkdir -p $REPORTS/$2 && (cd $1 && sudo -u dsdev cp -p --parents $(ls SUPERVISOR-RESULT.json SUPERVISOR.json batch-result.json \
    RECORDING.json A-STORE.json a-store-coverage.json progress.json report/g3-report.json report/g3-report.md 2>/dev/null) $REPORTS/$2/)
  ls $REPORTS/$2
}
```

`$OPS` 的路径和 `$RECEIPT` 沿用手册 §0；A 构建回执原文件不能移动或改动（预录目录按 sha256 引用它）。

## S1. 冻结录制树（每个要录的提交一次，约 1 分钟，约 0.3GB）

录制期间落地分支还会往前走，所以不能直接在 `$LAND` 里录：给本次提交建一个只读的分离 worktree。

```bash
sudo -u dsdev git -C $LAND status --porcelain --untracked-files=no     # 必须为空
sudo -u dsdev git -C $LAND worktree add --detach $TREE $SHA
NM=$(readlink -f $LAND/node_modules); test -d "$NM" || NM=$(readlink -f /home/dsdev/dev/deep-student/node_modules)
sudo -u dsdev ln -s $NM $TREE/node_modules && echo node_modules=$NM
sudo -u dsdev git -C $TREE status --porcelain --untracked-files=no     # 必须为空
G=$(sed 's/^gitdir: //' $TREE/.git); find $TREE -maxdepth 1 ! -user dsdev; find $G ! -user dsdev   # 两条都必须没有输出
# 只在新的 ASHA 第一次（S3/S5 之前）：同一提交另建 A 树
test -d $ATREE || { sudo -u dsdev git -C $LAND worktree add --detach $ATREE $ASHA && sudo -u dsdev ln -s $NM $ATREE/node_modules; }
sudo -u dsdev git -C $ATREE rev-parse HEAD; sudo -u dsdev git -C $ATREE status --porcelain --untracked-files=no   # HEAD 等于 $ASHA，状态为空
```

- 失败：`worktree add` 报已存在 → 目录是上次建的，`git -C $TREE rev-parse HEAD` 等于 `$SHA` 就直接用；属主检查有输出 → `chown -R dsdev:dsdev <路径>` 后重查。
- **录制期间不要在 `$NM` 所在仓库 `npm install`**：运行器把 node 和原生模块 sha256 写进回执，中途变化会拒绝续跑（手册 §1.2）。

## S2. 前置检查（每棵冻结树一次，约 3 分钟）

```bash
cd $TREE
sudo -u dsdev mkdir -p /tmp/opencode && sudo -u dsdev test -w /tmp/opencode && echo writable
pgrep -u dsdev -af 'g3-(batch|supervise|run-a|run-b)|Xvfb|unshare' || echo none          # 必须 none
df -h $OPS /tmp | cat                                                                    # 见下面的磁盘要求
g3slice                                                                                  # 必须 slice-ok
sudo -u dsdev $DSENV $NODE scripts/electron-migration/record/g3-corpus-check.mjs --strict --json /tmp/opencode/g3-corpus-${SHA:0:12}.json; echo exit=$?
sudo -u dsdev $DSENV $NODE --test --test-reporter=dot host/e2e/differential/g3-lifecycle.test.mjs 2>&1 | grep -E '^# (pass|fail|skipped)'
sudo -u dsdev $DSENV $NODE --test --test-reporter=dot host/e2e/differential/g3-split.test.mjs host/e2e/differential/g3-supervise-split.test.mjs \
  host/e2e/differential/g3-inputs.test.mjs host/e2e/differential/g3-slice.test.mjs host/e2e/differential/g3-a-stale.test.mjs \
  host/e2e/differential/g3-rust-fixes.test.mjs host/e2e/differential/g3-corpus-check.test.mjs \
  host/e2e/differential/g3-seed.test.mjs host/e2e/differential/g3-services.test.mjs host/e2e/differential/g3-rf-check.test.mjs \
  host/e2e/differential/g3-runner-search.test.mjs 2>&1 | grep -E '^# (pass|fail|skipped)'
sudo -u dsdev $DSENV $NODE scripts/electron-migration/record/g3-rf-check.mjs --json /tmp/opencode/g3-rf-${SHA:0:12}.json | head -3
sudo -u dsdev mkdir -p $REPORTS/g3-preflight-${SHA:0:12} && sudo -u dsdev cp /tmp/opencode/g3-corpus-${SHA:0:12}.json $REPORTS/g3-preflight-${SHA:0:12}/corpus-check.json
sudo -u dsdev cp /tmp/opencode/g3-rf-${SHA:0:12}.json $REPORTS/g3-preflight-${SHA:0:12}/rf-check.json
```

判定（全部满足才往下走）：

| 检查 | 通过 | 不通过时 |
|---|---|---|
| 语料检查 | 下面核对命令输出 `unexpected: 0` | 列出的文件和场景交给套件属主；`unexpected` 非 0 就停 |
| 生命周期测试 | `pass 16`、`fail 0`、`skipped 0`（5 条 Linux 用例真实运行，含“each worker gets its own private MCP directory at the fixed path”，只能在服务器上验证） | 停，不要录；把输出带回 W13。只有 MCP 目录那条失败时，非 MCP 场景仍能录，但 MCP 场景（第九轮树不在 `pending-*` 的 41 个）会 runner-error（手册 §1.4） |
| 拆分 / 指纹 / RF / 语料 / 种子 / 服务测试 | `fail 0`、`skipped 0`（`g3-slice` 的覆盖率用例与 `g3-services` 在服务器上起 LLM、云、MCP 服务，端口都是 0，不占固定端口；`g3-services` 用 `sh -c 'command -v xdg-open'` 检查替身浏览器，服务器上 `sh` 是 dash） | 同上；只有 `g3-slice`/`g3-a-stale` 失败时，S2b 的结论不可信，S4/S6 照常（仅 B 自己判 stale-a）；只有 `g3-services` 失败时，非 OAuth 场景照常录，OAuth 场景（全在 `pending-*`）不用管 |
| rust-fixes 选择器 | 只读，**不阻塞**；第一行 `problems {…}` 列出永远命中不了的选择器 | 把 `rf-check.json` 交主代理，按登记属主分发（手册 §12.5；W13 第九轮的清单见 `scripts/electron-migration/record/W13-PROGRESS.md`） |
| 线程上限 | `g3slice` 输出 `slice-ok` | 以 root 执行 `systemctl set-property --runtime dsdev.slice TasksMax=6000`（`--runtime` 重启失效；夜间 `z-night.conf` 曾把它压在 1800，所以每批启动前都查）。不改就录，A/A2 会因 EAGAIN 大量 runner-error（2026-11-07 第 1 批约 43%） |
| 磁盘 | `$OPS` 所在盘：S3+S4 ≥ 2GB；S5 ≥ 40GB；每个 S6 ≥ 20GB。`/tmp` ≥ 25GiB（准入阈值） | 清理旧的 smoke/诊断目录（只删 `$OPS/g3-*smoke*`、`$OPS/g3-diag-*`，不删已封存的预录目录） |

语料检查：`--strict` 在有任何阻塞项时退出 1，**现在预期就是 `exit=1`**。W13 第七轮树（INT `f3439333` + W13）的结果（231 个套件、3881 个场景）：阻塞项 56 条、涉及 33 个场景，**全部在 `pending-*` 套件里**（未定义种子、`${runner.*}`/`${seed.*}` 绑定，以及 `pending-mock/mcp-oauth-websocket.json` 里 MCP 服务没有的 `${mcp.oauth.*}`、`${mcp.*.wsUrl}` 共 8 条）。MCP 已接线，非 pending 的 39 个 MCP 场景不再是阻塞项，核对命令也不再放过 `${mcp.`。W13 第八轮交付树（合入 INT `fe5feb68`，含第四批）：233 个套件、3881 个场景，阻塞项 52 条、涉及 31 个场景，同样全部在 `pending-*` 里（`bad-reference` 41、`unknown-seed` 11）。W13 第九轮树（合入 INT `2be7ed80`，含第五批）：233 个套件、3887 个场景，阻塞项 43 条、涉及 26 个场景，全部在 `pending-*` 里（`bad-reference` 32：`${runner.*}` 25、`${seed.*}` 4、`${fixture.*}` 2、`${search.*}` 1；`unknown-seed` 11）。W13 第十轮树（合入 INT `1d1fdb78`，`${runner.*}`、`${search.*}` 已接）：阻塞项 17 条、涉及 13 个场景，全部在 `pending-*` 里（`unknown-seed` 11、`bad-reference` 6：`${seed.*}` 4、`${fixture.*}` 2）。运行器把阻塞的场景直接记为 `unsupported`，不启动应用。判据：`pending-*` 以外没有阻塞项。核对命令：

```bash
$NODE -e 'const B=["invalid-scenario","not-a-v0-suite","unparseable-json","duplicate-id","unknown-seed","forward-reference","error-step-reference","bad-reference","unknown-cloud-seed","wait-without-events"];
const r=require(process.argv[1]); const odd=r.findings.filter(f=>B.includes(f.kind)&&!/\/pending-/.test(f.file));
console.log({scenarios:r.scenarios, blocked:r.blockedScenarios, unexpected:odd.length}); for (const f of odd.slice(0,20)) console.log(f.kind, f.file, f.id, f.detail)' /tmp/opencode/g3-corpus-${SHA:0:12}.json
```

`unexpected: 0` 才继续。警告不阻塞（第八轮交付树：`llm-script-missing` 0 条，第四批里 W21 给 qbank 出题套件补了 `.provider.json`；`unknown-embedding-model` 0 条；`a-unregistered-command` 0 条；`date-literal` 527 条；第九轮树 521 条，MCP 的 `protocolVersion` 不再算）。第八轮起，模型配置全是 `isEmbedding: true` 的场景（vfs-repos 15 个）不再报 `llm-script-missing`，改为核对模型名是否在 `host/plugins/llm-providers/src/replay/embeddings.ts` 里（第四批之后 X5 的 `/embeddings` 由它应答）。

## S2b. A 失效预查（每棵冻结树一次，约 1 分钟；S4/S6 之前）

`g3-a-stale` 按逐场景 A 输入（`g3-inputs/v2`）列出：这棵树上哪些场景用不了某个预录目录的 A/A2，以及原因。判定和 S4/S6 写进 `a-store-coverage.json` 的完全相同，但不用先录 B。只读：不写预录目录，不启动应用；种子在 `/tmp` 里临时生成，结束即删。必须在服务器上用 `$NODE` 跑：node 版本和 MCP 启动参数是本机的，换台机器会全部报 `runtime:node`。

```bash
cd $TREE
for S in $SMOKE_STORE $STORE; do
  test -f $S/A-STORE.json || { echo "$S: not recorded yet"; continue; }
  F=/tmp/opencode/g3-a-stale-$(basename $S)-${SHA:0:12}.json
  sudo -u dsdev $DSENV $NODE scripts/electron-migration/record/g3-a-stale.mjs --from $S --json | sudo -u dsdev tee $F > /dev/null; echo "$S exit=${PIPESTATUS[0]}"
  $NODE -e 'const r=require(process.argv[1]); console.log({ store: r.from.dir, inputs: r.from.scenarioInputs, defects: r.from.defects, to: r.to,
  scenarios: r.scenarios, unaffected: r.unaffected, stale: r.stale.length, missing: r.missing.length, reasons: r.reasons })' $F
done
sudo -u dsdev mkdir -p $REPORTS/g3-preflight-${SHA:0:12} && sudo -u dsdev cp /tmp/opencode/g3-a-stale-*-${SHA:0:12}.json $REPORTS/g3-preflight-${SHA:0:12}/
```

判定：

| 输出 | 含义 | 下一步 |
|---|---|---|
| `exit=0`、`defects: []`、`to.dirty: []` | 结果可用 | 看下面几行 |
| `stale: 0`、`missing: 0` | 这棵树所有场景都能用该预录目录的 A | 直接 S4/S6 |
| `stale + missing` ≤ 约 1500 | 这些场景在 S4/S6 里会是 stale-a / missing（不比较） | 按 S8 直接用这个文件录增补（`--top-up-from $F`），再跑 S6；也可以先跑 S6，再用它的 `a-store-coverage.json` 增补 |
| `stale + missing` > 约 1500 | 增补比重录慢：增补约 0.4 分钟/场景，S5 全量约 0.17 分钟/场景 | 按 S5 用这个 `$SHA` 作新的 `ASHA` 重录 |
| `defects` 非空 | 仅 B 会拒绝这个预录目录 | 停，带回 W13 |
| `inputs: suite-fingerprint-only` | 预录目录的录制提交在 `$TREE` 读不到（`$TREE` 是 `$LAND` 的 worktree，正常读得到） | 所有场景都报 `schema`；查 `git -C $TREE cat-file -t <recorderHead>` |

原因（`reasons`，一个场景可有多个）：`scenario` 场景定义；`seed` 种子内容；`seedBindings` 场景读的 `${seed.*}` 绑定（第九轮）；`llm` 它的 LLM 脚本条目；`events` 前端事件表（只影响捕获事件的场景）；`services` 它启动的服务集合；`code:<文件>` A 进程能执行的代码在该文件里变了；`resource:<文件>` A 侧服务按 URL 复制或提供的文件；`program:<入口>:<文件>` 服务派生的独立进程（MCP stdio 服务器）的代码；`package:<名>` 切片用到的 npm 包（按 `package-lock.json`）；`launch:a` g3-batch 的 A 命令行或 namespace 包装/init；`launch:mcp`；`runtime:node`；`environment`；`file:<路径>` 场景引用的仓库文件。

合入前预估（可选，本地或服务器均可，约 1 分钟，`/tmp` 临时占用约 0.6GB）：两个提交之间哪些 A 会失效。`--to` 缺省是当前工作树。

```bash
cd $TREE && sudo -u dsdev $DSENV $NODE scripts/electron-migration/record/g3-a-stale.mjs --from $ASHA --to $SHA | head -40
```

## S3. A/A2 预录 smoke（第一次落地做一次，10–20 分钟，< 1GB）

只在 `ASHA` 对应的树上做（第一次 `ASHA=SHA`，就是 `$TREE`）。先 dry-run（几秒，`--verify-binary` 重算 A binary sha256，约 1 分钟）：

```bash
cd $ATREE && sudo -u dsdev $DSENV $NODE scripts/electron-migration/record/g3-supervise.mjs --mode a-store --tree $ATREE --commit $ASHA \
  --a-receipt $RECEIPT --a-receipt-sha256 $RECEIPT_SHA --out $SMOKE_STORE --phase smoke $SMOKE_SUITES --verify-binary --dry-run \
  | $NODE -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("preflight.ok =",r.preflight.ok);for(const c of r.preflight.checks)if(!c.ok)console.log("FAIL",c.name,JSON.stringify(c.detail))})'
```

`preflight.ok = true` 后启动：

```bash
U=$(g3run g3-astore-smoke-${ASHA:0:12} $ATREE scripts/electron-migration/record/g3-supervise.mjs --mode a-store --tree $ATREE --commit $ASHA \
  --a-receipt $RECEIPT --a-receipt-sha256 $RECEIPT_SHA --out $SMOKE_STORE --phase smoke $SMOKE_SUITES); echo $U
g3peak $U; tail -3 $SMOKE_STORE/batch.log      # 运行中随时看
g3wait $U
```

资源：A、A2 各 1 个 worker，每个 worker 一个 Tauri + WebKit + Xvfb；内存峰值预计 2–4GB（未实测，以 `g3peak` 为准，把 `MemoryPeak` 记进报告）。

判定（手册 §9.4，全部满足）：

```bash
cd $SMOKE_STORE && $NODE -e '
const r = require("./SUPERVISOR-RESULT.json"); const b = r.phases.batch.result;
console.log({ verdict: r.verdict, exit: r.exitCode, mode: b.mode, rejected: b.rejectedShards, outcomes: b.workerOutcomes,
  runnerErrors: b.runnerErrors, defects: r.phases.store?.defects, coverage: r.phases.store?.coverage, reasons: r.reasons });'
ls RECORDING.json host-receipt.json B compare 2>&1 | grep -c 'No such file'      # 必须是 4
pgrep -u dsdev -af 'Xvfb|unshare|deep-student|g3-run' || echo "no leftovers"
g3collect $SMOKE_STORE g3-astore-smoke-${ASHA:0:12}
```

1. `verdict: complete`、`exit: 0`、`mode: a-store`，`rejected` 全 0，`outcomes` 只有 `exited`。
2. `defects: []`；`coverage` 的 `A`、`A2` 都是 6 减去 `runnerErrors`（期望 `runnerErrors` 为 0）。
3. 每个 A/A2 take 的 Tauri 进程 `exited/0/closed/-`、单个 take < 3 分钟（逐分片检查命令见手册 §3.3），无残留进程。

失败：不要进 S5；按手册 §5 定位，`$OPS/g3-astore-smoke-*.service.log` 和 `$SMOKE_STORE/logs/` 带回。

## S4. 仅 B smoke（每个 INT 版本一次，5–15 分钟，< 1GB）

```bash
cd $TREE && sudo -u dsdev $DSENV $NODE scripts/electron-migration/record/g3-supervise.mjs --mode b-only --tree $TREE --b-commit $SHA \
  --a-store $SMOKE_STORE --a-store-sha256 $(sha256sum $SMOKE_STORE/A-STORE.json | cut -d' ' -f1) \
  --out $OPS/g3-b-smoke-${SHA:0:12} --phase smoke $SMOKE_SUITES --dry-run | grep -o '"ok": *false' | wc -l     # 必须是 0
U=$(g3run g3-b-smoke-${SHA:0:12} $TREE scripts/electron-migration/record/g3-supervise.mjs --mode b-only --tree $TREE --b-commit $SHA \
  --a-store $SMOKE_STORE --a-store-sha256 $(sha256sum $SMOKE_STORE/A-STORE.json | cut -d' ' -f1) \
  --out $OPS/g3-b-smoke-${SHA:0:12} --phase smoke $SMOKE_SUITES); g3wait $U
```

资源：B 1 个 worker（Host 子进程，无 X server），compare 1 个；内存 < 2GB。

判定（手册 §10.3）：

```bash
cd $OPS/g3-b-smoke-${SHA:0:12} && $NODE -e '
const r = require("./SUPERVISOR-RESULT.json"); const b = r.phases.batch.result; const c = require("./a-store-coverage.json");
console.log({ verdict: r.verdict, mode: b.mode, rejected: b.rejectedShards, compared: b.compared, compareErrors: b.compareErrors,
  runnerErrors: b.runnerErrors, defects: r.phases.provenance.defects, totals: r.phases.report?.summary?.totals, topUp: c.topUp, reasons: r.reasons });'
ls receipts; grep -m1 '预录目录' report/g3-report.md; grep -c unattributable-recording report/g3-report.md
g3collect $OPS/g3-b-smoke-${SHA:0:12} g3-b-smoke-${SHA:0:12}
```

1. `verdict: complete`，`rejected` 全 0，`compared` 等于 S3 里 A、A2 都录到的场景数（6），`compareErrors: 0`，`defects: []`。
2. `receipts` 只有 `B`；报告有“A/A2 取自 A 预录目录 1 个”；`unattributable-recording` 计数为 0。
3. `equal`/`unequal`（报告里的 pass/fail）是比对结论，不是 smoke 判据。
4. `verdict: incomplete` 且原因是 `A/A2 unavailable: N stale-a scenario(s), M missing, …` → `$ASHA` 之后这 3 个套件里有场景改了（stale-a）或新增了（missing）；其余场景照常比较。按 S8 用这次的 `a-store-coverage.json` 录一个增补 store，再带上它重跑本节。

## S5. A/A2 预录全量（每个录制器版本一次，约 10–11 小时，分 3 批；约 30GB，按 40GB 预留）

**W13 第七轮合入后必须从新的 `ASHA` 重录。** 第七轮改了录制器（两侧统一的启动观察协议 G3-STARTUP/v1、等待锚点、MCP 接线、闭包边界，手册 §13.4–13.5），新增 `runner-a`、`mcp` 闭包，所以 2026-11-07 用 `007c1af5` 录的 `$OPS/g3-astore-007c1af54c3e`（第 1 批）对第七轮之后的 B 树**全部是 stale-a**，比较器也拒绝启动规则不同的 take。旧目录只对第七轮之前的 B 树有效；它的第 2、3 批不值得再在旧树上录（除非还要比较第七轮之前的 B）。新的 `ASHA` 取落地后第一个含 W13 第七轮的提交（`unset ASHA` 后重粘 S0），S1 建 `$ATREE`，S2、S3 走一遍，再开始下面的第 1 批。

**第八轮（A 指纹 v2）不要求重录**（开头）。以后是否要从新的 `ASHA` 重录，看 S2b 对新树报的 `stale + missing`：超过约 1500 才值得重录，否则按 S8 增补。

**第五批合入后必须重录**（开头“第九轮”）：S2b 对旧 `$STORE` 报约 3887 个 stale + missing。`ASHA` 要同时含第五批与 W13 第九轮的录制器改动，这一次重录就把两者都覆盖了。

每批同一条命令，只换 `DOMAINS`；每批约 3.5 小时（`--deadline-min 300` 到点不再开新分片）。**每批启动前先 `g3slice`**（`slice-ok`）。

| 批 | `DOMAINS` | 场景数（W13 第七轮树） |
|---|---|---:|
| 1 | `chat,notes,anki,review,qbank` | 1112 |
| 2 | `vfs,vfs-handlers,vfs-repos,vfs-index` | 1232 |
| 3 | 空（删掉 `--domain $DOMAINS`，其余全部） | 1537 |

合计 231 个套件、3881 个有效场景。

```bash
g3slice                                        # 必须 slice-ok
DOMAINS=chat,notes,anki,review,qbank
U=$(g3run g3-astore-${ASHA:0:12} $ATREE scripts/electron-migration/record/g3-supervise.mjs --mode a-store --tree $ATREE --commit $ASHA \
  --a-receipt $RECEIPT --a-receipt-sha256 $RECEIPT_SHA --out $STORE --phase full --domain $DOMAINS \
  --deadline-min 300 --total-timeout-min 400 --coverage); echo $U
cat $STORE/progress.json; g3peak $U          # 第一批开始 15 分钟后看一次：MemoryPeak、TasksCurrent 记下
g3wait $U
```

资源：A、A2 各 3 个 worker（合计 6，硬上限）；每个 worker 一套 Tauri + WebKit + Xvfb。`MemoryMax=12G`；准入控制（可用内存 ≥ 8GiB、`/tmp` ≥ 25GiB、dsdev 线程 < 1400、CPU pressure ≤ 40%）不满足时会等待，不会挤爆机器，但会变慢。

每批判定：

```bash
cd $STORE && $NODE -e '
const r = require("./SUPERVISOR-RESULT.json"); const b = r.phases.batch.result;
console.log({ verdict: r.verdict, rejected: b.rejectedShards, outcomes: b.workerOutcomes, runnerErrors: b.runnerErrors,
  coverage: r.phases.store?.coverage, defects: r.phases.store?.defects, reasons: r.reasons });'
g3collect $STORE g3-astore-${ASHA:0:12}-batch$(date +%m%d%H%M)
```

- `verdict: incomplete` 且原因只有 `deferred by --deadline-min` → 同一条命令再跑一次（继续本批）；`complete` → 换下一批的 `DOMAINS`。
- `rejected` 非 0 → 被拒绝的分片下次自动重跑；同一分片连续两批被拒就停，按手册 §5 查。
- `defects` 非空 → 停。
- `runnerErrors`：`unsupported` 只剩 `pending-*` 套件里的场景（第九轮树：语料检查阻塞的 26 个——未定义种子，`${runner.*}`、`${fixture.*}`、`${search.*}`，种子还不提供绑定的 `${seed.*}`——加上用场景级 `concurrent` 的 1 个）；MCP 场景照常录（第九轮树不在 `pending-*` 的 41 个，oauth/WebSocket 键服务已提供）。其余是场景本身的失败；只在数量明显异常（比如一整个套件都报错）时才查。
- 原因里有 `infrastructure runner errors (EAGAIN / thread creation, …): A=… A2=…` → 不是场景结果。先 `g3slice`，再用**同一条命令加 `--retry-infra-errors`** 跑一次（只重跑这些分片，S5b）；`phases.failures` 给出按侧计数与签名。
- 三批都 `complete` 后按手册 §9.6 封存，记下 `STORE_SHA=$(sha256sum $STORE/A-STORE.json | cut -d' ' -f1)`，写进 `$REPORTS/g3-astore-${ASHA:0:12}/STORE_SHA`。

## S5b. 重试 runner 错误（按需）

已接纳的分片（含 runner-error 的也算）同一条命令再跑会直接复用；要重跑就加重试参数（运行参数，不改 `--out` 的意图）。语义与选择见手册 §9.7：`--retry-infra-errors` 只重跑基础设施错误（首选，第七轮之后的树才有）；`--retry-errors-before ISO` 重跑早于该时刻的含错分片（每个失败只重试一次）；`--retry-errors` 每次运行都重跑全部含错分片（只加在一次运行上）。

新树（第七轮之后的 `$ATREE`/`$TREE`），以 S5 第 1 批为例：

```bash
g3slice                                        # 必须 slice-ok
DOMAINS=chat,notes,anki,review,qbank
cd $ATREE && sudo -u dsdev $DSENV $NODE scripts/electron-migration/record/g3-supervise.mjs --mode a-store --tree $ATREE --commit $ASHA \
  --a-receipt $RECEIPT --a-receipt-sha256 $RECEIPT_SHA --out $STORE --phase full --domain $DOMAINS \
  --deadline-min 300 --total-timeout-min 400 --coverage --retry-infra-errors --dry-run \
  | $NODE -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("preflight.ok =",r.preflight.ok,"| batch tail:",r.batch.slice(-2).join(" "));for(const c of r.preflight.checks)if(!c.ok)console.log("FAIL",c.name,JSON.stringify(c.detail))})'
U=$(g3run g3-astore-${ASHA:0:12} $ATREE scripts/electron-migration/record/g3-supervise.mjs --mode a-store --tree $ATREE --commit $ASHA \
  --a-receipt $RECEIPT --a-receipt-sha256 $RECEIPT_SHA --out $STORE --phase full --domain $DOMAINS \
  --deadline-min 300 --total-timeout-min 400 --coverage --retry-infra-errors); echo $U
g3wait $U
grep -c 'infrastructure runner-error retry' $STORE/batch.log      # 重跑过的分片数（每侧每分片一行；batch.log 累计所有运行）
```

**旧的第 1 批（`007c1af5`，可选，需主代理决定）**：只对第七轮之前的 B 树有用（见 S5 开头）。旧树的 `g3-supervise` 不认重试参数（报 `Unknown option`），要用新树（第七轮之后的 `$TREE`）里的 `g3-supervise.mjs` 驱动旧树：它在旧树里启动旧树自己的 `g3-batch`，`a-store` 意图字段两版相同，同一 `--out` 可续跑。旧树的 `g3-batch` 只认 `--retry-errors` 和 `--retry-errors-before`。09:55 调整线程上限时还在跑的分片，`summary.json` 晚于 09:55 却含调整前的 EAGAIN，所以截止时间取 10:30（09:55 + 单分片超时 30 分钟 + kill-grace），或者按原计划用 `--retry-errors` 整批重试一次。

```bash
OLD_ASHA=007c1af54c3ebdb44a23e000c438a2ad3882e089
OLD_ATREE=/home/dsdev/dev/ds-mig/_g3-astore-007c1af54c3e
OLD_STORE=$OPS/g3-astore-007c1af54c3e
systemctl list-units --no-legend 'ds-g3-astore-007c1af54c3e-*' | grep -c running   # 必须 0：旧批不在跑
g3slice                                                                        # 必须 slice-ok
RETRY="--retry-errors-before $(date -d '2026-11-07 10:30' --iso-8601=seconds)"   # 服务器本地时间 10:30；或 RETRY=--retry-errors（只加这一次）
echo $RETRY
cd $OLD_ATREE && sudo -u dsdev $DSENV $NODE $TREE/scripts/electron-migration/record/g3-supervise.mjs --mode a-store --tree $OLD_ATREE --commit $OLD_ASHA \
  --a-receipt $RECEIPT --a-receipt-sha256 $RECEIPT_SHA --out $OLD_STORE --phase full --domain chat,notes,anki,review,qbank \
  --deadline-min 300 --total-timeout-min 400 --coverage $RETRY --dry-run \
  | $NODE -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("preflight.ok =",r.preflight.ok,"| batch tail:",r.batch.slice(-2).join(" "));for(const c of r.preflight.checks)if(!c.ok)console.log("FAIL",c.name,JSON.stringify(c.detail))})'
U=$(g3run g3-astore-007c1af54c3e $OLD_ATREE $TREE/scripts/electron-migration/record/g3-supervise.mjs --mode a-store --tree $OLD_ATREE --commit $OLD_ASHA \
  --a-receipt $RECEIPT --a-receipt-sha256 $RECEIPT_SHA --out $OLD_STORE --phase full --domain chat,notes,anki,review,qbank \
  --deadline-min 300 --total-timeout-min 400 --coverage $RETRY); echo $U
g3wait $U
grep -c 'rerun: runner-error retry' $OLD_STORE/batch.log          # 重跑过的分片数（累计）
```

判定同 S5（`phases.failures` 是新 supervisor 从分片目录读出的按侧计数，旧树录的分片也一样分类）。`preflight.checks` 里有 `batch-option:--retry-…` 一项为 `ok`；若 `FAIL out` 且 `changed` 非空，说明意图字段对不上（命令和原批不同，比如 `--phase`、`--tz`），按原批命令改，不要换 `--out`。

## S6. 仅 B 全量（每个 INT 版本一次，约 5 小时；按 20GB 预留）

前提：S1、S2、S4 在这个 `$SHA` 上通过；`STORE_SHA` 已记下（S5 封存后）；`$SHA` 含 W13 第七轮时，`$STORE` 也必须是第七轮之后录的（否则全部 stale-a，S5 开头）。S2b 对 `$STORE` 的结果已看过：其中的 `stale + missing` 就是本节会报的 stale-a / missing 数；已按 S8 用 S2b 的文件录了增补时，把命令里的 `--a-store … --a-store-sha256 …` 换成 S8 的 `$ASTORES`。

```bash
g3slice                                        # 必须 slice-ok
STORE_SHA=$(cat $REPORTS/g3-astore-${ASHA:0:12}/STORE_SHA)
DOMAINS=chat,notes,anki,review,qbank          # 批 2：vfs,vfs-handlers,vfs-repos,vfs-index；批 3：删掉 --domain
U=$(g3run g3-b-${SHA:0:12} $TREE scripts/electron-migration/record/g3-supervise.mjs --mode b-only --tree $TREE --b-commit $SHA \
  --a-store $STORE --a-store-sha256 $STORE_SHA --out $OPS/g3-b-${SHA:0:12} --phase full --domain $DOMAINS \
  --deadline-min 300 --total-timeout-min 400); echo $U
g3peak $U; g3wait $U
cd $OPS/g3-b-${SHA:0:12} && $NODE -e '
const r = require("./SUPERVISOR-RESULT.json"); const b = r.phases.batch.result; const c = require("./a-store-coverage.json");
console.log({ verdict: r.verdict, rejected: b.rejectedShards, compared: b.compared, compareErrors: b.compareErrors, runnerErrors: b.runnerErrors,
  defects: r.phases.provenance.defects, totals: r.phases.report?.summary?.totals, staleA: b.aStore.staleA, missingA: b.aStore.missingA,
  awaitingA: b.aStore.awaitingA, topUpScenarios: c.topUpScenarios.length, reasons: r.reasons });'
g3collect $OPS/g3-b-${SHA:0:12} g3-b-${SHA:0:12}
```

资源：B 6 个 worker（6 个 Host 子进程，无 X server），compare 2 个。6 个 Host 同时运行的内存峰值未实测：第一批 15 分钟后 `g3peak`，`MemoryCurrent` 超过 10G 就 `systemctl stop $U`，加 `--workers-b 4` 用同一条命令续跑（已接纳的分片复用）。

判定：`compareErrors: 0`、`defects: []`、`rejected` 全 0；`staleA`/`missingA` 非 0 → 这些场景没有比较（不计 pass/fail），按 S8 增补后带上增补 store 重跑本节（已接纳的 B 分片和 compare 复用，只补新比较的）；`awaitingA` 非 0 → 基础 store 还没录完这些场景，等 S5 下一批；结论原因与续跑规则同 S5。报告 `report/g3-report.md` 的 pass/fail 是给各 lane 的比对结论，RF 豁免与归一化在里面单独列出（手册 §12）。

**旧 B 目录**：每个 B 目录约 15GB。下一个 INT 版本的 S6 通过后，上一个版本的 B 目录只留 `$REPORTS` 里的报告即可，trace 可删（`rm -rf $OPS/g3-b-<旧 sha12>`），不要删预录目录 `$STORE` 和 `$RECEIPT`。

## S8. A 增补 store（按需；S4/S6 报 stale-a 或 missing 时）

基础 store（`$STORE`、`$SMOKE_STORE`）不改：它继续由 `$ATREE` 上的旧代码录完（S5 三批都用 `$ATREE`）。场景改了或新增了，就从**当前** `$TREE` 只录这些场景，另封一个增补 store；仅 B 同时引用基础 store 和若干增补 store，每个各自按 sha256 校验，同一场景取命令行里**最后**一个有匹配 A/A2 的 store。

判定一个场景能不能用某个 store 的 A，看逐场景输入（`g3-inputs/v2`，S2b 列了全部原因）：场景定义本身（`stringifyExact`）、它的种子 digest、它用到的 LLM 脚本条目（`<套件>.provider.json` 里 `llm ?? id` 那一条）、A 进程能执行的代码（`g3-run-a.mjs` 的切片加所用服务模块，逐文件）、前端事件表、A 命令行与隔离、node、环境、场景里引用的仓库文件。新 store 把这些写在 `A-STORE.json` 的 `inputs.scenarios`；旧 store（v1，包括正在录的 `$STORE`）没有，就用它的 `recorder.head` 从 git 按 v2 重算（`$TREE` 是 `$LAND` 的 worktree，`$ASHA` 可读）；`a-store-coverage.json` 的 `stores[].scenarioInputs` 写明是 `recorded` 还是 `recomputed-from-recorder-head`（读不到提交时退回套件级指纹 `suite-fingerprint-only`）。

两种来源都可以给 `--top-up-from`：S4/S6 的 `a-store-coverage.json`，或 S2b 在**同一个 `$SHA` 的干净 `$TREE`** 上生成的 `g3-a-stale` 文件（这样不用等 S6；别的提交或脏树生成的文件会被拒绝）。下面以 B 目录为例；用 S2b 的文件时把 `$B_OUT/a-store-coverage.json` 换成 `/tmp/opencode/g3-a-stale-$(basename $STORE)-${SHA:0:12}.json`（smoke 用 `$SMOKE_STORE`）。

```bash
B_OUT=$OPS/g3-b-${SHA:0:12}                       # 报 stale-a/missing 的那次仅 B 目录（smoke 用 $OPS/g3-b-smoke-${SHA:0:12}）
TOPUP=$OPS/g3-astore-topup-${SHA:0:12}-$(date +%m%d%H%M)
$NODE -e 'const c=require(process.argv[1]);console.log(c.topUpScenarios.length,"scenarios");for(const s of c.staleA ?? c.stale)console.log("stale-a",s.file,s.id,s.reasons.join(","))' $B_OUT/a-store-coverage.json
cd $TREE && sudo -u dsdev $DSENV $NODE scripts/electron-migration/record/g3-supervise.mjs --mode a-store --tree $TREE --commit $SHA \
  --a-receipt $RECEIPT --a-receipt-sha256 $RECEIPT_SHA --out $TOPUP --phase full --top-up-from $B_OUT/a-store-coverage.json --dry-run \
  | grep -o '"ok": *false' | wc -l                 # 必须是 0
U=$(g3run g3-astore-topup-${SHA:0:12} $TREE scripts/electron-migration/record/g3-supervise.mjs --mode a-store --tree $TREE --commit $SHA \
  --a-receipt $RECEIPT --a-receipt-sha256 $RECEIPT_SHA --out $TOPUP --phase full --top-up-from $B_OUT/a-store-coverage.json); g3wait $U
echo "$TOPUP $(sha256sum $TOPUP/A-STORE.json | cut -d' ' -f1)" | sudo -u dsdev tee -a $REPORTS/g3-astore-${ASHA:0:12}/TOPUPS
g3collect $TOPUP g3-astore-topup-${SHA:0:12}
```

`--top-up-from` 读 `topUpScenarios`（`{file, id}`），等价于对这些套件给 `--file`、对这些场景给 `--scenario`；分片键是 `…/only-<hash>-NNN`，与全量分片分开。判定同 S3（`verdict: complete`、`defects: []`、`rejected` 全 0）。

带增补重跑仅 B（S4/S6 的命令把 `--a-store … --a-store-sha256 …` 换成下面的 `$ASTORES`，基础 store 在前、增补按录制先后在后）：

```bash
ASTORES="--a-store $STORE --a-store-sha256 $STORE_SHA $(awk '{printf "--a-store %s --a-store-sha256 %s ", $1, $2}' $REPORTS/g3-astore-${ASHA:0:12}/TOPUPS)"
echo $ASTORES
```

smoke（S4）用 `$SMOKE_STORE` 及其 sha256 代替 `$STORE $STORE_SHA`，增补清单另记在 `$REPORTS/g3-astore-smoke-${ASHA:0:12}/TOPUPS`。

报告（`report/g3-report.md` “录制回执”一行）写每个 store 提供了几个场景的 A，逐场景来源在 `g3-report.json` 的 `recording.aStores[].scenarios`，以及 `a-store-coverage.json` 的 `suites[<套件>].sources`（场景 id → store sha256 前 12 位）。stale-a 的场景列在 `a-store-coverage.json` 的 `staleA`（含原因，词表见 S2b；v1 时期的 `closure:<名>` 不再出现）。

时长：A、A2 各 3 个 worker，按旧数据 A 分片中位 4.3 分钟/10 场景估：50 个场景约 25 分钟，150 个约 1 小时，300 个约 2 小时（含封存，不含排队）；磁盘约 8MB/场景。W21 本轮补的 44 个种子、152 个 LLM 脚本落地后，凡是用到它们的场景都会变 stale-a 或 missing，预计一次增补 200–250 个场景，约 1.5–2 小时、约 2GB。

## S7. W04 单场景诊断：`memory.batch_move.basic` 第 0 步 A 侧 trace（每轮 2–5 分钟，约 50MB）

目的：W04 怀疑 Rust 后台索引有竞态，需要 A 侧第 0 步（第一个 `memory_write`）之后的完整捕获。每轮录 A 和 A2 两个 take；跑 3 轮得到 6 个 take，看第 0 步捕获是否在 take 之间变化。不需要 B，不需要预录目录；与 S5 同时跑会抢 worker 名额，放在 S5 之前或两批之间。

```bash
SUITE=host/plugins/memory/equivalence/memory-batch-export-search.json
for i in 1 2 3; do
  DIAG=$OPS/g3-diag-w04-${SHA:0:12}-r$i
  U=$(g3run g3-diag-w04-${SHA:0:12}-r$i $TREE scripts/electron-migration/record/g3-batch.mjs $RECEIPT --mode a-store --sides A,A2 \
    --workers-a 1 --workers-a2 1 --out $DIAG --file $SUITE --scenario memory.batch_move.basic --shard-timeout-min 15 --kill-grace-s 30)
  g3wait $U
done
```

`--scenario` 只录这一个场景（分片键 `…/only-<hash>-000`，与全量分片分开）；场景 id 写错会在写任何文件之前报 `--scenario not found as a valid scenario`。

判定与取证：

```bash
OUTD=$REPORTS/g3-diag-w04-${SHA:0:12}; sudo -u dsdev mkdir -p $OUTD
for t in $(find $OPS/g3-diag-w04-${SHA:0:12}-r* -name 'trace.json*' | sort); do
  take=$(echo $t | sed "s#$OPS/g3-diag-w04-${SHA:0:12}-##; s#/#_#g; s#_trace.json.*##")
  sudo -u dsdev $NODE -e '
const fs = require("fs"), zlib = require("zlib"); const f = process.argv[1];
const t = JSON.parse((f.endsWith(".gz") ? zlib.gunzipSync(fs.readFileSync(f)) : fs.readFileSync(f)).toString());
const c = t.calls[0]; fs.writeFileSync(process.argv[2], JSON.stringify({ trace: f, step0: c }, null, 2));
console.log(process.argv[2], c.outcome.kind, "events", (c.capture?.events ?? []).length, "quiet", JSON.stringify(c.capture?.quiet));' $t $OUTD/$take.step0.json
done
for i in 1 2 3; do D=$OPS/g3-diag-w04-${SHA:0:12}-r$i
  A=$(find $D/A -name 'trace.json*' | head -1); A2=$(find $D/A2 -name 'trace.json*' | head -1)
  (cd $TREE && sudo -u dsdev $DSENV $NODE scripts/electron-migration/record/g3-compare.mjs $SUITE memory.batch_move.basic $A $A2 $OUTD/r$i.A-vs-A2.compare.json); echo "r$i A vs A2 exit=$?"
done
ls -la $OUTD
```

- 成功：3 轮每轮都有 `A`、`A2` 两个 `trace.json*`，每个 `step0.json` 的 `outcome` 为 `result`。
- 读结果：`step0.capture.databases` 是第 0 步后静默时的全部数据库快照，`capture.events` 是事件，`capture.quiet` 记录静默等待（等了多久、是否超时）。`r<i>.A-vs-A2.compare.json`（此时 compare 退出码 1 是正常的）`equal: false` 且 `differences` 里有 `step: 0` 的条目 → 两个 Rust take 自己不一致，即 Rust 侧的非确定性（支持竞态假设）；6 个 take 第 0 步都一致 → 竞态不在第 0 步，差异来自 B。
- 交付给 W04：整个 `$OUTD` 目录（只有 JSON，几 MB）。诊断的 trace 目录用完可删（`rm -rf $OPS/g3-diag-w04-*`）。
- 失败：`trace.json*` 缺失 → 看 `$OPS/g3-diag-w04-*-r<i>/A/**/summary.json` 的 `reason` 和 `app.stderr.log`。

## 资源与时间汇总

| 步骤 | 频率 | 墙钟 | worker | 内存（预估） | 磁盘（`$OPS`） |
|---|---|---|---|---|---|
| S1 冻结树 | 每个提交 | 1 分钟 | — | — | 0.3GB |
| S2 前置检查 | 每个提交 | 3 分钟 | — | < 1GB | — |
| S2b A 失效预查 | 每个提交 | 约 1 分钟（每个预录目录约 30 秒） | — | < 1GB | —（`/tmp` 临时） |
| S3 A/A2 smoke | 一次 | 10–20 分钟 | A1 + A2 1 | 2–4GB | < 1GB |
| S4 B smoke | 每个提交 | 5–15 分钟 | B 1 | < 2GB | < 1GB |
| S5 A/A2 全量 | 每个录制器版本一次（第七轮合入后重录） | 10–11 小时（3 批） | A 3 + A2 3 | ≤ 12G（上限），线程 ≤ 4000 | 约 30GB，预留 40GB |
| S5b 重试 | 按需 | 按含错分片数，约 4.3 分钟/分片 ÷ 3 | A 3 + A2 3 | 同 S5 | 旧分片目录改名保留 |
| S6 B 全量 | 每个提交 | 约 5 小时（3 批） | B 6 + compare 2 | 未实测，≤ 12G | 约 15GB，预留 20GB |
| S7 W04 诊断 | 按需 | 每轮 2–5 分钟 | A 1 + A2 1 | 2–4GB | 约 50MB/轮 |
| S8 A 增补 | 按需 | 约 25 分钟/50 场景 | A 3 + A2 3 | ≤ 12G（上限） | 约 8MB/场景 |

估算依据：旧数据 A 分片中位 4.3 分钟/10 场景；B 无实测中位，保守按同值（手册 §10.6）。“未实测”的项以第一次运行 `g3peak` 的数值为准，请写进对应报告目录。

## 时钟与随机数

两侧都**没有**冻结系统时钟和随机数（A 是真实 Tauri 进程，B 是真实 Host 进程，只固定了 `TZ`/`LANG`/`LC_ALL`）。语料里有 527 个步骤带日期字面量。因此：A/A2 预录和之后的 B 录制不在同一天时，依赖“今天”的场景（到期、统计窗口、按日期过滤）可能出现 A 与 B 的差异，A/A2 之间也可能有时间戳差异（这些由已批准的归一化处理）。看到只在日期相关字段上的差异，先对比 `A-STORE.json` 的录制时间与 B 目录的录制时间，再判断是否回归。
