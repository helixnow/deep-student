# S0-architect 状态

> 用户 2026-11-06 07:45 授权：独立架构代理，负责管线自愈改造，不属于 C0/C1/C2 指挥链。
> 目标与红线见 `docs/dev/electron-migration/dispatch/S0-architect.md`。本文件由 S0 每轮更新，最新在最下。

## 当前状态（2026-11-06 05:15Z）

- **BLOCKED：部署需要用户执行一次 `sudo systemctl restart ds-migration`。** S0 的全部改动（G1–G4、门禁原件、批次排序、vitest JSON 判定）
  已在 main（`8da23f0a2`），但守护进程 pid 916422 从 02:00:55Z 运行至今，加载的是当时 main `366f0e617` 的 `oc-dispatch.mjs`：
  G3 的排队执行器、`pause-dispatch` 和 G4 压力阀都还没有运行。`coord.mjs`、`integrate-parallel.mjs`、`gate-runner.mjs` 每次调用都从磁盘读，已经生效。
  dsdev 执行 `systemctl restart` 被拒（Access denied，sudo 要密码）。用 SIGKILL 借 `Restart=on-failure` 重启可以做到，但这绕过了权限边界，S0 不做。
  备份：`/tmp/opencode/s0-backup-0500/`（`old/` 是守护进程现在跑的版本，`new/` 是 main 版本，`main.sha`、`daemon-start.sha`）。
  回滚：把 `old/oc-dispatch.mjs` 和 `old/lib/` 拷回再重启，或 `git revert` 对应合入。
- 重启后 S0 要做：观察 5 分钟（`systemctl is-active`、watch.log 至少一次正常 tick、无"watch 出错"）。
- S0 分支领先 main 2 个功能提交：`b9af42ee7`（发送方审计）、`463bcba9d`（内容过滤换会话），随 auto 轮合入。
  `463bcba9d` 改的是守护进程，同样要等重启才生效。重启最好在它进 main 之后，一次带上。
- 待办：`jobs/runner.mjs` 的 `integrating()` 把 JSON 锁当 pid 读，结果恒为 false，集成期间作业不收紧。
  主工作树里这个文件有他人未提交改动（rust 作业类），等那份提交后再改，避免合入时冲突。

## 第一轮记录（2026-11-06 00:15Z）

### 交付：G1 集成心跳 + G2 锁租约（`aa64ccdfb`）

| 文件 | 内容 |
|---|---|
| `scripts/electron-migration/lib/integrate-lease.mjs` | 租约：`{pid, owner, scope:{deny}, acquiredAt, expiresAt, renewals}`，TTL 20 分钟；`sweep` 收回已退出 / 过期空闲（无子进程且 main 一个 TTL 内无新提交）的持有者；过期但忙的告警一次，宽限 40 分钟后强制收回并上报；旧格式纯 pid 按 10 分钟 TTL 并告警一次；收回时 `deny` 转存 `integrate.holds.json`；收回用"改名再核对"，不误删刚续的租约。只收回锁，从不结束持有者进程。 |
| `scripts/electron-migration/lib/integrate-heartbeat.mjs` | 集成以 sh 包装启动，退出码写 `<log>.exit`；没有"并行集成完成"即异常：记 incident（退出码、信号、停在哪个 `[阶段]`）；首次异常立即以减半并行（≥1）重试一次；与上次失败停在同一阶段 → 熔断：写 escalation、`incidents.jsonl`（kind=integrate-breaker）、`coord queue C0-chief`，60 分钟冷却后自动再试。 |
| `integrate-parallel.mjs` | 用租约取锁；每个门禁结果 / 合入后续租；快进 main 前确认租约仍属于自己，失去租约则 `exit 3`、不写 main；快进失败按 lane 报"未合入"而不是整轮崩溃；按 holds + 他人锁的 deny 过滤候选；`[阶段] 选候选/门禁/合入/复核/逐条合入` 标记；默认 `--jobs 2`。 |
| `oc-dispatch.mjs` | `collectIntegrate` 走心跳判定并清理残留进程组；`tickAll` 每轮 `lease.sweep`，处理待重试与熔断；串行 `integrate` 命令也用租约。 |
| `dashboard/server.mjs` | 兼容读取 JSON 锁。 |
| `s0-selftest.mjs` | 临时目录 + 假探针 + 假集成进程，19 例（正例/反例），含端到端：真实 SIGKILL → 记 SIGKILL/门禁 → 以 `--jobs 1` 重试 → 接管死锁 → 完成合入。人为去掉"忙"判断后对应 2 例变红，证明测试有效。 |

