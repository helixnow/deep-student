# 0824 Wave2-C 第 1 轮扫描报告 · 壳与导航（06-shell-nav）

- 扫描员：Wave2-C R1「扫描员-壳与导航」（claude-fable-5-thinking-high）
- worktree：`/tmp/0824-wave2-c-r1-sidebar`（detached HEAD @ `29ca02d9`，基线 = `cursor/0824-wave2-mobile-uiux-a875`）
- 约束遵守：未执行 npm/npx/node/cargo/tsc/vite/vitest/tauri/CI/computerUse；`/workspace` 未动；本轮不 git commit（父代理统一提交）。

---

## 1. UnifiedMobileHeader 注册表 vs CurrentView

`src/types/navigation.ts` 的 `CurrentView` 联合共 **16 个视图**。全仓 `useMobileHeader('<viewId>', ...)` 字面量扫描（排除 `MobileHeaderContext.tsx` JSDoc 示例）结果：

| CurrentView | 注册文件（实测 grep 命中） | 与契约测试注册表一致 |
|---|---|---|
| chat-v2 | `src/features/chat/pages/useChatPageLayout.tsx:168` | ✅ |
| sandbox-workbench | `src/features/sandbox/pages/SandboxWorkbenchPage.tsx:32` | ✅ |
| settings | `src/features/settings/components/Settings.tsx:703` | ✅ |
| dashboard | `src/components/SOTADashboardLite.tsx:141` | ✅ |
| data-management | `src/components/DataImportExport.tsx:280` | ✅ |
| task-dashboard | `src/features/anki-tasks/AnkiTasksApp.tsx:450` | ✅ |
| template-management | `src/features/template-management/TemplateManagementApp.tsx:715` | ✅ |
| ui-lab | `src/components/style-lab/StyleDebugPage.tsx:32` | ✅ |
| template-json-preview | `src/components/TemplateJsonPreviewPage.tsx:68` | ✅ |
| crepe-demo | `src/components/dev/CrepeDemoPage.tsx:24` | ✅ |
| pdf-reader | `src/features/pdf/components/PdfReader.tsx:25` | ✅ |
| learning-hub | `src/features/learning-hub/LearningHubPage.tsx:723` | ✅ |
| skills-management | `src/components/skills-management/SkillsManagementPage.tsx:1175` | ✅ |
| todo | `src/features/todo/components/TodoContentView.tsx:267-268`（换行写法） | ✅ |
| chat-v2-test | `src/features/chat/dev/IntegrationTest.tsx:206` | ✅ |
| llm-playground | `src/features/chat/dev/playground/LLMOutputPlayground.tsx:92` | ✅ |

结论：**16/16 全覆盖，无缺漏、无非法 viewId、无游离注册**。与
`tests/vitest/mobile-uiux/mobileHeaderViewRegistryContract.test.ts` 的
`VIEW_REGISTRY_FILES`（16 键）逐条一致；`App.tsx:2352-2369` 的 D-1 兜底标签表
（`labels: Partial<Record<CurrentView, string>>`）同样 16/16 覆盖，未注册视图
顶栏空白的兜底（`fallbackTitle` → `UnifiedMobileHeader.tsx:185-188`）链路完整。
与 `docs/dev/mobile-uiux-unify/INVENTORY.md` 的第 0 轮盘点表相符（NotesHome
已删，无非法 'notes' viewId）。

配置隔离机制核验（`MobileHeaderContext.tsx`）：per-view 配置缓存 +
`setActiveView` 切换应用；写/读 context 分离（`MobileHeaderActionsContext`
引用永久稳定）防重渲染循环；卸载时 `clearConfig` 防 LRU 驱逐后 rightActions
闭包滞留；`enabled=false` 嵌入实例不写不清、防误删活跃视图配置。
`MobileSubviewChromeContext.tsx` 维持「每个 viewId 单一写者」契约：子屏 chrome
经宿主（LearningHubPage）栈式并入自己的 `useMobileHeader` 配置，不引入第二写者，
publisher 有保活可见性守卫（enabled 必须含 isActive gate）。

## 2. 抽屉分区（MobileSidebarNavigation + config/navigation）

- 数据源：`src/config/navigation.ts` 的 `MOBILE_NAV_SECTION_OF_VIEW`
  （`Record<NavViewType, 'study' | 'manage'>`）：
  - **study（学习）**：chat-v2、learning-hub、todo
  - **manage（管理）**：skills-management、task-dashboard、template-management、ui-lab（需显式启用 UI Lab）、settings
