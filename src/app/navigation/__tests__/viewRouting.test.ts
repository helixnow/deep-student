import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CurrentView } from '@/types/navigation';
import {
  MAX_ALIVE_VIEWS_DESKTOP,
  MAX_ALIVE_VIEWS_TOUCH,
  advanceViewNavStack,
  computeNextVisitedViews,
  getMaxAliveViews,
} from '../viewRouting';

const visited = (entries: Array<[CurrentView, number]>) => new Map<CurrentView, number>(entries);

describe('computeNextVisitedViews (LRU of alive views)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records the target view and keeps everything while under the limit', () => {
    const prev = visited([['chat-v2', 1]]);
    const next = computeNextVisitedViews(prev, 'settings');
    expect(next).not.toBe(prev);
    expect([...next.keys()]).toEqual(['chat-v2', 'settings']);
    expect(prev.size).toBe(1);
  });

  it('evicts the oldest non-pinned view once the desktop limit is exceeded', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
    const views: CurrentView[] = ['chat-v2', 'settings', 'todo', 'media', 'dashboard', 'learning-hub', 'flashcards', 'ui-lab'];
    const prev = visited(views.map((view, index) => [view, index] as [CurrentView, number]));
    expect(prev.size).toBe(MAX_ALIVE_VIEWS_DESKTOP);
    const next = computeNextVisitedViews(prev, 'skills-management');
    expect(next.size).toBe(MAX_ALIVE_VIEWS_DESKTOP);
    expect(next.has('chat-v2')).toBe(true); // pinned
    expect(next.has('settings')).toBe(false); // oldest non-pinned
    expect(next.has('skills-management')).toBe(true);
  });

  it('defers evicting pdf-reader while other candidates exist', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const prev = visited([['chat-v2', 0], ['pdf-reader', 1], ['todo', 2], ['media', 3]]);
    expect(getMaxAliveViews()).toBe(MAX_ALIVE_VIEWS_TOUCH);
    const next = computeNextVisitedViews(prev, 'settings');
    expect([...next.keys()].sort()).toEqual(['chat-v2', 'media', 'pdf-reader', 'settings']);
  });
});

describe('advanceViewNavStack (layer slide direction)', () => {
  it('pushes unseen views forward and pops back to a view already on the stack', () => {
    const stack: CurrentView[] = ['chat-v2'];
    const setDirection = vi.fn();
    advanceViewNavStack(stack, 'chat-v2', 'settings', setDirection);
    expect(stack).toEqual(['chat-v2', 'settings']);
    expect(setDirection).toHaveBeenLastCalledWith(1);

    advanceViewNavStack(stack, 'settings', 'chat-v2', setDirection);
    expect(stack).toEqual(['chat-v2']);
    expect(setDirection).toHaveBeenLastCalledWith(-1);
  });

  it('leaves stack and direction untouched when the target is already on top', () => {
    const stack: CurrentView[] = ['chat-v2', 'todo'];
    const setDirection = vi.fn();
    advanceViewNavStack(stack, 'todo', 'todo', setDirection);
    expect(stack).toEqual(['chat-v2', 'todo']);
    expect(setDirection).not.toHaveBeenCalled();
  });
});
