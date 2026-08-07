# ACR 4.5 — 覆盖深化轮（协调者章程）

状态：已完成（2026-07-20）。5 个子代理两波并行落地 + 协调者静态验收通过（见 §5）；
本文件是 4.5 轮次的契约真相源与分工表。
背景：4.0 已达成「广度全覆盖」（全部注册应用有 manifest）；本轮按覆盖缺口调研
（见对话记录 / ACR-4.0.md §4 之后的缺口清单）深化四个高价值面 + 小补齐。

## 0. 目标

1. **A45-1 templates CRUD**：模板应用从「只读+定位」升到「全写」——创建/重命名/
   编辑内容/删除，走前端 store（features/template-management/stores）真实落库路径；
   删除 high 风险；可逆操作注册 undo inverse；OCC/revision 校验遵循 manifest 惯例。
2. **A45-2 taskDashboard 任务操作**：制卡任务面板从只读升到可操作——重试失败任务、
   取消进行中任务（如域支持）；不伪造「创建任务」能力（创建入口在 chat 制卡流，
   若域无独立创建 API 则诚实不提供）。
3. **A45-3 desktop 全局搜索**：desktop 虚拟目标新增 `globalSearch` 能力——复用
   `search/globalSearchProviders.ts` 的 apps/commands/dstu/chat 四个 provider，
   查询结果结构化返回给 agent（read 级）；可选 `openSearchResult`（按 ref 打开）。
4. **A45-4 desktop Dock 编排**：`pinApp` / `unpinApp` / `reorderDock`——复用
   `components/DockPinnedStore.tsx`（getDockPinned/setDockPinned/toggleDockPinned/
   reorderDockPinned）；整体固定区快照 undo（对齐 tileWindows 布局快照惯例）。
5. **A45-5 内容窗/chat 小补齐**：image 内容窗能力补齐（视 UI 真实能力：适配模式/
   旋转等，只暴露真可用项）；chat `scrollToMessage` 虚拟化长会话（>80 条）失效修复
   （chat/register.ts 已有注释标记的已知遗留）。

## 1. 分工与文件所有权（并行防冲突硬边界）

| 代理 | 波次 | 独占文件/目录 |
|---|---|---|
| A45-1 templates | 第一波 | `apps/system/agentManifests.ts` **templates 段**；新文件 `apps/system/templatesAgentActions.ts`（如需）；`features/template-management/**`（只读调用优先，确需改动最小化）；`apps/system/__tests__/templatesAgentManifest.test.ts`（新） |
| A45-3 desktop 搜索 | 第一波 | `apps/desktop/agentManifest.ts` **搜索能力段**（文件尾部追加，勿动既有能力）；`search/globalSearchProviders.ts` 只读调用；`apps/desktop/__tests__/desktopGlobalSearch.test.ts`（新） |
| A45-5 内容窗/chat | 第一波 | `apps/content/agentManifests.ts` **image 段**；`apps/chat/{register.ts,agentManifest.ts}` scrollToMessage 相关行；`features/chat/` 消息列表虚拟化滚动 API（agent 相关行）；相应 __tests__ 新文件 |
| A45-2 taskDashboard | 第二波 | `apps/system/agentManifests.ts` **taskDashboard 段**；`features/anki-tasks/**`（agent 接入相关行）；`apps/system/__tests__/taskDashboardAgentManifest.test.ts`（新） |
| A45-4 Dock 编排 | 第二波 | `apps/desktop/agentManifest.ts` **Dock 能力段**；`components/DockPinnedStore.tsx` 只读调用（确需导出新辅助函数可追加）；`apps/desktop/__tests__/desktopDockOrchestration.test.ts`（新） |

第二波在第一波全部完成后启动（A45-1/2 同文件、A45-3/4 同文件，物理上不并行）。
i18n：各代理在 `src/locales/{zh-CN,en-US}/workbench.json` 追加自己前缀的 key
（`agent.apps.<scope>.*`），两语成对；不改他人 key。

## 2. 统一纪律（本轮特别约束）

- **禁止运行任何 node / npm / npx / tsc / vitest / cargo / tauri 命令**。
  测试**只写不跑**；自验靠静态走查（协调者统一静态检查收尾）。
- 只改名下文件；跨界需求写进进度报告「跨界申请」节，不直接动手。
- 回执诚实：no-op 必须 `changed:false`；能力表只报真可用（UI 做不到的不暴露）；
  不可撤销就不注册 inverse；所有兜底/降级写进回执 message。
- undo：High 敏感度、每次确认；inverse 用 manifest `undo.inverse` 结构
  （参考 desktop tileWindows / chat setInput 的既有写法）。
- 风险分级：读/定位 = read/low；改视图态 = low；改域数据 = medium；
  删除/不可逆 = high。`mutates`/`reversible`/`idempotent` 如实标注。
- 演出：新增实体反馈沿用 `data-agent-entity="{typeId}:{id}"` + `agentFlash`；
  动画只动 transform/opacity，reduced-motion/forced-colors 全路径。
