/**
 * `resource.contextMenu` rows of surfaces that load lazily (FE-B9); the slot is a kernel builtin, its row and context
 * types are the kernel contract `@/ui-kernel/contracts/content`.
 *
 * The official rows of the notes workspace tree (notesTreeMenu.ts) load with the workspace (not at startup) and
 * announce themselves to `resourceMenuContributions`; `dstu.ui.menu` contributes what is announced.
 */
import type { SlotEntry, SlotValue } from '@/ui-sdk';
import { createLazyContributionPoint } from '@/ui-sdk/lazy';

export type ResourceMenuValue = SlotValue<'resource.contextMenu'>;

export const resourceMenuContributions = createLazyContributionPoint<SlotEntry<ResourceMenuValue>>('resource.contextMenu');
