# oc-orchestrator 运维文件

opencode 多 lane 并行改造框架在 Linux 服务器上的运维部分（调度代码本身在 `scripts/electron-migration/`，部署步骤见 `docs/dev/electron-migration/server-runbook.md`）。

| 文件 | 安装位置 | 作用 |
|---|---|---|
| `systemd/dsdev.slice` | `/etc/systemd/system/` | 资源组：内存回收线/硬上限、swap 上限；所有 lane 与 opencode 服务都在其中 |
| `systemd/ds-opencode.service` | 同上 | opencode 后台服务（lane 的工具执行都在这里，必须在资源组内）；vitest worker 限流 |
| `systemd/ds-migration.service` | 同上 | 调度守护进程（`oc-dispatch.mjs watch`：5 分钟主循环 + 30 秒事件循环） |
| `systemd/ds-dashboard.service` | 同上 | 监控面板（8787 端口，Basic 认证，密码在 `.oc-runs/dashboard.pass`） |
| `sbin/ds-integrate` | `/usr/local/sbin/` | 在资源组内手动触发一次带门禁的集成（已在跑则跳过） |
| `sbin/ds-import-opencode-key` | 任意（以 dsdev 运行） | 把 OpenCode Go API key 作为 OpenCode Console 账号导入（key 从标准输入读入），之后把标签加进 `.oc-runs/accounts.json` |
| `sbin/ds-launch-coordinators` | 任意（以 dsdev 运行，守护进程停止时） | 启动 C1/C2 协调者并在 sessions.json 标记身份与负责范围 |
| `accounts.example.json` | `.oc-runs/accounts.json` | 额度账号轮换配置（只有标签，没有凭据） |

注意：ExecStart 里的路径、内存上限、并发数（`--max-running`）按机器规格调整；本目录是 64 GB / 32 核机器上的实际配置。

## 管线自愈与协调者能力（W11，2026-11-07；第二、三轮审查后修订）

诊断见 `docs/dev/electron-migration/audits/W11-coordinator-diagnosis.md`，通用方法见 `docs/dev/electron-migration/BLUEPRINT-orchestration.md`。

威胁模型：各 lane 是以 dsdev 运行的 agent，能改 dsdev 可写的一切（`/home/dsdev/**`、`.git`、工作树、`.oc-runs`、`~/oc-jobs-tmp`）。
root 运行的东西不跟随其中的链接、不执行或 import 其中的代码、不在其中跑 git、不把其中内容拷到 dsdev 可读处。由此：

| 组件 | 位置 | 身份 | 作用 |
|---|---|---|---|
| 巡检 v3 | `night/night-guard.py` → `/usr/local/sbin/ds-night-guard.py`；`night/systemd/ds-night-guard.{service,timer}` | dsdev | 没在跑且未 hold 的服务拉起（退避 + 熔断）；心跳停滞只重启在跑的调度器，先存诊断；属主漂移只报告；清理已完成作业的 tmp |
| 巡检特权 | `sudoers/ds-night-guard` → `/etc/sudoers.d/ds-night-guard` | root | 仅 7 条精确命令：`systemctl start\|reset-failed` × ds-migration/ds-jobs/ds-dashboard，`restart ds-migration.service` |
| 意图标记 | `lib/ops-intent.mjs` | — | `~/ops-night/hold/<服务名>`（有意停住一项）、`.oc-runs/maintenance.json` / `~/ops-night/maintenance`（全局维护） |
| 修复动作库 | `lib/repair-actions.mjs`、`repair.mjs`、`coord.mjs repair` | dsdev（root 调用直接报错） | state-json（两次间隔读取都坏才算坏）、sessions-compact（以 scheduler-heartbeat 判定守护进程）、stale-locks、fulltest-resume（hold/维护时不恢复）、git-ownership（只报告） |
| 报告预生成 | `coord-reports.mjs`、`systemd/ds-coord-reports.{service,timer}` | dsdev | 每 5 分钟生成 progress/substance/repair-check/pipeline-check 到 `.oc-runs/reports/`，调度主循环只读 |
| 质量反馈 | `quality-feedback.mjs --spool`、`lib/quality-feedback-spool.mjs`、`systemd/ds-quality-feedback.{service,timer}` | dsdev | main 前进后在主循环外扫描（最长 15 分钟），新问题写入 `.oc-runs/reports/quality-feedback/`；守护进程每个 tick 投递并删除，状态过期或失败时 C0 摘要标注 |
| 第二阶段调度 | `systemd/ds-migration.service.d/z-phase2.conf`、`dispatch/DISPOSITION.json`（`lib/lane-paths.mjs`） | — | 关闭空闲自动续派；lane 处置表生效后退役 / 并入的 lane 不能再派活，路径归接手 lane。安装与生效步骤见 `docs/dev/electron-migration/RESUME-RUNBOOK.md` 第 2、4 步 |
| 卡住动作 | `lib/stall-policy.mjs`、`systemd/ds-stall-watch.service.d/z-w11.conf` | dsdev | 连续卡住 30 分钟在原会话重启一次；维护/hold/调度停着时不发；重启请求 15 分钟过期；工具进程按工作目录、祖先、OLDPWD、命令行归属到 lane，完全无法归属的最多推迟 30 分钟 |
| 备份 | `sbin/ds-backup`、`night/systemd/ds-backup-night.conf` | root（仓库读取全部以 dsdev 执行） | git/sqlite3/tar/zstd 以 dsdev 写 stdout，root 只重定向进 0700 目录、算校验和、轮换；单份输出上限 8GiB（patch 512MiB，`DS_BACKUP_MAX_*_MB`），备份盘剩余不足 20GiB 时跳过 |
| 历史 | `night/deploy-night.mjs` | — | 11-06 一次性部署记录，**已改为直接退出，不得再运行** |

