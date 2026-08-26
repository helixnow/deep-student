# Deep Student 0824 设置 / Vendor Key / MCP / 开源致谢质量评审

## 结论

对比范围：`v0.9.44`（`1cf6cabc`）→ `origin/cursor/0824-cde6`（`2d41ea8b`）。本报告按真实 diff 与目标树源码静态评审，未运行产品、未写入或读取真实密钥。

| 评审面 | 增量判定 | 当前态判定 | 结论 |
| --- | --- | --- | --- |
| 设置体验 | PASS（有测试缺口） | PASS | 搜索、移动返回链、安全区、触屏命中区和窄屏 MCP 浮层均有实质改善。 |
| 供应商密钥 | PASS（存储语义未改） | PASS | 0824 主要改善交互；真实存储仍是“内置供应商走安全存储、自定义供应商密文留在 `vendor_configs`”的既有混合模型。 |
| MCP | 非本轮回归 | FAIL（存量缺陷） | 安全存储写入与多条运行时明文读取的分叉在 v0.9.44 已逐字存在；0824 未引入、未扩大消费点，也未修复。 |
| 开源致谢 / NOTICES | PASS | PASS | 单一权威文件、单一进包通道和公共许可证正文抽取均成立，清单更小、更清楚。 |

因此应区分两种口径：

- **评价 0824 增量：PASS。** 设置面相对 v0.9.44 确实变好，MCP 缺陷不能归因于本轮。
- **评价 2d41ea8b 当前产品状态：仍有 MCP FAIL。** 该缺陷虽是存量欠账，仍会让 UI 中保存的工具策略在部分运行时路径静默失效，不能因为“不是本轮引入”而忽略。

## 1. 设置面：有实质改善，不只是换样式

设置相关 diff 涉及 84 个文件，约 `+5038/-982`；其中大量行来自云存储与数据治理扩展，不能单靠行数判优。可回源确认的有效改善是：

1. **设置搜索从“点结果切 tab”升级为可完成的定位流程。**  
   `SettingsSidebar.tsx:63-143,186-260` 新增 IME 保护、上下/Home/End/Enter/Escape 键盘操作、combobox/listbox 状态、空白输入与无结果出口；`settingsSearchReveal.ts:30-125` 在 lazy tab 挂载后滚动到标题并短时高亮，同时尊重 reduced-motion。新增的 `SettingsSidebar.searchKeyboard.test.tsx` 与 `settingsSearchReveal.test.ts` 是真实 DOM 交互测试，不是只查源码字符串。

2. **移动端返回链和标题恢复正确层级。**  
   `Settings.tsx:571-599` 把设置 Sheet 的 Android 返回处理放到 overlay 优先级，避让更上层 Radix 浮层，并以 `isActive` 防止 LRU 保活页面吞掉其他页面返回事件；`Settings.tsx:1946-2022` 给分区、供应商详情和右滑编辑面板显示实际标题及 44px 触屏按钮。`settings.css:11-76` 同时修正 Sheet 顶部死区和 portal 后安全区变量丢失。

3. **触屏命中区改善覆盖关键操作。**  
   `settingsTabPrimitives.tsx:47-67`、`api-key-field.css:112-135`、`McpEditorSection.tsx` 与 `McpToolsSection.tsx` 将开关行、密钥输入动作、MCP 编辑/删除/测试等按钮在 coarse pointer 下扩到至少 44px，并把密钥输入字号提高到 16px，避免 iOS 聚焦缩放。

4. **MCP 窄屏浮层不再容易被滚动容器裁切。**  
   `McpToolsSection.tsx` 将快捷操作与预设选择器迁到带碰撞钳制的 portal popover；新增 `McpToolsSection.narrowViewportOverlay.test.tsx` 覆盖 820px 窄视口、Escape 回焦、外点关闭和 360px 内联分支。

5. **开源致谢的移动体验更连贯。**  
   `OpenSourceAcknowledgementsSection.tsx:121-167` 在小屏使用 About 页内联长文，并让系统返回先回致谢列表；对应测试覆盖移动内联、桌面 Dialog、Web fetch 和 Tauri resource 读取。

### 非阻断风险

