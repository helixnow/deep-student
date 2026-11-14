# X5-stream-parity lane 状态

**WP-089**：`fixed-https/` 交付逐 A/B take 的本地 CONNECT/TLS 隔离服务、每进程 CA、运行说明及 B 真实 IlinkClient 请求原件（job `20261105173827-caa449` exit0）。A 仍 blocked：reqwest 0.11.27 当前未带 native-roots，需构建维护提供每进程 CA 信任；Electron 未测。D38 open，不能称双端/登录成功。详见新 `BLOCKERS.md`、`fixed-https/README.md` 和 audit。首个样本限 iLink，GitHub/codeload/clawhub 不响应业务协议。

**未完成：Host 普通/thinking/EOF-error 已获限定签收（official `1d788c4a1` 绿）；新 cancel 场景定向红，待 L03 核定外层取消 Drop 语义；其余场景及完整 parity 未通过。** 本 lane 只审计和写测试，不实现生产代码。

**WAVE0（WP-042）**：`wave0/` 提供确定性 LLM 服务（start/stop/CLI）、生产事件记录器、v0 场景 runner、候选规范化生成器，见 `wave0/README.md` 和审计文件中的 §WAVE0。B 端五个场景已录制；A 端录制属于 X7，尚未进行；候选规则待 C2 审核。没有 A/B 等价结论。

**WP-096**：修复 WP-042 数值记录失真，事件原始 `payloadJson`、step `argsJson/valueJson` 与展示值并存；候选比较走公开精确 JSON reader，B runner 保留真实 kernel invoke outcome.json。A 端缺 raw 明确不支持精度证明；旧 B 录件保留为历史轨迹，不可用于精度证明。自检/回归见 audit WP-096。原 cancel-after-partial 九条预期保留，L03 取消 Drop owner 阻塞继续有效。以下“本轮无可执行事项”是旧取消审计轮次的历史结论，WP-096 只按当前 WORKER 单包交付。

## 本轮可执行事项：已完成（不等于 lane/parity 完成）

C1已亲核取消的两次原始失败：`20261105015318-089cba` exit1/1fail，以及 official `70ad586ca` / main `628b4192e` 的 `20261105020134-ff7f35` exit1/26pass1fail、无Errors/非超时。9-vs10红断言与 `/tmp/opencode/x5-cancel-CmPIhY/trace.json`、`/tmp/opencode/x5-cancel-ySbOwE/trace.json` 均保留，未过滤/改表迁就；未观察late content:end，不扩大结论。

C1补核Rust外层取消Drop与L02主动取消不能混同，需架构授权实际writer核定/修复。当前仅余owner结论，无获准的进一步本轮执行事项：不改生产，不扩retry/变体，不循环同红runner。既有parked L03信箱消息保留，后续依赖统一经C1/C2/架构，不追加停放执行消息、不解除停放。本次收尾只记报告，正式自检仍红，完整parity仍不通过。

## 剩余事项

| 编号 | 状态（cancel 测试 `eaab4d13a`；main `f2d5b6c46`） | owner / 下一步 |
|---|---|---|
| X5-01 | 真实公开 cancel 在消费 partial 后关闭未自然结束HTTP，DB与唯一session取消前置证据已过；完整九条Rust预期 vs十条实际保红。retry目前只有业务guard证据 | L03 核定cancel-drop；X5真实retry generation未验收 |
| X5-02 | send→真实 L03 execute→L02 unified stream→公共假 adapter→本地 HTTP/SSE 的首条模型消费已实测 | X5 后续场景；不是 L01 真实供应商 parser 验收 |
| X5-03 | 普通11条/thinking15条/EOF-error10条获限定签收；cancel增加scoped_cancelled且JS loser在session终态后继续日志，待owner确认Drop语义，未签cancel | L03牵头；chatToolRuntime/工具第二轮/变体仍独立未验收 |

下一步仅由C1/C2/架构统一协调实际owner，待明确授权/修复进入main后恢复验收；本轮不继续扩场景。断言草案见 `REAL-CHAIN-PLAN.md`。已签收的六条局部用例不重跑。

## 已签收

- EOF-error：C1已核 official `1d788c4a1` / base `f2d5b6c46` 四项通过，`20261105012734-ffc959` exit0/26pass，认可该错误分支限定门槛；不覆盖原77c门禁失败历史或本次cancel差异。
- Host thinking：C1 已核定向 `20261105001757-5863a6` exit0、official `3bf7aaa8e` / base `c6309183c` 自检ok，全部15事件、reasoning usage及两类块终态前落库获得限定签收；不签 L01 parser/Electron/完整 parity。
- 首条 Host 普通回答：作业 `20261104234958-48890f` exit 0，1 passed。真实 diagnostics + 公开模型设置 + 本地 HTTP/SSE；fake.created/requests 各一次、parsed 四帧，终态时真实 DB 可读，全量 11 条事件顺序严格匹配。不是七场景或真实 Electron 窗口 E2E。
- X5-05、X5-04 binder 接线、X5-03 发射子项：`3d293b55e`，作业 `20261104065020-9dacfe` exit 0。

## 自检

- cancel 定向 `20261105015318-089cba` exit1/1failed（非超时），九条外层Drop预期与实际十条差异，原件 `/tmp/opencode/x5-cancel-CmPIhY/trace.json`；已投L03/C1，不放宽红断言，报告提交后仅§5收尾。
- official `77c0326be` / main `a9683a43b`：`20261105004831-04d655` exit1，components beforeAll60s、error/thinking test60s，3files failed/2passed、15pass2fail9skip、Errors3 onTaskUpdate。负载/并发不足以确诊；保持预算与断言，先用仅 error 文件的独立阶段 JSONL 区分初始化/真实执行/清理，不扩新场景。
- 固定诊断 `c6d58ce8f`：单error `20261105011125-f717a1` exit0/1passed；原三失败文件各一条 `20261105011341-23b4da` exit0/3passed/10标题过滤。独立JSONL显示迁移各一次、插件装配/流等待/终态/清理均完成，当前最小组未复现；不能覆盖原official红灯或确定原卡点，交C1关联共享RPC诊断，不再整矩阵。
- error-after-partial EOF 定向 `20261105004415-2455a3` exit 0 / 1 passed，完整十条与终态回调真实部分DB；本轮无额外手动重跑已签场景，提交后再 §5。
- thinking 定向 `20261105001757-5863a6` exit 0 / 1 passed；首两次 `20261105000718-50a066`、`20261105001033-ff97b2` 各 exit1 保历史（事件预期遗漏/Host 内存与 JSON 键缺省层级）；未修改生产、未过滤事件，提交后再 §5。
- main-red `650ddffbe` 最小回归：`20261104233543-76712a` exit 0，三种 retry 各自合法参数均到达精确 MESSAGE_NOT_FOUND（3 passed / 9 filtered skipped），不计主链成功。
- main `7f4fb688b`：修正 execute 已实现后过时的缺口断言；typecheck `20261104173123-e79ea8`、boundaries `20261104173123-34ba58`、host vitest 本目录 `20261104173123-31fdd8` 均 exit 0（23 passed 为门禁复验，不计主链通过）。
- main `677f6727c` 合并后的 tests 装载回归：`dstu.vfs` 要求新增 `notes/vfsIndex`。夹具补装两个真实插件；定向装载回归作业 `20261104161902-1b782a` exit 0（1 passed / 11 filtered skipped）。不计主链通过。
- `151f15e62`（main `45c3250b0`）：lane-gate 4/4 通过（typecheck、boundaries、boundaries-strict(changed)、tests）。

完整 parity：**不通过**。
