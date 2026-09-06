import React from 'react';
import { FunnelSimple, Robot } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuSwitchItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import type { TFunction } from 'i18next';
import {
  isSidebarFilterModified,
  useSidebarFilterPrefs,
} from '../hooks/useSidebarFilterPrefs';

export interface SidebarFilterMenuProps {
  t: TFunction<any, any>;
  /** 触发按钮尺寸/配色，由各侧栏按自身行高约定传入 */
  triggerClassName?: string;
  /** 菜单对齐方式（默认 end，贴右缘） */
  align?: 'start' | 'center' | 'end';
}

/**
 * 对话侧栏过滤菜单（漏斗按钮）：过滤选项的统一入口。
 *
 * 当前选项：
 * - 显示子代理会话（默认关闭，即子代理会话不进侧栏列表）
 *
 * 后续排序策略等更多选项追加到本菜单（新增 AppMenuGroup 分组即可），
 * 偏好状态集中在 `useSidebarFilterPrefs`（localStorage 持久化）。
 */
export const SidebarFilterMenu: React.FC<SidebarFilterMenuProps> = ({
  t,
  triggerClassName,
  align = 'end',
}) => {
  const showSubagentSessions = useSidebarFilterPrefs((state) => state.showSubagentSessions);
  const setShowSubagentSessions = useSidebarFilterPrefs((state) => state.setShowSubagentSessions);
  const modified = isSidebarFilterModified({ showSubagentSessions });

  return (
    <AppMenu>
      <AppMenuTrigger asChild>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          aria-label={t('chatV2:page.sidebarFilter')}
          title={t('chatV2:page.sidebarFilter')}
          className={cn(triggerClassName, modified && '!text-primary')}
        >
          <FunnelSimple size={15} weight={modified ? 'fill' : 'regular'} />
        </DsButton>
      </AppMenuTrigger>
      <AppMenuContent align={align} width={220}>
        <AppMenuGroup>
          <AppMenuSwitchItem
            icon={<Robot size={16} />}
            checked={showSubagentSessions}
            onCheckedChange={setShowSubagentSessions}
          >
            {t('chatV2:page.showSubagentSessions')}
          </AppMenuSwitchItem>
        </AppMenuGroup>
      </AppMenuContent>
    </AppMenu>
  );
};