- `settingsSearchReveal.ts` 仍以翻译后的标题文本扫描 DOM，最多轮询 3 秒后静默放弃；重复标题可能命中首项，虚拟化或慢挂载也可能只完成切 tab、不完成定位。目前没有“搜索索引每一项都能命中真实页面锚点”的全量契约测试。它是明显改善，但还不是稳定的结构化锚点系统。
- Android 返回优先级与 Sheet 安全区修复逻辑较复杂，目标树没有针对 `sheetContentRef` / `hasOpenRadixOverlayBesides` 的直接回归测试；现有证据以源码逻辑和相邻组件测试为主，仍需移动端发布冒烟。

## 2. 供应商密钥：实际如何存、如何读

这里不能把所有 Vendor Key 简化成同一种存储。

### 内置供应商

- `secure_store.rs:109-127,534-560` 将以 `.api_key` / `.apiKey` 结尾的键视为敏感键，使用 AES-256-GCM 加密文件存储。
- `SecureStore::new_with_dir` 的真实根目录由 Tauri 的 `app_data_dir` 提供，再拼接源码定义的 `.secure` 子目录（`secure_store.rs:507-519`）；密文文件名由键名生成并加 `.enc`（`:1174-1191`）。这不是按供应商写 `.env` 文件。
- `llm_manager/mod.rs:4911-4936` 在运行时以 `{vendor_id}.api_key` 调用 `Database::get_secret`；保存/清除在 `:5106-5144` 调用 `save_secret` / `delete_secret`。`Database::save_secret` 成功写入安全存储后会删除同名 SQLite 明文行，失败则拒绝明文回退（`database/mod.rs:4221-4277`）。

### 自定义供应商、备用 key 与敏感 header

- 自定义供应商主 key 不拆成单独安全存储文件。`llm_manager/mod.rs:5026-5052,5054-5087,5145-5165` 分别把敏感 header、备用 key、主 key 经 `CryptoService` 加密，再把包含密文的供应商 JSON 写入 SQLite `settings` 表的 `vendor_configs` 行。
- 读取时 `read_user_vendor_configs` 从 `vendor_configs` 取 JSON，并在 Rust 侧解密这些字段（`llm_manager/mod.rs:4818-4894`）；运行请求再通过 `vendor_configs_for_runtime` 补入内置供应商安全存储中的 key（`:4897-4943`）。
- Renderer 的 `get_vendor_configs` 只收到 `***` 占位符：主 key、备用 key 和敏感 header 均在返回前遮蔽（`:4757-4815`）。前端 `VendorApiKeySection.tsx:95-133,142-161` 把占位符解释为“已配置”，保存成功后清空输入。其 8 秒“显示”只可能显示本次组件会话中用户刚输入、仍在 `lastSavedKeyRef` 的值；后端不会把已落盘明文读回 Renderer。

### 相对 v0.9.44 的变化

上述存储、迁移、遮蔽和运行时读取区块在两版间没有 API-key 语义 diff。0824 对该面主要增加 coarse-pointer 命中区，并把一个缺失翻译键的状态提示改为已有的“隐藏 API 密钥”文案。结论是：**密钥交互小幅变好，存储安全模型没有被本轮重写，也没有新增虚构目录。**

## 3. MCP：真实缺陷，但不是 0824 引入或加重

### 当前分叉

1. `mcp.transport.*`、`mcp.tools.*`、`mcp.servers.*` 被 `SecureStore::is_sensitive_key` 判为敏感（`secure_store.rs:109-127,534-545`）。
2. Settings UI 的 `useSettingsConfig.ts:78-91,350-365` 通过通用 `get_setting` / `save_setting` Tauri 命令读写；命令内部实际转调 `Database::get_secret` / `save_secret`（`cmd/web_search.rs:538-566`）。安全写入还会删除旧明文行。
3. 但 Chat v2 策略加载仍用 `Database::get_setting` 直接查 SQLite：`chat_v2/pipeline/helpers.rs:214-248`；`llm_manager/mod.rs:6955-7001` 也这样读取 advertise-all、白名单和黑名单；`lib.rs:3341-3355,3554-3646` 同样明文读取工具列表、transport 与策略。
4. `Database::get_setting` 只查询 `settings` 表（`database/mod.rs:4113-4123`），没有安全存储回退。因此 UI 一旦读取迁移或保存这些键，明文行被删除，上述运行时路径就会读到空值。
5. 策略缺失不会失败关闭：`helpers.rs:251-267` 明确是 blacklist deny-first，但空 whitelist 等于全放行。
6. 反方向还存在已注册的 `save_mcp_config`：它对同组敏感键直接 `db.save_setting`（`cmd/mcp.rs:630-723`），可把值明文写回 SQLite。目标树前端没有调用它，但命令仍在注册表和权限表中。
7. Agent 侧专用 `mcp_settings_store.rs:28-52` 已正确使用 `get_secret` / `save_secret`，进一步证明当前是多套路径不一致，而非统一设计。

