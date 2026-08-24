import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { mindmapEmbedPropsSchema, MindmapEmbedBlock } from '@/features/generative-ui/components/MindmapEmbedBlock';

vi.mock('@/features/mindmap/components/mindmap/MindMapEmbed', () => ({
  MindMapEmbed: (props: { displayTitle?: string; mindmapId?: string; versionId?: string }) => (
    <div
      data-testid="mindmap-embed-mock"
      data-mindmap-id={props.mindmapId}
      data-version-id={props.versionId}
      data-title={props.displayTitle}
    />
  ),
}));

describe('MindmapEmbedBlock', () => {
  it('rejects traversal and scheme-like embed ids', () => {
    expect(mindmapEmbedPropsSchema.safeParse({ mindmapId: '../evil' }).success).toBe(false);
    expect(mindmapEmbedPropsSchema.safeParse({ versionId: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('accepts versionId-only props in schema', () => {
    const parsed = mindmapEmbedPropsSchema.safeParse({
      versionId: 'mv_test123',
      title: 'Snapshot',
      height: 280,
    });
    expect(parsed.success).toBe(true);
  });

  it('renders lazy embed with displayTitle and version ref', async () => {
    render(
      <React.Suspense fallback={<div data-testid="loading" />}>
        <MindmapEmbedBlock versionId="mv_test123" title="Snapshot" height={280} />
      </React.Suspense>,
    );
    expect(await screen.findByTestId('mindmap-embed-mock')).toHaveAttribute('data-version-id', 'mv_test123');
    expect(screen.getByTestId('mindmap-embed-mock')).toHaveAttribute('data-title', 'Snapshot');
    expect(screen.getByText('Snapshot')).toBeInTheDocument();
  });
});
