import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { StreamingBlockRenderer } from '../StreamingBlockRenderer';
import { StreamingMarkdownRenderer } from '../StreamingMarkdownRenderer';
import { StreamPreferencesProvider } from '../StreamPreferencesContext';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://mock${path}`,
}));

describe('streaming renderer defaults', () => {
  it('defaults markdown streaming to blocked mode with flowtoken-direct preset', () => {
    const { container } = render(
      <StreamingMarkdownRenderer content="正在输出" isStreaming />
    );

    const root = container.querySelector('.streaming-markdown');
    expect(root).toHaveAttribute('data-stream-mode', 'blocked');
    expect(root).toHaveAttribute('data-stream-preset', 'flowtoken-direct');
  });

  it('block streaming uses flowtoken-direct preset (smoothing removed)', () => {
    const { container } = render(
      <StreamPreferencesProvider preset="silky">
        <StreamingBlockRenderer content="正在输出" isStreaming />
      </StreamPreferencesProvider>
    );

    const root = container.querySelector('.streaming-block-renderer');
    expect(root).toHaveAttribute('data-stream-preset', 'flowtoken-direct');
  });
});
