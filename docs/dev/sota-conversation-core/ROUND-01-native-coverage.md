# 第一轮补充：官方 Responses 覆盖度（2026-08-23 实时文档）

来源：[Responses native features](b0ca75ca-0edf-4ca5-81ad-efcabefe32d5)

与既有判断一致：内部 CC → Responses 转换；`store:false` + 全量重放是和 DeepSeek 无状态的公约数。

## 新事实

1. **DeepSeek V4-Pro 官方已支持 Responses**（今日文档列出 flash / pro / flash-vision-exp）。
   本地注册表仍写「Pro 正式版后再开放」，测试还断言 **即使显式选 Responses 也强制回落 CC**。
   这与「默认路径缺门控会把 pro 误送 Responses」是同一扇门的两侧：门控函数过期，默认路径又绕过它。
2. OpenAI `include[]` 只主动用了 `reasoning.encrypted_content`；其余 7 个值未用。
3. `prompt_cache_retention: 24h` / GPT-5.6+ `prompt_cache_options` + `prompt_cache_breakpoint` 未用。
4. `background` / hosted MCP / computer / file_search / code_interpreter 明确可不做（桌面 + 本地 MCP/RAG 已覆盖）。

## 未决分歧（下一轮必须核对）

[System prompt stability](9859559e-9c33-4fde-a58e-16d7910cebe7) 认为 Anthropic **顶层** `cache_control` 不是合法参数、转换时还剥掉了块级标记，缓存实际未生效。

本报告认为 2026 官方已有「顶层 automatic caching」，实现与最新语义吻合。

落地前必须用当前 Anthropic 文档裁定：顶层 automatic 是否存在；若存在，块级断点是否仍被剥掉。