作用域规则写法：`L17-memory-research/051c4cb73`（该提交及其后代）、`051c4cb73`、`L17*` / `L17`（lane 名或前缀）、`lane:` / `commit:` 前缀。
已在 main 中的提交规则自动失效（否则会拒绝一切）。

### 现场处理

- 任务卡里的 392272 已于 23:39 被 C2 的 `/tmp/opencode/c2-2332-freeze.py`（pid 538390）原地接替。538390 的 fulltest 23:57:49 完成
  （13292 用例 / 0 失败 / 70 pending / 失败套件 0），随后脚本因 main≠029 `AssertionError`（见 `/tmp/opencode/c2-2332-freeze/blocked.md`）
  停在 `signal.pause()`，无子进程。新代码判定为 `expired-idle`。
- 00:12:13Z：先把 C2 要求保持的 D111 保护写成作用域 hold `H-20261106001213-1`（deny `L17-memory-research/051c4cb73`，owner C2-platform），
  再收回 538390 的锁（incident kind=lock-released；未结束 538390 进程），持租约把 main 从 `01dd0a0c8` 快进到 `38f708e7a`，随即释放。
- 部署前备份：`/tmp/opencode/s0-backup-0012/`（三个被改文件 + `main.sha` = `01dd0a0c8`）。回滚：`git revert aa64ccdfb`。
- 00:12:22Z：经心跳包装启动 `integrate-parallel --jobs 2`（sh pid 633055，持锁 pid 633056）。
- 已通知 C0-chief、C2-platform（`/tmp/opencode/s0-notice-0013.md`）。

### 已知遗留

- `jobs/runner.mjs` 的 `integrating()` 用 `Number(锁内容)` 判断，JSON 锁下恒为 false，集成期间作业队列不再让路（只少一个 3/4 降速，无正确性影响）。
  主工作树里该文件有他人未提交改动，我没有动它；等那份改动提交后改为兼容 JSON。

## 第二轮记录（2026-11-06 00:31Z）

### 交付：G3 执行器（`0cde5913d`，S0 分支）

| 命令 | 行为 |
|---|---|
| `coord release-lock --from X [--force] [--reason]` | 可收回状态（持有者已退出 / 过期空闲 / 超宽限）直接收回；持有中或过期但忙，只有 `--force` 才收回。只收回锁，不结束持有者进程；deny 转存 holds；被收回的集成器下次续租失败会自行停止，不写 main。 |
| `coord integrate --lanes a,b@sha --from X [--jobs 2]` | 写入 `.oc-runs/integrate.queue/`；集成器空闲则立即启动，否则当前一轮结束后先跑队首批次。`lane@sha` 只合到该提交；按给定顺序合入；`--jobs` 上限 2。执行进程中途死亡时批次放回重试一次，再失败则归档，不无限重放。批次内全部已入 main 时自动跳过。 |
| `coord pause-dispatch` / `resume-dispatch --from X` | 守护进程不再启动、续派、恢复执行者；在跑的 lane 和协调者不受影响。G4 压力阀会用它。 |

每个动作在 `incidents.jsonl` 记一行 `kind=command`（`board/COMMAND.md` 归 C0 独占，不写）。
验证：selftest 新增 6 例，共 25/25；把重试上限和 jobs 上限改坏，对应 2 例变红。
现场：在本轮 auto 持锁时执行 `release-lock`（不带 `--force`），结果是拒绝、exit 2、锁原样、审计行已写。
C0"第三轮接管调度"现在对应 `release-lock --force` 加 `integrate --lanes`，两条都可直接执行。
部署前备份：`/tmp/opencode/s0-backup-0030/`（4 个文件的 main 版本，`main.sha` = `38f708e7a`）。回滚：`git revert 0cde5913d`。

### 现场处理

