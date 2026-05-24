/**
 * Menu event bridge — Phase D2 of native-feel migration (2026-05-14).
 *
 * Listens for events emitted by the macOS native menu bar (see
 * src-tauri/src/menu.rs) and dispatches them into the existing in-app
 * command system. A single command implementation thereby backs both
 * Cmd+K command palette and the system menu — no duplication.
 *
 * Event names are kept in lock-step with the Rust constants
 * (`EVENT_PREFERENCES`, `EVENT_NEW_SESSION`, …).
 */

import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Map of menu event id → action invoked on receipt. */
type MenuHandler = () => void;

function buildHandlers(): Record<string, MenuHandler> {
  const dispatch = (eventName: string) => () => {
    window.dispatchEvent(new CustomEvent(eventName));
  };

  return {
    'menu://preferences': () => {
      // Settings page navigation flows through nav.goto.settings (mod+,).
      // Reuse the same custom event pattern other call sites use:
      // detail = { view: '<viewName>' }
      window.dispatchEvent(
        new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'settings' } })
      );
    },
    'menu://new-session': dispatch(COMMAND_EVENTS.CHAT_NEW_SESSION),
    'menu://command-palette': () => {
      // Open the command palette via the same key combo it listens for.
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          code: 'KeyK',
          ctrlKey: !isMac,
          metaKey: isMac,
          bubbles: true,
        })
      );
    },
    'menu://toggle-sidebar': dispatch(COMMAND_EVENTS.CHAT_TOGGLE_SIDEBAR),
    'menu://documentation': () => {
      const url = 'https://github.com/anomalyco/deep-student';
      try {
        // Prefer Tauri opener so we keep launching in the user's default browser
        void import('@tauri-apps/plugin-opener')
          .then((m) => m.openUrl?.(url))
          .catch(() => window.open(url, '_blank'));
      } catch {
        window.open(url, '_blank');
      }
    },
    'menu://report-issue': () => {
      const url = 'https://github.com/anomalyco/deep-student/issues/new';
      try {
        void import('@tauri-apps/plugin-opener')
          .then((m) => m.openUrl?.(url))
          .catch(() => window.open(url, '_blank'));
      } catch {
        window.open(url, '_blank');
      }
    },
  };
}

/**
 * Hook variant for components mounted inside the React tree.
 * Safe to call unconditionally — does nothing on non-macOS or non-Tauri
 * environments.
 */
export function useMenuEventBridge(): void {
  useEffect(() => {
    if (!isTauri || !isMac) return;
    const handlers = buildHandlers();
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    void (async () => {
      for (const [eventName, handler] of Object.entries(handlers)) {
        try {
          const unlisten = await listen(eventName, handler);
          if (cancelled) {
            unlisten();
            continue;
          }
          unlisteners.push(unlisten);
        } catch (err) {
          console.warn(`[menu-bridge] failed to subscribe to ${eventName}:`, err);
        }
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((u) => {
        try { u(); } catch { /* noop */ }
      });
    };
  }, []);
}
