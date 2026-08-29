# 第一轮补充：前缀断裂（DeepSeek / system / 技能）

来源：
- [DeepSeek Responses audit](17351f7e-9a67-4fe0-9e97-41f31c61bab1)
- [System prompt stability](9859559e-9c33-4fde-a58e-16d7910cebe7)
- [Skill injection cache risk](5df53cf1-bd09-4c34-a36f-24e053aa04ba)

## 架构级（三份报告交叉成立）

「稳定前缀 / 动态后缀」只在 system **字符串内部**成立。system 是 input 第 0 位，动态后缀（检索、按当前 query 重排的 user_profile、待办、citation/context、canvas）每轮变化，等于把易变内容插在**全部历史前面**，历史缓存整段失效。

更致命的两处会从第 0 字节清缓存：

1. `<available_skills excludeLoaded=true>` 写在 `<system_instructions>` 里。`load_skills` 成功后目录缩水，下一轮 system 从头变。
2. 中途把技能内嵌工具追加进 `tools`。Anthropic/OpenAI 都把 tools 算进前缀。

技能正文走尾部 transient user 消息方向对，但每轮删了再插会在旧插入点分叉；环内新技能还插到当前 user 之前。

## DeepSeek 特有

- 第三方托管（SiliconFlow）**没有**被误切 Responses。
- **默认协议路径缺模型门控**：`api_protocol=None` 时直接吃注册表 `default_protocol=openai_responses`，官方 `v4-pro` / v3 可能 404。前端通常会写显式协议，后端/headless/旧数据没有。
- `is_official_deepseek_config` 只看 provider_type，不校验 base_url（反代会被当官方）。
- `reasoning_effort` 被转成 `reasoning:{summary:auto,effort}`，DeepSeek 是否认这个形态未验证。
- `store:false` 无条件发给不支持 store 的端点（当前静默忽略）。
- web_search 缺键时默认开启。

## 发送 / 回放不一致

当前轮 user 带 `<user_query>` + `<injected_context>`（含 runtime_facts），落库只存原始 `user_content`。下一轮历史按另一套字节重建，公共前缀停在「上一轮 user 之前」。`V20260806` 没覆盖这里。

## Anthropic 缓存实际未生效

system 上的 `cache_control` 在转 Anthropic 时被压平丢掉；顶层 `cache_control` 不是 Messages API 合法参数。该路径等于没有 prompt caching。

## 其他抖动

- 多变体路径 tools **没有**字母序（G6 只覆盖单变体）。
- `web_search` 的 `engine.enum` 随可用性 TTL 回落会改 schema 字节。
- microcompact「最近 3 个 user 轮」每轮滚动，历史深处从全文变占位。
- user_profile 按当前问题 bigram 重排。
