import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_EVENTS } from '@/events';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import * as keyboardHeight from '@/hooks/useKeyboardHeight';
import { navigateFromChatMobileDrawer } from '../pages/mobileSidebarNavigation';

describe('S4-17 mobile chat sidebar dock navigation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    workbenchBus.setEnabled(false);
  });

  afterEach(() => {
    workbenchBus.setEnabled(false);
  });

  it('launches Todo via workbenchBus and closes the mobile drawer when workbench is active', () => {
    workbenchBus.setEnabled(true);
    const launchSpy = vi.spyOn(workbenchBus, 'launch').mockReturnValue('win_todo_1');
    const closeDrawer = vi.fn();

    const accepted = navigateFromChatMobileDrawer('todo', { closeDrawer });

    expect(accepted).toBe(true);
    expect(closeDrawer).toHaveBeenCalledTimes(1);
    expect(launchSpy).toHaveBeenCalledWith({ typeId: 'todo', reason: 'dock' });
  });

  it('dispatches MOBILE_APP_NAVIGATE and closes drawer when workbench is disabled', () => {
    const closeDrawer = vi.fn();
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener(APP_EVENTS.MOBILE_APP_NAVIGATE, listener);

    try {
      const accepted = navigateFromChatMobileDrawer('todo', { closeDrawer });
      expect(accepted).toBe(true);
      expect(closeDrawer).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);
      expect(events[0]?.detail).toEqual({ view: 'todo' });
    } finally {
      window.removeEventListener(APP_EVENTS.MOBILE_APP_NAVIGATE, listener);
    }
  });

  it('respects Android keyboard transition guard without closing the drawer', () => {
    vi.spyOn(keyboardHeight, 'shouldBlockMobileNavigation').mockReturnValue(true);
    workbenchBus.setEnabled(true);
    const launchSpy = vi.spyOn(workbenchBus, 'launch');
    const closeDrawer = vi.fn();

    const accepted = navigateFromChatMobileDrawer('todo', { closeDrawer });

    expect(accepted).toBe(false);
    expect(closeDrawer).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
  });
});