- 注释中文、文件头标注任务 ID（如 `A45-1`）与本文件路径。
- 完成后写 `docs/dev/acr/progress/A45-<n>.md`（模板见 STANDARDS.md §6，
  自验一栏如实写「静态走查，未运行测试（本轮约束）」）。

## 3. 验收（协调者）

全部代理完成后由协调者做**纯静态检查**：diff 走查、类型/导入正确性目测、
i18n 两语 key 成对核对、能力表与 UI 真实能力对照、undo/风险分级契约核对。
不运行 typecheck/vitest/cargo（用户明确要求）；动态验证遗留给后续有实测条件时。

## 4. 验收记录（各代理回填）

- A45-1：已完成——templates 段新增 createTemplate/renameTemplate/updateTemplateContent（medium、可逆带 inverse）与 deleteTemplate（high、不可逆不注册 inverse，自定义物理删除/内置停用墓碑如实回执），写路径走 templateManager 真实落库 + updatedAt/version 双层 OCC；单测只写未跑（本轮约束），详见 progress/A45-1.md。
- A45-2：已完成——taskDashboard 段新增 retryTask/retryFailedTasks（medium）与 cancelSession（high），全部不可逆不注册 inverse，写路径与 UI 同走 taskControl 门面（trigger_task_processing / cancel_document_processing）；observe 补会话状态令牌 + 焦点会话失败分段实体（旧形状表面诚实降级）；域无独立创建 API，不提供创建能力（证据见 progress/A45-2.md）；单测只写未跑（本轮约束）。
- A45-3：已完成——desktop 追加 `globalSearch`（read，复用 ⌘K 四 provider、3s 超时结构化失败）与 `openSearchResult`（medium，app/dstu/chat/command 分派、壳依赖命令结构化拒绝），observe 增补 searchAvailable；单测已写未跑（本轮约束），详见 progress/A45-3.md（含旧 desktop 契约测试断言需协调者更新的跨界申请）。
- A45-4：已完成——desktop 追加 pinApp（low）/unpinApp（medium）/reorderDock（low，typeId+toIndex 形态），全走 DockPinnedStore 真实函数，undo 为固定区整体快照（已声明能力组合恢复 + state_equals dockPinned 断言），observe 按固定区状态收敛三动作；旧契约测试能力全集断言已更新为 13 能力（含 A45-3 的 2 个，兼容 globalSearch mutates:false），新单测只写未跑（本轮约束），详见 progress/A45-4.md。
- A45-5：已完成——image 新增 rotate（90/180/270，反向 undo，未挂载/未加载诚实失败；平移与保存到本地经调研不暴露），chat scrollToMessage 改走 MessageList 注册的 scrollToIndex handle（虚拟化 >80 条可达，行挂载后 flash，失败结构化 code/hint），三份单测只写未跑（进度报告 progress/A45-5.md）。

## 5. 协调者静态验收（2026-07-20，本轮禁 node/cargo，纯静态）

- **走查范围**：全部 5 个代理名下改动（manifest 段、执行器新文件、锚点/表面接线、
  8 个新测试文件、旧 desktop 契约测试断言更新、i18n、进度报告）。
- **结论：通过，无阻断问题。** 关键核对项：
  - `apps/system/agentManifests.ts` A45-1/A45-2 两段共存无互相覆盖，imports 干净，
    写路径均经独立执行器文件动态 import 真实域门面（templateManager / taskControl，
    后者命令名与 `features/anki/taskControl.ts` 实际 invoke 一致）；
  - `apps/desktop/agentManifest.ts` A45-3/A45-4 段隔离良好；旧契约测试能力全集
    断言已更新为 13 项且兼容 globalSearch mutates:false（A45-3 跨界申请已闭环）；
    globalSearch 的 AbortController 超时/外层 signal 级联/部分降级路径实现正确；
  - chat：messageListScrollRegistry 注册/防误删、MessageList 三种渲染分支均挂
    `data-agent-entity="chat:{id}"` 锚点、`data-wb-chat-session` scope 属性存在
    （ChatV2Page）、register.ts 失败结构化三码齐全；
  - image：rotate 落点与工具栏同一条 setRotation 路径，activation 通道误入给指路
    回执不假成功；
  - i18n：zh-CN/en-US workbench.json 扁平 key 集**完全一致**（脚本核对 0 单侧 key）；
  - IDE 诊断：全部实现文件与测试文件 0 lint 错误；
  - 进度报告 A45-1..5 齐全，§4 验收记录五条齐全。
- **协调者裁决（风格分歧）**：undo label 的 i18n 惯例——A45-1（system 侧）走
  workbench ns 两语 key，A45-4（desktop 侧）跟随 tileWindows 文件内硬编码中文先例。
  接受现状：desktop manifest 整文件同一惯例优先，跨文件统一留给后续 i18n 清理轮。
- **动态验证遗留**（有实测条件后执行）：`npm run typecheck`、新增 8 个测试文件
  实跑、`check:i18n`、desktop 13 能力契约测试回归。
