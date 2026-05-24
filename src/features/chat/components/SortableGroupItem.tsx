/**
 * SortableGroupItem - 支持长按拖拽的分组项
 *
 * 使用 @dnd-kit/sortable 实现分组排序（长按 300ms 触发拖拽），
 * 内部保留 @hello-pangea/dnd 的 Droppable 用于会话级别的拖放。
 */

import React from 'react';
import { Folder } from '@phosphor-icons/react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Droppable, Draggable } from '@hello-pangea/dnd';
import { cn } from '@/lib/utils';
import { UnifiedSidebarSection } from '@/components/ui/unified-sidebar/UnifiedSidebarSection';
import { PRESET_ICONS } from './groups/GroupEditorDialog';
import { SessionGroupActions } from '../pages/SessionGroupActions';
import type { SessionGroup } from '../types/group';
import type { ChatSession } from '../types/session';
import type { SessionDragState } from '../pages/SessionItemRenderer';
import type { TFunction } from 'i18next';

export interface SortableGroupItemProps {
  group: SessionGroup;
  groupSessions: ChatSession[];
  isCollapsed: boolean;
  groupDragDisabled: boolean;
  toggleGroupCollapse: (groupId: string) => void;
  openEditGroup: (group: SessionGroup) => void;
  openRenameGroup: (group: SessionGroup) => void;
  requestArchiveGroup: (group: SessionGroup) => void;
  createSession: (groupId?: string) => Promise<void>;
  renderSessionItem: (session: ChatSession, drag?: SessionDragState) => React.ReactNode;
  t: TFunction;
}

export function SortableGroupItem({
  group,
  groupSessions,
  isCollapsed,
  groupDragDisabled,
  toggleGroupCollapse,
  openEditGroup,
  openRenameGroup,
  requestArchiveGroup,
  createSession,
  renderSessionItem,
  t,
}: SortableGroupItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: group.id,
    disabled: groupDragDisabled,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const presetIcon = group.icon ? PRESET_ICONS.find(p => p.name === group.icon) : null;
  const title = (group.icon && !presetIcon) ? `${group.icon} ${group.name}` : group.name;
  const IconComponent = presetIcon?.Icon ?? Folder;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        isDragging && 'z-50 shadow-lg ring-1 ring-border bg-card/80 rounded-md opacity-90',
      )}
    >
      <Droppable droppableId={`session-group:${group.id}`} type="SESSION">
        {(sessionProvided, sessionSnapshot) => (
          <div
            ref={sessionProvided.innerRef}
            {...sessionProvided.droppableProps}
            className={cn(
              sessionSnapshot.isDraggingOver && 'bg-accent/30 rounded-md',
            )}
          >
            <SessionGroupActions
              group={group}
              labels={{
                groupActions: t('page.groupActions'),
                newSession: t('page.newSession'),
                newSessionInGroup: t('page.newSessionInGroup', {
                  groupName: group.name,
                  defaultValue: '在 {{groupName}} 中新建会话',
                }),
                renameGroup: t('page.renameGroup'),
                editGroup: t('page.editGroup'),
                archiveGroup: t('page.archiveGroup'),
              }}
              onCreateSession={createSession}
              onRenameGroup={openRenameGroup}
              onEditGroup={openEditGroup}
              onArchiveGroup={requestArchiveGroup}
            >
              {({ quickAction, onContextMenu }) => (
                <UnifiedSidebarSection
                  id={group.id}
                  title={title}
                  icon={IconComponent}
                  count={groupSessions.length}
                  open={!isCollapsed}
                  onOpenChange={() => toggleGroupCollapse(group.id)}
                  onHeaderContextMenu={onContextMenu}
                  twoLineLayout
                  dragHandleProps={listeners ? { ...attributes, ...listeners } : undefined}
                  quickAction={quickAction}
                >
                  {groupSessions.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      {t('page.noGroupSessions')}
                    </div>
                  ) : (
                    groupSessions.map((session, sessionIndex) => (
                      <Draggable
                        key={`session:${session.id}`}
                        draggableId={`session:${session.id}`}
                        index={sessionIndex}
                      >
                        {(sessionProvided, sessionSnapshot) =>
                          renderSessionItem(session, {
                            provided: sessionProvided,
                            snapshot: sessionSnapshot,
                          })
                        }
                      </Draggable>
                    ))
                  )}
                </UnifiedSidebarSection>
              )}
            </SessionGroupActions>
            {sessionProvided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}
