# W11 协调者能力诊断（2026-11-07）

范围：自愈与修复、监控与发现、主动性与推进。数据来自 ser-38 `.oc-runs/`（只读统计，未拉全量）、仓库快照 `ae4efdf9e`、`/Users/heli/der/ops/ser38/`。统计窗口 11-03 10:43Z – 11-06 17:36Z（用户暂停派发）。

## 0. 一句话

管线**检测得到“活着/不活着”，处理得了“lane 进程”层面的故障，处理不了“管线结构”层面的故障；看得见进程，看不见产出；协调者的主要动作是读状态、写看板、发消息，而不是改变系统状态。**

## 1. 自愈与修复（评分 3/10）

| # | 结论 | 证据 |
|---|---|---|
| 1.1 | 已有的自动恢复全部面向 **lane 进程**：供应商错误恢复 1059 次、异常退出恢复 324 次、集成心跳重试/熔断 3 次、租约回收。对**管线/结构**故障没有任何修复动作。 | `watch.log(.prev)` 统计；`oc-dispatch.mjs:1060-1099`；`coord.mjs` 执行器只有 release-lock/integrate/pause/resume（`coord.mjs:15-21`） |
| 1.2 | **X7 权限事故是结构性的且无人能修**：16:48:50Z 一次 root 身份的 git 操作改写了 `.git/packed-refs` 与 113 个工作树的 `logs/HEAD`（另有 18 个 index、`ORIG_HEAD` 16:59:45Z），共 134 个文件归 root；X7 16:55Z 首次提交失败，到 17:31Z 上报 5 次，C1 17:32Z 才看到，17:36Z 暂停时仍未修复，至今仍是 root。协调者都以 dsdev 运行，**没有权限、也没有动作**去 chown。另有 14 个文件早在 11-05 12:00Z 就已归 root，潜伏 30 多小时无人发现。 | `stat` 结果；`find .git/worktrees -user root` = 134；`X7-differential.jsonl` 16:55 起 40 处 `logs/HEAD`；W11 之前的 `ops/oc-orchestrator/night/deploy-night.mjs` 第 12、47-48 行（以 root 跑 `git merge`，带 `safe.directory=*`） |
| 1.2b | 第二个 root 属主来源是 **root 备份定时器**：`ds-backup` 每 30 分钟以 root 在每个工作树跑 `git diff HEAD`；porcelain diff 遇到 stat 变化会写回 index（`GIT_OPTIONAL_LOCKS=0` 也挡不住，已本机验证），index 随之变成 root 属主（18 个）。另外仓库里的 `ds-backup` 已与服务器安装版漂移（安装版有 VACUUM INTO 与 12/5 保留），按仓库重新部署会把修复回退。 | `ops/oc-orchestrator/sbin/ds-backup:35-37`（W11 前）；安装版与仓库版 md5 不同 |
| 1.3 | **夜间巡检是盲重启**：任何 inactive 服务 10 分钟后被拉起（不区分“故障”与“人为停止”）；心跳超 15 分钟就重启调度器——调度器被人停掉时心跳必然陈旧，于是每 30 分钟把它拉起一次。没有诊断、没有熔断。 | 旧 `night-guard.py:43-61` |
| 1.4 | **状态文件损坏会悄悄改变行为而不报错**：`dispatch.paused.json` 坏了 → `dispatchPaused()` 回落 null = 派发被恢复；`integrate.holds.json` 坏了 → deny 保护消失；`sessions.json` 坏了 → 守护进程每轮抛异常、`coord.mjs` 所有子命令崩溃，协调者连检查工具都用不了。 | `lib/orch-control.mjs:131-133`；`oc-dispatch.mjs:124-125`；`coord.mjs:39`（旧） |
| 1.5 | 管线 bug 只能靠人改代码：C1 11-04 12:36–12:48Z 连续 24 次唤醒失败（`spawn E2BIG`，唤醒消息超过单参数上限）；全测控制器在“排队→运行”间隙误判退出（`ae4efdf9e` 才修）；恢复全测的 night-guard 代码只存在于未部署的 `ops/ser38/`。 | `watch.log` E2BIG 24 行；`oc-dispatch.mjs:286-293` 的修复注释；`maintenance-handoff.md` |
| 1.6 | 资源/状态膨胀无人治理：`sessions.json` 7.75MB（C1 sentQueue 1304 条、C2 1390 条）+ 5 份 7MB 备份；守护进程每轮全量读写。 | `ls -la .oc-runs` |

## 2. 监控与发现（评分 4/10）

