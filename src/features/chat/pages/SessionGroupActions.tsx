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
import { NotionButton } from '@/components/ui/NotionButton';
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
    <div className="flex items-center gap-0.5">
      <div
        data-menu-open={menuOpen ? 'true' : 'false'}
        className="opacity-0 transition-opacity duration-150 group-hover/sidebar-section:opacity-100 group-focus-within/sidebar-section:opacity-100 data-[menu-open=true]:opacity-100"
      >
        <AppMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <AppMenuTrigger asChild>
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={(event) => event.stopPropagation()}
              aria-label={labels.groupActions}
              title={labels.groupActions}
              className="!h-6 !w-6"
            >
              <DotsThree size={14} />
            </NotionButton>
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
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={(event) => {
            event.stopPropagation();
            void onCreateSession(group.id);
          }}
          aria-label={newSessionInGroupLabel}
          className="!h-6 !w-6"
        >
          <StudyComposeIcon className="w-3.5 h-3.5" />
        </NotionButton>
      </CommonTooltip>
    </div>
  );

  return <>{children({ quickAction, onContextMenu: handleContextMenu })}</>;
}