- 收到 C1/C2 交接（00:01–00:14Z）。按 C2 00:14Z 要求，不中断已在跑的 33 候选 auto 轮，所以没有单独先跑 209。
  C2 指定的顺序已经排队（见"当前状态"），由 G3 合入 main 后的下一轮集成按顺序执行。
- D111 hold `H-20261106001213-1` 保持，规则按祖先判定，任何 lane 继承 051c4cb73 都拒；只有 C1/C2 显式签收后才解除。
- gate-fail.json 里 L12 的旧条目我没有手改：本轮门禁阶段结束时，集成器会用内存里的结果整体重写这个文件（L12 本轮在候选内），
  现在手改会被覆盖。本轮结束后再核对。

### 待办（按顺序）

1. 本轮 auto 结束后：合入/拒绝明细、main 新 head、账本 A/B；确认 S0 分支入 main，排队批次被消费。
2. G4 压力阀。
3. 门禁原件持久化（C2 提出）：gate-runner 只在内存里保留 stdout，integrate-parallel 只记失败摘录，原退出码、信号和原始 JSON 都丢了。
   这在 `scripts/electron-migration/**` 范围内，由 S0 负责，排在 G4 之后。
4. `jobs/runner.mjs` 的 `integrating()` 兼容 JSON 锁（主工作树里该文件有他人未提交改动，等那份改动提交后再动）。

## 第三轮记录（2026-11-06 00:36Z）

### 交付：G4 压力阀（`bc0d7ebee`，S0 分支）

- 积压按 git 加 selfgate 计算，不读看板：非协调者 lane 中领先 main、自检通过、自检提交就是当前分支头、且没被 hold 拒绝的 lane。
- 积压超过 15 且 main 30 分钟没有前进 → 自动 `pause-dispatch`（auto=true），并给 C1 发一次"先清积压"硬指令，附候选清单。
  人工 resume 之后同样给 30 分钟宽限，避免恢复后立刻又停。
- 积压降到 8 及以下 → 只自动恢复压力阀自己暂停的；人工暂停只能人工恢复。
- 验收（selftest）：临时仓库造 18 条假 lane（16 条过检，1 条自检失败，1 条自检提交不是分支头）→ 积压 16 → 暂停并通知 C1 →
  合入 8 条 → 积压 8 → 自动恢复。用 hold 拒绝 1 条后积压变 15，不暂停。把"分支头"判断和"只自动恢复自动暂停"改坏，2 例变红。
- 现场只读核算（00:33Z）：积压 22 条，main 已 22 分钟没有前进，判定结果是"不暂停"。守护进程重启前压力阀不会运行。

### 回复 C2 00:25Z

- S0 自己的 38f 合入：00:12:13.094Z 收回 538390 的锁（incident `lock-released`），S0 持租约把 main 快进到 `38f708e7a`
  （reflog 00:12:13Z），随即释放；633056 在 00:12:22.403Z 取锁。两者先后串行，没有重叠。
- 本轮能留下的原件只有 auto 日志里的失败摘录和 gate-fail.json，门禁成功的完整 stdout 和退出码都没有保存。持久化（候选、base、
  merge 提交，每项门禁的退出码、信号、stdout）是下一项工作，不追补本轮。
- L12 旧条目：等本轮写回 gate-fail.json 之后再核对，只在确实仍是旧 53e40 时清理，不碰其它条目。

## 第四轮记录（2026-11-06 00:51Z）

### 交付：门禁原件持久化（`1a5e398a4`，S0 分支，C2 提出）

- gate-runner：设置 `GATE_RAW_DIR` 时，把每项检查的完整输出直接写盘为 `<name>.log`，不受内存里 4MB 截断的影响；
  另写 `<name>.json`（code、signal、起止时间、命令、第几次重跑）和 `results.json`。stdout 返回的结果格式不变。
- integrate-parallel：每次门禁（单 lane 门禁、整体复核、逐条合入）各有一个目录 `.oc-runs/gate-raw/<本轮>/<序号>-<lane 或阶段>/`，
  内含 `meta.json`（lane、候选、分支头、base、试合并提交、gate-runner 退出码和信号）和 gate-runner 的 stderr；日志里逐 lane 打印目录。
