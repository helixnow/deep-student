# 恢复线上派发操作手册

> 状态：**已裁定**（主 agent 2026-11-07，见下节），在服务器上按序执行。方案与理由见 `RESUME-PLAN.md`。W11 不 SSH、不执行其中任何一步。
> 约定：`REPO=/home/dsdev/dev/deep-student`；`AS_DSDEV="sudo -u dsdev env HOME=/home/dsdev PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin"`；
> 仓库里的命令一律以 dsdev 执行（以 root 跑 git 会制造 root 属主文件，2026-11-07 X7 事故）；`$COORD` 表示 `$AS_DSDEV node $REPO/scripts/electron-migration/coord.mjs`。

## 主 agent 裁定（2026-11-07）

1. **处置表**：采纳 `dispatch/DISPOSITION.proposed.json`（第 4 步改名生效）。恢复前对照最终合入的 main 再复核一次（第 3.2 步）；复核要改的写进 proposed 文件后再改名。
2. **新 lane 的模型**：P3 用 `xhh/gpt-6-astra#high`；P1、P2、P4、P5、P6 用 `ai98pro/claude-opus-5-5#high`。`MODEL_BY_LANE` 由用户维护，本手册在 `launch` 时显式传 `--model`（第 6 步）。
3. **继续的 lane**：先打 `inflight/<lane>-20261107` 标签，再重置到新 main（第 3.4 步）。有未吸收真实修复的 lane（L17、L20、L20b、L21 等），由本机对应工作流先把补丁吸收进集成分支（第 0 步），合入 main 并经第 3.2 步确认后再重置；确认之前这些 lane 停放，不重置、不派活。

判据工具：`scripts/electron-migration/absorb-check.mjs`（只读，在临时索引里逐文件试应用，不动真实索引、工作树和 ref）。
每个文件判为：已吸收（反向能应用）、未吸收（正向能应用）、分叉（都不能，main 另行改过）。未吸收或分叉的非文档文件为 0 时输出 `reset-ok`，否则 `HOLD`。

## 第 0 步（本机，第 1 步之前）：先吸收在途真实修复

`.transfer/inflight/*.patch` 是 01:43 从服务器取的“lane 分支相对 main”的差异。由下表的本机工作流把未吸收的代码改动吸收进各自的集成分支，再随第一阶段合入。
本表是 2026-11-07 03:50 在本机对当时各集成分支核对的结果（已吸收/未吸收/分叉）：

| lane（处置） | 吸收方 | 核对结果 | 未吸收的真实改动 |
|---|---|---|---|
| L17-memory-research（继续） | W03 | 13/1/0，`reset-ok` | 无（剩 1 个文档文件） |
| L20-sync（继续） | W10 | 0/3/0，`HOLD` | 默认学习者档案合并：`sync/src/field-merge.ts`、`repository/apply-record.ts` 与测试（WP2-001） |
| L20b-sync-support（并入 L20） | W08 | 0/5/0，`HOLD` | `sync_state` 延迟打开：`sync-support/index.ts`、`src/state.ts` 与 `state-lazy-open` 测试（WP2-002） |
| L21-backup-governance（继续） | W08 | 0/12/0，`HOLD` | backup 等价语料与 `migration-diagnostic` 测试（WP2-004） |
| L24-chatanki（并入 L16） | W10 | 0/3/0，`HOLD` | chatanki 模板等价数据与真实沙箱测试 |
| F1-kernel（继续） | W01 | 0/4/0，`HOLD` | `host/kernel/serde.ts` 与 `cloud-config-inbound` 测试（WP2-003） |
| L06-agent-orchestration（继续） | W02 | 1/2/0，`HOLD` | g3w 等价场景 1 个 |
| L05-agent-workspace（继续） | W02 | 2/6/0，`HOLD` | 只有 wp276 自检原件（`*.original.json`），可不吸收：由 W02 确认后在第 3.2 步按“证据件”放行 |
| X1-e2e-smoke（继续） | W12 | 14/46/0，`HOLD` | smoke 夹具与测试 46 个文件，由 W12 逐个判断吸收或淘汰 |
| L23-sync-providers（继续） | W08 | 0/1/0，`reset-ok` | 无（只有文档） |
| X7-differential（继续） | W13 | 分叉 | 录制脚本以 W13 版本为准（RESUME-PLAN §1.2），由 W13 确认后放行 |
| L18-media-docs（退役） | W04 | 29/0/1 | `media/index.ts` 分叉，以 W04 版本为准 |
| S0-architect（继续） | W09、W11 | 0/4/1 | `s0-selftest.mjs`、`lib/gate-excerpt.mjs` 由 WP2-067 对账；`jobs/runner.mjs` 以 W09 版本为准 |

