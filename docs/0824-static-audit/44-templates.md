model=claude-fable-5-thinking-xhigh

# 44 — 模板管理与 Anki 模板库入口静态审计

> 范围：`src/features/template-management/`（App / Browser / Toolbar / InlinePanels / lib）、
> `src/features/workbench/apps/system/TemplatesAppWindow.tsx`、`src/data/ankiTemplates.ts`、
> `src/services/templateService.ts`、`src/App.tsx` 模板视图接线、Anki 侧入口
> （`src/features/anki-tasks/AnkiTasksApp.tsx`、`TaskDashboardAppWindow.tsx`）、
> 后端 `src-tauri/src/commands.rs` 模板 CRUD 命令。纯静态走读，未运行代码。

## 1. 架构走读

### 1.1 三种宿主布局（同一组件，运行时分叉）

`TemplateManagementApp` 依据环境选择布局（`TemplateManagementApp.tsx` L1339–L1388）：

- **legacy 桌面壳**：`useDesktopShellSidebarPortal('template-management')` 有 portal 目标时，
  侧栏（搜索 / 新建 / 刷新 / 导入导出组）经 `createPortal` 投送到壳侧栏槽位；
- **workbench 窗口 / 无壳侧栏**：`TemplatesAppWindow` 内没有 portal 目标，组件自动切换为
  顶部标签导航（`wb-tm-nav`），窗口层还补了 ⌘/Ctrl+F 聚焦搜索框（capture 阶段消费、
  `data-focused` 门禁，防跨窗抢键）；
- **移动端**：`MobileSlidingLayout` 三屏（左抽屉 / 中内容 / 右屏代码编辑器），抽屉行复用
  `mobileDrawerStyles` 契约，与 Chat / 学习资源同构。

三处布局共享同一份状态与回调，无重复实现，分叉点集中在渲染末端，结构清晰。

### 1.2 数据层

- 唯一写路径是 `@/data/ankiTemplates` 的 `templateManager` 单例（invoke
  `create/update/delete_custom_template` 后 `loadTemplates()` 重读并广播），域内
  `stores/` 目录为空——与 `docs/dev/acr/progress/A45-1.md` 的裁决一致；
- `lib/templateLibrary.ts` 为 UI 无关纯函数层（类型识别 / 搜索 / 筛选 / 排序 / 导入错误归类 /
  视图模式持久化），已有单测 `templateLibrary.viewModeAndImportError.test.ts`；
- 视图模式持久化 key `template-management:view-mode`，localStorage 异常静默降级为 grid，合理。

### 1.3 Anki 模板库入口（本轮重点之一）

| 入口 | 路径 | 去向 |
| --- | --- | --- |
| legacy 制卡页链接（桌面） | `AnkiTasksApp.tsx` L593 `openTemplateLib` | `App.tsx` L2405：`setIsSelectingTemplate(false)` + `setCurrentView('template-management')` |
| legacy 制卡页整行按钮（移动端） | `AnkiTasksApp.tsx` L656–L661 | 同上 |
| legacy 制卡页空态按钮 | `AnkiTasksApp.tsx` L807–L814 | 同上（有空态单测覆盖） |
| workbench 制卡窗口 | `TaskDashboardAppWindow.tsx` L68 | `workbenchBus.launch({ typeId: 'templates' })` 开独立窗口 |
| 返回制卡 | 面包屑「Anki 制卡 >」 | `onBackToAnki` → `setCurrentView('task-dashboard')`，编辑态脏检查经 `leaveEditorGuardRef` 前置拦截 |

入口进入前统一 `setIsSelectingTemplate(false)`，避免选择模式状态串页；面包屑离开与取消编辑
共用同一脏检查（`confirmDiscardEditorChanges`），防误触丢稿的语义闭环完整。

## 2. 危险删除链路（只记录，不改）

### 2.1 前端确认层

- `TemplateBrowser.tsx`：删除不用弹窗，卡片 / 列表行内联二次确认，
  `DELETE_CONFIRM_TIMEOUT_MS = 8000` 超时自动还原（L86–L100）；取消按钮 `autoFocus`，
  危险按钮不默认聚焦，方向正确；
- 键盘 `Delete` / `Backspace` 也只进入待确认态（L596–L601），不直接删除；
- 内置 / 自定义分文案：内置提示「删除后保持停用、不会随升级恢复」，自定义如实提示不可恢复；
- 列表变化后清理悬挂的 `pendingDeleteId`（L509–L517），无幽灵确认条。

### 2.2 后端语义（`commands.rs` `delete_custom_template`，L3281–L3341）

