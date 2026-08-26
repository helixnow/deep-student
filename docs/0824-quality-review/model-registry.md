# Deep Student 0824 模型目录 / 内置供应商质量评审

对比范围：`v0.9.44`（`1cf6cabc`）→ `origin/cursor/0824-cde6`（`2d41ea8b`）。评审对象只包括两版真实 diff、目标树中的目录消费链及与新增型号直接相关的官方文档。

## 裁决

这轮不是简单堆型号，目录消费和内置供应商接线有实质改善：

- 能力推断开始区分 `registry`、规则和兜底来源，注册表确认的 32K/64K 小窗口不再被启发式错误抬到 100K 以上。
- 新增 Anthropic 内置供应商后，官方地址、原生 Messages 协议、Anthropic adapter、四个当前公开型号及各自 thinking 代际能够连成完整链路。
- 本轮写入的五个能力目录型号和新增的 Gemini 内置型号都能在厂商官方文档中核实；`claude-haiku-5` 没有进入真实目录。

但整体不能判为无条件 PASS。**“防虚构”修正把真实但限量开放的 `claude-mythos-5` 当成虚构家族，从适配器中删除，造成相对 v0.9.44 的真实回归；同时来源字段仍只是少数条目的注释，尚未成为内置目录准入门槛。** 因此本轮是“目录能力净改善，真实性治理仍需整改”。

## 真实增量与型号真实性

`scripts/model-capability-registry.json` 从 120 条记录、117 个唯一 `model_id` 变为 123 条记录、120 个唯一 `model_id`：

- 新增 `claude-opus-5`、`claude-haiku-4-5`、`gemini-3.1-flash-lite`、`gemini-3.5-flash-lite`、`MiniMax-M2`。
- 删除 `hunyuan-2.0-think`、`hunyuan-2.0-instruct` 两条没有 `source_url` / `verified_at` 的记录。

五个新增 ID 均不是虚构：

- Anthropic 官方模型总览列出 `claude-opus-5` 和 `claude-haiku-4-5`，并确认 1M/128K、200K/64K 上限；代码中的 Haiku 日期版 ID、来源和核验日期位于 `scripts/model-capability-registry.json:837-863`。
- Google 官方模型页列出 `gemini-3.1-flash-lite`、`gemini-3.5-flash-lite`，其 1,048,576 输入、65,536 输出及多模态能力与 `scripts/model-capability-registry.json:947-1019` 一致。
- MiniMax 官方 API Overview 列出 `MiniMax-M2` 和 204,800 总上下文，代码记录位于 `scripts/model-capability-registry.json` 的 MiniMax 分组。

内置目录的产品增量是：

- `src-tauri/src/llm_manager/builtin_vendors.rs:195-205` 新增 `builtin-anthropic`。
- `src-tauri/src/llm_manager/builtin_vendors.rs:923-970` 新增 Opus 5、Sonnet 5、Fable 5、Haiku 4.5 四个 Anthropic profile。Anthropic 官方当前公开阵容正是这四个，型号本身可信。
- `scripts/gemini-model-registry.json:41-53` 新增 `gemini-3.5-flash-lite`，并将两个 Flash-Lite 的默认 effort 统一为 `minimal`。

所以，**目标树没有把 `claude-haiku-5` 或其他无法核实的新增 ID 下发给普通用户。** `builtin_catalog_has_no_fabricated_claude_haiku_5`（`builtin_vendors.rs:1681-1692`）对 Haiku 5 的负向断言也是正确的。

## 目录治理确实变好的部分

### 1. 能力值开始有明确优先级

`src/utils/apiCapabilityEngine.ts:697-722` 将上下文窗口优先级明确为“注册表确认值 > 规则 > 默认”，并返回 `contextWindowSource`；`src/utils/modelCapabilities.ts:333-370` 只在来源为 `default` 时才使用 `maxOutputTokens × 4` 的启发式。相较 v0.9.44 用“是否大于 100K”猜测有没有命中，这修复了已确认小窗口被放大的实质问题。

新增测试覆盖 registry/rule/default 三种来源，以及 Qwen 32K、GLM 64K 的直通。这里的测试验证的是消费语义，不只是查 JSON 是否含某个字符串，质量较好。

### 2. Anthropic 内置供应商接线完整

`builtin-anthropic` 使用 `https://api.anthropic.com/v1`，转换后协议为 `anthropic_messages`；四个 profile 使用 `anthropic` adapter，并分别得到 1M 或 200K context（`builtin_vendors.rs:1076-1169,1353-1361`）。

前端协议解析也从字符串包含升级为精确 hostname：`src/utils/providerProtocolRegistry.ts:35-63,81-97` 只把 `api.anthropic.com` 和 `generativelanguage.googleapis.com` 识别为官方原生端点，路径夹带域名和伪造子域不会命中；`modelConverters.ts:62-102,128-160` 保证错误的 `providerType` 不会再把官方端点钳回 OpenAI Chat。相应测试覆盖了官方 host、代理路径和伪造子域。

### 3. 展示目录更可读

`src/features/settings/components/modelFamily.ts:39-89` 补齐 Gemini 3、Llama 4、Grok、Magistral、MiniMax、ERNIE 分组，降低新型号全部落入 Other 的概率。它改善的是展示分组，不应被当成型号存在性证明；当前代码没有混淆二者。

## 主要问题

### P1：防虚构误杀真实的 Mythos 5