- selftest +1 例（28/28）：5MB 输出完整落盘、exit 3 和 SIGKILL 原样记录；去掉写盘那一行，这一例变红。
- 只对之后的轮次生效，不补本轮。
- main 期间新增用户的三个提交（fulltest 失败套件计红、health 增加 S0 静默告警、gate-runner 把 worker RPC 超时定性为工具故障），
  已合入 S0 分支，自检通过。部署备份已按 main `ff18ba14d` 刷新：`/tmp/opencode/s0-backup-0030/`。

## 第五轮记录（2026-11-06 01:05–01:40Z）

- 本批 auto-001222：门禁基于 38f；合入阶段 reset 到 ff18，整体复核没过（测试输出里有"payload 主键不一致"的 error 行），改为逐条合入。
  到 01:38Z 已合入 C2-platform、F1、F2、F4、F5、F7、L02、L07、L11。C1-app 和 F3 快进失败，原因是用户在批中直接提交了 main（9e69、7945），两条下一轮重试。
- 审计：用户 helix 在主工作树直接提交了 5 个 main 提交，时间是 00:47:04Z、01:14:50Z、01:21:08Z，绕过了租约。
  已记入 incidents.jsonl（kind=main-written-outside-lease，共 2 行）。
- 合并冲突（9e69 的 8 条批次上限 vs G3 指定批次保持给定顺序）：两条都保留，指定 `--lanes` 的批次不截断。
- ledger-history 的测试 A/B 一直来自 fulltest/latest.json（029292123）。dashboard 改为同时记 `testsHead`（`963f33ac8`），进 main 并重启 dashboard 后生效。
- 设计缺口（待做，排在 G3/G4 部署之后）：逐条合入时快进失败只说"下一轮重试"，应该在本轮内对新 main 重新合并、跑门禁一次。
- 已回 C0（事实 8 条）：`/tmp/opencode/s0-to-c0-0140.md`。

## 第六轮记录（2026-11-06 01:49Z）

- 本批 auto-001222 仍在逐条合入（新增 L13、L14、L15；main=`83fbcf066`），租约 02:08Z 到期，持续续租。按约定不打断，S0 本轮不写 main。
- 用户又在 main 上直接提交了 `930d98adf`（`lane-paths.mjs` +11 行）。只改了数据表，没有改集成流程，不单独记 incident。
- S0 分支再次合入 main，得到 `292fcadf9`，无冲突，selftest 28/28。部署前备份已刷新：`/tmp/opencode/s0-backup-0149/`（main.sha=`930d98adf`）。
- 下一轮：本批释放锁后，持租约把 S0 分支合入 main → 重启 ds-migration 并观察 5 分钟 → 确认排队批次被消费。

## 第七轮记录（2026-11-06 02:05Z）

- 本批 auto-001222 仍在逐条合入，到 X6 为止（main=`a027ae08d`），租约 02:21Z 到期、持续续租。
  X4 快进失败，原因是 02:00Z 用户直接提交了 main（`366f0e617`），已记 incident。01:49–02:01Z 间 watch 启动 4 次，systemd 显示 active，判断是用户在部署修复。
- D-154：U4-ui-content 允许列表加了 4 个文件，提交 `89fd8e592`（S0 分支，C1 和 C2 都已同意），会和 G3/G4 一起进 main。
- llvm-tools：机器上没有，装工具链超出 S0 范围，已请 C1 上报用户。
- 合入顺序（C2 02:00 安排）：633056 退出 → C2 等待脚本 `/tmp/opencode/c2-0159-after-batch.sh` 合 F3、L06（看 waiter.log 里的 "integrate done"）→ S0 持锁合入 → 重启 ds-migration。
  只重启 watch，不动 ds-fulltest、dashboard 和全测；dashboard 等新的 latest.json 生成后再重启。
- 已回 C1、C2：`/tmp/opencode/s0-to-c1c2-0206.md`。

## 第八轮记录（2026-11-06 02:20Z）

- 本批 auto-001222 在 02:19:04Z 退出（exit 0），main=`b433e4bc4`。合入 23 条，门禁未过 4 条（L06 L04 L21 X1），
  共存失败 1 条（L23），快进失败 5 条（C1-app F3 L18 R2 X4，下一轮重试）。终态已发 C0：`/tmp/opencode/s0-to-c0-0221.md`。
