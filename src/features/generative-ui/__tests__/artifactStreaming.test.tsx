import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeBlock } from '@/features/chat/components/renderers/CodeBlock';
import { requestPinArtifactToCanvas, usePinnedArtifactStore } from '@/stores/pinnedArtifactStore';

vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
const { mermaidRender } = vi.hoisted(() => ({ mermaidRender: vi.fn() }));
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: mermaidRender } }));

describe('artifact preview versus explicit pinned snapshots', () => {
  beforeEach(() => usePinnedArtifactStore.getState().resetPinnedArtifacts());

  it('discards a late Mermaid render after the code block is regenerated', async () => {
    let complete!: (value: { svg: string }) => void;
    mermaidRender.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const { rerender, container } = render(<CodeBlock className="language-mermaid">{'graph TD\nA-->B'}</CodeBlock>);
    fireEvent.click(screen.getByRole('button', { name: /运行|Run/ }));
    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(1));
    rerender(<CodeBlock className="language-mermaid" isStreaming>{'graph TD\nC-->D'}</CodeBlock>);
    await act(async () => { complete({ svg: '<svg><text>过期图表</text></svg>' }); });
    expect(container.querySelector('.mermaid-content')).toBeNull();
    expect(container.textContent).not.toContain('过期图表');
  });

  it.each(['html', 'html-interactive', 'svg', 'mermaid', 'widget'])(
    'does not create pinned records during %s token streaming, even after another artifact is pinned',
    (language) => {
      const record = requestPinArtifactToCanvas({
        ownerKey: 'sandbox:chat:stream', sessionId: 'stream', widgetId: 'pinned',
        sourceMessageId: 'old', title: '已固定', kind: 'html', language: 'html', content: '<p>固定快照</p>',
      });
      const source = language === 'svg' ? '<svg viewBox="0 0 10 10"><rect width="2" height="2"/></svg>'
        : language === 'mermaid' ? 'graph TD\nA-->B' : '<!doctype html><html><body><p>持续生成</p></body></html>';
      const { rerender } = render(<CodeBlock className={`language-${language}`} isStreaming>{''}</CodeBlock>);
      for (let i = 1; i <= source.length; i++) {
        rerender(<CodeBlock className={`language-${language}`} isStreaming>{source.slice(0, i)}</CodeBlock>);
      }
      rerender(<CodeBlock className={`language-${language}`} isStreaming={false}>{source}</CodeBlock>);
      expect(Object.keys(usePinnedArtifactStore.getState().recordsById)).toEqual([record.artifactId]);
      expect(usePinnedArtifactStore.getState().recordsById[record.artifactId]).toEqual(record);
    },
  );
});
