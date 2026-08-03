/**
 * 将选中集裁剪到当前可见 items（及可选 extraAliveIds）。
 * 用于 loadItems / executeSearch / setItems 后剔除幽灵选中。
 */

export type PruneSelectionResult = {
  selectedIds: Set<string>;
  lastSelectedId: string | null;
  /** true 表示相对输入有删减 */
  changed: boolean;
};

export function pruneSelectionAgainstItems(
  selectedIds: ReadonlySet<string>,
  items: ReadonlyArray<{ id: string }>,
  lastSelectedId: string | null,
  options?: {
    /** 不在 items 但仍应保留的 id（如 pending folder） */
    extraAliveIds?: ReadonlySet<string> | readonly string[];
    /**
     * Keep the previous range pivot even when it disappears from this result.
     * The pivot is not kept selected; it only preserves Shift-range intent
     * across a transient refresh. Navigation and explicit clear still reset it.
     */
    preserveLastSelectedIfWasSelected?: boolean;
  },
): PruneSelectionResult {
  const alive = new Set(items.map((item) => item.id));
  if (options?.extraAliveIds) {
    for (const id of options.extraAliveIds) {
      alive.add(id);
    }
  }

  const next = new Set<string>();
  for (const id of selectedIds) {
    if (alive.has(id)) next.add(id);
  }

  const preserveLastSelected =
    options?.preserveLastSelectedIfWasSelected === true &&
    lastSelectedId != null &&
    selectedIds.has(lastSelectedId);

  // Keep a former selected pivot only when the caller explicitly opts in.
  const nextLast =
    lastSelectedId != null && (alive.has(lastSelectedId) || preserveLastSelected)
      ? lastSelectedId
      : null;

  const changed =
    next.size !== selectedIds.size ||
    nextLast !== lastSelectedId ||
    [...selectedIds].some((id) => !next.has(id));

  return {
    selectedIds: next,
    lastSelectedId: nextLast,
    changed,
  };
}