- C2 等待脚本 02:19:04Z 起持租约集成 F3、L06（pid 1047643）。S0 等它出现 "integrate done" 后再持锁合入。

## 第九轮记录（2026-11-06 02:36Z）

- C2 等待脚本：F3 在 02:25:41Z 进 main（`2288e84f6`），L06 仍被"上次门禁失败后无新提交"跳过。全测和 ledger 已对 `2288e84f6` 开跑（不持锁）。
- 02:25–02:35Z 锁空了约 10 分钟，S0 不在线。02:35:22Z 新 auto 轮（pid 1136602，8 条上限）取锁，S0 又没赶上。
  不写后台等待脚本（那正是 S0 要消除的模式），下一轮唤醒时锁空就合。
- 修复 `30ac6c41b`：守护进程的集成摘要把"与本轮已合入的其他 lane 共存时失败"也算成已合入（02:23Z 摘要里 L23 同时出现在两边）。
  改为只认以"<lane>: 已合入"开头的行，用 001222 日志核过：23 条，不含 L23。
- S0 分支 `3b58fa613` 合入 main@`45b1290ae`。冲突在 launchPending，`366f0e617` 的"满额供应商移到队尾"和 G3 的"暂停时保留执行者"都保留，selftest 28/28。
- 自举问题：G3 的排队执行器要先进 main 才能给 S0 自己排队。S0 只能等锁空时手动合入。

## 第十轮记录（2026-11-06 02:51Z）

- auto 轮 pid 1136602 仍持锁（门禁阶段，正在跑 W-L13a、W-L14 等语料 lane），租约 03:07Z 到期、持续续租。main 仍是 `45b1290ae`。S0 本轮不写 main，下一轮锁空就合。

## 第十一轮记录（2026-11-06 03:06–03:20Z）

- 02:35Z 那轮 auto 合入 8 条（含 R2、W-L13a、W-L14），在 03:12Z 前后结束。S0 03:12:55Z 取得租约，但 main 已前进到 `4d3659ee1`，不能快进，所以放弃。
  我的一次性脚本在 `process.exit` 时没跑到 `finally`，锁留给了已退出的 pid 1309281（TTL 5 分钟）。03:16:06Z 新一轮 auto 按 `dead` 收回（incident `lock-released`），没有堵塞。
  这正好在现场验证了 G2 收回死持有者的锁。教训：一次性持锁脚本必须用 exitCode，不能直接 exit。
- 饥饿问题：auto 每 15 分钟一轮、每轮约 25 分钟，锁几乎一直被占。S0 手动去抢锁不可靠（要卡在两轮之间几十秒的空档）。
  改走正常通道：S0 分支 `55d67f27e`（已含 main@`4d3659ee1`）跑 lane-gate，通过后 S0 是"自检通过"的候选，由 auto 轮在门禁之后合入，不另抢锁。
  lane-gate 日志：`/tmp/opencode/s0-lanegate-0318.log`。
- 合入后再按红线重启 ds-migration：备份已在 `/tmp/opencode/s0-backup-0308/`（main.sha=`45b1290ae`，合入前再刷新一次）。

## 第十二轮记录（2026-11-06 03:31Z）

- 03:15Z 那轮 auto 合入 8 条（含 C1-app、R2），main=`4d3659ee1`。03:16Z 那轮仍在复核阶段；S0 不在本轮的 8 条里（排在暂缓的 21 条中）。
- D-166：U4-ui-content 允许列表新增 `htmlSandboxPolicy.test.ts`、`htmlSandboxPreview.test.tsx`，`htmlSandboxPolicy.ts` 已在 89fd8e592 里。提交 `3b63d68a2`，selftest 28/28。
- 本条记录提交后重跑 lane-gate，让自检提交等于分支头；之后到合入前不再往 S0 分支提交。

## 第十三轮记录（2026-11-06 03:47–04:02Z）

