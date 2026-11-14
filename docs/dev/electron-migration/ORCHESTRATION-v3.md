# 编排 v3（2026-11-05 起生效，取代 v2 中与之冲突的调度条款）

v2 的问题不在模型能力，而在调度：普通消息排队 5 分钟就打断 lane（立即送达 864 次 > 正常续派 728 次）；协调者被噪声唤醒（stall 汇总占收件 29%）、大部分工具调用在读状态；49% 的自动续派落在上下文 ≥320K 的会话上；上报只改名为 `.seen`，架构师离线后约 250 份无人处理；12 条停放 lane 积压了约 95 条过期指令；跨 lane 接口需求在 lane 之间点对点直发约 970 条，提供方被停放时无人收口。证据见 `.oc-runs/board/BASELINE.md`。

v3 只改调度与分工，**质量标准不变**：`standard-v2.md`、`quality.md`、`controls.md` 的全部硬规则继续有效。

## 1. 角色

| 角色 | 会话 | 职责 | 独占写 |
|---|---|---|---|
| **C1-app：交付协调者** | 常驻，按需唤醒 | 全部剩余工作的计划、拆包、派发、依赖收口、架构裁定 | `board/WORKPLAN.md`、`board/DEPS.md`、`board/DECISIONS.md` |
| **C2-platform：集成与验证协调者** | 常驻，按需唤醒 | main 常绿、工作包进 main、全测与账本、独立复核与抽检、门禁误报处理 | `board/INTEGRATION.md`、`board/BASELINE.md` |
| **C0-chief：总指挥（监督者）** | 常驻，固定每 10 分钟唤醒 | 监督整体进度与含金量，找出卡点并催办 C1/C2；只做判断、催办、升级，不写代码 | `board/COMMAND.md` |
| **执行者（各 lane）** | **每个工作包一个新会话** | 在本 lane 工作树内完成一个工作包，自检，交付报告 | 本 lane 允许路径 |
| **复核者（R1–R6、X6）** | 同执行者 | 由 C2 派发的独立审读/抽检工作包 | 各自允许路径 |
| **用户** | — | 仅保留事项（§7） | — |

不再有"架构师"在线角色。原先需要架构师的决定，按 §7 由 C1 或 C2 直接裁定并记入 `DECISIONS.md`。

## 2. 看板：唯一事实来源

路径 `/home/dsdev/dev/deep-student/.oc-runs/board/`（不进 git，所有工作树可见，ds-backup 每 30 分钟备份）。

- `BASELINE.md`：当前基线事实（main、全测、账本、未闭合依赖、端到端工作流）。C2 维护。
- `WORKPLAN.md`：工作包表。C1 维护。每行：`WP 编号 | lane | 标题 | 波次 | 依赖 | 状态 | 模型 | 派发时间 | 交付 tip`。状态：`ready / assigned / delivered / integrated / blocked / dropped`。
- `DEPS.md`：跨 lane 未闭合接口（提供方 → 消费方、接口、状态、对应 WP）。C1 维护。
- `INTEGRATION.md`：待集成队列、门禁结果、main 红灯与处置。C2 维护。
- `DECISIONS.md`：裁定记录（编号、问题、决定、依据、裁定者、时间）；`## 待用户裁定` 一节列保留事项。
- `ESCALATIONS.log`：协调者的上报（守护进程追加）。
- `wp/WP-xxx.brief.md`、`wp/WP-xxx.report.md`：派发 brief 与交付报告（工具写入）。

协调者是**无状态**的：每次唤醒都从看板与 git 重建判断，不依赖会话记忆。会话上下文超过 200K 时守护进程自动换新会话。

## 3. 工作包生命周期

1. **拆包**（C1）：一个工作包 = 一个 lane 内、一个会话（目标 ≤2 小时、上下文 ≤250K）能完成并能独立验收的单元。写清目标、范围（文件/Rust 来源）、验收条件、依赖、禁止事项。
2. **派发**（C1，复核类由 C2）：`node scripts/electron-migration/coord.mjs assign <lane> WP-xxx <brief文件> --from C1-app [--model m]`。lane 在跑时会被拒绝；守护进程以**新会话**启动，旧会话 id 存入 `prevSessions`，旧事件流归档到 `.oc-runs/archive/`。
3. **执行**（执行者）：按 `dispatch/WORKER.md`。只在本 lane 允许路径内改动；验证全走作业队列。
4. **交付**（执行者）：提交 → `lane-gate.mjs` 自检全绿 → `coord.mjs wp-done WP-xxx <报告> --lane <lane>`，自动通知所属协调者与 C2。然后结束会话。
5. **集成**（C2）：守护进程每 3 轮自动集成；C2 处理被拒、跨 lane 组合与红灯。
6. **验收**（C1 读报告与证据；C2 按 §6 抽检）：`integrated` 且验收条件满足才算完成。

