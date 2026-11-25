import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useUnifiedNotification } from '../useUnifiedNotification';

describe('G11c useUnifiedNotification replaceKey atomic replacement', () => {
  it('atomically replaces an in-progress notification with success/error/cancelled sharing the same replaceKey', () => {
    const { result } = renderHook(() => useUnifiedNotification());

    act(() => {
      showGlobalNotification('info', 'Creating full local restore point...', undefined, {
        replaceKey: 'data-governance:backup-job',
      });
    });

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0]?.type).toBe('info');
    expect(result.current.notifications[0]?.message).toBe('Creating full local restore point...');
    const startedId = result.current.notifications[0]?.id;

    // Fast backup completes immediately -> must replace the in-progress toast atomically
    act(() => {
      showGlobalNotification('success', 'Backup created successfully', undefined, {
        replaceKey: 'data-governance:backup-job',
      });
    });

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0]?.type).toBe('success');
    expect(result.current.notifications[0]?.message).toBe('Backup created successfully');
    expect(result.current.notifications[0]?.count).toBe(1);
    // Fresh id prevents a closing timer from the old toast from removing the replacement
    expect(result.current.notifications[0]?.id).not.toBe(startedId);

    // Subsequent error on the same replaceKey also replaces cleanly
    act(() => {
      showGlobalNotification('error', 'Backup failed: disk full', undefined, {
        replaceKey: 'data-governance:backup-job',
      });
    });

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0]?.type).toBe('error');
    expect(result.current.notifications[0]?.message).toBe('Backup failed: disk full');
  });

  it('preserves unrelated notifications while replacing only matching replaceKey entries', () => {
    const { result } = renderHook(() => useUnifiedNotification());

    act(() => {
      showGlobalNotification('warning', 'Unrelated warning');
      showGlobalNotification('info', 'Creating restore point...', undefined, {
        replaceKey: 'data-governance:backup-job',
      });
    });

    expect(result.current.notifications).toHaveLength(2);

    act(() => {
      showGlobalNotification('success', 'Backup created successfully', undefined, {
        replaceKey: 'data-governance:backup-job',
      });
    });

    expect(result.current.notifications).toHaveLength(2);
    expect(result.current.notifications.map((n) => n.message)).toEqual([
      'Backup created successfully',
      'Unrelated warning',
    ]);
  });

  it('dedupes identical notifications sharing the same replaceKey by incrementing count', () => {
    const { result } = renderHook(() => useUnifiedNotification());

    act(() => {
      showGlobalNotification('info', 'Creating restore point...', undefined, {
        replaceKey: 'data-governance:backup-job',
      });
      showGlobalNotification('info', 'Creating restore point...', undefined, {
        replaceKey: 'data-governance:backup-job',
      });
    });

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0]?.count).toBe(2);
  });
});
