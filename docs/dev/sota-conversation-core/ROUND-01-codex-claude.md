# 第二轮：Claude Code / Codex 交叉验证

来源：[Claude Code Codex compare](4d4caf7e-9e8e-4dc7-aefe-26d49eff2411)

## 对既有材料的修正

1. **Anthropic 顶层 `cache_control` 合法。** 2026 Automatic caching：顶层一个标记，断点跟会话末尾走。
   `providers/mod.rs:1993` 与官方示例一致。块级 `cache_control` 在转 Anthropic 时被剥掉，
   对 OpenAI/DeepSeek 也是死字段。DESIGN 的「纯显式 4 断点」改为：
   **保留顶层 auto + 只补 tools 尾、system 尾两个保险断点。**
2. **`store:true` + `previous_response_id` 再降优先级。** Codex 官方刻意走无状态全量重放 +
   稳定 key + encrypted reasoning。本产品跟这条，不跟 OpenCode 链式。
3. Gemini `cachedContentTokenCount` **非流式已抬**，只补流式。
4. `prompt_cache_retention: 24h` 只适用于旧代模型；GPT-5.6+ 是 `prompt_cache_options.ttl`（30m）。

## 新缺口

- Codex 至少 12 个调用面 `session_id=None`，cache key 回落随机 UUID（批改/OCR/翻译等共享长 system 时打散分片）。
- GPT-5.6+ 顶层 `instructions` **不能**打 `prompt_cache_breakpoint`。稳定指令应放 developer `input_text`。
- `cache_write_tokens` 未解析，看不出「反复写缓存却不复用」（技能重插的典型症状）。
