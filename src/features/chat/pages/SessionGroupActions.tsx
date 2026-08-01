import React, { useCallback, useState } from 'react';
import { Archive, PencilSimple, DotsThree, PushPin, Gear } from '@phosphor-icons/react';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import { DsButton } from '@/components/ui/DsButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { StudyComposeIcon } from '@/components/icons/StudySidebarIcons';
import type { SessionGroup } from '../types/group';

type SessionGroupActionLabels = {
  groupActions: string;
  newSession: string;
  newSessionInGroup: string;
  pinGroup?: string;
  unpinGroup?: string;
  renameGroup: string;
  editGroup: string;
  archiveGroup: string;
};

type SessionGroupActionsRenderProps = {
  quickAction: React.ReactNode;
  onContextMenu: React.MouseEventHandler<HTMLElement>;
};

interface SessionGroupActionsProps {
  group: SessionGroup;
  labels: SessionGroupActionLabels;
  onCreateSession: (groupId: string) => void | Promise<void>;
  isPinned?: boolean;
  onTogglePinGroup?: (group: SessionGroup, pinned: boolean) => void | Promise<void>;
  onRenameGroup: (group: SessionGroup) => void;
  onEditGroup: (group: SessionGroup) => void;
  onArchiveGroup: (group: SessionGroup) => void;
  children: (props: SessionGroupActionsRenderProps) => React.ReactNode;
}

export function SessionGroupActions({
  group,
  labels,
  onCreateSession,
  isPinned = false,
  onTogglePinGroup,
  onRenameGroup,
  onEditGroup,
  onArchiveGroup,
  children,
}: SessionGroupActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const newSessionInGroupLabel = labels.newSessionInGroup.replace(/\{\{\s*groupName\s*\}\}/g, group.name);

  const handleContextMenu = useCallback<React.MouseEventHandler<HTMLElement>>((event) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuOpen(true);
  }, []);

  const quickAction = (
    <div
      data-menu-open={menuOpen ? 'true' : 'false'}
      className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/sidebar-section:opacity-100 group-focus-within/sidebar-section:opacity-100 data-[menu-open=true]:opacity-100"
    >
      <div
        className="flex items-center"
      >
        <AppMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <AppMenuTrigger asChild>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={(event) => event.stopPropagation()}
              aria-label={labels.groupActions}
              title={labels.groupActions}
              // 触屏（<lg）放大到 36px 触控目标，桌面保持 24px 紧凑视觉（与 SessionItemRenderer 同范式）
              className="!h-9 !w-9 lg:!h-6 lg:!w-6 !rounded-none hover:bg-transparent hover:text-[color:var(--shell-navigation-foreground)] active:bg-transparent active:text-[color:var(--shell-navigation-foreground)]"
            >
              <DotsThree size={14} />
            </DsButton>
          </AppMenuTrigger>
          <AppMenuContent align="end" width={180}>
            <AppMenuGroup>
              {onTogglePinGroup ? (
                <AppMenuItem
                  icon={<PushPin size={16} />}
                  onClick={() => onTogglePinGroup(group, !isPinned)}
                >
                  {isPinned
                    ? labels.unpinGroup ?? 'Unpin Group'
                    : labels.pinGroup ?? 'Pin Group'}
                </AppMenuItem>
              ) : null}
              <AppMenuItem
                icon={<PencilSimple size={16} />}
                onClick={() => onRenameGroup(group)}
              >
                {labels.renameGroup}
              </AppMenuItem>
              <AppMenuItem
                icon={<Gear size={16} />}
                onClick={() => onEditGroup(group)}
              >
                {labels.editGroup}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem
                icon={<Archive size={16} />}
                onClick={() => onArchiveGroup(group)}
              >
                {labels.archiveGroup}
              </AppMenuItem>
            </AppMenuGroup>
          </AppMenuContent>
        </AppMenu>
      </div>
      <CommonTooltip content={newSessionInGroupLabel} position="right">
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={(event) => {
            event.stopPropagation();
            void onCreateSession(group.id);
          }}
          aria-label={newSessionInGroupLabel}
          // 触屏（<lg）放大到 36px 触控目标，桌面保持 24px 紧凑视觉
          className="!h-9 !w-9 lg:!h-6 lg:!w-6 !rounded-none hover:bg-transparent hover:text-[color:var(--shell-navigation-foreground)] active:bg-transparent active:text-[color:var(--shell-navigation-foreground)]"
        >
          <StudyComposeIcon className="w-3.5 h-3.5" />
        </DsButton>
      </CommonTooltip>
    </div>
  );

  return <>{children({ quickAction, onContextMenu: handleContextMenu })}</>;
}
