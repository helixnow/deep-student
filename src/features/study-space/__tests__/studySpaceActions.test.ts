import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_EVENTS } from '@/events';
import { setWorkbenchHostBridge, type WorkbenchHostBridge } from '@/shared/workbenchHost';
import { provideStudySpaceReview } from '@/shared/study-space/reviewBridge';
import { launchSpaceFlashcardReview, openSpaceFolderInHub } from '../utils/workbenchPresetApplier';
import { useStudySpaceStore } from '../store/studySpaceStore';
import { STUDY_SPACE_CHANGED_EVENT } from '../types';

const { listCards } = vi.hoisted(() => ({ listCards: vi.fn() }));
vi.mock('@/utils/chatApi', () => ({ listAnkiLibraryCards: listCards }));

describe('Study Space action boundaries', () => {
  beforeEach(() => {
    listCards.mockReset();
    setWorkbenchHostBridge(null);
    useStudySpaceStore.getState().resetForTests();
  });

  it('delegates folder navigation through the host bridge, including cold window launch', async () => {
    const activate = vi.fn(async () => true);
    setWorkbenchHostBridge({ isEnabled: () => true, activate } as unknown as WorkbenchHostBridge);
    await openSpaceFolderInHub(' fld_physics ');
    expect(activate).toHaveBeenCalledWith({
      typeId: 'files', instanceKey: '', action: 'openFolder', payload: { folderId: 'fld_physics' },
      fallbackLaunch: { typeId: 'files', reason: 'api', payload: { folderId: 'fld_physics' } },
    });
  });

  it('uses the existing durable openResource navigation intent in the classic shell', async () => {
    const listener = vi.fn();
    window.addEventListener(APP_EVENTS.NAVIGATE_TO_VIEW, listener);
    await openSpaceFolderInHub('fld_classic');
    window.removeEventListener(APP_EVENTS.NAVIGATE_TO_VIEW, listener);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ view: 'learning-hub', openResource: '/fld_classic' });
  });

  it('passes only the bound deck due-card IDs to the classic review provider', async () => {
    const start = vi.fn(async () => true);
    provideStudySpaceReview(start);
    listCards.mockResolvedValue({ items: [{ id: 'anki_a' }, { id: 'anki_b' }] });
    expect(await launchSpaceFlashcardReview({ name: 'Space', defaultDeckId: 'Physics::Core' })).toBe(true);
    expect(listCards).toHaveBeenCalledWith(expect.objectContaining({ deck: 'Physics::Core', status: 'due' }));
    expect(start).toHaveBeenCalledWith(['anki_a', 'anki_b']);
  });

  it('uses the host startReview contract and falls back to new cards within the same deck', async () => {
    const activate = vi.fn(async () => true);
    setWorkbenchHostBridge({ isEnabled: () => true, activate } as unknown as WorkbenchHostBridge);
    listCards.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ items: [{ id: 'anki_new' }] });
    expect(await launchSpaceFlashcardReview({ name: 'Space', defaultDeckId: 'Physics' })).toBe(true);
    expect(listCards).toHaveBeenNthCalledWith(2, expect.objectContaining({ deck: 'Physics', status: 'new' }));
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'startReview', payload: { screen: 'session', mode: 'batch', cardIds: ['anki_new'] },
    }));
  });

  it('emits only one layout-owner event when entering a space with applyWorkbenchPreset', () => {
    const listener = vi.fn();
    window.addEventListener(STUDY_SPACE_CHANGED_EVENT, listener);
    useStudySpaceStore.getState().setActiveSpace('grp_layout', { applyWorkbenchPreset: true });
    window.removeEventListener(STUDY_SPACE_CHANGED_EVENT, listener);
    expect(listener).toHaveBeenCalledOnce();
  });
});
