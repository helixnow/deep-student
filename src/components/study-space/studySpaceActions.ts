import { APP_EVENTS, dispatchAppEvent, dispatchTypedEvent } from '@/events';
import { activateWorkbenchApp, isWorkbenchHostEnabled } from '@/shared/workbenchHost';
import { requestStudySpaceReview } from '@/shared/study-space/reviewBridge';
import { STUDY_SPACE_CHANGED_EVENT, STUDY_SPACE_DEFAULTS, type ActiveSpaceSelection, type StudySpace, type WorkbenchLayoutPreset } from '@/shared/study-space/types';
import { listAnkiLibraryCards } from '@/utils/chatApi';
import { getErrorMessage } from '@/utils/errorUtils';

export interface WorkbenchPresetContext {
  spaceId?: ActiveSpaceSelection;
  rootFolderId?: string | null;
  defaultDeckId?: string | null;
}

/** WorkbenchDesktop owns snapshot restoration and layout application on this event. */
export async function applySpaceWorkbenchPreset(preset: WorkbenchLayoutPreset, context?: WorkbenchPresetContext): Promise<boolean> {
  if (!isWorkbenchHostEnabled()) return false;
  dispatchTypedEvent(STUDY_SPACE_CHANGED_EVENT, {
    spaceId: context?.spaceId ?? null,
    rootFolderId: context?.rootFolderId ?? '',
    defaultDeckId: context?.defaultDeckId ?? null,
    workbenchLayoutPreset: preset,
    targetRetention: STUDY_SPACE_DEFAULTS.targetRetention,
    memoryScope: STUDY_SPACE_DEFAULTS.memoryScope,
  });
  return true;
}

export async function openSpaceFolderInHub(folderId: string | null | undefined, _folderTitle?: string): Promise<void> {
  const id = folderId?.trim();
  if (isWorkbenchHostEnabled()) {
    await activateWorkbenchApp({
      typeId: 'files', instanceKey: '', action: 'openFolder', payload: { folderId: id },
      fallbackLaunch: { typeId: 'files', reason: 'api', payload: { folderId: id } },
    });
    return;
  }
  dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'learning-hub', openResource: id ? `/${id}` : undefined });
}

export async function launchSpaceFlashcardReview(space: Pick<StudySpace, 'defaultDeckId' | 'name'>): Promise<boolean> {
  try {
    const deck = space.defaultDeckId?.trim() || undefined;
    const due = await listAnkiLibraryCards({ deck, status: 'due', sort: 'due', page: 1, page_size: 200 });
    const cards = due?.items?.length ? due.items : (await listAnkiLibraryCards({ deck, status: 'new', sort: 'created', page: 1, page_size: 10 }))?.items ?? [];
    const cardIds = cards.map((card) => card.id);
    if (isWorkbenchHostEnabled()) {
      return activateWorkbenchApp({
        typeId: 'flashcards', instanceKey: '', action: 'startReview',
        payload: cardIds.length ? { screen: 'session', mode: 'batch', cardIds } : { screen: 'today' },
        fallbackLaunch: { typeId: 'flashcards', reason: 'api' },
      });
    }
    const requested = requestStudySpaceReview(cardIds);
    dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'flashcards' });
    return await requested;
  } catch (error: unknown) {
    console.error('[studySpaceActions] Failed to launch space review:', getErrorMessage(error));
    return false;
  }
}
