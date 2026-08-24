# 第一轮补充：前缀断裂路径总表

来源：[Prompt cache prefix audit](ddb6d831-cacf-4899-9b32-54af663b45ab)

与 `ROUND-01-cache-prefix.md` 重叠的部分不重复。本文件只收新增分叉。

## 新增 live ↔ 重放分叉

| 数据 | live | 下一轮重放 |
| --- | --- | --- |
| 检索工具输出 | `sanitize_retrieval_output_for_llm` 脱敏 | 全量 `tool_output` |
| Gemini/Anthropic `thought_signature` | 附在 assistant | `None` |
| DeepSeek 空 `reasoning_content` | 保留空串作 merge 边界 | 只拼非空 thinking，用 `\n` join |
| Responses reasoning item | metadata 回放 | **未持久化** |
| 连续 user 合并 | 有瞬态技能时跳过合并 | 无技能时合并 → 技能开关会重排历史 |

## 其它

- system 还有旁路：`append_injection_to_system_message`（图谱预取、无工具降级检索）会改 system 尾部。
- 本报告仍把 G6 当有效排序；以 [Tools and cache impact](d3ab2581-4092-434f-b965-925e046e6dee) 为准：排序键取错，是空操作。
- microcompact（K=3 user 轮）与 FIFO 裁剪一旦滚动，命中区钉在改写点之前。属有意取舍，需用命中率量化后再改 K。
