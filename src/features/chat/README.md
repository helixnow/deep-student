# Chat V2 - 从零开始的干净聊天模块

## 设计目标

1. **统一 Store**：单一 SSOT，消除双层同步
2. **全新实现**：不依赖旧代码，确保架构干净
3. **性能优先**：Map + 顺序数组，O(1) 查找，细粒度更新
4. **块系统**：消息由独立块组成，thinking 置顶，其他按到达顺序
5. **操作正交**：状态机 + 操作守卫，确保操作互不干扰
6. **插件化**：新增功能只加插件文件，不改核心代码
7. **全量持久化**：所有会话配置持久化，从全局配置复制默认值
8. **核心极简**：核心 Store 不含业务类型，`features` 和 `modeState` 通用化

---

## 核心原则：插件化架构

```
新增模式    → 只加 plugins/modes/newMode.ts      → 不改核心
新增块类型  → 只加 plugins/blocks/newBlock.tsx   → 不改核心
新增事件    → 只加 plugins/events/newEvent.ts    → 不改核心
```

**绝不出现**：加一个插件需要改 Store、改 BlockRenderer、改 eventBridge、改类型定义。

---

## 文档索引

| 文档 | 说明 |
|------|------|
| [01-可复用清单](./docs/01-可复用清单.md) | 可复用的组件、工具、样式、类型 |
| [02-完整架构](./docs/02-完整架构.md) | 插件化架构图、目录结构、扩展流程 |
| [03-数据契约](./docs/03-数据契约.md) | 类型定义、块系统、插件接口、SSOT |
| [04-实现阶段](./docs/04-实现阶段.md) | 会话模式、实现优先级、插件开发指南 |
| [05-多会话管理](./docs/05-多会话管理.md) | SessionManager、LRU 缓存、并行流式 |

### 架构文档 (最新)

| 文档 | 说明 |
|------|------|
| [整体架构图](./docs/architecture/整体架构图.md) | 前后端整体架构、数据流、插件扩展点 |
| [前端架构图](./docs/architecture/前端架构图.md) | Store、Hooks、Components、中间件、适配器 |
| [后端架构图](./docs/architecture/后端架构图.md) | Pipeline、Handlers、Events、Repo、Adapters |
| [数据结构图](./docs/architecture/数据结构图.md) | 类型定义、前后端对齐、数据库 Schema |

---