v0.9.44 的 Anthropic adapter 将 `mythos` 识别为 adaptive、always-on thinking 家族。本轮 `caa2d6c4` 以“reject fabricated model families”为由删除该分支；目标树 `src-tauri/src/llm_manager/adapters/anthropic.rs:64-65,107-142` 已不再识别 `mythos`。

这与官方事实冲突。Anthropic 的 [Fable 5 / Mythos 5 官方说明](https://platform.claude.com/docs/en/models/fable-5/introducing-claude-fable-5-and-claude-mythos-5) 明确给出 API ID `claude-mythos-5`，自 2026-06-09 起通过 Project Glasswing 限量开放，并说明它与 Fable 5 一样只接受 always-on adaptive thinking。

不把 Mythos 5放入大众内置目录是合理的，因为普通账号不可用；把它从自定义型号适配能力中删除则不合理。目标树会将其判为 `Unsupported`，随后走 `apply_manual_generation`（`anthropic.rs:391-412`）；启用 thinking 时会发送 `thinking.type="enabled"`（`:300-361`），而官方要求 adaptive，获批用户会收到 400。这个回归范围有限，但是真实存在，且正是“用缺少目录记录推导型号不存在”的反例。

### P1：来源字段尚未成为准入规则

来源覆盖有改善，但幅度有限：

- v0.9.44 为 120 条记录中的 16 条提供 `source_url` + `verified_at`。
- 2d41ea8b 为 123 条中的 20 条提供，仍有 109 条标为 `confirmed`，其中 89 条没有这两个来源字段。
- 本轮五条新增能力记录中，四条带来源；后来补入的 `claude-opus-5` 没有。Anthropic 的 11 条能力记录里只有 Haiku 4.5 带来源。

这使 `scripts/model-capability-registry.json:4` 的“均核验官方文档”和 `builtin_vendors.rs:924,1646-1647` 的“官方已核验”主要依赖提交说明及人工信任。现有测试只断言硬编码 ID、窗口和布尔值，未断言 `status=confirmed` 必须有官方来源，也不会校验来源页面是否列出该 ID。

更关键的是，这些元数据当前不参与裁决：

- 前端 `src/utils/modelCapabilityRegistry.ts:83-143` 只按 ID、别名和 provider scope 评分，不按 `status` 过滤。
- 后端 `src-tauri/src/llm_manager/mod.rs:47-66` 的反序列化结构甚至不读取 `status`、`source_url`、`verified_at`，`:3586-3624` 会直接消费命中的能力值。

因此 `confirmed`、`inferred`、`deprecated` 在运行时没有信任等级差异；来源字段目前是文档，不是防虚构机制。

### P2：目录仍有多个事实源，已经出现时间戳漂移

当前至少同时维护：

1. `scripts/model-capability-registry.json`：能力和参数形态；
2. `src-tauri/src/llm_manager/builtin_vendors.rs`：绝大多数内置供应商、模型、默认参数；
3. `scripts/gemini-model-registry.json`：Gemini 的独立内置目录；
4. `apiCapabilityEngine.ts` 的正则规则和 `builtin_vendors.rs:1313-1364` 的窗口硬编码。

Anthropic 四个型号因此在 capability JSON、Rust 内置数组、Claude 代际解析和窗口函数中重复出现。Gemini 3.5 Flash-Lite 同时写入 capability JSON 与 Gemini 内置 JSON。后者新增了 2026-07 型号，却仍保留 `updated_at: "2026-07-08"`（`scripts/gemini-model-registry.json:1-4`），已经说明人工同步会漂移。

`deepseek_context_window` 这个函数还承载了 Claude、Gemini 之外多家模型的窗口（`builtin_vendors.rs:1313-1364`），命名与职责不符，也让后来维护者很难发现它是另一份目录事实源。

## 优化顺序

1. **先修 Mythos 回归。** 保持它不进入默认内置目录，但恢复 `claude-mythos-5` 的 adaptive + always-on 适配和回归测试；目录中应标记为 `restricted`，不能标成虚构。
2. **建立一个可执行的目录准入契约。** 至少要求所有 `builtin` 或 `status=confirmed` 条目具备官方 `source_url`、`verified_at`、可用范围（public/restricted/preview）和生命周期；CI 校验 scoped ID 唯一、内置模型必须映射到一条可公开使用的 confirmed 记录。
3. **收敛事实源。** 将供应商、型号、能力、默认参数和展示元数据放入同一规范化目录，再生成或加载 Rust/TypeScript 结构；协议 adapter 保留行为代码，但不再重复声明型号身份和窗口。
4. **把状态变成运行时语义。** `deprecated` 不应与 `confirmed` 同权命中，`inferred` 应允许能力兜底但不能自动晋升为内置型号；解析失败也不应静默回退为空目录。
5. **复用现有动态发现作为校验。** `vendorModelService.ts` 已能读取 OpenAI-compatible、Gemini、Anthropic 的模型列表；有凭据时可用返回列表标记静态条目的当前可见性，静态目录只承担离线默认和能力补充，不把一次人工录入永久当成可用事实。

最终判断：**相对 v0.9.44，目录消费正确性和官方供应商可用性明显提升，新增公开型号本身可信；但“防虚构”仍是零散 denylist 与人工注释，不是系统性治理，并且已经误伤真实的限量型号。修复 Mythos 回归并让来源/状态成为机器可执行的准入条件后，才适合把这一块判为稳定 PASS。**
