# 方案冻结（第一轮全部切片完成后）

实现按供应商分流，**不改 `store:false` 隐私默认**。跟 Codex 无状态路线，不跟 OpenCode 链式。

## 已交叉成立的结论

1. 适配器是高质量 CC→Responses 转换层，不是原生会话客户端。DeepSeek 无状态，链式 id / cache key 不要发给它。
2. 观测断裂：Responses `input_tokens_details.cached_tokens`（及 `cache_write_tokens`）三处不读；
   Anthropic 流式终态覆盖丢掉 cache；Gemini 流式未抬字段；`token_source` 恒为 `api`。
3. 跨轮前缀未成立：`V20260806` 三列零读写；system 动态后缀在全部历史前面；
   `available_skills excludeLoaded` 从第 0 字节清缓存；G6 排序空操作；技能瞬态消息跨轮漂移。
4. 同轮工具循环靠内存前缀连续，这层不要破坏。

## 落地顺序（独立实现分支）

**P0 观测与 key（先让命中可见）**

1. 两处 usage 解析补 `input_tokens_details.cached_tokens` + `cache_write_tokens` + `output_tokens_details.reasoning_tokens`。
2. Anthropic 字段级合并；Gemini 流式抬 `cachedContentTokenCount`。
3. OpenAI CC 按端点发 `stream_options.include_usage`（DeepSeek 不发）。
4. 真实写入 `token_source` / adapter。
5. OpenAI/Codex 稳定 `prompt_cache_key`；禁止 `Uuid::new_v4()`；批量任务用 caller 级稳定串。DeepSeek 不写。
6. DeepSeek 默认协议跑模型门控；按 2026-08-23 文档放开 v4-pro / vision-exp。

**P1 前缀（命中可见后再改形状）**

7. 接线 V20260806（含变体过滤、workspace 注入回放、分支复制带列）。
8. `available_skills` 不再 `excludeLoaded`；技能锚定或驻留 tool result。
9. tools 排序取 `function.name`；改 append-only；多变体写 `custom_tools`。
10. turn-volatile 迁出 system；user 发送/回放字节一致。

**P2**

11. Anthropic：auto + tools/system 尾保险断点。
12. GPT-5.6+：稳定指令改 developer `input_text` + `prompt_cache_breakpoint`。
13. DeepSeek `web_search_call` 原样回传。
14. 流式 `output_item.added` / `arguments.delta`（对齐 Codex 桥）。
