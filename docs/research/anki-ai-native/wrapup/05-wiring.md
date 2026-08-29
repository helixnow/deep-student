# 收尾 #5：模块接线审计

> 范围：只核对现有模块是否进入真实生产路径；不重写 executor，不新增管线。

## 接线状态

| 项目 | 代码事实 | 本轮结论 |
|---|---|---|
| Image Occlusion | `VlmFull` 在直接图片 ref 存在时，把 `[IMAGE_DESC]` 经 `propose_boxes_from_image_desc` 和校验转成内部 draft marker；流式生成会从 prompt 剥离 marker，并把 `_occlusion` 与 `image-occlusion` tag 合并到该分段首张成功卡 | **最小接线**。无图片、无有效描述、校验或解析失败均降级普通卡；PDF 页图、真实图像 grounding、编辑器及 APKG/AnkiConnect 可复习遮挡转换仍未接 |
| Preference memory | retrieve 从持久化 settings key `chatanki_preference_memory_store` 读取 `PreferenceStore`；全仓库没有生产写入该 key 的路径，`extract_preferences` / `consolidate` 仅由测试调用 | **读取侧已接，写入侧未接**。全新安装 key 不存在，实际注入为 no-op；不得宣称会自动学习偏好 |
| Anki model routing | streaming 生成消费 `Generator`；critic 通过 `resolve_anki_role_decision` 与 `call_anki_routed_raw_prompt` 消费 `Critic`，路由或配置失效时回退 model2 | **不只用于 Generator**。Generator / Critic 已接；Planner / Vlm 角色目前没有生产消费者 |
| FingerprintTracker registry | 主调度完成、取消、删除、按文档导出释放 tracker；resume 查询失败、无剩余任务，以及手动单任务重试达到文档终态也释放；暂停时刻意保留供 resume | **已覆盖已知终态**。未发现仍可复现的按 `document_id` 无界残留路径 |
| CardForge 残留 | 旧 `AnkiToolExecutor`、`anki_tool_call` 前端桥和 adapter 已删除；旧 CardAgent 结果回调又于收尾续作 #6 从 handler、导出、注册和权限中成组删除 | **死回调已清除**。`CardAgent.startGeneration` 仍由划词制卡消费，导出校验仍由聊天导出 UI 消费，不能把整个 `cardforge` 模块视为死代码；headless 历史工具名仅作 fail-closed 隔离 |

## Image Occlusion 数据边界

```text
VlmFull + direct image ref
  → [IMAGE_DESC: ...]
  → propose_boxes_from_image_desc
  → validate_spec
  → [ANKI_OCCLUSION_DRAFT:{...}]
  → 文档分段
  → marker 从生成 prompt 剥离
  → 分段首张成功卡 extra_fields["_occlusion"] + tag
```

网格框只是依据文字标签生成的可编辑启发式草稿，不是图上实体定位结果。当前链路不改写
front/back/text，也不会创建原生 Image Occlusion note type。

## Preference memory 的准确口径

settings 本身是持久化存储，并非每次构造一个临时空 store；但当前没有生产写入者。
只有历史版本或外部迁移预先写入合法 `PreferenceStore` JSON 时，retrieve 才会注入内容。

## CardForge 删除边界

收尾续作 #6 复核了生产源码和测试引用后，已删除无内部消费者、无测试依赖的旧结果
回调命令，并添加注册面源码守卫。保留项及证据见 `wrapup/16-dead-compat.md`：
划词制卡仍消费 `CardAgent.startGeneration`，聊天导出仍消费 `validateCardsForExport`；
`anki_generate_cards` 只留在 headless 禁止清单中，并有测试保证不会进入 schema 或白名单。
