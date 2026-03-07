# 代码风格规范

## 1. 通用规范

| 项目 | 要求 |
|-----|------|
| 错误处理 | 统一使用 `getErrorMessage`，杜绝 `[object Object]` |
| 主题模式 | 考虑暗色/亮色模式，为全局切换打好基础 |
| 向后兼容 | 大规模迭代不做兼容，通过数据库迁移实现 |

## 2. 国际化 (i18n)

- 所有前端功能必须接入 i18n，中英文翻译完整
- 翻译键与代码引用的命名空间一一对应
- `en-US` 与 `zh-CN` 结构完全一致
- 提交前运行 i18n 检查脚本确认无缺键

## 3. React 组件

### 3.1 命名规范

| 类型 | 规则 | 示例 |
|-----|------|------|
| 组件文件 | PascalCase | `ChatContainer.tsx` |
| Props 接口 | PascalCase + Props | `InputBarProps` |
| Hook | camelCase + use | `useSessionStatus` |
| 事件处理 | handle 前缀 | `handleCopy` |
| 回调 Props | on 前缀 | `onCopy` |

### 3.2 文件结构

```typescript
// 1. React 核心
import React, { useCallback, useState } from 'react';
// 2. 第三方库（按字母序）
import { useTranslation } from 'react-i18next';
// 3. @/ 路径别名
import { cn } from '@/utils/cn';
// 4. 相对路径
import { useSessionStatus } from '../hooks';

// ============================================================================
// Props 定义
// ============================================================================
interface ComponentProps { ... }

// ============================================================================
// 组件实现
// ============================================================================
export const Component: React.FC<ComponentProps> = () => { ... };
export default Component;
```

### 3.3 条件渲染

优先 Early Return：`if (loading) return <Loading />;`

## 4. Tailwind CSS

必须使用 `cn()` 合并类名，使用 `cva` 管理组件变体：

```typescript
import { cn } from '@/utils/cn';
className={cn('base', isActive && 'bg-primary', className)}
```

> **注意**：项目中存在两个 `cn()` 实现：
> - `@/utils/cn`（推荐）：使用 `twMerge + clsx`，能正确处理 Tailwind 类名冲突
> - `@/lib/utils`（历史遗留）：仅做简单拼接，**不支持** Tailwind 类名合并
>
> 新代码必须使用 `import { cn } from '@/utils/cn'`。

## 5. 组件使用规范

### 5.1 CustomScrollArea

- 间距放入 `viewportClassName`，外层容器贴紧右缘
- **父容器必须有固定高度**，否则滚动失效

```tsx
<div className="h-[200px]">
  <CustomScrollArea className="h-full">{/* 内容 */}</CustomScrollArea>
</div>
```

### 5.2 移动端布局

配置常量：`src/config/mobileLayout.ts`

| 项目 | 规范值 |
|-----|-------|
| 顶部导航栏 | 56px |
| 底部 TabBar（带标签） | 56px |
| 底部 TabBar（无标签） | 48px |
| 最小点击区域 | 32px |
| 触摸反馈 | `active:scale-95 active:opacity-80` |
| iOS 安全区 | `env(safe-area-inset-*)` |

三屏滑动布局使用 `MobileSlidingLayout`（`src/components/layout/MobileSlidingLayout.tsx`）

## 6. Rust 后端

### 6.1 命名规范

| 类型 | 规则 |
|-----|------|
| 函数 | snake_case |
| 结构体/枚举 | PascalCase |
| 模块 | snake_case |

### 6.2 错误处理

```rust
#[derive(Debug, Error, Serialize)]
pub enum ChatV2Error {
    #[error("Session not found: {0}")]
    SessionNotFound(String),
}
pub type ChatV2Result<T> = Result<T, ChatV2Error>;
```

### 6.3 数据库

| 场景 | 要求 |
|-----|------|
| 字段修改 | 实现自动迁移函数 |
| 并发访问 | 获取锁后用 `_with_conn` 方法，避免死锁 |

## 7. 日志规范

| 环境 | 格式 |
|-----|------|
| Rust | `[Module::function] message` |
| React | `[ComponentName] message` |
