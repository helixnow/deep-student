WP-219 首检查点：修前一次最小取证已证实本 lane 旧夹具重复注册 embedding@1；将窄修真实 owner 装配。

- 原 tip `53e40d3e534b60c0982f4b573a5c3694f11f05e7`，正常 merge 固定 main `df2cd30a1cacf598df851f40d643bb12ceacc7f2` 后 tip `bc0a0b9e5d38df3b6125ad77ce48bb93a61b4015`。
- 本包唯一修前 job `20261105232019-f83490` raw exit1/signal null；1 failed file，0 passed / 0 failed assertions / 3 skipped，Errors/Unhandled 0。原 hook 180000/testTimeout30000，fork1。
- 完整 stdout/stderr、run metadata、Vitest JSON 在本目录 `WP-219-before.{stdout.log,stderr.log,run.json,vitest.json}`；队列原件 `~/.oc-jobs/done/20261105232019-f83490.{log,json}`。Node26.5.0/ABI147。
- 原错误 `Error: service "embedding@1" has been registered at <root>`，llm/index.ts:146 → kernel/testing.ts:209 → 本测试:48。L12 fixture:53 的旧替身与实际 L02 owner 重复。
- 检索还找到并亲读 C2 已结束的 `20261105231336-8c00a8` log/json，同错误、exit1/3 skipped；这是后续复验原件，不能补称为官方2240缺失的栈。此次未与 C2 定向复验并发；不再投修前重复作业。
- 将删除旧 embedding 替身与 getApiConfigs spy，经真实 L02 配置、F3 usage/F4 settings 与确定性本地 HTTP 建立第三例前提。三条完整错误、进度后重读与零段写入保持；不改生产/超时/TESTMAP。
- 两份 foreign migration 账本仍未动；202/205/192 原证据保留，WP-202 仍等新候选完整官方组合，009 全域 independent acceptance 不关闭。
