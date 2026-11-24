import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { shouldBlockMobileNavigation } from '@/hooks/useKeyboardHeight';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import type { CurrentView } from '@/types/navigation';
import { setPendingSettingsTab } from '@/utils/pendingSettingsTab';

const VIEW_TO_WORKBENCH_TYPE_ID: Partial<Record<CurrentView, string>> = {
  'chat-v2': 'chat',
  'learning-hub': 'files',
  todo: 'todo',
  'skills-management': 'skills',
  'template-management': 'templates',
  'task-dashboard': 'taskDashboard',
  'sandbox-workbench': 'sandbox',
  flashcards: 'flashcards',
  media: 'media',
  settings: 'settings',
};

export interface MobileSidebarNavigationDeps {
  closeDrawer: () => void;
  focusChat?: () => void;
}

/**
 * Resolves mobile drawer dock navigation inside ChatV2Page.
 * When Desktop Workbench is active on a narrow viewport, legacy `setCurrentView` is ignored by AppShellChrome;
 * route via `workbenchBus.launch` so clicking "待办" or other dock tiles opens the target window.
 */
export function navigateFromChatMobileDrawer(
  view: CurrentView,
  deps: MobileSidebarNavigationDeps,
): boolean {
  if (shouldBlockMobileNavigation()) {
    return false;
  }

  deps.closeDrawer();

  if (workbenchBus.isEnabled()) {
    if (view === 'chat-v2') {
      deps.focusChat?.();
      workbenchBus.launch({ typeId: 'chat', reason: 'dock' });
      return true;
    }
    if (view === 'data-management') {
      setPendingSettingsTab('data-governance');
      workbenchBus.launch({ typeId: 'settings', reason: 'dock' });
      return true;
    }
    const typeId = VIEW_TO_WORKBENCH_TYPE_ID[view];
    if (typeId) {
      workbenchBus.launch({ typeId, reason: 'dock' });
      return true;
    }
  }

  if (view === 'chat-v2') {
    deps.focusChat?.();
  }
  dispatchAppEvent(APP_EVENTS.MOBILE_APP_NAVIGATE, { view });
  return true;
}
