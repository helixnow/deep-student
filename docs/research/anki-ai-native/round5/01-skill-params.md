# Round 5 #1：run/start 生成调优参数补齐（skill schema ↔ Rust args 对齐）

## 背景

Round 4 #1 在 Rust 执行器（`src-tauri/src/chat_v2/tools/chatanki_executor.rs`）为
`chatanki_run` / `chatanki_start` 接入了一组生成调优参数（`ChatAnkiGenerationTuning`），
但 `src/features/chat/skills/builtin/index.ts` 的 embeddedTools JSON schema 完全没有暴露，
Agent 侧不可见也不可调用（`round4/00-round4-status.md` 已标记该缺口）。本轮把 Agent
可调用面补齐：只改 TS schema / skill 文案 / 文档 / 契约测试，**不动 Rust 执行器逻辑**。

## Rust 真源与 TS schema 对照

对照 `ChatAnkiRunArgs`（L533）与 `ChatAnkiStartArgs`（L642），serde 为
`rename_all = "camelCase"` 且逐字段带 snake_case alias，因此 schema 一律用 camelCase：

| Rust 字段 | schema 名 | run | start | 类型/约束 | 后端语义 |
|---|---|---|---|---|---|
| `output_protocol` | `outputProtocol` | ✅ | ✅ | enum `auto\|delimiter\|json_object\|json_schema` | `normalize_output_protocol_arg`：`auto`/空 → None；三个合法值透传；**其余启动前直接报错**，不静默回退成 `delimiter`（那是 `resolve_output_protocol` 对 wire 值的兜底） |
| `visual_hint` | `visualHint` | ✅ | ❌ | string | 仅 VLM 路由生效；`render_visual_hint_data_block` 以数据分隔符包裹注入 VLM prompt（非指令）。start 固定纯文本路径，Rust 侧硬编码 `visual_hint: None` |
| `content_format` | `contentFormat` | ✅ | ✅ | enum `auto\|glossary\|prose`，default `auto` | `ChatAnkiContentFormat::glossary_override()`：auto → 启发式；glossary/prose → 强制 true/false |
| `enable_qa_pass` | `enableQaPass` | ✅ | ✅ | boolean | None=默认开启（`_qa_flags` 留痕），与 `StructuredOutputOptions` 语义一致 |
| `enable_fsrs_feedback` | `enableFsrsFeedback` | ✅ | ✅ | boolean | None=默认开启，FSRS 复习画像回流 |
| `max_images` | `maxImages` | ✅ | ❌ | integer `1..12` | `effective_max_images`：clamp 到 `1..=MAX_VLM_IMAGES(12)`；路由默认 light 6 / full 12。start 侧硬编码 `max_images: None` |
| `enable_preference_memory` | `enablePreferenceMemory` | ✅ | ✅ | boolean | `preference_memory_enabled()`：None=默认开启 |

`extraRequirements` 此前 schema 已有，本轮补进文档参数表（`docs/anki-agent-tools.md`
原 run 表缺失该行）。

## Schema 层决策

1. **enum 与后端接受集一字不差**（要求 4）：`outputProtocol` enum 为
   `['auto','delimiter','json_object','json_schema']`，与
   `normalize_output_protocol_arg` 的 match 分支同源；非法值由后端在
   `start_background_pipeline` 入口拒绝，schema 描述明确"不会静默回退"。
2. **run/start 均补 `additionalProperties: false`**：参数集现已与 Rust 结构体
   全量对齐，关闭 schema 可防止 Agent 把 `analyze` 的管线内自算参数
   （`temperature`/`segmentOverlapSize`/`maxOutputTokensOverride`/
   `pipelineDefaultMaxCards`）伪装成 run/start 旋钮传入。Rust 侧
   run/start 未加 `deny_unknown_fields`（兼容旧调用），schema 层收紧无运行时破坏。
3. **start 不虚构 VLM/路由参数**：`ChatAnkiStartArgs` 没有
   `route`/`resourceId(s)`/`visual_hint`/`max_images`，schema 保持一致。
4. **maxImages 声明 `1..12`**：与 clamp 窗口一致；越界值后端 clamp 而非报错，
   schema 边界让模型第一时间给出合法值。

## 基线测试修正

`tests/vitest/chat-v2/skills/chatAnkiRound4Contract.test.ts` 原断言
"route enum 在 run/start/analyze 三处一致"在基线上就是**失败**的：
`builtin-chatanki_start` schema 从未有过 `route`，Rust `ChatAnkiStartArgs`
也没有该字段，`docs/anki-agent-tools.md` 更是明确"start 不接受 route"。
本轮把该断言修正为与真源一致：run/analyze 两处 enum 相同，且显式断言
start **没有** `route` 属性。

## skill content 新增「生成调优参数」指南

新增独立章节（决策树之后），核心判别口径（要求 2）：

- `goal`：学习目标 + 卡型 + 粒度（"要做什么卡"）；
- `extraRequirements`：成品风格/语言/格式（"卡片长什么样"）；
- `visualHint`：VLM 视觉注意力引导（"看图看哪里"），仅 run + VLM 路由，数据非指令；
- `contentFormat`：材料体裁覆盖（"材料是什么体裁"），与 `analyze.routing.glossaryMode` 对应；
- `outputProtocol`：管线↔模型输出协议排障位，与卡片内容无关，默认 auto；
- 三个布尔开关默认开启，禁止 Agent 无用户明确要求自行关闭；
- `maxImages` 仅 run + VLM 路由，clamp 到 1~12。

## 契约测试（tests/vitest/chat-v2/skills/chatAnkiRound5SkillParams.test.ts，12 例）

- 工具清单：29 个 chatanki 工具的**显式清单 diff**（不写死会漂移的数字，
  增删工具必须显式改清单）；
- run/start `properties` 键集合分别与 `ChatAnkiRunArgs`/`ChatAnkiStartArgs`
  字段集精确相等（camelCase）；
- `outputProtocol` enum 与后端接受集一致 + "启动前拒绝"纪律写入描述；
- `contentFormat` enum/default、三个布尔开关类型与"默认 true"描述、
  `maxImages` 1..12 边界与路由默认、`visualHint` 的 VLM/数据边界；
- start 不得暴露 `route`/`resourceId(s)`/`visualHint`/`maxImages`；
- run/start `additionalProperties: false` + analyze 自算参数不得出现；
- required 集不变（调优旋钮全部可选）；
- skill content 含参数选用指南与 run/start 描述中的旋钮清单。

## 文档更新

`docs/anki-agent-tools.md`：run 参数表补 `extraRequirements` + 7 个调优参数行
（含 clamp/拒绝语义）；start 节明确"没有 visualHint/maxImages（Rust 无字段）"
并列出其余调优参数；补充 `additionalProperties: false` 与 snake_case alias 说明。

## 验证

- `npx vitest run tests/vitest/chat-v2/skills/`：除 `activeSkillToolAccess.test.ts`
  （基线即因测试环境 i18n LanguageDetector 加载失败，与本轮无关）外全部通过；
  Round4 + Round5 契约共 24 例通过。
- 未改任何 Rust 文件；schema 名与 Rust serde alias 逐一核对。

## 遗留

- `activeSkillToolAccess.test.ts` 的环境性加载失败需要单独修（i18n 初始化在
  vitest 环境缺 LanguageDetector 依赖链），不属于本轮文件所有权。
- Rust run/start 未开 `deny_unknown_fields`；schema 层已经拦截未知旋钮，
  后端是否收紧留给 Rust 侧轮次决策。