| # | 结论 | 证据 |
|---|---|---|
| 2.1 | **检测快、处置几乎为零**：卡住检测 90 秒触发，共 1215 段、累计 235 lane·小时；44 段超过 10 分钟，其中只有 3 段在恢复前有人干预（中位 13 分钟），41 段是自己结束的；最长一段 R6 卡 18.3 小时直到 lane 停止。守护进程自己的“30 分钟疑似卡住”只触发 7 次。 | `stalls.jsonl`（start/end 配对）；`watch.log` 干预事件对齐 |
| 2.2 | **监控的是进程，不是产出**：执行者 1865 轮中 844 轮（45%）没有任何文件改动；有改动的 1021 轮里 390 轮（38%）只改文档；执行者编辑操作中文档 3608 次，产品代码 2066 + 测试 1783。11-06 17:30Z 在跑的 18 条执行者里 6 条在空转（5 条两小时 40–78 步零提交，1 条只提交文档）。这些都不会触发“无输出/出错率/无提交 90 分钟”报警（有输出、有检查点提交）。 | lane 日志（含 archive 635MB）逐轮分类；`progress.mjs` 回放 |
| 2.3 | **度量失真无人对账**：命令 B 级从 11-04 18:22Z 起连续 47.6 小时为 0，而 A 级 99.8%——判据要求 SPEC 逐条打勾，属于“没统计”而非“没做”，但被当成“没做”驱动了大量补文档；测试 B 级 89.2% 来自 `fulltestOk=false` 的一次全测；仓库 `migration/LEDGER.md` 停在 11-03。 | `ledger-history.jsonl` 250 行；`fulltest/history.jsonl` |
| 2.4 | **main 上的数字掺水**：11-01 以来 main 7378 个非合并提交，53%（3906）是自动检查点/WIP，34.5%（2545）只改文档；121 轮自动集成里 65 轮（54%）0 合入，累计合入 488 / 拒绝 636。 | `git log main --no-merges`；`watch.log` 集成摘要 |
| 2.5 | **功能可达性与端到端行为完全没有探针**：Agent 工具执行器约 30 个未实现（`attempt_completion` 无法结束循环）、前端参数键错误、事件无发射点、Electron 缺权限拦截、>2GiB 备份无法导入——看板与 `COMMAND.md` 中相关关键词出现 0 次。账本只数“1058 个命令有没有注册”。 | 看板/上报关键词检索：attempt_completion / setPermissionRequestHandler / 2GiB / ZIP64 均为 0 |
| 2.6 | 环境问题被当成产品问题、证据不可追溯：全测 6 个失败来自作业 TMPDIR 在隐藏路径（W09 `e60501a` 已修）；G3 1043 组对比缺 B 端提交号，不能作为验收证据。 | `fulltest/latest.json`；`maintenance-night.md` |
| 2.7 | 推送通道被噪声污染后被整体关闭：stall-watch 汇总 359 条里 354 条与 3 小时内旧消息高度相似；另有 111 份“协调者卡住检测”上报。v3 改为 `--digest-min 100000` 后，卡住信息不再推给任何人。 | 消息相似度统计；`ds-stall-watch.service.d/v3.conf` |

## 3. 主动性与推进（评分 4/10）

| # | 结论 | 证据 |
|---|---|---|
| 3.1 | **C0 以读和写为主**：11-05/06 共唤醒 155 次，`COMMAND.md` 140 段（112KB，平均 7.5 分钟一段，15 段“无变化”）；工具调用中读状态约 472 次，改变状态的 `coord` 动作 115 次（多数是 queue），写看板 91 次。 | `C0-chief*.jsonl` 工具分类；`board/COMMAND.md` |
| 3.2 | **同一阻塞重复催办**：C0 的 132 次主题催办中 18 次是 2 小时内同主题第 3 次以上（WP-043 → C1 7 次）；C2 的 1060 条消息中 97 条与 3 小时内旧消息高度相似。`COMMAND.md` 里 23 段出现“最高优先级/第 2-3 轮”，7 段写“C0 接管调度”——但 C0 没有接管用的执行器。 | `sessions.json` sentQueue 回放；`COMMAND.md` |
| 3.3 | **协调者把轮次花在文档上**：协调者 706 轮里 397 轮（56%）只改看板/文档、269 轮无改动；其编辑操作中看板 703 + 文档 1151，代码 55、编排 86。看板文件合计 1.27MB（INTEGRATION 380KB、WORKPLAN 269KB、COMMAND 188KB、BASELINE 185KB、DECISIONS 115KB）。 | 协调者日志逐轮分类；`wc -c board/*.md` |
| 3.4 | **上报 ≠ 处理**：593 份上报全部被守护进程立即改名 `.seen`（转发即算看过）；241 份 lane 上报中，协调者回复该 lane 的中位延迟 23.8 分钟、p90 191 分钟，29 份（12%）6 小时内没有任何回复。 | `oc-dispatch.mjs:749`；escalations × sentQueue 对齐 |
| 3.5 | 有规则无机制：`NIGHT-OPERATIONS.md:14` 要求“同一阻塞连续两轮无新证据→唯一 owner 执行具体动作”，`maintenance-handoff.md` 要求“不再只催办、补文档或刷映射”，但发送路径上没有任何检查。 | 文档原文；`coord.mjs queue`（旧）无闸门 |

## 4. 根因归纳

1. **能力边界**：协调者是 dsdev 下、opencode 沙箱里的 LLM，只有“发消息”和少量调度执行器；结构性故障（属主、systemd、坏状态文件）在它的权限之外，且 C0 合同明令不写脚本/配置。
2. **信号层级错位**：监控回答“进程活着吗、有输出吗”，没有回答“产出了什么、数字是不是同源、功能能不能用”。
3. **闭环缺失**：检测 → 记录 → 发消息，止于消息；没有“检测 → 动作 → 复核”的自动路径，也没有阻止“再发一遍”的闸门。

## 5. 本次落地（W11）

| 改动 | 解决 |
|---|---|
| `lib/repair-actions.mjs` + `repair.mjs` + `coord.mjs repair` | 1.2、1.4、1.5（全测恢复）、1.6 |
| `night-guard.py` v3（dsdev + sudoers 白名单；第二轮审查后取代 root 运行的 v2）+ `deploy-night.mjs` 停用 | 1.2（检测 + 人工一次性修复）、1.3 |
| `lib/progress.mjs` + `coord.mjs progress` + 唤醒摘要 + pipeline-check 结构检测 | 2.2、2.3、2.4，及 1.2 的发现 |
| `lib/nudge-guard.mjs`（`coord.mjs queue` 闸门） | 3.2、3.5 |
| `lib/stall-policy.mjs` + `stall-watch --auto-restart-min` | 2.1 |

未落地、交接：功能可达性/端到端探针（2.5，需 W09 的 gate-checks/contracts）、B 级判据（2.3，`ledger-core.mjs` 归 W09）、证据清单校验（2.6，`record/` 归 X7）。
