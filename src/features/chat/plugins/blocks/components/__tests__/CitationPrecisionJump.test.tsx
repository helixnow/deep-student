import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  CitationPopover,
  extractCitationLocator,
} from '../CitationPopover';
import type { RetrievalSource } from '../types';
import UnifiedSourcePanel, {
  canAutoJumpCitationItem,
  isLocalMarkdownSource,
  resolveMediaJumpTarget,
} from '../../../../components/panels/UnifiedSourcePanel';
import { citationEvents } from '../../../../utils/citationEvents';
import { MEDIA_REF_OPEN_EVENT } from '@/features/learning-hub/apps/views/media/mediaRefEvents';
import type { UnifiedSourceBundle, UnifiedSourceItem } from '../../../../components/panels/sourceTypes';
import { ContentBlock } from '../../content';
import { CitationSourceContext, type CitationSourceResolver } from '../../../../utils/citationSourceContext';
import type { Block } from '../../../../core/types/block';

vi.mock('@/utils/urlOpener', () => ({
  openUrl: vi.fn(),
}));

vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => () => {},
  BACK_PRIORITY: { overlay: 100 },
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useIsMobile: () => false,
}));

const capturedResolverRef: { current: CitationSourceResolver | null } = { current: null };

vi.mock('../../../../components/renderers', () => ({
  StreamingBlockRenderer: () => {
    const resolver = React.useContext(CitationSourceContext);
    capturedResolverRef.current = resolver;
    return <div data-testid="mock-streaming-renderer" />;
  },
}));

function makeItem(overrides: Partial<UnifiedSourceItem>): UnifiedSourceItem {
  return {
    id: 'src-1',
    title: 'Attention Is All You Need.pdf',
    snippet: 'We set d_k = 64 for each attention head.',
    score: 0.92,
    origin: 'rag',
    providerId: 'local_rag',
    providerLabel: 'Local RAG',
    citationType: 'rag',
    typeIndex: 1,
    raw: {
      document_id: 'doc-1',
      file_name: 'Attention Is All You Need.pdf',
      chunk_text: 'We set d_k = 64 for each attention head.',
      score: 0.92,
      chunk_index: 0,
    },
    ...overrides,
  };
}

