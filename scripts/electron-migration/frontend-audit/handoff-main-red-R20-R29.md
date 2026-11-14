# main-red R20 / R29：既有 X2 负前提已被 owner 进展取代

- fulltest 原基线 `650ddffbe`，原全量 exit 1（C1 回执：32 failed / 21 files failed）；本轮固定 main `f821b3733`。
- R20：L18 `159fbc8ae` 经 `650ddffbe` 注册真实 `textbooks_add`（media/index.ts:729-743 → src/textbooks-add.ts）。X2 旧断言仍为“未注册”。
- R29：L04 `cd40ee716` / `862095376` 经 `bb04a0c0e` 发布 dispatcher 与 worker-runtime 条件注册。精确 Rust ID `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs::tests::g03_dedup_hit_converges_to_delivered_without_redelivery` 现映射到 `host/plugins/chat/tests/completion-dispatcher.test.ts`，不再 pending；X2 正则却写死 pending。

## owner / 协调动作

这是 owner 新生产入口合入后，X2 历史状态断言失效，不是要求 L18 注销命令或 L04 恢复 pending 的业务回退。
X2 自行更新原用例：R20 保留真实 apply/invoke，验证 Rust 空输入、Configuration 错误与文本导入/进度/持久化；R29 保留全部 Option 省略断言，核精确 Rust ID、真实 emitter 接线和原去重不重投递测试。
请 C1 正常集成 X2 的 `fix(main-red)`；L18/L04 不需为旧负断言回退。完整 execute / GUI / Android 等未签边界不随此次修正通过。

## 最小复验

- 原失败复现 `20261104233449-dff02b`：2 failed / exit 1；不是隐藏全量旧失败。
- 更新后的原最小集 `20261104233857-07c123`：仅 X2-R20 / X2-R29，2 passed / exit 0。R20 验证空 sources、Configuration、真实 txt 导入的完整 DTO、落库和 null 进度/watch 事件；R29 保留全部旧可选字段断言并调用真实生产 serializer。
- L04 原 G03 `g03_dedup_hit_converges_to_delivered_without_redelivery` 未改，`20261104233449-ae7301` 1 passed / exit 0，delivered 状态与 inbox 一条结果均保留。
- L04 原 worker 成功及失败/取消两例 `20261104233657-aa8f51` 2 passed / exit 0：真实 worker/事件，但 execute 与跨 lane seams 是原测试提供的外部端口。
- 不改生产契约、GENERATED 或 owner 测试，不重扫 1,673 调用点；PDF/其他格式、完整真实模型流水线、GUI/Android 不签。