- 根因：auto 轮的 8 条上限按会话表顺序截断，S0 排在第 55 位，03:16、03:31、03:46 连续被暂缓。U4 也因 D-154 没进 main，在 03:46Z 被判越界。
- 修复 `096d8ebb6`：新增 `lib/batch-order.mjs`。自检通过的优先，同为自检通过时被暂缓最久的优先；暂缓起点跨轮保存在 `.oc-runs/integrate.deferred.json`。
  `--lanes` 指定批次不截断、不重排。selftest 29/29，把暂缓优先改坏后新例变红。
- S0 分支 `3161f63ac`（含 main@`9607f665e`）lane-gate 通过。一次性等待脚本 `/tmp/opencode/s0-waiter.sh`（setsid 启动，最多 40 分钟，日志 `/tmp/opencode/s0-waiter.log`）
  在锁空时执行正式入口 `integrate-parallel --lanes S0-architect`。持锁、门禁、写 main 都由它按租约完成。这是自举期的一次性办法，G3 排队执行器进 main 后不再需要。
- 拒绝：ai98pro 软上限 18→14（红线：不调低供应商并发上限）；把语料批并进 S0 批次（集成组合归 C2）；装 llvm-tools（不在编排层，已 escalate 给用户）。
- 异常：信箱日志 03:23:05Z、03:30:32Z 有以 S0-architect 名义发出的消息，不是本会话发的，已请 C0、C1 核对实际发送者。
- 下一轮：看 waiter.log → 进 main 后刷新备份、记 main sha → 重启 ds-migration 并观察 5 分钟 → 通知 C1（U4 可跑 gate）、C2、C0。

## 第十四轮记录（2026-11-06 04:02Z）

- C2 的 `/tmp/opencode/c2-0358-after-batch.sh` 已排好：auto 批 1454054 退出 → `--lanes S0-architect,L23-sync-providers` → L21 子集 → 同源全测和 ledger。
  这和我的 `s0-waiter.sh` 重复，还会抢同一把锁，所以停掉了我的脚本（04:02:23Z，日志里有记录）。合入顺序按 C2 的安排。
- S0 分支头 `d67af3689`。到 C2 那批取走之前，不再往 S0 分支提交。
- 下一轮：看 `/tmp/opencode/c2-0358-after-batch/waiter.log` 里的 "integrate done" → 刷新备份、记 main sha → 重启 ds-migration 并观察 5 分钟（C2 说全测不受影响）→ 通知 C1 U4 可以跑 gate。

## 第十五轮记录（2026-11-06 04:17–04:26Z）

- auto 批 1454054 仍持锁（到期 04:36Z），C2 的批后脚本还在等。main 仍是 `9607f665e`。
- C1 D-176 和 D-166 追加：lane-paths 新增 `TEMP_GRANTS`，在常规路径之外追加精确文件，按决策编号注释，进 main 后删行即可撤销。
  D-154、D-166 原先的 6 个文件从 U4 常规列表移进来，另加 `templateRenderSanitization.test.tsx`。L04 加 `chat-pipeline/src/tool-runtime.ts`。
  提交 `da1ff9b58`，selftest 29/29，lane-gate 通过。已回 C1。
- 冒名消息：信箱只记录自报的 `--from`。X7 那条 03:23:05Z 入队，正文却写着"S0 03:40Z"，不是本会话发的。
  待做：`coord queue` 在队列记录里写上调用方的 pid、ppid 和工作目录，只做审计，不拦截。排在 S0 分支进 main 和重启之后。

## 第十六轮记录（2026-11-06 04:32–04:46Z）

