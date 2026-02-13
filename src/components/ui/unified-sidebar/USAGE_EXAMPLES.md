# UnifiedSidebar 使用示例

## 基础用法（桌面端面板模式）

```tsx
import {
  UnifiedSidebar,
  UnifiedSidebarHeader,
  UnifiedSidebarContent,
  UnifiedSidebarItem,
} from '@/components/ui/unified-sidebar';
import { MessageSquare } from 'lucide-react';

function ChatSidebar() {
  return (
    <UnifiedSidebar width={280} collapsedWidth={48}>
      <UnifiedSidebarHeader
        title="会话列表"
        icon={MessageSquare}
        showSearch
        showCreate
        onCreateClick={() => console.log('创建新会话')}
      />
      <UnifiedSidebarContent>
        <UnifiedSidebarItem
          id="1"
          title="我的第一个会话"
          description="最近活跃"
          isSelected
          onClick={() => console.log('选中会话')}
        />
      </UnifiedSidebarContent>
    </UnifiedSidebar>
  );
}
```

## 移动端响应式（自动切换到 Sheet 模式）

```tsx
import { useState } from 'react';
import {
  UnifiedSidebar,
  UnifiedSidebarHeader,
  UnifiedSidebarContent,
} from '@/components/ui/unified-sidebar';

function ResponsiveSidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* 移动端触发按钮 */}
      <button onClick={() => setMobileOpen(true)}>
        打开侧边栏
      </button>

      {/* 侧边栏 - 自动响应式 */}
      <UnifiedSidebar
        displayMode="panel"          // 默认 panel 模式
        autoResponsive               // 小屏幕自动切换到 sheet
        mobileOpen={mobileOpen}
        onMobileOpenChange={setMobileOpen}
      >
        <UnifiedSidebarHeader
          title="菜单"
          showSearch={false}
        />
        <UnifiedSidebarContent>
          {/* 内容 */}
        </UnifiedSidebarContent>
      </UnifiedSidebar>
    </>
  );
}
```

## 强制使用 Sheet 模式（底部弹出）

```tsx
import { useState } from 'react';
import { UnifiedSidebar } from '@/components/ui/unified-sidebar';

function SheetSidebar() {
  const [open, setOpen] = useState(false);

  return (
    <UnifiedSidebar
      displayMode="sheet"           // 强制 sheet 模式
      mobileOpen={open}
      onMobileOpenChange={setOpen}
      sheetDefaultHeight={0.7}      // 高度为屏幕 70%
      enableSwipeClose              // 支持下滑关闭
    >
      {/* 内容 */}
    </UnifiedSidebar>
  );
}
```

## 使用 Drawer 模式（左侧抽屉）

```tsx
import { useState } from 'react';
import { UnifiedSidebar } from '@/components/ui/unified-sidebar';

function DrawerSidebar() {
  const [open, setOpen] = useState(false);

  return (
    <UnifiedSidebar
      displayMode="drawer"          // 抽屉模式
      drawerSide="left"             // 从左侧滑出
      width={320}                   // 抽屉宽度
      mobileOpen={open}
      onMobileOpenChange={setOpen}
      enableSwipeClose              // 支持滑动关闭
    >
      {/* 内容 */}
    </UnifiedSidebar>
  );
}
```

## 受控模式示例

```tsx
import { useState } from 'react';
import {
  UnifiedSidebar,
  UnifiedSidebarHeader,
  UnifiedSidebarContent,
} from '@/components/ui/unified-sidebar';

function ControlledSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <UnifiedSidebar
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
    >
      <UnifiedSidebarHeader
        showSearch
        searchPlaceholder="搜索..."
      />
      <UnifiedSidebarContent>
        {/* 根据 searchQuery 过滤的内容 */}
      </UnifiedSidebarContent>
    </UnifiedSidebar>
  );
}
```

## 使用 Context Hook