有意停一个服务：先 `sudo -u dsdev sh -c 'echo 原因 > /home/dsdev/ops-night/hold/ds-jobs'`，再 `systemctl stop ds-jobs`；恢复时删 hold 文件。
巡检 v3 的规则是“服务不在运行且没有 hold 文件就拉起”（管理 ds-migration、ds-jobs、ds-dashboard）；ds-fulltest 的 hold 只阻止 fulltest-resume，
要让定时全测也停住还需 `systemctl stop ds-fulltest.timer`；ds-opencode 不在巡检管理范围，写 hold 只作记录。

hold 与维护标记的滥用：任何 dsdev 进程都能创建它们，巡检会一直遵守。存在超过 `DS_HOLD_ALERT_HOURS`（默认 6）小时的标记会进
`night-progress.json` 的 `holdAlerts` 与 C0/C1/C2 唤醒摘要，写明创建时间（mtime）、文件属主、内容里的 `by`/原因。
可选的防护：把 hold 目录放到 dsdev 不可写的位置——`install -d -m 0755 -o root -g root /etc/ds-ops/hold`，并给
`ds-night-guard`、`ds-migration`、`ds-stall-watch`、`ds-coord-reports` 各加 drop-in `Environment=DS_HOLD_DIR=/etc/ds-ops/hold`；
之后 hold 只能由 root 写（`echo 原因 > /etc/ds-ops/hold/ds-jobs`），`~/ops-night/hold/` 里的文件被忽略。只把 `~/ops-night/hold`
改成 root 属主不够：父目录归 dsdev，dsdev 能删掉空的 hold 目录再自建。维护标记（`.oc-runs/maintenance.json`、`~/ops-night/maintenance`）
仍在 dsdev 目录里，靠上面的告警发现滥用。

### 部署（不 SSH 时不执行；由主 agent 在服务器上按序做）

前提：旧巡检已停且 `ds-night-guard.timer` 已 disable（主 agent 已完成）。`REV` 是审查通过的 W11 提交；`SHA256SUMS` 的内容从审查/交付报告里复制，**不从仓库或工作树读取**。
导出与计算校验和都用 `git -c core.useReplaceRefs=false cat-file blob <REV>:<path>`：`refs/replace/*` 可由 dsdev 写入，会让同一个 REV 取出别的内容。
REV 变了要重新计算（在审查方的干净克隆里做，输出格式与第 4 步的文件名一致）：

