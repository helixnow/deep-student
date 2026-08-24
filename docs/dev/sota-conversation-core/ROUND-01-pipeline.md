# 第一轮补充：Chat V2 流水线

来源：[Chat V2 pipeline review](b35b36be-d67a-49b5-ae7a-708cf76ebd9c)

与 P0（三列未接线、Responses usage）重叠的不重复。

## 新增

1. **变体重放混拼所有变体。** 同 `message_id` 下各变体 CONTENT 被 `join("")`，不按 `active_variant_id` / `variants[].block_ids` 过滤。切换活跃变体也不改重放字节。
2. **workspace 注入只活在内存。** 父会话 coordinator 把 workspace 消息当 user 注入；落成 `workspace_injection` 块后，`history.rs` 不认这类块。下一轮 LLM 视角里注入消失。子代理本身用独立 session，不污染父前缀。
3. **分支复制重生成 block_id。** 接线 V20260806 时必须把三列一起拷；只读 `MessageBlock` 再写会静默丢列。分支换 session_id 会丢掉源会话的 OpenAI cache 热分区，可考虑 `prompt_cache_key = branchedFrom.sessionId`。
4. **续写/中断**额外丢掉内存里的 round_text / reasoning item。三列落地后会大幅改善。
5. **FIFO 默认 32K 比 compaction 先动手**，头删滚动会抢在正确的 tail 锚定压缩之前把前缀清零。
6. 变体共 `prompt_cache_key` 是对的（同前缀、尾部分叉）。缺口仍是 API-key 路径不发 key。