describe('Gap S1: Precision Citation Hover & 1-Click Jump', () => {
  beforeEach(() => {
    cleanup();
    capturedResolverRef.current = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('forwards pageIndex, timeRange, mediaCitation, sourceId, resourceType from content.tsx into CitationSourceContext', () => {
    const ragBlock: Block = {
      id: 'blk-rag',
      messageId: 'msg-1',
      type: 'rag',
      status: 'success',
      content: '',
      createdAt: 1,
      toolOutput: [
        {
          title: 'Attention.pdf',
          snippet: 'Scaled dot-product attention uses d_k = 64.',
          score: 0.95,
          sourceId: 'file_arxiv_1',
          resourceId: 'res_1',
          resourceType: 'file',
          pageIndex: 3,
          typeIndex: 1,
        },
        {
          title: 'Lecture-01.mp4',
          snippet: 'At 1:30 we explain multi-head attention.',
          score: 0.88,
          sourceId: 'file_vid_1',
          resourceType: 'media',
          timeRange: { startMs: 90_000, endMs: 105_000 },
          mediaCitation: '[媒体@file_vid_1:01:30]',
          typeIndex: 2,
        },
      ],
    };
    const contentBlock: Block = {
      id: 'blk-content',
      messageId: 'msg-1',
      type: 'content',
      status: 'success',
      content: 'See [知识库-1] and [知识库-2].',
      createdAt: 2,
    };

    const storeState = {
      blocks: new Map([
        [ragBlock.id, ragBlock],
        [contentBlock.id, contentBlock],
      ]),
      messageMap: new Map([
        [
          'msg-1',
          {
            id: 'msg-1',
            role: 'assistant',
            blockIds: [ragBlock.id, contentBlock.id],
          },
        ],
      ]),
    };

    const fakeStore = {
      getState: () => storeState,
      subscribe: () => () => {},
    } as never;

    render(<ContentBlock block={contentBlock} isStreaming={false} store={fakeStore} />);

    expect(capturedResolverRef.current).toBeTypeOf('function');
    const pdfSource = capturedResolverRef.current?.('rag', 1);
    expect(pdfSource?.metadata).toMatchObject({
      pageIndex: 3,
      sourceId: 'file_arxiv_1',
      resourceId: 'res_1',
      resourceType: 'file',
    });

    const mediaSource = capturedResolverRef.current?.('rag', 2);
    expect(mediaSource?.metadata).toMatchObject({
      timeRange: { startMs: 90_000, endMs: 105_000 },
      mediaCitation: '[媒体@file_vid_1:01:30]',
      sourceId: 'file_vid_1',
      resourceType: 'media',
    });
  });

  it('renders P.N badge and explicit footer jump CTA in CitationPopover for PDF sources', () => {
    const anchor = document.createElement('span');
    document.body.appendChild(anchor);
    const onLocate = vi.fn();

    const pdfSource: RetrievalSource = {
      id: 'src-pdf',
      type: 'rag',
      title: 'Attention.pdf',
      snippet: 'd_k = 64 reduces dot product magnitude.',
      score: 0.91,
      metadata: {
        pageIndex: 4,
        sourceId: 'file_arxiv_1',
        resourceType: 'file',
      },
    };

    render(
      <CitationPopover
        source={pdfSource}
        anchorEl={anchor}
        onClose={vi.fn()}
        onLocate={onLocate}
      />,
    );

    const locatorBadge = document.body.querySelector('[data-citation-locator="page"]');
    expect(locatorBadge?.textContent).toBe('P.5');

    const cta = document.body.querySelector<HTMLButtonElement>('[data-citation-jump-cta="true"]');
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain('5');

    fireEvent.click(cta!);
    expect(onLocate).toHaveBeenCalledTimes(1);
    anchor.remove();
  });

  it('renders mm:ss badge and explicit seek CTA in CitationPopover for media sources', () => {
    const anchor = document.createElement('span');
    document.body.appendChild(anchor);
    const onLocate = vi.fn();

    const mediaSource: RetrievalSource = {
      id: 'src-media',
      type: 'rag',
      title: 'Bioethics.mp3',
      snippet: 'Informed consent requires transparency.',
      metadata: {
        timeRange: { startMs: 125_000, endMs: 140_000 },
        mediaCitation: '[媒体@file_audio_1:02:05]',
        sourceId: 'file_audio_1',
      },
    };

    expect(extractCitationLocator(mediaSource)).toMatchObject({
      kind: 'media',
      mediaSeconds: 125,
      mediaTimestamp: '02:05',
      sourceId: 'file_audio_1',
    });

    render(
      <CitationPopover
        source={mediaSource}
        anchorEl={anchor}
        onClose={vi.fn()}
        onLocate={onLocate}
      />,
    );

    const badge = document.body.querySelector('[data-citation-locator="media"]');
    expect(badge?.textContent).toContain('02:05');

    const cta = document.body.querySelector<HTMLButtonElement>('[data-citation-jump-cta="true"]');
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain('02:05');
    fireEvent.click(cta!);
    expect(onLocate).toHaveBeenCalledTimes(1);
    anchor.remove();
  });

  it('routes timeRange/mediaCitation to media-ref:open and local Markdown to side preview in UnifiedSourcePanel', () => {
    const mediaItem = makeItem({
      id: 'item-media',
      title: 'Lecture.mp4',
      sourceId: 'file_media_9',
      timeRange: { startMs: 95_000, endMs: 110_000 },
      mediaCitation: '[媒体@file_media_9:01:35]',
      typeIndex: 1,
    });
    const mdItem = makeItem({
      id: 'item-md',
      title: 'astro-notes.md',
      sourceId: 'file_astro_md',
      resourceType: 'file',
      snippet: 'Redshift z=0.23798 confirmed in spectroscopy.',
      typeIndex: 2,
      raw: {
        document_id: 'doc-md',
        file_name: 'astro-notes.md',
        chunk_text: 'Redshift z=0.23798 confirmed in spectroscopy.',
        score: 0.9,
        chunk_index: 0,
        source_id: 'file_astro_md',
      },
    });
    const webItem = makeItem({
      id: 'item-web',
      title: 'Wikipedia',
      origin: 'web_search',
      citationType: 'web_search',
      typeIndex: 1,
      link: 'https://example.org/wiki',
    });

    expect(resolveMediaJumpTarget(mediaItem)).toEqual({
      resourceId: 'file_media_9',
      seconds: 95,
    });
    expect(isLocalMarkdownSource(mdItem)).toBe(true);
    expect(canAutoJumpCitationItem(mediaItem, { sourceId: 'file_media_9' })).toBe(true);
    expect(canAutoJumpCitationItem(mdItem, { sourceId: 'file_astro_md', title: 'astro-notes.md' })).toBe(true);
    expect(canAutoJumpCitationItem(webItem, {})).toBe(false);

    const bundle: UnifiedSourceBundle = {
      total: 3,
      groups: [
        {
          group: 'rag',
          providerId: 'local_rag',
          providerLabel: 'Local RAG',
          count: 2,
          items: [mediaItem, mdItem],
        },
        {
          group: 'web_search',
          providerId: 'web_search',
          providerLabel: 'Web',
          count: 1,
          items: [webItem],
        },
      ],
    };

    const mediaEvents: CustomEvent[] = [];
    const previewEvents: CustomEvent[] = [];
    const onMedia = (e: Event) => mediaEvents.push(e as CustomEvent);
    const onPreview = (e: Event) => previewEvents.push(e as CustomEvent);
    document.addEventListener(MEDIA_REF_OPEN_EVENT, onMedia);
    window.addEventListener('CHAT_OPEN_ATTACHMENT_PREVIEW', onPreview);

    try {
      render(<UnifiedSourcePanel data={bundle} messageId="msg-s1" />);

      // 1-click [1] -> media-ref:open at 95s
      citationEvents.emit({ type: 'rag', index: 1, messageId: 'msg-s1' });
      expect(mediaEvents).toHaveLength(1);
      expect(mediaEvents[0].detail).toMatchObject({
        resourceId: 'file_media_9',
        seconds: 95,
      });

      // 1-click [2] -> local Markdown side preview via CHAT_OPEN_ATTACHMENT_PREVIEW
      citationEvents.emit({ type: 'rag', index: 2, messageId: 'msg-s1' });
      expect(previewEvents).toHaveLength(1);
      expect(previewEvents[0].detail).toEqual({
        id: 'file_astro_md',
        type: 'file',
        title: 'astro-notes.md',
      });

      // Web source does NOT auto-jump on citation click
      citationEvents.emit({ type: 'web_search', index: 1, messageId: 'msg-s1' });
      expect(previewEvents).toHaveLength(1);
      expect(mediaEvents).toHaveLength(1);

      // Source panel action button for media displays formatted timestamp
      expect(screen.getByText('01:35')).toBeTruthy();
    } finally {
      document.removeEventListener(MEDIA_REF_OPEN_EVENT, onMedia);
      window.removeEventListener('CHAT_OPEN_ATTACHMENT_PREVIEW', onPreview);
    }
  });
});