- 移动端专属追加项（`MobileSidebarNavigation.tsx:85-96`，F1 审计补入）：
  dashboard（总览）、data-management（数据管理）→ 插入 manage 分组、设置之前收尾。
- 分区标题（`MobileSidebarNavigation.tsx:131-134`）：
  `sidebar:mobile_drawer.section_study`（fallback '学习'）/
  `sidebar:mobile_drawer.section_manage`（fallback '管理'）——本轮缺键补齐对象，见 §4。
- 去重契约（两层，均基于 `canonicalizeView` 归一化）：① 指向当前视图的入口
  不渲染（页内工具已提供）；② createNavItems 与手工追加项按 canonical view
  首见保留。由 `src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx`
  锁定（9 用例：当前视图隐藏 ×3、集合去重 ×3、settings footer 拆分 ×2、
  onNavigate 透传 settings ×1）。
- 抽屉形态：`MobileSlidingLayout` 统一滚动抽屉 = 页内工具（`sidebar` prop）
  在上 + `MobileSidebarNavigation embedded hideSettings` 在下（同一
  CustomScrollArea 内），settings 以 `settingsOnly` 固定在抽屉 footer
  （border-t + 底部安全区）。`MobileUnifiedDrawerProvider` 向页内 sidebar
  广播「已嵌入统一抽屉」。导航直连经 `MobileAppNavigationContext`（P1-7），
  守卫拦截返回 false 时抽屉保持展开；无 Provider 时回退
  `APP_EVENTS.MOBILE_APP_NAVIGATE` 全局事件。导航后收抽屉，settings 例外
  （Sheet 叠加、保留原抽屉上下文，`closeSidebarAfterAppNavigation`）。

## 3. reachability / back 契约现状

`tests/vitest/mobile-uiux/mobileReachabilityContract.test.ts`（只读核验，未执行）：

- 三桶模型：① 抽屉（config/navigation 共享项 + MobileSidebarNavigation 手工项）
  ② 命令面板（`deps.navigate('view')`）③ 上下文/DEV allowlist
  （pdf-reader、template-json-preview、sandbox-workbench、crepe-demo、
  chat-v2-test、llm-playground —— 6 项，与 CurrentView 现存视图核对无过期条目）。
- 静态推演：抽屉桶覆盖 chat-v2 / learning-hub / todo / skills-management /
  task-dashboard / template-management / ui-lab / settings / dashboard /
  data-management（10），allowlist 覆盖其余 6，**16/16 无孤岛视图**；
  `view: 'dashboard' as CurrentView`、`view: 'data-management' as CurrentView`
  两条 F1 断言的源码锚点仍在（`MobileSidebarNavigation.tsx:87,92`）。
- back 契约（`androidBackCoordinator.ts`，只读核验、未重写）：优先级
  overlay(100) → Radix Escape 兜底探测（夹在 overlay 与更低档之间，保证
  「先关浮层再退页面」）→ view(50) → navigation(0)，同优先级栈语义
  （后注册先执行）；全部消费失败 → native `moveTaskToBack`。
  `MobileSlidingLayout.tsx:645-653` 以 overlay 档注册「非中屏收回主视图」
  handler，带 `isActiveViewLayer` 可见性守卫（保活隐藏层不抢返回键）；
  调用方契约注释明示：回调必须真正派生回 'center'，否则死循环（ChatV2
  沙箱锁定场景需同步重置）。touchcancel 路径只回弹不提交切屏，避免
  Android 10+ 系统返回手势与前端切屏双重响应。
- `SKIP_IN_HISTORY` 当前为空集，历史栈上限 200，无中转视图污染历史。

其余两个契约测试（列清单，均未执行）：
- `deprecatedMobileHeaderBanContract.test.ts`：封禁旧版自绘 `MobileHeader`
  （barrel 不导出 / 全仓禁 import 与 JSX 渲染 / `data-mobile-shell="header"`
  打点唯一来源 = UnifiedMobileHeader）。核验：`MobileHeader.tsx` 文件头
  @deprecated 注释与豁免名单一致，现状合规。
- `inputBarSplitI18nKeys.contract.test.ts`：拆分输入栏字面量 i18n 键双语可解析
  （与本轮壳导航无交集，属 Composer 拆分范围）。

## 4. 缺键补齐说明（legacy: v0.9.44 既有债，非 0824 回归）

**归因**：`MobileSidebarNavigation.tsx:132-133` 自引入「学习/管理」分组起即引用
`sidebar:mobile_drawer.section_study` / `section_manage`，但两份 locale 的
`mobile_drawer` 只有 `section_app` / `section_chat` / `section_learning`
（zh-CN/en-US 同缺）。属 **v0.9.44 既有债（P6）**，非 0824 分支回归。
现网症状：i18next 解析失败后走 t() 第二参 fallback，zh/en 一律显示中文
「学习」「管理」——en-US 用户看到未翻译的中文分区标题。