```bash
REV=<新 REV>
for f in night/night-guard.py night/systemd/ds-night-guard.service night/systemd/ds-night-guard.timer sudoers/ds-night-guard \
         sbin/ds-backup night/systemd/ds-backup-night.conf systemd/ds-stall-watch.service.d/z-w11.conf \
         systemd/ds-coord-reports.service systemd/ds-coord-reports.timer; do
  printf '%s  %s\n' "$(git -c core.useReplaceRefs=false cat-file blob "$REV:ops/oc-orchestrator/$f" | sha256sum | cut -d' ' -f1)" "$(echo $f | tr / _)"
done
```


```bash
REPO=/home/dsdev/dev/deep-student
AS_DSDEV="sudo -u dsdev env HOME=/home/dsdev PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin"
REV=<审查通过的 W11 提交 sha>
# 0. 备份暂停：旧 ds-backup 仍以 root 在仓库里跑 git，部署期间不能触发
systemctl stop ds-backup.timer
while systemctl is-active -q ds-backup.service; do sleep 10; done
# 1. 维护标记（巡检、repair、stall-watch 均不做启动/重启/恢复）
echo "W11 deploy $(date -u +%FT%TZ)" | sudo -u dsdev tee $REPO/.oc-runs/maintenance.json
# 2. 合入：按正常集成路径（dsdev、持租约）把 $REV 合进 main；之后 main 中这些文件应与 $REV 相同
# 3. 自检：全部以 dsdev 在仓库里运行（不以 root 跑仓库代码）
cd $REPO
$AS_DSDEV node --test scripts/electron-migration/{repair,progress,nudge-guard,stall-policy,night-stability,coord-reports}.test.mjs
$AS_DSDEV python3 -m unittest ops/oc-orchestrator/night/test_night_guard.py
# 4. 导出将装进 root 路径的文件：从 $REV 取 blob（不读工作树），在 root 的 0700 目录校验 sha256
install -d -m 0700 /root/w11-stage && cd /root/w11-stage
for f in night/night-guard.py night/systemd/ds-night-guard.service night/systemd/ds-night-guard.timer \
         sudoers/ds-night-guard sbin/ds-backup night/systemd/ds-backup-night.conf \
         systemd/ds-stall-watch.service.d/z-w11.conf systemd/ds-coord-reports.service systemd/ds-coord-reports.timer; do
  sudo -u dsdev git -c core.useReplaceRefs=false -C $REPO cat-file blob "$REV:ops/oc-orchestrator/$f" > "$(echo $f | tr / _)"
done
cat > SHA256SUMS <<'EOF'
<从交付报告复制>
EOF
sha256sum -c SHA256SUMS || { echo "校验失败，停止部署"; exit 1; }
# 5. 先换备份脚本（以后的备份不再以 root 跑仓库程序）
cp -p /usr/local/sbin/ds-backup /usr/local/sbin/ds-backup.bak-w11
install -m 0755 -o root -g root sbin_ds-backup /usr/local/sbin/ds-backup
install -D -m 0644 -o root -g root night_systemd_ds-backup-night.conf /etc/systemd/system/ds-backup.service.d/z-night.conf
# 6. sudoers：先语法检查再装
visudo -cf sudoers_ds-night-guard && install -m 0440 -o root -g root sudoers_ds-night-guard /etc/sudoers.d/ds-night-guard
sudo -l -U dsdev | grep systemctl                               # 只应列出 7 条命令
# 7. 巡检 v3 与单元、报告定时器、卡住动作 drop-in
cp -p /usr/local/sbin/ds-night-guard.py /usr/local/sbin/ds-night-guard.py.bak-w11
cp -p /etc/systemd/system/ds-night-guard.service /etc/systemd/system/ds-night-guard.service.bak-w11
install -m 0755 -o root -g root night_night-guard.py /usr/local/sbin/ds-night-guard.py
install -m 0644 -o root -g root night_systemd_ds-night-guard.service night_systemd_ds-night-guard.timer /etc/systemd/system/
install -m 0644 -o root -g root systemd_ds-coord-reports.service systemd_ds-coord-reports.timer /etc/systemd/system/
install -D -m 0644 -o root -g root systemd_ds-stall-watch.service.d_z-w11.conf /etc/systemd/system/ds-stall-watch.service.d/z-w11.conf
systemctl daemon-reload
# 8. 人工一次性修属主（见下节；要求所有 dsdev 进程都已停），然后确认
find $REPO/.git /home/dsdev/dev/ds-mig -xdev -user root | wc -l      # 0
# 9. 压缩 sessions.json：调度器停止且 scheduler-heartbeat.json 超过 10 分钟未更新后才会执行（否则返回 blocked）；
#    心跳文件读不懂也按“在运行”处理——确认调度器已停后可把它移走再执行
stat -c '%y' $REPO/.oc-runs/scheduler-heartbeat.json; systemctl is-active ds-migration.service   # 应 >10 分钟前、inactive
cd $REPO && $AS_DSDEV node scripts/electron-migration/coord.mjs repair apply sessions-compact --from deploy-w11
#    预生成一次报告、维护标记下试跑巡检（应只有 held，没有 actions）
systemctl start ds-coord-reports.service
systemctl start ds-night-guard.service && $AS_DSDEV python3 -c "import json;d=json.load(open('$REPO/.oc-runs/night-progress.json'));print(d['actions'],d['held'],d['errors'])"
# 10. 解除维护前写 hold：巡检 v3 会拉起“不在运行且没有 hold 文件”的服务，解除维护后 2 分钟内生效
sudo -u dsdev mkdir -p /home/dsdev/ops-night/hold
systemctl show -p Id,ActiveState,Result ds-migration.service ds-opencode.service ds-jobs.service ds-dashboard.service ds-fulltest.service
#     逐一决定 ds-migration、ds-opencode、ds-jobs、ds-dashboard、ds-fulltest 是否保持停止；要停的每个写一个 hold，例如：
#     sudo -u dsdev sh -c 'echo "W11 部署：等用户恢复派发 by 主agent" > /home/dsdev/ops-night/hold/ds-migration'
#     failed 且要保持停止的再 systemctl reset-failed <服务>；ds-fulltest 要停还需 systemctl stop ds-fulltest.timer
ls -l /home/dsdev/ops-night/hold/                                # 核对：每个要保持停止的服务都有文件
$AS_DSDEV node scripts/electron-migration/coord.mjs repair check                      # 应全为“无”（git-ownership 也应为无）
rm $REPO/.oc-runs/maintenance.json
systemctl enable --now ds-night-guard.timer ds-coord-reports.timer ds-backup.timer
systemctl restart ds-stall-watch.service                          # restart 而不是 start：新 drop-in 与新代码才生效
#     若要在恢复派发前保持 stall-watch 停止：先写 hold/ds-stall-watch 并跳过这一步，恢复派发时再 restart
# 11. 观察 15 分钟：night-progress.json 的 actions/held/errors；.oc-runs/reports/* 每 5 分钟更新；
#     下一次 ds-backup 后 find $REPO/.git -user root 仍为 0；watch.log 正常 tick
```