本机复核命令（在 `deep-student` 主仓库执行，`<集成分支>` 换成吸收方当前的集成分支）：

```bash
node wt/W11/scripts/electron-migration/absorb-check.mjs --patch --target <集成分支> .transfer/inflight/L20-sync.patch
#   预期 reset-ok；仍为 HOLD 的，补丁未吸收的文件列在行尾
```

吸收方把文件吸收或明确淘汰（淘汰写进该工作流的 PROGRESS，说明原因）之后，这一行才算完成。“分叉”行由吸收方确认以其版本为准即可。

## 第 1 步：合入第一阶段

按 `ASSAULT-PLAN.md` §5：本机集成分支 → 生成补丁 → 服务器从 `ae4efdf9e` 开新分支并应用 → 服务器全量测试 → 合入 main（dsdev、持集成锁）。

```bash
cd $REPO
$AS_DSDEV git log --oneline -1 main                      # 记下合入后的 main sha，后面各步都对照它
$AS_DSDEV node --test scripts/electron-migration/*.test.mjs scripts/electron-migration/lib/*.test.mjs
#   预期：全部通过（W11 本机 2026-11-07：86/86；integrate-fault 的夹具已补）
```

通过条件：服务器全测失败数为 0（Linux 上第一阶段集成基线应为全绿；本机已知的 40 个环境性失败不出现在 Linux）。不通过就停在这一步。

## 第 2 步：部署 W11

按 `ops/oc-orchestrator/README.md`：先“部署”一节（REV `e43e403`，9 个文件，校验和已由主 agent 独立核验），再“增补：质量反馈定时器”一节（2 个单元文件，REV 取第一阶段合入后 main 上的 W11 提交，校验和在审查方干净克隆里重算）。
另加第二阶段的调度 drop-in（关闭空闲自动续派，RESUME-PLAN §3.1），同样从 REV 导出并校验：

```bash
cd /root/w11-stage
sudo -u dsdev git -c core.useReplaceRefs=false -C $REPO cat-file blob "$REV:ops/oc-orchestrator/systemd/ds-migration.service.d/z-phase2.conf" > systemd_ds-migration.service.d_z-phase2.conf
sha256sum systemd_ds-migration.service.d_z-phase2.conf          # 与审查方干净克隆算出的值比对
install -D -m 0644 -o root -g root systemd_ds-migration.service.d_z-phase2.conf /etc/systemd/system/ds-migration.service.d/z-phase2.conf
systemctl daemon-reload
systemctl show -p Environment ds-migration.service              # 含 DS_AUTO_CONTINUE_MAX=0
```

部署完成时：ds-migration、ds-opencode、ds-stall-watch 保持停止，并各有 hold 文件（README 第 10 步）；ds-jobs、ds-dashboard 可以在跑。

## 第 3 步：处置 lane 分支（退役 / 并入的打标签保留，不删除）

调度器必须已停（`systemctl is-active ds-migration` 为 inactive，`scheduler-heartbeat.json` 超过 10 分钟未更新）。

### 3.1 清单

