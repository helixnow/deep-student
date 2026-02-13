# CommonTooltip - 通用悬浮提示气泡组件

一个现代化、易用的悬浮提示气泡组件，支持多种位置、主题和自定义选项。

## ✨ 特性

- 🚀 **立即显示** - 鼠标悬停立即显示提示，无延迟（可配置）
- 🎨 **多主题支持** - 深色、浅色、自动跟随系统
- 📍 **多位置支持** - 上、下、左、右四个方向
- 🎯 **智能定位** - 自动边界检测，防止超出视口
- 💎 **精美样式** - 现代化设计，支持暗色/亮色模式
- 🔧 **高度可定制** - 支持自定义样式、最大宽度等
- ♿ **无障碍支持** - 符合ARIA标准
- 📱 **响应式设计** - 移动端友好

## 📦 安装

组件已经包含在项目中，直接导入使用即可：

```tsx
import CommonTooltip from '@/components/shared/CommonTooltip';
```

## 🎯 基础用法

### 最简单的用法

```tsx
<CommonTooltip content="这是提示内容">
  <button>鼠标悬停</button>
</CommonTooltip>
```

### 指定位置

```tsx
<CommonTooltip content="底部提示" position="bottom">
  <button>查看底部提示</button>
</CommonTooltip>
```

### 不同主题

```tsx
{/* 深色主题（默认） */}
<CommonTooltip content="深色提示" theme="dark">
  <button>深色</button>
</CommonTooltip>

{/* 浅色主题 */}
<CommonTooltip content="浅色提示" theme="light">
  <button>浅色</button>
</CommonTooltip>

{/* 自动跟随系统 */}
<CommonTooltip content="自动主题" theme="auto">
  <button>自动</button>
</CommonTooltip>
```

## 📖 API 文档

### Props

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `content` | `React.ReactNode` | *必填* | 提示内容，支持文本或JSX |
| `position` | `'top' \| 'bottom' \| 'left' \| 'right'` | `'top'` | 气泡显示位置 |
| `theme` | `'dark' \| 'light' \| 'auto'` | `'auto'` | 主题样式 |
| `disabled` | `boolean` | `false` | 是否禁用提示 |
| `offset` | `number` | `8` | 气泡与触发元素的距离（px） |
| `showArrow` | `boolean` | `true` | 是否显示箭头 |
| `delay` | `number` | `0` | 延迟显示时间（ms），0为立即显示 |
| `maxWidth` | `number \| string` | `300` | 最大宽度 |
| `className` | `string` | `''` | 自定义CSS类名 |
| `children` | `React.ReactElement` | *必填* | 触发元素（必须是单个元素） |

## 🎨 使用场景

### 1. 图标按钮提示

```tsx
<CommonTooltip content="保存" position="top">
  <button className="icon-button">
    <SaveIcon />
  </button>
</CommonTooltip>
```

### 2. 表单字段说明

```tsx
<div className="form-field">
  <label>
    用户名
    <CommonTooltip content="用户名必须是3-20个字符" position="right">
      <span className="help-icon">?</span>
    </CommonTooltip>
  </label>
  <input type="text" />
</div>
```

### 3. 禁用按钮说明

```tsx
<CommonTooltip content="请先完成上一步操作">
  <button disabled>下一步</button>
</CommonTooltip>
```

### 4. 术语解释

```tsx
<p>
  这个功能使用了
  <CommonTooltip content="人工智能是计算机科学的一个分支">
    <span className="term">AI</span>
  </CommonTooltip>
  技术。
</p>
```

### 5. 富文本提示

```tsx
<CommonTooltip 
  content={
    <div>
      <div className="font-bold">快捷键</div>
      <div>Ctrl + S: 保存</div>
      <div>Ctrl + Z: 撤销</div>
    </div>
  }
>
  <button>快捷键帮助</button>
</CommonTooltip>
```

### 6. 长文本自动换行

```tsx
<CommonTooltip 
  content="这是一段很长的说明文字，系统会自动换行并限制最大宽度..."
  maxWidth={250}
>
  <button>查看详情</button>
</CommonTooltip>
```

## 🎭 主题说明

### Dark（深色）
- 使用项目的主色调作为背景
- 适合在浅色背景上使用
- 提供良好的对比度

### Light（浅色）
- 使用浅色背景和深色文字
- 适合在深色背景上使用
- 更加温和的视觉效果

### Auto（自动）
- 根据系统主题自动切换
- 在亮色模式下使用深色气泡
- 在暗色模式下使用适配的气泡样式

## 💡 最佳实践

### 1. 简洁明了
```tsx
✅ 推荐
<CommonTooltip content="删除此项">
  <button>删除</button>
</CommonTooltip>

❌ 不推荐
<CommonTooltip content="点击此按钮将会删除这个项目，删除后无法恢复，请谨慎操作...">
  <button>删除</button>
</CommonTooltip>
```

### 2. 合适的位置
- 顶部空间充足时使用 `position="top"`（默认）
- 底部有足够空间时使用 `position="bottom"`
- 横向布局时考虑使用 `position="left"` 或 `position="right"`

### 3. 避免重复信息
```tsx
✅ 推荐
<CommonTooltip content="保存当前编辑">
  <button>保存</button>
</CommonTooltip>

❌ 不推荐
<CommonTooltip content="保存">
  <button>保存</button>
</CommonTooltip>
```

### 4. 移动端考虑
在移动端可以考虑禁用或使用其他提示方式：
```tsx
const isMobile = window.innerWidth < 768;

<CommonTooltip content="提示内容" disabled={isMobile}>
  <button>按钮</button>
</CommonTooltip>
```

## 🔍 注意事项

1. **单个子元素**：`children` 必须是单个React元素，不能是文本或多个元素
   ```tsx
   ✅ 正确
   <CommonTooltip content="提示">
     <button>按钮</button>
   </CommonTooltip>
   
   ❌ 错误
   <CommonTooltip content="提示">
     按钮文本
   </CommonTooltip>
   ```

2. **性能优化**：避免在tooltip的content中放置过于复杂的组件

3. **层级问题**：tooltip使用Portal渲染到body，z-index为10000，确保能正常显示

4. **事件冒泡**：组件会保留子元素原有的事件处理器

## 🎬 完整示例

查看 `CommonTooltip.example.tsx` 文件获取更多使用示例。

## 📝 类型定义

```typescript
export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';
export type TooltipTheme = 'dark' | 'light' | 'auto';

export interface CommonTooltipProps {
  content: React.ReactNode;
  position?: TooltipPosition;
  theme?: TooltipTheme;
  disabled?: boolean;
  offset?: number;
  showArrow?: boolean;
  delay?: number;
  maxWidth?: number | string;
  className?: string;
  children: React.ReactElement;
}
```

## 🤝 贡献

如有问题或建议，欢迎提出issue或PR。

## 📄 许可

MIT License

