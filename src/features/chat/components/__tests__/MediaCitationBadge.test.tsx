import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { MediaCitationBadge, clearMediaResourceNameCache } from '../MediaCitationBadge';

afterEach(cleanup);
beforeEach(() => {
  invokeMock.mockReset();
  clearMediaResourceNameCache();
});

describe('MediaCitationBadge', () => {
  it('renders "▶ mm:ss · file name" after resolving the resource name', async () => {
    invokeMock.mockResolvedValue({ name: '第三讲 梯度下降.mp4' });
    render(<MediaCitationBadge resourceId="file_1" seconds={754} />);
    expect(await screen.findByText('第三讲 梯度下降.mp4')).toBeInTheDocument();
    expect(screen.getByText('12:34')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('dstu_get', { path: '/file_1' });
  });

  it('dispatches media-ref:open with resourceId and seconds on click', async () => {
    invokeMock.mockResolvedValue(null);
    const listener = vi.fn();
    document.addEventListener('media-ref:open', listener);
    render(<MediaCitationBadge resourceId="file_2" seconds={65} />);
    fireEvent.click(screen.getByRole('button'));
    document.removeEventListener('media-ref:open', listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      resourceId: 'file_2',
      seconds: 65,
    });
  });
});