- **内置模板**：不物理删除，转「停用 + `user_deleted` 墓碑」（`soft_delete_builtin_template`），
  模板 ID 稳定、内置升级导入不复活，UI 无恢复入口；
- **自定义模板**：物理 `DELETE`，**无回收站、不可恢复**；
- 返回 `{ deleted, deactivated, isBuiltIn, referencingCards, message }`；前端对
  `referencingCards > 0` 补一条 warning 通知（`TemplateManagementApp.tsx` L661–L667）。

### 2.3 记录的危险点（均不在本轮修改）

- **[危险删除-记录 1]** 自定义模板物理删除即使仍有存量卡片引用也**不阻断**：后端仅
  `warn!` 日志（L3327–L3332）+ 前端事后 toast，被引用卡片的 `template_id` 绑定断裂后
  渲染回退行为依赖别处兜底。属既有设计（bug D5 增强已把引用数如实回执），只记录。
- **[危险删除-记录 2]** `templateService.deleteTemplates`（L258–L262）循环单删做批量，
  无整体确认层，当前 UI 未接批量删除入口，但该导出函数对任意调用方开放。只记录。
- **[危险删除-记录 3]** Agent 双路径可删模板：`templatesAgentActions.ts` 的
  `deleteTemplate`（risk=high、reversible=false、不注册 inverse，有 manifest 单测锁定）与
  `chat_v2/tools/template_executor.rs`（自定义直接物理删）。两处语义与 UI 后端一致，
  可逆性申明诚实。只记录。

## 3. 其余静态发现（低风险）

1. **疑似死代码——选择模式触发器**：`App.tsx` L1887 `handleTemplateSelectionRequest` 是
   唯一 `setIsSelectingTemplate(true)` 的地方，但全 `src/` 无调用方；即选择模式
   （`isSelectingMode`，含 `page_title_select` 标题、`onTemplateSelected` 回调、取消返回等
   整条 UI 链路）当前不可达。配套的 `handleViewChange` L1791 守卫注释「从 Anki 制卡页面进入」
   与 `!== 'task-dashboard'` 条件语义相符，但同样只为这条不可达流程服务。建议后续核实
   是否为规划中的「制卡时选模板」入口预留，再决定删除或接线。
2. **导出降级链的信息暴露**：单个 / 批量导出在保存对话框与剪贴板都失败时，把完整模板 JSON
   `console.log` 到控制台（`TemplateManagementApp.tsx` L396、L476）。模板非敏感数据，
   影响极低，但生产日志倾倒完整负载可再收敛。
3. **副本 ID 生成**：`handleDuplicateTemplate` 用 `${template.id}-copy-${Date.now()}` 拼 ID
   （L595），多级复制会让 ID 无限增长；毫秒级时间戳在人工操作下无碰撞风险，可接受。
4. **导入 strict 探测**：`handleConfirmImportExternal` 以
   `'fields_json' in item || 'field_extraction_rules_json' in item` 推断 `strict_builtin`
   （L532），属启发式；配合前端先行 `JSON.parse` 与 `classifyTemplateImportError` 的
   「怎么办」级错误归类（permission / not_template / invalid_json 信号词表），失败路径可读性好。
5. **保活守卫一致性**：三处 Android 返回 handler（导入导出面板 / 编辑态 / 选择模式）都带
   `getClientRects` + computed `visibility` 双重可见性守卫，与 PluginsTab 等同款范式，
   防隐藏保活层吞返回键的处理到位。
6. **refreshToken 刷新**：AI 工作室导入后经 `templateManagementRefreshTick` 递增触发
   `loadTemplates()` 强制刷新（L335–L339），单向 tick 语义简单可靠。

## 结论

- 模板管理域结构健康：三宿主布局分叉集中在渲染末端；写路径统一走 `templateManager` 单例；
  纯函数层有单测；Anki 模板库入口（legacy 三处 + workbench 一处）接线正确，进入前统一清除
  选择模式状态，编辑态脏检查闭环完整。
- 危险删除链路整体设计诚实：行内二次确认 + 8 秒自动还原，内置停用墓碑 / 自定义物理删除
  分语义如实提示；三条危险点（引用卡片不阻断删除、`deleteTemplates` 批量函数无确认层、
  Agent 双路径高危删除）均为既有设计且回执诚实，本文只记录，不动删除语义。
- 唯一值得后续跟进的是 `handleTemplateSelectionRequest` 不可达导致整条模板选择模式 UI
  成为死链路，建议另开任务核实去留。
- **本轮不改代码**。