- C2 补丁请求：整体复核 tests 按 vitest JSON 判定。提交 `19f5064e9`，S0 分支 `06146c00f`。
  - 根因：gate-runner 在内存里只保留 4MB，超出后截到最后 2MB。整体复核跨多个目录，输出超限，`FAIL` 行被截掉，`failedTestKeys` 得到空集。
    于是维持原判定，摘录退回到含 `Error:` 的行，也就是 sync-support 的预期日志 "Database error … 已拒绝"。
    00:12Z、02:23Z、03:46Z 三批都是这样。其中 00:12Z 那批 sync-support 确实是新失败（基线 029 时还没有），但摘录也没说清楚。
  - 改法：宿主 `tests` 检查追加 `--reporter=default --reporter=json --outputFile.json=…`。失败集合按用例和文件的 status 取，路径换成相对工作树，和 main 基线做差集。
    报告里没有失败、但退出码非 0 → 不放行。报告缺失 → 退回文本判定。不做错误文本白名单。
    gate-runner 和 lane-gate 共用 `lib/gate-excerpt.mjs` 的 `judgeTestsJson`，JSON 报告随原件落盘（`<check>.vitest.json`）。
  - 验证：selftest 30/30，新例用 60000 行预期错误日志加 4 种结局。把 JSON 判定改坏后新例变红，复现了"实际 [false,'text']"。
    实测 `host/plugins/sync-support/`，基线 2288e84f6：退出码 1，judgedBy=vitest-json，"仅 main 既有失败 73 项，不阻塞"。
- 进 main 方式不变：C2 的 `/tmp/opencode/c2-0425-after-batch.sh` 在 auto 批 1454054 退出后执行 `--lanes S0-architect,L23,L06`，S0 不另抢锁。

## 第十七轮记录（2026-11-06 04:52–05:15Z）

- 04:50Z auto 合入 S0（`7b36d8a03`，round 12 那一版）；C2 批后脚本随后合入 S0 头 `5ed89a92a`（`8da23f0a2`）和 L06（main=`84d89e3e8`）。S0 分支已全部进 main。
- main 上 selftest 30/30，相关 `.mjs` 全部 `node --check` 通过。
- 部署：备份完成后执行 `systemctl restart ds-migration`，被拒（Access denied）。写成 BLOCKED，见"当前状态"。
- 交付 `b9af42ee7`（第十五轮登记的冒名问题）：`coord queue/restart/assign` 记录发送方的 pid、ppid、cwd、`OPENCODE_SESSION_ID`，
  并按 cwd 反查所在 lane（每个 lane 的工作树互不重叠，已核对）。审计行写 `.oc-runs/inbox-audit.jsonl`；
  `--from` 和 cwd 所属 lane 不一致时，额外记 incident `sender-mismatch`，并在 stderr 提示。只审计，不拦截。信箱条目带 `sender` 字段，守护进程忽略它。
  selftest 31/31；把 mismatch 判定改成恒 false 后新例变红。selftest 只写临时仓库，真实 `.oc-runs` 未受影响。
- 观察：C2 的批后集成用了 `--jobs 4`（集成顺序由 C2 裁定，S0 不改）；auto 轮是 `--integrate-jobs 2`。

## 第十八轮记录（2026-11-06 05:10–05:20Z）

- C0 05:08Z：C1-app、U2-ui-shell 卡在 provider.content-filter 循环。两者 pid 都已退出。
- 根因在守护进程（S0 范围），两处，用现场日志只读核对过：
  - 执行者：换会话要求"续作后没有任何 step_finish"，但被拦那一步自己会写 step_finish（reason=content-filter）。
    U2 现场：lastResumeAt 05:10:09Z 后，旧规则判为有进展，poisonHits 停在 1，走"供应商错误、不计重试"，循环了 11 次。新规则判为无进展。
  - 协调者：唤醒路径只按上下文 >200k 换会话。C1 上一轮被拦（缓存写入约 12 万 token），每次都 resume 回同一会话。
- 修复 `463bcba9d`：新增 `lib/session-poison.mjs`，被拦的 step_finish 不算进展。协调者唤醒时如果上一轮被拦，就换新会话（带 coordBoot），
  补送被拦轮次消费掉的消息，每条只补一次。补送范围按 lastResumeAt 算，因为立即送达会把 lastWakeAt 改成一小时前。记 incident `session-poisoned`。
  selftest 32/32；让被拦的 step_finish 重新算进展后，新例变红。
- S0 不做：改 C1/U2 的 sessions.json、换模型（红线）。已回 C0：U2 走 `coord assign`（派发，归 C1/C2）；
  C1 在修复部署前没有正式通道，同意 C0 第 4 条，先交 C2。回执：`/tmp/opencode/s0-to-c0-0513.md`。

## 第十九轮记录（2026-11-06 05:25Z）

