import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { appRegistry } from '../../../core/appRegistry';
import type { ActivationContext } from '../../../core/types';
import { FILE_PREVIEW_APP_TYPE_ID } from '../../content/typeMap';
import { FILE_PREVIEW_APP_DEFINITION, handleFilePreviewActivation } from '../register';
import { registerInkWorkspaceExitGuard } from '@/services/inkWorkspaceRegistry';

describe('file preview app registration', () => {
  it('registers one multi-instance application for previewable files', () => {
    expect(appRegistry.get(FILE_PREVIEW_APP_TYPE_ID)).toBe(FILE_PREVIEW_APP_DEFINITION);
    expect(FILE_PREVIEW_APP_DEFINITION.instanceMode).toBe('multi');
    expect(FILE_PREVIEW_APP_DEFINITION.showInLauncher).toBe(false);
    expect(FILE_PREVIEW_APP_DEFINITION.memoryWeight).toBe(3);
    expect(React.isValidElement(FILE_PREVIEW_APP_DEFINITION.icon)).toBe(true);
  });

  it('preserves regular previews but blocks freezing and awaits Ink workspace close', async () => {
    expect(FILE_PREVIEW_APP_DEFINITION.canSuspend!('file_plain')).toBe(true);
    await expect(FILE_PREVIEW_APP_DEFINITION.canClose!('file_plain')).resolves.toBe(true);
    let finish!: (saved: boolean) => void;
    const flush = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const stop = registerInkWorkspaceExitGuard('file_ink', { isDirty: () => false, flush });
    try {
      expect(FILE_PREVIEW_APP_DEFINITION.canSuspend!('/folder/file_ink')).toBe(false);
      const closing = FILE_PREVIEW_APP_DEFINITION.canClose!('/folder/file_ink');
      expect(flush).toHaveBeenCalledTimes(1);
      finish(false);
      await expect(closing).resolves.toBe(false);
    } finally {
      stop();
    }
  });

  it('routes page activation and waits for the shared PDF focus ACK', async () => {
    const listener = vi.fn((event: Event) => {
      (event as CustomEvent<{ acknowledge?: (handled: boolean) => void }>).detail
        ?.acknowledge?.(true);
    });
    document.addEventListener('pdf-ref:focus', listener);
    const result = await handleFilePreviewActivation({
      action: 'scrollToHeading',
      instanceKey: 'tb_1',
      payload: { page: 7 },
    } as ActivationContext);

    expect(result).toEqual({ handled: true, acknowledged: true });
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toMatchObject({ sourceId: 'tb_1', pageNumber: 7, path: '/tb_1' });
    document.removeEventListener('pdf-ref:focus', listener);
  });
});
