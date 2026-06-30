# 代理 1 —— 对话引擎与 AI 能力扩展

> 先读 [README.md](./README.md) 总览,遵守全局规则;状态文档:`docs/6.12/status/agent-1-status.md`。
> 本组是合并组(原"对话引擎" + "AI 能力扩展层"),体量最大,优先保证审阅深度,优化按风险从低到高推进。

## 1. 负责域

Chat V2 对话全链路(后端 Pipeline ↔ 前端界面)+ 所有"给 AI 接能力"的扩展层:
模型供应商、技能系统、MCP、联网搜索/深度调研、智能记忆、语音输入输出。

## 2. 模块清单

### 后端(src-tauri/src)
| 模块 | 路径 | 要点 |
|------|------|------|
| Chat V2 引擎 | `chat_v2/`(pipeline、handlers、tools、adapters、workspace、migration) | 流水线、工具执行器、审批管理(approval_manager/scope)、prompt_builder、会话/资源仓储 repo、变体对比 variant_context、vfs_resolver |
| LLM 管理 | `llm_manager/`、`providers/` | 9 家供应商适配、模型能力检测、OpenAI 兼容接口 |
| 推理与注入策略 | `reasoning_policy.rs`、`injection_budget.rs` | 思维链策略、上下文注入预算 |
| 用量追踪 | `llm_usage/` | Token 统计 |
| MCP 协议 | `mcp/` | 客户端/服务管理、工具调用 |
| 联网搜索与调研 | `tools/`(web_search.rs) | 7 搜索引擎适配、深度调研 Agent 链路 |
| 智能记忆 | `memory/` | 事实提取、ADD/UPDATE/APPEND/DELETE 决策、画像汇总、标签升降权 |
| 语音 | `voice_input.rs`、`tts.rs` | ASR 输入、TTS 朗读 |
| 会话基础 | `session_manager.rs`、`persistent_message_queue.rs` | 会话生命周期、消息队列 |

### 前端(src)
| 模块 | 路径 | 要点 |
|------|------|------|
| Chat 特性全部 | `features/chat/`(core、components、pages、plugins、skills、tools、adapters、anki、context、queue、registry、resources、workspace、readiness) | Store/类型/注册表、消息块渲染插件、多 Tab、会话分支、引用面板、分组、技能选择 UI;先读 `features/chat/README.md` 与 `BLOCK_RENDERING_GUIDE.md` |
| MCP 前端 | `src/mcp/`、`src/mcp-debug/` | MCP 客户端与内置工具定义、调试界面 |
| 技能管理 UI | `features/skills-management/`、`components/skills-management/` | 技能开关/加载管理 |
| 语音输入 UI | `features/voice-input/`、`src/voice-input/` | 录音浮层、实时转写 |
| 提示词套件 | `src/promptkit/` | 提示词构建 |
| 对话相关 stores/hooks | `stores/` 中会话相关、`hooks/useChatV2Stats.ts`、`useEventRegistry.ts` 等 | 状态与事件 |

## 3. 不归属本组(别改)
- 向量化/索引/检索实现(`vfs/`)→ 代理 2(本组只经 `vfs_resolver` 消费)。
- 题库判分、制卡服务 → 代理 4/5(对话内触发制卡的入口在本组,服务实现不是)。
- `components/ui` 基础组件 → 代理 7。

## 4. 审阅重点清单
- [ ] Pipeline 全链路:消息构建 → 模型调用 → 流式输出 → 工具调用 → 事件落库,有无状态机漏洞(中断/重试/分支/变体对比时)。
- [ ] 工具执行器与审批机制:权限校验是否完备,审批 scope 有无绕过路径。
- [ ] 多模型并行(变体对比)与多 Tab 并发:竞态、Token 计费重复、事件串扰。
- [ ] 流式渲染性能:大消息/长会话的渲染抖动、不必要的全量重渲染。
- [ ] 9 家供应商适配的一致性:错误处理、超时、重试、流式协议差异。
- [ ] 技能三级加载(内置→全局→项目)的覆盖规则与 Token 节省是否真实生效。
- [ ] MCP 连接生命周期:断连重连、工具 schema 校验、错误透传。
- [ ] 7 搜索引擎适配的降级与配额处理;深度调研长链路的中断恢复。
- [ ] 记忆系统:提取→比对→决策→写入的幂等性,隐私模式是否真正阻断外呼。
- [ ] API Key 等敏感信息在日志/事件/错误信息中是否泄漏。
- [ ] 前端 chat store 的状态膨胀与内存泄漏(长会话、多 Tab 切换)。

## 5. 跨组接口
- 经 `chat_v2/vfs_resolver.rs` 调用代理 2 的检索:只消费接口,需求变更登记到状态文档「跨组问题」。
- 对话内"制卡/出题"指令最终调用代理 4/5 的服务:保持调用契约不变。

## 6. 验证
按 README 3.4 执行;本组重点:`cargo test chat_v2`、`npm test -- chat`、
手动冒烟 `npm run dev:test`(chat-test-runner 自动用例)。