```bash
cd $REPO
$AS_DSDEV git branch --list 'ds-mig/*' --format='%(refname:short)' > /tmp/ds-mig-branches.txt
$AS_DSDEV node -e '
const d = require("./docs/dev/electron-migration/dispatch/DISPOSITION.proposed.json");
const have = require("fs").readFileSync("/tmp/ds-mig-branches.txt", "utf8").split("\n").filter(Boolean).map((b) => b.slice(7));
for (const b of have) { const x = d.lanes[b]; console.log(`${x ? x.action : "UNLISTED"}\t${b}\t${x?.into ?? ""}`); }
for (const l of Object.keys(d.lanes)) if (!have.includes(l)) console.log(`NO-BRANCH\t${l}`);
' | sort > /tmp/ds-mig-disposition.tsv
cat /tmp/ds-mig-disposition.tsv
```

`UNLISTED` 的分支按“退役、接手 P1”处理（先确认它不是本手册之外新开的 lane）。

### 3.2 对照最终合入的 main 复核（裁定第 1、3 条）

```bash
cd $REPO
$AS_DSDEV node scripts/electron-migration/absorb-check.mjs $(awk '$1!="NO-BRANCH"{print "ds-mig/"$2}' /tmp/ds-mig-disposition.tsv) > /tmp/ds-mig-absorb.tsv
awk -F'\t' '$2=="HOLD"' /tmp/ds-mig-absorb.tsv                  # 每行：lane、HOLD、已吸收/未吸收/分叉、未吸收或分叉的非文档文件
```

逐条 `HOLD` 处理：

- **继续的 lane**：不重置（3.4 只处理 `reset-ok`），会话停放。把行尾文件交回第 0 步表里的吸收方；吸收方的修复合入 main 后，重跑本节，转为 `reset-ok` 再做 3.4 并取消停放。
- **退役 / 并入的 lane**：照常打标签、停放（3.3），分支保留。行尾文件或由第 0 步的吸收方吸收，或在 RESUME-PLAN §2 给接手 lane 加一个“从 `retired/<lane>-20261107` 重放”的包；两者都不做的，在处置表该 lane 的 `reason` 里写明放弃的理由。
- **只剩分叉、且吸收方已确认以其版本为准**（第 0 步表的 X7、L18、S0）：视为 `reset-ok`，把该行第 2 列改为 `reset-ok`（`sed -i 's/^X7-differential\tHOLD/X7-differential\treset-ok/' /tmp/ds-mig-absorb.tsv`）。
- 复核中发现处置本身要改（例如某条退役 lane 其实还有大量未吸收的业务代码），先改 `DISPOSITION.proposed.json`，再进行 3.3 和第 4 步。

### 3.3 退役 / 并入：打标签、停放

```bash
DATE=20261107
for lane in $(awk '$1=="retire"||$1=="merge"||$1=="UNLISTED"{print $2}' /tmp/ds-mig-disposition.tsv); do
  wt=/home/dsdev/dev/ds-mig/$lane
  if [ -d "$wt" ] && [ -n "$($AS_DSDEV git -C "$wt" status --porcelain)" ]; then
    $AS_DSDEV sh -c "git -C '$wt' diff HEAD > $REPO/.oc-runs/archive/phase1-uncommitted-$lane.patch"   # 未提交改动留档
    $AS_DSDEV git -C "$wt" stash push -u -m "phase1-end $DATE"
  fi
  $AS_DSDEV git tag -a "retired/$lane-$DATE" "ds-mig/$lane" -m "第二阶段处置：见 docs/dev/electron-migration/RESUME-PLAN.md §1.2"
done
$AS_DSDEV git tag --list 'retired/*' | wc -l                    # 等于上面处理的分支数
# 停放会话（守护进程停着时直接改 sessions.json）
LANES=$(awk '$1=="retire"||$1=="merge"||$1=="UNLISTED"{print $2}' /tmp/ds-mig-disposition.tsv | paste -sd, -)
$AS_DSDEV node scripts/electron-migration/oc-dispatch.mjs park "$LANES" 第二阶段处置：退役或并入，见 RESUME-PLAN §1.2
```

分支与工作树都保留。以后要看某条退役 lane 的工作：`git log base..retired/<lane>-20261107`。

### 3.4 继续的 lane：先打标签，再重置到新 main（裁定第 3 条）

只处理 3.2 判为 `reset-ok` 的继续 lane；`HOLD` 的先停放，吸收完成、重跑 3.2 转为 `reset-ok` 后再对它单独执行下面的循环体。

