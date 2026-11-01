import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

import { CodeBlock } from '../CodeBlock';
import {
  DEFAULT_RENDERER_CAPABILITIES,
  parseRendererCapabilities,
} from '../rendererCapabilities';

const INTENT = JSON.stringify({
  version: '1',
  blocks: [{ type: 'stat-card', id: 's1', props: { title: '正确率', value: '82%' } }],
});

const ON = { ...DEFAULT_RENDERER_CAPABILITIES, generativeUiInline: true };

describe('generativeUiInline capability', () => {
  it('defaults to false and parses only booleans', () => {
    expect(DEFAULT_RENDERER_CAPABILITIES.generativeUiInline).toBe(false);
    expect(parseRendererCapabilities(null).generativeUiInline).toBe(false);
    expect(parseRendererCapabilities('{"charts":true}').generativeUiInline).toBe(false);
    expect(parseRendererCapabilities('{"generativeUiInline":"yes"}').generativeUiInline).toBe(false);
    expect(parseRendererCapabilities('{"generativeUiInline":true}').generativeUiInline).toBe(true);
    // 与后端 serde camelCase 一致：snake_case 不识别
    expect(parseRendererCapabilities('{"generative_ui_inline":true}').generativeUiInline).toBe(false);
  });
});

describe('CodeBlock ```genui', () => {
  it('capability off → plain source code block', () => {
    const { container } = render(<CodeBlock className="language-genui">{INTENT}</CodeBlock>);
    expect(container.querySelector('pre.code-block')).not.toBeNull();
    expect(container.querySelector('[data-inline-genui]')).toBeNull();
  });

  it('capability on → renders the inline UI and can toggle to source', async () => {
    const { container } = render(
      <CodeBlock className="language-genui" rendererCapabilities={ON}>{INTENT}</CodeBlock>,
    );
    await waitFor(() => expect(container.querySelector('[data-inline-genui="render"]')).not.toBeNull(), { timeout: 10000 });
    expect(screen.getByText('82%')).toBeTruthy();
    expect(container.querySelector('pre.code-block')).toBeNull();

    const toggle = screen.getByRole('button', { pressed: false, name: /源码|Source/i });
    fireEvent.click(toggle);
    expect(container.querySelector('[data-inline-genui]')).toBeNull();
    expect(container.querySelector('pre.code-block')).not.toBeNull();
  });

  it('invalid genui (interactive block) → source + warning', async () => {
    const bad = JSON.stringify({
      version: '1',
      blocks: [
        {
          type: 'choice',
          id: 'q1',
          props: { question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
        },
      ],
    });
    const { container } = render(
      <CodeBlock className="language-genui" rendererCapabilities={ON}>{bad}</CodeBlock>,
    );
    await waitFor(() => expect(container.querySelector('[data-inline-genui="fallback"]')).not.toBeNull(), { timeout: 10000 });
    expect(container.querySelector('[data-inline-genui-warning]')).not.toBeNull();
    expect(container.querySelector('pre.code-block')).not.toBeNull();
  });

  it('streaming with no closed block shows the generating placeholder', async () => {
    const { container } = render(
      <CodeBlock className="language-genui" rendererCapabilities={ON} isStreaming>
        {'{"version":"1","blocks":[{"type":"stat'}
      </CodeBlock>,
    );
    await waitFor(() => expect(container.querySelector('[data-inline-genui="pending"]')).not.toBeNull(), { timeout: 10000 });
  });
});