### 回归归因

真实 diff 给出的答案是明确的：

- `useSettingsConfig.ts`、`cmd/web_search.rs`、`chat_v2/tools/mcp_settings_store.rs` 在 v0.9.44→2d41ea8b 间零 diff。
- `helpers.rs` 的策略函数、`llm_manager/mod.rs` 和 `lib.rs` 的上述明文读取区块逐字不变；调用点数量与空 whitelist 语义没有变化。
- `cmd/mcp.rs` 的全部 diff 只是 feature gate/import 调整，10 处敏感键 `save_setting` 调用未变。
- `secure_store.rs` 与 `database/mod.rs` 本轮虽有较大改动，但分别集中在云存储凭据和其他数据库逻辑；MCP 敏感前缀及 `save_secret` / `get_secret` 区块未变。
- MCP 设置 UI 本轮改的是触屏命中区、窄屏 overlay、文案和可访问性，没有改策略保存命令或运行时消费路径。

所以裁决为：**MCP 读写分叉是 v0.9.44 已有缺陷，0824 未引入、未在存储或消费语义上加重。** 本轮让 MCP 设置更容易在触屏设备上操作，可能让更多用户碰到既有问题，但这属于暴露度增加，不是代码语义回归。修复应单独立项：统一所有敏感键读取到 `get_secret`，移除或改造明文写入口，并重新审视“缺策略即全放行”。

## 4. NOTICES：确实更干净

### 权威路径与分发去重

- v0.9.44 的权威文件位于 `public/legal/`，既会进入 frontend dist，又被 Tauri resources 再映射一次。
- 2d41ea8b 删除该副本，只保留仓库根 `legal/THIRD_PARTY_NOTICES.txt`。`scripts/generate-third-party-notices.mjs:13-16`、`scripts/check-license-compliance.mjs`、`src-tauri/tauri.conf.json` 与 `docs/THIRD_PARTY_LICENSES.md` 全部指向同一源。
- 安装包只通过 Tauri resource 映射得到 `licenses/THIRD_PARTY_NOTICES.txt`；`OpenSourceAcknowledgementsSection.tsx:91-118` 在 Tauri 中用 `resolveResource` + `readTextFile`，Web 开发环境由 `vite.config.ts` 的 serve-only 中间件代理，不再把大文件塞入 dist。

### 内容去重

- 旧清单：2,586,708 bytes、56,593 行、1,871 components、816 distinct legal texts。
- 新清单：1,251,350 bytes、28,994 行、1,849 components、787 distinct legal texts、3 common license texts。
- 文件体积下降约 **51.6%**，而组件数只下降约 **1.2%**，主要收益不是删依赖。生成器先规范空白并按“完全相同的词序列”去重（`generate-third-party-notices.mjs:23-42,334-350`），再把多个 notice 中逐字相同的 Apache 条款抽成 `COMMON TEXT`，原位置保留引用（`:250-323,352-392`）。版权头、包专属前后文和 NOTICE 内容仍各自保留。
- 生成物头部写入双 lockfile SHA-256、组件数和去重统计；合规脚本校验 lock 新鲜度、未知许可证、机器绝对路径和 Tauri resource 映射，且 `package.json:11` 把检查放在 `prebuild`。

结论：**NOTICES 在内容结构、包内副本数和展示读取链路上都更干净，不是简单搬路径。**

保留边界：`vite preview` 或独立部署的静态 Web build 不包含该文件，Tauri resource 读取失败后的 fetch 也会进入统一错误态；如果未来把纯 Web production 定义为正式分发目标，需要另补生产读取通道。就当前 Tauri 分发目标而言不构成阻断。

## 最终裁决

0824 相对 v0.9.44 对设置面形成了可验证的净改善：导航与搜索更可用，移动端层级、触屏操作和开源致谢读取更完整，NOTICES 同时完成内容与分发去重；Vendor Key 没有被迁到任何臆造位置，既有的真实混合存储模型保持不变。

唯一高严重度问题仍是 MCP 敏感设置分叉。它应继续按当前态 FAIL 跟踪，但回归归因必须写清：**这是 v0.9.44 已有欠账，2d41ea8b 未引入、未加重，也未修复。**