一个 lane 同一时间只有一个执行者会话（单写者不变）。需要并行时，C1 把同一 lane 的工作拆成**有先后的**工作包，而不是同时派两个。

## 4. 消息与唤醒

- 守护进程参数：`--queue-max-age-min 100000`（普通消息**不再**因排队时间打断 lane）、`--coord-min-gap-min 10`、`--coord-wake-min 30`、`DS_AUTO_CONTINUE_MAX=0`（不再用固定提示空转续派）。
- 总指挥 C0 固定每 10 分钟唤醒（会话字段 `wakeMin=10`、`minGapMin=10`）：只读看板与 `coord.mjs substance/health`，向 C1/C2 发催办。它给 C1/C2 的消息默认排队；只有正在造成损害（越界写、伪造证据、main 红灯扩大）才允许 `--now`。
- 普通消息（`queue`）只在 lane 本轮收尾后送达；打断（`--now`）只用于正在造成损害的情形（越界写、伪造证据、破坏 main）。
- 协调者被唤醒的条件：负责范围内有 lane 收尾/放弃、收到消息（至少间隔 10 分钟），或 30 分钟兜底。
- stall-watch 不再发信箱汇总（只写 `.oc-runs/stalls*.json`，健康表照常读取）；pipeline-check 不再发信箱报警（只写 `pipeline-alerts.json`，进唤醒摘要）。
- lane 不再点对点给其他 lane 发接口需求。需求写进交付报告的"阻塞"一节，由 C1 记入 `DEPS.md` 并给提供方派工作包。
- lane 的 `escalate` 转给其协调者；协调者的 `escalate` 记入 `ESCALATIONS.log` 并写进 `DECISIONS.md` 的"待用户裁定"。

## 5. 上下文与会话卫生

- 执行者：一个工作包一个新会话。会话内收到的后续反馈（门禁失败等）若原会话上下文 >260K，守护进程自动改用新会话并附上反馈。
- 协调者：上下文 >200K 自动换新会话（启动消息要求先读角色文件与看板）。
- 协调者每轮唤醒的产出写进看板，不在会话里"记住"。协调日志 `coordination/C*.md` 只记本轮的决定与理由，单轮 ≤40 行。

## 6. 质量防护（不因提速放松）

- 执行者交付报告必须粘贴原始证据（提交号、自检 job id 与 exit、测试 passed/failed/skipped 计数、TESTMAP 前后计数）。
- **TESTMAP 映射类工作包**：C2 对每个交付抽检 ≥10%（至少 1 条），逐条读 Rust 原测试与 TS 用例；发现按名字硬映射即整包退回并回滚该包提交。
- 完成标准按账本：测试 A/B、命令 A/B/C（`ledger-core.mjs`）。不得为提升数字而改 TESTMAP 却无对应断言。
- 禁止：弱化/删除断言、`skip`/`todo`、`expect(true)`、放宽超时或数值、改实现迁就测试、未批准的 `obsolete`。

## 7. 决策权

**C1 可直接裁定**（记入 `DECISIONS.md`）：接口归属与签名、跨 lane 语义争议（以 Rust 源码为准）、运行时策略（如 finalizer 注册失败是否中止启动）、新增 MIT/Apache/BSD 许可的 npm 依赖、工作包拆分与先后、lane 停放与换模型。
**C2 可直接裁定**：集成顺序与组合、回退已合入的坏提交（`git revert`，不改写历史）、门禁误报的定性与隔离清单、`obsolete` 批准（`migration/approvals.d/C2-platform.json`）、复核结论的签收。
**保留给用户**（写入 `DECISIONS.md`「待用户裁定」，工作不得因此停下，先做不依赖它的部分）：
- macOS / Windows 构建与实测资源（CI runner、实机）、代码签名证书、发布渠道与更新服务器；
- 删除用户数据或改变数据目录/标识；
- 修改质量标准或完成定义本身。

## 8. 资源

- `--max-running 26`（2 协调者 + 最多 24 执行者）。作业队列 `typecheck=6,test=6,build=2`，集成门禁 `VITEST_MAX_FORKS=4`。
- 模型（11-05 22:30 用户指令）：xhh 硬上限 10 并发（含 2 个协调者的预留名额），只用 `xhh/gpt-6-astra#high`，留给最难、最关键路径的工作包；其余全部用 `ai98pro/claude-opus-5-5#high`（上限 16）。`gpt-6.1-sol` 停用（守护进程会自动改为 opus）。派发时 xhh 已满，守护进程自动改用 opus，xhh 有空位后在下一个工作包边界切回。上限由守护进程环境 `DS_PROVIDER_CAPS=xhh:10,ai98pro:16`、`DS_FILL_MODEL` 控制。
- 总指挥 C0 单独使用 `opencode-go/deepseek-v4.1-flash#max`，不占 xhh/ai98pro 名额；固定每 10 分钟唤醒，只读监督，不写代码。
- Rust 构建（X7 差分/录制）只经作业队列 `build` 类执行。
