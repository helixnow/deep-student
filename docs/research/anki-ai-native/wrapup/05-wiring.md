# 收尾 #5：模块接线审计

> 范围：只核对现有模块是否进入真实生产路径；不重写 executor，不新增管线。

## 接线状态

| 项目 | 代码事实 | 本轮结论 |
|---|---|---|
| Image Occlusion | `VlmFull` 在直接图片 ref 存在时，把 `[IMAGE_DESC]` 经 `propose_boxes_from_image_desc` 和校验转成内部 draft marker；流式生成会从 prompt 剥离 marker，并把 `_occlusion` 与 `image-occlusion` tag 合并到该分段首张成功卡 | **最小接线**。无图片、无有效描述、校验或解析失败均降级普通卡；PDF 页图、真实图像 grounding、前端预览/编辑和原生 Anki Image Occlusion note type 仍未接 |
| Preference memory | retrieve 从持久化 settings key `chatanki_preference_memory_store` 读取 `PreferenceStore`；全仓库没有生产写入该 key 的路径，`extract_preferences` / `consolidate` 仅由测试调用 | **读取侧已接，写入侧未接**。全新安装 key 不存在，实际注入为 no-op；不得宣称会自动学习偏好 |
| Anki model routing | streaming 生成消费 `Generator`；critic 通过 `resolve_anki_role_decision` 与 `call_anki_routed_raw_prompt` 消费 `Critic`，路由或配置失效时回退 model2 | **不只用于 Generator**。Generator / Critic 已接；Planner / Vlm 角色目前没有生产消费者 |
| FingerprintTracker registry | 主调度完成、取消、删除、按文档导出释放 tracker；resume 查询失败、无剩余任务，以及手动单任务重试达到文档终态也释放；暂停时刻意保留供 resume | **已覆盖已知终态**。未发现仍可复现的按 `document_id` 无界残留路径 |
| CardForge 残留 | 旧 `AnkiToolExecutor`、`anki_tool_call` 前端桥和 adapter 已删除；`chat_v2_anki_cards_result` 仍定义、重导出、注册并列入权限，但当前 `src` 没有调用方 | **核心死链已删除，保留一个兼容命令**。它不是当前生产管线消费者；确认不兼容旧客户端后才应成组删除 handler、导出、注册、权限与相关类型/测试 |

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

`chat_v2_anki_cards_result` 可能仍被旧客户端从 Tauri command 边界调用，单凭仓库内无调用方
不足以证明可安全删除。因此本轮只记录其兼容状态，不把“仍注册”描述为“当前管线仍使用”。
