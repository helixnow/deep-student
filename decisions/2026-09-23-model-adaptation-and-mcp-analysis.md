# 2026-09-23 deepstudent 模型适配重构 + MCP 握手问题 方案分析

> 触发：用户反馈两个问题：
> 1. **MCP 跑不通**：本地安装 MCP 后，应用无法与本地 MCP 握手，怀疑与沙箱环境隔离有关，建议"危险访问"放开沙箱。
> 2. **模型配置问题**：千问（Qwen）部分模型有"思考强度"参数，但前端没有暴露配置入口。
>
> 任务：参考 `E:\yysls\operit`（Operit-2026）的模型适配思路，评估能否重构 deepstudent；并排查 MCP 握手失败的根因。
>
> 按 RULES.txt 第 2、4 条：不直接改代码，先给方案选项由用户决策，决策记录到本地文件。

---

## 一、operit 的模型适配思路（参考对象）

仓库：`E:\yysls\operit`，Android Kotlin 项目。

**核心模式：经典继承 + 单一 Boolean `enableThinking` 信号 + 通用 `ModelParameter<*>` 逃生口。**

| 层 | 文件 | 作用 |
|---|---|---|
| 枚举 | `app/src/main/java/com/ai/assistance/operit/data/model/ModelConfigData.kt` | `ApiProviderType` 34 个枚举值（OPENAI/ALIYUN/MOONSHOT/DEEPSEEK/DOUBAO/NVIDIA/ZHIPU/SILICONFLOW/…），唯一的"provider 目录" |
| 接口 | `api/chat/llmprovider/AIService.kt` | `sendMessage(... enableThinking: Boolean ...)` —— 跨抽象边界的**唯一**思考信号 |
| 工厂 | `api/chat/llmprovider/AIServiceFactory.kt` | `when (providerType)` 分发到具体 Provider 子类 |
| 基类 | `api/chat/llmprovider/OpenAIProvider.kt` | `createRequestBodyInternal(...)` 构建标准 OpenAI JSON，**遍历 `modelParameters` 把每个 `ModelParameter` 按 `apiName → currentValue` 写入 JSON**（这是逃生口） |
| 子类 | `QwenAIProvider.kt` / `DeepseekProvider.kt` / `KimiProvider.kt` / `DoubaoAIProvider.kt` / `NvidiaAIProvider.kt` / `ClaudeProvider.kt` / `GeminiProvider.kt` | 覆盖 `createRequestBody(...)`，调基类后**按自己的方言**塞 `enable_thinking` / `thinking:{type:enabled}` / `thinking:{type,budget_tokens}` / `thinkingConfig:{includeThoughts}` / `chat_template_kwargs.enable_thinking` |
| 通用参数 | `data/model/ModelParameter.kt` + `StandardModelParameters.kt` | 用户可加任意 `apiName → value`（如 `reasoning_effort=high`、`budget_tokens=4096`），基类原样塞进请求体 |
| UI | `ui/features/chat/components/style/input/classic/ClassicChatSettingsBar.kt` | 聊天屏单一"思考模式"开关（不是按模型分） |

**关键观察：operit 没有声明式的"模型能力描述表"。** 它对每个 provider 硬编码子类；`reasoning_effort` 这种非通用参数靠用户手动加 `ModelParameter`，基类**盲目透传**到请求体。

---

## 二、deepstudent 现状（已探明）

### 2.1 模型适配架构（双层）

```
VendorConfig + ModelProfile
    │
    ▼
ApiConfig (runtime merged)
    │
    ▼
apply_runtime_reasoning_overrides(&mut ApiConfig, enable_thinking, reasoning_effort, thinking_budget)
    │
    ▼
LLMManager::apply_reasoning_config(body, config, enable_thinking)
    │
    ├─ request_adapter_for_config(config)   ← Tier B 厂商方言适配
    │     ADAPTER_REGISTRY: openai/general/siliconflow/nvidia/mimo/minimax/
    │                       deepseek/qwen/zhipu/doubao/moonshot/kimi/ernie/
    │                       anthropic/google/xai/mistral
    │
    ├─ adapter.apply_reasoning_config(body, ...)   ← Qwen/DeepSeek/… 各自塞参
    └─ adapter.apply_common_params(body, ...)
    │
    ▼
build_provider_adapter(config)   ← Tier A 传输协议适配
    OpenAIAdapter / OpenAIResponsesAdapter / AnthropicAdapter / GeminiAdapter
    │
    ▼
POST 到对应 endpoint
```

