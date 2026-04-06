import React, { useCallback, useState } from 'react';
import { Edit2, MoreHorizontal, Plus, Settings, Trash2 } from 'lucide-react';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import { NotionButton } from '@/components/ui/NotionButton';
import type { SessionGroup } from '../types/group';

type SessionGroupActionLabels = {
  groupActions: string;
  newSession: string;
  renameGroup: string;
  editGroup: string;
  deleteGroup: string;
};

type SessionGroupActionsRenderProps = {
  quickAction: React.ReactNode;
  onContextMenu: React.MouseEventHandler<HTMLElement>;
};

interface SessionGroupActionsProps {
  group: SessionGroup;
  labels: SessionGroupActionLabels;
  onCreateSession: (groupId: string) => void | Promise<void>;
  onRenameGroup: (group: SessionGroup) => void;
  onEditGroup: (group: SessionGroup) => void;
  onDeleteGroup: (group: SessionGroup) => void;
  children: (props: SessionGroupActionsRenderProps) => React.ReactNode;
}

export function SessionGroupActions({
  group,
  labels,
  onCreateSession,
  onRenameGroup,
  onEditGroup,
  onDeleteGroup,
  children,
}: SessionGroupActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);

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
            <MoreHorizontal className="w-3.5 h-3.5" />
          </NotionButton>
        </AppMenuTrigger>
        <AppMenuContent align="end" width={180}>
          <AppMenuGroup>
            <AppMenuItem
              icon={<Edit2 className="w-4 h-4" />}
              onClick={() => onRenameGroup(group)}
            >
              {labels.renameGroup}
            </AppMenuItem>
            <AppMenuItem
              icon={<Settings className="w-4 h-4" />}
              onClick={() => onEditGroup(group)}
            >
              {labels.editGroup}
            </AppMenuItem>
            <AppMenuSeparator />
            <AppMenuItem
              destructive
              icon={<Trash2 className="w-4 h-4" />}
              onClick={() => onDeleteGroup(group)}
            >
              {labels.deleteGroup}
            </AppMenuItem>
          </AppMenuGroup>
        </AppMenuContent>
      </AppMenu>
      <NotionButton
        variant="ghost"
        size="icon"
        iconOnly
        onClick={(event) => {
          event.stopPropagation();
          void onCreateSession(group.id);
        }}
        aria-label={labels.newSession}
        title={labels.newSession}
        className="!h-6 !w-6"
      >
        <Plus className="w-3.5 h-3.5" />
      </NotionButton>
    </div>
  );

  return <>{children({ quickAction, onContextMenu: handleContextMenu })}</>;
}
