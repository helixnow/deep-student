model=gpt-5.6-sol-xhigh-fast

# 设置、Vendor Key、MCP 与 Legal 静态审计

审计方式：仅静态读取；未运行产品、未写入或验证任何真实密钥。状态汇总：

| 审计面 | 状态 | 摘要 |
| --- | --- | --- |
| Vendor API key | PASS | Renderer 只拿到占位符；内置 Vendor 使用安全存储，自定义 Vendor 的 key 与敏感 header 加密后落盘。 |
| MCP 设置与策略 | FAIL | Settings UI 将 `mcp.transport.*` / `mcp.tools.*` 写入安全存储，但多处运行时仍从明文 `settings` 表读取；策略读取失败后空白名单语义为全放行。另有命令直接明文写同类键。 |
| NOTICES、Tauri、Vite | PASS | 唯一权威文件在根目录 `legal/`；Tauri resources 映射、Vite dev 中间件和展示读取路径一致。 |
| 虚构模型条目 | PASS | 内置目录无 `mythos-5` / `claude-haiku-5` 真实条目，并有负向守卫。 |
| qbank-tools | PASS | 描述压缩成果有预算护栏；`daily_target` 在技能工具 schema、执行器及服务层贯通，不属于 Settings UI。 |

## 1. 设置 / Vendor API key

### PASS：Vendor key 未回传明文，落盘链路有保护

- `src-tauri/src/llm_manager/mod.rs:4777-4809` 明确把主 key、备用 key 和敏感 header 替换为 `***` 后再交给 Renderer；已保存的真实 key 不通过 Vendor 配置接口回传。
- `src-tauri/src/llm_manager/mod.rs:4911-4936` 从安全存储恢复内置 Vendor 的运行时 key；`src-tauri/src/llm_manager/mod.rs:5106-5144` 保存或删除 `{vendor_id}.api_key`，并保证 `vendor_configs` 中不保存内置 Vendor 主 key。
- `src-tauri/src/llm_manager/mod.rs:5026-5052` 加密敏感 header，`src-tauri/src/llm_manager/mod.rs:5054-5087` 加密备用 key；`src-tauri/src/llm_manager/mod.rs:5145-5155` 加密自定义 Vendor 主 key。
- `src/features/settings/components/ApiKeyField.tsx:24-50` 默认使用 `password` 输入类型；`src/features/settings/components/VendorApiKeySection.tsx:95-133` 将后端占位符视为“已配置”而非真实值，`142-161` 保存后清空输入框。

安全边界：本审计没有使用真实 key。不得把真实 key 写入仓库、审计文档、issue/PR、日志、截图或测试夹具。

## 2. MCP 设置、凭据与工具策略

### FAIL：安全存储读写与运行时读取分叉，策略可静默退化为全放行

1. `src-tauri/src/secure_store.rs:109-127` 把 `mcp.transport.*`、`mcp.tools.*` 和 `mcp.servers.*` 定义为敏感键；`src-tauri/src/secure_store.rs:534-560` 对这些键启用加密文件存储。
2. 通用 Tauri 设置命令的实现是正确的：`src-tauri/src/cmd/web_search.rs:538-566` 的 `save_setting` / `get_setting` 实际调用 `Database::save_secret` / `get_secret`。`src-tauri/src/database/mod.rs:4241-4276` 在安全写入后删除旧明文行，明确拒绝明文回退。
3. Settings UI 正是走该通用命令：`src/features/settings/components/useSettingsConfig.ts:78-91` 读取 MCP 设置，`src/features/settings/components/useSettingsConfig.ts:350-365` 保存 transport、工具策略、工具列表和性能项。因此 `mcp.transport.*` / `mcp.tools.*` 最终位于安全存储，而不是 `settings` 表。
4. 但 Chat v2 策略仍绕过 `get_secret`：`src-tauri/src/chat_v2/pipeline/helpers.rs:220-248` 用 `db.get_setting` 读取 `advertise_all_tools`、whitelist、blacklist；`src-tauri/src/llm_manager/mod.rs:6955-7001` 也直接从 `settings` 表读取同组策略。安全存储写入会删除同名明文行，所以这些读取会得到空值。
5. 该缺失不是安全失败关闭：`src-tauri/src/chat_v2/pipeline/helpers.rs:251-266` 先检查 blacklist，但最终以“whitelist 为空即放行”处理。于是 UI 中保存的黑名单/白名单可能不被运行时看到，随后外部 MCP 工具按空策略放行。
6. 同一问题还覆盖连接配置：`src-tauri/src/lib.rs:3341-3355` 用 `get_setting` 读取 `mcp.tools.list`，`src-tauri/src/lib.rs:3554-3646` 用 `get_setting` 读取 transport 与工具策略。与之相对，Agent 工具侧的专用实现 `src-tauri/src/chat_v2/tools/mcp_settings_store.rs:28-52` 已正确使用 `get_secret` / `save_secret`，说明当前存在两套不一致的读取路径。
7. 另一个入口反向绕过安全存储：`src-tauri/src/cmd/mcp.rs:631-719` 的 `save_mcp_config` 对 `mcp.transport.*` 和 `mcp.tools.*` 直接调用 `db.save_setting`。同一敏感键会因入口不同而分别落入安全存储或明文 SQLite，形成安全性和行为双重分叉。

