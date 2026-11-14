import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowLeft,
  Check,
  CircleNotch,
  FileText,
  FolderSimple,
  LinkSimple,
} from '@phosphor-icons/react';
import { DsDialog } from '@/components/ui/DsDialog';
import { DsButton } from '@/components/ui/DsButton';
import { Badge } from '@/components/ui/shad/Badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { dstu, type DstuNode } from '@/dstu';
import type { SessionGroup } from '@/features/chat/types/group';
import { cn } from '@/utils/cn';
import { getErrorMessage } from '@/utils/errorUtils';
import type { StudySpace, StudySpaceMount } from '@/shared/study-space/types';
import { toSpaceMountItemType } from '@/shared/study-space/studySpaceApi';
import { useActiveStudySpace } from './useActiveStudySpace';
import { useStudySpaceStore } from '@/stores/studySpaceStore';
import { stripEmojiText } from '@/shared/study-space/spaceCountdown';

export interface MountableItemTarget {
  itemId: string;
  itemType: string;
  title: string;
  canonicalFolderId?: string | null;
}

export interface SpaceMountPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Mode A: Mount a known item (from Learning Hub context menu) into a chosen Study Space */
  item?: MountableItemTarget | null;
  /** Mode B: Pick a VFS item/folder from another folder to mount into a known target Study Space */
  targetSpace?: Pick<StudySpace, 'spaceId' | 'name' | 'rootFolderId' | 'mountedResourceIds'> | null;
  onMounted?: (mount: StudySpaceMount) => void;
}