```tsx
import { useUnifiedSidebar } from '@/components/ui/unified-sidebar';

function CustomComponent() {
  const {
    collapsed,
    setCollapsed,
    searchQuery,
    setSearchQuery,
    displayMode,
    isMobile,
    closeMobile,
  } = useUnifiedSidebar();

  return (
    <div>
      <p>当前模式: {displayMode}</p>
      <p>是否移动端: {isMobile ? '是' : '否'}</p>
      {displayMode !== 'panel' && (
        <button onClick={closeMobile}>关闭侧边栏</button>
      )}
    </div>
  );
}
```

## 完整示例（带列表项操作）

```tsx
import { useState } from 'react';
import {
  UnifiedSidebar,
  UnifiedSidebarHeader,
  UnifiedSidebarContent,
  UnifiedSidebarItem,
  UnifiedSidebarFooter,
} from '@/components/ui/unified-sidebar';
import { MessageSquare, Plus } from 'lucide-react';

interface Chat {
  id: string;
  title: string;
  lastMessage?: string;
  timestamp: string;
}

function ChatList() {
  const [chats, setChats] = useState<Chat[]>([
    { id: '1', title: '技术讨论', lastMessage: '最新消息...', timestamp: '2小时前' },
    { id: '2', title: '产品设计', timestamp: '昨天' },
  ]);
  const [selectedId, setSelectedId] = useState('1');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    // 模拟刷新
    await new Promise(resolve => setTimeout(resolve, 1000));
    setIsRefreshing(false);
  };

  const handleDelete = (id: string) => {
    setChats(prev => prev.filter(chat => chat.id !== id));
  };

  return (
    <UnifiedSidebar width={280}>
      <UnifiedSidebarHeader
        title="聊天列表"
        icon={MessageSquare}
        showSearch
        showRefresh
        showCreate
        isRefreshing={isRefreshing}
        onRefreshClick={handleRefresh}
        onCreateClick={() => console.log('新建聊天')}
      />

      <UnifiedSidebarContent
        isEmpty={chats.length === 0}
        emptyTitle="暂无聊天"
        emptyDescription="点击上方按钮创建新聊天"
        emptyIcon={MessageSquare}
      >
        {chats.map(chat => (
          <UnifiedSidebarItem
            key={chat.id}
            id={chat.id}
            title={chat.title}
            description={chat.lastMessage}
            stats={<span>{chat.timestamp}</span>}
            isSelected={selectedId === chat.id}
            onClick={() => setSelectedId(chat.id)}
            showDelete
            onDeleteClick={(e) => {
              e.stopPropagation();
              handleDelete(chat.id);
            }}
          />
        ))}
      </UnifiedSidebarContent>

      <UnifiedSidebarFooter>
        <button className="w-full py-2 text-sm text-muted-foreground hover:text-foreground">
          查看全部
        </button>
      </UnifiedSidebarFooter>
    </UnifiedSidebar>
  );
}
```

## 类型说明

### SidebarDisplayMode

```typescript
type SidebarDisplayMode = 'panel' | 'sheet' | 'drawer';
```

- `panel`: 桌面端固定面板模式
- `sheet`: 移动端底部弹出模式
- `drawer`: 移动端/平板侧边抽屉模式

### 响应式行为

当 `autoResponsive={true}` 时：
- 在小屏幕（< 768px）上，`displayMode="panel"` 会自动切换为 `sheet`
- 在大屏幕上保持原有的 `displayMode`

### 滑动关闭

- Sheet 模式：向下滑动超过 100px 触发关闭
- Drawer 模式：向滑出方向相反滑动超过 100px 触发关闭
- 可通过 `enableSwipeClose={false}` 禁用

## 注意事项

1. **向后兼容性**：所有新增的 props 都是可选的，现有代码无需修改即可继续使用
2. **移动端状态管理**：使用 `mobileOpen` 和 `onMobileOpenChange` 管理移动端的打开/关闭状态
3. **Context 使用**：在 UnifiedSidebar 内部的组件可以使用 `useUnifiedSidebar` hook 访问状态
4. **Mac 安全区域**：在 panel 模式下自动显示，在 sheet/drawer 模式下隐藏
5. **折叠按钮**：只在 panel 模式下显示，在 sheet/drawer 模式下自动隐藏
