import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { get, t } = vi.hoisted(() => ({
  get: vi.fn(),
  t: (key: string) => key,
}));

vi.mock('@/dstu', () => ({ dstu: { get } }));
vi.mock('@/features/ink/LazyInkEditorEntry', async () => {
  const React = await import('react');
  return {
    LazyInkEditor: ({ documentId }: { documentId: string }) =>
      React.createElement('div', { 'data-testid': 'lazy-ink-editor', 'data-document-id': documentId }),
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/utils/fileManager', () => ({ fileManager: { saveFromSource: vi.fn() } }));

import { loadEditorComponent } from '@/dstu/editorRegistry';
import { registerDstuFileViewer } from '@/features/ink';

describe('DSTU file editor ink dispatch', () => {
  it('loads the registry editor with only its path and resolves the actual Ink node', async () => {
    registerDstuFileViewer();
    const FileEditor = await loadEditorComponent('file');
    get.mockResolvedValue({
      ok: true,
      value: {
        id: 'file_stable456',
        sourceId: 'file_stable456',
        path: '/file_stable456',
        name: 'notes.dsink',
        type: 'file',
        size: 10,
        createdAt: 1,
        updatedAt: 1,
        previewType: 'text',
        metadata: { mimeType: 'application/json' },
      },
    });

    render(<FileEditor path="/file_stable456" />);

    expect(await screen.findByTestId('lazy-ink-editor')).toHaveAttribute('data-document-id', 'file_stable456');
    expect(get).toHaveBeenCalledWith('/file_stable456');
  });
});