```bash
MAIN=$($AS_DSDEV git rev-parse main)
HELD=$(awk -F'\t' '$2=="HOLD"{print $1}' /tmp/ds-mig-absorb.tsv)
for lane in $(awk '$1=="continue"{print $2}' /tmp/ds-mig-disposition.tsv); do
  echo "$HELD" | grep -qx "$lane" && { echo "HOLD $lane：先吸收，暂不重置"; continue; }
  ahead=$($AS_DSDEV git rev-list --count "$MAIN..ds-mig/$lane")
  [ "$ahead" = 0 ] && continue
  wt=/home/dsdev/dev/ds-mig/$lane
  if [ -d "$wt" ] && [ -n "$($AS_DSDEV git -C "$wt" status --porcelain)" ]; then
    $AS_DSDEV sh -c "git -C '$wt' diff HEAD > $REPO/.oc-runs/archive/phase1-uncommitted-$lane.patch"
    $AS_DSDEV git -C "$wt" stash push -u -m "phase1-end $DATE"
  fi
  $AS_DSDEV git tag -a "inflight/$lane-$DATE" "ds-mig/$lane" -m "第一阶段结束时的在途提交（$ahead 个），由第二阶段工作包按需重放"
  if [ -d "$wt" ]; then $AS_DSDEV git -C "$wt" reset -q --hard "$MAIN"; else $AS_DSDEV git branch -f "ds-mig/$lane" "$MAIN"; fi
done
$AS_DSDEV git tag --list 'inflight/*'
# HOLD 的继续 lane 停放，吸收完成并重置后再取消停放
HELD_CONT=$(for l in $HELD; do awk -v l="$l" '$1=="continue"&&$2==l{print l}' /tmp/ds-mig-disposition.tsv; done | paste -sd, -)
[ -n "$HELD_CONT" ] && $AS_DSDEV node scripts/electron-migration/oc-dispatch.mjs park "$HELD_CONT" 第二阶段：在途修复待吸收，见 RESUME-RUNBOOK 3.2
```

重放来源：WP2-001/002 用 `inflight/L20-sync-*`、`retired/L20b-sync-support-*`；WP2-003 用 `inflight/F1-kernel-*`；WP2-004 用 `inflight/L21-backup-governance-*`；WP2-067 用 `inflight/S0-architect-*`。

## 第 4 步：采纳处置表，写入第二阶段派发文档

协调者任务卡（C0/C1/C2/S0 的“第二阶段”节）、P1–P6 任务卡、`RESUME-PLAN.md` 已随第一阶段进入 main。这里只做一件事：让处置表生效。

```bash
cd $REPO
# 主 agent 的修改先写进 DISPOSITION.proposed.json，再改名（经正常集成路径提交，dsdev、持锁）
$AS_DSDEV git mv docs/dev/electron-migration/dispatch/DISPOSITION.proposed.json docs/dev/electron-migration/dispatch/DISPOSITION.json
#   lane-paths.test.mjs 优先校验 DISPOSITION.json，不存在时校验 proposed
$AS_DSDEV node --test scripts/electron-migration/lane-paths.test.mjs
$AS_DSDEV git commit -m "[主agent] 第二阶段 lane 处置生效（RESUME-PLAN §1）"
# 生效核对
$AS_DSDEV node -e 'import("./scripts/electron-migration/lib/lane-paths.mjs").then(m => { const l = m.allLanes(); console.log(l.length, l.filter(x => /^P\d/.test(x)).join(","), m.laneStatus("L02-llm-manager")); })'
#   预期：活动 lane 含 P1–P6；L02 为 { active: false, action: 'retire', into: 'P1-plugin-health' }
$COORD assign L02-llm-manager WP-0000 /dev/null --from 主agent; echo "exit $?"   # 预期报错“已退役，路径归 P1-plugin-health”
```

## 第 5 步：解除 hold

按依赖顺序，一次解除一个，每个之后看 2 分钟巡检结果（`night-progress.json` 的 actions/errors）：

