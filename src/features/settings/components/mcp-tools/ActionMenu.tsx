import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, Flask, DotsThree, Sparkle, Key } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { DsButton } from '@/components/ui/DsButton';
import { UiPresence } from '@/components/ui/UiPresence';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';

// 操作菜单组件（导出供窄屏视口契约测试使用，见 #46）
export function ActionMenu({
  onReconnect,
  onHealthCheck,
  onClearCache,
  onOpenPolicy
}: {
  onReconnect: () => void;
  onHealthCheck: () => void;
  onClearCache: () => void;
  onOpenPolicy: () => void;
}) {
  const { t } = useTranslation(['settings']);
  // P0-3 移动端契约：不使用 fixed 遮罩下拉，改为按钮下方页内内联展开
  const { isSmallScreen } = useBreakpoint();
  const [isOpen, setIsOpen] = useState(false);

  // 📱 Android 返回键：本菜单为自绘浮层（桌面 fixed 遮罩 / 移动内联展开），
  // 无 data-state="open"，协调器 Radix 兜底探测不到；打开期间显式注册
  // overlay 档 handler 先关菜单（对照 FinderBatchToolbar 排序菜单）。
  useEffect(() => {
    if (!isOpen) return;
    return registerBackHandler(() => {
      setIsOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isOpen]);

  const menuItems = (
    <>
      <DsButton variant="ghost" size="sm" onClick={() => { onReconnect(); setIsOpen(false); }} className="w-full !justify-start [@media(pointer:coarse)]:!min-h-11">
        <ArrowClockwise className="w-3.5 h-3.5 text-muted-foreground" />
        {t('settings:mcp.reconnect')}
      </DsButton>
      <DsButton variant="ghost" size="sm" onClick={() => { onHealthCheck(); setIsOpen(false); }} className="w-full !justify-start [@media(pointer:coarse)]:!min-h-11">
        <Flask className="w-3.5 h-3.5 text-muted-foreground" />
        {t('settings:mcp.health_check')}
      </DsButton>
      <DsButton variant="ghost" size="sm" onClick={() => { onClearCache(); setIsOpen(false); }} className="w-full !justify-start [@media(pointer:coarse)]:!min-h-11">
        <Sparkle className="w-3.5 h-3.5 text-muted-foreground rotate-45" />
        {t('settings:mcp.clear_cache')}
      </DsButton>
      <div className="my-1 border-t border-border/50" />
      <DsButton variant="ghost" size="sm" onClick={() => { onOpenPolicy(); setIsOpen(false); }} className="w-full !justify-start [@media(pointer:coarse)]:!min-h-11">
        <Key className="w-3.5 h-3.5 text-muted-foreground" />
        {t('settings:mcp.security_policy')}
      </DsButton>
    </>
  );

  // 移动端：按钮下方内联展开（操作栏为 flex-wrap，w-full 自动换行占满一行）；
  // UiPresence 承载打开/退出动画。
  if (isSmallScreen) {
    return (
      <div className={cn('relative', isOpen && 'w-full')}>
        <DsButton
          variant="outline"
          size="sm"
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          className="[@media(pointer:coarse)]:!min-h-11"
        >
          <DotsThree className="w-4 h-4" />
          {t('settings:mcp_descriptions.quick_actions')}
        </DsButton>

        <UiPresence
          open={isOpen}
          inClass="ui-zoom-fade-in motion-reduce:animate-none"
          outClass="ui-zoom-fade-out"
          className="mt-1 w-full rounded-lg border border-border bg-popover p-1.5"
        >
          {menuItems}
        </UiPresence>
      </div>
    );
  }

  // 桌面/平板（含安卓横屏 ≥768px）：Portal + fixed 定位（#46）。
  // 旧实现是 `absolute right-0` + z-50：在窄视口下会超出屏幕左缘，
  // 且被设置内容滚动容器裁切、被侧栏 stacking context 压住。
  // Popover 原语自带视口碰撞钳制（resolvePopoverPosition）与 Z_INDEX.popover 层级。
  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <DsButton
          variant="outline"
          size="sm"
          className="[@media(pointer:coarse)]:!min-h-11"
        >
          <DotsThree className="w-4 h-4" />
          {t('settings:mcp_descriptions.quick_actions')}
        </DsButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        // 显式宽度：fixed 定位 + w-full 菜单项会把菜单撑到可用宽度（~385px），盖住半个设置侧栏
        className="w-56 max-w-[calc(100vw-1rem)]"
        data-testid="mcp-quick-actions-menu"
      >
        {menuItems}
      </PopoverContent>
    </Popover>
  );
}