`mcp.performance.*` 只保存超时、限流和缓存数值（`src/features/settings/components/useSettingsConfig.ts:358-361`），不在敏感键前缀中；本项 FAIL 针对 transport、server/tool 列表与工具策略的存取不一致，不能泛化成“所有 MCP 设置都必须加密”。

## 3. THIRD_PARTY_NOTICES 权威路径

### PASS：权威路径是 `legal/`，不是 `public/legal/`

- 仓库内唯一的 notices 文件是 `legal/THIRD_PARTY_NOTICES.txt`；`public/legal/THIRD_PARTY_NOTICES.txt` 不存在。
- `scripts/generate-third-party-notices.mjs:13-16` 明确声明唯一权威路径，并输出到根目录 `legal/THIRD_PARTY_NOTICES.txt`。
- `scripts/check-license-compliance.mjs:8-9` 将合规检查目标固定为该根目录文件，`scripts/check-license-compliance.mjs:38-39` 对缺失文件失败。

### PASS：Tauri resources 映射正确

- `src-tauri/tauri.conf.json:60-68` 将 `../legal/THIRD_PARTY_NOTICES.txt` 映射为安装包资源 `licenses/THIRD_PARTY_NOTICES.txt`，没有从 `public/legal/` 打包副本。
- `src/features/settings/components/OpenSourceAcknowledgementsSection.tsx:86-92` 区分 web 路径与 Tauri resource 路径；`100-118` 在 Tauri 中经 `resolveResource` + `readTextFile` 读取，web 环境再回退 `fetch`。

### PASS：Vite dev 中间件读取同一权威文件

- `vite.config.ts:74-77` 说明 NOTICES 不再进入 `dist`，纯 web dev 由中间件代理。
- `vite.config.ts:79-94` 在 `/legal/THIRD_PARTY_NOTICES.txt` 路由读取仓库根 `legal/THIRD_PARTY_NOTICES.txt`；不存在 `public/legal/` 影子来源。

## 4. 无 mythos-5 / haiku-5 真实条目

### PASS

- `src-tauri/src/llm_manager/builtin_vendors.rs:923-935` 的 Anthropic 内置目录注明 Haiku 最新为 4.5，随后列出的是真实内置型号而非 Haiku 5。
- `src-tauri/src/llm_manager/builtin_vendors.rs:1680-1692` 负向断言 `claude-haiku-5` 和任何 `mythos` 模型不得进入 `BUILTIN_MODELS`，并正向锁定 `claude-haiku-4-5`。
- `scripts/model-capability-registry.json:1-5` 明确不收录未发布的 `claude-haiku-5`；`src/utils/__tests__/apiCapabilityEngine.test.ts:105-123` 锁定 4.5 可解析而 5 不可解析。
- `src/utils/deepseekReasoningControls.ts:213-239` 的 `mythos` 命中只是自定义模型名的适配层代际推断，不是内置模型或 capability registry 的真实条目。

## 5. qbank-tools 描述压缩与 daily_target

### PASS：两项并存，位于技能工具面

- `src/features/chat/skills/builtin-tools/qbank-tools.ts:11-23` 定义 `qbank-tools` 技能；其 embedded tool schema 位于同文件 `159-838`，属于 Chat 技能工具面，不属于 Settings UI。
- `docs/dev/optimization0824/progress/R2-WI-10-slim.md:20-41` 记录 qbank schema 从 7,389 降至 6,172 tokens（估算），降幅 16.5%；`tests/vitest/chat-v2/token-budget.test.ts:128-141` 将当前最大组记录为 qbank-tools 6,172，并以 6,800 作为单组上限，`196-210` 执行单组与总量预算护栏。
- `src/features/chat/skills/builtin-tools/qbank-tools.ts:723-750` 保留每日一练 `count: 1..=50`，并在打卡日历工具中保留 `daily_target: 1..=50`（具体字段在 `746`）。
- `src-tauri/src/chat_v2/tools/qbank_executor.rs:3587-3606` 校验并转发 `daily_target`；`src-tauri/src/question_bank_service.rs:2832-2848` 消费该值并在缺省时使用 10。该参数不只是 schema 文案。

## 结论

**FAIL**

Vendor key、NOTICES 权威路径、Tauri resources、Vite 中间件、虚构模型排除及 qbank-tools 指定项均通过；但 MCP 的敏感设置写入与运行时读取不在同一存储面，且工具策略缺失后会按空白名单全放行，同时仍存在直接明文写入入口。这是影响策略有效性与凭据边界的阻断项，故整体不能判为 PASS/WARN。

本轮不改代码；仅写入本静态审计文档。
