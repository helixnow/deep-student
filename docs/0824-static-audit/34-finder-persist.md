# 34 — Step 18 复核：Finder/Workbench 持久化加固与 Composer 旧状态归一化

- 基座：`origin/cursor/0824-cde6` @ `2d41ea8b`。本审计枝工作树的产品代码
  （`src/`、`src-tauri/`、`tests/`）与基座 `git diff` 为空，以下行号即基座行号。
- 审计对象：MERGE-PLAN Step 18 落地的两个提交
  - `e24b828d` fix(storage): harden finder and workbench upgrades（源 `9176740b`）；
  - `67a7fdf8` fix(chat): normalize legacy composer state（源 `0a6344e1`）。
- 源 SHA `9176740b`/`0a6344e1` 属 `cursor/0824-rel-finder-cde6`，本 VM 未取该枝、
  对象不可达；等价性以 MERGE-PLAN Step 18 记录为准。两提交已在基座落地，
  **不需要也不建议回放这两个源 SHA**。
- 方法：只读静态审计，未装 node_modules、未跑 vitest/cargo（遵循本仓
  「不做 Tauri 实机编译」约定）；MERGE-PLAN 记录 Step 18 落地时
  typecheck / vite build / cargo check 均 exit 0。

## 1. Finder 视图偏好白名单（`e24b828d` 前端部分）

`src/features/learning-hub/stores/finderStore.ts`：

- 白名单集合与类型定义逐项一致：`ViewMode`/`SortBy`/`SortOrder`
  （22–26 行）↔ `FINDER_VIEW_MODES`/`FINDER_SORT_FIELDS`/`FINDER_SORT_ORDERS`
  （444–446 行），无漏项无多项（含 `columns` 视图与 `size` 排序）。
- `sanitizeFinderViewPreferences`（459–475 行）逐字段校验：三个枚举走
  `Set.has`，`quickAccessCollapsed` 要求 boolean；非 record（含数组、null）
  返回 `{}`。旧数据里的 `currentPath` 等非偏好键天然被丢弃。
- 两条读取路径共用同一白名单，无旁路：
  - eager seed：`readPersistedPreferences`（477–496 行）解析
    `parsed.state` 后过白名单，空结果返回 null → `resolveInitialViewPreferences`
    （504–515 行）回落旧单例 key（`learning-hub-finder`，380/421–424 行），
    继承逻辑未被破坏；
  - Zustand 二次水合：persist `merge`（1246–1249 行）用同一
    `sanitizeFinderViewPreferences` 覆盖默认浅合并，防止被拒字段经水合
    重新注入。
- `partialize`（1237–1242 行）仍只写 4 个偏好字段，写面未扩大。persist
  无 `version`/`migrate`：历史只写过 version 0（Zustand 默认），白名单
  merge 已覆盖坏值场景，无需版本迁移。
- 测试：`tests/vitest/learning-hub/finder-host-buckets.test.ts` 新增
  「结构合法但字段类型非法只保留合法字段」（239–247 行）与
  「version 0 坏载荷不经水合回注、`currentPath.folderId` 保持 null」
  （249–274 行）两例，断言与实现语义吻合。

## 2. Workbench 壁纸 / 平铺边距容错解析（`e24b828d` 其余部分）

`src/features/workbench/core/persistedSettings.ts`（新增，76 行）：

- `parseRecord` 同时接受字符串 JSON（settings 后端 / localStorage 回退）
  与对象（`workbench:settings-changed` 事件载荷），坏 JSON / 非 record /
  数组一律回落。
- `parsePersistedWallpaper`（33–62 行）：`kind` 仅收 `theme|image`，
  `value` 必须非空字符串；image 的 `imageBlur` clamp 0–40、`imageDim`
  clamp 0–0.6、`imageVignette` 仅收 boolean——与消费端
  `WallpaperLayer.resolveImageAdaptation` 的钳制（`WallpaperLayer.tsx`
  123–131 行：0–40 / 0–0.6 / `!== false`）完全一致，也与
  `WallpaperConfig` 类型注释（23–32 行）一致；未知注入字段被丢弃。
- `parsePersistedTileMargins`（65–75 行）：`enabled` 仅收 boolean，`px`
  clamp 0–32，与设置页 `TILE_MARGIN_MIN=0`/`TILE_MARGIN_MAX=32`
  （`WorkbenchSettingsSection.tsx` 107–108 行）及输入框钳制（619 行）一致。
- 读路径全覆盖，旧的缺陷解析器已删除：
  - `WorkbenchDesktop.tsx`：启动回放（322–323 行）与
    `settings-changed` 热更新（339–343 行）均改走新解析器，原
    `parseJson` 浅合并（`{...fallback, ...parsed}` 会让
    `px:'wide'`、`value:123` 之类的坏字段直接进入 state）已移除；
  - `WorkbenchSettingsSection.tsx`：启动回放（246–248 行）同改，原
    `parseJsonSetting` 已删除；
  - 其余触碰 `desktop.workbenchWallpaper` 的面板均为**写侧**：
    `DesktopContextMenu.tsx`（564 行）与 `WallpaperManagerDialog.tsx`
    （134 行）只 `JSON.stringify` 良构对象；对话框的当前壁纸来自
    `WorkbenchDesktop` 已解析的 prop（`WallpaperManagerDialog.tsx`
    110–119 行），无未加固的 JSON 读点。
