model=claude-fable-5-thinking-xhigh

# MCP 存储面分叉回归定位(08 号 FAIL 对照 v0.9.44)

任务:08 号报告判定 MCP 敏感设置「写入与运行时读取不在同一存储面、空策略全放行、存在明文写入入口」为 FAIL。本文用 `git show` / `git diff v0.9.44...HEAD` 静态对照,裁定该缺陷是否为 0824 升级引入的真回归。v0.9.44(`1cf6cabc`)正好是 HEAD 的 merge-base,对比为干净线性 diff。

## 1. 写入路径 vs 读取路径(0824 与 v0.9.44 各自)

### 写入路径:两版逐字相同,均写入安全存储并删除明文行

- 敏感键前缀 `mcp.transport.` / `mcp.tools.` / `mcp.servers.`:0824 位于 `src-tauri/src/secure_store.rs:116-118`,v0.9.44 位于同文件 112-114 行,内容一致。该前缀组自 v0.9.2 初始发布提交(`1813b3c9`,2026-02-13)即存在。
- 通用命令 `save_setting` / `get_setting`(`src-tauri/src/cmd/web_search.rs:538-566`)转调 `Database::save_secret` / `get_secret`:该文件在 v0.9.44...HEAD 间零 diff。
- `Database::save_secret` 对敏感键写安全存储、成功后删除旧明文行、失败拒绝明文回退:0824 位于 `src-tauri/src/database/mod.rs:4222-4278`,v0.9.44 位于 4202-4258;两个区块逐字 diff 为空。
- UI 写入通道 `src/features/settings/components/useSettingsConfig.ts`(读 78-91、存 350-365)与 Agent 工具侧 `src-tauri/src/chat_v2/tools/mcp_settings_store.rs:28-52`(get_secret/save_secret):两文件在 v0.9.44...HEAD 间零 diff。

### 读取路径:三处运行时明文读取在两版逐字/等价存在

- `load_mcp_tool_policy` 用 `db.get_setting` 明文读 `mcp.tools.advertise_all_tools` / whitelist / blacklist:0824 与 v0.9.44 同在 `src-tauri/src/chat_v2/pipeline/helpers.rs:220-248`,214-270 行区间逐字 diff 为空。helpers.rs 在两版间共 752 行改动,但 grep 全部增删行,无一行涉及 `get_setting` / whitelist / blacklist / advertise / 策略函数——该文件改动全部是本地 shell 守卫与工具排序,与 MCP 策略存取无关。
- `src-tauri/src/llm_manager/mod.rs` 同组策略明文读取:0824 位于 6972/6980/6992 行,v0.9.44 位于 6817/6825/6837 行;对应区块(v44 6805-6860 vs HEAD 6960-7015)逐字 diff 为空。
- `src-tauri/src/lib.rs` 明文读 `mcp.tools.list`(HEAD 3349 / v44 3260)及 transport 与策略键(HEAD 3556-3639 / v44 3467-3550):两个区块逐字 diff 为空,仅整体行号平移。

即:「UI 写安全存储并删明文行 → 运行时从明文表读到空值」这一分叉结构,在 v0.9.44 与 0824 中完全同构。

## 2. 空策略全放行:两边都有

`is_mcp_tool_allowed_by_policy` 的 `whitelist.is_empty() || whitelist.iter().any(...)` 语义(`src-tauri/src/chat_v2/pipeline/helpers.rs:255-267`)在两版逐字相同(214-270 行区间 diff 为空,含注释「空白名单 = 全放行」)。该函数与 `load_mcp_tool_policy` 由 `f32d820a` 引入,首个包含它的 tag 是 v0.9.43,早于 v0.9.44。0824 diff 中该两函数无任何新增或删除的调用点。

## 3. 明文写入入口:两边都有

`save_mcp_config`(`src-tauri/src/cmd/mcp.rs`)对 `mcp.transport.type/command/args/framing/url` 与 `mcp.tools.cache_ttl_ms/advertise_all_tools/whitelist/blacklist` 共 10 处直接 `db.save_setting`:0824 位于 631-693 行,v0.9.44 位于 629-691 行,逐字对应。该文件两版间的全部 diff 仅为 `#[cfg(feature = "mcp")]` 门控与 import 调整,不触及任何写入调用。

## 4. 0824 diff 全量反查

- 整个 `src-tauri/**` diff 中涉及 `"mcp.` 字面量的增删仅三类:两处 `strip_prefix("mcp.tools.")` 代码搬移(工具名规范化逻辑在文件间移动,减增行内容相同)、一处测试中新增工具名字符串 `mcp.tools.local_shell_execute`。均为工具命名,不是设置键的读写。
- `secure_store.rs` 的 233 行改动全部是云存储凭据面(加密口令长度校验、Debug 脱敏、清理命令及测试),不改 `is_sensitive_key` 判定,不触碰 MCP 键路由。
- `database/mod.rs` 的 171 行改动不触及 `save_secret` / `get_secret` / `delete_secret` 区块(已逐字比对)。

因此 0824 升级既没有制造这条分叉,也没有扩大其触发面(策略消费点数量与语义不变),同样也没有修复它。

## 裁决

**v0.9.44 既有。** 08 号报告指出的三项事实(存储面分叉、空白名单全放行、`save_mcp_config` 明文入口)全部在 v0.9.44 中以逐字相同的代码存在,历史上可进一步追溯到 v0.9.43(策略函数)与 v0.9.2(敏感键前缀)。0824 未引入、未加重。

按本轮规则「只有 0824 引入或明显加重才建议下一轮隔离枝修」:**不建议**将其纳入 0824 隔离枝修复。08 号 FAIL 的事实认定依然成立——缺陷真实存在且值得修——但它属于既有缺陷,应转入独立的存量缺陷跟踪(统一策略读取到 `get_secret`、封堵 `save_mcp_config` 明文写入、审视空白名单默认语义),而非 0824 回归修复范围。

## 结论

08 号 FAIL 所述 MCP 存储面分叉、空策略全放行与明文写入入口均为 **v0.9.44 既有** 缺陷,0824 升级未引入也未加重,不满足进入下一轮 0824 隔离枝的条件;建议按存量缺陷单独立项跟踪。

本轮不改代码;仅写入本静态审计文档。
