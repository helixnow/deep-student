# 执行者协议（编排 v3）

你在一个 lane 的独立工作树里，用一个新会话完成**一个工作包**。工作包 brief 在派发消息里，也存于 `/home/dsdev/dev/deep-student/.oc-runs/board/wp/<WP>.brief.md`。

## 开始
1. 读 brief、本 lane 任务卡（`docs/dev/electron-migration/dispatch/<lane>.md`）、LANE.md / BLOCKERS.md / TESTMAP.md。
2. `git merge --no-edit main`；跑本 lane 的类型检查与相关测试，确认起点。起点就红：先判断是不是你的问题；不是就写进报告，继续做不受影响的部分。
3. 依赖核实：brief 列出的接口真的在 main 上（`git show main:<路径>`）。不在 → 不要自己实现别人的接口，写进报告"阻塞"，完成能做的部分后交付。

## 执行
- 只改本 lane 允许路径（运行环境一节列出）。需要别人改的，写进报告。
- 严格遵守 `standard-v2.md` 全部硬规则：测生产代码、单一所有者、对齐 serde、保留日志与错误语义、测试真实、覆盖全部分支、运行时语义一致。
- 所有类型检查/测试/构建经作业队列：`node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- <命令>`（排队期间做不占 CPU 的事）。不要直接起 vitest/tsc。
- 不运行 Rust、不装依赖（brief 明确授权的除外）。
- TESTMAP 映射：每条都要读 Rust 原测试全文与候选 TS 用例，确认断言、边界、失败路径等价后才改去向。名字相同不是证据。对不上的保留 pending，在报告里写差异。
- 禁止：弱化/删除断言、`skip`/`todo`、`expect(true)`、放宽超时或数值、改实现迁就测试、未批准的 `obsolete`。
- 发现 BLOCKERS/LANE 文档已过时，顺手更正（附证据）。

## 交付
1. 提交（只提交你的改动；他人生成物如 `migration/LEDGER.md`、`ledger.json` 的未提交改动不要提交）。
2. 自检：`node /home/dsdev/dev/deep-student/scripts/electron-migration/lane-gate.mjs`，修到全部通过。确实因他人问题无法全绿的，在报告里给出失败原文与归属。
3. 写报告并交付：`node /home/dsdev/dev/deep-student/scripts/electron-migration/coord.mjs wp-done <WP> <报告文件> --lane <你的 lane>`。
4. 结束会话。不要等待新指令；下一件事由协调者另行派发（新会话）。

## 报告格式（中文，第一行是一句话结论）
```
结论：<完成 / 部分完成 / 阻塞>，<一句话>
提交：<短 sha 列表>（分支 tip <sha>）
自检：lane-gate job <id> exit <code>；各项结果
测试：<文件/目录> passed X / failed Y / skipped Z（job id）
TESTMAP：pending 前 N → 后 M；本包改动的条目逐条列出：Rust id（文件:行）→ TS 文件:行/用例名，断言对应说明
未完成：<条目与原因>
阻塞：<需要谁、提供什么接口（方法签名/语义对应的 Rust 函数文件:行）、谁在等>
供抽检：<随机挑 2 条最值得复核的条目>
```

## 上下文
本会话预算约 250K 上下文。接近时：提交已完成部分，交付"部分完成"报告，写清剩余项。不要硬撑到自动压缩。