- 测试：`tests/vitest/workbench/workbench-persisted-settings.test.ts`
  4 例覆盖 v0.9.44 合法值保真、坏形状回落、可选适配字段独立钳制、
  边距字段级默认/钳制，断言与实现一致。

## 3. Composer 旧状态归一化（`67a7fdf8` 前端部分）

- `src/features/chat/core/store/composerStateMigration.ts`（新增）：
  `normalizeRestoredComposerState` 以 `createDefaultPanelStates()` 起底，
  仅接收 `COMPOSER_PANEL_KEYS` 中 boolean 值；`inputValue` 非字符串归空
  （防 `{text:...}` 之类坏导入在渲染路径炸 `.trim()`）。
  `COMPOSER_PANEL_KEYS`（`types/common.ts` 89–95 行，
  `satisfies readonly (keyof PanelStates)[]`）与 `PanelStates` 接口
  （76–87 行）同为 mcp/model/advanced/attachment/skill 5 键，退役的
  rag/search/learn 幽灵键被丢弃，语义与 76 行处注释一致。
- `src/features/chat/core/store/restoreActions.ts`：705 行是恢复路径的
  **唯一**面板/草稿入口（原地内联的过滤循环已删除并收敛进纯函数）；
  887–889 行 `liveStateAdvanced` 时保留实时输入框的保护逻辑原样保留，
  927 行落 store。写侧 `setPanelState`（`sessionActions.ts` 308–322 行）
  与会话初始化（456 行）只产出 5 布尔键，store 内不变量闭环。
- 测试：`composerStateMigration.test.ts` 4 例覆盖 v0.9.44 含退役键载荷、
  部分缺键补默认、非法类型拒收、null/数组/标量载荷不抛异常。

## 4. Rust `PanelStates` 兼容（`67a7fdf8` 后端部分）

`src-tauri/src/chat_v2/types.rs`：

- 新增 `skill: Option<bool>` 带 `skip_serializing_if`（3021–3023 行）。
  struct 无 `deny_unknown_fields`，且 serde 对 `Option` 字段缺失时内建
  默认 None（不需 `#[serde(default)]`）——v0.9.44 旧行缺 `skill` 可反序列化，
  新行多 `skill` 亦可，双向兼容；单测
  `test_panel_states_accepts_v0944_shape_missing_skill` /
  `test_panel_states_round_trips_current_skill_panel`（3107–3138 行）
  锁定该行为。
- 遗留 rag/search/learn 字段保留为 `Option`（2993–3007 行）只为读旧行；
  前端保存的新载荷不含这三键 → 反序列化为 None →
  `skip_serializing_if` 使其在首次重存后自然清除，与前端过滤方向一致。
- 读写路径容错：`repo.rs` 读取 `from_str(...).ok()`（2481–2483 行，
  坏 JSON 归 None 不报错），写入 `to_string` 幂等 upsert（2392–2407 行）。
- `PanelStates::default()`（3026–3039 行）仍含 rag/search/learn
  `Some(false)`，全树仅测试构造使用（`repo.rs` 5839 行，测试段），
  即便序列化出这三键，前端恢复时也会丢弃，无产品影响。

## 5. 记录事项（非缺陷，不要求修复）

1. `WorkbenchDesktop` 热更新对**非法**壁纸事件载荷的行为由「忽略」
   变为「回落默认壁纸」（339–343 行）。事件全部来自内部合法派发方
   （设置页 / 右键菜单 / 壁纸面板均派发良构对象），实际不可达，仅记录
   语义变化。
2. `parsePersistedWallpaper` 对 `kind:'theme'` 丢弃 imageBlur/imageDim/
   imageVignette——主题壁纸本就不消费这些字段，符合预期。
3. finder persist 不设 `version`/`migrate`；如未来偏好形状破坏性变更，
   应届时补版本号，本轮无此需求。

## 结论

**PASS。**

- Step 18 两提交（`e24b828d`/`67a7fdf8`）在基座 `origin/cursor/0824-cde6`
  @ `2d41ea8b` 上落地完整：Finder 偏好双读取路径共用同一字段白名单、
  Workbench 壁纸/平铺边距的全部 JSON 读点收敛到容错解析器且钳制范围与
  消费端/设置 UI 一致、Composer 恢复丢退役键补默认值、Rust `PanelStates`
  对缺失/新增 `skill` 双向兼容，各自带定向测试，未发现旁路读点或
  白名单漏项。
- 不需要产品修复；第 5 节三项仅记录。
- 不建议回放 `9176740b`/`0a6344e1`：二者已分别以 `e24b828d`/`67a7fdf8`
  等价落地。
- **本轮不改代码**：本文件为本次任务唯一产物。