**关键文件：**

- `src-tauri/src/llm_manager/adapters/mod.rs` — `RequestAdapter` trait + 静态 `ADAPTER_REGISTRY`
- `src-tauri/src/llm_manager/adapters/qwen.rs` — Qwen 适配器（409 行）
- `src-tauri/src/llm_manager/builtin_vendors.rs` — 内置 vendor/model 目录（1821 行）
- `src-tauri/src/llm_manager/mod.rs` — `ApiConfig`/`ModelProfile` 结构、`apply_reasoning_config` 入口
- `src/utils/apiCapabilityEngine.ts` — 前端能力推断引擎（740 行）
- `src/utils/modelCapabilities.ts` — 前端能力 facade + 每模型默认参数
- `src/utils/deepseekReasoningControls.ts` — 前端"思考深度"控件状态机（606 行，虽然名字叫 deepseek 但是通用的）
- `src/features/settings/components/ShadApiEditModal.tsx` — 模型编辑对话框（2280 行）
- `src/features/chat/components/input-bar/InputBarV2.tsx` — 聊天输入栏思考开关

### 2.2 Qwen 现状（用户问题 2 核心）

**Rust 端 `QwenAdapter::apply_reasoning_config` 已经做了：**

```rust
// 强制思考模型：qwq / qwen3.7-max-preview / qwen3-*-thinking → 永远 enable_thinking=true
// 混合思考模型：qwen3.7-plus / qwen-plus / qwen-turbo / qwen3.5/3.6/3.7 → 跟用户开关
body.insert("enable_thinking", enable_thinking_value);

if is_dashscope && supports_preserve_thinking(model) {  // qwen3.6/3.7
    body.insert("preserve_thinking", enable_thinking && include_thoughts);
}
if let Some(budget) = config.thinking_budget {
    body.insert("thinking_budget", clamped_budget);
}

// DashScope / SiliconFlow：reasoning_effort 被 **删除**
if is_dashscope || is_siliconflow {
    body.remove("reasoning_effort");
}
```

**前端的缺口（用户痛点）：**

1. **`DeepSeekReasoningControlKind` 枚举没有 qwen 专用 kind** — Qwen 模型一律走 `toggle-only` 分支，UI 只显示"开/关"，**没有低/中/高"思考强度"下拉**（DeepSeek V4 有、GPT-5 有、Qwen 没有）。
2. **`apiCapabilityEngine.ts` 的 `supportsReasoningEffort` 不含 Qwen** — 与 Rust 端"删除 reasoning_effort"一致，但 DashScope 实际上**支持**通过 `thinking_budget` 大小表达"思考强度"，前端没暴露数字输入框以外的抽象。
3. **内置 Qwen 模型默认 `thinking_enabled=false`** — `builtin_vendors.rs` 只标 `is_reasoning=true`，不设默认 `enable_thinking`/`thinking_budget`；前端 `getModelDefaultParameters` 也只给 `qwq-32b` 系列设默认，**qwen3.7-max / qwen3.7-plus / qwen-plus 等商业模型默认 `{}`**，用户要手动开。
4. **`preserve_thinking` 很少被发送** — 依赖 `include_thoughts=true`，前端默认 false。
5. **aggregator 上的 Qwen 丢失方言** — OpenRouter/Together/one-api 等走 `GenericOpenAIAdapter`，`enable_thinking`/`thinking_budget` 不会被加；只有 SiliconFlow 做了家族分发。
6. **`is_forced_thinking_model` 列表与前端能力检测不完全同步** — 如 `qwen3-max-preview` 前端认为可思考，Rust 端没列强制思考。

**结论：deepstudent 的 Qwen 适配在 Rust 端已经相当完备，缺的是前端把"思考强度"这个概念暴露给用户。**

---

## 三、能否按 operit 思路重构 deepstudent？

**短答：不需要也不建议。** deepstudent 现有的"双层适配"已经比 operit 更结构化。

