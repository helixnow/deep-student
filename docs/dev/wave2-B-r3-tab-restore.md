# 0824 Wave2-B 第 3 轮 — 标签恢复 P8（LearningHubPage 持久化/恢复段）

- 角色：实现员-标签恢复（第 3 轮），独占可写 `src/features/learning-hub/LearningHubPage.tsx` 的持久化/恢复段
- 对照锚点：`docs/dev/wave2-B-r1-anchor-hub.md` §2（P8 地图）与 §6 插入点表 P8-1/P8-2/P8-3
- 未触碰：TabPanelContainer、UnifiedAppPanel 加载逻辑、finder host 分桶（Page 顶栏/移动/桌面三处调用点原样）、closeTabGate.ts；第 2 轮 close gate 全部保留

## P8-1：savePersistedTabs 写透缓存

`savePersistedTabs` 现在先更新模块级 `persistedTabsCache` 再写 localStorage（storage 抛异常也不影响缓存）。消除 r1 §2a 的回滚时序：同 renderer 内 Page 卸载重挂时，`useState` 惰性初始化读到的不再是启动时的过期快照，首次持久化 effect 不会再用旧数据覆盖 localStorage。

## P8-2：恢复校验改稳定 resourceId

恢复后的后台校验从 `dstu.get(tab.dstuPath)` 改为 `dstu.get('/' + tab.resourceId)`，与 UnifiedAppPanel 的实际加载键对齐（r1 §2b/§4）。三分支语义：

| 结果 | 处理 |
|------|------|
| 成功 | 标签保留，重绑 `dstuPath = node.path`、`title = node.name`（name 为空时保留旧 title）——移动/重命名不再误删标签 |
| `NOT_FOUND` | 实体确认不存在，删标签（原有活跃标签修正语义不变） |
| 其他错误码（网络/超时/内部） | 保留标签，不凭瞬态错误断定实体已死，由面板加载自行报错 |

## P8-3：OpenTab 版本化白名单解析

- 存储 key 沿用 `learning-hub-tabs-v1`（避免升级即丢历史标签）；payload 写入 `version: 2`。v1（无 version 字段）与 v2 共用同一逐条白名单解析。
- 逐字段策略（`parsePersistedTab`）：
  - **整条丢弃**：`tabId`（激活/分屏引用键）、`resourceId`（恢复与加载键）、`type`（面板类型路由，白名单为 8 个可打开类型，排除浏览筛选值 `all`）任一损坏。
  - **字段修复**：`dstuPath` 损坏 → 回退 `/${resourceId}`；`title` 损坏 → 空串（P8-2 校验后以 node.name 回填）；`openedAt` 非有限数 → `Date.now()`（防污染 LRU 排序，r1 §2c）；`isPinned` 非 `true` → 视为未固定。
- 追加去重：`tabId`（React key / 激活引用）与 `resourceId`（openTab 去重不变量）重复时保留先出现的一条。
- JSON 整体损坏 → 整份回空态，下次保存写入干净的 v2 payload。

## 验证说明

环境无 node_modules 且本轮禁用 npm/vitest，未运行类型检查/测试；改动经人工复读核对（`VfsErrorCode` 自 `@/shared/result` 导入，与库内既有用法一致）。