export const SpaceMountPickerDialog: React.FC<SpaceMountPickerDialogProps> = ({
  open,
  onOpenChange,
  item,
  targetSpace,
  onMounted,
}) => {
  const { t } = useTranslation(['learningHub', 'chatV2', 'common']);
  const { spaces, loading } = useActiveStudySpace();
  const mountItemToSpace = useStudySpaceStore((s) => s.mountItemToSpace);

  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = React.useRef(false);

  // Mode B browser state
  const [browsePath, setBrowsePath] = useState<string>('/');
  const [browseStack, setBrowseStack] = useState<Array<{ path: string; label: string }>>([]);
  const [browseNodes, setBrowseNodes] = useState<DstuNode[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);

  // Ensure spaces are hydrated even if Learning Hub was opened before Chat sidebar
  useEffect(() => {
    if (!open) return;
    if (spaces.length > 0) return;
    let cancelled = false;
    invoke<SessionGroup[]>('chat_v2_list_groups', { status: 'active' })
      .then((groups) => {
        if (!cancelled && Array.isArray(groups) && groups.length > 0) {
          void useStudySpaceStore.getState().hydrateFromGroups(groups);
        }
      })
      .catch(() => {
        // Ignore in isolated unit test environments.
      });
    return () => {
      cancelled = true;
    };
  }, [open, spaces.length]);

  const candidateSpaces = useMemo(() => {
    if (!item) return spaces;
    return spaces.filter((space) => {
      if (!space.rootFolderId) return false;
      if (item.canonicalFolderId && space.rootFolderId === item.canonicalFolderId) {
        return false;
      }
      if (item.itemType === 'folder' && space.rootFolderId === item.itemId) {
        return false;
      }
      return true;
    });
  }, [item, spaces]);

  useEffect(() => {
    if (!open || !item) return;
    const firstUnmounted = candidateSpaces.find(
      (space) => !space.mountedResourceIds.includes(item.itemId),
    );
    setSelectedSpaceId(firstUnmounted?.spaceId ?? candidateSpaces[0]?.spaceId ?? null);
  }, [candidateSpaces, item, open]);

  // Mode B: Load VFS directory listing for picking an item to mount into targetSpace
  useEffect(() => {
    if (!open || item || !targetSpace) return;
    let cancelled = false;
    setBrowseLoading(true);
    dstu
      .list(browsePath)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          const filtered = res.value.filter(
            (node) => node.id !== targetSpace.rootFolderId,
          );
          setBrowseNodes(filtered);
        } else {
          setBrowseNodes([]);
        }
      })
      .catch(() => {
        if (!cancelled) setBrowseNodes([]);
      })
      .finally(() => {
        if (!cancelled) setBrowseLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [browsePath, item, open, targetSpace]);

  useEffect(() => {
    if (!open) {
      setBrowsePath('/');
      setBrowseStack([]);
    }
  }, [open]);

  const handleConfirmTargetSpace = useCallback(async () => {
    if (!item || !selectedSpaceId || submittingRef.current) return;
    const chosen = candidateSpaces.find((s) => s.spaceId === selectedSpaceId);
    if (!chosen || !chosen.rootFolderId || chosen.mountedResourceIds.includes(item.itemId)) return;

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const mount = await mountItemToSpace({
        spaceId: chosen.spaceId,
        targetFolderId: chosen.rootFolderId,
        itemType: toSpaceMountItemType(item.itemType),
        itemId: item.itemId,
      });
      showGlobalNotification(
        'success',
        t('learningHub:spaceMount.mountSuccess', {
          name: stripEmojiText(chosen.name),
        }),
      );
      onMounted?.(mount);
      onOpenChange(false);
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [candidateSpaces, item, mountItemToSpace, onMounted, onOpenChange, selectedSpaceId, submitting, t]);

  const handleMountNodeIntoTargetSpace = useCallback(
    async (node: DstuNode) => {
      if (!targetSpace || !targetSpace.rootFolderId || submittingRef.current ||
        targetSpace.mountedResourceIds.includes(node.id)) return;
      submittingRef.current = true;
      setSubmitting(true);
      try {
        const mount = await mountItemToSpace({
          spaceId: targetSpace.spaceId,
          targetFolderId: targetSpace.rootFolderId,
          itemType: toSpaceMountItemType(node.type),
          itemId: node.id,
        });
        showGlobalNotification(
          'success',
          t('learningHub:spaceMount.mountSuccess', {
            name: stripEmojiText(targetSpace.name),
          }),
        );
        onMounted?.(mount);
        onOpenChange(false);
      } catch (error: unknown) {
        showGlobalNotification('error', getErrorMessage(error));
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [mountItemToSpace, onMounted, onOpenChange, submitting, t, targetSpace],
  );

  const selectedSpaceAlreadyMounted = useMemo(() => {
    if (!item || !selectedSpaceId) return false;
    const chosen = candidateSpaces.find((s) => s.spaceId === selectedSpaceId);
    return Boolean(chosen?.mountedResourceIds.includes(item.itemId));
  }, [candidateSpaces, item, selectedSpaceId]);

  return (
    <DsDialog
      open={open}
      onOpenChange={onOpenChange}
      maxWidth="max-w-[480px]"
      aria-label={t('learningHub:spaceMount.pickerTitle')}
      className="rounded-[var(--radius-card)] p-0 overflow-hidden"
    >
      <div className="flex flex-col">
        <div className="border-b border-border/35 px-5 py-4 pr-12">
          <div className="flex items-center gap-2">
            <LinkSimple size={16} className="shrink-0 text-foreground" />
            <h2 className="text-base font-semibold text-foreground">
              {t('learningHub:spaceMount.pickerTitle')}
            </h2>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('learningHub:spaceMount.pickerSubtitle')}
          </p>
          {item ? (
            <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded bg-muted/60 px-2 py-1 text-xs text-foreground">
              {item.itemType === 'folder' ? (
                <FolderSimple size={13} className="shrink-0 text-muted-foreground" />
              ) : (
                <FileText size={13} className="shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{stripEmojiText(item.title) || item.itemId}</span>
            </div>
          ) : null}
        </div>

        <ScrollArea className="max-h-[320px]">
          <div className="p-4">
            {item ? (
              loading && candidateSpaces.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                  <CircleNotch size={16} className="animate-spin" />
                  <span>{t('common:loading')}</span>
                </div>
              ) : candidateSpaces.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  {t('learningHub:spaceMount.noSpacesAvailable')}
                </div>
              ) : (
                <div className="divide-y divide-border/35 rounded-[var(--radius-shell-control)] border border-border/35">
                  {candidateSpaces.map((space) => {
                    const alreadyMounted = space.mountedResourceIds.includes(item.itemId);
                    const isSelected = selectedSpaceId === space.spaceId;
                    const cleanSpaceName = stripEmojiText(space.name) || space.spaceId;
                    return (
                      <button
                        key={space.spaceId}
                        type="button"
                        onClick={() => setSelectedSpaceId(space.spaceId)}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors',
                          isSelected
                            ? 'bg-[var(--surface-elevated)] text-foreground'
                            : 'hover:bg-[var(--interactive-hover)] text-foreground/90',
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span
                            aria-hidden="true"
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-primary)]"
                            style={
                              space.color ? { backgroundColor: space.color } : undefined
                            }
                          />
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">
                              {cleanSpaceName}
                            </div>
                            <div className="truncate font-mono text-[11px] tabular-nums text-muted-foreground">
                              {space.rootFolderId}
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {alreadyMounted ? (
                            <Badge variant="secondary" className="text-[11px]">
                              {t('learningHub:spaceMount.alreadyMounted')}
                            </Badge>
                          ) : null}
                          {isSelected ? (
                            <Check size={15} className="text-foreground" />
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )
            ) : targetSpace ? (
              <div className="space-y-2">
                {browseStack.length > 0 ? (
                  <DsButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => {
                      const nextStack = browseStack.slice(0, -1);
                      const prev = nextStack[nextStack.length - 1];
                      setBrowseStack(nextStack);
                      setBrowsePath(prev ? prev.path : '/');
                    }}
                    className="gap-1.5 text-xs"
                  >
                    <ArrowLeft size={13} />
                    <span>{t('common:back')}</span>
                  </DsButton>
                ) : null}

                {browseLoading ? (
                  <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                    <CircleNotch size={16} className="animate-spin" />
                    <span>{t('common:loading')}</span>
                  </div>
                ) : browseNodes.length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    {t('chatV2:studySpace.mounts.empty')}
                  </div>
                ) : (
                  <div className="divide-y divide-border/35 rounded-[var(--radius-shell-control)] border border-border/35">
                    {browseNodes.map((node) => {
                      const alreadyMounted = targetSpace.mountedResourceIds.includes(
                        node.id,
                      );
                      const isFolder = node.type === 'folder';
                      return (
                        <div
                          key={node.id}
                          className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              if (isFolder) {
                                const folderPath = `/${node.id}`;
                                setBrowseStack((prev) => [
                                  ...prev,
                                  { path: folderPath, label: node.name },
                                ]);
                                setBrowsePath(folderPath);
                              } else if (!alreadyMounted) {
                                void handleMountNodeIntoTargetSpace(node);
                              }
                            }}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline"
                          >
                            {isFolder ? (
                              <FolderSimple
                                size={15}
                                className="shrink-0 text-muted-foreground"
                              />
                            ) : (
                              <FileText
                                size={15}
                                className="shrink-0 text-muted-foreground"
                              />
                            )}
                            <span className="truncate">
                              {stripEmojiText(node.name) || node.id}
                            </span>
                          </button>

                          {alreadyMounted ? (
                            <Badge variant="secondary" className="shrink-0 text-[11px]">
                              {t('learningHub:spaceMount.alreadyMounted')}
                            </Badge>
                          ) : (
                            <DsButton
                              variant="ghost"
                              size="sm"
                              type="button"
                              disabled={submitting}
                              onClick={() => void handleMountNodeIntoTargetSpace(node)}
                              className="!h-7 px-2 text-xs"
                            >
                              {t('chatV2:studySpace.mounts.add')}
                            </DsButton>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </ScrollArea>

        {item ? (
          <div className="flex items-center justify-end gap-2 border-t border-border/35 px-5 py-3">
            <DsButton
              variant="ghost"
              size="sm"
              type="button"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              {t('common:cancel')}
            </DsButton>
            <button
              type="button"
              disabled={
                submitting ||
                !selectedSpaceId ||
                candidateSpaces.length === 0 ||
                selectedSpaceAlreadyMounted
              }
              onClick={() => void handleConfirmTargetSpace()}
              className="inline-flex h-8 [@media(pointer:coarse)]:min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-shell-control)] bg-foreground px-3.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90 disabled:pointer-events-none disabled:opacity-50"
            >
              {submitting ? (
                <CircleNotch size={13} className="animate-spin" />
              ) : (
                <LinkSimple size={13} />
              )}
              <span>{t('chatV2:studySpace.mounts.add')}</span>
            </button>
          </div>
        ) : null}
      </div>
    </DsDialog>
  );
};

export default SpaceMountPickerDialog;
