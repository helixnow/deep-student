import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { showGlobalNotification, debugLogError } = vi.hoisted(() => ({
  showGlobalNotification: vi.fn(),
  debugLogError: vi.fn(),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification,
}));

vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: {
    log: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: debugLogError,
  },
  debugMasterSwitch: {
    isEnabled: () => false,
  },
}));

import {
  clearAdapterErrorFlag,
  getAdapterErrorFlag,
  reportAdapterError,
} from '../adapterErrorChannel';

describe('adapterErrorChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAdapterErrorFlag('sess_a');
    clearAdapterErrorFlag('sess_b');
  });

  afterEach(() => {
    clearAdapterErrorFlag('sess_a');
    clearAdapterErrorFlag('sess_b');
  });

  it('user-level errors notify and set a retryable store flag', () => {
    const setState = vi.fn();
    const retry = vi.fn();

    const flag = reportAdapterError({
      code: 'listener_registration_failed',
      level: 'user',
      sessionId: 'sess_a',
      message: 'listeners down',
      title: 'Listener failed',
      retryable: true,
      retry,
      storeApi: { setState },
    });

    expect(flag).toMatchObject({
      code: 'listener_registration_failed',
      sessionId: 'sess_a',
      message: 'listeners down',
      retryable: true,
    });
    expect(getAdapterErrorFlag('sess_a')).toEqual(flag);
    expect(setState).toHaveBeenCalledWith({ adapterError: flag });
    expect(showGlobalNotification).toHaveBeenCalledWith(
      'error',
      'listeners down',
      'Listener failed',
      expect.objectContaining({
        action: expect.objectContaining({
          label: expect.any(String),
          onClick: expect.any(Function),
        }),
      }),
    );

    const action = showGlobalNotification.mock.calls[0][3]?.action;
    action?.onClick();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('dev-level errors stay in debug logs without toast or flag', () => {
    const setState = vi.fn();
    const result = reportAdapterError({
      code: 'block_event_failed',
      level: 'dev',
      sessionId: 'sess_a',
      message: 'block boom',
      cause: new Error('parse'),
      storeApi: { setState },
    });

    expect(result).toBeNull();
    expect(getAdapterErrorFlag('sess_a')).toBeNull();
    expect(showGlobalNotification).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
    expect(debugLogError).toHaveBeenCalled();
  });

  it('clearAdapterErrorFlag can target specific codes only', () => {
    reportAdapterError({
      code: 'session_load_failed',
      level: 'user',
      sessionId: 'sess_b',
      message: 'load failed',
      notify: false,
    });

    clearAdapterErrorFlag('sess_b', null, ['listener_registration_failed']);
    expect(getAdapterErrorFlag('sess_b')?.code).toBe('session_load_failed');

    clearAdapterErrorFlag('sess_b', null, ['session_load_failed']);
    expect(getAdapterErrorFlag('sess_b')).toBeNull();
  });
});
