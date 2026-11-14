# 夜间运行约定（2026-11-07，用户授权的维护覆盖条款）

本文件覆盖角色文件中冲突的旧调度/供应商说明，不修改行为等价和代码质量完成标准。

## 明早的交付物

08:00 CST前形成一份真实快照：固定main全测（含raw退出、缺片、pending）、G1真实dist窗口、G2四流程、G3固定768五态及覆盖率/证据缺口、产品净变更、未闭合根因。全绿才说完成；否则明确已经跨过哪些关键障碍，剩余owner与解除条件。注册率、场景equal、提交数均不能代替完成度。

## 责任与主动性

- C1拥有产品修复任务图：共同根因/供方先于消费方，已有writer只排后继，不新增并行writer。每包30–90分钟，明确输入、Rust依据、生产入口与通过证据。空闲不是必须派活的理由；不要用报告/TESTMAP工作填满机器。
- C2拥有唯一正式验收：通过systemd启动 `ds-fulltest.service`，不再写/tmp waiter/冻结标记链。不同run不可混片；完整但raw非0仍是非绿。差异按真实根因聚类，不能每个下游症状一包。
- S0拥有维护上线后的运维：读 `night-progress.json`、具体服务journal与incident。可在用户既有授权内处理38服务器的可逆管线问题；先保全再执行，不需为了合法的项目服务部署再次等用户。但不能结束活业务任务、清除未知WIP或改变验收标准。
- C0负责闭环而非重复催办：同一阻塞连续两轮无新证据，要求C1/C2/S0中唯一owner执行具体动作，或明确不可自动处理的保留事项；不能每10分钟重发相同指令，也不能把一次正常长任务当死锁。可使用 `coord integrate/pause-dispatch/resume-dispatch` 的已有安全执行器，不能强收活租约。
- root定时night-guard仅处理已知控制故障（服务退出/心跳停滞）、输出资源/验收快照与去重告警，不替AI做语义签收。
- night-guard v3（W11）：以 dsdev 运行，特权只有 sudoers 白名单中的 start/reset-failed/restart；失败服务与心跳停滞有退避和熔断，重启前留诊断；属主漂移只报告（人工一次性修复）。有意停服务先写 `~/ops-night/hold/<服务名>`；维护期间写 `.oc-runs/maintenance.json`（一行原因）挂起所有自动启动/重启/恢复，结束后删除。维护操作一律 `sudo -u dsdev git`，root 不在仓库与 dsdev 目录里运行任何程序。存在超过 6 小时（`DS_HOLD_ALERT_HOURS`）的 hold/维护标记会进唤醒摘要与 `night-progress.json` 的 `holdAlerts`；不再需要的立即删除。
- C0“唯一owner执行具体动作”的规则由 `coord.mjs queue` 执行：同主题 2 小时内第 3 次且无新证据（提交号/job id/run id）的催办被拒绝（退出码 3），按拒绝信息改用 `repair`/`restart`/`integrate` 或写“待用户裁定”。
- 管线结构故障（属主、坏状态文件、残留锁、孤儿全测）先用 `coord.mjs repair check`/`apply`，不要发消息让 lane 处理它们修不了的东西。

## 资源与作业

- 所有叶子测试/编译/扫描/构建经jobs；集成门禁已接同一队列。父编排器 lane-gate/fulltest不能再提交到该队列等待自己的子任务。
- 全局同时6个叶子任务，test最多3、typecheck2、other2、build1、rust1；无低压burst。保留28核slice上限、52GiB内存硬限和系统余量。
- 新任务准入要求：可用内存≥8GiB、磁盘≥25GiB、共享UID线程<1400、CPU压力≤40%、load≤核数×1.4。暂停只阻止新启动，不放宽/跳过既有测试。保留sandbox NPROC2048。
- G3只能跑固定干净树，初始A2/B/A合计6worker，有PID namespace和systemd cgroup托管。不得再裸跑42worker。资源紧张时等空位，不提高并发赌吞吐。
- 每个job有专用TMPDIR、进程组和原始code/signal/源码前后记录；只清理已完成且24小时以上的受控job tmp。任何patch、原始轨迹、profile、DB、未提交源码都不能按/tmp年龄删除。

## 会话与供应商

- 当前可用主渠道xhh（Sol/Astra）；一般确定性包可用opencode-go/deepseek-v4.1-flash#max。不要从旧角色文件再派ai98pro/tokenfree。
- 协调、独立复核、差分框架/原生能力/关键语义包使用xhh。DeepSeek不得自行扩写复杂语义或改断言；由主协调者给出原Rust输入与明确验收。
- 供应商失败有持久退避；连续无进展换新会话时读当前WP brief，不恢复旧“全域继续”任务。严重失败必须留下可执行纠正，而非无限“不计重试”复活。
- 普通消息只排队，不能因收件人失败就绕过全局cap立即启动。活writer不自动WIP提交，避免验证时源码和分支tip漂移。lane-gate会拒收验证期间变化的源码。
- 每轮只读看板当前状态与相关包，历史裁定按ID搜索；不反复读完整数十万字协调日志。

## 证据与版本

- fulltest每run独立目录/工作树，job ID、raw code/signal、前后HEAD完整保存；dashboard只在受测head计算账本，保留sourceHead/runId，不拿新main映射配旧测试。
- ledger默认输出到非源码目录；禁止写回migration/生成物。主树脏时集成在测试前报告阻塞，不清WIP、不重测空转。
- 旧G3缺实际Host revision的数据保留诊断，不倒填、不永远等待不存在的终态。固定树新run取得正式证明；已知Rust缺陷/有意行为变化单列，不用归一化造equal。
- Linux上的通过不证明macOS/Windows、历史WebView数据迁移或发布安装通过；这些保留缺口必须在交付报告中明确。