| 维度 | operit | deepstudent 现状 | 评价 |
|---|---|---|---|
| Provider 目录 | enum 34 个 | `ADAPTER_REGISTRY` + `builtin_vendors.rs` 内置目录 | deepstudent 更数据驱动 |
| 思考信号 | 单一 Boolean `enableThinking` | Boolean + `reasoning_effort` + `thinking_budget` + `include_thoughts` | deepstudent 表达力更强 |
| 方言适配 | 每 provider 一个子类硬编码 | 每 provider 一个 `RequestAdapter` impl | 模式本质相同，deepstudent 的 trait 更干净 |
| 逃生口 | `ModelParameter` 通用 key-value 透传 | 无显式逃生口（`extra_body` 字段未暴露给 UI） | **operit 唯一比 deepstudent 好的点** |
| UI 抽象 | 单一全局"思考模式"开关 | 按模型动态解析 `DeepSeekRuntimeReasoningControl` | deepstudent 更细粒度，但缺 Qwen kind |
| 能力推断 | 无（用户手动配） | `apiCapabilityEngine.ts` 740 行自动推断 | deepstudent 更智能 |

**operit 有而 deepstudent 缺的唯一有价值的东西：通用"自定义参数"逃生口**——用户在 UI 上加一行 `reasoning_effort=high` 或 `thinking_budget=8192`，基类就透传到请求体。deepstudent 目前的字段是硬编码的（`enable_thinking` / `reasoning_effort` / `thinking_budget` / `include_thoughts`），UI 没暴露的字段就没办法塞进请求体。

**建议采纳的局部改进（不是重构）：**

1. **前端补 Qwen 的"思考强度"控件**（问题 2 的直解）
   - 在 `DeepSeekReasoningControlKind` 新增 `'qwen-effort'` kind
   - 给 Qwen 混合思考模型（`qwen3.7-max` / `qwen3.7-plus` / `qwen-plus` / `qwen-turbo` / `qwen3.5/3.6/3.7` 非 thinking）暴露：
     - 开/关 toggle（已有）
     - `thinking_budget` 数字滑杆（已有但被埋在 AdvancedPanel）
     - 可选：三档预设（低=1024 / 中=4096 / 高=16384），映射到 `thinking_budget`
   - 前端 `apiCapabilityEngine.ts` 给 Qwen 家族加 `supportsThinkingBudget` 标记

2. **给内置 Qwen 模型补默认参数**（小问题顺手修）
   - `builtin_vendors.rs` 给 `qwen3.7-max` / `qwen3.7-plus` / `qwen-plus` / `qwq-plus` 设默认 `thinking_budget`
   - 或在前端 `getModelDefaultParameters` 加对应条目

3. **加"自定义额外参数"逃生口**（采纳 operit 的思路）
   - `ApiConfig` 加 `extra_body: Option<serde_json::Map<String, Value>>`
   - `RequestAdapter::apply_common_params` 末尾把 `extra_body` 合并进请求体
   - `ShadApiEditModal` 加"自定义参数"编辑器（key-value 列表）
   - 这样用户可以手动塞 `preserve_thinking=true` / `reasoning_effort=high` / 任何未来新参数

4. **aggregator 上的 Qwen 家族分发扩展**（可选）
   - `adapters/mod.rs` 的 `get_adapter` 现在只对 SiliconFlow 做家族分发
   - 可以扩展到 OpenRouter / Together 当 `model_adapter == "qwen"` 时也走 `QwenAdapter`

---

## 四、MCP 握手问题根因（用户问题 1）

### 4.1 关键事实（已探明）

**MCP 子进程并没有被沙箱隔离。** 用户怀疑"沙箱环境隔离"是误判。

| 事实 | 位置 |
|---|---|
| MCP stdio 用 `tokio::process::Command` 直接 spawn，**不走** `tauri_plugin_shell`，**不走** Seatbelt/bwrap/AppContainer | `src-tauri/src/mcp/global.rs:361-425` |
| "Unrestricted Host Shell" / `DangerFullAccess` **只影响聊天 local_shell 工具**，与 MCP 完全无关 | `src-tauri/src/chat_v2/types.rs:564` |
| 沙箱代码 (`shell_sandbox.rs`) 只在 `local_shell_execute` 用，MCP 不 import 它 | `src-tauri/src/chat_v2/tools/shell_sandbox.rs` |
| MCP 客户端是前端 `@modelcontextprotocol/sdk`，通过 `TauriStdioClientTransport` 调 `mcp_stdio_start` 命令 | `src/mcp/mcpService.ts:672`, `src/mcp/tauriStdioTransport.ts:161` |
| Rust 后端 `McpClient::initialize` 只被"测试连接"按钮用，聊天走的是前端 SDK | `src-tauri/src/cmd/mcp.rs:25-62` |

