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
| [BLOCK_RENDERING_GUIDE](./BLOCK_RENDERING_GUIDE.md) | 块渲染/互动/持久化开发者参考手册：Block 类型体系、插件注册、事件系统、工具块渲染、扩展指南 |
| `core/types/common.ts` | Block/Session 类型定义（SSOT） |
| `plugins/` | 模式、块渲染、事件处理器插件目录（import 即注册） |

> 历史设计文档（01-可复用清单 ~ 05-多会话管理、架构图系列）已随项目演进移除；当前架构以本 README + BLOCK_RENDERING_GUIDE 为准。

---
