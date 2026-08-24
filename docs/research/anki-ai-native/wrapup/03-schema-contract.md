# ChatAnki Skill Schema / Rust 参数契约收尾

核对范围：`builtin-chatanki_run`、`start`、`analyze`、`transform`、`retemplate`。Rust 真源分别为 `ChatAnkiRunArgs`、`ChatAnkiStartArgs`、`ChatAnkiAnalyzeArgs`、`ChatAnkiTransformArgs`、`ChatAnkiRetemplateArgs`。

## 逐字段结论

| 工具 | Rust wire 字段 | Skill schema 结论 |
|---|---|---|
| `run` | `goal, content, route, resourceId, resourceIds, templateId, templateIds, templateMode, deckName, noteType, maxCards, extraRequirements, outputProtocol, visualHint, contentFormat, enableQaPass, enableFsrsFeedback, maxImages, enablePreferenceMemory, debug` | 集合一致；route、templateMode、outputProtocol、contentFormat 枚举及 maxCards/maxImages 公共边界已锁定 |
| `start` | `goal, content, templateId, templateIds, templateMode, deckName, noteType, maxCards, extraRequirements, outputProtocol, contentFormat, enableQaPass, enableFsrsFeedback, enablePreferenceMemory, debug` | 集合一致；未暴露 run 专属的 route/resource/visualHint/maxImages |
| `analyze` | `content, goal, route, resourceId, resourceIds` | 集合一致；补齐非空 source、非空 resourceIds 与未知字段拒绝 |
| `transform` | `documentId, selection, mode, transform, expectedVersions, purpose` | 集合一致；补齐 selection 二选一、apply 必须携带非空 expectedVersions、非空 ID/script/pattern/tag 及各 op 必填/禁用字段 |
| `retemplate` | `documentId, cardIds, targetTemplateId, strategy, expectedVersions` | 集合一致；selector 二选一、版本映射和 `fill_missing_llm` 已与 Rust 一致 |

## 发现的不一致与处理

1. `transform.selection` 原 schema 只在描述中声明 `cardIds`/`filter` 互斥，空 selection 或同时提供两者仍可通过 schema；Rust 会拒绝。已用 `oneOf` 对齐。
2. `transform(mode=apply)` 原 schema 只在描述中声明 `expectedVersions` 必填，未声明条件 required，空映射也可通过；Rust 会拒绝。已增加条件 required 与 `minProperties: 1`。
3. transform 原 schema 未表达 `regex_replace` 必须带 `field+pattern`、tag op 必须带 `tags`，也未排除跨 op 参数；Rust 会拒绝。已用按 op 的 `oneOf` 对齐，并补齐 Rust 的非空及长度边界。
4. `analyze` 原 schema 允许空 `content`、空 `resourceId`、空 `resourceIds` 以及未知参数；Rust 归一化后会报 `content or resourceIds is required`。已补有效 source 约束并关闭 `additionalProperties`。
5. 工具文档仍写 28 个 ChatAnki 工具，实际 embedded manifest 为 29 个；已修正。文档末尾“APKG 媒体只统计不导入”也与当前导入器不符，已改为当前媒体往返语义。

未发现 Rust 已实现但 skill schema 漏掉的 run/start/retemplate 字段；没有新增后端参数，也没有修改 transform 执行器。

## 有意保留的公共契约收紧

- Rust 为历史调用兼容，`maxCards` 是 `Option<i32>`、支持数字字符串并会对大值 clamp；Agent schema 继续要求 run/start 必传整数 `1..100`，避免依赖兼容回退。
- Rust 的 outputProtocol 归一化接受大小写/首尾空白，公开 schema 只发布四个 canonical 值：`auto|delimiter|json_object|json_schema`；其他公开输入被 enum 拒绝，后端仍有启动前拒绝兜底。
- Rust run 对未知 route 会回到自动路由；公开 schema 通过精确 enum 阻止该输入。analyze 后端自身也会拒绝未知 route。
- Rust run/start/analyze 未启用 `deny_unknown_fields`；公开 schema 使用 `additionalProperties: false` 防止 Agent 发明参数。transform/retemplate 的 Rust args 本身也启用了未知字段拒绝。

## 回归钉点

- run/start 完整字段集合、必填集合、outputProtocol 非法值、contentFormat 枚举。
- analyze 完整字段集合与有效 source。
- transform 完整字段集合、script/ops 互斥、selection 互斥、op 分支必填、apply expectedVersions。
- retemplate 完整字段集合与 `fill_missing_llm` Phase 2 CAS 契约。
- ChatAnki allowlist 与 embeddedTools 名称集合完全相等，并由显式 29 项 manifest 防止同增同删掩盖漂移。