### 4.2 真正卡住握手的三道闸

**闸 1：批准配置门（`validate_stdio_start_against_entries`）**

`src-tauri/src/cmd/mcp.rs:453-536`：`mcp_stdio_start` 要求 `(command, args, env, cwd, framing)` **完全匹配** `mcp.tools.list` 里某个 enabled 的 stdio 条目，否则拒绝：

```
mcp_stdio_start rejected: executable, args, env, cwd, and framing must exactly match
an enabled MCP stdio server in the approved configuration (mcp.tools.list)
```

任何字段（包括 env 顺序、cwd 大小写、framing）不一致都会触发拒绝。

**闸 2：env_clear + 极简白名单**

`src-tauri/src/mcp/global.rs:404-409`：

```rust
cmd.env_clear();
for key in minimal_child_env_keys() {
    if let Some(value) = std::env::var_os(key) { cmd.env(key, value); }
}
```

Windows 白名单只有 17 个变量：`PATH/Path/PATHEXT/SystemRoot/SYSTEMROOT/WINDIR/COMSPEC/TEMP/TMP/USERPROFILE/APPDATA/LOCALAPPDATA/HOMEDRIVE/HOMEPATH/PROGRAMFILES/NUMBER_OF_PROCESSORS/OS`。

**被抹掉的关键变量**：`SYSTEMDRIVE`、`ProgramData`、`PUBLIC`、`PSModulePath`、`NODE_PATH`、`NPM_CONFIG_*`、`NVM_HOME`、`NVM_SYMLINK`、`VOLTA_HOME`、`FNM_DIR`、`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`。

后果：
- 通过 nvm-windows / fnm / volta 装的 Node，shim 依赖 `NVM_HOME` 等变量
- `npx` 首次运行需要 `HTTP_PROXY` 走公司代理下载包；env 被抹后**直接卡死或超时**
- `npm_config_cache` 被抹 → `npx` 每次重新下载 → 冷启动超过 SDK 默认 60s 超时

**闸 3：cwd 校验**

`src-tauri/src/cmd/mcp.rs:296-311`：`canonicalize_stdio_cwd` 要求 `fs::canonicalize` 成功且是目录。如果用户没填 cwd，fallback 是 deep-student 进程自己的 `current_dir()`，而不是用户期望的项目目录。MCP server 在错误的目录启动，可能在 `initialize` 阶段直接退出，表现为握手超时。

### 4.3 其他候选原因（按可能性排序）