**改动（仅 2 个文件，允许清单内）**：
- `src/locales/zh-CN/sidebar.json` `mobile_drawer` 增加
  `"section_study": "学习"`、`"section_manage": "管理"`；
- `src/locales/en-US/sidebar.json` `mobile_drawer` 增加
  `"section_study": "Study"`、`"section_manage": "Manage"`。

既有 `section_app` / `section_chat` / `section_learning` 与其他键均未动
（`section_learning` 仍被 `DstuAppLauncher.tsx:379` 消费，`section_chat`
被 SessionSidebarContent 测试桩引用，`section_app` 当前无消费者但按指令保留）。
两份 JSON 已用 python3 json.load 校验语法。`git status` 确认仅这 2 个文件改动。

**未改 MobileSidebarNavigation.tsx 的 fallback**：新键 zh 值与 fallback
字符串逐字一致（'学习'/'管理'），en 值为其正译，无语义冲突——按指令默认只补 JSON。

## 5. 五条统一规范对壳本身的核验

对照 `docs/dev/mobile-uiux-unify/README.md` 验收口径，逐条核验壳层文件本身：

1. **全局顶栏唯一** ✅：`data-mobile-shell="header"` 打点仅存在于
   `UnifiedMobileHeader.tsx:109`（封禁契约锁定唯一来源）；旧 `MobileHeader`
   已出 barrel、仅存文件供迁移基线测试；子屏顶栏经 SubviewChrome 栈并入宿主
   配置，不产生第二条顶栏。
2. **左侧按钮语义** ✅：`UnifiedMobileHeader.tsx:61-73` 互斥决策链
   showBackArrow（页内返回）> showMenu（☰ 呼出侧栏）> 全局历史返回/前进；
   前进按钮槽位保留策略防标题横向跳动；floatingMenuButton 分支供聊天空态。
3. **右侧 ≤2 动作、≥44px** ✅（约定层面）：`UnifiedMobileHeader.tsx:197-200`
   与 `MobileHeaderConfig.rightActions`、`MobileSubviewChrome.rightActions`
   三处注释同约束；壳自身按钮走 `shellIconButtonClassName` +
   `min-w-[var(--touch-target-size)]`。壳无溢出收纳机制——超限属页面责任，
   壳层无静态强制手段（无契约测试计数 rightActions 子节点），维持约定现状。
4. **禁桌面组件滥用** ✅（壳内）：壳层无 ResizablePanel/宽表/hover-only；
   `data-tauri-drag-region` 仅非移动平台（桌面窄窗口）挂载，避免干扰触摸；
   抽屉行样式 `mobileDrawerStyles.ts` 复用桌面 token（desktop-shell-nav-row 系）
   但为移动 44px 触控行（min-h-[2.75rem]），属样式同源而非组件滥用。
5. **可达且可回退** ✅：三桶 16/16 可达（§3）；回退三通道齐备——顶栏返回
   （全局历史/页内箭头）、系统返回键（coordinator 分档 + 抽屉/右屏 overlay
   handler）、手势（三屏滑动 + 遮罩点击 + fling，touchcancel 不误提交）。
   已知局限已在源码注释登记：Android 10+ 手势导航边缘热区抢占（缓解：
   touchcancel 只回弹；所有手势目标均有按钮兜底入口）。

**明确不重写 mobileShell 底座**：`src/app/shell/mobileShell.ts`（安全区
CSS 变量 + 顶栏高度 token，47 行）职责单一、被 UnifiedMobileHeader /
MobileSlidingLayout 经 CSS 变量间接消费，本轮零改动、亦无重写必要。
`MobileLayoutContext`（isMobile + 全屏 claim 集合）、`MobileDrawerContext`
（统一抽屉布尔广播）同为最小完备，未动。

## 6. 改动清单汇总

| 文件 | 改动 | 归因 |
|---|---|---|
| `src/locales/zh-CN/sidebar.json` | mobile_drawer 增 section_study/section_manage | legacy: v0.9.44 P6 缺键 |
| `src/locales/en-US/sidebar.json` | mobile_drawer 增 section_study/section_manage | legacy: v0.9.44 P6 缺键 |

其余只读清单文件（含 androidBackCoordinator、mobileShell、五个 layout 组件、
dedup 测试、docs、契约测试）均零改动。未 commit，待父代理统一提交
（建议提交信息注明 `legacy(i18n)` 归因，非 0824 回归）。
