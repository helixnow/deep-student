# 代码风格规范

> 前端 UI / 视觉规范（组件选用、设计令牌、交互模式、评审清单）见 [docs/frontend/](./frontend/README.md)。本文与其冲突时以 `docs/frontend/` 为准。

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

### 5.1 ScrollArea

- 统一使用标准滚动组件 `ScrollArea`（`@/components/ui/scroll-area`）；`CustomScrollArea` 已标记 `@deprecated`，新代码不得使用
- 间距放入 `viewportClassName`，外层容器贴紧右缘；**父容器必须有确定高度**（flex 子项加 `min-h-0`），否则滚动失效
- 不要外包自带滚动管理的编辑器或画布（CodeMirror、Crepe/Milkdown/ProseMirror、思维导图画布）；对话框内使用 `DsDialogBody` 的原生滚动
- 禁止手写 `::-webkit-scrollbar`；隐藏滚动条只用 `.scrollbar-none`

```tsx
import { ScrollArea } from '@/components/ui/scroll-area';

<div className="h-[200px]">
  <ScrollArea className="h-full" viewportClassName="p-3">
    {/* 内容 */}
  </ScrollArea>
</div>
```

### 5.2 拖拽上传

所有文件上传拖拽功能**必须**使用统一组件，**禁止**自行实现原生拖拽监听：

| 组件 | 位置 |
|-----|------|
| `UnifiedDragDropZone` | `src/components/shared/UnifiedDragDropZone.tsx` |
| `useTauriDragAndDrop` | `src/hooks/useTauriDragAndDrop.ts` |

禁止：直接使用 `onDragOver`/`onDrop` 处理文件、直接监听 `tauri://drag-*` 事件、读取 `e.dataTransfer.files`、复制统一组件内部逻辑。

原因：Electron 桌面壳层运行在沙箱渲染进程中，Web 原生拖拽 API 无法直接获取本地文件路径，需要经 Electron preload 隔离世界的 `webUtils.getPathForFile` 与预加载 IPC 兼容桥（`electron/preload/preload.ts`、`bridge.ts`）转发；统一组件已封装原生与 Web 拖放去重、可见性检查、文件校验、HEIC/HEIF 支持等逻辑。

### 5.3 移动端布局

配置常量：`src/config/mobileLayout.ts`（`MOBILE_LAYOUT`）

| 项目 | 规范值 |
|-----|-------|
| 顶部导航栏标准高度（`mobileHeader.height`） | `56px`（横屏紧凑 `landscapeHeight`: `40px`，羽化尾迹 `progressiveBlurTailPx`: `14px`） |
| 输入栏首帧占位高度（`inputBar.placeholderHeight`） | `112px`（高度变化阈值 `heightChangeThreshold`: `4px`） |
| 最小触控区域（`pointer: coarse`） | `44px`（`--touch-target-size`，由体系组件或 `TouchTarget` 保证） |
| 触摸反馈 | `.ui-press-coarse`（`--m-press-scale: 0.97`，`DsButton` 已内建） |
| 安全区 | `--mobile-safe-area-*` / `.safe-area-*`（禁止裸写 `env(safe-area-inset-*)`） |

移动端页面须通过 `useMobileHeader` 向全局唯一顶栏 `UnifiedMobileHeader` 注册标题与操作；三屏滑动布局使用 `MobileSlidingLayout`（`src/components/layout/MobileSlidingLayout.tsx`）。详见 [docs/frontend/patterns.md](./frontend/patterns.md)。

## 6. TypeScript / Cordis Host 后端

### 6.1 分层与插件边界

后端遵循严格的单向依赖分层（由 `npm run check:arch` 与 `npm run check:plugins` 门禁校验，完整约定见 [docs/plugins/ARCHITECTURE.md](./plugins/ARCHITECTURE.md)）：

```text
electron/        Electron 桌面壳、窗口与预加载 IPC 兼容桥（不含业务）
  -> host/kernel/    Cordis 运行时、命令路由、契约校验与插件生命周期
    -> host/platform/  平台服务（storage / errors / log / secrets / settings / paths / net-policy 等）
      -> host/plugins/   业务插件（通过 definePlugin 注册）
```

- 插件间协作**只能通过对方 `api.ts` / `portable.ts` 声明的服务接口**（`ctx.provide` / `inject`），严禁直接 import 其他插件的 `src/` 或 `repository/`
- 新增或调整 Host 命令及入参/出参时，以 `contracts/ipc/` 为单一事实源，同步执行 `npm run contracts:generate` 与 `npm run contracts:check`

### 6.2 错误处理

命令边界与平台错误统一使用 `host/platform/errors/api.ts` 导出的结构化错误模型（`AppError`、`AppErrorType`、`CommandError`、`ErrorCode`、`ErrorDetails`、`CommandErrorEnvelope`）：

- 命令处理函数抛出的错误须带明确分类（受 `ds-host/no-untyped-command-throw` 校验），使用 `AppError` 工厂（如 `AppError.not_found`、`AppError.validation`、`AppError.database`、`AppError.file_system`、`AppError.network` 等）配合 `CommandError`
- 将任意未知异常转为可读文本时，统一使用 `errorDisplay(error)`，避免 `String(error)` 产生 `[object Object]`

```ts
import { CommandError } from '../../kernel/api.ts';
import { AppError } from '../../platform/errors/api.ts';

if (!paper) {
  throw new CommandError(AppError.not_found(`Paper not found: ${paperId}`));
}
```

### 6.3 数据库与数据所有权

| 场景 | 要求 |
|-----|------|
| 表归属 | 每张 SQLite 表仅由单一所属插件写入，其他插件通过服务接口读写 |
| SQL 位置 | SQL 只允许出现在所属插件的 `repository/` 目录中 |
| 连接与迁移 | 连接、事务与架构迁移由平台 `storage` 服务统一管理；表结构演进走正规数据库迁移 |
| 跨插件写入 | 跨插件原子写入由提供方插件封装在单事务服务方法中暴露，禁止在调用方拼接多次写入 |

## 7. 日志规范

- **Host 后端**：禁止在生产代码中散落 `console.log`，按使用场景选用 Cordis 内建日志或 `host/platform/log` 提供的 `ctx.log`：
  - 标准插件日志：直接使用 Cordis 内建的 `ctx.logger(target)`（由 `host/platform/log` 自动桥接写入主日志，无需 `inject: ['log']`；按 `error` / `warn` / `info` / `debug` / `trace` 分级）
  - 结构化调试日志与 LLM 调试日志：通过 `inject: ['log']` 使用 `ctx.log.structured`（如 `log`、`logDatabaseOperation`、`logApiCall` 等）与 `ctx.log.debugLogs`
  - 敏感信息保护：输出外部请求、凭据或路径前，通过 `inject: ['log']` 使用 `ctx.log.redactSensitiveText` / `redactSensitiveFields` / `scrubPii` 脱敏
- **React 前端**：生产代码禁止新增 `console.log`（受 `no-console` 约束）；诊断告警/错误使用统一日志上报或 `console.warn` / `console.error`，消息前缀统一为 `[ComponentName] message`
