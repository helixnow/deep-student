model=gpt-5.6-sol-xhigh-fast
# 43 — Todo 主路径与 0824 归并面

- 对照基座：`origin/cursor/0824-cde6` @
  `2d41ea8baca24e96ef02770a3a9b56ec0b87043d`。
- 范围：Todo 的独立页 / Workbench 入口、主列表 CRUD、前后端命令链，以及
  0824 已记录的归并冲突；纯静态核对，未运行测试。

## 结论

**WARN（主路径闭环；0824 历史内容冲突已裁决，当前终树没有未解决的 Todo
归并冲突；但用户 UI 主写路径没有启用已存在的 OCC 令牌）。**

1. 独立页与 Workbench 没有形成两套产品实现：独立页由
   `src/App.tsx:1959-1965,2003-2017,2854-2855` 接入 Todo 专属侧栏和
   `LazyTodoPage`，再经 `TodoPage.tsx:8-13` 进入 `TodoContentView`；
   Workbench 把 Todo 注册为单实例应用
   （`src/features/workbench/apps/system/register.tsx:208-219`），
   `TodoAppWindow.tsx:207-229` 仍复用同一个 `TodoContentView`。因此导航壳虽有
   legacy / Workbench 两种承载，状态与内容主路径只有一份。
2. 数据链完整：`TodoMainPanel.tsx:309-329,1039-1053,1092-1226` 把快速新增、
   行操作、筛选及详情接到 `useTodoStore`；store 的加载、乐观写、定向回滚和
   静默校准见 `useTodoStore.ts:467-521,683-720,722-903`；API 统一经
   `api.ts:117-144` 包装 Tauri invoke，核心 CRUD 对应
   `api.ts:150-268`；命令在 `src-tauri/src/lib.rs:2330-2366` 注册，经
   `todo_handlers.rs:367-487` 落到 `VfsTodoRepo`。新增、更新、完成、软删除、
   重排及跨清单移动均能沿同一链到达数据库层。
3. 0824 的 Todo 冲突是**历史上真实发生、现已解决的内容冲突**，不是当前待
   处理冲突：`docs/0824-MERGE-PLAN.md:441-443` 记录 G 合入时共 52 处冲突；
   `:478-484` 明确把 `TodoMainPanel` 归入 13 个 F 交叠项，并以
   `step3-fg` 终态保留“返回键保活可见性守卫 ×2 + coarse 热区”。当前
   `TodoMainPanel.tsx:363-376` 的多选返回守卫、`:905-991` 的 44px 工具栏
   热区，以及同文件 `MobileDetailOverlay` 的
   `:125-137` 可见性守卫均在位，说明裁决没有在终树丢失。
   MERGE-PLAN `:536-548` 还记录含 todo 的联合门禁 34 文件 321/321 通过。
   所以相对指定的 0824 终树没有再归并 Todo 产品 patch 的必要。
4. WARN 来自主写路径的并发契约未真正接通：类型已提供
   `expectedUpdatedAt`（`types.ts:106-125`），toggle API 也能透传该令牌
   （`api.ts:244-250`），后端在
   `todo_repo.rs:1538-1557,1953-1982` 会据此返回冲突；但 store 更新仍把
   原始 `input` 直接交给 API（`useTodoStore.ts:725-742`），完成切换也只传
   `itemId`（`:778-820`）。Todo feature 内没有消费
   `expectedUpdatedAt` 的 UI 调用点。结果是多入口或外部写并发时，普通用户
   编辑仍可能后写覆盖先写；`useTodoStore.ts:44-68` 已准备的 conflict 刷新
   动作在这条主路径上通常不会被触发。

## 归并判断与后续边界

- 对**当前 `origin/cursor/0824-cde6` 终树**：Todo 主路径可保留原样，历史
  `TodoMainPanel` 冲突已经按 0824 裁决收口，不构成新的 merge blocker。
- 对任何未来候选枝：本任务没有提供其 head/SHA，不能据此宣称 Git 会自动
  clean merge；若候选同时修改 `TodoMainPanel`，必须保住上述返回守卫与
  coarse 热区。
- OCC 后续修复不能只机械补一个旧 `updatedAt`：同条目连续 blur 写可能共享
  同一旧版本并互相冲突，应连同逐条目串行/合并写与冲突后权威重载一起设计。

需要后续产品修复 OCC 主路径，但不阻塞 0824 当前归并。**本轮不改代码**。