### 增补：质量反馈定时器（第四轮，在上面的部署完成之后做）

上面 9 个文件与 `e43e403` 的校验和不变。这一步多装 2 个单元文件，REV 取包含它们的 W11 提交，校验和同样在审查方干净克隆里算：

```bash
for f in systemd/ds-quality-feedback.service systemd/ds-quality-feedback.timer; do
  printf '%s  %s\n' "$(git -c core.useReplaceRefs=false cat-file blob "$REV:ops/oc-orchestrator/$f" | sha256sum | cut -d' ' -f1)" "$(echo $f | tr / _)"
done
```

```bash
cd $REPO && $AS_DSDEV node --test scripts/electron-migration/quality-feedback-spool.test.mjs
cd /root/w11-stage
for f in systemd/ds-quality-feedback.service systemd/ds-quality-feedback.timer; do
  sudo -u dsdev git -c core.useReplaceRefs=false -C $REPO cat-file blob "$REV:ops/oc-orchestrator/$f" > "$(echo $f | tr / _)"
done
sha256sum -c SHA256SUMS-qf || exit 1
install -m 0644 -o root -g root systemd_ds-quality-feedback.service systemd_ds-quality-feedback.timer /etc/systemd/system/
systemctl daemon-reload
# 已发送记录沿用现有的 .oc-runs/feedback-state.json，发过的不会重发；停机期间 main 上新出现的问题会在第一批里一起入队
systemctl start ds-quality-feedback.service && cat $REPO/.oc-runs/reports/quality-feedback.json
systemctl enable --now ds-quality-feedback.timer
```

