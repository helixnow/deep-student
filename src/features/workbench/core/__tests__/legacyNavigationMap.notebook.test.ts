import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_EVENTS, addAppEventListener } from '@/events';
import type { LaunchRequest } from '../types';

vi.mock('../windowStore', () => ({
  useWindowStore: { getState: () => ({ windows: {}, focusStack: [] }) },
}));
vi.mock('../workbenchBus', () => ({
  workbenchBus: { registerLegacyFallback: vi.fn() },
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/utils/i18n', () => ({ t: (key: string) => key }));

import { translateLegacyNavigation } from '../legacyNavigationMap';

const dispatched: unknown[] = [];
let stopListening: (() => void) | undefined;

beforeEach(() => {
  stopListening = addAppEventListener(APP_EVENTS.NAVIGATE_TO_VIEW, (detail) => dispatched.push(detail));
});
afterEach(() => {
  stopListening?.();
  dispatched.length = 0;
});

describe('notebook legacy navigation', () => {
  it.each(['launch', 'activate'] as const)('routes notebook %s to the standalone classic notes page', (kind) => {
    if (kind === 'launch') {
      translateLegacyNavigation({ typeId: 'notebook', reason: 'api' }, kind);
    } else {
      translateLegacyNavigation({ typeId: 'notebook', instanceKey: '', action: 'focus' }, kind);
    }
    expect(dispatched).toEqual([{ view: 'notes' }]);
  });

  it.each([
    [{ typeId: 'notes', reason: 'dock' }, { view: 'learning-hub' }],
    [{ typeId: 'note', instanceKey: 'note_text', reason: 'files' }, { view: 'learning-hub', openResource: '/note_text' }],
    [{ typeId: 'mindmap', instanceKey: 'mm_text', reason: 'files' }, { view: 'learning-hub', openResource: '/mm_text' }],
  ] satisfies Array<[LaunchRequest, Record<string, string>]>)('preserves the existing text-note fallback for %s', (request, expected) => {
    translateLegacyNavigation(request, 'launch');
    expect(dispatched).toEqual([expected]);
  });
});
