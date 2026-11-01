import type React from 'react';
import type { DstuNode } from '@/dstu';
import type { FinderPath, QueryItemsForPathResult } from '../stores/finderStore';
import { matchesLiveName } from '../utils/searchHonesty';
import { pruneSelectionAgainstItems } from '../stores/selectionPrune';

export interface RefreshCanvasListContext {
  isMountedRef: React.MutableRefObject<boolean>;
  canvasRequestIdRef: React.MutableRefObject<number>;
  currentPath: FinderPath;
  canvasSearchQuery: string;
  setCanvasIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setCanvasError: React.Dispatch<React.SetStateAction<string | null>>;
  queryItemsForPath: (path: FinderPath) => Promise<QueryItemsForPathResult>;
  setCanvasItems: React.Dispatch<React.SetStateAction<DstuNode[]>>;
  setCanvasSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  canvasLastSelectedId: string | null;
  setCanvasLastSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
}

/** canvas 宿主本地列表刷新（本地活名过滤，而非后端搜索） */
export async function refreshCanvasList({
  isMountedRef,
  canvasRequestIdRef,
  currentPath,
  canvasSearchQuery,
  setCanvasIsLoading,
  setCanvasError,
  queryItemsForPath,
  setCanvasItems,
  setCanvasSelectedIds,
  canvasLastSelectedId,
  setCanvasLastSelectedId,
}: RefreshCanvasListContext): Promise<void> {
  if (!isMountedRef.current) return;
  const requestId = ++canvasRequestIdRef.current;
  const pathSnapshot = currentPath;
  const querySnapshot = canvasSearchQuery.trim();
  setCanvasIsLoading(true);
  setCanvasError(null);
  const result = await queryItemsForPath(pathSnapshot);
  if (!isMountedRef.current || requestId !== canvasRequestIdRef.current) return;
  if (result.ok) {
    const nextItems = querySnapshot
      ? result.value.filter((item) => matchesLiveName(item, querySnapshot))
      : result.value;
    setCanvasItems(nextItems);
    setCanvasSelectedIds((previous) => {
      const pruned = pruneSelectionAgainstItems(
        previous,
        nextItems,
        canvasLastSelectedId,
        { preserveLastSelectedIfWasSelected: true },
      );
      setCanvasLastSelectedId(pruned.lastSelectedId);
      return pruned.selectedIds;
    });
  } else if ('error' in result) {
    setCanvasError(result.error.message);
  }
  setCanvasIsLoading(false);
}