4. **`\\?\` 扩展路径前缀** — 已在 `normalize_command_path` 处理，不太可能。
5. **framing 不匹配** — 默认 JSONL，部分 Windows MCP server 用 `Content-Length:`；代码有自动回退，但 CRLF/BOM/stderr 混入 stdout 仍可能卡住。可在编辑器强制 `content_length`。
6. **握手超时太短** — 前端 SDK 默认 60s，但 `npx` 首次下载 + 冷启动可能超。已被闸 2 放大。
7. **`mcp.tools.list` 里条目被 disabled** — 用户改了配置忘了重新 enable。
8. **Android/iOS 目标拦截** — stdio 不支持移动端，用户说"本地安装"应该是桌面端，排除。

### 4.4 排查清单（用户可立刻自查）

按顺序：

1. 打开应用设置 → MCP → 找到目标 server → 点"**测试连接**"，看 `mcp-test-progress` 事件流，定位卡在哪一步（`spawn_process` / `initialize` / `tools/list`）
2. 如果卡在 `spawn_process`：检查命令路径。把 `npx` 改成 `npx.cmd` 的绝对路径（如 `C:\Program Files\nodejs\npx.cmd`），或在 PATH 里能找到的完整路径
3. 如果卡在 `initialize`：
   - 查应用日志里有没有 `mcp_stdio_start rejected:` 前缀 → 闸 1 触发，对齐配置
   - 查日志里有没有 `Spawning MCP process: ...` 后面跟 `Failed to spawn` → 命令不存在或 cwd 无效
   - 查日志里有没有 `MCP stdout reader terminated` 早于 `initialize` 响应 → 子进程崩溃或 framing 错乱
4. 检查日志里 `Spawning MCP process: ... with N env vars` 的 N 是多少。如果 N 很小（<30），说明子进程只看到极简白名单 → 闸 2 触发
5. 在系统终端手动跑一遍同样的命令：`npx -y @modelcontextprotocol/server-filesystem C:\` 看是否能正常启动并打印 JSON-RPC。能跑说明是应用环境问题（闸 2），不能跑说明是 MCP server 本身问题

### 4.5 修复方案选项（按风险排序）

**方案 A：环境白名单扩充（低风险，推荐）**

在 `minimal_child_env_keys()` Windows 分支追加：

```
SYSTEMDRIVE, ProgramData, PUBLIC, PSModulePath,
NODE_PATH, NPM_CONFIG_PREFIX, NPM_CONFIG_CACHE,
NVM_HOME, NVM_SYMLINK, VOLTA_HOME, FNM_DIR,
HTTP_PROXY, HTTPS_PROXY, NO_PROXY, ALL_PROXY
```

POSIX 分支追加：

```
NVM_DIR, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME,
HTTP_PROXY, HTTPS_PROXY, NO_PROXY, ALL_PROXY,
SSH_AUTH_SOCK
```

- 优点：改动小，立竿见影，不破坏批准门的安全性
- 缺点：仍然是白名单思路，未来新工具链可能要再加

**方案 B：每 server 一个"继承父进程环境"开关（中风险，最灵活）**

在 `mcp.tools.list` 条目里加 `inherit_parent_env: bool`（默认 false）。为 true 时 `create_stdio_transport` 不调 `env_clear()`，改为 `cmd.envs(std::env::vars())` 再覆盖 entry env。

- 优点：给用户完整控制；nvm/fnm/volta/代理问题一并解决
- 缺点：子进程会看到 deepstudent 的全部环境变量（可能含 API key）；需要 UI 加开关；需要数据迁移

**方案 C：放弃"危险访问放开沙箱"的思路（必须告知用户）**

MCP 子进程**根本没被沙箱隔离**。"Unrestricted Host Shell" 是聊天 local_shell 工具的概念，跟 MCP 完全无关。走这条路不会修任何问题。

**方案 D：诊断日志增强（建议先做）**

在 `create_stdio_transport` 里把现有 `log::info!` 改成 `log::warn!` 级别，并额外打：
- spawn 前：完整的 `cmd` debug 格式（含 env 键名列表）
- spawn 失败：`std::io::Error` 的 `raw_os_error()`
- stdout/stderr 前 1KB 预览（如果子进程在 initialize 前退出）

这样用户下次反馈时日志直接给出根因，不用猜。

---

## 五、方案选项汇总（请用户选择）

### 问题 2（Qwen 思考强度配置）

| 选项 | 内容 | 工作量 | 推荐度 |
|---|---|---|---|
| **2A** | 前端补 Qwen 的"思考强度"控件：新增 `qwen-effort` kind，暴露 enable_thinking toggle + thinking_budget 三档预设 | ~200 行前端 | ★★★★★ |
| 2B | 给内置 Qwen 模型补默认 `thinking_budget`（顺手改进） | ~30 行 | ★★★★ |
| 2C | 加通用"自定义额外参数"逃生口（采纳 operit 思路） | ~150 行（前后端） | ★★★★ |
| 2D | aggregator 上 Qwen 家族分发扩展（OpenRouter 等） | ~50 行 | ★★★ |
| 2E | 全量按 operit 思路重写 | 重写整个 llm_manager | ❌ 不建议，现有架构更好 |

**推荐组合：2A + 2B + 2C。** 2A 直解用户痛点，2B 顺手改进开箱体验，2C 是 operit 思路中唯一值得借鉴的部分（逃生口），为未来新参数留路。

### 问题 1（MCP 握手失败）

| 选项 | 内容 | 风险 | 推荐度 |
|---|---|---|---|
| **1A** | 环境白名单扩充（SYSTEMDRIVE / ProgramData / NVM_* / 代理变量等） | 低 | ★★★★★ |
| 1B | 每 server "继承父进程环境"开关 | 中 | ★★★★ |
| 1C | 诊断日志增强（spawn 前打完整 cmd / spawn 失败打 OS errno / stdout 前 1KB 预览） | 低 | ★★★★★（必做） |
| 1D | 放开沙箱 / 接 Unrestricted Host Shell 到 MCP | — | ❌ 无效，MCP 根本没被沙箱隔离 |
| 1E | 放宽批准配置门（允许模糊匹配） | 高 | ❌ 会降低安全性 |

**推荐组合：1C + 1A + 1B。** 先做 1C 拿到真实错误日志，再做 1A 解决 90% 用户场景；1B 作为高级选项给有复杂 Node 安装（nvm/fnm/代理）的用户。

**不推荐 1D**：用户怀疑的"沙箱隔离"实际不存在。真正的原因是 env 白名单太狠 + 批准配置门太严。走 1D 不会修任何问题，反而引入误导。

---

## 六、决策记录（待用户填写）

请在下方标记你的选择：

```
[ ] 问题 2 选择：____________（例如 "2A + 2B + 2C"）
[ ] 问题 1 选择：____________（例如 "1C + 1A"）
[ ] 其他指示：____________
```

用户确认后，按 RULES.txt 第 8 条：每个修改跑测试验证有效后才构建。

---

## 七、参考文件路径速查

**deepstudent 模型适配关键文件：**
- `E:\yysls\deepstudent\deep-student\src-tauri\src\llm_manager\adapters\mod.rs`（RequestAdapter trait + registry）
- `E:\yysls\deepstudent\deep-student\src-tauri\src\llm_manager\adapters\qwen.rs`（Qwen 方言）
- `E:\yysls\deepstudent\deep-student\src-tauri\src\llm_manager\builtin_vendors.rs`（内置模型目录）
- `E:\yysls\deepstudent\deep-student\src-tauri\src\llm_manager\mod.rs`（ApiConfig / apply_reasoning_config）
- `E:\yysls\deepstudent\deep-student\src\utils\apiCapabilityEngine.ts`（能力推断）
- `E:\yysls\deepstudent\deep-student\src\utils\deepseekReasoningControls.ts`（思考控件状态机）
- `E:\yysls\deepstudent\deep-student\src\utils\modelCapabilities.ts`（每模型默认参数）

**deepstudent MCP 关键文件：**
- `E:\yysls\deepstudent\deep-student\src-tauri\src\mcp\global.rs`（spawn 入口，env_clear 在这里）
- `E:\yysls\deepstudent\deep-student\src-tauri\src\mcp\client.rs`（McpClient::initialize）
- `E:\yysls\deepstudent\deep-student\src-tauri\src\cmd\mcp.rs`（mcp_stdio_start 批准门）
- `E:\yysls\deepstudent\deep-student\src\mcp\mcpService.ts`（前端 SDK 封装）
- `E:\yysls\deepstudent\deep-student\src\mcp\tauriStdioTransport.ts`（Tauri transport 桥）
- `E:\yysls\deepstudent\deep-student\src\features\settings\components\McpEditorSection.tsx`（MCP 配置 UI）

**operit 参考文件：**
- `E:\yysls\operit\app\src\main\java\com\ai\assistance\operit\data\model\ModelConfigData.kt`（ApiProviderType 枚举）
- `E:\yysls\operit\app\src\main\java\com\ai\assistance\operit\api\chat\llmprovider\AIService.kt`（统一接口）
- `E:\yysls\operit\app\src\main\java\com\ai\assistance\operit\api\chat\llmprovider\OpenAIProvider.kt`（基类 + 参数透传）
- `E:\yysls\operit\app\src\main\java\com\ai\assistance\operit\api\chat\llmprovider\QwenAIProvider.kt`（Qwen 方言）
- `E:\yysls\operit\app\src\main\java\com\ai\assistance\operit\data\model\ModelParameter.kt`（通用参数模型）