```bash
H=/home/dsdev/ops-night/hold                                     # 若用了 DS_HOLD_DIR 则为 /etc/ds-ops/hold
ls -l $H/
rm -f $H/ds-jobs $H/ds-dashboard                                 # 巡检会拉起未在跑的
rm -f $H/ds-fulltest && systemctl start ds-fulltest.timer        # 定时全测
rm -f $H/ds-opencode && systemctl start ds-opencode.service      # 巡检不管 opencode，手动起
rm -f $H/ds-stall-watch && systemctl restart ds-stall-watch.service
rm -f $H/ds-migration && systemctl start ds-migration.service    # 最后起调度器（此时派发仍处于暂停标记下）
sleep 120; $AS_DSDEV python3 -c "import json;d=json.load(open('$REPO/.oc-runs/night-progress.json'));print(d['actions'],d['held'],d['errors'],d.get('holdAlerts'))"
systemctl show -p Environment ds-migration.service | grep -c DS_AUTO_CONTINUE_MAX=0   # 1
```

## 第 6 步：恢复派发

```bash
cd $REPO
$COORD resume-dispatch --from 主agent --reason "第二阶段开始：RESUME-PLAN.md"
# 新 lane 首次启动（只做起点检查后结束，任务卡“首次启动”一节）；模型按裁定第 2 条
for l in P1-plugin-health P2-portability P4-mobile-proto P5-plugin-sdk P6-ui-features; do
  $AS_DSDEV node scripts/electron-migration/oc-dispatch.mjs launch --lanes $l --model ai98pro/claude-opus-5-5#high; done
for l in P3-gates-ledger; do
  $AS_DSDEV node scripts/electron-migration/oc-dispatch.mjs launch --lanes $l --model xhh/gpt-6-astra#high; done
# C1 的第一轮会按 RESUME-PLAN §2.9 派第一批 10 个包；C0、C2 按各自第二阶段节运行
```

## 第 7 步：第一小时观察与回滚条件

每 15 分钟看一次（`coord.mjs status`、`watch.log`、`.oc-runs/reports/`、`night-progress.json`）：

| 时间 | 应看到 |
|---|---|
| 15 分钟 | `scheduler-heartbeat.json` 每分钟更新；C1 已用 `assign` 派出第一批中的 ≥5 个包（brief 含“查重”行）；退役 lane 没有被启动；`.oc-runs/reports/*` 在更新，`quality-feedback.json` 新鲜 |
| 30 分钟 | 无 `空闲…已自动续派` 日志（续派已关闭）；巡检 `actions` 里没有反复拉起同一服务；`repair check` 全为“无” |
| 60 分钟 | 至少一轮自动集成跑完（`integrate-auto-*.log` 有完成标记）；全测已在新 main 上启动或完成；没有 root 属主文件（`find $REPO/.git -user root \| wc -l` 为 0） |

**回滚条件**（任一出现即执行）：

1. main 全测出现新失败且 30 分钟内定位不到引入提交；
2. 出现 root 属主文件，或巡检熔断（`night-progress.json` 的 breaker 打开）；
3. 退役 / 并入 lane 的提交进入 main（处置表没有生效），或有 lane 越界写入被合入；
4. 调度心跳停滞超过 10 分钟且巡检重启两次仍未恢复；
5. 一小时内 C1 派出的包有 ≥3 个被 C2 判为“重做已完成的工作”（查重失效）。

**回滚动作**（只停派发，不回退代码；代码问题按 C2 的 revert 流程单独处理）：

```bash
$COORD pause-dispatch --from 主agent --reason "<回滚条件编号与证据>"
sudo -u dsdev sh -c 'echo "第二阶段回滚：<原因> by 主agent" > /home/dsdev/ops-night/hold/ds-migration'
systemctl stop ds-migration.service                               # 在跑的 lane 会话不受影响，跑完即止
# 处置表有问题：把 DISPOSITION.json 改回 proposed（git mv + 提交）即恢复 v3 的路径归属；退役 lane 的分支与标签都在
# W11 组件问题：按 ops/oc-orchestrator/README.md「回滚」一节
```