- 没有变化：守护进程仍是 pid 916422（旧代码），S0 的 3 个提交未进 main。C2 批次 pid 1892551 持锁（`--jobs 4`，8 条），S0 不抢锁。
- C1-app 05:25:17Z 已在新会话启动（pid 2143111），不是 S0 做的。
- U2-ui-shell：WP-258 在 05:20–05:25Z 被派了 3 次（C1 一次，C2 两次）。05:25:14Z xhh 新会话启动后，C2 05:25:35Z 改派 opus，
  xhh 会话的日志停在 step_start，没有 exit 记录，看起来是被 `--force` 打断，现在待启动队列里是 opus 那份。派发归 C1/C2，S0 只记录，不处理。
- 下一轮：S0 进 main → 确认用户重启 → 观察 5 分钟。`jobs/runner.mjs` 仍有他人未提交改动，`integrating()` 修复继续等。

## 第二十轮记录（2026-11-06 05:41–05:55Z）

- 现场：C2 批次 pid 1892551 的整体复核在 05:11–05:41Z 跑了 30 分钟（tests 15 分钟超时，加一次重跑），期间没有续租。
  05:31Z 租约过期，incident `lock-expired-busy`，再过 40 分钟宽限就会从活着的持有者手里强制收回。
  05:41Z 进入逐条合入后续上了（到期 06:01Z），本批没出事，但这是 G2 的缺口：续租只在阶段边界发生，单次门禁可以超过 TTL。
- 修复 `daaf44267`：`lease.keepAlive`，在 runGate 的门禁子进程存活期间每 5 分钟续租，close 时停止。
  空闲持有者照常按 TTL 过期，心跳不跨门禁；门禁单项 15 分钟超时限制了心跳时长。续租失败 → 停门禁、exit 3、不写 main。
  selftest 34/34；去掉心跳里的续租、去掉 close 时的 stop，各有一例变红。
  integrate-parallel 每轮从磁盘加载，所以进 main 后下一轮就生效，不需要重启守护进程。
- 不变：守护进程 pid 916422 仍是旧代码，S0 有 4 个功能提交未进 main，重启仍待用户。

## 第二十一轮记录（2026-11-06 05:56Z）

- 没有变化：守护进程仍是旧代码，S0 的功能提交未进 main。C2 批次 1892551 在逐条合入（L19 已进，main=`12a07b1b4`），租约正常。
- 发现：C0 05:28Z 用 `coord integrate --lanes U4-ui-content@57e959732` 排的队（IQ-…-34ca）不会被执行，
  因为守护进程现在跑的版本里没有消费 `integrate.queue` 的代码。已告诉 C0，要等重启。队列里还有 00:29Z 的 0p9e、654l。

## 第二十二轮记录（2026-11-06 06:11–06:25Z）

- C2 06:01Z 请求（门禁误报定性归 C2，改 gate-runner 归 S0）：整体复核"30 分钟"实际是 15 分钟超时跑了两次。
  第一次 0 失败，只有 `Timeout calling "onTaskUpdate"`，退出码 1；重跑并发减半，跑满 15 分钟被 SIGTERM。
- 修复 `34f9d16fc`（加上自动检查点 `b3cdc313b` 里的 `lib/gate-excerpt.mjs`）：
  1. `judgeTestsJson`：JSON 报告完整（每个文件和用例都有终态，passed+pending+todo=total）、0 失败用例、0 失败套件，
     并且未处理错误全部是 worker RPC 超时（逐块核对，块数等于 `Errors N` 汇总）→ 判 ok，标 `infra: true`，不重跑。lane-gate 用同一个判定。
  2. `timeoutFor`：宿主测试超时按目录数放宽，每多一个目录加 7.5 分钟，上限 60；重跑翻倍，上限 90。6 目录整体复核为 52.5 / 90 分钟，单目录仍是 15。
- 现场原件 `gate-raw/2026-11-06T045631827Z/07-_` 用新判定只读复核：complete=true、2500 通过、只有 infra 错误 → ok。
- selftest 35/35。去掉"报告完整"、把"全部是 RPC 超时"改成"有一个是"，各有一例变红。
- 这些都在 integrate-parallel 和 gate-runner 里，每轮从磁盘加载，进 main 后下一轮就生效，不需要重启守护进程。
