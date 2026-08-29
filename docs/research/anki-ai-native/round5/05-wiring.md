# Round 5 #5：接线收尾审计

> 范围：只核对已有模块是否进入真实生产路径；不重写 executor，不新增管线。

## 接线状态

| 项目 | 审计前事实 | 本轮处置 | 当前状态 |
| --- | --- | --- | --- |
| Image Occlusion | `anki_image_occlusion` 仅被 `lib.rs` 注册和单测调用；VlmFull 产出的 `[IMAGE_DESC]` 不消费 | VlmFull 在存在直接图片 ref 时调用 `build_occlusion_draft_marker`（内部执行 propose → validate）；Streaming 层从分段 marker 取字段，合并到首张成功卡的 `_occlusion` 与 `image-occlusion` tag；marker 不进入模型 prompt | **最小接线**。失败降级普通卡；PDF 页图因无稳定逐页 ref 暂不接；网格坐标只是可编辑草稿，不是 grounding；前端 overlay 仍未接预览 |
| Preference memory | retrieve 从 settings key `chatanki_preference_memory_store` 读取并反序列化持久化 store，但全仓库没有生产 `save_setting` 写入该 key；`extract_preferences`/`consolidate` 只有单测调用 | 修正代码注释与模块文档，明确全新安装 store 为空、注入 no-op，不再声称会自动学习 | **读取侧接线 / 写入侧未接** |
| Sidekick routing | Generator 在 streaming 路径消费路由；Critic 通过 `resolve_anki_role_decision` / `call_anki_routed_raw_prompt` 消费路由，配置失效时回退 model2 | 本轮不扩展路由 | **并非“只用于 Generator”**：Generator / Critic 已接；Planner / Vlm 角色仍未消费 |
| FingerprintTracker registry | 主调度完成、取消、删除、按文档导出会释放；暂停刻意保留供 resume | 补 resume 查询失败、resume 无剩余任务、手动单任务重试达到文档终态三处释放 | **已覆盖已知终态**；暂停且仍有待处理任务继续保留符合设计 |
| CardForge 残留 | 旧 `AnkiToolExecutor` / `anki_tool_call` / adapter 已删；`chat_v2_anki_cards_result` handler 仍注册，但 `src` 无调用方；headless 的 `anki_generate_cards` 仅为历史调用防挂死拦截 | 去掉前端注释对旧命令的现役叙述；保留 handler 并在此诚实登记（本轮允许文件范围外，不冒险删除外部可调用命令） | **核心死链已删，仍有一个无内部消费者的兼容命令** |

## Image Occlusion 数据边界

当前链路是：

```text
VlmFull + direct image ref
  → [IMAGE_DESC: ...]
  → propose_boxes_from_image_desc
  → validate_spec
  → [ANKI_OCCLUSION_DRAFT:{...}]（后端内部 marker）
  → 文档分段
  → marker 从生成 prompt 剥离
  → 分段首张成功入库卡 extra_fields["_occlusion"] + tag
```

以下情况全部返回普通卡，不阻断生成：没有直接图片 ref、VLM 没有有效
`IMAGE_DESC`、proposal 为空、spec 校验失败、marker 解析失败。当前不会改写
front/back/text，不会把候选 Cloze 字段和图片媒体接入 APKG/AnkiConnect 导出，
也不会把启发式网格宣传成真实图上坐标。

## Preference memory 的诚实口径

settings 是持久化存储，不是“每次 new 一个空内存 store”；但当前没有生产写入者，
所以全新安装里该 key 不存在，实际效果与空 store 相同。只有历史版本或外部迁移
预先写入合法 `PreferenceStore` JSON 时，retrieve 才会注入内容。

## CardForge 后续删除候选

`chat_v2_anki_cards_result` 当前仍在 `block_actions.rs` 定义、`handlers/mod.rs`
重导出并由 `lib.rs` 注册。全仓库前端无 invoke 调用；若确认不再兼容旧客户端，
后续应在同一提交中删除 handler、重导出、Tauri 注册和相关 request 类型/测试。
本轮只登记，不把“仍注册”伪装成“仍被生产消费”。