调度守护进程必须是同一 REV 的代码（`systemctl restart ds-migration`，或恢复派发时启动），否则旧代码仍在主循环里同步跑扫描。

### 一次性人工操作：属主修复

```bash
pgrep -u dsdev -l                                                       # 必须无输出：没有任何 dsdev 进程能在修复期间替换路径
find /home/dsdev/dev/deep-student/.git /home/dsdev/dev/ds-mig -xdev -user root -print   # 列出清单核对（预期 134 个左右）
chown -R -P --from=root dsdev:dsdev /home/dsdev/dev/deep-student/.git /home/dsdev/dev/ds-mig
find /home/dsdev/dev/deep-student/.git /home/dsdev/dev/ds-mig -xdev -user root | wc -l  # 0
```

单个 chown 进程完成：`-P` 不跟随任何符号链接（链接本身也只改属主），`--from=root` 只改当前属主为 root 的条目。
以后出现属主漂移，`repair check` / pipeline-check / 巡检只告警并给出同一流程。

### 回滚

按序执行：

```bash
systemctl disable --now ds-night-guard.timer && rm /etc/sudoers.d/ds-night-guard      # 1. 巡检先停，再收回特权
systemctl disable --now ds-coord-reports.timer ds-quality-feedback.timer               # 2. 报告与质量反馈预生成
rm /etc/systemd/system/ds-stall-watch.service.d/z-w11.conf && systemctl daemon-reload  # 3. 卡住动作 drop-in
systemctl restart ds-stall-watch                                                       #    （要保持停止则跳过）
```

| 组件 | 说明 |
|---|---|
| 巡检 | 不建议恢复 `.bak-w11`（v1/v2 以 root 运行，存在已知提权路径）；确需恢复：`cp -p` 两个 `.bak-w11` 回原位、`systemctl daemon-reload`，并在审查记录中说明 |
| 报告预生成 | 停用后调度摘要显示“报告暂无/过期”，不影响调度 |
| 质量反馈 | 停用后不再有新反馈入队，C0 摘要标注“质量反馈已 N 分钟未生成”；假脱机里未投递的批次保留，重新启用后照常投递 |
| 备份 | `cp -p /usr/local/sbin/ds-backup.bak-w11 /usr/local/sbin/ds-backup`；`rm /etc/systemd/system/ds-backup.service.d/z-night.conf && systemctl daemon-reload`（旧脚本以 root 跑仓库 git，同样有已知风险） |
| 代码 | 在 main 上 `sudo -u dsdev git revert` W11 的提交（不改写历史），`systemctl restart ds-migration ds-stall-watch` |
| 催办闸 | 单条消息：`--force-repeat --reason "<新事实>"`；整体：revert 该提交 |
| sessions 压缩 | 停守护进程后用 `.oc-runs/repair/quarantine/<时间>/sessions.json.before-compact` 覆盖；历史在 `.oc-runs/archive/sessions-history-*.jsonl` |
| 属主修复 | 不回滚（恢复的是应有状态） |

## 备份与恢复

`sbin/ds-backup` + `systemd/ds-backup.{service,timer}`：每 30 分钟把工作区备份到工作区之外的 `/var/backups/ds-migration/snapshots/<UTC 时间>/`（最近 12 份全留，更早的每天留一份、最多 5 天）。root 运行，但仓库、工作树、`.oc-runs` 与会话库的读取全部以 dsdev 执行（见脚本头注释）。

恢复：
- 仓库：`git clone <快照>/repo.bundle deep-student && cd deep-student && git fetch <快照>/repo.bundle "refs/heads/*:refs/heads/*" --update-head-ok`，再按 runbook 重建工作树。
- 进行中的改动：在对应 lane 工作树 `git apply <快照>/worktrees/<lane>.patch`。
- 调度状态：`tar --zstd -xf <快照>/oc-runs.tar.zst -C <仓库>`（恢复前先停 ds-migration，并清掉 sessions.json 中各 lane 的 pid）。
- opencode 会话库：停 ds-opencode 后 `zstd -d <快照>/opencode.db.zst -o ~dsdev/.local/share/opencode/opencode.db`（删除旧的 -wal/-shm）。
