import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { appRegistry } from '../../../core/appRegistry';
import type { ActivationContext } from '../../../core/types';
import { FILE_PREVIEW_APP_TYPE_ID } from '../../content/typeMap';
import { FILE_PREVIEW_APP_DEFINITION, handleFilePreviewActivation } from '../register';

describe('file preview app registration', () => {
  it('registers one multi-instance application for previewable files', () => {
    expect(appRegistry.get(FILE_PREVIEW_APP_TYPE_ID)).toBe(FILE_PREVIEW_APP_DEFINITION);
    expect(FILE_PREVIEW_APP_DEFINITION.instanceMode).toBe('multi');
    expect(FILE_PREVIEW_APP_DEFINITION.showInLauncher).toBe(false);
    expect(FILE_PREVIEW_APP_DEFINITION.memoryWeight).toBe(3);
    expect(React.isValidElement(FILE_PREVIEW_APP_DEFINITION.icon)).toBe(true);
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
