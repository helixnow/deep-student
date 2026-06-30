# 代理 7（round 2）—— 平台基座与全局体验

> 先读 `docs/6.13/README.md`，再通读 `docs/6.12/status/agent-7-status.md`（F1–F30 / O1–O9 / X1–X9）。
> 本组同时是 `commands.rs` / `lib.rs` / `App.tsx` / `locales` 共享文件的一致性仲裁人。

## 已完成（收尾会话，勿重做）
- F7 crypto 密钥损坏可操作诊断（**未自动重置**，防瞬时读失败导致数据不可逆丢失）。
- F9 `secure_store::list_sensitive_keys` 改扫描 `.enc`。
- F13「清空数据」：`purge_all_database_files`（写 `startup_cleanup` 标记 + 前端重启，`lib.rs:382` 在开库前 `purge_active_data_dir`，规避 Windows 文件锁）+ `purge_active_data_dir_now`（移动端即时），均已注册。
- F16 capabilities 诚实化：删 `capabilities/test.json`，通配并入 `default.json` + 写明理由。
- F26 `lint:css` glob 单引号→双引号（修 Windows）。

## 本轮任务（按优先级）

### P1 — 死代码 / 僵尸命令清理（F12 + F15 + X1–X9 协调）
- [ ] **F15** `components/Dashboard.tsx`：整组件无人导入（已被 `components/dashboard/*` 取代），内部 `get_statistics` 命令也不存在。核实后删。
- [ ] **F12** 僵尸命令：24 个 `#[tauri::command]` 定义未注册且前端不调用（`textbooks_*` 9 个由代理 2 处理；`data_space` 4 个、`debug_commands` 3 个、research 报告 4 个、`check_anki_connect_availability`、`resource_get_content_from_vfs`、`test_rmcp_streamable_http`、`test_web_search_connectivity`）。逐个确认确无前端调用后删定义；明细见状态文档 X1-X9 与 `%TEMP%/dead_invoke_analysis.txt`。
- [ ] X1–X9 跨域 invoke→不存在命令：本组牵头核对，**死包装删除**、**需后端的上报对应代理**（注：`rebuild_chat_fts`(F14, 代理1域) 与 `purge_*`(F13) 已由收尾会话实现；`generate_anki_cards_for_segment`/`unified_*`/`get_document_state` 等经核实为死包装）。

### P2 — 健壮性 / 性能
- [ ] **F8** Windows 下 `.master_key`/`.secure` 无 ACL 收紧（仅 Unix 0600）。本地单用户可接受；评估是否加 Windows ACL。
- [ ] **F21** `main.tsx`：console.warn/error 三层包装（早期过滤 + tauri_lab 桥 + plugin-log forward），每条触发 1–2 次 IPC 且无节流、prod 也启用。给 tauri_lab 桥加节流或 dev-only。
- [ ] **F22** `main.tsx:431`：StrictMode 仅 prod 启用（dev 移除）——与 React 行为相反，等于全程无 StrictMode 诊断。恢复 dev StrictMode 需先清理双执行噪声（中风险）。
- [ ] **F29** 视图级 ErrorBoundary 缺失：全局仅 `main.tsx` TopLevel 一道，单页崩溃打穿整壳。为懒加载视图容器加每视图 ErrorBoundary + 统一降级 UI。

### P2 — 备份重构类（第一轮登记，中风险，先出方案）
- [ ] **F3** `backup/mod.rs` 三个备份入口 ~80 行重复，抽公共流程。
- [ ] **F4** lance 目录按普通资产复制，备份期写入可能得到不一致快照（恢复后可重建兜底）。
- [ ] **F5** `commands_asset.rs:data_governance_restore_with_assets` 恢复非活跃插槽但不恢复密钥，与主路径不一致（UI 未用）。

### P3 — i18n（大工程，需各组协同）
- [ ] **F24** 全仓硬编码中文 2464 处；本组大头 `ModernSidebar.tsx`(47) / `SkillsManagementPage`(54)。本轮先清本组大头，全仓清理出协同方案。

## 验证
`cargo check`；`npm run typecheck`/`lint`/`check:i18n`；删命令后确认 `generate_handler!` 列表与前端 invoke 一致。共享文件改动登记到状态文档。
